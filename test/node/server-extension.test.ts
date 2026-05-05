import { beforeAll, describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { NodeAvVideoDecoder } from '../../packages/server/src/video-decoder.js';
import { NodeAvVideoEncoder } from '../../packages/server/src/video-encoder.js';
import { VideoSample } from '../../src/sample.js';
import { buildVideoCodecString, VideoCodec } from '../../src/codec.js';
import { EncodedPacket } from '../../src/packet.js';
import {
	AvcNalUnitType,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
} from '../../src/codec-data.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { NodeAvFrameVideoSampleResource } from '../../packages/server/src/video-sample.js';

beforeAll(() => {
	registerMediabunnyServer();
});

describe('Video', async () => {
	test('Decoder lifecycle', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/video.mp4'),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		const decoder = new NodeAvVideoDecoder();
		// @ts-expect-error Readonly
		decoder.codec = await videoTrack.getCodec();
		// @ts-expect-error Readonly
		decoder.config = await videoTrack.getDecoderConfig();

		let sampleCount = 0;
		const packetTimestamps: number[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: VideoSample) => {
			expect(sample.timestamp).toBe(packetTimestamps[sampleCount]);
			expect(sample.duration).toBe(1 / 25);

			sampleCount++;
			sample.close();
		};

		await decoder.init();

		const sink = new EncodedPacketSink(videoTrack);
		let packetCount = 0;
		for await (const packet of sink.packets()) {
			packetTimestamps.push(packet.timestamp);
			packetTimestamps.sort((a, b) => a - b); // Because of B-frames
			await decoder.decode(packet);

			if (++packetCount === 10) {
				break;
			}
		}

		await decoder.flush();

		expect(sampleCount).toBe(10);

		// And, go again
		sampleCount = 0;
		packetTimestamps.length = 0;

		packetCount = 0;
		for await (const packet of sink.packets((await sink.getKeyPacket(2))!)) {
			packetTimestamps.push(packet.timestamp);
			packetTimestamps.sort((a, b) => a - b); // Because of B-frames
			await decoder.decode(packet);

			if (++packetCount === 10) {
				break;
			}
		}

		await decoder.flush();

		expect(sampleCount).toBe(10);

		await decoder.close();
	});

	test('Encoder lifecycle', async () => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'avc';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString('avc', 1280, 720, 1e6),
			width: 1280,
			height: 720,
			bitrate: 1e6,
		} satisfies VideoEncoderConfig;

		let packetCount = 0;
		const sampleTimestamps: number[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			expect(packet.timestamp).toBe(sampleTimestamps[packetCount]);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(packetCount ? 'delta' : 'key');

			if (packetCount === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.colorSpace).toEqual({
					primaries: 'bt709',
					transfer: 'iec61966-2-1',
					matrix: 'rgb',
					fullRange: true,
				});
				expect(meta.decoderConfig!.description).toBeDefined();
			}

			packetCount++;
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(packetCount).toBe(10);

		packetCount = 0;
		sampleTimestamps.length = 0;

		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(packetCount).toBe(10);

		await encoder.close();
	});

	test('AVC encode and decode, length-prefixed', async () => {
		await encodeDecodeTest('avc', {}, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]);

			for (const loc of iterateNalUnitsInLengthPrefixed(packet.data, 4)) {
				const naluType = extractNalUnitTypeForAvc(packet.data[loc.offset]!);
				// These have been stripped
				expect(
					naluType !== AvcNalUnitType.SPS
					&& naluType !== AvcNalUnitType.PPS
					&& naluType !== AvcNalUnitType.SPS_EXT,
				).toBe(true);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect(toUint8Array(meta.decoderConfig!.description!)[0]).toBe(1); // configurationVersion
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);
			expect(sample.colorSpace).toEqual({
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				matrix: 'rgb',
				fullRange: true,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('AVC encode and decode, Annex B', async () => {
		await encodeDecodeTest('avc', { avc: { format: 'annexb' } }, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

			if (i === 0) {
				// In Annex B there's no description, so SPS/PPS are inlined into the keyframe
				const naluTypes: number[] = [];
				for (const loc of iterateNalUnitsInAnnexB(packet.data)) {
					naluTypes.push(extractNalUnitTypeForAvc(packet.data[loc.offset]!));
				}
				expect(naluTypes).toContain(AvcNalUnitType.SPS);
				expect(naluTypes).toContain(AvcNalUnitType.PPS);

				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);
			expect(sample.colorSpace).toEqual({
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				matrix: 'rgb',
				fullRange: true,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('HEVC encode and decode, length-prefixed', async () => {
		await encodeDecodeTest('hevc', {}, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]);

			for (const loc of iterateNalUnitsInLengthPrefixed(packet.data, 4)) {
				const naluType = extractNalUnitTypeForHevc(packet.data[loc.offset]!);
				// These have been stripped
				expect(
					naluType !== HevcNalUnitType.SPS_NUT
					&& naluType !== HevcNalUnitType.PPS_NUT
					&& naluType !== HevcNalUnitType.VPS_NUT,
				).toBe(true);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('hev1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect(toUint8Array(meta.decoderConfig!.description!)[0]).toBe(1); // configurationVersion
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			// Undefined, for some reason:
			expect(sample.colorSpace).toEqual({
				primaries: null,
				transfer: null,
				matrix: null,
				fullRange: false,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBe(255); // White
		});
	});

	test('HEVC encode and decode, Annex B', async () => {
		// @ts-expect-error Fucky types
		await encodeDecodeTest('hevc', { hevc: { format: 'annexb' } }, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect([...packet.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

			if (i === 0) {
				// In Annex B there's no description, so VPS/SPS/PPS are inlined into the keyframe
				const naluTypes: number[] = [];
				for (const loc of iterateNalUnitsInAnnexB(packet.data)) {
					naluTypes.push(extractNalUnitTypeForHevc(packet.data[loc.offset]!));
				}
				expect(naluTypes).toContain(HevcNalUnitType.VPS_NUT);
				expect(naluTypes).toContain(HevcNalUnitType.SPS_NUT);
				expect(naluTypes).toContain(HevcNalUnitType.PPS_NUT);

				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('hev1.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			// Undefined, for some reason:
			expect(sample.colorSpace).toEqual({
				primaries: null,
				transfer: null,
				matrix: null,
				fullRange: false,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBe(255); // White
		});
	});

	test('VP8 encode and decode', async () => {
		await encodeDecodeTest('vp8', {}, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('vp8');
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);
			expect(sample.colorSpace).toEqual({
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				matrix: 'bt470bg',
				fullRange: false,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('VP9 encode and decode', async () => {
		await encodeDecodeTest('vp9', {}, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('vp09.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);
			expect(sample.colorSpace).toEqual({
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				matrix: null,
				fullRange: false,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('AV1 encode and decode', async () => {
		await encodeDecodeTest('av1', {}, async (packet, meta, i) => {
			expect(packet.timestamp).toBe(i / 30);
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('av01.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);
			expect(sample.colorSpace).toEqual({
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				matrix: 'rgb',
				fullRange: false,
			});

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('Non-square pixels encode and decode #1', async () => {
		await encodeDecodeTest('avc', { displayWidth: 2 * 1280, displayHeight: 720 }, async (packet, meta, i) => {
			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.displayAspectWidth).toBe(2 * 1280);
				expect(meta.decoderConfig!.displayAspectHeight).toBe(720);
			}
		}, async (sample) => {
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.squarePixelWidth).toBe(2 * 1280);
			expect(sample.squarePixelHeight).toBe(720);
		});
	});

	test('Non-square pixels encode and decode #2', async () => {
		await encodeDecodeTest('avc', { displayWidth: 1280, displayHeight: 2 * 720 }, async (packet, meta, i) => {
			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.displayAspectWidth).toBe(1280);
				expect(meta.decoderConfig!.displayAspectHeight).toBe(2 * 720);
			}
		}, async (sample) => {
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.squarePixelWidth).toBe(1280);
			expect(sample.squarePixelHeight).toBe(2 * 720);
		});
	});

	const encodeDecodeTest = async (
		codec: VideoCodec,
		extraConfig: Partial<VideoEncoderConfig>,
		onPacket: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata, i: number) => Promise<void>,
		onSample: (sample: VideoSample, i: number) => Promise<void>,
	) => {
		const encoder = new NodeAvVideoEncoder();
		// @ts-expect-error Readonly
		encoder.codec = codec;
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildVideoCodecString(codec, 1280, 720, 1e6),
			width: 1280,
			height: 720,
			bitrate: 1e6,
			...extraConfig,
		} satisfies VideoEncoderConfig;

		const sampleTimestamps: number[] = [];
		const packets: EncodedPacket[] = [];
		const metas: EncodedVideoChunkMetadata[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			packets.push(packet);
			metas.push(meta);
		};

		await encoder.init();

		const data = new Uint8Array(1280 * 720 * 4).fill(0xff); // White
		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: 'RGBX',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: i / 30,
				duration: 1 / 30,
			});

			sampleTimestamps.push(sample.timestamp);

			await encoder.encode(sample, {});
		}

		await encoder.flush();

		expect(packets).toHaveLength(10);

		for (let i = 0; i < packets.length; i++) {
			await onPacket(packets[i]!, metas[i]!, i);
		}

		const decoder = new NodeAvVideoDecoder();
		// @ts-expect-error Readonly
		decoder.codec = codec;
		// @ts-expect-error Readonly
		decoder.config = metas[0]!.decoderConfig!;

		const decodedSamples: VideoSample[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: VideoSample) => {
			decodedSamples.push(sample);
		};

		await decoder.init();

		for (const packet of packets) {
			await decoder.decode(packet);
		}

		await decoder.flush();

		expect(decodedSamples).toHaveLength(10);

		for (using sample of decodedSamples) {
			await onSample(sample, decodedSamples.indexOf(sample));
		}
	};

	test('AVC conversion roundtrip', { timeout: 10_000 }, async () => {
		await conversionRoundtrip('avc');
	});

	test('HEVC conversion roundtrip', { timeout: 10_000 }, async () => {
		await conversionRoundtrip('hevc');
	});

	test('VP8 conversion roundtrip', { timeout: 10_000 }, async () => {
		await conversionRoundtrip('vp8');
	});

	test('VP9 conversion roundtrip', { timeout: 10_000 }, async () => {
		await conversionRoundtrip('vp9');
	});

	test('AV1 conversion roundtrip', { timeout: 10_000 }, async () => {
		await conversionRoundtrip('av1');
	});

	const conversionRoundtrip = async (codec: VideoCodec) => {
		using input = new Input({
			source: new FilePathSource('./test/public/video.mp4'),
			formats: ALL_FORMATS,
		});

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const inputTrack = await input.getPrimaryVideoTrack();
		assert(inputTrack);

		const packetTimestamps: number[] = [];
		const packetSink = new EncodedPacketSink(inputTrack);

		for await (const packet of packetSink.packets()) {
			packetTimestamps.push(packet.timestamp);
		}

		packetTimestamps.sort((a, b) => a - b);

		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec,
				forceTranscode: true,
			}, audio: {
				discard: true,
			},
		});
		await conversion.execute();

		using newInput = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const newInputTrack = await newInput.getPrimaryVideoTrack();
		assert(newInputTrack);

		expect(await newInputTrack.getCodec()).toBe(codec);

		const sink = new VideoSampleSink(newInputTrack);

		let sampleCount = 0;
		for await (using sample of sink.samples()) {
			expect(sample.codedWidth).toBe(await inputTrack.getCodedWidth());
			expect(sample.codedHeight).toBe(await inputTrack.getCodedHeight());
			expect(sample.timestamp).toBe(packetTimestamps[sampleCount]);

			sampleCount++;
		}

		expect(sampleCount).toBe(packetTimestamps.length);
	};

	test('Custom VideoSample resource', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/video.mp4'),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		const sink = new VideoSampleSink(videoTrack);
		using sample = await sink.getSample(0);
		assert(sample);

		expect(sample.getUnderlyingData()).toBeInstanceOf(NodeAvFrameVideoSampleResource);
		expect(sample.format).toBe('I420');
		expect(sample.codedWidth).toBe(1920);
		expect(sample.codedHeight).toBe(1080);
		expect(sample.squarePixelWidth).toBe(1920);
		expect(sample.squarePixelHeight).toBe(1080);
		expect(sample.displayWidth).toBe(1920);
		expect(sample.displayHeight).toBe(1080);
		expect(sample.visibleRect).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1080,
		});
		expect(sample.rotation).toBe(0);
		expect(sample.timestamp).toBe(0);
		expect(sample.duration).toBe(1 / 25);
		expect(sample.colorSpace).toEqual({
			primaries: null,
			transfer: null,
			matrix: 'bt470bg',
			fullRange: true,
		});

		// Default expected YUV size
		expect(sample.allocationSize()).toBe(1920 * 1080 * 1.5);
		// This is the same
		expect(sample.allocationSize({ format: 'I420' })).toBe(1920 * 1080 * 1.5);
		// Expected RGBA size
		expect(sample.allocationSize({ format: 'RGBA' })).toBe(1920 * 1080 * 4);
		// Can't convert to a non-RGBA format
		expect(() => sample.allocationSize({ format: 'NV12' })).toThrow('Invalid destination format');
		// Default YUV layout
		expect(sample.allocationSize({ layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		] })).toBe(1920 * 1080 * 1.5);
		// Custom YUV layout
		expect(sample.allocationSize({ layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1000 },
			{ offset: 1920 * 1080 + (1000) * (1080 / 2), stride: 1920 / 2 },
		] })).toBe(1920 * 1080 + (1000) * (1080 / 2) + (1920 / 2) * (1080 / 2));
		// Default RGBA layout
		expect(sample.allocationSize({ format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 4 },
		] })).toBe(1920 * 1080 * 4);
		// Custom RGBA layout
		expect(sample.allocationSize({ format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 5 },
		] })).toBe(1920 * 1080 * 5);
		// Subrect with YUV
		expect(sample.allocationSize({ rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toBe(400 * 200 * 1.5);
		// Subrect with RGBA
		expect(sample.allocationSize({ format: 'RGBA', rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toBe(400 * 200 * 4);

		const buffer = new ArrayBuffer(1920 * 1080 * 5);

		// Default YUV layout
		expect(await sample.copyTo(buffer)).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		]);
		// This is the same
		expect(await sample.copyTo(buffer, { format: 'I420' })).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		]);
		// Default RGBA layout
		expect(await sample.copyTo(buffer, { format: 'RGBA' })).toEqual([
			{ offset: 0, stride: 1920 * 4 },
		]);
		// Can't convert to a non-RGBA format
		await expect(sample.copyTo(buffer, { format: 'NV12' })).rejects.toThrow('Invalid destination format');
		// Explicit default YUV layout
		expect(await sample.copyTo(buffer, { layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		] })).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 / 2 },
			{ offset: 1920 * 1080 + (1920 / 2) * (1080 / 2), stride: 1920 / 2 },
		]);
		// Custom YUV layout
		expect(await sample.copyTo(buffer, { layout: [
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1000 },
			{ offset: 1920 * 1080 + (1000) * (1080 / 2), stride: 1920 / 2 },
		] })).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1000 },
			{ offset: 1920 * 1080 + (1000) * (1080 / 2), stride: 1920 / 2 },
		]);
		// Explicit default RGBA layout
		expect(await sample.copyTo(buffer, { format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 4 },
		] })).toEqual([
			{ offset: 0, stride: 1920 * 4 },
		]);
		// Custom RGBA layout
		expect(await sample.copyTo(buffer, { format: 'RGBA', layout: [
			{ offset: 0, stride: 1920 * 5 },
		] })).toEqual([
			{ offset: 0, stride: 1920 * 5 },
		]);
		// Subrect with YUV
		expect(await sample.copyTo(buffer, { rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toEqual([
			{ offset: 0, stride: 400 },
			{ offset: 400 * 200, stride: 400 / 2 },
			{ offset: 400 * 200 + (400 / 2) * (200 / 2), stride: 400 / 2 },
		]);
		// Subrect with RGBA
		expect(await sample.copyTo(buffer, { format: 'RGBA', rect: {
			x: 0,
			y: 0,
			width: 400,
			height: 200,
		} })).toEqual([
			{ offset: 0, stride: 400 * 4 },
		]);
	});
});
