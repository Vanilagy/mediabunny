import { expect, test } from 'vitest';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Reader, readBytes } from '../../src/reader.js';

test('Should be able to load a very small video file via URL (<512 kB)', async () => {
	const source = new UrlSource('/frames.webm');
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	const primaryVideoTrack = await input.getPrimaryVideoTrack();
	if (!primaryVideoTrack) {
		throw new Error('No video track found');
	};

	const duration = await primaryVideoTrack.computeDuration();
	expect(duration).toBeCloseTo(3.33333);
});

test('requestInit with Range', async () => {
	const url = makeRampedUrl();

	const source = new UrlSource(url, {
		requestInit: {
			headers: { Range: 'bytes=10-' },
		},
	});
	const reader = new Reader(source);

	const slice = await reader.requestSlice(0, 5);
	expect(slice).not.toBeNull();

	expect([...readBytes(slice!, 5)]).toEqual([10, 11, 12, 13, 14]);

	expect(reader.fileSize).toBe(256 - 10);

	URL.revokeObjectURL(url);
});

test('Request with Range', async () => {
	const url = makeRampedUrl();

	const request = new Request(url, {
		headers: { Range: 'bytes=20-29' },
	});

	const source = new UrlSource(request);
	const reader = new Reader(source);

	const slice = await reader.requestSlice(2, 4);
	expect(slice).not.toBeNull();

	expect([...readBytes(slice!, 4)]).toEqual([22, 23, 24, 25]);

	expect(reader.fileSize).toBe(10);

	expect(await reader.requestSlice(8, 4)).toBeNull();

	URL.revokeObjectURL(url);
});

const CHUNK_SIZE = 1024;
const NO_RANGE_DATA_SIZE = 16 * CHUNK_SIZE;

const makeNoRangeFetch = (data: Uint8Array, onFetch: () => void) => {
	return (async () => {
		onFetch();

		// Always respond with the full resource, ignoring any Range header
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let pos = 0; pos < data.length; pos += CHUNK_SIZE) {
					controller.enqueue(data.subarray(pos, pos + CHUNK_SIZE));
				}
				controller.close();
			},
		});

		return new Response(stream, {
			status: 200,
			headers: { 'Content-Length': String(data.length) },
		});
	}) as typeof fetch;
};

const makeNoRangeData = () => {
	const data = new Uint8Array(NO_RANGE_DATA_SIZE);
	for (let i = 0; i < data.length; i++) {
		data[i] = i % 256;
	}
	return data;
};

test('Explicitly set maxCacheSize is honored when the server does not support range requests', async () => {
	const data = makeNoRangeData();
	let fetchCount = 0;

	const source = new UrlSource('https://example.com/no-range-support', {
		maxCacheSize: 4 * CHUNK_SIZE,
		fetchFn: makeNoRangeFetch(data, () => fetchCount++),
	});
	const reader = new Reader(source);

	// Read the entire resource sequentially, which engages the fallback
	const full = await reader.requestSlice(0, data.length);
	expect(full).not.toBeNull();
	expect([...readBytes(full!, data.length)]).toEqual([...data]);

	// The explicit cache bound must have been kept, meaning early data got evicted during the sequential read
	expect(source._orchestrator.options.maxCacheSize).toBe(4 * CHUNK_SIZE);

	// A backward read to evicted data must still return correct bytes, but requires re-downloading the resource
	const before = fetchCount;
	const slice = await reader.requestSlice(0, CHUNK_SIZE);
	expect(slice).not.toBeNull();
	expect([...readBytes(slice!, CHUNK_SIZE)]).toEqual([...data.subarray(0, CHUNK_SIZE)]);
	expect(fetchCount).toBe(before + 1);
});

test('Default cache bound is lifted when the server does not support range requests', async () => {
	const data = makeNoRangeData();
	let fetchCount = 0;

	const source = new UrlSource('https://example.com/no-range-support', {
		fetchFn: makeNoRangeFetch(data, () => fetchCount++),
	});
	const reader = new Reader(source);

	// Read the entire resource sequentially, which engages the fallback
	const full = await reader.requestSlice(0, data.length);
	expect(full).not.toBeNull();
	expect([...readBytes(full!, data.length)]).toEqual([...data]);

	// With no explicit cache bound, the cache must have been made unbounded to avoid re-downloads
	expect(source._orchestrator.options.maxCacheSize).toBe(Infinity);

	// A backward read is then served from the cache without an additional request
	const slice = await reader.requestSlice(0, CHUNK_SIZE);
	expect(slice).not.toBeNull();
	expect([...readBytes(slice!, CHUNK_SIZE)]).toEqual([...data.subarray(0, CHUNK_SIZE)]);
	expect(fetchCount).toBe(1);
});

const makeRampedUrl = () => {
	const data = new Uint8Array(256);
	for (let i = 0; i < data.length; i++) {
		data[i] = i;
	}

	const blob = new Blob([data.buffer]);
	return URL.createObjectURL(blob);
};
