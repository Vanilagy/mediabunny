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

	expect(ogTrack.rotation).toBe(90);
	expect(ogTrack.codedWidth).toBe(1920);
	expect(ogTrack.codedHeight).toBe(1080);
	expect(ogTrack.displayWidth).toBe(1080);
	expect(ogTrack.displayHeight).toBe(1920);

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

	expect(track.codedWidth).toBe(320);
	expect(track.codedHeight).toBe(570);
	expect(track.displayWidth).toBe(320);
	expect(track.displayHeight).toBe(570);
	expect(track.rotation).toBe(0);
});
