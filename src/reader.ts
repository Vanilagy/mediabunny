/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, clamp, getUint24, MaybePromise, toDataView } from './misc';
import { Source } from './source';

export class Reader {
	fileSize!: number | null;

	constructor(public source: Source) {}

	requestSlice(start: number, length: number): MaybePromise<FileSlice | null> {
		if (this.fileSize !== null && start + length > this.fileSize) {
			return null;
		}

		const end = start + length;
		const result = this.source._read(start, end);

		if (result instanceof Promise) {
			return result.then((x) => {
				if (!x) {
					return null;
				}

				return new FileSlice(x.bytes, x.view, x.offset, start, end);
			});
		} else {
			if (!result) {
				return null;
			}

			return new FileSlice(result.bytes, result.view, result.offset, start, end);
		}
	}

	requestSliceRange(start: number, minLength: number, maxLength: number): MaybePromise<FileSlice | null> {
		if (this.fileSize !== null) {
			return this.requestSlice(
				start,
				clamp(this.fileSize - start, minLength, maxLength),
			);
		} else {
			const promisedAttempt = this.requestSlice(start, maxLength);

			const handleAttempt = (attempt: FileSlice | null) => {
				if (attempt) {
					return attempt;
				}

				const handleFileSize = (fileSize: number | null) => {
					assert(fileSize !== null); // The slice couldn't fit, meaning we must know the file size now

					return this.requestSlice(
						start,
						clamp(fileSize - start, minLength, maxLength),
					);
				};

				const promisedFileSize = this.source._retrieveSize();
				if (promisedFileSize instanceof Promise) {
					return promisedFileSize.then(handleFileSize);
				} else {
					return handleFileSize(promisedFileSize);
				}
			};

			if (promisedAttempt instanceof Promise) {
				return promisedAttempt.then(handleAttempt);
			} else {
				return handleAttempt(promisedAttempt);
			}
		}
	}
}

export class FileSlice {
	bufferPos: number;

	constructor(
		public readonly bytes: Uint8Array,
		public readonly view: DataView,
		private readonly offset: number,
		public readonly start: number,
		public readonly end: number,
	) {
		this.bufferPos = start - offset;
	}

	static tempFromBytes(bytes: Uint8Array) {
		return new FileSlice(
			bytes,
			toDataView(bytes),
			0,
			0,
			bytes.length,
		);
	}

	get length() {
		return this.end - this.start;
	}

	get filePos() {
		return this.offset + this.bufferPos;
	}

	set filePos(value: number) {
		this.bufferPos = value - this.offset;
	}

	skip(byteCount: number) {
		this.bufferPos += byteCount;
	}

	slice(filePos: number, length = this.end - filePos) {
		if (filePos < this.start || filePos + length > this.end) {
			throw new RangeError('Slicing outside of original slice.');
		}

		return new FileSlice(
			this.bytes,
			this.view,
			this.offset,
			filePos,
			filePos + length,
		);
	}
}

export const readBytes = (slice: FileSlice, length: number) => {
	const bytes = slice.bytes.subarray(slice.bufferPos, slice.bufferPos + length);
	slice.bufferPos += length;

	return bytes;
};

export const readU8 = (slice: FileSlice) => slice.view.getUint8(slice.bufferPos++);

export const readU16 = (slice: FileSlice, littleEndian: boolean) => {
	const value = slice.view.getUint16(slice.bufferPos, littleEndian);
	slice.bufferPos += 2;

	return value;
};

export const readU16Be = (slice: FileSlice) => {
	const value = slice.view.getUint16(slice.bufferPos, false);
	slice.bufferPos += 2;

	return value;
};

export const readU24Be = (slice: FileSlice) => {
	const value = getUint24(slice.view, slice.bufferPos, false);
	slice.bufferPos += 3;

	return value;
};

export const readI16Be = (slice: FileSlice) => {
	const value = slice.view.getInt16(slice.bufferPos, false);
	slice.bufferPos += 2;

	return value;
};

export const readU32 = (slice: FileSlice, littleEndian: boolean) => {
	const value = slice.view.getUint32(slice.bufferPos, littleEndian);
	slice.bufferPos += 4;

	return value;
};

export const readU32Be = (slice: FileSlice) => {
	const value = slice.view.getUint32(slice.bufferPos, false);
	slice.bufferPos += 4;

	return value;
};

export const readU32Le = (slice: FileSlice) => {
	const value = slice.view.getUint32(slice.bufferPos, true);
	slice.bufferPos += 4;

	return value;
};

export const readI32Be = (slice: FileSlice) => {
	const value = slice.view.getInt32(slice.bufferPos, false);
	slice.bufferPos += 4;

	return value;
};

export const readI32Le = (slice: FileSlice) => {
	const value = slice.view.getInt32(slice.bufferPos, true);
	slice.bufferPos += 4;

	return value;
};

export const readU64 = (slice: FileSlice, littleEndian: boolean) => {
	let low: number;
	let high: number;

	if (littleEndian) {
		low = readU32(slice, true);
		high = readU32(slice, true);
	} else {
		high = readU32(slice, false);
		low = readU32(slice, false);
	}

	return high * 0x100000000 + low;
};

export const readU64Be = (slice: FileSlice) => {
	const high = readU32Be(slice);
	const low = readU32Be(slice);
	return high * 0x100000000 + low;
};

export const readI64Be = (slice: FileSlice) => {
	const high = readI32Be(slice);
	const low = readU32Be(slice);
	return high * 0x100000000 + low;
};

export const readI64Le = (slice: FileSlice) => {
	const low = readU32Le(slice);
	const high = readI32Le(slice);
	return high * 0x100000000 + low;
};

export const readF32Be = (slice: FileSlice) => {
	const value = slice.view.getFloat32(slice.bufferPos, false);
	slice.bufferPos += 4;

	return value;
};

export const readF64Be = (slice: FileSlice) => {
	const value = slice.view.getFloat64(slice.bufferPos, false);
	slice.bufferPos += 8;

	return value;
};

export const readAscii = (slice: FileSlice, length: number) => {
	if (slice.bufferPos + length > slice.bytes.length) {
		throw new RangeError('Reading past end of slice.');
	}

	let str = '';

	for (let i = 0; i < length; i++) {
		str += String.fromCharCode(slice.bytes[slice.bufferPos++]!);
	}

	return str;
};
