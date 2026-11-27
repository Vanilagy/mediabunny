/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parsePcmCodec, PcmAudioCodec } from './codec';
import { assert, assertNever } from './misc';

// Original source:
// https://github.com/dystopiancode/pcm-g711/blob/master/pcm-g711/g711.c

export const toUlaw = (s16: number) => {
	const MULAW_MAX = 0x1FFF;
	const MULAW_BIAS = 33;

	let number = s16 >> 2;
	let mask = 0x1000;
	let sign = 0;
	let position = 12;
	let lsb = 0;

	if (number < 0) {
		number = -number;
		sign = 0x80;
	}

	number += MULAW_BIAS;

	if (number > MULAW_MAX) {
		number = MULAW_MAX;
	}

	while ((number & mask) !== mask && position >= 5) {
		mask >>= 1;
		position--;
	}

	lsb = (number >> (position - 4)) & 0x0f;

	return ~(sign | ((position - 5) << 4) | lsb) & 0xFF;
};

export const fromUlaw = (u8: number) => {
	const MULAW_BIAS = 33;
	let sign = 0;
	let position = 0;

	let number = ~u8;

	if (number & 0x80) {
		number &= ~(1 << 7);
		sign = -1;
	}

	position = ((number & 0xF0) >> 4) + 5;

	const decoded = ((1 << position) | ((number & 0x0F) << (position - 4))
		| (1 << (position - 5))) - MULAW_BIAS;

	return ((sign === 0) ? decoded : -decoded) << 2;
};

export const toAlaw = (s16: number) => {
	const ALAW_MAX = 0xFFF;
	let mask = 0x800;
	let sign = 0;
	let position = 11;
	let lsb = 0;

	let number = s16 >> 3;

	if (number < 0) {
		number = -number - 1;
	} else {
		sign = 0x80;
	}

	if (number > ALAW_MAX) {
		number = ALAW_MAX;
	}

	while ((number & mask) !== mask && position >= 5) {
		mask >>= 1;
		position--;
	}

	lsb = (number >> ((position === 4) ? 1 : (position - 4))) & 0x0f;

	return (sign | ((position - 4) << 4) | lsb) ^ 0x55;
};

export const fromAlaw = (u8: number) => {
	let sign = 0x00;
	let position = 0;

	let number = u8 ^ 0x55;

	if (number & 0x80) {
		number &= ~(1 << 7);
		sign = -1;
	}

	position = ((number & 0xF0) >> 4) + 4;

	let decoded = 0;
	if (position !== 4) {
		decoded = ((1 << position) | ((number & 0x0F) << (position - 4))
			| (1 << (position - 5)));
	} else {
		decoded = (number << 1) | 1;
	}

	return ((sign === 0) ? -decoded : decoded) << 3;
};

// Integer keys, since switching over these in per-value loops is much faster than over strings
export const PCM_FORMAT_U8 = 0;
export const PCM_FORMAT_S8 = 1;
export const PCM_FORMAT_ULAW = 2;
export const PCM_FORMAT_ALAW = 3;
export const PCM_FORMAT_U16_LE = 4;
export const PCM_FORMAT_U16_BE = 5;
export const PCM_FORMAT_S16_LE = 6;
export const PCM_FORMAT_S16_BE = 7;
export const PCM_FORMAT_U24_LE = 8;
export const PCM_FORMAT_U24_BE = 9;
export const PCM_FORMAT_S24_LE = 10;
export const PCM_FORMAT_S24_BE = 11;
export const PCM_FORMAT_U32_LE = 12;
export const PCM_FORMAT_U32_BE = 13;
export const PCM_FORMAT_S32_LE = 14;
export const PCM_FORMAT_S32_BE = 15;
export const PCM_FORMAT_F32_LE = 16;
export const PCM_FORMAT_F32_BE = 17;
export const PCM_FORMAT_F64_LE = 18;
export const PCM_FORMAT_F64_BE = 19;

export const getPcmFormat = (codec: PcmAudioCodec) => {
	const { dataType, sampleSize, littleEndian } = parsePcmCodec(codec);

	switch (sampleSize) {
		case 1: {
			if (dataType === 'unsigned') {
				return PCM_FORMAT_U8;
			} else if (dataType === 'signed') {
				return PCM_FORMAT_S8;
			} else if (dataType === 'ulaw') {
				return PCM_FORMAT_ULAW;
			} else if (dataType === 'alaw') {
				return PCM_FORMAT_ALAW;
			}
		}; break;
		case 2: {
			if (dataType === 'unsigned') {
				return littleEndian ? PCM_FORMAT_U16_LE : PCM_FORMAT_U16_BE;
			} else if (dataType === 'signed') {
				return littleEndian ? PCM_FORMAT_S16_LE : PCM_FORMAT_S16_BE;
			}
		}; break;
		case 3: {
			if (dataType === 'unsigned') {
				return littleEndian ? PCM_FORMAT_U24_LE : PCM_FORMAT_U24_BE;
			} else if (dataType === 'signed') {
				return littleEndian ? PCM_FORMAT_S24_LE : PCM_FORMAT_S24_BE;
			}
		}; break;
		case 4: {
			if (dataType === 'unsigned') {
				return littleEndian ? PCM_FORMAT_U32_LE : PCM_FORMAT_U32_BE;
			} else if (dataType === 'signed') {
				return littleEndian ? PCM_FORMAT_S32_LE : PCM_FORMAT_S32_BE;
			} else if (dataType === 'float') {
				return littleEndian ? PCM_FORMAT_F32_LE : PCM_FORMAT_F32_BE;
			}
		}; break;
		case 8: {
			if (dataType === 'float') {
				return littleEndian ? PCM_FORMAT_F64_LE : PCM_FORMAT_F64_BE;
			}
		}; break;
		default: {
			assertNever(sampleSize);
		};
	}

	assert(false);
};
