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
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex,
	binarySearchExact,
	binarySearchLessOrEqual,
	isThenable,
	toDataView,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	Mp3FrameHeader,
	getXingOffset,
	INFO,
	XING,
	XingFlags,
	computeAverageMp3FrameSize,
	getMp3ChannelCount,
	MP3_DECODER_DELAY,
	MP3_FRAME_HEADER_SIZE,
	readMp3FrameHeader,
	VBRI,
} from '../../shared/mp3-misc';
import {
	ID3_V1_TAG_SIZE,
	ID3_V2_HEADER_SIZE,
	parseId3V1Tag,
	parseId3V2Tag,
	readId3V2Header,
	skipId3V2Tags,
} from '../id3';
import { readConfirmedMp3FrameHeader, readNextMp3FrameHeader } from './mp3-reader';
import { Logging } from '../logging';
import { readAscii, readBytes, Reader, readU16Be, readU32Be, readU32Le } from '../reader';

const APE_TAG_FOOTER_SIZE = 32;

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class Mp3Demuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: Mp3FrameHeader | null = null;
	firstFrameHeaderPos: number | null = null;
	xingFrameHeader: Mp3FrameHeader | null = null;
	xingFrameHeaderPos: number | null = null;
	loadedSamples: Sample[] = []; // All samples from the start of the file to lastLoadedPos
	metadataTags: MetadataTags | null = null;
	xingData: {
		isVbr: boolean;
		frameCount: number | null;
	} | null = null;

	trackBackings: Mp3AudioTrackBacking[] = [];

	readingMutex = new AsyncMutex();
	lastSampleLoaded = false;
	lastLoadedPos = 0;
	nextTimestampInSamples = 0;
	primingDelay = 0;

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

			if (!this.firstFrameHeader && this.xingFrameHeader) {
				// The file consists of nothing but a Xing frame, so it holds no audio data - but that frame still
				// tells us everything about the track
				this.firstFrameHeader = this.xingFrameHeader;
				this.firstFrameHeaderPos = this.xingFrameHeaderPos;
			}

			if (!this.firstFrameHeader) {
				throw new Error('No valid MP3 frame found.');
			}

			this.trackBackings = [new Mp3AudioTrackBacking(this)];
		})();
	}

	async advanceReader() {
		let result: { header: Mp3FrameHeader; startPos: number } | null;

		if (this.lastLoadedPos === 0) {
			// Start at the first confirmed frame, not at a false sync word in junk before it
			const startPos = await skipId3V2Tags(this.reader, 0);
			result = await readConfirmedMp3FrameHeader(this.reader, startPos, 4096, null);
		} else {
			// The next frame starts where the previous one ended (or a byte earlier, in case it was a byte too short)
			result = await readNextMp3FrameHeader(
				this.reader,
				this.lastLoadedPos,
				this.lastLoadedPos + 2,
				this.firstFrameHeader,
			);

			if (!result) {
				if (this.firstFrameHeader) {
					// If that's because the frame there has a different sample rate, the stream ends here, since a
					// track can only have one sample rate
					let slice = this.reader.requestSlice(this.lastLoadedPos, MP3_FRAME_HEADER_SIZE + 1);
					if (isThenable(slice)) slice = await slice;

					if (slice) {
						for (let i = 0; i < 2; i++) {
							slice.filePos = this.lastLoadedPos + i;
							const { header } = readMp3FrameHeader(readU32Be(slice), null);

							if (header && header.sampleRate !== this.firstFrameHeader.sampleRate) {
								Logging._warn(
									`The sample rate changes mid-stream (from ${this.firstFrameHeader.sampleRate} Hz to`
									+ ` ${header.sampleRate} Hz), which isn't properly supported or handled by`
									+ ` Mediabunny.`,
								);
								this.lastSampleLoaded = true;
								return;
							}
						}
					}
				}

				// Something else follows, so let's resync on the next confirmed frame of the stream
				const startPos = await skipId3V2Tags(this.reader, this.lastLoadedPos + 1);
				result = await readConfirmedMp3FrameHeader(this.reader, startPos, 2 ** 16, this.firstFrameHeader);
			}
		}

		if (!result) {
			this.lastSampleLoaded = true;
			return;
		}

		const header = result.header;

		this.lastLoadedPos = result.startPos + header.totalSize - 1; // -1 in case the frame is 1 byte too short

		// Header frames are checked for on every frame, not just the first, since concatenated MP3 files can have them
		// mid-stream too
		const xingOffset = getXingOffset(header.mpegVersionId, header.channel);

		let slice = this.reader.requestSlice(result.startPos + xingOffset, 4);
		if (isThenable(slice)) slice = await slice;
		if (slice) {
			const word = readU32Be(slice);
			const isXing = word === XING || word === INFO;

			if (isXing) {
				// There's no actual audio data in this frame, so let's skip it

				if (!this.xingFrameHeader) {
					this.xingFrameHeader = header;
					this.xingFrameHeaderPos = result.startPos;
				}

				if (!this.xingData) {
					let xingDataSlice = this.reader.requestSlice(result.startPos + xingOffset + 4, 8);
					if (isThenable(xingDataSlice)) xingDataSlice = await xingDataSlice;
					if (xingDataSlice) {
						const xingData = readBytes(xingDataSlice, 8);
						const view = toDataView(xingData);
						const flags = view.getUint32(0, false);

						this.xingData = {
							// LAME and FFmpeg write the same header with 'Info' in place of 'Xing' for CBR streams
							isVbr: word === XING,
							frameCount: (flags & XingFlags.FrameCount)
								? view.getUint32(4, false)
								: null,
						};

						const lameOffset = result.startPos + xingOffset + 8
							+ ((flags & XingFlags.FrameCount) ? 4 : 0)
							+ ((flags & XingFlags.FileSize) ? 4 : 0)
							+ ((flags & XingFlags.Toc) ? 100 : 0)
							+ ((flags & XingFlags.Quality) ? 4 : 0);
						if (!this.firstFrameHeader && lameOffset + 24 <= result.startPos + header.totalSize) {
							let lameSlice = this.reader.requestSlice(lameOffset, 24);
							if (isThenable(lameSlice)) lameSlice = await lameSlice;
							if (lameSlice) {
								const lame = readBytes(lameSlice, 24);
								const encoder = String.fromCharCode(...lame.subarray(0, 4));
								if (encoder === 'LAME' || encoder === 'Lavf' || encoder === 'Lavc') {
									this.primingDelay = (lame[21]! << 4 | lame[22]! >> 4) + MP3_DECODER_DELAY;
									this.nextTimestampInSamples = -this.primingDelay;
								}
							}
						}
					}
				}

				return;
			}
		}

		// Fraunhofer's Layer III encoder writes a VBRI header instead, which always sits 32 bytes past the frame header
		let vbriSlice = header.layer === 1
			? this.reader.requestSlice(result.startPos + MP3_FRAME_HEADER_SIZE + 32, 18)
			: null;
		if (isThenable(vbriSlice)) vbriSlice = await vbriSlice;
		if (vbriSlice) {
			const word = readU32Be(vbriSlice);
			const version = readU16Be(vbriSlice);

			if (word === VBRI && version === 1) {
				// Just like with Xing, there's no actual audio data in this frame
				if (!this.xingFrameHeader) {
					this.xingFrameHeader = header;
					this.xingFrameHeaderPos = result.startPos;
				}

				if (!this.xingData) {
					vbriSlice.skip(8); // Delay, quality and byte count
					const frameCount = readU32Be(vbriSlice);

					this.xingData = {
						isVbr: true,
						frameCount,
					};
				}

				return;
			}
		}

		if (!this.firstFrameHeader) {
			this.firstFrameHeader = header;
			this.firstFrameHeaderPos = result.startPos;
		}

		const sampleDuration = header.audioSamplesInFrame / this.firstFrameHeader.sampleRate;
		const sample: Sample = {
			timestamp: this.nextTimestampInSamples / this.firstFrameHeader.sampleRate,
			duration: sampleDuration,
			dataStart: result.startPos,
			dataSize: header.totalSize,
		};

		this.loadedSamples.push(sample);
		this.nextTimestampInSamples += header.audioSamplesInFrame;

		return;
	}

	async getMimeType() {
		return 'audio/mpeg';
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
			let id3V2HeaderFound = false;

			while (true) {
				let headerSlice = this.reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
				if (isThenable(headerSlice)) headerSlice = await headerSlice;
				if (!headerSlice) break;

				const id3V2Header = readId3V2Header(headerSlice);
				if (!id3V2Header) {
					break;
				}

				id3V2HeaderFound = true;

				let contentSlice = this.reader.requestSlice(headerSlice.filePos, id3V2Header.size);
				if (isThenable(contentSlice)) contentSlice = await contentSlice;
				if (!contentSlice) break;

				parseId3V2Tag(contentSlice, id3V2Header, this.metadataTags);

				currentPos = headerSlice.filePos + id3V2Header.size;
			}

			if (!id3V2HeaderFound && this.reader.fileSize !== null && this.reader.fileSize >= ID3_V1_TAG_SIZE) {
				// Try reading an ID3v1 tag at the end of the file
				let slice = this.reader.requestSlice(this.reader.fileSize - ID3_V1_TAG_SIZE, ID3_V1_TAG_SIZE);
				if (isThenable(slice)) slice = await slice;
				assert(slice);

				const tag = readAscii(slice, 3);
				if (tag === 'TAG') {
					parseId3V1Tag(slice, this.metadataTags);
				}
			}

			return this.metadataTags;
		} finally {
			release();
		}
	}
}

class Mp3AudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: Mp3Demuxer) {}

	getType() {
		return 'audio' as const;
	}

	getNumber() {
		return 1;
	}

	getTimeResolution() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate;
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
		const demuxer = this.demuxer;

		assert(demuxer.firstFrameHeader !== null);
		assert(demuxer.firstFrameHeaderPos !== null);

		if (demuxer.xingData && demuxer.xingData.frameCount !== null) {
			return (
				demuxer.xingData.frameCount * demuxer.firstFrameHeader.audioSamplesInFrame - demuxer.primingDelay
			) / demuxer.firstFrameHeader.sampleRate;
		} else if (!demuxer.xingData?.isVbr) {
			// Not tagged as VBR, assuming CBR

			if (demuxer.reader.fileSize !== null) {
				// Tags trailing the audio data mustn't count toward it
				let audioEndPos = demuxer.reader.fileSize;

				if (audioEndPos - demuxer.firstFrameHeaderPos >= ID3_V1_TAG_SIZE) {
					let slice = demuxer.reader.requestSlice(audioEndPos - ID3_V1_TAG_SIZE, 3);
					if (isThenable(slice)) slice = await slice;
					assert(slice);

					if (readAscii(slice, 3) === 'TAG') {
						audioEndPos -= ID3_V1_TAG_SIZE;
					}
				}

				// APEv2 tags sit before any ID3v1 tag
				if (audioEndPos - demuxer.firstFrameHeaderPos >= APE_TAG_FOOTER_SIZE) {
					let slice = demuxer.reader.requestSlice(audioEndPos - APE_TAG_FOOTER_SIZE, APE_TAG_FOOTER_SIZE);
					if (isThenable(slice)) slice = await slice;
					assert(slice);

					if (readAscii(slice, 8) === 'APETAGEX') {
						slice.skip(4); // Version
						const tagSize = readU32Le(slice); // Includes the footer, but not the header
						slice.skip(4); // Item count
						const flags = readU32Le(slice);
						const hasHeader = (flags & (1 << 31)) !== 0;

						audioEndPos -= tagSize + (hasHeader ? APE_TAG_FOOTER_SIZE : 0);
						if (audioEndPos < demuxer.firstFrameHeaderPos) {
							throw new Error('Invalid APE tag size.');
						}
					}
				}

				const averageFrameSize = computeAverageMp3FrameSize(
					demuxer.firstFrameHeader.lowSamplingFrequency,
					demuxer.firstFrameHeader.layer,
					demuxer.firstFrameHeader.bitrate,
					demuxer.firstFrameHeader.sampleRate,
				);
				const frameCount = (audioEndPos - demuxer.firstFrameHeaderPos) / averageFrameSize;

				return (
					Math.round(frameCount) * demuxer.firstFrameHeader.audioSamplesInFrame - demuxer.primingDelay
				) / demuxer.firstFrameHeader.sampleRate;
			}
		}

		return null;
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
		return 'mp3';
	}

	getInternalCodecId() {
		return null;
	}

	getNumberOfChannels() {
		assert(this.demuxer.firstFrameHeader);
		return getMp3ChannelCount(this.demuxer.firstFrameHeader.channel);
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
			numberOfChannels: getMp3ChannelCount(this.demuxer.firstFrameHeader.channel),
			sampleRate: this.demuxer.firstFrameHeader.sampleRate,
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
