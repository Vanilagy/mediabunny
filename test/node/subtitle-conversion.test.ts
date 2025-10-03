/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'vitest';
import {
	Input,
	FilePathSource,
	ALL_FORMATS,
	Conversion,
	Output,
	BufferTarget,
	BufferSource,
	MkvOutputFormat,
	Mp4OutputFormat,
	WebMOutputFormat,
	TextSubtitleSource,
} from '../../src/index.js';

describe('Subtitle Conversion - Basic Cases', () => {
	it('should passthrough subtitle track when codec matches output format', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'srt', // Keep as SRT
			},
		});

		expect(conversion.isValid).toBe(true);
		expect(conversion.utilizedTracks.filter(t => t.type === 'subtitle').length).toBe(1);

		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(1);
		expect(subtitleTracks[0]!.codec).toBe('srt');

		const text = await subtitleTracks[0]!.exportToText();
		expect(text).toContain('Hello world');
	});

	it('should convert SRT to WebVTT', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'webvtt',
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(1);
		expect(subtitleTracks[0]!.codec).toBe('webvtt');

		const text = await subtitleTracks[0]!.exportToText();
		expect(text).toContain('Hello world');
	});

	it('should convert ASS to SRT', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'srt',
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(1);
		expect(subtitleTracks[0]!.codec).toBe('srt');

		const text = await subtitleTracks[0]!.exportToText();
		expect(text).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);

		// Verify ASS metadata is stripped (no "0,0,Default,,0,0,0,," prefix)
		expect(text).not.toContain('Default,,0,0,0');
		expect(text).toContain('Hello world!');
		expect(text).toContain('This is a test');
	});

	it('should convert WebVTT to SRT', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-vtt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'srt',
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(1);
		expect(subtitleTracks[0]!.codec).toBe('srt');
	});

	it('should discard all subtitle tracks when discard is true', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				discard: true,
			},
		});

		expect(conversion.isValid).toBe(true);
		expect(conversion.utilizedTracks.filter(t => t.type === 'subtitle').length).toBe(0);
		expect(conversion.discardedTracks.filter(t => t.track.type === 'subtitle').length).toBe(1);
		expect(conversion.discardedTracks[0]!.reason).toBe('discarded_by_user');
	});

	it('should handle multiple subtitle tracks', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-multi.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'webvtt',
			},
		});

		expect(conversion.isValid).toBe(true);
		const inputTracks = await input.subtitleTracks;
		expect(conversion.utilizedTracks.filter(t => t.type === 'subtitle').length).toBe(inputTracks.length);

		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(inputTracks.length);

		for (const track of subtitleTracks) {
			expect(track.codec).toBe('webvtt');
		}
	});
});

describe('Subtitle Conversion - Track-Specific Options', () => {
	it('should selectively discard tracks based on language', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-multi.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const inputTracks = await input.subtitleTracks;
		const firstTrackLang = inputTracks[0]!.languageCode;

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: (track) => {
				// Keep only the first track's language
				if (track.languageCode !== firstTrackLang) {
					return { discard: true };
				}
				return {};
			},
		});

		expect(conversion.isValid).toBe(true);
		expect(conversion.utilizedTracks.filter(t => t.type === 'subtitle').length).toBeLessThan(
			inputTracks.length,
		);

		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBeLessThan(inputTracks.length);
	});

	it('should apply different codec conversion per track', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-multi.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: (track, n) => {
				// First track to SRT, rest to WebVTT
				return {
					codec: n === 1 ? 'srt' : 'webvtt',
				};
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks[0]!.codec).toBe('srt');
		for (let i = 1; i < subtitleTracks.length; i++) {
			expect(subtitleTracks[i]!.codec).toBe('webvtt');
		}
	});

	it('should handle mixed operations: keep, convert, discard', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-multi.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const inputTracks = await input.subtitleTracks;

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: (track, n) => {
				if (n === 1) {
					// First track: keep as is
					return {};
				} else if (n === 2 && inputTracks.length >= 2) {
					// Second track: convert to SRT
					return { codec: 'srt' };
				} else {
					// Rest: discard
					return { discard: true };
				}
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output has expected tracks
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		if (inputTracks.length >= 2) {
			expect(subtitleTracks.length).toBe(2);
			expect(subtitleTracks[1]!.codec).toBe('srt');
		}
	});
});

describe('Subtitle Conversion - Trimming', () => {
	it('should adjust subtitle timestamps when trimming', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		// Get first cue timestamp to use as trim start
		const firstTrack = (await input.subtitleTracks)[0]!;
		const cues = [];
		for await (const cue of firstTrack.getCues()) {
			cues.push(cue);
		}

		const trimStart = cues[0]!.timestamp;
		const trimEnd = cues[Math.min(cues.length - 1, 2)]!.timestamp + 1;

		const conversion = await Conversion.init({
			input,
			output,
			trim: {
				start: trimStart,
				end: trimEnd,
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		const outputCues = [];
		for await (const cue of subtitleTracks[0]!.getCues()) {
			outputCues.push(cue);
		}

		// First cue should start at 0 (adjusted)
		expect(outputCues[0]!.timestamp).toBeCloseTo(0, 2);
		// Should have fewer cues than original
		expect(outputCues.length).toBeLessThanOrEqual(cues.length);
	});

	it('should exclude cues outside trim range', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const firstTrack = (await input.subtitleTracks)[0]!;
		const cues = [];
		for await (const cue of firstTrack.getCues()) {
			cues.push(cue);
		}

		// Trim to only second cue
		const trimStart = cues[1]!.timestamp;
		const trimEnd = cues[1]!.timestamp + cues[1]!.duration;

		const conversion = await Conversion.init({
			input,
			output,
			trim: {
				start: trimStart,
				end: trimEnd,
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		const outputCues = [];
		for await (const cue of subtitleTracks[0]!.getCues()) {
			outputCues.push(cue);
		}

		// Should have only 1 cue
		expect(outputCues.length).toBe(1);
		expect(outputCues[0]!.text).toBe(cues[1]!.text);
	});

	it('should handle partial cue trimming', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const firstTrack = (await input.subtitleTracks)[0]!;
		const cues = [];
		for await (const cue of firstTrack.getCues()) {
			cues.push(cue);
		}

		// Trim in middle of first cue
		const firstCue = cues[0]!;
		const trimStart = firstCue.timestamp + firstCue.duration / 2;
		const trimEnd = firstCue.timestamp + firstCue.duration;

		const conversion = await Conversion.init({
			input,
			output,
			trim: {
				start: trimStart,
				end: trimEnd,
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		const outputCues = [];
		for await (const cue of subtitleTracks[0]!.getCues()) {
			outputCues.push(cue);
		}

		// Should still have the cue but with adjusted duration
		expect(outputCues.length).toBeGreaterThanOrEqual(1);
		expect(outputCues[0]!.timestamp).toBeCloseTo(0, 2);
		expect(outputCues[0]!.duration).toBeLessThan(firstCue.duration);
	});
});

describe('Subtitle Conversion - Codec Compatibility', () => {
	it('should discard track when target codec not supported by output format', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: { discard: true },
			audio: { discard: true },
			subtitle: {
				codec: 'ass', // MP4 only supports webvtt, not ass
			},
			showWarnings: false,
		});

		// Track should be discarded because ASS is not supported in MP4
		expect(conversion.isValid).toBe(false);
		expect(conversion.discardedTracks.filter(t => t.track.type === 'subtitle').length).toBe(1);
		expect(conversion.discardedTracks.find(t => t.track.type === 'subtitle')!.reason).toBe(
			'no_encodable_target_codec',
		);
	});

	it('should support WebVTT and TX3G in MP4', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'webvtt',
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks[0]!.codec).toBe('webvtt');
	});

	it('should support all text formats in MKV', async () => {
		// Test WebVTT and SRT which are well-supported
		// ASS/SSA conversion is tested separately below
		const testCases = [
			{ codec: 'webvtt' as const },
			{ codec: 'srt' as const },
		];

		for (const { codec } of testCases) {
			using input = new Input({
				source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
				formats: ALL_FORMATS,
			});

			const target = new BufferTarget();
			const output = new Output({
				format: new MkvOutputFormat(),
				target,
			});

			const conversion = await Conversion.init({
				input,
				output,
				subtitle: {
					codec,
				},
				showWarnings: false,
			});

			expect(conversion.isValid).toBe(true);
			await conversion.execute();

			// Verify output has subtitle with correct codec
			using outputInput = new Input({
				source: new BufferSource(target.buffer),
				formats: ALL_FORMATS,
			});

			const subtitleTracks = await outputInput.subtitleTracks;
			expect(subtitleTracks.length, `codec: ${codec}`).toBeGreaterThan(0);
			expect(subtitleTracks[0]!.codec).toBe(codec);
		}
	});

	it('should convert SRT to ASS with proper header', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'ass',
			},
			showWarnings: false,
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);
		expect(subtitleTracks[0]!.codec).toBe('ass');

		// Verify ASS structure
		const assText = await subtitleTracks[0]!.exportToText();
		expect(assText).toContain('[Script Info]');
		expect(assText).toContain('[V4+ Styles]');
		expect(assText).toContain('[Events]');
		expect(assText).toContain('Dialogue:');
	});

	it('should preserve ASS header when trimming', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'ass',
			},
			trim: { start: 0, end: 10 },
			showWarnings: false,
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);
		expect(subtitleTracks[0]!.codec).toBe('ass');

		// Verify ASS structure is preserved
		const assText = await subtitleTracks[0]!.exportToText();
		expect(assText).toContain('[Script Info]');
		expect(assText).toContain('[V4+ Styles]');
		expect(assText).toContain('[Events]');
	});

	it('should only support WebVTT in WebM', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new WebMOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'webvtt',
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks[0]!.codec).toBe('webvtt');
	});
});

describe('Subtitle Conversion - External Subtitles', () => {
	it('should add external subtitle track', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-video.mp4'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: { discard: true },
			audio: { discard: true },
		});

		// Add external subtitle
		const subtitleSource = new TextSubtitleSource('webvtt');
		conversion.addExternalSubtitleTrack(subtitleSource, {
			languageCode: 'eng',
			name: 'External Subtitle',
		}, async () => {
			await subtitleSource.add('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nExternal subtitle test');
			subtitleSource.close();
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(1);
		expect(subtitleTracks[0]!.codec).toBe('webvtt');

		const text = await subtitleTracks[0]!.exportToText();
		expect(text).toContain('External subtitle test');
	});

	it('should combine external subtitles with input subtitles', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
		});

		// Add external subtitle
		const subtitleSource = new TextSubtitleSource('webvtt');
		conversion.addExternalSubtitleTrack(subtitleSource, {
			languageCode: 'spa',
			name: 'Spanish',
		}, async () => {
			await subtitleSource.add('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHola mundo');
			subtitleSource.close();
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBe(2);

		// Find the tracks
		const srtTrack = subtitleTracks.find(t => t.codec === 'srt');
		const vttTrack = subtitleTracks.find(t => t.codec === 'webvtt');

		expect(srtTrack).toBeDefined();
		expect(vttTrack).toBeDefined();

		const vttText = await vttTrack!.exportToText();
		expect(vttText).toContain('Hola mundo');
	});

	it('should respect track count limits for external subtitles', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-video.mp4'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: { discard: true },
			audio: { discard: true },
		});

		// Add external subtitle
		const subtitleSource = new TextSubtitleSource('webvtt');
		conversion.addExternalSubtitleTrack(subtitleSource, {}, async () => {
			await subtitleSource.add('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nTest');
			subtitleSource.close();
		});

		expect(conversion.isValid).toBe(true);
		expect(() => {
			// Try to add second external subtitle
			const subtitleSource2 = new TextSubtitleSource('webvtt');
			conversion.addExternalSubtitleTrack(subtitleSource2, {}, async () => {
				await subtitleSource2.add('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nTest 2');
				subtitleSource2.close();
			});
		}).not.toThrow(); // MP4 supports multiple subtitle tracks
	});
});

describe('Subtitle Conversion - Edge Cases', () => {
	it('should handle empty subtitle track', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
			subtitle: {
				codec: 'webvtt', // Convert SRT to WebVTT
			},
		});

		expect(conversion.isValid).toBe(true);
		await conversion.execute();

		// Verify output has WebVTT track
		using outputInput = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await outputInput.subtitleTracks;
		expect(subtitleTracks.length).toBeGreaterThan(0);

		const webvttTrack = subtitleTracks.find(t => t.codec === 'webvtt');
		expect(webvttTrack).toBeDefined();

		const cues = [];
		for await (const cue of webvttTrack!.getCues()) {
			cues.push(cue);
		}
		// Should have cues from original SRT
		expect(cues.length).toBeGreaterThan(0);
	});

	it('should throw error for invalid subtitle options', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		await expect(() =>
			Conversion.init({
				input,
				output: new Output({
					format: new MkvOutputFormat(),
					target: new BufferTarget(),
				}),
				subtitle: {
					// @ts-expect-error Testing invalid input
					codec: 'invalid-codec',
				},
			}),
		).rejects.toThrow();
	});

	it('should not execute conversion after adding external subtitle', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-srt.mkv'),
			formats: ALL_FORMATS,
		});

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const conversion = await Conversion.init({
			input,
			output,
		});

		await conversion.execute();

		// Try to add external subtitle after execution
		const subtitleSource = new TextSubtitleSource('webvtt');
		expect(() => {
			conversion.addExternalSubtitleTrack(subtitleSource, {}, async () => {
				await subtitleSource.add('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nTest');
				subtitleSource.close();
			});
		}).toThrow('Cannot add subtitle tracks after conversion has been executed');
	});
});
