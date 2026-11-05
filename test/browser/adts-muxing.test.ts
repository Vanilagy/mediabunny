import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget, type StreamTargetChunk } from '../../src/target.js';
import { AdtsOutputFormat } from '../../src/output-format.js';
import { assert } from '../../src/misc.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacket } from '../../src/packet.js';
import { buildAacAudioSpecificConfig } from '../../shared/aac-misc.js';

const createBufferingStreamTarget = () => {
	const written = new Map<number, Uint8Array>();

	const stream = new WritableStream<StreamTargetChunk>({
		async write(chunk: StreamTargetChunk) {
			written.set(chunk.position, chunk.data.slice());
		},
	});

	const toBuffer = () => {
		let maxEnd = 0;
		for (const [offset, data] of written) {
			maxEnd = Math.max(maxEnd, offset + data.byteLength);
		}
		const buffer = new Uint8Array(maxEnd);
		for (const [offset, data] of written) {
			buffer.set(data, offset);
		}
		return buffer;
	};

	return { stream, toBuffer };
};

test('ADTS with metadata over StreamTarget', async () => {
	const target = createBufferingStreamTarget();

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new StreamTarget(target.stream),
	});

	output.setMetadataTags({ comment: 'Remotion' });

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);

	let isFirst = true;
	for await (const packet of sink.packets()) {
		await audioSource.add(packet, {
			decoderConfig: isFirst ? (await audioTrack.getDecoderConfig())! : undefined,
		});
		isFirst = false;
	}

	await output.finalize();

	const buffer = target.toBuffer();
	using outputAsInput = new Input({
		source: new BufferSource(buffer.buffer),
		formats: ALL_FORMATS,
	});

	const readTags = await outputAsInput.getMetadataTags();
	expect(readTags.comment).toBe('Remotion');

	const outputAudioTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputAudioTrack);
	expect(await outputAudioTrack.getCodec()).toBe('aac');
});

// Previously, write handler rejections were silently swallowed and surfaced as
// "Cannot write to a closing writable stream" instead of the actual error.
test('StreamTarget write errors surface directly', async () => {
	let writeCount = 0;
	const stream = new WritableStream<StreamTargetChunk>({
		async write() {
			writeCount++;
			if (writeCount === 2) {
				throw new Error('OPFS write failed');
			}
		},
	});

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new StreamTarget(stream),
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);

	const run = async () => {
		let isFirst = true;
		for await (const packet of sink.packets()) {
			await audioSource.add(packet, {
				decoderConfig: isFirst ? (await audioTrack.getDecoderConfig())! : undefined,
			});
			isFirst = false;
		}
		await output.finalize();
	};

	await expect(run()).rejects.toThrow('OPFS write failed');
});

test('ADTS muxer with raw AAC input', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
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
		source: new UrlSource('/sample3.aac'),
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
		programConfigElement: null,
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
