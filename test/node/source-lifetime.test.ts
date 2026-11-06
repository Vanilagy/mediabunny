import { expect, test, vi } from 'vitest';
import {
	BlobSource,
	BufferSource,
	CustomPathedSource,
	CustomSource,
	FilePathSource,
	ReadableStreamSource,
} from '../../src/source.js';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Input, InputDisposedError } from '../../src/input.js';
import { ALL_FORMATS, MP4 } from '../../src/input-format.js';
import { promiseWithResolvers } from '../../src/misc.js';
import { Reader } from '../../src/reader.js';
import * as node from '../../src/node.js';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

vi.mock(import('../../src/node.js'), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		fs: {
			...original.fs,
			open: vi.fn(original.fs.open),
		},
	};
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const videoFilePath = path.join(__dirname, '..', 'public/video.mp4');

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

test.each([
	{ delayed: false, cancelRejects: false },
	{ delayed: false, cancelRejects: true },
	{ delayed: true, cancelRejects: false },
	{ delayed: true, cancelRejects: true },
])('CustomSource disposal (delayed=$delayed, rejects=$cancelRejects)', async ({ delayed, cancelRejects }) => {
	const started = promiseWithResolvers();
	const readResult = promiseWithResolvers<ReadableStream<Uint8Array>>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn(() => {
		if (cancelRejects) {
			throw new Error('Cancel failed');
		}
	});
	const stream = new ReadableStream<Uint8Array>({
		start(value) { controller = value; },
		pull() { started.resolve(); },
		cancel,
	}, { highWaterMark: 0 });
	const dispose = vi.fn();
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => 1024,
			read: () => {
				if (delayed) {
					started.resolve();
					return readResult.promise;
				}
				return stream;
			},
			dispose,
		}),
	});
	const result = input.getFormat().catch((error: unknown) => error);
	await started.promise;
	input.dispose();
	readResult.resolve(stream);
	try {
		expect(await result).toBeInstanceOf(InputDisposedError);
		await setImmediate();
		expect(dispose).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
	} finally {
		if (cancel.mock.calls.length === 0) {
			controller.close();
		}
	}
});

test('CustomSource releases stream readers after successful reads', async () => {
	const bytes = await readFile(path.join(__dirname, '../public/video.mp4'));
	const streams: ReadableStream<Uint8Array>[] = [];
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({
			getSize: () => bytes.length,
			read: (start, end) => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.subarray(start, end));
						controller.close();
					},
				});
				streams.push(stream);
				return stream;
			},
		}),
	});
	expect(await input.getFormat()).toBe(MP4);
	expect(streams.length).toBeGreaterThan(0);
	expect(streams.every(stream => !stream.locked)).toBe(true);
});

test('CustomSource releases stream readers after read errors', async () => {
	const error = new Error('Read failed');
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) { controller.error(error); },
	});
	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomSource({ getSize: () => 1024, read: () => stream }),
	});
	await expect(input.getFormat()).rejects.toBe(error);
	expect(stream.locked).toBe(false);
});

test('FilePathSource disposal while opening', async () => {
	const openedHandles = trackOpenedFileHandles();
	const source = new FilePathSource(videoFilePath);
	const ref = source.ref();

	const slice = new Reader(source).requestSlice(0, 8);
	ref.free();

	await expect(slice).rejects.toBeInstanceOf(InputDisposedError);

	const handles = await openedHandles.get();
	expect(handles.length).toBeGreaterThan(0);
	expect(handles.every(handle => handle.fd === -1)).toBe(true);
});

test('FilePathSource concurrent first reads', async () => {
	const openedHandles = trackOpenedFileHandles();
	const source = new FilePathSource(videoFilePath);
	const ref = source.ref();
	const reader = new Reader(source);

	const [a, b] = await Promise.all([reader.requestSlice(0, 8), reader.requestSlice(100, 8)]);
	expect(a).not.toBeNull();
	expect(b).not.toBeNull();

	ref.free();

	const handles = await openedHandles.get();
	expect(handles.every(handle => handle.fd === -1)).toBe(true);
});

test('FilePathSource garbage collection without refs', async () => {
	const openedHandles = trackOpenedFileHandles();
	let weakSource!: WeakRef<FilePathSource>;

	await (async () => {
		const source = new FilePathSource(videoFilePath);
		weakSource = new WeakRef(source);
		expect(await source.getSize()).toBeGreaterThan(0);
	})();

	await collectGarbage();
	expect(weakSource.deref()).toBeUndefined();

	const handles = await openedHandles.get();
	expect(handles.length).toBeGreaterThan(0);
	expect(handles.every(handle => handle.fd === -1)).toBe(true);
});

const trackOpenedFileHandles = () => {
	const open = vi.mocked(node.fs.open);
	open.mockClear();

	return {
		get: () => Promise.all(open.mock.results.map(result => result.value as Promise<FileHandle>)),
	};
};

const collectGarbage = async () => {
	v8.setFlagsFromString('--expose-gc');
	const gc = vm.runInNewContext('gc') as () => void;

	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setTimeout(resolve, 10));
		gc();
	}
};

test('FilePathSource read events', async () => {
	const source = new FilePathSource(videoFilePath);
	const reads: { start: number; end: number }[] = [];
	source.on('read', read => reads.push(read));

	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(MP4);

	expect(reads.length).toBeGreaterThan(0);
	expect(reads[0]!.start).toBe(0);
});

test('FilePathSource disposal while getting the size', async () => {
	const source = new FilePathSource(videoFilePath);
	const ref = source.ref();

	vi.mocked(node.fs.open).mockImplementationOnce(async (...args) => {
		const handle = await open(...args);
		const stat = handle.stat.bind(handle);

		// Dispose while the stat call is in flight
		return Object.assign(handle, {
			stat: () => {
				const promise = stat();
				ref.free();
				return promise;
			},
		});
	});

	await expect(new Reader(source).requestSlice(0, 8)).rejects.toBeInstanceOf(InputDisposedError);
});

test('ReadableStreamSource disposal before reading', async () => {
	const cancel = vi.fn();
	const source = new ReadableStreamSource(new ReadableStream<Uint8Array>({ cancel }));
	source.ref().free();

	await Promise.resolve();
	expect(cancel).toHaveBeenCalledOnce();
});

test('CustomSource with concurrent initial reads', async () => {
	const getSize = vi.fn(async () => 1000);
	const source = new CustomSource({
		getSize,
		read: (start, end) => new Uint8Array(end - start),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	const slices = await Promise.all([reader.requestSlice(0, 8), reader.requestSlice(100, 8)]);
	expect(slices.every(x => x !== null)).toBe(true);
	expect(getSize).toHaveBeenCalledOnce();
});

test('RangedSource read events', async () => {
	const data = new Uint8Array(2 ** 21);
	const source = new CustomSource({
		getSize: () => data.length,
		read: (start, end) => data.slice(start, end),
	});
	using sourceRef = source.ref();
	const slice = source.slice(2 ** 20, 1000);
	const reads: { start: number; end: number }[] = [];
	slice.on('read', read => reads.push(read));
	using sliceRef = slice.ref();

	expect(await new Reader(sourceRef.source).requestSlice(0, 10)).not.toBeNull();
	expect(await new Reader(sliceRef.source).requestSlice(10, 20)).not.toBeNull();
	expect(reads).toEqual([{ start: 10, end: 30 }]);
});

test('RangedSource longer than its base', async () => {
	const createBase = () => new CustomSource({
		getSize: () => 10,
		read: (start, end) => new Uint8Array(end - start),
	});

	// The specified length is trusted as the size, and data that turns out missing is an error
	using ref = createBase().slice(4, 100).ref();
	expect(await ref.source.getSize()).toBe(100);

	const reader = new Reader(ref.source);
	expect(await reader.requestSlice(0, 4)).not.toBeNull();
	await expect(async () => await reader.requestSlice(4, 4)).rejects.toThrow('Underlying data too short');
	expect(await ref.source.getSize()).toBe(100);
});

test('CustomPathedSource read events', async () => {
	const source = new CustomPathedSource('root', () => new BufferSource(new Uint8Array(100)));
	const reads: { start: number; end: number }[] = [];
	source.on('read', read => reads.push(read));
	using ref = source.ref();

	expect(await new Reader(ref.source).requestSlice(0, 10)).not.toBeNull();
	expect(reads).toEqual([{ start: 0, end: 100 }]);
});

test('CustomPathedSource first read past the end of its root', async () => {
	for (const createRoot of [
		() => new BufferSource(new Uint8Array(3)),
		() => new BlobSource(new Blob([new Uint8Array(3)])),
	]) {
		using ref = new CustomPathedSource('root', createRoot).ref();
		expect(await new Reader(ref.source).requestSlice(0, 12)).toBeNull();
	}

	using emptyRef = new CustomPathedSource('root', () => new BlobSource(new Blob())).ref();
	expect(await emptyRef.source.getSize()).toBe(0);
});

test('CustomSource cancels streams yielding more than requested', async () => {
	const cancel = vi.fn();
	const source = new CustomSource({
		getSize: () => 1000,
		read: start => new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1000 - start));
			},
			cancel,
		}),
	});
	using ref = source.ref();

	expect(await new Reader(ref.source).requestSlice(0, 10)).not.toBeNull();
	expect(cancel).toHaveBeenCalledOnce();
});
