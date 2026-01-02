import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { FLAC, WAVE } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSampleCursor } from '../../src/cursors.js';

test('can decode samples from a FLAC file', async () => {
	using input = new Input({
		source: new UrlSource('/sample.flac'),
		formats: [FLAC],
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	await using cursor = new AudioSampleCursor(track);

	using sample = await cursor.seekTo(1);
	assert(sample);
	expect(sample.timestamp).toBe(0.9287981859410431);
});

test('can convert a .flac to .wav', async () => {
	using input = new Input({
		source: new UrlSource('/sample.flac'),
		formats: [FLAC],
	});
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	const buffer = output.target.buffer;
	assert(buffer);

	const outputAsInput = new Input({
		source: new BufferSource(buffer),
		formats: [WAVE],
	});

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	const duration = await outputTrack.computeDuration();
	expect(duration).toBe(19.71428571428571);
	const tags = await outputAsInput.getMetadataTags();
	expect(tags.raw).toEqual({
		IART: 'Samples Files',
		ICRD: '2020-01-01',
		IGNR: 'Ambient',
		INAM: 'The Happy Meeting',
		IPRD: 'Samples files',
		ITRK: '4',
	});
	expect(inputTrack.sampleRate).toBe(outputTrack.sampleRate);
	expect(inputTrack.numberOfChannels).toBe(outputTrack.numberOfChannels);
	expect(inputTrack.timeResolution).toBe(outputTrack.timeResolution);
});
