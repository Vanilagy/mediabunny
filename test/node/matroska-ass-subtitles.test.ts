import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat, Mp4OutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { TextSubtitleSource } from '../../src/media-source.js';

const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Alignment
Style: Default,Arial,20,&H00FFFFFF,&H00000000,0,2

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Second line
`;

// The subtitle codec strings and payloads are ASCII, so decode the raw container as latin1
// and look for them. (mediabunny's Input demuxes only audio/video, so we assert on bytes.)
const decoder = new TextDecoder('latin1');
const contains = (buffer: ArrayBuffer, needle: string) => decoder.decode(buffer).includes(needle);

test('Matroska muxer writes an S_TEXT/ASS subtitle track', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new TextSubtitleSource('ass');
	output.addSubtitleTrack(source);

	await output.start();
	await source.add(ASS);
	await output.finalize();

	const buffer = output.target.buffer!;
	expect(buffer).not.toBeNull();
	expect(buffer.byteLength).toBeGreaterThan(0);

	// The Matroska CodecID for ASS.
	expect(contains(buffer, 'S_TEXT/ASS')).toBe(true);

	// The header up to and including the [Events] Format line is stored as CodecPrivate.
	expect(contains(buffer, '[Script Info]')).toBe(true);
	const eventsFormat = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
	expect(contains(buffer, eventsFormat)).toBe(true);

	// Each Dialogue becomes a block whose text is the S_TEXT/ASS payload, reordered to
	// "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text" with an incrementing ReadOrder.
	expect(contains(buffer, '0,0,Default,,0,0,0,,Hello world')).toBe(true);
	expect(contains(buffer, '1,0,Default,,0,0,0,,Second line')).toBe(true);
});

test('WebM and MP4 reject the ASS subtitle codec, Matroska accepts it', () => {
	const mkv = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	expect(() => mkv.addSubtitleTrack(new TextSubtitleSource('ass'))).not.toThrow();

	const webm = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	expect(() => webm.addSubtitleTrack(new TextSubtitleSource('ass'))).toThrow(/cannot be contained/);

	const mp4 = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	expect(() => mp4.addSubtitleTrack(new TextSubtitleSource('ass'))).toThrow(/cannot be contained/);
});
