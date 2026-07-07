import { expect, test } from 'vitest';
import { AudioSample } from '../../src/sample.js';

const SAMPLE_RATE = 48000;
const NUM_CHANNELS = 2;
const NUM_FRAMES = 10;
const TIMESTAMP = 1;

const cellValue = (frame: number, channel: number) => frame * 10 + channel;

const makeInterleavedSample = () => {
	const data = new Int16Array(NUM_FRAMES * NUM_CHANNELS);
	for (let f = 0; f < NUM_FRAMES; f++) {
		for (let c = 0; c < NUM_CHANNELS; c++) {
			data[f * NUM_CHANNELS + c] = cellValue(f, c);
		}
	}

	return new AudioSample({
		data,
		format: 's16',
		sampleRate: SAMPLE_RATE,
		numberOfChannels: NUM_CHANNELS,
		timestamp: TIMESTAMP,
	});
};

const makePlanarSample = () => {
	const data = new Float32Array(NUM_FRAMES * NUM_CHANNELS);
	for (let c = 0; c < NUM_CHANNELS; c++) {
		for (let f = 0; f < NUM_FRAMES; f++) {
			data[c * NUM_FRAMES + f] = cellValue(f, c);
		}
	}

	return new AudioSample({
		data,
		format: 'f32-planar',
		sampleRate: SAMPLE_RATE,
		numberOfChannels: NUM_CHANNELS,
		timestamp: TIMESTAMP,
	});
};

const readCell = (sample: AudioSample, frame: number, channel: number) => {
	if (sample.format === 's16') {
		const out = new Int16Array(sample.numberOfFrames * sample.numberOfChannels);
		sample.copyTo(out, { planeIndex: 0, format: 's16' });
		return out[frame * sample.numberOfChannels + channel];
	} else {
		const out = new Float32Array(sample.numberOfFrames);
		sample.copyTo(out, { planeIndex: channel, format: 'f32-planar' });
		return out[frame];
	}
};

for (const [label, makeSample] of [
	['interleaved', makeInterleavedSample],
	['planar', makePlanarSample],
] as const) {
	test(`trim, normal case (${label})`, () => {
		using sample = makeSample();
		using trimmed = sample.trim(3, 8);

		expect(trimmed).not.toBe(sample);
		expect(trimmed.format).toBe(sample.format);
		expect(trimmed.sampleRate).toBe(SAMPLE_RATE);
		expect(trimmed.numberOfChannels).toBe(NUM_CHANNELS);
		expect(trimmed.numberOfFrames).toBe(5);
		expect(trimmed.duration).toBeCloseTo(5 / SAMPLE_RATE);
		expect(trimmed.timestamp).toBeCloseTo(TIMESTAMP + 3 / SAMPLE_RATE);

		// The trimmed frame i corresponds to the original frame i + 3
		for (let f = 0; f < trimmed.numberOfFrames; f++) {
			for (let c = 0; c < NUM_CHANNELS; c++) {
				expect(readCell(trimmed, f, c)).toBe(cellValue(f + 3, c));
			}
		}

		// The original sample must be untouched
		expect(sample.numberOfFrames).toBe(NUM_FRAMES);
		expect(readCell(sample, 3, 0)).toBe(cellValue(3, 0));
	});

	test(`trim, full range is an independent copy (${label})`, () => {
		using sample = makeSample();
		using trimmed = sample.trim(0, NUM_FRAMES);

		expect(trimmed.numberOfFrames).toBe(NUM_FRAMES);
		expect(trimmed.timestamp).toBeCloseTo(TIMESTAMP);
		for (let f = 0; f < NUM_FRAMES; f++) {
			for (let c = 0; c < NUM_CHANNELS; c++) {
				expect(readCell(trimmed, f, c)).toBe(cellValue(f, c));
			}
		}
	});

	test(`trim, pathological zero-sample case (${label})`, () => {
		using sample = makeSample();

		// Empty range in the middle
		using empty = sample.trim(4, 4);
		expect(empty.numberOfFrames).toBe(0);
		expect(empty.duration).toBe(0);
		expect(empty.format).toBe(sample.format);
		expect(empty.numberOfChannels).toBe(NUM_CHANNELS);
		expect(empty.timestamp).toBeCloseTo(TIMESTAMP + 4 / SAMPLE_RATE);

		// Empty range right at the end (startSample === numberOfFrames) is still valid
		using emptyAtEnd = sample.trim(NUM_FRAMES, NUM_FRAMES);
		expect(emptyAtEnd.numberOfFrames).toBe(0);
		expect(emptyAtEnd.timestamp).toBeCloseTo(TIMESTAMP + NUM_FRAMES / SAMPLE_RATE);
	});

	test(`trim, illegal params (${label})`, () => {
		using sample = makeSample();

		// Non-integer
		expect(() => sample.trim(1.5, 5)).toThrow(TypeError);
		expect(() => sample.trim(1, 5.5)).toThrow(TypeError);

		// Negative
		expect(() => sample.trim(-1, 5)).toThrow(TypeError);
		expect(() => sample.trim(0, -1)).toThrow(TypeError);

		// Out of range
		expect(() => sample.trim(0, NUM_FRAMES + 1)).toThrow(RangeError);
		expect(() => sample.trim(NUM_FRAMES + 1, NUM_FRAMES + 1)).toThrow(RangeError);

		// End before start
		expect(() => sample.trim(6, 3)).toThrow(RangeError);
	});
}

test('trim, throws on a closed sample', () => {
	const sample = makeInterleavedSample();
	sample.close();
	expect(() => sample.trim(0, 5)).toThrow('AudioSample is closed.');
});
