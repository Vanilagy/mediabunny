import { expect, test } from 'vitest';
import { registerProresDecoder } from '@mediabunny/prores';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MovOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

const SAMPLE_URL = 'https://pub-1ee78aacb848486482b20a72b55b3121.r2.dev/turbores-sample.mov';

test.concurrent('ProRes MOV file reading', async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');
	expect(await videoTrack.getCodedWidth()).toBe(1920);
	expect(await videoTrack.getCodedHeight()).toBe(1080);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('ProRes transmuxing into MOV', { timeout: 10_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
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
	expect(await videoTrack.getCodec()).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('ProRes transmuxing into MKV', { timeout: 10_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MkvOutputFormat(),
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
	expect(await videoTrack.getCodec()).toBe('prores');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(15);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('apch');
	expect(decoderConfig.description).toBeUndefined();
});

test('Custom coder registration', { timeout: 10_000 }, async () => {
	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('prores');

	// Without a registered decoder, there's no way to decode ProRes in this environment
	expect(await videoTrack.canDecode()).toBe(false);

	registerProresDecoder();

	expect(await videoTrack.canDecode()).toBe(true);
});

test('ProRes decoding', { timeout: 10_000 }, async () => {
	registerProresDecoder();

	using input = new Input({
		source: new UrlSource(SAMPLE_URL),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const firstTimestamp = await videoTrack.getFirstTimestamp();

	const sink = new VideoSampleSink(videoTrack);
	using sample = await sink.getSample(firstTimestamp);
	assert(sample);

	expect(sample.timestamp).toBe(firstTimestamp);
	expect(sample.duration).toBeGreaterThan(0);

	expect(sample.displayWidth).toBe(1920);
	expect(sample.displayHeight).toBe(1080);
	expect(sample.codedWidth).toBe(1920);
	expect(sample.codedHeight).toBe(1080); // Technically a lie but the field is ill-defined
	expect(sample.visibleRect).toEqual({
		left: 0,
		top: 0,
		width: 1920,
		height: 1080,
	});
	expect(sample.format).toBe('I422P10');

	const allocationSize = sample.allocationSize();
	expect(allocationSize).toBeGreaterThan(0);

	const pixels = new Uint8Array(allocationSize);
	await sample.copyTo(pixels);
	expect(pixels.some(byte => byte !== 0)).toBe(true);
});
