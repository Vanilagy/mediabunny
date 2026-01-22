/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FlacBlockType, readVorbisComments } from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex,
	binarySearchLessOrEqual,
	Bitstream,
	textDecoder,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	FileSlice,
	readBytes,
	Reader,
	readU24Be,
	readU32Be,
	readU8,
} from '../reader';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	calculateCrc8,
	readBlockSize,
	getBlockSizeOrUncommon,
	readCodedNumber,
	readSampleRate,
	getSampleRateOrUncommon,
} from './flac-misc';

type FlacAudioInfo = {
	numberOfChannels: number;
	sampleRate: number;
	totalSamples: number;
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
	byteSize: number;
};

type NextFlacFrameResult = {
	num: number;
	blockSize: number;
	sampleRate: number;
	size: number;
	isLastFrame: boolean;
};

export class FlacDemuxer extends Demuxer {
	reader: Reader;

	loadedSamples: Sample[] = []; // All samples from the start of the file to lastLoadedPos

	metadataPromise: Promise<void> | null = null;
	track: InputAudioTrack | null = null;
	metadataTags: MetadataTags = {};

	audioInfo: FlacAudioInfo | null = null;
	lastLoadedPos: number | null = null;
	blockingBit: number | null = null;

	readingMutex = new AsyncMutex();
	lastSampleLoaded = false;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async computeDuration(): Promise<number> {
		await this.readMetadata();
		assert(this.track);
		return this.track.computeDuration();
	}

	override async getMetadataTags(): Promise<MetadataTags> {
		await this.readMetadata();
		return this.metadataTags;
	}

	async getTracks() {
		await this.readMetadata();
		assert(this.track);
		return [this.track];
	}

	async getMimeType() {
		return 'audio/flac';
	}

	async readMetadata() {
		let currentPos = 4; // Skip 'fLaC'

		return (this.metadataPromise ??= (async () => {
			while (
				this.reader.fileSize === null
				|| currentPos < this.reader.fileSize
			) {
				let sizeSlice = this.reader.requestSlice(currentPos, 4);
				if (sizeSlice instanceof Promise) sizeSlice = await sizeSlice;
				currentPos += 4;

				if (sizeSlice === null) {
					throw new Error(
						`Metadata block at position ${currentPos} is too small! Corrupted file.`,
					);
				}

				assert(sizeSlice);

				const byte = readU8(sizeSlice); // first bit: isLastMetadata, remaining 7 bits: metaBlockType
				const size = readU24Be(sizeSlice);
				const isLastMetadata = (byte & 0x80) !== 0;
				const metaBlockType = byte & 0x7f;

				switch (metaBlockType) {
					case FlacBlockType.STREAMINFO: {
						// Parse streaminfo block
						// https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2
						let streamInfoBlock = this.reader.requestSlice(
							currentPos,
							size,
						);
						if (streamInfoBlock instanceof Promise) streamInfoBlock = await streamInfoBlock;

						assert(streamInfoBlock);
						if (streamInfoBlock === null) {
							throw new Error(
								`StreamInfo block at position ${currentPos} is too small! Corrupted file.`,
							);
						}

						const streamInfoBytes = readBytes(streamInfoBlock, 34);
						const bitstream = new Bitstream(streamInfoBytes);

						const minimumBlockSize = bitstream.readBits(16);
						const maximumBlockSize = bitstream.readBits(16);
						const minimumFrameSize = bitstream.readBits(24);
						const maximumFrameSize = bitstream.readBits(24);

						const sampleRate = bitstream.readBits(20);
						const numberOfChannels = bitstream.readBits(3) + 1;
						bitstream.readBits(5); // bitsPerSample - 1
						const totalSamples = bitstream.readBits(36);

						// https://www.w3.org/TR/webcodecs-flac-codec-registration/#audiodecoderconfig-description
						// description is required, and has to be the following:
						// 1. The bytes 0x66 0x4C 0x61 0x43 ("fLaC" in ASCII)
						// 2. A metadata block (called the STREAMINFO block) as described in section 7 of [FLAC]
						// 3. Optionaly (sic) other metadata blocks, that are not used by the specification

						bitstream.skipBits(16 * 8); // md5 hash

						const description = new Uint8Array(42);
						// 1. "fLaC"
						description.set(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), 0);
						// 2. STREAMINFO block
						description.set(new Uint8Array([128, 0, 0, 34]), 4);
						// 3. Other metadata blocks
						description.set(streamInfoBytes, 8);

						this.audioInfo = {
							numberOfChannels,
							sampleRate,
							totalSamples,
							minimumBlockSize,
							maximumBlockSize,
							minimumFrameSize,
							maximumFrameSize,
							description,
						};

						this.track = new InputAudioTrack(this.input, new FlacAudioTrackBacking(this));
						break;
					}
					case FlacBlockType.VORBIS_COMMENT: {
						// Parse vorbis comment block
						// https://www.rfc-editor.org/rfc/rfc9639.html#name-vorbis-comment
						let vorbisCommentBlock = this.reader.requestSlice(
							currentPos,
							size,
						);
						if (vorbisCommentBlock instanceof Promise) vorbisCommentBlock = await vorbisCommentBlock;

						assert(vorbisCommentBlock);

						readVorbisComments(
							readBytes(vorbisCommentBlock, size),
							this.metadataTags,
						);

						break;
					}
					case FlacBlockType.PICTURE: {
						// Parse picture block
						// https://www.rfc-editor.org/rfc/rfc9639.html#name-picture
						let pictureBlock = this.reader.requestSlice(
							currentPos,
							size,
						);
						if (pictureBlock instanceof Promise) pictureBlock = await pictureBlock;

						assert(pictureBlock);
						const pictureType = readU32Be(pictureBlock);
						const mediaTypeLength = readU32Be(pictureBlock);
						const mediaType = textDecoder.decode(
							readBytes(pictureBlock, mediaTypeLength),
						);
						const descriptionLength = readU32Be(pictureBlock);
						const description = textDecoder.decode(
							readBytes(pictureBlock, descriptionLength),
						);
						pictureBlock.skip(4 + 4 + 4 + 4); // Skip width, height, color depth, number of indexed colors
						const dataLength = readU32Be(pictureBlock);
						const data = readBytes(pictureBlock, dataLength);

						this.metadataTags.images ??= [];
						this.metadataTags.images.push({
							data,
							mimeType: mediaType,
							// https://www.rfc-editor.org/rfc/rfc9639.html#table13
							kind:
								pictureType === 3
									? 'coverFront'
									: pictureType === 4
										? 'coverBack'
										: 'unknown',
							description,
						});
						break;
					}
					default:
						break;
				}
				currentPos += size;

				if (isLastMetadata) {
					this.lastLoadedPos = currentPos;
					break;
				}
			}
		})());
	}

	async readNextFlacFrame({
		startPos,
		isFirstPacket,
	}: {
		startPos: number;
		isFirstPacket: boolean;
	}): Promise<NextFlacFrameResult | null> {
		assert(this.audioInfo);
		// we expect that there are at least `minimumFrameSize` bytes left in the file

		// Ideally we also want to validate the next header is valid
		// to throw out an accidential sync word

		// The shortest valid FLAC header I can think of, based off the code
		// of readFlacFrameHeader:
		// 4 bytes used for bitstream from syncword to bit depth
		// 1 byte coded number
		// (uncommon values, no bytes read)
		// 1 byte crc
		// --> 6 bytes
		const minimumHeaderLength = 6;
		// If we read everything in readFlacFrameHeader, we read 16 bytes
		const maximumHeaderSize = 16;
		const maximumSliceLength
			= this.audioInfo.maximumFrameSize + maximumHeaderSize;

		const slice = await this.reader.requestSliceRange(
			startPos,
			this.audioInfo.minimumFrameSize,
			maximumSliceLength,
		);

		if (!slice) {
			return null;
		}

		const frameHeader = this.readFlacFrameHeader({
			slice,
			isFirstPacket: isFirstPacket,
		});

		if (!frameHeader) {
			return null;
		}

		// We don't know exactly how long the packet is, we only know the `minimumFrameSize` and `maximumFrameSize`
		// The packet is over if the next 2 bytes are the sync word followed by a valid header
		// or the end of the file is reached

		// The next sync word is expected at earliest when `minimumFrameSize` is reached,
		// we can skip over anything before that
		slice.filePos = startPos + this.audioInfo.minimumFrameSize;

		while (true) {
			// Reached end of the file, packet is over
			if (slice.filePos > slice.end - minimumHeaderLength) {
				return {
					num: frameHeader.num,
					blockSize: frameHeader.blockSize,
					sampleRate: frameHeader.sampleRate,
					size: slice.end - startPos,
					isLastFrame: true,
				};
			}

			const nextByte = readU8(slice);
			if (nextByte === 0xff) {
				const positionBeforeReading = slice.filePos;

				const byteAfterNextByte = readU8(slice);

				const expected = this.blockingBit === 1 ? 0b1111_1001 : 0b1111_1000;
				if (byteAfterNextByte !== expected) {
					slice.filePos = positionBeforeReading;
					continue;
				}

				slice.skip(-2);
				const lengthIfNextFlacFrameHeaderIsLegit = slice.filePos - startPos;

				const nextFrameHeader = this.readFlacFrameHeader({
					slice,
					isFirstPacket: false,
				});

				if (!nextFrameHeader) {
					slice.filePos = positionBeforeReading;
					continue;
				}

				// Ensure the frameOrSampleNum is consecutive.
				// https://github.com/Vanilagy/mediabunny/issues/194

				if (this.blockingBit === 0) {
					// Case A: If the stream is fixed block size, this is the frame number, which increments by 1
					if (nextFrameHeader.num - frameHeader.num !== 1) {
						slice.filePos = positionBeforeReading;
						continue;
					}
				} else {
					// Case B: If the stream is variable block size, this is the sample number, which increments by
					// amount of samples in a frame.
					if (nextFrameHeader.num - frameHeader.num !== frameHeader.blockSize) {
						slice.filePos = positionBeforeReading;
						continue;
					}
				}

				return {
					num: frameHeader.num,
					blockSize: frameHeader.blockSize,
					sampleRate: frameHeader.sampleRate,
					size: lengthIfNextFlacFrameHeaderIsLegit,
					isLastFrame: false,
				};
			}
		}
	}

	readFlacFrameHeader({
		slice,
		isFirstPacket,
	}: {
		slice: FileSlice;
		isFirstPacket: boolean;
	}) {
		// In this function, generally it is not safe to throw errors.
		// We might end up here because we stumbled upon a syncword,
		// but the data might not actually be a FLAC frame, it might be random bitstream
		// data, in that case we should return null and continue.

		const startOffset = slice.filePos;

		// https://www.rfc-editor.org/rfc/rfc9639.html#section-9.1
		// Each frame MUST start on a byte boundary and start with the 15-bit frame
		// sync code 0b111111111111100. Following the sync code is the blocking strategy
		// bit, which MUST NOT change during the audio stream.
		const bytes = readBytes(slice, 4);
		const bitstream = new Bitstream(bytes);

		const bits = bitstream.readBits(15);
		if (bits !== 0b111111111111100) {
			// This cannot be a valid FLAC frame, must start with the syncword
			return null;
		}

		if (this.blockingBit === null) {
			assert(isFirstPacket);
			const newBlockingBit = bitstream.readBits(1);
			this.blockingBit = newBlockingBit;
		} else if (this.blockingBit === 1) {
			assert(!isFirstPacket);
			const newBlockingBit = bitstream.readBits(1);
			if (newBlockingBit !== 1) {
				// This cannot be a valid FLAC frame, expected 1 but got 0
				return null;
			}
		} else if (this.blockingBit === 0) {
			assert(!isFirstPacket);
			const newBlockingBit = bitstream.readBits(1);
			if (newBlockingBit !== 0) {
				// This cannot be a valid FLAC frame, expected 0 but got 1
				return null;
			}
		} else {
			throw new Error('Invalid blocking bit');
		}

		const blockSizeOrUncommon = getBlockSizeOrUncommon(bitstream.readBits(4));
		if (!blockSizeOrUncommon) {
			// This cannot be a valid FLAC frame, the syncword was just coincidental
			return null;
		}
		assert(this.audioInfo);
		const sampleRateOrUncommon = getSampleRateOrUncommon(
			bitstream.readBits(4),
			this.audioInfo.sampleRate,
		);
		if (!sampleRateOrUncommon) {
			// This cannot be a valid FLAC frame, the syncword was just coincidental
			return null;
		}

		bitstream.readBits(4); // channel count
		bitstream.readBits(3); // bit depth
		const reservedZero = bitstream.readBits(1); // reserved zero

		if (reservedZero !== 0) {
			// This cannot be a valid FLAC frame, the syncword was just coincidental
			return null;
		}

		const num = readCodedNumber(slice);
		const blockSize = readBlockSize(slice, blockSizeOrUncommon);

		const sampleRate = readSampleRate(slice, sampleRateOrUncommon);
		if (sampleRate === null) {
			// This cannot be a valid FLAC frame, the syncword was just coincidental
			return null;
		}

		if (sampleRate !== this.audioInfo.sampleRate) {
			// This cannot be a valid FLAC frame, the sample rate is not the same as in the stream info
			return null;
		}

		const size = slice.filePos - startOffset;
		const crc = readU8(slice);

		slice.skip(-size);
		slice.skip(-1);
		const crcCalculated = calculateCrc8(readBytes(slice, size));

		if (crc !== crcCalculated) {
			// Maybe this wasn't a FLAC frame at all, the syncword was just coincidentally
			// in the bitstream
			return null;
		}

		return { num, blockSize, sampleRate };
	}

	async advanceReader() {
		await this.readMetadata();
		assert(this.lastLoadedPos !== null);
		assert(this.audioInfo);
		const startPos = this.lastLoadedPos;
		const frame = await this.readNextFlacFrame({
			startPos,
			isFirstPacket: this.loadedSamples.length === 0,
		});

		if (!frame) {
			// Unexpected case, failed to read next FLAC frame
			// handling gracefully
			this.lastSampleLoaded = true;
			return;
		}

		const lastSample = this.loadedSamples[this.loadedSamples.length - 1];
		const blockOffset = lastSample
			? lastSample.blockOffset + lastSample.blockSize
			: 0;

		const sample: Sample = {
			blockOffset,
			blockSize: frame.blockSize,
			byteOffset: startPos,
			byteSize: frame.size,
		};

		this.lastLoadedPos = this.lastLoadedPos + frame.size;
		this.loadedSamples.push(sample);

		if (frame.isLastFrame) {
			this.lastSampleLoaded = true;
			return;
		}
	}
}

class FlacAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: FlacDemuxer) {}

	getId() {
		return 1;
	}

	getNumber() {
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

	async computeDuration() {
		const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
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

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	async getFirstTimestamp() {
		return 0;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		assert(this.demuxer.audioInfo);

		return {
			codec: 'flac' as const,
			numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
			sampleRate: this.demuxer.audioInfo.sampleRate,
			description: this.demuxer.audioInfo.description,
		};
	}

	async getPacket(
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		assert(this.demuxer.audioInfo);
		if (timestamp < 0) {
			throw new Error('Timestamp cannot be negative');
		}

		const release = await this.demuxer.readingMutex.acquire();

		try {
			while (true) {
				const packetIndex = binarySearchLessOrEqual(
					this.demuxer.loadedSamples,
					timestamp,
					x => x.blockOffset / this.demuxer.audioInfo!.sampleRate,
				);
				if (packetIndex === -1) {
					await this.demuxer.advanceReader();
					continue;
				}

				const packet = this.demuxer.loadedSamples[packetIndex]!;
				const sampleTimestamp
					= packet.blockOffset / this.demuxer.audioInfo.sampleRate;
				const sampleDuration
					= packet.blockSize / this.demuxer.audioInfo.sampleRate;

				if (sampleTimestamp + sampleDuration <= timestamp) {
					if (this.demuxer.lastSampleLoaded) {
						return this.getPacketAtIndex(
							this.demuxer.loadedSamples.length - 1,
							options,
						);
					}

					await this.demuxer.advanceReader();
					continue;
				}

				return this.getPacketAtIndex(packetIndex, options);
			}
		} finally {
			release();
		}
	}

	async getNextPacket(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const release = await this.demuxer.readingMutex.acquire();
		try {
			const nextIndex = packet.sequenceNumber + 1;
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
		if (!rawSample) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(
				rawSample.byteOffset,
				rawSample.byteSize,
			);
			if (slice instanceof Promise) slice = await slice;

			if (!slice) {
				return null; // Data didn't fit into the rest of the file
			}

			data = readBytes(slice, rawSample.byteSize);
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
			rawSample.byteSize,
		);
	}

	async getFirstPacket(
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		// Ensure the next sample exists
		while (
			this.demuxer.loadedSamples.length === 0
			&& !this.demuxer.lastSampleLoaded
		) {
			await this.demuxer.advanceReader();
		}

		return this.getPacketAtIndex(0, options);
	}
}
