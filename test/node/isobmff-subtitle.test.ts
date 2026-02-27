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

	it('should detect tx3g subtitle track in MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-tx3g.mp4'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);

		const track = subtitleTracks[0]!;
		expect(track.codec).toBe('tx3g');
		expect(track.languageCode).toBe('eng');
	});

	it('should detect tx3g subtitle track in MOV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mov-tx3g.mov'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);

		const track = subtitleTracks[0]!;
		expect(track.codec).toBe('tx3g');
		// MOV file may have undefined language
		expect(['eng', 'und']).toContain(track.languageCode);
	});

	it('should export tx3g subtitle track to SRT format', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-tx3g.mp4'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('tx3g');

		const subtitleText = await track.exportToText();

		// Check that it's SRT format
		expect(subtitleText).toMatch(/\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
		expect(subtitleText).toContain('Hello world!');
	});

	it('should read tx3g cues from MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-tx3g.mp4'),
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

	it('should detect TTML subtitle track in MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-ttml.mp4'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);

		const track = subtitleTracks[0]!;
		expect(track.codec).toBe('ttml');
		expect(track.languageCode).toBe('eng');
	});

	it('should detect TTML subtitle track in MOV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mov-ttml.mov'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);

		const track = subtitleTracks[0]!;
		expect(track.codec).toBe('ttml');
		expect(track.languageCode).toBe('eng');
	});

	it('should export TTML subtitle track to TTML format', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-ttml.mp4'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('ttml');

		const subtitleText = await track.exportToText();

		// Check that it's TTML format
		expect(subtitleText).toMatch(/<tt[^>]*xmlns="http:\/\/www\.w3\.org\/ns\/ttml"/);
		expect(subtitleText).toContain('Hello world!');
	});

	it('should read TTML cues from MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-ttml.mp4'),
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
