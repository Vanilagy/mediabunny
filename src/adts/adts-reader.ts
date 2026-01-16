/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Bitstream } from '../misc';
import { FileSlice, readBytes } from '../reader';

export const MIN_ADTS_FRAME_HEADER_SIZE = 7;
export const MAX_ADTS_FRAME_HEADER_SIZE = 9;

export type AdtsFrameHeader = {
	objectType: number;
	samplingFrequencyIndex: number;
	channelConfiguration: number;
	frameLength: number;
	numberOfAacFrames: number;
	crcCheck: number | null;
	startPos: number;
};

export const readAdtsFrameHeader = (slice: FileSlice): AdtsFrameHeader | null => {
	// https://wiki.multimedia.cx/index.php/ADTS (last visited: 2025/08/17)

	const startPos = slice.filePos;

	const bytes = readBytes(slice, 9); // 9 with CRC, 7 without CRC
	const bitstream = new Bitstream(bytes);

	const syncword = bitstream.readBits(12);
	if (syncword !== 0b1111_11111111) {
		return null;
	}

	bitstream.skipBits(1); // MPEG version
	const layer = bitstream.readBits(2);
	if (layer !== 0) {
		return null;
	}

	const protectionAbsence = bitstream.readBits(1);
	const objectType = bitstream.readBits(2) + 1;
	const samplingFrequencyIndex = bitstream.readBits(4);
	if (samplingFrequencyIndex === 15) {
		return null;
	}

	bitstream.skipBits(1); // Private bit
	const channelConfiguration = bitstream.readBits(3);
	if (channelConfiguration === 0) {
		throw new Error('ADTS frames with channel configuration 0 are not supported.');
	}

	bitstream.skipBits(1); // Originality
	bitstream.skipBits(1); // Home
	bitstream.skipBits(1); // Copyright ID bit
	bitstream.skipBits(1); // Copyright ID start
	const frameLength = bitstream.readBits(13);
	bitstream.skipBits(11); // Buffer fullness
	const numberOfAacFrames = bitstream.readBits(2) + 1;
	if (numberOfAacFrames !== 1) {
		throw new Error('ADTS frames with more than one AAC frame are not supported.');
	}

	let crcCheck: number | null = null;

	if (protectionAbsence === 1) { // No CRC
		slice.filePos -= 2;
	} else { // CRC
		crcCheck = bitstream.readBits(16);
	}

	return {
		objectType,
		samplingFrequencyIndex,
		channelConfiguration,
		frameLength,
		numberOfAacFrames,
		crcCheck,
		startPos,
	};
};
