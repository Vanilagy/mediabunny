/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, MaybePromise } from './misc';
import { readBytes, Reader } from './reader';

// Inspired in part by https://github.com/halloweeks/AES-128-CBC/blob/main/AES_128_CBC.h

export const AES_128_BLOCK_SIZE = 16;

const Te4 = new Uint32Array(256);
const Td0 = new Uint32Array(256);
const Td1 = new Uint32Array(256);
const Td2 = new Uint32Array(256);
const Td3 = new Uint32Array(256);
const Td4 = new Uint32Array(256);
const rcon = new Uint32Array(10);

let tablesGenerated = false;

// Generating the tables once is much more bundle size-efficient than shipping them in the bundle (entropy ftw)
const generateAesTables = () => {
	const sbox = new Uint8Array(256);
	const log = new Uint8Array(256);
	const pow = new Uint8Array(256);

	// 1. Generate GF(2^8) log/exp tables
	// Primitive polynomial: x^8 + x^4 + x^3 + x + 1 (0x11B)
	for (let i = 0, p = 1; i < 256; i++) {
		pow[i] = p;
		log[p] = i;
		p = p ^ (p << 1) ^ (p & 0x80 ? 0x11B : 0);
	}

	// Helper: GF(2^8) multiplication
	const mul = (a: number, b: number) =>
		(a && b) ? pow[(log[a]! + log[b]!) % 255]! : 0;

	// 2. Generate S-Box and Inverse S-Box
	sbox[0] = 0x63; // Special case for 0
	// Loop for inverse (using log/exp) and Affine Transform
	for (let i = 1; i < 256; i++) {
		const x = pow[255 - log[i]!]!; // Multiplicative inverse
		let s = x ^ (x << 1) ^ (x << 2) ^ (x << 3) ^ (x << 4);
		s = (s >>> 8) ^ (s & 0xFF) ^ 0x63; // Affine transform
		sbox[i] = s;
	}

	// 3. Fill Tables
	for (let i = 0; i < 256; i++) {
		const s = sbox[i]!; // Forward S-Box value
		const is = sbox.indexOf(i); // Inverse S-Box value

		// Te4: Forward S-Box packed
		Te4[i] = (s << 24) | (s << 16) | (s << 8) | s;

		// Td4: Inverse S-Box packed
		Td4[i] = (is << 24) | (is << 16) | (is << 8) | is;

		// Td0-Td3: Inverse MixColumns applied to Inverse S-Box
		// Coefficients: 0x0E, 0x09, 0x0D, 0x0B (Order specific to Td0 structure)
		const b0 = mul(is, 0x0E);
		const b1 = mul(is, 0x09);
		const b2 = mul(is, 0x0D);
		const b3 = mul(is, 0x0B);

		const w = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
		Td0[i] = w;
		Td1[i] = (w >>> 8) | (w << 24); // Rotate right 8
		Td2[i] = (w >>> 16) | (w << 16); // Rotate right 16
		Td3[i] = (w >>> 24) | (w << 8); // Rotate right 24
	}

	// 4. Generate Rcon
	let r = 1;
	for (let i = 0; i < 10; i++) {
		rcon[i] = r << 24;
		r = (r << 1) ^ (r & 0x80 ? 0x11B : 0);
	}

	tablesGenerated = true;
};

export type Aes128CbcContextInit = {
	key: Uint8Array;
	iv: Uint8Array;
};

/** A context for doing AES-128-CBC operations. Better than the Web Crypto API since we can stream it. */
export class Aes128CbcContext {
	roundkey = new Uint32Array(44);
	iv = new Uint32Array(AES_128_BLOCK_SIZE / Uint32Array.BYTES_PER_ELEMENT);
	in = new Uint8Array(AES_128_BLOCK_SIZE);
	out = new Uint8Array(AES_128_BLOCK_SIZE);
	inView = new DataView(this.in.buffer);
	outView = new DataView(this.out.buffer);

	init({ key, iv }: Aes128CbcContextInit) {
		assert(key.byteLength === 16);
		assert(iv.byteLength === 16);

		if (!tablesGenerated) {
			generateAesTables();
		}

		const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
		const ivView = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);

		this.roundkey[0] = keyView.getUint32(0, false);
		this.roundkey[1] = keyView.getUint32(4, false);
		this.roundkey[2] = keyView.getUint32(8, false);
		this.roundkey[3] = keyView.getUint32(12, false);

		this.iv[0] = ivView.getUint32(0, false);
		this.iv[1] = ivView.getUint32(4, false);
		this.iv[2] = ivView.getUint32(8, false);
		this.iv[3] = ivView.getUint32(12, false);

		for (let index = 4; index < 44; index += 4) {
			const temp = this.roundkey[index - 1]!;
			this.roundkey[index] = this.roundkey[index - 4]!
				^ (Te4[(temp >>> 16) & 0xff]! & 0xff000000)
				^ (Te4[(temp >>> 8) & 0xff]! & 0x00ff0000)
				^ (Te4[(temp >>> 0) & 0xff]! & 0x0000ff00)
				^ (Te4[(temp >>> 24) & 0xff]! & 0x000000ff)
				^ rcon[(index / 4) - 1]!;
			this.roundkey[index + 1] = this.roundkey[index - 3]! ^ this.roundkey[index]!;
			this.roundkey[index + 2] = this.roundkey[index - 2]! ^ this.roundkey[index + 1]!;
			this.roundkey[index + 3] = this.roundkey[index - 1]! ^ this.roundkey[index + 2]!;
		}

		// Invert the order of the round keys
		for (let i = 0, j = 40; i < j; i += 4, j -= 4) {
			for (let k = 0; k < 4; k++) {
				const temp = this.roundkey[i + k]!;
				this.roundkey[i + k] = this.roundkey[j + k]!;
				this.roundkey[j + k] = temp;
			}
		}

		// Apply Inverse MixColumn transform to all round keys except first and last
		for (let index = 4; index < 40; index += 4) {
			for (let k = 0; k < 4; k++) {
				const rk = this.roundkey[index + k]!;
				this.roundkey[index + k]
					= Td0[Te4[(rk >>> 24) & 0xff]! & 0xff]!
						^ Td1[Te4[(rk >>> 16) & 0xff]! & 0xff]!
						^ Td2[Te4[(rk >>> 8) & 0xff]! & 0xff]!
						^ Td3[Te4[(rk >>> 0) & 0xff]! & 0xff]!;
			}
		}
	}

	decrypt() {
		let s0 = this.inView.getUint32(0, false) ^ this.roundkey[0]!;
		let s1 = this.inView.getUint32(4, false) ^ this.roundkey[1]!;
		let s2 = this.inView.getUint32(8, false) ^ this.roundkey[2]!;
		let s3 = this.inView.getUint32(12, false) ^ this.roundkey[3]!;

		// Store input for CBC XOR later
		const temp0 = this.inView.getUint32(0, false);
		const temp1 = this.inView.getUint32(4, false);
		const temp2 = this.inView.getUint32(8, false);
		const temp3 = this.inView.getUint32(12, false);

		let t0, t1, t2, t3;

		// Rounds 1-9
		for (let round = 1; round < 10; round++) {
			const offset = round * 4;
			t0 = Td0[s0 >>> 24]!
				^ Td1[(s3 >>> 16) & 0xff]!
				^ Td2[(s2 >>> 8) & 0xff]!
				^ Td3[s1 & 0xff]!
				^ this.roundkey[offset]!;
			t1 = Td0[s1 >>> 24]!
				^ Td1[(s0 >>> 16) & 0xff]!
				^ Td2[(s3 >>> 8) & 0xff]!
				^ Td3[s2 & 0xff]!
				^ this.roundkey[offset + 1]!;
			t2 = Td0[s2 >>> 24]!
				^ Td1[(s1 >>> 16) & 0xff]!
				^ Td2[(s0 >>> 8) & 0xff]!
				^ Td3[s3 & 0xff]!
				^ this.roundkey[offset + 2]!;
			t3 = Td0[s3 >>> 24]!
				^ Td1[(s2 >>> 16) & 0xff]!
				^ Td2[(s1 >>> 8) & 0xff]!
				^ Td3[s0 & 0xff]!
				^ this.roundkey[offset + 3]!;

			s0 = t0;
			s1 = t1;
			s2 = t2;
			s3 = t3;
		}

		// Final Round (10)
		const f0 = (Td4[(s0 >>> 24) & 0xff]! & 0xff000000)
			^ (Td4[(s3 >>> 16) & 0xff]! & 0x00ff0000)
			^ (Td4[(s2 >>> 8) & 0xff]! & 0x0000ff00)
			^ (Td4[(s1 >>> 0) & 0xff]! & 0x000000ff)
			^ this.roundkey[40]!;
		const f1 = (Td4[(s1 >>> 24) & 0xff]! & 0xff000000)
			^ (Td4[(s0 >>> 16) & 0xff]! & 0x00ff0000)
			^ (Td4[(s3 >>> 8) & 0xff]! & 0x0000ff00)
			^ (Td4[(s2 >>> 0) & 0xff]! & 0x000000ff)
			^ this.roundkey[41]!;
		const f2 = (Td4[(s2 >>> 24) & 0xff]! & 0xff000000)
			^ (Td4[(s1 >>> 16) & 0xff]! & 0x00ff0000)
			^ (Td4[(s0 >>> 8) & 0xff]! & 0x0000ff00)
			^ (Td4[(s3 >>> 0) & 0xff]! & 0x000000ff)
			^ this.roundkey[42]!;
		const f3 = (Td4[(s3 >>> 24) & 0xff]! & 0xff000000)
			^ (Td4[(s2 >>> 16) & 0xff]! & 0x00ff0000)
			^ (Td4[(s1 >>> 8) & 0xff]! & 0x0000ff00)
			^ (Td4[(s0 >>> 0) & 0xff]! & 0x000000ff)
			^ this.roundkey[43]!;

		// CBC XOR and output
		this.outView.setUint32(0, f0 ^ this.iv[0]!, false);
		this.outView.setUint32(4, f1 ^ this.iv[1]!, false);
		this.outView.setUint32(8, f2 ^ this.iv[2]!, false);
		this.outView.setUint32(12, f3 ^ this.iv[3]!, false);

		// Update IV for next block
		this.iv[0] = temp0;
		this.iv[1] = temp1;
		this.iv[2] = temp2;
		this.iv[3] = temp3;
	}
}

export const createAesDecryptStream = (reader: Reader, getInit: () => MaybePromise<Aes128CbcContextInit>) => {
	let initted = false;
	let pos = 0;
	const CHUNK_SIZE = 2 ** 16;
	const BLOCK_SIZE = 16;

	const aesContext = new Aes128CbcContext();

	return new ReadableStream<Uint8Array>({
		pull: async (controller) => {
			if (!initted) {
				aesContext.init(await getInit());
				initted = true;
			}

			const requestedLength = CHUNK_SIZE + BLOCK_SIZE;

			let nextSlice = reader.requestSliceRange(pos, 0, requestedLength);
			if (nextSlice instanceof Promise) nextSlice = await nextSlice;
			if (!nextSlice || nextSlice.length === 0) {
				// Due to padding, this should never happen
				throw new Error('Invalid ciphertext.');
			}

			const sliceLength = nextSlice.length;
			if (sliceLength % 16 !== 0) {
				throw new Error('Invalid ciphertext.');
			}

			const bytesToRead = sliceLength === requestedLength
				? sliceLength - BLOCK_SIZE // Don't read the last block
				: sliceLength;

			const input = readBytes(nextSlice, bytesToRead);
			const output = new Uint8Array(bytesToRead);

			for (let i = 0; i < bytesToRead; i += 16) {
				aesContext.in.set(input.subarray(i, i + 16));
				aesContext.decrypt();
				output.set(aesContext.out, i);
			}

			if (bytesToRead < sliceLength) {
				controller.enqueue(output);
				pos += bytesToRead;
			} else {
				// This is the last chunk
				const paddingLength = output[bytesToRead - 1]!;
				const trimmedOutput = output.subarray(0, bytesToRead - paddingLength); // PKCS#7 padding

				controller.enqueue(trimmedOutput);
				controller.close();
			}
		},
	});
};
