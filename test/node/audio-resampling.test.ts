import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { WAVE } from '../../src/input-format.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { WavOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

const roundTrip = async (
	data: Float32Array, chunks: number[], sourceRate: number, targetRate: number, channels: number,
) => {
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({
		codec: 'pcm-f32',
		transform: { numberOfChannels: channels, sampleRate: targetRate },
	});
	output.addAudioTrack(source);
	await output.start();

	let offset = 0;
	for (const frames of chunks) {
		using sample = new AudioSample({
			data: data.subarray(offset * 2, (offset + frames) * 2),
			format: 'f32', numberOfChannels: 2, sampleRate: sourceRate, timestamp: offset / sourceRate,
		});
		await source.add(sample);
		offset += frames;
	}
	source.close();
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: [WAVE] });
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getSampleRate()).toBe(targetRate);
	expect(await track.getNumberOfChannels()).toBe(channels);

	const pcm: number[] = [];
	for await (const sample of new AudioSampleSink(track).samples()) {
		try {
			expect(sample.timestamp).toBeCloseTo(pcm.length / channels / targetRate, 10);
			expect(sample.sampleRate).toBe(targetRate);
			expect(sample.numberOfChannels).toBe(channels);
			const buffer = new Float32Array(sample.numberOfFrames * channels);
			sample.copyTo(buffer, { planeIndex: 0, format: 'f32' });
			pcm.push(...buffer);
		} finally {
			sample.close();
		}
	}
	expect(pcm.length / channels).toBe(Math.ceil(offset * targetRate / sourceRate));
	return pcm;
};

for (const channels of [4, 6]) {
	test.each([
		{ name: 'one frame', chunks: [1], sourceRate: 48000, targetRate: 48000 },
		{ name: 'two frames', chunks: [2], sourceRate: 48000, targetRate: 48000 },
		{ name: 'uneven chunks', chunks: [1, 3, 2, 3], sourceRate: 48000, targetRate: 48000 },
		{ name: 'uneven chunks with resampling', chunks: [1, 3, 2, 3], sourceRate: 32000, targetRate: 48000 },
		{ name: 'one frame with resampling', chunks: [1], sourceRate: 48000, targetRate: 96000 },
	])(`Stereo to ${channels} channels: $name`, async ({ chunks, sourceRate, targetRate }) => {
		const frames = chunks.reduce((sum, count) => sum + count, 0);
		const data = Float32Array.from({ length: frames * 2 }, (_, i) => (i % 2 ? -1 : 1) * (i + 1) / 32);
		const pcm = await roundTrip(data, chunks, sourceRate, targetRate, channels);
		const stereo = sourceRate === targetRate
			? Array.from(data)
			: await roundTrip(data, chunks, sourceRate, targetRate, 2);

		expect(pcm.every(Number.isFinite)).toBe(true);
		for (let frame = 0; frame < pcm.length / channels; frame++) {
			expect(pcm.slice(frame * channels, frame * channels + 2)).toEqual(stereo.slice(frame * 2, frame * 2 + 2));
			for (let channel = 2; channel < channels; channel++) {
				expect(pcm[frame * channels + channel]).toBe(0);
			}
		}
	});
}
