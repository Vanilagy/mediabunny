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
	constructor(private writer: Writer) {}

	writeXingFrame(data: XingFrameData) {
		const firstByte = 0xff;
		const secondByte = 0xe1 | (data.mpegVersionId << 3) | (data.layer << 1); // No MPEG frame CRC

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

		const kilobitRate = KILOBIT_RATES[bitrateOffset + bitrateIndex]!;
		const frameSize = computeMp3FrameSize(
			lowSamplingFrequency, data.layer, 1000 * kilobitRate, data.sampleRate, padding,
		);
		const frame = new Uint8Array(frameSize);
		const view = new DataView(frame.buffer);
		frame.set([firstByte, secondByte, thirdByte, fourthByte]);
		view.setUint32(xingOffset, data.isCbr ? INFO : XING); // Following LAME's convention

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

		view.setUint32(xingOffset + 4, flags);
		view.setUint32(xingOffset + 8, data.frameCount ?? 0);
		view.setUint32(xingOffset + 12, data.fileSize ?? 0);
		if (data.toc !== null) {
			frame.set(data.toc, xingOffset + 16);
		}

		if (data.encoderDelay !== null) {
			// LAME-compatible tag. Only the start delay is known; end padding is not trimmed.
			const lameOffset = xingOffset + 116;
			frame.set([0x4c, 0x41, 0x4d, 0x45], lameOffset); // 'LAME'
			frame[lameOffset + 21] = data.encoderDelay >> 4;
			// Readers subtract the decoder delay from the padding field, so this means no end trim.
			frame[lameOffset + 22] = ((data.encoderDelay & 0xf) << 4) | (MP3_DECODER_DELAY >> 8);
			frame[lameOffset + 23] = MP3_DECODER_DELAY & 0xff;

			// CRC-16/ANSI covers the MPEG header through the LAME tag, excluding the CRC itself.
			let crc = 0;
			for (let i = 0; i < lameOffset + 34; i++) {
				crc ^= frame[i]!;
				for (let bit = 0; bit < 8; bit++) {
					crc = (crc >>> 1) ^ ((crc & 1) ? 0xa001 : 0);
				}
			}
			view.setUint16(lameOffset + 34, crc);
		}

		this.writer.write(frame);
	}
}
