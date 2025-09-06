/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex,
	binarySearchExact,
	Bitstream,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	FileSlice,
	readBytes,
	Reader,
	readU24Be,
	readU32Le,
	readU8,
} from '../reader';
import { MetadataTags } from '../tags';
import {
	calculateCRC8,
	getBlockSize,
	getBlockSizeOrUncommon,
	getFlacCodedNumber,
	getSampleRate,
	getSampleRateOrUncommon,
} from './flac-misc';

type FlacAudioInfo = {
	numberOfChannels: number;
	sampleRate: number;
	totalSamples: number;
	bitsPerSample: number;
	minimumBlockSize: number;
	maximumBlockSize: number;
	minimumFrameSize: number;
	maximumFrameSize: number;
	description: Uint8Array;
};

type Sample = {
	blockOffset: number;
	blockSize: number;
	byteOffset: number;
};

type NextFlacFrameResult = {
	num: number;
	blockSize: number;
	sampleRate: number;
	size: number;
	isLastFrame: boolean;
};

class FlacAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: FlacDemuxer) {}

	getId() {
		return 1;
	}

	getCodec() {
		return 'flac' as const;
	}

	getInternalCodecId(): string | number | Uint8Array | null {
		return null;
	}

	getNumberOfChannels() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.numberOfChannels;
	}

	computeDuration() {
		assert(this.demuxer.audioInfo);
		return Promise.resolve(
			this.demuxer.audioInfo.totalSamples / this.demuxer.audioInfo.sampleRate,
		);
	}

	getSampleRate() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	getName(): string | null {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	async getFirstTimestamp() {
		return 0;
	}

	getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		assert(this.demuxer.audioInfo);

		return Promise.resolve({
			codec: 'flac' as const,
			numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
			sampleRate: this.demuxer.audioInfo.sampleRate,
			description: this.demuxer.audioInfo.description,
		});
	}

	getPacket(
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		throw new Error('TODO: getPacket() not implemented');
	}

	async getNextPacket(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const release = await this.demuxer.readingMutex.acquire();
		try {
			const sampleIndex = binarySearchExact(
				this.demuxer.loadedSamples,
				packet.timestamp,
				x => x.blockOffset / this.demuxer.audioInfo!.sampleRate,
			);
			if (sampleIndex === -1) {
				throw new Error('Packet was not created from this track.');
			}

			const nextIndex = sampleIndex + 1;
			if (
				this.demuxer.lastSampleLoaded
				&& nextIndex >= this.demuxer.loadedSamples.length
			) {
				return null;
			}

			// Ensure the next sample exists
			while (
				nextIndex >= this.demuxer.loadedSamples.length
				&& !this.demuxer.lastSampleLoaded
			) {
				await this.demuxer.advanceReader();
			}
			return this.getPacketAtIndex(nextIndex, options);
		} finally {
			release();
		}
	}

	getKeyPacket(
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		return this.getNextPacket(packet, options);
	}

	async getPacketAtIndex(
		sampleIndex: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const rawSample = this.demuxer.loadedSamples[sampleIndex];
		if (rawSample) {
			let data: Uint8Array;
			if (options.metadataOnly) {
				data = PLACEHOLDER_DATA;
			} else {
				let slice = this.demuxer.reader.requestSlice(
					rawSample.byteOffset,
					rawSample.blockSize,
				);
				if (slice instanceof Promise) slice = await slice;

				if (!slice) {
					return null; // Data didn't fit into the rest of the file
				}

				data = readBytes(slice, rawSample.blockSize);
			}

			assert(this.demuxer.audioInfo);
			const timestamp = rawSample.blockOffset / this.demuxer.audioInfo.sampleRate;
			const duration = rawSample.blockSize / this.demuxer.audioInfo.sampleRate;
			return new EncodedPacket(
				data,
				'key',
				timestamp,
				duration,
				sampleIndex,
				rawSample.blockSize,
			);
		}

		await this.demuxer.advanceReader();
		return this.getPacketAtIndex(sampleIndex, options);
	}

	getFirstPacket(
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		return this.getPacketAtIndex(0, options);
	}
}

export class FlacDemuxer extends Demuxer {
	reader: Reader;

	loadedSamples: Sample[] = []; // All samples from the start of the file to lastLoadedPos

	metadataPromise: Promise<void> | null = null;
	tracks: InputAudioTrack[] = [];
	metadataTags: MetadataTags = {};

	audioInfo: FlacAudioInfo | null = null;
	lastLoadedPos: number | null = null;
	blockingBit: number | undefined = undefined;

	readingMutex = new AsyncMutex();
	lastSampleLoaded = false;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async computeDuration(): Promise<number> {
		const tracks = await this.getTracks();
		const trackDurations = await Promise.all(
			tracks.map(x => x.computeDuration()),
		);
		return Math.max(0, ...trackDurations);
	}

	override async getMetadataTags(): Promise<MetadataTags> {
		await this.readMetadata();
		return this.metadataTags;
	}

	readFlacFrameHeader = ({
		slice,
		blockingBit,
		firstPacket,
	}: {
		slice: FileSlice;
		blockingBit: number | undefined;
		firstPacket: boolean;
	}) => {
		const startOffset = slice.filePos;

		// https://www.rfc-editor.org/rfc/rfc9639.html#section-9.1
		// Each frame MUST start on a byte boundary and start with the 15-bit frame
		// sync code 0b111111111111100. Following the sync code is the blocking strategy
		// bit, which MUST NOT change during the audio stream.
		const bytes = readBytes(slice, 4);
		const bitStream = new Bitstream(bytes);

		const bits = bitStream.readBits(15);
		if (bits !== 0b111111111111100) {
			throw new Error('Invalid sync code');
		}

		if (blockingBit === undefined) {
			assert(firstPacket);
			const newBlockingBit = bitStream.readBits(1);
			this.blockingBit = newBlockingBit;
		} else if (blockingBit === 1) {
			assert(!firstPacket);
			const newBlockingBit = bitStream.readBits(1);
			assert(newBlockingBit === 1);
		} else if (blockingBit === 0) {
			assert(!firstPacket);
			const newBlockingBit = bitStream.readBits(1);
			assert(newBlockingBit === 0);
		} else {
			throw new Error('Invalid blocking bit');
		}

		const blockSizeOrUncommon = getBlockSizeOrUncommon(bitStream.readBits(4));
		assert(this.audioInfo);
		const sampleRateOrUncommon = getSampleRateOrUncommon(
			bitStream.readBits(4),
			this.audioInfo.sampleRate,
		);
		bitStream.skipBits(4); // channel count
		bitStream.skipBits(3); // bit depth
		const reservedZero = bitStream.readBits(1); // reserved zero
		assert(reservedZero === 0);

		const num = getFlacCodedNumber(slice);
		const blockSize = getBlockSize(slice, blockSizeOrUncommon);
		const sampleRate = getSampleRate(slice, sampleRateOrUncommon);
		const size = slice.filePos - startOffset;
		const crc = readU8(slice);

		slice.bufferPos -= size;
		slice.bufferPos -= 1;
		const crcCalculated = calculateCRC8(readBytes(slice, size));

		if (crc !== crcCalculated) {
			// Maybe this wasn't a FLAC frame at all, the syncword was just coincidentally
			// in the bitstream
			return null;
		}

		return { num, blockSize, sampleRate, size: blockSize };
	};

	readNextFlacFrame = async ({
		reader,
		startPos,
		firstPacket,
		blockingBit,
	}: {
		reader: Reader;
		startPos: number;
		firstPacket: boolean;
		blockingBit: number | undefined;
	}): Promise<NextFlacFrameResult | null> => {
		assert(this.audioInfo);
		// Also want to validate the next header is valid
		// to throw out an accidential sync word
		// which in the worst case may be up to 16 bytes
		const desiredEnd = this.audioInfo.maximumFrameSize + 16;
		const slice = await reader.requestSliceRange(startPos, 1, desiredEnd);

		if (!slice) {
			return null;
		}

		const a = this.readFlacFrameHeader({
			slice,
			blockingBit,
			firstPacket,
		});

		if (!a) {
			return null;
		}

		// We don't know exactly how long the packet is, we only know the `miniumFrameSize` and `maximumFrameSize`
		// The packet is over if the next 2 bytes are the sync word followed by a valid header
		// or the end of the file is reached

		// The next sync word is expected at earliest when `minimumFrameSize` is reached,
		// we can skip over anything before that
		slice.filePos = startPos + this.audioInfo.minimumFrameSize;

		while (true) {
			// Reached end of the file, packet is over
			if (slice.filePos >= slice.end) {
				return {
					num: a.num,
					blockSize: a.blockSize,
					sampleRate: a.sampleRate,
					size: slice.end - startPos,
					isLastFrame: true,
				};
			}

			const nextBits = readU8(slice);
			if (nextBits === 0xff) {
				const nextBits = readU8(slice);

				const expected = blockingBit === 1 ? 0b1111_1001 : 0b1111_1000;
				if (nextBits !== expected) {
					slice.bufferPos -= 1;
					continue;
				}

				slice.bufferPos -= 2;
				const lengthIfNextFlacFrameHeaderIsLegit = slice.filePos - startPos;

				const nextIsLegit = this.readFlacFrameHeader({
					slice,
					blockingBit,
					firstPacket,
				});

				if (!nextIsLegit) {
					slice.bufferPos -= 1;
					continue;
				}

				return {
					num: a.num,
					blockSize: a.blockSize,
					sampleRate: a.sampleRate,
					size: lengthIfNextFlacFrameHeaderIsLegit,
					isLastFrame: false,
				};
			}
		}
	};

	async advanceReader() {
		await this.readMetadata();
		assert(this.lastLoadedPos !== null);
		assert(this.audioInfo);
		const startPos = this.lastLoadedPos;
		const result = await this.readNextFlacFrame({
			reader: this.reader,
			startPos,
			firstPacket: this.loadedSamples.length === 0,
			blockingBit: this.blockingBit,
		});

		if (!result) {
			throw new Error('Failed to read next FLAC frame');
		}

		if (this.audioInfo.minimumBlockSize !== this.audioInfo.maximumBlockSize) {
			throw new Error('Cannot determine timestamp');
		}

		const lastSample = this.loadedSamples[this.loadedSamples.length - 1];
		const blockOffset = lastSample ? (lastSample.blockOffset + lastSample.blockSize) : 0;

		const sample: Sample = {
			blockOffset,
			blockSize: result.blockSize,
			byteOffset: startPos,
		};

		this.lastLoadedPos = this.lastLoadedPos + result.size;
		this.loadedSamples.push(sample);

		if (result?.isLastFrame) {
			this.lastSampleLoaded = true;
			return;
		}
	}

	async readMetadata() {
		let currentPos = 4;

		return (this.metadataPromise ??= (async () => {
			while (
				this.reader.fileSize === null
				|| currentPos < this.reader.fileSize
			) {
				// Parse streaminfo block
				// https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2
				const sizeSlice = await this.reader.requestSlice(
					currentPos,
					currentPos + 4,
				);
				if (!sizeSlice) return;

				const byte = readU8(sizeSlice); // first bit: isLastMetadata, remaining 7 bits: metaBlockType
				const size = readU24Be(sizeSlice);
				currentPos += 4;
				const isLastMetadata = (byte & 0x80) !== 0;
				const metaBlockType = byte & 0x7f;

				// 0 -> streaminfo
				// 4 -> descriptive metadata (for future implementation)
				if (metaBlockType === 0) {
					const streamInfoBlock = await this.reader.requestSlice(
						currentPos,
						currentPos + size,
					);
					if (!streamInfoBlock) return;
					currentPos += size;

					const streamInfoDescription = readBytes(streamInfoBlock, 34);
					const bitstream = new Bitstream(streamInfoDescription);

					const minimumBlockSize = bitstream.readBits(16);
					const maximumBlockSize = bitstream.readBits(16);
					const minimumFrameSize = bitstream.readBits(24);
					const maximumFrameSize = bitstream.readBits(24);

					const sampleRate = bitstream.readBits(20);
					const channels = bitstream.readBits(3) + 1;
					const bitsPerSample = bitstream.readBits(5);
					const totalSamples = bitstream.readBits(36);

					// https://www.w3.org/TR/webcodecs-flac-codec-registration/#audiodecoderconfig-description
					// description is required, and has to be the following:
					// - The bytes 0x66 0x4C 0x61 0x43 ("fLaC" in ASCII)
					// - A metadata block (called the STREAMINFO block) as described in section 7 of [FLAC]
					// - Optionaly (sic) other metadata blocks, that are not used by the specification
					const description = new Uint8Array([
						0x66,
						0x4c,
						0x61,
						0x43,
						...streamInfoDescription,
					]);

					bitstream.skipBits(16 * 8); // md5 hash

					this.audioInfo = {
						numberOfChannels: channels,
						sampleRate,
						totalSamples,
						bitsPerSample,
						minimumBlockSize,
						maximumBlockSize,
						minimumFrameSize,
						maximumFrameSize,
						description,
					};

					this.tracks.push(
						new InputAudioTrack(new FlacAudioTrackBacking(this)),
					);
				} else if (metaBlockType === 4) {
					// Parse vorbis comment block
					// https://www.rfc-editor.org/rfc/rfc9639.html#name-vorbis-comment
					const vorbisCommentBlock = await this.reader.requestSlice(
						currentPos,
						currentPos + size,
					);
					currentPos += size;
					if (!vorbisCommentBlock) return;
					const vendorLength = readU32Le(vorbisCommentBlock);
					readBytes(vorbisCommentBlock, vendorLength);
					// ^ vendor string, like "reference libFLAC 1.3.2 20190804";
					// we don't use it
					const listLength = readU32Le(vorbisCommentBlock);
					for (let i = 0; i < listLength; i++) {
						const stringLength = readU32Le(vorbisCommentBlock);
						const bytes = readBytes(vorbisCommentBlock, stringLength);
						const string = new TextDecoder().decode(bytes).trim();
						const split = string.split('=');
						const key = split[0]?.toLowerCase();
						const value = split[1] as string;
						if (key === 'title') {
							this.metadataTags.title = value;
						} else if (key === 'artist') {
							this.metadataTags.artist = value;
						} else if (key === 'album') {
							this.metadataTags.album = value;
						} else if (key === 'date') {
							this.metadataTags.date = new Date(value);
						} else if (key === 'comment') {
							this.metadataTags.comment = value;
						} else if (key === 'lyrics') {
							this.metadataTags.lyrics = value;
						} else if (key === 'genre') {
							this.metadataTags.genre = value;
						} else if (key === 'tracknumber') {
							this.metadataTags.trackNumber = Number.parseInt(value, 10);
						} else if (key === 'tracktotal') {
							this.metadataTags.tracksTotal = Number.parseInt(value, 10);
						} else if (key === 'discnumber') {
							this.metadataTags.discNumber = Number.parseInt(value, 10);
						} else if (key === 'disctotal') {
							this.metadataTags.discsTotal = Number.parseInt(value, 10);
						}
					}
				} else {
					// Skip the metadata block
					currentPos += size;
				}
				if (isLastMetadata) {
					this.lastLoadedPos = currentPos;
					break;
				}
			}
		})());
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
	}

	override getMimeType(): Promise<string> {
		return Promise.resolve('audio/flac');
	}
}
