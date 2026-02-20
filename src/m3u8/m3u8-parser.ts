/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AES_128_BLOCK_SIZE } from '../aes';
import { ManifestInput } from '../manifest-input';
import { ManifestParser } from '../manifest-parser';
import { AssociatedGroup, ManifestInputVariant } from '../manifest-input-variant';
import { AsyncMutex, binarySearchLessOrEqual, joinPaths, last, toDataView } from '../misc';
import { LineReader, Reader } from '../reader';
import { ManifestInputSegment, ManifestInputSegmentLocation, SegmentEncryptionInfo } from '../manifest-input-segment';
import { inferCodecFromCodecString, MediaCodec } from '../codec';

const IV_STRING_REGEX = /^0[xX][0-9a-fA-F]+$/;

export class M3u8Parser extends ManifestParser {
	metadataPromise: Promise<void> | null = null;
	variants: M3u8ManifestVariant[] = [];
	lineReader: LineReader;

	constructor(input: ManifestInput) {
		super(input);
		this.lineReader = new LineReader(() => input._entryReader, canIgnoreLine);
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			let line = this.lineReader.readNextLine();
			if (line instanceof Promise) line = await line;

			if (line !== '#EXTM3U') {
				throw new Error('Invalid M3U8 file; expected first line to be #EXTM3U.');
			}

			let iFramesOnlyTagFound = false;

			while (true) {
				let line = this.lineReader.readNextLine();
				if (line instanceof Promise) line = await line;

				if (line === null) {
					break;
				}

				if (line.startsWith('#EXT-X-STREAM-INF:')) {
					let playlistPath = this.lineReader.readNextLine();
					if (playlistPath instanceof Promise) playlistPath = await playlistPath;

					if (playlistPath === null) {
						throw new Error('Incorrect M3U8 file; a line must follow the #EXT-X-STREAM-INF tag.');
					}

					const fullPath = joinPaths(this._input._entryPath, playlistPath);
					const attributes = new AttributeList(line.slice(18));

					this.pushOrMergeVariant(
						fullPath,
						null,
						attributes,
						false,
					);
				} else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
					const attributes = new AttributeList(line.slice(18));
					const playlistPath = attributes.get('uri');

					if (playlistPath === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-I-FRAME-STREAM-INF tag requires a URI attribute.',
						);
					}

					const fullPath = joinPaths(this._input._entryPath, playlistPath);

					this.pushOrMergeVariant(
						fullPath,
						null,
						attributes,
						true,
					);
				} else if (line.startsWith('#EXT-X-MEDIA:')) {
					const attributes = new AttributeList(line.slice(13));

					const groupId = attributes.get('group-id');
					if (groupId === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-MEDIA tag requires a GROUP-ID attribute.',
						);
					}

					const uri = attributes.get('uri');
					if (uri === null) {
						continue;
					}

					const fullPath = joinPaths(this._input._entryPath, uri);

					this.pushOrMergeVariant(
						fullPath,
						null,
						attributes,
						false,
					);
				} else if (line === '#EXT-X-I-FRAMES-ONLY') {
					iFramesOnlyTagFound = true;
				} else if (line.startsWith('#EXTINF:')) {
					// This is a media playlist, not a master playlist

					this.variants = [
						new M3u8ManifestVariant(
							this,
							this._input._entryPath,
							this.lineReader.reader,
							new AttributeList(''),
							iFramesOnlyTagFound,
						),
					];

					break;
				}
			}
		})();
	}

	pushOrMergeVariant(
		path: string,
		reader: Reader | null,
		attributes: AttributeList,
		isKeyFrameOnly: boolean,
	) {
		const existing = this.variants.find(v => v.path === path);
		if (existing) {
			// Sometimes the same path exists multiple times, so let's just aggregate the data then
			// (instead of showing the variant twice)
			existing._attributes.merge(attributes);
			existing._isKeyFrameOnly = isKeyFrameOnly;
		} else {
			this.variants.push(new M3u8ManifestVariant(
				this,
				path,
				reader,
				attributes,
				isKeyFrameOnly,
			));
		}
	}

	override async getVariants() {
		await this.readMetadata();
		return this.variants;
	}
}

export class M3u8ManifestVariant extends ManifestInputVariant {
	_attributes: AttributeList;
	_isKeyFrameOnly: boolean;
	_parser: M3u8Parser;
	_lineReader: LineReader;
	_segments: ManifestInputSegment[] = [];
	_nextSegmentDuration: number | null = null;
	_nextSegmentTitle: string | null = null;
	_accumulatedTime = 0;
	_headerRead = false;
	_mutex = new AsyncMutex();
	_currentKey: SegmentEncryptionInfo | null = null;
	_nextSequenceNumber = 0;
	_currentFirstSegment: ManifestInputSegment | null = null;
	_currentInitSegment: ManifestInputSegment | null = null;
	_lastByteRangeEnd: number | null = null;
	_nextByteRange: { offset: number; length: number } | null = null;

	/** @internal */
	constructor(
		parser: M3u8Parser,
		path: string,
		reader: Reader | null,
		attributes: AttributeList,
		isKeyFrameOnly: boolean,
	) {
		super(parser._input, path);

		this._attributes = attributes;
		this._isKeyFrameOnly = isKeyFrameOnly;
		this._parser = parser;

		if (reader) {
			this._lineReader = new LineReader(() => reader, canIgnoreLine);
		} else {
			this._lineReader = new LineReader(async () => {
				const source = await this.input._getSourceUncached(this.path);
				return new Reader(source);
			}, canIgnoreLine);
		}
	}

	get metadata() {
		const codecStrings = this._getCodecStrings();
		const codecs = codecStrings.map(x => inferCodecFromCodecString(x)).filter(Boolean) as MediaCodec[];

		return {
			name: this._attributes.get('name'),
			bitrate: this._attributes.getAsNumber('bandwidth'),
			averageBitrate: this._attributes.getAsNumber('average-bandwidth'),
			codecs,
			codecStrings,
			resolution: this._getResolution(),
			frameRate: this._attributes.getAsNumber('frame-rate'),
			isKeyFrameOnly: this._isKeyFrameOnly,
		};
	}

	get groupId() {
		return this._attributes.get('group-id');
	}

	get associatedGroups() {
		const groups: AssociatedGroup[] = [];

		const videoGroupId = this._attributes.get('video');
		if (videoGroupId) {
			groups.push({ id: videoGroupId, type: 'video' });
		}

		const audioGroupId = this._attributes.get('audio');
		if (audioGroupId) {
			groups.push({ id: audioGroupId, type: 'audio' });
		}

		const subtitlesGroupId = this._attributes.get('subtitles');
		if (subtitlesGroupId) {
			groups.push({ id: subtitlesGroupId, type: 'subtitles' });
		}

		const closedCaptionsGroupId = this._attributes.get('closed-captions');
		if (closedCaptionsGroupId) {
			groups.push({ id: closedCaptionsGroupId, type: 'closed-captions' });
		}

		return groups;
	}

	_getCodecStrings() {
		const value = this._attributes.get('codecs');
		if (!value) {
			return [];
		}

		return value.split(',').map(x => x.trim()).filter(x => x);
	}

	_getResolution() {
		const value = this._attributes.get('resolution');
		if (!value) {
			return null;
		}

		const match = value.match(/^(\d+)x(\d+)$/);
		if (!match) {
			return null;
		}

		return {
			width: Number(match[1]),
			height: Number(match[2]),
		};
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

	async getNextSegment(segment: ManifestInputSegment) {
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

	async getPreviousSegment(segment: ManifestInputSegment): Promise<ManifestInputSegment | null> {
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
					const location: ManifestInputSegmentLocation = {
						path: fullPath,
						offset: this._nextByteRange?.offset ?? 0,
						length: this._nextByteRange?.length ?? null,
					};

					const segment = new ManifestInputSegment(
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
					const location: ManifestInputSegmentLocation = {
						path: fullPath,
						offset: this._nextByteRange?.offset ?? 0,
						length: this._nextByteRange?.length ?? null,
					};

					if (this._currentKey?.method === 'AES-128' && !this._currentKey.iv) {
						// Required by the spec
						throw new Error('IV attribute must be set on #EXT-X-KEY tag preceding the #EXT-X-MAP tag.');
					}

					const segment = new ManifestInputSegment(
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

const canIgnoreLine = (line: string) => line.length === 0 || (line.startsWith('#') && !line.startsWith('#EXT'));

class AttributeList {
	_attributes: Record<string, string> = {};

	constructor(str: string) {
		let key = '';
		let value = '';
		let inValue = false;
		let inQuotes = false;

		for (let i = 0; i < str.length; i++) {
			const char = str[i]!;

			if (char === '"') {
				inQuotes = !inQuotes;
			} else if (char === '=' && !inValue && !inQuotes) {
				inValue = true;
			} else if (char === ',' && !inQuotes) {
				if (key) {
					this._attributes[key.toLowerCase()] = value;
				}

				key = '';
				value = '';
				inValue = false;
			} else if (inValue) {
				value += char;
			} else {
				key += char;
			}
		}

		if (key) {
			this._attributes[key.toLowerCase()] = value;
		}
	}

	get(name: string) {
		return this._attributes[name.toLowerCase()] ?? null;
	}

	getAsNumber(name: string) {
		const value = this.get(name);
		if (value === null) {
			return null;
		}

		const num = Number(value);
		return Number.isFinite(num) ? num : null;
	}

	merge(other: AttributeList) {
		Object.assign(this._attributes, other._attributes);
	}
}
