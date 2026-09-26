import { test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleCursor } from '../../src/cursors.js';

// "joined" in the sense that it was two separate MP3s that were spliced together (I think)
test('Can decode malformed joined MP3', async () => {
	using input = new Input({
		source: new UrlSource('/malformed-join.mp3'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	await using cursor = new AudioSampleCursor(audioTrack);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const sample of cursor);
});
