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
import { FlacOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import {
	CustomAudioEncoder,
	customAudioDecoders,
	customAudioEncoders,
	registerDecoder,
} from '../../src/custom-coder.js';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { assert, uint8ArraysAreEqual } from '../../src/misc.js';

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

	const audioSource = new AudioSampleSource({ codec: 'flac' });
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

test('FLAC with huge timestamps', async () => {
	registerFlacEncoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'flac' });
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

	expect(firstPacket.timestamp).toBe(timestamp);
});

test('FLAC canceled during worker creation', async () => {
	registerFlacEncoder();

	const onSpy = vi.spyOn(Worker.prototype, 'on');
	const terminateSpy = vi.spyOn(Worker.prototype, 'terminate');

	try {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new AudioSampleSource({ codec: 'flac', quality: new Quality({ bitrate: 128000 }) });
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

		await output.cancel();
		await addPromise;

		const workers = [...new Set(onSpy.mock.contexts)];
		expect(workers).toHaveLength(1);
		expect(terminateSpy.mock.contexts).toContain(workers[0]);
	} finally {
		vi.restoreAllMocks();
	}
});

test('FLAC encoding after a flush', async () => {
	registerFlacEncoder();

	const config: AudioEncoderConfig = {
		codec: 'flac',
		numberOfChannels: 1,
		sampleRate: 48000,
	};

	const MatchingEncoder = customAudioEncoders.find(x => x.supports('flac', config));
	assert(MatchingEncoder);
	// @ts-expect-error Can't create an instance of an abstract class
	const encoder = new MatchingEncoder() as CustomAudioEncoder;
	// @ts-expect-error Readonly
	encoder.codec = 'flac';
	// @ts-expect-error Readonly
	encoder.config = config;

	const packets: EncodedPacket[] = [];
	// @ts-expect-error Readonly
	encoder.onPacket = (packet: EncodedPacket) => {
		packets.push(packet);
	};

	await encoder.init();

	let firstRunPacketCount = 0;
	for (let run = 0; run < 2; run++) {
		using sample = new AudioSample({
			data: createSineWave(48000, 1, 0.25),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: 0,
		});
		await encoder.encode(sample);
		await encoder.flush();

		firstRunPacketCount ||= packets.length;
	}

	await encoder.close();

	// The second run should come out exactly like the first one, rather than with libFLAC's default configuration
	const firstRun = packets.slice(0, firstRunPacketCount);
	const secondRun = packets.slice(firstRunPacketCount);
	expect(firstRun.length).toBeGreaterThan(0);
	expect(secondRun.map(x => x.timestamp)).toEqual(firstRun.map(x => x.timestamp));
	expect(secondRun.every((x, i) => uint8ArraysAreEqual(x.data, firstRun[i]!.data))).toBe(true);
});

test('Float input rounded to 24 bits', async () => {
	registerFlacEncoder();

	// The extension only encodes, so FFmpeg does the decoding
	if (!customAudioDecoders.includes(NodeAvAudioDecoder)) {
		registerDecoder(NodeAvAudioDecoder);
	}

	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({ codec: 'flac', quality: new Quality('high') });
	output.addAudioTrack(source);
	await output.start();

	// Three quarters of the way from one 24-bit value to the next
	const sample = new AudioSample({
		data: new Float32Array(4096).fill(1000.75 / 2 ** 23),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});
	await source.add(sample);
	sample.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	for await (using decoded of new AudioSampleSink(track).samples()) {
		const values = new Int32Array(decoded.numberOfFrames);
		decoded.copyTo(values, {
			format: 's32',
			planeIndex: 0,
		});
		expect(new Set(values)).toEqual(new Set([256 * 1001]));
	}
});
