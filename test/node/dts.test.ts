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
