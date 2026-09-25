/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Writer } from '../writer';

/**
 * Writer for AIFF's big-endian IFF chunks. AIFF is the big-endian counterpart to RIFF, so this mirrors
 * {@link RiffWriter} but writes in big-endian byte order.
 */
export class AiffWriter {
	private helper = new Uint8Array(10);
	private helperView = new DataView(this.helper.buffer);

	constructor(private writer: Writer) {}

	writeU16(value: number) {
		this.helperView.setUint16(0, value, false);
		this.writer.write(this.helper.subarray(0, 2));
	}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeAscii(text: string) {
		this.writer.write(new TextEncoder().encode(text));
	}

	/**
	 * Writes a sample rate as an 80-bit IEEE 754 extended-precision float, the format AIFF uses for the sample rate in
	 * the COMM chunk. Exact for integer sample rates.
	 */
	writeExtendedFloat80(value: number) {
		this.helper.fill(0, 0, 10);

		if (value !== 0) {
			let sign = 0;
			if (value < 0) {
				sign = 0x8000;
				value = -value;
			}

			const exponent = Math.floor(Math.log2(value));
			const shift = 63 - exponent;

			// The 64-bit mantissa carries an explicit integer bit, so mantissa = value * 2^(63 - exponent). For integer
			// sample rates this is exact via a BigInt shift.
			const mantissa = (Number.isInteger(value) && shift >= 0)
				? BigInt(value) << BigInt(shift)
				: BigInt(Math.round(value * 2 ** shift));

			this.helperView.setUint16(0, sign | (exponent + 16383), false);
			this.helperView.setUint32(2, Number((mantissa >> 32n) & 0xffffffffn), false);
			this.helperView.setUint32(6, Number(mantissa & 0xffffffffn), false);
		}

		this.writer.write(this.helper.subarray(0, 10));
	}
}
