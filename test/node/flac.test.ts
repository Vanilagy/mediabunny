import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { assert, toUint8Array } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource, CustomSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS, FLAC } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { VERSIONED_NAME } from '../../src/version.js';
import { AttachedImage, MetadataTags } from '../../src/metadata.js';
import { calculateCrc8 } from '../../src/flac/flac-misc.js';
import { Bitstream } from '../../shared/bitstream.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SAMPLE_PATH = path.join(__dirname, '..', 'public/sample.flac');
const SAMPLE_DURATION = 19.714285714285715;
const BLOCK_SIZE = 4096;

test('can loop over all samples', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toEqual(19.714285714285715);
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
	expect(await track.getTimeResolution()).toEqual(44100);
	expect(await input.getMimeType()).toEqual('audio/flac');

	const sink = new EncodedPacketSink(track);
	let samples = 0;
	let lastSampleTimestamp = 0;
	for await (const sample of sink.packets()) {
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
	const packetSink = new EncodedPacketSink(track);

	const packet = await packetSink.getPacket(10);
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.data.byteLength).toBe(8345);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);

	const nextPacket = await packetSink.getNextPacket(packet);
	assert(nextPacket);
	expect(nextPacket.timestamp).toBe(10.031020408163265);
	expect(nextPacket.data.byteLength).toBe(8988);
	expect(nextPacket.sequenceNumber).toBe(108);
	expect(nextPacket.duration).toBe(0.09287981859410431);

	const priorPacket = await packetSink.getPacket(3);
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
	const packetSink = new EncodedPacketSink(track);

	const packet = await packetSink.getPacket(10, { metadataOnly: true });
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
	expect(await inputTrack.getSampleRate()).toBe(await outputTrack.getSampleRate());
	expect(await inputTrack.getNumberOfChannels()).toBe(await outputTrack.getNumberOfChannels());
	expect(await inputTrack.getTimeResolution()).toBe(await outputTrack.getTimeResolution());

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
			DATE: '2020-01-01',
			vendor: VERSIONED_NAME,
		},
		images: inputImages,
	});

	const inputPacketSink = new EncodedPacketSink(inputTrack);
	const outputPacketSink = new EncodedPacketSink(outputTrack);
	let packets = 0;
	let timestamp = 0;
	for await (const packet of outputPacketSink.packets()) {
		packets++;
		timestamp = packet.timestamp;
	}

	expect(packets).toBe(213);
	expect(timestamp).toBe(19.690521541950112);

	// Test that packets are byte-identical
	const inputPacket = await inputPacketSink.getPacket(10);
	const outputPacket = await outputPacketSink.getPacket(10);

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

test('appendOnly writes correct STREAMINFO header', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const target = new BufferTarget();
	const output = new Output({
		format: new FlacOutputFormat({ appendOnly: true }),
		target,
	});

	const conversion = await Conversion.init({ input, output });
	await conversion.execute();

	assert(target.buffer);
	const bytes = new Uint8Array(target.buffer);

	// STREAMINFO: min_block=16, max_block=65535, min_frame=0, max_frame=0
	expect(bytes.slice(8, 18)).toEqual(new Uint8Array([
		// minimum_block_size=16
		0x00, 0x10,
		// maximum_block_size=65535
		0xFF, 0xFF,
		// minimum_frame_size=0
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	]));
});

test('can read a FLAC file with leading ID3v2 tags', async () => {
	const createId3V23TitleTag = (title: string) => {
		const titleBytes = new TextEncoder().encode(title);
		const frame = new Uint8Array(11 + titleBytes.length);
		frame.set([0x54, 0x49, 0x54, 0x32]); // TIT2
		frame[7] = 1 + titleBytes.length;
		frame[10] = 0; // ISO-8859-1
		frame.set(titleBytes, 11);

		const tag = new Uint8Array(10 + frame.length);
		tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]); // ID3v2.3
		tag[9] = frame.length;
		tag.set(frame, 10);

		return tag;
	};

	const concatenateBytes = (...chunks: Uint8Array[]) => {
		const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
		let offset = 0;

		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}

		return result;
	};

	using input = new Input({
		source: new BufferSource(concatenateBytes(
			createId3V23TitleTag('First tag'),
			createId3V23TitleTag('Second tag'),
			await fs.readFile(new URL('../public/sample.flac', import.meta.url)),
		)),
		formats: ALL_FORMATS,
	});

	expect(await input.canRead()).toBe(true);
	expect(await input.getFormat()).toBe(FLAC);

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getDurationFromMetadata()).toEqual(19.714285714285715);

	const firstPacket = await new EncodedPacketSink(track).getPacket(0);
	assert(firstPacket);
	expect(firstPacket.sequenceNumber).toBe(0);
	expect(firstPacket.timestamp).toBe(0);

	const metadataTags = await input.getMetadataTags();
	expect(metadataTags.title).toBe('First tag');
	expect(metadataTags.raw!['TIT2']).toBe('First tag');
	expect(metadataTags.raw!['TITLE']).toBe('The Happy Meeting');
});

test('Frame sample rate coded in kHz', async () => {
	using input = new Input({
		source: new BufferSource(createFlacFile({
			sampleRate: 12000,
			sampleRateBits: 0b1100,
			sampleRateExtraBytes: [12],
			frameCount: 5,
			totalSamples: 5 * BLOCK_SIZE,
		})),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toBe(5 * BLOCK_SIZE / 12000);
});

test('Total sample count spanning all 36 bits', async () => {
	const totalSamples = 2 ** 36 - 1;
	using input = new Input({
		source: new BufferSource(createFlacFile({
			sampleRate: 192000,
			sampleRateBits: 0b0011,
			sampleRateExtraBytes: [],
			frameCount: 1,
			totalSamples,
		})),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getDurationFromMetadata()).toBe(totalSamples / 192000);
});

const createFlacFile = (options: {
	sampleRate: number;
	sampleRateBits: number;
	sampleRateExtraBytes: number[];
	frameCount: number;
	totalSamples: number;
}) => {
	const frames: number[] = [];
	let frameSize = 0;

	for (let i = 0; i < options.frameCount; i++) {
		const frame = [
			0xff, 0xf8, // Sync code, fixed block size
			(0b1100 << 4) | options.sampleRateBits, // 4096 samples
			0b1000, // Mono, 16-bit
			i, // Frame number
			...options.sampleRateExtraBytes,
		];
		frame.push(calculateCrc8(new Uint8Array(frame)));
		frame.push(0, 0, 0); // Constant subframe of silence

		const crc = calculateCrc16(frame);
		frame.push(crc >> 8, crc & 0xff);

		frames.push(...frame);
		frameSize = frame.length;
	}

	const streamInfo = new Bitstream(new Uint8Array(34));
	streamInfo.writeBits(16, BLOCK_SIZE);
	streamInfo.writeBits(16, BLOCK_SIZE);
	streamInfo.writeBits(24, frameSize);
	streamInfo.writeBits(24, frameSize);
	streamInfo.writeBits(20, options.sampleRate);
	streamInfo.writeBits(3, 0); // Mono
	streamInfo.writeBits(5, 15); // 16-bit
	streamInfo.writeBits(4, Math.floor(options.totalSamples / 2 ** 32));
	streamInfo.writeBits(16, Math.floor(options.totalSamples / 2 ** 16) % 2 ** 16);
	streamInfo.writeBits(16, options.totalSamples % 2 ** 16);

	return new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, // fLaC
		0x80, 0x00, 0x00, 34, // Last metadata block: STREAMINFO
		...streamInfo.bytes,
		...frames,
	]);
};

const calculateCrc16 = (bytes: number[]) => {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++) {
			crc = (crc & 0x8000) ? (crc << 1) ^ 0x8005 : crc << 1;
			crc &= 0xffff;
		}
	}

	return crc;
};

test('Concurrent first timestamp and duration queries', async () => {
	const bytes = await fs.readFile(SAMPLE_PATH);
	using input = new Input({
		source: new CustomSource({
			getSize: () => bytes.byteLength,
			// Slow reads, so that both queries are waiting on the same frame at once
			read: (start, end) => new Promise(resolve => setTimeout(() => resolve(bytes.subarray(start, end)), 1)),
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await Promise.all([track.getFirstTimestamp(), track.computeDuration()])).toEqual([0, SAMPLE_DURATION]);
});

test('Packet lookup at packet start timestamps', async () => {
	await expectSequentialPacketLookups(packet => packet.timestamp);
});

test('Packet lookup at packet end timestamps', async () => {
	await expectSequentialPacketLookups(packet => packet.timestamp + packet.duration);
});

const expectSequentialPacketLookups = async (getTimestamp: (packet: EncodedPacket) => number) => {
	using referenceInput = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const referenceTrack = await referenceInput.getPrimaryAudioTrack();
	assert(referenceTrack);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(referenceTrack).packets(undefined, undefined, {
		metadataOnly: true,
	})) {
		packets.push(packet);
	}

	// A fresh input, so that each lookup has to load the packets it needs on demand
	using input = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	for (const packet of packets) {
		const timestamp = getTimestamp(packet);
		const retrievedPacket = await sink.getPacket(timestamp, { metadataOnly: true });
		expect(retrievedPacket?.sequenceNumber).toBe(packets.filter(x => x.timestamp <= timestamp).length - 1);
	}
};

test('Non-ASCII picture description', async () => {
	using input = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	const image: AttachedImage = {
		data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
		mimeType: 'image/png',
		kind: 'coverFront',
		description: `Caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x5c01, 0x9762)}`,
	};
	const conversion = await Conversion.init({
		input,
		output,
		tags: { images: [image] },
	});
	await conversion.execute();

	assert(output.target.buffer);
	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});
	expect((await outputAsInput.getMetadataTags()).images).toEqual([image]);
});

test('Single-frame output', async () => {
	using input = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	assert(packet);

	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();
	await source.add(packet, { decoderConfig });
	await output.finalize();

	assert(output.target.buffer);
	const view = new DataView(output.target.buffer);
	const minimumBlockSize = view.getUint16(8);
	const maximumBlockSize = view.getUint16(10);
	expect(minimumBlockSize).toBe(BLOCK_SIZE);
	expect(maximumBlockSize).toBe(BLOCK_SIZE);
});

test('Single-frame output shorter than 16 samples', async () => {
	using input = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const decoderConfig = (await (await input.getPrimaryAudioTrack())!.getDecoderConfig())!;

	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();

	// The muxer only looks at the frame header
	const blockSize = 10;
	const frame = new Uint8Array([
		0xff, 0xf8, // Sync code, fixed block size
		(0b0110 << 4) | 0b1001, // Uncommon 8-bit block size, 44.1 kHz
		(0b0001 << 4) | 0b1000, // Stereo, 16-bit
		0x00, // Frame number
		blockSize - 1,
	]);
	await source.add(new EncodedPacket(frame, 'key', 0, blockSize / 44100), { decoderConfig });
	await output.finalize();

	// STREAMINFO's block sizes must be at least 16, or FFmpeg refuses the file
	const view = new DataView(output.target.buffer!);
	const minimumBlockSize = view.getUint16(8);
	const maximumBlockSize = view.getUint16(10);
	expect(minimumBlockSize).toBe(16);
	expect(maximumBlockSize).toBe(16);
});

test('onFrame validation', () => {
	expect(() => new FlacOutputFormat({ onFrame: 5 as never })).toThrow(TypeError);
});

test('Sample numbers beyond 31 bits', async () => {
	using input = new Input({
		source: new BufferSource(variableBlockSizeFlacFile(2 ** 31 - 5000, 5)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		durations.push(packet.duration);
	}
	expect(durations).toEqual(Array(5).fill(BLOCK_SIZE / 44100));
});

const variableBlockSizeFlacFile = (firstSampleNumber: number, frameCount: number) => {
	const streamInfo = new Bitstream(new Uint8Array(34));
	streamInfo.writeBits(16, BLOCK_SIZE);
	streamInfo.writeBits(16, BLOCK_SIZE);
	streamInfo.skipBits(48); // Unknown frame sizes
	streamInfo.writeBits(20, 44100);
	streamInfo.writeBits(3, 0); // Mono
	streamInfo.writeBits(5, 15); // 16-bit

	const frames = Array.from({ length: frameCount }, (_, i) => {
		const header = [
			0xff, 0xf9, // Sync code, variable block size
			(0b1100 << 4) | 0b1001, // 4096 samples, 44.1 kHz
			0b1000, // Mono, 16-bit
			...flacCodedNumber(firstSampleNumber + BLOCK_SIZE * i),
		];

		// Then a constant subframe of silence and the CRC-16, which isn't checked
		return [...header, calculateCrc8(new Uint8Array(header)), 0, 0, 0, 0, 0];
	});

	return new Uint8Array([
		0x66, 0x4c, 0x61, 0x43, // fLaC
		0x80, 0x00, 0x00, 34, // Last metadata block: STREAMINFO
		...streamInfo.bytes,
		...frames.flat(),
	]);
};

// The UTF-8-like coding of frame and sample numbers, for numbers that don't fit into a single byte
const flacCodedNumber = (value: number) => {
	let continuationByteCount = 1;
	while (value >= 2 ** (5 * continuationByteCount + 6)) {
		continuationByteCount++;
	}

	return [
		((0xff << (7 - continuationByteCount)) & 0xff) | Math.floor(value / 2 ** (6 * continuationByteCount)),
		...Array.from(
			{ length: continuationByteCount },
			(_, i) => 0x80 | (Math.floor(value / 2 ** (6 * (continuationByteCount - 1 - i))) % 64),
		),
	];
};

test('Picture exceeding the metadata block size limit', async () => {
	await testOversizedMetadataBlock({
		images: [{
			data: new Uint8Array(2 ** 24),
			mimeType: 'image/png',
			kind: 'coverFront',
		}],
	});
});

test('Vorbis comment exceeding the metadata block size limit', async () => {
	await testOversizedMetadataBlock({ comment: 'a'.repeat(2 ** 24) });
});

const testOversizedMetadataBlock = async (tags: MetadataTags) => {
	using input = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await track.getDecoderConfig())!;
	const packet = (await new EncodedPacketSink(track).getFirstPacket())!;

	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});
	output.setMetadataTags(tags);
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();

	// The block's 24-bit size field used to silently overflow, making the file unreadable
	await expect(source.add(packet, { decoderConfig })).rejects.toThrow('too big for FLAC');
};

test('Output with more than 2^32 samples', async () => {
	using input = new Input({
		source: new FilePathSource(SAMPLE_PATH),
		formats: ALL_FORMATS,
	});
	const decoderConfig = (await (await input.getPrimaryAudioTrack())!.getDecoderConfig())!;

	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();

	// The biggest block size there is, so that it takes as few frames as possible. The muxer only looks at the frame
	// header, so that's all there is to them.
	const blockSize = 65535;
	const frameCount = Math.ceil(2 ** 32 / blockSize) + 1;
	const frame = new Uint8Array([
		0xff, 0xf8, // Sync code, fixed block size
		(0b0111 << 4) | 0b1001, // Uncommon 16-bit block size, 44.1 kHz
		(0b0001 << 4) | 0b1000, // Stereo, 16-bit
		0x00, // Frame number
		(blockSize - 1) >> 8,
		(blockSize - 1) & 0xff,
	]);
	for (let i = 0; i < frameCount; i++) {
		const packet = new EncodedPacket(frame, 'key', i * blockSize / 44100, blockSize / 44100);
		await source.add(packet, { decoderConfig });
	}
	await output.finalize();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = (await outputAsInput.getPrimaryAudioTrack())!;
	expect(await track.getDurationFromMetadata()).toBe(frameCount * blockSize / decoderConfig.sampleRate);
});
