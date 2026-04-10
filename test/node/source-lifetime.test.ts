import { expect, test } from 'vitest';
import { FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { ALL_FORMATS, MP4 } from '../../src/input-format.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Direct source disposal', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	expect(!source._disposed);

	const ref = source.ref();
	ref.free();
	expect(source._disposed);
});

test('Implicit source disposal', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	const input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(MP4);

	expect(!source._disposed);
	input.dispose();
	expect(source._disposed);
});

test('Implicit source disposal, double input', async () => {
	const filePath = path.join(__dirname, '../public/video.mp4');
	const source = new FilePathSource(filePath);

	const input1 = new Input({
		source,
		formats: ALL_FORMATS,
	});
	const input2 = new Input({
		source,
		formats: ALL_FORMATS,
	});

	expect(await input1.getFormat()).toBe(MP4);
	expect(await input2.getFormat()).toBe(MP4);

	expect(!source._disposed);
	input1.dispose();
	expect(!source._disposed);
	input2.dispose();
	expect(source._disposed);
});
