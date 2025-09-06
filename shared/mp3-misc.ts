/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const FRAME_HEADER_SIZE = 4;

// These are in kbps:
export const MPEG_V1_BITRATES: Record<number, number[]> = {
	// Layer 3
	1: [-1, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
	// Layer 2
	2: [-1, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1],
	// Layer 1
	3: [-1, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1],
};
export const MPEG_V2_BITRATES: Record<number, number[]> = {
	// Layer 3
	1: [-1, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1],
	// Layer 2
	2: [-1, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
	// Layer 1
	3: [-1, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
};
export const SAMPLING_RATES: Record<number, number[]> = {
	// MPEG Version 2.5
	0: [11025, 12000, 8000, -1],
	// MPEG Version 2 (ISO/IEC 13818-3)
	2: [22050, 24000, 16000, -1],
	// MPEG Version 1 (ISO/IEC 11172-3)
	3: [44100, 48000, 32000, -1],
};

/** 'Xing' */
export const XING = 0x58696e67;
/** 'Info' */
export const INFO = 0x496e666f;

export type FrameHeader = {
	totalSize: number;
	mpegVersionId: number;
	layer: number;
	bitrate: number;
	frequencyIndex: number;
	sampleRate: number;
	channel: number;
	modeExtension: number;
	copyright: number;
	original: number;
	emphasis: number;
	audioSamplesInFrame: number;
};

export const computeMp3FrameSize = (layer: number, bitrate: number, sampleRate: number, padding: number) => {
	if (layer === 3) {
		// Layer 1
		return Math.floor((12 * bitrate / sampleRate + padding) * 4);
	} else {
		return Math.floor((144 * bitrate / sampleRate) + padding);
	}
};

export const getXingOffset = (mpegVersionId: number, channel: number) => {
	return mpegVersionId === 3
		? (channel === 3 ? 21 : 36)
		: (channel === 3 ? 13 : 21);
};

export const readFrameHeader = (word: number, remainingBytes: number | null): {
	header: FrameHeader | null;
	bytesAdvanced: number;
} => {
	const firstByte = word >>> 24;
	const secondByte = (word >>> 16) & 0xff;
	const thirdByte = (word >>> 8) & 0xff;
	const fourthByte = word & 0xff;

	if (firstByte !== 0xff && secondByte !== 0xff && thirdByte !== 0xff && fourthByte !== 0xff) {
		return {
			header: null,
			bytesAdvanced: 4,
		};
	}

	if (firstByte !== 0xff) {
		return { header: null, bytesAdvanced: 1 };
	}

	if ((secondByte & 0xe0) !== 0xe0) {
		return { header: null, bytesAdvanced: 1 };
	}

	const mpegVersionId = (secondByte >> 3) & 0x3;
	const layer = (secondByte >> 1) & 0x3;

	const bitrateIndex = (thirdByte >> 4) & 0xf;
	const frequencyIndex = (thirdByte >> 2) & 0x3;
	const padding = (thirdByte >> 1) & 0x1;

	const channel = (fourthByte >> 6) & 0x3;
	const modeExtension = (fourthByte >> 4) & 0x3;
	const copyright = (fourthByte >> 3) & 0x1;
	const original = (fourthByte >> 2) & 0x1;
	const emphasis = fourthByte & 0x3;

	const kilobitRate = mpegVersionId === 3
		? MPEG_V1_BITRATES[layer]?.[bitrateIndex]
		: MPEG_V2_BITRATES[layer]?.[bitrateIndex];
	if (!kilobitRate || kilobitRate === -1) {
		return { header: null, bytesAdvanced: 1 };
	}

	const bitrate = kilobitRate * 1000;

	const sampleRate = SAMPLING_RATES[mpegVersionId]?.[frequencyIndex];
	if (!sampleRate || sampleRate === -1) {
		return { header: null, bytesAdvanced: 1 };
	}

	const frameLength = computeMp3FrameSize(layer, bitrate, sampleRate, padding);

	if (remainingBytes !== null && remainingBytes < frameLength) {
		// The frame doesn't fit into the rest of the file
		return { header: null, bytesAdvanced: 1 };
	}

	let audioSamplesInFrame: number;
	if (mpegVersionId === 3) {
		audioSamplesInFrame = layer === 3 ? 384 : 1152;
	} else {
		if (layer === 3) {
			audioSamplesInFrame = 384;
		} else if (layer === 2) {
			audioSamplesInFrame = 1152;
		} else {
			audioSamplesInFrame = 576;
		}
	}

	return {
		header: {
			totalSize: frameLength,
			mpegVersionId,
			layer,
			bitrate,
			frequencyIndex,
			sampleRate,
			channel,
			modeExtension,
			copyright,
			original,
			emphasis,
			audioSamplesInFrame,
		},
		bytesAdvanced: 1,
	};
};

export const encodeSynchsafe = (unsynchsafed: number) => {
	let mask = 0x7f;
	let synchsafed = 0;
	let unsynchsafedRest = unsynchsafed;

	while ((mask ^ 0x7fffffff) !== 0) {
		synchsafed = unsynchsafedRest & ~mask;
		synchsafed <<= 1;
		synchsafed |= unsynchsafedRest & mask;
		mask = ((mask + 1) << 8) - 1;
		unsynchsafedRest = synchsafed;
	}

	return synchsafed;
};

export const decodeSynchsafe = (synchsafed: number) => {
	let mask = 0x7f000000;
	let unsynchsafed = 0;

	while (mask !== 0) {
		unsynchsafed >>= 1;
		unsynchsafed |= synchsafed & mask;
		mask >>= 8;
	}

	return unsynchsafed;
};
