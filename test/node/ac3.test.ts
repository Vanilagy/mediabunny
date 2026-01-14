import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { toUint8Array } from '../../src/misc.js';
import { parseAC3Config, parseEAC3Config, type AC3FrameInfo, type EAC3Config } from '../../src/codec-data.js';

const __dirname = new URL('.', import.meta.url).pathname;

const expectedAC3Config: AC3FrameInfo = {
	fscod: 0,
	bsid: 8,
	bsmod: 0,
	acmod: 7,
	lfeon: 1,
	bitRateCode: 15,
};

const expectedEAC3Config: EAC3Config = {
	dataRate: 384,
	substreams: [
		{
			fscod: 0,
			fscod2: 0,
			bsid: 16,
			bsmod: 0,
			acmod: 7,
			lfeon: 1,
			numDepSub: 0,
			chanLoc: 0,
		},
	],
};

test('reads AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(audioTrack.codec).toBe('ac3');
	expect(decoderConfig.description).toBeDefined();
	expect(decoderConfig.description!.byteLength).toBeGreaterThanOrEqual(3);

	const config = parseAC3Config(toUint8Array(decoderConfig.description!))!;

	expect(config).toEqual(expectedAC3Config);
});

test('creates dac3 box when converting AC-3 from MKV to MP4', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mkv')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;
	const originalDecoderConfig = (await originalAudioTrack.getDecoderConfig())!;

	expect(originalDecoderConfig.description).toBeUndefined();
	expect(originalAudioTrack.codec).toBe('ac3');

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;
	const newDecoderConfig = (await newAudioTrack.getDecoderConfig())!;

	expect(newDecoderConfig.description).toBeDefined();
	expect(newDecoderConfig.description!.byteLength).toBeGreaterThanOrEqual(3);
	expect(newAudioTrack.codec).toBe('ac3');

	const config = parseAC3Config(toUint8Array(newDecoderConfig.description!))!;

	expect(config).toEqual(expectedAC3Config);
});

test('reads E-AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(audioTrack.codec).toBe('eac3');
	expect(decoderConfig.description).toBeDefined();
	expect(decoderConfig.description!.byteLength).toBeGreaterThanOrEqual(5);

	const config = parseEAC3Config(toUint8Array(decoderConfig.description!))!;

	expect(config).toEqual(expectedEAC3Config);
});

test('creates dec3 box when converting E-AC-3 from MKV to MP4', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mkv')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;
	const originalDecoderConfig = (await originalAudioTrack.getDecoderConfig())!;

	expect(originalDecoderConfig.description).toBeUndefined();
	expect(originalAudioTrack.codec).toBe('eac3');

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;
	const newDecoderConfig = (await newAudioTrack.getDecoderConfig())!;

	expect(newDecoderConfig.description).toBeDefined();
	expect(newDecoderConfig.description!.byteLength).toBeGreaterThanOrEqual(5);
	expect(newAudioTrack.codec).toBe('eac3');

	const config = parseEAC3Config(toUint8Array(newDecoderConfig.description!))!;

	expect(config).toEqual(expectedEAC3Config);
});
