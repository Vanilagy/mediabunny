import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';

test('iPhone MOV video produces VideoSample with null format', async () => {
	using input = new Input({
		source: new UrlSource('/no-correct-videoframe-format.mov'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(videoTrack).toBeDefined();

	expect(videoTrack.codec).toBeDefined();
	expect(videoTrack.displayWidth).toBeGreaterThan(0);
	expect(videoTrack.displayHeight).toBeGreaterThan(0);

	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;

	expect(sample).toBeDefined();
	expect(sample.format).toBeNull();

	expect(() => sample.allocationSize()).toThrow();
});
