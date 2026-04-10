import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { canEncode } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';

const createSineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
	const totalFrames = sampleRate * durationSeconds;
	const data = new Float32Array(totalFrames * channels);

	for (let i = 0; i < totalFrames; i++) {
		const value = Math.sin(2 * Math.PI * 440 * i / sampleRate);
		for (let ch = 0; ch < channels; ch++) {
			data[i * channels + ch] = value;
		}
	}

	return data;
};

test('Custom coder registration', async () => {
	expect(await canEncode('flac')).toBe(false);

	registerFlacEncoder();

	expect(await canEncode('flac')).toBe(true);
});

test('FLAC encoding', async () => {
	registerFlacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'flac', bitrate: 1 });
	output.addAudioTrack(audioSource);

	await output.start();
	await audioSource.add(new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('flac');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	// FLAC default block size is 4096, so ~24 packets for 2 seconds at 48kHz
	expect(packetCount).toBeGreaterThan(durationSeconds * sampleRate / 4096);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});
