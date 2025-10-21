import { expect, test, beforeAll } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS, MP4, QTFF, MATROSKA, AVI } from '../../src/input-format.js';
import { registerMpeg4Decoder, registerMpeg4Encoder } from '../../packages/mpeg4/src/index.js';

beforeAll(() => {
	registerMpeg4Decoder();
	registerMpeg4Encoder();
});

test('Can read MP4 with mpeg4 video codec', async () => {
	using input = new Input({
		source: new UrlSource('/mp4/mpeg4-aac.mp4'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks.length).toBeGreaterThan(0);
	expect(videoTracks[0]!.codec).toBe('mpeg4');

	const audioTracks = await input.getAudioTracks();
	expect(audioTracks.length).toBeGreaterThan(0);
	expect(audioTracks[0]!.codec).toBe('aac');
});

test('Can read MOV with mpeg4 video codec', async () => {
	using input = new Input({
		source: new UrlSource('/mov/mpeg4-aac.mov'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(QTFF);

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks.length).toBeGreaterThan(0);
	expect(videoTracks[0]!.codec).toBe('mpeg4');
});

test('Can read MKV with mpeg4 video codec', async () => {
	using input = new Input({
		source: new UrlSource('/mkv/mpeg4-aac.mkv'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MATROSKA);

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks.length).toBeGreaterThan(0);
	expect(videoTracks[0]!.codec).toBe('mpeg4');
});

test('Can read AVI with mpeg4 video codec', async () => {
	using input = new Input({
		source: new UrlSource('/avi/mpeg4-mp3.avi'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(AVI);

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks.length).toBeGreaterThan(0);
	expect(videoTracks[0]!.codec).toBe('mpeg4');

	const audioTracks = await input.getAudioTracks();
	expect(audioTracks[0]!.codec).toBe('mp3');
});

test('Can read AVI with various video codecs', async () => {
	const testFiles = [
		{ file: '/avi/avc-aac.avi', videoCodec: 'avc', audioCodec: 'aac' },
		{ file: '/avi/hevc-aac.avi', videoCodec: 'hevc', audioCodec: 'aac' },
		{ file: '/avi/vp8-mp3.avi', videoCodec: 'vp8', audioCodec: 'mp3' },
		{ file: '/avi/vp9-vorbis.avi', videoCodec: 'vp9', audioCodec: 'vorbis' },
		{ file: '/avi/av1-aac.avi', videoCodec: 'av1', audioCodec: 'aac' },
	];

	for (const { file, videoCodec, audioCodec } of testFiles) {
		using input = new Input({
			source: new UrlSource(file),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(AVI);

		const videoTracks = await input.getVideoTracks();
		expect(videoTracks.length).toBeGreaterThan(0);
		expect(videoTracks[0]!.codec).toBe(videoCodec);

		const audioTracks = await input.getAudioTracks();
		expect(audioTracks.length).toBeGreaterThan(0);
		expect(audioTracks[0]!.codec).toBe(audioCodec);
	}
});