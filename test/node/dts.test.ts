import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat, MpegTsOutputFormat, OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, uint8ArraysAreEqual } from '../../src/misc.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSample } from '../../src/sample.js';
import { canEncode, Quality } from '../../src/encode.js';
import { registerDtsDecoder, registerDtsEncoder } from '@mediabunny/dts';

const __dirname = new URL('.', import.meta.url).pathname;

const DTSC_FILE = 'toothsome-dts.mp4';
const ESDS_FILE = 'toothsome-dts-esds.mp4';

const MP4_TIMESTAMP_TOLERANCE = 0;
const MATROSKA_TIMESTAMP_TOLERANCE = 1 / 1000;
const MPEG_TS_TIMESTAMP_TOLERANCE = 1 / 90_000;

test('Read from MP4 with a dtsc sample entry', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', DTSC_FILE)),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	expect(await track.getCodec()).toBe('dts');
	expect(decoderConfig.codec).toBe('dtsc');
	expect(decoderConfig.description).toBeUndefined();

	// This file declares 48000 in its sample entry, which the ddts box then corrects to the real rate
	expect(await track.getSampleRate()).toBe(24000);
	expect(await track.getNumberOfChannels()).toBe(2);

	await expectStreamShape(input);
});

test('Read from MP4 with an esds sample entry', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', ESDS_FILE)),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	expect(await track.getCodec()).toBe('dts');
	expect(decoderConfig.codec).toBe('dtsc');
	expect(decoderConfig.description).toBeUndefined();

	expect(await track.getSampleRate()).toBe(24000);
	expect(await track.getNumberOfChannels()).toBe(2);

	await expectStreamShape(input);
});

test('Transmux dtsc MP4 into MP4', async () => {
	await expectTransmuxToPreservePackets(DTSC_FILE, new Mp4OutputFormat(), MP4_TIMESTAMP_TOLERANCE);
});

test('Transmux dtsc MP4 into Matroska', async () => {
	await expectTransmuxToPreservePackets(DTSC_FILE, new MkvOutputFormat(), MATROSKA_TIMESTAMP_TOLERANCE);
});

test('Transmux dtsc MP4 into MPEG-TS', async () => {
	await expectTransmuxToPreservePackets(DTSC_FILE, new MpegTsOutputFormat(), MPEG_TS_TIMESTAMP_TOLERANCE);
});

test('Transmux esds MP4 into MP4', async () => {
	await expectTransmuxToPreservePackets(ESDS_FILE, new Mp4OutputFormat(), MP4_TIMESTAMP_TOLERANCE);
});

test('Transmux esds MP4 into Matroska', async () => {
	await expectTransmuxToPreservePackets(ESDS_FILE, new MkvOutputFormat(), MATROSKA_TIMESTAMP_TOLERANCE);
});

test('Transmux esds MP4 into MPEG-TS', async () => {
	await expectTransmuxToPreservePackets(ESDS_FILE, new MpegTsOutputFormat(), MPEG_TS_TIMESTAMP_TOLERANCE);
});

test('Custom coder registration', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', DTSC_FILE)),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.canDecode()).toBe(false);
	expect(await canEncode('dts')).toBe(false);

	registerDtsDecoder();
	registerDtsEncoder();

	expect(await track.canDecode()).toBe(true);
	expect(await canEncode('dts')).toBe(true);
});

test('Decode with the extension', async () => {
	registerDtsDecoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', DTSC_FILE)),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const { packetCount } = await track.computePacketStats();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBeCloseTo(512 / 24000);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(2);
		expect(sample.sampleRate).toBe(24000);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

test('Encode with the extension', async () => {
	registerDtsEncoder();

	const output = await encodeSineWaveToMp4(0, new Mp4OutputFormat());

	using input = new Input({
		source: new BufferSource(output),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('dts');
	expect(await track.getSampleRate()).toBe(ENCODE_SAMPLE_RATE);
	expect(await track.getNumberOfChannels()).toBe(ENCODE_CHANNELS);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.codec).toBe('dtsc');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;

	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}

	expect(packetCount).toBeGreaterThan(0);
	expect(await track.computeDuration()).toBeCloseTo(ENCODE_DURATION, 1);
});

test('Round-trip through the extension', async () => {
	registerDtsDecoder();
	registerDtsEncoder();

	const output = await encodeSineWaveToMp4(0, new Mp4OutputFormat());

	using input = new Input({
		source: new BufferSource(output),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioSampleSink(track);
	const chunks: Float32Array[] = [];
	let decodedFrames = 0;

	for await (using sample of sink.samples()) {
		expect(sample.numberOfChannels).toBe(ENCODE_CHANNELS);
		expect(sample.sampleRate).toBe(ENCODE_SAMPLE_RATE);
		decodedFrames += sample.numberOfFrames;

		const chunk = new Float32Array(
			new ArrayBuffer(sample.allocationSize({ format: 'f32-planar', planeIndex: 0 })),
		);
		sample.copyTo(chunk, { format: 'f32-planar', planeIndex: 0 });
		chunks.push(chunk);
	}

	expect(decodedFrames).toBeGreaterThanOrEqual(ENCODE_SAMPLE_RATE * ENCODE_DURATION);

	const signal = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		signal.set(chunk, offset);
		offset += chunk.length;
	}

	expect(sine440Score(signal, ENCODE_SAMPLE_RATE, 440)).toBeGreaterThan(0.98);
});

test('Encode with huge timestamps', async () => {
	registerDtsDecoder();
	registerDtsEncoder();

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
});

const expectStreamShape = async (input: Input) => {
	const packets = await readAllPackets(input);

	expect(packets.length).toBe(1805);
	expect(packets.every(packet => packet.type === 'key')).toBe(true);
	expect(packets.every(packet => packet.data.byteLength === 512)).toBe(true);
};

/** Converts the file without re-encoding and checks that every packet comes back out unchanged. */
const expectTransmuxToPreservePackets = async (
	fileName: string,
	outputFormat: OutputFormat,
	timestampTolerance: number,
) => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', fileName)),
		formats: ALL_FORMATS,
	});

	const originalPackets = await readAllPackets(originalInput);

	const output = new Output({
		format: outputFormat,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	const { buffer } = output.target;
	assert(buffer);

	using newInput = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const newTrack = await newInput.getPrimaryAudioTrack();
	assert(newTrack);

	const newDecoderConfig = await newTrack.getDecoderConfig();
	assert(newDecoderConfig);

	expect(await newTrack.getCodec()).toBe('dts');
	expect(await newTrack.getSampleRate()).toBe(24000);
	expect(await newTrack.getNumberOfChannels()).toBe(2);

	// Only the MP4 sample entry can carry this, so for the other formats it comes back out of the bitstream
	expect(newDecoderConfig.codec).toBe('dtsc');

	const newPackets = await readAllPackets(newInput);
	expectPacketsToMatch(newPackets, originalPackets, timestampTolerance);
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

const readAllPackets = async (input: Input) => {
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];

	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	return packets;
};

const ENCODE_SAMPLE_RATE = 48000;
const ENCODE_CHANNELS = 2;
const ENCODE_DURATION = 2;
const ENCODE_BITRATE = 768000;

const encodeSineWaveToMp4 = async (startTimestamp: number, format: Mp4OutputFormat) => {
	const totalFrames = ENCODE_SAMPLE_RATE * ENCODE_DURATION;
	const data = new Float32Array(totalFrames * ENCODE_CHANNELS);

	for (let i = 0; i < totalFrames; i++) {
		const value = Math.sin(2 * Math.PI * 440 * i / ENCODE_SAMPLE_RATE);
		for (let channel = 0; channel < ENCODE_CHANNELS; channel++) {
			data[i * ENCODE_CHANNELS + channel] = value;
		}
	}

	const output = new Output({ format, target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'dts', quality: new Quality({ bitrate: ENCODE_BITRATE }) });
	output.addAudioTrack(source);

	await output.start();

	const sample = new AudioSample({
		data,
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

/** Returns the fraction of the signal's energy explained by a pure sine at `freq`. */
const sine440Score = (x: Float32Array, sampleRate: number, freq: number) => {
	const w = 2 * Math.PI * freq / sampleRate;

	let ss = 0, cc = 0, sc = 0;
	let xs = 0, xc = 0;
	let xx = 0;

	for (let n = 0; n < x.length; n++) {
		const s = Math.sin(w * n);
		const c = Math.cos(w * n);

		ss += s * s;
		cc += c * c;
		sc += s * c;

		xs += x[n]! * s;
		xc += x[n]! * c;
		xx += x[n]! * x[n]!;
	}

	const det = ss * cc - sc * sc;

	const a = (xs * cc - xc * sc) / det;
	const b = (xc * ss - xs * sc) / det;

	let fitEnergy = 0;

	for (let n = 0; n < x.length; n++) {
		const y = a * Math.sin(w * n) + b * Math.cos(w * n);
		fitEnergy += y * y;
	}

	return fitEnergy / xx;
};
