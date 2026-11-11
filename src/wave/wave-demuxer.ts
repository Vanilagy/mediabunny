/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	createUtcDate,
	floorToMultiple,
	isThenable,
	parseIsoSuffix,
	roundIfAlmostInteger,
	strictTextDecoder,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readAscii, readBytes, Reader, readU16, readU32, readU64 } from '../reader';
import { ID3_V2_HEADER_SIZE, parseId3V2Tag, readId3V2Header } from '../id3';

export enum WaveFormat {
	PCM = 0x0001,
	IEEE_FLOAT = 0x0003,
	ALAW = 0x0006,
	MULAW = 0x0007,
	EXTENSIBLE = 0xFFFE,
}

export class WaveDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	dataStart = -1;
	dataSize = -1;
	dataSizeCapped = false;
	dataSizeIsPlaceholder = false;
	audioInfo: {
		format: number;
		numberOfChannels: number;
		sampleRate: number;
		sampleSizeInBytes: number;
		blockSizeInBytes: number;
	} | null = null;

	trackBackings: WaveAudioTrackBacking[] = [];
	metadataTags: MetadataTags = {};

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let slice = this.reader.requestSlice(0, 12);
			if (isThenable(slice)) slice = await slice;
			assert(slice);

			const riffType = readAscii(slice, 4);
			const littleEndian = riffType !== 'RIFX';

			const isRf64 = riffType === 'RF64';

			const outerChunkSize = readU32(slice, littleEndian);

			// A RIFF size of 0 means the file was probably never finalized
			let sizesUnfinalized = !isRf64 && outerChunkSize === 0;

			let totalFileSize = isRf64 || sizesUnfinalized
				? this.reader.fileSize
				: Math.min(outerChunkSize + 8, this.reader.fileSize ?? Infinity);
			const format = readAscii(slice, 4);

			if (format !== 'WAVE') {
				throw new Error('Invalid WAVE file - wrong format');
			}

			let chunksRead = 0;
			let dataChunkSize: number | null = null;
			let currentPos = slice.filePos;

			while (totalFileSize === null || currentPos < totalFileSize) {
				let slice = this.reader.requestSlice(currentPos, 8);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const chunkId = readAscii(slice, 4);
				let chunkSize = readU32(slice, littleEndian);
				const startPos = slice.filePos;

				if (isRf64 && chunksRead === 0 && chunkId !== 'ds64') {
					throw new Error('Invalid RF64 file: First chunk must be "ds64".');
				}

				if (chunkId === 'fmt ') {
					await this.parseFmtChunk(startPos, chunkSize, littleEndian);
				} else if (chunkId === 'data') {
					dataChunkSize ??= chunkSize;
					if (sizesUnfinalized && dataChunkSize === 0) {
						// The data goes until the end of the file
						dataChunkSize = Number.MAX_SAFE_INTEGER;
						chunkSize = dataChunkSize;
					}

					this.dataSizeIsPlaceholder = dataChunkSize === Number.MAX_SAFE_INTEGER
						|| (!isRf64 && dataChunkSize === 0xffffffff);
					if (isRf64) {
						// The chunk's own size field is only a placeholder, so make sure to skip over the actual data
						chunkSize = dataChunkSize;
					}

					this.dataStart = slice.filePos;
					this.dataSize = Math.max(Math.min(dataChunkSize, (totalFileSize ?? Infinity) - this.dataStart), 0);

					if (this.reader.fileSize === null) {
						break; // Stop once we hit the data chunk
					}
				} else if (chunkId === 'ds64') {
					// File and data chunk sizes are defined in here instead

					let ds64Slice = this.reader.requestSlice(startPos, chunkSize);
					if (isThenable(ds64Slice)) ds64Slice = await ds64Slice;
					if (!ds64Slice) break;

					if (chunkSize < 16) {
						throw new Error('Invalid RF64 file: "ds64" chunk is too small.');
					}

					// Sizes past what a JS number can address exactly can't be real, they're just placeholders. We need
					// to cap here to make sure the downstream math still works correctly
					const riffChunkSize = Math.min(readU64(ds64Slice, littleEndian), Number.MAX_SAFE_INTEGER);
					dataChunkSize = Math.min(readU64(ds64Slice, littleEndian), Number.MAX_SAFE_INTEGER);

					sizesUnfinalized = riffChunkSize === 0;
					totalFileSize = sizesUnfinalized
						? this.reader.fileSize
						: Math.min(riffChunkSize + 8, this.reader.fileSize ?? Infinity);
				} else if (chunkId === 'LIST') {
					await this.parseListChunk(startPos, chunkSize, littleEndian);
				} else if (chunkId === 'ID3 ' || chunkId === 'id3 ') {
					await this.parseId3Chunk(startPos, chunkSize);
				}

				currentPos = startPos + chunkSize + (chunkSize & 1); // Handle padding
				chunksRead++;
			}

			if (!this.audioInfo) {
				throw new Error('Invalid WAVE file - missing "fmt " chunk');
			}
			if (this.dataStart === -1) {
				throw new Error('Invalid WAVE file - missing "data" chunk');
			}

			const blockSize = this.audioInfo.blockSizeInBytes;
			this.dataSize = Math.floor(this.dataSize / blockSize) * blockSize;
			this.maybeCapDataSize();

			this.trackBackings.push(new WaveAudioTrackBacking(this));
		})();
	}

	private async parseFmtChunk(startPos: number, size: number, littleEndian: boolean) {
		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		if (size < 14) {
			throw new Error('Invalid WAVE file - "fmt " chunk is too small');
		}

		let formatTag = readU16(slice, littleEndian);
		const numChannels = readU16(slice, littleEndian);
		const sampleRate = readU32(slice, littleEndian);
		slice.skip(4); // Bytes per second
		const blockAlign = readU16(slice, littleEndian);

		if (numChannels === 0 || sampleRate === 0 || blockAlign === 0) {
			throw new Error('Invalid WAVE file - channel count, sample rate and block align must be positive');
		}

		let bitsPerSample: number;

		if (size < 16) { // Plain WAVEFORMAT
			bitsPerSample = 8;
		} else {
			bitsPerSample = readU16(slice, littleEndian);
		}

		// Handle WAVEFORMATEXTENSIBLE
		if (size >= 18 && formatTag !== 0x0165) {
			const cbSize = readU16(slice, littleEndian);
			const remainingSize = size - 18;
			const extensionSize = Math.min(remainingSize, cbSize);

			if (extensionSize >= 22 && formatTag === WaveFormat.EXTENSIBLE) {
				// Parse WAVEFORMATEXTENSIBLE
				slice.skip(2 + 4);
				const subFormat = readBytes(slice, 16);

				// Get actual format from subFormat GUID
				formatTag = subFormat[0]! | (subFormat[1]! << 8);
			}
		}

		if (formatTag === WaveFormat.MULAW || formatTag === WaveFormat.ALAW) {
			bitsPerSample = 8;
		}

		if (
			formatTag !== WaveFormat.PCM
			&& formatTag !== WaveFormat.IEEE_FLOAT
			&& formatTag !== WaveFormat.ALAW
			&& formatTag !== WaveFormat.MULAW
		) {
			throw new Error(
				`Unsupported WAVE codec (format tag ${formatTag}). Only integer/float PCM, A-law, and μ-law are`
				+ ` supported.`,
			);
		}
		if (formatTag === WaveFormat.PCM && ![8, 16, 24, 32].includes(bitsPerSample)) {
			throw new Error(
				`Unsupported WAVE PCM bit depth (${bitsPerSample}). Only 8, 16, 24, and 32 bits are supported.`,
			);
		}
		if (formatTag === WaveFormat.IEEE_FLOAT && ![32, 64].includes(bitsPerSample)) {
			throw new Error(
				`Unsupported WAVE float bit depth (${bitsPerSample}). Only 32 and 64 bits are supported.`,
			);
		}

		this.audioInfo = {
			format: formatTag,
			numberOfChannels: numChannels,
			sampleRate,
			sampleSizeInBytes: Math.ceil(bitsPerSample / 8),
			blockSizeInBytes: blockAlign,
		};
	}

	private async parseListChunk(startPos: number, size: number, littleEndian: boolean) {
		if (size < 4) return; // Chunk too short

		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		const infoType = readAscii(slice, 4);
		if (infoType !== 'INFO' && infoType !== 'INF0') { // exiftool.org claims INF0 can happen
			return; // Not an INFO chunk
		}

		let currentPos = slice.filePos;
		while (currentPos <= startPos + size - 8) {
			slice.filePos = currentPos;

			const chunkName = readAscii(slice, 4);
			const chunkSize = readU32(slice, littleEndian);
			if (chunkSize > slice.remainingLength) {
				break; // The sub-chunk doesn't fit into the LIST chunk
			}

			const bytes = readBytes(slice, chunkSize);
			const nullIndex = bytes.indexOf(0);
			const stringBytes = bytes.subarray(0, nullIndex === -1 ? bytes.length : nullIndex);

			// The spec says Latin-1, but many writers (like FFmpeg) put UTF-8 in here. Latin-1 text with non-ASCII
			// characters is virtually never valid UTF-8, so try that first.
			let value: string;
			try {
				value = strictTextDecoder.decode(stringBytes);
			} catch {
				value = '';
				for (const byte of stringBytes) {
					value += String.fromCharCode(byte);
				}
			}

			this.metadataTags.raw ??= {};
			this.metadataTags.raw[chunkName] = value;

			switch (chunkName) {
				case 'INAM':
				case 'TITL': {
					this.metadataTags.title ??= value;
				}; break;

				case 'TIT3': {
					this.metadataTags.description ??= value;
				}; break;

				case 'IART': {
					this.metadataTags.artist ??= value;
				}; break;

				case 'IPRD': {
					this.metadataTags.album ??= value;
				}; break;

				case 'IPRT':
				case 'ITRK':
				case 'TRCK': {
					const parts = value.split('/');
					const trackNum = Number.parseInt(parts[0]!, 10);
					const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

					if (Number.isInteger(trackNum) && trackNum > 0) {
						this.metadataTags.trackNumber ??= trackNum;
					}
					if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
						this.metadataTags.tracksTotal ??= tracksTotal;
					}
				}; break;

				case 'ICRD': {
					const date = parseIsoSuffix(value);
					if (date) {
						this.metadataTags.date ??= date;
					}
				}; break;

				case 'YEAR': {
					const year = Number.parseInt(value, 10);
					const date = createUtcDate(year);
					if (year > 0 && !Number.isNaN(date.getTime())) {
						this.metadataTags.date ??= date;
					}
				}; break;

				case 'IGNR':
				case 'GENR': {
					this.metadataTags.genre ??= value;
				}; break;

				case 'ICMT':
				case 'CMNT':
				case 'COMM': {
					this.metadataTags.comment ??= value;
				}; break;
			}

			currentPos += 8 + chunkSize + (chunkSize & 1); // Handle padding
		}
	}

	private async parseId3Chunk(startPos: number, size: number) {
		// Parse ID3 tag embedded in WAV file (non-default, but used a lot in practice anyway)
		if (size < ID3_V2_HEADER_SIZE) return; // Chunk too short

		let slice = this.reader.requestSlice(startPos, size);
		if (isThenable(slice)) slice = await slice;
		if (!slice) return; // File too short

		const id3V2Header = readId3V2Header(slice);
		if (id3V2Header) {
			// Clamp to the available data in case the ID3 header claims more than the WAV chunk provides
			// https://github.com/Vanilagy/mediabunny/issues/300
			const availableSize = size - ID3_V2_HEADER_SIZE;
			id3V2Header.size = Math.min(id3V2Header.size, availableSize);

			if (id3V2Header.size > 0) {
				const contentSlice = slice.slice(startPos + ID3_V2_HEADER_SIZE, id3V2Header.size);
				parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);
			}
		}
	}

	getCodec(): AudioCodec | null {
		assert(this.audioInfo);

		if (this.audioInfo.format === WaveFormat.MULAW) {
			return 'ulaw';
		}
		if (this.audioInfo.format === WaveFormat.ALAW) {
			return 'alaw';
		}

		// All formats are little-endian, even in RIFX!

		if (this.audioInfo.format === WaveFormat.PCM) {
			if (this.audioInfo.sampleSizeInBytes === 1) {
				return 'pcm-u8';
			} else if (this.audioInfo.sampleSizeInBytes === 2) {
				return 'pcm-s16';
			} else if (this.audioInfo.sampleSizeInBytes === 3) {
				return 'pcm-s24';
			} else if (this.audioInfo.sampleSizeInBytes === 4) {
				return 'pcm-s32';
			}
		}
		if (this.audioInfo.format === WaveFormat.IEEE_FLOAT) {
			if (this.audioInfo.sampleSizeInBytes === 4) {
				return 'pcm-f32';
			} else if (this.audioInfo.sampleSizeInBytes === 8) {
				return 'pcm-f64';
			}
		}

		assert(false);
	}

	maybeCapDataSize() {
		assert(this.audioInfo);

		if (this.dataSizeCapped) {
			return;
		}

		// With unsized sources, we may only get to know the file size after the init logic, so this may only happen
		// later on
		const fileSize = this.reader.fileSize;
		if (fileSize !== null) {
			this.dataSize = Math.min(
				this.dataSize,
				floorToMultiple(fileSize - this.dataStart, this.audioInfo.blockSizeInBytes),
			);
			this.dataSizeCapped = true;
		}
	}

	async getMimeType() {
		return 'audio/wav';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}
}

const PACKET_SIZE_IN_FRAMES = 2048;

class WaveAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: WaveDemuxer) {}

	getType() {
		return 'audio' as const;
	}

	getNumber() {
		return 1;
	}

	getCodec() {
		return this.demuxer.getCodec();
	}

	getInternalCodecId() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.format;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		const codec = this.demuxer.getCodec();
		if (!codec) {
			return null;
		}

		assert(this.demuxer.audioInfo);
		return {
			codec,
			numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
			sampleRate: this.demuxer.audioInfo.sampleRate,
		};
	}

	getNumberOfChannels() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.numberOfChannels;
	}

	getSampleRate() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	getTimeResolution() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		assert(this.demuxer.dataSize !== -1);

		this.demuxer.maybeCapDataSize();
		if (this.demuxer.dataSizeIsPlaceholder && !this.demuxer.dataSizeCapped) {
			return null;
		}

		return this.demuxer.dataSize / this.demuxer.audioInfo!.blockSizeInBytes / this.demuxer.audioInfo!.sampleRate;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	private async getPacketAtIndex(
		packetIndex: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		assert(packetIndex >= 0);

		assert(this.demuxer.audioInfo);
		const blockSize = this.demuxer.audioInfo.blockSizeInBytes;

		this.demuxer.maybeCapDataSize();
		const fileSize = this.demuxer.reader.fileSize;

		const startOffset = packetIndex * PACKET_SIZE_IN_FRAMES * blockSize;
		if (startOffset >= this.demuxer.dataSize) {
			return null;
		}

		const sizeInBytes = Math.min(PACKET_SIZE_IN_FRAMES * blockSize, this.demuxer.dataSize - startOffset);

		if (fileSize === null) {
			// If the file size is unknown, we weren't able to cap the dataSize in the init logic and we instead have to
			// rely on the headers telling us how large the file is. But, these might be wrong, so let's check if the
			// requested slice actually exists.

			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (isThenable(slice)) slice = await slice;

			if (!slice) {
				// It doesn't, but the failed read has told us the file size, so let's try again with a capped dataSize
				assert(this.demuxer.reader.fileSize !== null);
				return this.getPacketAtIndex(packetIndex, options);
			}
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (isThenable(slice)) slice = await slice;
			assert(slice);

			data = readBytes(slice, sizeInBytes);
		}

		const timestamp = packetIndex * PACKET_SIZE_IN_FRAMES / this.demuxer.audioInfo.sampleRate;
		const duration = sizeInBytes / blockSize / this.demuxer.audioInfo.sampleRate;

		return new EncodedPacket(
			data,
			'key',
			timestamp,
			duration,
			packetIndex,
			sizeInBytes,
		);
	}

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		assert(this.demuxer.audioInfo);

		const packetIndex = Math.floor(Math.min(
			roundIfAlmostInteger(timestamp * this.demuxer.audioInfo.sampleRate) / PACKET_SIZE_IN_FRAMES,
			(this.demuxer.dataSize - 1) / (PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes),
		));
		if (packetIndex < 0) {
			return null;
		}

		const packet = await this.getPacketAtIndex(packetIndex, options);
		if (packet) {
			return packet;
		}

		// The file is shorter than we thought, meaning the packet we were looking for doesn't exist. But by now, the
		// dataSize has been capped to the actual data, so let's try again.
		return this.getPacket(timestamp, options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		assert(this.demuxer.audioInfo);
		const packetIndex = Math.round(packet.timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES);

		return this.getPacketAtIndex(packetIndex + 1, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}
