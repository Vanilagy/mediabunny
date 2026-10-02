import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleCursor } from '../../src/cursors.js';
import { assert } from '../../src/misc.js';

test('Encrypted MP4 without senc', async () => {
	using input = new Input({
		source: new UrlSource('/639955605-b752f7ad-7ce8-43c2-8ae9-88e74c6ae696.mp4'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: () => 'aabbccddeeff00112233445566778899',
			},
		},
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	// Test that it can decode
	await using cursor = new AudioSampleCursor(audioTrack);
	const firstSample = await cursor.seekTo(0);
	assert(firstSample);
	expect(firstSample.timestamp).toBe(0);
});
