/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FRAME_HEADER_SIZE, Mp3FrameHeader, readMp3FrameHeader } from '../../shared/mp3-misc';
import { Reader, readU32Be } from '../reader';

export const readNextMp3FrameHeader = async (reader: Reader, startPos: number, until: number | null): Promise<{
	header: Mp3FrameHeader;
	startPos: number;
} | null> => {
	const CHUNK_SIZE = 2 ** 16; // So we don't need to grab thousands of slices
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		const maxLength = until !== null
			? Math.min(CHUNK_SIZE, until - currentPos)
			: CHUNK_SIZE;

		let slice = reader.requestSliceRange(currentPos, FRAME_HEADER_SIZE, maxLength);
		if (slice instanceof Promise) slice = await slice;
		if (!slice || slice.length < FRAME_HEADER_SIZE) break;

		while (slice.remainingLength >= FRAME_HEADER_SIZE) {
			const posBeforeRead = slice.filePos;
			const word = readU32Be(slice);
			const remainingBytes = reader.fileSize !== null
				? reader.fileSize - currentPos
				: null;

			const result = readMp3FrameHeader(word, remainingBytes);
			if (result.header) {
				return { header: result.header, startPos: currentPos };
			}

			slice.filePos = posBeforeRead + result.bytesAdvanced;
			currentPos = slice.filePos;
		}
	}

	return null;
};
