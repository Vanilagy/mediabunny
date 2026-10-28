import { expect, test } from 'vitest';
import { AudioResampler } from '../../src/resample.js';
import { AudioSample } from '../../src/sample.js';

test('Output buffer boundary with fractional chunk endpoint', async () => {
	const output: number[] = [];
	const outputLengths: number[] = [];
	const resampler = new AudioResampler({
		targetSampleRate: 12,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			output.push(...data);
			outputLengths.push(sample.numberOfFrames);
			sample.close();
		},
	});

	// At 5 Hz in and 12 Hz out, the second chunk ends at output frame 62.4, past the end of the first buffer
	const samples = [
		{ frames: 1, timestamp: 0 },
		{ frames: 25, timestamp: 1 / 5 },
		{ frames: 4, timestamp: 26 / 5 },
	].map(({ frames, timestamp }) => new AudioSample({
		format: 'f32',
		sampleRate: 5,
		numberOfChannels: 1,
		timestamp,
		data: new Float32Array(frames).fill(0.75),
	}));

	for (const sample of samples) {
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	expect(outputLengths).toEqual([60, 12]);
	expect(output.slice(58, 63)).toEqual([0.75, 0.75, 0.75, 0.75, 0.75]);
});

test('Exact output frame count across chunks', async () => {
	let outputFrames = 0;
	const resampler = new AudioResampler({
		targetSampleRate: 48000,
		targetNumberOfChannels: 1,
		onSample: async (sample) => {
			outputFrames += sample.numberOfFrames;
			sample.close();
		},
	});

	// The last chunk's end lands exactly on an output frame, which plain float time math overshoots
	for (let i = 0; i < 343; i++) {
		const sample = new AudioSample({
			format: 'f32',
			sampleRate: 22050,
			numberOfChannels: 1,
			timestamp: 1152 * i / 22050,
			data: new Float32Array(1152).fill(0.5),
		});
		await resampler.add(sample);
		sample.close();
	}
	await resampler.finalize();

	expect(outputFrames).toBe(343 * 1152 * 48000 / 22050);
});
