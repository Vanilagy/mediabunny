/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isIso88591Compatible, textEncoder } from '../misc';
import { Writer } from '../writer';
import {
	computeMp3FrameSize,
	encodeSynchsafe,
	getXingOffset,
	KILOBIT_RATES,
	XING,
} from '../../shared/mp3-misc';
import { Id3V2TextEncoding } from '../id3';

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

	writeU8(value: number) {
		this.helper[0] = value;
		this.writer.write(this.helper.subarray(0, 1));
	}

	writeU16(value: number) {
		this.helperView.setUint16(0, value, false);
		this.writer.write(this.helper.subarray(0, 2));
	}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeAscii(text: string) {
		for (let i = 0; i < text.length; i++) {
			this.helper[i] = text.charCodeAt(i);
		}
		this.writer.write(this.helper.subarray(0, text.length));
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

	writeSynchsafeU32(value: number) {
		this.writeU32(encodeSynchsafe(value));
	}

	writeIsoString(text: string) {
		const bytes = new Uint8Array(text.length + 1);
		for (let i = 0; i < text.length; i++) {
			bytes[i] = text.charCodeAt(i);
		}
		bytes[text.length] = 0x00;
		this.writer.write(bytes);
	}

	writeUtf8String(text: string) {
		const utf8Data = textEncoder.encode(text);
		this.writer.write(utf8Data);
		this.writeU8(0x00);
	}

	writeId3V2TextFrame(frameId: string, text: string) {
		const useIso88591 = isIso88591Compatible(text);
		const textDataLength = useIso88591 ? text.length : textEncoder.encode(text).byteLength;
		const frameSize = 1 + textDataLength + 1;

		this.writeAscii(frameId);
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);
		if (useIso88591) {
			this.writeIsoString(text);
		} else {
			this.writeUtf8String(text);
		}
	}

	writeId3V2LyricsFrame(lyrics: string) {
		const useIso88591 = isIso88591Compatible(lyrics);
		const shortDescription = '';
		const frameSize = 1 + 3 + shortDescription.length + 1 + lyrics.length + 1;

		this.writeAscii('USLT');
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);
		this.writeAscii('und');

		if (useIso88591) {
			this.writeIsoString(shortDescription);
			this.writeIsoString(lyrics);
		} else {
			this.writeUtf8String(shortDescription);
			this.writeUtf8String(lyrics);
		}
	}

	writeId3V2CommentFrame(comment: string) {
		const useIso88591 = isIso88591Compatible(comment);
		const textDataLength = useIso88591 ? comment.length : textEncoder.encode(comment).byteLength;
		const shortDescription = '';
		const frameSize = 1 + 3 + shortDescription.length + 1 + textDataLength + 1;

		this.writeAscii('COMM');
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);
		this.writeU8(0x75); // 'u'
		this.writeU8(0x6E); // 'n'
		this.writeU8(0x64); // 'd'

		if (useIso88591) {
			this.writeIsoString(shortDescription);
			this.writeIsoString(comment);
		} else {
			this.writeUtf8String(shortDescription);
			this.writeUtf8String(comment);
		}
	}

	writeId3V2ApicFrame(mimeType: string, pictureType: number, description: string, imageData: Uint8Array) {
		const useIso88591 = isIso88591Compatible(mimeType) && isIso88591Compatible(description);
		const descriptionDataLength = useIso88591 ? description.length : textEncoder.encode(description).byteLength;
		const frameSize = 1 + mimeType.length + 1 + 1 + descriptionDataLength + 1 + imageData.byteLength;

		this.writeAscii('APIC');
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);

		if (useIso88591) {
			this.writeIsoString(mimeType);
		} else {
			this.writeUtf8String(mimeType);
		}

		this.writeU8(pictureType);

		if (useIso88591) {
			this.writeIsoString(description);
		} else {
			this.writeUtf8String(description);
		}

		this.writer.write(imageData);
	}
}
