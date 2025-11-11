/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, beforeAll } from 'vitest';
import { Input, Output } from '../../src/index.js';
import { BufferSource, BufferTarget } from '../../src/index.js';
import { ALL_FORMATS, AVI, AviOutputFormat } from '../../src/index.js';
import { EncodedVideoPacketSource, EncodedAudioPacketSource } from '../../src/index.js';
import { EncodedPacket } from '../../src/index.js';
import { registerMpeg4Decoder, registerMpeg4Encoder } from '../../packages/mpeg4/src/index.js';

beforeAll(() => {
	registerMpeg4Decoder();
	registerMpeg4Encoder();
});

test('Should be able to detect AVI format', async () => {
	const buffer = new ArrayBuffer(12);
	const view = new DataView(buffer);

	view.setUint8(0, 0x52);
	view.setUint8(1, 0x49);
	view.setUint8(2, 0x46);
	view.setUint8(3, 0x46);
	view.setUint32(4, 4, true);
	view.setUint8(8, 0x41);
	view.setUint8(9, 0x56);
	view.setUint8(10, 0x49);
	view.setUint8(11, 0x20);

	using input = new Input({
		source: new BufferSource(new Uint8Array(buffer)),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(AVI);
});

test('Should be able to create AVI output with video track', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new AviOutputFormat(),
	});

	const videoPacket = new EncodedPacket(
		new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67]),
		'key',
		0,
		0.033,
		0
	);

	const videoSource = new EncodedVideoPacketSource('avc');
	await output.addVideoTrack(videoSource);
	await output.start();

	await videoSource.add(videoPacket, {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 640,
			codedHeight: 480,
		},
	});

	await output.finalize();

	const result = target.buffer ? new Uint8Array(target.buffer) : new Uint8Array();
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.length).toBeGreaterThan(0);

	const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
	expect(resultView.getUint8(0)).toBe(0x52);
	expect(resultView.getUint8(1)).toBe(0x49);
	expect(resultView.getUint8(2)).toBe(0x46);
	expect(resultView.getUint8(3)).toBe(0x46);

	expect(resultView.getUint8(8)).toBe(0x41);
	expect(resultView.getUint8(9)).toBe(0x56);
	expect(resultView.getUint8(10)).toBe(0x49);
	expect(resultView.getUint8(11)).toBe(0x20);
});

test('Should be able to create AVI output with audio track', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new AviOutputFormat(),
	});

	const audioPacket = new EncodedPacket(
		new Uint8Array([0xFF, 0xFB, 0x90, 0x00]),
		'key',
		0,
		0.026,
		0
	);

	const audioSource = new EncodedAudioPacketSource('mp3');
	await output.addAudioTrack(audioSource);
	await output.start();

	await audioSource.add(audioPacket, {
		decoderConfig: {
			codec: 'mp3',
			sampleRate: 44100,
			numberOfChannels: 2,
		},
	});

	await output.finalize();

	const result = target.buffer ? new Uint8Array(target.buffer) : new Uint8Array();
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.length).toBeGreaterThan(0);

	const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
	const riff = String.fromCharCode(
		resultView.getUint8(0),
		resultView.getUint8(1),
		resultView.getUint8(2),
		resultView.getUint8(3)
	);
	expect(riff).toBe('RIFF');
	const aviType = String.fromCharCode(
		resultView.getUint8(8),
		resultView.getUint8(9),
		resultView.getUint8(10),
		resultView.getUint8(11)
	);
	expect(aviType).toBe('AVI ')
});

test('Should properly handle AVI codec mappings', async () => {
	const format = new AviOutputFormat();

	const supportedVideoCodecs = format.getSupportedVideoCodecs();
	expect(supportedVideoCodecs).toContain('avc');
	expect(supportedVideoCodecs).toContain('hevc');
	expect(supportedVideoCodecs).toContain('vp8');
	expect(supportedVideoCodecs).toContain('vp9');
	expect(supportedVideoCodecs).toContain('av1');
	expect(supportedVideoCodecs).toContain('mpeg4');

	const supportedAudioCodecs = format.getSupportedAudioCodecs();
	expect(supportedAudioCodecs).toContain('mp3');
	expect(supportedAudioCodecs).toContain('aac');
	expect(supportedAudioCodecs).toContain('vorbis');
	expect(supportedAudioCodecs).toContain('flac');
	expect(supportedAudioCodecs).toContain('pcm-s16');
	expect(supportedAudioCodecs).toContain('pcm-f32');
	expect(supportedAudioCodecs).toContain('ulaw');
	expect(supportedAudioCodecs).toContain('alaw');

	expect(format.fileExtension).toBe('.avi');
	expect(format.mimeType).toBe('video/x-msvideo');
});

test('Should be able to create AVI with both video and audio', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new AviOutputFormat(),
	});

	const videoPackets = [];
	for (let i = 0; i < 3; i++) {
		videoPackets.push(new EncodedPacket(
			new Uint8Array([0x00, 0x00, 0x00, 0x01, i === 0 ? 0x67 : 0x41]),
			i === 0 ? 'key' : 'delta',
			i * 0.033,
			0.033,
			i
		));
	}

	const audioPackets = [];
	for (let i = 0; i < 4; i++) {
		audioPackets.push(new EncodedPacket(
			new Uint8Array([0xFF, 0xFB, 0x90, 0x00]),
			'key',
			i * 0.026,
			0.026,
			i
		));
	}

	const videoSource = new EncodedVideoPacketSource('avc');
	const audioSource = new EncodedAudioPacketSource('mp3');

	await output.addVideoTrack(videoSource);
	await output.addAudioTrack(audioSource);
	await output.start();

	for (let i = 0; i < videoPackets.length; i++) {
		await videoSource.add(videoPackets[i]!, i === 0 ? {
			decoderConfig: {
				codec: 'avc1.640028',
				codedWidth: 640,
				codedHeight: 480,
			},
		} : undefined);
	}

	for (let i = 0; i < audioPackets.length; i++) {
		await audioSource.add(audioPackets[i]!, i === 0 ? {
			decoderConfig: {
				codec: 'mp3',
				sampleRate: 44100,
				numberOfChannels: 2,
			},
		} : undefined);
	}

	await output.finalize();

	const result = target.buffer ? new Uint8Array(target.buffer) : new Uint8Array();
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.length).toBeGreaterThan(100);

	const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
	expect(resultView.getUint8(0)).toBe(0x52);
	expect(resultView.getUint8(1)).toBe(0x49);
	expect(resultView.getUint8(2)).toBe(0x46);
	expect(resultView.getUint8(3)).toBe(0x46);
	expect(resultView.getUint8(8)).toBe(0x41);
	expect(resultView.getUint8(9)).toBe(0x56);
	expect(resultView.getUint8(10)).toBe(0x49);
	expect(resultView.getUint8(11)).toBe(0x20);
});

test('Should read AVI files with various video codecs', async () => {
	const testFiles = [
		{ file: 'avc-aac.avi', expectedVideoCodec: 'avc', expectedAudioCodec: 'aac' },
		{ file: 'hevc-aac.avi', expectedVideoCodec: 'hevc', expectedAudioCodec: 'aac' },
		{ file: 'vp8-mp3.avi', expectedVideoCodec: 'vp8', expectedAudioCodec: 'mp3' },
		{ file: 'vp9-vorbis.avi', expectedVideoCodec: 'vp9', expectedAudioCodec: 'vorbis' },
		{ file: 'av1-aac.avi', expectedVideoCodec: 'av1', expectedAudioCodec: 'aac' },
		{ file: 'mpeg4-mp3.avi', expectedVideoCodec: 'mpeg4', expectedAudioCodec: 'mp3' },
	];

	for (const { file, expectedVideoCodec, expectedAudioCodec } of testFiles) {
		const { FilePathSource } = await import('../../src/index.js');
		using input = new Input({
			source: new FilePathSource(`test/public/avi/${file}`),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(AVI);

		const videoTracks = await input.getVideoTracks();
		const audioTracks = await input.getAudioTracks();

		if (videoTracks.length === 0 && audioTracks.length === 0) {
			throw new Error(`No tracks found in ${file}. This indicates the AVI demuxer is not parsing streams correctly.`);
		}

		expect(videoTracks.length).toBeGreaterThan(0);
		expect(videoTracks[0]!.codec).toBe(expectedVideoCodec);

		expect(audioTracks.length).toBeGreaterThan(0);
		expect(audioTracks[0]!.codec).toBe(expectedAudioCodec);
	}
});

test('Should read audio-only AVI files', async () => {
	const testFiles = [
		{ file: 'aac-only.avi', expectedCodec: 'aac' },
		{ file: 'mp3-only.avi', expectedCodec: 'mp3' },
		{ file: 'vorbis-only.avi', expectedCodec: 'vorbis' },
		{ file: 'flac-only.avi', expectedCodec: 'flac' },
		{ file: 'pcm-s16.avi', expectedCodec: 'pcm-s16' },
		{ file: 'pcm-f32.avi', expectedCodec: 'pcm-f32' },
		{ file: 'ulaw.avi', expectedCodec: 'ulaw' },
		{ file: 'alaw.avi', expectedCodec: 'alaw' },
	];

	for (const { file, expectedCodec } of testFiles) {
		const { FilePathSource } = await import('../../src/index.js');
		using input = new Input({
			source: new FilePathSource(`test/public/avi/${file}`),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(AVI);

		const videoTracks = await input.getVideoTracks();
		expect(videoTracks.length).toBe(0);

		const audioTracks = await input.getAudioTracks();
		expect(audioTracks.length).toBeGreaterThan(0);
		expect(audioTracks[0]!.codec).toBe(expectedCodec);
	}
});