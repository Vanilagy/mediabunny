import { expect, test } from 'vitest';
import { VideoCodec } from '../../src/codec.js';
import {
	concatAvcNalUnits,
	deserializeAvcDecoderConfigurationRecord,
	iterateAvcNalUnits,
} from '../../src/codec-data.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert, colorSpaceIsComplete, toUint8Array } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferSource, Source, UrlSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

test('Color space extraction, AVC in MP4', async () => {
	const source = await readPackets('/video.mp4');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, HEVC in MP4', async () => {
	const source = await readPackets('/video-h265.mp4');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, VP9 in MP4', async () => {
	const source = await readPackets('/vp9-smpte170m.webm');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: 'smpte170m',
		transfer: 'smpte170m',
		matrix: 'smpte170m',
		fullRange: false,
	});
});

test('Color space extraction, AV1 in MP4', async () => {
	const source = await encodePackets('av1', 'av01.0.04M.08');
	const buffer = await remuxWithoutColorSpace(new Mp4OutputFormat(), source);

	await expectCompleteColorSpace(new BufferSource(buffer));
});

test('Color space extraction, AVC in Matroska', async () => {
	const source = await readPackets('/video.mp4');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, HEVC in Matroska', async () => {
	const source = await readPackets('/video-h265.mp4');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		// The SPS only signals the matrix and the range, leaving the rest unspecified
		primaries: undefined,
		transfer: undefined,
		matrix: 'bt470bg',
		fullRange: true,
	});
});

test('Color space extraction, VP9 in Matroska', async () => {
	const source = await readPackets('/vp9-smpte170m.webm');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectColorSpace(new BufferSource(buffer), {
		primaries: 'smpte170m',
		transfer: 'smpte170m',
		matrix: 'smpte170m',
		fullRange: false,
	});
});

test('Color space extraction, AV1 in Matroska', async () => {
	const source = await encodePackets('av1', 'av01.0.04M.08');
	const buffer = await remuxWithoutColorSpace(new MkvOutputFormat(), source);

	await expectCompleteColorSpace(new BufferSource(buffer));
});

// https://issues.chromium.org/issues/532860177
test.for(['prefer-software', 'prefer-hardware'] as const)(
	'Configured AVC color space reaches %s decoding, including repeated in-band SPS',
	async (hardwareAcceleration, { skip }) => {
		const source = await readPackets('/untagged-h264.mp4');
		if (hardwareAcceleration === 'prefer-hardware') {
			const { supported } = await VideoDecoder.isConfigSupported({
				...source.decoderConfig,
				hardwareAcceleration,
			});
			if (!supported) {
				skip('Hardware H.264 decoding is not supported in this environment.');
			}
		}
		const record = deserializeAvcDecoderConfigurationRecord(toUint8Array(source.decoderConfig.description!));
		assert(record);

		for (const fullRange of [false, true]) {
			using referenceInput = new Input({
				source: new UrlSource(fullRange ? '/bt601-full-range-h264.mp4' : '/bt601-h264.mp4'),
				formats: ALL_FORMATS,
			});
			const referenceTrack = await referenceInput.getPrimaryVideoTrack();
			assert(referenceTrack);
			const canvas = new OffscreenCanvas(854, 480);
			const context = canvas.getContext('2d')!;
			const referenceFrames: { pixels: Uint8ClampedArray; fullRange: boolean | null }[] = [];
			const referenceSink = new VideoSampleSink(referenceTrack, { hardwareAcceleration });
			for await (using sample of referenceSink.samples()) {
				sample.draw(context, 0, 0);
				referenceFrames.push({
					pixels: context.getImageData(0, 0, 854, 480).data,
					fullRange: sample.colorSpace.fullRange,
				});
			}

			for (const mode of ['avc', 'avc-in-band', 'annex-b']) {
				const annexB = mode === 'annex-b';
				const decoderConfig: VideoDecoderConfig = {
					...source.decoderConfig,
					colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange },
				};
				if (annexB) {
					delete decoderConfig.description;
				}

				const output = new Output({
					format: annexB ? new MkvOutputFormat() : new Mp4OutputFormat(),
					target: new BufferTarget(),
				});
				const videoSource = new EncodedVideoPacketSource('avc');
				output.addVideoTrack(videoSource);
				await output.start();
				for (let i = 0; i < source.packets.length; i++) {
					const packet = source.packets[i]!;
					const nalUnits = [...iterateAvcNalUnits(packet.data, source.decoderConfig)]
						.map(loc => packet.data.subarray(loc.offset, loc.offset + loc.length));
					// Repeat the original, untagged SPS even after decoding has started.
					const data = mode === 'avc'
						? packet.data
						: concatAvcNalUnits([
								...record.sequenceParameterSets,
								...record.pictureParameterSets,
								...nalUnits,
							], decoderConfig);
					await videoSource.add(packet.clone({ data }), i === 0 ? { decoderConfig } : undefined);
				}
				await output.finalize();

				using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
				const track = await input.getPrimaryVideoTrack();
				assert(track);
				expect(!!(await track.getDecoderConfig())!.description).toBe(!annexB);
				let count = 0;
				const sink = new VideoSampleSink(track, { hardwareAcceleration });
				for await (using sample of sink.samples()) {
					expect(sample.colorSpace.matrix).toBe('smpte170m');
					const reference = referenceFrames[count]!;
					// Decoders may convert full-range input to limited-range output; compare the tagged control.
					expect(sample.colorSpace.fullRange).toBe(reference.fullRange);
					sample.draw(context, 0, 0);
					const pixels = context.getImageData(0, 0, 854, 480).data;
					let maxDifference = 0;
					for (let i = 0; i < pixels.length; i++) {
						maxDifference = Math.max(maxDifference, Math.abs(pixels[i]! - reference.pixels[i]!));
					}
					expect(maxDifference).toBe(0);
					count++;
				}
				expect(count).toBe(source.packets.length);
			}
		}
	},
);

const readPackets = async (path: string) => {
	using input = new Input({
		source: new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const codec = await track.getCodec();
	assert(codec);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];

	for await (const packet of sink.packets()) {
		packets.push(packet);

		if (packets.length === 10) {
			break;
		}
	}

	return { codec, decoderConfig, packets };
};

const encodePackets = async (codec: VideoCodec, codecString: string) => {
	const width = 320;
	const height = 240;

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d')!;

	let decoderConfig: VideoDecoderConfig | null = null;
	const packets: EncodedPacket[] = [];

	// We manually go through WebCodecs here so we can intercept the decoder config
	const encoder = new VideoEncoder({
		output: (chunk, metadata) => {
			decoderConfig ??= metadata?.decoderConfig ?? null;
			packets.push(EncodedPacket.fromEncodedChunk(chunk));
		},
		error: (error) => {
			throw error;
		},
	});
	encoder.configure({ codec: codecString, width, height });

	for (let i = 0; i < 10; i++) {
		context.fillStyle = `hsl(${36 * i}, 100%, 50%)`;
		context.fillRect(0, 0, width, height);
		context.fillStyle = 'black';
		context.fillRect(20 * i, 10 * i, 80, 80);

		const frame = new VideoFrame(canvas, { timestamp: i * 1e6 / 30, duration: 1e6 / 30 });
		encoder.encode(frame, { keyFrame: i === 0 });
		frame.close();
	}

	await encoder.flush();
	encoder.close();

	assert(decoderConfig);

	return { codec, decoderConfig, packets };
};

const remuxWithoutColorSpace = async (
	format: Mp4OutputFormat | MkvOutputFormat,
	source: { codec: VideoCodec; decoderConfig: VideoDecoderConfig; packets: EncodedPacket[] },
) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource(source.codec);
	output.addVideoTrack(videoSource);

	await output.start();

	const decoderConfig = { ...source.decoderConfig };
	delete decoderConfig.colorSpace;

	let isFirstPacket = true;
	for (const packet of source.packets) {
		await videoSource.add(packet, isFirstPacket ? { decoderConfig } : undefined);
		isFirstPacket = false;
	}

	await output.finalize();

	const buffer = output.target.buffer;
	assert(buffer);

	return buffer;
};

const expectColorSpace = async (source: Source, expected: VideoColorSpaceInit) => {
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	expect(await track.getColorSpace()).toEqual(expected);
	expect({ ...decoderConfig.colorSpace }).toEqual(expected);
};

const expectCompleteColorSpace = async (source: Source) => {
	using input = new Input({
		source,
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	expect(colorSpaceIsComplete(await track.getColorSpace())).toBe(true);
	expect(colorSpaceIsComplete(decoderConfig.colorSpace)).toBe(true);
};
