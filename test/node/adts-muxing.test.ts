import { beforeAll, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { AdtsOutputFormat, MkvOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert } from '../../src/misc.js';

beforeAll(() => {
	registerMediabunnyServer();
});

test('Program config element', async () => {
	const frames: Uint8Array[] = [];
	const output = new Output({
		format: new AdtsOutputFormat({ onFrame: data => frames.push(data.slice()) }),
		target: new BufferTarget(),
	});

	const source = new AudioSampleSource({
		codec: 'aac',
		bitrate: 128e3,
	});
	output.addAudioTrack(source);
	await output.start();

	const numberOfChannels = 4;
	const sampleRate = 48000;
	const data = new Float32Array(numberOfChannels * sampleRate);
	for (let i = 0; i < data.length; i++) {
		data[i] = Math.sin(2 * Math.PI * 440 * Math.floor(i / numberOfChannels) / sampleRate);
	}

	using sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels,
		sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();

	// FFmpeg's encoder describes the quad layout with a PCE instead of a channel configuration
	const channelConfiguration = ((frames[0]![2]! & 1) << 2) | (frames[0]![3]! >> 6);
	expect(channelConfiguration).toBe(0);

	expect(await decodeAacFrames(frames)).toEqual(frames.map(() => numberOfChannels));
	// Every frame carries the PCE, so decoding can start anywhere
	expect(await decodeAacFrames(frames.slice(10))).toEqual(frames.slice(10).map(() => numberOfChannels));

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getNumberOfChannels()).toBe(numberOfChannels);

	// Formats holding raw AAC take the PCE into the description
	for (const format of [new Mp4OutputFormat(), new MkvOutputFormat(), new MpegTsOutputFormat()]) {
		const remuxOutput = new Output({
			format,
			target: new BufferTarget(),
		});
		const remuxSource = new EncodedAudioPacketSource('aac');
		remuxOutput.addAudioTrack(remuxSource);
		await remuxOutput.start();

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await remuxSource.add(packet, { decoderConfig });
		}
		await remuxOutput.finalize();

		using remuxInput = new Input({
			source: new BufferSource(remuxOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const remuxTrack = await remuxInput.getPrimaryAudioTrack();
		assert(remuxTrack);
		expect(await remuxTrack.getNumberOfChannels()).toBe(numberOfChannels);

		const remuxFrames: Uint8Array[] = [];
		for await (const packet of new EncodedPacketSink(remuxTrack).packets()) {
			remuxFrames.push(packet.data);
		}
		const description = (await remuxTrack.getDecoderConfig())!.description;
		expect(await decodeAacFrames(remuxFrames, description)).toEqual(remuxFrames.map(() => numberOfChannels));
	}
});

const decodeAacFrames = async (frames: Uint8Array[], description?: AllowSharedBufferSource) => {
	const decoder = new NodeAvAudioDecoder();
	// @ts-expect-error Readonly
	decoder.codec = 'aac';
	// Without a description, the frames are taken as ADTS
	// @ts-expect-error Readonly
	decoder.config = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description,
	};

	const channelCounts: number[] = [];
	// @ts-expect-error Readonly
	decoder.onSample = (sample: AudioSample) => {
		channelCounts.push(sample.numberOfChannels);
		sample.close();
	};

	await decoder.init();
	for (let i = 0; i < frames.length; i++) {
		await decoder.decode(new EncodedPacket(frames[i]!, 'key', 1024 * i / 48000, 1024 / 48000));
	}
	await decoder.flush();
	await decoder.close();

	return channelCounts;
};
