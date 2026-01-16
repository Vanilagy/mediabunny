/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// https://github.com/dystopiancode/pcm-g711/blob/master/pcm-g711/g711.c

export const toUlaw = (s16: number) => {
	const MULAW_MAX = 0x1FFF;
	const MULAW_BIAS = 33;

	let number = s16;
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

	return (sign === 0) ? decoded : -decoded;
};

export const toAlaw = (s16: number) => {
	const ALAW_MAX = 0xFFF;
	let mask = 0x800;
	let sign = 0;
	let position = 11;
	let lsb = 0;

	let number = s16;

	if (number < 0) {
		number = -number;
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

	return (sign === 0) ? decoded : -decoded;
};
