import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

test('BufferTarget onFinalize callback', async () => {
	let received: ArrayBuffer | null = null;
	let asyncCallbackDone = false;

	using input = new Input({
		source: new FilePathSource(samplePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget({
			onFinalize: async (buffer) => {
				received = buffer;
				await new Promise(resolve => setTimeout(resolve, 20));
				asyncCallbackDone = true;
			},
		}),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	expect(received).not.toBeNull();
	expect(received).toBe(output.target.buffer);
	expect(asyncCallbackDone).toBe(true);
	expect(output.target.buffer!.byteLength).toBeGreaterThan(0);
});

const writeSample = (target: BufferTarget) => {
	const data = new Uint8Array(100_000).fill(42);
	target._write(data, 0);
	target._write(new Uint8Array([1, 2, 3]), 10);
	data.set([1, 2, 3], 10);
	return data;
};

const retainedBytes = (target: BufferTarget) => {
	const backingBuffers = new Set([target.buffer!, target._buffer, target._bytes.buffer]);
	return [...backingBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
};

test('BufferTarget finalizes by transferring a fixed-length buffer', async () => {
	let seen: ArrayBuffer | null = null;
	let detachedDuringCallback = false;

	const target = new BufferTarget({
		onFinalize: (buffer) => {
			seen = buffer;
			detachedDuringCallback = growthBuffer.byteLength === 0;
		},
	});
	const data = writeSample(target);
	const growthBuffer = target._buffer;

	await target._finalize();

	expect(detachedDuringCallback).toBe(true);
	expect(seen).toBe(target.buffer);
	expect(target.buffer!.byteLength).toBe(data.byteLength);
	expect(new Uint8Array(target.buffer!)).toEqual(data);
	expect(target._getSlice(10, 13)).toEqual(new Uint8Array([1, 2, 3]));
	expect(retainedBytes(target)).toBe(data.byteLength);
	expect(new Uint8Array(structuredClone(target.buffer!))).toEqual(data);
	expect(growthBuffer.byteLength).toBe(0);
});

test('BufferTarget finalize copies when transfer is unavailable', async () => {
	const prototype = ArrayBuffer.prototype as ArrayBuffer & {
		transferToFixedLength?: (byteLength?: number) => ArrayBuffer;
	};
	const transferToFixedLength = prototype.transferToFixedLength;
	delete prototype.transferToFixedLength;

	try {
		const target = new BufferTarget();
		const data = writeSample(target);
		const growthBuffer = target._buffer;

		await target._finalize();

		expect(target.buffer!.byteLength).toBe(data.byteLength);
		expect(new Uint8Array(target.buffer!)).toEqual(data);
		expect(target._getSlice(10, 13)).toEqual(new Uint8Array([1, 2, 3]));
		expect(target.buffer).not.toBe(growthBuffer);
		expect(retainedBytes(target)).toBe(data.byteLength);
		expect(growthBuffer.byteLength).toBeGreaterThan(0);
		expect(new Uint8Array(growthBuffer).subarray(0, data.byteLength)).toEqual(data);
		expect(new Uint8Array(structuredClone(target.buffer!))).toEqual(data);
	} finally {
		prototype.transferToFixedLength = transferToFixedLength;
	}
});
