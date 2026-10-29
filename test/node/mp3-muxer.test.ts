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
import { assert } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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

test('LAME delay with optional Xing fields', async () => {
	for (const encoder of ['LAME', 'Lavf', 'Lavc', 'none']) {
		for (let flags = 0; flags < 16; flags++) {
			for (const encoderDelay of [0, 576]) {
				// Three MPEG-1 Layer III frames: one metadata frame, followed by two audio frames.
				const bytes = new Uint8Array(417 * 3);
				for (let i = 0; i < 3; i++) {
					bytes.set([0xff, 0xfb, 0x90, 0xc0], i * 417);
				}
				bytes.set(new TextEncoder().encode('Info'), 21);
				const view = new DataView(bytes.buffer);
				view.setUint32(25, flags);
				let offset = 29;
				if (flags & 1) {
					view.setUint32(offset, 2);
					offset += 4;
				}
				if (flags & 2) {
					view.setUint32(offset, bytes.length);
					offset += 4;
				}
				if (flags & 4) {
					offset += 100;
				}
				if (flags & 8) {
					offset += 4;
				}
				bytes.set(new TextEncoder().encode(encoder), offset);
				bytes[offset + 21] = encoderDelay >> 4;
				bytes[offset + 22] = (encoderDelay & 0xf) << 4;

				using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
				const track = await input.getPrimaryAudioTrack();
				assert(track);
				const delay = encoder === 'none' ? 0 : encoderDelay + 529;
				const first = await new EncodedPacketSink(track).getFirstPacket();
				assert(first);
				expect(first.timestamp).toBe(delay === 0 ? 0 : -delay / 44100);
				expect(await track.getDurationFromMetadata()).toBe((2304 - delay) / 44100);
				expect(await track.computeDuration()).toBeCloseTo((2304 - delay) / 44100, 10);
			}
		}
	}
});

test('Truncated LAME tag does not change timestamps', async () => {
	const bytes = new Uint8Array(104 * 3);
	for (let i = 0; i < 3; i++) {
		bytes.set([0xff, 0xfb, 0x10, 0xc0], i * 104);
	}
	bytes.set(new TextEncoder().encode('Info'), 21);
	new DataView(bytes.buffer).setUint32(25, 4); // A TOC cannot fit in this frame.
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getFirstTimestamp()).toBe(0);
});

test('MP3 muxing preserves start delay without trimming the end', async () => {
	for (const delay of [0, 529, 1105, 4624]) {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();
		const frame = new Uint8Array(417);
		frame.set([0xff, 0xfb, 0x90, 0xc0]);
		for (let i = 0; i < 8; i++) {
			await source.add(new EncodedPacket(frame, 'key', (i * 1152 - delay) / 44100, 1152 / 44100));
		}
		await output.finalize();

		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		let count = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			expect(packet.timestamp).toBe((count * 1152 - delay) / 44100);
			expect(packet.data).toEqual(frame);
			count++;
		}
		expect(count).toBe(8);
		expect(await track.getDurationFromMetadata()).toBe((8 * 1152 - delay) / 44100);
		expect(await track.computeDuration()).toBeCloseTo((8 * 1152 - delay) / 44100, 10);
	}
});

test('MP3 muxing rejects unrepresentable negative start timestamps', async () => {
	for (const delay of [528, 4625]) {
		const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
		const source = new EncodedAudioPacketSource('mp3');
		output.addAudioTrack(source);
		await output.start();
		const frame = new Uint8Array(417);
		frame.set([0xff, 0xfb, 0x90, 0xc0]);
		await expect(source.add(new EncodedPacket(frame, 'key', -delay / 44100, 1152 / 44100)))
			.rejects.toThrow('cannot be represented by LAME delay metadata');
		await output.cancel();
	}
});
