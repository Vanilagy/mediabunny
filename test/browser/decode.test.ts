import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleCursor } from '../../src/cursors.js';

test('MP3 decoding', async () => {
	using input = new Input({
		source: new UrlSource('/AudacityTest1.mp3'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const cursor = new AudioSampleCursor(audioTrack);
	const sample = await cursor.seekToFirst();
	expect(sample).not.toBe(null);
	expect(sample!.timestamp).toBe(0);
	expect(sample!.duration).toBeCloseTo(1152 / audioTrack.sampleRate);
});
