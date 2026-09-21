import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import { Mp4OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { promiseWithResolvers, uint8ArraysAreEqual } from '../../src/misc.js';
import { Writer } from '../../src/writer.js';

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

test.each([1, 4])('Chunked StreamTarget respects backpressure within a packet (HWM=%i)', async (highWaterMark) => {
	const started = promiseWithResolvers();
	const release = promiseWithResolvers();
	let enqueues = 0;
	let added = false;
	const stream = new WritableStream<StreamTargetChunk>({
		async write() {
			started.resolve();
			await release.promise;
		},
	}, {
		highWaterMark,
		size() {
			enqueues++;
			return 1;
		},
	});
	const output = new Output({
		format: new WavOutputFormat(),
		target: new StreamTarget(stream, { chunked: true, chunkSize: 1024 }),
	});
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	const add = source.add(new EncodedPacket(new Uint8Array(64 * 1024), 'key', 0, 32768 / 48000), {
		decoderConfig: { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 },
	}).then(() => { added = true; });

	try {
		await started.promise;
		await setImmediate();
		expect(enqueues).toBe(highWaterMark);
		expect(added).toBe(false);
	} finally {
		release.resolve();
		await add;
		await output.finalize();
	}
});

test('Chunked StreamTarget handles a packet spanning many chunks', async () => {
	const data = Uint8Array.from({ length: 8 * 1024 * 1024 }, (_, i) => i % 251);
	const packet = new EncodedPacket(data, 'key', 0, data.length / 2 / 48000);
	const expected = new BufferTarget();
	const actual = new Uint8Array(data.length + 1024);
	let end = 0;
	const stream = new StreamTarget(new WritableStream<StreamTargetChunk>({
		write(chunk) {
			actual.set(chunk.data, chunk.position);
			end = Math.max(end, chunk.position + chunk.data.length);
		},
	}), { chunked: true, chunkSize: 1024 });

	for (const target of [expected, stream]) {
		const output = new Output({ format: new WavOutputFormat(), target });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		try {
			await source.add(packet, {
				decoderConfig: { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 },
			});
			await output.finalize();
		} finally {
			if (output.state !== 'finalized') {
				await output.cancel();
			}
		}
	}

	expect(uint8ArraysAreEqual(actual.subarray(0, end), new Uint8Array(expected.buffer!))).toBe(true);
});

test('Chunked StreamTarget respects backpressure when finalizing partial chunks', async () => {
	const started = promiseWithResolvers();
	const release = promiseWithResolvers();
	let enqueues = 0;
	let blocked = false;
	let closed = false;
	const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
		async write() {
			if (blocked) {
				started.resolve();
				await release.promise;
			}
		},
		close() { closed = true; },
	}, {
		highWaterMark: 1,
		size() {
			enqueues++;
			return 1;
		},
	}), { chunked: true, chunkSize: 1024 });
	const writer = new Writer(target, false);
	writer.start();
	writer.write(new Uint8Array(2048));
	await writer.flush();
	await setImmediate();

	// Rewrites leave two partial chunks, with two disjoint sections in the second.
	for (const position of [10, 1040, 1050]) {
		writer.seek(position);
		writer.write(new Uint8Array([1]));
	}
	await writer.flush();
	enqueues = 0;
	blocked = true;
	const finalizing = writer.finalize();
	try {
		await started.promise;
		await setImmediate();
		expect(enqueues).toBe(1);
		expect(closed).toBe(false);
	} finally {
		release.resolve();
		await finalizing;
	}
	expect(enqueues).toBe(3);
	expect(closed).toBe(true);
});

test('Chunked StreamTarget preserves the original error while waiting for a write', async () => {
	const failure = new Error('Target write failed');
	const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
		async write() {
			await setImmediate();
			throw failure;
		},
	}), { chunked: true, chunkSize: 1024 });
	const writer = new Writer(target, true);
	writer.start();
	writer.write(new Uint8Array(64 * 1024));
	await expect(writer.flush()).rejects.toBe(failure);
});

test('Chunked StreamTarget preserves overlapping writes across flushes', async () => {
	const expected = new Uint8Array(8192);
	const actual = new Uint8Array(expected.length);
	const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
		async write(chunk) {
			await setImmediate();
			actual.set(chunk.data, chunk.position);
		},
	}), { chunked: true, chunkSize: 1024 });
	const writer = new Writer(target, false);
	writer.start();

	// Cover partial chunks, overwrites of flushed chunks and disjoint sections in a retained chunk.
	const writes = [[0, 6000], [1000, 2000], [6100, 100], [6300, 100], [50, 40], [7000, 500]] as const;
	for (let i = 0; i < writes.length; i++) {
		const [position, length] = writes[i]!;
		const data = new Uint8Array(length).fill(i + 1);
		writer.seek(position);
		writer.write(data);
		expected.set(data, position);
		await writer.flush();
	}
	await writer.finalize();
	expect(uint8ArraysAreEqual(actual, expected)).toBe(true);
});
