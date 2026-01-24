import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { AdtsOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

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

	expect(outputTrack.codec).toBe('aac');
	expect(outputTrack.sampleRate).toBe(audioTrack.sampleRate);
	expect(outputTrack.numberOfChannels).toBe(audioTrack.numberOfChannels);

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

test('ADTS muxer with ADTS input (passthrough)', { timeout: 10_000 }, async () => {
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
