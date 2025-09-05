/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, Bitstream } from '../misc';
import { FileSlice, readBytes, Reader, readU8 } from '../reader';
import {
	calculateCRC8,
	getBlockSize,
	getBlockSizeOrUncommon,
	getFlacCodedNumber,
	getSampleRate,
	getSampleRateOrUncommon,
} from './flac-misc';

const readFlacFrameHeader = ({
	slice,
	blockingBit,
	firstPacket,
	setBlockingBit,
	streamInfoSampleRate,
}: {
	slice: FileSlice;
	blockingBit: number | undefined;
	firstPacket: boolean;
	setBlockingBit: (blockingBit: number) => void;
	streamInfoSampleRate: number;
}) => {
	const startOffset = slice.filePos;

	// https://www.rfc-editor.org/rfc/rfc9639.html#section-9.1
	// Each frame MUST start on a byte boundary and start with the 15-bit frame
	// sync code 0b111111111111100. Following the sync code is the blocking strategy
	// bit, which MUST NOT change during the audio stream.
	const bytes = readBytes(slice, 4);
	const bitStream = new Bitstream(bytes);

	const bits = bitStream.readBits(15);
	if (bits !== 0b111111111111100) {
		throw new Error('Invalid sync code');
	}

	if (blockingBit === undefined) {
		assert(firstPacket);
		const newBlockingBit = bitStream.readBits(1);
		setBlockingBit(newBlockingBit);
	} else if (blockingBit === 1) {
		assert(!firstPacket);
		const newBlockingBit = bitStream.readBits(1);
		assert(newBlockingBit === 1);
	} else if (blockingBit === 0) {
		assert(!firstPacket);
		const newBlockingBit = bitStream.readBits(1);
		assert(newBlockingBit === 0);
	} else {
		throw new Error('Invalid blocking bit');
	}

	const blockSizeOrUncommon = getBlockSizeOrUncommon(bitStream.readBits(4));
	const sampleRateOrUncommon = getSampleRateOrUncommon(
		bitStream.readBits(4),
		streamInfoSampleRate,
	);
	bitStream.skipBits(4); // channel count
	bitStream.skipBits(3); // bit depth
	const reservedZero = bitStream.readBits(1); // reserved zero
	assert(reservedZero === 0);

	const num = getFlacCodedNumber(slice);
	const blockSize = getBlockSize(slice, blockSizeOrUncommon);
	const sampleRate = getSampleRate(slice, sampleRateOrUncommon);
	const size = slice.filePos - startOffset;
	const crc = readU8(slice);

	slice.bufferPos -= size;
	slice.bufferPos -= 1;
	const crcCalculated = calculateCRC8(readBytes(slice, size));

	if (crc !== crcCalculated) {
		// Maybe this wasn't a FLAC frame at all, the syncword was just coincidentally
		// in the bitstream
		return null;
	}

	return { num, blockSize, sampleRate, size: blockSize };
};

type NextFlacFrameResult = {
	num: number;
	blockSize: number;
	sampleRate: number;
	size: number;
	isLastFrame: boolean;
};

export const readNextFlacFrame = async ({
	reader,
	startPos,
	until,
	firstPacket,
	blockingBit,
	setBlockingBit,
	streamInfoSampleRate,
}: {
	reader: Reader;
	startPos: number;
	until: number;
	firstPacket: boolean;
	blockingBit: number | undefined;
	setBlockingBit: (blockingBit: number) => void;
	streamInfoSampleRate: number;
}): Promise<NextFlacFrameResult | null> => {
	// Also need to validate the next header, which in the worst case may be up to 16 bytes
	const desiredEnd = until + 16 - startPos;
	const slice = await reader.requestSliceRange(startPos, 1, desiredEnd);

	if (!slice) {
		return null;
	}

	const a = readFlacFrameHeader({
		slice,
		blockingBit,
		firstPacket,
		setBlockingBit,
		streamInfoSampleRate,
	});

	if (!a) {
		return null;
	}

	while (true) {
		if (slice.filePos >= slice.end) {
			return {
				num: a.num,
				blockSize: a.blockSize,
				sampleRate: a.sampleRate,
				size: slice.end - startPos,
				isLastFrame: true,
			};
		}

		const nextBits = readU8(slice);
		if (nextBits === 0xff) {
			const nextBits = readU8(slice);

			const expected = blockingBit === 1 ? 0b1111_1001 : 0b1111_1000;
			if (nextBits !== expected) {
				slice.bufferPos -= 1;
				continue;
			}

			slice.bufferPos -= 2;
			const lengthIfNextFlacFrameHeaderIsLegit = slice.filePos - startPos;

			const nextIsLegit = readFlacFrameHeader({
				slice,
				blockingBit,
				firstPacket,
				setBlockingBit,
				streamInfoSampleRate,
			});

			if (!nextIsLegit) {
				slice.bufferPos -= 1;
				continue;
			}

			return {
				num: a.num,
				blockSize: a.blockSize,
				sampleRate: a.sampleRate,
				size: lengthIfNextFlacFrameHeaderIsLegit,
				isLastFrame: false,
			};
		}
	}
};
