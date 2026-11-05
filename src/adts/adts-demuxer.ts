/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	aacChannelMap,
	aacFrequencyTable,
	getAacProgramConfigElementChannelCount,
	readAdtsProgramConfigElement,
} from '../../shared/aac-misc';
import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import {
	ID3_V2_HEADER_SIZE,
	parseId3V2Tag,
	readId3V2Header,
} from '../id3';
import { Input } from '../input';
import { InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	AsyncMutex,
	binarySearchExact,
	binarySearchLessOrEqual,
	isThenable,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readBytes, Reader } from '../reader';
import { Logging } from '../logging';
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
	numberOfChannels: number | null = null;
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
				await this.advanceReader();
			}

			// There has to be a frame if this demuxer got selected
			const header = this.firstFrameHeader;
			assert(header);

			if (header.channelConfiguration === 0) {
				// The channel layout comes from the PCE at the start of the frame's raw data block
				const headerSize = header.crcCheck === null ? MIN_ADTS_FRAME_HEADER_SIZE : MAX_ADTS_FRAME_HEADER_SIZE;
				let slice = this.reader.requestSlice(header.startPos + headerSize, header.frameLength - headerSize);
				if (isThenable(slice)) slice = await slice;
				if (!slice) {
					throw new Error('Invalid ADTS file: the first frame is cut off.');
				}

				const result = readAdtsProgramConfigElement(readBytes(slice, header.frameLength - headerSize));
				if (!result) {
					throw new Error(
						'Invalid ADTS file: frames with channel configuration 0 must begin with a program config'
						+ ' element.',
					);
				}

				this.numberOfChannels = getAacProgramConfigElementChannelCount(result.programConfigElement);
			} else {
				this.numberOfChannels = aacChannelMap[header.channelConfiguration]!;
			}

			// Create the single audio track
			this.trackBackings = [new AdtsAudioTrackBacking(this)];
		})();
	}

	async advanceReader() {
		while (true) {
			let slice = this.reader.requestSliceRange(
				this.lastLoadedPos,
				MIN_ADTS_FRAME_HEADER_SIZE,
				MAX_ADTS_FRAME_HEADER_SIZE,
			);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				this.lastSampleLoaded = true;
				return;
			}

			const header = readAdtsFrameHeader(slice);
			if (!header) {
				// ID3v2 tags sit not only at the start of the file but can also come in between frames (like timed
				// metadata in HLS packed audio), so let's skip them
				let id3Slice = this.reader.requestSlice(this.lastLoadedPos, ID3_V2_HEADER_SIZE);
				if (isThenable(id3Slice)) id3Slice = await id3Slice;
				if (!id3Slice) {
					this.lastSampleLoaded = true;
					return;
				}

				const id3V2Header = readId3V2Header(id3Slice);
				if (!id3V2Header) {
					this.lastSampleLoaded = true;
					return;
				}

				this.lastLoadedPos = id3Slice.filePos + id3V2Header.size;
				continue;
			}

			if (this.reader.fileSize !== null && header.startPos + header.frameLength > this.reader.fileSize) {
				// Frame doesn't fit in the rest of the file
				this.lastSampleLoaded = true;
				return;
			}

			if (!this.firstFrameHeader) {
				this.firstFrameHeader = header;
			}

			const sampleRate = aacFrequencyTable[this.firstFrameHeader.samplingFrequencyIndex];
			assert(sampleRate !== undefined);

			if (header.samplingFrequencyIndex !== this.firstFrameHeader.samplingFrequencyIndex) {
				// Since a track can only have one sample rate, the stream ends here
				Logging._warn(
					`The sample rate changes mid-stream (from ${sampleRate} Hz to`
					+ ` ${aacFrequencyTable[header.samplingFrequencyIndex]} Hz), which isn't properly supported or`
					+ ` handled by Mediabunny.`,
				);
				this.lastSampleLoaded = true;
				return;
			}

			const sample: Sample = {
				timestamp: this.nextTimestampInSamples / sampleRate,
				duration: SAMPLES_PER_AAC_FRAME / sampleRate,
				dataStart: header.startPos,
				dataSize: header.frameLength,
			};

			this.loadedSamples.push(sample);
			this.nextTimestampInSamples += SAMPLES_PER_AAC_FRAME;
			this.lastLoadedPos = header.startPos + header.frameLength;

			return;
		}
	}

	async getMimeType() {
		return 'audio/aac';
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackings;
	}

	async getMetadataTags() {
		const release = await this.readingMutex.acquire();

		try {
			await this.readMetadata();

			if (this.metadataTags) {
				return this.metadataTags;
			}

			this.metadataTags = {};
			let currentPos = 0;

			while (true) {
				let headerSlice = this.reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
				if (isThenable(headerSlice)) headerSlice = await headerSlice;
				if (!headerSlice) break;

				const id3V2Header = readId3V2Header(headerSlice);
				if (!id3V2Header) {
					break;
				}

				let contentSlice = this.reader.requestSlice(headerSlice.filePos, id3V2Header.size);
				if (isThenable(contentSlice)) contentSlice = await contentSlice;
				if (!contentSlice) break;

				parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);

				currentPos = headerSlice.filePos + id3V2Header.size;
			}

			return this.metadataTags;
		} finally {
			release();
		}
	}
}

class AdtsAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: AdtsDemuxer) {}

	getType() {
		return 'audio' as const;
	}

	getNumber() {
		return 1;
	}

	getTimeResolution() {
		return this.getSampleRate();
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
		assert(this.demuxer.numberOfChannels !== null);
		return this.demuxer.numberOfChannels;
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
			if (isThenable(slice)) slice = await slice;

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
