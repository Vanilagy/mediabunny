import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import {
	AC3_REGISTRATION_DESCRIPTOR,
	EAC3_REGISTRATION_DESCRIPTOR,
	getEac3ChannelCount,
	parseAc3SyncFrame,
	parseEac3Config,
} from '../../src/codec-data.js';
import { canEncode, canEncodeAudio, Quality } from '../../src/encode.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';
import { assert, toDataView } from '../../src/misc.js';
import { Bitstream } from '../../shared/bitstream.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('reads AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(await audioTrack.getCodec()).toBe('ac3');
	expect(decoderConfig.description).toBeUndefined();
});

test('reads E-AC-3 from MP4', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getPrimaryAudioTrack())!;
	const decoderConfig = (await audioTrack.getDecoderConfig())!;

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(decoderConfig.description).toBeUndefined();
});

test('reads and writes AC-3 in MPEG-TS', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.ts')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;

	expect(await originalAudioTrack.getCodec()).toBe('ac3');
	expect(await originalAudioTrack.getInternalCodecId()).toBe(0x81);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;

	expect(await newAudioTrack.getCodec()).toBe('ac3');
	expect(await newAudioTrack.getInternalCodecId()).toBe(0x81);
	expect(await newAudioTrack.getNumberOfChannels()).toBe(await originalAudioTrack.getNumberOfChannels());
	expect(await newAudioTrack.getSampleRate()).toBe(await originalAudioTrack.getSampleRate());

	// Verify registration_descriptor is present
	const buffer = new Uint8Array(output.target.buffer!);
	let found = false;
	for (let i = 0; i < buffer.length - AC3_REGISTRATION_DESCRIPTOR.length; i++) {
		if (AC3_REGISTRATION_DESCRIPTOR.every((byte, j) => buffer[i + j] === byte)) {
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
});

test('reads and writes E-AC-3 in MPEG-TS', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.ts')),
		formats: ALL_FORMATS,
	});

	const originalAudioTrack = (await originalInput.getPrimaryAudioTrack())!;

	expect(await originalAudioTrack.getCodec()).toBe('eac3');
	expect(await originalAudioTrack.getInternalCodecId()).toBe(0x87);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newAudioTrack = (await newInput.getPrimaryAudioTrack())!;

	expect(await newAudioTrack.getCodec()).toBe('eac3');
	expect(await newAudioTrack.getInternalCodecId()).toBe(0x87);
	expect(await newAudioTrack.getNumberOfChannels()).toBe(await originalAudioTrack.getNumberOfChannels());
	expect(await newAudioTrack.getSampleRate()).toBe(await originalAudioTrack.getSampleRate());

	// Verify registration_descriptor is present
	const buffer = new Uint8Array(output.target.buffer!);
	let found = false;
	for (let i = 0; i < buffer.length - EAC3_REGISTRATION_DESCRIPTOR.length; i++) {
		if (EAC3_REGISTRATION_DESCRIPTOR.every((byte, j) => buffer[i + j] === byte)) {
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
});

test('Custom coder registration', async () => {
	using ac3Input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});
	using eac3Input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const ac3Track = (await ac3Input.getPrimaryAudioTrack())!;
	const eac3Track = (await eac3Input.getPrimaryAudioTrack())!;

	// Before registration, nothing can decode or encode AC3/EAC3
	expect(await ac3Track.canDecode()).toBe(false);
	expect(await eac3Track.canDecode()).toBe(false);
	expect(await canEncode('ac3')).toBe(false);
	expect(await canEncode('eac3')).toBe(false);

	registerAc3Decoder();
	registerAc3Encoder();

	// After registration, both should work
	expect(await ac3Track.canDecode()).toBe(true);
	expect(await eac3Track.canDecode()).toBe(true);
	expect(await canEncode('ac3')).toBe(true);
	expect(await canEncode('eac3')).toBe(true);
});

test('AC-3 decoding', async () => {
	registerAc3Decoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const { packetCount } = await track.computePacketStats();
	const trackNumberOfChannels = await track.getNumberOfChannels();
	const trackSampleRate = await track.getSampleRate();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBe(0.032);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(trackNumberOfChannels);
		expect(sample.sampleRate).toBe(trackSampleRate);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

test('E-AC-3 decoding', async () => {
	registerAc3Decoder();

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/eac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	const { packetCount } = await track.computePacketStats();
	const trackNumberOfChannels = await track.getNumberOfChannels();
	const trackSampleRate = await track.getSampleRate();
	const sink = new AudioSampleSink(track);

	let sampleCount = 0;
	let nextTimestamp = 0;

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBeCloseTo(nextTimestamp);
		expect(sample.duration).toBe(0.032);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(trackNumberOfChannels);
		expect(sample.sampleRate).toBe(trackSampleRate);

		nextTimestamp += sample.duration;
		sampleCount++;
	}

	expect(sampleCount).toBe(packetCount);
});

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

test('AC-3 encoding', async () => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'ac3', quality: new Quality({ bitrate: 192000 }) });
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
	expect(await track.getCodec()).toBe('ac3');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	expect(await track.getFirstTimestamp()).toBeLessThan(0); // Due to priming delay!

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(0);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('E-AC-3 encoding', async () => {
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'eac3', quality: new Quality({ bitrate: 192000 }) });
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
	expect(await track.getCodec()).toBe('eac3');
	expect(await track.getSampleRate()).toBe(sampleRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	expect(await track.getFirstTimestamp()).toBeLessThan(0); // Due to priming delay!

	const sink = new EncodedPacketSink(track);
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.type).toBe('key');
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(0);

	expect(await track.computeDuration()).toBeCloseTo(2, 1);
});

test('AC-3 with huge timestamps', async () => {
	registerAc3Decoder();
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'ac3', quality: new Quality({ bitrate: 192000 }) });
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
	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);

	const primingDelay = 256 / 48000;
	expect(firstPacket.timestamp).toBe(timestamp - primingDelay);

	const sampleSink = new AudioSampleSink(track);
	const iterator = sampleSink.samples(timestamp);
	const firstSample = (await iterator.next()).value;
	assert(firstSample);

	expect(firstSample.timestamp).toBe(timestamp - primingDelay);
});

test('E-AC-3 with huge timestamps', async () => {
	registerAc3Decoder();
	registerAc3Encoder();

	const sampleRate = 48000;
	const channels = 2;
	const timestamp = 1e9;
	const durationSeconds = 2;
	const data = createSineWave(sampleRate, channels, durationSeconds);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec: 'eac3', quality: new Quality({ bitrate: 192000 }) });
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
	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);

	const primingDelay = 256 / 48000;
	expect(firstPacket.timestamp).toBe(timestamp - primingDelay);

	const sampleSink = new AudioSampleSink(track);
	const iterator = sampleSink.samples(timestamp);
	const firstSample = (await iterator.next()).value;
	assert(firstSample);

	expect(firstSample.timestamp).toBe(timestamp - primingDelay);
});

test('Encode AC-3 input that fills its last frame', async () => {
	await testFilledLastFrame('ac3');
});

test('Encode E-AC-3 input that fills its last frame', async () => {
	await testFilledLastFrame('eac3');
});

const testFilledLastFrame = async (codec: 'ac3' | 'eac3') => {
	registerAc3Decoder();
	registerAc3Encoder();

	const sampleRate = 48000;
	const frameCount = 4 * 1536;

	const data = new Float32Array(frameCount);
	for (let i = 0; i < frameCount; i++) {
		data[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
	}

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({
		codec,
		quality: new Quality({ bitrate: 192000 }),
	});
	output.addAudioTrack(source);
	await output.start();

	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: 1,
		sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	sample.close();
	source.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const sink = new AudioSampleSink(track);

	// The encoder's output lags 256 samples behind its input, so these are the ones at stake
	let sumOfSquares = 0;
	let tailFrameCount = 0;
	for await (using decoded of sink.samples()) {
		const startIndex = Math.round(decoded.timestamp * sampleRate);
		const values = new Float32Array(decoded.numberOfFrames);
		decoded.copyTo(values, {
			planeIndex: 0,
			format: 'f32-planar',
		});

		for (let i = 0; i < values.length; i++) {
			if (startIndex + i >= frameCount - 256 && startIndex + i < frameCount) {
				sumOfSquares += values[i]! ** 2;
				tailFrameCount++;
			}
		}
	}

	expect(tailFrameCount).toBe(256);
	expect(Math.sqrt(sumOfSquares / tailFrameCount)).toBeGreaterThan(0.25);
};

test('Encoding with more than six channels', async () => {
	registerAc3Encoder();

	expect(await canEncodeAudio('ac3', { numberOfChannels: 6 })).toBe(true);
	expect(await canEncodeAudio('ac3', { numberOfChannels: 7 })).toBe(false);
	expect(await canEncodeAudio('ac3', { numberOfChannels: 8 })).toBe(false);
	expect(await canEncodeAudio('eac3', { numberOfChannels: 6 })).toBe(true);
	expect(await canEncodeAudio('eac3', { numberOfChannels: 7 })).toBe(false);
	expect(await canEncodeAudio('eac3', { numberOfChannels: 8 })).toBe(false);
});

test('E-AC-3 encoding at reduced sample rates', async () => {
	registerAc3Encoder();

	expect(await canEncodeAudio('eac3', { sampleRate: 32000 })).toBe(true);
	expect(await canEncodeAudio('eac3', { sampleRate: 24000 })).toBe(false);
	expect(await canEncodeAudio('eac3', { sampleRate: 22050 })).toBe(false);
	expect(await canEncodeAudio('eac3', { sampleRate: 16000 })).toBe(false);
});

test('E-AC-3 encoding above the maximum bitrate', async () => {
	registerAc3Encoder();

	// Even single-block syncframes can't go past 2048 words per 256 samples
	const highest = new Quality({ bitrate: 6_144_000 });
	const tooHigh = new Quality({ bitrate: 6_200_000 });
	expect(await canEncodeAudio('eac3', { sampleRate: 48000, quality: highest })).toBe(true);
	expect(await canEncodeAudio('eac3', { sampleRate: 48000, quality: tooHigh })).toBe(false);
	expect(await canEncodeAudio('eac3', { sampleRate: 32000, quality: highest })).toBe(false);
	// AC-3 encoding just snaps to its highest bitrate
	expect(await canEncodeAudio('ac3', { sampleRate: 48000, quality: tooHigh })).toBe(true);
});

test('E-AC-3 dec3 dependent substream channel count', () => {
	// 5.1 independent substream plus a dependent one carrying the Lrs/Rrs pair (chan_loc bit 1), making it 7.1
	const config = parseEac3Config(new Uint8Array([0x14, 0x00, 0x20, 0x0f, 0x02, 0x02]));
	assert(config);

	expect(config.substreams[0]!.numDepSub).toBe(1);
	expect(config.substreams[0]!.chanLoc).toBe(0x002);
	expect(getEac3ChannelCount(config)).toBe(8);
});

test('E-AC-3 7.1 in MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('eac3');
	output.addAudioTrack(source);
	await output.start();

	// A 5.1 independent substream, followed by a dependent one replacing Ls/Rs and adding the Lrs/Rrs pair
	const data = new Uint8Array([
		...createEac3Frame({
			strmtyp: 0,
			acmod: 7,
			lfeon: 1,
			chanmap: null,
		}),
		...createEac3Frame({
			strmtyp: 1,
			acmod: 6,
			lfeon: 0,
			chanmap: 0x1a00,
		}),
	]);

	for (let i = 0; i < 3; i++) {
		await source.add(new EncodedPacket(data, 'key', 0.032 * i, 0.032), {
			decoderConfig: {
				codec: 'ec-3',
				numberOfChannels: 8,
				sampleRate: 48000,
			},
		});
	}

	source.close();
	await output.finalize();

	const buffer = output.target.buffer!;
	const dec3Pos = Buffer.from(buffer).indexOf('dec3');
	expect([...new Uint8Array(buffer, dec3Pos + 6, 4)]).toEqual([0x20, 0x0f, 0x02, 0x02]);

	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getNumberOfChannels()).toBe(8);
});

test('E-AC-3 dependent substreams in MPEG-TS', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('eac3');
	output.addAudioTrack(source);
	await output.start();

	// 5.1 in the independent substream, extended to 7.1 by the dependent one
	const data = new Uint8Array([
		...createEac3Frame({
			strmtyp: 0,
			acmod: 7,
			lfeon: 1,
			chanmap: null,
		}),
		...createEac3Frame({
			strmtyp: 1,
			acmod: 2,
			lfeon: 0,
			chanmap: 1 << 9, // The Lrs/Rrs pair
		}),
	]);

	const accessUnitCount = 10;
	for (let i = 0; i < accessUnitCount; i++) {
		await source.add(new EncodedPacket(data, 'key', 0.032 * i, 0.032), {
			decoderConfig: {
				codec: 'ec-3',
				numberOfChannels: 8,
				sampleRate: 48000,
			},
		});
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getNumberOfChannels()).toBe(8);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}
	expect(packets.map(x => x.byteLength)).toEqual(Array(accessUnitCount).fill(data.byteLength));

	// The 1536 samples of an access unit make 2880 MPEG-TS ticks
	expect(packets.map(x => x.timestamp)).toEqual(
		Array.from({ length: accessUnitCount }, (_, i) => 2880 * i / 90000),
	);
	expect(packets.map(x => x.duration)).toEqual(Array(accessUnitCount).fill(2880 / 90000));
});

const createEac3Frame = (options: { strmtyp: number; acmod: number; lfeon: number; chanmap: number | null }) => {
	const bytes = new Uint8Array(128);
	const bitstream = new Bitstream(bytes);

	bitstream.writeBits(16, 0x0b77);
	bitstream.writeBits(2, options.strmtyp);
	bitstream.writeBits(3, 0); // substreamid
	bitstream.writeBits(11, bytes.length / 2 - 1); // frmsiz
	bitstream.writeBits(2, 0); // fscod
	bitstream.writeBits(2, 3); // numblkscod
	bitstream.writeBits(3, options.acmod);
	bitstream.writeBits(1, options.lfeon);
	bitstream.writeBits(5, 16); // bsid
	bitstream.writeBits(5, 31); // dialnorm
	bitstream.writeBits(1, 0); // compre

	if (options.chanmap !== null) {
		bitstream.writeBits(1, 1); // chanmape
		bitstream.writeBits(16, options.chanmap);
	}

	return bytes;
};

test('AC-3 track sample rate differing from the decoded sample rate', async () => {
	registerAc3Decoder();

	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mkv')),
		formats: ALL_FORMATS,
	});
	const originalTrack = (await originalInput.getPrimaryAudioTrack())!;
	const decoderConfig = (await originalTrack.getDecoderConfig())!;
	expect(decoderConfig.sampleRate).toBe(48000);

	// Declare half the rate the stream decodes at
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('ac3');
	output.addAudioTrack(source);
	await output.start();

	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(originalTrack).packets()) {
		await source.add(packet, {
			decoderConfig: {
				...decoderConfig,
				sampleRate: 24000,
			},
		});

		if (++packetCount === 20) {
			break;
		}
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getSampleRate()).toBe(24000);

	const packetTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packetTimestamps.push(packet.timestamp);
	}

	const sampleTimestamps: number[] = [];
	for await (using sample of new AudioSampleSink(track).samples()) {
		expect(sample.sampleRate).toBe(48000);
		sampleTimestamps.push(sample.timestamp);
	}

	// Matroska stores timestamps in whole milliseconds, which the decoded samples needn't stick to
	expect(sampleTimestamps.length).toBe(packetTimestamps.length);
	for (let i = 0; i < packetTimestamps.length; i++) {
		expect(Math.abs(sampleTimestamps[i]! - packetTimestamps[i]!)).toBeLessThan(0.001);
	}
});

test('E-AC-3 syncframes shorter than six blocks in MP4', async () => {
	registerAc3Decoder();
	registerAc3Encoder();

	// At this bitrate, a syncframe only fits three of the usual six blocks, so two of them make up an MP4 sample
	const sampleRate = 32000;
	const syncframeDuration = 768 / sampleRate;
	const data = createSineWave(sampleRate, 1, 1);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new AudioSampleSource({
		codec: 'eac3',
		quality: new Quality({ bitrate: 740000 }),
	});
	output.addAudioTrack(audioSource);
	await output.start();

	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: 1,
		sampleRate,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const stszPos = Buffer.from(bytes).indexOf('stsz');
	const mp4SampleCount = toDataView(bytes).getUint32(stszPos + 12);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	const syncframes: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.duration).toBe(syncframeDuration);
		syncframes.push(packet);
	}
	expect(syncframes.length).toBe(2 * mp4SampleCount);

	// Every syncframe should decode to a sample of its own, right where it was
	const sampleTimestamps: number[] = [];
	for await (using decoded of new AudioSampleSink(track).samples()) {
		expect(decoded.duration).toBe(syncframeDuration);
		sampleTimestamps.push(decoded.timestamp);
	}

	expect(sampleTimestamps.length).toBe(syncframes.length);
	for (let i = 0; i < sampleTimestamps.length; i++) {
		expect(sampleTimestamps[i]).toBeCloseTo(syncframes[i]!.timestamp, 6);
	}

	// Seeking lands on the right syncframe within an MP4 sample
	const secondSyncframe = (await new EncodedPacketSink(track).getPacket(1.5 * syncframeDuration))!;
	expect(secondSyncframe.timestamp).toBeCloseTo(syncframes[1]!.timestamp, 6);
});

test('AC-3 encoding with three channels', async () => {
	await testChannelLayout(3, 3); // L, C, R
});

test('AC-3 encoding with four channels', async () => {
	await testChannelLayout(4, 6); // L, R, Ls, Rs
});

const testChannelLayout = async (numberOfChannels: number, expectedAcmod: number) => {
	registerAc3Decoder();
	registerAc3Encoder();

	const sampleRate = 48000;

	// Every channel gets a tone of its own, so we can tell where each of them ends up
	const tones = [500, 700, 1000, 1300];
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
	const source = new AudioSampleSource({
		codec: 'ac3',
		quality: new Quality({ bitrate: 384000 }),
	});
	output.addAudioTrack(source);
	await output.start();

	const sample = new AudioSample({
		data,
		format: 'f32',
		numberOfChannels,
		sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	sample.close();
	source.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);
	const frameInfo = parseAc3SyncFrame(firstPacket.data);
	assert(frameInfo);
	expect(frameInfo.acmod).toBe(expectedAcmod);
	expect(frameInfo.lfeon).toBe(0);

	// Lay the decoded audio out on the timeline to line it up with the input
	const decoded = Array.from({ length: numberOfChannels }, () => new Float32Array(sampleRate));
	for await (using decodedSample of new AudioSampleSink(track).samples()) {
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
