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
	KILOBIT_RATES,
	XING,
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

	frameCount: number | null;
	fileSize: number | null;
	toc: Uint8Array | null;
};

export class Mp3Writer {
	private helper = new Uint8Array(8);
	private helperView = new DataView(this.helper.buffer);

	constructor(private writer: Writer) {}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeXingFrame(data: XingFrameData) {
		const startPos = this.writer.getPos();

		const firstByte = 0xff;
		const secondByte = 0xe0 | (data.mpegVersionId << 3) | (data.layer << 1);

		let lowSamplingFrequency: number;
		if (data.mpegVersionId & 2) {
			lowSamplingFrequency = (data.mpegVersionId & 1) ? 0 : 1;
		} else {
			lowSamplingFrequency = 1;
		}

		const padding = 0;
		const neededBytes = 155;

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

		this.writer.write(this.helper.subarray(0, 4));

		const xingOffset = getXingOffset(data.mpegVersionId, data.channel);

		this.writer.seek(startPos + xingOffset);
		this.writeU32(XING);

		let flags = 0;
		if (data.frameCount !== null) {
			flags |= 1;
		}
		if (data.fileSize !== null) {
			flags |= 2;
		}
		if (data.toc !== null) {
			flags |= 4;
		}

		this.writeU32(flags);

		this.writeU32(data.frameCount ?? 0);
		this.writeU32(data.fileSize ?? 0);
		this.writer.write(data.toc ?? new Uint8Array(100));

		const kilobitRate = KILOBIT_RATES[bitrateOffset + bitrateIndex]!;
		const frameSize = computeMp3FrameSize(
			lowSamplingFrequency, data.layer, 1000 * kilobitRate, data.sampleRate, padding,
		);
		this.writer.seek(startPos + frameSize);
	}
}
