import { expect, test } from 'vitest';
import { inferCodecFromCodecString, parsePcmCodec } from '../../src/codec.js';

test('inferCodecFromCodecString handles valid PCM codec strings', () => {
	expect(inferCodecFromCodecString('pcm-s16')).toBe('pcm-s16');
	expect(inferCodecFromCodecString('pcm-s24')).toBe('pcm-s24');
	expect(inferCodecFromCodecString('pcm-s32')).toBe('pcm-s32');
	expect(inferCodecFromCodecString('pcm-f32')).toBe('pcm-f32');
	expect(inferCodecFromCodecString('pcm-f64')).toBe('pcm-f64');
	expect(inferCodecFromCodecString('pcm-u8')).toBe('pcm-u8');
	expect(inferCodecFromCodecString('pcm-s8')).toBe('pcm-s8');
});

test('inferCodecFromCodecString handles valid PCM codec strings with big-endian', () => {
	expect(inferCodecFromCodecString('pcm-s16be')).toBe('pcm-s16be');
	expect(inferCodecFromCodecString('pcm-s24be')).toBe('pcm-s24be');
	expect(inferCodecFromCodecString('pcm-s32be')).toBe('pcm-s32be');
	expect(inferCodecFromCodecString('pcm-f32be')).toBe('pcm-f32be');
	expect(inferCodecFromCodecString('pcm-f64be')).toBe('pcm-f64be');
});

test('inferCodecFromCodecString returns null for invalid PCM strings', () => {
	expect(inferCodecFromCodecString('pcm-x16')).toBeNull();
	expect(inferCodecFromCodecString('pcm-s')).toBeNull();
	expect(inferCodecFromCodecString('pcm-s16bex')).toBeNull();
	expect(inferCodecFromCodecString('pcm-s16bee')).toBeNull();
});

test('inferCodecFromCodecString does not hang on crafted input (ReDoS)', () => {
	// The original regex /^pcm-([usf])(\d+)+(be)?$/ had catastrophic backtracking
	// due to the redundant outer `+` on the capturing group. This test ensures
	// a maliciously crafted input completes in reasonable time.
	const start = performance.now();
	inferCodecFromCodecString('pcm-u' + '9'.repeat(25) + 'x');
	const elapsed = performance.now() - start;
	expect(elapsed).toBeLessThan(1000); // should complete in <1 second, not hang
});

test('parsePcmCodec returns correct config for known codecs', () => {
	const s16 = parsePcmCodec('pcm-s16');
	expect(s16.dataType).toBe('signed');
	expect(s16.sampleSize).toBe(2);
	expect(s16.littleEndian).toBe(true);

	const f32be = parsePcmCodec('pcm-f32be');
	expect(f32be.dataType).toBe('float');
	expect(f32be.sampleSize).toBe(4);
	expect(f32be.littleEndian).toBe(false);

	const u8 = parsePcmCodec('pcm-u8');
	expect(u8.dataType).toBe('unsigned');
	expect(u8.sampleSize).toBe(1);
	expect(u8.littleEndian).toBe(true);
});
