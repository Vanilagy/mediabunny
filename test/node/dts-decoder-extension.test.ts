import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { canDecode } from '../../src/decode.js';
import { assert } from '../../src/misc.js';
import { registerDtsDecoder } from '@mediabunny/dts-decoder';
import path from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname;

test('Custom coder registration', async () => {
	expect(await canDecode('dts')).toBe(false);

	registerDtsDecoder();

	expect(await canDecode('dts')).toBe(true);
});

test('DTS decoding', async () => {
	registerDtsDecoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/dts.mkv')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('dts');

	const trackNumberOfChannels = await track.getNumberOfChannels();
	const trackSampleRate = await track.getSampleRate();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let frameCount = 0;

	for await (using sample of sink.samples()) {
		expect(sample.numberOfFrames).toBeGreaterThan(0);
		expect(sample.numberOfChannels).toBe(trackNumberOfChannels);
		expect(sample.sampleRate).toBe(trackSampleRate);

		frameCount += sample.numberOfFrames;
		sampleCount++;
	}

	expect(sampleCount).toBeGreaterThan(0);
	expect(frameCount).toBeGreaterThan(0);
});
