import { AES_128_BLOCK_SIZE } from '../aes';
import { Segment, SegmentEncryptionInfo, SegmentLocation } from '../segment';
import { SegmentedInput } from '../segmented-input';
import { AsyncMutex, binarySearchLessOrEqual, toDataView, joinPaths, last } from '../misc';
import { LineReader, Reader } from '../reader';
import { HlsDemuxer } from './hls-demuxer';
import { AttributeList, canIgnoreLine } from './hls-misc';

const IV_STRING_REGEX = /^0[xX][0-9a-fA-F]+$/;

export class HlsSegmentedInput extends SegmentedInput {
	_demuxer: HlsDemuxer;
	_lineReader: LineReader;
	_segments: Segment[] = [];
	_nextSegmentDuration: number | null = null;
	_nextSegmentTitle: string | null = null;
	_accumulatedTime = 0;
	_headerRead = false;
	_mutex = new AsyncMutex();
	_currentKey: SegmentEncryptionInfo | null = null;
	_nextSequenceNumber = 0;
	_currentFirstSegment: Segment | null = null;
	_currentInitSegment: Segment | null = null;
	_lastByteRangeEnd: number | null = null;
	_nextByteRange: { offset: number; length: number } | null = null;

	/** @internal */
	constructor(
		demuxer: HlsDemuxer,
		path: string,
		reader: Reader | null,
	) {
		super(demuxer.input, path);

		this._demuxer = demuxer;

		if (reader) {
			this._lineReader = new LineReader(() => reader, canIgnoreLine);
		} else {
			this._lineReader = new LineReader(async () => {
				const source = await this._demuxer.input._getSourceUncached({ path: this.path });
				return new Reader(source);
			}, canIgnoreLine);
		}
	}

	async getFirstSegment() {
		if (this._segments.length === 0) {
			await this._readNextSegment();
		}

		return this._segments[0] ?? null;
	}

	async getSegmentAt(relativeTimestamp: number) {
		await this._readUntilSegmentAt(relativeTimestamp);

		const index = binarySearchLessOrEqual(this._segments, relativeTimestamp, x => x.relativeTimestamp);
		if (index === -1) {
			return null;
		}

		return this._segments[index]!;
	}

	async getNextSegment(segment: Segment) {
		const index = this._segments.indexOf(segment);
		if (index === -1) {
			throw new Error('Segment was not created by this variant.');
		}

		if (index + 1 < this._segments.length) {
			return this._segments[index + 1]!;
		}

		if (this._lineReader.reachedEnd) {
			return null;
		}

		await this._readNextSegment();
		return this._segments[index + 1] ?? null;
	}

	async getPreviousSegment(segment: Segment): Promise<Segment | null> {
		const index = this._segments.indexOf(segment);
		if (index === -1) {
			throw new Error('Segment was not created by this variant.');
		}

		if (index - 1 >= 0) {
			return this._segments[index - 1]!;
		}

		return null;
	}

	async _readNextSegment() {
		const segmentCount = this._segments.length;
		const release = await this._mutex.acquire();

		try {
			if (segmentCount < this._segments.length) {
				// The next segment has already been read by someone else, great
				return;
			}

			while (true) {
				let line = this._lineReader.readNextLine();
				if (line instanceof Promise) line = await line;

				if (line === null) {
					return;
				}

				if (!this._headerRead) {
					if (line !== '#EXTM3U') {
						throw new Error('Invalid M3U8 file; expected first line to be #EXTM3U.');
					}

					this._headerRead = true;
					continue;
				}

				if (!line.startsWith('#')) {
					if (this._nextSegmentDuration === null) {
						throw new Error('Invalid M3U8 file; a segment must be preceeded by a #EXTINF tag.');
					}

					let key = this._currentKey;
					if (key && !key.iv) {
						// "the Media Sequence Number is to be used as the IV when decrypting a Media Segment, by
						// putting its big-endian binary representation into a 16-octet (128-bit) buffer and padding
						// (on the left) with zeros"

						const iv = new Uint8Array(AES_128_BLOCK_SIZE);
						const view = toDataView(iv);
						view.setUint32(8, Math.floor(this._nextSequenceNumber / (2 ** 32)));
						view.setUint32(12, this._nextSequenceNumber);

						key = { ...key, iv };
					}

					const fullPath = joinPaths(this.path, line);
					const location: SegmentLocation = {
						path: fullPath,
						offset: this._nextByteRange?.offset ?? 0,
						length: this._nextByteRange?.length ?? null,
					};

					const segment = new Segment(
						this,
						location,
						this._accumulatedTime,
						this._nextSegmentDuration,
						this._nextSegmentTitle,
						key,
						this._currentFirstSegment,
						this._currentInitSegment,
					);
					this._segments.push(segment);
					this._accumulatedTime += this._nextSegmentDuration;
					this._nextSequenceNumber++;
					this._currentFirstSegment ??= segment;

					this._nextSegmentDuration = null;
					this._nextSegmentTitle = null;

					if (this._nextByteRange === null) {
						this._lastByteRangeEnd = null;
					} else {
						this._nextByteRange = null;
					}

					return;
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

					this._nextSegmentDuration = duration;
					this._nextSegmentTitle = title;
				} else if (line.startsWith('#EXT-X-MAP:')) {
					const attributes = new AttributeList(line.slice(11));
					const uri = attributes.get('uri');
					if (!uri) {
						throw new Error('Invalid #EXT-X-MAP tag; missing URI attribute.');
					}

					const byteRange = attributes.get('byterange');
					if (byteRange !== null) {
						this._parseAndUpdateByteRange(byteRange);
					}

					const fullPath = joinPaths(this.path, uri);
					const location: SegmentLocation = {
						path: fullPath,
						offset: this._nextByteRange?.offset ?? 0,
						length: this._nextByteRange?.length ?? null,
					};

					if (this._currentKey?.method === 'AES-128' && !this._currentKey.iv) {
						// Required by the spec
						throw new Error('IV attribute must be set on #EXT-X-KEY tag preceding the #EXT-X-MAP tag.');
					}

					const segment = new Segment(
						this,
						location,
						this._accumulatedTime,
						0,
						null,
						this._currentKey,
						null,
						null,
					);

					// Accumulated time and sequence number are not updated in this case
					this._currentInitSegment = segment;

					this._nextSegmentDuration = null;
					this._nextSegmentTitle = null;

					if (this._nextByteRange === null) {
						this._lastByteRangeEnd = null;
					} else {
						this._nextByteRange = null;
					}
				} else if (line.startsWith('#EXT-X-KEY:')) {
					const attributes = new AttributeList(line.slice(11));
					const method = attributes.get('method');

					if (method === 'NONE') {
						this._currentKey = null;
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

						this._currentKey = {
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

					this._nextSequenceNumber = number;
				} else if (line.startsWith('#EXT-X-BYTERANGE:')) {
					this._parseAndUpdateByteRange(line.slice(17));
				} else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
					this._currentFirstSegment = null;
					this._currentInitSegment = null;
				}
			}
		} finally {
			release();
		}
	}

	_parseAndUpdateByteRange(content: string) {
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
			if (this._lastByteRangeEnd === null) {
				throw new Error(
					'Invalid M3U8 file; #EXT-X-BYTERANGE without offset requires a previous byte range.',
				);
			}
			offset = this._lastByteRangeEnd;
		}

		this._nextByteRange = { offset, length };
		this._lastByteRangeEnd = offset + length;
	}

	async _readUntilSegmentAt(relativeTimestamp: number) {
		while (!this._lineReader.reachedEnd) {
			const lastSegment = last(this._segments);
			if (lastSegment && lastSegment.relativeTimestamp > relativeTimestamp) {
				break;
			}

			await this._readNextSegment();
		}
	}
}
