/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { RichImageData } from '../metadata';
import { TextDecoder, textDecoder } from '../misc';
import { FileSlice, readAscii, readBytes, readI32Be, readU16Be, readU32Be, readU64Be, readU8 } from '../reader';

export const MIN_BOX_HEADER_SIZE = 8;
export const MAX_BOX_HEADER_SIZE = 16;

export const readBoxHeader = (slice: FileSlice) => {
	let totalSize = readU32Be(slice);
	const name = readAscii(slice, 4);
	let headerSize = 8;

	const hasLargeSize = totalSize === 1;
	if (hasLargeSize) {
		totalSize = readU64Be(slice);
		headerSize = 16;
	}

	const contentSize = totalSize - headerSize;
	if (contentSize < 0) {
		return null; // Hardly a box is it
	}

	return { name, totalSize, headerSize, contentSize };
};

export const readFixed_16_16 = (slice: FileSlice) => {
	return readI32Be(slice) / 0x10000;
};

export const readFixed_2_30 = (slice: FileSlice) => {
	return readI32Be(slice) / 0x40000000;
};

export const readIsomVariableInteger = (slice: FileSlice) => {
	let result = 0;

	for (let i = 0; i < 4; i++) {
		result <<= 7;
		const nextByte = readU8(slice);
		result |= nextByte & 0x7f;

		if ((nextByte & 0x80) === 0) {
			break;
		}
	}

	return result;
};

export const readEsDescriptor = (slice: FileSlice) => {
	const tag = readU8(slice);
	if (tag !== 0x03) {
		throw new Error('Invalid esds: expected ES_Descriptor.');
	}

	readIsomVariableInteger(slice); // Length

	slice.skip(2); // ES ID
	const mixed = readU8(slice);

	const streamDependenceFlag = (mixed & 0x80) !== 0;
	const urlFlag = (mixed & 0x40) !== 0;
	const ocrStreamFlag = (mixed & 0x20) !== 0;

	if (streamDependenceFlag) {
		slice.skip(2);
	}
	if (urlFlag) {
		const urlLength = readU8(slice);
		slice.skip(urlLength);
	}
	if (ocrStreamFlag) {
		slice.skip(2);
	}

	const decoderConfigTag = readU8(slice);
	if (decoderConfigTag !== 0x04) {
		throw new Error('Invalid esds: expected DecoderConfigDescriptor.');
	}

	const decoderConfigDescriptorLength = readIsomVariableInteger(slice); // Length

	const payloadStart = slice.filePos;

	const objectTypeIndication = readU8(slice);

	slice.skip(1 + 3 + 4 + 4);

	let decoderSpecificInfo: Uint8Array | null = null;
	if (decoderConfigDescriptorLength > slice.filePos - payloadStart) {
		// There's a DecoderSpecificInfo at the end, let's read it

		const decoderSpecificInfoTag = readU8(slice);
		if (decoderSpecificInfoTag !== 0x05) {
			throw new Error('Invalid esds: expected DecoderSpecificInfo.');
		}

		const decoderSpecificInfoLength = readIsomVariableInteger(slice);
		decoderSpecificInfo = readBytes(slice, decoderSpecificInfoLength);
	}

	return {
		objectTypeIndication,
		decoderSpecificInfo,
	};
};

export const readMetadataStringShort = (slice: FileSlice) => {
	let stringLength = readU16Be(slice);
	slice.skip(2); // Language

	stringLength = Math.min(stringLength, slice.remainingLength);
	return textDecoder.decode(readBytes(slice, stringLength));
};

export const readDataBox = (slice: FileSlice) => {
	const header = readBoxHeader(slice);
	if (!header || header.name !== 'data') {
		return null;
	}

	if (slice.remainingLength < 8) {
		// Box is too small
		return null;
	}

	const typeIndicator = readU32Be(slice);
	slice.skip(4); // Locale indicator
	const data = readBytes(slice, header.contentSize - 8);

	switch (typeIndicator) {
		case 1: return textDecoder.decode(data); // UTF-8
		case 2: return new TextDecoder('utf-16be').decode(data); // UTF-16-BE
		case 13: return new RichImageData(data, 'image/jpeg');
		case 14: return new RichImageData(data, 'image/png');
		case 27: return new RichImageData(data, 'image/bmp');

		default: return data;
	}
};
