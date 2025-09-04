import { assert } from 'console';
import { Bitstream } from '../misc';
import { readBytes, Reader, readU8 } from '../reader';
import {
	calculateCRC8,
	getBlockSize,
	getBlockSizeOrUncommon,
	getFlacCodedNumber,
	getSampleRate,
	getSampleRateOrUncommon,
} from './flac-misc';

export const readNextFlacFrame = async (
	reader: Reader,
	startPos: number,
	until: number,
	firstPacket: boolean,
	blockingBit: number | undefined,
	setBlockingBit: (blockingBit: number) => void,
	streamInfoSampleRate: number,
) => {
	let slice = reader.requestSlice(startPos, until);
	if (slice instanceof Promise) slice = await slice;

	if (!slice) {
		throw new Error('Data didn\'t fit into the rest of the file');
	}

	const startOffset = slice.filePos;

	// https://www.rfc-editor.org/rfc/rfc9639.html#section-9.1
	// Each frame MUST start on a byte boundary and start with the 15-bit frame
	// sync code 0b111111111111100. Following the sync code is the blocking strategy
	// bit, which MUST NOT change during the audio stream.
	const bytes = readBytes(slice, 4);
	const bitStream = new Bitstream(bytes);

	if (blockingBit === undefined) {
		assert(firstPacket);
		const bits = bitStream.readBits(15);
		if (bits !== 0b111111111111100) {
			throw new Error('Invalid sync code');
		}
		const newBlockingBit = bitStream.readBits(1);
		setBlockingBit(newBlockingBit);
	} else if (blockingBit === 1) {
		assert(!firstPacket);
		const bits = bitStream.readBits(16);
		if (bits !== 0b111111111111101) {
			throw new Error('Invalid sync code');
		}
		const newBlockingBit = bitStream.readBits(1);
		assert(newBlockingBit === 1);
	} else if (blockingBit === 0) {
		assert(!firstPacket);
		const bits = bitStream.readBits(16);
		if (bits !== 0b111111111111100) {
			throw new Error('Invalid sync code');
		}
		const newBlockingBit = bitStream.readBits(1);
		assert(newBlockingBit === 0);
	} else {
		throw new Error('Invalid blocking bit');
	}

	const blockSizeOrUncommon = getBlockSizeOrUncommon(bitStream.readBits(4));
	const sampleRateOrUncommon = getSampleRateOrUncommon(bitStream.readBits(4), streamInfoSampleRate);
	bitStream.skipBits(4); // channel count
	bitStream.skipBits(3); // bit depth
	const reservedZero = bitStream.readBits(1); // reserved zero
	assert(reservedZero === 0);

	const flacCodedNumber = getFlacCodedNumber(slice);
	const blockSize = getBlockSize(slice, blockSizeOrUncommon);
	const sampleRate = getSampleRate(slice, sampleRateOrUncommon);
	const size = slice.filePos - startOffset;
	const crc = readU8(slice);

	slice.bufferPos -= size;
	slice.bufferPos -= 1;
	const crcCalculated = calculateCRC8(readBytes(slice, size));

	if (crc !== crcCalculated) {
		throw new Error('Invalid CRC');
	}

	return { num: flacCodedNumber, blockSize, sampleRate };
};
