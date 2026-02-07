/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MediaCodec } from '../codec';
import { assert, assertNever, textDecoder, textEncoder } from '../misc';
import { FileSlice, readBytes, Reader, readF32Be, readF64Be, readU8 } from '../reader';
import { Writer } from '../writer';

export interface EBMLElement {
	id: number;
	size?: number;
	data:
		| number
		| bigint
		| string
		| Uint8Array
		| EBMLFloat32
		| EBMLFloat64
		| EBMLSignedInt
		| EBMLUnicodeString
		| (EBML | null)[];
}

export type EBML = EBMLElement | Uint8Array | (EBML | null)[];

/** Wrapper around a number to be able to differentiate it in the writer. */
export class EBMLFloat32 {
	value: number;

	constructor(value: number) {
		this.value = value;
	}
}

/** Wrapper around a number to be able to differentiate it in the writer. */
export class EBMLFloat64 {
	value: number;

	constructor(value: number) {
		this.value = value;
	}
}

/** Wrapper around a number to be able to differentiate it in the writer. */
export class EBMLSignedInt {
	value: number;

	constructor(value: number) {
		this.value = value;
	}
}

export class EBMLUnicodeString {
	constructor(public value: string) {}
}

/** Defines some of the EBML IDs used by Matroska files. */
export enum EBMLId {
	EBML = 0x1a45dfa3,
	EBMLVersion = 0x4286,
	EBMLReadVersion = 0x42f7,
	EBMLMaxIDLength = 0x42f2,
	EBMLMaxSizeLength = 0x42f3,
	DocType = 0x4282,
	DocTypeVersion = 0x4287,
	DocTypeReadVersion = 0x4285,
	Void = 0xec,
	Segment = 0x18538067,
	SeekHead = 0x114d9b74,
	Seek = 0x4dbb,
	SeekID = 0x53ab,
	SeekPosition = 0x53ac,
	Duration = 0x4489,
	Info = 0x1549a966,
	TimestampScale = 0x2ad7b1,
	MuxingApp = 0x4d80,
	WritingApp = 0x5741,
	Tracks = 0x1654ae6b,
	TrackEntry = 0xae,
	TrackNumber = 0xd7,
	TrackUID = 0x73c5,
	TrackType = 0x83,
	FlagEnabled = 0xb9,
	FlagDefault = 0x88,
	FlagForced = 0x55aa,
	FlagOriginal = 0x55ae,
	FlagHearingImpaired = 0x55ab,
	FlagVisualImpaired = 0x55ac,
	FlagCommentary = 0x55af,
	FlagLacing = 0x9c,
	Name = 0x536e,
	Language = 0x22b59c,
	LanguageBCP47 = 0x22b59d,
	CodecID = 0x86,
	CodecPrivate = 0x63a2,
	CodecDelay = 0x56aa,
	SeekPreRoll = 0x56bb,
	DefaultDuration = 0x23e383,
	Video = 0xe0,
	PixelWidth = 0xb0,
	PixelHeight = 0xba,
	AlphaMode = 0x53c0,
	Audio = 0xe1,
	SamplingFrequency = 0xb5,
	Channels = 0x9f,
	BitDepth = 0x6264,
	SimpleBlock = 0xa3,
	BlockGroup = 0xa0,
	Block = 0xa1,
	BlockAdditions = 0x75a1,
	BlockMore = 0xa6,
	BlockAdditional = 0xa5,
	BlockAddID = 0xee,
	BlockDuration = 0x9b,
	ReferenceBlock = 0xfb,
	Cluster = 0x1f43b675,
	Timestamp = 0xe7,
	Cues = 0x1c53bb6b,
	CuePoint = 0xbb,
	CueTime = 0xb3,
	CueTrackPositions = 0xb7,
	CueTrack = 0xf7,
	CueClusterPosition = 0xf1,
	Colour = 0x55b0,
	MatrixCoefficients = 0x55b1,
	TransferCharacteristics = 0x55ba,
	Primaries = 0x55bb,
	Range = 0x55b9,
	Projection = 0x7670,
	ProjectionType = 0x7671,
	ProjectionPoseRoll = 0x7675,
	Attachments = 0x1941a469,
	AttachedFile = 0x61a7,
	FileDescription = 0x467e,
	FileName = 0x466e,
	FileMediaType = 0x4660,
	FileData = 0x465c,
	FileUID = 0x46ae,
	Chapters = 0x1043a770,
	Tags = 0x1254c367,
	Tag = 0x7373,
	Targets = 0x63c0,
	TargetTypeValue = 0x68ca,
	TargetType = 0x63ca,
	TagTrackUID = 0x63c5,
	TagEditionUID = 0x63c9,
	TagChapterUID = 0x63c4,
	TagAttachmentUID = 0x63c6,
	SimpleTag = 0x67c8,
	TagName = 0x45a3,
	TagLanguage = 0x447a,
	TagString = 0x4487,
	TagBinary = 0x4485,
	ContentEncodings = 0x6d80,
	ContentEncoding = 0x6240,
	ContentEncodingOrder = 0x5031,
	ContentEncodingScope = 0x5032,
	ContentCompression = 0x5034,
	ContentCompAlgo = 0x4254,
	ContentCompSettings = 0x4255,
	ContentEncryption = 0x5035,
}

export const LEVEL_0_EBML_IDS: EBMLId[] = [
	EBMLId.EBML,
	EBMLId.Segment,
];

// All the stuff that can appear in a segment, basically
export const LEVEL_1_EBML_IDS: EBMLId[] = [
	EBMLId.SeekHead,
	EBMLId.Info,
	EBMLId.Cluster,
	EBMLId.Tracks,
	EBMLId.Cues,
	EBMLId.Attachments,
	EBMLId.Chapters,
	EBMLId.Tags,
];

export const LEVEL_0_AND_1_EBML_IDS = [
	...LEVEL_0_EBML_IDS,
	...LEVEL_1_EBML_IDS,
];

export const measureUnsignedInt = (value: number) => {
	if (value < (1 << 8)) {
		return 1;
	} else if (value < (1 << 16)) {
		return 2;
	} else if (value < (1 << 24)) {
		return 3;
	} else if (value < 2 ** 32) {
		return 4;
	} else if (value < 2 ** 40) {
		return 5;
	} else {
		return 6;
	}
};

export const measureUnsignedBigInt = (value: bigint) => {
	if (value < (1n << 8n)) {
		return 1;
	} else if (value < (1n << 16n)) {
		return 2;
	} else if (value < (1n << 24n)) {
		return 3;
	} else if (value < (1n << 32n)) {
		return 4;
	} else if (value < (1n << 40n)) {
		return 5;
	} else if (value < (1n << 48n)) {
		return 6;
	} else if (value < (1n << 56n)) {
		return 7;
	} else {
		return 8;
	}
};

export const measureSignedInt = (value: number) => {
	if (value >= -(1 << 6) && value < (1 << 6)) {
		return 1;
	} else if (value >= -(1 << 13) && value < (1 << 13)) {
		return 2;
	} else if (value >= -(1 << 20) && value < (1 << 20)) {
		return 3;
	} else if (value >= -(1 << 27) && value < (1 << 27)) {
		return 4;
	} else if (value >= -(2 ** 34) && value < 2 ** 34) {
		return 5;
	} else {
		return 6;
	}
};

export const measureVarInt = (value: number) => {
	if (value < (1 << 7) - 1) {
		/** Top bit is set, leaving 7 bits to hold the integer, but we can't store
		 * 127 because "all bits set to one" is a reserved value. Same thing for the
		 * other cases below:
		 */
		return 1;
	} else if (value < (1 << 14) - 1) {
		return 2;
	} else if (value < (1 << 21) - 1) {
		return 3;
	} else if (value < (1 << 28) - 1) {
		return 4;
	} else if (value < 2 ** 35 - 1) {
		return 5;
	} else if (value < 2 ** 42 - 1) {
		return 6;
	} else {
		throw new Error('EBML varint size not supported ' + value);
	}
};

export class EBMLWriter {
	helper = new Uint8Array(8);
	helperView = new DataView(this.helper.buffer);

	/**
	 * Stores the position from the start of the file to where EBML elements have been written. This is used to
	 * rewrite/edit elements that were already added before, and to measure sizes of things.
	 */
	offsets = new WeakMap<EBML, number>();
	/** Same as offsets, but stores position where the element's data starts (after ID and size fields). */
	dataOffsets = new WeakMap<EBML, number>();

	constructor(private writer: Writer) {}

	writeByte(value: number) {
		this.helperView.setUint8(0, value);
		this.writer.write(this.helper.subarray(0, 1));
	}

	writeFloat32(value: number) {
		this.helperView.setFloat32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeFloat64(value: number) {
		this.helperView.setFloat64(0, value, false);
		this.writer.write(this.helper);
	}

	writeUnsignedInt(value: number, width = measureUnsignedInt(value)) {
		let pos = 0;

		// Each case falls through:
		switch (width) {
			case 6:
				// Need to use division to access >32 bits of floating point var
				this.helperView.setUint8(pos++, (value / 2 ** 40) | 0);
			// eslint-disable-next-line no-fallthrough
			case 5:
				this.helperView.setUint8(pos++, (value / 2 ** 32) | 0);
			// eslint-disable-next-line no-fallthrough
			case 4:
				this.helperView.setUint8(pos++, value >> 24);
			// eslint-disable-next-line no-fallthrough
			case 3:
				this.helperView.setUint8(pos++, value >> 16);
			// eslint-disable-next-line no-fallthrough
			case 2:
				this.helperView.setUint8(pos++, value >> 8);
			// eslint-disable-next-line no-fallthrough
			case 1:
				this.helperView.setUint8(pos++, value);
				break;
			default:
				throw new Error('Bad unsigned int size ' + width);
		}

		this.writer.write(this.helper.subarray(0, pos));
	}

	writeUnsignedBigInt(value: bigint, width = measureUnsignedBigInt(value)) {
		let pos = 0;

		for (let i = width - 1; i >= 0; i--) {
			this.helperView.setUint8(pos++, Number((value >> BigInt(i * 8)) & 0xffn));
		}

		this.writer.write(this.helper.subarray(0, pos));
	}

	writeSignedInt(value: number, width = measureSignedInt(value)) {
		if (value < 0) {
			// Two's complement stuff
			value += 2 ** (width * 8);
		}

		this.writeUnsignedInt(value, width);
	}

	writeVarInt(value: number, width = measureVarInt(value)) {
		let pos = 0;

		switch (width) {
			case 1:
				this.helperView.setUint8(pos++, (1 << 7) | value);
				break;
			case 2:
				this.helperView.setUint8(pos++, (1 << 6) | (value >> 8));
				this.helperView.setUint8(pos++, value);
				break;
			case 3:
				this.helperView.setUint8(pos++, (1 << 5) | (value >> 16));
				this.helperView.setUint8(pos++, value >> 8);
				this.helperView.setUint8(pos++, value);
				break;
			case 4:
				this.helperView.setUint8(pos++, (1 << 4) | (value >> 24));
				this.helperView.setUint8(pos++, value >> 16);
				this.helperView.setUint8(pos++, value >> 8);
				this.helperView.setUint8(pos++, value);
				break;
			case 5:
				/**
				 * JavaScript converts its doubles to 32-bit integers for bitwise
				 * operations, so we need to do a division by 2^32 instead of a
				 * right-shift of 32 to retain those top 3 bits
				 */
				this.helperView.setUint8(pos++, (1 << 3) | ((value / 2 ** 32) & 0x7));
				this.helperView.setUint8(pos++, value >> 24);
				this.helperView.setUint8(pos++, value >> 16);
				this.helperView.setUint8(pos++, value >> 8);
				this.helperView.setUint8(pos++, value);
				break;
			case 6:
				this.helperView.setUint8(pos++, (1 << 2) | ((value / 2 ** 40) & 0x3));
				this.helperView.setUint8(pos++, (value / 2 ** 32) | 0);
				this.helperView.setUint8(pos++, value >> 24);
				this.helperView.setUint8(pos++, value >> 16);
				this.helperView.setUint8(pos++, value >> 8);
				this.helperView.setUint8(pos++, value);
				break;
			default:
				throw new Error('Bad EBML varint size ' + width);
		}

		this.writer.write(this.helper.subarray(0, pos));
	}

	writeAsciiString(str: string) {
		this.writer.write(new Uint8Array(str.split('').map(x => x.charCodeAt(0))));
	}

	writeEBML(data: EBML | null) {
		if (data === null) return;

		if (data instanceof Uint8Array) {
			this.writer.write(data);
		} else if (Array.isArray(data)) {
			for (const elem of data) {
				this.writeEBML(elem);
			}
		} else {
			this.offsets.set(data, this.writer.getPos());

			this.writeUnsignedInt(data.id); // ID field

			if (Array.isArray(data.data)) {
				const sizePos = this.writer.getPos();
				const sizeSize = data.size === -1 ? 1 : (data.size ?? 4);

				if (data.size === -1) {
					// Write the reserved all-one-bits marker for unknown/unbounded size.
					this.writeByte(0xff);
				} else {
					this.writer.seek(this.writer.getPos() + sizeSize);
				}

				const startPos = this.writer.getPos();
				this.dataOffsets.set(data, startPos);
				this.writeEBML(data.data);

				if (data.size !== -1) {
					const size = this.writer.getPos() - startPos;
					const endPos = this.writer.getPos();
					this.writer.seek(sizePos);
					this.writeVarInt(size, sizeSize);
					this.writer.seek(endPos);
				}
			} else if (typeof data.data === 'number') {
				const size = data.size ?? measureUnsignedInt(data.data);
				this.writeVarInt(size);
				this.writeUnsignedInt(data.data, size);
			} else if (typeof data.data === 'bigint') {
				const size = data.size ?? measureUnsignedBigInt(data.data);
				this.writeVarInt(size);
				this.writeUnsignedBigInt(data.data, size);
			} else if (typeof data.data === 'string') {
				this.writeVarInt(data.data.length);
				this.writeAsciiString(data.data);
			} else if (data.data instanceof Uint8Array) {
				this.writeVarInt(data.data.byteLength, data.size);
				this.writer.write(data.data);
			} else if (data.data instanceof EBMLFloat32) {
				this.writeVarInt(4);
				this.writeFloat32(data.data.value);
			} else if (data.data instanceof EBMLFloat64) {
				this.writeVarInt(8);
				this.writeFloat64(data.data.value);
			} else if (data.data instanceof EBMLSignedInt) {
				const size = data.size ?? measureSignedInt(data.data.value);
				this.writeVarInt(size);
				this.writeSignedInt(data.data.value, size);
			} else if (data.data instanceof EBMLUnicodeString) {
				const bytes = textEncoder.encode(data.data.value);
				this.writeVarInt(bytes.length);
				this.writer.write(bytes);
			} else {
				assertNever(data.data);
			}
		}
	}
}

export const MAX_VAR_INT_SIZE = 8;
export const MIN_HEADER_SIZE = 2; // 1-byte ID and 1-byte size
export const MAX_HEADER_SIZE = 2 * MAX_VAR_INT_SIZE; // 8-byte ID and 8-byte size

export const readVarIntSize = (slice: FileSlice) => {
	if (slice.remainingLength < 1) {
		return null;
	}

	const firstByte = readU8(slice);
	slice.skip(-1);

	if (firstByte === 0) {
		return null; // Invalid VINT
	}

	let width = 1;
	let mask = 0x80;
	while ((firstByte & mask) === 0) {
		width++;
		mask >>= 1;
	}

	// Check if we have enough bytes to read the full varint
	if (slice.remainingLength < width) {
		return null;
	}

	return width;
};

export const readVarInt = (slice: FileSlice) => {
	if (slice.remainingLength < 1) {
		return null;
	}

	// Read the first byte to determine the width of the variable-length integer
	const firstByte = readU8(slice);

	if (firstByte === 0) {
		return null; // Invalid VINT
	}

	// Find the position of VINT_MARKER, which determines the width
	let width = 1;
	let mask = 1 << 7;
	while ((firstByte & mask) === 0) {
		width++;
		mask >>= 1;
	}

	if (slice.remainingLength < width - 1) {
		// Not enough bytes
		return null;
	}

	// First byte's value needs the marker bit cleared
	let value = firstByte & (mask - 1);

	// Read remaining bytes
	for (let i = 1; i < width; i++) {
		value *= 1 << 8;
		value += readU8(slice);
	}

	return value;
};

export const readUnsignedInt = (slice: FileSlice, width: number) => {
	if (width < 1 || width > 8) {
		throw new Error('Bad unsigned int size ' + width);
	}

	let value = 0;

	// Read bytes from most significant to least significant
	for (let i = 0; i < width; i++) {
		value *= 1 << 8;
		value += readU8(slice);
	}

	return value;
};

export const readUnsignedBigInt = (slice: FileSlice, width: number) => {
	if (width < 1) {
		throw new Error('Bad unsigned int size ' + width);
	}

	let value = 0n;

	for (let i = 0; i < width; i++) {
		value <<= 8n;
		value += BigInt(readU8(slice));
	}

	return value;
};

export const readSignedInt = (slice: FileSlice, width: number) => {
	let value = readUnsignedInt(slice, width);

	// If the highest bit is set, convert from two's complement
	if (value & (1 << (width * 8 - 1))) {
		value -= 2 ** (width * 8);
	}

	return value;
};

export const readElementId = (slice: FileSlice) => {
	const size = readVarIntSize(slice);
	if (size === null) {
		return null;
	}

	if (slice.remainingLength < size) {
		return null; // It don't fit
	}

	const id = readUnsignedInt(slice, size);
	return id;
};

/** Returns `undefined` to indicate the EBML undefined size. Returns `null` if the size couldn't be read. */
export const readElementSize = (slice: FileSlice): number | undefined | null => {
	// Need at least 1 byte to read the size
	if (slice.remainingLength < 1) {
		return null;
	}

	const firstByte = readU8(slice);

	if (firstByte === 0xff) {
		return undefined;
	}

	slice.skip(-1);
	const size = readVarInt(slice);

	if (size === null) {
		return null;
	}

	// In some (livestreamed) files, this is the value of the size field. While this technically is just a very
	// large number, it is intended to behave like the reserved size 0xFF, meaning the size is undefined. We
	// catch the number here. Note that it cannot be perfectly represented as a double, but the comparison works
	// nonetheless.
	// eslint-disable-next-line no-loss-of-precision
	if (size === 0x00ffffffffffffff) {
		return undefined;
	}

	return size;
};

export const readElementHeader = (slice: FileSlice) => {
	assert(slice.remainingLength >= MIN_HEADER_SIZE);

	const id = readElementId(slice);
	if (id === null) {
		return null;
	}

	const size = readElementSize(slice);
	if (size === null) {
		return null;
	}

	return { id, size };
};

export const readAsciiString = (slice: FileSlice, length: number) => {
	const bytes = readBytes(slice, length);

	// Actual string length might be shorter due to null terminators
	let strLength = 0;
	while (strLength < length && bytes[strLength] !== 0) {
		strLength += 1;
	}

	return String.fromCharCode(...bytes.subarray(0, strLength));
};

export const readUnicodeString = (slice: FileSlice, length: number) => {
	const bytes = readBytes(slice, length);

	// Actual string length might be shorter due to null terminators
	let strLength = 0;
	while (strLength < length && bytes[strLength] !== 0) {
		strLength += 1;
	}

	return textDecoder.decode(bytes.subarray(0, strLength));
};

export const readFloat = (slice: FileSlice, width: number) => {
	if (width === 0) {
		return 0;
	}

	if (width !== 4 && width !== 8) {
		throw new Error('Bad float size ' + width);
	}

	return width === 4 ? readF32Be(slice) : readF64Be(slice);
};

/** Returns the byte offset in the file of the next element with a matching ID. */
export const searchForNextElementId = async (
	reader: Reader,
	startPos: number,
	ids: EBMLId[],
	until: number | null,
): Promise<{ pos: number; found: boolean }> => {
	const idsSet = new Set(ids);
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		let slice = reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) break;

		const elementHeader = readElementHeader(slice);
		if (!elementHeader) {
			break;
		}

		if (idsSet.has(elementHeader.id)) {
			return { pos: currentPos, found: true };
		}

		assertDefinedSize(elementHeader.size);

		currentPos = slice.filePos + elementHeader.size;
	}

	return { pos: (until !== null && until > currentPos) ? until : currentPos, found: false };
};

/** Searches for the next occurrence of an element ID using a naive byte-wise search. */
export const resync = async (reader: Reader, startPos: number, ids: EBMLId[], until: number) => {
	const CHUNK_SIZE = 2 ** 16; // So we don't need to grab thousands of slices
	const idsSet = new Set(ids);
	let currentPos = startPos;

	while (currentPos < until) {
		let slice = reader.requestSliceRange(currentPos, 0, Math.min(CHUNK_SIZE, until - currentPos));
		if (slice instanceof Promise) slice = await slice;
		if (!slice) break;
		if (slice.length < MAX_VAR_INT_SIZE) break;

		for (let i = 0; i < slice.length - MAX_VAR_INT_SIZE; i++) {
			slice.filePos = currentPos;

			const elementId = readElementId(slice);
			if (elementId !== null && idsSet.has(elementId)) {
				return currentPos;
			}

			currentPos++;
		}
	}

	return null;
};

export const CODEC_STRING_MAP: Partial<Record<MediaCodec, string>> = {
	'avc': 'V_MPEG4/ISO/AVC',
	'hevc': 'V_MPEGH/ISO/HEVC',
	'vp8': 'V_VP8',
	'vp9': 'V_VP9',
	'av1': 'V_AV1',

	'aac': 'A_AAC',
	'mp3': 'A_MPEG/L3',
	'opus': 'A_OPUS',
	'vorbis': 'A_VORBIS',
	'flac': 'A_FLAC',
	'ac3': 'A_AC3',
	'eac3': 'A_EAC3',
	'pcm-u8': 'A_PCM/INT/LIT',
	'pcm-s16': 'A_PCM/INT/LIT',
	'pcm-s16be': 'A_PCM/INT/BIG',
	'pcm-s24': 'A_PCM/INT/LIT',
	'pcm-s24be': 'A_PCM/INT/BIG',
	'pcm-s32': 'A_PCM/INT/LIT',
	'pcm-s32be': 'A_PCM/INT/BIG',
	'pcm-f32': 'A_PCM/FLOAT/IEEE',
	'pcm-f64': 'A_PCM/FLOAT/IEEE',

	'webvtt': 'S_TEXT/WEBVTT',
};

export function assertDefinedSize(size: number | undefined): asserts size is number {
	if (size === undefined) {
		throw new Error('Undefined element size is used in a place where it is not supported.');
	}
};
