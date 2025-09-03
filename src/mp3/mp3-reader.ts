/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FRAME_HEADER_SIZE, FrameHeader, readFrameHeader } from '../../shared/mp3-misc';
import { FileSlice, readAscii, Reader, readU32Be } from '../reader';

export const readId3 = (slice: FileSlice) => {
	const tag = readAscii(slice, 3);
	if (tag !== 'ID3') {
		slice.skip(-3);
		return null;
	}

	slice.skip(3);

	const size = decodeSynchsafe(readU32Be(slice));
	return { size };
};

export const readNextFrameHeader = async (reader: Reader, startPos: number, until: number | null): Promise<{
	header: FrameHeader;
	startPos: number;
} | null> => {
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		let slice = reader.requestSlice(currentPos, FRAME_HEADER_SIZE);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) break;

		const word = readU32Be(slice);

		const result = readFrameHeader(word, reader.fileSize !== null ? reader.fileSize - currentPos : null);
		if (result.header) {
			return { header: result.header, startPos: currentPos };
		}

		currentPos += result.bytesAdvanced;
	}

	return null;
};

export const decodeSynchsafe = (synchsafed: number) => {
	let mask = 0x7f000000;
	let unsynchsafed = 0;

	while (mask !== 0) {
		unsynchsafed >>= 1;
		unsynchsafed |= synchsafed & mask;
		mask >>= 8;
	}

	return unsynchsafed;
};
