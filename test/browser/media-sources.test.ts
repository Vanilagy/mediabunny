import { expect, test, vi } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WavOutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget, StreamTarget } from '../../src/target.js';
import {
	AudioBufferSource,
	AudioSampleSource,
	MediaStreamAudioTrackSource,
	MediaStreamVideoTrackSource,
	VideoSampleSource,
} from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { assert, promiseWithResolvers, Rotation, toDataView, wait } from '../../src/misc.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

test('VideoSampleSource, normal usage', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium') },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);

	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, .close() should be idempotent after finalize()', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
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

test('VideoSampleSource, changing input dimensions throws with deny (default)', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
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

test('VideoSampleSource, changing input dimensions with passThrough preserves per-frame dimensions', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), sizeChangeBehavior: 'passThrough' },
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

test(
	'VideoSampleSource, changing input dimensions with fill/contain/cover locks output to first frame dimensions',
	async () => {
		for (const behavior of ['fill', 'contain', 'cover'] as const) {
			const buffer = await encodeFrames(
				{ codec: 'vp8', quality: new Quality('medium'), sizeChangeBehavior: behavior },
				[{ width: 100, height: 100 }, { width: 200, height: 150 }],
			);

			const { input, track } = await readBackTrack(buffer);
			expect(await track.getCodedWidth()).toBe(100);
			expect(await track.getCodedHeight()).toBe(100);
			input.dispose();
		}
	},
);

test('VideoSampleSource, same-sized frames with width and height set', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { width: 50, height: 80, fit: 'fill' } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, same-sized frames with rotation set to 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { rotate: 90 } },
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(100);
	expect(await track.getCodedHeight()).toBe(200);
	input.dispose();
});

test('VideoSampleSource, same-sized frames with rotation, width and height', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: { rotate: 90, width: 50, height: 80, fit: 'contain' },
		},
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, changing dimensions with passThrough and rotation 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), sizeChangeBehavior: 'passThrough', transform: { rotate: 90 } },
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

test('VideoSampleSource, changing dimensions with passThrough, width and height set', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
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

test('VideoSampleSource, encoding rotated video frames', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium') },
		[{ width: 200, height: 100, rotation: 90 }, { width: 200, height: 100, rotation: 90 }],
	);

	const samples = await readBackSamples(buffer);

	// They were encoded with no regard for the rotation metadata
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(200);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, flip is baked in via transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { flip: true } },
		[{ width: 200, height: 100, leftHalfBlue: true }, { width: 200, height: 100, leftHalfBlue: true }],
	);

	// After the flip, the blue half is on the right
	const { input, track } = await readBackTrack(buffer);
	const sink = new VideoSampleSink(track);
	using sample = (await sink.getSample(0))!;
	expect(sample.flip).toBe(false);

	const canvas = new OffscreenCanvas(200, 100);
	const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
	sample.draw(ctx, 0, 0);
	const left = ctx.getImageData(50, 50, 1, 1).data;
	const right = ctx.getImageData(150, 50, 1, 1).data;
	expect(left[0]).toBeGreaterThan(200); // red
	expect(right[2]).toBeGreaterThan(200); // blue

	input.dispose();
});

test('VideoSampleSource, encoding flipped video frames with forced transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { force: true } },
		[{ width: 200, height: 100, flip: true, leftHalfBlue: true }],
	);

	const { input, track } = await readBackTrack(buffer);
	const sink = new VideoSampleSink(track);
	using sample = (await sink.getSample(0))!;

	const canvas = new OffscreenCanvas(200, 100);
	const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
	sample.draw(ctx, 0, 0);
	expect(ctx.getImageData(150, 50, 1, 1).data[2]).toBeGreaterThan(200); // blue on the right now

	input.dispose();
});

test('VideoSampleSource, encoding rotated video frames with forced transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { force: true } },
		[{ width: 200, height: 100, rotation: 90 }, { width: 200, height: 100, rotation: 90 }],
	);

	const samples = await readBackSamples(buffer);

	// The rotation has been baked into the samples
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(200);
	}
});

test('VideoSampleSource, transform.process identity function', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { process: sample => sample } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(3);
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(100);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, transform.process manual resize', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				process: (sample) => {
					const canvas = new OffscreenCanvas(60, 40);
					const ctx = canvas.getContext('2d')!;
					sample.draw(ctx, 0, 0, 60, 40);
					sample.close();

					return canvas;
				},
			},
		},
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(60);
	expect(await track.getCodedHeight()).toBe(40);
	input.dispose();
});

test('VideoSampleSource, transform.process receives pre-transformed frames', async () => {
	const receivedDimensions: { width: number; height: number }[] = [];

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
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
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, transform.process drops all frames after the first', async () => {
	let frameIndex = 0;

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
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

test('VideoSampleSource, transform.process expands every frame into two', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
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

test('VideoSampleSource, transform.frameRate normalizes variable-rate input to fixed rate', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
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

test('VideoSampleSource, transform.frameRate pads gaps by repeating last frame', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
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

test('VideoSampleSource, transform.frameRate deduplicates frames in the same slot', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
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

test('VideoSampleSource, transform.frameRate final padding fills remaining duration', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
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

test('VideoSampleSource, transform.frameRate skipping and padding combined', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', quality: new Quality('medium'), transform: { frameRate: 10 } },
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

test('VideoSampleSource, transform.frameRate works with transform', async () => {
	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
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

test('VideoSampleSource, transform.frameRate works with process', async () => {
	const processedTimestamps: number[] = [];

	const buffer = await encodeFrames(
		{
			codec: 'vp8',
			quality: new Quality('medium'),
			transform: {
				frameRate: 10,
				process: (sample) => {
					processedTimestamps.push(sample.timestamp);

					const canvas = new OffscreenCanvas(60, 40);
					const ctx = canvas.getContext('2d')!;
					sample.draw(ctx, 0, 0, 60, 40);

					return canvas;
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
	expect(await track.getCodedWidth()).toBe(60);
	expect(await track.getCodedHeight()).toBe(40);

	input.dispose();
});

const makeCanvas = (width: number, height: number, leftHalfBlue = false) => {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, width, height);

	if (leftHalfBlue) {
		ctx.fillStyle = 'blue';
		ctx.fillRect(0, 0, width / 2, height);
	}

	return canvas;
};

const encodeFrames = async (
	encodingConfig: ConstructorParameters<typeof VideoSampleSource>[0],
	frames: {
		width: number;
		height: number;
		timestamp?: number;
		duration?: number;
		rotation?: Rotation;
		flip?: boolean;
		leftHalfBlue?: boolean;
	}[],
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
		const canvas = makeCanvas(f.width, f.height, f.leftHalfBlue);
		const sample = new VideoSample(canvas, {
			timestamp: f.timestamp ?? i / 30,
			duration: f.duration ?? 1 / 30,
			rotation: f.rotation,
			flip: f.flip,
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

test('VideoSampleSource, fit from sizeChangeBehavior for frames of the original size', async () => {
	const cornerPixels: number[][] = [];

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
		sizeChangeBehavior: 'contain',
		transform: {
			width: 64,
			height: 64,
		},
		onEncodedSample: (sample) => {
			const canvas = new OffscreenCanvas(64, 64);
			const context = canvas.getContext('2d')!;
			sample.draw(context, 0, 0);
			cornerPixels.push([...context.getImageData(5, 5, 1, 1).data]);
		},
	});
	output.addVideoTrack(source);
	await output.start();

	// A white landscape frame, which sets the original size, followed by a portrait one
	const sizes = [[160, 90], [90, 160]] as const;
	for (let i = 0; i < sizes.length; i++) {
		const [width, height] = sizes[i]!;
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'white';
		context.fillRect(0, 0, width, height);

		using sample = new VideoSample(canvas, {
			timestamp: i / 30,
			duration: 1 / 30,
		});
		await source.add(sample);
	}
	await output.finalize();

	// Both are letterboxed, the first one isn't stretched
	expect(cornerPixels).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
});

test('AudioSampleSource, normal usage', async () => {
	const sample = makeSineWave(48000, 2, 1);
	const buffer = await encodeAudio({ codec: 'pcm-s16' }, sample);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.computeDuration()).toBe(1);
	input.dispose();
});

test('AudioSampleSource, remixed to mono', async () => {
	const sample = makeSineWave(48000, 2, 1);
	const buffer = await encodeAudio(
		{ codec: 'pcm-s16', transform: { numberOfChannels: 1 } },
		sample,
	);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(1);
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.computeDuration()).toBe(1);
	input.dispose();
});

test('AudioSampleSource, resampled to 44100 Hz', async () => {
	const sample = makeSineWave(48000, 2, 1);
	const buffer = await encodeAudio(
		{ codec: 'pcm-s16', transform: { sampleRate: 44100 } },
		sample,
	);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.computeDuration()).toBe(1);
	input.dispose();
});

test('AudioSampleSource, resampled stereo with non-zero start timestamp', async () => {
	const sample = makeSineWave(48000, 2, 1, 1);
	const buffer = await encodeAudio(
		{ codec: 'pcm-s16', transform: { numberOfChannels: 2 } },
		sample,
	);

	const { input, track } = await readBackAudioTrack(buffer);
	expect(await track.getNumberOfChannels()).toBe(2);
	expect(await track.getSampleRate()).toBe(48000);

	expect(await track.getFirstTimestamp()).toBe(1);
	expect(await track.computeDuration()).toBe(2);
	input.dispose();
});

const makeSineWave = (
	sampleRate: number,
	numberOfChannels: number,
	durationSeconds: number,
	timestamp = 0,
) => {
	const numberOfFrames = Math.round(sampleRate * durationSeconds);
	const data = new Float32Array(numberOfFrames * numberOfChannels);

	for (let frame = 0; frame < numberOfFrames; frame++) {
		const value = Math.sin(2 * Math.PI * 440 * frame / sampleRate);
		for (let ch = 0; ch < numberOfChannels; ch++) {
			data[frame * numberOfChannels + ch] = value;
		}
	}

	return new AudioSample({
		data,
		format: 'f32-planar',
		sampleRate,
		numberOfChannels,
		numberOfFrames,
		timestamp,
	});
};

const encodeAudio = async (
	encodingConfig: ConstructorParameters<typeof AudioSampleSource>[0],
	sample: AudioSample,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }), // Fragmented to avoid the PCM transformation
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource(encodingConfig);
	output.addAudioTrack(audioSource);
	await output.start();

	await audioSource.add(sample);
	sample.close();

	await output.finalize();
	return output.target.buffer!;
};

const readBackAudioTrack = async (buffer: ArrayBuffer) => {
	const input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack() as InputAudioTrack;
	assert(track);

	return { input, track };
};

test('Delta packets from the encoder on a hasOnlyKeyPackets track', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('medium'),
	});
	// Without a key frame interval of 0, the encoder will also produce delta packets
	output.addVideoTrack(source, { hasOnlyKeyPackets: true });
	await output.start();

	const encode = async () => {
		const canvas = new OffscreenCanvas(64, 64);
		const context = canvas.getContext('2d')!;

		for (let i = 0; i < 5; i++) {
			context.fillStyle = i % 2 === 0 ? 'red' : 'blue';
			context.fillRect(0, 0, 64, 64);

			using sample = new VideoSample(canvas, { timestamp: i / 30, duration: 1 / 30 });
			await source.add(sample);
		}

		await output.finalize();
	};

	await expect(encode()).rejects.toThrow('Cannot add non-key packets');
});

test('Output canceled while the encoder is being created', async () => {
	const encoders: VideoEncoder[] = [];
	const OriginalVideoEncoder = VideoEncoder;
	globalThis.VideoEncoder = class extends OriginalVideoEncoder {
		constructor(init: VideoEncoderInit) {
			super(init);
			encoders.push(this);
		}
	};

	try {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const source = new VideoSampleSource({
			codec: 'vp8',
			quality: new Quality('medium'),
		});
		output.addVideoTrack(source);
		await output.start();

		const canvas = new OffscreenCanvas(64, 64);
		canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
		using sample = new VideoSample(canvas, { timestamp: 0, duration: 1 / 30 });

		// Encoder creation is asynchronous, so this cancels the output while it's still in progress
		const addPromise = source.add(sample);
		await output.cancel();
		await addPromise;

		expect(encoders.length).toBeGreaterThan(0);
		expect(encoders.every(x => x.state === 'closed')).toBe(true);
	} finally {
		globalThis.VideoEncoder = OriginalVideoEncoder;
	}
});

test('Video track paused before its first frame', async () => {
	const uncaughtErrors = collectUncaughtErrors();

	const generator = new MediaStreamTrackGenerator({ kind: 'video' });
	const writer = generator.writable.getWriter();

	const source = new MediaStreamVideoTrackSource(
		generator,
		{ codec: 'vp8', quality: new Quality('low') },
		{ frameRate: 30 },
	);
	const sourceErrors: unknown[] = [];
	source.errorPromise.catch(error => sourceErrors.push(error));
	source.pause();

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	output.addVideoTrack(source);
	await output.start();

	await writer.write(makeVideoFrame(0));
	await wait(100);

	source.resume();
	for (let i = 1; i <= 10; i++) {
		await writer.write(makeVideoFrame(i / 30));
		await wait(1000 / 30);
	}

	await output.finalize();
	generator.stop();
	uncaughtErrors.stop();

	expect(uncaughtErrors.errors).toEqual([]);
	expect(sourceErrors).toEqual([]);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(0);
});

const makeVideoFrame = (timestamp: number) => {
	const canvas = new OffscreenCanvas(64, 64);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 64, 64);

	return new VideoFrame(canvas, { timestamp: 1e6 * timestamp });
};

test('Audio track resampled with a slow target', async () => {
	const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
	const writer = generator.writable.getWriter();

	const encodedSamples: { timestamp: number; numberOfFrames: number }[] = [];
	const source = new MediaStreamAudioTrackSource(
		generator,
		{
			codec: 'pcm-s16',
			transform: { numberOfChannels: 2 },
			onEncodedSample: (sample) => {
				encodedSamples.push({ timestamp: sample.timestamp, numberOfFrames: sample.numberOfFrames });
			},
		},
		{ timestampBase: 'zero' },
	);
	const sourceErrors: unknown[] = [];
	source.errorPromise.catch(error => sourceErrors.push(error));

	let writesBlocked = false;
	const writesUnblocked = promiseWithResolvers();
	const output = new Output({
		format: new WavOutputFormat(),
		target: new StreamTarget(new WritableStream({
			write: async () => {
				if (writesBlocked) {
					await writesUnblocked.promise;
				}
			},
		})),
	});
	output.addAudioTrack(source);
	await output.start();
	writesBlocked = true;

	// 6 seconds of audio. The resampler hands over its first 5 seconds at once, and encoding them is stuck on the
	// target until we finalize, so further samples queue up behind it until the queue is full.
	for (let i = 0; i < 600; i++) {
		await writer.write(new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfChannels: 1,
			numberOfFrames: 480,
			timestamp: 10_000 * i,
			data: new Float32Array(480),
		}));
		await wait(0);
	}
	await wait(200);

	// The resampler's last second only gets handed over when finalizing
	expect(encodedSamples).toEqual([{ timestamp: 0, numberOfFrames: 5 * 48000 }]);

	// The queued samples were captured before finalizing, so they must still make it into the file, while the ones
	// arriving once the queue was full got dropped
	const finalizePromise = output.finalize();
	writesUnblocked.resolve();
	await finalizePromise;
	generator.stop();

	expect(sourceErrors).toEqual([]);
	expect(encodedSamples).toHaveLength(2);
	expect(encodedSamples[1]!.timestamp).toBe(5);
	expect(encodedSamples[1]!.numberOfFrames / 480).toBeCloseTo(8, 0);
});

test('Audio track captured through the audio context fallback', async () => {
	const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
	const writer = generator.writable.getWriter();

	const contexts: AudioContext[] = [];
	const OriginalAudioContext = window.AudioContext;
	window.AudioContext = class extends OriginalAudioContext {
		constructor(options?: AudioContextOptions) {
			super(options);
			contexts.push(this);
		}
	};
	const OriginalProcessor = window.MediaStreamTrackProcessor;
	// @ts-expect-error Simulates a browser without it
	window.MediaStreamTrackProcessor = undefined;

	const source = new MediaStreamAudioTrackSource(generator, { codec: 'pcm-s16' });
	const sourceErrors: unknown[] = [];
	source.errorPromise.catch(error => sourceErrors.push(error));

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	output.addAudioTrack(source);

	try {
		await output.start();
	} finally {
		window.AudioContext = OriginalAudioContext;
		window.MediaStreamTrackProcessor = OriginalProcessor;
	}

	for (let i = 0; i < 50; i++) {
		await writer.write(new AudioData({
			format: 'f32-planar',
			sampleRate: 48000,
			numberOfChannels: 1,
			numberOfFrames: 480,
			timestamp: 10_000 * i,
			data: new Float32Array(480).fill(0.5),
		}));
		await wait(10);
	}

	await output.finalize();
	generator.stop();

	expect(sourceErrors).toEqual([]);
	expect(output.target.buffer!.byteLength).toBeGreaterThan(44);
	expect(contexts.length).toBe(1);
	expect(contexts[0]!.state).toBe('closed');
});

test('Encoder error while an added sample is still being processed', async () => {
	const toAudioDataSpy = vi.spyOn(AudioSample.prototype, 'toAudioData');

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	let processCount = 0;
	const source = new AudioSampleSource({
		codec: 'opus',
		quality: new Quality('medium'),
		transform: {
			process: async (sample) => {
				if (processCount++ === 0) {
					return sample.clone();
				}

				await wait(100);

				// The encoder is configured for stereo, so this makes it error out
				return new AudioSample({
					data: new Float32Array(6 * 960),
					format: 'f32',
					numberOfChannels: 6,
					sampleRate: 48000,
					timestamp: sample.timestamp,
				});
			},
		},
	});
	output.addAudioTrack(source);
	await output.start();

	const errors: string[] = [];
	for (let i = 0; i < 3; i++) {
		using sample = new AudioSample({
			data: new Float32Array(2 * 960),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp: 0.02 * i,
		});
		await source.add(sample).catch((error: Error) => errors.push(error.name));
	}

	const audioDatas = toAudioDataSpy.mock.results.map(result => result.value as AudioData);
	toAudioDataSpy.mockRestore();

	await output.cancel();

	expect(errors).toEqual(['EncodingError']);
	// Closed AudioData has a null format
	expect(audioDatas.filter(audioData => audioData.format !== null)).toEqual([]);
});

test('onEncodedPacket throwing for an encoder-emitted packet', async () => {
	const uncaughtErrors = collectUncaughtErrors();

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({
		codec: 'opus',
		quality: new Quality('medium'),
		onEncodedPacket: () => {
			throw new Error('Callback failed');
		},
	});
	output.addAudioTrack(source);
	await output.start();

	using sample = new AudioSample({
		data: new Float32Array(2 * 48000),
		format: 'f32',
		numberOfChannels: 2,
		sampleRate: 48000,
		timestamp: 0,
	});
	await source.add(sample);

	await expect(output.finalize()).rejects.toThrow('Callback failed');
	uncaughtErrors.stop();

	expect(uncaughtErrors.errors).toEqual([]);
});

const collectUncaughtErrors = () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => {
		errors.push(event.error);
		event.preventDefault();
	};
	window.addEventListener('error', onError);

	return {
		errors,
		stop: () => window.removeEventListener('error', onError),
	};
};

test('Empty audio sample', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({
		codec: 'opus',
		bitrate: 64000,
	});
	output.addAudioTrack(source);
	await output.start();

	for (const [timestamp, numberOfFrames] of [[0, 960], [0.02, 0], [0.02, 960]]) {
		using sample = new AudioSample({
			data: new Float32Array(numberOfFrames!),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: timestamp!,
		});
		await source.add(sample);
	}

	await output.finalize();
});

test('AudioBufferSource with overlapping adds', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioBufferSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();

	// Each buffer gets split into two samples, and is a constant value higher than the one before
	const frameCount = 6 * 48000;
	const buffers = [1, 2].map((value) => {
		const buffer = new AudioBuffer({
			length: frameCount,
			numberOfChannels: 1,
			sampleRate: 48000,
		});
		buffer.getChannelData(0).fill(value / 16);
		return buffer;
	});

	await Promise.all(buffers.map(buffer => source.add(buffer)));
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const values: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		const view = toDataView(packet.data);
		for (let i = 0; i < packet.data.byteLength; i += 2) {
			values.push(view.getInt16(i, true));
		}
	}

	// The buffers' samples must not interleave
	expect(values).toHaveLength(2 * frameCount);
	const firstValues = new Set(values.slice(0, frameCount));
	const secondValues = new Set(values.slice(frameCount));
	expect(firstValues.size).toBe(1);
	expect(secondValues.size).toBe(1);
	expect([...secondValues][0]).toBeGreaterThan([...firstValues][0]!);
});
