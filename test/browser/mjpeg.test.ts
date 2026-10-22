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
import { canEncodeVideo, Quality } from '../../src/encode.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { VideoSample } from '../../src/sample.js';

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
	const conversion = await Conversion.init({ input, output, video: { codec: 'mjpeg' } });

	await conversion.execute();

	expect(outputTarget.buffer?.byteLength).toBeGreaterThan(0);
	expect(output.tracks.length).toBeGreaterThan(0);
});

test.each([
	{ name: 'quantizer 0', quality: new Quality({ quantizer: 0 }), canvasQuality: 1 },
	{ name: 'quantizer 25', quality: new Quality({ quantizer: 25 }), canvasQuality: 0.75 },
	{ name: 'quantizer 100', quality: new Quality({ quantizer: 100 }), canvasQuality: 0 },
	{ name: 'very-low quality', quality: new Quality('very-low'), canvasQuality: 0 },
	{ name: 'medium quality', quality: new Quality('medium'), canvasQuality: 0.5 },
	{ name: 'very-high quality', quality: new Quality('very-high'), canvasQuality: 1 },
	{ name: 'bitrate fallback', quality: new Quality({ bitrate: 1_000_000 }), canvasQuality: 1 },
])('encodes mjpeg with $name', async ({ quality, canvasQuality }) => {
	registerMjpegEncoder();

	const canvas = new OffscreenCanvas(32, 32);
	const context = canvas.getContext('2d')!;
	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			context.fillStyle = `rgb(${x * 8}, ${y * 8}, ${(x * y * 17) % 256})`;
			context.fillRect(x, y, 1, 1);
		}
	}
	const expectedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: canvasQuality });
	const expectedData = new Uint8Array(await expectedBlob.arrayBuffer());
	const packets: Uint8Array[] = [];
	const source = new VideoSampleSource({
		codec: 'mjpeg',
		quality,
		onEncodedPacket: (packet) => packets.push(packet.data),
	});
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addVideoTrack(source);
	await output.start();
	using sample = new VideoSample(canvas, { timestamp: 0, duration: 1 });
	await source.add(sample);
	source.close();
	await output.finalize();

	expect(packets).toHaveLength(1);
	expect(packets[0]).toEqual(expectedData);
});

test('rejects mjpeg quantizers above 100', async () => {
	registerMjpegEncoder();
	expect(await canEncodeVideo('mjpeg', { quality: new Quality({ quantizer: 101 }) })).toBe(false);
});
