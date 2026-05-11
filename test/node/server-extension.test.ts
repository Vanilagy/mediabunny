import { beforeAll, describe, expect, test } from 'vitest';
import { registerMediabunnyServer } from '@mediabunny/server';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, last, toUint8Array } from '../../src/misc.js';
import { AudioSampleSink, EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';
import { NodeAvVideoDecoder } from '../../packages/server/src/video-decoder.js';
import { NodeAvVideoEncoder } from '../../packages/server/src/video-encoder.js';
import { NodeAvAudioDecoder } from '../../packages/server/src/audio-decoder.js';
import { NodeAvAudioEncoder } from '../../packages/server/src/audio-encoder.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { AudioCodec, buildAudioCodecString, buildVideoCodecString, VideoCodec } from '../../src/codec.js';
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
import { NodeAvFrameAudioSampleResource } from '../../packages/server/src/audio-sample.js';

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

		const encodedPackets: EncodedPacket[] = [];
		const sampleTimestamps: number[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedVideoChunkMetadata) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(encodedPackets.length ? 'delta' : 'key');

			if (encodedPackets.length === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('avc1.')).toBe(true);
				expect(meta.decoderConfig!.codedWidth).toBe(1280);
				expect(meta.decoderConfig!.codedHeight).toBe(720);
				expect(meta.decoderConfig!.description).toBeDefined();
			}

			encodedPackets.push(packet);
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

		expect(encodedPackets).toHaveLength(10);

		let sortedTimestamps = encodedPackets.map(x => x.timestamp).sort((a, b) => a - b);
		expect(sortedTimestamps).toEqual(sampleTimestamps);

		// And, go again
		encodedPackets.length = 0;
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

		expect(encodedPackets).toHaveLength(10);

		sortedTimestamps = encodedPackets.map(x => x.timestamp).sort((a, b) => a - b);
		expect(sortedTimestamps).toEqual(sampleTimestamps);

		await encoder.close();
	});

	test('Forced key frame encode', async () => {
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

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket) => {
			expect(packet.type).toBe(packetCount % 2 ? 'delta' : 'key');
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

			await encoder.encode(sample, { keyFrame: i % 2 === 0 });
		}

		await encoder.flush();
		await encoder.close();
	});

	test('AVC encode and decode, length-prefixed', async () => {
		await encodeDecodeTest('avc', {}, async (packet, meta, i) => {
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

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('AVC encode and decode, Annex B', async () => {
		await encodeDecodeTest('avc', { avc: { format: 'annexb' } }, async (packet, meta, i) => {
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

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('HEVC encode and decode, length-prefixed', async () => {
		await encodeDecodeTest('hevc', {}, async (packet, meta, i) => {
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

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBe(255); // White
		});
	});

	test('HEVC encode and decode, Annex B', async () => {
		// @ts-expect-error Fucky types
		await encodeDecodeTest('hevc', { hevc: { format: 'annexb' } }, async (packet, meta, i) => {
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

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBe(255); // White
		});
	});

	test('VP8 encode and decode', async () => {
		await encodeDecodeTest('vp8', {}, async (packet, meta, i) => {
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

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('VP9 encode and decode, opaque', async () => {
		await encodeDecodeTest('vp9', {}, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect(packet.sideData.alpha).toBeUndefined();

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

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBX' }));
			await sample.copyTo(buf, { format: 'RGBX' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white
		});
	});

	test('VP9 encode and decode, transparent', async () => {
		await encodeDecodeTest('vp9', { alpha: 'keep' }, async (packet, meta, i) => {
			expect(packet.duration).toBe(1 / 30);
			expect(packet.type).toBe(i ? 'delta' : 'key');
			expect(packet.sideData.alpha).toBeDefined();
			expect(packet.sideData.alpha!.byteLength).toBeGreaterThan(0);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec.startsWith('vp09.')).toBe(true);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample, i) => {
			expect(sample.format).toBe('I420A');
			expect(sample.codedWidth).toBe(1280);
			expect(sample.codedHeight).toBe(720);
			expect(sample.timestamp).toBe(i / 30);
			expect(sample.duration).toBe(1 / 30);

			const buf = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
			await sample.copyTo(buf, { format: 'RGBA' });

			expect(buf[0]).toBeGreaterThan(250); // Quasi-white

			// Check transparency
			expect(Math.abs(buf[3]! - 0x80)).toBeLessThan(3);
		}, true);
	});

	test('AV1 encode and decode', async () => {
		await encodeDecodeTest('av1', {}, async (packet, meta, i) => {
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
		transparent = false,
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
		if (transparent) {
			for (let i = 0; i < data.byteLength; i += 4) {
				data[i + 3] = 0x80;
			}
		}

		for (let i = 0; i < 10; i++) {
			using sample = new VideoSample(data, {
				format: transparent ? 'RGBA' : 'RGBX',
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

		const sortedTimestamps = packets.map(x => x.timestamp).sort((a, b) => a - b);
		expect(sortedTimestamps).toEqual(sampleTimestamps);

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

	test('AVC conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('avc');
	});

	test('HEVC conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('hevc');
	});

	test('VP8 conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('vp8');
	});

	test('VP9 conversion roundtrip', { timeout: 20_000 }, async () => {
		await conversionRoundtrip('vp9');
	});

	test('AV1 conversion roundtrip', { timeout: 20_000 }, async () => {
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

		expect(sample._data).toBeInstanceOf(NodeAvFrameVideoSampleResource);
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

	describe('VideoSample transformation', () => {
		// 400x400 image: red everywhere, with a 200x200 blue square filling the bottom-left quadrant.
		const TEST_IMAGE = (() => {
			const buf = new Uint8Array(400 * 400 * 4);
			for (let i = 0; i < 400 * 400; i++) {
				buf[i * 4] = 255;
				buf[i * 4 + 1] = 0;
				buf[i * 4 + 2] = 0;
				buf[i * 4 + 3] = 255;
			}
			for (let y = 200; y < 400; y++) {
				for (let x = 0; x < 200; x++) {
					const i = y * 400 + x;
					buf[i * 4] = 0;
					buf[i * 4 + 1] = 0;
					buf[i * 4 + 2] = 255;
					buf[i * 4 + 3] = 255;
				}
			}
			return buf;
		})();

		const makeSample = () => new VideoSample(TEST_IMAGE, {
			format: 'RGBA',
			codedWidth: 400,
			codedHeight: 400,
			timestamp: 0,
		});

		const readRgba = async (sample: VideoSample) => {
			const buffer = new Uint8Array(sample.codedWidth * sample.codedHeight * 4);
			await sample.copyTo(buffer, { format: 'RGBA' });
			return buffer;
		};

		const getColorAt = (rgba: Uint8Array, width: number, x: number, y: number) => {
			const i = (y * width + x) * 4;
			return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
		};

		const expectColor = (actual: number[], expected: number[], tolerance = 4) => {
			for (let i = 0; i < 3; i++) {
				expect(
					Math.abs(actual[i]! - expected[i]!),
					`channel ${i}: got ${actual[i]}, expected ${expected[i]} (+/-${tolerance})`,
				).toBeLessThanOrEqual(tolerance);
			}
		};

		test('resize to 200x200', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 200, height: 200, fit: 'fill' });

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [255, 0, 0]); // top-left
			expectColor(getColorAt(rgba, 200, 150, 50), [255, 0, 0]); // top-right
			expectColor(getColorAt(rgba, 200, 50, 150), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 200, 150, 150), [255, 0, 0]); // bottom-right
		});

		test('rotate 90 deg clockwise', async () => {
			using sample = makeSample();
			using result = await sample.transform({ rotate: 90 });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(400);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [0, 0, 255]); // top-left (blue)
			expectColor(getColorAt(rgba, 400, 350, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 50, 350), [255, 0, 0]);
			expectColor(getColorAt(rgba, 400, 350, 350), [255, 0, 0]);
		});

		test('crop top-left, no rotation', async () => {
			using sample = makeSample();
			using result = await sample.transform({ crop: { left: 0, top: 0, width: 200, height: 200 } });

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 200, 150, 50), [255, 0, 0]);
			expectColor(getColorAt(rgba, 200, 50, 150), [255, 0, 0]);
			expectColor(getColorAt(rgba, 200, 150, 150), [255, 0, 0]);
		});

		test('rotate 90 deg then crop top-left, crop applies after rotation', async () => {
			using sample = makeSample();
			using result = await sample.transform({
				rotate: 90,
				crop: { left: 0, top: 0, width: 200, height: 200 },
			});

			expect(result.codedWidth).toBe(200);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 200, 50, 50), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 150, 50), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 50, 150), [0, 0, 255]);
			expectColor(getColorAt(rgba, 200, 150, 150), [0, 0, 255]);
		});

		test('resize to 400x200 with fill, vertically squished', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 400, height: 200, fit: 'fill' });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]); // top-left
			expectColor(getColorAt(rgba, 400, 300, 50), [255, 0, 0]); // top-right
			expectColor(getColorAt(rgba, 400, 50, 175), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 400, 300, 175), [255, 0, 0]); // bottom-right
		});

		test('resize to 400x200 with contain, letterboxed', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 400, height: 200, fit: 'contain' });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 100), [0, 0, 0]); // left letterbox
			expectColor(getColorAt(rgba, 400, 350, 100), [0, 0, 0]); // right letterbox
			expectColor(getColorAt(rgba, 400, 150, 50), [255, 0, 0]); // top-left of image (red)
			expectColor(getColorAt(rgba, 400, 150, 150), [0, 0, 255]); // bottom-left of image (blue)
			expectColor(getColorAt(rgba, 400, 250, 150), [255, 0, 0]); // bottom-right of image (red)
		});

		test('resize to 400x200 with cover, vertical center crop', async () => {
			using sample = makeSample();
			using result = await sample.transform({ width: 400, height: 200, fit: 'cover' });

			expect(result.codedWidth).toBe(400);
			expect(result.codedHeight).toBe(200);

			const rgba = await readRgba(result);
			expectColor(getColorAt(rgba, 400, 50, 50), [255, 0, 0]); // top-left (red)
			expectColor(getColorAt(rgba, 400, 350, 50), [255, 0, 0]); // top-right (red)
			expectColor(getColorAt(rgba, 400, 50, 150), [0, 0, 255]); // bottom-left (blue)
			expectColor(getColorAt(rgba, 400, 350, 150), [255, 0, 0]); // bottom-right (red)
		});

		test('VideoSample transformation via Conversion API', async () => {
			using input = new Input({
				source: new FilePathSource('./test/public/video.mp4'),
				formats: ALL_FORMATS,
			});

			const output = new Output({
				format: new Mp4OutputFormat(),
				target: new BufferTarget(),
			});

			const conversion = await Conversion.init({
				input,
				output,
				video: {
					width: 300,
					height: 300,
					fit: 'contain',
				},
			});
			await conversion.execute();
		});
	});
});

describe('Audio', async () => {
	test('Decoder lifecycle', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/trim-buck-bunny-ffmpeg.ts'),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const decoder = new NodeAvAudioDecoder();
		// @ts-expect-error Readonly
		decoder.codec = await audioTrack.getCodec();
		// @ts-expect-error Readonly
		decoder.config = await audioTrack.getDecoderConfig();

		let sampleCount = 0;
		const packetTimestamps: number[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: AudioSample) => {
			expect(sample.timestamp).toBe(packetTimestamps[sampleCount]);

			if (sampleCount > 0) {
				expect(sample.duration).toBeCloseTo(
					packetTimestamps[sampleCount]! - packetTimestamps[sampleCount - 1]!,
				);
			}

			sampleCount++;
			sample.close();
		};

		await decoder.init();

		const sink = new EncodedPacketSink(audioTrack);
		let packetCount = 0;
		for await (const packet of sink.packets()) {
			packetTimestamps.push(packet.timestamp);
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
		for await (const packet of sink.packets((await sink.getKeyPacket(5))!)) {
			packetTimestamps.push(packet.timestamp);
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
		const encoder = new NodeAvAudioEncoder();
		// @ts-expect-error Readonly
		encoder.codec = 'aac';
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildAudioCodecString('aac', 2, 48000),
			numberOfChannels: 2,
			sampleRate: 48000,
			bitrate: 128000,
		} satisfies AudioEncoderConfig;

		let packetCount = 0;

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedAudioChunkMetadata) => {
			expect(packet.duration).toBe(1024 / 48000);
			expect(packet.type).toBe('key');

			if (packetCount === 0) {
				expect(packet.timestamp).toBe(0);

				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp4a.40.2');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig?.description).toBeDefined();
			}

			packetCount++;
		};

		await encoder.init();

		const data = createF32SineWave(48000, 2, 2);
		using sample1 = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		await encoder.encode(sample1);

		await encoder.flush();

		const minPacketCount = 2 * 48000 / 1024;
		expect(packetCount).toBeGreaterThan(minPacketCount);

		packetCount = 0;

		using sample2 = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0,
			numberOfChannels: 2,
			sampleRate: 48000,
		});
		await encoder.encode(sample2);

		await encoder.flush();

		expect(packetCount).toBeGreaterThan(minPacketCount);

		await encoder.close();
	});

	const createF32SineWave = (sampleRate: number, channels: number, durationSeconds: number) => {
		const totalFrames = sampleRate * durationSeconds;
		const data = new Float32Array(totalFrames * channels);

		for (let i = 0; i < totalFrames; i++) {
			const value = Math.sin(2 * Math.PI * 440 * i / sampleRate);
			for (let ch = 0; ch < channels; ch++) {
				data[i * channels + ch] = value;
			}
		}

		return data;
	};

	test('AAC encode & decode, AAC format', async () => {
		await encodeDecodeTest('aac', {
			// @ts-expect-error Fucky type
			aac: { format: 'aac' },
		}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');
			expect(packet.duration).toBe(1024 / 48000);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp4a.40.2');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
			}
		}, async (sample) => {
			expect(sample.duration).toBe(1024 / 48000);
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
		});
	});

	test('AAC encode & decode, ADTS format', async () => {
		await encodeDecodeTest('aac', {
			// @ts-expect-error Fucky type
			aac: { format: 'adts' },
		}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');
			expect(packet.duration).toBe(1024 / 48000);
			expect(packet.data[0]).toBe(0xff);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp4a.40.2');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.duration).toBe(1024 / 48000);
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
		});
	});

	test('Opus encode & decode', async () => {
		await encodeDecodeTest('opus', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(0.02);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('opus');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect([...toUint8Array(meta.decoderConfig!.description!).slice(0, 8)]).toEqual([
					// OpusHead
					0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
				]);
			}
		}, async (sample, i, n) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);

			if (i > 0 && i < n - 1) {
				expect(sample.duration).toBe(0.02);
			}
		});
	});

	test('MP3 encode & decode', async () => {
		await encodeDecodeTest('mp3', {}, async (packet, meta, i, n) => {
			expect(packet.type).toBe('key');

			if (i < n - 1) {
				expect(packet.duration).toBe(1152 / 48000);
			}

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('mp3');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(1152 / 48000);
		});
	});

	test('Vorbis encode & decode', async () => {
		await encodeDecodeTest('vorbis', {}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('vorbis');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect(toUint8Array(meta.decoderConfig!.description!)[0]).toBe(2); // "Xiph extradata format"
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
		});
	});

	test('FLAC encode & decode', async () => {
		await encodeDecodeTest('flac', {}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');
			expect(packet.duration).toBe(0.096);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('flac');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeDefined();
				expect([...toUint8Array(meta.decoderConfig!.description!).slice(0, 4)]).toEqual([
					// fLaC
					0x66, 0x4c, 0x61, 0x43,
				]);
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(0.096);
		});
	});

	test('AC-3 encode & decode', async () => {
		await encodeDecodeTest('ac3', {}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');
			expect(packet.duration).toBe(0.032);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('ac-3');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(0.032);
		});
	});

	test('E-AC-3 encode & decode', async () => {
		await encodeDecodeTest('eac3', {}, async (packet, meta, i) => {
			expect(packet.type).toBe('key');
			expect(packet.duration).toBe(0.032);

			if (i === 0) {
				expect(meta.decoderConfig).toBeDefined();
				expect(meta.decoderConfig!.codec).toBe('ec-3');
				expect(meta.decoderConfig!.numberOfChannels).toBe(2);
				expect(meta.decoderConfig!.sampleRate).toBe(48000);
				expect(meta.decoderConfig!.description).toBeUndefined();
			}
		}, async (sample) => {
			expect(sample.numberOfChannels).toBe(2);
			expect(sample.sampleRate).toBe(48000);
			expect(sample.duration).toBe(0.032);
		});
	});

	const encodeDecodeTest = async (
		codec: AudioCodec,
		extraConfig: Partial<AudioEncoderConfig>,
		onPacket: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata, i: number, n: number) => Promise<void>,
		onSample: (sample: AudioSample, i: number, n: number) => Promise<void>,
	) => {
		const sampleRate = 48000;
		const numberOfChannels = 2;

		const encoder = new NodeAvAudioEncoder();
		// @ts-expect-error Readonly
		encoder.codec = codec;
		// @ts-expect-error Readonly
		encoder.config = {
			codec: buildAudioCodecString(codec, numberOfChannels, sampleRate),
			numberOfChannels,
			sampleRate,
			bitrate: 128000,
			...extraConfig,
		} satisfies AudioEncoderConfig;

		const packets: EncodedPacket[] = [];
		const metas: EncodedAudioChunkMetadata[] = [];

		// @ts-expect-error Readonly
		encoder.onPacket = (packet: EncodedPacket, meta: EncodedAudioChunkMetadata) => {
			packets.push(packet);
			metas.push(meta);
		};

		await encoder.init();

		const data = createF32SineWave(sampleRate, numberOfChannels, 2);
		using inputSample = new AudioSample({
			data,
			format: 'f32',
			timestamp: 0,
			numberOfChannels,
			sampleRate,
		});
		await encoder.encode(inputSample);

		await encoder.flush();

		for (let i = 0; i < packets.length; i++) {
			await onPacket(packets[i]!, metas[i]!, i, packets.length);
		}

		const decoder = new NodeAvAudioDecoder();
		// @ts-expect-error Readonly
		decoder.codec = codec;
		// @ts-expect-error Readonly
		decoder.config = metas[0]!.decoderConfig!;

		const decodedSamples: AudioSample[] = [];

		// @ts-expect-error Readonly
		decoder.onSample = (sample: AudioSample) => {
			decodedSamples.push(sample);
		};

		await decoder.init();

		for (const packet of packets) {
			await decoder.decode(packet);
		}

		await decoder.flush();

		expect(decodedSamples.length).toBeGreaterThan(0);
		expect(last(decodedSamples)!.timestamp + last(decodedSamples)!.duration).toBeGreaterThanOrEqual(2);

		for (let i = 0; i < decodedSamples.length; i++) {
			await onSample(decodedSamples[i]!, i, decodedSamples.length);
		}

		const signalChunks: Float32Array[] = [];

		for (const sample of decodedSamples) {
			const buf = new Float32Array(new ArrayBuffer(sample.allocationSize({
				format: 'f32-planar', planeIndex: 0,
			})));
			sample.copyTo(buf, { format: 'f32-planar', planeIndex: 0 });
			signalChunks.push(buf);

			sample.close();
		}

		const totalSize = signalChunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const signal = new Float32Array(totalSize);
		let offset = 0;
		for (const chunk of signalChunks) {
			signal.set(chunk, offset);
			offset += chunk.length;
		}

		const score = sine440Score(signal, sampleRate, 440);
		expect(score).toBeGreaterThan(0.98);

		await encoder.close();
		await decoder.close();
	};

	const sine440Score = (x: Float32Array, sampleRate: number, freq: number) => {
		const w = 2 * Math.PI * freq / sampleRate;

		let ss = 0, cc = 0, sc = 0;
		let xs = 0, xc = 0;
		let xx = 0;

		for (let n = 0; n < x.length; n++) {
			const s = Math.sin(w * n);
			const c = Math.cos(w * n);

			ss += s * s;
			cc += c * c;
			sc += s * c;

			xs += x[n]! * s;
			xc += x[n]! * c;
			xx += x[n]! * x[n]!;
		}

		const det = ss * cc - sc * sc;

		const a = (xs * cc - xc * sc) / det;
		const b = (xc * ss - xs * sc) / det;

		let fitEnergy = 0;

		for (let n = 0; n < x.length; n++) {
			const y = a * Math.sin(w * n) + b * Math.cos(w * n);
			fitEnergy += y * y;
		}

		const score = fitEnergy / xx;
		return score;
	};

	test('AAC conversion roundtrip', async () => {
		await conversionRoundtrip('aac');
	});

	test('Opus conversion roundtrip', async () => {
		await conversionRoundtrip('opus');
	});

	test('MP3 conversion roundtrip', async () => {
		await conversionRoundtrip('mp3');
	});

	test('Vorbis conversion roundtrip', async () => {
		await conversionRoundtrip('vorbis');
	});

	test('FLAC conversion roundtrip', async () => {
		await conversionRoundtrip('flac');
	});

	test('AC-3 conversion roundtrip', async () => {
		await conversionRoundtrip('ac3');
	});

	test('E-AC-3 conversion roundtrip', async () => {
		await conversionRoundtrip('eac3');
	});

	const conversionRoundtrip = async (codec: AudioCodec) => {
		using input = new Input({
			source: new FilePathSource('./test/public/trim-buck-bunny-ffmpeg.ts'),
			formats: ALL_FORMATS,
		});

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const inputTrack = await input.getPrimaryAudioTrack();
		assert(inputTrack);

		const conversion = await Conversion.init({
			input,
			output,
			video: {
				discard: true,
			}, audio: {
				codec,
				forceTranscode: true,
			},
			trim: {
				start: 0,
			},
		});
		await conversion.execute();

		using newInput = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const newInputTrack = await newInput.getPrimaryAudioTrack();
		assert(newInputTrack);

		expect(await newInputTrack.getCodec()).toBe(codec);
		expect(await newInputTrack.computeDuration()).toBeCloseTo(await inputTrack.computeDuration(), 0);

		const sink = new AudioSampleSink(newInputTrack);

		let sampleCount = 0;
		for await (using sample of sink.samples()) {
			expect([await inputTrack.getNumberOfChannels(), 2].includes(sample.numberOfChannels)).toBe(true);
			expect(sample.sampleRate).toBe(await inputTrack.getSampleRate());

			sampleCount++;
		}

		expect(sampleCount).toBeGreaterThan(0);
	};

	test('Custom AudioSample resource', async () => {
		using input = new Input({
			source: new FilePathSource('./test/public/trim-buck-bunny-ffmpeg.ts'),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		const sink = new AudioSampleSink(audioTrack);
		using sample = await sink.getSample(await audioTrack.getFirstTimestamp());
		assert(sample);

		expect(sample._data).toBeInstanceOf(NodeAvFrameAudioSampleResource);
		expect(sample.format).toBe('f32-planar');
		expect(sample.numberOfChannels).toBe(6);
		expect(sample.sampleRate).toBe(48000);
		expect(sample.timestamp).toBe(await audioTrack.getFirstTimestamp());
		expect(sample.duration).toBe(1024 / 48000);
		expect(sample.numberOfFrames).toBe(1024);

		const size = sample.allocationSize({ planeIndex: 0 });
		expect(size).toBe(1024 * Float32Array.BYTES_PER_ELEMENT);

		// Test a bunch of copyTo()s:
		const buf = new ArrayBuffer(1e6);
		sample.copyTo(buf, { planeIndex: 0 });
		sample.copyTo(buf, { planeIndex: 1 });
		sample.copyTo(buf, { planeIndex: 2 });
		sample.copyTo(buf, { planeIndex: 3 });
		sample.copyTo(buf, { planeIndex: 4 });
		sample.copyTo(buf, { planeIndex: 5 });
		sample.copyTo(buf, { format: 'f32', planeIndex: 0 });
	});
});
