import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const findBytes = (haystack: Uint8Array, needle: Uint8Array) => {
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (needle.every((byte, j) => haystack[i + j] === byte)) {
			return i;
		}
	}

	return -1;
};

const findBoxPayload = (bytes: Uint8Array, type: string) => {
	const typeOffset = findBytes(bytes, new TextEncoder().encode(type));
	if (typeOffset < 4) {
		return null;
	}

	const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(typeOffset - 4);
	return bytes.subarray(typeOffset + 4, typeOffset - 4 + size);
};

type PacketFixture = {
	size: number;
	timestamp: number;
	duration: number;
	type?: 'key' | 'delta';
};

type FastStart = false | 'in-memory' | 'reserve' | 'fragmented';

const createVideoMp4 = async (
	fastStart: FastStart,
	packets: PacketFixture[],
	nominalBitrate?: number,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp9');
	source._nominalBitrate = nominalBitrate;
	output.addVideoTrack(source, {
		maximumPacketCount: fastStart === 'reserve' ? packets.length : undefined,
		decoderConfig: {
			codec: 'vp09.00.10.08',
			codedWidth: 1280,
			codedHeight: 720,
		},
	});

	await output.start();
	for (const packet of packets) {
		await source.add(new EncodedPacket(
			new Uint8Array(packet.size),
			packet.type ?? 'key',
			packet.timestamp,
			packet.duration,
		));
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const createAacMp4 = async (
	fastStart: FastStart,
	packets: PacketFixture[],
	nominalBitrate?: number,
	adts = false,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	source._nominalBitrate = nominalBitrate;
	output.addAudioTrack(source, {
		maximumPacketCount: fastStart === 'reserve' ? packets.length : undefined,
		decoderConfig: adts
			? undefined
			: {
					codec: 'mp4a.40.2',
					sampleRate: 44100,
					numberOfChannels: 2,
					description: new Uint8Array([0x12, 0x10]),
				},
	});

	await output.start();
	for (let i = 0; i < packets.length; i++) {
		const packet = packets[i]!;
		let data = new Uint8Array(packet.size);
		if (adts) {
			const frameLength = data.byteLength + 7;
			const header = new Uint8Array([
				0xff,
				0xf1,
				0x50,
				0x80 | (frameLength >> 11),
				(frameLength >> 3) & 0xff,
				((frameLength & 0x7) << 5) | 0x1f,
				0xfc,
			]);
			const frame = new Uint8Array(frameLength);
			frame.set(header);
			frame.set(data, header.length);
			data = frame;
		}

		await source.add(new EncodedPacket(
			data,
			'key',
			packet.timestamp,
			packet.duration,
		), adts && i === 0
			? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2 } }
			: undefined);
	}
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const expectBitratePayload = (bytes: Uint8Array, boxType: 'btrt' | 'esds', maximum: number, average: number) => {
	let bitrateBytes: Uint8Array;
	if (boxType === 'btrt') {
		const payload = findBoxPayload(bytes, boxType);
		expect(payload).not.toBeNull();
		bitrateBytes = payload!.subarray(4, 12);
	} else {
		const decoderConfigOffset = findBytes(bytes, new Uint8Array([0x40, 0x15, 0x00, 0x00, 0x00]));
		expect(decoderConfigOffset).toBeGreaterThanOrEqual(0);
		bitrateBytes = bytes.subarray(decoderConfigOffset + 5, decoderConfigOffset + 13);
	}

	const view = new DataView(bitrateBytes.buffer, bitrateBytes.byteOffset, bitrateBytes.byteLength);
	expect({ maximum: view.getUint32(0), average: view.getUint32(4) }).toEqual({ maximum, average });
};

test('Regular MP4 modes write measured maximum and average video bitrates', async () => {
	const packets: PacketFixture[] = [
		{ size: 100, timestamp: 0, duration: 0.5 },
		{ size: 300, timestamp: 0.5, duration: 0.5 },
		{ size: 50, timestamp: 1, duration: 0.5 },
		{ size: 50, timestamp: 1.5, duration: 0.5 },
	];

	for (const fastStart of [false, 'in-memory', 'reserve'] as const) {
		const bytes = await createVideoMp4(fastStart, packets);
		expectBitratePayload(bytes, 'btrt', 3200, 2000);
	}
});

test('Regular MP4 measures B-frame bitrate by presentation time across negative shifts and gaps', async () => {
	for (const shift of [-2, 2]) {
		const bytes = await createVideoMp4(false, [
			{ size: 300, timestamp: shift + 0.5, duration: 0.5, type: 'key' },
			{ size: 100, timestamp: shift, duration: 0.5, type: 'delta' },
			{ size: 100, timestamp: shift + 2, duration: 0.5, type: 'key' },
		]);

		expectBitratePayload(bytes, 'btrt', 3200, 1600);
	}
});

test('Regular MP4 excludes samples exactly one second apart despite floating-point timestamps', async () => {
	const bytes = await createVideoMp4(false, [
		{ size: 100, timestamp: 0.4, duration: 1 },
		{ size: 100, timestamp: 1.4, duration: 1 },
	]);

	expectBitratePayload(bytes, 'btrt', 800, 800);
});

test('Regular MP4 uses a fixed one-second maximum window for short and zero-duration video', async () => {
	const shortClip = await createVideoMp4(false, [
		{ size: 100, timestamp: 0, duration: 0.25 },
	]);
	expectBitratePayload(shortClip, 'btrt', 800, 3200);

	const zeroDuration = await createVideoMp4(false, [
		{ size: 100, timestamp: 0, duration: 0 },
	]);
	expectBitratePayload(zeroDuration, 'btrt', 800, 0);
});

test('Regular MP4 measures AAC bitrate after stripping ADTS headers', async () => {
	const bytes = await createAacMp4(false, [
		{ size: 100, timestamp: 0, duration: 0.5 },
		{ size: 300, timestamp: 0.5, duration: 0.5 },
		{ size: 100, timestamp: 1, duration: 1 },
	], undefined, true);

	expectBitratePayload(bytes, 'esds', 3200, 2000);
});

test('Fragmented MP4 writes known nominal bitrate and preserves unknown values', async () => {
	const packet = [{ size: 100, timestamp: 0, duration: 1 }];
	const nominalVideo = await createVideoMp4('fragmented', packet, 3_000_000);
	expectBitratePayload(nominalVideo, 'btrt', 3_000_000, 3_000_000);

	const unknownVideo = await createVideoMp4('fragmented', packet);
	expect(findBoxPayload(unknownVideo, 'btrt')).toBeNull();

	const nominalAudio = await createAacMp4('fragmented', packet, 192_000);
	expectBitratePayload(nominalAudio, 'esds', 192_000, 192_000);

	const unknownAudio = await createAacMp4('fragmented', packet);
	expectBitratePayload(unknownAudio, 'esds', 0, 0);
});

test('Fragmented MP4 clamps oversized nominal bitrate and rejects non-finite values', async () => {
	const packet = [{ size: 100, timestamp: 0, duration: 1 }];
	const oversizedVideo = await createVideoMp4('fragmented', packet, 0x1_0000_0000);
	expectBitratePayload(oversizedVideo, 'btrt', 0xffff_ffff, 0xffff_ffff);

	const nonFiniteVideo = await createVideoMp4('fragmented', packet, Number.POSITIVE_INFINITY);
	expect(findBoxPayload(nonFiniteVideo, 'btrt')).toBeNull();

	const nonFiniteAudio = await createAacMp4('fragmented', packet, Number.NaN);
	expectBitratePayload(nonFiniteAudio, 'esds', 0, 0);
});

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
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
		format: new Mp4OutputFormat(),
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

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const originalVideoSink = new EncodedPacketSink(videoTrack);
	const originalTimestamps: number[] = [];
	for await (const packet of originalVideoSink.packets()) {
		originalTimestamps.push(packet.timestamp);
	}

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(originalTimestamps);
});

test('Zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);
});

test('Non-zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') && str.includes('elst')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Non-zero start timestamp, fragmented MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Negative start timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, false);
});

test('Negative start timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, true);
});

test('Wholly negative timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, false);
});

test('Wholly negative timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, true);
});

const testNegativeTimestampRoundTrip = async (
	timestamps: number[],
	duration: number,
	fragmented: boolean,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : false }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate: 10 });

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

test('PCM audio', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test('PCM audio with non-zero timestamp', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(1);
});

test('PCM audio, silence padding', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 48000 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

test('PCM audio, no silence padding with approximate timestamps', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	// 0.006 is 256/48000 "rounded up", but it's close enough for silence padding not to kick in
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0.006, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 256 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

// https://github.com/Vanilagy/mediabunny/pull/391
test('At least one track is enabled even if all are added disabled', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	const source1 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source1, { disposition: { default: false } });

	const source2 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source2, { disposition: { default: false } });

	await output.start();

	await source1.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source2.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks.length).toBe(2);

	// Even though both tracks were added disabled, the muxer forces the first one to be enabled
	expect((await tracks[0]!.getDisposition()).default).toBe(true);
	expect((await tracks[1]!.getDisposition()).default).toBe(false);
});
