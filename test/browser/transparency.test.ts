import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { CanvasSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { CanvasSource, VideoSampleSource } from '../../src/media-source.js';
import { canEncodeVideo, QUALITY_HIGH } from '../../src/encode.js';
import { VideoSample } from '../../src/sample.js';
import { Conversion } from '../../src/conversion.js';

test('Can decode transparent video', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const sink = new VideoSampleSink(videoTrack);
	const sample = (await sink.getSample(0.5))!;

	expect(sample.format).toContain('A'); // Probably RGBA
	expect(sample.hasAlpha).toBe(true);

	const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
	const context = canvas.getContext('2d')!;

	sample.draw(context, 0, 0);

	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBeLessThan(255); // Check that there's actually transparent pixels
});

test('Can decode faulty transparent video and behaves gracefully', async () => {
	using input = new Input({
		source: new UrlSource('/transparency-faulty.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const packetSink = new EncodedPacketSink(videoTrack);
	const secondKeyPacket = (await packetSink.getNextKeyPacket((await packetSink.getFirstPacket())!))!;

	const sink = new VideoSampleSink(videoTrack);

	const startSample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(startSample.format).toContain('A');

	const secondSample = (await sink.getSample(secondKeyPacket.timestamp))!;
	expect(secondSample.format).not.toContain('A'); // There was no alpha key frame for this one
	expect(secondSample.hasAlpha).toBe(false);
});

test('Can extract transparent frames via CanvasSink', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new CanvasSink(videoTrack, { alpha: true });
	const wrappedCanvas = (await sink.getCanvas(await videoTrack.getFirstTimestamp()))!;

	const canvas = new OffscreenCanvas(wrappedCanvas.canvas.width, wrappedCanvas.canvas.height);
	const context = canvas.getContext('2d')!;
	context.drawImage(wrappedCanvas.canvas, 0, 0);

	let imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBeLessThan(255); // Check that there's actually transparent pixels

	const opaqueSink = new CanvasSink(videoTrack); // Default is alpha: false
	const opaqueWrappedCanvas = (await opaqueSink.getCanvas(await videoTrack.getFirstTimestamp()))!;

	context.drawImage(opaqueWrappedCanvas.canvas, 0, 0);

	imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBe(255);
});

test('Can encode transparent video', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const context = canvas.getContext('2d')!;

	const source = new CanvasSource(canvas, {
		codec: 'vp9',
		bitrate: QUALITY_HIGH,
		alpha: 'keep',
	});
	output.addVideoTrack(source);

	await output.start();

	context.fillStyle = '#ff0000';
	context.fillRect(200, 200, 200, 200);
	await source.add(0, 1);

	context.fillStyle = '#00ff00';
	context.fillRect(300, 300, 200, 200);
	await source.add(1, 1);

	context.fillStyle = '#0000ff';
	context.fillRect(400, 400, 200, 200);
	await source.add(2, 1);

	await output.finalize();

	const blob = new Blob([output.target.buffer!], {
		type: output.format.mimeType,
	});
	const url = URL.createObjectURL(blob);

	const video = document.createElement('video');
	video.src = url;
	video.muted = true;
	void video.play();

	await new Promise(resolve => video.addEventListener('loadeddata', resolve));

	// Let the video play for a little bit to prevent flake
	while (video.currentTime < 0.1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	expect(video.videoWidth).toBe(1280);
	expect(video.videoHeight).toBe(720);

	const probeCanvas = new OffscreenCanvas(1280, 720);
	const probeContext = probeCanvas.getContext('2d')!;

	probeContext.drawImage(video, 0, 0);

	let imageData = probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
	const index1 = (100 + 100 * probeCanvas.width) * 4;
	expect(imageData.data[index1 + 3]).toBe(0); // Transparent

	const pos = { x: 300, y: 300 }; // Dead center in the red square
	const index2 = (pos.x + pos.y * probeCanvas.width) * 4;

	// Red (within error)
	expect(imageData.data[index2 + 0]).greaterThanOrEqual(253);
	expect(imageData.data[index2 + 1]).lessThanOrEqual(2);
	expect(imageData.data[index2 + 2]).lessThanOrEqual(2);

	expect(imageData.data[index2 + 3]).toBe(255); // Opaque

	// Let's also check it's read correctly by Mediabunny
	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const sink = new VideoSampleSink(videoTrack);

	const firstSample = (await sink.getSample(0))!;
	expect(firstSample.format).toContain('A');

	probeContext.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
	firstSample.draw(probeContext, 0, 0);

	imageData = probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height);

	expect(imageData.data[3]).toBe(0); // Transparent
});

test('Can encode video with alternating transparency', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas1 = new OffscreenCanvas(640, 480);
	const context1 = canvas1.getContext('2d', { alpha: true })!;
	context1.fillStyle = '#ff000080';
	context1.fillRect(0, 0, canvas1.width, canvas1.height);

	const canvas2 = new OffscreenCanvas(640, 480);
	const context2 = canvas2.getContext('2d', { alpha: false })!;
	context2.fillStyle = '#0000ff';
	context2.fillRect(0, 0, canvas2.width, canvas2.height);

	const source = new VideoSampleSource({
		codec: 'vp9',
		bitrate: QUALITY_HIGH,
		alpha: 'keep',
	});
	output.addVideoTrack(source);

	await output.start();

	for (let i = 0; i < 64; i++) {
		const sample = new VideoSample(new Uint8Array(640 * 480 * 4), {
			format: i % 2 ? 'RGBX' : 'RGBA',
			codedWidth: 640,
			codedHeight: 480,
			timestamp: i,
			duration: 1,
		});
		await source.add(sample);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const packetSink = new EncodedPacketSink(videoTrack);

	let i = 0;
	for await (const packet of packetSink.packets()) {
		if (i % 2) {
			expect(packet.sideData.alpha).toBeUndefined();
		} else {
			expect(packet.sideData.alpha).toBeDefined();
		}

		i++;
	}

	const sampleSink = new VideoSampleSink(videoTrack);

	i = 0;
	for await (const sample of sampleSink.samples()) {
		if (i % 2) {
			expect(sample.format).not.toContain('A');
		} else {
			expect(sample.format).toContain('A');
		}

		i++;
	}
});

test('Can encode transparent video with odd dimensions', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(641, 479);
	const context = canvas.getContext('2d', { alpha: true })!;
	context.fillStyle = '#ff000080';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const source = new CanvasSource(canvas, {
		codec: 'vp9',
		bitrate: QUALITY_HIGH,
		alpha: 'keep',
	});
	output.addVideoTrack(source);

	await output.start();
	await source.add(0, 1);
	await output.finalize();
});

test('Positive encodability check with alpha', async () => {
	const result = await canEncodeVideo('vp9', { alpha: 'keep' });
	expect(result).toBe(true);
});

test('Can transmux transparent video, discards alpha by default', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
	});
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await outputInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(false);

	const sink = new VideoSampleSink(videoTrack);
	const sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(sample.hasAlpha).toBe(false);
});

test('Can transmux transparent video, can keep alpha', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			alpha: 'keep',
		},
	});
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await outputInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);

	const sink = new VideoSampleSink(videoTrack);
	const sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(sample.format).toContain('A');
	expect(sample.hasAlpha).toBe(true);
});

test('Can reencode transparent video, keeping alpha', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			width: 320,
			alpha: 'keep',
		},
		trim: {
			start: 0,
			end: 0.5,
		},
	});
	await conversion.execute();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await outputInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.canBeTransparent()).toBe(true);
	expect(videoTrack.displayWidth).toBe(320);

	const sink = new VideoSampleSink(videoTrack);
	const sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(sample.format).toContain('A');
	expect(sample.hasAlpha).toBe(true);
});
