/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Bitstream } from '../../shared/bitstream';
import { aacFrequencyTable } from '../../shared/aac-misc';
import { isThenable } from '../misc';
import { FileSlice, readBytes, Reader, readU16Be, readU8 } from '../reader';

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

export const readConfirmedAdtsFrameHeader = async (
	reader: Reader,
	startPos: number,
	searchLength: number,
	ref: AdtsFrameHeader | null,
) => {
	const headersMatch = (a: AdtsFrameHeader, b: AdtsFrameHeader) => a.objectType === b.objectType
		&& a.samplingFrequencyIndex === b.samplingFrequencyIndex
		&& a.channelConfiguration === b.channelConfiguration;

	let slice = reader.requestSliceRange(
		startPos,
		MIN_ADTS_FRAME_HEADER_SIZE,
		searchLength + MAX_ADTS_FRAME_HEADER_SIZE,
	);
	if (isThenable(slice)) slice = await slice;
	if (!slice) {
		return null;
	}

	// A header is only confirmed by what follows it, since sync words show up in junk all the time
	for (let pos = startPos; pos < Math.min(startPos + searchLength, slice.end); pos++) {
		slice.filePos = pos;
		if (readU8(slice) !== 0xff) {
			continue;
		}

		slice.filePos = pos;
		const header = readAdtsFrameHeader(slice);
		if (!header || (ref && !headersMatch(header, ref))) {
			continue;
		}

		const frameEndPos = pos + header.frameLength;
		if (frameEndPos === reader.fileSize) {
			// The frame ends the file
			return header;
		}

		let nextSlice = reader.requestSliceRange(frameEndPos, MIN_ADTS_FRAME_HEADER_SIZE, MAX_ADTS_FRAME_HEADER_SIZE);
		if (isThenable(nextSlice)) nextSlice = await nextSlice;

		const nextHeader = nextSlice && readAdtsFrameHeader(nextSlice);
		if (nextHeader && headersMatch(header, nextHeader)) {
			return header;
		}
	}

	return null;
};

export const readAdtsFrameHeader = (slice: FileSlice): AdtsFrameHeader | null => {
	// https://wiki.multimedia.cx/index.php/ADTS (last visited: 2025/08/17)

	const startPos = slice.filePos;

	if (slice.remainingLength < MIN_ADTS_FRAME_HEADER_SIZE) {
		return null;
	}

	const bytes = readBytes(slice, MIN_ADTS_FRAME_HEADER_SIZE);
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
	if (samplingFrequencyIndex >= aacFrequencyTable.length) {
		return null;
	}

	bitstream.skipBits(1); // Private bit
	const channelConfiguration = bitstream.readBits(3);

	bitstream.skipBits(1); // Originality
	bitstream.skipBits(1); // Home
	bitstream.skipBits(1); // Copyright ID bit
	bitstream.skipBits(1); // Copyright ID start
	const frameLength = bitstream.readBits(13);
	bitstream.skipBits(11); // Buffer fullness
	const numberOfAacFrames = bitstream.readBits(2) + 1;
	if (numberOfAacFrames !== 1) {
		return null; // Not supported
	}

	let crcCheck: number | null = null;

	if (protectionAbsence === 0) { // CRC
		if (slice.remainingLength < 2) {
			return null;
		}

		crcCheck = readU16Be(slice);
	}

	if (frameLength < slice.filePos - startPos) {
		return null; // The frame must at least contain its own header
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
