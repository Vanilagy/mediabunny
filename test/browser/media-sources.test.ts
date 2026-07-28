import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSampleSource, VideoSampleSource } from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import {
	canEncodeVideo,
	getFirstEncodableVideoCodec,
	Quality,
	QUALITY_MEDIUM,
} from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource } from '../../src/source.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { assert, Rotation } from '../../src/misc.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

test('VideoSampleSource, normal usage', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM },
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

test('VideoSampleSource, changing input dimensions throws with deny (default)', async () => {
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

test('VideoSampleSource, changing input dimensions with passThrough preserves per-frame dimensions', async () => {
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

test(
	'VideoSampleSource, changing input dimensions with fill/contain/cover locks output to first frame dimensions',
	async () => {
		for (const behavior of ['fill', 'contain', 'cover'] as const) {
			const buffer = await encodeFrames(
				{ codec: 'vp8', bitrate: QUALITY_MEDIUM, sizeChangeBehavior: behavior },
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
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { width: 50, height: 80, fit: 'fill' } },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, same-sized frames with rotation set to 90', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { rotate: 90 } },
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(100);
	expect(await track.getCodedHeight()).toBe(200);
	input.dispose();
});

test('VideoSampleSource, same-sized frames with rotation, width and height', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { rotate: 90, width: 50, height: 80, fit: 'contain' } },
		[{ width: 200, height: 100 }, { width: 200, height: 100 }],
	);

	const { input, track } = await readBackTrack(buffer);
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, changing dimensions with passThrough and rotation 90', async () => {
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

test('VideoSampleSource, changing dimensions with passThrough, width and height set', async () => {
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

test('VideoSampleSource, encoding rotated video frames', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM },
		[{ width: 200, height: 100, rotation: 90 }, { width: 200, height: 100, rotation: 90 }],
	);

	const samples = await readBackSamples(buffer);

	// They were encoded with no regard for the rotation metadata
	for (const sample of samples) {
		expect(sample.codedWidth).toBe(200);
		expect(sample.codedHeight).toBe(100);
	}
});

test('VideoSampleSource, encoding rotated video frames with forced transform', async () => {
	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: QUALITY_MEDIUM, transform: { force: true } },
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

test('VideoSampleSource, transform.process manual resize', async () => {
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
	expect(await track.getCodedWidth()).toBe(50);
	expect(await track.getCodedHeight()).toBe(80);
	input.dispose();
});

test('VideoSampleSource, transform.process drops all frames after the first', async () => {
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

test('VideoSampleSource, transform.process expands every frame into two', async () => {
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

test('VideoSampleSource, transform.frameRate normalizes variable-rate input to fixed rate', async () => {
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

test('VideoSampleSource, transform.frameRate pads gaps by repeating last frame', async () => {
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

test('VideoSampleSource, transform.frameRate deduplicates frames in the same slot', async () => {
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

test('VideoSampleSource, transform.frameRate final padding fills remaining duration', async () => {
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

test('VideoSampleSource, transform.frameRate skipping and padding combined', async () => {
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

test('VideoSampleSource, transform.frameRate works with transform', async () => {
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

test('VideoSampleSource, transform.frameRate works with process', async () => {
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

test('Quality, custom quality factors', async () => {
	expect(() => new Quality(0)).toThrow(TypeError);
	expect(() => new Quality(-1)).toThrow(TypeError);
	expect(() => new Quality(NaN)).toThrow(TypeError);
	expect(() => new Quality(Infinity)).toThrow(TypeError);

	const buffer = await encodeFrames(
		{ codec: 'vp8', bitrate: new Quality(1.5) },
		[{ width: 100, height: 100 }, { width: 100, height: 100 }],
	);

	const samples = await readBackSamples(buffer);
	expect(samples).toHaveLength(2);
});

test('VideoSampleSource, quantizer mode config validation', () => {
	// bitrate is optional in quantizer mode
	expect(() => new VideoSampleSource({ codec: 'avc', bitrateMode: 'quantizer' })).not.toThrow();
	// Each codec's scale comes from its codec registration: 0-51 for avc/hevc, 0-63 for vp9, 0-255 for av1
	expect(() => new VideoSampleSource({ codec: 'avc', bitrateMode: 'quantizer', quantizer: 51 })).not.toThrow();
	expect(() => new VideoSampleSource({ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 63 })).not.toThrow();
	expect(() => new VideoSampleSource({ codec: 'av1', bitrateMode: 'quantizer', quantizer: 255 })).not.toThrow();
	expect(() => new VideoSampleSource({ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 64 })).toThrow(TypeError);
	expect(() => new VideoSampleSource({ codec: 'av1', bitrateMode: 'quantizer', quantizer: 256 })).toThrow(TypeError);

	// @ts-expect-error bitrate is required outside of quantizer mode
	expect(() => new VideoSampleSource({ codec: 'avc' })).toThrow(TypeError);
	// Quantizer mode is only supported for avc, hevc, vp9 and av1 (enforced at runtime)
	expect(() => new VideoSampleSource({ codec: 'vp8', bitrateMode: 'quantizer' })).toThrow(TypeError);
	// quantizer requires bitrateMode 'quantizer'; this compiles and is rejected at runtime
	expect(() => new VideoSampleSource({ codec: 'avc', bitrate: 1e6, quantizer: 20 })).toThrow(TypeError);
	expect(() => new VideoSampleSource({
		codec: 'avc',
		bitrateMode: 'quantizer',
		quantizer: 52, // Out of range for avc
	})).toThrow(TypeError);
	expect(() => new VideoSampleSource({
		codec: 'vp9',
		bitrateMode: 'quantizer',
		quantizer: 64, // Out of range for vp9
	})).toThrow(TypeError);
});

test('canEncodeVideo, quantizer mode', async () => {
	expect(typeof await canEncodeVideo('vp9', { bitrateMode: 'quantizer' })).toBe('boolean');
	expect(await canEncodeVideo('vp8', { bitrateMode: 'quantizer' })).toBe(false);

	// Out-of-range quantizers return false instead of throwing, so codec lists can still be probed
	expect(await canEncodeVideo('avc', { bitrateMode: 'quantizer', quantizer: 60 })).toBe(false);
	expect(await canEncodeVideo('vp9', { bitrateMode: 'quantizer', quantizer: 64 })).toBe(false);
	// 60 is out of range for avc but fine for vp9, so we skip past avc
	if (await canEncodeVideo('vp9', { bitrateMode: 'quantizer' })) {
		expect(await getFirstEncodableVideoCodec(['avc', 'vp9'], { bitrateMode: 'quantizer', quantizer: 60 }))
			.toBe('vp9');
	}

	await expect(canEncodeVideo('avc', { bitrate: new Quality(Number.MAX_VALUE) })).rejects.toThrow(TypeError);
});

test('VideoSampleSource, quantizer bitrate mode', async () => {
	// Encoding in quantizer mode must always succeed, even in browsers without support for it, thanks to the
	// automatic fallback to variable bitrate mode
	const lowQuantizerBuffer = await encodeNoisyFrames(
		{ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 8 },
		8,
	);
	const highQuantizerBuffer = await encodeNoisyFrames(
		{ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 60 },
		8,
	);

	expect(await readBackSamples(lowQuantizerBuffer)).toHaveLength(8);
	expect(await readBackSamples(highQuantizerBuffer)).toHaveLength(8);

	if (await canEncodeVideo('vp9', { bitrateMode: 'quantizer' })) {
		// Noise is largely incompressible, so the margin is small - but consistent
		expect(lowQuantizerBuffer.byteLength).toBeGreaterThan(1.25 * highQuantizerBuffer.byteLength);
	}
});

test('VideoSampleSource, av1 uses the quantizer index scale', async () => {
	if (!(await canEncodeVideo('av1', { bitrateMode: 'quantizer' }))) {
		return;
	}

	// 200 is only meaningful if the encoder really is on the 0-255 quantizer index scale; on a 0-63 scale it would
	// be out of range, and the size ordering below would collapse
	const fineBuffer = await encodeNoisyFrames({ codec: 'av1', bitrateMode: 'quantizer', quantizer: 40 }, 6);
	const coarseBuffer = await encodeNoisyFrames({ codec: 'av1', bitrateMode: 'quantizer', quantizer: 200 }, 6);

	expect(await readBackSamples(fineBuffer)).toHaveLength(6);
	expect(await readBackSamples(coarseBuffer)).toHaveLength(6);
	expect(fineBuffer.byteLength).toBeGreaterThan(1.25 * coarseBuffer.byteLength);
});

test('VideoSampleSource, per-frame quantizer', async () => {
	if (!(await canEncodeVideo('vp9', { bitrateMode: 'quantizer' }))) {
		// Per-frame quantizers only take effect when the browser supports quantizer mode
		return;
	}

	const packetSizes: number[] = [];

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp9',
		bitrateMode: 'quantizer',
		quantizer: 60,
		onEncodedPacket: packet => packetSizes.push(packet.byteLength),
	});

	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < 12; i++) {
		const sample = new VideoSample(makeNoisyCanvas(320, 240), { timestamp: i / 30, duration: 1 / 30 });

		// The second half of the frames overrides the config-level quantizer with a much lower value
		await videoSource.add(sample, i < 6 ? undefined : { quantizer: 8 });
		sample.close();
	}

	const invalidSample = new VideoSample(makeNoisyCanvas(320, 240), { timestamp: 12 / 30, duration: 1 / 30 });
	await expect(videoSource.add(invalidSample, { quantizer: 64 })).rejects.toThrow(/quantizer/);
	await expect(videoSource.add(invalidSample, { vp9: { quantizer: 65536 } })).rejects.toThrow(/quantizer/);
	invalidSample.close();

	await output.finalize();

	expect(packetSizes).toHaveLength(12);

	// Skip the first packet (key frame) for a fair comparison
	const highQuantizerSizes = packetSizes.slice(1, 6);
	const lowQuantizerSizes = packetSizes.slice(6);

	expect(average(lowQuantizerSizes)).toBeGreaterThan(1.25 * average(highQuantizerSizes));
});

// Moderate quantizers on purpose: Apple's hardware avc encoder misbehaves badly at very low ones
const SAFE_AVC_QUANTIZER = 26;
const COARSE_AVC_QUANTIZER = 45;

test('VideoSampleSource, avc quantizer mode on the hardware encoder', async () => {
	if (!(await canEncodeVideo('avc', { bitrateMode: 'quantizer' }))) {
		return; // Quantizer mode for avc isn't available on this browser
	}

	const fineBuffer = await encodeNoisyFrames(
		{ codec: 'avc', bitrateMode: 'quantizer', quantizer: SAFE_AVC_QUANTIZER },
		8,
	);
	const coarseBuffer = await encodeNoisyFrames(
		{ codec: 'avc', bitrateMode: 'quantizer', quantizer: COARSE_AVC_QUANTIZER },
		8,
	);

	expect(await readBackSamples(fineBuffer)).toHaveLength(8);
	expect(await readBackSamples(coarseBuffer)).toHaveLength(8);

	// The finer quantizer must yield a meaningfully larger file
	expect(fineBuffer.byteLength).toBeGreaterThan(1.25 * coarseBuffer.byteLength);
});

test('VideoSampleSource, hevc quantizer mode', async () => {
	if (!(await canEncodeVideo('hevc', { bitrateMode: 'quantizer' }))) {
		return; // Quantizer mode for hevc isn't available on this browser
	}

	// hevc shares the avc scale, and on Apple hardware it shares the low-quantizer hazard too
	const fineBuffer = await encodeNoisyFrames(
		{ codec: 'hevc', bitrateMode: 'quantizer', quantizer: SAFE_AVC_QUANTIZER },
		8,
	);
	const coarseBuffer = await encodeNoisyFrames(
		{ codec: 'hevc', bitrateMode: 'quantizer', quantizer: COARSE_AVC_QUANTIZER },
		8,
	);

	expect(await readBackSamples(fineBuffer)).toHaveLength(8);
	expect(await readBackSamples(coarseBuffer)).toHaveLength(8);
	expect(fineBuffer.byteLength).toBeGreaterThan(1.25 * coarseBuffer.byteLength);
});

test('VideoSampleSource, avc per-frame quantizer reaches the encoder', async () => {
	if (!(await canEncodeVideo('avc', { bitrateMode: 'quantizer' }))) {
		return;
	}

	const appliedQuantizers: number[] = [];
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const originalEncode = VideoEncoder.prototype.encode;
	VideoEncoder.prototype.encode = function (
		this: VideoEncoder,
		frame: VideoFrame,
		options?: VideoEncoderEncodeOptions,
	) {
		const quantizer = (options as { avc?: { quantizer?: number } } | undefined)?.avc?.quantizer;
		if (quantizer !== undefined) {
			appliedQuantizers.push(quantizer);
		}

		return originalEncode.call(this, frame, options);
	};

	const packetSizes: number[] = [];

	try {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const videoSource = new VideoSampleSource({
			codec: 'avc',
			bitrateMode: 'quantizer',
			quantizer: COARSE_AVC_QUANTIZER,
			onEncodedPacket: packet => packetSizes.push(packet.byteLength),
		});
		output.addVideoTrack(videoSource);
		await output.start();

		for (let i = 0; i < 8; i++) {
			const sample = new VideoSample(makeNoisyCanvas(320, 240), { timestamp: i / 30, duration: 1 / 30 });
			// The second half overrides the config-level quantizer with a finer (but still safe) one
			await videoSource.add(sample, i < 4 ? undefined : { quantizer: SAFE_AVC_QUANTIZER });
			sample.close();
		}

		await output.finalize();
	} finally {
		VideoEncoder.prototype.encode = originalEncode;
	}

	// Both the config-level and the per-frame quantizer must have reached the encoder, unmodified
	expect(appliedQuantizers.slice(0, 4)).toEqual(Array(4).fill(COARSE_AVC_QUANTIZER));
	expect(appliedQuantizers.slice(4)).toEqual(Array(4).fill(SAFE_AVC_QUANTIZER));

	// And the finer half must actually produce larger packets (skipping the leading key frame)
	expect(average(packetSizes.slice(4))).toBeGreaterThan(1.25 * average(packetSizes.slice(1, 4)));
});

test('VideoSampleSource, quantizer mode falls back to variable bitrate mode when unsupported', async () => {
	const originalIsConfigSupported = VideoEncoder.isConfigSupported.bind(VideoEncoder);

	// Simulate a browser that doesn't know quantizer mode: These browsers reject during the conversion of the
	// config dictionary since 'quantizer' is not part of their bitrate mode enum
	VideoEncoder.isConfigSupported = (config: VideoEncoderConfig) => {
		if (config.bitrateMode === 'quantizer') {
			return Promise.reject(new TypeError('Failed to read the \'bitrateMode\' property.'));
		}

		return originalIsConfigSupported(config);
	};

	try {
		const buffer = await encodeNoisyFrames(
			{ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 30 },
			3,
		);

		const samples = await readBackSamples(buffer);
		expect(samples).toHaveLength(3);
	} finally {
		VideoEncoder.isConfigSupported = originalIsConfigSupported;
	}
});

test('VideoSampleSource, quantizer mode falls back when configure rejects the config', async () => {
	const originalIsConfigSupported = VideoEncoder.isConfigSupported.bind(VideoEncoder);

	// Claim support in the probe, then have configure itself reject the config anyway
	VideoEncoder.isConfigSupported = (config: VideoEncoderConfig) => {
		if (config.bitrateMode === 'quantizer') {
			return Promise.resolve({ supported: true, config });
		}

		return originalIsConfigSupported(config);
	};

	// eslint-disable-next-line @typescript-eslint/unbound-method
	const originalConfigure = VideoEncoder.prototype.configure;
	VideoEncoder.prototype.configure = function (this: VideoEncoder, config: VideoEncoderConfig) {
		if (config.bitrateMode === 'quantizer') {
			throw new DOMException('Unsupported configuration', 'NotSupportedError');
		}

		return originalConfigure.call(this, config);
	};

	try {
		// Since quantizer configs always throw above, this succeeding proves the variable bitrate fallback ran
		const buffer = await encodeNoisyFrames(
			{ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 30 },
			3,
		);

		expect(await readBackSamples(buffer)).toHaveLength(3);
	} finally {
		VideoEncoder.isConfigSupported = originalIsConfigSupported;
		VideoEncoder.prototype.configure = originalConfigure;
	}
});

test('VideoSampleSource, codec-specific quantizers do not survive the fallback', async () => {
	const originalIsConfigSupported = VideoEncoder.isConfigSupported.bind(VideoEncoder);
	VideoEncoder.isConfigSupported = (config: VideoEncoderConfig) => {
		if (config.bitrateMode === 'quantizer') {
			return Promise.reject(new TypeError('Failed to read the \'bitrateMode\' property.'));
		}

		return originalIsConfigSupported(config);
	};

	const leakedQuantizers: number[] = [];
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const originalEncode = VideoEncoder.prototype.encode;
	VideoEncoder.prototype.encode = function (
		this: VideoEncoder,
		frame: VideoFrame,
		options?: VideoEncoderEncodeOptions,
	) {
		const quantizer = (options as { vp9?: { quantizer?: number } } | undefined)?.vp9?.quantizer;
		if (quantizer !== undefined) {
			leakedQuantizers.push(quantizer);
		}

		return originalEncode.call(this, frame, options);
	};

	try {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const videoSource = new VideoSampleSource({ codec: 'vp9', bitrateMode: 'quantizer', quantizer: 30 });
		output.addVideoTrack(videoSource);
		await output.start();

		for (let i = 0; i < 3; i++) {
			const sample = new VideoSample(makeCanvas(320, 240), { timestamp: i / 30, duration: 1 / 30 });
			await videoSource.add(sample, { vp9: { quantizer: 8 } });
			sample.close();
		}

		await output.finalize();

		expect(await readBackSamples(output.target.buffer!)).toHaveLength(3);
	} finally {
		VideoEncoder.isConfigSupported = originalIsConfigSupported;
		VideoEncoder.prototype.encode = originalEncode;
	}

	// After the fallback, per-frame quantizers are documented as ignored
	expect(leakedQuantizers).toEqual([]);
});

test('VideoSampleSource, a rejected frame leaves the frame rate state intact', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const videoSource = new VideoSampleSource({
		codec: 'vp9',
		bitrateMode: 'quantizer',
		quantizer: 30,
		transform: { frameRate: 10 },
	});
	output.addVideoTrack(videoSource);
	await output.start();

	const firstSample = new VideoSample(makeCanvas(320, 240), { timestamp: 0, duration: 0.1 });
	await videoSource.add(firstSample);
	firstSample.close();

	const secondSample = new VideoSample(makeCanvas(320, 240), { timestamp: 0.1, duration: 0.1 });
	await expect(videoSource.add(secondSample, { quantizer: 64 })).rejects.toThrow(/quantizer/);
	// The rejected frame must not have claimed its frame rate slot, or this retry would be swallowed
	await videoSource.add(secondSample, { quantizer: 8 });
	secondSample.close();

	await output.finalize();

	const samples = await readBackSamples(output.target.buffer!);
	expect(samples).toHaveLength(2);
});

test('VideoSampleSource, frame rate padding repeats the stored frame\'s quantizer', async () => {
	if (!(await canEncodeVideo('vp9', { bitrateMode: 'quantizer' }))) {
		return;
	}

	const appliedQuantizers: number[] = [];
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const originalEncode = VideoEncoder.prototype.encode;
	VideoEncoder.prototype.encode = function (
		this: VideoEncoder,
		frame: VideoFrame,
		options?: VideoEncoderEncodeOptions,
	) {
		const quantizer = (options as { vp9?: { quantizer?: number } } | undefined)?.vp9?.quantizer;
		if (quantizer !== undefined) {
			appliedQuantizers.push(quantizer);
		}

		return originalEncode.call(this, frame, options);
	};

	try {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const videoSource = new VideoSampleSource({
			codec: 'vp9',
			bitrateMode: 'quantizer',
			quantizer: 60,
			transform: { frameRate: 10 },
		});
		output.addVideoTrack(videoSource);
		await output.start();

		const sample = new VideoSample(makeCanvas(320, 240), { timestamp: 0, duration: 0.5 });
		await videoSource.add(sample, { quantizer: 8 });
		sample.close();

		await output.finalize();
	} finally {
		VideoEncoder.prototype.encode = originalEncode;
	}

	// The padded repeats stand in for the frame that was added with quantizer 8, so they carry it too
	expect(appliedQuantizers).toEqual(Array(5).fill(8));
});

const makeCanvas = (width: number, height: number) => {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, width, height);
	return canvas;
};

const average = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0) / sizes.length;

const makeNoisyCanvas = (width: number, height: number) => {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	const imageData = ctx.createImageData(width, height);

	for (let i = 0; i < imageData.data.length; i += 4) {
		imageData.data[i + 0] = Math.floor(Math.random() * 256);
		imageData.data[i + 1] = Math.floor(Math.random() * 256);
		imageData.data[i + 2] = Math.floor(Math.random() * 256);
		imageData.data[i + 3] = 255;
	}

	ctx.putImageData(imageData, 0, 0);
	return canvas;
};

const encodeNoisyFrames = async (
	encodingConfig: ConstructorParameters<typeof VideoSampleSource>[0],
	frameCount: number,
) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource(encodingConfig);
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < frameCount; i++) {
		const sample = new VideoSample(makeNoisyCanvas(320, 240), { timestamp: i / 30, duration: 1 / 30 });
		await videoSource.add(sample);
		sample.close();
	}

	await output.finalize();
	return output.target.buffer!;
};

const encodeFrames = async (
	encodingConfig: ConstructorParameters<typeof VideoSampleSource>[0],
	frames: {
		width: number;
		height: number;
		timestamp?: number;
		duration?: number;
		rotation?: Rotation;
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
		const canvas = makeCanvas(f.width, f.height);
		const sample = new VideoSample(canvas, {
			timestamp: f.timestamp ?? i / 30,
			duration: f.duration ?? 1 / 30,
			rotation: f.rotation,
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
