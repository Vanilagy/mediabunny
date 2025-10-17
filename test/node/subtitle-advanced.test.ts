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
	MkvOutputFormat,
	BufferSource,
	TextSubtitleSource,
} from '../../src/index.js';
import { formatCuesToAss, convertDialogueLineToMkvFormat } from '../../src/subtitles.js';

describe('Advanced ASS Features', () => {
	it('should preserve Comment lines from CodecPrivate', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass-fonts.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		expect(track.codec).toBe('ass');

		const codecPrivate = (track as any)._backing.getCodecPrivate();
		console.log('\n=== CodecPrivate has Comment? ===', codecPrivate?.includes('Comment:'));

		const cues = [];
		for await (const cue of track.getCues()) {
			cues.push(cue);
		}
		console.log('Total cues:', cues.length);
		console.log('First cue text:', cues[0]?.text);

		const assText = await track.exportToText('ass');

		console.log('\n=== Exported has Comment? ===', assText.includes('Comment:'));

		// Should preserve Comment line from CodecPrivate
		expect(assText).toContain('Comment:');
		expect(assText).toContain('This is a comment');
	});

	it('should preserve [Fonts] section from CodecPrivate', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass-fonts.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText('ass');

		// Should have [Fonts] section
		expect(assText).toContain('[Fonts]');
		expect(assText).toContain('fontname: CustomFont');
	});

	it('should preserve [Graphics] section from CodecPrivate', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass-fonts.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText('ass');

		// Should have [Graphics] section
		expect(assText).toContain('[Graphics]');
		expect(assText).toContain('filename: logo.png');
	});

	it('should place Dialogue lines in correct position after Comment', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass-fonts.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText('ass');

		// Verify Event ordering: Format, then Dialogue, then Comment (at end of Events)
		const formatIdx = assText.indexOf('Format:');
		const firstDialogueIdx = assText.indexOf('Dialogue:');
		const commentIdx = assText.indexOf('Comment:');
		const fontsIdx = assText.indexOf('[Fonts]');

		// Proper order: Format < Dialogue < Comment < [Fonts]
		expect(formatIdx).toBeGreaterThan(-1);
		expect(firstDialogueIdx).toBeGreaterThan(formatIdx);
		expect(commentIdx).toBeGreaterThan(firstDialogueIdx); // Comment AFTER Dialogue
		if (fontsIdx > -1) {
			expect(commentIdx).toBeLessThan(fontsIdx); // Comment before [Fonts]
		}
	});

	it('should have proper section ordering', async () => {
		using input = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass-fonts.mkv'),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const assText = await track.exportToText('ass');

		const sections = [];
		const lines = assText.split('\n');

		for (const line of lines) {
			if (line.startsWith('[') && line.endsWith(']')) {
				sections.push(line);
			}
		}

		console.log('Section order:', sections);

		// Expected order: [Script Info], [V4+ Styles], [Events], [Fonts], [Graphics]
		expect(sections[0]).toBe('[Script Info]');
		expect(sections).toContain('[V4+ Styles]');
		expect(sections).toContain('[Events]');
		expect(sections).toContain('[Fonts]');
		expect(sections).toContain('[Graphics]');

		// [Events] should come before [Fonts] and [Graphics]
		const eventsIdx = sections.indexOf('[Events]');
		const fontsIdx = sections.indexOf('[Fonts]');
		const graphicsIdx = sections.indexOf('[Graphics]');

		expect(eventsIdx).toBeLessThan(fontsIdx);
		expect(eventsIdx).toBeLessThan(graphicsIdx);
	});
});

describe('ASS Edge Cases - Parsing and Reconstruction', () => {
	it('should handle text starting with comma in MKV format', async () => {
		// Create ASS subtitle with text that starts with comma
		const assContent = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,,comma-leading text`;

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const subtitleSource = new TextSubtitleSource('ass');
		output.addSubtitleTrack(subtitleSource, { languageCode: 'eng' });

		await output.start();

		await subtitleSource.add(assContent);
		subtitleSource.close();

		await output.finalize();

		// Read back
		const input = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const cues = [];
		for await (const cue of track.getCues()) {
			cues.push(cue);
		}

		expect(cues.length).toBe(1);
		// Should not have double comma at start
		expect(cues[0]!.text).not.toMatch(/^,/);

		const exported = await track.exportToText('ass');
		const dialogueLine = exported.split('\n').find(l => l.startsWith('Dialogue:'));
		expect(dialogueLine).toContain(',comma-leading text');
		// Should not have duplicate field data
		expect(dialogueLine).not.toMatch(/Default,,0,0,0,,.*,Default,,0,0,0,,/);

		input[Symbol.dispose]();
	});

	it('should handle text containing multiple commas', async () => {
		const assContent = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello, world, how, are, you?`;

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const subtitleSource = new TextSubtitleSource('ass');
		output.addSubtitleTrack(subtitleSource, { languageCode: 'eng' });

		await output.start();

		await subtitleSource.add(assContent);
		subtitleSource.close();

		await output.finalize();

		const input = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const exported = await track.exportToText('ass');
		expect(exported).toContain('Hello, world, how, are, you?');

		input[Symbol.dispose]();
	});

	it('should handle MKV format with ReadOrder field (9 fields)', async () => {
		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const subtitleSource = new TextSubtitleSource('ass');
		output.addSubtitleTrack(subtitleSource, { languageCode: 'eng' });

		const assContent = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Test text`;

		await output.start();

		await subtitleSource.add(assContent);
		subtitleSource.close();
		await output.finalize();

		// Verify MKV block contains proper format (without ReadOrder, but could be added by muxer)
		const input = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const track = (await input.subtitleTracks)[0]!;
		const cues = [];
		for await (const cue of track.getCues()) {
			cues.push(cue);
		}

		// MKV block should have format: Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text (8 fields)
		// or: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text (9 fields)
		const parts = cues[0]!.text.split(',');
		expect(parts.length).toBeGreaterThanOrEqual(8);
		expect(parts[parts.length - 1]).toBe('Test text');

		input[Symbol.dispose]();
	});

	it('should handle round-trip ASS -> MKV -> ASS conversion', async () => {
		using input1 = new Input({
			source: new FilePathSource('test/public/subtitles/test-mkv-ass.mkv'),
			formats: ALL_FORMATS,
		});

		const target1 = new BufferTarget();
		const output1 = new Output({
			format: new MkvOutputFormat(),
			target: target1,
		});

		// First conversion: MKV -> MKV (with ASS)
		const conversion1 = await Conversion.init({
			input: input1,
			output: output1,
			subtitle: { codec: 'ass' },
			showWarnings: false,
		});

		await conversion1.execute();

		// Read intermediate result
		const input2 = new Input({
			source: new BufferSource(target1.buffer),
			formats: ALL_FORMATS,
		});

		const target2 = new BufferTarget();
		const output2 = new Output({
			format: new MkvOutputFormat(),
			target: target2,
		});

		// Second conversion: MKV -> MKV (with ASS)
		const conversion2 = await Conversion.init({
			input: input2,
			output: output2,
			subtitle: { codec: 'ass' },
			showWarnings: false,
		});

		await conversion2.execute();

		// Compare outputs
		const input3 = new Input({
			source: new BufferSource(target2.buffer),
			formats: ALL_FORMATS,
		});

		const track1 = (await input2.subtitleTracks)[0]!;
		const track2 = (await input3.subtitleTracks)[0]!;

		const text1 = await track1.exportToText('ass');
		const text2 = await track2.exportToText('ass');

		// Extract just the text content from dialogue lines (ignore timestamp precision differences)
		const extractText = (line: string) => {
			// Extract text after the 9th comma (after Effect field)
			const parts = line.split(',');
			return parts.slice(9).join(',');
		};

		const dialogue1 = text1.split('\n').filter(l => l.startsWith('Dialogue:'));
		const dialogue2 = text2.split('\n').filter(l => l.startsWith('Dialogue:'));

		expect(dialogue1.length).toBe(dialogue2.length);

		// Compare text content (not timestamps due to precision issues)
		for (let i = 0; i < dialogue1.length; i++) {
			const text1Content = extractText(dialogue1[i]!);
			const text2Content = extractText(dialogue2[i]!);
			expect(text2Content).toBe(text1Content);
			// Should not have duplicated field data
			expect(text2Content).not.toMatch(/Default,,0,0,0,,.*Default,,0,0,0,,/);
		}

		input2[Symbol.dispose]();
		input3[Symbol.dispose]();
	});

	it('should handle empty fields in ASS format', async () => {
		const assContent = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Text with empty name and effect`;

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const subtitleSource = new TextSubtitleSource('ass');
		output.addSubtitleTrack(subtitleSource, { languageCode: 'eng' });

		await output.start();

		await subtitleSource.add(assContent);
		subtitleSource.close();
		await output.finalize();

		const input = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const exported = await (await input.subtitleTracks)[0]!.exportToText('ass');
		const dialogueLine = exported.split('\n').find(l => l.startsWith('Dialogue:'));

		// Should preserve empty fields
		expect(dialogueLine).toMatch(/Default,,0,0,0,,Text with empty name and effect/);

		input[Symbol.dispose]();
	});

	it('should handle convertDialogueLineToMkvFormat helper', () => {
		// Test with full Dialogue line
		const fullLine = 'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world';
		const converted = convertDialogueLineToMkvFormat(fullLine);
		expect(converted).toBe('0,Default,,0,0,0,,Hello world');

		// Test with text containing commas
		const commaLine = 'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello, world, test';
		const convertedComma = convertDialogueLineToMkvFormat(commaLine);
		expect(convertedComma).toBe('0,Default,,0,0,0,,Hello, world, test');

		// Test with already MKV format
		const mkvFormat = '0,Default,,0,0,0,,Already MKV format';
		const convertedMkv = convertDialogueLineToMkvFormat(mkvFormat);
		expect(convertedMkv).toBe('0,Default,,0,0,0,,Already MKV format');
	});

	it('should handle formatCuesToAss with different field structures', () => {
		const cues = [
			{
				timestamp: 1.0,
				duration: 2.0,
				text: '0,Default,,0,0,0,,Standard format',
			},
			{
				timestamp: 4.0,
				duration: 2.0,
				text: '0,0,Default,,0,0,0,,ReadOrder format',
			},
		];

		const header = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

		const result = formatCuesToAss(cues, header);
		const dialogueLines = result.split('\n').filter(l => l.startsWith('Dialogue:'));

		expect(dialogueLines.length).toBe(2);
		expect(dialogueLines[0]).toContain('Standard format');
		expect(dialogueLines[1]).toContain('ReadOrder format');

		// Both should have proper timestamps
		expect(dialogueLines[0]).toMatch(/Dialogue: 0,0:00:01\.00,0:00:03\.00/);
		expect(dialogueLines[1]).toMatch(/Dialogue: 0,0:00:04\.00,0:00:06\.00/);

		// Should not have extra field between End and Style
		expect(dialogueLines[0]).toMatch(/Dialogue: 0,0:00:01\.00,0:00:03\.00,Default,,0,0,0,,/);
		expect(dialogueLines[1]).toMatch(/Dialogue: 0,0:00:04\.00,0:00:06\.00,Default,,0,0,0,,/);
		expect(dialogueLines[0]).not.toMatch(/End,\d+,Default/);
		expect(dialogueLines[1]).not.toMatch(/End,\d+,Default/);
	});

	it('should not create extra commas when text is empty', async () => {
		const assContent = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,`;

		const target = new BufferTarget();
		const output = new Output({
			format: new MkvOutputFormat(),
			target,
		});

		const subtitleSource = new TextSubtitleSource('ass');
		output.addSubtitleTrack(subtitleSource, { languageCode: 'eng' });

		await output.start();

		await subtitleSource.add(assContent);
		subtitleSource.close();
		await output.finalize();

		const input = new Input({
			source: new BufferSource(target.buffer),
			formats: ALL_FORMATS,
		});

		const cues = [];
		for await (const cue of (await input.subtitleTracks)[0]!.getCues()) {
			cues.push(cue);
		}

		// Text should be empty, not starting with comma
		expect(cues[0]!.text).not.toMatch(/^,/);

		const exported = await (await input.subtitleTracks)[0]!.exportToText('ass');
		const dialogueLine = exported.split('\n').find(l => l.startsWith('Dialogue:'));

		// Should end with ,, not ,,,
		expect(dialogueLine).toMatch(/,,$/);
		expect(dialogueLine).not.toMatch(/,,,$/);

		input[Symbol.dispose]();
	});
});
