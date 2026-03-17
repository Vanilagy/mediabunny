/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { SubtitleCodec } from './codec';

export type SubtitleCue = {
	timestamp: number; // in seconds
	duration: number; // in seconds
	text: string;
	identifier?: string;
	settings?: string;
	notes?: string;
};

export type SubtitleConfig = {
	description: string;
};

export type SubtitleMetadata = {
	config?: SubtitleConfig;
};

export interface SubtitleFormat {
	readonly codec: SubtitleCodec;
	parse(text: string): SubtitleCue[];
	format(cues: SubtitleCue[], config?: string): string;
	parseTimestamp(timeString: string): number;
	formatTimestamp(seconds: number): string;
}

// ---------------------------------------------------------------------------
// WebVTT
// ---------------------------------------------------------------------------

const cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;

const webvttTimestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;

export class WebVttFormat implements SubtitleFormat {
	readonly codec: SubtitleCodec = 'webvtt';

	parseTimestamp(timeString: string): number {
		const match = webvttTimestampRegex.exec(timeString);
		if (!match) throw new Error('Expected match.');

		return 60 * 60 * 1000 * Number(match[1] || '0')
			+ 60 * 1000 * Number(match[2])
			+ 1000 * Number(match[3])
			+ Number(match[4]);
	}

	formatTimestamp(milliseconds: number): string {
		const hours = Math.floor(milliseconds / (60 * 60 * 1000));
		const minutes = Math.floor((milliseconds % (60 * 60 * 1000)) / (60 * 1000));
		const seconds = Math.floor((milliseconds % (60 * 1000)) / 1000);
		const ms = milliseconds % 1000;

		return hours.toString().padStart(2, '0') + ':'
			+ minutes.toString().padStart(2, '0') + ':'
			+ seconds.toString().padStart(2, '0') + '.'
			+ ms.toString().padStart(3, '0');
	}

	parse(text: string): SubtitleCue[] {
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

		const cues: SubtitleCue[] = [];
		cueBlockHeaderRegex.lastIndex = 0;

		let preamble: string | null = null;
		if (preambleStartRegex.test(text)) {
			const firstMatch = cueBlockHeaderRegex.exec(text);
			preamble = text.slice(0, firstMatch?.index ?? text.length).trimEnd();
			if (firstMatch) {
				text = text.slice(firstMatch.index);
				cueBlockHeaderRegex.lastIndex = 0;
			} else {
				return cues;
			}
		}

		let match: RegExpMatchArray | null;
		let isFirst = true;
		while ((match = cueBlockHeaderRegex.exec(text))) {
			const notes = text.slice(0, match.index);
			const cueIdentifier = match[1];
			const matchEnd = match.index! + match[0].length;
			const bodyStart = text.indexOf('\n', matchEnd) + 1;
			const cueSettings = text.slice(matchEnd, bodyStart).trim();
			let bodyEnd = text.indexOf('\n\n', matchEnd);
			if (bodyEnd === -1) bodyEnd = text.length;

			const startTime = this.parseTimestamp(match[2]!);
			const endTime = this.parseTimestamp(match[3]!);

			const body = text.slice(bodyStart, bodyEnd).trim();

			text = text.slice(bodyEnd).trimStart();
			cueBlockHeaderRegex.lastIndex = 0;

			const cue: SubtitleCue = {
				timestamp: startTime / 1000,
				duration: (endTime - startTime) / 1000,
				text: body,
				identifier: cueIdentifier,
				settings: cueSettings,
				notes: isFirst ? (notes || undefined) : notes || undefined,
			};

			isFirst = false;
			cues.push(cue);
		}

		if (preamble && cues.length > 0) {
			cues[0]!.notes = preamble;
		}

		return cues;
	}

	format(cues: SubtitleCue[], preamble?: string): string {
		let result = preamble || 'WEBVTT\n';

		if (!result.endsWith('\n\n')) {
			result += '\n';
		}

		const body = cues.map((cue) => {
			const startTime = this.formatTimestamp(cue.timestamp * 1000);
			const endTime = this.formatTimestamp((cue.timestamp + cue.duration) * 1000);

			return `${startTime} --> ${endTime}\n${extractTextFromAssCue(cue.text)}`;
		}).join('\n\n');

		return result + body;
	}
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

const srtTimestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/;

export class SrtFormat implements SubtitleFormat {
	readonly codec: SubtitleCodec = 'srt';

	parseTimestamp(timeString: string): number {
		const match = srtTimestampRegex.exec(timeString);
		if (!match) throw new Error('Invalid SRT timestamp format');

		return Number(match[1]) * 3600
			+ Number(match[2]) * 60
			+ Number(match[3])
			+ Number(match[4]) / 1000;
	}

	formatTimestamp(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = Math.floor(seconds % 60);
		const milliseconds = Math.round((seconds % 1) * 1000);

		return hours.toString().padStart(2, '0') + ':'
			+ minutes.toString().padStart(2, '0') + ':'
			+ secs.toString().padStart(2, '0') + ','
			+ milliseconds.toString().padStart(3, '0');
	}

	parse(text: string): SubtitleCue[] {
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

		const cues: SubtitleCue[] = [];
		const cueRegex
			= /(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]*?)(?=\n\n\d+\n|\n*$)/g;

		let match: RegExpExecArray | null;
		while ((match = cueRegex.exec(text))) {
			const startTime = this.parseTimestamp(match[2]!);
			const endTime = this.parseTimestamp(match[3]!);

			cues.push({
				timestamp: startTime,
				duration: endTime - startTime,
				text: match[4]!.trim(),
				identifier: match[1]!,
			});
		}

		return cues;
	}

	format(cues: SubtitleCue[]): string {
		return cues.map((cue, index) => {
			const startTime = this.formatTimestamp(cue.timestamp);
			const endTime = this.formatTimestamp(cue.timestamp + cue.duration);
			const text = extractTextFromAssCue(cue.text);

			return `${index + 1}\n${startTime} --> ${endTime}\n${text}\n`;
		}).join('\n');
	}
}

// ---------------------------------------------------------------------------
// ASS / SSA
// ---------------------------------------------------------------------------

const assTimestampRegex = /(\d+):(\d{2}):(\d{2})\.(\d{2})/;

export class AssFormat implements SubtitleFormat {
	readonly codec: SubtitleCodec = 'ass';

	parseTimestamp(timeString: string): number {
		const match = assTimestampRegex.exec(timeString);
		if (!match) throw new Error('Invalid ASS timestamp format');

		return Number(match[1]) * 3600
			+ Number(match[2]) * 60
			+ Number(match[3])
			+ Number(match[4]) / 100;
	}

	formatTimestamp(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = Math.floor(seconds % 60);
		const centiseconds = Math.floor((seconds % 1) * 100);

		return hours.toString() + ':'
			+ minutes.toString().padStart(2, '0') + ':'
			+ secs.toString().padStart(2, '0') + '.'
			+ centiseconds.toString().padStart(2, '0');
	}

	parse(text: string): SubtitleCue[] {
		return splitAssIntoCues(text).cues;
	}

	parseWithHeader(text: string): { header: string; cues: SubtitleCue[] } {
		return splitAssIntoCues(text);
	}

	format(cues: SubtitleCue[], header?: string): string {
		return formatCuesToAss(cues, header || '');
	}
}

// ---------------------------------------------------------------------------
// Format registry
// ---------------------------------------------------------------------------

const WEB_VTT = /* #__PURE__ */ new WebVttFormat();
const SRT = /* #__PURE__ */ new SrtFormat();
const ASS = /* #__PURE__ */ new AssFormat();

export const getSubtitleFormat = (codec: SubtitleCodec): SubtitleFormat => {
	switch (codec) {
		case 'srt': return SRT;
		case 'ass':
		case 'ssa': return ASS;
		case 'webvtt':
		case 'tx3g':
		case 'ttml':
		default: return WEB_VTT;
	}
};

// ---------------------------------------------------------------------------
// SubtitleParser (backward compatible wrapper)
// ---------------------------------------------------------------------------

type SubtitleParserOptions = {
	codec: SubtitleCodec;
	output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};

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
		const cues = SRT.parse(text);
		for (let i = 0; i < cues.length; i++) {
			const metadata: SubtitleMetadata = {};
			if (i === 0) metadata.config = { description: '' };
			this.options.output(cues[i]!, metadata);
		}
	}

	private parseAss(text: string) {
		const { header, cues } = splitAssIntoCues(text);
		for (let i = 0; i < cues.length; i++) {
			const metadata: SubtitleMetadata = {};
			if (i === 0) metadata.config = { description: header };
			this.options.output(cues[i]!, metadata);
		}
	}

	private parseTx3g(text: string) {
		const meta: SubtitleMetadata = { config: { description: '' } };
		const cue: SubtitleCue = { timestamp: 0, duration: 0, text: text.trim() };
		this.options.output(cue, meta);
	}

	private parseTtml(text: string) {
		const pRegex = /<p[^>]*>(.*?)<\/p>/gs;
		const matches = [...text.matchAll(pRegex)];

		for (let i = 0; i < matches.length; i++) {
			const content = matches[i]![1]?.replace(/<[^>]+>/g, '') || '';
			const meta: SubtitleMetadata = {};
			if (i === 0) meta.config = { description: '' };
			this.options.output(
				{ timestamp: 0, duration: 0, text: content.trim() },
				meta,
			);
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

			const startTime = WEB_VTT.parseTimestamp(match[2]!);
			const endTime = WEB_VTT.parseTimestamp(match[3]!);
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
				meta.config = { description: this.preambleText };
				this.preambleEmitted = true;
			}

			this.options.output(cue, meta);
		}
	}
}

// ---------------------------------------------------------------------------
// Utility functions (backward compatible exports)
// ---------------------------------------------------------------------------

export const parseSubtitleTimestamp = (string: string) => WEB_VTT.parseTimestamp(string);
export const formatSubtitleTimestamp = (timestamp: number) => WEB_VTT.formatTimestamp(timestamp);
export const parseSrtTimestamp = (timeString: string) => SRT.parseTimestamp(timeString);
export const formatSrtTimestamp = (seconds: number) => SRT.formatTimestamp(seconds);
export const parseAssTimestamp = (timeString: string) => ASS.parseTimestamp(timeString);
export const formatAssTimestamp = (seconds: number) => ASS.formatTimestamp(seconds);
export const splitSrtIntoCues = (text: string) => SRT.parse(text);
export const formatCuesToSrt = (cues: SubtitleCue[]) => SRT.format(cues);
export const formatCuesToWebVTT = (cues: SubtitleCue[], preamble?: string) => WEB_VTT.format(cues, preamble);

export const extractTextFromAssCue = (text: string): string => {
	if (text.startsWith('Dialogue:') || text.startsWith('Comment:')) {
		const afterColon = text.substring(text.indexOf(':') + 1);
		const parts = afterColon.split(',');

		if (parts.length >= 10) {
			return parts.slice(9).join(',');
		}
	}

	const parts = text.split(',');
	if (parts.length >= 8) {
		const firstPart = parts[0]?.trim();
		const secondPart = parts[1]?.trim();

		if (firstPart && !isNaN(parseInt(firstPart))) {
			if (secondPart && !isNaN(parseInt(secondPart)) && parts.length >= 9) {
				return parts.slice(8).join(',');
			}

			return parts.slice(7).join(',');
		}
	}

	return text;
};

export const splitAssIntoCues = (text: string): { header: string; cues: SubtitleCue[] } => {
	text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

	const lines = text.split('\n');
	const eventsIndex = lines.findIndex(line => line.trim() === '[Events]');
	if (eventsIndex === -1) {
		return { header: text, cues: [] };
	}

	const headerSections: string[] = [];
	const eventsHeader: string[] = [];
	const dialogueLines: string[] = [];
	const postEventsSections: string[] = [];

	let currentSection = headerSections;
	let inEventsSection = false;

	for (const line of lines) {
		if (line.startsWith('[') && line.endsWith(']')) {
			if (line.trim() === '[Events]') {
				inEventsSection = true;
				eventsHeader.push(line);
				continue;
			}

			if (inEventsSection) {
				currentSection = postEventsSections;
				inEventsSection = false;
			}

			currentSection.push(line);
			continue;
		}

		if (inEventsSection) {
			if (!line) continue;

			if (line.startsWith('Format:') || line.startsWith('Comment:')) {
				eventsHeader.push(line);
			} else if (line.startsWith('Dialogue:')) {
				dialogueLines.push(line);
			}
		} else {
			currentSection.push(line);
		}
	}

	const header = [
		...headerSections,
		...eventsHeader,
		...postEventsSections,
	].join('\n');

	const cues: SubtitleCue[] = [];
	for (const line of dialogueLines) {
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;

		const parts = line.substring(colonIndex + 1).split(',');
		if (parts.length < 10) continue;

		try {
			const startTime = ASS.parseTimestamp(parts[1]!.trim());
			const endTime = ASS.parseTimestamp(parts[2]!.trim());

			cues.push({
				timestamp: startTime,
				duration: endTime - startTime,
				text: line,
			});
		} catch {
			continue;
		}
	}

	return { header, cues };
};

export const convertDialogueLineToMkvFormat = (line: string): string => {
	const match = /^(Dialogue|Comment):\s*(\d+),\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},(.*)$/.exec(line);
	if (match) {
		return `${match[2]},${match[3]}`;
	}

	if (line.startsWith('Dialogue:') || line.startsWith('Comment:')) {
		return line.substring(line.indexOf(':') + 1).trim();
	}

	return line;
};

export const formatCuesToAss = (cues: SubtitleCue[], header: string): string => {
	if (!header.trim()) {
		header = [
			'[Script Info]',
			'Title: Default',
			'ScriptType: v4.00+',
			'',
			'[V4+ Styles]',
			'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, '
			+ 'BackColour, Bold, Italic, '
			+ 'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, '
			+ 'MarginL, MarginR, MarginV, Encoding',
			'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,'
			+ '10,1',
			'',
			'[Events]',
			'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
		].join('\n');
	}

	const headerLines = header.split('\n');
	const eventsIndex = headerLines.findIndex(line => line.trim() === '[Events]');
	if (eventsIndex === -1) {
		return header
			+ '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
			+ cues.map(c => c.text).join('\n');
	}

	let formatIndex = -1;
	for (let i = eventsIndex + 1; i < headerLines.length; i++) {
		const line = headerLines[i]!;
		if (line.trim().startsWith('Format:')) {
			formatIndex = i;
			break;
		}
		if (line.startsWith('[') && line.endsWith(']')) {
			break;
		}
	}

	const dialogueLines = cues.map((cue) => {
		if (cue.text.startsWith('Dialogue:') || cue.text.startsWith('Comment:')) {
			if (/^(Dialogue|Comment):\s*\d+,\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},/.test(cue.text)) {
				return cue.text;
			}
		}

		let params = cue.text;
		const isComment = params.startsWith('Comment:');
		const prefix = isComment ? 'Comment:' : 'Dialogue:';

		if (params.startsWith('Dialogue:') || params.startsWith('Comment:')) {
			params = params.substring(params.indexOf(':') + 1).trim();
		}

		const parts = params.split(',');
		const startTime = ASS.formatTimestamp(cue.timestamp);
		const endTime = ASS.formatTimestamp(cue.timestamp + cue.duration);

		const blockHasReadOrder = parts.length >= 9 && !isNaN(parseInt(parts[0]!)) && !isNaN(parseInt(parts[1]!));
		const blockHasLayer = parts.length >= 8 && !isNaN(parseInt(parts[0]!));

		if (blockHasReadOrder) {
			return `${prefix} ${parts[1]},${startTime},${endTime},${parts.slice(2).join(',')}`;
		}

		if (blockHasLayer) {
			return `${prefix} ${parts[0]},${startTime},${endTime},${parts.slice(1).join(',')}`;
		}

		return `${prefix} 0,${startTime},${endTime},Default,,0,0,0,,${cue.text}`;
	});

	if (formatIndex === -1) {
		return header + '\n' + dialogueLines.join('\n');
	}

	const commentLines: string[] = [];
	let nextSectionIndex = headerLines.length;
	for (let i = formatIndex + 1; i < headerLines.length; i++) {
		const line = headerLines[i]!;
		if (line.startsWith('Comment:')) {
			commentLines.push(line);
		}
		if (line.startsWith('[') && line.endsWith(']')) {
			nextSectionIndex = i;
			break;
		}
	}

	return [
		...headerLines.slice(0, formatIndex + 1),
		...dialogueLines,
		...commentLines,
		...headerLines.slice(nextSectionIndex),
	].join('\n');
};
