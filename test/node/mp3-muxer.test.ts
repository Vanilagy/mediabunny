import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp3OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert, textEncoder } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo, no CRC
const FRAME_HEADER = [0xff, 0xfb, 0x90, 0x64];
const FRAME_SIZE = 417;
const FRAME_DURATION = 1152 / 44100;

// MPEG-1 Layer II, 192 kbps, 44.1 kHz, stereo, no CRC
const LAYER_2_FRAME_HEADER = [0xff, 0xfd, 0xa0, 0x04];
const LAYER_2_FRAME_SIZE = 626;

test('Muxing without Xing header', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/Toothsome-Meme.VBRv2.mp3')),
		formats: ALL_FORMATS,
	});

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const output = new Output({
		format: new Mp3OutputFormat({ xingHeader: false }),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();

	let inputPacketCount = 0;
	for await (const packet of new EncodedPacketSink(inputTrack).packets()) {
		await source.add(packet);
		inputPacketCount++;
	}

	await output.finalize();

	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputInput.getPrimaryAudioTrack();
	assert(outputTrack);

	let outputPacketCount = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const packet of new EncodedPacketSink(outputTrack).packets()) {
		outputPacketCount++;
	}

	expect(inputPacketCount).toBeGreaterThan(0);
	expect(outputPacketCount).toBe(inputPacketCount);
});

test('Xing frame', async () => {
	const buffer = await mux(Array.from({ length: 10 }, createMp3Frame));

	// For this header, the tag sits at byte 36, followed by the flags and then the frame count, which excludes the
	// Xing frame itself
	const view = new DataView(buffer);
	expect(view.getUint32(36)).toBe(0x496e666f); // 'Info'
	expect(view.getUint32(44)).toBe(10);
	expect(view.getUint8(1) & 1).toBe(1); // Protection bit, meaning no CRC follows

	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.computeDuration()).toBe(10 * 1152 / 44100);
	expect(await track.getDurationFromMetadata()).toBe(10 * 1152 / 44100);
});

test('VBRI header', async () => {
	const frameCount = 10;
	using input = new Input({
		source: new BufferSource(concat(
			vbriFrame(frameCount, FRAME_SIZE * (frameCount + 1)),
			...Array.from({ length: frameCount }, createMp3Frame),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getDurationFromMetadata()).toBe(frameCount * 1152 / 44100);

	// Like the Xing frame, the VBRI frame holds no audio
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(Array.from({ length: frameCount }, (_, i) => i * 1152 / 44100));
});

const vbriFrame = (frameCount: number, byteCount: number) => {
	const frame = createMp3Frame();
	const view = new DataView(frame.buffer);

	frame.set(textEncoder.encode('VBRI'), 36);
	view.setUint16(40, 1); // Version
	view.setUint32(46, byteCount);
	view.setUint32(50, frameCount);

	return frame;
};

test('False sync on a reserved MPEG version', async () => {
	await testFalseSync([0xff, 0xeb, 0x90, 0x00]);
});

test('False sync on a reserved sampling frequency', async () => {
	await testFalseSync([0xff, 0xfb, 0x9c, 0x00]);
});

const testFalseSync = async (falseHeader: number[]) => {
	const frameCount = 10;
	using input = new Input({
		source: new BufferSource(concat(
			falseHeader,
			new Uint8Array(100),
			...Array.from({ length: frameCount }, createMp3Frame),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getSampleRate()).toBe(44100);

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.byteLength).toBe(FRAME_SIZE);
		packetCount++;
	}
	expect(packetCount).toBe(frameCount);
};

const createMp3Frame = () => {
	const frame = new Uint8Array(FRAME_SIZE);
	frame.set(FRAME_HEADER);
	return frame;
};

const concat = (...parts: (Uint8Array | number[])[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

test('Xing frame count of empty file', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	output.addAudioTrack(new EncodedAudioPacketSource('mp3'), {
		decoderConfig: {
			codec: 'mp3',
			sampleRate: 44100,
			numberOfChannels: 2,
		},
	});
	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.computeDuration()).toBe(0);
	expect(await track.getDurationFromMetadata()).toBe(0);
});

test('Layer II without Xing frame', async () => {
	// Xing frames are a Layer III thing, other decoders would play it as an extra frame
	const frames = Array.from({ length: 10 }, createLayer2Frame);
	const buffer = await mux(frames);
	expect(buffer.byteLength).toBe(10 * LAYER_2_FRAME_SIZE);
});

const mux = async (frames: Uint8Array[]) => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();

	for (let i = 0; i < frames.length; i++) {
		await source.add(new EncodedPacket(frames[i]!, 'key', i * FRAME_DURATION, FRAME_DURATION));
	}

	await output.finalize();
	return output.target.buffer!;
};

test('VBRI-like bytes in Layer II', async () => {
	// VBRI headers only exist for Layer III
	const frames = Array.from({ length: 10 }, createLayer2Frame);
	frames[0]!.set(textEncoder.encode('VBRI'), 36);
	new DataView(frames[0]!.buffer).setUint16(40, 1); // Version

	using input = new Input({
		source: new BufferSource(concat(...frames)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.byteLength).toBe(LAYER_2_FRAME_SIZE);
		packetCount++;
	}
	expect(packetCount).toBe(10);
});

const createLayer2Frame = () => {
	const frame = new Uint8Array(LAYER_2_FRAME_SIZE);
	frame.set(LAYER_2_FRAME_HEADER);
	return frame;
};

test('CBR duration with trailing tags', async () => {
	// MPEG-2 Layer III, 8 kbps, 22.05 kHz, mono, making for tiny frames that the tags would easily outweigh
	const frames = Array.from({ length: 10 }, () => {
		const frame = new Uint8Array(26);
		frame.set([0xff, 0xf3, 0x10, 0xc4]);
		return frame;
	});

	const apeItems = new Uint8Array(100);
	const id3V1Tag = new Uint8Array(128);
	id3V1Tag.set(textEncoder.encode('TAG'));

	using input = new Input({
		source: new BufferSource(concat(
			...frames,
			createApeTagHeaderOrFooter(true, apeItems.length),
			apeItems,
			createApeTagHeaderOrFooter(false, apeItems.length),
			id3V1Tag,
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	expect(await track.getDurationFromMetadata()).toBe(10 * 576 / 22050);
});

const createApeTagHeaderOrFooter = (isHeader: boolean, itemsSize: number) => {
	const bytes = new Uint8Array(32);
	const view = new DataView(bytes.buffer);

	bytes.set(textEncoder.encode('APETAGEX'));
	view.setUint32(8, 2000, true); // Version
	view.setUint32(12, itemsSize + 32, true); // Tag size, including the footer
	view.setUint32(20, (1 << 31) | (isHeader ? 1 << 29 : 0), true); // Has a header, and whether this is it

	return bytes;
};
