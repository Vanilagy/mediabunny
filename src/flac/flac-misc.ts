/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, assertNever, Bitstream } from '../misc';
import { FileSlice, readBytes, readU16Be, readU8 } from '../reader';

type BlockSizeOrUncommon = number | 'uncommon-u16' | 'uncommon-u8';
type SampleRateOrUncommon =
	| number
	| 'uncommon-u8'
	| 'uncommon-u16'
	| 'uncommon-u16-10';

// https://www.rfc-editor.org/rfc/rfc9639.html#name-block-size-bits
export const getBlockSizeOrUncommon = (bits: number): BlockSizeOrUncommon | null => {
	if (bits === 0b0000) {
		return null;
	} else if (bits === 0b0001) {
		return 192;
	} else if (bits >= 0b0010 && bits <= 0b0101) {
		return 144 * 2 ** bits;
	} else if (bits === 0b0110) {
		return 'uncommon-u8';
	} else if (bits === 0b0111) {
		return 'uncommon-u16';
	} else if (bits >= 0b1000 && bits <= 0b1111) {
		return 2 ** bits;
	} else {
		return null;
	}
};

// https://www.rfc-editor.org/rfc/rfc9639.html#name-sample-rate-bits
export const getSampleRateOrUncommon = (
	sampleRateBits: number,
	streamInfoSampleRate: number,
): SampleRateOrUncommon | null => {
	switch (sampleRateBits) {
		case 0b0000: return streamInfoSampleRate;
		case 0b0001: return 88200;
		case 0b0010: return 176400;
		case 0b0011: return 192000;
		case 0b0100: return 8000;
		case 0b0101: return 16000;
		case 0b0110: return 22050;
		case 0b0111: return 24000;
		case 0b1000: return 32000;
		case 0b1001: return 44100;
		case 0b1010: return 48000;
		case 0b1011: return 96000;
		case 0b1100: return 'uncommon-u8';
		case 0b1101: return 'uncommon-u16';
		case 0b1110: return 'uncommon-u16-10';
		default: return null;
	}
};

// https://www.rfc-editor.org/rfc/rfc9639.html#name-coded-number
export const readCodedNumber = (fileSlice: FileSlice): number => {
	let ones = 0;

	const bitstream1 = new Bitstream(readBytes(fileSlice, 1));
	while (bitstream1.readBits(1) === 1) {
		ones++;
	}

	if (ones === 0) {
		return bitstream1.readBits(7);
	}

	const bitArray: number[] = [];
	const extraBytes = ones - 1;
	const bitstream2 = new Bitstream(readBytes(fileSlice, extraBytes));

	const firstByteBits = 8 - ones - 1;
	for (let i = 0; i < firstByteBits; i++) {
		bitArray.unshift(bitstream1.readBits(1));
	}

	for (let i = 0; i < extraBytes; i++) {
		for (let j = 0; j < 8; j++) {
			const val = bitstream2.readBits(1);
			if (j < 2) {
				continue;
			}

			bitArray.unshift(val);
		}
	}

	const encoded = bitArray.reduce((acc, bit, index) => {
		return acc | (bit << index);
	}, 0);

	return encoded;
};

export const readBlockSize = (
	slice: FileSlice,
	blockSizeBits: BlockSizeOrUncommon,
) => {
	if (blockSizeBits === 'uncommon-u16') {
		return readU16Be(slice) + 1;
	} else if (blockSizeBits === 'uncommon-u8') {
		return readU8(slice) + 1;
	} else if (typeof blockSizeBits === 'number') {
		return blockSizeBits;
	} else {
		assertNever(blockSizeBits);
		assert(false);
	}
};

export const readSampleRate = (
	slice: FileSlice,
	sampleRateOrUncommon: SampleRateOrUncommon,
) => {
	if (sampleRateOrUncommon === 'uncommon-u16') {
		return readU16Be(slice);
	}

	if (sampleRateOrUncommon === 'uncommon-u16-10') {
		return readU16Be(slice) * 10;
	}

	if (sampleRateOrUncommon === 'uncommon-u8') {
		return readU8(slice);
	}

	if (typeof sampleRateOrUncommon === 'number') {
		return sampleRateOrUncommon;
	}

	return null;
};

// https://www.rfc-editor.org/rfc/rfc9639.html#section-9.1.1
export const calculateCrc8 = (data: Uint8Array) => {
	const polynomial = 0x07; // x^8 + x^2 + x^1 + x^0
	let crc = 0x00; // Initialize CRC to 0

	for (const byte of data) {
		crc ^= byte; // XOR byte into least significant byte of crc

		for (let i = 0; i < 8; i++) {
			// For each bit in the byte
			if ((crc & 0x80) !== 0) {
				// If the leftmost bit (MSB) is set
				crc = (crc << 1) ^ polynomial; // Shift left and XOR with polynomial
			} else {
				crc <<= 1; // Just shift left
			}

			crc &= 0xff; // Ensure CRC remains 8-bit
		}
	}

	return crc;
};
