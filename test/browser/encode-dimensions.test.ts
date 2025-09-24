import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { NullTarget } from '../../src/target.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { canEncodeVideo, QUALITY_HIGH } from '../../src/encode.js';
import { VideoSample } from '../../src/sample.js';

test('Odd video dimensions fail for AVC', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new NullTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(source);

	await output.start();

	const canvas = document.createElement('canvas');
	canvas.width = 1281;
	canvas.height = 720;
	const sample = new VideoSample(canvas, { timestamp: 0 });

	await expect(source.add(sample)).rejects.toThrow('even number'); // The error message is explicit
});

test('Odd video dimensions fail for HEVC', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new NullTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'hevc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(source);

	await output.start();

	const canvas = document.createElement('canvas');
	canvas.width = 1281;
	canvas.height = 720;
	const sample = new VideoSample(canvas, { timestamp: 0 });

	await expect(source.add(sample)).rejects.toThrow('even number');
});

test('Odd video dimensions pass for VP9', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new NullTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'vp9',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(source);

	await output.start();

	const canvas = document.createElement('canvas');
	canvas.width = 1281;
	canvas.height = 720;
	const sample = new VideoSample(canvas, { timestamp: 0 });

	await source.add(sample);
});

test('Odd video dimensions encodability checks', async () => {
	expect(await canEncodeVideo('avc', { width: 1920, height: 1081 })).toBe(false);
	expect(await canEncodeVideo('hevc', { width: 1920, height: 1081 })).toBe(false);
	expect(await canEncodeVideo('vp8', { width: 1920, height: 1081 })).toBe(true);
	expect(await canEncodeVideo('vp9', { width: 1920, height: 1081 })).toBe(true);
	expect(await canEncodeVideo('av1', { width: 1920, height: 1081 })).toBe(true);
});
