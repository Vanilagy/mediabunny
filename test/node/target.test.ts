import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { AppendOnlyStreamTarget, BufferTarget, FilePathTarget, StreamTarget, Target } from '../../src/target.js';
import { AdtsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Writer } from '../../src/writer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const samplePath = path.join(__dirname, '../public/video.mp4');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabunny-target-'));
afterAll(() => fs.rmSync(tempDir, {
	recursive: true,
	force: true,
}));

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

test('BufferTarget internal buffer transfer on finalize', async () => {
	const target = new BufferTarget();
	target._write(new Uint8Array([1, 2, 3, 4, 5]), 0);
	target._write(new Uint8Array([6, 7]), 3);

	const internalBuffer = target._buffer!;
	await target._finalize();

	expect(internalBuffer).toHaveProperty('detached', true);
	expect(target._buffer).toBeNull();
	expect(target._bytes).toBeNull();

	expect(target.buffer).toHaveProperty('resizable', false);
	expect([...new Uint8Array(target.buffer!)]).toEqual([1, 2, 3, 6, 7]);
});

test('Tracked write starting before the tracked region', () => {
	const writer = new Writer(new BufferTarget(), false);
	writer.start();
	writer.write(new Uint8Array(10));

	writer.startTrackingWrites();
	writer.write(new Uint8Array([1, 2, 3, 4]));
	writer.seek(8);
	writer.write(new Uint8Array([5, 6, 7, 8]));

	const { data, start, end } = writer.stopTrackingWrites();
	expect(start).toBe(10);
	expect(end).toBe(14);
	expect([...data]).toEqual([7, 8, 3, 4]);
});

test('AppendOnlyStreamTarget finalized event', async () => {
	const target = new AppendOnlyStreamTarget(new WritableStream());
	let finalized = false;
	target.on('finalized', () => finalized = true);

	const { output, source } = createAdtsOutput(target);
	await output.start();
	await addPacket(source);
	await output.finalize();

	expect(finalized).toBe(true);
});

test('StreamTarget canceled before start', async () => {
	let closed = false;
	const target = new StreamTarget(new WritableStream({
		close: () => {
			closed = true;
		},
	}));
	const { output } = createAdtsOutput(target);

	await output.cancel();
	expect(closed).toBe(true);
	expect(() => new Writer(target, true)).toThrow('Can\'t create a Writer for a Target that has already been closed.');
});

test('FilePathTarget canceled before start', async () => {
	const target = new FilePathTarget(path.join(tempDir, 'canceled.aac'));
	const { output } = createAdtsOutput(target);

	await output.cancel();

	// Give a leaked file handle the chance to show up
	await new Promise(resolve => setTimeout(resolve, 100));
	expect(target._fileHandle).toBeNull();
});

test('StreamTarget canceled after a write error', async () => {
	const target = new StreamTarget(new WritableStream({
		write: () => {
			throw new Error('Write failed');
		},
	}));
	const { output, source } = createAdtsOutput(target);
	await output.start();
	await addPacket(source);
	await vi.waitFor(() => expect(target._writeError).not.toBeNull());

	await expect(output.cancel()).resolves.toBeUndefined();
});

test('FilePathTarget write error', async () => {
	const target = new FilePathTarget(path.join(tempDir, 'write-error.aac'));
	const { output, source } = createAdtsOutput(target);

	await vi.waitFor(() => expect(target._fileHandle).not.toBeNull());
	const fileHandle = target._fileHandle!;
	vi.spyOn(fileHandle, 'write').mockRejectedValue(new Error('Disk full'));

	await output.start();
	await addPacket(source);
	await expect(output.finalize()).rejects.toThrow('Disk full');
	expect(fileHandle.fd).toBe(-1);
});

test('Chunked StreamTarget with a single write spanning many chunks', async () => {
	let bytesWritten = 0;
	const target = new StreamTarget(new WritableStream({
		write: (chunk) => {
			bytesWritten += chunk.data.byteLength;
		},
	}), {
		chunked: true,
		chunkSize: 1024,
	});
	const writer = new Writer(target, true);
	writer.start();
	writer.write(new Uint8Array(1024 * 50_000));
	await writer.flush();
	await writer.finalize();

	expect(bytesWritten).toBe(1024 * 50_000);
});

const createAdtsOutput = (target: Target) => {
	const output = new Output({
		format: new AdtsOutputFormat(),
		target,
	});
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);

	return {
		output,
		source,
	};
};

const addPacket = (source: EncodedAudioPacketSource) => {
	return source.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 0.02), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
		},
	});
};
