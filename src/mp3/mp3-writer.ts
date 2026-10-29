/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Writer } from '../writer';
import {
	computeMp3FrameSize,
	getXingOffset,
	INFO,
	KILOBIT_RATES,
	MP3_DECODER_DELAY,
	XING,
	XingFlags,
} from '../../shared/mp3-misc';

export type XingFrameData = {
	mpegVersionId: number;
	layer: number;
	frequencyIndex: number;
	sampleRate: number;
	channel: number;
	modeExtension: number;
	copyright: number;
	original: number;
	emphasis: number;

	isCbr: boolean;
	frameCount: number | null;
	fileSize: number | null;
	toc: Uint8Array | null;
	encoderDelay: number | null;
};

export class Mp3Writer {
	private helper = new Uint8Array(8);
	private helperView = new DataView(this.helper.buffer);
	private crc = 0;

	constructor(private writer: Writer) {}

	private writeWithCrc(bytes: Uint8Array) {
		for (const byte of bytes) {
			this.crc ^= byte;
			for (let bit = 0; bit < 8; bit++) {
				this.crc = (this.crc >>> 1) ^ ((this.crc & 1) ? 0xa001 : 0);
			}
		}
		this.writer.write(bytes);
	}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writeWithCrc(this.helper.subarray(0, 4));
	}

	writeXingFrame(data: XingFrameData) {
		const startPos = this.writer.getPos();
		this.crc = 0;

		const firstByte = 0xff;
		const secondByte = 0xe0 | (data.mpegVersionId << 3) | (data.layer << 1);

		let lowSamplingFrequency: number;
		if (data.mpegVersionId & 2) {
			lowSamplingFrequency = (data.mpegVersionId & 1) ? 0 : 1;
		} else {
			lowSamplingFrequency = 1;
		}

		const padding = 0;
		const xingOffset = getXingOffset(data.mpegVersionId, data.channel);
		const neededBytes = data.encoderDelay === null ? 155 : xingOffset + 8 + 4 + 4 + 100 + 36;

		let bitrateIndex = -1;
		const bitrateOffset = lowSamplingFrequency * 16 * 4 + data.layer * 16;

		// Let's find the lowest bitrate for which the frame size is sufficiently large to fit all the data
		for (let i = 0; i < 16; i++) {
			const kbr = KILOBIT_RATES[bitrateOffset + i]!;
			const size = computeMp3FrameSize(lowSamplingFrequency, data.layer, 1000 * kbr, data.sampleRate, padding);

			if (size >= neededBytes) {
				bitrateIndex = i;
				break;
			}
		}

		if (bitrateIndex === -1) {
			throw new Error('No suitable bitrate found.');
		}

		const thirdByte = (bitrateIndex << 4) | (data.frequencyIndex << 2) | padding << 1;
		const fourthByte = (data.channel << 6)
			| (data.modeExtension << 4)
			| (data.copyright << 3)
			| (data.original << 2)
			| data.emphasis;

		this.helper[0] = firstByte;
		this.helper[1] = secondByte;
		this.helper[2] = thirdByte;
		this.helper[3] = fourthByte;
		this.writeWithCrc(this.helper.subarray(0, 4));
		this.writeWithCrc(new Uint8Array(xingOffset - 4));
		this.writeU32(data.isCbr ? INFO : XING); // Following LAME's convention

		let flags = 0;
		if (data.frameCount !== null) {
			flags |= XingFlags.FrameCount;
		}
		if (data.fileSize !== null) {
			flags |= XingFlags.FileSize;
		}
		if (data.toc !== null) {
			flags |= XingFlags.Toc;
		}

		this.writeU32(flags);
		this.writeU32(data.frameCount ?? 0);
		this.writeU32(data.fileSize ?? 0);
		this.writeWithCrc(data.toc ?? new Uint8Array(100));

		if (data.encoderDelay !== null) {
			const lame = new Uint8Array(36);
			lame.set([0x4c, 0x41, 0x4d, 0x45]); // 'LAME'
			lame[21] = data.encoderDelay >> 4;
			// Readers subtract the decoder delay from the padding field, so this means no end trim.
			lame[22] = ((data.encoderDelay & 0xf) << 4) | (MP3_DECODER_DELAY >> 8);
			lame[23] = MP3_DECODER_DELAY & 0xff;
			this.writeWithCrc(lame.subarray(0, 34));
			new DataView(lame.buffer).setUint16(34, this.crc);
			this.writer.write(lame.subarray(34));
		}

		const kilobitRate = KILOBIT_RATES[bitrateOffset + bitrateIndex]!;
		const frameSize = computeMp3FrameSize(
			lowSamplingFrequency, data.layer, 1000 * kilobitRate, data.sampleRate, padding,
		);

		// Pad the frame out to its full size
		this.writer.write(new Uint8Array(startPos + frameSize - this.writer.getPos()));
	}
}
