import { afterEach, expect, test, vi } from 'vitest';
import { AudioCodec, buildVideoCodecString, extractVideoCodecString } from '../../src/codec.js';
import {
	addAvcBitstreamRestriction,
	concatNalUnitsInAnnexB,
	deserializeAvcDecoderConfigurationRecord,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractProresCodecInfoFromPacket,
	extractVp9CodecInfoFromPacket,
	parseAvcSps,
	parseHevcSps,
	serializeAvcDecoderConfigurationRecord,
	countShownVideoFrames,
} from '../../src/codec-data.js';
import { CustomAudioDecoder, registerDecoder } from '../../src/custom-coder.js';
import { canDecode, canDecodeAudio, canDecodeVideo } from '../../src/decode.js';
import { canEncodeVideo } from '../../src/encode.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { assert, hexStringToBytes, toUint8Array } from '../../src/misc.js';
import { UrlSource } from '../../src/source.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test('canDecodeVideo with differing ArrayBuffer descriptions', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig?.description);

	const validDescription = toUint8Array(decoderConfig.description).slice().buffer;
	const invalidDescription = new ArrayBuffer(8);

	expect(await canDecodeVideo('avc', { codec: decoderConfig.codec, description: invalidDescription })).toBe(false);
	expect(await canDecodeVideo('avc', { codec: decoderConfig.codec, description: validDescription })).toBe(true);
});

test('AV1 level for 8K at a Main tier bitrate', () => {
	// Level 5.3 tops out at 8912896 samples per picture just like the rest of level 5, so this needs level 6.0
	expect(buildVideoCodecString('av1', 7680, 4320, 30e6, false)).toBe('av01.0.16M.08');
});

test('Interlaced AVC SPS dimensions', () => {
	// 1080i from x264: frame_mbs_only_flag is 0, so the height is coded in map units of two macroblock rows
	const sps = new Uint8Array([
		0x67, 0x4d, 0x40, 0x28, 0xf4, 0x03, 0xc0, 0x22, 0x7e, 0xf0, 0x11, 0x00,
		0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x03, 0x00, 0x32, 0x1f, 0x16, 0x2e,
		0xa0,
	]);

	const info = parseAvcSps(sps)!;
	expect(info.frameMbsOnlyFlag).toBe(0);
	expect(info.codedWidth).toBe(1920);
	expect(info.codedHeight).toBe(1088);
	expect(info.displayWidth).toBe(1920);
	expect(info.displayHeight).toBe(1080);
});

test('HEVC SPS with inter-predicted short-term reference picture sets', () => {
	// Carries the reference picture sets of HM's random access GOP, all but the first predicted from their predecessor.
	// The second set keeps fewer entries than the first, which determines how many flags the third one has.
	const sps = new Uint8Array([
		0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00,
		0x03, 0x00, 0x00, 0x03, 0x00, 0x5d, 0xa0, 0x0a, 0x08, 0x0f, 0x16, 0x59,
		0x5e, 0x49, 0x32, 0x12, 0x58, 0x8a, 0xa9, 0x31, 0x30, 0xcb, 0xec, 0xfa,
		0xf3, 0x7e, 0x59, 0xf5, 0xe3, 0xff, 0xc0, 0x01, 0x00, 0x00, 0xdb, 0x84,
		0x88, 0x04, 0x80, 0x40,
	]);

	const info = parseHevcSps(sps)!;
	expect(info.pixelAspectRatio).toEqual({ num: 4, den: 3 });
	expect(info.colourPrimaries).toBe(9);
	expect(info.transferCharacteristics).toBe(16);
	expect(info.matrixCoefficients).toBe(9);
	expect(info.fullRangeFlag).toBe(1);
});

test('HEVC SPS with long-term reference pictures', () => {
	// The VUI comes after the long-term reference pictures, so misreading those garbles the colors and aspect ratio
	const spsInfo = parseHevcSps(hexStringToBytes(
		'42010101600000030090000003000003005da00a080f16595e49324bd88721ffe00080006dc244024020',
	));

	expect(spsInfo).toMatchObject({
		pixelAspectRatio: { num: 4, den: 3 },
		colourPrimaries: 9,
		transferCharacteristics: 16,
		matrixCoefficients: 9,
		fullRangeFlag: 1,
	});
});

test('VP9 RGB key frame', () => {
	// Start of a 320x240 profile 1 key frame, encoded by libvpx from gbrp
	const packet = new Uint8Array([
		0xa2, 0x49, 0x83, 0x42, 0xe0, 0x13, 0xf0, 0x0e, 0xf6, 0x06, 0x38, 0x24,
		0x1c, 0x18, 0x4a, 0x00,
	]);

	expect(extractVp9CodecInfoFromPacket(packet)).toEqual({
		profile: 1,
		level: 20,
		bitDepth: 8,
		chromaSubsampling: 3,
		videoFullRangeFlag: 1,
		colourPrimaries: 1,
		transferCharacteristics: 13,
		matrixCoefficients: 0,
	});
});

test('ProRes codec info with minimal frame header', () => {
	// Start of a frame encoded by prores_ks with default quantization matrices, so its frame header is only 20 bytes
	const packet = new Uint8Array([
		0x00, 0x00, 0x0b, 0x07, 0x69, 0x63, 0x70, 0x66, 0x00, 0x14, 0x00, 0x00, 0x4c, 0x61, 0x76, 0x63,
		0x00, 0x40, 0x00, 0x40, 0x80, 0x00, 0x09, 0x10, 0x09, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x0a,
		0xeb, 0x00, 0x04, 0x30, 0x03, 0x12, 0x02, 0xcd,
	]);

	expect(extractProresCodecInfoFromPacket(packet)).toEqual({
		fullRange: false,
		colourPrimaries: 9,
		transferCharacteristics: 16,
		matrixCoefficients: 9,
	});
});

test('canDecodeAudio with differing ArrayBuffer descriptions', async () => {
	registerDecoder(DescriptionCheckingAudioDecoder);

	expect(await canDecodeAudio('ac3', { description: new Uint8Array([0]).buffer })).toBe(false);
	expect(await canDecodeAudio('ac3', { description: new Uint8Array([1]).buffer })).toBe(true);
});

class DescriptionCheckingAudioDecoder extends CustomAudioDecoder {
	static override supports(codec: AudioCodec, config: AudioDecoderConfig) {
		return codec === 'ac3' && !!config.description && toUint8Array(config.description)[0] === 1;
	}

	init() {}
	decode() {}
	flush() {}
	close() {}
}

test('canDecode with a subtitle codec', async () => {
	const result = canDecode('webvtt');

	expect(result).toBeInstanceOf(Promise);
	expect(await result).toBe(false);
});

test('AVC decoder configuration record for High 4:4:4 Predictive', () => {
	// As written by FFmpeg for x264's yuv444p output, ending in chroma_format 3 and 8-bit depths
	const avcC = hexStringToBytes(
		'01f4000affe1001767f4000a919b2884d80880000003008000000a078912cb01000668ebe3c44844fff8f800',
	);

	const record = deserializeAvcDecoderConfigurationRecord(avcC)!;
	expect(record.chromaFormat).toBe(3);
	expect(record.bitDepthLumaMinus8).toBe(0);
	expect(record.bitDepthChromaMinus8).toBe(0);
	expect(serializeAvcDecoderConfigurationRecord(record)).toEqual(avcC);

	const annexB = concatNalUnitsInAnnexB([record.sequenceParameterSets[0]!, record.pictureParameterSets[0]!]);
	expect(serializeAvcDecoderConfigurationRecord(extractAvcDecoderConfigurationRecord(annexB)!)).toEqual(avcC);
});

test('HEVC decoder configuration record with prefix and suffix SEI', () => {
	// x265's parameter sets, a recovery point prefix SEI, and the decoded picture hash suffix SEI from x265 --hash
	const packet = concatNalUnitsInAnnexB([
		'40010c01ffff01600000030090000003000003001e959809',
		'42010101600000030090000003000003001ea020810596566924caf0168080000003008000000504',
		'4401c172b42240',
		'4e010601d080',
		'5001843100b33ec0a6b671a8ae98a5e9636aa935a33457f026b8b222daba01d5fd9a2c2212836def28613fa051a27688394dd2e93e80',
	].map(hexStringToBytes));

	const record = extractHevcDecoderConfigurationRecord(packet)!;
	expect(record.arrays.map(x => ({
		arrayCompleteness: x.arrayCompleteness,
		nalUnitType: x.nalUnitType,
		nalUnitCount: x.nalUnits.length,
	}))).toEqual([
		{ arrayCompleteness: 1, nalUnitType: 32, nalUnitCount: 1 },
		{ arrayCompleteness: 1, nalUnitType: 33, nalUnitCount: 1 },
		{ arrayCompleteness: 1, nalUnitType: 34, nalUnitCount: 1 },
		{ arrayCompleteness: 0, nalUnitType: 39, nalUnitCount: 1 },
		{ arrayCompleteness: 0, nalUnitType: 40, nalUnitCount: 1 },
	]);
});

test('AVC SPS with the old High 4:4:4 profile', () => {
	// x264's yuv444p SPS with profile_idc swapped to 144, which has the same syntax
	const info = parseAvcSps(hexStringToBytes('6790000a919b2884d80880000003008000000a078912cb'))!;
	expect(info.chromaFormatIdc).toBe(3);
	expect(info.displayWidth).toBe(64);
	expect(info.displayHeight).toBe(64);
});

test('AVC SPS without VUI and a too-low level', () => {
	// x264's 1080p baseline SPS with 4 reference frames but level 3.1, which only allows 2 at that size. VUI removed.
	const info = parseAvcSps(hexStringToBytes('6742c01fd940780227e540'))!;
	expect(info.maxDecFrameBuffering).toBe(4);

	const restricted = parseAvcSps(addAvcBitstreamRestriction(info))!;
	expect(restricted.bitstreamRestrictionFlag).toBe(1);
	expect(restricted.maxDecFrameBuffering).toBe(4);
});

test('AVC SPS without VUI at level 1b', () => {
	// x264's QCIF Main profile SPS at level 1b (level_idc 11 plus constraint_set3_flag). VUI removed.
	const info = parseAvcSps(hexStringToBytes('674d500beca16272'))!;
	expect(info.levelIdc).toBe(11);
	// MaxDpbMbs of 396 over 99 macroblocks, not level 1.1's 900
	expect(info.maxDecFrameBuffering).toBe(4);
	expect(info.numReorderFrames).toBe(4);
});

test('AV1 level for a wide picture', () => {
	// Few enough pixels for level 2.0, but too wide for its maximum width of 2048
	expect(buildVideoCodecString('av1', 2100, 64, 1e6, false)).toBe('av01.0.01M.08');
	expect(extractVideoCodecString({
		width: 2100,
		height: 64,
		codec: 'av1',
		codecDescription: null,
		colorSpace: null,
		avcType: null,
		avcCodecInfo: null,
		hevcCodecInfo: null,
		vp9CodecInfo: null,
		av1CodecInfo: null,
		proresFormat: null,
	})).toBe('av01.0.01M.08');
});

test('Video packets with hidden frames', () => {
	// VP8 inter frame tags, with show_frame as the fifth bit
	expect(countShownVideoFrames('vp8', new Uint8Array([0x11, 0x00, 0x00]))).toBe(1);
	expect(countShownVideoFrames('vp8', new Uint8Array([0x01, 0x00, 0x00]))).toBe(0);

	// Starts of VP9 inter frames from Lavf56, which stored hidden frames as packets of their own
	expect(countShownVideoFrames('vp9', hexStringToBytes('86004092'))).toBe(1);
	expect(countShownVideoFrames('vp9', hexStringToBytes('84008049'))).toBe(0);

	// VP9 superframes of two two-byte frames (hidden 84, shown 86), whose indexes hold one-byte frame sizes
	expect(countShownVideoFrames('vp9', hexStringToBytes('84008600c10202c1'))).toBe(1);
	expect(countShownVideoFrames('vp9', hexStringToBytes('86008600c10202c1'))).toBe(2);
	expect(countShownVideoFrames('vp9', hexStringToBytes('84008400c10202c1'))).toBe(0);

	// The same with two-byte frame sizes, which are little-endian
	expect(countShownVideoFrames('vp9', hexStringToBytes('84008600c902000200c9'))).toBe(1);
});

// Keep this test last, and keep anything that calls isFirefox() out of this file: isFirefox() caches its first
// result, so the faked user agent only takes effect if nothing ran it before, and it stays true afterwards
test('canEncodeVideo encoder probing on Firefox', async () => {
	const userAgent = navigator.userAgent;
	vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`${userAgent} Firefox/140.0`);

	const encoders: VideoEncoder[] = [];
	vi.stubGlobal('VideoEncoder', class extends VideoEncoder {
		constructor(init: VideoEncoderInit) {
			super(init);
			encoders.push(this);
		}
	});

	expect(await canEncodeVideo('vp8', { width: 64, height: 64 })).toBe(true);
	expect(encoders.length).toBeGreaterThan(0);
	expect(encoders.every(x => x.state === 'closed')).toBe(true);
});
