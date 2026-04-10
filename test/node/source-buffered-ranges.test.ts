import { expect, test } from 'vitest';
import { BufferSource, ReadableStreamSource, StreamSource } from '../../src/source.js';

test('BufferSource exposes the entire backing buffer as one end-exclusive buffered byte range', () => {
	const source = new BufferSource(new Uint8Array(16));

	expect(source.getBufferedByteRanges()).toEqual([{ start: 0, end: 16 }]);
});

test('StreamSource exposes only the currently retained cached byte range, not unread regions', async () => {
	const bytes = new Uint8Array(16).map((_, index) => index);
	const source = new StreamSource({
		getSize: () => bytes.length,
		read: (start, end) => bytes.slice(start, end),
		prefetchProfile: 'none',
	});

	await source.getSize();
	expect(source.getBufferedByteRanges()).toEqual([]);

	await source._read(4, 8);

	expect(source.getBufferedByteRanges()).toEqual([{ start: 4, end: 8 }]);
	expect(source.getBufferedByteRanges()).not.toContainEqual({ start: 8, end: 16 });
});

test('ReadableStreamSource reports retained cached chunks as end-exclusive byte ranges in stream order', async () => {
	const source = new ReadableStreamSource(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([0, 1, 2, 3]));
			controller.enqueue(new Uint8Array([4, 5, 6, 7]));
			controller.close();
		},
	}));

	expect(source.getBufferedByteRanges()).toEqual([]);

	await source._read(0, 6);

	expect(source.getBufferedByteRanges()).toEqual([
		{ start: 0, end: 4 },
		{ start: 4, end: 8 },
	]);
	expect(source.getBufferedByteRanges()).not.toContainEqual({ start: 0, end: 6 });
});
