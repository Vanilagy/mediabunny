import { expect, test } from 'vitest';
import { registerMjpegDecoder, registerMjpegEncoder } from '@mediabunny/mjpeg';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';

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

test.concurrent('encodes mjpeg frames', async () => {
	registerMjpegEncoder();

	const input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});

	const outputTarget = new BufferTarget();

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: outputTarget,
	});
	const conversion = await Conversion.init({ input, output });

	await conversion.execute();

	expect(outputTarget.buffer?.byteLength).toBeGreaterThan(0);
	expect(output.tracks.length).toBeGreaterThan(0);
});
