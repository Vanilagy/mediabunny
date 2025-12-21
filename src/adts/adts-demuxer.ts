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
	AsyncMutex4,
	binarySearchExact,
	binarySearchLessOrEqual,
	Bitstream,
	ResultValue,
	UNDETERMINED_LANGUAGE,
	Yo,
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

	readingMutex = new AsyncMutex4();
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
				const result = new ResultValue<void>();
				const promise = this.advanceReader(result);
				if (result.pending) await promise;
			}

			if (!this.firstFrameHeader) {
				throw new Error('No valid ADTS frame found.');
			}

			// Create the single audio track
			this.tracks = [new InputAudioTrack(this.input, new AdtsAudioTrackBacking(this))];
		})();
	}

	async advanceReader(res: ResultValue<void>): Promise<Yo> {
		let slice = this.reader.requestSliceRange(this.lastLoadedPos, MIN_FRAME_HEADER_SIZE, MAX_FRAME_HEADER_SIZE);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			this.lastSampleLoaded = true;
			return res.set();
		}

		const header = readFrameHeader(slice);
		if (!header) {
			this.lastSampleLoaded = true;
			return res.set();
		}

		if (this.reader.fileSize !== null && header.startPos + header.frameLength > this.reader.fileSize) {
			// Frame doesn't fit in the rest of the file
			this.lastSampleLoaded = true;
			return res.set();
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

		return res.set();
	}

	async getMimeType() {
		return 'audio/aac';
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
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

	getTimeResolution() {
		const sampleRate = this.getSampleRate();
		return sampleRate / SAMPLES_PER_AAC_FRAME;
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

	async getPacketAtIndex(
		res: ResultValue<EncodedPacket | null>,
		sampleIndex: number,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		if (sampleIndex === -1) {
			return res.set(null);
		}

		const rawSample = this.demuxer.loadedSamples[sampleIndex];
		if (!rawSample) {
			return res.set(null);
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(rawSample.dataStart, rawSample.dataSize);
			if (slice instanceof Promise) slice = await slice;

			if (!slice) {
				return res.set(null); // Data didn't fit into the rest of the file
			}

			data = readBytes(slice, rawSample.dataSize);
		}

		return res.set(new EncodedPacket(
			data,
			'key',
			rawSample.timestamp,
			rawSample.duration,
			sampleIndex,
			rawSample.dataSize,
		));
	}

	getFirstPacket(res: ResultValue<EncodedPacket | null>, options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(res, 0, options);
	}

	async getNextPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		using lock = this.demuxer.readingMutex.lock();
		if (lock.pending) await lock.ready;

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
			const result = new ResultValue<void>();
			const promise = this.demuxer.advanceReader(result);
			if (result.pending) await promise;
		}

		return this.getPacketAtIndex(res, nextIndex, options);
	}

	async getPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		using lock = this.demuxer.readingMutex.lock();
		if (lock.pending) await lock.ready;

		while (true) {
			const index = binarySearchLessOrEqual(
				this.demuxer.loadedSamples,
				timestamp,
				x => x.timestamp,
			);

			if (index === -1 && this.demuxer.loadedSamples.length > 0) {
				// We're before the first sample
				return res.set(null);
			}

			if (this.demuxer.lastSampleLoaded) {
				// All data is loaded, return what we found
				return this.getPacketAtIndex(res, index, options);
			}

			if (index >= 0 && index + 1 < this.demuxer.loadedSamples.length) {
				// The next packet also exists, we're done
				return this.getPacketAtIndex(res, index, options);
			}

			// Otherwise, keep loading data
			const result = new ResultValue<void>();
			const promise = this.demuxer.advanceReader(result);
			if (result.pending) await promise;
		}
	}

	getKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		return this.getPacket(res, timestamp, options);
	}

	getNextKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		return this.getNextPacket(res, packet, options);
	}
}
