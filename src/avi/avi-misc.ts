/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, VideoCodec } from '../codec';

export interface AVIMainHeader {
	microSecPerFrame: number;
	maxBytesPerSec: number;
	paddingGranularity: number;
	flags: number;
	totalFrames: number;
	initialFrames: number;
	streams: number;
	suggestedBufferSize: number;
	width: number;
	height: number;
}

export interface AVIStreamHeader {
	fccType: string;
	fccHandler: string;
	flags: number;
	priority: number;
	language: number;
	initialFrames: number;
	scale: number;
	rate: number;
	start: number;
	length: number;
	suggestedBufferSize: number;
	quality: number;
	sampleSize: number;
	frame: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	};
}

export interface AVIBitmapInfoHeader {
	size: number;
	width: number;
	height: number;
	planes: number;
	bitCount: number;
	compression: string;
	sizeImage: number;
	xPelsPerMeter: number;
	yPelsPerMeter: number;
	clrUsed: number;
	clrImportant: number;
}

export interface AVIWaveFormatEx {
	formatTag: number;
	channels: number;
	samplesPerSec: number;
	avgBytesPerSec: number;
	blockAlign: number;
	bitsPerSample: number;
	cbSize?: number;
	extraData?: Uint8Array;
}

export interface AVIIndexEntry {
	ckid: string;
	flags: number;
	offset: number;
	size: number;
}

export const AVIIF_KEYFRAME = 0x00000010;
export const AVIIF_LIST = 0x00000001;
export const AVIIF_NO_TIME = 0x00000100;

const VIDEO_FOURCC_TO_CODEC: Record<string, VideoCodec> = {
	'H264': 'avc',
	'h264': 'avc',
	'AVC1': 'avc',
	'avc1': 'avc',
	'H265': 'hevc',
	'h265': 'hevc',
	'HEVC': 'hevc',
	'hevc': 'hevc',
	'hev1': 'hevc',
	'hvc1': 'hevc',
	'VP80': 'vp8',
	'VP8 ': 'vp8',
	'VP90': 'vp9',
	'VP9 ': 'vp9',
	'AV01': 'av1',
	'av01': 'av1',
	'XVID': 'mpeg4',
	'xvid': 'mpeg4',
	'DIVX': 'mpeg4',
	'DX50': 'mpeg4',
	'FMP4': 'mpeg4',
	'MP4V': 'mpeg4',
};

const AUDIO_FORMAT_TAG_TO_CODEC: Record<number, AudioCodec> = {
	0x0001: 'pcm-s16',
	0x0003: 'pcm-f32',
	0x0006: 'alaw',
	0x0007: 'ulaw',
	0x0055: 'mp3',
	0x0092: 'ac3',
	0x00FF: 'aac',
	0x2000: 'aac',
	0x566F: 'vorbis',
	0x674F: 'vorbis',
	0xF1AC: 'flac',
};

export function aviVideoFourccToCodec(fourccStr: string): VideoCodec | null {
	const codec = VIDEO_FOURCC_TO_CODEC[fourccStr];
	return codec as VideoCodec || null;
}

export function aviAudioFormatTagToCodec(formatTag: number): AudioCodec | null {
	const codec = AUDIO_FORMAT_TAG_TO_CODEC[formatTag];
	return codec as AudioCodec || null;
}

const CODEC_TO_PREFERRED_FOURCC: Partial<Record<VideoCodec, string>> = {
	avc: 'H264',
	hevc: 'H265',
	vp8: 'VP80',
	vp9: 'VP90',
	av1: 'AV01',
	mpeg4: 'XVID',
};

export function aviVideoCodecToFourcc(codec: VideoCodec): string | null {
	const preferred = CODEC_TO_PREFERRED_FOURCC[codec];
	if (preferred) return preferred;

	for (const [fourccStr, codecId] of Object.entries(VIDEO_FOURCC_TO_CODEC)) {
		if (codecId === codec) {
			return fourccStr;
		}
	}
	return null;
}

export function aviAudioCodecToFormatTag(codec: AudioCodec): number | null {
	for (const [tag, codecId] of Object.entries(AUDIO_FORMAT_TAG_TO_CODEC)) {
		if (codecId === codec) {
			return Number(tag);
		}
	}
	return null;
}

export function parseMainHeader(data: DataView): AVIMainHeader {
	return {
		microSecPerFrame: data.getUint32(0, true),
		maxBytesPerSec: data.getUint32(4, true),
		paddingGranularity: data.getUint32(8, true),
		flags: data.getUint32(12, true),
		totalFrames: data.getUint32(16, true),
		initialFrames: data.getUint32(20, true),
		streams: data.getUint32(24, true),
		suggestedBufferSize: data.getUint32(28, true),
		width: data.getUint32(32, true),
		height: data.getUint32(36, true),
	};
}

export function parseStreamHeader(data: DataView): AVIStreamHeader {
	const decoder = new TextDecoder('latin1');
	return {
		fccType: decoder.decode(new Uint8Array(data.buffer, data.byteOffset, 4)),
		fccHandler: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + 4, 4)),
		flags: data.getUint32(8, true),
		priority: data.getUint16(12, true),
		language: data.getUint16(14, true),
		initialFrames: data.getUint32(16, true),
		scale: data.getUint32(20, true),
		rate: data.getUint32(24, true),
		start: data.getUint32(28, true),
		length: data.getUint32(32, true),
		suggestedBufferSize: data.getUint32(36, true),
		quality: data.getUint32(40, true),
		sampleSize: data.getUint32(44, true),
		frame: {
			left: data.getUint16(48, true),
			top: data.getUint16(50, true),
			right: data.getUint16(52, true),
			bottom: data.getUint16(54, true),
		},
	};
}

export function parseBitmapInfoHeader(data: DataView): AVIBitmapInfoHeader {
	const decoder = new TextDecoder('latin1');
	return {
		size: data.getUint32(0, true),
		width: data.getInt32(4, true),
		height: data.getInt32(8, true),
		planes: data.getUint16(12, true),
		bitCount: data.getUint16(14, true),
		compression: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + 16, 4)),
		sizeImage: data.getUint32(20, true),
		xPelsPerMeter: data.getInt32(24, true),
		yPelsPerMeter: data.getInt32(28, true),
		clrUsed: data.getUint32(32, true),
		clrImportant: data.getUint32(36, true),
	};
}

export function parseWaveFormatEx(data: DataView): AVIWaveFormatEx {
	const formatTag = data.getUint16(0, true);
	const channels = data.getUint16(2, true);
	const samplesPerSec = data.getUint32(4, true);
	const avgBytesPerSec = data.getUint32(8, true);
	const blockAlign = data.getUint16(12, true);
	const bitsPerSample = data.getUint16(14, true);

	let cbSize = 0;
	let extraData: Uint8Array | undefined;

	if (data.byteLength >= 18) {
		cbSize = data.getUint16(16, true);
		if (cbSize > 0 && data.byteLength >= 18 + cbSize) {
			extraData = new Uint8Array(data.buffer, data.byteOffset + 18, cbSize);
		}
	}

	return {
		formatTag,
		channels,
		samplesPerSec,
		avgBytesPerSec,
		blockAlign,
		bitsPerSample,
		cbSize,
		extraData,
	};
}

export function parseIndexEntry(data: DataView, offset: number): AVIIndexEntry {
	const decoder = new TextDecoder('latin1');
	return {
		ckid: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + offset, 4)),
		flags: data.getUint32(offset + 4, true),
		offset: data.getUint32(offset + 8, true),
		size: data.getUint32(offset + 12, true),
	};
}

export function makeStreamChunkId(streamNumber: number, type: 'db' | 'dc' | 'wb' | 'pc'): string {
	const streamStr = streamNumber.toString().padStart(2, '0');
	return streamStr + type;
}

export function parseStreamChunkId(ckid: string): { streamNumber: number; type: string } | null {
	if (ckid.length !== 4) return null;

	const streamStr = ckid.substring(0, 2);
	const type = ckid.substring(2);
	const streamNumber = parseInt(streamStr, 10);

	if (isNaN(streamNumber)) return null;

	return { streamNumber, type };
}
