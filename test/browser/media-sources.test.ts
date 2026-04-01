import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';
import { QUALITY_MEDIUM } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { InputVideoTrack } from '../../src/input-track.js';

test('VideoSampleSource.close() should be idempotent after finalize()', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		bitrate: QUALITY_MEDIUM,
	});

	output.addVideoTrack(videoSource);
	await output.start();

	const canvas = new OffscreenCanvas(100, 100);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 100, 100);

	const sample = new VideoSample(canvas, { timestamp: 0, duration: 1 / 30 });
	await videoSource.add(sample);
	sample.close();

	await output.finalize();

	videoSource.close(); // This previously threw
});

test('Changing input dimensions throws with deny (default)', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		bitrate: QUALITY_MEDIUM,
	});

	output.addVideoTrack(videoSource);
	await output.start();

	const sample1 = new VideoSample(makeCanvas(100, 100), { timestamp: 0, duration: 1 / 30 });
	await videoSource.add(sample1);
	sample1.close();

	const sample2 = new VideoSample(makeCanvas(200, 150), { timestamp: 1 / 30, duration: 1 / 30 });
	await expect(videoSource.add(sample2)).rejects.toThrow(/Video sample size must remain constant/);
	sample2.close();

	videoSource.close();
});

test('Changing input dimensions with passThrough preserves per-frame dimensions', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, sizeChangeBehavior: 'passThrough' },
		[{ width: 100, height: 100 }, { width: 200, height: 150 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	expect(samples[0]).toMatchObject({ codedWidth: 100, codedHeight: 100 });
	expect(
		// Either are valid; WebCodecs encoders don't like changing dimensions sometimes
		(samples[1]!.codedWidth === 100 && samples[1]!.codedHeight === 100)
		|| (samples[1]!.codedWidth === 200 && samples[1]!.codedHeight === 150),
	).toBe(true);
});

test('Changing input dimensions with fill/contain/cover locks output to first frame dimensions', async () => {
	for (const behavior of ['fill', 'contain', 'cover'] as const) {
		const buffer = await encodeFrames(
			{ codec: 'vp8', bitrate: QUALITY_MEDIUM, sizeChangeBehavior: behavior },
			[{ width: 100, height: 100 }, { width: 200, height: 150 }],
		);

		const { input, track } = await readBackTrack(buffer);
		expect(track.codedWidth).toBe(100);
		expect(track.codedHeight).toBe(100);
		input.dispose();
	}
});

test('Same-sized frames with width and height set', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { width: 50, height: 80, fit: 'fill' } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(track.codedWidth).toBe(50);
	expect(track.codedHeight).toBe(80);
	input.dispose();
});

test('Same-sized frames with rotation set to 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { rotate: 90 } },
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(track.codedWidth).toBe(100);
	expect(track.codedHeight).toBe(200);
	input.dispose();
});

test('Same-sized frames with rotation, width and height', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { rotate: 90, width: 50, height: 80, fit: 'contain' } },
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(track.codedWidth).toBe(50);
	expect(track.codedHeight).toBe(80);
	input.dispose();
});

test('Changing dimensions with passThrough and rotation 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, sizeChangeBehavior: 'passThrough', transform: { rotate: 90 } },
		[{ width: 200, height: 100 }, { width: 300, height: 150 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	expect(samples[0]).toMatchObject({ codedWidth: 100, codedHeight: 200 });
	expect(
		// Either are valid; WebCodecs encoders don't like changing dimensions sometimes
		(samples[1]!.codedWidth === 150 && samples[1]!.codedHeight === 300)
		|| (samples[1]!.codedWidth === 100 && samples[1]!.codedHeight === 200),
	).toBe(true);
});

test('Changing dimensions with passThrough, width and height set', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			sizeChangeBehavior: 'passThrough',
			transform: {
				width: 50,
				height: 80,
				fit: 'fill',
			},
		},
		[{ width: 100, height: 100 }, { width: 200, height: 150 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	// Both frames should be resized to the fixed width/height
	expect(samples[0]).toMatchObject({ codedWidth: 50, codedHeight: 80 });
	expect(samples[1]).toMatchObject({ codedWidth: 50, codedHeight: 80 });
});

test('transform.process identity function', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { process: sample => sample } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(100);
	}
});

test('transform.process manual resize', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			transform: {
				process: (sample) => {
					const canvas = new OffscreenCanvas(60, 40);
					const ctx = canvas.getContext('2d')!;
					sample.draw(ctx, 0, 0, 60, 40);
					sample.close();

					return new VideoSample(canvas, {
						timestamp: sample.timestamp,
						duration: sample.duration,
					});
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(track.codedWidth).toBe(60);
	expect(track.codedHeight).toBe(40);
	input.dispose();
});

test('transform.process receives pre-transformed frames', async () => {
	const receivedDimensions: { width: number; height: number }[] = [];

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			transform: {
				width: 50,
				height: 80,
				fit: 'fill',
				process: (sample) => {
					receivedDimensions.push({
						width: sample.codedWidth,
						height: sample.codedHeight,
					});
					return sample;
				},
			},
		},
		[{ width: 200, height: 200 }, { width: 200, height: 200 }],
	);

	expect(receivedDimensions).toHaveLength(2);
	for (const dim of receivedDimensions) {
		expect(dim.width).toBe(50);
		expect(dim.height).toBe(80);
	}

	const { input, track } = await readBackTrack(buffer);
	expect(track.codedWidth).toBe(50);
	expect(track.codedHeight).toBe(80);
	input.dispose();
});

test('transform.process drops all frames after the first', async () => {
	let frameIndex = 0;

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			transform: {
				process: (sample) => {
					if (frameIndex++ > 0) {
						return null;
					}
					return sample;
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(1);
});

test('transform.process expands every frame into two', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			transform: {
				process: (sample) => {
					const t = sample.timestamp;
					const d = sample.duration;
					const clone = sample.clone();
					clone.setTimestamp(2 * t);
					clone.setDuration(d);
					const clone2 = sample.clone();
					clone2.setTimestamp(2 * t + d);
					clone2.setDuration(d);
					return [clone, clone2];
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(6);

	const d = 1 / 30;
	for (let i = 0; i < 6; i++) {
		expect(samples[i]!.timestamp).toBe(i * d);
		expect(samples[i]!.duration).toBe(d);
	}
});

test('transform.frameRate normalizes variable-rate input to fixed rate', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.15 },
			{ width: 100, height: 100, timestamp: 0.15, duration: 0.1 },
			{ width: 100, height: 100, timestamp: 0.25, duration: 0.05 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (let i = 0; i < 3; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBeCloseTo(0.1);
	}
});

test('transform.frameRate pads gaps by repeating last frame', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.1 },
			{ width: 100, height: 100, timestamp: 0.3, duration: 0.1 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(4);
	for (let i = 0; i < 4; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBeCloseTo(0.1);
	}
});

test('transform.frameRate deduplicates frames in the same slot', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.03 },
			{ width: 100, height: 100, timestamp: 0.03, duration: 0.03 },
			{ width: 100, height: 100, timestamp: 0.06, duration: 0.04 },
			{ width: 100, height: 100, timestamp: 0.1, duration: 0.1 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
	expect(samples[0]!.timestamp).toBe(0);
	expect(samples[1]!.timestamp).toBeCloseTo(0.1);
});

test('transform.frameRate final padding fills remaining duration', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.5 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(5);
	for (let i = 0; i < 5; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
	}
});

test('transform.frameRate skipping and padding combined', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { frameRate: 10 } },
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.02 },
			{ width: 100, height: 100, timestamp: 0.02, duration: 0.02 },
			{ width: 100, height: 100, timestamp: 0.04, duration: 0.02 },
			{ width: 100, height: 100, timestamp: 0.3, duration: 0.05 },
			{ width: 100, height: 100, timestamp: 0.35, duration: 0.05 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(4);
	for (let i = 0; i < 4; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBeCloseTo(0.1);
	}
});

test('transform.frameRate works with transform', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			transform: { width: 50, height: 50, fit: 'fill', frameRate: 10 },
		},
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.3 },
		],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (let i = 0; i < 3; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(i * 0.1);
		expect(samples[i]!.duration).toBe(0.1);
		expect(samples[i]!.codedWidth).toBe(50);
		expect(samples[i]!.codedHeight).toBe(50);
	}
});

test('transform.frameRate works with process', async () => {
	const processedTimestamps: number[] = [];

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			bitrate: QUALITY_MEDIUM,
			transform: {
				frameRate: 10,
				process: (sample) => {
					processedTimestamps.push(sample.timestamp);

					const canvas = new OffscreenCanvas(60, 40);
					const ctx = canvas.getContext('2d')!;
					sample.draw(ctx, 0, 0, 60, 40);

					return new VideoSample(canvas, {
						timestamp: sample.timestamp,
						duration: sample.duration,
					});
				},
			},
		},
		[
			{ width: 100, height: 100, timestamp: 0, duration: 0.3 },
		],
	);

	expect(processedTimestamps).toHaveLength(3);
	for (let i = 0; i < 3; i++) {
		expect(processedTimestamps[i]).toBeCloseTo(i * 0.1);
	}

	const { input, track } = await readBackTrack(buffer);
	expect(track.codedWidth).toBe(60);
	expect(track.codedHeight).toBe(40);

	input.dispose();
});

const makeCanvas = (width: number, height: number) => {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, width, height);
	return canvas;
};

const encodeFrames = async (
	encodingConfig: ConstructorParameters<typeof VideoSampleSource>[0],
	frames: { width: number; height: number; timestamp?: number; duration?: number }[],
) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource(encodingConfig);
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < frames.length; i++) {
		const f = frames[i]!;
		const canvas = makeCanvas(f.width, f.height);
		const sample = new VideoSample(canvas, {
			timestamp: f.timestamp ?? i / 30,
			duration: f.duration ?? 1 / 30,
		});
		await videoSource.add(sample);
		sample.close();
	}

	await output.finalize();
	return output.target.buffer!;
};

const readBackTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack() as InputVideoTrack;
	assert(track);

	return { input, track };
};

const readBackSamples = async (buffer: ArrayBuffer) => {
	const { input, track } = await readBackTrack(buffer);
	const sink = new VideoSampleSink(track);
	const samples: { codedWidth: number; codedHeight: number; timestamp: number; duration: number }[] = [];

	for await (using sample of sink.samples()) {
		samples.push({
			codedWidth: sample.codedWidth,
			codedHeight: sample.codedHeight,
			timestamp: sample.timestamp,
			duration: sample.duration,
		});
	}

	input.dispose();
	return samples;
};
