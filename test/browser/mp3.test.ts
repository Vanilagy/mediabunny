import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioBufferSink, AudioSampleSink } from '../../src/media-sink.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSample } from '../../src/sample.js';
import { Output } from '../../src/output.js';
import { Mp3OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

// "joined" in the sense that it was two separate MP3s that were spliced together (I think)
test('Can decode malformed joined MP3', async () => {
	using input = new Input({
		source: new UrlSource('/malformed-join.mp3'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new AudioSampleSink(audioTrack);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples());
});

test('MP3 encoding and decoding agree with Web Audio timing', async () => {
	registerMp3Encoder();
	const sampleRate = 44100;
	const data = new Float32Array(sampleRate);
	for (let i = sampleRate / 2; i < sampleRate * 0.55; i++) {
		data[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sampleRate);
	}
	const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'mp3', bitrate: 128_000 });
	output.addAudioTrack(source);
	await output.start();
	using sample = new AudioSample({ data, format: 'f32', numberOfChannels: 1, sampleRate, timestamp: 0 });
	await source.add(sample);
	await output.finalize();

	const context = new AudioContext({ sampleRate });
	try {
		const reference = await context.decodeAudioData(output.target.buffer!.slice(0));
		const referenceIndex = reference.getChannelData(0).findIndex(value => Math.abs(value) > 0.03);
		expect(referenceIndex).toBeGreaterThanOrEqual(0);
		using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		let beepTimestamp: number | null = null;
		for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
			const index = buffer.getChannelData(0).findIndex(value => Math.abs(value) > 0.03);
			if (index !== -1) {
				beepTimestamp = timestamp + index / sampleRate;
				break;
			}
		}
		assert(beepTimestamp !== null);
		expect(Math.abs(beepTimestamp - 0.5)).toBeLessThan(2 / sampleRate);
		expect(Math.abs(beepTimestamp - referenceIndex / sampleRate)).toBeLessThan(1 / sampleRate);
	} finally {
		await context.close();
	}
});
