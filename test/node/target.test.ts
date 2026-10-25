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

test('BufferTarget releases its growth buffer on finalization', async () => {
	const target = new BufferTarget();
	const data = new Uint8Array(100_000).fill(42);
	target._write(data, 0);
	target._write(new Uint8Array([1, 2, 3]), 10);
	data.set([1, 2, 3], 10);

	await target._finalize();
	expect(target.buffer!.byteLength).toBe(data.byteLength);
	expect(new Uint8Array(target.buffer!)).toEqual(data);

	const backingBuffers = new Set([target.buffer!, target._buffer, target._bytes.buffer]);
	const retainedBytes = [...backingBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
	expect(retainedBytes).toBe(target.buffer!.byteLength);
});
