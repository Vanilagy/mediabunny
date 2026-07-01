import { expect, test } from 'vitest';
import path from 'node:path';
import {
	AIFF,
	AiffOutputFormat,
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	FilePathSource,
	Input,
	Output,
} from '../../src/index.js';

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

const WRITE_FRAMES = 2205; // 0.05s at 44100 Hz

// A 440 Hz mono tone as floating-point samples.
const makeTone = () => {
	const data = new Float32Array(WRITE_FRAMES);
	for (let i = 0; i < WRITE_FRAMES; i++) {
		data[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE);
	}
	return data;
};

const writeCases = [
	{ codec: 'pcm-s16be', formType: 'AIFF', compression: 'NONE', tolerance: 1e-4 },
	{ codec: 'pcm-s24be', formType: 'AIFF', compression: 'NONE', tolerance: 1e-6 },
	{ codec: 'pcm-s8', formType: 'AIFF', compression: 'NONE', tolerance: 1e-2 },
	{ codec: 'pcm-f32be', formType: 'AIFC', compression: 'fl32', tolerance: 1e-6 },
] as const;

for (const { codec, formType, compression, tolerance } of writeCases) {
	test(`Should write and read back AIFF (${codec})`, async () => {
		const tone = makeTone();

		const output = new Output({
			format: new AiffOutputFormat(),
			target: new BufferTarget(),
		});
		const source = new AudioSampleSource({ codec });
		output.addAudioTrack(source);
		await output.start();

		await source.add(new AudioSample({
			data: tone,
			format: 'f32-planar',
			numberOfChannels: 1,
			sampleRate: SAMPLE_RATE,
			timestamp: 0,
		}));
		source.close();
		await output.finalize();

		const buffer = output.target.buffer!;
		expect(buffer).toBeInstanceOf(ArrayBuffer);

		// The file should declare the expected FORM type (AIFF vs AIFF-C).
		expect(new TextDecoder().decode(new Uint8Array(buffer, 8, 4))).toBe(formType);

		using input = new Input({
			source: new BufferSource(buffer),
			formats: [AIFF],
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
		expect(await input.computeDuration()).toBeCloseTo(WRITE_FRAMES / SAMPLE_RATE, 4);

		// Decode and compare against the original waveform.
		const decoded = new Float32Array(WRITE_FRAMES);
		let frames = 0;
		const sink = new AudioSampleSink(track);
		for await (const sample of sink.samples()) {
			const chunk = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32-planar' }) / 4);
			sample.copyTo(chunk, { planeIndex: 0, format: 'f32-planar' });
			decoded.set(chunk, frames);
			frames += sample.numberOfFrames;
			sample.close();
		}

		expect(frames).toBe(WRITE_FRAMES);
		let maxError = 0;
		for (let i = 0; i < WRITE_FRAMES; i++) {
			maxError = Math.max(maxError, Math.abs(decoded[i]! - tone[i]!));
		}
		expect(maxError).toBeLessThan(tolerance);
	});
}

const writeAiff = async (metadataFormat: 'text' | 'id3', tags: Parameters<Output['setMetadataTags']>[0]) => {
	const output = new Output({
		format: new AiffOutputFormat({ metadataFormat }),
		target: new BufferTarget(),
	});
	output.setMetadataTags(tags);

	const source = new AudioSampleSource({ codec: 'pcm-s16be' });
	output.addAudioTrack(source);
	await output.start();
	await source.add(new AudioSample({
		data: makeTone(),
		format: 'f32-planar',
		numberOfChannels: 1,
		sampleRate: SAMPLE_RATE,
		timestamp: 0,
	}));
	source.close();
	await output.finalize();

	return output.target.buffer!;
};

const readTags = async (buffer: ArrayBuffer) => {
	using input = new Input({ source: new BufferSource(buffer), formats: [AIFF] });
	return await input.getMetadataTags();
};

test('Should round-trip metadata via native AIFF text chunks', async () => {
	const buffer = await writeAiff('text', {
		title: 'Trying to Feel Alive',
		artist: 'Porter Robinson',
		comment: 'A great song',
		album: 'Nurture', // Not representable as a text chunk; should be dropped
	});

	const tags = await readTags(buffer);
	expect(tags.title).toBe('Trying to Feel Alive');
	expect(tags.artist).toBe('Porter Robinson');
	expect(tags.comment).toBe('A great song');
	expect(tags.album).toBeUndefined();
});

test('Should round-trip rich metadata via an ID3 chunk', async () => {
	const buffer = await writeAiff('id3', {
		title: 'Trying to Feel Alive',
		artist: 'Porter Robinson',
		album: 'Nurture',
		genre: 'Electronic',
		trackNumber: 3,
	});

	const tags = await readTags(buffer);
	expect(tags.title).toBe('Trying to Feel Alive');
	expect(tags.artist).toBe('Porter Robinson');
	expect(tags.album).toBe('Nurture');
	expect(tags.genre).toBe('Electronic');
	expect(tags.trackNumber).toBe(3);
});
