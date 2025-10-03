/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'vitest';
import { Input, FilePathSource, ALL_FORMATS } from '../../src/index.js';

describe('Matroska Subtitle Demuxing', () => {
	it('should detect SRT subtitle track in MKV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks).toHaveLength(1);

		const track = subtitleTracks[0]!;
		expect(track.codec).toBe('srt');
		expect(track.internalCodecId).toBe('S_TEXT/UTF8');
		expect(track.languageCode).toBe('eng');
	});

	it('should detect ASS subtitle track in MKV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('ass');
		expect(track.internalCodecId).toBe('S_TEXT/ASS');
	});

	it('should detect SSA subtitle track in MKV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ssa.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		// FFmpeg converts SSA to ASS (ASS is superset of SSA)
		expect(track.codec).toBe('ass');
		expect(track.internalCodecId).toBe('S_TEXT/ASS');
	});

	it('should detect WebVTT subtitle track in MKV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-vtt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('webvtt');
		// FFmpeg uses D_WEBVTT/SUBTITLES instead of S_TEXT/WEBVTT
		expect(track.internalCodecId).toBe('D_WEBVTT/SUBTITLES');
	});

	it('should read subtitle cues from MKV with SRT', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const cues = [];

		for await (const cue of track.getCues()) {
			cues.push(cue);
		}

		expect(cues.length).toBeGreaterThan(0);
		expect(cues[0]!.text).toContain('Hello world');
		expect(cues[0]!.timestamp).toBeCloseTo(1.0, 1);
		expect(cues[0]!.duration).toBeCloseTo(2.5, 1);
	});

	it('should export SRT subtitle track to text', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const srtText = await track.exportToText();

		// Check for SRT timestamp format (HH:MM:SS,mmm)
		expect(srtText).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
		expect(srtText).toContain('Hello world');
	});

	it('should preserve ASS CodecPrivate header', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText();

		expect(assText).toContain('[Script Info]');
		expect(assText).toContain('[V4+ Styles]');
		expect(assText).toContain('Dialogue:');
	});

	it('should handle multiple subtitle tracks', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-multi.mkv'),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThanOrEqual(2);

		const srtTrack = subtitleTracks.find(t => t.codec === 'srt');
		const assTrack = subtitleTracks.find(t => t.codec === 'ass');

		expect(srtTrack).toBeDefined();
		expect(assTrack).toBeDefined();
		expect(srtTrack?.languageCode).toBe('eng');
		expect(assTrack?.languageCode).toBe('spa');
	});
});
