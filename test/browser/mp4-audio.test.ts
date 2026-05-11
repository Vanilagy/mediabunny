import { expect, test } from 'vitest';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { AudioBufferSink } from '../../src/media-sink.js';
import { UrlSource } from '../../src/source.js';

test('MP4 edit list audio ranges remain seamless across seek boundaries', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!audioTrack) {
		throw new Error('No audio track found.');
	}

	const sink = new AudioBufferSink(audioTrack);
	let previousLastTimestamp = -Infinity;
	for await (const buffer of sink.buffers(0, 4)) {
		previousLastTimestamp = buffer.timestamp;
	}

	const nextIterator = sink.buffers(4, 8);
	const next = await nextIterator.next();
	await nextIterator.return();

	expect(next.value?.timestamp).toBe(previousLastTimestamp);
});
