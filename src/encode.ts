/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AUDIO_CODECS,
	AudioCodec,
	buildAudioCodecString,
	buildVideoCodecString,
	getAudioEncoderConfigExtension,
	getVideoEncoderConfigExtension,
	inferCodecFromCodecString,
	MediaCodec,
	PCM_AUDIO_CODECS,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { customAudioEncoders, customVideoEncoders } from './custom-coder';
import { isFirefox } from './misc';
import { EncodedPacket } from './packet';

/**
 * Configuration object that controls video encoding. Can be used to set codec, quality, and more.
 * @group Encoding
 * @public
 */
export type VideoEncodingConfig = {
	/** The video codec that should be used for encoding the video samples (frames). */
	codec: VideoCodec;
	/**
	 * The target bitrate for the encoded video, in bits per second. Alternatively, a subjective {@link Quality} can
	 * be provided.
	 */
	bitrate: number | Quality;
	/**
	 * The interval, in seconds, of how often frames are encoded as a key frame. The default is 5 seconds. Frequent key
	 * frames improve seeking behavior but increase file size. When using multiple video tracks, you should give them
	 * all the same key frame interval.
	 */
	keyFrameInterval?: number;
	/**
	 * Video frames may change size over time. This field controls the behavior in case this happens.
	 *
	 * - `'deny'` (default) will throw an error, requiring all frames to have the exact same dimensions.
	 * - `'passThrough'` will allow the change and directly pass the frame to the encoder.
	 * - `'fill'` will stretch the image to fill the entire original box, potentially altering aspect ratio.
	 * - `'contain'` will contain the entire image within the original box while preserving aspect ratio. This may lead
	 * to letterboxing.
	 * - `'cover'` will scale the image until the entire original box is filled, while preserving aspect ratio.
	 *
	 * The "original box" refers to the dimensions of the first encoded frame.
	 */
	sizeChangeBehavior?: 'deny' | 'passThrough' | 'fill' | 'contain' | 'cover';

	/** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
	onEncodedPacket?: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => unknown;
	/**
	 * Called when the internal [encoder config](https://www.w3.org/TR/webcodecs/#video-encoder-config), as used by the
	 * WebCodecs API, is created.
	 */
	onEncoderConfig?: (config: VideoEncoderConfig) => unknown;
} & VideoEncodingAdditionalOptions;

export const validateVideoEncodingConfig = (config: VideoEncodingConfig) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('Encoding config must be an object.');
	}
	if (!VIDEO_CODECS.includes(config.codec)) {
		throw new TypeError(`Invalid video codec '${config.codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
	}
	if (!(config.bitrate instanceof Quality) && (!Number.isInteger(config.bitrate) || config.bitrate <= 0)) {
		throw new TypeError('config.bitrate must be a positive integer or a quality.');
	}
	if (
		config.keyFrameInterval !== undefined
		&& (!Number.isFinite(config.keyFrameInterval) || config.keyFrameInterval < 0)
	) {
		throw new TypeError('config.keyFrameInterval, when provided, must be a non-negative number.');
	}
	if (
		config.sizeChangeBehavior !== undefined
		&& !['deny', 'passThrough', 'fill', 'contain', 'cover'].includes(config.sizeChangeBehavior)
	) {
		throw new TypeError(
			'config.sizeChangeBehavior, when provided, must be \'deny\', \'passThrough\', \'fill\', \'contain\''
			+ ' or \'cover\'.',
		);
	}
	if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
		throw new TypeError('config.onEncodedChunk, when provided, must be a function.');
	}
	if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
		throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
	}

	validateVideoEncodingAdditionalOptions(config.codec, config);
};

/**
 * Additional options that control audio encoding.
 * @group Encoding
 * @public
 */
export type VideoEncodingAdditionalOptions = {
	/**
	 * What to do with alpha data contained in the video samples.
	 *
	 * - `'discard'` (default): Only the samples' color data is kept; the video is opaque.
	 * - `'keep'`: The samples' alpha data is also encoded as side data. Make sure to pair this mode with a container
	 * format that supports transparency (such as WebM or Matroska).
	 */
	alpha?: 'discard' | 'keep';
	/** Configures the bitrate mode; defaults to `'variable'`. */
	bitrateMode?: 'constant' | 'variable';
	/**
	 * The latency mode used by the encoder; controls the performance-quality tradeoff.
	 *
	 * - `'quality'` (default): The encoder prioritizes quality over latency, and no frames can be dropped.
	 * - `'realtime'`: The encoder prioritizes low latency over quality, and may drop frames if the encoder becomes
	 * overloaded to keep up with real-time requirements.
	 */
	latencyMode?: 'quality' | 'realtime';
	/**
	 * The full codec string as specified in the Mediabunny Codec Registry. This string must match the codec
	 * specified in `codec`. When not set, a fitting codec string will be constructed automatically by the library.
	 */
	fullCodecString?: string;
	/**
	 * A hint that configures the hardware acceleration method of this codec. This is best left on `'no-preference'`,
	 * the default.
	 */
	hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
	/**
	 * An encoding scalability mode identifier as defined by
	 * [WebRTC-SVC](https://w3c.github.io/webrtc-svc/#scalabilitymodes*).
	 */
	scalabilityMode?: string;
	/**
	 * An encoding video content hint as defined by
	 * [mst-content-hint](https://w3c.github.io/mst-content-hint/#video-content-hints).
	 */
	contentHint?: string;
};

export const validateVideoEncodingAdditionalOptions = (codec: VideoCodec, options: VideoEncodingAdditionalOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('Encoding options must be an object.');
	}
	if (options.alpha !== undefined && !['discard', 'keep'].includes(options.alpha)) {
		throw new TypeError('options.alpha, when provided, must be \'discard\' or \'keep\'.');
	}
	if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
		throw new TypeError('bitrateMode, when provided, must be \'constant\' or \'variable\'.');
	}
	if (options.latencyMode !== undefined && !['quality', 'realtime'].includes(options.latencyMode)) {
		throw new TypeError('latencyMode, when provided, must be \'quality\' or \'realtime\'.');
	}
	if (options.fullCodecString !== undefined && typeof options.fullCodecString !== 'string') {
		throw new TypeError('fullCodecString, when provided, must be a string.');
	}
	if (options.fullCodecString !== undefined && inferCodecFromCodecString(options.fullCodecString) !== codec) {
		throw new TypeError(
			`fullCodecString, when provided, must be a string that matches the specified codec (${codec}).`,
		);
	}
	if (
		options.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(options.hardwareAcceleration)
	) {
		throw new TypeError(
			'hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
			+ ' \'prefer-software\'.',
		);
	}
	if (options.scalabilityMode !== undefined && typeof options.scalabilityMode !== 'string') {
		throw new TypeError('scalabilityMode, when provided, must be a string.');
	}
	if (options.contentHint !== undefined && typeof options.contentHint !== 'string') {
		throw new TypeError('contentHint, when provided, must be a string.');
	}
};

export const buildVideoEncoderConfig = (options: {
	codec: VideoCodec;
	width: number;
	height: number;
	bitrate: number | Quality;
	framerate: number | undefined;
} & VideoEncodingAdditionalOptions): VideoEncoderConfig => {
	const resolvedBitrate = options.bitrate instanceof Quality
		? options.bitrate._toVideoBitrate(options.codec, options.width, options.height)
		: options.bitrate;

	return {
		codec: options.fullCodecString ?? buildVideoCodecString(
			options.codec,
			options.width,
			options.height,
			resolvedBitrate,
		),
		width: options.width,
		height: options.height,
		bitrate: resolvedBitrate,
		bitrateMode: options.bitrateMode,
		alpha: options.alpha ?? 'discard',
		framerate: options.framerate,
		latencyMode: options.latencyMode,
		hardwareAcceleration: options.hardwareAcceleration,
		scalabilityMode: options.scalabilityMode,
		contentHint: options.contentHint,
		...getVideoEncoderConfigExtension(options.codec),
	};
};

/**
 * Configuration object that controls audio encoding. Can be used to set codec, quality, and more.
 * @group Encoding
 * @public
 */
export type AudioEncodingConfig = {
	/** The audio codec that should be used for encoding the audio samples. */
	codec: AudioCodec;
	/**
	 * The target bitrate for the encoded audio, in bits per second. Alternatively, a subjective {@link Quality} can
	 * be provided. Required for compressed audio codecs, unused for PCM codecs.
	 */
	bitrate?: number | Quality;

	/** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
	onEncodedPacket?: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => unknown;
	/**
	 * Called when the internal [encoder config](https://www.w3.org/TR/webcodecs/#audio-encoder-config), as used by the
	 * WebCodecs API, is created.
	 */
	onEncoderConfig?: (config: AudioEncoderConfig) => unknown;
} & AudioEncodingAdditionalOptions;

export const validateAudioEncodingConfig = (config: AudioEncodingConfig) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('Encoding config must be an object.');
	}
	if (!AUDIO_CODECS.includes(config.codec)) {
		throw new TypeError(`Invalid audio codec '${config.codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
	}
	if (
		config.bitrate === undefined
		&& (!(PCM_AUDIO_CODECS as readonly string[]).includes(config.codec) || config.codec === 'flac')
	) {
		throw new TypeError('config.bitrate must be provided for compressed audio codecs.');
	}
	if (
		config.bitrate !== undefined
		&& !(config.bitrate instanceof Quality)
		&& (!Number.isInteger(config.bitrate) || config.bitrate <= 0)
	) {
		throw new TypeError('config.bitrate, when provided, must be a positive integer or a quality.');
	}
	if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
		throw new TypeError('config.onEncodedChunk, when provided, must be a function.');
	}
	if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
		throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
	}

	validateAudioEncodingAdditionalOptions(config.codec, config);
};

/**
 * Additional options that control audio encoding.
 * @group Encoding
 * @public
 */
export type AudioEncodingAdditionalOptions = {
	/** Configures the bitrate mode. */
	bitrateMode?: 'constant' | 'variable';
	/**
	 * The full codec string as specified in the Mediabunny Codec Registry. This string must match the codec
	 * specified in `codec`. When not set, a fitting codec string will be constructed automatically by the library.
	 */
	fullCodecString?: string;
};

export const validateAudioEncodingAdditionalOptions = (codec: AudioCodec, options: AudioEncodingAdditionalOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('Encoding options must be an object.');
	}
	if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
		throw new TypeError('bitrateMode, when provided, must be \'constant\' or \'variable\'.');
	}
	if (options.fullCodecString !== undefined && typeof options.fullCodecString !== 'string') {
		throw new TypeError('fullCodecString, when provided, must be a string.');
	}
	if (options.fullCodecString !== undefined && inferCodecFromCodecString(options.fullCodecString) !== codec) {
		throw new TypeError(
			`fullCodecString, when provided, must be a string that matches the specified codec (${codec}).`,
		);
	}
};

export const buildAudioEncoderConfig = (options: {
	codec: AudioCodec;
	numberOfChannels: number;
	sampleRate: number;
	bitrate?: number | Quality;
} & AudioEncodingAdditionalOptions): AudioEncoderConfig => {
	const resolvedBitrate = options.bitrate instanceof Quality
		? options.bitrate._toAudioBitrate(options.codec)
		: options.bitrate;

	return {
		codec: options.fullCodecString ?? buildAudioCodecString(
			options.codec,
			options.numberOfChannels,
			options.sampleRate,
		),
		numberOfChannels: options.numberOfChannels,
		sampleRate: options.sampleRate,
		bitrate: resolvedBitrate,
		bitrateMode: options.bitrateMode,
		...getAudioEncoderConfigExtension(options.codec),
	};
};

/**
 * Represents a subjective media quality level.
 * @group Encoding
 * @public
 */
export class Quality {
	/** @internal */
	_factor: number;

	/** @internal */
	constructor(factor: number) {
		this._factor = factor;
	}

	/** @internal */
	_toVideoBitrate(codec: VideoCodec, width: number, height: number) {
		const pixels = width * height;

		const codecEfficiencyFactors = {
			avc: 1.0, // H.264/AVC (baseline)
			hevc: 0.6, // H.265/HEVC (~40% more efficient than AVC)
			vp9: 0.6, // Similar to HEVC
			av1: 0.4, // ~60% more efficient than AVC
			vp8: 1.2, // Slightly less efficient than AVC
		};

		const referencePixels = 1920 * 1080;
		const referenceBitrate = 3000000;
		const scaleFactor = Math.pow(pixels / referencePixels, 0.95); // Slight non-linear scaling
		const baseBitrate = referenceBitrate * scaleFactor;

		const codecAdjustedBitrate = baseBitrate * codecEfficiencyFactors[codec];
		const finalBitrate = codecAdjustedBitrate * this._factor;

		return Math.ceil(finalBitrate / 1000) * 1000;
	}

	/** @internal */
	_toAudioBitrate(codec: AudioCodec) {
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec) || codec === 'flac') {
			return undefined;
		}

		const baseRates = {
			aac: 128000, // 128kbps base for AAC
			opus: 64000, // 64kbps base for Opus
			mp3: 160000, // 160kbps base for MP3
			vorbis: 64000, // 64kbps base for Vorbis
			ac3: 384000, // 384kbps base for AC-3
			eac3: 192000, // 192kbps base for E-AC-3
		};

		const baseBitrate = baseRates[codec as keyof typeof baseRates];
		if (!baseBitrate) {
			throw new Error(`Unhandled codec: ${codec}`);
		}

		let finalBitrate = baseBitrate * this._factor;

		if (codec === 'aac') {
			// AAC only works with specific bitrates, let's find the closest
			const validRates = [96000, 128000, 160000, 192000];
			finalBitrate = validRates.reduce((prev, curr) =>
				Math.abs(curr - finalBitrate) < Math.abs(prev - finalBitrate) ? curr : prev,
			);
		} else if (codec === 'opus' || codec === 'vorbis') {
			finalBitrate = Math.max(6000, finalBitrate);
		} else if (codec === 'mp3') {
			const validRates = [
				8000, 16000, 24000, 32000, 40000, 48000, 64000, 80000,
				96000, 112000, 128000, 160000, 192000, 224000, 256000, 320000,
			];
			finalBitrate = validRates.reduce((prev, curr) =>
				Math.abs(curr - finalBitrate) < Math.abs(prev - finalBitrate) ? curr : prev,
			);
		}

		return Math.round(finalBitrate / 1000) * 1000;
	}
}

/**
 * Represents a very low media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_VERY_LOW = /* #__PURE__ */ new Quality(0.3);
/**
 * Represents a low media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_LOW = /* #__PURE__ */ new Quality(0.6);
/**
 * Represents a medium media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_MEDIUM = /* #__PURE__ */ new Quality(1);
/**
 * Represents a high media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_HIGH = /* #__PURE__ */ new Quality(2);
/**
 * Represents a very high media quality.
 * @group Encoding
 * @public
 */
export const QUALITY_VERY_HIGH = /* #__PURE__ */ new Quality(4);

/**
 * Checks if the browser is able to encode the given codec.
 * @group Encoding
 * @public
 */
export const canEncode = (codec: MediaCodec) => {
	if ((VIDEO_CODECS as readonly string[]).includes(codec)) {
		return canEncodeVideo(codec as VideoCodec);
	} else if ((AUDIO_CODECS as readonly string[]).includes(codec)) {
		return canEncodeAudio(codec as AudioCodec);
	} else if ((SUBTITLE_CODECS as readonly string[]).includes(codec)) {
		return canEncodeSubtitles(codec as SubtitleCodec);
	}

	throw new TypeError(`Unknown codec '${codec}'.`);
};

/**
 * Checks if the browser is able to encode the given video codec with the given parameters.
 * @group Encoding
 * @public
 */
export const canEncodeVideo = async (
	codec: VideoCodec,
	options: {
		width?: number;
		height?: number;
		bitrate?: number | Quality;
	} & VideoEncodingAdditionalOptions = {},
) => {
	const {
		width = 1280,
		height = 720,
		bitrate = 1e6,
		...restOptions
	} = options;

	if (!VIDEO_CODECS.includes(codec)) {
		return false;
	}
	if (!Number.isInteger(width) || width <= 0) {
		throw new TypeError('width must be a positive integer.');
	}
	if (!Number.isInteger(height) || height <= 0) {
		throw new TypeError('height must be a positive integer.');
	}
	if (!(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('bitrate must be a positive integer or a quality.');
	}
	validateVideoEncodingAdditionalOptions(codec, restOptions);

	let encoderConfig: VideoEncoderConfig | null = null;

	if (customVideoEncoders.length > 0) {
		encoderConfig ??= buildVideoEncoderConfig({
			codec,
			width,
			height,
			bitrate,
			framerate: undefined,
			...restOptions,
		});

		if (customVideoEncoders.some(x => x.supports(codec, encoderConfig!))) {
			// There's a custom encoder
			return true;
		}
	}

	if (typeof VideoEncoder === 'undefined') {
		return false;
	}

	const hasOddDimension = width % 2 === 1 || height % 2 === 1;
	if (
		hasOddDimension
		&& (codec === 'avc' || codec === 'hevc')
	) {
		// Disallow odd dimensions for certain codecs
		return false;
	}

	encoderConfig ??= buildVideoEncoderConfig({
		codec,
		width,
		height,
		bitrate,
		framerate: undefined,
		...restOptions,
		alpha: 'discard', // Since we handle alpha ourselves
	});

	const support = await VideoEncoder.isConfigSupported(encoderConfig);
	if (!support.supported) {
		return false;
	}

	if (isFirefox()) {
		// isConfigSupported on Firefox appears to unreliably indicate if encoding will actually succeed. Therefore, we
		// just try encoding a frame to see if it actually works.
		// https://github.com/Vanilagy/mediabunny/issues/222

		// eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
		return new Promise<boolean>(async (resolve) => {
			try {
				const encoder = new VideoEncoder({
					output: () => {},
					error: () => resolve(false),
				});
				encoder.configure(encoderConfig);

				const frameData = new Uint8Array(width * height * 4);
				const frame = new VideoFrame(frameData, {
					format: 'RGBA',
					codedWidth: width,
					codedHeight: height,
					timestamp: 0,
				});

				encoder.encode(frame);
				frame.close();

				await encoder.flush();

				resolve(true);
			} catch {
				resolve(false);
			}
		});
	} else {
		return true;
	}
};

/**
 * Checks if the browser is able to encode the given audio codec with the given parameters.
 * @group Encoding
 * @public
 */
export const canEncodeAudio = async (
	codec: AudioCodec,
	options: {
		numberOfChannels?: number;
		sampleRate?: number;
		bitrate?: number | Quality;
	} & AudioEncodingAdditionalOptions = {},
) => {
	const {
		numberOfChannels = 2,
		sampleRate = 48000,
		bitrate = 128e3,
		...restOptions
	} = options;

	if (!AUDIO_CODECS.includes(codec)) {
		return false;
	}
	if (!Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
		throw new TypeError('numberOfChannels must be a positive integer.');
	}
	if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
		throw new TypeError('sampleRate must be a positive integer.');
	}
	if (!(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('bitrate must be a positive integer.');
	}
	validateAudioEncodingAdditionalOptions(codec, restOptions);

	let encoderConfig: AudioEncoderConfig | null = null;

	if (customAudioEncoders.length > 0) {
		encoderConfig ??= buildAudioEncoderConfig({
			codec,
			numberOfChannels,
			sampleRate,
			bitrate,
			...restOptions,
		});

		if (customAudioEncoders.some(x => x.supports(codec, encoderConfig!))) {
			// There's a custom encoder
			return true;
		}
	}

	if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
		return true; // Because we encode these ourselves
	}

	if (typeof AudioEncoder === 'undefined') {
		return false;
	}

	encoderConfig ??= buildAudioEncoderConfig({
		codec,
		numberOfChannels,
		sampleRate,
		bitrate,
		...restOptions,
	});

	const support = await AudioEncoder.isConfigSupported(encoderConfig);
	return support.supported === true;
};

/**
 * Checks if the browser is able to encode the given subtitle codec.
 * @group Encoding
 * @public
 */
export const canEncodeSubtitles = async (codec: SubtitleCodec) => {
	if (!SUBTITLE_CODECS.includes(codec)) {
		return false;
	}

	return true;
};

/**
 * Returns the list of all media codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableCodecs = async (): Promise<MediaCodec[]> => {
	const [videoCodecs, audioCodecs, subtitleCodecs] = await Promise.all([
		getEncodableVideoCodecs(),
		getEncodableAudioCodecs(),
		getEncodableSubtitleCodecs(),
	]);

	return [...videoCodecs, ...audioCodecs, ...subtitleCodecs];
};

/**
 * Returns the list of all video codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableVideoCodecs = async (
	checkedCodecs: VideoCodec[] = VIDEO_CODECS as unknown as VideoCodec[],
	options?: {
		width?: number;
		height?: number;
		bitrate?: number | Quality;
	},
): Promise<VideoCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canEncodeVideo(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the list of all audio codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableAudioCodecs = async (
	checkedCodecs: AudioCodec[] = AUDIO_CODECS as unknown as AudioCodec[],
	options?: {
		numberOfChannels?: number;
		sampleRate?: number;
		bitrate?: number | Quality;
	},
): Promise<AudioCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canEncodeAudio(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the list of all subtitle codecs that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getEncodableSubtitleCodecs = async (
	checkedCodecs: SubtitleCodec[] = SUBTITLE_CODECS as unknown as SubtitleCodec[],
): Promise<SubtitleCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(canEncodeSubtitles));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the first video codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getFirstEncodableVideoCodec = async (
	checkedCodecs: VideoCodec[],
	options?: {
		width?: number;
		height?: number;
		bitrate?: number | Quality;
	},
): Promise<VideoCodec | null> => {
	for (const codec of checkedCodecs) {
		if (await canEncodeVideo(codec, options)) {
			return codec;
		}
	}

	return null;
};

/**
 * Returns the first audio codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getFirstEncodableAudioCodec = async (
	checkedCodecs: AudioCodec[],
	options?: {
		numberOfChannels?: number;
		sampleRate?: number;
		bitrate?: number | Quality;
	},
): Promise<AudioCodec | null> => {
	for (const codec of checkedCodecs) {
		if (await canEncodeAudio(codec, options)) {
			return codec;
		}
	}

	return null;
};

/**
 * Returns the first subtitle codec from the given list that can be encoded by the browser.
 * @group Encoding
 * @public
 */
export const getFirstEncodableSubtitleCodec = async (
	checkedCodecs: SubtitleCodec[],
): Promise<SubtitleCodec | null> => {
	for (const codec of checkedCodecs) {
		if (await canEncodeSubtitles(codec)) {
			return codec;
		}
	}

	return null;
};
