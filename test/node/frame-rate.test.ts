import { expect, test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS, Input, FilePathSource, EncodedPacketSink } from '../../src/index.js';
import { findUnderlyingFrameRate } from '../../src/input-track.js';
import { assert } from '../../src/misc.js';

test('findUnderlyingFrameRate with 30 FPS at 30 Hz time resolution', () => {
	const ticks = makeTicks(30, 30);
	expect(findUnderlyingFrameRate(ticks, 30)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz time resolution', () => {
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.floor }), 1000)).toBe(30);
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.round }), 1000)).toBe(30);
	expect(findUnderlyingFrameRate(makeTicks(30, 1000, { quantize: Math.ceil }), 1000)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 30 Hz with dropped frames', () => {
	const ticks = makeTicks(30, 30, { dropFrame: dropSomeFrames });
	expect(findUnderlyingFrameRate(ticks, 30)).toBe(30);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz with dropped frames', () => {
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.floor, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.round, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
	expect(findUnderlyingFrameRate(
		makeTicks(30, 1000, { quantize: Math.ceil, dropFrame: dropSomeFrames }),
		1000,
	)).toBe(30);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 24000 Hz time resolution', () => {
	const ticks = makeTicks(24000 / 1001, 24000);
	expect(findUnderlyingFrameRate(ticks, 24000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 1000 Hz time resolution (1 minute)', () => {
	const frameCount = Math.floor(60 * 24000 / 1001);
	const ticks = makeTicks(24000 / 1001, 1000, { frameCount });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 24/1.001 FPS at 1000 Hz time resolution (60 minutes)', () => {
	const frameCount = Math.floor(3600 * 24000 / 1001);
	const ticks = makeTicks(24000 / 1001, 1000, { frameCount });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(24000 / 1001);
});

test('findUnderlyingFrameRate with 30 FPS at 1000 Hz starting at 1e9 seconds', () => {
	const ticks = makeTicks(30, 1000, { startTime: 1e9 });
	expect(findUnderlyingFrameRate(ticks, 1000)).toBe(30);
});

test('findUnderlyingFrameRate with irregular timestamps yields null', () => {
	const ticks = new Float64Array([0, 0.2, 0.5].map(x => Math.round(x * 100)));
	expect(findUnderlyingFrameRate(ticks, 100)).toBe(null);
});

test('findUnderlyingFrameRate with cursed VFR timestamps yields null', async () => {
	const { ticks, timeResolution } = await getSortedTrackTicks(publicPath('cursed-vfr.mp4'));
	expect(findUnderlyingFrameRate(ticks, timeResolution)).toBe(null);
});

test('computeFrameRateMetrics with constant frame rate video', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();

	expect(metrics.underlyingFrameRate).toBe(25);
	expect(metrics.bestGuessFrameRate).toBe(25);
	expect(metrics.minFrameRate).toBe(25);
	expect(metrics.maxFrameRate).toBe(25);
	expect(metrics.averageFrameRate).toBe(25);
	expect(metrics.medianFrameRate).toBe(25);
	expect(metrics.frameRateIsConstant).toBe(true);
});

test('computeFrameRateMetrics with cursed VFR video', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('cursed-vfr.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const metrics = await videoTrack.computeFrameRateMetrics();

	expect(metrics.underlyingFrameRate).toBe(null);
	expect(metrics.bestGuessFrameRate).toBe(30);
	expect(metrics.minFrameRate).toBe(0.6369426751592356);
	expect(metrics.maxFrameRate).toBe(188.85245901639345);
	expect(metrics.averageFrameRate).toBe(8.664659340979288);
	expect(metrics.medianFrameRate).toBe(30.165016356826754);
	expect(metrics.frameRateIsConstant).toBe(false);
});

const makeTicks = (
	frameRate: number,
	timeResolution: number,
	options: {
		frameCount?: number;
		startTime?: number;
		quantize?: (value: number) => number;
		dropFrame?: (index: number) => boolean;
	} = {},
) => {
	const frameCount = options.frameCount ?? 300;
	const startTime = options.startTime ?? 0;
	const quantize = options.quantize ?? Math.round;

	const ticks: number[] = [];

	for (let i = 0; i < frameCount; i++) {
		if (options.dropFrame?.(i)) {
			continue;
		}

		ticks.push(quantize((startTime + i / frameRate) * timeResolution));
	}

	return new Float64Array(ticks);
};

const dropSomeFrames = (index: number) => index % 11 === 4 || index % 17 === 9;

const getSortedTrackTicks = async (filePath: string) => {
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timeResolution = await videoTrack.getTimeResolution();
	const sink = new EncodedPacketSink(videoTrack);
	const ticks: number[] = [];

	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		ticks.push(Math.round(packet.timestamp * timeResolution));
	}

	ticks.sort((a, b) => a - b);

	const dedupedTicks = ticks.filter((tick, index) => index === 0 || tick !== ticks[index - 1]);

	return { ticks: new Float64Array(dedupedTicks), timeResolution };
};

const __dirname = new URL('.', import.meta.url).pathname;
const publicPath = (file: string) => path.join(__dirname, '../public', file);
