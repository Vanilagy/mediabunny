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
	expect(await outputTrack.getFirstTimestamp()).toBe(0);
});

test('LAME delay survives remuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/Toothsome-Meme.VBRv2.mp3')),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const first = await sink.getFirstPacket();
	assert(first);
	expect(first.timestamp).toBe(-2210 / 48000);

	const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(source);
	await output.start();
	await source.add(first);
	await output.finalize();

	using remuxed = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const remuxedTrack = await remuxed.getPrimaryAudioTrack();
	assert(remuxedTrack);
	expect(await remuxedTrack.getFirstTimestamp()).toBe(first.timestamp);
});

test('Truncated LAME tag does not read into the next frame', async () => {
	const bytes = new Uint8Array(104 * 3);
	for (let i = 0; i < 3; i++) {
		bytes.set([0xff, 0xfb, 0x10, 0xc0], i * 104);
	}
	bytes.set(new TextEncoder().encode('Info'), 21);
	new DataView(bytes.buffer).setUint32(25, 4); // A TOC cannot fit in this frame.
	bytes.set(new TextEncoder().encode('LAME'), 129); // A fake tag in the following audio frame.
	bytes[150] = 36; // 576 samples of delay, if the reader crosses the frame boundary.
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getFirstTimestamp()).toBe(0);
});
