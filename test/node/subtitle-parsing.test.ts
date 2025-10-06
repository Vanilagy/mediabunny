/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'vitest';
import {
	parseSrtTimestamp,
	formatSrtTimestamp,
	splitSrtIntoCues,
	formatCuesToSrt,
	parseAssTimestamp,
	formatAssTimestamp,
	splitAssIntoCues,
	formatCuesToAss,
	SubtitleCue,
} from '../../src/subtitles.js';

describe('SRT Timestamp Parsing', () => {
	it('should parse SRT timestamp format', () => {
		expect(parseSrtTimestamp('00:00:01,000')).toBe(1.0);
		expect(parseSrtTimestamp('00:00:03,500')).toBe(3.5);
		expect(parseSrtTimestamp('01:23:45,678')).toBe(5025.678);
	});

	it('should format seconds to SRT timestamp', () => {
		expect(formatSrtTimestamp(1.0)).toBe('00:00:01,000');
		expect(formatSrtTimestamp(3.5)).toBe('00:00:03,500');
		expect(formatSrtTimestamp(5025.678)).toBe('01:23:45,678');
	});
});

describe('SRT Splitting', () => {
	it('should split SRT text into cues', () => {
		const srt = `1
00:00:01,000 --> 00:00:03,500
Hello world!

2
00:00:05,000 --> 00:00:07,000
Goodbye!`;

		const cues = splitSrtIntoCues(srt);

		expect(cues).toHaveLength(2);
		expect(cues[0]).toMatchObject({
			timestamp: 1.0,
			duration: 2.5,
			text: 'Hello world!',
		});
		expect(cues[1]).toMatchObject({
			timestamp: 5.0,
			duration: 2.0,
			text: 'Goodbye!',
		});
	});

	it('should handle multi-line subtitle text', () => {
		const srt = `1
00:00:01,000 --> 00:00:03,500
Line 1
Line 2
Line 3

2
00:00:05,000 --> 00:00:07,000
Single line`;

		const cues = splitSrtIntoCues(srt);
		expect(cues[0]!.text).toBe('Line 1\nLine 2\nLine 3');
		expect(cues[1]!.text).toBe('Single line');
	});

	it('should handle SRT with missing sequence numbers', () => {
		const srt = `1
00:00:01,000 --> 00:00:03,500
Text one

3
00:00:05,000 --> 00:00:07,000
Text two`;

		const cues = splitSrtIntoCues(srt);
		expect(cues).toHaveLength(2);
	});
});

describe('SRT Formatting', () => {
	it('should format cues back to SRT', () => {
		const cues: SubtitleCue[] = [
			{ timestamp: 1.0, duration: 2.5, text: 'Hello' },
			{ timestamp: 5.0, duration: 2.0, text: 'Goodbye' },
		];

		const srt = formatCuesToSrt(cues);

		expect(srt).toContain('1\n00:00:01,000 --> 00:00:03,500\nHello');
		expect(srt).toContain('2\n00:00:05,000 --> 00:00:07,000\nGoodbye');
	});

	it('should preserve multi-line text', () => {
		const cues: SubtitleCue[] = [
			{ timestamp: 1.0, duration: 2.5, text: 'Line 1\nLine 2' },
		];

		const srt = formatCuesToSrt(cues);
		expect(srt).toContain('Line 1\nLine 2');
	});
});

describe('ASS Timestamp Parsing', () => {
	it('should parse ASS timestamp format', () => {
		expect(parseAssTimestamp('0:00:01.00')).toBe(1.0);
		expect(parseAssTimestamp('0:00:03.50')).toBe(3.5);
		expect(parseAssTimestamp('1:23:45.67')).toBe(5025.67);
	});

	it('should format seconds to ASS timestamp', () => {
		expect(formatAssTimestamp(1.0)).toBe('0:00:01.00');
		expect(formatAssTimestamp(3.5)).toBe('0:00:03.50');
		expect(formatAssTimestamp(5025.67)).toBe('1:23:45.67');
	});
});

describe('ASS Splitting', () => {
	it('should split ASS into header and cues', () => {
		const ass = `[Script Info]
Title: Test

[V4+ Styles]
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world!
Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Goodbye!`;

		const { header, cues } = splitAssIntoCues(ass);

		expect(header).toContain('[Script Info]');
		expect(header).toContain('[V4+ Styles]');
		expect(header).toContain('[Events]');
		expect(header).toContain('Format:');
		expect(cues).toHaveLength(2);
		expect(cues[0]!.timestamp).toBe(1.0);
		expect(cues[0]!.duration).toBe(2.5);
	});

	it('should preserve full dialogue line in cue text', () => {
		const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\pos(320,240)}Styled text`;

		const { cues } = splitAssIntoCues(ass);
		expect(cues[0]!.text).toContain('Dialogue:');
		expect(cues[0]!.text).toContain('{\\pos(320,240)}Styled text');
	});

	it('should handle SSA format (v4.00)', () => {
		const ssa = `[Script Info]
Title: Test
ScriptType: v4.00

[V4 Styles]
Style: Default,Arial,20

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello`;

		const { header, cues } = splitAssIntoCues(ssa);
		expect(header).toContain('[V4 Styles]');
		expect(cues).toHaveLength(1);
	});
});

describe('ASS Formatting', () => {
	it('should format cues back to ASS with header', () => {
		const header = `[Script Info]
Title: Test

[V4+ Styles]
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

		const cues: SubtitleCue[] = [
			{
				timestamp: 1.0,
				duration: 2.5,
				text: 'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello',
			},
		];

		const ass = formatCuesToAss(cues, header);

		expect(ass).toContain('[Script Info]');
		expect(ass).toContain('[V4+ Styles]');
		expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello');
	});
});
