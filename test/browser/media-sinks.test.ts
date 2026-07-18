import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleCursor } from '../../src/cursors.js';

// https://github.com/Vanilagy/mediabunny/issues/370
test('Negative audio timestamps are preserved', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getFirstTimestamp()).toBeLessThan(0);

	await using cursor = new AudioSampleCursor(track);

	for await (const sample of cursor) {
		expect(sample.timestamp).toBe(await track.getFirstTimestamp());
		break;
	}
});
