/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Writer } from '../writer';
import { textEncoder } from '../misc';

export class RIFFWriter {
	private writer: Writer;
	private isRIFX = false; // Big-endian variant

	constructor(writer: Writer, isRIFX = false) {
		this.writer = writer;
		this.isRIFX = isRIFX;
	}

	writeString(str: string): void {
		this.writer.write(textEncoder.encode(str));
	}

	writeFourCC(fourcc: string): void {
		const buffer = new Uint8Array(4);
		for (let i = 0; i < 4 && i < fourcc.length; i++) {
			buffer[i] = fourcc.charCodeAt(i);
		}
		this.writer.write(buffer);
	}

	writeUint32(value: number): void {
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		view.setUint32(0, value, !this.isRIFX);
		this.writer.write(new Uint8Array(buffer));
	}

	writeUint16(value: number): void {
		const buffer = new ArrayBuffer(2);
		const view = new DataView(buffer);
		view.setUint16(0, value, !this.isRIFX);
		this.writer.write(new Uint8Array(buffer));
	}

	writeInt32(value: number): void {
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		view.setInt32(0, value, !this.isRIFX);
		this.writer.write(new Uint8Array(buffer));
	}

	writeInt16(value: number): void {
		const buffer = new ArrayBuffer(2);
		const view = new DataView(buffer);
		view.setInt16(0, value, !this.isRIFX);
		this.writer.write(new Uint8Array(buffer));
	}

	writeBytes(data: Uint8Array): void {
		this.writer.write(data);
	}

	writePadding(): void {
		// RIFF chunks must be word-aligned
		if (this.writer.getPos() % 2 !== 0) {
			this.writer.write(new Uint8Array(1));
		}
	}

	startList(fourcc: string): number {
		this.writeFourCC('LIST');
		const sizePos = this.writer.getPos();
		this.writeUint32(0); // Size placeholder
		this.writeFourCC(fourcc);
		return sizePos;
	}

	endList(sizePos: number): void {
		const currentPos = this.writer.getPos();
		const size = currentPos - sizePos - 8;
		this.writer.seek(sizePos);
		this.writeUint32(size);
		this.writer.seek(currentPos);
	}

	startChunk(fourcc: string): number {
		this.writeFourCC(fourcc);
		const sizePos = this.writer.getPos();
		this.writeUint32(0); // Size placeholder
		return sizePos;
	}

	endChunk(sizePos: number): void {
		const currentPos = this.writer.getPos();
		const size = currentPos - sizePos - 4;
		this.writer.seek(sizePos);
		this.writeUint32(size);
		this.writer.seek(currentPos);
		this.writePadding();
	}
}
