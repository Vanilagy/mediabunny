import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import {
	audioBufferTransformer,
	AudioSampleCursor,
	canvasTransformer,
	PacketReader,
	VideoSampleCursor,
} from '../../src/cursors.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { promiseIterateAll } from '../../src/misc.js';

test('Sample cursor seeking', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	await using cursor = new VideoSampleCursor(reader);
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
	const cursor = new VideoSampleCursor(reader);
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
	const cursor = new VideoSampleCursor(reader);
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

	const cursor2 = new VideoSampleCursor(reader);
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

test('Sample cursor reset', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	await using cursor = new VideoSampleCursor(reader);

	expect(cursor.closed).toBe(false);

	await cursor.close();
	expect(cursor.closed).toBe(true);

	expect(() => cursor.seekToFirst()).toThrow('cursor has been closed');

	await cursor.reset();
	expect(cursor.closed).toBe(false);

	const firstSample = await cursor.seekToFirst();
	expect(firstSample).not.toBe(null);

	await cursor.close();
	await cursor.reset();

	const nextSample = await cursor.next();
	expect(nextSample).not.toBe(null);
	expect(nextSample!.timestamp).toBe(firstSample!.timestamp);

	// Absolutely deranged usage, but it's gotta work!
	const commands = [
		cursor.next(),
		cursor.close(),
		cursor.reset(),
		cursor.next(),
		cursor.next(),
		cursor.reset(),
		cursor.next(),
	];

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const results = await Promise.all(commands);

	expect(cursor.closed).toBe(false);
	expect(results[0]!.timestamp).toBeGreaterThan(firstSample!.timestamp);
	expect(results[3]!.timestamp).toBe(firstSample!.timestamp);
	expect(results[4]!.timestamp).toBe(results[0]!.timestamp);
	expect(results[6]!.timestamp).toBe(firstSample!.timestamp);

	await using cursor2 = new VideoSampleCursor(reader);
	cursor2.debugInfo.enabled = true;

	// Test if queueing a reset makes the decoder decode minimally many packets
	const commands2 = [
		cursor2.seekToFirst(),
		cursor2.reset(),
	];

	// eslint-disable-next-line @typescript-eslint/await-thenable
	await Promise.all(commands2);

	expect(cursor2.debugInfo.decodedPackets).toHaveLength(1);
});

test('Decoder setup error & reset', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	await using cursor1 = new VideoSampleCursor(reader);
	cursor1.debugInfo.enabled = true;
	cursor1.debugInfo.throwInDecoderInit = true;
	expect(cursor1.closed).toBe(false);

	await expect(cursor1.seekToFirst()).rejects.toThrow('Fake decoder init error');

	expect(cursor1.closed).toBe(true);

	expect(() => cursor1.seekToFirst()).toThrow('Fake decoder init error'); // Bricked

	await expect(cursor1.reset()).rejects.toThrow('Fake decoder init error');
	expect(cursor1.closed).toBe(true);

	cursor1.debugInfo.throwInDecoderInit = false;
	await cursor1.reset();
	expect(cursor1.closed).toBe(false);

	const firstSample = (await cursor1.seekToFirst())!;
	expect(firstSample).not.toBe(null);

	// Let's test directly closing after opening
	const cursor2 = new VideoSampleCursor(reader);
	cursor2.debugInfo.enabled = true;
	cursor2.debugInfo.throwInDecoderInit = true;
	await cursor2.close();
});

test('Decoder pump error handling & reset', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = new VideoSampleCursor(reader);
	cursor.debugInfo.enabled = true;

	cursor.debugInfo.throwInPump = true;
	await expect(async () => cursor.seekToFirst()).rejects.toThrow('Fake pump error');

	expect(cursor.closed).toBe(true);
	expect(cursor.current).toBe(null);

	cursor.debugInfo.throwInPump = false;
	await expect(async () => cursor.seekToFirst()).rejects.toThrow('Fake pump error'); // It's bricked

	expect(VideoSample._openSampleCount).toBe(0);

	await cursor.reset();

	const firstSample = await cursor.seekToFirst();
	expect(firstSample!.timestamp).toBe(0);
});

test('Decoder errors & reset', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const cursor1 = new VideoSampleCursor(reader);
	cursor1.debugInfo.enabled = true;
	cursor1.debugInfo.throwDecoderError = true;

	await expect(cursor1.seekToFirst()).rejects.toThrow('Fake decoder error');
	expect(cursor1.closed).toBe(true);

	cursor1.debugInfo.throwDecoderError = false;
	expect(() => cursor1.seekToFirst()).toThrow('Fake decoder error'); // Bricked

	await cursor1.reset();

	const firstSample = await cursor1.seekToFirst();
	expect(firstSample!.timestamp).toBe(0);

	const cursor2 = new VideoSampleCursor(reader);
	cursor2.debugInfo.enabled = true;

	await cursor2.seekToFirst();

	cursor2.debugInfo.throwDecoderError = true;
	await new Promise(resolve => setTimeout(resolve, 200));

	expect(() => cursor2.next()).toThrow('Fake decoder error');
	expect(cursor2.closed).toBe(true);
});

test('Use after close', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const cursor1 = new VideoSampleCursor(reader);

	expect(cursor1.closed).toBe(false);
	await cursor1.close();
	expect(cursor1.closed).toBe(true);

	await expect(async () => await cursor1.seekToFirst()).rejects.toThrow('cursor has been closed');
	await expect(async () => await cursor1.seekTo(0)).rejects.toThrow('cursor has been closed');
	await expect(async () => await cursor1.seekToKey(0)).rejects.toThrow('cursor has been closed');
	await expect(async () => await cursor1.next()).rejects.toThrow('cursor has been closed');

	const cursor2 = new VideoSampleCursor(reader);
	const commands2 = [
		cursor2.seekToFirst(),
		cursor2.next(),
		cursor2.close(),
		cursor2.seekTo(1),
	];

	await expect(commands2[0]).resolves.toBeInstanceOf(VideoSample);
	await expect(commands2[1]).resolves.toBeInstanceOf(VideoSample);
	await expect(commands2[2]).resolves.toBeUndefined();
	await expect(commands2[3]).rejects.toThrow('cursor has been closed');

	expect(cursor2.pumpRunning).toBe(false);
	expect(cursor2.decoder).toBe(null);

	const cursor3 = new VideoSampleCursor(reader);
	const commands3 = [
		cursor3.seekToFirst(),
		cursor3.next(),
		cursor3.close(),
		cursor3.next(),
	];

	await expect(commands3[0]).resolves.toBeInstanceOf(VideoSample);
	await expect(commands3[1]).resolves.toBeInstanceOf(VideoSample);
	await expect(commands3[2]).resolves.toBeUndefined();
	await expect(commands3[3]).rejects.toThrow('cursor has been closed');

	expect(VideoSample._openSampleCount).toBe(0);
});

test('Command queuing', async () => {
	using input = new Input({
		// Fetch the data into RAM to avoid packet lookups causing flaky timing
		source: new BufferSource(await fetch('/trim-buck-bunny.mov').then(x => x.arrayBuffer())),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const cursor0 = new VideoSampleCursor(reader);
	cursor0.debugInfo.enabled = true;

	const commands0 = [
		cursor0.seekToFirst(),
		cursor0.seekToFirst(),
		cursor0.close(),
	];
	expect(commands0.every(x => x instanceof Promise)).toBe(true);

	// eslint-disable-next-line @typescript-eslint/await-thenable
	await Promise.all(commands0);

	expect(cursor0.debugInfo.pumpsStarted).toBe(1);

	const cursor1 = new VideoSampleCursor(reader);
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

	const cursor2 = new VideoSampleCursor(reader);
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

	const cursor3 = new VideoSampleCursor(reader);
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

	const cursor4 = new VideoSampleCursor(reader);
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

	const cursor5 = new VideoSampleCursor(reader);
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

	const cursor6 = new VideoSampleCursor(reader);
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

	const cursor7 = new VideoSampleCursor(reader);
	const commands7 = [
		cursor7.close(),
		cursor7.close(),
	];
	expect(commands7[0]).toBe(commands7[1]); // Same Promise

	await Promise.all(commands7);

	const cursor8 = new VideoSampleCursor(reader, { autoClose: false });

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

test('Automatic cursor disposal', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const cursor = new VideoSampleCursor(reader);
	await cursor.seekToFirst();

	// No cursor.close() here, but the disposed Input closes the cursor
	input.dispose();

	expect(cursor._closed).toBe(true);
});

test('Video with stubborn first sample emit', async () => {
	using input = new Input({
		// For some reason, this video is stubborn in the sense that it takes quite a lot of packets for the decoder to
		// emit its first samples. This used to cause issues in the past where the decoder got stuck, so good to have it
		// tested.
		source: new UrlSource('/sylvie-trimmed.mp4'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	await using cursor = new VideoSampleCursor(reader);

	const firstSample = (await cursor.seekToFirst())!;
	expect(firstSample).not.toBe(null);
	expect(firstSample.timestamp).toBe(0);
});

test('AudioSampleCursor', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const reader = new PacketReader(audioTrack);
	const cursor = new AudioSampleCursor(reader);
	cursor.debugInfo.enabled = true;

	const firstSample = (await cursor.seekToFirst())!;
	expect(firstSample).not.toBe(null);
	expect(firstSample.timestamp).toBe(0);
	expect(firstSample).toBeInstanceOf(AudioSample);

	const secondSample = (await cursor.next())!;
	expect(secondSample.timestamp).toBeCloseTo(firstSample.timestamp + firstSample.duration);

	const thirdSample = (await cursor.seekTo(secondSample.timestamp + 0.05))!;
	expect(thirdSample.timestamp).toBeGreaterThan(secondSample.timestamp);

	expect(cursor.debugInfo.pumpsStarted).toBe(1);

	await cursor.seekToFirst();

	let lastTimestamp = -Infinity;
	let total = 0;
	for await (const sample of cursor) {
		if (total === 0) {
			expect(sample.timestamp).toBe(0);
		}

		expect(sample.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = sample.timestamp;
		total++;
	}

	expect(total).toBe(235);
	expect(lastTimestamp).toBeCloseTo(5, 1);

	expect(cursor.debugInfo.pumpsStarted).toBe(2);

	const middleSample = (await cursor.seekTo(2.5))!;
	expect(middleSample.timestamp).toBeLessThanOrEqual(2.5);
	expect(middleSample.timestamp).toBeGreaterThan(2.4);

	expect(cursor.debugInfo.pumpsStarted).toBe(3);

	const commands = [
		cursor.seekTo(0),
		cursor.seekTo(0.05),
		cursor.seekTo(0.1),
		cursor.seekTo(0.15),
		cursor.seekTo(0.2),
	];

	// eslint-disable-next-line @typescript-eslint/await-thenable
	const result = await Promise.all(commands);

	expect(result[0]!.timestamp).toBeLessThanOrEqual(0);
	expect(result[1]!.timestamp).toBeLessThanOrEqual(0.05);
	expect(result[2]!.timestamp).toBeLessThanOrEqual(0.1);
	expect(result[3]!.timestamp).toBeLessThanOrEqual(0.15);
	expect(result[4]!.timestamp).toBeLessThanOrEqual(0.2);

	// One pump was used for all the above commands, even tho they all seek to different key packets
	expect(cursor.debugInfo.pumpsStarted).toBe(4);

	await cursor.close();

	expect(AudioSample._openSampleCount).toBe(0);
});

test('Sample mapping', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	let callCount = 0;
	await using cursor = new VideoSampleCursor(reader, {
		transform: (sample) => {
			callCount++;

			return {
				original: sample,
				timestampMs: sample.timestamp * 1000,
			};
		},
	});

	const firstSample = (await cursor.seekToFirst())!;
	expect(firstSample.original).toBeInstanceOf(VideoSample);
	expect(firstSample.timestampMs).toBe(0);
	expect(firstSample.original.closed).toBe(false);

	const secondSample = (await cursor.next())!;
	expect(secondSample.original).toBeInstanceOf(VideoSample);
	expect(secondSample.timestampMs).toBeCloseTo(firstSample.timestampMs + firstSample.original.duration * 1000);
	expect(firstSample.original.closed).toBe(true);
	expect(secondSample.original.closed).toBe(false);

	const thirdSample = (await cursor.seekTo(0.5))!;
	expect(thirdSample).not.toBe(null);

	expect(callCount).toBe(3);
});

test('Canvas transformer', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const cursor1 = new VideoSampleCursor(reader, {
		transform: canvasTransformer(),
	});

	const firstSample = (await cursor1.seekToFirst())!;
	expect(firstSample.canvas).toBeInstanceOf(HTMLCanvasElement);
	expect(firstSample.canvas.width).toBe(videoTrack.displayWidth);
	expect(firstSample.canvas.height).toBe(videoTrack.displayHeight);
	expect(firstSample.timestamp).toBe(0);
	expect(firstSample.duration).toBeGreaterThan(0);

	const nextSample = (await cursor1.next())!;
	expect(nextSample.canvas).toBeInstanceOf(HTMLCanvasElement);
	expect(nextSample.timestamp).toBeGreaterThan(firstSample.timestamp);
	expect(nextSample.canvas).not.toBe(firstSample.canvas);

	await cursor1.close();

	const cursor2 = new VideoSampleCursor(reader, {
		transform: canvasTransformer({
			width: 320,
			poolSize: 2,
		}),
	});

	const sample1 = (await cursor2.seekToFirst())!;
	expect(sample1.canvas.width).toBe(320);
	expect(sample1.canvas.height).toBe(180);

	const sample2 = (await cursor2.next())!;
	expect(sample2.canvas.width).toBe(320);
	expect(sample2.canvas.height).toBe(180);
	expect(sample2.canvas).not.toBe(sample1.canvas);

	const sample3 = (await cursor2.next())!;
	const sample4 = (await cursor2.next())!;

	expect(sample3.canvas).toBe(sample1.canvas);
	expect(sample2.canvas).toBe(sample4.canvas);

	await cursor2.close();

	expect(VideoSample._openSampleCount).toBe(0);
});

test('AudioBuffer transformer', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny.mov'),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const reader = new PacketReader(audioTrack);

	const cursor = new AudioSampleCursor(reader, {
		transform: audioBufferTransformer(),
	});

	const firstSample = (await cursor.seekToFirst())!;
	expect(firstSample.buffer).toBeInstanceOf(AudioBuffer);
	expect(firstSample.timestamp).toBe(0);
	expect(firstSample.duration).toBeGreaterThan(0);
	expect(firstSample.buffer.duration).toBe(firstSample.duration);

	const nextSample = (await cursor.next())!;
	expect(nextSample.buffer).toBeInstanceOf(AudioBuffer);
	expect(nextSample.timestamp).toBeGreaterThan(firstSample.timestamp);
	expect(nextSample.buffer).not.toBe(firstSample.buffer);
	expect(nextSample.buffer.duration).toBe(nextSample.duration);

	await cursor.close();

	expect(AudioSample._openSampleCount).toBe(0);
});
