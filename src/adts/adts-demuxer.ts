/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { aacChannelMap, aacFrequencyTable, AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex,
	binarySearchExact,
	binarySearchLessOrEqual,
	Bitstream,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readBytes, Reader } from '../reader';
import { DEFAULT_TRACK_DISPOSITION } from '../metadata';
import { FrameHeader, MAX_FRAME_HEADER_SIZE, MIN_FRAME_HEADER_SIZE, readFrameHeader } from './adts-reader';

const SAMPLES_PER_AAC_FRAME = 1024;

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class AdtsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: FrameHeader | null = null;
	loadedSamples: Sample[] = [];

	tracks: InputAudioTrack[] = [];

	readingMutex = new AsyncMutex();
	lastSampleLoaded = false;
	lastLoadedPos = 0;
	nextTimestampInSamples = 0;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			// Keep loading until we find the first frame header
			while (!this.firstFrameHeader && !this.lastSampleLoaded) {
				await this.advanceReader();
			}

			// There has to be a frame if this demuxer got selected
			assert(this.firstFrameHeader);

			// Create the single audio track
			this.tracks = [new InputAudioTrack(this.input, new AdtsAudioTrackBacking(this))];
		})();
	}

	async advanceReader() {
		let slice = this.reader.requestSliceRange(this.lastLoadedPos, MIN_FRAME_HEADER_SIZE, MAX_FRAME_HEADER_SIZE);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			this.lastSampleLoaded = true;
			return;
		}

		const header = readFrameHeader(slice);
		if (!header) {
			this.lastSampleLoaded = true;
			return;
		}

		if (this.reader.fileSize !== null && header.startPos + header.frameLength > this.reader.fileSize) {
			// Frame doesn't fit in the rest of the file
			this.lastSampleLoaded = true;
			return;
		}

		if (!this.firstFrameHeader) {
			this.firstFrameHeader = header;
		}

		const sampleRate = aacFrequencyTable[header.samplingFrequencyIndex];
		assert(sampleRate !== undefined);
		const sampleDuration = SAMPLES_PER_AAC_FRAME / sampleRate;
		const headerSize = header.crcCheck ? MAX_FRAME_HEADER_SIZE : MIN_FRAME_HEADER_SIZE;

		const sample: Sample = {
			timestamp: this.nextTimestampInSamples / sampleRate,
			duration: sampleDuration,
			dataStart: header.startPos + headerSize,
			dataSize: header.frameLength - headerSize,
		};

		this.loadedSamples.push(sample);
		this.nextTimestampInSamples += SAMPLES_PER_AAC_FRAME;
		this.lastLoadedPos = header.startPos + header.frameLength;
	}

	async getMimeType() {
		return 'audio/aac';
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
	}

	async computeDuration() {
		await this.readMetadata();

		const track = this.tracks[0];
		assert(track);

		return track.computeDuration();
	}

	async getMetadataTags() {
		return {}; // No tags in this one
	}
}

class AdtsAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: AdtsDemuxer) {}

	getId() {
		return 1;
	}

	async getFirstTimestamp() {
		return 0;
	}

	getTimeResolution() {
		const sampleRate = this.getSampleRate();
		return sampleRate / SAMPLES_PER_AAC_FRAME;
	}

	async computeDuration() {
		const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getCodec(): AudioCodec {
		return 'aac';
	}

	getInternalCodecId() {
		assert(this.demuxer.firstFrameHeader);

		return this.demuxer.firstFrameHeader.objectType;
	}

	getNumberOfChannels() {
		assert(this.demuxer.firstFrameHeader);

		const numberOfChannels = aacChannelMap[this.demuxer.firstFrameHeader.channelConfiguration];
		assert(numberOfChannels !== undefined);

		return numberOfChannels;
	}

	getSampleRate() {
		assert(this.demuxer.firstFrameHeader);

		const sampleRate = aacFrequencyTable[this.demuxer.firstFrameHeader.samplingFrequencyIndex];
		assert(sampleRate !== undefined);

		return sampleRate;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.demuxer.firstFrameHeader);

		const bytes = new Uint8Array(3); // 19 bits max
		const bitstream = new Bitstream(bytes);

		const { objectType, samplingFrequencyIndex, channelConfiguration } = this.demuxer.firstFrameHeader;

		if (objectType > 31) {
			bitstream.writeBits(5, 31);
			bitstream.writeBits(6, objectType - 32);
		} else {
			bitstream.writeBits(5, objectType);
		}

		bitstream.writeBits(4, samplingFrequencyIndex); // samplingFrequencyIndex === 15 is forbidden

		bitstream.writeBits(4, channelConfiguration);

		return {
			codec: `mp4a.40.${this.demuxer.firstFrameHeader.objectType}`,
			numberOfChannels: this.getNumberOfChannels(),
			sampleRate: this.getSampleRate(),
			description: bytes.subarray(0, Math.ceil((bitstream.pos - 1) / 8)),
		};
	}

	async getPacketAtIndex(sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const rawSample = this.demuxer.loadedSamples[sampleIndex];
		if (!rawSample) {
			return null;
		}

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

	getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
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

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			while (true) {
				const index = binarySearchLessOrEqual(
					this.demuxer.loadedSamples,
					timestamp,
					x => x.timestamp,
				);
				if (index === -1 && this.demuxer.loadedSamples.length > 0) {
					// We're before the first sample
					return null;
				}

				if (this.demuxer.lastSampleLoaded) {
					// All data is loaded, return what we found
					return this.getPacketAtIndex(index, options);
				}

				if (index >= 0 && index + 1 < this.demuxer.loadedSamples.length) {
					// The next packet also exists, we're done
					return this.getPacketAtIndex(index, options);
				}

				// Otherwise, keep loading data
				await this.demuxer.advanceReader();
			}
		} finally {
			release();
		}
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}
