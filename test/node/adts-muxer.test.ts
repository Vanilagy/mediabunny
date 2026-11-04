import { beforeAll, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMediabunnyServer } from '@mediabunny/server';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { AdtsOutputFormat, MkvOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, textEncoder } from '../../src/misc.js';
import { buildAacAudioSpecificConfig } from '../../shared/aac-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

beforeAll(() => {
	registerMediabunnyServer();
});

test('ADTS muxer with raw AAC input', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const inputDecoderConfig = await audioTrack.getDecoderConfig();
	assert(inputDecoderConfig!.description); // MP4 has description

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await outputAsInput.getFormat()).toBe(ADTS);

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await audioTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await audioTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeUndefined(); // ADTS has no description

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// All packets should be ADTS frames now (start with 0xfff sync word)
		expect(packet.data[0]).toBe(0xff);
		expect((packet.data[1]! & 0xf0)).toBe(0xf0);
		count++;
	}

	expect(count).toBe(237);
});

test('ADTS muxer with ADTS input (passthrough)', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	const inputSink = new EncodedPacketSink(inputTrack);
	const outputSink = new EncodedPacketSink(outputTrack);

	let inputPacket = await inputSink.getFirstPacket();
	let outputPacket = await outputSink.getFirstPacket();
	let count = 0;

	while (inputPacket && outputPacket) {
		// Verify that the packets are identical
		expect(outputPacket.data).toEqual(inputPacket.data);
		expect(outputPacket.timestamp).toBe(inputPacket.timestamp);
		expect(outputPacket.duration).toBe(inputPacket.duration);

		inputPacket = await inputSink.getNextPacket(inputPacket);
		outputPacket = await outputSink.getNextPacket(outputPacket);
		count++;
	}

	expect(inputPacket).toBeNull();
	expect(outputPacket).toBeNull();
	expect(count).toBe(4557);
});

test('ID3v2 tag between frames', async () => {
	// Like timed metadata in HLS packed audio, or segments that were glued together
	const file = concat([...adtsFrames(5), id3V2Tag(), ...adtsFrames(5)]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(Array.from({ length: 10 }, (_, i) => 1024 * i / 44100));
});

test('Sample rate change between frames', async () => {
	// Like two files that were glued together
	const file = concat([...adtsFrames(5, 7), ...adtsFrames(5)]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([
		...Array.from({ length: 5 }, (_, i) => 1024 * i / 22050),
		...Array.from({ length: 5 }, (_, i) => 5 * 1024 / 22050 + 1024 * i / 44100),
	]);
});

test('Single frame', async () => {
	using input = new Input({
		source: new BufferSource(adtsFrames(1)[0]!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computePacketStats()).toMatchObject({ packetCount: 1 });
});

const concat = (parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}

	return result;
};

const adtsFrames = (count: number, samplingFrequencyIndex = 4) => Array.from({ length: count }, () => {
	const frameLength = 7 + 20;

	// AAC-LC, 44100 Hz by default, stereo, no CRC
	return new Uint8Array([
		0xff,
		0xf1,
		0x40 | (samplingFrequencyIndex << 2),
		0x80 | (frameLength >> 11),
		(frameLength >> 3) & 0xff,
		((frameLength & 7) << 5) | 0x1f,
		0xfc,
		...new Uint8Array(20),
	]);
});

const id3V2Tag = () => {
	const text = textEncoder.encode('Now playing');
	const frameSize = 1 + text.byteLength;

	return new Uint8Array([
		...textEncoder.encode('ID3'), 4, 0, 0, 0, 0, 0, 10 + frameSize,
		...textEncoder.encode('TIT2'), 0, 0, 0, frameSize, 0, 0,
		3, // UTF-8
		...text,
	]);
};

test('Program config element', async () => {
	const frames: Uint8Array[] = [];
	const output = new Output({
		format: new AdtsOutputFormat({ onFrame: data => frames.push(data.slice()) }),
		target: new BufferTarget(),
	});

	const source = new AudioSampleSource({
		codec: 'aac',
		bitrate: 128e3,
	});
	output.addAudioTrack(source);
	await output.start();

	const numberOfChannels = 4;
	const sampleRate = 48000;
	const data = new Float32Array(numberOfChannels * sampleRate);
	for (let i = 0; i < data.length; i++) {
		data[i] = Math.sin(2 * Math.PI * 440 * Math.floor(i / numberOfChannels) / sampleRate);
	}

	using sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels,
		sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();

	// FFmpeg's encoder describes the quad layout with a PCE instead of a channel configuration
	const channelConfiguration = ((frames[0]![2]! & 1) << 2) | (frames[0]![3]! >> 6);
	expect(channelConfiguration).toBe(0);

	expect(await decodeAacFrames(frames)).toEqual(frames.map(() => numberOfChannels));
	// Every frame carries the PCE, so decoding can start anywhere
	expect(await decodeAacFrames(frames.slice(10))).toEqual(frames.slice(10).map(() => numberOfChannels));

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getNumberOfChannels()).toBe(numberOfChannels);

	// Formats holding raw AAC take the PCE into the description
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat(), new MpegTsOutputFormat()]) {
		const remuxOutput = new Output({
			format,
			target: new BufferTarget(),
		});
		const remuxSource = new EncodedAudioPacketSource('aac');
		remuxOutput.addAudioTrack(remuxSource);
		await remuxOutput.start();

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await remuxSource.add(packet, { decoderConfig });
		}
		await remuxOutput.finalize();

		using remuxInput = new Input({
			source: new BufferSource(remuxOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const remuxTrack = await remuxInput.getPrimaryAudioTrack();
		assert(remuxTrack);
		expect(await remuxTrack.getNumberOfChannels()).toBe(numberOfChannels);

		const remuxFrames: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(remuxTrack).packets()) {
			remuxFrames.push(packet.data);
		}
		const description = (await remuxTrack.getDecoderConfig())!.description;
		expect(await decodeAacFrames(remuxFrames, description)).toEqual(remuxFrames.map(() => numberOfChannels));
	}
});

const decodeAacFrames = async (frames: Uint8Array[], description?: AllowSharedBufferSource) => {
	const decoder = new NodeAvAudioDecoder();
	// @ts-expect-error Readonly
	decoder.codec = 'aac';
	// Without a description, the frames are taken as ADTS
	// @ts-expect-error Readonly
	decoder.config = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description,
	};

	const channelCounts: number[] = [];
	// @ts-expect-error Readonly
	decoder.onSample = (sample: AudioSample) => {
		channelCounts.push(sample.numberOfChannels);
		sample.close();
	};

	await decoder.init();
	for (let i = 0; i < frames.length; i++) {
		await decoder.decode(new EncodedPacket(frames[i]!, 'key', 1024 * i / 48000, 1024 / 48000));
	}
	await decoder.flush();
	await decoder.close();

	return channelCounts;
};

test('Unrepresentable channel configuration', async () => {
	const { output, addPacket } = await startAdtsOutput();

	// What FFmpeg's encoder writes for 7.1: channel configuration 12, too large for the 3-bit ADTS field
	const description = new Uint8Array([0x11, 0xe0, 0x56, 0xe5, 0x00]);
	await expect(addPacket(description)).rejects.toThrow('channel configuration 12');

	// The rejected packet mustn't leave the muxer half set up
	await expect(addPacket(description)).rejects.toThrow('channel configuration 12');
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty ADTS file');
});

test('Unrepresentable object type', async () => {
	const { addPacket } = await startAdtsOutput();

	// xHE-AAC (USAC)
	const description = new Uint8Array([0xf9, 0x46, 0x40, 0x00, 0x00]);
	await expect(addPacket(description)).rejects.toThrow('object type 42');
});

test('Unrepresentable sampling frequency', async () => {
	const { addPacket } = await startAdtsOutput();

	// A rate missing from the table, so it's spelled out after the escape index 15
	const explicitRate = buildAacAudioSpecificConfig({
		objectType: 2,
		outputSampleRate: 50000,
		outputNumberOfChannels: 2,
	});
	await expect(addPacket(explicitRate)).rejects.toThrow('sampling frequency index 15');

	// Reserved index 13
	await expect(addPacket(new Uint8Array([0x16, 0x90]))).rejects.toThrow('sampling frequency index 13');
});

test('Unrepresentable frame length', async () => {
	const { addPacket } = await startAdtsOutput();

	// AAC-LC with frameLengthFlag set, meaning 960-sample frames
	await expect(addPacket(new Uint8Array([0x11, 0x94]))).rejects.toThrow('frame length 960');
});

const startAdtsOutput = async () => {
	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	const addPacket = (description: Uint8Array) => source.add(
		new EncodedPacket(new Uint8Array(16), 'key', 0, 1024 / 48000),
		{
			decoderConfig: {
				codec: 'mp4a.40.2',
				numberOfChannels: 2,
				sampleRate: 48000,
				description,
			},
		},
	);

	return {
		output,
		addPacket,
	};
};
