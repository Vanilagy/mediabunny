/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export class Bitstream {
	/** Current offset in bits. */
	pos = 0;

	constructor(public bytes: Uint8Array) {}

	seekToByte(byteOffset: number) {
		this.pos = 8 * byteOffset;
	}

	private readBit() {
		const byteIndex = Math.floor(this.pos / 8);
		const byte = this.bytes[byteIndex] ?? 0;
		const bitIndex = 0b111 - (this.pos & 0b111);
		const bit = (byte & (1 << bitIndex)) >> bitIndex;

		this.pos++;
		return bit;
	}

	readBits(n: number) {
		if (n === 1) {
			return this.readBit();
		}

		let result = 0;

		for (let i = 0; i < n; i++) {
			result <<= 1;
			result |= this.readBit();
		}

		return result;
	}

	writeBits(n: number, value: number) {
		const end = this.pos + n;

		for (let i = this.pos; i < end; i++) {
			const byteIndex = Math.floor(i / 8);
			let byte = this.bytes[byteIndex]!;
			const bitIndex = 0b111 - (i & 0b111);

			byte &= ~(1 << bitIndex);
			byte |= ((value & (1 << (end - i - 1))) >> (end - i - 1)) << bitIndex;
			this.bytes[byteIndex] = byte;
		}

		this.pos = end;
	};

	readAlignedByte() {
		if (this.pos % 8 !== 0) {
			throw new Error('Bitstream is not byte-aligned.');
		}

		const byteIndex = this.pos / 8;
		const byte = this.bytes[byteIndex] ?? 0;

		this.pos += 8;
		return byte;
	}

	skipBits(n: number) {
		this.pos += n;
	}

	getBitsLeft() {
		return this.bytes.length * 8 - this.pos;
	}

	clone() {
		const clone = new Bitstream(this.bytes);
		clone.pos = this.pos;
		return clone;
	}
}
