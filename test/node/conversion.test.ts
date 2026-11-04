import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, Source } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget } from '../../src/target.js';
import {
	CmafOutputFormat,
	FlacOutputFormat,
	MkvOutputFormat,
	Mp4OutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { MetadataTags } from '../../src/metadata.js';
import { Conversion, ConversionCanceledError } from '../../src/conversion.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const VIDEO_FILE = path.join(__dirname, '..', 'public', 'video.mp4');
const WAV_FILE = path.join(__dirname, '..', 'public', 'glitch-hop-is-dead.wav');
const FLAC_FILE = path.join(__dirname, '..', 'public', 'sample.flac');

test('Output start failure', async () => {
	using input = new Input({
		source: new FilePathSource(VIDEO_FILE),
		formats: ALL_FORMATS,
	});

	// No initTarget, so starting the output throws
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await expect(conversion.execute()).rejects.toThrow(/initTarget/);

	expect(conversion.state).toBe('canceled');
	expect(output.state).toBe('canceled');
	await expect(conversion.execute()).rejects.toBeInstanceOf(ConversionCanceledError);
});

test('Cancel during startup with progress', async () => {
	using input = new Input({
		source: new FilePathSource(VIDEO_FILE),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	conversion.onProgress = () => {};

	const promise = conversion.execute();
	void conversion.cancel();

	await expect(promise).rejects.toBeInstanceOf(ConversionCanceledError);
	expect(output.state).toBe('canceled');
});

test('Cancel from progress callback', async () => {
	using input = new Input({
		source: new FilePathSource(WAV_FILE),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output });
	conversion.onProgress = (progress) => {
		if (progress > 0) {
			void conversion.cancel();
		}
	};

	await expect(conversion.execute()).rejects.toBeInstanceOf(ConversionCanceledError);
});

test('Progress for an empty trim range', async () => {
	using input = new Input({
		source: new FilePathSource(VIDEO_FILE),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		trim: { start: await input.computeDuration() },
	});
	const progressValues: number[] = [];
	conversion.onProgress = (progress) => {
		progressValues.push(progress);
	};
	await conversion.execute();

	expect(progressValues).toEqual([0, 1]);
});

test('Finalize failure', async () => {
	using input = new Input({
		source: new FilePathSource(VIDEO_FILE),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget({
			onFinalize: () => {
				throw new Error('Upload failed');
			},
		}),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await expect(conversion.execute()).rejects.toThrow('Upload failed');

	expect(conversion.state).toBe('canceled');
	await expect(conversion.execute()).rejects.toBeInstanceOf(ConversionCanceledError);
});

test('Stream target write failure', async () => {
	using input = new Input({
		source: new FilePathSource(VIDEO_FILE),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: false }),
		target: new StreamTarget(new WritableStream({
			write: () => {
				throw new Error('Write failed');
			},
		})),
	});

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
	process.on('unhandledRejection', onUnhandledRejection);

	try {
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		await expect(conversion.execute()).rejects.toThrow('Write failed');

		// Let the cleanup run its course
		await output._cancelPromise!.catch(() => {});
		await new Promise(resolve => setTimeout(resolve));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

test('PCM fallback when no compressed codec is encodable', async () => {
	using input = new Input({
		source: new FilePathSource(WAV_FILE),
		formats: ALL_FORMATS,
	});
	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);
	expect(await inputTrack.getSampleRate()).toBe(44100);

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: { forceTranscode: true },
		trim: { end: 1 },
		showWarnings: false,
	});
	expect(conversion.isValid).toBe(true);
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toMatch(/^pcm-/);
	expect(await track.getSampleRate()).toBe(44100);
});

test('Options callback index for a non-first primary track', async () => {
	using input = new Input({
		source: new BufferSource(await createTwoVideoTrackFile()),
		formats: ALL_FORMATS,
	});

	const primaryTrack = await input.getPrimaryVideoTrack();
	expect(primaryTrack!.number).toBe(2);

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const seen: [number, number][] = [];
	await Conversion.init({
		input,
		output,
		tracks: 'primary',
		video: (track, n) => {
			seen.push([track.number, n]);
			return { discard: true };
		},
		showWarnings: false,
	});

	expect(seen).toEqual([[2, 2]]);
});

const createTwoVideoTrackFile = async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	// The first track is not the default one, making the second track the primary one
	const sources = [new EncodedVideoPacketSource('avc'), new EncodedVideoPacketSource('avc')];
	output.addVideoTrack(sources[0]!, { disposition: { default: false } });
	output.addVideoTrack(sources[1]!);

	await output.start();
	for (const source of sources) {
		await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
			decoderConfig: {
				codec: 'avc1.64001f',
				codedWidth: 1280,
				codedHeight: 720,
			},
		});
	}
	await output.finalize();

	return output.target.buffer!;
};

test('Invalidity explanation for a codec the output format cannot contain', async () => {
	using input = new Input({
		source: new FilePathSource(WAV_FILE),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		audio: { codec: 'aac' },
		showWarnings: false,
	});
	expect(conversion.isValid).toBe(false);
	expect(conversion.discardedTracks[0]!.reason).toBe('no_encodable_target_codec');
	await expect(conversion.execute()).rejects.toThrow(
		/discarded because the output format cannot contain the requested codecs 'aac'\.$/,
	);
});

test('FLAC to FLAC with a picture in the Vorbis comments', async () => {
	// Some taggers put pictures into the comments the way Ogg does it, rather than into PICTURE blocks
	const picture = new Uint8Array(45);
	const pictureView = new DataView(picture.buffer);
	pictureView.setUint32(0, 3); // Front cover
	pictureView.setUint32(4, 9);
	picture.set(new TextEncoder().encode('image/png'), 8);
	pictureView.setUint32(37, 4);
	picture.set([1, 2, 3, 4], 41);

	const taggedFile = await convertFlac(new FilePathSource(FLAC_FILE), {
		raw: { METADATA_BLOCK_PICTURE: Buffer.from(picture).toString('base64') },
	});
	const convertedFile = await convertFlac(new BufferSource(taggedFile), undefined);

	using input = new Input({
		source: new BufferSource(convertedFile),
		formats: ALL_FORMATS,
	});
	const { images } = await input.getMetadataTags();
	expect(images).toHaveLength(1);
	expect(images![0]!.data).toEqual(new Uint8Array([1, 2, 3, 4]));
});

const convertFlac = async (source: Source, tags: MetadataTags | undefined) => {
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		tags,
		trim: { end: 0.5 },
	});
	await conversion.execute();

	return output.target.buffer!;
};
