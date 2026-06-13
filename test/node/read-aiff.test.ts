import { expect, test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS, AIFF, AudioSampleSink, Input, FilePathSource } from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

const SAMPLE_RATE = 44100;
const NUM_FRAMES = 11025; // 0.25s at 44100 Hz

const cases = [
	{ file: 'tone-16bit.aiff', codec: 'pcm-s16be', compression: 'NONE' },
	{ file: 'tone-8bit.aiff', codec: 'pcm-s8', compression: 'NONE' },
	{ file: 'tone-aifc-fl32.aifc', codec: 'pcm-f32be', compression: 'fl32' },
	{ file: 'tone-aifc-sowt.aifc', codec: 'pcm-s16', compression: 'sowt' },
] as const;

for (const { file, codec, compression } of cases) {
	test(`Should demux and decode ${file}`, async () => {
		const filePath = path.join(__dirname, '..', 'public', file);
		using input = new Input({
			source: new FilePathSource(filePath),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(AIFF);

		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			throw new Error('No audio track found');
		}

		expect(await track.getCodec()).toBe(codec);
		expect(await track.getInternalCodecId()).toBe(compression);
		expect(await track.getNumberOfChannels()).toBe(1);
		expect(await track.getSampleRate()).toBe(SAMPLE_RATE);
		expect(await track.canDecode()).toBe(true);
		expect(await input.computeDuration()).toBeCloseTo(NUM_FRAMES / SAMPLE_RATE, 3);

		// Decode every sample and confirm the full frame count and non-silent audio.
		const sink = new AudioSampleSink(track);
		let frames = 0;
		let peak = 0;
		for await (const sample of sink.samples()) {
			const data = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32-planar' }) / 4);
			sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
			for (const v of data) {
				peak = Math.max(peak, Math.abs(v));
			}
			frames += sample.numberOfFrames;
			sample.close();
		}

		expect(frames).toBe(NUM_FRAMES);
		expect(peak).toBeGreaterThan(0.2); // The fixture is a 0.3-amplitude tone
	});
}

test('Should detect AIFF independently of file extension', async () => {
	const filePath = path.join(__dirname, '..', 'public', 'tone-16bit.aiff');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: [AIFF],
	});

	expect((await input.getFormat()).name).toBe('AIFF');
	const track = await input.getPrimaryAudioTrack();
	expect(await track?.canDecode()).toBe(true);
});
