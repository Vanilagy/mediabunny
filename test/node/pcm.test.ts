import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { AudioSampleCursor } from '../../src/cursors.js';
import { AudioSample } from '../../src/sample.js';
import { PcmAudioCodec } from '../../src/codec.js';
import { toUint8Array, uint8ArraysAreEqual } from '../../src/misc.js';
import { fromAlaw, fromUlaw, toAlaw, toUlaw } from '../../src/pcm.js';

// All of these span the full value range of their format
const u8Data = Uint8Array.from({ length: 256 }, (_, i) => i);
const s16Data = Int16Array.from({ length: 65536 }, (_, i) => i - 32768);
const s24Data = Int32Array.from({ length: 65536 }, (_, i) => (i * 256 + (i & 255) - 8388608) << 8);
const s32Data = Int32Array.from({ length: 65536 }, (_, i) => (i - 32768) * 65536 + i);
const f32Data = Float32Array.from({ length: 65536 }, (_, i) => Math.sin(i));

type SampleData = Uint8Array | Int16Array | Int32Array | Float32Array;
type SampleFormat = 'u8' | 's16' | 's32' | 'f32';

test('u8 copyTo identity', () => {
	testCopyToIdentity('u8', u8Data);
});

test('s16 copyTo identity', () => {
	testCopyToIdentity('s16', s16Data);
});

test('s32 copyTo identity', () => {
	testCopyToIdentity('s32', s32Data);
});

test('f32 copyTo identity', () => {
	testCopyToIdentity('f32', f32Data);
});

test('pcm-u8 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-u8', 'u8', u8Data);
});

test('pcm-s16 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-s16', 's16', s16Data);
});

test('pcm-s24 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-s24', 's32', s24Data);
});

test('pcm-s32 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-s32', 's32', s32Data);
});

test('pcm-f32 encode-decode roundtrip', async () => {
	await testEncodeDecodeRoundtrip('pcm-f32', 'f32', f32Data);
});

const testCopyToIdentity = (format: SampleFormat, data: SampleData) => {
	using sample = new AudioSample({
		data,
		format,
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});

	const copied = data.slice().fill(0);
	sample.copyTo(copied, {
		format,
		planeIndex: 0,
	});

	expect(uint8ArraysAreEqual(toUint8Array(copied), toUint8Array(data))).toBe(true);
};

const testEncodeDecodeRoundtrip = async (codec: PcmAudioCodec, format: SampleFormat, data: SampleData) => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format,
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe(codec);

	await using cursor = new AudioSampleCursor(track);
	const decoded = data.slice().fill(0);
	let frameOffset = 0;

	for await (const sample of cursor) {
		sample.copyTo(decoded.subarray(frameOffset), {
			format,
			planeIndex: 0,
		});
		frameOffset += sample.numberOfFrames;
	}

	expect(frameOffset).toBe(data.length);
	expect(uint8ArraysAreEqual(toUint8Array(decoded), toUint8Array(data))).toBe(true);
};

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

test('mu-law file roundtrip', async () => {
	await expectG711FileRoundtrip('ulaw', fromUlaw);
});

test('A-law file roundtrip', async () => {
	await expectG711FileRoundtrip('alaw', fromAlaw);
});

const expectG711FileRoundtrip = async (codec: 'ulaw' | 'alaw', decodeCodeword: (u8: number) => number) => {
	// Every value the codec can represent, so the roundtrip must be lossless
	const data = Int16Array.from({ length: 256 }, (_, i) => decodeCodeword(i));

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new AudioSampleSource({ codec });
	output.addAudioTrack(audioSource);

	await output.start();
	const sample = new AudioSample({
		data,
		format: 's16',
		numberOfChannels: 1,
		sampleRate: 8000,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe(codec);

	await using cursor = new AudioSampleCursor(track);
	const decoded = new Int16Array(data.length);
	let frameOffset = 0;

	for await (const sample of cursor) {
		sample.copyTo(decoded.subarray(frameOffset), {
			format: 's16',
			planeIndex: 0,
		});
		frameOffset += sample.numberOfFrames;
	}

	expect(frameOffset).toBe(data.length);
	expect(decoded).toEqual(data);
};
