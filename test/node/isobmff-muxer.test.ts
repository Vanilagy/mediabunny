import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { AppendOnlyStreamTarget, BufferTarget, NullTarget, StreamTarget, Target } from '../../src/target.js';
import { CmafOutputFormat, IsobmffOutputFormat, MovOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert, toDataView } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource, TextSubtitleSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { InputTrack } from '../../src/input-track.js';
import { IsobmffMuxer } from '../../src/isobmff/isobmff-muxer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const vp8Meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
const mp3Meta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };

const STSD_PATH = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'];

type FoundBox = {
	contentStart: number;
	end: number;
};

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

test('xHE-AAC decoder config', async () => {
	const target = new BufferTarget();
	const output = new Output({
		format: new Mp4OutputFormat(),
		target,
	});
	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	const packet = new EncodedPacket(new Uint8Array(16), 'key', 0, 1024 / 48000);
	await source.add(packet, {
		decoderConfig: {
			codec: 'mp4a.40.42',
			numberOfChannels: 2,
			sampleRate: 48000,
			// AudioSpecificConfig with the USAC object type (42), 48 kHz, stereo
			description: new Uint8Array([0xf9, 0x46, 0x40]),
		},
	});
	await output.finalize();

	using input = new Input({
		source: new BufferSource(target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodecParameterString()).toBe('mp4a.40.42');
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

test('btrt boxes computed from packet sizes, regular MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat());
	const boxes = findBtrtBoxes(bytes);

	expect(boxes).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 3261384,
			avgBitrate: 2858330,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 318224,
			avgBitrate: 317375,
		},
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getBitrate()).toBe(3261384);
	expect(await videoTrack.getAverageBitrate()).toBe(2858330);
	expect(await audioTrack.getBitrate()).toBe(318224);
	expect(await audioTrack.getAverageBitrate()).toBe(317375);
});

test('btrt boxes copied from input metadata in conversion, fragmented MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat({ fastStart: 'fragmented' }));

	// These are equal to what was in the input file
	expect(findBtrtBoxes(bytes)).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 2858329,
			avgBitrate: 2858329,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 320000,
			avgBitrate: 317375,
		},
	]);
});

test('No btrt boxes, fragmented MP4 without bitrate metadata', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource((await audioTrack.getCodec())!);
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();

	const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: (await audioTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([]);
});

const copyVideoMp4 = async (format: Mp4OutputFormat) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

const findBtrtBoxes = (bytes: Uint8Array) => {
	const view = toDataView(bytes);
	const boxes: { bufferSizeDB: number; maxBitrate: number; avgBitrate: number }[] = [];

	for (let i = 0; i < bytes.length - 4; i++) {
		if (bytes[i] !== 0x62 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x72 || bytes[i + 3] !== 0x74) {
			continue;
		}

		const boxSize = view.getUint32(i - 4);
		expect(boxSize).toBe(20);

		boxes.push({
			bufferSizeDB: view.getUint32(i + 4),
			maxBitrate: view.getUint32(i + 8),
			avgBitrate: view.getUint32(i + 12),
		});
	}

	return boxes;
};

test('Chunks written in chronological order, no Fast Start', async () => {
	await testChunkOrder(false);
});

test('Chunks written in chronological order, in-memory Fast Start', async () => {
	await testChunkOrder('in-memory');
});

test('Chunks written in chronological order, reserved Fast Start', async () => {
	await testChunkOrder('reserve');
});

const testChunkOrder = async (fastStart: false | 'in-memory' | 'reserve') => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 1000 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 1000 });

	await output.start();

	// Add all video before all audio, so the muxer can't just write chunks in the order they complete
	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	for (let i = 0; i < 150; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), i === 0 ? 'key' : 'delta', i / 30, 1 / 30);
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	for (let i = 0; i < 200; i++) {
		const packet = new EncodedPacket(new Uint8Array(8), 'key', 0.01 + 1152 * i / 48000, 1152 / 48000);
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	// Packet data read from a BufferSource is a view into the file, so its byte offset is its position in the file
	const packets: { trackIndex: number; timestamp: number; offset: number }[] = [];
	const tracks = await input.getTracks();
	for (let i = 0; i < tracks.length; i++) {
		for await (const packet of new EncodedPacketSink(tracks[i]!).packets()) {
			packets.push({
				trackIndex: i,
				timestamp: packet.timestamp,
				offset: packet.data.byteOffset,
			});
		}
	}

	expect(packets).toHaveLength(350);
	const packetsInFileOrder = packets.sort((a, b) => a.offset - b.offset);

	const chunkStartTimestamps: number[] = [];
	for (let i = 0; i < packetsInFileOrder.length; i++) {
		if (i === 0 || packetsInFileOrder[i]!.trackIndex !== packetsInFileOrder[i - 1]!.trackIndex) {
			chunkStartTimestamps.push(packetsInFileOrder[i]!.timestamp);
		}
	}

	expect(chunkStartTimestamps.length).toBeGreaterThan(10);
	expect(chunkStartTimestamps).toEqual([...chunkStartTimestamps].sort((a, b) => a - b));
};

test('Reserved Fast Start rejects a maximum packet count beyond u32', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});
	output.addVideoTrack(new EncodedVideoPacketSource('vp8'), { maximumPacketCount: 2 ** 32 });

	await expect(output.start()).rejects.toThrow('exceeds the maximum');
});

// This used to cause an assertion failure in the box writing code
test('Reserved Fast Start with a B-frame GOP completed before all tracks are known', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 100 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 100 });

	await output.start();

	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const videoTimestamps = [0, 0.2, 0.1, 0.3];
	for (let i = 0; i < videoTimestamps.length; i++) {
		const type = i === 0 || i === 3 ? 'key' : 'delta';
		await videoSource.add(new EncodedPacket(new Uint8Array(8), type, videoTimestamps[i]!, 0.1), videoMeta);
	}

	const audioMeta = { decoderConfig: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 } };
	await audioSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1152 / 48000), audioMeta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(videoTimestamps);
});

test('In-memory Fast Start with an append-only target', async () => {
	const chunks: Uint8Array[] = [];
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
		target: new AppendOnlyStreamTarget(new WritableStream({
			write: (chunk) => {
				chunks.push(chunk.slice());
			},
		})),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	for (let i = 0; i < 10; i++) {
		const packet = new EncodedPacket(new Uint8Array(100).fill(i), i === 0 ? 'key' : 'delta', i / 10, 0.1);
		await source.add(packet, vp8Meta);
	}

	await output.finalize();

	const bytes = new Uint8Array(chunks.reduce((acc, x) => acc + x.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.data[0]).toBe(timestamps.length);
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
});

test('onMoov data with reserved Fast Start', async () => {
	let moovData = null as Uint8Array | null;
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: 'reserve',
			onMoov: (data) => {
				moovData = data;
			},
		}),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { maximumPacketCount: 10 });

	await output.start();

	for (let i = 0; i < 10; i++) {
		await source.add(new EncodedPacket(new Uint8Array(8), i === 0 ? 'key' : 'delta', i / 10, 0.1), vp8Meta);
	}

	await output.finalize();

	assert(moovData);
	const boxSize = toDataView(moovData).getUint32(0);
	expect(String.fromCharCode(...moovData.subarray(4, 8))).toBe('moov');
	expect(moovData.byteLength).toBe(boxSize);
});

test('Fragmented MP4, track starting later at a negative timestamp', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();

	// The video alone spans more than the minimum fragment duration before the audio's first packet
	const videoTimestamps = [-2, -1.5, -1, -0.5, 0, 0.5];
	for (const timestamp of videoTimestamps) {
		await videoSource.add(new EncodedPacket(new Uint8Array(8), 'key', timestamp, 0.5), vp8Meta);
	}

	const audioTimestamps = [-0.75, -0.25, 0.25];
	for (const timestamp of audioTimestamps) {
		await audioSource.add(new EncodedPacket(new Uint8Array(8), 'key', timestamp, 0.5), mp3Meta);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await readTimestamps(videoTrack)).toEqual(videoTimestamps);
	expect(await readTimestamps(audioTrack)).toEqual(audioTimestamps);
});

const readTimestamps = async (track: InputTrack) => {
	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}

	return timestamps;
};

test('Fragment start timestamps with a negative start timestamp', async () => {
	const fragmentTimestamps: number[] = [];
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: 'fragmented',
			onMoof: (data, position, timestamp) => {
				fragmentTimestamps.push(timestamp);
			},
		}),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	for (const timestamp of [-1, -0.5, 0, 0.5, 1, 1.5]) {
		await source.add(new EncodedPacket(new Uint8Array(8), 'key', timestamp, 0.5), vp8Meta);
	}

	await output.finalize();

	expect(fragmentTimestamps).toEqual([-1, 0, 1]);
});

test('Fragmented MP4 with an mdat larger than 4 GiB', async () => {
	const target = new HeaderRecordingTarget();
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target,
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	// All packets share the same buffer, so this stays cheap on memory
	const data = new Uint8Array(2 ** 28);
	for (let i = 0; i < 17; i++) {
		await source.add(new EncodedPacket(data, 'key', i / 30, 1 / 30), vp8Meta);
	}

	await output.finalize();

	const boxTypes: string[] = [];
	let pos = 0;
	while (pos < target.size) {
		const header = target.read(pos, 16);
		const view = toDataView(header);
		const compactSize = view.getUint32(0);
		const largeSizeHigh = view.getUint32(8);
		const largeSizeLow = view.getUint32(12);
		const size = compactSize === 1 ? 2 ** 32 * largeSizeHigh + largeSizeLow : compactSize;
		expect(size).toBeGreaterThan(0);

		boxTypes.push(String.fromCharCode(...header.subarray(4, 8)));
		pos += size;
	}

	expect(boxTypes).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'mfra']);
	expect(pos).toBe(target.size);
});

// Only keeps small writes, which is enough to reconstruct box headers without holding on to huge sample data
class HeaderRecordingTarget extends Target {
	writes: { pos: number; data: Uint8Array }[] = [];
	size = 0;

	_start() {}

	_write(data: Uint8Array, pos: number) {
		if (data.byteLength <= 2 ** 16) {
			this.writes.push({
				pos,
				data: data.slice(),
			});
		}

		this.size = Math.max(this.size, pos + data.byteLength);
	}

	async _flush() {}

	async _finalize() {}

	async _release() {}

	read(pos: number, length: number) {
		const result = new Uint8Array(length);
		for (const write of this.writes) {
			const start = Math.max(pos, write.pos);
			const end = Math.min(pos + length, write.pos + write.data.byteLength);
			if (start < end) {
				result.set(write.data.subarray(start - write.pos, end - write.pos), start - pos);
			}
		}

		return result;
	}
}

test('CMAF segment over 2 GiB', async () => {
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new NullTarget(),
		initTarget: new NullTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	await addHugePackets(source);

	// sidx can't reference this many bytes
	await expect(output.finalize()).rejects.toThrow('CMAF segments must be smaller than 2 GiB');
});

test('Traf data more than 2 GiB past its moof', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: 'fragmented',
			minimumFragmentDuration: Infinity,
		}),
		target: new NullTarget(),
	});

	const hugeSource = new EncodedVideoPacketSource('vp8');
	const smallSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(hugeSource);
	output.addVideoTrack(smallSource);
	await output.start();

	// The small track's data comes after all of the huge track's data in the one and only fragment, too far away from
	// the moof for trun's signed 32-bit data offset
	await addHugePackets(hugeSource);
	await smallSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 1), vp8Meta);
	await expect(output.finalize()).rejects.toThrow('must start less than 2 GiB after its moof box');
});

const addHugePackets = async (source: EncodedVideoPacketSource) => {
	// Reusing one buffer keeps memory in check, since the muxer only holds references to packet data
	const data = new Uint8Array(2 ** 28);
	for (let i = 0; i < 9; i++) {
		await source.add(new EncodedPacket(data, i === 0 ? 'key' : 'delta', i, 1), vp8Meta);
	}
};

test('WebVTT cues with zero duration', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	await source.add([
		'WEBVTT',
		'',
		'00:00.000 --> 00:02.000',
		'A',
		'',
		'00:01.000 --> 00:01.000',
		'B',
		'',
		'00:03.000 --> 00:03.000',
		'C',
		'',
		'00:04.000 --> 00:05.000',
		'D',
		'',
	].join('\n'));
	await output.finalize();

	const payloads = findBoxes(new Uint8Array(output.target.buffer!), 'payl')
		.map(box => new TextDecoder().decode(box));
	expect(payloads).toEqual(['A', 'D']);
});

test('WebVTT touching cues', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	// In floating point, 0.1 + 0.2 isn't 0.3
	await source.add([
		'WEBVTT',
		'',
		'00:00.100 --> 00:00.300',
		'A',
		'',
		'00:00.300 --> 00:00.500',
		'B',
		'',
		'00:00.700 --> 00:00.900',
		'C',
		'',
	].join('\n'));
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const sttsView = toDataView(findBoxes(bytes, 'stts')[0]!);
	const entryCount = sttsView.getUint32(4);
	const sampleDurations: number[] = [];
	for (let i = 0; i < entryCount; i++) {
		const sampleCount = sttsView.getUint32(8 + 8 * i);
		const sampleDelta = sttsView.getUint32(12 + 8 * i);
		sampleDurations.push(...Array<number>(sampleCount).fill(sampleDelta));
	}

	expect(sampleDurations).toEqual([100, 200, 200, 200, 200]);
	expect(findBoxes(bytes, 'payl').map(box => new TextDecoder().decode(box))).toEqual(['A', 'B', 'C']);
	expect(findBoxes(bytes, 'vsid')).toEqual([]);
});

test('WebVTT cue time box', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	await source.add('WEBVTT\n\n00:05.000 --> 00:07.000\nHello <00:06.000>world\n');
	await output.finalize();

	const times = findBoxes(new Uint8Array(output.target.buffer!), 'ctim')
		.map(box => new TextDecoder().decode(box));
	expect(times).toEqual(['00:00:05.000']);
});

test('Failure while closing a track', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: false }),
		target: new StreamTarget(new WritableStream({
			write: () => {
				throw new Error('Write failed.');
			},
		})),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource);
	const audioTrack = output.addAudioTrack(audioSource);

	await output.start();

	// Lets the failed write of the file header surface, so that the next flush throws
	await new Promise(resolve => setTimeout(resolve, 0));

	await audioSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 0.1), mp3Meta);

	// The audio track ran dry, so these stay queued
	for (let i = 0; i < 10; i++) {
		await videoSource.add(new EncodedPacket(new Uint8Array(8), i === 0 ? 'key' : 'delta', i / 10, 0.1), vp8Meta);
	}

	// Closing the audio track writes out the queued video packets. The muxer is called directly since
	// MediaSource.close() doesn't surface the error.
	const muxer = output._muxer as IsobmffMuxer;
	await expect(muxer.onTrackClose(audioTrack)).rejects.toThrow('Write failed.');

	await expect(output.finalize()).rejects.toThrow('Write failed.');
});

test('Failure while starting', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.addVideoTrack(new EncodedVideoPacketSource('vp8'));
	output.setMetadataTags({ creationTime: new Date('1900-01-01T00:00:00Z') });

	await expect(output.start()).rejects.toThrow('creationTime must be after');
	await expect(output.finalize()).rejects.toThrow();
});

test('Disc number atom', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	output.setMetadataTags({
		discNumber: 2,
		discsTotal: 3,
	});
	await writeVideoPacket(output);

	const bytes = new Uint8Array(output.target.buffer!);
	expect(findBox(bytes, ['moov', 'udta', 'meta', 'ilst', 'disc'])).toBeNull();

	const dataBox = findBox(bytes, ['moov', 'udta', 'meta', 'ilst', 'disk', 'data']);
	assert(dataBox);

	const view = toDataView(bytes);
	const discNumber = view.getUint16(dataBox.contentStart + 10);
	const discsTotal = view.getUint16(dataBox.contentStart + 12);
	expect(discNumber).toBe(2);
	expect(discsTotal).toBe(3);
});

test('VP8 bit depth in vpcC', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	await writeVideoPacket(output);

	// The bit depth sits in the upper bits of the byte following version, flags, profile and level
	const vpcC = findBoxes(new Uint8Array(output.target.buffer!), 'vpcC')[0]!;
	expect(vpcC[6]! >> 4).toBe(8);
});

test('Handler name, MOV', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	await writeVideoPacket(output);

	// QuickTime wants a counted string after the 24 bytes of version, flags, types, manufacturer and component flags
	const name = findBoxes(new Uint8Array(output.target.buffer!), 'hdlr')[0]!.subarray(24);
	expect(name[0]).toBe(name.length - 1);
	expect(new TextDecoder().decode(name.subarray(1))).toBe('MediabunnyVideoHandler');
});

const writeVideoPacket = async (output: Output) => {
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), vp8Meta);
	await output.finalize();
};

const findBoxes = (bytes: Uint8Array, type: string) => {
	const view = toDataView(bytes);
	const contents: Uint8Array[] = [];

	for (let i = 4; i < bytes.length - 4; i++) {
		if (String.fromCharCode(...bytes.subarray(i, i + 4)) !== type) {
			continue;
		}

		const size = view.getUint32(i - 4);
		contents.push(bytes.subarray(i + 4, i - 4 + size));
	}

	return contents;
};

test('24-bit PCM sample entry, MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s24');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'pcm-s24',
		numberOfChannels: 2,
		sampleRate: 48000,
	};
	await source.add(new EncodedPacket(new Uint8Array(6 * 1024), 'key', 0, 1024 / 48000), { decoderConfig });
	await output.finalize();

	// QuickTime's extended version 1 layout has no place in an ISO sample entry, Apple drops the track if it's there
	const bytes = new Uint8Array(output.target.buffer!);
	const sampleEntry = findBox(bytes, [...STSD_PATH, 'ipcm']);
	assert(sampleEntry);

	const version = toDataView(bytes).getUint16(sampleEntry.contentStart + 8);
	expect(version).toBe(0);
	expect(findBox(bytes, [...STSD_PATH, 'ipcm', 'pcmC'])).not.toBeNull();

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s24');
	expect(await track.getSampleRate()).toBe(48000);
});

test('AAC sample entry above 65535 Hz, MOV', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 96000,
		description: new Uint8Array([0x10, 0x10]), // AAC-LC, 96 kHz, stereo
	};
	await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1024 / 96000), { decoderConfig });
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const sampleEntry = findBox(bytes, [...STSD_PATH, 'mp4a']);
	assert(sampleEntry);

	const view = toDataView(bytes);
	const version = view.getUint16(sampleEntry.contentStart + 8);
	const sampleRate = view.getFloat64(sampleEntry.contentStart + 32);
	expect(version).toBe(2);
	expect(sampleRate).toBe(96000);
	expect(findBox(bytes, [...STSD_PATH, 'mp4a', 'esds'])).not.toBeNull();
});

test('24-bit FLAC sample entry above 65535 Hz, MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('flac');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'flac',
		numberOfChannels: 2,
		sampleRate: 96000,
		// 'fLaC', then a lone STREAMINFO block: 4096-sample blocks, 96 kHz, stereo, 24 bits per sample
		description: new Uint8Array([
			0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22,
			0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x17, 0x70, 0x03, 0x70, 0x00, 0x00, 0x00, 0x00,
			...new Uint8Array(16),
		]),
	};
	await source.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 4096 / 96000), { decoderConfig });
	await output.finalize();

	const bytes = new Uint8Array(output.target.buffer!);
	const sampleEntry = findBox(bytes, [...STSD_PATH, 'fLaC']);
	assert(sampleEntry);

	const view = toDataView(bytes);
	expect(view.getUint16(sampleEntry.contentStart + 18)).toBe(24);
	expect(view.getUint16(sampleEntry.contentStart + 24)).toBe(48000); // Halved until it fits

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getSampleRate()).toBe(96000);
});

test('AC-3 in MOV', async () => {
	await testAc3InMov('ac3', 'ac-3', 'dac3');
});

test('E-AC-3 in MOV', async () => {
	// Apple's players drop E-AC-3 tracks in MOV whose dec3 box isn't wrapped in a wave box
	await testAc3InMov('eac3', 'ec-3', 'dec3');
});

const testAc3InMov = async (codec: 'ac3' | 'eac3', sampleEntryName: string, configBoxName: string) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, `../public/${codec}.mp4`)),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		showWarnings: false,
	});
	await conversion.execute();

	// The config box goes into a wave box
	const bytes = new Uint8Array(output.target.buffer!);
	expect(findBox(bytes, [...STSD_PATH, sampleEntryName, 'wave', configBoxName])).not.toBeNull();

	using outputAsInput = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const track = await outputAsInput.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe(codec);
	expect(await track.getNumberOfChannels()).toBe(6);
	expect(await track.getSampleRate()).toBe(48000);
};

const findBox = (bytes: Uint8Array, boxPath: string[]) => {
	const view = toDataView(bytes);

	const search = (start: number, end: number, depth: number, parentType: string | null): FoundBox | null => {
		let pos = start;
		while (pos < end) {
			const size = view.getUint32(pos);
			assert(size >= 8);

			const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
			const box = {
				contentStart: pos + 8,
				end: pos + size,
			};

			if (type === boxPath[depth]) {
				if (depth === boxPath.length - 1) {
					return box;
				}

				let childrenOffset = 0;
				if (type === 'stsd') {
					childrenOffset = 8;
				} else if (type === 'meta') {
					// QuickTime's meta box isn't a full box
					const nextType = String.fromCharCode(...bytes.subarray(box.contentStart + 4, box.contentStart + 8));
					childrenOffset = nextType === 'hdlr' ? 0 : 4;
				} else if (parentType === 'stsd') {
					// Audio sample entries grow with their version
					const version = view.getUint16(box.contentStart + 8);
					childrenOffset = 28 + [0, 16, 36][version]!;
				}

				const result = search(box.contentStart + childrenOffset, box.end, depth + 1, type);
				if (result) {
					return result;
				}
			}

			pos += size;
		}

		return null;
	};

	return search(0, bytes.byteLength, 0, null);
};

test('Key frames in the middle of a fragment', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	// Key frames every half second, so each one-second fragment contains two of them
	const types = Array.from({ length: 60 }, (_, i) => i % 15 === 0 ? 'key' as const : 'delta' as const);
	for (let i = 0; i < types.length; i++) {
		await source.add(new EncodedPacket(new Uint8Array(1024), types[i]!, i / 30, 1 / 30), vp8Meta);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const readTypes: string[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		readTypes.push(packet.type);
	}

	expect(readTypes).toEqual(types);
});

test('PCM above 65535 Hz, MOV', async () => {
	await testPcmAbove65535Hz(new MovOutputFormat());
});

test('PCM above 65535 Hz, MP4', async () => {
	const bytes = await testPcmAbove65535Hz(new Mp4OutputFormat());

	// The rate that doesn't fit into the sample entry goes into a srat box
	const srat = findBox(bytes, [...STSD_PATH, 'ipcm', 'srat']);
	assert(srat);
	expect(toDataView(bytes).getUint32(srat.contentStart + 4)).toBe(96000);
});

const testPcmAbove65535Hz = async (format: IsobmffOutputFormat) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s24');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'pcm-s24',
		numberOfChannels: 2,
		sampleRate: 96000,
	};
	const data = new Uint8Array(6 * 960).map((_, i) => i);
	await source.add(new EncodedPacket(data, 'key', 0, 960 / 96000), { decoderConfig });
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s24');
	expect(await track.getSampleRate()).toBe(96000);
	expect(await track.getNumberOfChannels()).toBe(2);

	const readData: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		readData.push(...packet.data);
	}

	expect(new Uint8Array(readData)).toEqual(data);

	return new Uint8Array(output.target.buffer!);
};

test('Multichannel PCM, MOV', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();

	const decoderConfig = {
		codec: 'pcm-s16',
		numberOfChannels: 6,
		sampleRate: 48000,
	};
	await source.add(new EncodedPacket(new Uint8Array(12 * 480), 'key', 0, 480 / 48000), { decoderConfig });
	await output.finalize();

	// The version 1 sound description is only specified for mono and stereo, so this needs version 2, with lpcm
	const bytes = new Uint8Array(output.target.buffer!);
	const lpcm = findBox(bytes, [...STSD_PATH, 'lpcm']);
	assert(lpcm);
	expect(toDataView(bytes).getUint16(lpcm.contentStart + 8)).toBe(2);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s16');
	expect(await track.getNumberOfChannels()).toBe(6);
});
