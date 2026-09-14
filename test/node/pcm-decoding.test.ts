import { expect, test } from 'vitest';
import path from 'node:path';
import {
	ALL_FORMATS,
	AudioSampleCursor,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	FilePathSource,
	Input,
	Output,
	WavOutputFormat,
} from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

// The PCM decoder emits its samples synchronously, so the cursor must have registered the request before it starts
// decoding; these tests retrieve actual samples, which canDecode() alone would never prove

// A WAV file holding the given packets, 0.1 s each
const wavWith = async (codec: 'pcm-s16' | 'ulaw' | 'alaw', ...packets: Uint8Array[]) => {
	const output = new Output({ target: new BufferTarget(), format: new WavOutputFormat() });
	const source = new EncodedAudioPacketSource(codec);
	output.addAudioTrack(source);
	await output.start();
	const decoderConfig = { codec, numberOfChannels: 1, sampleRate: 8000 };
	for (const [index, data] of packets.entries()) {
		await source.add(new EncodedPacket(data, 'key', index / 10, 0.1), { decoderConfig });
	}
	await output.finalize();
	return new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
};

test('PCM samples through the sample cursor', async () => {
	const filePath = path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav');
	using input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	expect(await track!.getCodec()).toBe('pcm-s16');
	expect(await track!.canDecode()).toBe(true);

	let frames = 0;
	for await (const sample of new AudioSampleCursor(track!)) {
		expect(sample.format).toBe('s16');
		frames += sample.numberOfFrames;
		sample.close();
	}
	expect(frames).toBe(425000); // 9.637 s at 44.1 kHz
});

test('PCM written by the WAVE muxer, seeking after the pump ended', async () => {
	const data = new Uint8Array(1600);
	new Int16Array(data.buffer).fill(1234);
	using input = await wavWith('pcm-s16', data, data);
	const track = await input.getPrimaryAudioTrack();
	expect(await track!.canDecode()).toBe(true);

	await using cursor = new AudioSampleCursor(track!);
	const first = await cursor.next();
	expect(first?.timestamp).toBe(0);
	const decoded = new Int16Array(first!.numberOfFrames);
	first!.copyTo(decoded, { planeIndex: 0, format: 's16' });
	expect(decoded[0]).toBe(1234);
	first!.close();
	// The pump has ended after delivering everything; seeking back to the same spot must start a fresh one
	const again = await cursor.seekTo(0);
	expect(again?.timestamp).toBe(0);
	let frames = again!.numberOfFrames;
	again!.close();
	// Iterating the cursor would start over from the first sample, so drain it by hand
	for (let sample = await cursor.next(); sample; sample = await cursor.next()) {
		frames += sample.numberOfFrames;
		sample.close();
	}
	expect(frames).toBe(1600);
});
