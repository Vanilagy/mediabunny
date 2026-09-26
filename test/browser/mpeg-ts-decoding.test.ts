import { test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleCursor, AudioSampleCursor } from '../../src/cursors.js';
import { assert } from '../../src/misc.js';

test('MPEG-TS video samples are decodable', async () => {
	using input = new Input({
		source: new UrlSource('/0.ts'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	await using cursor = new VideoSampleCursor(videoTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const sample of cursor) {
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

	await using cursor = new AudioSampleCursor(audioTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const sample of cursor) {
		count++;
	}

	assert(count > 0);
});
