import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import { CanvasSource, EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacket } from '../../src/packet.js';
import { MpegTsMuxer } from '../../src/mpeg-ts/mpeg-ts-muxer.js';

const AVC_DECODER_CONFIG: VideoDecoderConfig = {
	codec: 'avc1.64001f',
	codedWidth: 16,
	codedHeight: 16,
};

test('MPEG-TS output format', async () => {
	const format = new MpegTsOutputFormat();
	expect(format.mimeType).toBe('video/MP2T');
	expect(format.fileExtension).toBe('.ts');
	expect(format.supportsVideoTransformationMetadata).toBe(false);
	expect(format.getSupportedCodecs()).toEqual(['avc', 'hevc', 'aac', 'mp3', 'ac3', 'eac3', 'dts']);
	expect(format.getSupportedTrackCounts()).toEqual({
		video: { min: 0, max: 16 },
		audio: { min: 0, max: 32 },
		subtitle: { min: 0, max: 0 },
		total: { min: 0, max: 48 },
	});
});

test('MPEG-TS muxing with AVC and AAC', async () => {
	let tsPacketCount = 0;
	let started = false;
	let finalized = false;
	let mimeTypeResolved = false;

	const output = new Output({
		format: new MpegTsOutputFormat({
			onPacket: (data) => {
				expect(data[0]).toBe(0x47);
				tsPacketCount++;
			},
		}),
		target: new BufferTarget(),
	});

	// Test getMimeType - it resolves once all tracks are known (first packet arrives)
	void output.getMimeType().then((mimeType) => {
		expect(started).toBe(true);
		expect(finalized).toBe(false);
		expect(mimeType).toMatch(/^video\/MP2T; codecs="/);
		expect(mimeType).toMatch(/avc1\./);
		expect(mimeType).toMatch(/mp4a\.40\./);

		mimeTypeResolved = true;
	});

	const canvas = new OffscreenCanvas(640, 480);
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#000000';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(videoSource);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();
	started = true;

	const fps = 30;
	const duration = 2;
	const frameCount = fps * duration;
	const frameDuration = 1 / fps;

	for (let i = 0; i < frameCount; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	using aacInput = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const aacTrack = await aacInput.getPrimaryAudioTrack();
	assert(aacTrack);

	const aacSink = new EncodedPacketSink(aacTrack);

	let isFirst = true;
	for await (const packet of aacSink.packets()) {
		if (packet.timestamp >= duration) break;

		await audioSource.add(packet, {
			decoderConfig: isFirst
				? (await aacTrack.getDecoderConfig())!
				: undefined,
		});
		isFirst = false;
	}

	await output.finalize();
	finalized = true;

	expect(mimeTypeResolved).toBe(true);
	expect(tsPacketCount).toBeGreaterThan(100);

	// Now let's read it back using the demuxer
	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	// Verify video track
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(videoTrack.id).toBe(1);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect(await videoTrack.getDisplayWidth()).toBe(640);
	expect(await videoTrack.getDisplayHeight()).toBe(480);

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	assert(videoDecoderConfig);
	expect(videoDecoderConfig.codec).toMatch(/^avc1\./);
	expect(videoDecoderConfig.codedWidth).toBe(640);
	expect(videoDecoderConfig.codedHeight).toBe(480);
	expect(videoDecoderConfig.description).toBeUndefined(); // Annex B, no description

	// Verify audio track
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.id).toBe(2);
	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	assert(audioDecoderConfig);
	expect(audioDecoderConfig.codec).toMatch(/^mp4a\.40\./);
	expect(audioDecoderConfig.numberOfChannels).toBe(2);
	expect(audioDecoderConfig.sampleRate).toBe(48000);
	expect(audioDecoderConfig.description).toBeUndefined(); // ADTS, no description

	// Verify video packets are Annex B
	const videoSink = new EncodedPacketSink(videoTrack);
	let videoPacketCount = 0;

	const firstVideoPacket = await videoSink.getFirstPacket();
	assert(firstVideoPacket);
	expect(firstVideoPacket.type).toBe('key');

	const secondVideoPacket = await videoSink.getNextPacket(firstVideoPacket);
	assert(secondVideoPacket);

	for await (const packet of videoSink.packets()) {
		expect(packet.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1])); // Annex B start code
		videoPacketCount++;
	}

	// Check that seeking works
	const middlePacket = await videoSink.getPacket(1);
	assert(middlePacket);
	expect(middlePacket.timestamp).toBeCloseTo(1);

	expect(videoPacketCount).toBe(frameCount);

	// Verify audio packets are ADTS
	const audioSink = new EncodedPacketSink(audioTrack);
	let audioPacketCount = 0;

	const firstAudioPacket = await audioSink.getFirstPacket();
	assert(firstAudioPacket);
	expect(firstAudioPacket.type).toBe('key');

	const secondAudioPacket = await audioSink.getNextPacket(firstAudioPacket);
	assert(secondAudioPacket);
	expect(secondAudioPacket.type).toBe('key');

	for await (const packet of audioSink.packets()) {
		expect(packet.data[0]).toBe(0xff); // ADTS sync word
		expect(packet.data[1]! & 0xf0).toBe(0xf0); // ADTS sync word continued
		audioPacketCount++;
	}

	// Check that seeking works
	const audioMiddlePacket = await audioSink.getPacket(1);
	assert(audioMiddlePacket);
	expect(audioMiddlePacket.timestamp).toBeCloseTo(1, 1);

	expect(audioPacketCount).toBeGreaterThan(0);

	// Verify duration is approximately 5 seconds
	const videoDuration = await videoTrack.computeDuration();
	const audioDuration = await audioTrack.computeDuration();

	expect(videoDuration).toBeCloseTo(duration, 1);
	expect(audioDuration).toBeCloseTo(duration, 1);
});

test('MPEG-TS muxing with HEVC and MP3', async () => {
	let tsPacketCount = 0;
	const output = new Output({
		format: new MpegTsOutputFormat({
			onPacket: (data) => {
				expect(data[0]).toBe(0x47);
				tsPacketCount++;
			},
		}),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(videoSource);

	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(audioSource);

	await output.start();

	const duration = 5;

	// Extract HEVC packets from existing file
	using hevcInput = new Input({
		source: new UrlSource('/video-h265.mp4'),
		formats: ALL_FORMATS,
	});

	const hevcTrack = await hevcInput.getPrimaryVideoTrack();
	assert(hevcTrack);

	const hevcSink = new EncodedPacketSink(hevcTrack);

	let isFirstVideo = true;
	let videoPacketCountWritten = 0;
	for await (const packet of hevcSink.packets()) {
		if (packet.timestamp >= duration) break;

		await videoSource.add(packet, {
			decoderConfig: isFirstVideo
				? (await hevcTrack.getDecoderConfig())!
				: undefined,
		});
		isFirstVideo = false;
		videoPacketCountWritten++;
	}

	// Extract MP3 packets from existing file
	using mp3Input = new Input({
		source: new UrlSource('/Toothsome-Meme.VBRv2.mp3'),
		formats: ALL_FORMATS,
	});

	const mp3Track = await mp3Input.getPrimaryAudioTrack();
	assert(mp3Track);

	const mp3Sink = new EncodedPacketSink(mp3Track);

	let isFirstAudio = true;
	for await (const packet of mp3Sink.packets()) {
		if (packet.timestamp >= duration) break;

		await audioSource.add(packet, {
			decoderConfig: isFirstAudio
				? (await mp3Track.getDecoderConfig())!
				: undefined,
		});
		isFirstAudio = false;
	}

	await output.finalize();

	expect(tsPacketCount).toBeGreaterThan(100);

	// Now let's read it back using the demuxer
	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	// Verify video track
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(videoTrack.id).toBe(1);
	expect(await videoTrack.getCodec()).toBe('hevc');

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	assert(videoDecoderConfig);
	expect(videoDecoderConfig.codec).toMatch(/^hev1\./);
	expect(videoDecoderConfig.description).toBeUndefined(); // Annex B, no description

	// Verify audio track
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.id).toBe(2);
	expect(await audioTrack.getCodec()).toBe('mp3');
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(24000);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	assert(audioDecoderConfig);
	expect(audioDecoderConfig.codec).toBe('mp3');
	expect(audioDecoderConfig.numberOfChannels).toBe(2);
	expect(audioDecoderConfig.sampleRate).toBe(24000);
	expect(audioDecoderConfig.description).toBeUndefined(); // MP3 has no description

	// Verify video packets are Annex B
	const videoSink = new EncodedPacketSink(videoTrack);
	let videoPacketCount = 0;

	for await (const packet of videoSink.packets()) {
		expect(packet.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1])); // Annex B start code
		videoPacketCount++;
	}

	expect(videoPacketCount).toBe(videoPacketCountWritten);

	// Verify audio packets are MP3 frames
	const audioSink = new EncodedPacketSink(audioTrack);
	let audioPacketCount = 0;

	for await (const packet of audioSink.packets()) {
		expect(packet.data[0]).toBe(0xff); // MP3 sync word
		audioPacketCount++;
	}

	expect(audioPacketCount).toBeGreaterThan(0);

	// Verify duration is approximately 5 seconds
	const videoDuration = await videoTrack.computeDuration();
	const audioDuration = await audioTrack.computeDuration();

	expect(videoDuration).toBeCloseTo(4.933333333333334, 1);
	expect(audioDuration).toBeCloseTo(5, 1);
});

test('MPEG-TS muxing with no data', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(videoSource);

	await output.start();
	await output.finalize();

	// Read it back - should have zero tracks since no packets were written
	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.length).toBe(0);
});

test('MPEG-TS muxing with video only', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#ff0000';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 30;
	const duration = 1;
	const frameCount = fps * duration;
	const frameDuration = 1 / fps;

	for (let i = 0; i < frameCount; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('avc');

	const audioTrack = await input.getPrimaryAudioTrack();
	expect(audioTrack).toBeNull();

	const videoSink = new EncodedPacketSink(videoTrack);
	let videoPacketCount = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const packet of videoSink.packets()) {
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(frameCount);
});

test('MPEG-TS muxing with audio only', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	const duration = 1;

	using aacInput = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const aacTrack = await aacInput.getPrimaryAudioTrack();
	assert(aacTrack);

	const aacSink = new EncodedPacketSink(aacTrack);

	let isFirst = true;
	for await (const packet of aacSink.packets()) {
		if (packet.timestamp >= duration) break;

		await audioSource.add(packet, {
			decoderConfig: isFirst
				? (await aacTrack.getDecoderConfig())!
				: undefined,
		});
		isFirst = false;
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	const videoTrack = await input.getPrimaryVideoTrack();
	expect(videoTrack).toBeNull();

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('aac');

	const audioSink = new EncodedPacketSink(audioTrack);
	let audioPacketCount = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const packet of audioSink.packets()) {
		audioPacketCount++;
	}
	expect(audioPacketCount).toBeGreaterThan(0);
});

test('MPEG-TS muxing with two video tracks', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource1 = new EncodedVideoPacketSource('hevc');
	const videoSource2 = new EncodedVideoPacketSource('hevc');

	output.addVideoTrack(videoSource1);
	output.addVideoTrack(videoSource2);

	await output.start();

	const duration = 1;

	using hevcInput = new Input({
		source: new UrlSource('/video-h265.mp4'),
		formats: ALL_FORMATS,
	});

	const hevcTrack = await hevcInput.getPrimaryVideoTrack();
	assert(hevcTrack);

	const hevcSink = new EncodedPacketSink(hevcTrack);
	const hevcDecoderConfig = await hevcTrack.getDecoderConfig();

	let isFirst = true;
	for await (const packet of hevcSink.packets()) {
		if (packet.timestamp >= duration) break;

		const meta = { decoderConfig: isFirst ? hevcDecoderConfig! : undefined };
		await videoSource1.add(packet, meta);
		await videoSource2.add(packet, meta);
		isFirst = false;
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter(t => t.type === 'video');
	expect(videoTracks.length).toBe(2);

	expect(await videoTracks[0]!.getCodec()).toBe('hevc');
	expect(await videoTracks[1]!.getCodec()).toBe('hevc');
	expect(videoTracks[0]!.id).toBe(1);
	expect(videoTracks[1]!.id).toBe(2);
});

test('MPEG-TS muxing with two audio tracks', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource1 = new EncodedAudioPacketSource('aac');
	const audioSource2 = new EncodedAudioPacketSource('aac');

	output.addAudioTrack(audioSource1);
	output.addAudioTrack(audioSource2);

	await output.start();

	const duration = 1;

	using aacInput = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const aacTrack = await aacInput.getPrimaryAudioTrack();
	assert(aacTrack);

	const aacSink = new EncodedPacketSink(aacTrack);

	const decoderConfig = await aacTrack.getDecoderConfig();
	assert(decoderConfig);

	let isFirst1 = true;
	for await (const packet of aacSink.packets()) {
		if (packet.timestamp >= duration) break;

		await audioSource1.add(packet, {
			decoderConfig: isFirst1 ? decoderConfig : undefined,
		});
		isFirst1 = false;
	}

	let isFirst2 = true;
	for await (const packet of aacSink.packets()) {
		if (packet.timestamp >= duration) break;

		await audioSource2.add(packet, {
			decoderConfig: isFirst2 ? decoderConfig : undefined,
		});
		isFirst2 = false;
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	const tracks = await input.getTracks();
	const audioTracks = tracks.filter(t => t.type === 'audio');
	expect(audioTracks.length).toBe(2);

	expect(await audioTracks[0]!.getCodec()).toBe('aac');
	expect(await audioTracks[1]!.getCodec()).toBe('aac');
	expect(audioTracks[0]!.id).toBe(1);
	expect(audioTracks[1]!.id).toBe(2);
});

test('MPEG-TS transmux (Annex B and ADTS passthrough)', async () => {
	using input = new Input({
		source: new UrlSource('/0.ts'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		trim: { start: 0 }, // So we maintain the timestamps
	});
	expect(conversion.isValid).toBe(true);

	await conversion.execute();

	// Read the output back
	using outputInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await outputInput.getFormat()).toBe(MPEG_TS);

	const inputVideoTrack = await input.getPrimaryVideoTrack();
	const inputAudioTrack = await input.getPrimaryAudioTrack();
	const outputVideoTrack = await outputInput.getPrimaryVideoTrack();
	const outputAudioTrack = await outputInput.getPrimaryAudioTrack();

	assert(inputVideoTrack);
	assert(inputAudioTrack);
	assert(outputVideoTrack);
	assert(outputAudioTrack);

	// Codecs should match
	expect(await outputVideoTrack.getCodec()).toBe(await inputVideoTrack.getCodec());
	expect(await outputAudioTrack.getCodec()).toBe(await inputAudioTrack.getCodec());

	// Verify video packets are Annex B
	const videoSink = new EncodedPacketSink(outputVideoTrack);
	const firstVideoPacket = await videoSink.getFirstPacket();
	assert(firstVideoPacket);
	expect(firstVideoPacket.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));

	// Verify audio packets are ADTS
	const audioSink = new EncodedPacketSink(outputAudioTrack);
	const firstAudioPacket = await audioSink.getFirstPacket();
	assert(firstAudioPacket);
	expect(firstAudioPacket.data[0]).toBe(0xff);
	expect(firstAudioPacket.data[1]! & 0xf0).toBe(0xf0);

	expect(await outputInput.getFirstTimestamp()).toBe(10.012);
	expect(await outputInput.computeDuration()).toBe(15.004);
});

test('MPEG-TS muxing with StreamTarget', async () => {
	let nextPos = 0;
	const chunks: Uint8Array[] = [];

	const writable = new WritableStream<StreamTargetChunk>({
		write(chunk) {
			chunks.push(chunk.data);
			expect(chunk.position).toBe(nextPos);
			nextPos += chunk.data.byteLength;
		},
	});

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new StreamTarget(writable),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#0000ff';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 30;
	const duration = 1;
	const frameCount = fps * duration;
	const frameDuration = 1 / fps;

	for (let i = 0; i < frameCount; i++) {
		await videoSource.add(i * frameDuration, frameDuration, {
			keyFrame: true, // Otherwise all packets get written at once due to the DTS logic
		});
	}

	await output.finalize();

	expect(chunks).toHaveLength(frameCount);

	const buffer = new Uint8Array(nextPos);
	nextPos = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, nextPos);
		nextPos += chunk.byteLength;
	}

	// Verify the concatenated output
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('avc');

	const videoSink = new EncodedPacketSink(videoTrack);
	let videoPacketCount = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const packet of videoSink.packets()) {
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(frameCount);
});

test('MPEG-TS muxing with negative start timestamps', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1);
});

test('MPEG-TS muxing with wholly negative timestamps', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1);
});

const testNegativeTimestampRoundTrip = async (timestamps: number[], duration: number) => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#0000ff';
	context.fillRect(0, 0, canvas.width, canvas.height);

	const source = new CanvasSource(canvas, {
		codec: 'avc',
		quality: new Quality('high'),
	});
	output.addVideoTrack(source, { frameRate: 10 });

	await output.start();

	for (const timestamp of timestamps) {
		await source.add(timestamp, duration);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	const expectedPackets = timestamps.map(timestamp => ({ timestamp, duration }));
	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(expectedPackets);

	for (const expectedPacket of expectedPackets) {
		const outputPacket = await sink.getPacket(expectedPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual(expectedPacket);
	}
};

test('DTS with B-frames', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	// Two GOPs in decode order, presentation times given in frames
	const frames = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9];
	for (let i = 0; i < frames.length; i++) {
		const isKey = i === 0 || i === 7;
		const packet = new EncodedPacket(
			new Uint8Array([0, 0, 0, 1, isKey ? 0x65 : 0x41, 0x88]),
			isKey ? 'key' : 'delta',
			frames[i]! / 30,
			1 / 30,
		);

		await source.add(packet, { decoderConfig: AVC_DECODER_CONFIG });
	}

	await output.finalize();

	const pesPackets = readPesPackets(new Uint8Array(output.target.buffer!), 0x100);
	expect(pesPackets.map(x => x.pts)).toEqual(frames.map(x => 3000 * x));
	expect(pesPackets.map(x => x.dts)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(x => 3000 * x));
});

test('HEVC access unit delimiter', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	// A lone IDR_W_RADL slice
	const packet = new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x26, 0x01, 0xaf]), 'key', 0, 1 / 30);
	await source.add(packet, {
		decoderConfig: {
			codec: 'hev1.1.6.L93.B0',
			codedWidth: 16,
			codedHeight: 16,
		},
	});

	await output.finalize();

	const pesPackets = readPesPackets(new Uint8Array(output.target.buffer!), 0x100);
	expect(pesPackets).toHaveLength(1);
	// AUD with pic_type 2 and its RBSP trailing bits, followed by the slice
	expect([...pesPackets[0]!.data]).toEqual([0, 0, 0, 1, 0x46, 0x01, 0x50, 0, 0, 0, 1, 0x26, 0x01, 0xaf]);
});

const readPesPackets = (bytes: Uint8Array, pid: number) => {
	const pesPackets: {
		pts: number;
		dts: number | null;
		data: Uint8Array;
	}[] = [];
	let payloads: Uint8Array[] = [];

	for (let pos = 0; pos < bytes.length; pos += 188) {
		const packet = bytes.subarray(pos, pos + 188);
		expect(packet[0]).toBe(0x47);

		const packetPid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
		if (packetPid !== pid) {
			continue;
		}

		const pusi = !!(packet[1]! & 0x40);
		const hasAdaptationField = !!(packet[3]! & 0x20);
		const adaptationFieldLength = packet[4]!;
		const payload = packet.subarray(hasAdaptationField ? 5 + adaptationFieldLength : 4);

		if (pusi && payloads.length > 0) {
			pesPackets.push(parsePesPacket(payloads));
			payloads = [];
		}

		payloads.push(payload);
	}

	if (payloads.length > 0) {
		pesPackets.push(parsePesPacket(payloads));
	}

	return pesPackets;
};

const parsePesPacket = (payloads: Uint8Array[]) => {
	const pes = new Uint8Array(payloads.reduce((a, b) => a + b.length, 0));
	let offset = 0;
	for (const payload of payloads) {
		pes.set(payload, offset);
		offset += payload.length;
	}

	expect([...pes.subarray(0, 3)]).toEqual([0, 0, 1]);

	const ptsDtsFlags = pes[7]! >> 6;
	const headerDataLength = pes[8]!;
	expect(ptsDtsFlags & 0b10).toBe(0b10);

	return {
		pts: readTimestamp(pes.subarray(9)),
		dts: ptsDtsFlags === 0b11 ? readTimestamp(pes.subarray(14)) : null,
		data: pes.subarray(9 + headerDataLength),
	};
};

const readTimestamp = (bytes: Uint8Array) => {
	const high = (bytes[0]! >> 1) & 0x07;
	const middle = (bytes[1]! << 7) | (bytes[2]! >> 1);
	const low = (bytes[3]! << 7) | (bytes[4]! >> 1);
	const value = 2 ** 30 * high + 2 ** 15 * middle + low;

	// Values in the upper half are negative timestamps that were wrapped around
	return value >= 2 ** 32 ? value - 2 ** 33 : value;
};

test('Write error while closing a track', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new StreamTarget(new WritableStream({
			write() {
				throw new Error('Write failed');
			},
		})),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	// The second key packet flushes out the first GOP, which errors the stream
	for (let i = 0; i < 3; i++) {
		const isKey = i !== 1;
		const packet = new EncodedPacket(
			new Uint8Array([0, 0, 0, 1, isKey ? 0x65 : 0x41, 0x88]),
			isKey ? 'key' : 'delta',
			i / 30,
			1 / 30,
		);

		await source.add(packet, { decoderConfig: AVC_DECODER_CONFIG });
	}

	await new Promise(resolve => setTimeout(resolve));

	// The error only surfaces with the next flush, which happens as the track closes
	const muxer = output._muxer as MpegTsMuxer;
	await expect(muxer.onTrackClose(output.tracks[0]!)).rejects.toThrow('Write failed');

	await expect(output.finalize()).rejects.toThrow('Write failed');
});

test('Unrepresentable AAC channel configuration', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	// What FFmpeg's encoder writes for 7.1: channel configuration 12, too large for the 3-bit ADTS field
	const addPacket = () => source.add(
		new EncodedPacket(new Uint8Array(16), 'key', 0, 1024 / 48000),
		{
			decoderConfig: {
				codec: 'mp4a.40.2',
				numberOfChannels: 8,
				sampleRate: 48000,
				description: new Uint8Array([0x11, 0xe0, 0x56, 0xe5, 0x00]),
			},
		},
	);
	await expect(addPacket()).rejects.toThrow('channel configuration 12');

	// The rejected packet mustn't leave the track half set up
	await expect(addPacket()).rejects.toThrow('channel configuration 12');
});
