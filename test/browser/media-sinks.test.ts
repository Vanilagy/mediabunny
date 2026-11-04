import { expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { AudioSampleSink, ColorAlphaMerger, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, MpegTsOutputFormat, WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions, VideoSample } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { EncodedVideoPacketSource, VideoSampleSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { EncodedPacket } from '../../src/packet.js';

// https://github.com/Vanilagy/mediabunny/issues/370
test('Negative audio timestamps are preserved', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getFirstTimestamp()).toBeLessThan(0);

	const sink = new AudioSampleSink(track);

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBe(await track.getFirstTimestamp());
		break;
	}
});

test('No B-frames are skipped when software-decoding AVC', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBe(48);
});

test('No B-frames are skipped when software-decoding AVC, Annex B edition', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	// Force Annex B by converting to MPEG-TS
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBe(48);
});

test('Fallback sample past the end survives iterator return', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track);
	const iterator = sink.samples(await track.computeDuration() + 0.5);

	const { value: sample } = await iterator.next();
	assert(sample);
	await iterator.return();

	expect(sample._closed).toBe(false);
	sample.close();
});

test('Audio decoder pre-roll (AAC)', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('aac');
	expect(await track.getPreRollDuration()).toBe(1024 / await track.getSampleRate());

	await testAudioDecoderPreRoll(track, -90);
});

test('Audio decoder pre-roll (Opus)', async () => {
	using input = new Input({
		source: new UrlSource('/preroll-test.opus'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('opus');
	expect(await track.getPreRollDuration()).toBe(OPUS_PRE_ROLL_DURATION);

	await testAudioDecoderPreRoll(track, -90);
});

const testAudioDecoderPreRoll = async (track: InputAudioTrack, maxErrorDb: number) => {
	const sink = new AudioSampleSink(track);

	// Decoding straight through from the start gives us a reference sample with fully converged decoder state
	let referenceTimestamp: number | null = null;
	let referenceData: Float32Array | null = null;
	for await (using sample of sink.samples(0)) {
		if (sample.timestamp >= 1) {
			referenceTimestamp = sample.timestamp;
			referenceData = getSampleData(sample);
			break;
		}
	}
	assert(referenceTimestamp !== null);
	assert(referenceData);

	for await (using sample of sink.samples(referenceTimestamp)) {
		expect(sample.timestamp).toBe(referenceTimestamp);
		expectSimilarData(getSampleData(sample), referenceData, maxErrorDb);
		break;
	}

	for await (using sample of sink.samplesAtTimestamps([referenceTimestamp])) {
		assert(sample);
		expect(sample.timestamp).toBe(referenceTimestamp);
		expectSimilarData(getSampleData(sample), referenceData, maxErrorDb);
	}
};

const getSampleData = (sample: AudioSample) => {
	const options: AudioSampleCopyToOptions = {
		planeIndex: 0,
		format: 'f32',
	};

	const data = new Float32Array(sample.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT);
	sample.copyTo(data, options);

	return data;
};

const expectSimilarData = (actual: Float32Array, expected: Float32Array, maxErrorDb: number) => {
	expect(actual.length).toBe(expected.length);

	let maxDifference = 0;
	for (let i = 0; i < actual.length; i++) {
		maxDifference = Math.max(maxDifference, Math.abs(actual[i]! - expected[i]!));
	}

	expect(20 * Math.log10(maxDifference)).toBeLessThan(maxErrorDb);
};

test('Sample retrieval within Opus pre-skip', async () => {
	using input = new Input({
		source: new UrlSource('/demo.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('opus');
	expect(await track.getPreRollDuration()).toBe(OPUS_PRE_ROLL_DURATION);

	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);

	const sink = new AudioSampleSink(track);

	// The decoder trims the pre-skip off the first packet, so the first sample starts after it
	let firstSampleTimestamp: number | null = null;
	for await (using sample of sink.samples()) {
		firstSampleTimestamp = sample.timestamp;
		break;
	}
	assert(firstSampleTimestamp !== null);
	expect(firstSampleTimestamp).toBeGreaterThan(firstPacket.timestamp);

	const timestamps = [
		firstPacket.timestamp,
		(firstPacket.timestamp + firstSampleTimestamp) / 2,
		firstSampleTimestamp,
		1,
	];
	const results: ({ timestamp: number; duration: number } | null)[] = [];
	for await (using sample of sink.samplesAtTimestamps(timestamps)) {
		results.push(sample && {
			timestamp: sample.timestamp,
			duration: sample.duration,
		});
	}

	// No sample starts at or before these
	expect(results[0]).toBe(null);
	expect(results[1]).toBe(null);

	expect(results[2]!.timestamp).toBe(firstSampleTimestamp);

	expect(results[3]!.timestamp).toBeLessThanOrEqual(1);
	expect(results[3]!.timestamp + results[3]!.duration).toBeGreaterThan(1);
});

test('Samples at timestamps come out while timestamps are still coming in', async () => {
	using input = new Input({
		source: new UrlSource('/glitch-hop-is-dead.wav'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetSink = new EncodedPacketSink(track);
	const firstPacket = await packetSink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await packetSink.getNextPacket(firstPacket);
	assert(secondPacket);

	// The timestamps only end once the first sample has come out, which hangs if the sink holds off decoding until
	// the run of consecutive packets is over
	const { promise: firstSampleReceived, resolve: onFirstSampleReceived } = promiseWithResolvers();
	const timestamps = async function* () {
		yield firstPacket.timestamp;
		yield secondPacket.timestamp;
		await firstSampleReceived;
	};

	const sink = new AudioSampleSink(track);
	const sampleTimestamps: number[] = [];
	for await (using sample of sink.samplesAtTimestamps(timestamps())) {
		assert(sample);
		sampleTimestamps.push(sample.timestamp);
		onFirstSampleReceived();
	}

	expect(sampleTimestamps).toEqual([firstPacket.timestamp, secondPacket.timestamp]);
});

test('AVC alpha side data is decoded', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new VideoSampleSource({
		codec: 'avc',
		quality: new Quality('high'),
		alpha: 'keep',
	});
	output.addVideoTrack(source);
	await output.start();

	const data = new Uint8Array(4 * 320 * 240);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 255;
		data[i + 3] = 128;
	}

	for (let i = 0; i < 3; i++) {
		using sample = new VideoSample(data, {
			format: 'RGBA',
			codedWidth: 320,
			codedHeight: 240,
			timestamp: i,
			duration: 1,
		});
		await source.add(sample);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track);
	let count = 0;
	for await (using sample of sink.samples()) {
		expect(sample.hasAlpha).toBe(true);
		count++;
	}

	expect(count).toBe(3);
});

test('Alpha merging is subject to backpressure', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// eslint-disable-next-line @typescript-eslint/unbound-method
	const originalMerge = ColorAlphaMerger.prototype.merge;
	let mergesInFlight = 0;
	let maxMergesInFlight = 0;
	ColorAlphaMerger.prototype.merge = async function (color, alpha) {
		mergesInFlight++;
		maxMergesInFlight = Math.max(maxMergesInFlight, mergesInFlight);

		try {
			return await originalMerge.call(this, color, alpha);
		} finally {
			mergesInFlight--;
		}
	};

	let count = 0;
	try {
		const sink = new VideoSampleSink(track);
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (using sample of sink.samples()) {
			count++;
		}
	} finally {
		ColorAlphaMerger.prototype.merge = originalMerge;
	}

	expect(count).toBe(541);
	// Without backpressure, the merging falls behind the decoding and nearly the entire video piles up in memory
	expect(maxMergesInFlight).toBeLessThan(32);
});

test('Samples merged behind a failed alpha merge are closed', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Fail the first merge only once a later merge is done, so that its sample is stuck waiting behind it
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const originalMerge = ColorAlphaMerger.prototype.merge;
	const mergedFrames: VideoFrame[] = [];
	let mergeCount = 0;
	ColorAlphaMerger.prototype.merge = async function (color, alpha) {
		if (mergeCount++ === 0) {
			color.close();
			alpha.close();

			while (mergedFrames.length === 0) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}

			throw new Error('Merge failed');
		}

		const frame = await originalMerge.call(this, color, alpha);
		mergedFrames.push(frame);
		return frame;
	};

	try {
		const iterator = new VideoSampleSink(track).samples();
		await expect(iterator.next()).rejects.toThrow('Merge failed');
	} finally {
		ColorAlphaMerger.prototype.merge = originalMerge;
	}

	// A closed frame has a null format
	await vi.waitFor(() => expect(mergedFrames.filter(frame => frame.format !== null)).toEqual([]));
});

test('Anamorphic BT.601 video with alpha', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	using opaqueSample = await getAnamorphicBt601Sample(track, false);
	using transparentSample = await getAnamorphicBt601Sample(track, true);

	expect(opaqueSample.hasAlpha).toBe(false);
	expect(transparentSample.hasAlpha).toBe(true);

	expect(opaqueSample.squarePixelWidth).toBe(2560);
	expect(transparentSample.squarePixelWidth).toBe(2560);
	expect(transparentSample.colorSpace.toJSON()).toEqual(opaqueSample.colorSpace.toJSON());
});

const getAnamorphicBt601Sample = async (track: InputVideoTrack, keepAlpha: boolean) => {
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	let meta: EncodedVideoChunkMetadata | undefined = {
		decoderConfig: {
			...decoderConfig,
			colorSpace: {
				primaries: 'smpte170m',
				transfer: 'smpte170m',
				matrix: 'smpte170m',
				fullRange: true,
			},
			displayAspectWidth: 2 * decoderConfig.codedWidth!,
			displayAspectHeight: decoderConfig.codedHeight!,
		},
	};
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(keepAlpha ? packet : packet.clone({ sideData: {} }), meta);
		meta = undefined;
	}
	await output.finalize();

	using remuxedInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const remuxedTrack = await remuxedInput.getPrimaryVideoTrack();
	assert(remuxedTrack);

	const sample = await new VideoSampleSink(remuxedTrack).getSample(0.5);
	assert(sample);

	return sample;
};

test('Decoder error while alpha merges are in flight', async () => {
	using input = new Input({
		source: new BufferSource(await createBrokenSemiTransparentVideo()),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const decodedFrames: VideoFrame[] = [];
	const OriginalVideoDecoder = VideoDecoder;
	globalThis.VideoDecoder = class extends OriginalVideoDecoder {
		constructor(init: VideoDecoderInit) {
			super({
				...init,
				output: (frame) => {
					decodedFrames.push(frame);
					init.output(frame);
				},
			});
		}
	};

	try {
		// The opaque frames queue up behind the transparent ones still being merged when the decoder errors out
		await expect(async () => {
			for await (using sample of new VideoSampleSink(track).samples()) {
				void sample;
			}
		}).rejects.toThrow('Decoding error');
	} finally {
		globalThis.VideoDecoder = OriginalVideoDecoder;
	}

	await new Promise(resolve => setTimeout(resolve, 500));
	expect(decodedFrames.filter(x => x.format !== null).map(x => x.timestamp)).toEqual([]);
});

const createBrokenSemiTransparentVideo = async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('high'),
		alpha: 'keep',
	});
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 16; i++) {
		using sample = new VideoSample(new Uint8Array(64 * 64 * 4).fill(128), {
			format: i % 2 === 0 ? 'RGBA' : 'RGBX',
			codedWidth: 64,
			codedHeight: 64,
			timestamp: i,
			duration: 1,
		});
		await source.add(sample);
	}
	await output.finalize();

	return replacePacket(output.target.buffer!, 10, packet => packet.clone({ data: new Uint8Array(64).fill(0xff) }));
};

test('Invisible VP8 frame followed by a seek', async () => {
	using input = new Input({
		source: new BufferSource(await createVp8VideoWithInvisibleFrame()),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Each timestamp lies in a different key frame interval. The frame at 0.3 is never shown, so the one before it
	// answers that query.
	const timestamps: (number | null)[] = [];
	for await (using sample of new VideoSampleSink(track).samplesAtTimestamps([0.3, 1.5, 2.5])) {
		timestamps.push(sample?.timestamp ?? null);
	}

	expect(timestamps).toEqual([0.2, 1.5, 2.5]);
});

const createVp8VideoWithInvisibleFrame = async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({
		codec: 'vp8',
		quality: new Quality('high'),
		keyFrameInterval: 1,
	});
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 30; i++) {
		using sample = new VideoSample(new Uint8Array(64 * 64 * 4).fill(8 * i), {
			format: 'RGBX',
			codedWidth: 64,
			codedHeight: 64,
			timestamp: i / 10,
			duration: 1 / 10,
		});
		await source.add(sample);
	}
	await output.finalize();

	// Clearing the show_frame bit makes the decoder decode the frame without ever outputting it
	return replacePacket(output.target.buffer!, 3, (packet) => {
		const data = packet.data.slice();
		data[0] = data[0]! & ~0x10;
		return packet.clone({ data });
	});
};

const replacePacket = async (
	buffer: ArrayBuffer,
	index: number,
	replace: (packet: EncodedPacket) => EncodedPacket,
) => {
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const codec = await track.getCodec();
	assert(codec);

	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource(codec);
	output.addVideoTrack(source);
	await output.start();

	let meta: EncodedVideoChunkMetadata | undefined = { decoderConfig: (await track.getDecoderConfig())! };
	let packetIndex = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packetIndex === index ? replace(packet) : packet, meta);
		meta = undefined;
		packetIndex++;
	}
	await output.finalize();

	return output.target.buffer!;
};
