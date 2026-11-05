import { beforeEach, expect, test } from 'vitest';
import { registerMjpegDecoder, registerMjpegEncoder } from '@mediabunny/mjpeg';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { canEncodeVideo, Quality } from '../../src/encode.js';

beforeEach(() => {
	registerMjpegEncoder();
});

test.concurrent('mjpeg reading', async () => {
	const input = new Input({
		source: new UrlSource('/mjpeg.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('mjpeg');
	expect(await videoTrack.getCodedWidth()).toBe(640);
	expect(await videoTrack.getCodedHeight()).toBe(360);
});

test.concurrent('decodes mjpeg frames', async () => {
	registerMjpegDecoder();

	const input = new Input({
		source: new UrlSource('/mjpeg.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new VideoSampleSink(videoTrack);

	const firstSample = await sink.getSample(0);
	expect(firstSample?.codedWidth).toBe(640);
	expect(firstSample?.codedHeight).toBe(360);
	expect(firstSample?.allocationSize()).toBeGreaterThan(0);
});

test.concurrent('reencodes video to mjpeg at the target bitrate', async () => {
	const targetBitrate = 2_000_000;

	const input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});

	const outputTarget = new BufferTarget();

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: outputTarget,
	});
	const conversion = await Conversion.init({
		input,
		output,
		video: { codec: 'mjpeg', quality: new Quality({ bitrate: targetBitrate }) },
		audio: { discard: true },
	});

	await conversion.execute();

	using result = new Input({ source: new BufferSource(outputTarget.buffer!), formats: ALL_FORMATS });
	const track = (await result.getPrimaryVideoTrack())!;
	const { averageBitrate } = await track.computePacketStats();
	expect(Math.abs(averageBitrate / targetBitrate - 1)).toBeLessThan(0.05);
});

test.concurrent('higher mjpeg quantizers produce smaller videos', async () => {
	const sizes: number[] = [];
	for (const quantizer of [0, 50, 100]) {
		using input = new Input({ source: new UrlSource('/demo.mp4'), formats: ALL_FORMATS });
		const target = new BufferTarget();
		const output = new Output({ format: new Mp4OutputFormat(), target });
		const conversion = await Conversion.init({
			input,
			output,
			trim: { start: 0, end: 1 },
			video: { codec: 'mjpeg', quality: new Quality({ quantizer }) },
			audio: { discard: true },
		});
		await conversion.execute();
		sizes.push(target.buffer!.byteLength);
	}

	expect(sizes[0]).toBeGreaterThan(sizes[1]!);
	expect(sizes[1]).toBeGreaterThan(sizes[2]!);
});

test.concurrent('rejects mjpeg quantizers above 100', async () => {
	expect(await canEncodeVideo('mjpeg', { quality: new Quality({ quantizer: 101 }) })).toBe(false);
});
