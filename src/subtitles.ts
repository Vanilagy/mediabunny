/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { SubtitleCodec } from './codec.js';

/**
 * Represents a single subtitle cue with timing and text.
 * @group Media sources
 * @public
 */
export type SubtitleCue = {
	/** When the subtitle should appear, in seconds. */
	timestamp: number;
	/** How long the subtitle should be displayed, in seconds. */
	duration: number;
	/** The subtitle text content. */
	text: string;
	/** Optional cue identifier. */
	identifier?: string;
	/** Optional format-specific settings (e.g., VTT positioning). */
	settings?: string;
	/** Optional notes or comments. */
	notes?: string;
};

/**
 * Subtitle configuration data.
 * @group Media sources
 * @public
 */
export type SubtitleConfig = {
	/** Format-specific description (e.g., WebVTT preamble, ASS/SSA header). */
	description: string;
};

/**
 * Metadata associated with subtitle cues.
 * @group Media sources
 * @public
 */
export type SubtitleMetadata = {
	/** Optional subtitle configuration. */
	config?: SubtitleConfig;
};

type SubtitleParserOptions = {
	codec: SubtitleCodec;
	output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};

const cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;

export class SubtitleParser {
	private options: SubtitleParserOptions;
	private preambleText: string | null = null;
	private preambleEmitted = false;

	constructor(options: SubtitleParserOptions) {
		this.options = options;
	}

	parse(text: string) {
		if (this.options.codec === 'srt') {
			this.parseSrt(text);
		} else if (this.options.codec === 'ass' || this.options.codec === 'ssa') {
			this.parseAss(text);
		} else if (this.options.codec === 'tx3g') {
			this.parseTx3g(text);
		} else if (this.options.codec === 'ttml') {
			this.parseTtml(text);
		} else {
			this.parseWebVTT(text);
		}
	}

	private parseSrt(text: string) {
		const cues = splitSrtIntoCues(text);

		for (let i = 0; i < cues.length; i++) {
			const meta: SubtitleMetadata = {};
			// SRT doesn't have a header, but we need to provide a config for the first cue
			if (i === 0) {
				meta.config = { description: '' };
			}
			this.options.output(cues[i]!, meta);
		}
	}

	private parseAss(text: string) {
		const { header, cues } = splitAssIntoCues(text);

		for (let i = 0; i < cues.length; i++) {
			const meta: SubtitleMetadata = {};
			if (i === 0 && header) {
				meta.config = { description: header };
			}
			this.options.output(cues[i]!, meta);
		}
	}

	private parseWebVTT(text: string) {
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

		cueBlockHeaderRegex.lastIndex = 0;
		let match: RegExpMatchArray | null;

		if (!this.preambleText) {
			if (!preambleStartRegex.test(text)) {
				throw new Error('WebVTT preamble incorrect.');
			}

			match = cueBlockHeaderRegex.exec(text);
			const preamble = text.slice(0, match?.index ?? text.length).trimEnd();

			if (!preamble) {
				throw new Error('No WebVTT preamble provided.');
			}

			this.preambleText = preamble;

			if (match) {
				text = text.slice(match.index);
				cueBlockHeaderRegex.lastIndex = 0;
			}
		}

		while ((match = cueBlockHeaderRegex.exec(text))) {
			const notes = text.slice(0, match.index);
			const cueIdentifier = match[1];
			const matchEnd = match.index! + match[0].length;
			const bodyStart = text.indexOf('\n', matchEnd) + 1;
			const cueSettings = text.slice(matchEnd, bodyStart).trim();
			let bodyEnd = text.indexOf('\n\n', matchEnd);
			if (bodyEnd === -1) bodyEnd = text.length;

			const startTime = parseSubtitleTimestamp(match[2]!);
			const endTime = parseSubtitleTimestamp(match[3]!);
			const duration = endTime - startTime;

			const body = text.slice(bodyStart, bodyEnd).trim();

			text = text.slice(bodyEnd).trimStart();
			cueBlockHeaderRegex.lastIndex = 0;

			const cue: SubtitleCue = {
				timestamp: startTime / 1000,
				duration: duration / 1000,
				text: body,
				identifier: cueIdentifier,
				settings: cueSettings,
				notes,
			};

			const meta: SubtitleMetadata = {};
			if (!this.preambleEmitted) {
				meta.config = {
					description: this.preambleText,
				};
				this.preambleEmitted = true;
			}

			this.options.output(cue, meta);
		}
	}

	private parseTx3g(text: string) {
		// tx3g (3GPP Timed Text) samples are usually already plain text
		// For now, treat as plain text cue - timing comes from container
		const meta: SubtitleMetadata = { config: { description: '' } };
		const cue: SubtitleCue = {
			timestamp: 0,
			duration: 0,
			text: text.trim(),
		};
		this.options.output(cue, meta);
	}

	private parseTtml(text: string) {
		// Basic TTML parsing - extract text content from <p> elements
		// TODO: Full TTML/IMSC parser with styling support
		const pRegex = /<p[^>]*>(.*?)<\/p>/gs;
		const matches = [...text.matchAll(pRegex)];

		for (let i = 0; i < matches.length; i++) {
			const match = matches[i]!;
			const content = match[1]?.replace(/<[^>]+>/g, '') || ''; // Strip inner tags

			const meta: SubtitleMetadata = {};
			if (i === 0) {
				meta.config = { description: '' };
			}

			const cue: SubtitleCue = {
				timestamp: 0,
				duration: 0,
				text: content.trim(),
			};

			this.options.output(cue, meta);
		}
	}
}

const timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;

/**
 * Parses a WebVTT timestamp string to milliseconds.
 * @group Media sources
 * @internal
 */
export const parseSubtitleTimestamp = (string: string) => {
	const match = timestampRegex.exec(string);
	if (!match) throw new Error('Expected match.');

	return 60 * 60 * 1000 * Number(match[1] || '0')
		+ 60 * 1000 * Number(match[2])
		+ 1000 * Number(match[3])
		+ Number(match[4]);
};

/**
 * Formats milliseconds to WebVTT timestamp format.
 * @group Media sources
 * @internal
 */
export const formatSubtitleTimestamp = (timestamp: number) => {
	const hours = Math.floor(timestamp / (60 * 60 * 1000));
	const minutes = Math.floor((timestamp % (60 * 60 * 1000)) / (60 * 1000));
	const seconds = Math.floor((timestamp % (60 * 1000)) / 1000);
	const milliseconds = timestamp % 1000;

	return hours.toString().padStart(2, '0') + ':'
		+ minutes.toString().padStart(2, '0') + ':'
		+ seconds.toString().padStart(2, '0') + '.'
		+ milliseconds.toString().padStart(3, '0');
};

// SRT parsing functions
const srtTimestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/;

/**
 * Parses an SRT timestamp string (HH:MM:SS,mmm) to seconds.
 * @group Media sources
 * @public
 */
export const parseSrtTimestamp = (timeString: string): number => {
	const match = srtTimestampRegex.exec(timeString);
	if (!match) throw new Error('Invalid SRT timestamp format');

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const milliseconds = Number(match[4]);

	return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
};

/**
 * Formats seconds to SRT timestamp format (HH:MM:SS,mmm).
 * @group Media sources
 * @public
 */
export const formatSrtTimestamp = (seconds: number): string => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);
	const milliseconds = Math.round((seconds % 1) * 1000);

	return hours.toString().padStart(2, '0') + ':'
		+ minutes.toString().padStart(2, '0') + ':'
		+ secs.toString().padStart(2, '0') + ','
		+ milliseconds.toString().padStart(3, '0');
};

/**
 * Splits SRT subtitle text into individual cues.
 * @group Media sources
 * @public
 */
export const splitSrtIntoCues = (text: string): SubtitleCue[] => {
	text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

	const cues: SubtitleCue[] = [];
	const cueRegex = /(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]*?)(?=\n\n\d+\n|\n*$)/g;

	let match: RegExpExecArray | null;
	while ((match = cueRegex.exec(text))) {
		const startTime = parseSrtTimestamp(match[2]!);
		const endTime = parseSrtTimestamp(match[3]!);
		const cueText = match[4]!.trim();

		cues.push({
			timestamp: startTime,
			duration: endTime - startTime,
			text: cueText,
			identifier: match[1],
		});
	}

	return cues;
};

/**
 * Extracts plain text from ASS/SSA Dialogue/Comment line.
 * If the text is already plain (not ASS format), returns as-is.
 */
const extractTextFromAssCue = (text: string): string => {
	// Check if this is an ASS Dialogue/Comment line
	if (text.startsWith('Dialogue:') || text.startsWith('Comment:')) {
		// ASS format: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
		// We need to extract the last field (Text) which may contain commas
		const colonIndex = text.indexOf(':');
		if (colonIndex === -1) return text;

		const afterColon = text.substring(colonIndex + 1);
		const parts = afterColon.split(',');

		// Text is the 10th field (index 9), but it may contain commas
		// So we need to join everything from index 9 onward
		if (parts.length >= 10) {
			return parts.slice(9).join(',');
		}
	}

	// Check if this is MKV ASS format (without Dialogue: prefix)
	// MKV format: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
	// OR: Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
	const parts = text.split(',');
	if (parts.length >= 8) {
		const firstPart = parts[0]?.trim();
		const secondPart = parts[1]?.trim();

		// Check if first field is numeric (Layer or ReadOrder)
		if (firstPart && !isNaN(parseInt(firstPart))) {
			// Check if second field is also numeric (ReadOrder,Layer format)
			if (secondPart && !isNaN(parseInt(secondPart)) && parts.length >= 9) {
				// MKV format with ReadOrder: text is 9th field (index 8) onward
				return parts.slice(8).join(',');
			} else if (parts.length >= 8) {
				// Standard ASS format without ReadOrder: text is 8th field (index 7) onward
				return parts.slice(7).join(',');
			}
		}
	}

	// Not ASS format, return as-is
	return text;
};

/**
 * Formats subtitle cues back to SRT text format.
 * @group Media sources
 * @public
 */
export const formatCuesToSrt = (cues: SubtitleCue[]): string => {
	return cues.map((cue, index) => {
		const sequenceNumber = index + 1;
		const startTime = formatSrtTimestamp(cue.timestamp);
		const endTime = formatSrtTimestamp(cue.timestamp + cue.duration);
		const text = extractTextFromAssCue(cue.text);

		return `${sequenceNumber}\n${startTime} --> ${endTime}\n${text}\n`;
	}).join('\n');
};

/**
 * Formats subtitle cues back to WebVTT text format.
 * @group Media sources
 * @public
 */
export const formatCuesToWebVTT = (cues: SubtitleCue[], preamble?: string): string => {
	// Start with the WebVTT header
	let result = preamble || 'WEBVTT\n';

	// Ensure there's a blank line after the header
	if (!result.endsWith('\n\n')) {
		result += '\n';
	}

	// Format each cue
	const formattedCues = cues.map((cue) => {
		const startTime = formatSubtitleTimestamp(cue.timestamp * 1000); // Convert to milliseconds
		const endTime = formatSubtitleTimestamp((cue.timestamp + cue.duration) * 1000);
		const text = extractTextFromAssCue(cue.text);

		// WebVTT doesn't require sequence numbers like SRT
		return `${startTime} --> ${endTime}\n${text}`;
	});

	return result + formattedCues.join('\n\n');
};

// ASS/SSA parsing functions
const assTimestampRegex = /(\d+):(\d{2}):(\d{2})\.(\d{2})/;

/**
 * Parses an ASS/SSA timestamp string (H:MM:SS.cc) to seconds.
 * @group Media sources
 * @public
 */
export const parseAssTimestamp = (timeString: string): number => {
	const match = assTimestampRegex.exec(timeString);
	if (!match) throw new Error('Invalid ASS timestamp format');

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const centiseconds = Number(match[4]);

	return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
};

/**
 * Formats seconds to ASS/SSA timestamp format (H:MM:SS.cc).
 * @group Media sources
 * @public
 */
export const formatAssTimestamp = (seconds: number): string => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);
	const centiseconds = Math.floor((seconds % 1) * 100);

	return hours.toString() + ':'
		+ minutes.toString().padStart(2, '0') + ':'
		+ secs.toString().padStart(2, '0') + '.'
		+ centiseconds.toString().padStart(2, '0');
};

/**
 * Splits ASS/SSA subtitle text into header (styles) and individual cues.
 * Preserves all sections including [Fonts], [Graphics], and Aegisub sections.
 * Aegisub sections are moved to the end to avoid breaking [Events].
 * @group Media sources
 * @public
 */
export const splitAssIntoCues = (text: string): { header: string; cues: SubtitleCue[] } => {
	text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

	const lines = text.split('\n');

	// Find [Events] section
	const eventsIndex = lines.findIndex(line => line.trim() === '[Events]');
	if (eventsIndex === -1) {
		return { header: text, cues: [] };
	}

	// Separate sections for proper ordering
	const headerSections: string[] = []; // [Script Info], [V4+ Styles], etc. (before Events)
	const eventsHeader: string[] = []; // [Events] and Format: line
	const eventLines: string[] = []; // Dialogue/Comment lines
	const postEventsSections: string[] = []; // [Fonts], [Graphics], [Aegisub...] (after Events)

	let currentSection: string[] = headerSections;
	let inEventsSection = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Section header
		if (line && line.startsWith('[') && line.endsWith(']')) {
			const trimmedLine = line.trim();

			if (trimmedLine === '[Events]') {
				inEventsSection = true;
				eventsHeader.push(line);
				continue;
			}

			// Any section after [Events] goes to post-events
			if (inEventsSection) {
				currentSection = postEventsSections;
				inEventsSection = false;
			}

			currentSection.push(line);
			continue;
		}

		if (inEventsSection) {
			if (!line) {
				continue; // Skip empty lines in Events
			}

			if (line.startsWith('Format:')) {
				eventsHeader.push(line);
			} else if (line.startsWith('Dialogue:')) {
				// Dialogue lines go to eventLines (will be reconstructed with timestamps from blocks)
				eventLines.push(line);
			} else if (line.startsWith('Comment:')) {
				// Comment lines stay in header (they're metadata, not in MKV blocks)
				eventsHeader.push(line);
			}
		} else {
			if (line !== undefined) {
				currentSection.push(line);
			}
		}
	}

	// Build header: everything except Dialogue lines (keep Comments)
	// Format: [Header Sections] + [Events] + Format + Comments + [Post-Events Sections]
	const header = [
		...headerSections,
		...eventsHeader, // Includes [Events], Format:, and Comment: lines
		...postEventsSections,
	].join('\n');

	// Parse Comment and Dialogue lines
	const cues: SubtitleCue[] = [];

	for (const line of eventLines) {
		// Parse ASS dialogue/comment format
		// Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;

		const parts = line.substring(colonIndex + 1).split(',');
		if (parts.length < 10) continue;

		try {
			const startTime = parseAssTimestamp(parts[1]!.trim());
			const endTime = parseAssTimestamp(parts[2]!.trim());

			cues.push({
				timestamp: startTime,
				duration: endTime - startTime,
				text: line, // Store the entire line (Dialogue: or Comment:)
			});
		} catch {
			// Skip malformed lines
			continue;
		}
	}

	return { header, cues };
};

/**
 * Parses ASS Format line to get field order.
 * Returns map of field name to index.
 */
const parseAssFormat = (formatLine: string): Map<string, number> => {
	// Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
	const fields = formatLine
		.substring(formatLine.indexOf(':') + 1)
		.split(',')
		.map(f => f.trim());

	const fieldMap = new Map<string, number>();
	fields.forEach((field, index) => {
		fieldMap.set(field, index);
	});

	return fieldMap;
};

/**
 * Converts a full Dialogue/Comment line to MKV block format.
 * @group Media sources
 * @internal
 */
export const convertDialogueLineToMkvFormat = (line: string): string => {
	const match = /^(Dialogue|Comment):\s*(\d+),\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},(.*)$/.exec(line);
	if (match) {
		const layer = match[2];
		const restFields = match[3];
		return `${layer},${restFields}`;
	}

	if (line.startsWith('Dialogue:') || line.startsWith('Comment:')) {
		return line.substring(line.indexOf(':') + 1).trim();
	}

	return line;
};

/**
 * Formats subtitle cues back to ASS/SSA text format with header.
 * Properly inserts Dialogue/Comment lines within [Events] section.
 * @group Media sources
 * @public
 */
export const formatCuesToAss = (cues: SubtitleCue[], header: string): string => {
	// If header is empty or missing, create a default ASS header
	if (!header || header.trim() === '') {
		header = `[Script Info]
Title: Default
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
	}

	// Find [Events] section and its Format line
	const headerLines = header.split('\n');
	const eventsIndex = headerLines.findIndex(line => line.trim() === '[Events]');

	if (eventsIndex === -1) {
		// No [Events] section, create one
		return header + `\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(c => c.text).join('\n');
	}

	// Find Format line AFTER [Events]
	let formatIndex = -1;
	let formatLine = '';
	for (let i = eventsIndex + 1; i < headerLines.length; i++) {
		const line = headerLines[i];
		if (line && line.trim().startsWith('Format:')) {
			formatIndex = i;
			formatLine = line;
			break;
		}
		// Stop if we hit another section
		if (line && line.startsWith('[') && line.endsWith(']')) {
			break;
		}
	}

	// Parse format to understand field order
	const fieldMap = formatLine ? parseAssFormat(formatLine) : null;

	// Reconstruct dialogue lines with proper field order
	const dialogueLines = cues.map(cue => {
		// If text already has full Dialogue/Comment line with timestamps, use as-is
		if (cue.text.startsWith('Dialogue:') || cue.text.startsWith('Comment:')) {
			if (/^(Dialogue|Comment):\s*\d+,\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},/.test(cue.text)) {
				return cue.text;
			}
		}

		// Parse MKV block data or plain text
		let params = cue.text;
		const isComment = params.startsWith('Comment:');
		const prefix = isComment ? 'Comment:' : 'Dialogue:';

		if (params.startsWith('Dialogue:') || params.startsWith('Comment:')) {
			params = params.substring(params.indexOf(':') + 1).trim();
		}

		const parts = params.split(',');
		const startTime = formatAssTimestamp(cue.timestamp);
		const endTime = formatAssTimestamp(cue.timestamp + cue.duration);

		let layer: string;
		let restFields: string[];

		// Detect ReadOrder format from actual block data first
		// MKV blocks: ReadOrder,Layer,Style,... (9+ fields, first two numeric) OR Layer,Style,... (8+ fields, first numeric)
		const blockHasReadOrder = parts.length >= 9 && !isNaN(parseInt(parts[0]!)) && !isNaN(parseInt(parts[1]!));
		const blockHasLayer = parts.length >= 8 && !isNaN(parseInt(parts[0]!));

		if (blockHasReadOrder) {
			layer = parts[1] || '0';
			restFields = parts.slice(2);
		} else if (blockHasLayer) {
			layer = parts[0] || '0';
			restFields = parts.slice(1);
		} else {
			return `${prefix} 0,${startTime},${endTime},Default,,0,0,0,,${cue.text}`;
		}

		return `${prefix} ${layer},${startTime},${endTime},${restFields.join(',')}`;
	});

	if (formatIndex === -1) {
		// No Format line found, just append
		return header + '\n' + dialogueLines.join('\n');
	}

	// Find Comment lines and next section after [Events]
	const commentLines: string[] = [];
	let nextSectionIndex = headerLines.length;

	for (let i = formatIndex + 1; i < headerLines.length; i++) {
		const line = headerLines[i];
		if (line && line.startsWith('Comment:')) {
			commentLines.push(line);
		}
		if (line && line.startsWith('[') && line.endsWith(']')) {
			nextSectionIndex = i;
			break;
		}
	}

	// Build final structure:
	// 1. Everything up to and including Format line
	// 2. All Dialogue lines
	// 3. All Comment lines (at the end of Events)
	// 4. Everything after Events section
	const beforeDialogues = headerLines.slice(0, formatIndex + 1);
	const afterDialogues = headerLines.slice(nextSectionIndex);

	return [
		...beforeDialogues,
		...dialogueLines,
		...commentLines,
		...afterDialogues,
	].join('\n');
};
