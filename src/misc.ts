/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}

/**
 * Represents a clockwise rotation in degrees.
 * @group Miscellaneous
 * @public
 */
export type Rotation = 0 | 90 | 180 | 270;

export const normalizeRotation = (rotation: number) => {
	const mappedRotation = (rotation % 360 + 360) % 360;

	if (mappedRotation === 0 || mappedRotation === 90 || mappedRotation === 180 || mappedRotation === 270) {
		return mappedRotation as Rotation;
	} else {
		throw new Error(`Invalid rotation ${rotation}.`);
	}
};

export type TransformationMatrix = [number, number, number, number, number, number, number, number, number];

export const last = <T>(arr: T[]) => {
	return arr && arr[arr.length - 1];
};

export const isU32 = (value: number) => {
	return value >= 0 && value < 2 ** 32;
};

export class Bitstream {
	/** Current offset in bits. */
	pos = 0;

	constructor(public bytes: Uint8Array) {}

	seekToByte(byteOffset: number) {
		this.pos = 8 * byteOffset;
	}

	private readBit() {
		const byteIndex = Math.floor(this.pos / 8);
		const byte = this.bytes[byteIndex] ?? 0;
		const bitIndex = 0b111 - (this.pos & 0b111);
		const bit = (byte & (1 << bitIndex)) >> bitIndex;

		this.pos++;
		return bit;
	}

	readBits(n: number) {
		if (n === 1) {
			return this.readBit();
		}

		let result = 0;

		for (let i = 0; i < n; i++) {
			result <<= 1;
			result |= this.readBit();
		}

		return result;
	}

	writeBits(n: number, value: number) {
		const end = this.pos + n;

		for (let i = this.pos; i < end; i++) {
			const byteIndex = Math.floor(i / 8);
			let byte = this.bytes[byteIndex]!;
			const bitIndex = 0b111 - (i & 0b111);

			byte &= ~(1 << bitIndex);
			byte |= ((value & (1 << (end - i - 1))) >> (end - i - 1)) << bitIndex;
			this.bytes[byteIndex] = byte;
		}

		this.pos = end;
	};

	readAlignedByte() {
		// Ensure we're byte-aligned
		if (this.pos % 8 !== 0) {
			throw new Error('Bitstream is not byte-aligned.');
		}

		const byteIndex = this.pos / 8;
		const byte = this.bytes[byteIndex] ?? 0;

		this.pos += 8;
		return byte;
	}

	skipBits(n: number) {
		this.pos += n;
	}

	getBitsLeft() {
		return this.bytes.length * 8 - this.pos;
	}

	clone() {
		const clone = new Bitstream(this.bytes);
		clone.pos = this.pos;
		return clone;
	}
}

/** Reads an exponential-Golomb universal code from a Bitstream.  */
export const readExpGolomb = (bitstream: Bitstream) => {
	let leadingZeroBits = 0;
	while (bitstream.readBits(1) === 0 && leadingZeroBits < 32) {
		leadingZeroBits++;
	}

	if (leadingZeroBits >= 32) {
		throw new Error('Invalid exponential-Golomb code.');
	}

	const result = (1 << leadingZeroBits) - 1 + bitstream.readBits(leadingZeroBits);
	return result;
};

/** Reads a signed exponential-Golomb universal code from a Bitstream. */
export const readSignedExpGolomb = (bitstream: Bitstream) => {
	const codeNum = readExpGolomb(bitstream);

	return ((codeNum & 1) === 0)
		? -(codeNum >> 1)
		: ((codeNum + 1) >> 1);
};

export const writeBits = (bytes: Uint8Array, start: number, end: number, value: number) => {
	for (let i = start; i < end; i++) {
		const byteIndex = Math.floor(i / 8);
		let byte = bytes[byteIndex]!;
		const bitIndex = 0b111 - (i & 0b111);

		byte &= ~(1 << bitIndex);
		byte |= ((value & (1 << (end - i - 1))) >> (end - i - 1)) << bitIndex;
		bytes[byteIndex] = byte;
	}
};

export const toUint8Array = (source: AllowSharedBufferSource): Uint8Array => {
	if (source.constructor === Uint8Array) { // We want a true Uint8Array, not something that extends it like Buffer
		return source;
	} else if (ArrayBuffer.isView(source)) {
		return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
	} else {
		return new Uint8Array(source);
	}
};

export const toDataView = (source: AllowSharedBufferSource): DataView => {
	if (source.constructor === DataView) {
		return source;
	} else if (ArrayBuffer.isView(source)) {
		return new DataView(source.buffer, source.byteOffset, source.byteLength);
	} else {
		return new DataView(source);
	}
};

export const textDecoder = /* #__PURE__ */ new TextDecoder();
export const textEncoder = /* #__PURE__ */ new TextEncoder();

export const isIso88591Compatible = (text: string) => {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code > 255) {
			return false;
		}
	}

	return true;
};

const invertObject = <K extends PropertyKey, V extends PropertyKey>(object: Record<K, V>) => {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key])) as Record<V, K>;
};

// For the color space mappings, see Rec. ITU-T H.273.

export const COLOR_PRIMARIES_MAP = {
	bt709: 1, // ITU-R BT.709
	bt470bg: 5, // ITU-R BT.470BG
	smpte170m: 6, // ITU-R BT.601 525 - SMPTE 170M
	bt2020: 9, // ITU-R BT.202
	smpte432: 12, // SMPTE EG 432-1
};
export const COLOR_PRIMARIES_MAP_INVERSE = /* #__PURE__ */ invertObject(COLOR_PRIMARIES_MAP);

export const TRANSFER_CHARACTERISTICS_MAP = {
	'bt709': 1, // ITU-R BT.709
	'smpte170m': 6, // SMPTE 170M
	'linear': 8, // Linear transfer characteristics
	'iec61966-2-1': 13, // IEC 61966-2-1
	'pq': 16, // Rec. ITU-R BT.2100-2 perceptual quantization (PQ) system
	'hlg': 18, // Rec. ITU-R BT.2100-2 hybrid loggamma (HLG) system
};
export const TRANSFER_CHARACTERISTICS_MAP_INVERSE = /* #__PURE__ */ invertObject(TRANSFER_CHARACTERISTICS_MAP);

export const MATRIX_COEFFICIENTS_MAP = {
	'rgb': 0, // Identity
	'bt709': 1, // ITU-R BT.709
	'bt470bg': 5, // ITU-R BT.470BG
	'smpte170m': 6, // SMPTE 170M
	'bt2020-ncl': 9, // ITU-R BT.2020-2 (non-constant luminance)
};
export const MATRIX_COEFFICIENTS_MAP_INVERSE = /* #__PURE__ */ invertObject(MATRIX_COEFFICIENTS_MAP);

export type RequiredNonNull<T> = {
	[K in keyof T]-?: NonNullable<T[K]>;
};

export const colorSpaceIsComplete = (
	colorSpace: VideoColorSpaceInit | undefined,
): colorSpace is RequiredNonNull<VideoColorSpaceInit> => {
	return (
		!!colorSpace
		&& !!colorSpace.primaries
		&& !!colorSpace.transfer
		&& !!colorSpace.matrix
		&& colorSpace.fullRange !== undefined
	);
};

export const isAllowSharedBufferSource = (x: unknown) => {
	return (
		x instanceof ArrayBuffer
		|| (typeof SharedArrayBuffer !== 'undefined' && x instanceof SharedArrayBuffer)
		|| ArrayBuffer.isView(x)
	);
};

export class AsyncMutex {
	currentPromise = Promise.resolve();
	pending = 0;

	async acquire() {
		let resolver: () => void;
		const nextPromise = new Promise<void>((resolve) => {
			let resolved = false;

			resolver = () => {
				if (resolved) {
					return;
				}

				resolve();
				this.pending--;
				resolved = true;
			};
		});

		const currentPromiseAlias = this.currentPromise;
		this.currentPromise = nextPromise;
		this.pending++;

		await currentPromiseAlias;

		return resolver!;
	}
}

export const bytesToHexString = (bytes: Uint8Array) => {
	return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
};

export const reverseBitsU32 = (x: number): number => {
	x = ((x >> 1) & 0x55555555) | ((x & 0x55555555) << 1);
	x = ((x >> 2) & 0x33333333) | ((x & 0x33333333) << 2);
	x = ((x >> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
	x = ((x >> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
	x = ((x >> 16) & 0x0000ffff) | ((x & 0x0000ffff) << 16);
	return x >>> 0; // Ensure it's treated as an unsigned 32-bit integer
};

/** Returns the smallest index i such that val[i] === key, or -1 if no such index exists. */
export const binarySearchExact = <T>(arr: T[], key: number, valueGetter: (x: T) => number): number => {
	let low = 0;
	let high = arr.length - 1;
	let ans = -1;

	while (low <= high) {
		const mid = (low + high) >> 1;
		const midVal = valueGetter(arr[mid]!);

		if (midVal === key) {
			ans = mid;
			high = mid - 1; // Continue searching left to find the lowest index
		} else if (midVal < key) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return ans;
};

/** Returns the largest index i such that val[i] <= key, or -1 if no such index exists. */
export const binarySearchLessOrEqual = <T>(arr: T[], key: number, valueGetter: (x: T) => number) => {
	let low = 0;
	let high = arr.length - 1;
	let ans = -1;

	while (low <= high) {
		const mid = (low + (high - low + 1) / 2) | 0;
		const midVal = valueGetter(arr[mid]!);

		if (midVal <= key) {
			ans = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return ans;
};

/** Assumes the array is already sorted. */
export const insertSorted = <T>(arr: T[], item: T, valueGetter: (x: T) => number) => {
	const insertionIndex = binarySearchLessOrEqual(arr, valueGetter(item), valueGetter);
	arr.splice(insertionIndex + 1, 0, item); // This even behaves correctly for the -1 case
};

export const promiseWithResolvers = <T = void>() => {
	let resolve: (value: T) => void;
	let reject: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve: resolve!, reject: reject! };
};

export const removeItem = <T>(arr: T[], item: T) => {
	const index = arr.indexOf(item);
	if (index !== -1) {
		arr.splice(index, 1);
	}
};

export const findLast = <T>(arr: T[], predicate: (x: T) => boolean) => {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (predicate(arr[i]!)) {
			return arr[i];
		}
	}

	return undefined;
};

export const findLastIndex = <T>(arr: T[], predicate: (x: T) => boolean) => {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (predicate(arr[i]!)) {
			return i;
		}
	}

	return -1;
};

/**
 * Sync or async iterable.
 * @group Miscellaneous
 * @public
 */
export type AnyIterable<T> =
	| Iterable<T>
	| AsyncIterable<T>;

export const toAsyncIterator = async function* <T>(source: AnyIterable<T>): AsyncGenerator<T, void, unknown> {
	if (Symbol.iterator in source) {
		// @ts-expect-error Trust me
		yield* source[Symbol.iterator]();
	} else {
		// @ts-expect-error Trust me
		yield* source[Symbol.asyncIterator]();
	}
};

export const validateAnyIterable = (iterable: AnyIterable<unknown>) => {
	if (!(Symbol.iterator in iterable) && !(Symbol.asyncIterator in iterable)) {
		throw new TypeError('Argument must be an iterable or async iterable.');
	}
};

export const assertNever = (x: never) => {
	// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
	throw new Error(`Unexpected value: ${x}`);
};

export const getUint24 = (view: DataView, byteOffset: number, littleEndian: boolean) => {
	const byte1 = view.getUint8(byteOffset);
	const byte2 = view.getUint8(byteOffset + 1);
	const byte3 = view.getUint8(byteOffset + 2);

	if (littleEndian) {
		return byte1 | (byte2 << 8) | (byte3 << 16);
	} else {
		return (byte1 << 16) | (byte2 << 8) | byte3;
	}
};

export const getInt24 = (view: DataView, byteOffset: number, littleEndian: boolean) => {
	// The left shift pushes the most significant bit into the sign bit region, and the subsequent right shift
	// then correctly interprets the sign bit.
	return getUint24(view, byteOffset, littleEndian) << 8 >> 8;
};

export const setUint24 = (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => {
	// Ensure the value is within 24-bit unsigned range (0 to 16777215)
	value = value >>> 0; // Convert to unsigned 32-bit
	value = value & 0xFFFFFF; // Mask to 24 bits

	if (littleEndian) {
		view.setUint8(byteOffset, value & 0xFF);
		view.setUint8(byteOffset + 1, (value >>> 8) & 0xFF);
		view.setUint8(byteOffset + 2, (value >>> 16) & 0xFF);
	} else {
		view.setUint8(byteOffset, (value >>> 16) & 0xFF);
		view.setUint8(byteOffset + 1, (value >>> 8) & 0xFF);
		view.setUint8(byteOffset + 2, value & 0xFF);
	}
};

export const setInt24 = (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => {
	// Ensure the value is within 24-bit signed range (-8388608 to 8388607)
	value = clamp(value, -8388608, 8388607);

	// Convert negative values to their 24-bit representation
	if (value < 0) {
		value = (value + 0x1000000) & 0xFFFFFF;
	}

	setUint24(view, byteOffset, value, littleEndian);
};

export const setInt64 = (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => {
	if (littleEndian) {
		view.setUint32(byteOffset + 0, value, true);
		view.setInt32(byteOffset + 4, Math.floor(value / 2 ** 32), true);
	} else {
		view.setInt32(byteOffset + 0, Math.floor(value / 2 ** 32), true);
		view.setUint32(byteOffset + 4, value, true);
	}
};

/**
 * Calls a function on each value spat out by an async generator. The reason for writing this manually instead of
 * using a generator function is that the generator function queues return() calls - here, we forward them immediately.
 */
export const mapAsyncGenerator = <T, U>(
	generator: AsyncGenerator<T, void, unknown>,
	map: (t: T) => U,
): AsyncGenerator<U, void, unknown> => {
	return {
		async next() {
			const result = await generator.next();
			if (result.done) {
				return { value: undefined, done: true };
			} else {
				return { value: map(result.value), done: false };
			}
		},
		return() {
			return generator.return() as ReturnType<AsyncGenerator<U, void, unknown>['return']>;
		},
		throw(error) {
			return generator.throw(error) as ReturnType<AsyncGenerator<U, void, unknown>['throw']>;
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
};

export const clamp = (value: number, min: number, max: number) => {
	return Math.max(min, Math.min(max, value));
};

export const UNDETERMINED_LANGUAGE = 'und';

export const roundIfAlmostInteger = (value: number) => {
	const rounded = Math.round(value);

	if (Math.abs(value / rounded - 1) < 10 * Number.EPSILON) {
		return rounded;
	} else {
		return value;
	}
};

export const roundToMultiple = (value: number, multiple: number) => {
	return Math.round(value / multiple) * multiple;
};

export const floorToMultiple = (value: number, multiple: number) => {
	return Math.floor(value / multiple) * multiple;
};

export const ilog = (x: number) => {
	let ret = 0;
	while (x) {
		ret++;
		x >>= 1;
	}
	return ret;
};

const ISO_639_2_REGEX = /^[a-z]{3}$/;
export const isIso639Dash2LanguageCode = (x: string) => {
	return ISO_639_2_REGEX.test(x);
};

// Since the result will be truncated, add a bit of eps to compensate for floating point errors
export const SECOND_TO_MICROSECOND_FACTOR = 1e6 * (1 + Number.EPSILON);

/**
 * Sets all keys K of T to be required.
 * @group Miscellaneous
 * @public
 */
export type SetRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Merges two RequestInit objects with special handling for headers.
 * Headers are merged case-insensitively, but original casing is preserved.
 * init2 headers take precedence and will override case-insensitive matches from init1.
 */
export const mergeRequestInit = (init1: RequestInit, init2: RequestInit): RequestInit => {
	const merged: RequestInit = { ...init1, ...init2 };

	// Special handling for headers
	if (init1.headers || init2.headers) {
		const headers1 = init1.headers ? normalizeHeaders(init1.headers) : {};
		const headers2 = init2.headers ? normalizeHeaders(init2.headers) : {};

		const mergedHeaders = { ...headers1 };

		// For each header in headers2, check if a case-insensitive match exists in mergedHeaders
		Object.entries(headers2).forEach(([key2, value2]) => {
			const existingKey = Object.keys(mergedHeaders).find(
				key1 => key1.toLowerCase() === key2.toLowerCase(),
			);

			if (existingKey) {
				delete mergedHeaders[existingKey];
			}

			mergedHeaders[key2] = value2;
		});

		merged.headers = mergedHeaders;
	}

	return merged;
};

/** Normalizes HeadersInit to a Record<string, string> format. */
const normalizeHeaders = (headers: HeadersInit): Record<string, string> => {
	if (headers instanceof Headers) {
		const result: Record<string, string> = {};
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}

	if (Array.isArray(headers)) {
		const result: Record<string, string> = {};
		headers.forEach(([key, value]) => {
			result[key] = value;
		});
		return result;
	}

	return headers;
};

export const retriedFetch = async (
	fetchFn: typeof fetch,
	url: string | URL | Request,
	requestInit: RequestInit,
	getRetryDelay: (previousAttempts: number, error: unknown, url: string | URL | Request) => number | null,
	shouldStop: () => boolean,
) => {
	let attempts = 0;

	while (true) {
		try {
			return await fetchFn(url, requestInit);
		} catch (error) {
			if (shouldStop()) {
				throw error;
			}

			attempts++;
			const retryDelayInSeconds = getRetryDelay(attempts, error, url);

			if (retryDelayInSeconds === null) {
				throw error;
			}

			console.error('Retrying failed fetch. Error:', error);

			if (!Number.isFinite(retryDelayInSeconds) || retryDelayInSeconds < 0) {
				throw new TypeError('Retry delay must be a non-negative finite number.');
			}

			if (retryDelayInSeconds > 0) {
				await new Promise(resolve => setTimeout(resolve, 1000 * retryDelayInSeconds));
			}

			if (shouldStop()) {
				throw error;
			}
		}
	}
};

export const computeRationalApproximation = (x: number, maxDenominator: number) => {
	// Handle negative numbers
	const sign = x < 0 ? -1 : 1;
	x = Math.abs(x);

	let prevNumerator = 0, prevDenominator = 1;
	let currNumerator = 1, currDenominator = 0;

	// Continued fraction algorithm
	let remainder = x;

	while (true) {
		const integer = Math.floor(remainder);

		// Calculate next convergent
		const nextNumerator = integer * currNumerator + prevNumerator;
		const nextDenominator = integer * currDenominator + prevDenominator;

		if (nextDenominator > maxDenominator) {
			return {
				numerator: sign * currNumerator,
				denominator: currDenominator,
			};
		}

		prevNumerator = currNumerator;
		prevDenominator = currDenominator;
		currNumerator = nextNumerator;
		currDenominator = nextDenominator;

		remainder = 1 / (remainder - integer);

		// Guard against precision issues
		if (!isFinite(remainder)) {
			break;
		}
	}

	return {
		numerator: sign * currNumerator,
		denominator: currDenominator,
	};
};

export class CallSerializer {
	currentPromise = Promise.resolve();

	call(fn: () => Promise<void> | void) {
		return this.currentPromise = this.currentPromise.then(fn);
	}
}

let isWebKitCache: boolean | null = null;
export const isWebKit = () => {
	if (isWebKitCache !== null) {
		return isWebKitCache;
	}

	// This even returns true for WebKit-wrapping browsers such as Chrome on iOS
	return isWebKitCache = !!(
		typeof navigator !== 'undefined'
		&& (
			navigator.vendor?.match(/apple/i)
			// Or, in workers:
			|| (/AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent))
			|| /\b(iPad|iPhone|iPod)\b/.test(navigator.userAgent)
		)
	);
};

let isFirefoxCache: boolean | null = null;
export const isFirefox = () => {
	if (isFirefoxCache !== null) {
		return isFirefoxCache;
	}

	return isFirefoxCache = typeof navigator !== 'undefined' && navigator.userAgent?.includes('Firefox');
};

let isChromiumCache: boolean | null = null;
export const isChromium = () => {
	if (isChromiumCache !== null) {
		return isChromiumCache;
	}

	return isChromiumCache = !!(
		typeof navigator !== 'undefined'
		&& (navigator.vendor?.includes('Google Inc') || /Chrome/.test(navigator.userAgent))
	);
};

let chromiumVersionCache: number | null = null;
export const getChromiumVersion = () => {
	if (chromiumVersionCache !== null) {
		return chromiumVersionCache;
	}

	if (typeof navigator === 'undefined') {
		return null;
	}

	const match = /\bChrome\/(\d+)/.exec(navigator.userAgent);
	if (!match) {
		return null;
	}

	return chromiumVersionCache = Number(match[1]!);
};

/**
 * T or a promise that resolves to T.
 * @group Miscellaneous
 * @public
 */
export type MaybePromise<T> = T | Promise<T>;

/** Acts like `??` except the condition is -1 and not null/undefined. */
export const coalesceIndex = (a: number, b: number) => {
	return a !== -1 ? a : b;
};

export const closedIntervalsOverlap = (startA: number, endA: number, startB: number, endB: number) => {
	return startA <= endB && startB <= endA;
};

type KeyValuePair<T extends Record<string, unknown>> = {
	[K in keyof T]-?: {
		key: K;
		value: T[K] extends infer R | undefined ? R : T[K];
	}
}[keyof T];

export const keyValueIterator = function* <T extends Record<string, unknown>>(object: T) {
	for (const key in object) {
		const value = object[key];
		if (value === undefined) {
			continue;
		}

		yield { key, value } as KeyValuePair<T>;
	}
};

export const imageMimeTypeToExtension = (mimeType: string) => {
	switch (mimeType.toLowerCase()) {
		case 'image/jpeg':
		case 'image/jpg':
			return '.jpg';
		case 'image/png':
			return '.png';
		case 'image/gif':
			return '.gif';
		case 'image/webp':
			return '.webp';
		case 'image/bmp':
			return '.bmp';
		case 'image/svg+xml':
			return '.svg';
		case 'image/tiff':
			return '.tiff';
		case 'image/avif':
			return '.avif';
		case 'image/x-icon':
		case 'image/vnd.microsoft.icon':
			return '.ico';
		default:
			return null;
	}
};

export const base64ToBytes = (base64: string) => {
	const decoded = atob(base64);
	const bytes = new Uint8Array(decoded.length);

	for (let i = 0; i < decoded.length; i++) {
		bytes[i] = decoded.charCodeAt(i);
	}

	return bytes;
};

export const bytesToBase64 = (bytes: Uint8Array) => {
	let string = '';

	for (let i = 0; i < bytes.length; i++) {
		string += String.fromCharCode(bytes[i]!);
	}

	return btoa(string);
};

export const uint8ArraysAreEqual = (a: Uint8Array, b: Uint8Array) => {
	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
};

export const polyfillSymbolDispose = () => {
	// https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
	// @ts-expect-error Readonly
	Symbol.dispose ??= Symbol('Symbol.dispose');
};

export const isNumber = (x: unknown) => {
	return typeof x === 'number' && !Number.isNaN(x);
};
