import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import path from 'path';

const movFilePath = path.join(__dirname, '..', 'public/mjpeg.mov');

test.concurrent('mjpeg reading', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(movFilePath),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('mjpeg');
	expect(await videoTrack.getCodedWidth()).toBe(640);
	expect(await videoTrack.getCodedHeight()).toBe(360);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('jpeg');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('transcoding to mjpeg', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(movFilePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			codec: 'mjpeg',
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('mjpeg');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(125);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('jpeg');
	expect(decoderConfig.description).toBeUndefined();
});
