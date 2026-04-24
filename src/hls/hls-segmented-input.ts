/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AES_128_BLOCK_SIZE, createAes128CbcDecryptStream } from '../aes';
import { ENCRYPTION_KEY_CACHE_GROUP, Input } from '../input';
import { Segment, SegmentedInput, SegmentedInputTrackDeclaration, SegmentRetrievalOptions } from '../segmented-input';
import {
	toDataView,
	joinPaths,
	last,
	assert,
	binarySearchLessOrEqual,
	arrayArgmin,
	wait,
	base64ToBytes,
} from '../misc';
import { readAllLines, readBytes, Reader } from '../reader';
import { CustomPathedSource, ReadableStreamSource, SourceRef, SourceRequest } from '../source';
import { HlsDemuxer } from './hls-demuxer';
import {
	AttributeList,
	canIgnoreLine,
	TAG_BYTERANGE,
	TAG_DISCONTINUITY,
	TAG_ENDLIST,
	TAG_EXTINF,
	TAG_KEY,
	TAG_MAP,
	TAG_MEDIA_SEQUENCE,
	TAG_PLAYLIST_TYPE,
	TAG_PROGRAM_DATE_TIME,
	TAG_TARGETDURATION,
} from './hls-misc';
import { HlsInputFormat, type InputFormatOptions } from '../input-format';
import { parsePsshBoxContents, psshBoxesAreEqual, type PsshBox } from '../isobmff/isobmff-misc';

const IV_STRING_REGEX = /^0[xX][0-9a-fA-F]+$/;
const BASE64_DATA_URI_REGEX = /^data:.*;base64,/i;

export type HlsSegment = Segment & {
	sequenceNumber: number | null;
	location: HlsSegmentLocation;
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
} | {
	method: 'SAMPLE-AES' | 'SAMPLE-AES-CTR';
	psshBox: PsshBox | null;
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
		trackDeclarations: SegmentedInputTrackDeclaration[] | null,
		lines: string[] | null,
	) {
		super(demuxer.input, path, trackDeclarations);

		this.demuxer = demuxer;
		this.nextLines = lines;
	}

	runUpdateSegments() {
		return this.currentUpdateSegmentsPromise ??= (async () => {
			try {
				const remainingWaitTimeMs = this.getRemainingWaitTimeMs();
				if (remainingWaitTimeMs > 0) {
					await wait(remainingWaitTimeMs);
				}

				this.lastSegmentUpdateTime = performance.now();
				await this.updateSegments();
			} finally {
				this.currentUpdateSegmentsPromise = null;
			}
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
			using ref = await this.demuxer.input._getSourceUncached({ path: this.path, isRoot: false });
			const reader = new Reader(ref.source);

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
		let targetDuration: number | null = null;
		let segmentSeen = false;

		// Used for repeated parses where our job it is to only add the new segments
		let prevLastSegment = last(this.segments) ?? null;

		const parseByteRange = (content: string) => {
			const atIndex = content.indexOf('@');

			const length = Number(atIndex === -1 ? content : content.slice(0, atIndex));
			if (!Number.isInteger(length) || length < 0) {
				throw new Error(`Invalid #EXT-X-BYTERANGE length '${content}'.`);
			}

			let offset: number | null = null;
			if (atIndex !== -1) {
				offset = Number(content.slice(atIndex + 1));
				if (!Number.isInteger(offset) || offset < 0) {
					throw new Error(`Invalid #EXT-X-BYTERANGE offset '${content}'.`);
				}
			}

			return { length, offset };
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
						throw new Error('Invalid M3U8 file; a segment must be preceded by an #EXTINF tag.');
					}

					let key = currentKey;
					if (key && key.method === 'AES-128' && !key.iv) {
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

			if (line.startsWith(TAG_EXTINF)) {
				if (prevLastSegment) {
					segmentSeen = true;
					continue;
				}

				if (!segmentSeen) {
					if (lastProgramDateTimeSeconds === null && nextSequenceNumber > 0 && targetDuration !== null) {
						// Offset the first segment's start timestamp by the following:
						accumulatedTime = nextSequenceNumber * targetDuration;
					}

					segmentSeen = true;
				}

				const extinfContent = line.slice(TAG_EXTINF.length);
				const commaIndex = extinfContent.indexOf(',');
				const durationStr = commaIndex === -1 ? extinfContent : extinfContent.slice(0, commaIndex);
				const duration = Number(durationStr);
				if (!Number.isFinite(duration) || duration < 0) {
					throw new Error(`Invalid #EXTINF tag duration '${durationStr}'.`);
				}

				nextSegmentDuration = duration;
			} else if (line.startsWith(TAG_MAP)) {
				const attributes = new AttributeList(line.slice(TAG_MAP.length));
				const uri = attributes.get('uri');
				if (!uri) {
					throw new Error('Invalid #EXT-X-MAP tag; missing URI attribute.');
				}

				const byteRange = attributes.get('byterange');
				let parsedByteRange: ReturnType<typeof parseByteRange> | null = null;
				if (byteRange !== null) {
					parsedByteRange = parseByteRange(byteRange);
				}

				if (parsedByteRange && parsedByteRange.offset === null) {
					throw new Error('Invalid #EXT-X-MAP tag; BYTERANGE attribute must have a specified offset.');
				}

				if (!prevLastSegment) {
					const fullPath = joinPaths(this.path, uri);
					const location: HlsSegmentLocation = {
						path: fullPath,
						offset: parsedByteRange?.offset ?? 0,
						length: parsedByteRange?.length ?? null,
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
			} else if (line.startsWith(TAG_KEY)) {
				const attributes = new AttributeList(line.slice(TAG_KEY.length));
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

					const keyFormat = attributes.get('keyformat') ?? 'identity';
					if (keyFormat !== 'identity') {
						throw new Error(
							'For AES-128 encryption, only the \'identity\' KEYFORMAT is currently supported. If you'
							+ ' think other formats should be supported, please raise an issue.',
						);
					}

					currentKey = {
						method: 'AES-128',
						keyUri: joinPaths(this.path, uri),
						iv,
						keyFormat,
					};
				} else if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
					const uri = attributes.get('uri');
					if (!uri) {
						throw new Error(`Invalid #EXT-X-KEY: ${method} requires a URI attribute.`);
					}

					const keyFormat = attributes.get('keyformat') ?? 'identity';
					if (keyFormat === 'identity') {
						throw new Error(
							'For SAMPLE-AES and SAMPLE-AES-CTR encryption, the \'identity\' KEYFORMAT is not'
							+ ' supported. If you think this format should be supported, please raise an issue.',
						);
					}

					let psshBox: PsshBox | null = null;
					if (BASE64_DATA_URI_REGEX.test(uri)) {
						const commaIndex = uri.indexOf(',');
						const bytes = base64ToBytes(uri.slice(commaIndex + 1));

						if (
							bytes.length >= 8
							&& bytes[4] === 0x70
							&& bytes[5] === 0x73
							&& bytes[6] === 0x73
							&& bytes[7] === 0x68
						) {
							const size = toDataView(bytes).getUint32(0);
							psshBox = parsePsshBoxContents(bytes.subarray(8, Math.min(size, bytes.length)));
						}
					}

					currentKey = {
						method,
						psshBox,
					};
				} else {
					throw new Error(
						`Unsupported encryption method '${method}'. If you think this method should be supported,`
						+ ` please raise an issue.`,
					);
				}
			} else if (line.startsWith(TAG_MEDIA_SEQUENCE)) {
				const value = line.slice(TAG_MEDIA_SEQUENCE.length);
				const number = Number(value);

				if (!Number.isInteger(number) || number < 0) {
					throw new Error(`Invalid EXT-X-MEDIA-SEQUENCE value '${value}'.`);
				}

				setNextSequenceNumber(number);
			} else if (line.startsWith(TAG_BYTERANGE)) {
				const parsed = parseByteRange(line.slice(TAG_BYTERANGE.length));
				if (parsed.offset === null) {
					if (lastByteRangeEnd === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-BYTERANGE without offset requires a previous byte range.',
						);
					}
					parsed.offset = lastByteRangeEnd;
				}

				nextByteRange = parsed as { length: number; offset: number };
				lastByteRangeEnd = parsed.offset + parsed.length;
			} else if (line.startsWith(TAG_PROGRAM_DATE_TIME)) {
				if (prevLastSegment) {
					// No need to spend effort parsing dates if we're gonna discard it anyway. Also would be wrong to do
					// the segment shifting!
					continue;
				}

				const dateTime = line.slice(TAG_PROGRAM_DATE_TIME.length);
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
			} else if (line === TAG_DISCONTINUITY) {
				currentFirstSegment = null;
				// Note: the init segment is not reset; the #EXT-X-MAP statement simply lasts until the next
				// #EXT-X-MAP statement.
			} else if (line.startsWith(TAG_TARGETDURATION)) {
				const value = line.slice(TAG_TARGETDURATION.length);
				const duration = Number(value);

				if (!Number.isFinite(duration) || duration < 0) {
					throw new Error(`Invalid EXT-X-TARGETDURATION value '${value}'.`);
				}

				this.refreshInterval = duration;
				targetDuration = duration;
			} else if (line === TAG_ENDLIST) {
				this.streamHasEnded = true;
				break; // No need to keep reading after this
			} else if (line.startsWith(TAG_PLAYLIST_TYPE)) {
				const type = line.slice(TAG_PLAYLIST_TYPE.length);
				if (type.toLowerCase() === 'vod') {
					// A VOD playlist cannot be updated per spec so we can be sure the stream has ended
					this.streamHasEnded = true;
				}
			}
		}

		if (!headerRead) {
			throw new Error('Invalid M3U8 file; no #EXTM3U header.');
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

		const formatOptions: InputFormatOptions = {
			...this.input._formatOptions,
			isobmff: {
				...this.input._formatOptions.isobmff,
				// Intercept calls to resolveKeyId to inject our psshBox knowledge into it
				resolveKeyId: this.input._formatOptions.isobmff?.resolveKeyId && ((options) => {
					if (
						!hlsSegment.encryption
						|| !(
							hlsSegment.encryption.method === 'SAMPLE-AES'
							|| hlsSegment.encryption.method === 'SAMPLE-AES-CTR'
						)
						|| !hlsSegment.encryption.psshBox
					) {
						return this.input._formatOptions.isobmff!.resolveKeyId!(options);
					}

					let psshBoxes = options.psshBoxes;
					const { psshBox } = hlsSegment.encryption;

					if (
						(psshBox.keyIds === null || psshBox.keyIds.includes(options.keyId))
						&& !psshBoxes.some(x => psshBoxesAreEqual(x, psshBox))
					) {
						psshBoxes = [...psshBoxes, psshBox];
					}

					return this.input._formatOptions.isobmff!.resolveKeyId!({ ...options, psshBoxes });
				}),
			},
		};

		const input = new Input({
			source: new CustomPathedSource(
				hlsSegment.location.path,
				async (request) => {
					assert(request.isRoot); // Shouldn't fail since we don't allow recursive HLS

					const proxiedRequest: SourceRequest = {
						...request,
						isRoot: false,
					};

					let ref: SourceRef;
					const needsSlice = hlsSegment.location.offset > 0 || hlsSegment.location.length !== null;

					if (
						!hlsSegment.encryption
						|| hlsSegment.encryption.method === 'SAMPLE-AES'
						|| hlsSegment.encryption.method === 'SAMPLE-AES-CTR'
					) {
						ref = await this.input._getSourceCached(proxiedRequest);

						if (needsSlice) {
							const slice = ref.source.slice(
								hlsSegment.location.offset,
								hlsSegment.location.length ?? undefined,
							);
							const sliceRef = slice.ref();
							ref.free();
							ref = sliceRef;
						}
					} else if (hlsSegment.encryption.method === 'AES-128') {
						const encryption = hlsSegment.encryption;
						assert(encryption.iv);

						let ciphertextRef = await this.input._getSourceCached(proxiedRequest);
						if (needsSlice) {
							// Slice before decrypting
							const slice = ciphertextRef.source.slice(
								hlsSegment.location.offset,
								hlsSegment.location.length ?? undefined,
							);
							const sliceRef = slice.ref();
							ciphertextRef.free();
							ciphertextRef = sliceRef;
						}

						const ciphertextReader = new Reader(ciphertextRef.source);

						const stream = createAes128CbcDecryptStream(ciphertextReader, async () => {
							using keyRef = await this.input._getSourceCached(
								{ path: encryption.keyUri, isRoot: false },
								ENCRYPTION_KEY_CACHE_GROUP,
							);
							const keyReader = new Reader(keyRef.source);
							const keySlice = await keyReader.requestSlice(0, AES_128_BLOCK_SIZE);
							if (!keySlice) {
								throw new Error('Invalid AES-128 key; expected at least 16 bytes of data.');
							}
							const key = readBytes(keySlice, AES_128_BLOCK_SIZE);

							return { key, iv: encryption.iv! };
						}, () => {
							ciphertextRef.free();
						});

						ref = new ReadableStreamSource(stream).ref();
					} else {
						assert(false);
					}

					return ref;
				},
			),
			// Do not allow recursive HLS. Cool on paper, but allows for nasty infinite-depth request trees.
			formats: this.input._formats.filter(x => !(x instanceof HlsInputFormat)),
			initInput: initInput ?? undefined,
			formatOptions,
		});

		input._onFormatDetermined = (format) => {
			if (
				(hlsSegment.encryption?.method === 'SAMPLE-AES' || hlsSegment.encryption?.method === 'SAMPLE-AES-CTR')
				&& !format._isIsobmff
			) {
				// These methods can also be used for formats such as MPEG-TS
				// eslint-disable-next-line @stylistic/max-len
				// (see https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/HLS_Sample_Encryption/Encryption/Encryption.html)
				// but we don't support them there yet, so instead of silently decrypting nothing, we throw an error.
				throw new Error(
					'The SAMPLE-AES and SAMPLE-AES-CTR encryption methods are currently only supported for'
					+ ' ISOBMFF files.',
				);
			}
		};

		this.inputCache.push({
			segment: hlsSegment,
			input,
			age: this.nextInputCacheAge++,
		});

		const MAX_INPUT_CACHE_SIZE = 4;
		if (this.inputCache.length > MAX_INPUT_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this.inputCache, x => x.age);
			assert(minAgeIndex !== -1);
			this.inputCache.splice(minAgeIndex, 1);

			// DON'T dispose here; the Input might still be used! The source disposal will happen with GC logic
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
