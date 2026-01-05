import { expect, test } from 'vitest';
import path from 'node:path';
import { assert, toUint8Array } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS, FLAC } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { PacketCursor } from '../../src/cursors.js';
import { PacketReader } from '../../src/packet.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('can loop over all samples', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toEqual(19.71428571428571);
	expect(await track.getDecoderConfig()).toEqual({
		codec: 'flac',
		numberOfChannels: 2,
		sampleRate: 44100,
		description: new Uint8Array([
			102, 76, 97, 67, 128, 0, 0, 34, 16, 0, 16, 0, 0, 6, 45, 0, 37, 173, 10,
			196, 66, 240, 0, 13, 68, 24, 85, 22, 231, 0, 113, 139, 185, 1, 33, 54,
			155, 80, 241, 191, 203, 112,
		]),
	});
	expect(await track.getCodecParameterString()).toEqual('flac');
	expect(track.timeResolution).toEqual(44100);
	expect(await input.getMimeType()).toEqual('audio/flac');

	const cursor = new PacketCursor(track);

	let samples = 0;
	let lastSampleTimestamp = 0;
	for await (const sample of cursor) {
		samples++;
		lastSampleTimestamp = sample.timestamp;
		if (sample.sequenceNumber === 212) {
			// Last frame is a bit shorter
			// due it having a custom block size and the duration not being a multiple of the frame size
			expect(sample.duration).toEqual(0.023764172335600908);
		} else {
			expect(sample.duration).toEqual(0.09287981859410431);
		}
	}
	expect(samples).toBe(213);
	expect(lastSampleTimestamp).toBe(19.690521541950112);
});

test('can do random access', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const reader = new PacketReader(track);

	const packet = await reader.getAt(10);
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.data.byteLength).toBe(8345);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);

	const nextPacket = await reader.getNext(packet);
	assert(nextPacket);
	expect(nextPacket.timestamp).toBe(10.031020408163265);
	expect(nextPacket.data.byteLength).toBe(8988);
	expect(nextPacket.sequenceNumber).toBe(108);
	expect(nextPacket.duration).toBe(0.09287981859410431);

	const priorPacket = await reader.getAt(3);
	assert(priorPacket);
	expect(priorPacket.timestamp).toBe(2.972154195011338);
	expect(priorPacket.data.byteLength).toBe(6877);
	expect(priorPacket.sequenceNumber).toBe(32);
	expect(priorPacket.duration).toBe(0.09287981859410431);
});

test('can get metadata-only packets', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const reader = new PacketReader(track);

	const packet = await reader.getAt(10, { metadataOnly: true });
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.isMetadataOnly).toBe(true);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);
});

test('can get metadata', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const { images: inputImages, ...descriptiveMetadata } = await input.getMetadataTags();

	expect(inputImages![0]!.data).toHaveLength(4852);
	expect(inputImages![0]!.data.slice(0, 8)).toEqual(new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10,
	]));
	expect(inputImages![0]!.mimeType).toBe('image/png');
	expect(inputImages![0]!.description).toBe('Album cover');
	expect(inputImages![0]!.kind).toBe('coverFront');

	expect(descriptiveMetadata).toEqual({
		title: 'The Happy Meeting',
		date: new Date('2020'),
		album: 'Samples files',
		artist: 'Samples Files',
		trackNumber: 4,
		genre: 'Ambient',
		raw: {
			ALBUM: 'Samples files',
			ARTIST: 'Samples Files',
			DATE: '2020',
			ENCODER: 'Lavf58.76.100',
			GENRE: 'Ambient',
			TITLE: 'The Happy Meeting',
			TRACKNUMBER: '4',
			vendor: 'Lavf58.76.100',
		},
	});
});

test('can re-mux a .flac', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	let framesWritten = 0;

	const output = new Output({
		format: new FlacOutputFormat({
			onFrame() {
				framesWritten++;
			},
		}),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	expect(framesWritten).toBe(213);

	const buffer = output.target.buffer;
	assert(buffer);

	const outputAsInput = new Input({
		source: new BufferSource(buffer),
		formats: [FLAC],
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);
	expect(inputTrack.sampleRate).toBe(outputTrack.sampleRate);
	expect(inputTrack.numberOfChannels).toBe(outputTrack.numberOfChannels);
	expect(inputTrack.timeResolution).toBe(outputTrack.timeResolution);

	const outputMetadataTags = await outputAsInput.getMetadataTags();

	const inputMetadataTags = await input.getMetadataTags();
	expect(inputMetadataTags.images).toHaveLength(1);
	expect(Object.keys(outputMetadataTags)).toEqual([
		'images',
		'raw',
		'title',
		'date',
		'album',
		'artist',
		'trackNumber',
		'genre',
	]);

	const { images: inputImages, ...otherInputMetadataTags } = inputMetadataTags;

	expect(outputMetadataTags).toEqual({
		...otherInputMetadataTags,
		raw: {
			...otherInputMetadataTags.raw,
			vendor: 'Mediabunny',
		},
		images: inputImages,
	});

	const inputReader = new PacketReader(inputTrack);
	const outputReader = new PacketReader(outputTrack);
	const outputCursor = new PacketCursor(outputTrack);

	let packets = 0;
	let timestamp = 0;
	for await (const packet of outputCursor) {
		packets++;
		timestamp = packet.timestamp;
	}

	expect(packets).toBe(213);
	expect(timestamp).toBe(19.690521541950112);

	// Test that packets are byte-identical
	const inputPacket = await inputReader.getAt(10);
	const outputPacket = await outputReader.getAt(10);

	assert(inputPacket);
	assert(outputPacket);

	const { data: inputPacketData, ...otherInputPacket } = inputPacket;
	const { data: outputPacketData, ...otherOutputPacket } = outputPacket;

	expect(otherInputPacket).toEqual(otherOutputPacket);
	expect(inputPacketData).toEqual(outputPacketData);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	assert(inputDecoderConfig);
	assert(outputDecoderConfig);

	const { description: inputDescription, ...otherInputDecoderConfig } = inputDecoderConfig;
	const { description: outputDescription, ...otherOutputDecoderConfig } = outputDecoderConfig;

	assert(inputDescription);
	assert(outputDescription);

	const inputArray = toUint8Array(inputDescription);
	const outputArray = toUint8Array(outputDescription);

	const inputWithoutCrc = inputArray.slice(0, -16);
	const outputWithoutCrc = outputArray.slice(0, -16);
	expect(inputWithoutCrc).toEqual(outputWithoutCrc);

	expect(otherInputDecoderConfig).toEqual(otherOutputDecoderConfig);
});
