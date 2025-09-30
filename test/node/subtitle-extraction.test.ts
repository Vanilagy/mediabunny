/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'vitest';
import { Input, FilePathSource, ALL_FORMATS } from '../../src/index.js';
import { readFile } from 'fs/promises';

describe('Subtitle Extraction', () => {
	it('should extract SRT subtitles from MKV and download as text', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('srt');

		// Export to SRT format
		const srtText = await track.exportToText('srt');

		// Should have proper SRT format
		expect(srtText).toMatch(/\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
		expect(srtText).toContain('Hello world');
		expect(srtText).toContain('This is a test');

		// Should have sequence numbers
		expect(srtText).toMatch(/^1\n/m);
		expect(srtText).toMatch(/\n2\n/);
	});

	it('should extract ASS subtitles from MKV and preserve header', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('ass');

		// Export to ASS format
		const assText = await track.exportToText('ass');

		// Should have all ASS sections
		expect(assText).toContain('[Script Info]');
		expect(assText).toContain('[V4+ Styles]');
		expect(assText).toContain('[Events]');
		expect(assText).toContain('Format:');

		// Should have dialogue lines
		expect(assText).toMatch(/Dialogue:/);

		// Should have actual subtitle content
		expect(assText).toContain('Hello world');
	});

	it('should extract WebVTT subtitles from MKV', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-vtt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('webvtt');

		// Export to SRT (WebVTT export needs more work, so use SRT)
		const srtText = await track.exportToText('srt');

		expect(srtText).toBeTruthy();
		expect(srtText.length).toBeGreaterThan(0);
	});

	it('should extract WebVTT subtitles from MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mp4-webvtt.mp4'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;

		// Export to text
		const text = await track.exportToText();

		expect(text).toBeTruthy();
		expect(text.length).toBeGreaterThan(0);
	});

	it('should iterate through all subtitle cues', async () => {
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

		// Verify cue structure
		for (const cue of cues) {
			expect(cue).toHaveProperty('timestamp');
			expect(cue).toHaveProperty('duration');
			expect(cue).toHaveProperty('text');
			expect(typeof cue.timestamp).toBe('number');
			expect(typeof cue.duration).toBe('number');
			expect(typeof cue.text).toBe('string');
		}
	});

	it('should handle multiple subtitle tracks', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-multi.mkv'),
			formats: ALL_FORMATS,
		});

		const tracks = await input.subtitleTracks;
		expect(tracks.length).toBeGreaterThanOrEqual(2);

		// Extract all tracks
		const exportedTexts = await Promise.all(
			tracks.map(track => track.exportToText()),
		);

		for (const text of exportedTexts) {
			expect(text).toBeTruthy();
			expect(text.length).toBeGreaterThan(0);
		}
	});
});

describe('Subtitle Format Conversion', () => {
	it('should convert SRT to SRT (identity)', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const srtText = await track.exportToText('srt');

		// Should be valid SRT
		expect(srtText).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
		expect(srtText).toContain('Hello world');
	});

	it('should convert ASS to ASS (identity)', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText('ass');

		// Should preserve ASS structure
		expect(assText).toContain('[Script Info]');
		expect(assText).toContain('[V4+ Styles]');
		expect(assText).toContain('[Events]');
		expect(assText).toContain('Dialogue:');
	});

	it('should convert ASS to SRT (extract dialogue text)', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const srtText = await track.exportToText('srt');

		// Should have SRT format
		expect(srtText).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
		expect(srtText.length).toBeGreaterThan(0);
	});
});

describe('Subtitle Export Validation', () => {
	it('should export SRT with correct sequence numbers', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const srtText = await track.exportToText('srt');

		const lines = srtText.split('\n');
		const numbers = lines.filter(line => /^\d+$/.test(line));

		// Should have sequential numbers starting from 1
		expect(numbers[0]).toBe('1');
		if (numbers.length > 1) {
			expect(numbers[1]).toBe('2');
		}
	});

	it('should export ASS with Dialogue lines in [Events] section', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText('ass');

		// Find [Events] section
		const eventsIndex = assText.indexOf('[Events]');
		expect(eventsIndex).toBeGreaterThan(-1);

		// Find Format line after [Events]
		const afterEventsHeader = assText.substring(eventsIndex);
		const formatMatch = afterEventsHeader.match(/Format:\s*Layer,\s*Start,\s*End/);
		expect(formatMatch).toBeTruthy();

		const formatIndex = eventsIndex + formatMatch!.index!;
		const afterFormat = assText.substring(formatIndex);

		// Find first Dialogue/Comment after Format
		const dialogueMatch = afterFormat.match(/^(Dialogue|Comment):/m);
		expect(dialogueMatch).toBeTruthy();

		// Extract Events section (from [Events] to next section or end)
		const nextSectionMatch = afterEventsHeader.match(/\n\[([^\]]+)\]/);
		const eventsSection = nextSectionMatch
			? assText.substring(eventsIndex, eventsIndex + nextSectionMatch.index!)
			: assText.substring(eventsIndex);

		// Verify structure
		expect(eventsSection).toContain('Format: Layer, Start, End');
		expect(eventsSection).toMatch(/Dialogue:|Comment:/);

		// Verify Dialogue lines have timestamps
		const dialogueLines = eventsSection.match(/Dialogue:\s*\d+,\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},/g);
		expect(dialogueLines).toBeTruthy();
		expect(dialogueLines!.length).toBeGreaterThan(0);
	});

	it('should preserve Comment lines in ASS export', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;

		// Check if original has comments
		const originalAss = await readFile('test/public/subtitles/test.ass', 'utf-8');
		const hasComments = originalAss.includes('Comment:');

		if (hasComments) {
			const assText = await track.exportToText('ass');
			expect(assText).toContain('Comment:');
		}
	});
});
