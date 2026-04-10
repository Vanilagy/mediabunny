import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { expect, test } from 'vitest';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

test('Rotation is baked-in when rerendering', async () => {
	using input = new Input({
		source: new UrlSource('/rotate-buck-bunny.mp4'),
		formats: ALL_FORMATS,
	});

	const ogTrack = await input.getPrimaryVideoTrack();
	assert(ogTrack);

	expect(await ogTrack.getRotation()).toBe(90);
	expect(await ogTrack.getCodedWidth()).toBe(1920);
	expect(await ogTrack.getCodedHeight()).toBe(1080);
	expect(await ogTrack.getDisplayWidth()).toBe(1080);
	expect(await ogTrack.getDisplayHeight()).toBe(1920);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, video: {
		width: 320,
	} });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getCodedWidth()).toBe(320);
	expect(await track.getCodedHeight()).toBe(570);
	expect(await track.getDisplayWidth()).toBe(320);
	expect(await track.getDisplayHeight()).toBe(570);
	expect(await track.getRotation()).toBe(0);
});
