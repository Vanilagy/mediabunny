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
import { assert, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readAscii, readBytes, Reader, readU16Be, readU32Be } from '../reader';
import { ID3_V2_HEADER_SIZE, parseId3V2Tag, readId3V2Header } from '../id3';

const PACKET_SIZE_IN_FRAMES = 2048;

/**
 * Decodes an 80-bit IEEE 754 extended-precision float (big-endian). AIFF stores the sample rate in this format inside
 * the COMM chunk.
 */
const readExtendedFloat80 = (bytes: Uint8Array): number => {
	const sign = (bytes[0]! & 0x80) ? -1 : 1;
	const exponent = ((bytes[0]! & 0x7f) << 8) | bytes[1]!;
	const hiMant = ((bytes[2]! << 24) | (bytes[3]! << 16) | (bytes[4]! << 8) | bytes[5]!) >>> 0;
	const loMant = ((bytes[6]! << 24) | (bytes[7]! << 16) | (bytes[8]! << 8) | bytes[9]!) >>> 0;
	const mantissa = hiMant * 0x1_0000_0000 + loMant;

	if (exponent === 0 && mantissa === 0) {
		return 0;
	}
	if (exponent === 0x7fff) {
		return sign * Infinity;
	}

	// The mantissa carries an explicit integer bit, so the value is mantissa * 2^(exponent - bias - 63).
	return sign * mantissa * 2 ** (exponent - 16383 - 63);
};

/**
 * Maps an AIFF/AIFF-C (compressionType, bitsPerSample) pair to a Mediabunny audio codec. Returns null for compressed
 * AIFF-C payloads that Mediabunny doesn't decode (e.g. ima4, QDM2).
 */
const resolveCodec = (compressionType: string, bitsPerSample: number): AudioCodec | null => {
	switch (compressionType) {
		// Uncompressed, big-endian signed PCM. 'NONE' is also the implicit case for plain AIFF.
		case 'NONE':
		case 'twos': {
			if (bitsPerSample <= 8) {
				return 'pcm-s8';
			}
			if (bitsPerSample <= 16) {
				return 'pcm-s16be';
			}
			if (bitsPerSample <= 24) {
				return 'pcm-s24be';
			}
			if (bitsPerSample <= 32) {
				return 'pcm-s32be';
			}
			return null;
		}
		// Byte-swapped: little-endian signed PCM.
		case 'sowt':
		case 'SOWT': {
			if (bitsPerSample <= 16) {
				return 'pcm-s16';
			}
			if (bitsPerSample <= 24) {
				return 'pcm-s24';
			}
			if (bitsPerSample <= 32) {
				return 'pcm-s32';
			}
			return null;
		}
		// Unsigned 8-bit.
		case 'raw ': {
			return bitsPerSample <= 8 ? 'pcm-u8' : null;
		}
		case 'fl32':
		case 'FL32': {
			return 'pcm-f32be';
		}
		case 'fl64':
		case 'FL64': {
			return 'pcm-f64be';
		}
		case 'ulaw':
		case 'ULAW': {
			return 'ulaw';
		}
		case 'alaw':
		case 'ALAW': {
			return 'alaw';
		}
		default: {
			return null;
		}
	}
};

export class AiffDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	dataStart = -1;
	dataSize = -1;
	numSampleFrames = 0;
	audioInfo: {
		codec: AudioCodec | null;
		compressionType: string;
		bitsPerSample: number;
		numberOfChannels: number;
		sampleRate: number;
		blockSizeInBytes: number;
	} | null = null;

	trackBackings: AiffAudioTrackBacking[] = [];
	lastKnownPacketIndex = 0;
	metadataTags: MetadataTags = {};

	constructor(input: Input) {
		super(input);
		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let header = this.reader.requestSlice(0, 12);
			if (header instanceof Promise) header = await header;
			assert(header);

			readAscii(header, 4); // 'FORM'
			const outerChunkSize = readU32Be(header);
			const formType = readAscii(header, 4); // 'AIFF' or 'AIFC'
			const isAifc = formType === 'AIFC';

			const totalFileSize = Math.min(outerChunkSize + 8, this.reader.fileSize ?? Infinity);
			let currentPos = header.filePos;

			while (currentPos < totalFileSize) {
				let slice = this.reader.requestSlice(currentPos, 8);
				if (slice instanceof Promise) slice = await slice;
				if (!slice) {
					break;
				}

				const chunkId = readAscii(slice, 4);
				const chunkSize = readU32Be(slice);
				const dataStart = slice.filePos;

				if (chunkId === 'COMM') {
					await this.parseCommChunk(dataStart, chunkSize, isAifc);
				} else if (chunkId === 'SSND') {
					await this.parseSsndChunk(dataStart, chunkSize);
				} else if (chunkId === 'ID3 ' || chunkId === 'id3 ') {
					await this.parseId3Chunk(dataStart, chunkSize);
				} else if (chunkId === 'NAME' || chunkId === 'AUTH' || chunkId === 'ANNO' || chunkId === '(c) ') {
					await this.parseTextChunk(chunkId, dataStart, chunkSize);
				}

				currentPos = dataStart + chunkSize + (chunkSize & 1); // Chunks are padded to even sizes
			}

			if (!this.audioInfo) {
				throw new Error('Invalid AIFF file - missing "COMM" chunk');
			}
			if (this.dataStart === -1) {
				throw new Error('Invalid AIFF file - missing "SSND" chunk');
			}

			// Clamp the readable data to a whole number of frames.
			const blockSize = this.audioInfo.blockSizeInBytes;
			const framesByData = Math.floor(this.dataSize / blockSize);
			const frames = this.numSampleFrames > 0 ? Math.min(framesByData, this.numSampleFrames) : framesByData;
			this.dataSize = frames * blockSize;

			this.trackBackings.push(new AiffAudioTrackBacking(this));
		})();
	}

	async parseCommChunk(startPos: number, size: number, isAifc: boolean) {
		let slice = this.reader.requestSlice(startPos, size);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			return; // File too short
		}

		const numChannels = readU16Be(slice);
		this.numSampleFrames = readU32Be(slice);
		const bitsPerSample = readU16Be(slice);
		const sampleRate = readExtendedFloat80(readBytes(slice, 10));

		// Plain AIFF is always uncompressed big-endian PCM; AIFF-C names the compression explicitly.
		let compressionType = 'NONE';
		if (isAifc && size >= 22) {
			compressionType = readAscii(slice, 4);
		}

		const sampleSizeInBytes = Math.ceil(bitsPerSample / 8);
		this.audioInfo = {
			codec: resolveCodec(compressionType, bitsPerSample),
			compressionType,
			bitsPerSample,
			numberOfChannels: numChannels,
			sampleRate,
			blockSizeInBytes: numChannels * sampleSizeInBytes,
		};
	}

	async parseSsndChunk(startPos: number, size: number) {
		let slice = this.reader.requestSlice(startPos, 8);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			return; // File too short
		}

		const offset = readU32Be(slice);
		readU32Be(slice); // blockSize (alignment hint, unused)

		this.dataStart = startPos + 8 + offset;
		this.dataSize = Math.min(size - 8 - offset, (this.reader.fileSize ?? Infinity) - this.dataStart);
	}

	async parseTextChunk(chunkId: string, startPos: number, size: number) {
		let slice = this.reader.requestSlice(startPos, size);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			return; // File too short
		}

		const bytes = readBytes(slice, size);
		// AIFF text chunks are ISO 8859-1; trim any trailing null padding.
		let length = bytes.length;
		while (length > 0 && bytes[length - 1] === 0) {
			length--;
		}
		const value = String.fromCharCode(...bytes.subarray(0, length));

		this.metadataTags.raw ??= {};
		this.metadataTags.raw[chunkId] = value;

		switch (chunkId) {
			case 'NAME': {
				this.metadataTags.title ??= value;
			}; break;
			case 'AUTH': {
				this.metadataTags.artist ??= value;
			}; break;
			case 'ANNO': {
				this.metadataTags.comment ??= value;
			}; break;
		}
	}

	async parseId3Chunk(startPos: number, size: number) {
		let slice = this.reader.requestSlice(startPos, size);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			return; // File too short
		}

		const id3V2Header = readId3V2Header(slice);
		if (id3V2Header) {
			// Clamp to the data the chunk actually provides, in case the ID3 header over-claims.
			const availableSize = size - ID3_V2_HEADER_SIZE;
			id3V2Header.size = Math.min(id3V2Header.size, availableSize);
			if (id3V2Header.size > 0) {
				const contentSlice = slice.slice(startPos + ID3_V2_HEADER_SIZE, id3V2Header.size);
				parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);
			}
		}
	}

	getCodec() {
		assert(this.audioInfo);
		return this.audioInfo.codec;
	}

	async getMimeType() {
		return 'audio/aiff';
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

class AiffAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: AiffDemuxer) {}

	getType() {
		return 'audio' as const;
	}

	getId() {
		return 1;
	}

	getNumber() {
		return 1;
	}

	getCodec() {
		return this.demuxer.getCodec();
	}

	getInternalCodecId() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.compressionType;
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
		const startOffset = packetIndex * PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes;
		if (startOffset >= this.demuxer.dataSize) {
			return null;
		}

		const sizeInBytes = Math.min(
			PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes,
			this.demuxer.dataSize - startOffset,
		);

		if (this.demuxer.reader.fileSize === null) {
			// If the file size is unknown, we weren't able to cap the dataSize in the init logic and we instead have to
			// rely on the headers telling us how large the file is. But, these might be wrong, so let's check if the
			// requested slice actually exists.

			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (slice instanceof Promise) slice = await slice;

			if (!slice) {
				return null;
			}
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(this.demuxer.dataStart + startOffset, sizeInBytes);
			if (slice instanceof Promise) slice = await slice;
			assert(slice);

			data = readBytes(slice, sizeInBytes);
		}

		const timestamp = packetIndex * PACKET_SIZE_IN_FRAMES / this.demuxer.audioInfo.sampleRate;
		const duration = sizeInBytes / this.demuxer.audioInfo.blockSizeInBytes / this.demuxer.audioInfo.sampleRate;

		this.demuxer.lastKnownPacketIndex = Math.max(
			packetIndex,
			this.demuxer.lastKnownPacketIndex,
		);

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

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		assert(this.demuxer.audioInfo);

		const packetIndex = Math.floor(Math.min(
			timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES,
			(this.demuxer.dataSize - 1) / (PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes),
		));
		if (packetIndex < 0) {
			return null;
		}

		const packet = await this.getPacketAtIndex(packetIndex, options);
		if (packet) {
			return packet;
		}

		if (packetIndex === 0) {
			return null; // Empty data chunk
		}

		assert(this.demuxer.reader.fileSize === null);

		// The file is shorter than we thought, meaning the packet we were looking for doesn't exist. So, let's find
		// the last packet by doing a sequential scan, instead.
		let currentPacket = await this.getPacketAtIndex(this.demuxer.lastKnownPacketIndex, options);
		while (currentPacket) {
			const nextPacket = await this.getNextPacket(currentPacket, options);
			if (!nextPacket) {
				break;
			}

			currentPacket = nextPacket;
		}

		return currentPacket;
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
