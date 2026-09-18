import { expect, test } from 'vitest';
import { fromAlaw, fromUlaw, toAlaw, toUlaw } from '../../src/pcm.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink } from '../../src/media-sink.js';

// Expected values from the ITU-T G.711 decoding tables, expressed as s16 PCM

test('µ-law decoding produces correctly-scaled s16 PCM', () => {
	expect(fromUlaw(0x00)).toBe(-32124);
	expect(fromUlaw(0x80)).toBe(32124);
	expect(fromUlaw(0xFF)).toBe(0);
	expect(fromUlaw(0xFE)).toBe(8);
	expect(fromUlaw(0x7E)).toBe(-8);
	expect(fromUlaw(0x55)).toBe(-716);
	expect(fromUlaw(0xD5)).toBe(716);
});

test('A-law decoding produces correctly-scaled s16 PCM', () => {
	expect(fromAlaw(0xD5)).toBe(8);
	expect(fromAlaw(0x55)).toBe(-8);
	expect(fromAlaw(0xAA)).toBe(32256);
	expect(fromAlaw(0x2A)).toBe(-32256);
	expect(fromAlaw(0xF0)).toBe(688);
	expect(fromAlaw(0x70)).toBe(-688);
});

test('µ-law encoding maps full-scale s16 PCM', () => {
	expect(toUlaw(0)).toBe(0xFF);
	expect(toUlaw(1000)).toBe(0xCE); // Decodes to +988, within one quantization step
	expect(toUlaw(-1000)).toBe(0x4E);
	expect(toUlaw(32124)).toBe(0x80);
	expect(toUlaw(32767)).toBe(0x80);
	expect(toUlaw(-32124)).toBe(0x00);
	expect(toUlaw(-32768)).toBe(0x00);
});

test('A-law encoding maps full-scale s16 PCM', () => {
	expect(toAlaw(0)).toBe(0xD5);
	expect(toAlaw(1000)).toBe(0xFA);
	expect(toAlaw(-1000)).toBe(0x7A);
	expect(toAlaw(32256)).toBe(0xAA);
	expect(toAlaw(32767)).toBe(0xAA);
	expect(toAlaw(-32256)).toBe(0x2A);
	expect(toAlaw(-32768)).toBe(0x2A);
});

test('G.711 encode/decode round-trips', () => {
	for (const v of [1, -1, 64, -64, 500, -500, 4000, -4000, 16000, -16000, 32000, -32000]) {
		const fromU = fromUlaw(toUlaw(v));
		const fromA = fromAlaw(toAlaw(v));

		if (Math.abs(v) >= 64) {
			expect(Math.sign(fromU)).toBe(Math.sign(v));
			expect(Math.sign(fromA)).toBe(Math.sign(v));
		}

		expect(Math.abs(fromU - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) >> 3));
		expect(Math.abs(fromA - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) >> 3));
	}
});

const createWav = (formatTag: number, data: Uint8Array) => {
	const buffer = new ArrayBuffer(44 + data.length);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) {
			view.setUint8(offset + i, s.charCodeAt(i));
		}
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + data.length, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, formatTag, true);
	view.setUint16(22, 1, true); // Mono
	view.setUint32(24, 8000, true);
	view.setUint32(28, 8000, true); // Byte rate
	view.setUint16(32, 1, true); // Block align
	view.setUint16(34, 8, true); // Bits per sample
	writeAscii(36, 'data');
	view.setUint32(40, data.length, true);
	new Uint8Array(buffer, 44).set(data);

	return buffer;
};

const decodeWav = async (formatTag: number, data: Uint8Array) => {
	using input = new Input({
		source: new BufferSource(createWav(formatTag, data)),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.canDecode()).toBe(true); // Software decoding must work without AudioDecoder

	const sink = new AudioSampleSink(track);
	const decoded: number[] = [];

	for await (using sample of sink.samples()) {
		const chunk = new Int16Array(sample.allocationSize({ format: 's16', planeIndex: 0 }) / 2);
		sample.copyTo(chunk, { format: 's16', planeIndex: 0 });
		decoded.push(...chunk);
	}

	return decoded;
};

test('µ-law WAV decodes through the software path', async () => {
	const decoded = await decodeWav(0x0007, new Uint8Array([0x00, 0x80, 0xFF, 0xFE, 0x7E]));
	const expected = [-32124, 32124, 0, 8, -8];

	// Within 1 LSB of the ITU-T values: copyTo('s16') may round via the f32 intermediate
	expect(decoded.length).toBe(expected.length);
	for (const [i, v] of decoded.entries()) {
		expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(1);
	}
});

test('A-law WAV decodes through the software path', async () => {
	const decoded = await decodeWav(0x0006, new Uint8Array([0xD5, 0x55, 0xAA, 0x2A]));
	const expected = [8, -8, 32256, -32256];

	expect(decoded.length).toBe(expected.length);
	for (const [i, v] of decoded.entries()) {
		expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(1);
	}
});
