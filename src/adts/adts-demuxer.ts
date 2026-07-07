/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { aacChannelMap, aacFrequencyTable } from '../../shared/aac-misc';
import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import {
	ID3_V2_HEADER_SIZE,
	parseId3V2Tag,
	readId3V2Header,
} from '../id3';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	AsyncMutex,
	binarySearchLessOrEqual,
	MaybeRelevantPromise,
	ResultValue,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PacketRetrievalOptions, PLACEHOLDER_DATA } from '../packet';
import { readBytes, Reader } from '../reader';
import {
	AdtsFrameHeader,
	MIN_ADTS_FRAME_HEADER_SIZE,
	MAX_ADTS_FRAME_HEADER_SIZE,
	readAdtsFrameHeader,
} from './adts-reader';

export const SAMPLES_PER_AAC_FRAME = 1024;

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class AdtsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: AdtsFrameHeader | null = null;
	loadedSamples: Sample[] = [];
	metadataTags: MetadataTags | null = null;

	trackBackings: AdtsAudioTrackBacking[] = [];

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
				const result = new ResultValue<void>();
				const promise = this.advanceReader(result);
				if (result.pending) await promise;
			}

			if (!this.firstFrameHeader) {
				throw new Error('No valid ADTS frame found.');
			}

			// Create the single audio track
			this.trackBackings = [new AdtsAudioTrackBacking(this)];
		})();
	}

	async advanceReader(res: ResultValue<void>): MaybeRelevantPromise {
		if (this.lastLoadedPos === 0) {
			// Skip all ID3v2 tags at the start of the file
			while (true) {
				let slice = this.reader.requestSlice(this.lastLoadedPos, ID3_V2_HEADER_SIZE);
				if (slice instanceof Promise) slice = await slice;

				if (!slice) {
					this.lastSampleLoaded = true;
					return res.set();
				}

				const id3V2Header = readId3V2Header(slice);
				if (!id3V2Header) {
					break;
				}

				this.lastLoadedPos = slice.filePos + id3V2Header.size;
			}
		}

		let slice = this.reader.requestSliceRange(
			this.lastLoadedPos,
			MIN_ADTS_FRAME_HEADER_SIZE,
			MAX_ADTS_FRAME_HEADER_SIZE,
		);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			this.lastSampleLoaded = true;
			return res.set();
		}

		const header = readAdtsFrameHeader(slice);
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

		const sample: Sample = {
			timestamp: this.nextTimestampInSamples / sampleRate,
			duration: sampleDuration,
			dataStart: header.startPos,
			dataSize: header.frameLength,
		};

		this.loadedSamples.push(sample);
		this.nextTimestampInSamples += SAMPLES_PER_AAC_FRAME;
		this.lastLoadedPos = header.startPos + header.frameLength;

		return res.set();
	}

	async getMimeType() {
		return 'audio/aac';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		using lock = this.readingMutex.lock();
		if (lock.pending) await lock.ready;

		await this.readMetadata();

		if (this.metadataTags) {
			return this.metadataTags;
		}

		this.metadataTags = {};
		let currentPos = 0;

		while (true) {
			let headerSlice = this.reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (headerSlice instanceof Promise) headerSlice = await headerSlice;
			if (!headerSlice) break;

			const id3V2Header = readId3V2Header(headerSlice);
			if (!id3V2Header) {
				break;
			}

			let contentSlice = this.reader.requestSlice(headerSlice.filePos, id3V2Header.size);
			if (contentSlice instanceof Promise) contentSlice = await contentSlice;
			if (!contentSlice) break;

			parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);

			currentPos = headerSlice.filePos + id3V2Header.size;
		}

		return this.metadataTags;
	}
}

class AdtsAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: AdtsDemuxer) {}

	getType() {
		return 'audio' as const;
	}

	getId() {
		return 1;
	}

	getNumber() {
		return 1;
	}

	getTimeResolution() {
		const sampleRate = this.getSampleRate();
		return sampleRate / SAMPLES_PER_AAC_FRAME;
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
		return null; // No way
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

		return {
			codec: `mp4a.40.${this.demuxer.firstFrameHeader.objectType}`,
			numberOfChannels: this.getNumberOfChannels(),
			sampleRate: this.getSampleRate(),
		};
	}

	async getPacketAtIndex(
		res: ResultValue<EncodedPacket | null>,
		sampleIndex: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
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
	): MaybeRelevantPromise {
		using lock = this.demuxer.readingMutex.lock();
		if (lock.pending) await lock.ready;

		const sampleIndex = packet.sequenceNumber;
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
	): MaybeRelevantPromise {
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
	): MaybeRelevantPromise {
		return this.getPacket(res, timestamp, options);
	}

	getNextKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this.getNextPacket(res, packet, options);
	}
}
