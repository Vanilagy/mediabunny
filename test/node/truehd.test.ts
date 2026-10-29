import { expect, test } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { InputAudioTrack } from '../../src/input-track.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat, OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample } from '../../src/sample.js';
import { canEncode } from '../../src/encode.js';
import { assert, uint8ArraysAreEqual } from '../../src/misc.js';
import { registerTrueHdDecoder, registerTrueHdEncoder } from '@mediabunny/truehd';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const TRUEHD_FILE = path.join(__dirname, '..', 'public', 'truehd.mp4');

// SHA-256 of FFmpeg's decode of TRUEHD_FILE, as interleaved s32le
const TRUEHD_FILE_PCM_HASH = 'ab9198237c9f79cd53f725de82dc167bee25140eba8d54bc5b3f9af15d853cb0';

const ENCODE_SAMPLE_RATE = 48000;
const ENCODE_CHANNELS = 2;
const ENCODE_DURATION = 2;

test('ISOBMFF demuxing and muxing', async () => {
	using input = new Input({
		source: new FilePathSource(TRUEHD_FILE),
		formats: ALL_FORMATS,
	});
	const packets = await expectTrueHdTrack(input);

	using newInput = await convert(input, new Mp4OutputFormat());
	const newPackets = await expectTrueHdTrack(newInput);
	expectPacketsToMatch(newPackets, packets, 0);
});

test('Matroska muxing and demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(TRUEHD_FILE),
		formats: ALL_FORMATS,
	});
	const packets = await expectTrueHdTrack(input);

	using newInput = await convert(input, new MkvOutputFormat());
	const newPackets = await expectTrueHdTrack(newInput);
	expectPacketsToMatch(newPackets, packets, 1 / 1000);
});

test('Custom coder registration', async () => {
	using input = new Input({
		source: new FilePathSource(TRUEHD_FILE),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.canDecode()).toBe(false);
	expect(await canEncode('truehd')).toBe(false);

	registerTrueHdDecoder();
	registerTrueHdEncoder();

	expect(await track.canDecode()).toBe(true);
	expect(await canEncode('truehd')).toBe(true);
});

test('Decode with the extension', async () => {
	registerTrueHdDecoder();

	using input = new Input({
		source: new FilePathSource(TRUEHD_FILE),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const { samples, data } = await decodeToS32(track);

	// Packets get sent to the decoder in batches, but each one still comes back as its own sample
	expect(samples.length).toBe(6000);
	expect(data.length).toBe(6000 * 40 * 6);

	let nextTimestamp = 0;
	for (const sample of samples) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBeCloseTo(40 / 48000);
		expect(sample.format).toBe('s32');
		expect(sample.numberOfChannels).toBe(6);
		expect(sample.sampleRate).toBe(48000);

		nextTimestamp += sample.duration;
	}

	// TrueHD is lossless, so we must match FFmpeg here
	const hash = createHash('sha256').update(new Uint8Array(data.buffer)).digest('hex');
	expect(hash).toBe(TRUEHD_FILE_PCM_HASH);
});

test('Seek and decode with the extension', async () => {
	registerTrueHdDecoder();

	using input = new Input({
		source: new FilePathSource(TRUEHD_FILE),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const full = await decodeToS32(track);
	const partial = await decodeToS32(track, 2.5, 3);

	// Decoding has to start at the major sync before the seek point
	const firstSample = partial.samples[0]!;
	expect(firstSample.timestamp).toBeLessThanOrEqual(2.5);
	expect(firstSample.timestamp + firstSample.duration).toBeGreaterThan(2.5);

	const offset = 6 * Math.round(48000 * firstSample.timestamp);
	const expected = full.data.slice(offset, offset + partial.data.length);
	expect(uint8ArraysAreEqual(new Uint8Array(partial.data.buffer), new Uint8Array(expected.buffer))).toBe(true);
});

test('Encode with the extension', async () => {
	registerTrueHdEncoder();

	const output = await encodeSineWaveToMp4(0, new Mp4OutputFormat());

	using input = new Input({
		source: new BufferSource(output),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('truehd');
	expect(await track.getSampleRate()).toBe(ENCODE_SAMPLE_RATE);
	expect(await track.getNumberOfChannels()).toBe(ENCODE_CHANNELS);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.codec).toBe('mlpa');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	// FFmpeg's encoder writes a major sync every 16 access units
	expect(packets.length).toBe(ENCODE_SAMPLE_RATE * ENCODE_DURATION / 40);
	expect(packets.map(x => x.type)).toEqual(packets.map((_, i) => i % 16 === 0 ? 'key' : 'delta'));

	expect(await track.computeDuration()).toBeCloseTo(ENCODE_DURATION);
});

test('Round-trip through the extension', async () => {
	registerTrueHdDecoder();
	registerTrueHdEncoder();

	const output = await encodeSineWaveToMp4(0, new Mp4OutputFormat());

	using input = new Input({
		source: new BufferSource(output),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioSampleSink(track);
	const chunks: Float32Array[] = [];

	for await (using sample of sink.samples()) {
		expect(sample.numberOfChannels).toBe(ENCODE_CHANNELS);
		expect(sample.sampleRate).toBe(ENCODE_SAMPLE_RATE);

		const chunk = new Float32Array(sample.allocationSize({ format: 'f32', planeIndex: 0 }) / 4);
		sample.copyTo(chunk, { format: 'f32', planeIndex: 0 });
		chunks.push(chunk);
	}

	const signal = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		signal.set(chunk, offset);
		offset += chunk.length;
	}

	const original = createSineWave();
	expect(signal.length).toBe(original.length);

	let maxError = 0;
	for (let i = 0; i < original.length; i++) {
		maxError = Math.max(maxError, Math.abs(signal[i]! - original[i]!));
	}
	expect(maxError).toBeLessThan(2 ** -22);
});

test('Encode with huge timestamps', async () => {
	registerTrueHdDecoder();
	registerTrueHdEncoder();

	const timestamp = 1e9;
	const output = await encodeSineWaveToMp4(timestamp, new Mp4OutputFormat({ fastStart: 'fragmented' }));

	using input = new Input({
		source: new BufferSource(output),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);

	expect(firstPacket.timestamp).toBe(timestamp);

	const sampleSink = new AudioSampleSink(track);
	const firstSample = (await sampleSink.samples(timestamp).next()).value;
	assert(firstSample);

	expect(firstSample.timestamp).toBe(timestamp);
	firstSample.close();
});

const expectTrueHdTrack = async (input: Input) => {
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('truehd');
	expect(await track.getSampleRate()).toBe(48000);
	expect(await track.getNumberOfChannels()).toBe(6);
	expect(await track.hasOnlyKeyPackets()).toBe(false);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.codec).toBe('mlpa');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	// 5 seconds of 40-sample access units at 48 kHz
	expect(packets.length).toBe(6000);
	expect(packets.filter(x => x.type === 'key').length).toBe(375);
	expect(packets[0]!.type).toBe('key');

	const determinedTypes = await Promise.all(packets.map(x => track.determinePacketType(x)));
	expect(determinedTypes).toEqual(packets.map(x => x.type));

	const packet = await sink.getPacket(2.5);
	assert(packet);
	expect(packet.type).toBe('delta');

	const keyPacket = await sink.getKeyPacket(2.5, { verifyKeyPackets: true });
	assert(keyPacket);
	expect(keyPacket.type).toBe('key');
	expect(keyPacket.timestamp).toBeLessThan(packet.timestamp);
	expect(packet.timestamp - keyPacket.timestamp).toBeLessThan(16 * 40 / 48000);

	return packets;
};

const convert = async (input: Input, format: OutputFormat) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	const { buffer } = output.target;
	assert(buffer);

	return new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});
};

const expectPacketsToMatch = (actual: EncodedPacket[], expected: EncodedPacket[], timestampTolerance: number) => {
	expect(actual.length).toBe(expected.length);

	for (let i = 0; i < expected.length; i++) {
		const actualPacket = actual[i]!;
		const expectedPacket = expected[i]!;

		expect(actualPacket.type).toBe(expectedPacket.type);
		expect(uint8ArraysAreEqual(actualPacket.data, expectedPacket.data)).toBe(true);
		expect(Math.abs(actualPacket.timestamp - expectedPacket.timestamp)).toBeLessThanOrEqual(timestampTolerance);
	}
};

const decodeToS32 = async (track: InputAudioTrack, startTimestamp?: number, endTimestamp?: number) => {
	const sink = new AudioSampleSink(track);
	const samples: {
		timestamp: number;
		duration: number;
		format: AudioSampleFormat;
		numberOfChannels: number;
		sampleRate: number;
	}[] = [];
	const chunks: Int32Array[] = [];

	for await (using sample of sink.samples(startTimestamp, endTimestamp)) {
		samples.push({
			timestamp: sample.timestamp,
			duration: sample.duration,
			format: sample.format,
			numberOfChannels: sample.numberOfChannels,
			sampleRate: sample.sampleRate,
		});

		const chunk = new Int32Array(sample.allocationSize({ format: 's32', planeIndex: 0 }) / 4);
		sample.copyTo(chunk, { format: 's32', planeIndex: 0 });
		chunks.push(chunk);
	}

	const data = new Int32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.length;
	}

	return { samples, data };
};

const encodeSineWaveToMp4 = async (startTimestamp: number, format: Mp4OutputFormat) => {
	const output = new Output({ format, target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'truehd' });
	output.addAudioTrack(source);

	await output.start();

	const sample = new AudioSample({
		data: createSineWave(),
		format: 'f32',
		numberOfChannels: ENCODE_CHANNELS,
		sampleRate: ENCODE_SAMPLE_RATE,
		timestamp: startTimestamp,
	});
	await source.add(sample);
	sample.close();
	source.close();

	await output.finalize();

	const { buffer } = output.target;
	assert(buffer);

	return buffer;
};

const createSineWave = () => {
	const totalFrames = ENCODE_SAMPLE_RATE * ENCODE_DURATION;
	const data = new Float32Array(totalFrames * ENCODE_CHANNELS);

	for (let i = 0; i < totalFrames; i++) {
		const value = 0.5 * Math.sin(2 * Math.PI * 440 * i / ENCODE_SAMPLE_RATE);
		for (let channel = 0; channel < ENCODE_CHANNELS; channel++) {
			data[i * ENCODE_CHANNELS + channel] = value;
		}
	}

	return data;
};
