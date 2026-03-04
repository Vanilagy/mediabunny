import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { canEncode } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Mp3OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

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
	expect(await canEncode('mp3')).toBe(false);

	registerMp3Encoder();

	expect(await canEncode('mp3')).toBe(true);
});

test('MP3 encoding', async () => {
	registerMp3Encoder();

	const sampleRate = 44100;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'mp3', bitrate: 128_000 });
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
	expect(track.codec).toBe('mp3');
	expect(track.sampleRate).toBe(sampleRate);
	expect(track.numberOfChannels).toBe(channels);

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	// MP3 frames are 1152 samples each, so ~77 packets for 2 seconds at 44.1kHz
	expect(packetCount).toBeGreaterThan(durationSeconds * sampleRate / 1152 - 2);

	expect(await track.computeDuration()).toBeCloseTo(2, 0);
});
