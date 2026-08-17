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
import { assert, clamp, isFirefox, lerp, MaybePromise, Rotation } from './misc';
import { EncodedPacket } from './packet';
import { AudioSample, CropRectangle, validateCropRectangle, VideoSample, VideoSampleResource } from './sample';

export const canEncodeVideoMemo = new Map<string, Promise<boolean>>();
export const canEncodeAudioMemo = new Map<string, Promise<boolean>>();

/**
 * Configuration object that controls video encoding. Can be used to set codec, quality, and more.
 * @group Encoding
 * @public
 */
export type VideoEncodingConfig = {
	/** The video codec that should be used for encoding the video samples (frames). */
	codec: VideoCodec;
	/** The desired quality of the encoded video. */
	quality?: Quality;
	/**
	 * The target bitrate for the encoded video, in bits per second. Alternatively, a {@link Quality} can be provided.
	 * @deprecated Use `quality` instead.
	 */
	bitrate?: number | Quality;
	/**
	 * The interval, in seconds, of how often frames are encoded as a key frame. The default is 2 seconds. Frequent key
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

	/**
	 * Optional transformations to apply to the video frames before they are passed to the encoder.
	 */
	transform?: VideoTransformOptions;

	/** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
	onEncodedPacket?: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => unknown;
	/**
	 * Called when the internal [encoder config](https://www.w3.org/TR/webcodecs/#video-encoder-config), as used by the
	 * WebCodecs API, is created.
	 */
	onEncoderConfig?: (config: VideoEncoderConfig) => unknown;
	/** Called right before a sample is passed to the encoder. */
	onEncodedSample?: (sample: VideoSample) => unknown;
} & VideoEncodingAdditionalOptions;

/**
 * Options for transforming video frames before encoding.
 * @group Encoding
 * @public
 */
export type VideoTransformOptions = {
	/**
	 * The width in pixels to resize the frames to. If height is not set, it will be deduced
	 * automatically based on aspect ratio.
	 */
	width?: number;
	/**
	 * The height in pixels to resize the frames to. If width is not set, it will be deduced
	 * automatically based on aspect ratio.
	 */
	height?: number;
	/**
	 * The fitting algorithm in case both width and height are set.
	 *
	 * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
	 * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
	 * letterboxing.
	 * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
	 *
	 * To avoid ambiguity, this field must not be set when `sizeChangeBehavior` is `'fill'`, `'contain'` or
	 * `'deny'`, since `sizeChangeBehavior` already determines the fitting algorithm.
	 */
	fit?: 'fill' | 'contain' | 'cover';
	/**
	 * The clockwise rotation by which to rotate the frames. Rotation is applied before resizing.
	 */
	rotate?: Rotation;
	/**
	 * Specifies the rectangular region of the frames to crop to. The crop region will automatically be
	 * clamped to the dimensions of the frame. Cropping is performed after rotation but before resizing.
	 */
	crop?: CropRectangle;
	/**
	 * Whether to discard or keep the transparency information of the video samples. The default is `'keep'`.
	 */
	alpha?: 'keep' | 'discard';
	/**
	 * The frame rate in hertz to normalize the video frame stream to.
	 */
	frameRate?: number;
	/**
	 * Allows for custom user-defined processing of video frames, e.g. for applying overlays, color transformations,
	 * or timestamp modifications. Will be called for each video frame after transformations and frame rate
	 * corrections.
	 *
	 * Must return a {@link VideoSample}, a {@link VideoSampleResource} or a `CanvasImageSource`, an array of them, or
	 * `null` for dropping the frame. When non-timestamped data is returned, the timestamp and duration from the input
	 * sample will be used.
	 */
	process?: (sample: VideoSample) => MaybePromise<
		CanvasImageSource | VideoSample | VideoSampleResource
		| (CanvasImageSource | VideoSample | VideoSampleResource)[] | null
	>;
	/**
	 * Forces every video frame through the transformation step even if no transformation properties are defined.
	 * This can be used, for example, to bake rotation into the encoded video frames.
	 */
	force?: boolean;
};

export const validateVideoEncodingConfig = (config: VideoEncodingConfig) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('Encoding config must be an object.');
	}
	if (!VIDEO_CODECS.includes(config.codec)) {
		throw new TypeError(`Invalid video codec '${config.codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
	}
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const bitrate = config.bitrate;
	if (config.quality === undefined && bitrate === undefined) {
		throw new TypeError('config.quality must be provided.');
	}
	if (config.quality !== undefined && bitrate !== undefined) {
		throw new TypeError('config.quality and config.bitrate cannot both be provided.');
	}
	if (config.quality !== undefined && !(config.quality instanceof Quality)) {
		throw new TypeError('config.quality, when provided, must be a Quality.');
	}
	if (bitrate !== undefined && !(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('config.bitrate, when provided, must be a positive integer or a quality.');
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
	if (config.transform !== undefined) {
		if (typeof config.transform !== 'object' || !config.transform) {
			throw new TypeError('config.transform, when provided, must be an object.');
		}
		if (
			config.transform.width !== undefined
			&& (!Number.isInteger(config.transform.width) || config.transform.width <= 0)
		) {
			throw new TypeError('config.transform.width, when provided, must be a positive integer.');
		}
		if (
			config.transform.height !== undefined
			&& (!Number.isInteger(config.transform.height) || config.transform.height <= 0)
		) {
			throw new TypeError('config.transform.height, when provided, must be a positive integer.');
		}
		if (config.transform.fit !== undefined && !['fill', 'contain', 'cover'].includes(config.transform.fit)) {
			throw new TypeError('config.transform.fit, when provided, must be one of "fill", "contain", or "cover".');
		}
		if (
			config.transform.width !== undefined
			&& config.transform.height !== undefined
			&& config.transform.fit === undefined
			&& !['fill', 'contain', 'cover'].includes(config.sizeChangeBehavior!)
		) {
			throw new TypeError(
				'When both config.transform.width and config.transform.height are provided, config.transform.fit'
				+ ' must also be provided.',
			);
		}
		if (
			config.transform.fit !== undefined
			&& ['fill', 'contain', 'cover'].includes(config.sizeChangeBehavior!)
			&& config.transform.fit !== config.sizeChangeBehavior
		) {
			throw new TypeError(
				'config.transform.fit, when provided, cannot differ from config.sizeChangeBehavior when'
				+ ' config.sizeChangeBehavior is \'fill\', \'contain\' or \'cover\', as sizeChangeBehavior already'
				+ ' determines the fitting algorithm.',
			);
		}
		if (config.transform.rotate !== undefined && ![0, 90, 180, 270].includes(config.transform.rotate)) {
			throw new TypeError('config.transform.rotate, when provided, must be 0, 90, 180 or 270.');
		}
		if (config.transform.crop !== undefined) {
			validateCropRectangle(config.transform.crop, 'config.transform.');
		}
		if (config.transform.process !== undefined && typeof config.transform.process !== 'function') {
			throw new TypeError('config.transform.process, when provided, must be a function.');
		}
		if (
			config.transform.frameRate !== undefined
			&& (!Number.isFinite(config.transform.frameRate) || config.transform.frameRate <= 0)
		) {
			throw new TypeError('config.transform.frameRate, when provided, must be a finite positive number.');
		}
		if (config.transform.force !== undefined && typeof config.transform.force !== 'boolean') {
			throw new TypeError('config.transform.force, when provided, must be a boolean.');
		}
	}
	if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
		throw new TypeError('config.onEncodedPacket, when provided, must be a function.');
	}
	if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
		throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
	}
	if (config.onEncodedSample !== undefined && typeof config.onEncodedSample !== 'function') {
		throw new TypeError('config.onEncodedSample, when provided, must be a function.');
	}

	validateVideoEncodingAdditionalOptions(config.codec, config);
};

/**
 * Additional options that control video encoding.
 * @group Encoding
 * @public
 */
export type VideoEncodingAdditionalOptions = {
	/**
	 * What to do with alpha data contained in the video samples.
	 *
	 * - `'discard'` (default): Only the samples' color data is kept; the video is opaque.
	 * - `'keep'`: The samples' alpha data is also encoded. Depending on the codec, the alpha may be emitted as packet
	 * side data or in-band alongside the main packet. For codecs that emit alpha side data, such as VP9, make sure to
	 * pair this mode with a container format that supports transparency (such as WebM or Matroska).
	 */
	alpha?: 'discard' | 'keep';
	/**
	 * Configures the bitrate mode used for bitrate-based encoding; defaults to `'variable'`. A bitrate mode set
	 * directly on a {@link Quality} takes precedence over this field.
	 * @deprecated Specify the bitrate mode in the {@link Quality} instead.
	 */
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
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const bitrateMode = options.bitrateMode;
	if (bitrateMode !== undefined && !['constant', 'variable'].includes(bitrateMode)) {
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

export type VideoEncoderConfigCandidate = {
	config: VideoEncoderConfig;
	quantizer: number | null; // Since the actual config doesn't contain the quantizer
};

export type VideoRateControl = {
	quantizer: number | null;
	bitrate: number;
	bitrateMode: 'constant' | 'variable' | 'quantizer';
};

/**
 * Builds the encoder configs to attempt, in order of preference. Multiple configs are returned when a Quality can be
 * satisfied by multiple rate control methods (quantizer-based encoding with a bitrate-based fallback).
 */
export const buildVideoEncoderConfigs = (options: {
	codec: VideoCodec;
	width: number;
	height: number;
	quality: Quality;
	framerate: number | undefined;
	squarePixelWidth?: number;
	squarePixelHeight?: number;
} & VideoEncodingAdditionalOptions): VideoEncoderConfigCandidate[] => {
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const fallbackBitrateMode = options.bitrateMode;

	const rateControl = options.quality._toVideoRateControl(
		options.codec,
		options.width,
		options.height,
		fallbackBitrateMode,
	);

	const buildConfig = (
		bitrate: number | undefined,
		bitrateMode: 'constant' | 'variable' | 'quantizer',
		bitrateEstimate: number,
	): VideoEncoderConfig => ({
		codec: options.fullCodecString ?? buildVideoCodecString(
			options.codec,
			options.width,
			options.height,
			bitrateEstimate,
			options.alpha === 'keep',
		),
		width: options.width,
		height: options.height,
		displayWidth: options.squarePixelWidth,
		displayHeight: options.squarePixelHeight,
		bitrate,
		bitrateMode,
		alpha: options.alpha ?? 'discard',
		framerate: options.framerate,
		latencyMode: options.latencyMode,
		hardwareAcceleration: options.hardwareAcceleration,
		scalabilityMode: options.scalabilityMode,
		contentHint: options.contentHint,
		...getVideoEncoderConfigExtension(options.codec),
	});

	const candidates: VideoEncoderConfigCandidate[] = [];

	if (rateControl.quantizer !== null) {
		candidates.push({
			config: buildConfig(undefined, 'quantizer', rateControl.bitrate),
			quantizer: rateControl.quantizer,
		});
	}

	if (rateControl.bitrateMode !== 'quantizer') {
		candidates.push({
			config: buildConfig(rateControl.bitrate, rateControl.bitrateMode, rateControl.bitrate),
			quantizer: null,
		});
	}

	assert(candidates.length > 0);

	return candidates;
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
	 * The desired quality of the encoded audio. Required for compressed audio codecs, unused for PCM codecs.
	 */
	quality?: Quality;
	/**
	 * The target bitrate for the encoded audio, in bits per second. Alternatively, a {@link Quality} can be provided.
	 * @deprecated Use `quality` instead.
	 */
	bitrate?: number | Quality;

	/**
	 * Optional transformations to apply to the audio samples before they are passed to the encoder.
	 */
	transform?: AudioTransformOptions;

	/** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
	onEncodedPacket?: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => unknown;
	/**
	 * Called when the internal [encoder config](https://www.w3.org/TR/webcodecs/#audio-encoder-config), as used by the
	 * WebCodecs API, is created.
	 */
	onEncoderConfig?: (config: AudioEncoderConfig) => unknown;
	/** Called right before a sample is passed to the encoder. */
	onEncodedSample?: (sample: AudioSample) => unknown;
} & AudioEncodingAdditionalOptions;

/**
 * Options for transforming audio samples before encoding.
 * @group Encoding
 * @public
 */
export type AudioTransformOptions = {
	/** The desired number of output channels to up/downmix to. */
	numberOfChannels?: number;
	/** The desired output sample rate in hertz to resample to. */
	sampleRate?: number;
	/**
	 * The desired sample format (and therefore bit depth) of the audio samples before they are passed to the encoder.
	 * Can be used to control bit depth with certain output codecs such as FLAC.
	 */
	sampleFormat?: 'u8' | 's16' | 's32' | 'f32';
	/**
	 * Allows for custom user-defined processing of audio samples, e.g. for applying audio effects or timestamp
	 * modifications. Called for each audio sample after resampling and remixing.
	 *
	 * Must return an {@link AudioSample}, an array of them, or `null` for dropping the sample.
	 */
	process?: (sample: AudioSample) => MaybePromise<
		AudioSample | AudioSample[] | null
	>;
};

export const validateAudioEncodingConfig = (config: AudioEncodingConfig) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('Encoding config must be an object.');
	}
	if (!AUDIO_CODECS.includes(config.codec)) {
		throw new TypeError(`Invalid audio codec '${config.codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
	}
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const bitrate = config.bitrate;
	if (
		config.quality === undefined
		&& bitrate === undefined
		&& !((PCM_AUDIO_CODECS as readonly string[]).includes(config.codec) || config.codec === 'flac')
	) {
		throw new TypeError('config.quality must be provided for compressed audio codecs.');
	}
	if (config.quality !== undefined && bitrate !== undefined) {
		throw new TypeError('config.quality and config.bitrate cannot both be provided.');
	}
	if (config.quality !== undefined && !(config.quality instanceof Quality)) {
		throw new TypeError('config.quality, when provided, must be a Quality.');
	}
	if (bitrate !== undefined && !(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('config.bitrate, when provided, must be a positive integer or a quality.');
	}
	if (config.transform !== undefined) {
		if (typeof config.transform !== 'object' || !config.transform) {
			throw new TypeError('config.transform, when provided, must be an object.');
		}
		if (
			config.transform.numberOfChannels !== undefined
			&& (!Number.isInteger(config.transform.numberOfChannels) || config.transform.numberOfChannels <= 0)
		) {
			throw new TypeError('config.transform.numberOfChannels, when provided, must be a positive integer.');
		}
		if (
			config.transform.sampleRate !== undefined
			&& (!Number.isInteger(config.transform.sampleRate) || config.transform.sampleRate <= 0)
		) {
			throw new TypeError('config.transform.sampleRate, when provided, must be a positive integer.');
		}
		if (
			config.transform.sampleFormat !== undefined
			&& !['u8', 's16', 's32', 'f32'].includes(config.transform.sampleFormat)
		) {
			throw new TypeError('config.transform.sampleFormat, when provided, must be one of: u8, s16, s32, f32.');
		}
		if (config.transform.process !== undefined && typeof config.transform.process !== 'function') {
			throw new TypeError('config.transform.process, when provided, must be a function.');
		}
	}
	if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
		throw new TypeError('config.onEncodedPacket, when provided, must be a function.');
	}
	if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
		throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
	}
	if (config.onEncodedSample !== undefined && typeof config.onEncodedSample !== 'function') {
		throw new TypeError('config.onEncodedSample, when provided, must be a function.');
	}

	validateAudioEncodingAdditionalOptions(config.codec, config);
};

/**
 * Additional options that control audio encoding.
 * @group Encoding
 * @public
 */
export type AudioEncodingAdditionalOptions = {
	/**
	 * Configures the bitrate mode. A bitrate mode set directly on a {@link Quality} takes precedence over this field.
	 * @deprecated Specify the bitrate mode in the {@link Quality} instead.
	 */
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
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const bitrateMode = options.bitrateMode;
	if (bitrateMode !== undefined && !['constant', 'variable'].includes(bitrateMode)) {
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
	quality?: Quality;
} & AudioEncodingAdditionalOptions): AudioEncoderConfig => {
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const fallbackBitrateMode = options.bitrateMode;

	return {
		codec: options.fullCodecString ?? buildAudioCodecString(
			options.codec,
			options.numberOfChannels,
			options.sampleRate,
		),
		numberOfChannels: options.numberOfChannels,
		sampleRate: options.sampleRate,
		bitrate: options.quality?._toAudioBitrate(options.codec),
		bitrateMode: options.quality?._bitrateMode ?? fallbackBitrateMode,
		...getAudioEncoderConfigExtension(options.codec),
	};
};

/**
 * A named qualitative quality level.
 * @group Encoding
 * @public
 */
export type QualityLevel = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

/**
 * Quality options expressing a qualitative (subjective) quality level.
 * @group Encoding
 * @public
 */
export type QualitativeQualityOptions = {
	/**
	 * A qualitative quality level. Either a number ranging from 0 to 1, where 0 means worst and 1 means best quality,
	 * or one of five named levels ('very-low', 'low', 'medium', 'high', 'very-high'), which map to 0, 0.25, 0.5, 0.75
	 * and 1, respectively.
	 *
	 * Values outside the [0, 1] range are also allowed for extreme behavior, but might break on certain systems.
	 *
	 * Internally, either bitrate- or quantizer-driven encoding will be used, depending on availability and settings.
	 */
	quality: number | QualityLevel;
	/**
	 * When true, the quality level always maps to a bitrate, even if quantizer-based encoding is available. Useful
	 * when a predictable output size matters more than constant quality.
	 */
	preferBitrate?: boolean;
	/** The bitrate mode to use when encoding resolves to bitrate-based encoding. */
	bitrateMode?: 'constant' | 'variable';
};

/**
 * Quality options expressing quantitative rate control: an explicit bitrate, an explicit quantizer, or both.
 * @group Encoding
 * @public
 */
export type QuantitativeQualityOptions = {
	/**
	 * An explicit bitrate in bits per second. When set, this bitrate is used for encoding. It also acts as the
	 * fallback in case a specified quantizer cannot be used.
	 */
	bitrate?: number;
	/** The bitrate mode to use when encoding resolves to bitrate-based encoding. */
	bitrateMode?: 'constant' | 'variable';
	/**
	 * An explicit quantizer value used for quantizer-based video encoding; lower values mean higher quality. The valid
	 * range depends on the codec and is defined in the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview). This option is like FFmpeg's
	 * constant-rate factor (CRF).
	 *
	 * If the quantizer cannot be used due to missing support, then it will throw, unless `bitrate` is defined as a
	 * fallback.
	 */
	quantizer?: number;
};

/**
 * Options describing a desired encoding quality.
 * @group Encoding
 * @public
 */
export type QualityOptions = QualitativeQualityOptions | QuantitativeQualityOptions;

/**
 * Represents a desired encoding quality. Can express a qualitative quality level, an explicit bitrate, an explicit
 * quantizer value, or a combination thereof.
 * @group Encoding
 * @public
 */
export class Quality {
	/** @internal */
	_quality: number | undefined;
	/** @internal */
	_preferBitrate: boolean;
	/** @internal */
	_bitrate: number | undefined;
	/** @internal */
	_quantizer: number | undefined;
	/** @internal */
	_bitrateMode: 'constant' | 'variable' | undefined;

	constructor(options: QualityOptions | number | QualityLevel) {
		if (typeof options === 'number' || typeof options === 'string') {
			// Shorthand for directly specifying a qualitative quality level
			options = { quality: options };
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
			throw new TypeError('options.bitrateMode, when provided, must be \'constant\' or \'variable\'.');
		}

		if ('quality' in options) {
			if (
				typeof options.quality === 'string'
					? !(options.quality in QUALITY_LEVELS)
					: (typeof options.quality !== 'number' || Number.isNaN(options.quality))
			) {
				throw new TypeError(
					'options.quality must be a number, or one of \'very-low\', \'low\', \'medium\', \'high\''
					+ ' or \'very-high\'.',
				);
			}
			if (options.preferBitrate !== undefined && typeof options.preferBitrate !== 'boolean') {
				throw new TypeError('options.preferBitrate, when provided, must be a boolean.');
			}
			if ('bitrate' in options || 'quantizer' in options) {
				throw new TypeError('options.quality cannot be combined with options.bitrate or options.quantizer.');
			}

			this._quality = typeof options.quality === 'string'
				? QUALITY_LEVELS[options.quality]
				: options.quality;
			this._preferBitrate = options.preferBitrate ?? false;
			this._bitrate = undefined;
			this._quantizer = undefined;
		} else {
			if (options.bitrate !== undefined && (!Number.isInteger(options.bitrate) || options.bitrate <= 0)) {
				throw new TypeError('options.bitrate, when provided, must be a positive integer.');
			}
			if (options.quantizer !== undefined && (!Number.isInteger(options.quantizer) || options.quantizer < 0)) {
				throw new TypeError('options.quantizer, when provided, must be a non-negative integer.');
			}
			if (options.bitrate === undefined && options.quantizer === undefined) {
				throw new TypeError('At least one of options.bitrate or options.quantizer must be set.');
			}
			if ('preferBitrate' in options) {
				throw new TypeError('options.preferBitrate can only be combined with options.quality.');
			}

			this._quality = undefined;
			this._preferBitrate = false;
			this._bitrate = options.bitrate;
			this._quantizer = options.quantizer;
		}

		this._bitrateMode = options.bitrateMode;
	}

	/**
	 * Determines the rate control methods usable for the given codec.
	 * @internal
	 */
	_toVideoRateControl(
		codec: VideoCodec,
		width: number,
		height: number,
		fallbackBitrateMode: 'constant' | 'variable' | undefined,
	): VideoRateControl {
		const quantizerSupport = VIDEO_CODEC_QUANTIZER_SUPPORT[codec];

		let quantizer: number | null = null;
		let bitrateMode: 'constant' | 'variable' | 'quantizer' = this._bitrateMode ?? fallbackBitrateMode ?? 'variable';

		if (this._quantizer !== undefined) {
			// An explicit quantizer demands quantizer-based encoding, with an explicit bitrate (if any) being the
			// only permitted fallback
			if (!quantizerSupport) {
				if (this._bitrate === undefined) {
					throw new Error(
						`Codec '${codec}' does not support quantizer-based encoding. Provide a bitrate in the Quality`
						+ ` to define a fallback.`,
					);
				}
			} else if (this._quantizer < quantizerSupport.min || this._quantizer > quantizerSupport.max) {
				if (this._bitrate === undefined) {
					throw new Error(
						`Quantizer ${this._quantizer} is out of range for codec '${codec}'; must be between`
						+ ` ${quantizerSupport.min} and ${quantizerSupport.max}.`,
					);
				}
			} else {
				quantizer = this._quantizer;
				if (this._bitrate === undefined) {
					bitrateMode = 'quantizer';
				}
			}
		} else if (this._bitrate === undefined && quantizerSupport && !this._preferBitrate) {
			// A qualitative quality level is set; offer quantizer-based encoding since the codec supports it. Since
			// the quality may lie outside the 0-1 range, we clamp the result to the codec's legal quantizer range.
			assert(this._quality !== undefined);
			quantizer = clamp(
				Math.round(lerp(quantizerSupport.worst, quantizerSupport.best, this._quality)),
				quantizerSupport.min,
				quantizerSupport.max,
			);
		}

		let bitrate: number;
		if (this._bitrate !== undefined) {
			bitrate = this._bitrate;
		} else {
			let quality = this._quality;
			if (quality === undefined) {
				// Map the quantizer back onto the quality scale to derive a fitting bitrate estimate
				assert(quantizer !== null && quantizerSupport);
				quality = clamp(
					(quantizer - quantizerSupport.worst) / (quantizerSupport.best - quantizerSupport.worst),
					0,
					1,
				);
			}

			bitrate = computeVideoBitrate(codec, width, height, qualityToBitrateFactor(quality));
		}

		return { quantizer, bitrate, bitrateMode };
	}

	/** @internal */
	_toVideoBitrate(codec: VideoCodec, width: number, height: number) {
		if (this._bitrate !== undefined) {
			return this._bitrate;
		}

		assert(this._quality !== undefined);
		return computeVideoBitrate(codec, width, height, qualityToBitrateFactor(this._quality));
	}

	/** @internal */
	_toAudioBitrate(codec: AudioCodec) {
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec) || codec === 'flac') {
			return undefined;
		}

		if (this._bitrate !== undefined) {
			return this._bitrate;
		}

		if (this._quality === undefined) {
			throw new Error(
				'This Quality defines neither a quality level nor a bitrate and therefore cannot be used for audio'
				+ ' encoding.',
			);
		}

		const factor = qualityToBitrateFactor(this._quality);

		const baseRates = {
			aac: 128000, // 128kbps base for AAC
			opus: 64000, // 64kbps base for Opus
			mp3: 160000, // 160kbps base for MP3
			vorbis: 64000, // 64kbps base for Vorbis
			ac3: 384000, // 384kbps base for AC-3
			eac3: 192000, // 192kbps base for E-AC-3
			dts: 768000, // 768kbps base for DTS
		};

		const baseBitrate = baseRates[codec as keyof typeof baseRates];
		if (!baseBitrate) {
			throw new Error(`Unhandled codec: ${codec}`);
		}

		let finalBitrate = baseBitrate * factor;

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

const QUALITY_LEVELS: Record<QualityLevel, number> = {
	'very-low': 0,
	'low': 0.25,
	'medium': 0.5,
	'high': 0.75,
	'very-high': 1,
};

// best and worse define the reasonable range
const VIDEO_CODEC_QUANTIZER_SUPPORT: Partial<Record<VideoCodec, {
	min: number;
	max: number;
	worst: number;
	best: number;
}>> = {
	avc: { min: 0, max: 51, worst: 41, best: 16 },
	hevc: { min: 0, max: 51, worst: 41, best: 16 },
	vp9: { min: 0, max: 63, worst: 52, best: 20 },
	av1: { min: 0, max: 255, worst: 208, best: 80 },
};

/**
 * Maps the qualitative 0-1 quality scale to a bitrate multiplier. The curve is a least-squares exponential fit through
 * the multipliers historically used by the predefined quality levels (0.3, 0.6, 1, 2, 4).
 */
const qualityToBitrateFactor = (quality: number) => 0.3 * Math.exp(2.5538 * quality);

const computeVideoBitrate = (codec: VideoCodec, width: number, height: number, factor: number) => {
	const pixels = width * height;
	const referencePixels = 1920 * 1080;
	const referenceBitrate = 3_000_000;
	const scaleFactor = Math.pow(pixels / referencePixels, 0.95); // Slight non-linear scaling
	const baseBitrate = referenceBitrate * scaleFactor;

	const codecEfficiencyFactors: Record<VideoCodec, number> = {
		avc: 1.0, // H.264/AVC (baseline)
		hevc: 0.6, // H.265/HEVC (~40% more efficient than AVC)
		vp9: 0.6, // Similar to HEVC
		av1: 0.4, // ~60% more efficient than AVC
		vp8: 1.2, // Slightly less efficient than AVC
		prores: 220_000_000 / referenceBitrate, // Apple ProRes white paper claims 220 Mbps for 1080p 422 HQ @30Hz
	};

	const codecAdjustedBitrate = baseBitrate * codecEfficiencyFactors[codec];
	const finalBitrate = codecAdjustedBitrate * factor;

	return Math.ceil(finalBitrate / 1000) * 1000;
};

/** Builds the per-frame encode options that carry the quantizer value for the given codec. */
export const buildQuantizerEncodeOptions = (codec: VideoCodec, quantizer: number): VideoEncoderEncodeOptions => {
	if (codec === 'avc') {
		return { avc: { quantizer } };
	} else if (codec === 'hevc') {
		return { hevc: { quantizer } };
	} else if (codec === 'vp9') {
		return { vp9: { quantizer } };
	} else if (codec === 'av1') {
		return { av1: { quantizer } };
	}

	assert(false);
};

// Adds missing per-frame encode options
declare global {
	interface VideoEncoderEncodeOptions {
		hevc?: VideoEncoderEncodeOptionsForHevc;
		vp9?: VideoEncoderEncodeOptionsForVp9;
		av1?: VideoEncoderEncodeOptionsForAv1;
	}

	interface VideoEncoderEncodeOptionsForHevc {
		quantizer?: number | null;
	}

	interface VideoEncoderEncodeOptionsForVp9 {
		quantizer?: number | null;
	}

	interface VideoEncoderEncodeOptionsForAv1 {
		quantizer?: number | null;
	}
}

/**
 * Represents a very low media quality.
 * @deprecated Use `new Quality('very-low')` instead.
 * @group Encoding
 * @public
 */
export const QUALITY_VERY_LOW = /* #__PURE__ */ new Quality('very-low');
/**
 * Represents a low media quality.
 * @deprecated Use `new Quality('low')` instead.
 * @group Encoding
 * @public
 */
export const QUALITY_LOW = /* #__PURE__ */ new Quality('low');
/**
 * Represents a medium media quality.
 * @deprecated Use `new Quality('medium')` instead.
 * @group Encoding
 * @public
 */
export const QUALITY_MEDIUM = /* #__PURE__ */ new Quality('medium');
/**
 * Represents a high media quality.
 * @deprecated Use `new Quality('high')` instead.
 * @group Encoding
 * @public
 */
export const QUALITY_HIGH = /* #__PURE__ */ new Quality('high');
/**
 * Represents a very high media quality.
 * @deprecated Use `new Quality('very-high')` instead.
 * @group Encoding
 * @public
 */
export const QUALITY_VERY_HIGH = /* #__PURE__ */ new Quality('very-high');

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
		quality?: Quality;
		/** @deprecated Use `quality` instead. */
		bitrate?: number | Quality;
	} & VideoEncodingAdditionalOptions = {},
) => {
	const {
		width = 1280,
		height = 720,
		quality,
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		bitrate,
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
	if (quality !== undefined && !(quality instanceof Quality)) {
		throw new TypeError('quality, when provided, must be a Quality.');
	}
	if (quality !== undefined && bitrate !== undefined) {
		throw new TypeError('quality and bitrate cannot both be provided.');
	}
	if (bitrate !== undefined && !(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('bitrate must be a positive integer or a quality.');
	}
	validateVideoEncodingAdditionalOptions(codec, restOptions);

	const resolvedQuality = resolveQuality(quality, bitrate) ?? new Quality('medium');

	let candidates: VideoEncoderConfigCandidate[];
	try {
		candidates = buildVideoEncoderConfigs({
			codec,
			width,
			height,
			quality: resolvedQuality,
			framerate: undefined,
			...restOptions,
			alpha: 'discard', // Since we handle alpha ourselves
		});
	} catch {
		// The requested rate control cannot be used with this codec (e.g. a quantizer with no fallback bitrate on a
		// codec without quantizer support)
		return false;
	}

	const key = JSON.stringify(candidates);
	const memoized = canEncodeVideoMemo.get(key);
	if (memoized) {
		return memoized;
	}

	const promise = (async () => {
		for (const { config } of candidates) {
			if (customVideoEncoders.some(x => x.supports(codec, config))) {
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

		for (const { config, quantizer } of candidates) {
			try {
				const support = await VideoEncoder.isConfigSupported(config);
				if (!support.supported) {
					continue;
				}
			} catch {
				// Can type-error when unknown config features are used
				continue;
			}

			if (!isFirefox()) {
				return true;
			}

			// isConfigSupported on Firefox appears to unreliably indicate if encoding will actually succeed. Therefore,
			// we just try encoding a frame to see if it actually works.
			// https://github.com/Vanilagy/mediabunny/issues/222

			// eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
			const success = await new Promise<boolean>(async (resolve) => {
				try {
					const encoder = new VideoEncoder({
						output: () => {},
						error: () => resolve(false),
					});
					encoder.configure(config);

					const frameData = new Uint8Array(width * height * 4);
					const frame = new VideoFrame(frameData, {
						format: 'RGBA',
						codedWidth: width,
						codedHeight: height,
						timestamp: 0,
					});

					encoder.encode(
						frame,
						quantizer !== null ? buildQuantizerEncodeOptions(codec, quantizer) : undefined,
					);
					frame.close();

					await encoder.flush();

					resolve(true);
				} catch {
					resolve(false);
				}
			});

			if (success) {
				return true;
			}
		}

		return false;
	})();
	canEncodeVideoMemo.set(key, promise);

	return promise;
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
		quality?: Quality;
		/** @deprecated Use `quality` instead. */
		bitrate?: number | Quality;
	} & AudioEncodingAdditionalOptions = {},
) => {
	const {
		numberOfChannels = 2,
		sampleRate = 48000,
		quality,
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		bitrate,
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
	if (quality !== undefined && !(quality instanceof Quality)) {
		throw new TypeError('quality, when provided, must be a Quality.');
	}
	if (quality !== undefined && bitrate !== undefined) {
		throw new TypeError('quality and bitrate cannot both be provided.');
	}
	if (bitrate !== undefined && !(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('bitrate must be a positive integer.');
	}
	validateAudioEncodingAdditionalOptions(codec, restOptions);

	const resolvedQuality = resolveQuality(quality, bitrate) ?? new Quality('medium');

	const encoderConfig = buildAudioEncoderConfig({
		codec,
		numberOfChannels,
		sampleRate,
		quality: resolvedQuality,
		...restOptions,
	});

	const key = JSON.stringify(encoderConfig);
	const memoized = canEncodeAudioMemo.get(key);
	if (memoized) {
		return memoized;
	}

	const promise = (async () => {
		if (customAudioEncoders.some(x => x.supports(codec, encoderConfig))) {
			// There's a custom encoder
			return true;
		}
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
			return true; // Because we encode these ourselves
		}
		if (typeof AudioEncoder === 'undefined') {
			return false;
		}

		try {
			const support = await AudioEncoder.isConfigSupported(encoderConfig);
			return support.supported === true;
		} catch {
			// Can type-error when unknown config features are used
			return false;
		}
	})();
	canEncodeAudioMemo.set(key, promise);

	return promise;
};

/**
 * Resolves the `quality` and deprecated `bitrate` fields from the public API into a {@link Quality}, the norm used
 * internally.
 */
export const resolveQuality = (quality: Quality | undefined, bitrate: number | Quality | undefined) => {
	if (quality !== undefined) {
		return quality;
	}
	if (bitrate === undefined) {
		return undefined;
	}

	return bitrate instanceof Quality ? bitrate : new Quality({ bitrate });
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
		quality?: Quality;
		/** @deprecated Use `quality` instead. */
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
		quality?: Quality;
		/** @deprecated Use `quality` instead. */
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
		quality?: Quality;
		/** @deprecated Use `quality` instead. */
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
		quality?: Quality;
		/** @deprecated Use `quality` instead. */
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
