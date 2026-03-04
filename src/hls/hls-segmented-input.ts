import { AES_128_BLOCK_SIZE } from '../aes';
import { Segment, SegmentEncryptionInfo, SegmentLocation } from '../segment';
import { SegmentedInput } from '../segmented-input';
import { toDataView, joinPaths, last } from '../misc';
import { LineReader, Reader } from '../reader';
import { HlsDemuxer } from './hls-demuxer';
import { AttributeList, canIgnoreLine } from './hls-misc';

const IV_STRING_REGEX = /^0[xX][0-9a-fA-F]+$/;

export class HlsSegmentedInput extends SegmentedInput {
	demuxer: HlsDemuxer;
	nextSegmentDuration: number | null = null;
	nextSegmentTitle: string | null = null;
	accumulatedTime = 0;
	headerRead = false;
	segmentsPromise: Promise<Segment[]>;
	currentKey: SegmentEncryptionInfo | null = null;
	nextSequenceNumber = 0;
	currentFirstSegment: Segment | null = null;
	currentInitSegment: Segment | null = null;
	lastByteRangeEnd: number | null = null;
	nextByteRange: { offset: number; length: number } | null = null;
	lastProgramDateTimeSeconds: number | null = null;

	constructor(
		demuxer: HlsDemuxer,
		path: string,
		reader: Reader | null,
	) {
		super(demuxer.input, path);

		this.demuxer = demuxer;

		let lineReader: LineReader;
		if (reader) {
			lineReader = new LineReader(() => reader, canIgnoreLine);
		} else {
			lineReader = new LineReader(async () => {
				const source = await this.demuxer.input._getSourceUncached({ path: this.path });
				return new Reader(source);
			}, canIgnoreLine);
		}

		this.segmentsPromise ??= (async () => {
			const segments: Segment[] = [];

			while (true) {
				let line = lineReader.readNextLine();
				if (line instanceof Promise) line = await line;

				if (line === null) {
					break;
				}

				if (!this.headerRead) {
					if (line !== '#EXTM3U') {
						throw new Error('Invalid M3U8 file; expected first line to be #EXTM3U.');
					}

					this.headerRead = true;
					continue;
				}

				if (!line.startsWith('#')) {
					if (this.nextSegmentDuration === null) {
						throw new Error('Invalid M3U8 file; a segment must be preceeded by a #EXTINF tag.');
					}

					let key = this.currentKey;
					if (key && !key.iv) {
						// "the Media Sequence Number is to be used as the IV when decrypting a Media Segment, by
						// putting its big-endian binary representation into a 16-octet (128-bit) buffer and padding
						// (on the left) with zeros"

						const iv = new Uint8Array(AES_128_BLOCK_SIZE);
						const view = toDataView(iv);
						view.setUint32(8, Math.floor(this.nextSequenceNumber / (2 ** 32)));
						view.setUint32(12, this.nextSequenceNumber);

						key = { ...key, iv };
					}

					const fullPath = joinPaths(this.path, line);
					const location: SegmentLocation = {
						path: fullPath,
						offset: this.nextByteRange?.offset ?? 0,
						length: this.nextByteRange?.length ?? null,
					};

					const segment = new Segment(
						this,
						location,
						this.accumulatedTime,
						this.lastProgramDateTimeSeconds !== null,
						this.nextSegmentDuration,
						this.nextSegmentTitle,
						key,
						this.currentFirstSegment,
						this.currentInitSegment,
					);
					segments.push(segment);
					this.accumulatedTime += this.nextSegmentDuration;
					this.nextSequenceNumber++;
					this.currentFirstSegment ??= segment;

					this.nextSegmentDuration = null;
					this.nextSegmentTitle = null;

					if (this.nextByteRange === null) {
						this.lastByteRangeEnd = null;
					} else {
						this.nextByteRange = null;
					}
				}

				if (line.startsWith('#EXTINF:')) {
					const extinfContent = line.slice(8);
					const commaIndex = extinfContent.indexOf(',');
					const durationStr = commaIndex === -1 ? extinfContent : extinfContent.slice(0, commaIndex);
					const duration = Number(durationStr);
					if (!Number.isFinite(duration) || duration < 0) {
						throw new Error(`Invalid #EXTINF tag duration '${durationStr}'.`);
					}
					const title = commaIndex === -1 ? null : extinfContent.slice(commaIndex + 1).trim() || null;

					this.nextSegmentDuration = duration;
					this.nextSegmentTitle = title;
				} else if (line.startsWith('#EXT-X-MAP:')) {
					const attributes = new AttributeList(line.slice(11));
					const uri = attributes.get('uri');
					if (!uri) {
						throw new Error('Invalid #EXT-X-MAP tag; missing URI attribute.');
					}

					const byteRange = attributes.get('byterange');
					if (byteRange !== null) {
						this.parseAndUpdateByteRange(byteRange);
					}

					const fullPath = joinPaths(this.path, uri);
					const location: SegmentLocation = {
						path: fullPath,
						offset: this.nextByteRange?.offset ?? 0,
						length: this.nextByteRange?.length ?? null,
					};

					if (this.currentKey?.method === 'AES-128' && !this.currentKey.iv) {
						// Required by the spec
						throw new Error('IV attribute must be set on #EXT-X-KEY tag preceding the #EXT-X-MAP tag.');
					}

					const segment = new Segment(
						this,
						location,
						this.accumulatedTime,
						this.lastProgramDateTimeSeconds !== null,
						0,
						null,
						this.currentKey,
						null,
						null,
					);

					// Accumulated time and sequence number are not updated in this case
					this.currentInitSegment = segment;

					this.nextSegmentDuration = null;
					this.nextSegmentTitle = null;

					if (this.nextByteRange === null) {
						this.lastByteRangeEnd = null;
					} else {
						this.nextByteRange = null;
					}
				} else if (line.startsWith('#EXT-X-KEY:')) {
					const attributes = new AttributeList(line.slice(11));
					const method = attributes.get('method');

					if (method === 'NONE') {
						this.currentKey = null;
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

						this.currentKey = {
							method: 'AES-128',
							keyUri: joinPaths(this.path, uri),
							iv,
							keyFormat: attributes.get('keyformat') ?? 'identity',
						};
					} else {
						throw new Error(`Unsupported encryption method '${method}'.`);
					}
				} else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
					const value = line.slice(22);
					const number = Number(value);

					if (!Number.isInteger(number) || number < 0) {
						throw new Error(`Invalid EXT-X-MEDIA-SEQUENCE value '${value}'.`);
					}

					this.nextSequenceNumber = number;
				} else if (line.startsWith('#EXT-X-BYTERANGE:')) {
					this.parseAndUpdateByteRange(line.slice(17));
				} else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
					const dateTime = line.slice(25);
					const dateTimeMs = Date.parse(dateTime);

					if (!Number.isFinite(dateTimeMs)) {
						continue;
					}

					const dateTimeSeconds = dateTimeMs / 1000;
					if (this.lastProgramDateTimeSeconds === dateTimeSeconds) {
						continue;
					}

					if (this.lastProgramDateTimeSeconds === null && segments.length > 0) {
						// "If the first EXT-X-PROGRAM-DATE-TIME tag in a Playlist appears after
						// one or more Media Segment URIs, the client SHOULD extrapolate
						// backward from that tag (using EXTINF durations and/or media
						// timestamps) to associate dates with those segments."
						const lastSegment = last(segments)!;
						const lastSegmentEnd = lastSegment.relativeTimestamp + lastSegment.duration;
						const offset = dateTimeSeconds - lastSegmentEnd;

						for (const segment of segments) {
							segment.relativeTimestamp += offset;
							segment.relativeToUnixEpoch = true;
						}

						this.accumulatedTime += offset;
					}

					this.lastProgramDateTimeSeconds = dateTimeSeconds;

					if (Math.abs(this.accumulatedTime - dateTimeSeconds) >= 1) {
						// Only snap to the datetime if the current time is sufficiently far away from it. If we always
						// snapped, we'd lose the sub-second accuracy that's often provided by precise
						// segment durations.
						this.accumulatedTime = dateTimeSeconds;
					}
				} else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
					this.currentFirstSegment = null;
					this.currentInitSegment = null;
				}
			}

			return segments;
		})();
	}

	parseAndUpdateByteRange(content: string) {
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
			if (this.lastByteRangeEnd === null) {
				throw new Error(
					'Invalid M3U8 file; #EXT-X-BYTERANGE without offset requires a previous byte range.',
				);
			}
			offset = this.lastByteRangeEnd;
		}

		this.nextByteRange = { offset, length };
		this.lastByteRangeEnd = offset + length;
	}

	async getSegments() {
		return this.segmentsPromise;
	}
}
