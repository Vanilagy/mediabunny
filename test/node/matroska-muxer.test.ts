import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget } from '../../src/target.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource, TextSubtitleSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { MatroskaMuxer } from '../../src/matroska/matroska-muxer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Matroska muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Negative start timestamps', async () => {
	await testNegativeTimestampRoundTrip(
		Array.from({ length: 50 }, (_, index) => (index - 10) / 10),
		0.1,
		10,
	);
});

test('Wholly negative timestamps', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, 10);
});

const testNegativeTimestampRoundTrip = async (timestamps: number[], duration: number, frameRate: number) => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate });

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const inputPackets = timestamps.map((timestamp, index) => new EncodedPacket(
		new Uint8Array(1024).fill(index),
		'key',
		timestamp,
		duration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	// The Segment Duration (in milliseconds) is the end timestamp, but never negative
	const bytes = new Uint8Array(output.target.buffer!);
	const durationPos = bytes.findIndex((_, i) => bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88);
	const segmentDuration = new DataView(bytes.buffer).getFloat64(durationPos + 3);
	expect(segmentDuration).toBeCloseTo(1000 * Math.max(timestamps.at(-1)! + duration, 0));

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(inputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	})));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual({
			timestamp: inputPacket.timestamp,
			duration: inputPacket.duration,
		});
	}
};

test('Negative audio start timestamps via CodecDelay', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);

	await output.start();

	const meta = {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 32000, // Makes the first frame start at exactly -32 ms
			description: new Uint8Array([0x12, 0x90]),
		},
	};
	const inputPackets = Array.from({ length: 50 }, (_, index) => new EncodedPacket(
		new Uint8Array(64).fill(index),
		'key',
		(index - 1) * 32 / 1000,
		32 / 1000,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	expect(containsBytes(bytes, [0x56, 0xaa])).toBe(true); // CodecDelay element ID

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getDurationFromMetadata()).toBe(49 * 32 / 1000);
	expect(await input.computeDuration()).toBe(49 * 32 / 1000);

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => packet.timestamp)).toEqual(inputPackets.map(packet => packet.timestamp));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect(outputPacket.timestamp).toBe(inputPacket.timestamp);
	}
});

test('MaxBlockAdditionID with alpha side data', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	const packet = new EncodedPacket(new Uint8Array(16), 'key', 0, 1 / 30, -1, undefined, {
		alpha: new Uint8Array(4),
	});
	await source.add(packet, {
		decoderConfig: {
			codec: 'vp8',
			codedWidth: 16,
			codedHeight: 16,
		},
	});
	await output.finalize();

	expect(containsBytes(new Uint8Array(output.target.buffer!), [0x55, 0xee, 0x81, 0x01])).toBe(true);
});

test('MaxBlockAdditionID with WebVTT cue settings', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);
	await output.start();

	await source.add('WEBVTT\n\nintro\n00:00.000 --> 00:01.000 align:start\nHello\n');
	await output.finalize();

	expect(containsBytes(new Uint8Array(output.target.buffer!), [0x55, 0xee, 0x81, 0x01])).toBe(true);
});

test('DefaultDuration rounding', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate: 30000 / 1001 });
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1001 / 30000), {
		decoderConfig: {
			codec: 'vp8',
			codedWidth: 16,
			codedHeight: 16,
		},
	});
	await output.finalize();

	// 33366666.67 ns, rounded to 33366667 (0x1fd228b)
	expect(containsBytes(
		new Uint8Array(output.target.buffer!),
		[0x23, 0xe3, 0x83, 0x84, 0x01, 0xfd, 0x22, 0x8b],
	)).toBe(true);
});

test('Output sampling frequency', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 2048 / 48000), {
		decoderConfig: {
			codec: 'mp4a.40.5',
			numberOfChannels: 2,
			sampleRate: 48000,
			// HE-AAC with a 24 kHz core, whose SBR doubles it to 48 kHz
			description: new Uint8Array([0x13, 0x10, 0x56, 0xe5, 0x98]),
		},
	});
	await output.finalize();

	// SamplingFrequency is 24000, OutputSamplingFrequency is 48000
	const data = new Uint8Array(output.target.buffer!);
	expect(containsBytes(data, [0xb5, 0x84, 0x46, 0xbb, 0x80, 0x00])).toBe(true);
	expect(containsBytes(data, [0x78, 0xb5, 0x84, 0x47, 0x3b, 0x80, 0x00])).toBe(true);
});

const containsBytes = (haystack: Uint8Array, needle: number[]) => {
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (needle.every((byte, j) => haystack[i + j] === byte)) {
			return true;
		}
	}

	return false;
};

test('AV1 key packet without a sequence header', async () => {
	const target = new BufferTarget();
	const output = new Output({
		format: new MkvOutputFormat(),
		target,
	});
	const source = new EncodedVideoPacketSource('av1');
	output.addVideoTrack(source);
	await output.start();

	// Just a temporal delimiter OBU, so there's no sequence header to derive the codec info from
	const packet = new EncodedPacket(new Uint8Array([0x12, 0x00]), 'key', 0, 1);
	await source.add(packet, {
		decoderConfig: {
			codec: 'av01.0.08M.08',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});
	await output.finalize();

	using input = new Input({
		source: new BufferSource(target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getCodecParameterString()).toBe('av01.0.08M.08');
});

test('Last frame duration with B-frames', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	// Two GOPs in decode order, I0 P3 B1 B2 P6 B4 B5 and I7 P10 B8 B9 P13 B11 B12, all landing in the same cluster
	const frames = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9, 13, 11, 12];
	for (const frame of frames) {
		const packet = new EncodedPacket(new Uint8Array(8), frame % 7 === 0 ? 'key' : 'delta', frame / 10, 0.1);
		await source.add(packet, {
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 16,
				codedHeight: 16,
			},
		});
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();

	const durations: number[] = [];
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		durations.push(packet.duration);
	}

	expect(durations).toEqual(Array<number>(frames.length).fill(0.1));
	expect(await input.computeDuration()).toBe(1.4);
});

test('Write error surfacing in track close', async () => {
	let failWrites = false;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new StreamTarget(new WritableStream({
			write: () => {
				if (failWrites) {
					throw new Error('Disk full');
				}
			},
		})),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(videoSource);
	const audioSource = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(audioSource);
	await output.start();

	await videoSource.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.1), {
		decoderConfig: {
			codec: 'vp8',
			codedWidth: 16,
			codedHeight: 16,
		},
	});

	failWrites = true;
	await audioSource.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.1), {
		decoderConfig: {
			codec: 'pcm-s16',
			numberOfChannels: 1,
			sampleRate: 1000,
		},
	});
	await new Promise(resolve => setTimeout(resolve)); // Let the failed write settle

	// Closing a source doesn't await the muxer's close handling, so we call it directly to see it run into the error
	const muxer = output._muxer as MatroskaMuxer;
	await expect(muxer.onTrackClose(output.tracks[0]!)).rejects.toThrow('Disk full');

	await expect(output.finalize()).rejects.toThrow('Disk full');
});

test('onSegmentHeader validation message', () => {
	expect(() => new MkvOutputFormat({ onSegmentHeader: 5 as never }))
		.toThrow('options.onSegmentHeader, when provided, must be a function.');
});
