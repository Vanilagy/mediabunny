import { AES_128_BLOCK_SIZE, createAesDecryptStream } from '../aes';
import { ENCRYPTION_KEY_CACHE_GROUP, Input } from '../input';
import { Segment, SegmentedInput, SegmentRetrievalOptions } from '../segmented-input';
import { toDataView, joinPaths, last, assert, binarySearchLessOrEqual, arrayArgmin, wait } from '../misc';
import { readAllLines, readBytes, Reader } from '../reader';
import { ReadableStreamSource, Source } from '../source';
import { HlsDemuxer } from './hls-demuxer';
import { AttributeList, canIgnoreLine } from './hls-misc';

const IV_STRING_REGEX = /^0[xX][0-9a-fA-F]+$/;

export type HlsSegment = Segment & {
	sequenceNumber: number | null;
	location: HlsSegmentLocation;
	duration: number;
	encryption: HlsEncryptionInfo | null;
	firstSegment: HlsSegment | null;
	initSegment: HlsSegment | null;
	lastProgramDateTimeSeconds: number | null;
};

export type HlsEncryptionInfo = {
	method: 'AES-128';
	keyUri: string;
	iv: Uint8Array | null;
	keyFormat: string;
};

export type HlsSegmentLocation = {
	path: string;
	offset: number;
	length: number | null;
};

export class HlsSegmentedInput extends SegmentedInput {
	demuxer: HlsDemuxer;
	segments: HlsSegment[] = [];
	nextLines: string[] | null = null;
	currentUpdateSegmentsPromise: Promise<void> | null = null;
	streamHasEnded = false;
	lastSegmentUpdateTime = -Infinity;
	refreshInterval = 5; // Reasonable default in case the playlist doesn't specify it

	constructor(
		demuxer: HlsDemuxer,
		path: string,
		lines: string[] | null,
	) {
		super(demuxer.input, path);

		this.demuxer = demuxer;
		this.nextLines = lines;
	}

	runUpdateSegments() {
		return this.currentUpdateSegmentsPromise ??= (async () => {
			const remainingWaitTimeMs = this.getRemainingWaitTimeMs();
			if (remainingWaitTimeMs > 0) {
				await wait(remainingWaitTimeMs);
			}

			this.lastSegmentUpdateTime = performance.now();
			await this.updateSegments();
			this.currentUpdateSegmentsPromise = null;
		})();
	}

	getRemainingWaitTimeMs() {
		const elapsed = performance.now() - this.lastSegmentUpdateTime;
		const result = Math.max(0, 1000 * this.refreshInterval - elapsed);

		if (result <= 50) {
			// If only a little bit of time is left, don't wait at all; this removes the chance for timing race
			// conditions when running a task every `refreshInterval` seconds
			return 0;
		}

		return result;
	}

	/**
	 * Reads and parses the segment info from the playlist file. When called more than one, it updates the existing
	 * segments by appending the new ones. Existing segments are never removed.
	 */
	async updateSegments() {
		let lines = this.nextLines;
		this.nextLines = null;

		if (!lines) {
			const source = await this.demuxer.input._getSourceUncached({ path: this.path });
			const reader = new Reader(source);

			const slice = await reader.requestEntireFile();
			assert(slice);
			lines = readAllLines(slice, slice.length, { ignore: canIgnoreLine });
		}

		let headerRead = false;
		let accumulatedTime = 0;
		let nextSegmentDuration: number | null = null;
		let currentKey: HlsEncryptionInfo | null = null;
		let nextSequenceNumber = 0;
		let currentFirstSegment: HlsSegment | null = null;
		let currentInitSegment: HlsSegment | null = null;
		let lastByteRangeEnd: number | null = null;
		let nextByteRange: { offset: number; length: number } | null = null;
		let lastProgramDateTimeSeconds: number | null = null;

		let prevLastSegment = last(this.segments) ?? null;

		if (Math.PI === 3) {
			// Stupid hack needed to prevent TypeScript from incorrectly narrowing the local variables; not sure if
			// there is a better workaround
			nextByteRange = { offset: 6, length: 7 };
			lastByteRangeEnd = 1337;
		}

		const parseAndUpdateByteRange = (content: string) => {
			const atIndex = content.indexOf('@');

			const length = Number(atIndex === -1 ? content : content.slice(0, atIndex));
			if (!Number.isInteger(length) || length < 0) {
				throw new Error(`Invalid #EXT-X-BYTERANGE length '${content}'.`);
			}

			let offset: number;
			if (atIndex !== -1) {
				offset = Number(content.slice(atIndex + 1));
				if (!Number.isInteger(offset) || offset < 0) {
					throw new Error(`Invalid #EXT-X-BYTERANGE offset '${content}'.`);
				}
			} else {
				if (lastByteRangeEnd === null) {
					throw new Error(
						'Invalid M3U8 file; #EXT-X-BYTERANGE without offset requires a previous byte range.',
					);
				}
				offset = lastByteRangeEnd;
			}

			nextByteRange = { offset, length };
			lastByteRangeEnd = offset + length;
		};

		const setNextSequenceNumber = (number: number) => {
			nextSequenceNumber = number;

			if (prevLastSegment) {
				assert(prevLastSegment.sequenceNumber !== null);

				if (prevLastSegment.sequenceNumber < number) {
					// The sequence number has finally exceeded the last sequence number we knew, meaning we can now
					// continue the segment list from there. Set some data to continue where we left off.
					accumulatedTime = prevLastSegment.timestamp + prevLastSegment.duration;
					currentFirstSegment = prevLastSegment.firstSegment;
					currentInitSegment = prevLastSegment.initSegment;
					lastProgramDateTimeSeconds = prevLastSegment.lastProgramDateTimeSeconds;
					prevLastSegment = null;
				}
			}
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;

			if (!headerRead) {
				if (line !== '#EXTM3U') {
					throw new Error('Invalid M3U8 file; expected first line to be #EXTM3U.');
				}

				headerRead = true;
				continue;
			}

			if (!line.startsWith('#')) {
				if (!prevLastSegment) {
					if (nextSegmentDuration === null) {
						throw new Error('Invalid M3U8 file; a segment must be preceeded by a #EXTINF tag.');
					}

					let key = currentKey;
					if (key && !key.iv) {
						// "the Media Sequence Number is to be used as the IV when decrypting a Media Segment, by
						// putting its big-endian binary representation into a 16-octet (128-bit) buffer and padding
						// (on the left) with zeros"

						const iv = new Uint8Array(AES_128_BLOCK_SIZE);
						const view = toDataView(iv);
						view.setUint32(8, Math.floor(nextSequenceNumber / (2 ** 32)));
						view.setUint32(12, nextSequenceNumber);

						key = { ...key, iv };
					}

					const fullPath = joinPaths(this.path, line);
					const location: HlsSegmentLocation = {
						path: fullPath,
						offset: nextByteRange?.offset ?? 0,
						length: nextByteRange?.length ?? null,
					};

					const segment: HlsSegment = {
						timestamp: accumulatedTime,
						relativeToUnixEpoch: lastProgramDateTimeSeconds !== null,
						firstSegment: currentFirstSegment,
						sequenceNumber: nextSequenceNumber,
						location,
						duration: nextSegmentDuration,
						encryption: key,
						initSegment: currentInitSegment,
						lastProgramDateTimeSeconds,
					};

					currentFirstSegment ??= segment;
					accumulatedTime += nextSegmentDuration;

					this.segments.push(segment);
				} else {
					// We're still seeing segments we already know about
				}

				nextSegmentDuration = null;

				if (nextByteRange === null) {
					lastByteRangeEnd = null;
				} else {
					nextByteRange = null;
				}

				setNextSequenceNumber(nextSequenceNumber + 1);
			}

			if (line.startsWith('#EXTINF:')) {
				if (prevLastSegment) {
					continue;
				}

				const extinfContent = line.slice(8);
				const commaIndex = extinfContent.indexOf(',');
				const durationStr = commaIndex === -1 ? extinfContent : extinfContent.slice(0, commaIndex);
				const duration = Number(durationStr);
				if (!Number.isFinite(duration) || duration < 0) {
					throw new Error(`Invalid #EXTINF tag duration '${durationStr}'.`);
				}

				nextSegmentDuration = duration;
			} else if (line.startsWith('#EXT-X-MAP:')) {
				const attributes = new AttributeList(line.slice(11));
				const uri = attributes.get('uri');
				if (!uri) {
					throw new Error('Invalid #EXT-X-MAP tag; missing URI attribute.');
				}

				const byteRange = attributes.get('byterange');
				if (byteRange !== null) {
					parseAndUpdateByteRange(byteRange);
				}

				if (!prevLastSegment) {
					const fullPath = joinPaths(this.path, uri);
					const location: HlsSegmentLocation = {
						path: fullPath,
						offset: nextByteRange?.offset ?? 0,
						length: nextByteRange?.length ?? null,
					};

					if (currentKey?.method === 'AES-128' && !currentKey.iv) {
						// Required by the spec
						throw new Error('IV attribute must be set on #EXT-X-KEY tag preceding the #EXT-X-MAP tag.');
					}

					const segment: HlsSegment = {
						timestamp: accumulatedTime,
						relativeToUnixEpoch: lastProgramDateTimeSeconds !== null,
						firstSegment: null,
						sequenceNumber: null,
						location,
						duration: 0,
						encryption: currentKey,
						initSegment: null,
						lastProgramDateTimeSeconds,
					};

					// Accumulated time and sequence number are not updated in this case
					currentInitSegment = segment;
				} else {
					// We're still seeing segments we already know about
				}

				nextSegmentDuration = null;

				if (nextByteRange === null) {
					lastByteRangeEnd = null;
				} else {
					nextByteRange = null;
				}
			} else if (line.startsWith('#EXT-X-KEY:')) {
				const attributes = new AttributeList(line.slice(11));
				const method = attributes.get('method');

				if (method === 'NONE') {
					currentKey = null;
				} else if (method === 'AES-128') {
					const uri = attributes.get('uri');
					if (!uri) {
						throw new Error('Invalid #EXT-X-KEY: AES-128 requires a URI attribute.');
					}

					let iv: Uint8Array | null = null;
					const ivString = attributes.get('iv');
					if (ivString) {
						if (!IV_STRING_REGEX.test(ivString)) {
							throw new Error(`Unsupported IV format '${ivString}'.`);
						}

						let hex = ivString.slice(2);
						hex = hex.padStart(AES_128_BLOCK_SIZE * 2, '0');

						iv = new Uint8Array(AES_128_BLOCK_SIZE);
						for (let i = 0; i < AES_128_BLOCK_SIZE; i++) {
							const startIndex = -AES_128_BLOCK_SIZE * 2 + i;
							iv[i] = parseInt(hex.slice(startIndex, startIndex + 2), 16);
						}
					}

					currentKey = {
						method: 'AES-128',
						keyUri: joinPaths(this.path, uri),
						iv,
						keyFormat: attributes.get('keyformat') ?? 'identity',
					};
				} else {
					throw new Error(
						`Unsupported encryption method '${method}'. If you think this method should be supported,`
						+ ` please raise an issue.`,
					);
				}
			} else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
				const value = line.slice(22);
				const number = Number(value);

				if (!Number.isInteger(number) || number < 0) {
					throw new Error(`Invalid EXT-X-MEDIA-SEQUENCE value '${value}'.`);
				}

				setNextSequenceNumber(number);
			} else if (line.startsWith('#EXT-X-BYTERANGE:')) {
				parseAndUpdateByteRange(line.slice(17));
			} else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
				if (prevLastSegment) {
					continue; // No need to spend effort parsing dates if we're gonna discard it anyway
				}

				const dateTime = line.slice(25);
				const dateTimeMs = Date.parse(dateTime);

				if (!Number.isFinite(dateTimeMs)) {
					continue;
				}

				const dateTimeSeconds = dateTimeMs / 1000;
				if (lastProgramDateTimeSeconds === dateTimeSeconds) {
					continue;
				}

				if (lastProgramDateTimeSeconds === null && this.segments.length > 0) {
					// "If the first EXT-X-PROGRAM-DATE-TIME tag in a Playlist appears after
					// one or more Media Segment URIs, the client SHOULD extrapolate
					// backward from that tag (using EXTINF durations and/or media
					// timestamps) to associate dates with those segments."
					const lastSegment = last(this.segments)!;
					const lastSegmentEnd = lastSegment.timestamp + lastSegment.duration;
					const offset = dateTimeSeconds - lastSegmentEnd;

					for (const segment of this.segments) {
						segment.timestamp += offset;
						segment.relativeToUnixEpoch = true;
					}

					accumulatedTime += offset;
				}

				lastProgramDateTimeSeconds = dateTimeSeconds;
				accumulatedTime = dateTimeSeconds; // Snap the accumulated time to the datetime
			} else if (line === '#EXT-X-DISCONTINUITY') {
				currentFirstSegment = null;
				currentInitSegment = null;
			} else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
				const value = line.slice(22);
				const duration = Number(value);

				if (!Number.isFinite(duration) || duration < 0) {
					throw new Error(`Invalid EXT-X-TARGETDURATION value '${value}'.`);
				}

				this.refreshInterval = duration;
			} else if (line === '#EXT-X-ENDLIST') {
				this.streamHasEnded = true;
				break; // No need to keep reading after this
			}
		}
	}

	async getFirstSegment() {
		if (this.segments.length === 0) {
			await this.runUpdateSegments();
		}

		return this.segments[0] ?? null;
	}

	async getSegmentAt(timestamp: number, options: SegmentRetrievalOptions) {
		if (this.segments.length === 0) {
			await this.runUpdateSegments();
		}

		// If we're skipping the live wait BUT there's no wait time, we're actually not lazy for the first iteration
		let isLazy = !!options.skipLiveWait && this.getRemainingWaitTimeMs() > 0;

		while (true) {
			const index = binarySearchLessOrEqual(this.segments, timestamp, x => x.timestamp);
			if (index === -1) {
				return null;
			}

			if (index < this.segments.length - 1 || this.streamHasEnded || isLazy) {
				return this.segments[index]!;
			}

			const segment = this.segments[index]!;
			if (timestamp < segment.timestamp + segment.duration) {
				return segment;
			}

			await this.runUpdateSegments();

			if (options.skipLiveWait) {
				isLazy = true; // Definitely lazy in the next iteration
			}
		}
	}

	async getNextSegment(segment: Segment, options: SegmentRetrievalOptions) {
		const index = this.segments.indexOf(segment as HlsSegment);
		assert(index !== -1);

		const nextIndex = index + 1;

		// If we're skipping the live wait BUT there's no wait time, we're actually not lazy for the first iteration
		let isLazy = !!options.skipLiveWait && this.getRemainingWaitTimeMs() > 0;

		while (true) {
			if (nextIndex < this.segments.length) {
				return this.segments[nextIndex]!;
			}

			if (this.streamHasEnded || isLazy) {
				return null;
			}

			await this.runUpdateSegments();

			if (options.skipLiveWait) {
				isLazy = true; // Definitely lazy in the next iteration
			}
		}
	}

	async getPreviousSegment(segment: Segment) {
		const index = this.segments.indexOf(segment as HlsSegment);
		assert(index !== -1);

		return this.segments[index - 1] ?? null;
	}

	getInputForSegment(segment: Segment): Input {
		const hlsSegment = segment as HlsSegment;

		const cacheEntry = this.inputCache.find(x => x.segment === hlsSegment);
		if (cacheEntry) {
			cacheEntry.age = this.nextInputCacheAge++;
			return cacheEntry.input;
		}

		let initInput: Input | null = null;
		if (hlsSegment.initSegment || hlsSegment.firstSegment) {
			initInput = this.getInputForSegment((hlsSegment.initSegment ?? hlsSegment.firstSegment)!);
		}

		const input = new Input({
			entryPath: hlsSegment.location.path,
			source: async (request) => {
				if (request.path !== hlsSegment.location.path) {
					// This code technically allows for recursive .m3u8 files for example. Uncached because the added
					// input adds its own layer of caching, so here we just do a passthrough.
					return this.input._getSourceUncached(request);
				}

				let source: Source;
				const needsSlice = hlsSegment.location.offset > 0 || hlsSegment.location.length !== null;

				if (!hlsSegment.encryption) {
					source = await this.input._getSourceCached(request);
					if (needsSlice) {
						source = source.slice(hlsSegment.location.offset, hlsSegment.location.length ?? undefined);
					}
				} else {
					assert(hlsSegment.encryption.iv);

					let ciphertextSource = await this.input._getSourceCached(request);
					if (needsSlice) {
						// Slice before decrypting
						ciphertextSource = ciphertextSource.slice(
							hlsSegment.location.offset,
							hlsSegment.location.length ?? undefined,
						);
					}

					const ciphertextReader = new Reader(ciphertextSource);

					const stream = createAesDecryptStream(ciphertextReader, async () => {
						const keySource = await this.input._getSourceCached(
							{ path: hlsSegment.encryption!.keyUri },
							ENCRYPTION_KEY_CACHE_GROUP,
						);
						const keyReader = new Reader(keySource);
						const keySlice = await keyReader.requestSlice(0, AES_128_BLOCK_SIZE);
						if (!keySlice) {
							throw new Error('Invalid AES-128 key; expected at least 16 bytes of data.');
						}
						const key = readBytes(keySlice, AES_128_BLOCK_SIZE);

						return { key, iv: hlsSegment.encryption!.iv! };
					});

					source = new ReadableStreamSource(stream);
				}

				return source;
			},
			formats: this.input._formats,
			initInput: initInput ?? undefined,
		});

		this.inputCache.push({
			segment: hlsSegment,
			input,
			age: this.nextInputCacheAge++,
		});

		const MAX_INPUT_CACHE_SIZE = 4;
		if (this.inputCache.length > MAX_INPUT_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this.inputCache, x => x.age);
			this.inputCache.splice(minAgeIndex, 1);
		}

		return input;
	}

	async getLiveRefreshInterval() {
		if (this.getRemainingWaitTimeMs() === 0) {
			await this.runUpdateSegments();
		}

		return this.streamHasEnded ? null : this.refreshInterval;
	}
}
