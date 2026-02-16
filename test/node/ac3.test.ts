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
import { canEncode } from '../../src/encode.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';

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

test('Custom coder registration', async () => {
	using ac3Input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});
	using eac3Input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const ac3Track = (await ac3Input.getPrimaryAudioTrack())!;
	const eac3Track = (await eac3Input.getPrimaryAudioTrack())!;

	// Before registration, nothing can decode or encode AC3/EAC3
	expect(await ac3Track.canDecode()).toBe(false);
	expect(await eac3Track.canDecode()).toBe(false);
	expect(await canEncode('ac3')).toBe(false);
	expect(await canEncode('eac3')).toBe(false);

	registerAc3Decoder();
	registerAc3Encoder();

	// After registration, both should work
	expect(await ac3Track.canDecode()).toBe(true);
	expect(await eac3Track.canDecode()).toBe(true);
	expect(await canEncode('ac3')).toBe(true);
	expect(await canEncode('eac3')).toBe(true);
});

test('AC-3 decoding', async () => {
	registerAc3Decoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const { packetCount } = await track.computePacketStats();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBe(0.032);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(track.numberOfChannels);
		expect(sample.sampleRate).toBe(track.sampleRate);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

test('E-AC-3 decoding', async () => {
	registerAc3Decoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const { packetCount } = await track.computePacketStats();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBe(0.032);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(track.numberOfChannels);
		expect(sample.sampleRate).toBe(track.sampleRate);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

const createSineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
	const totalFrames = sampleRate * durationSeconds;
	const data = new Float32Array(totalFrames * channels);

	for (let i = 0; i < totalFrames; i++) {
		const value = Math.sin(2 * Math.PI * 440 * i / sampleRate);
		for (let ch = 0; ch < channels; ch++) {
			data[i * channels + ch] = value;
		}
	}

	return data;
};

test('AC-3 encoding', async () => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'ac3', bitrate: 192000 });
	output.addAudioTrack(audioSource);

	await output.start();
	await audioSource.add(new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(track.codec).toBe('ac3');
	expect(track.sampleRate).toBe(sampleRate);
	expect(track.numberOfChannels).toBe(channels);

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(0);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('E-AC-3 encoding', async () => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'eac3', bitrate: 192000 });
	output.addAudioTrack(audioSource);

	await output.start();
	await audioSource.add(new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(track.codec).toBe('eac3');
	expect(track.sampleRate).toBe(sampleRate);
	expect(track.numberOfChannels).toBe(channels);

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(0);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});
