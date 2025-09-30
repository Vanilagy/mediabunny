/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'vitest';
import { Input, FilePathSource, ALL_FORMATS } from '../../src/index.js';

describe('ISOBMFF Subtitle Demuxing', () => {
	it('should detect WebVTT subtitle track in MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-webvtt.mp4'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);

		const track = subtitleTracks[0]!;
		expect(track.codec).toBe('webvtt');
		expect(track.languageCode).toBe('eng');
	});

	it('should export WebVTT subtitle track to WebVTT format', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-webvtt.mp4'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('webvtt');

		const subtitleText = await track.exportToText();

		// Check that it's WebVTT format
		expect(subtitleText).toMatch(/^WEBVTT/);
		expect(subtitleText).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
		expect(subtitleText).toContain('Hello world!');
	});

	it('should read WebVTT cues from MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-webvtt.mp4'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const cues = [];

		for await (const cue of track.getCues()) {
			cues.push(cue);
		}

		expect(cues.length).toBeGreaterThan(0);
		expect(cues[0]!).toHaveProperty('timestamp');
		expect(cues[0]!).toHaveProperty('duration');
		expect(cues[0]!).toHaveProperty('text');
	});

});
