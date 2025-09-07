import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { FLAC, WAVE } from '../../src/input-format.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';

test('should be able to decode samples from a FLAC file', async () => {
	const input = new Input({
		source: new UrlSource('/sample.flac'),
		formats: [FLAC],
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioSampleSink(track);

	const sample = await sink.getSample(1);
	assert(sample);
	expect(sample.timestamp).toBe(0.9287981859410431);
});

test('should be able to convert a .flac to .wav', async () => {
	const input = new Input({
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

	const track = await outputAsInput.getPrimaryAudioTrack();
	assert(track);

	const duration = await track.computeDuration();
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
});
