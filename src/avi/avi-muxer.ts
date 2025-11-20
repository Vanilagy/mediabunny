/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Muxer } from '../muxer';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import { Output, OutputAudioTrack, OutputVideoTrack, OutputSubtitleTrack } from '../output';
import { AviOutputFormat } from '../output-format';
import { RIFFWriter } from './riff-writer';
import { promiseWithResolvers } from '../misc';
import { validateVideoChunkMetadata, validateAudioChunkMetadata } from '../codec';
import { SubtitleCue, SubtitleMetadata } from '../subtitles';
import {
	aviVideoCodecToFourcc,
	aviAudioCodecToFormatTag,
	makeStreamChunkId,
	AVIIF_KEYFRAME,
} from './avi-misc';

const APP_NAME = 'MediaBunny';

type InternalMediaChunk = {
	data: Uint8Array;
	type: 'key' | 'delta';
	timestamp: number;
	duration: number;
	streamIndex: number;
};

type AVIIndexEntry = {
	ckid: string;
	flags: number;
	offset: number;
	size: number;
};

type AVITrackData = {
	chunkQueue: InternalMediaChunk[];
	frameCount: number;
	sampleCount: number;
	maxChunkSize: number;
	lastTimestamp: number;
} & ({
	track: OutputVideoTrack;
	type: 'video';
	info: {
		width: number;
		height: number;
		frameRate: number;
		fourcc: string;
		decoderConfig: VideoDecoderConfig | null;
	};
} | {
	track: OutputAudioTrack;
	type: 'audio';
	info: {
		numberOfChannels: number;
		sampleRate: number;
		bitsPerSample: number;
		formatTag: number;
		decoderConfig: AudioDecoderConfig | null;
	};
});

type AVIVideoTrackData = AVITrackData & { type: 'video' };
type AVIAudioTrackData = AVITrackData & { type: 'audio' };

export class AVIMuxer extends Muxer {
	private writer: Writer;
	private riffWriter: RIFFWriter;
	private format: AviOutputFormat;

	private trackDatas: AVITrackData[] = [];
	private allTracksKnown = promiseWithResolvers();

	private fileStartPos = 0;
	private hdrlListSizePos = 0;
	private moviListSizePos = 0;
	private moviDataStart = 0;
	private mainHeaderPos = 0;
	private streamHeaderPositions: number[] = [];

	private index: AVIIndexEntry[] = [];
	private totalFrames = 0;
	private maxBytesPerSec = 0;
	private duration = 0;

	private headerFinalized = false;

	constructor(output: Output, format: AviOutputFormat) {
		super(output);

		this.writer = output._writer;
		this.format = format;
		this.riffWriter = new RIFFWriter(this.writer);

		if (this.format._options.large) {
			// RF64 support could be added here
		}
	}

	async start() {
		const release = await this.mutex.acquire();

		this.fileStartPos = this.writer.getPos();

		// Write RIFF header
		this.riffWriter.writeFourCC('RIFF');
		this.riffWriter.writeUint32(0); // File size placeholder
		this.riffWriter.writeFourCC('AVI ');

		// Start header list
		this.hdrlListSizePos = this.riffWriter.startList('hdrl');

		// Write main header
		this.writeMainHeader();

		// We'll finalize header and write stream headers when we get first packet

		await this.writer.flush();

		release();
	}

	private writeMainHeader(): void {
		this.riffWriter.writeFourCC('avih');
		this.riffWriter.writeUint32(56); // Size of AVIMainHeader

		this.mainHeaderPos = this.writer.getPos();

		// Write placeholder main header
		this.riffWriter.writeUint32(41667); // microSecPerFrame (24 fps default)
		this.riffWriter.writeUint32(0); // maxBytesPerSec
		this.riffWriter.writeUint32(0); // paddingGranularity
		this.riffWriter.writeUint32(0x10); // flags (AVIF_HASINDEX)
		this.riffWriter.writeUint32(0); // totalFrames
		this.riffWriter.writeUint32(0); // initialFrames
		this.riffWriter.writeUint32(0); // streams
		this.riffWriter.writeUint32(0); // suggestedBufferSize
		this.riffWriter.writeUint32(0); // width
		this.riffWriter.writeUint32(0); // height
		// Reserved fields (4 * 4 bytes)
		this.writer.write(new Uint8Array(16));
	}

	private async finalizeHeader(): Promise<void> {
		if (this.headerFinalized) return;

		this.allTracksKnown.resolve();

		// Write all stream headers
		for (let i = 0; i < this.trackDatas.length; i++) {
			this.writeStreamList(this.trackDatas[i], i);
		}

		// End header list
		this.riffWriter.endList(this.hdrlListSizePos);

		// Start movi list
		this.moviListSizePos = this.riffWriter.startList('movi');
		this.moviDataStart = this.writer.getPos();

		this.headerFinalized = true;
	}

	private writeStreamList(trackData: AVITrackData | undefined, index: number): void {
		if (!trackData) return;
		const strlSizePos = this.riffWriter.startList('strl');

		// Write stream header
		this.riffWriter.writeFourCC('strh');
		this.riffWriter.writeUint32(56); // Size of stream header

		this.streamHeaderPositions[index] = this.writer.getPos();

		if (trackData.type === 'video') {
			const videoTrackData = trackData as AVIVideoTrackData;
			this.riffWriter.writeFourCC('vids');
			this.riffWriter.writeFourCC(videoTrackData.info.fourcc);
			this.riffWriter.writeUint32(0); // flags
			this.riffWriter.writeUint16(0); // priority
			this.riffWriter.writeUint16(0); // language
			this.riffWriter.writeUint32(0); // initialFrames
			this.riffWriter.writeUint32(1000); // scale
			this.riffWriter.writeUint32(Math.round(videoTrackData.info.frameRate * 1000)); // rate
			this.riffWriter.writeUint32(0); // start
			this.riffWriter.writeUint32(0); // length (will be updated)
			this.riffWriter.writeUint32(0); // suggestedBufferSize (will be updated)
			this.riffWriter.writeUint32(10000); // quality
			this.riffWriter.writeUint32(0); // sampleSize
			this.riffWriter.writeUint16(0); // frame.left
			this.riffWriter.writeUint16(0); // frame.top
			this.riffWriter.writeUint16(videoTrackData.info.width); // frame.right
			this.riffWriter.writeUint16(videoTrackData.info.height); // frame.bottom
		} else if (trackData.type === 'audio') {
			const audioTrackData = trackData as AVIAudioTrackData;
			const bytesPerSample = (audioTrackData.info.bitsPerSample / 8) * audioTrackData.info.numberOfChannels;
			this.riffWriter.writeFourCC('auds');
			this.riffWriter.writeUint32(0); // fccHandler
			this.riffWriter.writeUint32(0); // flags
			this.riffWriter.writeUint16(0); // priority
			this.riffWriter.writeUint16(0); // language
			this.riffWriter.writeUint32(0); // initialFrames
			this.riffWriter.writeUint32(1); // scale
			this.riffWriter.writeUint32(audioTrackData.info.sampleRate); // rate
			this.riffWriter.writeUint32(0); // start
			this.riffWriter.writeUint32(0); // length (will be updated)
			this.riffWriter.writeUint32(0); // suggestedBufferSize (will be updated)
			this.riffWriter.writeUint32(0xFFFFFFFF); // quality
			this.riffWriter.writeUint32(bytesPerSample); // sampleSize
			this.riffWriter.writeUint16(0); // frame.left
			this.riffWriter.writeUint16(0); // frame.top
			this.riffWriter.writeUint16(0); // frame.right
			this.riffWriter.writeUint16(0); // frame.bottom
		}

		// Write stream format
		this.riffWriter.writeFourCC('strf');
		if (trackData.type === 'video') {
			const videoTrackData = trackData as AVIVideoTrackData;
			this.riffWriter.writeUint32(40); // Size of BITMAPINFOHEADER
			this.riffWriter.writeUint32(40); // biSize
			this.riffWriter.writeInt32(videoTrackData.info.width); // biWidth
			this.riffWriter.writeInt32(videoTrackData.info.height); // biHeight
			this.riffWriter.writeUint16(1); // biPlanes
			this.riffWriter.writeUint16(24); // biBitCount
			this.riffWriter.writeFourCC(videoTrackData.info.fourcc); // biCompression
			this.riffWriter.writeUint32(0); // biSizeImage
			this.riffWriter.writeInt32(0); // biXPelsPerMeter
			this.riffWriter.writeInt32(0); // biYPelsPerMeter
			this.riffWriter.writeUint32(0); // biClrUsed
			this.riffWriter.writeUint32(0); // biClrImportant
		} else if (trackData.type === 'audio') {
			const audioTrackData = trackData as AVIAudioTrackData;
			const blockAlign = audioTrackData.info.numberOfChannels * (audioTrackData.info.bitsPerSample / 8);
			this.riffWriter.writeUint32(16); // Basic WAVEFORMATEX size
			this.riffWriter.writeUint16(audioTrackData.info.formatTag); // wFormatTag
			this.riffWriter.writeUint16(audioTrackData.info.numberOfChannels); // nChannels
			this.riffWriter.writeUint32(audioTrackData.info.sampleRate); // nSamplesPerSec
			this.riffWriter.writeUint32(audioTrackData.info.sampleRate * blockAlign); // nAvgBytesPerSec
			this.riffWriter.writeUint16(blockAlign); // nBlockAlign
			this.riffWriter.writeUint16(audioTrackData.info.bitsPerSample); // wBitsPerSample
		}

		this.riffWriter.endList(strlSizePos);
	}

	async getMimeType(): Promise<string> {
		return 'video/x-msvideo';
	}

	private getVideoTrackData(track: OutputVideoTrack): AVIVideoTrackData | null {
		for (const trackData of this.trackDatas) {
			if (trackData.track === track) {
				return trackData as AVIVideoTrackData;
			}
		}
		return null;
	}

	private getAudioTrackData(track: OutputAudioTrack): AVIAudioTrackData | null {
		for (const trackData of this.trackDatas) {
			if (trackData.track === track) {
				return trackData as AVIAudioTrackData;
			}
		}
		return null;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): Promise<void> {
		const release = await this.mutex.acquire();

		let trackData = this.getVideoTrackData(track);

		if (!trackData) {
			// First packet for this track - create track data
			const fourcc = aviVideoCodecToFourcc(track.source._codec);
			if (!fourcc) {
				throw new Error(`Unsupported video codec for AVI: ${track.source._codec}`);
			}

			validateVideoChunkMetadata(meta);

			trackData = {
				track,
				type: 'video',
				info: {
					width: meta!.decoderConfig!.codedWidth || 640,
					height: meta!.decoderConfig!.codedHeight || 480,
					frameRate: 30,
					fourcc,
					decoderConfig: meta!.decoderConfig!,
				},
				chunkQueue: [],
				frameCount: 0,
				sampleCount: 0,
				maxChunkSize: 0,
				lastTimestamp: 0,
			};

			this.trackDatas.push(trackData);
		}

		// Ensure header is finalized before writing any data
		if (!this.headerFinalized) {
			await this.finalizeHeader();
		}

		const streamIndex = this.trackDatas.indexOf(trackData);
		const chunkId = makeStreamChunkId(streamIndex, 'dc');
		const offset = this.writer.getPos() - this.moviDataStart;

		// Write chunk
		this.riffWriter.writeFourCC(chunkId);
		this.riffWriter.writeUint32(packet.data.length);
		this.writer.write(packet.data);
		this.riffWriter.writePadding();

		// Add to index
		this.index.push({
			ckid: chunkId,
			flags: packet.type === 'key' ? AVIIF_KEYFRAME : 0,
			offset,
			size: packet.data.length,
		});

		trackData.frameCount++;
		trackData.lastTimestamp = packet.timestamp;
		trackData.maxChunkSize = Math.max(trackData.maxChunkSize, packet.data.length);
		this.totalFrames = Math.max(this.totalFrames, trackData.frameCount);
		this.duration = Math.max(this.duration, packet.timestamp);

		release();
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Promise<void> {
		const release = await this.mutex.acquire();

		let trackData = this.getAudioTrackData(track);

		if (!trackData) {
			// First packet for this track - create track data
			const formatTag = aviAudioCodecToFormatTag(track.source._codec);
			if (formatTag === null) {
				throw new Error(`Unsupported audio codec for AVI: ${track.source._codec}`);
			}

			validateAudioChunkMetadata(meta);

			trackData = {
				track,
				type: 'audio',
				info: {
					numberOfChannels: meta!.decoderConfig!.numberOfChannels || 2,
					sampleRate: meta!.decoderConfig!.sampleRate || 48000,
					bitsPerSample: 16, // Default, could be derived from codec
					formatTag,
					decoderConfig: meta!.decoderConfig!,
				},
				chunkQueue: [],
				frameCount: 0,
				sampleCount: 0,
				maxChunkSize: 0,
				lastTimestamp: 0,
			};

			this.trackDatas.push(trackData);
		}

		// Ensure header is finalized before writing any data
		if (!this.headerFinalized) {
			await this.finalizeHeader();
		}

		const streamIndex = this.trackDatas.indexOf(trackData);
		const chunkId = makeStreamChunkId(streamIndex, 'wb');
		const offset = this.writer.getPos() - this.moviDataStart;

		// Write chunk
		this.riffWriter.writeFourCC(chunkId);
		this.riffWriter.writeUint32(packet.data.length);
		this.writer.write(packet.data);
		this.riffWriter.writePadding();

		// Add to index
		this.index.push({
			ckid: chunkId,
			flags: 0,
			offset,
			size: packet.data.length,
		});

		// Update sample count
		const bytesPerSample = (trackData.info.bitsPerSample / 8) * trackData.info.numberOfChannels;
		trackData.sampleCount += Math.floor(packet.data.length / bytesPerSample);
		trackData.lastTimestamp = packet.timestamp;
		trackData.maxChunkSize = Math.max(trackData.maxChunkSize, packet.data.length);
		this.duration = Math.max(this.duration, packet.timestamp);

		release();
	}

	async addSubtitleCue(
		track: OutputSubtitleTrack,
		cue: SubtitleCue,
		meta?: SubtitleMetadata,
	): Promise<void> {
		// AVI doesn't support subtitles
		throw new Error('AVI format does not support subtitle tracks');
	}

	async finalize(): Promise<void> {
		const release = await this.mutex.acquire();

		// Ensure header was finalized if no packets were written
		if (!this.headerFinalized) {
			await this.finalizeHeader();
		}

		// End movi list
		if (this.moviListSizePos) {
			this.riffWriter.endList(this.moviListSizePos);
		}

		// Write index
		if (this.index.length > 0) {
			const idxSizePos = this.riffWriter.startChunk('idx1');
			for (const entry of this.index) {
				this.riffWriter.writeFourCC(entry.ckid);
				this.riffWriter.writeUint32(entry.flags);
				this.riffWriter.writeUint32(entry.offset);
				this.riffWriter.writeUint32(entry.size);
			}
			this.riffWriter.endChunk(idxSizePos);
		}

		// Update sizes and counts
		const endPos = this.writer.getPos();

		// Update RIFF size
		this.writer.seek(this.fileStartPos + 4);
		this.riffWriter.writeUint32(endPos - this.fileStartPos - 8);

		// Update main header
		this.updateMainHeader();

		// Update stream headers
		this.updateStreamHeaders();

		this.writer.seek(endPos);

		await this.writer.flush();
		release();
	}

	private updateMainHeader(): void {
		this.writer.seek(this.mainHeaderPos);

		// Calculate actual values
		let microSecPerFrame = 41667; // Default 24fps
		let width = 0;
		let height = 0;
		let suggestedBufferSize = 0;

		for (const trackData of this.trackDatas) {
			if (trackData.type === 'video') {
				const videoTrackData = trackData as AVIVideoTrackData;
				width = Math.max(width, videoTrackData.info.width);
				height = Math.max(height, videoTrackData.info.height);
				if (videoTrackData.info.frameRate > 0) {
					microSecPerFrame = Math.round(1000000 / videoTrackData.info.frameRate);
				}
			}
			suggestedBufferSize = Math.max(suggestedBufferSize, trackData.maxChunkSize);
		}

		this.riffWriter.writeUint32(microSecPerFrame);
		this.riffWriter.writeUint32(this.maxBytesPerSec);
		this.riffWriter.writeUint32(0); // paddingGranularity
		this.riffWriter.writeUint32(0x10); // flags (AVIF_HASINDEX)
		this.riffWriter.writeUint32(this.totalFrames);
		this.riffWriter.writeUint32(0); // initialFrames
		this.riffWriter.writeUint32(this.trackDatas.length); // streams
		this.riffWriter.writeUint32(suggestedBufferSize);
		this.riffWriter.writeUint32(width);
		this.riffWriter.writeUint32(height);
	}

	private updateStreamHeaders(): void {
		for (let i = 0; i < this.trackDatas.length; i++) {
			const trackData = this.trackDatas[i];
			if (!trackData) continue;

			const pos = this.streamHeaderPositions[i];
			if (!pos) continue;

			this.writer.seek(pos + 28); // Seek to length field

			if (trackData.type === 'video') {
				this.riffWriter.writeUint32(trackData.frameCount);
			} else if (trackData.type === 'audio') {
				this.riffWriter.writeUint32(trackData.sampleCount);
			}

			this.writer.seek(pos + 32); // Seek to suggestedBufferSize field
			this.riffWriter.writeUint32(trackData.maxChunkSize);
		}
	}
}
