import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { PacketReader, VideoSampleCursor } from '../../src/cursors.js';
import { VideoSample } from '../../src/sample.js';
import { promiseIterateAll } from '../../src/misc.js';

test('Sample cursor seeking', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = await VideoSampleCursor.init(reader);
	cursor.debugInfo.enabled = true;

	expect(cursor.current).toBe(null);
	expect(cursor.debugInfo.pumpsStarted).toBe(0);

	// Seek to start
	const seekToResult1 = cursor.seekToFirst();
	expect(seekToResult1).instanceOf(Promise);
	const sample1 = (await seekToResult1)!;
	expect(sample1).not.toBe(null);
	expect(sample1).toBe(cursor.current);
	expect(sample1.timestamp).toBeLessThanOrEqual(0);
	expect(sample1.closed).toBe(false);

	expect(cursor.debugInfo.pumpsStarted).toBe(1);

	// Seek to a frame in the current GOP
	const seekToResult2 = cursor.seekTo(0.5);
	expect(seekToResult2).instanceOf(Promise);
	const sample2 = (await seekToResult2)!;
	expect(sample2).not.toBe(null);
	expect(sample2).toBe(cursor.current);
	expect(sample2.timestamp).toBeGreaterThan(0);
	expect(sample2.timestamp).toBeLessThanOrEqual(0.5);
	expect(sample2.closed).toBe(false);
	expect(sample1.closed).toBe(true);

	// Wait a little bit so the next sample is most definitely decoded and waiting in the queue
	await new Promise(resolve => setTimeout(resolve, 200));

	const seekToResult3 = cursor.seekTo(0.55);
	expect(seekToResult3).instanceOf(VideoSample); // No promise this time
	const sample3 = (await seekToResult3)!;
	expect(sample3).toBe(cursor.current);
	expect(sample3.timestamp).toBeGreaterThan(0.5);
	expect(sample3.timestamp).toBeLessThanOrEqual(0.55);
	expect(sample3.closed).toBe(false);
	expect(sample2.closed).toBe(true);

	// Let's get the same sample again
	const seekToResult4 = cursor.seekTo(0.55);
	expect(seekToResult4).instanceOf(VideoSample);
	const sample4 = (await seekToResult4)!;
	expect(sample3).toBe(sample4);

	expect(cursor.debugInfo.pumpsStarted).toBe(1);

	// Seek to a different GOP
	const seekToResult5 = cursor.seekTo(2);
	expect(seekToResult5).instanceOf(Promise);
	const sample5 = (await seekToResult5)!;
	expect(sample5).toBe(cursor.current);
	expect(sample5.timestamp).toBeGreaterThan(0.55);
	expect(sample5.timestamp).toBeLessThanOrEqual(2);
	expect(sample5.closed).toBe(false);
	expect(sample3.closed).toBe(true);

	expect(cursor.debugInfo.pumpsStarted).toBe(2);

	// Seek to a frame in the current GOP
	const seekToResult6 = cursor.seekTo(2.5);
	expect(seekToResult6).instanceOf(Promise);
	const sample6 = (await seekToResult6)!;
	expect(sample6).toBe(cursor.current);
	expect(sample6.timestamp).toBeGreaterThan(2);
	expect(sample6.timestamp).toBeLessThanOrEqual(2.5);
	expect(sample6.closed).toBe(false);
	expect(sample5.closed).toBe(true);

	// Seek to a frame in the current GOP, but backwards, requiring decoding to start over
	const seekToResult7 = cursor.seekTo(2.4);
	expect(seekToResult7).instanceOf(Promise);
	const sample7 = (await seekToResult7)!;
	expect(sample7).toBe(cursor.current);
	expect(sample7.timestamp).toBeGreaterThan(2);
	expect(sample7.timestamp).toBeLessThanOrEqual(2.4);
	expect(sample7.closed).toBe(false);
	expect(sample6.closed).toBe(true);

	expect(cursor.debugInfo.pumpsStarted).toBe(3);

	// Seek to a previous GOP
	const seekToResult8 = cursor.seekTo(1);
	expect(seekToResult8).instanceOf(Promise);
	const sample8 = (await seekToResult8)!;
	expect(sample8).toBe(cursor.current);
	expect(sample8.timestamp).toBeLessThanOrEqual(1);
	expect(sample8.closed).toBe(false);
	expect(sample7.closed).toBe(true);

	expect(cursor.debugInfo.pumpsStarted).toBe(4);

	// Seek to past the end
	const seekToResult9 = cursor.seekTo(Infinity);
	expect(seekToResult9).instanceOf(Promise);
	const sample9 = (await seekToResult9)!;
	expect(sample9).toBe(cursor.current);
	expect(sample9.timestamp).toBe(5); // The length of the video
	expect(sample9.closed).toBe(false);
	expect(sample8.closed).toBe(true);

	expect(cursor.debugInfo.pumpsStarted).toBe(5);

	// Seek to before the start
	const seekToResult10 = cursor.seekTo(-Infinity);
	expect(seekToResult10).toBe(null);
	expect(sample9.closed).toBe(true);

	const seekToResult11 = cursor.seekToKey(2.5);
	expect(seekToResult11).toBeInstanceOf(Promise);
	const sample11 = (await seekToResult11)!;
	expect(sample11).toBe(cursor.current);
	expect(sample11.timestamp).toBe(2);
	expect(sample11.closed).toBe(false);

	await cursor.close();

	expect(sample11.closed).toBe(true);
	expect(cursor.current).toBe(null);
	expect(cursor.debugInfo.pumpsStarted).toBe(6);

	await cursor.close();

	expect(VideoSample._openSampleCount).toBe(0);
});

test('Sample cursor advancing', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = await VideoSampleCursor.init(reader);
	cursor.debugInfo.enabled = true;

	expect(cursor.current).toBe(null);
	expect(cursor.debugInfo.pumpsStarted).toBe(0);

	const firstSample = (await cursor.seekToFirst())!;
	const secondSample = (await cursor.next())!;
	const thirdSample = (await cursor.next())!;

	expect(secondSample.timestamp).toBeGreaterThan(firstSample.timestamp);
	expect(thirdSample.timestamp).toBeGreaterThan(secondSample.timestamp);
	expect(firstSample.closed).toBe(true);
	expect(secondSample.closed).toBe(true);
	expect(thirdSample.closed).toBe(false);
	expect(cursor.current).toBe(thirdSample);

	await new Promise(resolve => setTimeout(resolve, 200));

	const fourthSampleResult = cursor.next(); // It's available instantly
	expect(fourthSampleResult).not.toBeInstanceOf(Promise);

	const fourthSample = fourthSampleResult as VideoSample;
	expect(fourthSample.timestamp).toBeGreaterThan(thirdSample.timestamp);

	const lastSample = await cursor.seekTo(5);
	expect(lastSample).not.toBe(null);

	const nextSample = await cursor.next();
	expect(nextSample).toBe(null);
	const nextNextSample = await cursor.next();
	expect(nextNextSample).toBe(null);

	const middleSample = (await cursor.seekTo(3))!;
	const sampleAfterMiddle = (await cursor.next())!;
	expect(sampleAfterMiddle.timestamp).toBeGreaterThan(middleSample.timestamp);

	await cursor.seekTo(-Infinity);
	const firstSampleAgain = (await cursor.next())!;
	expect(firstSampleAgain.timestamp).toBe(firstSample.timestamp);

	let total = 0;
	let lastTimestamp = -Infinity;
	await cursor.iterate((sample) => {
		total++;

		expect(sample.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = sample.timestamp;
	});
	expect(total).toBe(121);
	expect(cursor.current).toBe(null);

	total = 0;
	await cursor.iterate(() => total++);
	expect(total).toBe(0); // Since we're at the end

	await cursor.seekToFirst(); ;
	total = 0;
	await cursor.iterate((sample, stop) => {
		if (sample.timestamp === 1) {
			stop();
			return;
		}

		total++;
	});
	expect(total).toBe(24);
	expect(cursor.current!.timestamp).toBe(1);

	total = 0;
	for await (const sample of cursor) {
		if (total === 0) {
			expect(sample.timestamp).toBe(1);
		}

		total++;
	}

	expect(total).toBe(97);

	await cursor.close();

	expect(cursor.debugInfo.pumpsStarted).toBe(5);

	expect(VideoSample._openSampleCount).toBe(0);
});

test('Sample cursor advancing, cold start', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = await VideoSampleCursor.init(reader);
	cursor.debugInfo.enabled = true;

	const firstSample = (await cursor.next())!;
	expect(firstSample).not.toBe(null);
	expect(firstSample.timestamp).toBe(0);

	const secondSample = (await cursor.next())!;
	expect(secondSample.timestamp).toBeGreaterThan(firstSample.timestamp);

	await cursor.seekTo(-Infinity);

	void cursor.next();
	void cursor.seekTo(2);

	await cursor.close();

	// Ensure the calls were serialized correctly
	expect(cursor.debugInfo.seekPackets.map(x => x?.timestamp ?? null)).toEqual([0, null, 0, 2]);

	const cursor2 = await VideoSampleCursor.init(reader);
	for await (const sample of cursor2) {
		expect(sample.timestamp).toBe(0);
		break;
	}

	await cursor2.iterate((sample, stop) => {
		expect(sample.timestamp).toBe(0);
		stop();
	});

	await cursor2.close();

	expect(VideoSample._openSampleCount).toBe(0);
});

test('Decoder pump error handling', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = await VideoSampleCursor.init(reader);
	cursor.debugInfo.enabled = true;

	cursor.debugInfo.throwInPump = true;
	await expect(cursor.seekToFirst()).rejects.toThrow();

	expect(cursor.current).toBe(null);

	cursor.debugInfo.throwInPump = false;
	const firstPacket = (await cursor.seekToFirst())!;
	expect(firstPacket.timestamp).toBe(0); // It has recovered

	await cursor.close();

	expect(VideoSample._openSampleCount).toBe(0);
});

test('Use after close', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = await VideoSampleCursor.init(reader);

	await cursor.close();

	await expect(async () => await cursor.seekToFirst()).rejects.toThrow();
	await expect(async () => await cursor.seekTo(0)).rejects.toThrow();
	await expect(async () => await cursor.seekToKey(0)).rejects.toThrow();
	await expect(async () => await cursor.next()).rejects.toThrow();
});

test('Command queuing', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const cursor0 = await VideoSampleCursor.init(reader);
	cursor0.debugInfo.enabled = true;

	const commands0 = [
		cursor0.seekToFirst(),
		cursor0.seekToFirst(),
		cursor0.close(),
	];
	expect(commands0.every(x => x instanceof Promise)).toBe(true);

	expect(cursor0.debugInfo.pumpsStarted).toBe(1);

	const cursor1 = await VideoSampleCursor.init(reader);
	cursor1.debugInfo.enabled = true;

	const commands1 = [
		cursor1.seekToFirst(),
		cursor1.close(),
	];
	expect(commands1.every(x => x instanceof Promise)).toBe(true);

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results1 = await Promise.all(commands1);
	expect(results1[0]!.timestamp).toBe(0);
	expect(cursor1.debugInfo.decodedPackets.map(x => x.timestamp)).toEqual([0]);

	const cursor2 = await VideoSampleCursor.init(reader);
	cursor2.debugInfo.enabled = true;

	const commands2 = [
		cursor2.seekTo(0),
		cursor2.seekTo(1),
		cursor2.seekTo(2),
		cursor2.seekTo(3),
		cursor2.seekTo(4),
		cursor2.seekTo(5),
		cursor2.close(),
	];
	expect(commands2.every(x => x instanceof Promise)).toBe(true);

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results2 = await Promise.all(commands2);
	expect(results2[0]!.timestamp).toBe(0);
	expect(results2[1]!.timestamp).toBe(1);
	expect(results2[2]!.timestamp).toBe(2);
	expect(results2[3]!.timestamp).toBe(3);
	expect(results2[4]!.timestamp).toBe(4);
	expect(results2[5]!.timestamp).toBe(5);
	expect(cursor2.debugInfo.decodedPackets.map(x => x.timestamp)).toEqual([
		0, 1, 2, 3, 4, 5,
	]);

	const cursor3 = await VideoSampleCursor.init(reader);
	cursor3.debugInfo.enabled = true;

	const commands3 = [
		cursor3.seekTo(0.5),
		cursor3.seekTo(0.4),
		cursor3.seekTo(0.3),
		cursor3.seekTo(0.2),
		cursor3.seekTo(0.1),
		cursor3.seekTo(0),
		cursor3.close(),
	];
	expect(commands3.every(x => x instanceof Promise)).toBe(true);

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results3 = await Promise.all(commands3);

	expect(results3[0]!.timestamp).toBeLessThanOrEqual(0.5);
	expect(results3[1]!.timestamp).toBeLessThanOrEqual(0.4);
	expect(results3[2]!.timestamp).toBeLessThanOrEqual(0.3);
	expect(results3[3]!.timestamp).toBeLessThanOrEqual(0.2);
	expect(results3[4]!.timestamp).toBeLessThanOrEqual(0.1);
	expect(results3[5]!.timestamp).toBe(0);
	expect(cursor3.debugInfo.decodedPackets.every(x => x.timestamp <= 0.5)).toBe(true);
	expect(cursor3.debugInfo.pumpsStarted).toBe(1);

	const cursor4 = await VideoSampleCursor.init(reader);
	cursor4.debugInfo.enabled = true;

	const commands4 = [
		cursor4.seekToFirst(),
		cursor4.next(),
		cursor4.next(),
		cursor4.close(),
	];

	expect(commands4.every(x => x instanceof Promise)).toBe(true);

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results4 = await Promise.all(commands4);

	expect(results4[0]!.timestamp).toBe(0);
	expect(results4[1]!.timestamp).toBeGreaterThan(results4[0]!.timestamp);
	expect(results4[2]!.timestamp).toBeGreaterThan(results4[1]!.timestamp);
	expect(cursor4.debugInfo.decodedPackets.length).toBeGreaterThan(3); // Because .next() goes into "sequential mode"

	const cursor5 = await VideoSampleCursor.init(reader);
	cursor5.debugInfo.enabled = true;

	const commands5 = [
		cursor5.seekTo(0),
		cursor5.next(),
		cursor5.next(),
		cursor5.seekTo(0.4),
		cursor5.next(),
		cursor5.next(),
		cursor5.seekTo(0.8),
		cursor5.next(),
		cursor5.next(),
		cursor5.seekTo(0),
		cursor5.next(),
		cursor5.close(),
	];

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results5 = await Promise.all(commands5);

	expect(results5[0]!.timestamp).toBe(0);
	expect(results5[1]!.timestamp).toBeGreaterThan(results5[0]!.timestamp);
	expect(results5[2]!.timestamp).toBeGreaterThan(results5[1]!.timestamp);
	expect(results5[3]!.timestamp).toBeLessThanOrEqual(0.4);
	expect(results5[3]!.timestamp).toBeGreaterThan(results5[2]!.timestamp);
	expect(results5[4]!.timestamp).toBeGreaterThan(results5[3]!.timestamp);
	expect(results5[5]!.timestamp).toBeGreaterThan(results5[4]!.timestamp);
	expect(results5[6]!.timestamp).toBeLessThanOrEqual(0.8);
	expect(results5[6]!.timestamp).toBeGreaterThan(results5[5]!.timestamp);
	expect(results5[7]!.timestamp).toBeGreaterThan(results5[6]!.timestamp);
	expect(results5[8]!.timestamp).toBeGreaterThan(results5[7]!.timestamp);
	expect(results5[9]!.timestamp).toBe(0);
	expect(results5[10]!.timestamp).toBeGreaterThan(results5[9]!.timestamp);

	expect(cursor5.debugInfo.pumpsStarted).toBe(1);

	const cursor6 = await VideoSampleCursor.init(reader);
	cursor6.debugInfo.enabled = true;

	const commands6 = [
		cursor6.seekTo(0),
		cursor6.seekTo(0.4),
		cursor6.seekTo(0.8),
		cursor6.seekTo(3.4),
		cursor6.seekTo(3.8),
		cursor6.seekTo(5),
		cursor6.close(),
	];

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results6 = await Promise.all(commands6);

	expect(results6[0]!.timestamp).toBe(0);
	expect(results6[1]!.timestamp).toBeLessThanOrEqual(0.4);
	expect(results6[2]!.timestamp).toBeLessThanOrEqual(0.8);
	expect(results6[3]!.timestamp).toBeLessThanOrEqual(3.4);
	expect(results6[4]!.timestamp).toBeLessThanOrEqual(3.8);
	expect(results6[5]!.timestamp).toBe(5);

	expect(cursor6.debugInfo.pumpsStarted).toBe(3);

	const cursor7 = await VideoSampleCursor.init(reader);
	const commands7 = [
		cursor7.close(),
		cursor7.close(),
	];
	expect(commands7[0]).toBe(commands7[1]); // Same Promise

	await Promise.all(commands7);

	const cursor8 = await VideoSampleCursor.init(reader, { autoClose: false });

	const firstSample = await cursor8.seekToFirst();
	firstSample!.close();
	await new Promise(resolve => setTimeout(resolve, 200));

	const commands8 = [
		cursor8.next(),
		cursor8.next(),
		cursor8.next(),
	];
	expect(commands8.every(x => !(x instanceof Promise))).toBe(true);

	for await (using sample of promiseIterateAll(commands8)) {
		expect(sample!.closed).toBe(false);
	}

	await cursor8.close();

	expect(VideoSample._openSampleCount).toBe(0);
});

// TODO:
// - Test throwing if cursor isn't closed at the end of the test
// - Sample cursor mapping function
// - AudioSampleCursor

// Test Sylvie video?
