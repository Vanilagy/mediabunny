import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import { CanvasSource, EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { QUALITY_HIGH } from '../../src/encode.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Conversion } from '../../src/conversion.js';

test('MPEG-TS output format', async () => {
	const format = new MpegTsOutputFormat();
	expect(format.mimeType).toBe('video/MP2T');
	expect(format.fileExtension).toBe('.ts');
	expect(format.supportsVideoRotationMetadata).toBe(false);
	expect(format.getSupportedCodecs()).toEqual(['avc', 'hevc', 'aac', 'mp3', 'ac3']);
	expect(format.getSupportedTrackCounts()).toEqual({
		video: { min: 0, max: 16 },
		audio: { min: 0, max: 32 },
		subtitle: { min: 0, max: 0 },
		total: { min: 1, max: 48 },
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
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();
	started = true;

	const fps = 30;
	const duration = 5;
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

	expect(videoTrack.id).toBe(0x100);
	expect(videoTrack.codec).toBe('avc');
	expect(videoTrack.displayWidth).toBe(640);
	expect(videoTrack.displayHeight).toBe(480);

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	assert(videoDecoderConfig);
	expect(videoDecoderConfig.codec).toMatch(/^avc1\./);
	expect(videoDecoderConfig.codedWidth).toBe(640);
	expect(videoDecoderConfig.codedHeight).toBe(480);
	expect(videoDecoderConfig.description).toBeUndefined(); // Annex B, no description

	// Verify audio track
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.id).toBe(0x101);
	expect(audioTrack.codec).toBe('aac');
	expect(audioTrack.numberOfChannels).toBe(2);
	expect(audioTrack.sampleRate).toBe(48000);

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
	expect(secondVideoPacket.type).toBe('delta');

	for await (const packet of videoSink.packets()) {
		expect(packet.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1])); // Annex B start code
		videoPacketCount++;
	}

	// Check that seeking works
	const middlePacket = await videoSink.getPacket(2.5);
	assert(middlePacket);
	expect(middlePacket.timestamp).toBeCloseTo(2.5);

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
	const audioMiddlePacket = await audioSink.getPacket(2.5);
	assert(audioMiddlePacket);
	expect(audioMiddlePacket.timestamp).toBeCloseTo(2.5);

	expect(audioPacketCount).toBeGreaterThan(0);

	// Verify duration is approximately 5 seconds
	const videoDuration = await videoTrack.computeDuration();
	const audioDuration = await audioTrack.computeDuration();

	expect(videoDuration).toBeCloseTo(5, 1);
	expect(audioDuration).toBeCloseTo(5, 1);
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

	expect(videoTrack.id).toBe(0x100);
	expect(videoTrack.codec).toBe('hevc');

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	assert(videoDecoderConfig);
	expect(videoDecoderConfig.codec).toMatch(/^hev1\./);
	expect(videoDecoderConfig.description).toBeUndefined(); // Annex B, no description

	// Verify audio track
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.id).toBe(0x101);
	expect(audioTrack.codec).toBe('mp3');
	expect(audioTrack.numberOfChannels).toBe(2);
	expect(audioTrack.sampleRate).toBe(24000);

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
		bitrate: QUALITY_HIGH,
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
		bitrate: QUALITY_HIGH,
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
	expect(videoTrack.codec).toBe('avc');

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
	expect(audioTrack.codec).toBe('aac');

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

	expect(videoTracks[0]!.codec).toBe('hevc');
	expect(videoTracks[1]!.codec).toBe('hevc');
	expect(videoTracks[0]!.id).toBe(0x100);
	expect(videoTracks[1]!.id).toBe(0x101);
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

	expect(audioTracks[0]!.codec).toBe('aac');
	expect(audioTracks[1]!.codec).toBe('aac');
	expect(audioTracks[0]!.id).toBe(0x100);
	expect(audioTracks[1]!.id).toBe(0x101);
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
	expect(outputVideoTrack.codec).toBe(inputVideoTrack.codec);
	expect(outputAudioTrack.codec).toBe(inputAudioTrack.codec);

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
		bitrate: QUALITY_HIGH,
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

	expect(chunks.length).toBe(frameCount);

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
	expect(videoTrack.codec).toBe('avc');

	const videoSink = new EncodedPacketSink(videoTrack);
	let videoPacketCount = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const packet of videoSink.packets()) {
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(frameCount);
});
