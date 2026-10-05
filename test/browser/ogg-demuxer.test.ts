import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleCursor } from '../../src/cursors.js';
import { assert } from '../../src/misc.js';

// VLC creates OGG files with an empty EOS page, which previously caused decoding errors
test('can decode OGG Vorbis file with empty EOS page', async () => {
	using input = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	await using cursor = new AudioSampleCursor(track);
	const buffers: AudioBuffer[] = [];

	await cursor.seekTo(4);

	for await (const sample of cursor) {
		if (sample.timestamp >= 10) {
			break;
		}

		buffers.push(sample.toAudioBuffer());
	}

	expect(buffers.length).toBeGreaterThan(0);
});
