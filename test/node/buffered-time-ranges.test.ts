import { expect, test } from 'vitest';
import path from 'node:path';
import nodeFs from 'node:fs/promises';
import { BufferSource, EncodedPacketSink, Input, MP4, StreamSource } from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('InputTrack.getBufferedTimeRanges returns one full end-exclusive media range when the entire MP4 source is buffered', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	const bytes = await nodeFs.readFile(filePath);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: [MP4],
	});

	const track = await input.getPrimaryVideoTrack();
	expect(track).toBeTruthy();
	if (!track) {
		return;
	}

	const bufferedRanges = await track.getBufferedTimeRanges();
	const firstTimestamp = await track.getFirstTimestamp();
	const duration = await track.computeDuration();

	expect(bufferedRanges).toHaveLength(1);
	expect(bufferedRanges[0]!.start).toBeCloseTo(firstTimestamp, 3);
	expect(bufferedRanges[0]!.end).toBeCloseTo(duration, 3);
	expect(bufferedRanges[0]!.start).toBeLessThan(bufferedRanges[0]!.end);
});

test('InputTrack.getBufferedTimeRanges exposes only the fetched media region after a random-access read', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	const bytes = await nodeFs.readFile(filePath);
	const requestedTimestamp = 1.0;
	const distantUnfetchedTimestamp = 4.5; // Near the end of public/video.mp4, outside the first fetched region.

	using input = new Input({
		source: new StreamSource({
			getSize: () => bytes.length,
			read: (start, end) => bytes.subarray(start, end),
			prefetchProfile: 'none',
			maxCacheSize: 1024 * 1024,
		}),
		formats: [MP4],
	});

	const track = await input.getPrimaryVideoTrack();
	expect(track).toBeTruthy();
	if (!track) {
		return;
	}

	expect(await track.getBufferedTimeRanges()).toEqual([]);

	const sink = new EncodedPacketSink(track);
	await sink.getPacket(requestedTimestamp);

	const bufferedRanges = await track.getBufferedTimeRanges();

	expect(bufferedRanges.length).toBeGreaterThan(0);
	expect(
		bufferedRanges.some(range => range.start <= requestedTimestamp && requestedTimestamp < range.end),
	).toBe(true);
	expect(
		bufferedRanges.some(
			range => range.start <= distantUnfetchedTimestamp && distantUnfetchedTimestamp < range.end,
		),
	).toBe(false);
});
