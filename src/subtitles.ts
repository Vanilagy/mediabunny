/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

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

type SubtitleParserOptions = {
	codec: 'webvtt' | 'ass';
	output: (cue: SubtitleCue, metadata: SubtitleMetadata) => unknown;
};

// ASS/SSA timestamp "H:MM:SS.cc" (centiseconds) -> milliseconds.
const parseAssTimestamp = (s: string): number => {
	const m = /(\d+):(\d{2}):(\d{2})\.(\d{2})/.exec(s.trim());
	if (!m) return 0;
	return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]) * 10;
};

const cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
const preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
export const inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;

export class SubtitleParser {
	private options: SubtitleParserOptions;
	private preambleText: string | null = null;
	private preambleEmitted = false;
	private assReadOrder = 0;
	private assConfigEmitted = false;

	constructor(options: SubtitleParserOptions) {
		this.options = options;
	}

	parse(text: string) {
		if (this.options.codec === 'ass') {
			this.parseAss(text);
			return;
		}

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

	// Parse an ASS/SSA document: the header (up to and including the [Events] Format line)
	// becomes the CodecPrivate; each Dialogue line becomes a cue whose text is the S_TEXT/ASS
	// block payload "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text".
	private parseAss(text: string) {
		const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
		let formatIdx = -1;
		let inEvents = false;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = (lines[i] ?? '').trim();
			if (/^\[events\]/i.test(trimmed)) {
				inEvents = true;
			} else if (inEvents && /^format:/i.test(trimmed)) {
				formatIdx = i;
				break;
			}
		}
		if (formatIdx === -1) throw new Error('ASS document has no [Events] Format line.');

		const header = lines.slice(0, formatIdx + 1).join('\n');
		const fmt = (lines[formatIdx] ?? '').replace(/^\s*format:\s*/i, '').split(',').map(s => s.trim().toLowerCase());
		const col = (name: string) => fmt.indexOf(name);
		const iStart = col('start');
		const iEnd = col('end');
		const iText = col('text');
		const cols = {
			layer: col('layer'),
			style: col('style'),
			name: col('name'),
			ml: col('marginl'),
			mr: col('marginr'),
			mv: col('marginv'),
			effect: col('effect'),
		};

		for (let i = formatIdx + 1; i < lines.length; i++) {
			const m = /^\s*dialogue:\s*(.*)$/i.exec(lines[i] ?? '');
			if (!m) {
				continue;
			}

			const bits = (m[1] ?? '').split(',');
			// The Text column is last and may itself contain commas, so it takes every remaining field.
			const field = (idx: number): string => {
				if (idx < 0) return '';
				return idx === iText ? bits.slice(iText).join(',') : (bits[idx] ?? '');
			};
			const start = parseAssTimestamp(field(iStart));
			const end = parseAssTimestamp(field(iEnd));
			const payload = [
				this.assReadOrder,
				field(cols.layer) || '0',
				field(cols.style),
				field(cols.name),
				field(cols.ml) || '0',
				field(cols.mr) || '0',
				field(cols.mv) || '0',
				field(cols.effect),
				field(iText),
			].join(',');

			const meta: SubtitleMetadata = {};
			if (!this.assConfigEmitted) {
				meta.config = { description: header };
				this.assConfigEmitted = true;
			}

			this.options.output(
				{ timestamp: start / 1000, duration: Math.max(0, end - start) / 1000, text: payload },
				meta,
			);
			this.assReadOrder++;
		}
	}
}

const timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;
export const parseSubtitleTimestamp = (string: string) => {
	const match = timestampRegex.exec(string);
	if (!match) throw new Error('Expected match.');

	return 60 * 60 * 1000 * Number(match[1] || '0')
		+ 60 * 1000 * Number(match[2])
		+ 1000 * Number(match[3])
		+ Number(match[4]);
};

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
