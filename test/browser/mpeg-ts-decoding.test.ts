import { test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink, AudioSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

test('MPEG-TS video samples are decodable', async () => {
	using input = new Input({
		source: new UrlSource('/0.ts'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new VideoSampleSink(videoTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	assert(count > 0);
});

test('MPEG-TS audio samples are decodable', async () => {
	using input = new Input({
		source: new UrlSource('/0.ts'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new AudioSampleSink(audioTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	assert(count > 0);
});
