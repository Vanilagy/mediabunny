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
import { assert, AsyncMutex, binarySearchExact, Bitstream, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readBytes, Reader, readU24Be, readU8 } from '../reader';
import { MetadataTags } from '../tags';
import { readNextFlacFrame } from './flac-reader';

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
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
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
				x => x.timestamp,
			);
			if (sampleIndex === -1) {
				throw new Error('Packet was not created from this track.');
			}

			const nextIndex = sampleIndex + 1;
			if (this.demuxer.lastSampleLoaded && nextIndex >= this.demuxer.loadedSamples.length) {
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
				let slice = this.demuxer.reader.requestSlice(rawSample.dataStart, rawSample.dataSize);
				if (slice instanceof Promise) slice = await slice;

				if (!slice) {
					return null; // Data didn't fit into the rest of the file
				}

				data = readBytes(slice, rawSample.dataSize);
			}

			return new EncodedPacket(
				data,
				'key',
				rawSample.timestamp,
				rawSample.duration,
				sampleIndex,
				rawSample.dataSize,
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

	override getMetadataTags(): Promise<MetadataTags> {
		throw new Error('TODO: Add metadata tags support');
	}

	async advanceReader() {
		await this.readMetadata();
		assert(this.lastLoadedPos !== null);
		assert(this.audioInfo);
		const startPos = this.lastLoadedPos;
		const result = await readNextFlacFrame({
			reader: this.reader,
			startPos,
			until: startPos + this.audioInfo.maximumFrameSize,
			firstPacket: this.loadedSamples.length === 0,
			blockingBit: this.blockingBit,
			setBlockingBit: (blockingBit: number) => {
				this.blockingBit = blockingBit;
			},
			streamInfoSampleRate: this.audioInfo.sampleRate,
		});

		if (!result) {
			throw new Error('Failed to read next FLAC frame');
		}

		if (this.audioInfo.minimumBlockSize !== this.audioInfo.maximumBlockSize) {
			throw new Error('Cannot determine timestamp');
		}

		const timestamp
			= (result.num * this.audioInfo.maximumBlockSize)
				/ this.audioInfo.sampleRate;

		const sample: Sample = {
			timestamp,
			duration: this.audioInfo.maximumBlockSize / this.audioInfo.sampleRate,
			dataStart: startPos,
			dataSize: result.size,
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
				let sizeSlice = this.reader.requestSlice(currentPos, currentPos + 4);
				if (sizeSlice instanceof Promise) sizeSlice = await sizeSlice;
				if (!sizeSlice) return;

				const byte = readU8(sizeSlice); // first bit: isLastMetadata, remaining 7 bits: metaBlockType
				const size = readU24Be(sizeSlice);
				currentPos += 4;
				const isLastMetadata = (byte & 0x80) !== 0;
				const metaBlockType = byte & 0x7f;

				// 0 -> streaminfo
				// 4 -> descriptive metadata (for future implementation)
				if (metaBlockType === 0) {
					let streamInfoBlock = this.reader.requestSlice(
						currentPos,
						currentPos + size,
					);
					if (streamInfoBlock instanceof Promise) {
						streamInfoBlock = await streamInfoBlock;
					}
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
