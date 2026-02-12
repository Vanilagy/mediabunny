/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	Av1CodecInfo,
	AvcDecoderConfigurationRecord,
	HevcDecoderConfigurationRecord,
	Vp9CodecInfo,
} from './codec-data';
import {
	Bitstream,
	COLOR_PRIMARIES_MAP,
	MATRIX_COEFFICIENTS_MAP,
	TRANSFER_CHARACTERISTICS_MAP,
	assert,
	bytesToHexString,
	isAllowSharedBufferSource,
	last,
	reverseBitsU32,
	toDataView,
} from './misc';
import { SubtitleMetadata } from './subtitles';

/**
 * List of known video codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const VIDEO_CODECS = [
	'avc',
	'hevc',
	'vp9',
	'av1',
	'vp8',
] as const;
/**
 * List of known PCM (uncompressed) audio codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const PCM_AUDIO_CODECS = [
	'pcm-s16', // We don't prefix 'le' so we're compatible with the WebCodecs-registered PCM codec strings
	'pcm-s16be',
	'pcm-s24',
	'pcm-s24be',
	'pcm-s32',
	'pcm-s32be',
	'pcm-f32',
	'pcm-f32be',
	'pcm-f64',
	'pcm-f64be',
	'pcm-u8',
	'pcm-s8',
	'ulaw',
	'alaw',
] as const;
/**
 * List of known compressed audio codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const NON_PCM_AUDIO_CODECS = [
	'aac',
	'opus',
	'mp3',
	'vorbis',
	'flac',
	'ac3',
	'eac3',
] as const;
/**
 * List of known audio codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const AUDIO_CODECS = [
	...NON_PCM_AUDIO_CODECS,
	...PCM_AUDIO_CODECS,
] as const;
/**
 * List of known subtitle codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const SUBTITLE_CODECS = [
	'webvtt',
] as const; // TODO add the rest

/**
 * Union type of known video codecs.
 * @group Codecs
 * @public
 */
export type VideoCodec = typeof VIDEO_CODECS[number];
/**
 * Union type of known audio codecs.
 * @group Codecs
 * @public
 */
export type AudioCodec = typeof AUDIO_CODECS[number];
export type PcmAudioCodec = typeof PCM_AUDIO_CODECS[number];
/**
 * Union type of known subtitle codecs.
 * @group Codecs
 * @public
 */
export type SubtitleCodec = typeof SUBTITLE_CODECS[number];
/**
 * Union type of known media codecs.
 * @group Codecs
 * @public
 */
export type MediaCodec = VideoCodec | AudioCodec | SubtitleCodec;

// https://en.wikipedia.org/wiki/Advanced_Video_Coding
export const AVC_LEVEL_TABLE = [
	{ maxMacroblocks: 99, maxBitrate: 64000, maxDpbMbs: 396, level: 0x0A }, // Level 1
	{ maxMacroblocks: 396, maxBitrate: 192000, maxDpbMbs: 900, level: 0x0B }, // Level 1.1
	{ maxMacroblocks: 396, maxBitrate: 384000, maxDpbMbs: 2376, level: 0x0C }, // Level 1.2
	{ maxMacroblocks: 396, maxBitrate: 768000, maxDpbMbs: 2376, level: 0x0D }, // Level 1.3
	{ maxMacroblocks: 396, maxBitrate: 2000000, maxDpbMbs: 2376, level: 0x14 }, // Level 2
	{ maxMacroblocks: 792, maxBitrate: 4000000, maxDpbMbs: 4752, level: 0x15 }, // Level 2.1
	{ maxMacroblocks: 1620, maxBitrate: 4000000, maxDpbMbs: 8100, level: 0x16 }, // Level 2.2
	{ maxMacroblocks: 1620, maxBitrate: 10000000, maxDpbMbs: 8100, level: 0x1E }, // Level 3
	{ maxMacroblocks: 3600, maxBitrate: 14000000, maxDpbMbs: 18000, level: 0x1F }, // Level 3.1
	{ maxMacroblocks: 5120, maxBitrate: 20000000, maxDpbMbs: 20480, level: 0x20 }, // Level 3.2
	{ maxMacroblocks: 8192, maxBitrate: 20000000, maxDpbMbs: 32768, level: 0x28 }, // Level 4
	{ maxMacroblocks: 8192, maxBitrate: 50000000, maxDpbMbs: 32768, level: 0x29 }, // Level 4.1
	{ maxMacroblocks: 8704, maxBitrate: 50000000, maxDpbMbs: 34816, level: 0x2A }, // Level 4.2
	{ maxMacroblocks: 22080, maxBitrate: 135000000, maxDpbMbs: 110400, level: 0x32 }, // Level 5
	{ maxMacroblocks: 36864, maxBitrate: 240000000, maxDpbMbs: 184320, level: 0x33 }, // Level 5.1
	{ maxMacroblocks: 36864, maxBitrate: 240000000, maxDpbMbs: 184320, level: 0x34 }, // Level 5.2
	{ maxMacroblocks: 139264, maxBitrate: 240000000, maxDpbMbs: 696320, level: 0x3C }, // Level 6
	{ maxMacroblocks: 139264, maxBitrate: 480000000, maxDpbMbs: 696320, level: 0x3D }, // Level 6.1
	{ maxMacroblocks: 139264, maxBitrate: 800000000, maxDpbMbs: 696320, level: 0x3E }, // Level 6.2
];

// https://en.wikipedia.org/wiki/High_Efficiency_Video_Coding
const HEVC_LEVEL_TABLE = [
	{ maxPictureSize: 36864, maxBitrate: 128000, tier: 'L', level: 30 }, // Level 1 (Low Tier)
	{ maxPictureSize: 122880, maxBitrate: 1500000, tier: 'L', level: 60 }, // Level 2 (Low Tier)
	{ maxPictureSize: 245760, maxBitrate: 3000000, tier: 'L', level: 63 }, // Level 2.1 (Low Tier)
	{ maxPictureSize: 552960, maxBitrate: 6000000, tier: 'L', level: 90 }, // Level 3 (Low Tier)
	{ maxPictureSize: 983040, maxBitrate: 10000000, tier: 'L', level: 93 }, // Level 3.1 (Low Tier)
	{ maxPictureSize: 2228224, maxBitrate: 12000000, tier: 'L', level: 120 }, // Level 4 (Low Tier)
	{ maxPictureSize: 2228224, maxBitrate: 30000000, tier: 'H', level: 120 }, // Level 4 (High Tier)
	{ maxPictureSize: 2228224, maxBitrate: 20000000, tier: 'L', level: 123 }, // Level 4.1 (Low Tier)
	{ maxPictureSize: 2228224, maxBitrate: 50000000, tier: 'H', level: 123 }, // Level 4.1 (High Tier)
	{ maxPictureSize: 8912896, maxBitrate: 25000000, tier: 'L', level: 150 }, // Level 5 (Low Tier)
	{ maxPictureSize: 8912896, maxBitrate: 100000000, tier: 'H', level: 150 }, // Level 5 (High Tier)
	{ maxPictureSize: 8912896, maxBitrate: 40000000, tier: 'L', level: 153 }, // Level 5.1 (Low Tier)
	{ maxPictureSize: 8912896, maxBitrate: 160000000, tier: 'H', level: 153 }, // Level 5.1 (High Tier)
	{ maxPictureSize: 8912896, maxBitrate: 60000000, tier: 'L', level: 156 }, // Level 5.2 (Low Tier)
	{ maxPictureSize: 8912896, maxBitrate: 240000000, tier: 'H', level: 156 }, // Level 5.2 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 60000000, tier: 'L', level: 180 }, // Level 6 (Low Tier)
	{ maxPictureSize: 35651584, maxBitrate: 240000000, tier: 'H', level: 180 }, // Level 6 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 120000000, tier: 'L', level: 183 }, // Level 6.1 (Low Tier)
	{ maxPictureSize: 35651584, maxBitrate: 480000000, tier: 'H', level: 183 }, // Level 6.1 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 240000000, tier: 'L', level: 186 }, // Level 6.2 (Low Tier)
	{ maxPictureSize: 35651584, maxBitrate: 800000000, tier: 'H', level: 186 }, // Level 6.2 (High Tier)
];

// https://en.wikipedia.org/wiki/VP9
export const VP9_LEVEL_TABLE = [
	{ maxPictureSize: 36864, maxBitrate: 200000, level: 10 }, // Level 1
	{ maxPictureSize: 73728, maxBitrate: 800000, level: 11 }, // Level 1.1
	{ maxPictureSize: 122880, maxBitrate: 1800000, level: 20 }, // Level 2
	{ maxPictureSize: 245760, maxBitrate: 3600000, level: 21 }, // Level 2.1
	{ maxPictureSize: 552960, maxBitrate: 7200000, level: 30 }, // Level 3
	{ maxPictureSize: 983040, maxBitrate: 12000000, level: 31 }, // Level 3.1
	{ maxPictureSize: 2228224, maxBitrate: 18000000, level: 40 }, // Level 4
	{ maxPictureSize: 2228224, maxBitrate: 30000000, level: 41 }, // Level 4.1
	{ maxPictureSize: 8912896, maxBitrate: 60000000, level: 50 }, // Level 5
	{ maxPictureSize: 8912896, maxBitrate: 120000000, level: 51 }, // Level 5.1
	{ maxPictureSize: 8912896, maxBitrate: 180000000, level: 52 }, // Level 5.2
	{ maxPictureSize: 35651584, maxBitrate: 180000000, level: 60 }, // Level 6
	{ maxPictureSize: 35651584, maxBitrate: 240000000, level: 61 }, // Level 6.1
	{ maxPictureSize: 35651584, maxBitrate: 480000000, level: 62 }, // Level 6.2
];

// https://en.wikipedia.org/wiki/AV1
const AV1_LEVEL_TABLE = [
	{ maxPictureSize: 147456, maxBitrate: 1500000, tier: 'M', level: 0 }, // Level 2.0 (Main Tier)
	{ maxPictureSize: 278784, maxBitrate: 3000000, tier: 'M', level: 1 }, // Level 2.1 (Main Tier)
	{ maxPictureSize: 665856, maxBitrate: 6000000, tier: 'M', level: 4 }, // Level 3.0 (Main Tier)
	{ maxPictureSize: 1065024, maxBitrate: 10000000, tier: 'M', level: 5 }, // Level 3.1 (Main Tier)
	{ maxPictureSize: 2359296, maxBitrate: 12000000, tier: 'M', level: 8 }, // Level 4.0 (Main Tier)
	{ maxPictureSize: 2359296, maxBitrate: 30000000, tier: 'H', level: 8 }, // Level 4.0 (High Tier)
	{ maxPictureSize: 2359296, maxBitrate: 20000000, tier: 'M', level: 9 }, // Level 4.1 (Main Tier)
	{ maxPictureSize: 2359296, maxBitrate: 50000000, tier: 'H', level: 9 }, // Level 4.1 (High Tier)
	{ maxPictureSize: 8912896, maxBitrate: 30000000, tier: 'M', level: 12 }, // Level 5.0 (Main Tier)
	{ maxPictureSize: 8912896, maxBitrate: 100000000, tier: 'H', level: 12 }, // Level 5.0 (High Tier)
	{ maxPictureSize: 8912896, maxBitrate: 40000000, tier: 'M', level: 13 }, // Level 5.1 (Main Tier)
	{ maxPictureSize: 8912896, maxBitrate: 160000000, tier: 'H', level: 13 }, // Level 5.1 (High Tier)
	{ maxPictureSize: 8912896, maxBitrate: 60000000, tier: 'M', level: 14 }, // Level 5.2 (Main Tier)
	{ maxPictureSize: 8912896, maxBitrate: 240000000, tier: 'H', level: 14 }, // Level 5.2 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 60000000, tier: 'M', level: 15 }, // Level 5.3 (Main Tier)
	{ maxPictureSize: 35651584, maxBitrate: 240000000, tier: 'H', level: 15 }, // Level 5.3 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 60000000, tier: 'M', level: 16 }, // Level 6.0 (Main Tier)
	{ maxPictureSize: 35651584, maxBitrate: 240000000, tier: 'H', level: 16 }, // Level 6.0 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 100000000, tier: 'M', level: 17 }, // Level 6.1 (Main Tier)
	{ maxPictureSize: 35651584, maxBitrate: 480000000, tier: 'H', level: 17 }, // Level 6.1 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 160000000, tier: 'M', level: 18 }, // Level 6.2 (Main Tier)
	{ maxPictureSize: 35651584, maxBitrate: 800000000, tier: 'H', level: 18 }, // Level 6.2 (High Tier)
	{ maxPictureSize: 35651584, maxBitrate: 160000000, tier: 'M', level: 19 }, // Level 6.3 (Main Tier)
	{ maxPictureSize: 35651584, maxBitrate: 800000000, tier: 'H', level: 19 }, // Level 6.3 (High Tier)
];

const VP9_DEFAULT_SUFFIX = '.01.01.01.01.00';
const AV1_DEFAULT_SUFFIX = '.0.110.01.01.01.0';

export const buildVideoCodecString = (codec: VideoCodec, width: number, height: number, bitrate: number) => {
	if (codec === 'avc') {
		const profileIndication = 0x64; // High Profile
		const totalMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);

		// Determine the level based on the table
		const levelInfo = AVC_LEVEL_TABLE.find(
			level => totalMacroblocks <= level.maxMacroblocks && bitrate <= level.maxBitrate,
		) ?? last(AVC_LEVEL_TABLE)!;
		const levelIndication = levelInfo ? levelInfo.level : 0;

		const hexProfileIndication = profileIndication.toString(16).padStart(2, '0');
		const hexProfileCompatibility = '00';
		const hexLevelIndication = levelIndication.toString(16).padStart(2, '0');

		return `avc1.${hexProfileIndication}${hexProfileCompatibility}${hexLevelIndication}`;
	} else if (codec === 'hevc') {
		const profilePrefix = ''; // Profile space 0
		const profileIdc = 1; // Main Profile

		const compatibilityFlags = '6'; // Taken from the example in ISO 14496-15

		const pictureSize = width * height;
		const levelInfo = HEVC_LEVEL_TABLE.find(
			level => pictureSize <= level.maxPictureSize && bitrate <= level.maxBitrate,
		) ?? last(HEVC_LEVEL_TABLE)!;

		const constraintFlags = 'B0'; // Progressive source flag

		return 'hev1.'
			+ `${profilePrefix}${profileIdc}.`
			+ `${compatibilityFlags}.`
			+ `${levelInfo.tier}${levelInfo.level}.`
			+ `${constraintFlags}`;
	} else if (codec === 'vp8') {
		return 'vp8'; // Easy, this one
	} else if (codec === 'vp9') {
		const profile = '00'; // Profile 0

		const pictureSize = width * height;
		const levelInfo = VP9_LEVEL_TABLE.find(
			level => pictureSize <= level.maxPictureSize && bitrate <= level.maxBitrate,
		) ?? last(VP9_LEVEL_TABLE)!;

		const bitDepth = '08'; // 8-bit

		return `vp09.${profile}.${levelInfo.level.toString().padStart(2, '0')}.${bitDepth}`;
	} else if (codec === 'av1') {
		const profile = 0; // Main Profile, single digit

		const pictureSize = width * height;
		const levelInfo = AV1_LEVEL_TABLE.find(
			level => pictureSize <= level.maxPictureSize && bitrate <= level.maxBitrate,
		) ?? last(AV1_LEVEL_TABLE)!;
		const level = levelInfo.level.toString().padStart(2, '0');

		const bitDepth = '08'; // 8-bit

		return `av01.${profile}.${level}${levelInfo.tier}.${bitDepth}`;
	}

	// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
	throw new TypeError(`Unhandled codec '${codec}'.`);
};

export const generateVp9CodecConfigurationFromCodecString = (codecString: string) => {
	// Reference: https://www.webmproject.org/docs/container/#vp9-codec-feature-metadata-codecprivate

	const parts = codecString.split('.'); // We can derive the required values from the codec string

	const profile = Number(parts[1]);
	const level = Number(parts[2]);
	const bitDepth = Number(parts[3]);
	const chromaSubsampling = parts[4] ? Number(parts[4]) : 1;

	return [
		1, 1, profile,
		2, 1, level,
		3, 1, bitDepth,
		4, 1, chromaSubsampling,
	];
};

export const generateAv1CodecConfigurationFromCodecString = (codecString: string) => {
	// Reference: https://aomediacodec.github.io/av1-isobmff/

	const parts = codecString.split('.'); // We can derive the required values from the codec string

	const marker = 1;
	const version = 1;
	const firstByte = (marker << 7) + version;

	const profile = Number(parts[1]);
	const levelAndTier = parts[2]!;
	const level = Number(levelAndTier.slice(0, -1));
	const secondByte = (profile << 5) + level;

	const tier = levelAndTier.slice(-1) === 'H' ? 1 : 0;
	const bitDepth = Number(parts[3]);
	const highBitDepth = bitDepth === 8 ? 0 : 1;
	const twelveBit = 0;
	const monochrome = parts[4] ? Number(parts[4]) : 0;
	const chromaSubsamplingX = parts[5] ? Number(parts[5][0]) : 1;
	const chromaSubsamplingY = parts[5] ? Number(parts[5][1]) : 1;
	const chromaSamplePosition = parts[5] ? Number(parts[5][2]) : 0; // CSP_UNKNOWN
	const thirdByte = (tier << 7)
		+ (highBitDepth << 6)
		+ (twelveBit << 5)
		+ (monochrome << 4)
		+ (chromaSubsamplingX << 3)
		+ (chromaSubsamplingY << 2)
		+ chromaSamplePosition;

	const initialPresentationDelayPresent = 0; // Should be fine
	const fourthByte = initialPresentationDelayPresent;

	return [firstByte, secondByte, thirdByte, fourthByte];
};

export const extractVideoCodecString = (trackInfo: {
	width: number;
	height: number;
	codec: VideoCodec | null;
	codecDescription: Uint8Array | null;
	colorSpace: VideoColorSpaceInit | null;
	avcType: 1 | 3 | null;
	avcCodecInfo: AvcDecoderConfigurationRecord | null;
	hevcCodecInfo: HevcDecoderConfigurationRecord | null;
	vp9CodecInfo: Vp9CodecInfo | null;
	av1CodecInfo: Av1CodecInfo | null;
}) => {
	const { codec, codecDescription, colorSpace, avcCodecInfo, hevcCodecInfo, vp9CodecInfo, av1CodecInfo } = trackInfo;

	if (codec === 'avc') {
		assert(trackInfo.avcType !== null);

		if (avcCodecInfo) {
			const bytes = new Uint8Array([
				avcCodecInfo.avcProfileIndication,
				avcCodecInfo.profileCompatibility,
				avcCodecInfo.avcLevelIndication,
			]);

			return `avc${trackInfo.avcType}.${bytesToHexString(bytes)}`;
		}

		if (!codecDescription || codecDescription.byteLength < 4) {
			throw new TypeError('AVC decoder description is not provided or is not at least 4 bytes long.');
		}

		return `avc${trackInfo.avcType}.${bytesToHexString(codecDescription.subarray(1, 4))}`;
	} else if (codec === 'hevc') {
		let generalProfileSpace: number;
		let generalProfileIdc: number;
		let compatibilityFlags: number;
		let generalTierFlag: number;
		let generalLevelIdc: number;
		let constraintFlags: number[];

		if (hevcCodecInfo) {
			generalProfileSpace = hevcCodecInfo.generalProfileSpace;
			generalProfileIdc = hevcCodecInfo.generalProfileIdc;
			compatibilityFlags = reverseBitsU32(hevcCodecInfo.generalProfileCompatibilityFlags);
			generalTierFlag = hevcCodecInfo.generalTierFlag;
			generalLevelIdc = hevcCodecInfo.generalLevelIdc;
			constraintFlags = [...hevcCodecInfo.generalConstraintIndicatorFlags];
		} else {
			if (!codecDescription || codecDescription.byteLength < 23) {
				throw new TypeError('HEVC decoder description is not provided or is not at least 23 bytes long.');
			}

			const view = toDataView(codecDescription);
			const profileByte = view.getUint8(1);

			generalProfileSpace = (profileByte >> 6) & 0x03;
			generalProfileIdc = profileByte & 0x1F;
			compatibilityFlags = reverseBitsU32(view.getUint32(2));
			generalTierFlag = (profileByte >> 5) & 0x01;
			generalLevelIdc = view.getUint8(12);

			constraintFlags = [];
			for (let i = 0; i < 6; i++) {
				constraintFlags.push(view.getUint8(6 + i));
			}
		}

		let codecString = 'hev1.';

		codecString += ['', 'A', 'B', 'C'][generalProfileSpace]! + generalProfileIdc;
		codecString += '.';
		codecString += compatibilityFlags.toString(16).toUpperCase();
		codecString += '.';
		codecString += generalTierFlag === 0 ? 'L' : 'H';
		codecString += generalLevelIdc;

		while (constraintFlags.length > 0 && constraintFlags[constraintFlags.length - 1] === 0) {
			constraintFlags.pop();
		}

		if (constraintFlags.length > 0) {
			codecString += '.';
			codecString += constraintFlags.map(x => x.toString(16).toUpperCase()).join('.');
		}

		return codecString;
	} else if (codec === 'vp8') {
		return 'vp8'; // Easy, this one
	} else if (codec === 'vp9') {
		if (!vp9CodecInfo) {
			// Calculate level based on dimensions
			const pictureSize = trackInfo.width * trackInfo.height;
			let level = last(VP9_LEVEL_TABLE)!.level; // Default to highest level
			for (const entry of VP9_LEVEL_TABLE) {
				if (pictureSize <= entry.maxPictureSize) {
					level = entry.level;
					break;
				}
			}

			// We don't really know better, so let's return a general-purpose, common codec string and hope for the best
			return `vp09.00.${level.toString().padStart(2, '0')}.08`;
		}

		const profile = vp9CodecInfo.profile.toString().padStart(2, '0');
		const level = vp9CodecInfo.level.toString().padStart(2, '0');
		const bitDepth = vp9CodecInfo.bitDepth.toString().padStart(2, '0');
		const chromaSubsampling = vp9CodecInfo.chromaSubsampling.toString().padStart(2, '0');
		const colourPrimaries = vp9CodecInfo.colourPrimaries.toString().padStart(2, '0');
		const transferCharacteristics = vp9CodecInfo.transferCharacteristics.toString().padStart(2, '0');
		const matrixCoefficients = vp9CodecInfo.matrixCoefficients.toString().padStart(2, '0');
		const videoFullRangeFlag = vp9CodecInfo.videoFullRangeFlag.toString().padStart(2, '0');

		let string = `vp09.${profile}.${level}.${bitDepth}.${chromaSubsampling}`;
		string += `.${colourPrimaries}.${transferCharacteristics}.${matrixCoefficients}.${videoFullRangeFlag}`;

		if (string.endsWith(VP9_DEFAULT_SUFFIX)) {
			string = string.slice(0, -VP9_DEFAULT_SUFFIX.length);
		}

		return string;
	} else if (codec === 'av1') {
		if (!av1CodecInfo) {
			// Calculate level based on dimensions
			const pictureSize = trackInfo.width * trackInfo.height;
			let level = last(VP9_LEVEL_TABLE)!.level; // Default to highest level
			for (const entry of VP9_LEVEL_TABLE) {
				if (pictureSize <= entry.maxPictureSize) {
					level = entry.level;
					break;
				}
			}

			// We don't really know better, so let's return a general-purpose, common codec string and hope for the best
			return `av01.0.${level.toString().padStart(2, '0')}M.08`;
		}

		// https://aomediacodec.github.io/av1-isobmff/#codecsparam
		const profile = av1CodecInfo.profile; // Single digit
		const level = av1CodecInfo.level.toString().padStart(2, '0');
		const tier = av1CodecInfo.tier ? 'H' : 'M';
		const bitDepth = av1CodecInfo.bitDepth.toString().padStart(2, '0');
		const monochrome = av1CodecInfo.monochrome ? '1' : '0';
		const chromaSubsampling = 100 * av1CodecInfo.chromaSubsamplingX
			+ 10 * av1CodecInfo.chromaSubsamplingY
			+ 1 * (
				av1CodecInfo.chromaSubsamplingX && av1CodecInfo.chromaSubsamplingY
					? av1CodecInfo.chromaSamplePosition
					: 0
			);

		// The defaults are 1 (ITU-R BT.709)
		const colorPrimaries = colorSpace?.primaries ? COLOR_PRIMARIES_MAP[colorSpace.primaries] : 1;
		const transferCharacteristics = colorSpace?.transfer ? TRANSFER_CHARACTERISTICS_MAP[colorSpace.transfer] : 1;
		const matrixCoefficients = colorSpace?.matrix ? MATRIX_COEFFICIENTS_MAP[colorSpace.matrix] : 1;

		const videoFullRangeFlag = colorSpace?.fullRange ? 1 : 0;

		let string = `av01.${profile}.${level}${tier}.${bitDepth}`;
		string += `.${monochrome}.${chromaSubsampling.toString().padStart(3, '0')}`;
		string += `.${colorPrimaries.toString().padStart(2, '0')}`;
		string += `.${transferCharacteristics.toString().padStart(2, '0')}`;
		string += `.${matrixCoefficients.toString().padStart(2, '0')}`;
		string += `.${videoFullRangeFlag}`;

		if (string.endsWith(AV1_DEFAULT_SUFFIX)) {
			string = string.slice(0, -AV1_DEFAULT_SUFFIX.length);
		}

		return string;
	}

	throw new TypeError(`Unhandled codec '${codec}'.`);
};

export const buildAudioCodecString = (codec: AudioCodec, numberOfChannels: number, sampleRate: number) => {
	if (codec === 'aac') {
		// If stereo or higher channels and lower sample rate, likely using HE-AAC v2 with PS
		if (numberOfChannels >= 2 && sampleRate <= 24000) {
			return 'mp4a.40.29'; // HE-AAC v2 (AAC LC + SBR + PS)
		}

		// If sample rate is low, likely using HE-AAC v1 with SBR
		if (sampleRate <= 24000) {
			return 'mp4a.40.5'; // HE-AAC v1 (AAC LC + SBR)
		}

		// Default to standard AAC-LC for higher sample rates
		return 'mp4a.40.2'; // AAC-LC
	} else if (codec === 'mp3') {
		return 'mp3';
	} else if (codec === 'opus') {
		return 'opus';
	} else if (codec === 'vorbis') {
		return 'vorbis';
	} else if (codec === 'flac') {
		return 'flac';
	} else if (codec === 'ac3') {
		return 'ac-3';
	} else if (codec === 'eac3') {
		return 'ec-3';
	} else if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
		return codec;
	}

	throw new TypeError(`Unhandled codec '${codec}'.`);
};

export type AacCodecInfo = {
	isMpeg2: boolean;
	objectType: number | null;
};

export const extractAudioCodecString = (trackInfo: {
	codec: AudioCodec | null;
	codecDescription: Uint8Array | null;
	aacCodecInfo: AacCodecInfo | null;
}) => {
	const { codec, codecDescription, aacCodecInfo } = trackInfo;

	if (codec === 'aac') {
		if (!aacCodecInfo) {
			throw new TypeError('AAC codec info must be provided.');
		}

		if (aacCodecInfo.isMpeg2) {
			return 'mp4a.67';
		} else {
			let objectType: number;
			if (aacCodecInfo.objectType !== null) {
				objectType = aacCodecInfo.objectType;
			} else {
				const audioSpecificConfig = parseAacAudioSpecificConfig(codecDescription);
				objectType = audioSpecificConfig.objectType;
			}

			return `mp4a.40.${objectType}`;
		}
	} else if (codec === 'mp3') {
		return 'mp3';
	} else if (codec === 'opus') {
		return 'opus';
	} else if (codec === 'vorbis') {
		return 'vorbis';
	} else if (codec === 'flac') {
		return 'flac';
	} else if (codec === 'ac3') {
		return 'ac-3';
	} else if (codec === 'eac3') {
		return 'ec-3';
	} else if (codec && (PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
		return codec;
	}

	throw new TypeError(`Unhandled codec '${codec}'.`);
};

export type AacAudioSpecificConfig = {
	objectType: number;
	frequencyIndex: number;
	sampleRate: number | null;
	channelConfiguration: number;
	numberOfChannels: number | null;
};

export const aacFrequencyTable = [
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export const aacChannelMap = [-1, 1, 2, 3, 4, 5, 6, 8];

export const parseAacAudioSpecificConfig = (bytes: Uint8Array | null): AacAudioSpecificConfig => {
	if (!bytes || bytes.byteLength < 2) {
		throw new TypeError('AAC description must be at least 2 bytes long.');
	}

	const bitstream = new Bitstream(bytes);

	let objectType = bitstream.readBits(5);
	if (objectType === 31) {
		objectType = 32 + bitstream.readBits(6);
	}

	const frequencyIndex = bitstream.readBits(4);
	let sampleRate: number | null = null;
	if (frequencyIndex === 15) {
		sampleRate = bitstream.readBits(24);
	} else {
		if (frequencyIndex < aacFrequencyTable.length) {
			sampleRate = aacFrequencyTable[frequencyIndex]!;
		}
	}

	const channelConfiguration = bitstream.readBits(4);
	let numberOfChannels: number | null = null;
	if (channelConfiguration >= 1 && channelConfiguration <= 7) {
		numberOfChannels = aacChannelMap[channelConfiguration]!;
	}

	return {
		objectType,
		frequencyIndex,
		sampleRate,
		channelConfiguration,
		numberOfChannels,
	};
};

export const buildAacAudioSpecificConfig = (config: {
	objectType: number;
	sampleRate: number;
	numberOfChannels: number;
}) => {
	let frequencyIndex = aacFrequencyTable.indexOf(config.sampleRate);
	let customSampleRate: number | null = null;

	if (frequencyIndex === -1) {
		frequencyIndex = 15;
		customSampleRate = config.sampleRate;
	}

	const channelConfiguration = aacChannelMap.indexOf(config.numberOfChannels);
	if (channelConfiguration === -1) {
		throw new TypeError(`Unsupported number of channels: ${config.numberOfChannels}`);
	}

	let bitCount = 5 + 4 + 4;
	if (config.objectType >= 32) {
		bitCount += 6;
	}
	if (frequencyIndex === 15) {
		bitCount += 24;
	}

	const byteCount = Math.ceil(bitCount / 8);
	const bytes = new Uint8Array(byteCount);
	const bitstream = new Bitstream(bytes);

	if (config.objectType < 32) {
		bitstream.writeBits(5, config.objectType);
	} else {
		bitstream.writeBits(5, 31);
		bitstream.writeBits(6, config.objectType - 32);
	}

	bitstream.writeBits(4, frequencyIndex);

	if (frequencyIndex === 15) {
		bitstream.writeBits(24, customSampleRate!);
	}

	bitstream.writeBits(4, channelConfiguration);

	return bytes;
};

export const OPUS_SAMPLE_RATE = 48_000;

const PCM_CODEC_REGEX = /^pcm-([usf])(\d+)+(be)?$/;

export const parsePcmCodec = (codec: PcmAudioCodec) => {
	assert(PCM_AUDIO_CODECS.includes(codec));

	if (codec === 'ulaw') {
		return { dataType: 'ulaw' as const, sampleSize: 1 as const, littleEndian: true, silentValue: 255 };
	} else if (codec === 'alaw') {
		return { dataType: 'alaw' as const, sampleSize: 1 as const, littleEndian: true, silentValue: 213 };
	}

	const match = PCM_CODEC_REGEX.exec(codec);
	assert(match);

	let dataType: 'unsigned' | 'signed' | 'float' | 'ulaw' | 'alaw';
	if (match[1] === 'u') {
		dataType = 'unsigned';
	} else if (match[1] === 's') {
		dataType = 'signed';
	} else {
		dataType = 'float';
	}

	const sampleSize = (Number(match[2]) / 8) as 1 | 2 | 3 | 4 | 8;
	const littleEndian = match[3] !== 'be';
	const silentValue = codec === 'pcm-u8' ? 2 ** 7 : 0;

	return { dataType, sampleSize, littleEndian, silentValue };
};

export const inferCodecFromCodecString = (codecString: string): MediaCodec | null => {
	// Video codecs
	if (codecString.startsWith('avc1') || codecString.startsWith('avc3')) {
		return 'avc';
	} else if (codecString.startsWith('hev1') || codecString.startsWith('hvc1')) {
		return 'hevc';
	} else if (codecString === 'vp8') {
		return 'vp8';
	} else if (codecString.startsWith('vp09')) {
		return 'vp9';
	} else if (codecString.startsWith('av01')) {
		return 'av1';
	}

	// Audio codecs
	if (codecString.startsWith('mp4a.40') || codecString === 'mp4a.67') {
		return 'aac';
	} else if (
		codecString === 'mp3'
		|| codecString === 'mp4a.69'
		|| codecString === 'mp4a.6B'
		|| codecString === 'mp4a.6b'
	) {
		return 'mp3';
	} else if (codecString === 'opus') {
		return 'opus';
	} else if (codecString === 'vorbis') {
		return 'vorbis';
	} else if (codecString === 'flac') {
		return 'flac';
	} else if (codecString === 'ac-3' || codecString === 'ac3') {
		return 'ac3';
	} else if (codecString === 'ec-3' || codecString === 'eac3') {
		return 'eac3';
	} else if (codecString === 'ulaw') {
		return 'ulaw';
	} else if (codecString === 'alaw') {
		return 'alaw';
	} else if (PCM_CODEC_REGEX.test(codecString)) {
		return codecString as PcmAudioCodec;
	}

	// Subtitle codecs
	if (codecString === 'webvtt') {
		return 'webvtt';
	}

	return null;
};

export const getVideoEncoderConfigExtension = (codec: VideoCodec) => {
	if (codec === 'avc') {
		return {
			avc: {
				format: 'avc' as const, // Ensure the format is not Annex B
			},
		};
	} else if (codec === 'hevc') {
		return {
			hevc: {
				format: 'hevc' as const, // Ensure the format is not Annex B
			},
		};
	}

	return {};
};

export const getAudioEncoderConfigExtension = (codec: AudioCodec) => {
	if (codec === 'aac') {
		return {
			aac: {
				format: 'aac' as const, // Ensure the format is not ADTS
			},
		};
	} else if (codec === 'opus') {
		return {
			opus: {
				format: 'opus' as const,
			},
		};
	}

	return {};
};

const VALID_VIDEO_CODEC_STRING_PREFIXES = ['avc1', 'avc3', 'hev1', 'hvc1', 'vp8', 'vp09', 'av01'];
const AVC_CODEC_STRING_REGEX = /^(avc1|avc3)\.[0-9a-fA-F]{6}$/;
const HEVC_CODEC_STRING_REGEX = /^(hev1|hvc1)\.(?:[ABC]?\d+)\.[0-9a-fA-F]{1,8}\.[LH]\d+(?:\.[0-9a-fA-F]{1,2}){0,6}$/;
const VP9_CODEC_STRING_REGEX = /^vp09(?:\.\d{2}){3}(?:(?:\.\d{2}){5})?$/;
const AV1_CODEC_STRING_REGEX = /^av01\.\d\.\d{2}[MH]\.\d{2}(?:\.\d\.\d{3}\.\d{2}\.\d{2}\.\d{2}\.\d)?$/;

export const validateVideoChunkMetadata = (metadata: EncodedVideoChunkMetadata | undefined) => {
	if (!metadata) {
		throw new TypeError('Video chunk metadata must be provided.');
	}
	if (typeof metadata !== 'object') {
		throw new TypeError('Video chunk metadata must be an object.');
	}
	if (!metadata.decoderConfig) {
		throw new TypeError('Video chunk metadata must include a decoder configuration.');
	}
	if (typeof metadata.decoderConfig !== 'object') {
		throw new TypeError('Video chunk metadata decoder configuration must be an object.');
	}
	if (typeof metadata.decoderConfig.codec !== 'string') {
		throw new TypeError('Video chunk metadata decoder configuration must specify a codec string.');
	}
	if (!VALID_VIDEO_CODEC_STRING_PREFIXES.some(prefix => metadata.decoderConfig!.codec.startsWith(prefix))) {
		throw new TypeError(
			'Video chunk metadata decoder configuration codec string must be a valid video codec string as specified in'
			+ ' the Mediabunny Codec Registry.',
		);
	}
	if (!Number.isInteger(metadata.decoderConfig.codedWidth) || metadata.decoderConfig.codedWidth! <= 0) {
		throw new TypeError(
			'Video chunk metadata decoder configuration must specify a valid codedWidth (positive integer).',
		);
	}
	if (!Number.isInteger(metadata.decoderConfig.codedHeight) || metadata.decoderConfig.codedHeight! <= 0) {
		throw new TypeError(
			'Video chunk metadata decoder configuration must specify a valid codedHeight (positive integer).',
		);
	}
	if (metadata.decoderConfig.description !== undefined) {
		if (!isAllowSharedBufferSource(metadata.decoderConfig.description)) {
			throw new TypeError(
				'Video chunk metadata decoder configuration description, when defined, must be an ArrayBuffer or an'
				+ ' ArrayBuffer view.',
			);
		}
	}
	if (metadata.decoderConfig.colorSpace !== undefined) {
		const { colorSpace } = metadata.decoderConfig;

		if (typeof colorSpace !== 'object') {
			throw new TypeError(
				'Video chunk metadata decoder configuration colorSpace, when provided, must be an object.',
			);
		}

		const primariesValues = Object.keys(COLOR_PRIMARIES_MAP);
		if (colorSpace.primaries != null && !primariesValues.includes(colorSpace.primaries)) {
			throw new TypeError(
				`Video chunk metadata decoder configuration colorSpace primaries, when defined, must be one of`
				+ ` ${primariesValues.join(', ')}.`,
			);
		}

		const transferValues = Object.keys(TRANSFER_CHARACTERISTICS_MAP);
		if (colorSpace.transfer != null && !transferValues.includes(colorSpace.transfer)) {
			throw new TypeError(
				`Video chunk metadata decoder configuration colorSpace transfer, when defined, must be one of`
				+ ` ${transferValues.join(', ')}.`,
			);
		}

		const matrixValues = Object.keys(MATRIX_COEFFICIENTS_MAP);
		if (colorSpace.matrix != null && !matrixValues.includes(colorSpace.matrix)) {
			throw new TypeError(
				`Video chunk metadata decoder configuration colorSpace matrix, when defined, must be one of`
				+ ` ${matrixValues.join(', ')}.`,
			);
		}

		if (colorSpace.fullRange != null && typeof colorSpace.fullRange !== 'boolean') {
			throw new TypeError(
				'Video chunk metadata decoder configuration colorSpace fullRange, when defined, must be a boolean.',
			);
		}
	}

	if (metadata.decoderConfig.codec.startsWith('avc1') || metadata.decoderConfig.codec.startsWith('avc3')) {
		// AVC-specific validation

		if (!AVC_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
			throw new TypeError(
				'Video chunk metadata decoder configuration codec string for AVC must be a valid AVC codec string as'
				+ ' specified in Section 3.4 of RFC 6381.',
			);
		}

		// `description` may or may not be set, depending on if the format is AVCC or Annex B, so don't perform any
		// validation for it.
		// https://www.w3.org/TR/webcodecs-avc-codec-registration
	} else if (metadata.decoderConfig.codec.startsWith('hev1') || metadata.decoderConfig.codec.startsWith('hvc1')) {
		// HEVC-specific validation

		if (!HEVC_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
			throw new TypeError(
				'Video chunk metadata decoder configuration codec string for HEVC must be a valid HEVC codec string as'
				+ ' specified in Section E.3 of ISO 14496-15.',
			);
		}

		// `description` may or may not be set, depending on if the format is HEVC or Annex B, so don't perform any
		// validation for it.
		// https://www.w3.org/TR/webcodecs-hevc-codec-registration
	} else if (metadata.decoderConfig.codec.startsWith('vp8')) {
		// VP8-specific validation

		if (metadata.decoderConfig.codec !== 'vp8') {
			throw new TypeError('Video chunk metadata decoder configuration codec string for VP8 must be "vp8".');
		}
	} else if (metadata.decoderConfig.codec.startsWith('vp09')) {
		// VP9-specific validation

		if (!VP9_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
			throw new TypeError(
				'Video chunk metadata decoder configuration codec string for VP9 must be a valid VP9 codec string as'
				+ ' specified in Section "Codecs Parameter String" of https://www.webmproject.org/vp9/mp4/.',
			);
		}
	} else if (metadata.decoderConfig.codec.startsWith('av01')) {
		// AV1-specific validation

		if (!AV1_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
			throw new TypeError(
				'Video chunk metadata decoder configuration codec string for AV1 must be a valid AV1 codec string as'
				+ ' specified in Section "Codecs Parameter String" of https://aomediacodec.github.io/av1-isobmff/.',
			);
		}
	}
};

const VALID_AUDIO_CODEC_STRING_PREFIXES = [
	'mp4a', 'mp3', 'opus', 'vorbis', 'flac', 'ulaw', 'alaw', 'pcm', 'ac-3', 'ec-3',
];

export const validateAudioChunkMetadata = (metadata: EncodedAudioChunkMetadata | undefined) => {
	if (!metadata) {
		throw new TypeError('Audio chunk metadata must be provided.');
	}
	if (typeof metadata !== 'object') {
		throw new TypeError('Audio chunk metadata must be an object.');
	}
	if (!metadata.decoderConfig) {
		throw new TypeError('Audio chunk metadata must include a decoder configuration.');
	}
	if (typeof metadata.decoderConfig !== 'object') {
		throw new TypeError('Audio chunk metadata decoder configuration must be an object.');
	}
	if (typeof metadata.decoderConfig.codec !== 'string') {
		throw new TypeError('Audio chunk metadata decoder configuration must specify a codec string.');
	}
	if (!VALID_AUDIO_CODEC_STRING_PREFIXES.some(prefix => metadata.decoderConfig!.codec.startsWith(prefix))) {
		throw new TypeError(
			'Audio chunk metadata decoder configuration codec string must be a valid audio codec string as specified in'
			+ ' the Mediabunny Codec Registry.',
		);
	}
	if (!Number.isInteger(metadata.decoderConfig.sampleRate) || metadata.decoderConfig.sampleRate <= 0) {
		throw new TypeError(
			'Audio chunk metadata decoder configuration must specify a valid sampleRate (positive integer).',
		);
	}
	if (!Number.isInteger(metadata.decoderConfig.numberOfChannels) || metadata.decoderConfig.numberOfChannels <= 0) {
		throw new TypeError(
			'Audio chunk metadata decoder configuration must specify a valid numberOfChannels (positive integer).',
		);
	}
	if (metadata.decoderConfig.description !== undefined) {
		if (!isAllowSharedBufferSource(metadata.decoderConfig.description)) {
			throw new TypeError(
				'Audio chunk metadata decoder configuration description, when defined, must be an ArrayBuffer or an'
				+ ' ArrayBuffer view.',
			);
		}
	}

	if (
		metadata.decoderConfig.codec.startsWith('mp4a')
		// These three refer to MP3:
		&& metadata.decoderConfig.codec !== 'mp4a.69'
		&& metadata.decoderConfig.codec !== 'mp4a.6B'
		&& metadata.decoderConfig.codec !== 'mp4a.6b'
	) {
		// AAC-specific validation

		const validStrings = ['mp4a.40.2', 'mp4a.40.02', 'mp4a.40.5', 'mp4a.40.05', 'mp4a.40.29', 'mp4a.67'];
		if (!validStrings.includes(metadata.decoderConfig.codec)) {
			throw new TypeError(
				'Audio chunk metadata decoder configuration codec string for AAC must be a valid AAC codec string as'
				+ ' specified in https://www.w3.org/TR/webcodecs-aac-codec-registration/.',
			);
		}

		// `description` may or may not be set, depending on if the format is AAC or ADTS, so don't perform any
		// validation for it.
		// https://www.w3.org/TR/webcodecs-aac-codec-registration
	} else if (metadata.decoderConfig.codec.startsWith('mp3') || metadata.decoderConfig.codec.startsWith('mp4a')) {
		// MP3-specific validation

		if (
			metadata.decoderConfig.codec !== 'mp3'
			&& metadata.decoderConfig.codec !== 'mp4a.69'
			&& metadata.decoderConfig.codec !== 'mp4a.6B'
			&& metadata.decoderConfig.codec !== 'mp4a.6b'
		) {
			throw new TypeError(
				'Audio chunk metadata decoder configuration codec string for MP3 must be "mp3", "mp4a.69" or'
				+ ' "mp4a.6B".',
			);
		}
	} else if (metadata.decoderConfig.codec.startsWith('opus')) {
		// Opus-specific validation

		if (metadata.decoderConfig.codec !== 'opus') {
			throw new TypeError('Audio chunk metadata decoder configuration codec string for Opus must be "opus".');
		}

		if (metadata.decoderConfig.description && metadata.decoderConfig.description.byteLength < 18) {
			// Description is optional for Opus per-spec, so we shouldn't enforce it
			throw new TypeError(
				'Audio chunk metadata decoder configuration description, when specified, is expected to be an'
				+ ' Identification Header as specified in Section 5.1 of RFC 7845.',
			);
		}
	} else if (metadata.decoderConfig.codec.startsWith('vorbis')) {
		// Vorbis-specific validation

		if (metadata.decoderConfig.codec !== 'vorbis') {
			throw new TypeError('Audio chunk metadata decoder configuration codec string for Vorbis must be "vorbis".');
		}

		if (!metadata.decoderConfig.description) {
			throw new TypeError(
				'Audio chunk metadata decoder configuration for Vorbis must include a description, which is expected to'
				+ ' adhere to the format described in https://www.w3.org/TR/webcodecs-vorbis-codec-registration/.',
			);
		}
	} else if (metadata.decoderConfig.codec.startsWith('flac')) {
		// FLAC-specific validation

		if (metadata.decoderConfig.codec !== 'flac') {
			throw new TypeError('Audio chunk metadata decoder configuration codec string for FLAC must be "flac".');
		}

		const minDescriptionSize = 4 + 4 + 34; // 'fLaC' + metadata block header + STREAMINFO block
		if (!metadata.decoderConfig.description || metadata.decoderConfig.description.byteLength < minDescriptionSize) {
			throw new TypeError(
				'Audio chunk metadata decoder configuration for FLAC must include a description, which is expected to'
				+ ' adhere to the format described in https://www.w3.org/TR/webcodecs-flac-codec-registration/.',
			);
		}
	} else if (metadata.decoderConfig.codec.startsWith('ac-3') || metadata.decoderConfig.codec.startsWith('ac3')) {
		// AC3-specific validation

		if (metadata.decoderConfig.codec !== 'ac-3') {
			throw new TypeError('Audio chunk metadata decoder configuration codec string for AC-3 must be "ac-3".');
		}
	} else if (metadata.decoderConfig.codec.startsWith('ec-3') || metadata.decoderConfig.codec.startsWith('eac3')) {
		// EAC3-specific validation

		if (metadata.decoderConfig.codec !== 'ec-3') {
			throw new TypeError('Audio chunk metadata decoder configuration codec string for EC-3 must be "ec-3".');
		}
	} else if (
		metadata.decoderConfig.codec.startsWith('pcm')
		|| metadata.decoderConfig.codec.startsWith('ulaw')
		|| metadata.decoderConfig.codec.startsWith('alaw')
	) {
		// PCM-specific validation

		if (!(PCM_AUDIO_CODECS as readonly string[]).includes(metadata.decoderConfig.codec)) {
			throw new TypeError(
				'Audio chunk metadata decoder configuration codec string for PCM must be one of the supported PCM'
				+ ` codecs (${PCM_AUDIO_CODECS.join(', ')}).`,
			);
		}
	}
};

export const validateSubtitleMetadata = (metadata: SubtitleMetadata | undefined) => {
	if (!metadata) {
		throw new TypeError('Subtitle metadata must be provided.');
	}
	if (typeof metadata !== 'object') {
		throw new TypeError('Subtitle metadata must be an object.');
	}
	if (!metadata.config) {
		throw new TypeError('Subtitle metadata must include a config object.');
	}
	if (typeof metadata.config !== 'object') {
		throw new TypeError('Subtitle metadata config must be an object.');
	}
	if (typeof metadata.config.description !== 'string') {
		throw new TypeError('Subtitle metadata config description must be a string.');
	}
};
