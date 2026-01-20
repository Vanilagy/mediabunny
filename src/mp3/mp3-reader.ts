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
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		let slice = reader.requestSlice(currentPos, FRAME_HEADER_SIZE);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) break;

		const word = readU32Be(slice);

		const result = readMp3FrameHeader(word, reader.fileSize !== null ? reader.fileSize - currentPos : null);
		if (result.header) {
			return { header: result.header, startPos: currentPos };
		}

		currentPos += result.bytesAdvanced;
	}

	return null;
};
