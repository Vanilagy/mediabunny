/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex4,
	binarySearchLessOrEqual,
	ResultValue,
	UNDETERMINED_LANGUAGE,
	Yo,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { FrameHeader, getXingOffset, INFO, XING } from '../../shared/mp3-misc';
import {
	ID3_V1_TAG_SIZE,
	ID3_V2_HEADER_SIZE,
	parseId3V1Tag,
	parseId3V2Tag,
	readId3V2Header,
} from '../id3';
import { readNextFrameHeader } from './mp3-reader';
import { readAscii, readBytes, Reader, readU32Be } from '../reader';

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class Mp3Demuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: FrameHeader | null = null;
	loadedSamples: Sample[] = []; // All samples from the start of the file to lastLoadedPos
	metadataTags: MetadataTags | null = null;

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
				throw new Error('No valid MP3 frame found.');
			}

			this.tracks = [new InputAudioTrack(this.input, new Mp3AudioTrackBacking(this))];
		})();
	}

	async advanceReader(res: ResultValue<void>): Promise<Yo> {
		if (this.lastLoadedPos === 0) {
			// Let's skip all ID3v2 tags at the start of the file
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

		const result = new ResultValue<{
			header: FrameHeader;
			startPos: number;
		} | null>();
		const promise = readNextFrameHeader(result, this.reader, this.lastLoadedPos, this.reader.fileSize);
		if (result.pending) await promise;

		if (!result.value) {
			this.lastSampleLoaded = true;
			return res.set();
		}

		const header = result.value.header;

		this.lastLoadedPos = result.value.startPos + header.totalSize - 1; // -1 in case the frame is 1 byte too short

		const xingOffset = getXingOffset(header.mpegVersionId, header.channel);

		let slice = this.reader.requestSlice(result.value.startPos + xingOffset, 4);
		if (slice instanceof Promise) slice = await slice;
		if (slice) {
			const word = readU32Be(slice);
			const isXing = word === XING || word === INFO;

			if (isXing) {
				// There's no actual audio data in this frame, so let's skip it
				return res.set();
			}
		}

		if (!this.firstFrameHeader) {
			this.firstFrameHeader = header;
		}

		if (header.sampleRate !== this.firstFrameHeader.sampleRate) {
			console.warn(
				`MP3 changed sample rate mid-file: ${this.firstFrameHeader.sampleRate} Hz to ${header.sampleRate} Hz.`
				+ ` Might be a bug, so please report this file.`,
			);
		}

		const sampleDuration = header.audioSamplesInFrame / this.firstFrameHeader.sampleRate;
		const sample: Sample = {
			timestamp: this.nextTimestampInSamples / this.firstFrameHeader.sampleRate,
			duration: sampleDuration,
			dataStart: result.value.startPos,
			dataSize: header.totalSize,
		};

		this.loadedSamples.push(sample);
		this.nextTimestampInSamples += header.audioSamplesInFrame;

		return res.set();
	}

	async getMimeType() {
		return 'audio/mpeg';
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
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
		let id3V2HeaderFound = false;

		while (true) {
			let headerSlice = this.reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (headerSlice instanceof Promise) headerSlice = await headerSlice;
			if (!headerSlice) break;

			const id3V2Header = readId3V2Header(headerSlice);
			if (!id3V2Header) {
				break;
			}

			id3V2HeaderFound = true;

			let contentSlice = this.reader.requestSlice(headerSlice.filePos, id3V2Header.size);
			if (contentSlice instanceof Promise) contentSlice = await contentSlice;
			if (!contentSlice) break;

			parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);

			currentPos = headerSlice.filePos + id3V2Header.size;
		}

		if (!id3V2HeaderFound && this.reader.fileSize !== null && this.reader.fileSize >= ID3_V1_TAG_SIZE) {
			// Try reading an ID3v1 tag at the end of the file
			let slice = this.reader.requestSlice(this.reader.fileSize - ID3_V1_TAG_SIZE, ID3_V1_TAG_SIZE);
			if (slice instanceof Promise) slice = await slice;
			assert(slice);

			const tag = readAscii(slice, 3);
			if (tag === 'TAG') {
				parseId3V1Tag(slice, this.metadataTags);
			}
		}

		return this.metadataTags;
	}
}

class Mp3AudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: Mp3Demuxer) {}

	getId() {
		return 1;
	}

	getTimeResolution() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate / this.demuxer.firstFrameHeader.audioSamplesInFrame;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getCodec(): AudioCodec {
		return 'mp3';
	}

	getInternalCodecId() {
		return null;
	}

	getNumberOfChannels() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2;
	}

	getSampleRate() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.demuxer.firstFrameHeader);

		return {
			codec: 'mp3',
			numberOfChannels: this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2,
			sampleRate: this.demuxer.firstFrameHeader.sampleRate,
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

		const sampleIndex = packet.sequenceNumber;
		if (sampleIndex < 0) {
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
