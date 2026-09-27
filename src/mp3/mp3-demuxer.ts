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
	clamp,
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
} from '../../shared/mp3-misc';
import {
	ID3_V1_TAG_SIZE,
	ID3_V2_HEADER_SIZE,
	parseId3V1Tag,
	parseId3V2Tag,
	readId3V2Header,
} from '../id3';
import { readNextMp3FrameHeader } from './mp3-reader';
import { readAscii, readBytes, Reader, readU32Be } from '../reader';

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

/**
 * Fixed reconstruction latency of a conformant MPEG-1 Layer III decoder: the synthesis filterbank + IMDCT
 * overlap-add emit output 528.5 samples behind the encoded timeline (rounded up by convention). The LAME tag's
 * gapless declaration stores only the encoder-side numbers and expects the player to add this decoder-side
 * constant — a raw-frame decoder never sees the tag and cannot compensate itself. Reference implementations
 * hardcode the same value: ffmpeg's `start_skip_samples = start_pad + 528 + 1` (libavformat/mp3dec.c), mpg123's
 * `GAPLESS_DELAY 529`.
 */
const MP3_DECODER_DELAY_IN_SAMPLES = 529;

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
		frameCount: number | null;
		fileSize: number | null;
		/**
		 * mp3 gapless declaration from the LAME-style Xing extension: the number
		 * of codec-priming samples at the start (encoder delay) and of padding
		 * samples at the end. `null` when the tag doesn't declare them.
		 */
		encoderDelay: number | null;
		encoderPadding: number | null;
	} | null = null;

	trackBackings: Mp3AudioTrackBacking[] = [];

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
		if (this.lastLoadedPos === 0) {
			// Let's skip all ID3v2 tags at the start of the file
			while (true) {
				let slice = this.reader.requestSlice(this.lastLoadedPos, ID3_V2_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;

				if (!slice) {
					this.lastSampleLoaded = true;
					return;
				}

				const id3V2Header = readId3V2Header(slice);
				if (!id3V2Header) {
					break;
				}

				this.lastLoadedPos = slice.filePos + id3V2Header.size;
			}
		}

		const result = await readNextMp3FrameHeader(
			this.reader,
			this.lastLoadedPos,
			this.reader.fileSize,
			this.firstFrameHeader,
		);
		if (!result) {
			this.lastSampleLoaded = true;
			return;
		}

		const header = result.header;

		this.lastLoadedPos = result.startPos + header.totalSize - 1; // -1 in case the frame is 1 byte too short

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
					// Optional Xing fields and the LAME extension must stay inside their frame; a field cut off by
					// the frame's end counts as absent.
					const readSize = clamp(header.totalSize - xingOffset - 4, 0, 160);
					let xingDataSlice = this.reader.requestSlice(result.startPos + xingOffset + 4, readSize);
					if (isThenable(xingDataSlice)) xingDataSlice = await xingDataSlice;
					if (xingDataSlice) {
						const xingData = readBytes(xingDataSlice, readSize);
						const view = toDataView(xingData);
						const readField = (offset: number) => offset + 4 <= view.byteLength
							? view.getUint32(offset, false)
							: null;
						const flags = readField(0) ?? 0;

						let pos = 4;
						const frameCount = (flags & XingFlags.FrameCount) ? readField(pos) : null;
						if (flags & XingFlags.FrameCount) pos += 4;
						const fileSize = (flags & XingFlags.FileSize) ? readField(pos) : null;
						if (flags & XingFlags.FileSize) pos += 4;
						if (flags & XingFlags.Toc) pos += 100;
						if (flags & (1 << 3)) pos += 4; // Quality indicator field

						// LAME-style extension: a 9-byte encoder string, then the encoder
						// delay and padding packed into 3 bytes at offset 21 — the mp3
						// gapless declaration (true stream length = frames * spf - delay
						// - padding).
						let encoderDelay: number | null = null;
						let encoderPadding: number | null = null;
						if (view.byteLength >= pos + 24) {
							const encoderIsAscii = xingData
								.subarray(pos, pos + 4)
								.every(byte => byte >= 0x20 && byte <= 0x7e);
							const delay = (view.getUint8(pos + 21) << 4) | (view.getUint8(pos + 22) >> 4);
							const padding = ((view.getUint8(pos + 22) & 0x0f) << 8) | view.getUint8(pos + 23);

							// All-zero fields mean "not declared" (bare Xing header)
							if (encoderIsAscii && (delay !== 0 || padding !== 0)) {
								encoderDelay = delay;
								encoderPadding = padding;
							}
						}

						this.xingData = { frameCount, fileSize, encoderDelay, encoderPadding };
					}
				}

				return;
			}
		}

		if (!this.firstFrameHeader) {
			this.firstFrameHeader = header;
			this.firstFrameHeaderPos = result.startPos;
		}

		// mp3 gapless (LAME tag): the declared encoder delay PLUS the decoder's fixed
		// reconstruction latency shift the whole timeline left (pre-zero audio is codec
		// priming, cropped downstream like an mp4 edit list), and the declared stream
		// end clamps the final frame's duration (trailing encoder padding is not
		// content). The tag carries encoder-side numbers only — the decoder-side 529
		// is the demuxer's to add, exactly where ffmpeg's mp3 demuxer adds it. The end
		// discard thus becomes padding − 529; a padding below 529 comes out short by
		// the difference, identically to the reference decoder.
		const gapless = this.getGaplessDeclaration();
		const timelineShiftInSamples = gapless ? gapless.delay + MP3_DECODER_DELAY_IN_SAMPLES : 0;
		const declaredEndInSamples = gapless && this.xingData?.frameCount != null
			? this.xingData.frameCount * header.audioSamplesInFrame - gapless.delay - gapless.padding
			: null;

		const startInSamples = this.nextTimestampInSamples - timelineShiftInSamples;
		let endInSamples = startInSamples + header.audioSamplesInFrame;
		if (declaredEndInSamples !== null) {
			endInSamples = Math.min(endInSamples, declaredEndInSamples);
		}

		const sample: Sample = {
			timestamp: startInSamples / this.firstFrameHeader.sampleRate,
			duration: Math.max(endInSamples - startInSamples, 0) / this.firstFrameHeader.sampleRate,
			dataStart: result.startPos,
			dataSize: header.totalSize,
		};

		this.loadedSamples.push(sample);
		this.nextTimestampInSamples += header.audioSamplesInFrame;

		return;
	}

	/**
	 * The encoder delay and padding the LAME tag declares, or null if it declares none. Delay and padding that
	 * together exceed the samples of the frames the Xing header counts are inconsistent, so they count as absent too
	 * and the timing stays untrimmed.
	 */
	getGaplessDeclaration() {
		assert(this.firstFrameHeader);

		const xingData = this.xingData;
		if (!xingData || xingData.encoderDelay === null || xingData.encoderPadding === null) {
			return null;
		}

		const totalSamples = xingData.frameCount !== null
			? xingData.frameCount * this.firstFrameHeader.audioSamplesInFrame
			: Infinity;
		if (xingData.encoderDelay + xingData.encoderPadding > totalSamples) {
			return null;
		}

		return { delay: xingData.encoderDelay, padding: xingData.encoderPadding };
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

	getId() {
		return 1;
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

		if (demuxer.xingData) {
			if (demuxer.xingData.frameCount !== null) {
				const totalSamples = demuxer.xingData.frameCount * demuxer.firstFrameHeader.audioSamplesInFrame;
				// With a gapless declaration the timeline is shifted by -delay and
				// ends at the declared stream length.
				const gapless = demuxer.getGaplessDeclaration();
				const trimmedSamples = gapless ? totalSamples - gapless.delay - gapless.padding : totalSamples;

				return trimmedSamples / demuxer.firstFrameHeader.sampleRate;
			}
		} else {
			// No Xing, assuming CBR

			if (demuxer.reader.fileSize !== null) {
				const averageFrameSize = computeAverageMp3FrameSize(
					demuxer.firstFrameHeader.lowSamplingFrequency,
					demuxer.firstFrameHeader.layer,
					demuxer.firstFrameHeader.bitrate,
					demuxer.firstFrameHeader.sampleRate,
				);
				const frameCount = (demuxer.reader.fileSize - demuxer.firstFrameHeaderPos) / averageFrameSize;

				return Math.round(frameCount)
					* demuxer.firstFrameHeader.audioSamplesInFrame
					/ demuxer.firstFrameHeader.sampleRate;
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
				let index = binarySearchLessOrEqual(
					this.demuxer.loadedSamples,
					timestamp,
					x => x.timestamp,
				);
				// Packets that start at or after the declared end present nothing: they stay in decode order, but a
				// timestamp lookup never lands on them
				while (index >= 0 && this.demuxer.loadedSamples[index]!.duration === 0) {
					index--;
				}

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
