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
import { MediaMetadata } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import { assert, AsyncMutex, binarySearchExact, binarySearchLessOrEqual, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { FrameHeader, getXingOffset, INFO, XING } from '../../shared/mp3-misc';
import { ID3_V1_TAG_SIZE, ID3_V2_HEADER_SIZE, Mp3Reader } from './mp3-reader';

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class Mp3Demuxer extends Demuxer {
	reader: Mp3Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: FrameHeader | null = null;
	loadedSamples: Sample[] = []; // All samples from the start of the file to lastLoadedPos
	metadata: MediaMetadata | null = null;

	tracks: InputAudioTrack[] = [];

	readingMutex = new AsyncMutex();
	lastLoadedPos = 0;
	fileSize = 0;
	nextTimestampInSamples = 0;

	constructor(input: Input) {
		super(input);

		this.reader = new Mp3Reader(input._mainReader);
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			this.fileSize = await this.input.source.getSize();
			this.reader.fileSize = this.fileSize;

			// Keep loading until we find the first frame header
			while (!this.firstFrameHeader && this.lastLoadedPos < this.fileSize) {
				await this.loadNextChunk();
			}

			// There has to be a frame if this demuxer got selected
			assert(this.firstFrameHeader);

			this.tracks = [new InputAudioTrack(new Mp3AudioTrackBacking(this))];
		})();
	}

	/** Loads the next 0.5 MiB of frames. */
	async loadNextChunk() {
		assert(this.lastLoadedPos < this.fileSize);

		this.reader.pos = this.lastLoadedPos;

		const chunkSize = 0.5 * 1024 * 1024; // 0.5 MiB
		const endPos = Math.min(this.lastLoadedPos + chunkSize, this.fileSize);
		await this.reader.reader.loadRange(this.lastLoadedPos, endPos);

		this.lastLoadedPos = endPos;
		assert(this.lastLoadedPos <= this.fileSize);

		if (this.reader.pos === 0) {
			while (true) { // There may be multiple
				await this.reader.reader.loadRange(this.reader.pos, this.reader.pos + ID3_V2_HEADER_SIZE);
				const id3V2Header = this.reader.readId3V2Header();
				if (!id3V2Header) {
					break;
				}

				this.reader.pos += id3V2Header.size; // Skip it for now
			}
		}

		this.parseFramesFromLoadedData();
	}

	private parseFramesFromLoadedData() {
		while (true) {
			const startPos = this.reader.pos;
			const header = this.reader.readNextFrameHeader();
			if (!header) {
				break;
			}

			// Check if the entire frame fits in the loaded data
			if (header.startPos + header.totalSize > this.lastLoadedPos) {
				// Frame doesn't fit, reset positions and stop
				this.reader.pos = startPos;
				this.lastLoadedPos = startPos; // Snap this back too so that the next read is frame-aligned

				break;
			}

			const xingOffset = getXingOffset(header.mpegVersionId, header.channel);
			this.reader.pos = header.startPos + xingOffset;
			const word = this.reader.readU32();
			const isXing = word === XING || word === INFO;

			this.reader.pos = header.startPos + header.totalSize - 1; // -1 in case the frame is 1 byte too short

			if (isXing) {
				// There's no actual audio data in this frame, so let's skip it
				continue;
			}

			if (!this.firstFrameHeader) {
				this.firstFrameHeader = header;
			}

			const sampleDuration = header.audioSamplesInFrame / header.sampleRate;
			const sample: Sample = {
				timestamp: this.nextTimestampInSamples / header.sampleRate,
				duration: sampleDuration,
				dataStart: header.startPos,
				dataSize: header.totalSize,
			};

			this.loadedSamples.push(sample);
			this.nextTimestampInSamples += header.audioSamplesInFrame;
		}
	}

	async getMimeType() {
		return 'audio/mpeg';
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

	async getMetadata() {
		const release = await this.readingMutex.acquire();

		try {
			await this.readMetadata();

			if (this.metadata) {
				return this.metadata;
			}

			this.metadata = {};
			this.reader.pos = 0;
			let id3V2HeaderFound = false;

			while (true) {
				await this.reader.reader.loadRange(this.reader.pos, this.reader.pos + ID3_V2_HEADER_SIZE);
				const id3V2Header = this.reader.readId3V2Header();
				if (!id3V2Header) {
					break;
				}

				id3V2HeaderFound = true;

				await this.reader.reader.loadRange(this.reader.pos, this.reader.pos + id3V2Header.size);
				this.reader.parseId3V2Tag(id3V2Header, this.metadata);
			}

			if (!id3V2HeaderFound) {
				// Try reading an ID3v1 tag at the end of the file
				this.reader.pos = Math.max(0, this.fileSize - ID3_V1_TAG_SIZE);
				await this.reader.reader.loadRange(this.reader.pos, this.reader.pos + ID3_V1_TAG_SIZE);

				const tag = this.reader.readAscii(3);
				if (tag === 'TAG') {
					this.reader.parseId3V1Tag(this.metadata);
				}
			}

			return this.metadata;
		} finally {
			release();
		}
	}
}

class Mp3AudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: Mp3Demuxer) {}

	getId() {
		return 1;
	}

	async getFirstTimestamp() {
		return 0;
	}

	getTimeResolution() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate / this.demuxer.firstFrameHeader.audioSamplesInFrame;
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

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.demuxer.firstFrameHeader);

		return {
			codec: 'mp3',
			numberOfChannels: this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2,
			sampleRate: this.demuxer.firstFrameHeader.sampleRate,
		};
	}

	getPacketAtIndex(sampleIndex: number, options: PacketRetrievalOptions) {
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
			this.demuxer.reader.pos = rawSample.dataStart;
			data = this.demuxer.reader.readBytes(rawSample.dataSize);
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

	async getFirstPacket(options: PacketRetrievalOptions) {
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
				&& this.demuxer.lastLoadedPos < this.demuxer.fileSize
			) {
				await this.demuxer.loadNextChunk();
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

				if (this.demuxer.lastLoadedPos === this.demuxer.fileSize) {
					// All data is loaded, return what we found
					return this.getPacketAtIndex(index, options);
				}

				if (index >= 0 && index + 1 < this.demuxer.loadedSamples.length) {
					// The next packet also exists, we're done
					return this.getPacketAtIndex(index, options);
				}

				// Otherwise, keep loading data
				await this.demuxer.loadNextChunk();
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
