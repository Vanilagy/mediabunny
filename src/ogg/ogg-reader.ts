/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FileSlice, readI64Le, readU32Le, readU8 } from '../reader';
import { OGGS } from './ogg-misc';

export const MIN_PAGE_HEADER_SIZE = 27;
export const MAX_PAGE_HEADER_SIZE = 27 + 255;
export const MAX_PAGE_SIZE = MAX_PAGE_HEADER_SIZE + 255 * 255;

export type Page = {
	headerStartPos: number;
	totalSize: number;
	dataStartPos: number;
	dataSize: number;
	headerType: number;
	granulePosition: number;
	serialNumber: number;
	sequenceNumber: number;
	checksum: number;
	lacingValues: Uint8Array;
};

export const readPageHeader = (slice: FileSlice): Page | null => {
	const startPos = slice.filePos;

	const capturePattern = readU32Le(slice);
	if (capturePattern !== OGGS) {
		return null;
	}

	slice.skip(1); // Version
	const headerType = readU8(slice);
	const granulePosition = readI64Le(slice);
	const serialNumber = readU32Le(slice);
	const sequenceNumber = readU32Le(slice);
	const checksum = readU32Le(slice);

	const numberPageSegments = readU8(slice);
	const lacingValues = new Uint8Array(numberPageSegments);

	for (let i = 0; i < numberPageSegments; i++) {
		lacingValues[i] = readU8(slice);
	}

	const headerSize = 27 + numberPageSegments;
	const dataSize = lacingValues.reduce((a, b) => a + b, 0);
	const totalSize = headerSize + dataSize;

	return {
		headerStartPos: startPos,
		totalSize,
		dataStartPos: startPos + headerSize,
		dataSize,
		headerType,
		granulePosition,
		serialNumber,
		sequenceNumber,
		checksum,
		lacingValues,
	};
};

export const findNextPageHeader = (slice: FileSlice, until: number) => {
	while (slice.filePos < until - (4 - 1)) { // Size of word minus 1
		const word = readU32Le(slice);
		const firstByte = word & 0xff;
		const secondByte = (word >>> 8) & 0xff;
		const thirdByte = (word >>> 16) & 0xff;
		const fourthByte = (word >>> 24) & 0xff;

		const O = 0x4f; // 'O'
		if (firstByte !== O && secondByte !== O && thirdByte !== O && fourthByte !== O) {
			continue;
		}

		slice.skip(-4);

		if (word === OGGS) {
			// We have found the capture pattern
			return true;
		}

		slice.skip(1);
	}

	return false;
};
