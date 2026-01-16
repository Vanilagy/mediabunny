/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Writer } from '../writer';

export class RiffWriter {
	private helper = new Uint8Array(8);
	private helperView = new DataView(this.helper.buffer);

	constructor(private writer: Writer) {}

	writeU16(value: number) {
		this.helperView.setUint16(0, value, true);
		this.writer.write(this.helper.subarray(0, 2));
	}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, true);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeU64(value: number) {
		this.helperView.setUint32(0, value, true);
		this.helperView.setUint32(4, Math.floor(value / 2 ** 32), true);
		this.writer.write(this.helper);
	}

	writeAscii(text: string) {
		this.writer.write(new TextEncoder().encode(text));
	}
}
