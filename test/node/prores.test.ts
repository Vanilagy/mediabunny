import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MovOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { CustomVideoDecoder, registerDecoder } from '../../src/custom-coder.js';
import { ProResDecoder } from '../../packages/prores-decoder/src/index.js';

test.concurrent('ProRes MOV file reading', async () => {
	using input = new Input({
		source: new UrlSource('https://pub-cf9fcfcb5c0a44e9b1bb5ff890e041ae.r2.dev/IMG_0158-prores-log.MOV'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(videoTrack.codec).toBe('prores');
	expect(videoTrack.codedWidth).toBe(1920);
	expect(videoTrack.codedHeight).toBe(1080);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('ProRes transmuxing into MOV', { timeout: 60_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://pub-cf9fcfcb5c0a44e9b1bb5ff890e041ae.r2.dev/IMG_0158-prores-log.MOV'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: {
			discard: true,
		},
		trim: {
			end: 0.5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(videoTrack.codec).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('ProRes transmuxing into MKV', { timeout: 60_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://pub-cf9fcfcb5c0a44e9b1bb5ff890e041ae.r2.dev/IMG_0158-prores-log.MOV'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			rotate: 270, // To undo the source rotation metadata so the copy path is taken
		},
		audio: {
			discard: true,
		},
		trim: {
			end: 0.5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(videoTrack.codec).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent.only('ProRes sample ahh', async () => {
	registerDecoder(ProResDecoder);

	using input = new Input({
		source: new UrlSource('https://pub-cf9fcfcb5c0a44e9b1bb5ff890e041ae.r2.dev/IMG_0158-prores-log.MOV'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new VideoSampleSink(videoTrack);
	const sample = await sink.getSample(0);

	console.log(sample);
});
