import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AC3_REGISTRATION_DESCRIPTOR, EAC3_REGISTRATION_DESCRIPTOR } from '../../src/codec-data.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('reads AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(audioTrack.codec).toBe('ac3');
	expect(decoderConfig.description).toBeUndefined();
});

test('reads E-AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(audioTrack.codec).toBe('eac3');
	expect(decoderConfig.description).toBeUndefined();
});

test('reads and writes AC-3 in MPEG-TS', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.ts')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;

	expect(originalAudioTrack.codec).toBe('ac3');
	expect(originalAudioTrack.internalCodecId).toBe(0x81);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;

	expect(newAudioTrack.codec).toBe('ac3');
	expect(newAudioTrack.internalCodecId).toBe(0x81);
	expect(newAudioTrack.numberOfChannels).toBe(originalAudioTrack.numberOfChannels);
	expect(newAudioTrack.sampleRate).toBe(originalAudioTrack.sampleRate);

	// Verify registration_descriptor is present
	const buffer = new Uint8Array(output.target.buffer!);
	let found = false;
	for (let i = 0; i < buffer.length - AC3_REGISTRATION_DESCRIPTOR.length; i++) {
		if (AC3_REGISTRATION_DESCRIPTOR.every((byte, j) => buffer[i + j] === byte)) {
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
});

test('reads and writes E-AC-3 in MPEG-TS', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.ts')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;

	expect(originalAudioTrack.codec).toBe('eac3');
	expect(originalAudioTrack.internalCodecId).toBe(0x87);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;

	expect(newAudioTrack.codec).toBe('eac3');
	expect(newAudioTrack.internalCodecId).toBe(0x87);
	expect(newAudioTrack.numberOfChannels).toBe(originalAudioTrack.numberOfChannels);
	expect(newAudioTrack.sampleRate).toBe(originalAudioTrack.sampleRate);

	// Verify registration_descriptor is present
	const buffer = new Uint8Array(output.target.buffer!);
	let found = false;
	for (let i = 0; i < buffer.length - EAC3_REGISTRATION_DESCRIPTOR.length; i++) {
		if (EAC3_REGISTRATION_DESCRIPTOR.every((byte, j) => buffer[i + j] === byte)) {
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
});
