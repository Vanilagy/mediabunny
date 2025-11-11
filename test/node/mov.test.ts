/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, beforeAll } from 'vitest';
import { Input, ALL_FORMATS, QTFF, MovOutputFormat } from '../../src/index.js';
import { registerMpeg4Decoder, registerMpeg4Encoder } from '../../packages/mpeg4/src/index.js';
import { registerEac3Decoder, registerEac3Encoder } from '../../packages/eac3/src/index.js';

beforeAll(() => {
	registerMpeg4Decoder();
	registerMpeg4Encoder();
	registerEac3Decoder();
	registerEac3Encoder();
});

test('Should properly handle MOV codec mappings', async () => {
	const format = new MovOutputFormat();

	const supportedVideoCodecs = format.getSupportedVideoCodecs();
	expect(supportedVideoCodecs).toContain('avc');
	expect(supportedVideoCodecs).toContain('hevc');
	expect(supportedVideoCodecs).toContain('vp8');
	expect(supportedVideoCodecs).toContain('vp9');
	expect(supportedVideoCodecs).toContain('av1');
	expect(supportedVideoCodecs).toContain('mpeg4');

	const supportedAudioCodecs = format.getSupportedAudioCodecs();
	expect(supportedAudioCodecs).toContain('aac');
	expect(supportedAudioCodecs).toContain('opus');
	expect(supportedAudioCodecs).toContain('mp3');
	expect(supportedAudioCodecs).toContain('vorbis');
	expect(supportedAudioCodecs).toContain('flac');
	expect(supportedAudioCodecs).toContain('eac3');
	expect(supportedAudioCodecs).toContain('ac3');

	expect(format.fileExtension).toBe('.mov');
	expect(format.mimeType).toBe('video/quicktime');
});

test('Should read MOV files with mpeg4 and ac3/eac3 codecs', async () => {
	const testFiles = [
		{ file: 'mpeg4-aac.mov', expectedVideoCodec: 'mpeg4', expectedAudioCodec: 'aac' },
		{ file: 'avc-eac3.mov', expectedVideoCodec: 'avc', expectedAudioCodec: 'eac3' },
		{ file: 'avc-ac3.mov', expectedVideoCodec: 'avc', expectedAudioCodec: 'ac3' },
	];

	for (const { file, expectedVideoCodec, expectedAudioCodec } of testFiles) {
		const { FilePathSource } = await import('../../src/index.js');
		using input = new Input({
			source: new FilePathSource(`test/public/mov/${file}`),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(QTFF);

		const videoTracks = await input.getVideoTracks();
		const audioTracks = await input.getAudioTracks();

		if (videoTracks.length === 0 && audioTracks.length === 0) {
			throw new Error(`No tracks found in ${file}`);
		}

		expect(videoTracks.length).toBeGreaterThan(0);
		expect(videoTracks[0]!.codec).toBe(expectedVideoCodec);

		expect(audioTracks.length).toBeGreaterThan(0);
		expect(audioTracks[0]!.codec).toBe(expectedAudioCodec);
	}
});