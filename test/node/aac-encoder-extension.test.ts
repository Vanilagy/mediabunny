import { expect, test, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { canEncode, Quality } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import {
	CustomAudioEncoder,
	customAudioDecoders,
	customAudioEncoders,
	registerDecoder,
} from '../../src/custom-coder.js';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';

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

test('AAC canceled during worker creation', async () => {
	await testCanceledDuringInit(false);
});

test('AAC canceled during encoder initialization', async () => {
	await testCanceledDuringInit(true);
});

const testCanceledDuringInit = async (cancelOnFirstWorkerMessage: boolean) => {
	registerAacEncoder();

	const firstWorkerMessage = promiseWithResolvers();
	const postMessageSpy = vi.spyOn(Worker.prototype, 'postMessage');
	postMessageSpy.mockImplementation(function (this: Worker, ...args) {
		postMessageSpy.mockRestore();
		firstWorkerMessage.resolve();
		this.postMessage(...args);
	});
	const onSpy = vi.spyOn(Worker.prototype, 'on');
	const terminateSpy = vi.spyOn(Worker.prototype, 'terminate');

	try {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
		output.addAudioTrack(audioSource);
		await output.start();

		using sample = new AudioSample({
			data: new Float32Array(4800),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: 0,
		});
		const addPromise = audioSource.add(sample);

		if (cancelOnFirstWorkerMessage) {
			// The worker is now busy setting up the encoder
			await firstWorkerMessage.promise;
		}

		await output.cancel();
		await addPromise;

		const workers = [...new Set(onSpy.mock.contexts)];
		expect(workers).toHaveLength(1);
		expect(terminateSpy.mock.contexts).toContain(workers[0]);
	} finally {
		vi.restoreAllMocks();
	}
};

test('AAC with three channels', async () => {
	await testChannelPositions(3);
});

test('AAC with seven channels', async () => {
	await testChannelPositions(7);
});

const testChannelPositions = async (numberOfChannels: number) => {
	registerAacEncoder();

	// The extension only encodes, so FFmpeg does the decoding
	if (!customAudioDecoders.includes(NodeAvAudioDecoder)) {
		registerDecoder(NodeAvAudioDecoder);
	}

	const sampleRate = 48000;

	// Every channel gets a tone of its own, so we can tell where each of them ends up. The fourth one stays low because
	// it's the LFE channel in the layouts that have one.
	const tones = [500, 700, 1000, 60, 1300, 1600, 1900];
	const data = new Float32Array(sampleRate * numberOfChannels);
	for (let i = 0; i < sampleRate; i++) {
		for (let channel = 0; channel < numberOfChannels; channel++) {
			data[i * numberOfChannels + channel] = 0.5 * Math.sin(2 * Math.PI * tones[channel]! * i / sampleRate);
		}
	}

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new AudioSampleSource({
		codec: 'aac',
		quality: new Quality({ bitrate: 64000 * numberOfChannels }),
	});
	output.addAudioTrack(audioSource);
	await output.start();

	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels,
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
	expect(await track.getNumberOfChannels()).toBe(numberOfChannels);

	// Lay the decoded audio out on the timeline to line it up with the input
	const decoded = Array.from({ length: numberOfChannels }, () => new Float32Array(sampleRate));
	for await (using decodedSample of new AudioSampleSink(track).samples()) {
		expect(decodedSample.numberOfChannels).toBe(numberOfChannels);
		const offset = Math.round(decodedSample.timestamp * sampleRate);

		for (let channel = 0; channel < numberOfChannels; channel++) {
			const plane = new Float32Array(decodedSample.numberOfFrames);
			decodedSample.copyTo(plane, {
				format: 'f32-planar',
				planeIndex: channel,
			});

			for (let i = Math.max(0, -offset); i < Math.min(plane.length, sampleRate - offset); i++) {
				decoded[channel]![offset + i] = plane[i]!;
			}
		}
	}

	for (let channel = 0; channel < numberOfChannels; channel++) {
		expect(getToneAmplitude(decoded[channel]!, tones[channel]!, sampleRate)).toBeCloseTo(0.5, 1);
	}
};

const getToneAmplitude = (signal: Float32Array, frequency: number, sampleRate: number) => {
	let sinSum = 0;
	let cosSum = 0;
	for (let i = 0; i < signal.length; i++) {
		const phase = 2 * Math.PI * frequency * i / sampleRate;
		sinSum += signal[i]! * Math.sin(phase);
		cosSum += signal[i]! * Math.cos(phase);
	}

	return 2 * Math.hypot(sinSum, cosSum) / signal.length;
};

test('AAC ADTS with seven or eight channels', () => {
	registerAacEncoder();

	const supportsAdts = (numberOfChannels: number) => customAudioEncoders.some(x => x.supports('aac', {
		codec: 'mp4a.40.2',
		numberOfChannels,
		sampleRate: 48000,
		bitrate: 128000,
		// @ts-expect-error Not in the types
		aac: { format: 'adts' },
	}));

	// ADTS headers can't carry the channel configurations these are encoded with (11 and 12)
	expect(supportsAdts(6)).toBe(true);
	expect(supportsAdts(7)).toBe(false);
	expect(supportsAdts(8)).toBe(false);
});

test('AAC encoding after a flush', async () => {
	registerAacEncoder();

	const config: AudioEncoderConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 1,
		sampleRate: 48000,
		bitrate: 128000,
	};

	// Mediabunny itself never encodes after a flush, so we drive the encoder directly
	const MatchingEncoder = customAudioEncoders.find(x => x.supports('aac', config));
	assert(MatchingEncoder);
	// @ts-expect-error Can't create an instance of an abstract class
	const encoder = new MatchingEncoder() as CustomAudioEncoder;
	// @ts-expect-error Readonly
	encoder.codec = 'aac';
	// @ts-expect-error Readonly
	encoder.config = config;

	const packets: EncodedPacket[] = [];
	// @ts-expect-error Readonly
	encoder.onPacket = (packet: EncodedPacket) => {
		packets.push(packet);
	};

	await encoder.init();

	for (const timestamp of [0, 1]) {
		const data = new Float32Array(4800);
		for (let i = 0; i < data.length; i++) {
			data[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
		}

		using sample = new AudioSample({
			data,
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp,
		});
		await encoder.encode(sample);
		await encoder.flush();
	}

	await encoder.close();

	// The second run should play out exactly like the first one did, just a second later
	const firstRun = packets.filter(x => x.timestamp < 0.5);
	const secondRun = packets.filter(x => x.timestamp >= 0.5);
	expect(firstRun.length).toBeGreaterThan(0);
	expect(secondRun.map(x => Math.round(48000 * (x.timestamp - 1)))).toEqual(
		firstRun.map(x => Math.round(48000 * x.timestamp)),
	);
	expect(secondRun.map(x => x.duration)).toEqual(firstRun.map(x => x.duration));
	expect(secondRun.map(x => x.data)).toEqual(firstRun.map(x => x.data));
});
