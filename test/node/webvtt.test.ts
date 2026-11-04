import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { TextSubtitleSource } from '../../src/media-source.js';
import { inlineTimestampRegex, parseSubtitleTimestamp, SubtitleCue, SubtitleParser } from '../../src/subtitles.js';

test('ISOBMFF muxing', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	await source.add(`WEBVTT

00:00.000 --> 00:00.900
Hildy!

00:01.000 --> 00:01.400
How are you?

00:01.500 --> 00:02.900
Tell me, is the lord of the universe in?
`);

	await output.finalize();
});

test('Matroska muxing', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	await source.add(`WEBVTT

00:00.000 --> 00:00.900
Hildy!

00:01.000 --> 00:01.400
How are you?

00:01.500 --> 00:02.900
Tell me, is the lord of the universe in?
`);

	await output.finalize();
});

test('Cue without payload at end of text', () => {
	const { cues } = parseWebVtt('WEBVTT\n\n1\n00:00.000 --> 00:01.000 align:start');

	expect(cues).toHaveLength(1);
	expect(cues[0]!.identifier).toBe('1');
	expect(cues[0]!.settings).toBe('align:start');
	expect(cues[0]!.text).toBe('');
});

test('Timestamps with three-digit hours', () => {
	const { cues } = parseWebVtt('WEBVTT\n\n99:59:59.000 --> 100:00:01.500\nHello\n');

	expect(cues).toHaveLength(1);
	expect(cues[0]!.timestamp).toBe(359999);
	expect(cues[0]!.duration).toBe(2.5);
	expect(cues[0]!.text).toBe('Hello');
	expect(parseSubtitleTimestamp('123:04:05.678')).toBe(1000 * (123 * 3600 + 4 * 60 + 5) + 678);
	expect('Hello <100:00:00.500>there'.match(inlineTimestampRegex)).toEqual(['<100:00:00.500>']);
});

test('Leading byte order mark', () => {
	const byteOrderMark = String.fromCharCode(0xFEFF);
	const { cues, description } = parseWebVtt(byteOrderMark + 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');

	expect(description).toBe('WEBVTT');
	expect(cues).toHaveLength(1);
	expect(cues[0]!.text).toBe('Hello');
});

const parseWebVtt = (text: string) => {
	const cues: SubtitleCue[] = [];
	let description: string | null = null;

	const parser = new SubtitleParser({
		codec: 'webvtt',
		output: (cue, metadata) => {
			cues.push(cue);
			if (metadata.config) {
				description = metadata.config.description;
			}
		},
	});
	parser.parse(text);

	return { cues, description };
};
