import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { CanvasSource } from '../../src/media-source.js';
import { QUALITY_HIGH } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

test('CMAF throws without initTarget', async () => {
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await expect(output.start()).rejects.toThrow('initTarget');
});

test('CMAF with video track', async () => {
	const initTarget = new BufferTarget();
	let initTargetCalled = false;

	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: () => {
			initTargetCalled = true;
			return initTarget;
		},
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff0000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 30;
	const frameDuration = 1 / fps;
	for (let i = 0; i < fps; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	expect(initTargetCalled).toBe(true);

	// Reading the segment without initInput should throw because the moov box is in the init segment
	using segmentInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	await expect(segmentInput.getTracks()).rejects.toThrow('initInput');

	// Reading with initInput should work
	using initInput = new Input({
		source: new BufferSource(initTarget.buffer!),
		formats: ALL_FORMATS,
	});

	using segmentInputWithInit = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
		initInput,
	});

	const tracks = await segmentInputWithInit.getTracks();
	expect(tracks).toHaveLength(1);
	expect(tracks[0]!.isVideoTrack()).toBe(true);
});

test('Input.getSegmentIndex parses sidx from a CMAF segment file', async () => {
	const initTarget = new BufferTarget();

	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget: () => initTarget,
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 30;
	const frameDuration = 1 / fps;
	for (let i = 0; i < fps * 2; i++) {
		ctx.fillStyle = i % 2 === 0 ? '#ff0000' : '#00ff00';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	using initInput = new Input({
		source: new BufferSource(initTarget.buffer!),
		formats: ALL_FORMATS,
	});
	using segmentInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
		initInput,
	});

	const sidxBoxes = await segmentInput.getSegmentIndex();
	expect(sidxBoxes.length).toBeGreaterThan(0);

	for (const sidx of sidxBoxes) {
		expect(sidx.timescale).toBeGreaterThan(0);
		expect(sidx.references.length).toBeGreaterThan(0);
		expect(sidx.boxStart).toBeGreaterThanOrEqual(0);
		expect(sidx.boxSize).toBeGreaterThan(0);

		for (const ref of sidx.references) {
			expect(ref.referencedSize).toBeGreaterThan(0);
			expect(ref.subsegmentDuration).toBeGreaterThan(0);
			expect(ref.referenceType === 0 || ref.referenceType === 1).toBe(true);
			expect(ref.startsWithSAP === 0 || ref.startsWithSAP === 1).toBe(true);
		}
	}
});

test('Input.getSegmentIndex returns empty array for non-fragmented MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff0000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();
	const fps = 30;
	const frameDuration = 1 / fps;
	for (let i = 0; i < fps; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const sidxBoxes = await input.getSegmentIndex();
	expect(sidxBoxes).toEqual([]);
});

test('CMAF with empty video track', async () => {
	const initTarget = new BufferTarget();

	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		initTarget,
	});

	const canvas = new OffscreenCanvas(640, 480);
	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();
	await output.finalize();

	expect(initTarget.buffer).toBeDefined();
	expect(output.target.buffer).toBeDefined();
});
