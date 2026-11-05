import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { canEncode, Quality } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { assert } from '../../src/misc.js';

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
	expect(await canEncode('aac')).toBe(false);

	registerAacEncoder();

	expect(await canEncode('aac')).toBe(true);
});

test('AAC encoding', async () => {
	registerAacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('aac');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	expect(await track.getFirstTimestamp()).toBeLessThan(0); // Due to priming delay!

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(durationSeconds * sampleRate / 1024);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('AAC with huge timestamps', async () => {
	registerAacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: channels,
		sampleRate,
		timestamp,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	const primingDelay = 1024 / 48000;
	expect(firstPacket.timestamp).toBe(timestamp - primingDelay);
});

test.each([1, 2])('AAC output is independent of input chunk sizes (%i channels)', async (channels) => {
	registerAacEncoder();
	const sampleRate = 48000;
	const data = createSineWave(sampleRate, channels, 0.75);
	const totalFrames = data.length / channels;

	const encode = async (chunkSizes: number[]) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		output.setMetadataTags({ creationTime: new Date(0) });
		const source = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
		output.addAudioTrack(source);
		await output.start();

		let offset = 0;
		let chunk = 0;
		while (offset < totalFrames) {
			const frames = Math.min(chunkSizes[chunk++ % chunkSizes.length]!, totalFrames - offset);
			const sample = new AudioSample({
				data: data.subarray(offset * channels, (offset + frames) * channels),
				format: 'f32', numberOfChannels: channels, sampleRate, timestamp: offset / sampleRate,
			});
			await source.add(sample);
			sample.close();
			offset += frames;
		}

		source.close();
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	};

	expect(await encode([1, 1023, 1024, 17, 2049, 32768])).toEqual(await encode([totalFrames]));
});

test('AAC emits packets from small input chunks before finalization', async () => {
	registerAacEncoder();
	const sampleRate = 48000;
	const data = createSineWave(sampleRate, 1, 12288 / sampleRate);
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	let packetCount = 0;
	const source = new AudioSampleSource({
		codec: 'aac', quality: new Quality({ bitrate: 128000 }),
		onEncodedPacket: () => packetCount++,
	});
	output.addAudioTrack(source);
	await output.start();

	for (let offset = 0; offset < data.length; offset += 1024) {
		const sample = new AudioSample({
			data: data.subarray(offset, offset + 1024), format: 'f32',
			numberOfChannels: 1, sampleRate, timestamp: offset / sampleRate,
		});
		await source.add(sample);
		sample.close();
	}

	expect(packetCount).toBeGreaterThan(0);
	source.close();
	await output.finalize();
});
