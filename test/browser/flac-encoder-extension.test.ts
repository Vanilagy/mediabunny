import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { FlacOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { EncodedPacket, PacketReader } from '../../src/packet.js';

test('FLAC encoder, 24-bit', async () => {
	registerFlacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createF32SineWave(sampleRate, channels, durationSeconds);

	const packet = await encodeSample(new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	expect(getBitDepthFromFlacPacket(packet!)).toBe(0b110); // 0b110 = 24 bit
});

test('FLAC encoder, 16-bit', async () => {
	registerFlacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createS16SineWave(sampleRate, channels, durationSeconds);

	const packet = await encodeSample(new AudioSample({
		data,
		format: 's16',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	}));
	expect(getBitDepthFromFlacPacket(packet!)).toBe(0b100); // 0b100 = 16 bit
});

const createF32SineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
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

const createS16SineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
	const totalFrames = sampleRate * durationSeconds;
	const data = new Int16Array(totalFrames * channels);

	for (let i = 0; i < totalFrames; i++) {
		const value = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 32767);
		for (let ch = 0; ch < channels; ch++) {
			data[i * channels + ch] = value;
		}
	}

	return data;
};

const encodeSample = async (audioSample: AudioSample) => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'flac' });
	output.addAudioTrack(audioSource);

	await output.start();
	await audioSource.add(audioSample);
	audioSample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const reader = new PacketReader(track);
	return reader.getFirst();
};

const getBitDepthFromFlacPacket = (packet: EncodedPacket) => {
	return (packet.data[3]! & 0b1110) >> 1;
};
