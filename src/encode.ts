/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { buildAacAudioSpecificConfig, parseAacAudioSpecificConfig } from '../shared/aac-misc';
import {
	AUDIO_CODECS,
	AudioCodec,
	buildAudioCodecString,
	buildVideoCodecString,
	extractVideoCodecString,
	getAudioEncoderConfigExtension,
	getVideoEncoderConfigExtension,
	inferCodecFromCodecString,
	MediaCodec,
	OPUS_SAMPLE_RATE,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import {
	deserializeAvcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
	parseOpusIdentificationHeader,
	serializeAvcDecoderConfigurationRecord,
} from './codec-data';
import {
	CustomAudioEncoder,
	customAudioEncoders,
	CustomVideoEncoder,
	customVideoEncoders,
} from './custom-coder';
import {
	audioDecoderConfigsAreEqual,
	CoderClosedError,
	DEFAULT_HIGH_WATER_MARK,
	ExtendedAudioDecoderConfig,
	ExtendedVideoDecoderConfig,
	validateHighWaterMark,
	videoDecoderConfigsAreEqual,
} from './decode';
import { readEsDescriptor } from './isobmff/isobmff-reader';
import {
	arrayCount,
	assert,
	binarySearchLessOrEqual,
	CallSerializer,
	clamp,
	createWorker,
	DeepReadonly,
	floorToDivisor,
	getChromiumVersion,
	isCodecReclaimedError,
	isFirefox,
	isThenable,
	isWebKit,
	last,
	lerp,
	MaybePromise,
	missingWebCodecsClassMessage,
	promiseWithResolvers,
	Rotation,
	roundToDivisor,
	setInt24,
	setUint24,
	toUint8Array,
	wait,
} from './misc';
import { EncodedPacket, EncodedPacketSideData, PacketType } from './packet';
import {
	getPcmFormat,
	PCM_FORMAT_ALAW,
	PCM_FORMAT_F32_BE,
	PCM_FORMAT_F32_LE,
	PCM_FORMAT_F64_BE,
	PCM_FORMAT_F64_LE,
	PCM_FORMAT_S16_BE,
	PCM_FORMAT_S16_LE,
	PCM_FORMAT_S24_BE,
	PCM_FORMAT_S24_LE,
	PCM_FORMAT_S32_BE,
	PCM_FORMAT_S32_LE,
	PCM_FORMAT_S8,
	PCM_FORMAT_U16_BE,
	PCM_FORMAT_U16_LE,
	PCM_FORMAT_U24_BE,
	PCM_FORMAT_U24_LE,
	PCM_FORMAT_U32_BE,
	PCM_FORMAT_U32_LE,
	PCM_FORMAT_U8,
	PCM_FORMAT_ULAW,
	toAlaw,
	toUlaw,
} from './pcm';
import { FileSlice } from './reader';
import { AudioResampler } from './resample';
import {
	AudioSample,
	audioSampleToInterleavedFormat,
	CropRectangle,
	getBytesPerSample,
	toInterleavedAudioFormat,
	validateCropRectangle,
	VideoSample,
	VideoSamplePixelFormat,
	VideoSampleResource,
} from './sample';

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

	/**
	 * Called for each successfully encoded packet. Both the packet and the encoding metadata are passed.
	 *
	 * The use of the `meta` argument is deprecated: the packet carries its decoder config itself.
	 */
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
	 * `'cover'`, since `sizeChangeBehavior` already determines the fitting algorithm.
	 */
	fit?: 'fill' | 'contain' | 'cover';
	/**
	 * The clockwise rotation by which to rotate the frames, in addition to each frame's own rotation. Rotation is
	 * applied before flipping.
	 */
	rotate?: Rotation;
	/**
	 * Whether to flip the frames horizontally (about the vertical axis), in addition to each frame's own flip. The flip
	 * is applied after rotation but before cropping and resizing.
	 */
	flip?: boolean;
	/**
	 * Specifies the rectangular region of the frames to crop to. The crop region will automatically be
	 * clamped to the dimensions of the frame. Cropping is performed after rotation and flip but before resizing.
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
	 * This can be used, for example, to bake rotation and flip into the encoded video frames.
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
		if (config.transform.flip !== undefined && typeof config.transform.flip !== 'boolean') {
			throw new TypeError('config.transform.flip, when provided, must be a boolean.');
		}
		if (config.transform.crop !== undefined) {
			validateCropRectangle(config.transform.crop, 'config.transform.');
		}
		if (config.transform.alpha !== undefined && !['keep', 'discard'].includes(config.transform.alpha)) {
			throw new TypeError('config.transform.alpha, when provided, must be \'keep\' or \'discard\'.');
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
	 * The expected frame rate in hertz, as a hint given to the encoder. When `transform.frameRate` is set,
	 * that frame rate is used instead.
	 */
	frameRateHint?: number;
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
	if (
		options.frameRateHint !== undefined
		&& (!Number.isFinite(options.frameRateHint) || options.frameRateHint <= 0)
	) {
		throw new TypeError('frameRateHint, when provided, must be a finite positive number.');
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

	/**
	 * Called for each successfully encoded packet. Both the packet and the encoding metadata are passed.
	 *
	 * The use of the `meta` argument is deprecated: the packet carries its decoder config itself.
	 */
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
		&& !(
			(PCM_AUDIO_CODECS as readonly string[]).includes(config.codec)
			|| config.codec === 'flac'
			|| config.codec === 'truehd'
		)
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
		codec: options.fullCodecString ?? buildAudioCodecString(options.codec),
		numberOfChannels: options.numberOfChannels,
		sampleRate: options.sampleRate,
		bitrate: options.quality?._toAudioBitrate(options.codec, options.numberOfChannels),
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
					? !Object.prototype.hasOwnProperty.call(QUALITY_LEVELS, options.quality)
					: (typeof options.quality !== 'number' || Number.isNaN(options.quality)) // Infinities allowed
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
	_toAudioBitrate(codec: AudioCodec, numberOfChannels: number) {
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec) || codec === 'flac' || codec === 'truehd') {
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

		if (codec === 'opus' || codec === 'vorbis') {
			// The base rates are for stereo
			finalBitrate *= numberOfChannels / 2;
		}

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
	// Chromium used the 0-63 scale before v145, see https://github.com/Vanilagy/mediabunny/issues/566
	vp9: (getChromiumVersion() ?? Infinity) < 145
		? { min: 0, max: 63, worst: 52, best: 20 }
		: { min: 0, max: 255, worst: 208, best: 80 },
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

type AnyDecoderConfig = DeepReadonly<ExtendedVideoDecoderConfig | ExtendedAudioDecoderConfig>;

type PendingSample<MediaSample extends VideoSample | AudioSample> = {
	sample: MediaSample;
	encodeOptions: VideoEncoderEncodeOptions | undefined;
};

export abstract class SampleEncoder<
	MediaSample extends VideoSample | AudioSample,
> {
	/** @internal */
	_results: (EncodedPacket | null)[] = [];
	/** @internal */
	_pendingPulls: ReturnType<typeof promiseWithResolvers<EncodedPacket | null>>[] = [];
	/** @internal */
	_backpressure: ReturnType<typeof promiseWithResolvers<void>> | null = null;
	/** @internal */
	_room: ReturnType<typeof promiseWithResolvers<void>> | null = null;
	/** @internal */
	_generator: Generator<void, void, void> | null = null;
	/** @internal */
	_generatorDrained: ReturnType<typeof promiseWithResolvers<void>> | null = null;
	/** @internal */
	_pendingInputs: (PendingSample<MediaSample> | null)[] = [];
	/** @internal */
	_processing = false;
	/** @internal */
	_sampleInFlight = false;
	/** @internal */
	_dirty = false;
	/** @internal */
	_decoderConfig: AnyDecoderConfig | null = null;
	/** @internal */
	_error: unknown = null;
	/** @internal */
	_hasError = false;
	/** @internal */
	_pushable = true;
	/** @internal */
	_endEmitted = false;
	/** @internal */
	_pullable = true;
	/** @internal */
	_released = false;
	/** @internal */
	_releasePromise: Promise<void> = Promise.resolve();
	/** @internal */
	_finishedResolver = promiseWithResolvers();
	/** @internal */
	_endPromise: Promise<void> | null = null;
	/** @internal */
	abstract _highWaterMark: number;

	get pushable() {
		return this._pushable;
	}

	get pullable() {
		return this._pullable;
	}

	abstract push(sample: MediaSample | null): Promise<void> | null;

	pull(): MaybePromise<EncodedPacket | null> {
		if (!this._pullable) {
			throw new Error('Cannot pull past the end of the encoder.');
		}

		if (this._results.length > 0) {
			const result = this._results.shift() as EncodedPacket | null;

			if (result) {
				this._handleDequeue();
			} else if (this._endEmitted && this._results.length === 0) {
				this._pullable = false;
				this._finishedResolver.resolve();
			}

			return result;
		}

		if (this._hasError) {
			this._pullable = false;
			throw this._error;
		}

		const resolver = promiseWithResolvers<EncodedPacket | null>();
		this._pendingPulls.push(resolver);

		return resolver.promise;
	}

	end() {
		if (this._pushable) {
			this._pushable = false;
			this._pendingInputs.push(null);
			void this._processInputs();
		}

		return this._endPromise ??= this._finishedResolver.promise.then(() => this._releasePromise);
	}

	close() {
		if (!this._pullable) {
			return;
		}

		this._results.length = 0;
		this._pullable = false;

		for (const pendingPull of this._pendingPulls) {
			pendingPull.reject(new CoderClosedError('The encoder was closed during a pending pull.'));
		}
		this._pendingPulls.length = 0;

		this._abort();
	}

	[Symbol.dispose]() {
		this.close();
	}

	/** @internal */
	abstract _decoderConfigsAreEqual(a: AnyDecoderConfig, b: AnyDecoderConfig): boolean;
	/** @internal */
	abstract _validateSample(sample: MediaSample): void;
	/** @internal */
	abstract _resetSampleValidation(): void;
	/** @internal */
	abstract _encodeSample(sample: MediaSample, encodeOptions: VideoEncoderEncodeOptions | undefined): Promise<void>;
	/** @internal */
	abstract _flush(): Promise<void>;
	/** @internal */
	abstract _getEncoderQueueSize(): number;
	/** @internal */
	abstract _releaseEncoder(): Promise<void>;

	/** @internal */
	_push(sample: MediaSample | null, encodeOptions: VideoEncoderEncodeOptions | undefined) {
		if (!this._pushable) {
			throw new Error('Cannot push after the encoder has been ended or closed.');
		}

		if (sample) {
			if (sample._closed) {
				throw new Error('Cannot encode a closed sample.');
			}

			this._validateSample(sample);

			// Clone the sample to isolate it from whatever the outside does to it next. WebCodecs does the same
			this._pendingInputs.push({ sample: sample.clone() as MediaSample, encodeOptions });
		} else {
			this._resetSampleValidation();
			this._pendingInputs.push(null);
		}

		void this._processInputs();

		if (this._released || this._getQueueSize() < this._highWaterMark) {
			return null;
		}

		this._backpressure ??= promiseWithResolvers();
		return this._backpressure.promise;
	}

	/** @internal */
	async _processInputs() {
		if (this._processing) {
			return;
		}
		this._processing = true;

		while (this._pendingInputs.length > 0 && !this._released) {
			const input = this._pendingInputs.shift()!;

			try {
				if (input) {
					this._dirty = true;
					this._sampleInFlight = true;
					try {
						await this._encodeSample(input.sample, input.encodeOptions);
					} finally {
						this._sampleInFlight = false;
						input.sample.close();
					}
				} else {
					// The flush queued by end() is always the last input
					const isEnd = !this._pushable && this._pendingInputs.length === 0;

					if (this._dirty) {
						this._dirty = false;

						await this._flush();
						if (this._released) {
							break;
						}
					}

					if (isEnd) {
						this._release();
						this._endEmitted = true;

						const pendingPull = this._pendingPulls.shift();
						if (pendingPull) {
							this._pullable = false;
							this._finishedResolver.resolve();
							pendingPull.resolve(null);

							for (const pendingPull of this._pendingPulls) {
								pendingPull.reject(new Error('Cannot pull past the end of the encoder.'));
							}
							this._pendingPulls.length = 0;
						} else {
							this._results.push(null);
						}
					} else {
						this._emit(null);
					}
				}
			} catch (error) {
				this._handleError(error);
			}

			this._releaseBackpressureIfPossible();
		}

		this._processing = false;
	}

	/** @internal */
	async _waitForRoom() {
		while (this._getAdmittedQueueSize() >= this._highWaterMark && !this._released) {
			this._room ??= promiseWithResolvers();
			await this._room.promise;
		}
	}

	/** @internal */
	_handleDequeue() {
		if (this._generator) {
			this._drainGenerator();
		}

		this._room?.resolve();
		this._room = null;

		this._releaseBackpressureIfPossible();
	}

	/** @internal */
	_drainGenerator() {
		assert(this._generator);

		while (this._getAdmittedQueueSize() < this._highWaterMark) {
			let result: IteratorResult<void, void>;
			try {
				result = this._generator.next();
			} catch (error) {
				this._handleError(error);
				return;
			}

			if (result.done) {
				this._generator = null;
				this._generatorDrained?.resolve();
				this._generatorDrained = null;

				return;
			}
		}
	}

	/** @internal */
	_resolveDecoderConfig(decoderConfig: AnyDecoderConfig | null) {
		// Packets keep sharing one config object until its content actually changes
		if (
			decoderConfig
			&& decoderConfig !== this._decoderConfig
			&& (this._decoderConfig === null || !this._decoderConfigsAreEqual(decoderConfig, this._decoderConfig))
		) {
			this._decoderConfig = decoderConfig;
		}
		if (!this._decoderConfig) {
			throw new Error('The first packet emitted by an encoder must come with a decoder config.');
		}

		return this._decoderConfig;
	}

	/** @internal */
	_emitPacket(packet: EncodedPacket) {
		if (this._released) {
			return false;
		}

		this._emit(packet);
		return true;
	}

	/** @internal */
	_emit(result: EncodedPacket | null) {
		const pendingPull = this._pendingPulls.shift();
		if (pendingPull) {
			pendingPull.resolve(result);
		} else {
			this._results.push(result);
		}
	}

	/** @internal */
	_releaseBackpressureIfPossible() {
		if (this._backpressure && this._getQueueSize() < this._highWaterMark) {
			this._backpressure.resolve();
			this._backpressure = null;
		}
	}

	/** @internal */
	_getQueueSize() {
		return this._getAdmittedQueueSize()
			+ arrayCount(this._pendingInputs, x => x !== null)
			+ (this._sampleInFlight ? 1 : 0);
	}

	/** @internal */
	_getAdmittedQueueSize() {
		return this._getEncoderQueueSize() + arrayCount(this._results, x => x !== null);
	}

	/** @internal */
	_handleError(error: unknown) {
		if (this._released) {
			return;
		}

		this._error = error;
		this._hasError = true;

		if (this._pendingPulls.length > 0) {
			this._pullable = false;
		}
		for (const pendingPull of this._pendingPulls) {
			pendingPull.reject(error);
		}
		this._pendingPulls.length = 0;

		this._abort();
	}

	/** @internal */
	_abort() {
		this._pushable = false;

		for (const input of this._pendingInputs) {
			input?.sample.close();
		}
		this._pendingInputs.length = 0;

		this._release();
		this._finishedResolver.resolve();
	}

	/** @internal */
	_release() {
		if (this._released) {
			return;
		}

		this._released = true;
		this._releasePromise = this._releaseEncoder();

		this._backpressure?.resolve();
		this._backpressure = null;
		this._room?.resolve();
		this._room = null;
		this._generator = null;
		this._generatorDrained?.resolve();
		this._generatorDrained = null;
	}
}

export type SampleEncoderOptions = {
	/**
	 * The queue size at which `push()` starts applying backpressure. The queue holds both the samples waiting to be
	 * encoded and the encoded packets waiting to be pulled. Must be a positive integer; defaults to 4.
	 */
	highWaterMark?: number;
};

export type VideoSampleEncoderOptions = VideoEncodingConfig & SampleEncoderOptions;

export class VideoSampleEncoder extends SampleEncoder<VideoSample> {
	/** @internal */
	_config: VideoEncodingConfig;
	/** @internal */
	_highWaterMark: number;

	/** @internal */
	_firstCodedWidth: number | null = null;
	/** @internal */
	_firstCodedHeight: number | null = null;
	/** @internal */
	_codedWidth: number | null = null;
	/** @internal */
	_codedHeight: number | null = null;
	/** @internal */
	_outputWidth: number | null = null;
	/** @internal */
	_outputHeight: number | null = null;

	/** @internal */
	_frameRateLastSample: VideoSample | null = null;
	/** @internal */
	_frameRateLastTimestamp = 0;
	/** @internal */
	_frameRateLastEndTimestamp = 0;

	/** @internal */
	_encoderSize: {
		width: number;
		height: number;
		squarePixelWidth: number;
		squarePixelHeight: number;
	} | null = null;

	/** @internal */
	_encoderNeedsCheck = false;
	/** @internal */
	_encoder: VideoEncoder | null = null;
	/** @internal */
	_encoderConfig: VideoEncoderConfig | null = null;
	// Set when the browser closed our encoders due to inactivity; they'll be recreated on the next encode
	/** @internal */
	_encodersReclaimed = false;
	/** @internal */
	_lastMultipleOfKeyFrameInterval: number | null = null;
	/** @internal */
	_emittedPacketCount = 0;
	/** @internal */
	_chunkTimestampsAreShiftedByDuration = false; // See detectAvcChunkTimestampShift
	// Set when the encoder uses quantizer-based rate control; carries the quantizer value applied to each frame
	/** @internal */
	_defaultEncodeOptions: VideoEncoderEncodeOptions = {};

	// VideoEncoder converts everything to microseconds, so we need to do some bookkeeping to restore the original
	// timing information
	/** @internal */
	_preciseTimings: {
		microsecondTimestamp: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	/** @internal */
	_customEncoder: CustomVideoEncoder | null = null;
	/** @internal */
	_customEncoderCallSerializer = new CallSerializer();
	/** @internal */
	_customEncoderQueueSize = 0;

	// Alpha stuff
	/** @internal */
	_alphaEncoder: VideoEncoder | null = null;
	/** @internal */
	_splitter: ColorAlphaSplitter | null = null;
	/** @internal */
	_alphaFrameQueue: (VideoFrame | null)[] = [];

	constructor(options: VideoSampleEncoderOptions) {
		validateVideoEncodingConfig(options);
		validateHighWaterMark(options.highWaterMark, 'options');

		super();

		this._config = options;
		this._highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
	}

	push(sample: VideoSample | null, encodeOptions?: VideoEncoderEncodeOptions) {
		if (sample !== null && !(sample instanceof VideoSample)) {
			throw new TypeError('sample must be a VideoSample or null.');
		}
		if (encodeOptions !== undefined && (!encodeOptions || typeof encodeOptions !== 'object')) {
			throw new TypeError('encodeOptions, when provided, must be an object.');
		}

		return this._push(sample, encodeOptions);
	}

	/** @internal */
	_decoderConfigsAreEqual(a: AnyDecoderConfig, b: AnyDecoderConfig) {
		assert(a.type === 'video' && b.type === 'video');
		return videoDecoderConfigsAreEqual(a, b);
	}

	/** @internal */
	_validateSample(sample: VideoSample) {
		if (this._firstCodedWidth === null || this._firstCodedHeight === null) {
			this._firstCodedWidth = sample.codedWidth;
			this._firstCodedHeight = sample.codedHeight;
		} else if (
			(this._config.sizeChangeBehavior ?? 'deny') === 'deny'
			&& (sample.codedWidth !== this._firstCodedWidth || sample.codedHeight !== this._firstCodedHeight)
		) {
			throw new Error(
				`Video sample size must remain constant. Expected ${this._firstCodedWidth}x${this._firstCodedHeight},`
				+ ` got ${sample.codedWidth}x${sample.codedHeight}. To allow the sample size to change over time, set`
				+ ` \`sizeChangeBehavior\` to a value other than 'deny' in the encoding options.`,
			);
		}
	}

	/** @internal */
	_resetSampleValidation() {
		this._firstCodedWidth = null;
		this._firstCodedHeight = null;
	}

	/** @internal */
	async _encodeSample(videoSample: VideoSample, encodeOptions: VideoEncoderEncodeOptions | undefined) {
		const config = this._config;
		const sizeChangeBehavior = config.sizeChangeBehavior ?? 'deny';

		let isSizeChange = false;
		if (this._codedWidth === null || this._codedHeight === null) {
			this._codedWidth = videoSample.codedWidth;
			this._codedHeight = videoSample.codedHeight;
		} else {
			isSizeChange = videoSample.codedWidth !== this._codedWidth || videoSample.codedHeight !== this._codedHeight;
		}

		// Determine if we need to apply transformations via canvas
		const hasTransformConfig = config.transform?.width !== undefined
			|| config.transform?.height !== undefined
			|| config.transform?.rotate !== undefined
			|| config.transform?.flip !== undefined
			|| config.transform?.crop !== undefined
			|| config.transform?.alpha === 'discard'
			|| config.transform?.force === true;
		const needsTransform = hasTransformConfig || (isSizeChange && sizeChangeBehavior !== 'passThrough');

		let transformed: VideoSample | null = null;
		if (needsTransform) {
			let targetWidth = config.transform?.width;
			let targetHeight = config.transform?.height;
			let appliedFit: 'fill' | 'contain' | 'cover' = config.transform?.fit ?? 'fill';

			if (sizeChangeBehavior !== 'deny' && sizeChangeBehavior !== 'passThrough') {
				appliedFit = sizeChangeBehavior;
			}

			// If the size changed and behavior is fill/contain/cover, lock to the original output dimensions
			if (isSizeChange && sizeChangeBehavior !== 'passThrough') {
				assert(this._outputWidth !== null && this._outputHeight !== null);

				targetWidth = this._outputWidth;
				targetHeight = this._outputHeight;
			}

			transformed = await videoSample.transform({
				width: targetWidth,
				height: targetHeight,
				roundDimensionsTo: 2,
				crop: config.transform?.crop,
				rotate: config.transform?.rotate,
				flip: config.transform?.flip,
				fit: appliedFit,
				alpha: config.transform?.alpha,
			});

			// Save the output dimensions of the first frame
			if (this._outputWidth === null || this._outputHeight === null) {
				this._outputWidth = transformed.displayWidth;
				this._outputHeight = transformed.displayHeight;
			}
		} else if (this._outputWidth === null || this._outputHeight === null) {
			this._outputWidth = videoSample.codedWidth;
			this._outputHeight = videoSample.codedHeight;
		}

		try {
			if (this._released) {
				return;
			}

			const sample = transformed ?? videoSample;

			const frameRate = config.transform?.frameRate;
			if (frameRate !== undefined) {
				// Apply frame rate normalization
				const originalEndTimestamp = sample.timestamp + sample.duration;
				const alignedTimestamp = floorToDivisor(sample.timestamp, frameRate);

				if (this._frameRateLastSample) {
					if (alignedTimestamp <= this._frameRateLastTimestamp) {
						// Same frame rate slot, replace stored sample with the newer one
						this._frameRateLastSample.close();
						this._frameRateLastSample = sample.clone();
						this._frameRateLastEndTimestamp = originalEndTimestamp;
						return;
					}

					// Pad the gap by repeating the previous frame
					await this._padFrameRate(alignedTimestamp, encodeOptions);

					if (this._released) {
						return;
					}
				}

				sample.setTimestamp(alignedTimestamp);
				sample.setDuration(1 / frameRate);

				this._frameRateLastSample?.close();
				this._frameRateLastSample = sample.clone();
				this._frameRateLastTimestamp = alignedTimestamp;
				this._frameRateLastEndTimestamp = originalEndTimestamp;
			}

			await this._processAndEncode(sample, encodeOptions);
		} finally {
			transformed?.close();
		}
	}

	/** @internal */
	async _flush() {
		if (this._frameRateLastSample) {
			// Fill the remaining frames up to the last sample's original end timestamp
			const frameRate = this._config.transform!.frameRate!;
			const alignedEnd = floorToDivisor(this._frameRateLastEndTimestamp, frameRate);
			await this._padFrameRate(alignedEnd, undefined);

			if (this._released) {
				return;
			}

			this._frameRateLastSample.close();
			this._frameRateLastSample = null;
		}

		if (this._released) {
			return;
		}

		if (this._customEncoder) {
			const customEncoder = this._customEncoder;
			await this._customEncoderCallSerializer.call(() => customEncoder.flush());
		} else if (this._encoder && !this._encodersReclaimed) {
			// These are wired in series, therefore they must also be flushed in series
			await this._encoder.flush();
			await this._alphaEncoder?.flush();

			// Workaround for https://issues.chromium.org/issues/529852980 to give it time for errors to surface
			await wait(25);
		}

		// The next sample starts over completely
		this._codedWidth = null;
		this._codedHeight = null;
		this._outputWidth = null;
		this._outputHeight = null;
		this._lastMultipleOfKeyFrameInterval = null;
		this._preciseTimings.length = 0;
		this._emittedPacketCount = 0;
		this._encoderNeedsCheck = true;
	}

	/** @internal */
	async _padFrameRate(until: number, encodeOptions: VideoEncoderEncodeOptions | undefined) {
		const frameRate = this._config.transform!.frameRate!;
		assert(this._frameRateLastSample);

		const frameDifference = Math.round(frameRate * (until - this._frameRateLastTimestamp));

		for (let i = 1; i < frameDifference; i++) {
			using sample = this._frameRateLastSample.clone();
			sample.setTimestamp(this._frameRateLastTimestamp + i / frameRate);
			sample.setDuration(1 / frameRate);
			await this._processAndEncode(sample, encodeOptions);

			if (this._released) {
				return;
			}
		}
	}

	/** @internal */
	async _processAndEncode(videoSample: VideoSample, encodeOptions: VideoEncoderEncodeOptions | undefined) {
		const config = this._config;
		let samplesToEncode: VideoSample[];

		// Apply the user-defined process function, if any
		if (config.transform?.process) {
			let processed = config.transform.process(videoSample);
			if (isThenable(processed)) {
				processed = await processed;
			}

			if (processed === null) {
				return;
			}

			if (!Array.isArray(processed)) {
				processed = [processed];
			}

			const mappedSamples: VideoSample[] = [];

			try {
				for (const x of processed) {
					if (x instanceof VideoSample) {
						mappedSamples.push(x);
					} else if (typeof VideoFrame !== 'undefined' && x instanceof VideoFrame) {
						mappedSamples.push(new VideoSample(x));
					} else {
						// Calling the VideoSample constructor here will automatically handle input validation for us
						// (it throws for any non-legal argument).
						mappedSamples.push(new VideoSample(x as CanvasImageSource, {
							timestamp: videoSample.timestamp,
							duration: videoSample.duration,
						}));
					}
				}
			} catch (error) {
				// One of the returned elements was invalid; close everything closable so no resource is leaked
				for (const sample of mappedSamples) {
					if (sample !== videoSample) {
						sample.close();
					}
				}
				for (const x of processed) {
					if (x instanceof VideoSample && x !== videoSample) {
						x.close();
					} else if (typeof VideoFrame !== 'undefined' && x instanceof VideoFrame) {
						x.close();
					}
				}

				throw error;
			}

			samplesToEncode = mappedSamples;
		} else {
			samplesToEncode = [videoSample];
		}

		try {
			for (const sampleToEncode of samplesToEncode) {
				if (this._released) {
					return;
				}

				if (this._encoderNeedsCheck) {
					// The first sample after a flush decides whether the existing encoder can be kept
					this._encoderNeedsCheck = false;

					const size = this._encoderSize;
					if (
						size
						&& (
							size.width !== sampleToEncode.codedWidth
							|| size.height !== sampleToEncode.codedHeight
							|| size.squarePixelWidth !== sampleToEncode.squarePixelWidth
							|| size.squarePixelHeight !== sampleToEncode.squarePixelHeight
						)
					) {
						void this._closeEncoders();
					}
				}

				if (!this._encoderSize) {
					await this._initEncoder(sampleToEncode);
					if (this._released) {
						return;
					}
				}

				if (this._encodersReclaimed) {
					this._recreateWebCodecsEncoders();
				}

				if (this._getAdmittedQueueSize() >= this._highWaterMark) {
					await this._waitForRoom();
				}
				if (this._released) {
					return;
				}

				const keyFrameInterval = config.keyFrameInterval ?? 2;
				const multipleOfKeyFrameInterval = Math.floor(sampleToEncode.timestamp / keyFrameInterval);

				const mergedEncodeOptions = {
					...this._defaultEncodeOptions,
					...sampleToEncode.encodeOptions,
					...encodeOptions,
				};

				const finalEncodeOptions = {
					...mergedEncodeOptions,
					keyFrame: mergedEncodeOptions.keyFrame !== undefined
						? mergedEncodeOptions.keyFrame
						// Ensure a key frame every keyFrameInterval seconds. It is important that all video tracks
						// follow the same "key frame" rhythm, because aligned key frames are required to start new
						// fragments in ISOBMFF or clusters in Matroska (or at least desirable).
						: keyFrameInterval === 0
							|| multipleOfKeyFrameInterval !== this._lastMultipleOfKeyFrameInterval,
				};
				this._lastMultipleOfKeyFrameInterval = multipleOfKeyFrameInterval;

				config.onEncodedSample?.(sampleToEncode);

				if (this._customEncoder) {
					const customEncoder = this._customEncoder;
					this._customEncoderQueueSize++;

					// We clone the sample so that it stays alive until it reaches the encoder
					const clonedSample = sampleToEncode.clone();

					void this._customEncoderCallSerializer
						.call(() => customEncoder.encode(clonedSample, finalEncodeOptions))
						.catch((error: unknown) => this._handleError(error))
						.finally(() => {
							this._customEncoderQueueSize--;
							clonedSample.close();
							this._handleDequeue();
						});
				} else {
					assert(this._encoder);

					const videoFrame = sampleToEncode.toVideoFrame();

					const preciseTimingIndex = binarySearchLessOrEqual(
						this._preciseTimings,
						videoFrame.timestamp,
						x => x.microsecondTimestamp,
					);
					const existingEntry = preciseTimingIndex !== -1
						? this._preciseTimings[preciseTimingIndex]
						: null;
					if (existingEntry && existingEntry.microsecondTimestamp === videoFrame.timestamp) {
						if (existingEntry.timestamp !== sampleToEncode.timestamp) {
							// Mapping isn't unique, can't use the timestamp
							existingEntry.timestampIsValid = false;
						}
						if (existingEntry.duration !== sampleToEncode.duration) {
							// Mapping isn't unique, can't use the duration
							existingEntry.durationIsValid = false;
						}
					} else {
						this._preciseTimings.splice(preciseTimingIndex + 1, 0, {
							microsecondTimestamp: videoFrame.timestamp,
							timestamp: sampleToEncode.timestamp,
							duration: sampleToEncode.duration,
							timestampIsValid: true,
							durationIsValid: true,
						});

						// Make sure it doesn't grow indefinitely
						if (this._preciseTimings.length > 128) {
							this._preciseTimings.shift();
						}
					}

					const frameDefinitelyHasNoAlpha = !!videoFrame.format && !videoFrame.format.includes('A');

					if (!this._alphaEncoder) {
						// No alpha encoder, simple case
						try {
							this._encoder.encode(videoFrame, finalEncodeOptions);
						} finally {
							videoFrame.close();
						}
					} else if (frameDefinitelyHasNoAlpha) {
						this._alphaFrameQueue.push(null);
						try {
							this._encoder.encode(videoFrame, finalEncodeOptions);
						} finally {
							videoFrame.close();
						}
					} else {
						this._splitter ??= new ColorAlphaSplitter();

						// The splitter takes ownership, so no need to close the frame ourselves
						const { colorFrame, alphaFrame } = await this._splitter.split(videoFrame);
						if (this._released) {
							colorFrame.close();
							alphaFrame.close();
							return;
						}

						this._alphaFrameQueue.push(alphaFrame);
						try {
							this._encoder.encode(colorFrame, finalEncodeOptions);
						} finally {
							colorFrame.close();
						}
					}
				}
			}
		} finally {
			for (const sample of samplesToEncode) {
				if (sample !== videoSample) {
					sample.close();
				}
			}
		}
	}

	/** @internal */
	async _initEncoder(videoSample: VideoSample) {
		const config = this._config;

		// eslint-disable-next-line @typescript-eslint/no-deprecated
		const quality = resolveQuality(config.quality, config.bitrate);
		assert(quality !== undefined);

		const candidates = buildVideoEncoderConfigs({
			...config,
			quality,
			width: videoSample.codedWidth,
			height: videoSample.codedHeight,
			squarePixelWidth: videoSample.squarePixelWidth,
			squarePixelHeight: videoSample.squarePixelHeight,
			framerate: config.transform?.frameRate ?? config.frameRateHint,
		});

		// Try the candidate configs in order of preference until we find one that is supported
		let selected: VideoEncoderConfigCandidate | null = null;
		let MatchingCustomEncoder: (typeof customVideoEncoders)[number] | undefined;

		for (const candidate of candidates) {
			const candidateConfig = candidate.config;

			MatchingCustomEncoder = customVideoEncoders.find(x => x.supports(config.codec, candidateConfig));
			if (MatchingCustomEncoder) {
				selected = candidate;
				break;
			}

			if (typeof VideoEncoder === 'undefined') {
				continue;
			}

			candidateConfig.alpha = 'discard'; // Since we handle alpha ourselves

			if (config.alpha === 'keep') {
				// Encoding alpha requires using two parallel encoders, so we need to make sure they stay in sync
				// and that neither of them drops frames. Setting latencyMode to 'quality' achieves this, because
				// "User Agents MUST not drop frames to achieve the target bitrate and/or framerate."
				candidateConfig.latencyMode = 'quality';
			}

			const hasOddDimension = candidateConfig.width % 2 === 1 || candidateConfig.height % 2 === 1;
			if (hasOddDimension && (config.codec === 'avc' || config.codec === 'hevc')) {
				config.onEncoderConfig?.(candidateConfig);

				// Throw a special error for this case as it gets hit often
				throw new Error(
					`The dimensions ${candidateConfig.width}x${candidateConfig.height} are not supported for codec`
					+ ` '${config.codec}'; both width and height must be even numbers. Make sure to round your`
					+ ` dimensions to the nearest even number.`,
				);
			}

			try {
				const support = await VideoEncoder.isConfigSupported(candidateConfig);
				if (support.supported) {
					selected = candidate;
					break;
				}
			} catch {
				// Not supported
			}
		}

		if (!selected) {
			// The candidates only differ in their rate control, so we describe them as one config with a
			// slash-separated list of the attempted rate control methods
			const firstConfig = candidates[0]!.config;
			config.onEncoderConfig?.(firstConfig);

			if (typeof VideoEncoder === 'undefined') {
				throw new Error(missingWebCodecsClassMessage('VideoEncoder'));
			}

			const rateControls = candidates.map(({ config, quantizer }) =>
				quantizer !== null ? `quantizer ${quantizer}` : `${config.bitrate} bps`,
			);

			throw new Error(
				`This specific encoder configuration (${firstConfig.codec}, ${rateControls.join(' / ')},`
				+ ` ${firstConfig.width}x${firstConfig.height}, hardware acceleration:`
				+ ` ${firstConfig.hardwareAcceleration ?? 'no-preference'}) is not supported in this environment.`
				+ ` Consider using another codec or changing your video parameters.`,
			);
		}

		config.onEncoderConfig?.(selected.config);

		if (config.codec === 'avc' && isFirefox() && !MatchingCustomEncoder) {
			this._chunkTimestampsAreShiftedByDuration = await detectAvcChunkTimestampShift();
		}

		if (this._released) {
			return;
		}

		const encoderConfig = selected.config;
		if (selected.quantizer !== null) {
			// The chosen config uses quantizer-based rate control, so each frame must carry the quantizer value
			this._defaultEncodeOptions = buildQuantizerEncodeOptions(config.codec, selected.quantizer);
		} else {
			this._defaultEncodeOptions = {};
		}

		this._encoderConfig = encoderConfig;
		this._encoderSize = {
			width: videoSample.codedWidth,
			height: videoSample.codedHeight,
			squarePixelWidth: videoSample.squarePixelWidth,
			squarePixelHeight: videoSample.squarePixelHeight,
		};

		if (MatchingCustomEncoder) {
			// @ts-expect-error "Can't create instance of abstract class 🤓"
			const customEncoder = new MatchingCustomEncoder() as CustomVideoEncoder;
			// @ts-expect-error It's technically readonly
			customEncoder.codec = config.codec;
			// @ts-expect-error It's technically readonly
			customEncoder.config = encoderConfig;
			// @ts-expect-error It's technically readonly
			customEncoder.onPacket = (packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) => {
				if (!(packet instanceof EncodedPacket)) {
					throw new TypeError('The first argument passed to onPacket must be an EncodedPacket.');
				}
				if (meta !== undefined && (!meta || typeof meta !== 'object')) {
					throw new TypeError('The second argument passed to onPacket must be an object or undefined.');
				}
				if (packet.decoderConfig && packet.decoderConfig.type !== 'video') {
					throw new TypeError('The packet passed to onPacket must not have an audio decoder config.');
				}

				// The decoder config in the metadata takes precedence over the packet's
				const decoderConfig = this._resolveDecoderConfig(
					meta?.decoderConfig ? { ...meta.decoderConfig, type: 'video' } : packet.decoderConfig,
				);
				if (packet.decoderConfig !== decoderConfig) {
					packet = packet.clone({ decoderConfig });
				}

				if (this._emitPacket(packet)) {
					config.onEncodedPacket?.(packet, meta);
				}
			};
			// @ts-expect-error It's technically readonly
			customEncoder.onError = (error) => {
				this._handleError(error);
			};

			this._customEncoder = customEncoder;
			await this._customEncoderCallSerializer.call(() => customEncoder.init());
		} else {
			this._createWebCodecsEncoders();
		}
	}

	// Browsers may reclaim codecs that have been inactive for a while (see
	// https://github.com/Vanilagy/mediabunny/issues/531), closing them and reporting a QuotaExceededError. Since a
	// reclaimed encoder was idle, no frames are lost, so we transparently replace the encoders with fresh ones.
	/** @internal */
	_recreateWebCodecsEncoders() {
		assert(this._encoder);

		if (this._encoder.state !== 'closed') {
			this._encoder.close();
		}
		if (this._alphaEncoder && this._alphaEncoder.state !== 'closed') {
			this._alphaEncoder.close();
		}

		this._alphaFrameQueue.forEach(x => x?.close());
		this._alphaFrameQueue.length = 0;

		this._encodersReclaimed = false;
		this._lastMultipleOfKeyFrameInterval = null; // The fresh encoder must start with a key frame

		this._createWebCodecsEncoders();
	}

	/** @internal */
	_createWebCodecsEncoders() {
		const encoderConfig = this._encoderConfig;
		assert(encoderConfig);

		/** Queue of color chunks waiting for their alpha counterpart. */
		const colorChunkQueue: {
			chunk: EncodedVideoChunk;
			meta: EncodedVideoChunkMetadata | undefined;
		}[] = [];
		/** Each value is the number of encoded alpha chunks at which a null alpha chunk should be added. */
		const nullAlphaChunkQueue: number[] = [];
		let encodedAlphaChunkCount = 0;
		let alphaEncoderQueue = 0;

		const handleError = (error: DOMException, stack: string | undefined) => {
			if (isCodecReclaimedError(error)) {
				this._encodersReclaimed = true;
				return;
			}

			error.stack = stack; // Provide a more useful stack trace, the default one sucks
			this._handleError(error);
		};

		const stack = new Error('Encoding error').stack;

		const encoder = new VideoEncoder({
			output: (chunk, meta) => {
				try {
					if (!this._alphaEncoder) {
						// We're done
						this._handleChunks(chunk, null, meta);
						return;
					}

					const alphaFrame = this._alphaFrameQueue.shift();
					assert(alphaFrame !== undefined);

					if (alphaFrame) {
						this._alphaEncoder.encode(alphaFrame, {
							...this._defaultEncodeOptions,
							// Crucial: The alpha frame is forced to be a key frame whenever the color frame
							// also is. Without this, playback can glitch and even crash in some browsers.
							// This is the reason why the two encoders are wired in series and not in parallel.
							keyFrame: chunk.type === 'key',
						});
						alphaEncoderQueue++;
						alphaFrame.close();
						colorChunkQueue.push({ chunk, meta });
					} else {
						// There was no alpha component for this frame
						if (alphaEncoderQueue === 0) {
							// No pending alpha encodes either, so we're done
							this._handleChunks(chunk, null, meta);
						} else {
							// There are still alpha encodes pending, so we can't add the packet immediately since
							// we'd end up with out-of-order packets. Instead, let's queue a null alpha chunk to be
							// added in the future, after the current encoder workload has completed:
							nullAlphaChunkQueue.push(encodedAlphaChunkCount + alphaEncoderQueue);
							colorChunkQueue.push({ chunk, meta });
						}
					}
				} catch (error) {
					this._handleError(error);
				}
			},
			error: error => handleError(error, stack),
		});
		encoder.addEventListener('dequeue', () => {
			this._handleDequeue();
		});
		encoder.configure(encoderConfig);
		this._encoder = encoder;

		if (this._config.alpha === 'keep') {
			const stack = new Error('Encoding error').stack;

			// We need to encode alpha as well, which we do with a separate encoder
			this._alphaEncoder = new VideoEncoder({
				// We ignore the alpha chunk's metadata
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				output: (chunk, meta) => {
					try {
						alphaEncoderQueue--;

						// There has to be a color chunk because the encoders are wired in series
						const colorChunk = colorChunkQueue.shift();
						assert(colorChunk !== undefined);

						this._handleChunks(colorChunk.chunk, chunk, colorChunk.meta);

						// See if there are any null alpha chunks queued up
						encodedAlphaChunkCount++;
						while (
							nullAlphaChunkQueue.length > 0
							&& nullAlphaChunkQueue[0] === encodedAlphaChunkCount
						) {
							nullAlphaChunkQueue.shift();
							const colorChunk = colorChunkQueue.shift();
							assert(colorChunk !== undefined);

							this._handleChunks(colorChunk.chunk, null, colorChunk.meta);
						}
					} catch (error) {
						this._handleError(error);
					}
				},
				error: error => handleError(error, stack),
			});
			this._alphaEncoder.configure(encoderConfig);
		}
	}

	/** @internal */
	_handleChunks(
		colorChunk: EncodedVideoChunk,
		alphaChunk: EncodedVideoChunk | null,
		meta: EncodedVideoChunkMetadata | undefined,
	) {
		const config = this._config;
		const sideData: EncodedPacketSideData = {};

		if (alphaChunk) {
			const alphaData = new Uint8Array(alphaChunk.byteLength);
			alphaChunk.copyTo(alphaData);

			sideData.alpha = alphaData;
		}

		const data = new Uint8Array(colorChunk.byteLength);
		colorChunk.copyTo(data);

		const encoderConfig = this._encoderConfig;
		assert(encoderConfig);

		if (meta?.decoderConfig) {
			// Let's correct the codec string based on the actual bitstream data, rather than leaving it on the default
			// value (which is just what was in the encoder config). This provides better consistency.
			meta.decoderConfig.codec = extractVideoCodecString({
				width: encoderConfig.width,
				height: encoderConfig.height,
				codec: config.codec,
				codecDescription: meta.decoderConfig.description
					? toUint8Array(meta.decoderConfig.description)
					: null,
				colorSpace: meta.decoderConfig.colorSpace ?? null,
				avcType: encoderConfig.codec.includes('avc1.')
					? 1
					: encoderConfig.codec.includes('avc3.')
						? 3
						: null,
				avcCodecInfo: config.codec === 'avc' && !meta.decoderConfig.description
					? extractAvcDecoderConfigurationRecord(data)
					: null,
				hevcType: encoderConfig.codec.includes('hev1.')
					? 'hev1'
					: encoderConfig.codec.includes('hvc1.')
						? 'hvc1'
						: null,
				hevcCodecInfo: config.codec === 'hevc' && !meta.decoderConfig.description
					? extractHevcDecoderConfigurationRecord(data)
					: null,
				vp9CodecInfo: config.codec === 'vp9'
					? extractVp9CodecInfoFromPacket(data)
					: null,
				av1CodecInfo: config.codec === 'av1'
					? extractAv1CodecInfoFromPacket(data)
					: null,
				proresFormat: null, // Can't be encoded by WebCodecs
			});

			if (config.codec === 'avc' && meta.decoderConfig.description && isFirefox()) {
				// This works around https://bugzilla.mozilla.org/show_bug.cgi?id=2082867
				// Also see https://github.com/Vanilagy/mediabunny/issues/559
				const parsed = deserializeAvcDecoderConfigurationRecord(toUint8Array(meta.decoderConfig.description));
				let sps = parsed?.sequenceParameterSets[0];

				if (sps && sps[0] === sps[1]) { // The first two bytes of the SPS being the same is a reliable signal
					assert(parsed);
					sps = sps.subarray(1);

					let pps = parsed.pictureParameterSets[0];
					if (pps) {
						pps = pps.subarray(1);
					}

					const record = serializeAvcDecoderConfigurationRecord({
						...parsed,
						sequenceParameterSets: [sps],
						pictureParameterSets: pps ? [pps] : [],
					});
					meta.decoderConfig.description = record;
				}
			}
		}

		let microsecondTimestamp = colorChunk.timestamp;
		if (this._chunkTimestampsAreShiftedByDuration) {
			// The encoder added the frame's duration to its timestamp, so undo that
			microsecondTimestamp -= colorChunk.duration ?? 0;
		}

		// See if there's a relevant timing entry to refine the packet's timing data
		const preciseTimingIndex = binarySearchLessOrEqual(
			this._preciseTimings,
			microsecondTimestamp,
			x => x.microsecondTimestamp,
		);
		const closestEntry = preciseTimingIndex !== -1 ? this._preciseTimings[preciseTimingIndex]! : null;
		const entry = closestEntry?.microsecondTimestamp === microsecondTimestamp ? closestEntry : null;

		let type = colorChunk.type as PacketType;
		if (this._emittedPacketCount === 0 && type === 'delta' && meta?.decoderConfig) {
			// https://github.com/Vanilagy/mediabunny/issues/365
			// We expect the first packet to be a key packet. If it's not, let's actually verify that it's
			// not by getting the actual type.
			type = determineVideoPacketType(config.codec, meta.decoderConfig, data) ?? type;
		}

		const packet = new EncodedPacket({
			data,
			type,
			timestamp: entry?.timestampIsValid ? entry.timestamp : microsecondTimestamp / 1e6,
			duration: entry?.durationIsValid ? entry.duration : (colorChunk.duration ?? 0) / 1e6,
			sideData,
			decoderConfig: this._resolveDecoderConfig(
				meta?.decoderConfig ? { ...meta.decoderConfig, type: 'video' } : null,
			),
		});

		this._emittedPacketCount++;
		if (this._emitPacket(packet)) {
			config.onEncodedPacket?.(packet, meta);
		}
	}

	/** @internal */
	_getEncoderQueueSize() {
		if (this._customEncoder) {
			return this._customEncoderQueueSize;
		} else {
			// Because the color and alpha encoders are wired in series, there's no need to also include the alpha
			// encoder's queue size here
			return this._encoder?.encodeQueueSize ?? 0;
		}
	}

	/** @internal */
	_releaseEncoder() {
		const closePromise = this._closeEncoders();
		this._splitter?.close();

		this._frameRateLastSample?.close();
		this._frameRateLastSample = null;

		return closePromise;
	}

	/** @internal */
	_closeEncoders() {
		let closePromise = Promise.resolve();

		if (this._customEncoder) {
			const customEncoder = this._customEncoder;
			closePromise = this._customEncoderCallSerializer
				.call(() => customEncoder.close())
				.catch(() => {});
			this._customEncoder = null;
		}
		if (this._encoder) {
			if (this._encoder.state !== 'closed') {
				this._encoder.close();
			}
			this._encoder = null;
		}
		if (this._alphaEncoder) {
			if (this._alphaEncoder.state !== 'closed') {
				this._alphaEncoder.close();
			}
			this._alphaEncoder = null;
		}

		this._alphaFrameQueue.forEach(x => x?.close());
		this._alphaFrameQueue.length = 0;

		this._encoderSize = null;
		this._encoderConfig = null;
		this._encodersReclaimed = false;

		return closePromise;
	}
}

let avcChunkTimestampShiftPromise: Promise<boolean> | null = null;

// Detects https://bugzilla.mozilla.org/show_bug.cgi?id=2082890 so we can work around it
const detectAvcChunkTimestampShift = () => {
	return avcChunkTimestampShiftPromise ??= (async () => {
		let chunkTimestamp: number | null = null;
		const encoder = new VideoEncoder({
			output: (chunk) => {
				chunkTimestamp ??= chunk.timestamp;
			},
			error: () => {},
		});

		try {
			encoder.configure({
				codec: 'avc1.64001f',
				width: 1280,
				height: 720,
			});

			const frame = new VideoFrame(new Uint8Array(1280 * 720 * 1.5), {
				format: 'I420',
				codedWidth: 1280,
				codedHeight: 720,
				timestamp: 0,
				duration: 500,
			});
			encoder.encode(frame, { keyFrame: true });
			frame.close();

			await encoder.flush();
		} catch {
			// Firefox encoders can be flaky and error _sometimes_, so let's just try again next time
			avcChunkTimestampShiftPromise = null;

			return false;
		} finally {
			if (encoder.state !== 'closed') {
				encoder.close();
			}
		}

		return chunkTimestamp === 500;
	})();
};

/** Utility class for splitting a composite frame into separate color and alpha parts on the CPU in a worker. */
export class ColorAlphaSplitter {
	private worker: Worker | null = null;
	private pendingRequests = new Map<
		number,
		ReturnType<typeof promiseWithResolvers<{ colorFrame: VideoFrame; alphaFrame: VideoFrame }>>
	>();

	private nextRequestId = 0;

	split(sourceFrame: VideoFrame): Promise<{ colorFrame: VideoFrame; alphaFrame: VideoFrame }> {
		if (!this.worker) {
			this.worker = createWorker('color-alpha-splitter', colorAlphaSplitterWorkerCode);

			this.worker.addEventListener('message', (event: MessageEvent<ColorAlphaSplitterWorkerResponse>) => {
				const data = event.data;
				const pending = this.pendingRequests.get(data.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(data.id);

				if ('error' in data) {
					pending.reject(new Error(data.error));
				} else {
					pending.resolve({ colorFrame: data.colorFrame, alphaFrame: data.alphaFrame });
				}
			});

			this.worker.addEventListener('error', (event) => {
				const error = new Error(event.message || 'Color/alpha splitter worker error.');
				for (const pending of this.pendingRequests.values()) {
					pending.reject(error);
				}
				this.pendingRequests.clear();
			});
		}

		const id = this.nextRequestId++;
		const pending = promiseWithResolvers<{ colorFrame: VideoFrame; alphaFrame: VideoFrame }>();
		this.pendingRequests.set(id, pending);
		this.worker.postMessage({ id, sourceFrame }, { transfer: [sourceFrame] });

		return pending.promise;
	}

	close() {
		this.worker?.terminate();
		this.worker = null;

		const error = new Error('Color/alpha splitter closed.');
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

type ColorAlphaSplitterWorkerRequest = {
	id: number;
	sourceFrame: VideoFrame;
};

type ColorAlphaSplitterWorkerResponse =
	| { id: number; colorFrame: VideoFrame; alphaFrame: VideoFrame }
	| { id: number; error: string };

export const colorAlphaSplitterWorkerCode = () => {
	// Reused across frames as long as the size matches, since consecutive frames usually share dimensions.
	let cpuSourceBuffer: Uint8Array | null = null;

	// Serialize execution internally so concurrent requests don't race on the shared cpuSourceBuffer.
	let chain: Promise<void> = Promise.resolve();
	self.addEventListener('message', (event: MessageEvent<ColorAlphaSplitterWorkerRequest>) => {
		const { id, sourceFrame } = event.data;
		chain = chain.then(async () => {
			try {
				const { colorFrame, alphaFrame } = await split(sourceFrame);
				self.postMessage({ id, colorFrame, alphaFrame }, { transfer: [colorFrame, alphaFrame] });
			} catch (error) {
				self.postMessage({ id, error: (error as Error).message });
			} finally {
				sourceFrame.close();
			}
		});
	});

	const split = async (sourceFrame: VideoFrame) => {
		const format = sourceFrame.format as VideoSamplePixelFormat | null;
		if (!format) {
			throw new Error('CPU color/alpha splitting requires a known VideoFrame format.');
		}

		const sourceSize = sourceFrame.allocationSize();

		if (!cpuSourceBuffer || cpuSourceBuffer.byteLength !== sourceSize) {
			cpuSourceBuffer = new Uint8Array(sourceSize);
		}
		await sourceFrame.copyTo(cpuSourceBuffer);

		if (format === 'RGBA' || format === 'BGRA') {
			return splitInterleavedRgba(cpuSourceBuffer, format, sourceFrame);
		} else if (
			format === 'I420A' || format === 'I420AP10' || format === 'I420AP12'
			|| format === 'I422A' || format === 'I422AP10' || format === 'I422AP12'
			|| format === 'I444A' || format === 'I444AP10' || format === 'I444AP12'
		) {
			return splitPlanarYuvA(cpuSourceBuffer, format, sourceFrame);
		}

		throw new Error(`CPU color/alpha splitting does not support format '${format}'.`);
	};

	const splitInterleavedRgba = (
		source: Uint8Array,
		format: 'RGBA' | 'BGRA',
		sourceFrame: VideoFrame,
	) => {
		const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
		const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;

		const pixelCount = width * height;
		const chromaW = Math.ceil(width / 2);
		const chromaH = Math.ceil(height / 2);
		const alphaSize = pixelCount + chromaW * chromaH * 2;

		// Encode alpha as I420: Y = source A bytes, UV = 128
		const alphaBuffer = new Uint8Array(alphaSize);
		for (let i = 0, j = 3; i < pixelCount; i++, j += 4) {
			alphaBuffer[i] = source[j]!;
		}
		alphaBuffer.fill(128, pixelCount);

		// Hand the source buffer straight to VideoFrame as RGBX/BGRX so the A bytes are ignored
		const colorFrame = new VideoFrame(source, {
			format: format === 'RGBA' ? 'RGBX' : 'BGRX',
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			// No transfer!
		});
		const alphaInit = {
			format: 'I420' as const,
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: {
				fullRange: true,
				matrix: 'bt709',
				primaries: 'bt709',
				transfer: 'bt709',
			} as const,
			transfer: [alphaBuffer.buffer],
		};
		const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
		return { colorFrame, alphaFrame };
	};

	const splitPlanarYuvA = (
		source: Uint8Array,
		format:
			| 'I420A' | 'I420AP10' | 'I420AP12'
			| 'I422A' | 'I422AP10' | 'I422AP12'
			| 'I444A' | 'I444AP10' | 'I444AP12',
		sourceFrame: VideoFrame,
	) => {
		const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
		const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;

		const is10 = format.includes('P10');
		const is12 = format.includes('P12');
		const bytesPerSample = (is10 || is12) ? 2 : 1;

		let chromaW: number;
		let chromaH: number;
		if (format.startsWith('I420')) {
			chromaW = Math.ceil(width / 2);
			chromaH = Math.ceil(height / 2);
		} else if (format.startsWith('I422')) {
			chromaW = Math.ceil(width / 2);
			chromaH = height;
		} else {
			chromaW = width;
			chromaH = height;
		}

		const ySamples = width * height;
		const uvSamples = chromaW * chromaH;
		const yBytes = ySamples * bytesPerSample;
		const uvBytes = uvSamples * bytesPerSample;
		const aBytes = ySamples * bytesPerSample;

		const colorBytes = yBytes + uvBytes * 2;
		const colorFormat = format.replace('A', '') as VideoPixelFormat;

		const alphaChromaW = Math.ceil(width / 2);
		const alphaChromaH = Math.ceil(height / 2);
		const alphaUvSamples = alphaChromaW * alphaChromaH;
		const alphaUvBytes = alphaUvSamples * bytesPerSample;
		const alphaSize = aBytes + 2 * alphaUvBytes;
		const alphaBuffer = new Uint8Array(alphaSize);

		const aPlaneStart = colorBytes;
		alphaBuffer.set(source.subarray(aPlaneStart, aPlaneStart + aBytes), 0);

		// Fill UV planes with the neutral chroma value
		const uvOffset = aBytes;
		const neutralChroma = is10 ? 512 : (is12 ? 2048 : 128);

		if (bytesPerSample === 1) {
			alphaBuffer.fill(neutralChroma, uvOffset);
		} else {
			const uvView = new Uint16Array(alphaBuffer.buffer, uvOffset, 2 * alphaUvSamples);
			uvView.fill(neutralChroma);
		}

		const alphaFormat = (is10 ? 'I420P10' : (is12 ? 'I420P12' : 'I420')) as VideoPixelFormat;

		// Color frame is simply a prefix of the combined bytes
		const colorFrame = new VideoFrame(source.subarray(0, colorBytes), {
			format: colorFormat,
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: sourceFrame.colorSpace,
		});
		const alphaInit = {
			format: alphaFormat,
			codedWidth: width,
			codedHeight: height,
			timestamp: sourceFrame.timestamp,
			duration: sourceFrame.duration ?? undefined,
			colorSpace: {
				fullRange: true,
				matrix: 'bt709',
				primaries: 'bt709',
				transfer: 'bt709',
			} as const,
			transfer: [alphaBuffer.buffer],
		};
		const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
		return { colorFrame, alphaFrame };
	};
};

export const PCM_ENCODER_PACKET_SIZE = 2048; // In frames

export type AudioSampleEncoderOptions = AudioEncodingConfig & SampleEncoderOptions;

export class AudioSampleEncoder extends SampleEncoder<AudioSample> {
	/** @internal */
	_config: AudioEncodingConfig;
	/** @internal */
	_highWaterMark: number;

	/** @internal */
	_firstNumberOfChannels: number | null = null;
	/** @internal */
	_firstSampleRate: number | null = null;
	/** @internal */
	_resampler: AudioResampler | null = null;
	/** @internal */
	_lastEndSampleIndex: number | null = null;

	/** @internal */
	_encoderParams: { numberOfChannels: number; sampleRate: number } | null = null;
	/** @internal */
	_encoderNeedsCheck = false;
	/** @internal */
	_encoder: AudioEncoder | null = null;
	/** @internal */
	_emittedPacketCount = 0;
	/** @internal */
	_primingShift = 0; // In seconds
	/** @internal */
	_opusPreSkip = 0; // In seconds
	/** @internal */
	_needsAacSilencePrefix = false;
	/** @internal */
	_segmentIndex = 0;
	/** @internal */
	_segmentStartTimestamp: number | null = null;
	/** @internal */
	_segmentTimestampOffset = 0;

	/** @internal */
	_customEncoder: CustomAudioEncoder | null = null;
	/** @internal */
	_customEncoderCallSerializer = new CallSerializer();
	/** @internal */
	_customEncoderQueueSize = 0;

	/** @internal */
	_isPcmEncoder = false;
	/** @internal */
	_pcmFormat = PCM_FORMAT_U8;
	/** @internal */
	_pcmSampleSize = 0;
	/** @internal */
	_pcmDecoderConfig: ExtendedAudioDecoderConfig | null = null;
	/** @internal */
	_pcmStartTimestamp = 0;
	/** @internal */
	_pcmEmittedFrames = 0;
	/** @internal */
	_pcmReadBuffer = new ArrayBuffer(0);
	/** @internal */
	_pcmScratchView: DataView | null = null;
	/** @internal */
	_pcmScratchFrames = 0;

	constructor(options: AudioSampleEncoderOptions) {
		validateAudioEncodingConfig(options);
		validateHighWaterMark(options.highWaterMark, 'options');

		super();

		this._config = options;
		this._highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
	}

	push(sample: AudioSample | null) {
		if (sample !== null && !(sample instanceof AudioSample)) {
			throw new TypeError('sample must be an AudioSample or null.');
		}

		return this._push(sample, undefined);
	}

	/** @internal */
	_decoderConfigsAreEqual(a: AnyDecoderConfig, b: AnyDecoderConfig) {
		assert(a.type === 'audio' && b.type === 'audio');
		return audioDecoderConfigsAreEqual(a, b);
	}

	/** @internal */
	_validateSample(sample: AudioSample) {
		if (this._firstNumberOfChannels === null || this._firstSampleRate === null) {
			this._firstNumberOfChannels = sample.numberOfChannels;
			this._firstSampleRate = sample.sampleRate;
		} else if (
			sample.numberOfChannels !== this._firstNumberOfChannels
			|| sample.sampleRate !== this._firstSampleRate
		) {
			throw new Error(
				`Audio parameters must remain constant. Expected ${this._firstNumberOfChannels} channels at`
				+ ` ${this._firstSampleRate} Hz, got ${sample.numberOfChannels} channels at ${sample.sampleRate} Hz.`,
			);
		}
	}

	/** @internal */
	_resetSampleValidation() {
		this._firstNumberOfChannels = null;
		this._firstSampleRate = null;
	}

	/** @internal */
	async _encodeSample(audioSample: AudioSample) {
		const transform = this._config.transform;

		if (transform?.numberOfChannels !== undefined || transform?.sampleRate !== undefined) {
			this._resampler ??= new AudioResampler({
				targetNumberOfChannels: transform.numberOfChannels ?? audioSample.numberOfChannels,
				targetSampleRate: transform.sampleRate ?? audioSample.sampleRate,
				onSample: async (sample) => {
					try {
						await this._processAndEncode(sample);
					} finally {
						sample.close();
					}
				},
			});

			await this._resampler.add(audioSample);
		} else {
			await this._processAndEncode(audioSample);
		}
	}

	/** @internal */
	async _flush() {
		if (this._resampler) {
			await this._resampler.finalize();
			this._resampler = null;

			if (this._released) {
				return;
			}
		}

		if (this._pcmScratchFrames > 0) {
			this._emitPcmScratchPacket();
		}

		if (this._customEncoder) {
			const customEncoder = this._customEncoder;
			await this._customEncoderCallSerializer.call(() => customEncoder.flush());
		} else if (this._encoder) {
			await this._encoder.flush();

			if (this._segmentStartTimestamp !== null) {
				this._segmentIndex++;
				this._segmentStartTimestamp = null;
			}
		}

		// The next sample starts over completely
		this._lastEndSampleIndex = null;
		this._pcmDecoderConfig = null;
		this._pcmEmittedFrames = 0;
		this._emittedPacketCount = 0;
		this._encoderNeedsCheck = true;
	}

	/** @internal */
	async _processAndEncode(audioSample: AudioSample) {
		const transform = this._config.transform;

		let converted: AudioSample | null = null;
		if (
			transform?.sampleFormat !== undefined
			&& toInterleavedAudioFormat(audioSample.format) !== transform.sampleFormat
		) {
			converted = audioSampleToInterleavedFormat(audioSample, transform.sampleFormat);
		}

		try {
			const sample = converted ?? audioSample;

			if (!transform?.process) {
				await this._encode(sample);
				return;
			}

			let processed = transform.process(sample);
			if (isThenable(processed)) {
				processed = await processed;
			}

			if (processed === null) {
				return;
			}

			if (!Array.isArray(processed)) {
				processed = [processed];
			}

			try {
				for (const x of processed) {
					if (!(x instanceof AudioSample)) {
						throw new TypeError(
							'The audio process function must return an AudioSample, null, or an array of AudioSamples.',
						);
					}
				}

				for (const x of processed) {
					await this._encode(x);
				}
			} finally {
				for (const x of processed) {
					if (x instanceof AudioSample && x !== sample) {
						x.close();
					}
				}
			}
		} finally {
			converted?.close();
		}
	}

	/** @internal */
	async _encode(audioSample: AudioSample) {
		if (audioSample.numberOfFrames === 0) {
			// Nothing to encode
			return;
		}

		if (this._released) {
			return;
		}

		if (this._encoderNeedsCheck) {
			// The first sample after a flush decides whether the existing encoder can be kept
			this._encoderNeedsCheck = false;

			const params = this._encoderParams;
			if (
				params
				&& (
					params.numberOfChannels !== audioSample.numberOfChannels
					|| params.sampleRate !== audioSample.sampleRate
				)
			) {
				void this._closeEncoders();
			}
		}

		if (!this._encoderParams) {
			await this._initEncoder(audioSample);
			if (this._released) {
				return;
			}
		}

		// Handle padding of gaps with silence to avoid audio drift over time, like in
		// https://github.com/Vanilagy/mediabunny/issues/176
		// TODO An open question is how encoders deal with the first AudioData having a non-zero timestamp, and with
		// AudioDatas that have an overlapping timestamp range.
		{
			const startSampleIndex = Math.round(audioSample.sampleRate * audioSample.timestamp);
			const endSampleIndex = Math.round(audioSample.sampleRate * (audioSample.timestamp + audioSample.duration));

			if (this._lastEndSampleIndex === null) {
				this._lastEndSampleIndex = endSampleIndex;
			} else {
				const sampleDiff = startSampleIndex - this._lastEndSampleIndex;

				if (sampleDiff >= 64) {
					// The gap is big enough, let's add correction samples, at most a second each so long gaps
					// don't need huge allocations
					const bytesPerFrame = getBytesPerSample(audioSample.format) * audioSample.numberOfChannels;
					const silence = new Uint8Array(bytesPerFrame * Math.min(sampleDiff, audioSample.sampleRate));
					if (audioSample.format === 'u8' || audioSample.format === 'u8-planar') {
						silence.fill(2 ** 7); // Fill it with the silent value
					}

					let remainingFrames = sampleDiff;
					while (remainingFrames > 0) {
						const frameCount = Math.min(remainingFrames, audioSample.sampleRate);
						const fillSample = new AudioSample({
							data: silence.subarray(0, bytesPerFrame * frameCount),
							_doNotCopy: true,
							format: audioSample.format,
							sampleRate: audioSample.sampleRate,
							numberOfChannels: audioSample.numberOfChannels,
							numberOfFrames: frameCount,
							timestamp: this._lastEndSampleIndex / audioSample.sampleRate,
						});

						try {
							await this._encode(fillSample); // Recursive call, advances lastEndSampleIndex
						} finally {
							fillSample.close();
						}
						if (this._released) {
							return;
						}

						remainingFrames -= frameCount;
					}
				}

				this._lastEndSampleIndex += audioSample.numberOfFrames;
			}
		}

		if (this._getAdmittedQueueSize() >= this._highWaterMark) {
			await this._waitForRoom();
		}
		if (this._released) {
			return;
		}

		this._config.onEncodedSample?.(audioSample);

		if (this._customEncoder) {
			const customEncoder = this._customEncoder;
			this._customEncoderQueueSize++;

			// We clone the sample so that it stays alive until it reaches the encoder
			const clonedSample = audioSample.clone();

			void this._customEncoderCallSerializer
				.call(() => customEncoder.encode(clonedSample))
				.catch((error: unknown) => this._handleError(error))
				.finally(() => {
					this._customEncoderQueueSize--;
					clonedSample.close();
					this._handleDequeue();
				});
		} else if (this._isPcmEncoder) {
			// Each step of the generator emits one packet. It only advances as far as there's room, so that the rest
			// gets produced right as packets are pulled.
			this._generator = this._encodePcm(audioSample);
			this._drainGenerator();

			if (this._generator) {
				this._generatorDrained = promiseWithResolvers();
				await this._generatorDrained.promise;
			}
		} else {
			assert(this._encoder);

			if (this._needsAacSilencePrefix) {
				encodeAacSilencePrefix(
					this._encoder,
					audioSample.format,
					audioSample.numberOfChannels,
					audioSample.sampleRate,
					audioSample.timestamp,
				);
				this._needsAacSilencePrefix = false;
			}

			this._segmentStartTimestamp ??= audioSample.timestamp;

			const audioData = audioSample.toAudioData();
			try {
				this._encoder.encode(audioData);
			} finally {
				audioData.close();
			}
		}
	}

	/** @internal */
	async _initEncoder(audioSample: AudioSample) {
		const config = this._config;
		const { numberOfChannels, sampleRate } = audioSample;

		// eslint-disable-next-line @typescript-eslint/no-deprecated
		const quality = resolveQuality(config.quality, config.bitrate);

		const encoderConfig = buildAudioEncoderConfig({
			numberOfChannels,
			sampleRate,
			...config,
			quality,
		});
		config.onEncoderConfig?.(encoderConfig);

		const MatchingCustomEncoder = customAudioEncoders.find(x => x.supports(config.codec, encoderConfig));

		if (MatchingCustomEncoder) {
			// @ts-expect-error "Can't create instance of abstract class 🤓"
			const customEncoder = new MatchingCustomEncoder() as CustomAudioEncoder;
			// @ts-expect-error It's technically readonly
			customEncoder.codec = config.codec;
			// @ts-expect-error It's technically readonly
			customEncoder.config = encoderConfig;
			// @ts-expect-error It's technically readonly
			customEncoder.onPacket = (packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) => {
				if (!(packet instanceof EncodedPacket)) {
					throw new TypeError('The first argument passed to onPacket must be an EncodedPacket.');
				}
				if (meta !== undefined && (!meta || typeof meta !== 'object')) {
					throw new TypeError('The second argument passed to onPacket must be an object or undefined.');
				}
				if (packet.decoderConfig && packet.decoderConfig.type !== 'audio') {
					throw new TypeError('The packet passed to onPacket must not have a video decoder config.');
				}

				// The decoder config in the metadata takes precedence over the packet's
				const decoderConfig = this._resolveDecoderConfig(
					meta?.decoderConfig ? { ...meta.decoderConfig, type: 'audio' } : packet.decoderConfig,
				);
				if (packet.decoderConfig !== decoderConfig) {
					packet = packet.clone({ decoderConfig });
				}

				if (this._emitPacket(packet)) {
					config.onEncodedPacket?.(packet, meta);
				}
			};
			// @ts-expect-error It's technically readonly
			customEncoder.onError = (error) => {
				this._handleError(error);
			};

			this._customEncoder = customEncoder;
			await this._customEncoderCallSerializer.call(() => customEncoder.init());
		} else if ((PCM_AUDIO_CODECS as readonly string[]).includes(config.codec)) {
			this._isPcmEncoder = true;
			this._pcmFormat = getPcmFormat(config.codec as PcmAudioCodec);
			this._pcmSampleSize = parsePcmCodec(config.codec as PcmAudioCodec).sampleSize;
		} else {
			if (typeof AudioEncoder === 'undefined') {
				throw new Error(missingWebCodecsClassMessage('AudioEncoder'));
			}

			const supported = await isAudioEncoderConfigSupported(config.codec, encoderConfig);
			if (!supported) {
				throw new Error(
					`This specific encoder configuration (${encoderConfig.codec}, ${encoderConfig.bitrate} bps,`
					+ ` ${encoderConfig.numberOfChannels} channels, ${encoderConfig.sampleRate} Hz) is not`
					+ ` supported in this environment. Consider using another codec or changing your`
					+ ` audio parameters.`,
				);
			}

			const primingShiftInSamples = await detectAudioEncoderPrimingShift(config.codec, encoderConfig.codec);
			if (this._released) {
				return;
			}

			this._primingShift = primingShiftInSamples / encoderConfig.sampleRate;
			this._opusPreSkip = 0;
			this._needsAacSilencePrefix = config.codec === 'aac' && isWebKit();
			this._segmentIndex = 0;

			const stack = new Error('Encoding error').stack;
			const encoder = new AudioEncoder({
				output: (chunk, meta) => {
					try {
						if (meta?.decoderConfig) {
							fixAudioDecoderConfig(config.codec, encoderConfig, meta.decoderConfig);

							// We want Opus packet timestamps to include the pre-skip
							if (config.codec === 'opus' && meta.decoderConfig.description) {
								const description = toUint8Array(meta.decoderConfig.description);
								const { preSkip } = parseOpusIdentificationHeader(description);
								this._opusPreSkip = preSkip / OPUS_SAMPLE_RATE;
							}
						}

						const chunkTimestamp = chunk.timestamp / 1e6;

						let timestamp: number;
						if (this._segmentIndex === 0) {
							// Firefox only offsets the very first timestamp by the pre-skip
							const opusPreSkip = isFirefox() && this._emittedPacketCount > 0 ? 0 : this._opusPreSkip;
							timestamp = chunkTimestamp - opusPreSkip;
						} else {
							// After a flush, the run is anchored on its first sample. Firefox needs this, since it
							// keeps counting from where it left off instead of following the input timestamps.
							// See https://bugzilla.mozilla.org/show_bug.cgi?id=2098500
							if (this._emittedPacketCount === 0) {
								assert(this._segmentStartTimestamp !== null);
								this._segmentTimestampOffset
									= this._segmentStartTimestamp - this._opusPreSkip - chunkTimestamp;
							}

							timestamp = chunkTimestamp + this._segmentTimestampOffset;
						}
						timestamp -= this._primingShift;

						const data = new Uint8Array(chunk.byteLength);
						chunk.copyTo(data);

						// Snap the timing information to the sample rate to recover information lost in microsecond
						// conversion
						const packet = new EncodedPacket({
							data,
							type: chunk.type as PacketType,
							timestamp: roundToDivisor(timestamp, encoderConfig.sampleRate),
							duration: roundToDivisor((chunk.duration ?? 0) / 1e6, encoderConfig.sampleRate),
							decoderConfig: this._resolveDecoderConfig(
								meta?.decoderConfig ? { ...meta.decoderConfig, type: 'audio' } : null,
							),
						});

						this._emittedPacketCount++;
						if (this._emitPacket(packet)) {
							config.onEncodedPacket?.(packet, meta);
						}
					} catch (error) {
						this._handleError(error);
					}
				},
				error: (error) => {
					// Unlike video, there's no reclaim handling here: Chromium never reclaims AudioEncoders in
					// practice

					error.stack = stack; // Provide a more useful stack trace
					this._handleError(error);
				},
			});
			encoder.addEventListener('dequeue', () => {
				this._handleDequeue();
			});
			encoder.configure(encoderConfig);
			this._encoder = encoder;
		}

		this._encoderParams = { numberOfChannels, sampleRate };
	}

	/** @internal */
	* _encodePcm(audioSample: AudioSample) {
		const { numberOfChannels, numberOfFrames, sampleRate, timestamp } = audioSample;

		if (!this._pcmDecoderConfig) {
			this._pcmDecoderConfig = {
				type: 'audio',
				codec: this._config.codec,
				numberOfChannels,
				sampleRate,
			};
			// Gaps get padded with silence before reaching us, so it's one contiguous run from here on
			this._pcmStartTimestamp = timestamp;
		}

		// Read the whole sample interleaved into our reusable read buffer, growing it if needed
		const isS32 = audioSample.format === 's32' || audioSample.format === 's32-planar';
		const readFormat = isS32 ? 's32' : 'f32'; // Can't read in f32 due to precision loss
		const scale = isS32 ? 1 / 2147483648 : 1;

		const allocationSize = audioSample.allocationSize({ planeIndex: 0, format: readFormat });
		if (this._pcmReadBuffer.byteLength < allocationSize) {
			this._pcmReadBuffer = new ArrayBuffer(allocationSize);
		}
		const values = isS32
			? new Int32Array(this._pcmReadBuffer, 0, allocationSize / 4)
			: new Float32Array(this._pcmReadBuffer, 0, allocationSize / 4);
		audioSample.copyTo(values, { planeIndex: 0, format: readFormat });

		const format = this._pcmFormat;
		const sampleSize = this._pcmSampleSize;

		// Fill up the scratch buffer, emitting it as a packet each time it's full
		let frame = 0;
		while (frame < numberOfFrames) {
			this._pcmScratchView ??= new DataView(
				new ArrayBuffer(PCM_ENCODER_PACKET_SIZE * numberOfChannels * sampleSize),
			);
			const view = this._pcmScratchView;

			const frameCount = Math.min(PCM_ENCODER_PACKET_SIZE - this._pcmScratchFrames, numberOfFrames - frame);
			const valueOffset = this._pcmScratchFrames * numberOfChannels;
			const readOffset = frame * numberOfChannels;

			// This loop is plenty fast. The important thing is that the switch uses integer keys and not strings.
			for (let i = 0; i < frameCount * numberOfChannels; i++) {
				const value = scale * values[readOffset + i]!;
				const byteOffset = sampleSize * (valueOffset + i);

				switch (format) {
					case PCM_FORMAT_U8: {
						view.setUint8(byteOffset, clamp(Math.round(128 * value) + 128, 0, 255));
					}; break;
					case PCM_FORMAT_S8: {
						view.setInt8(byteOffset, clamp(Math.round(128 * value), -128, 127));
					}; break;
					case PCM_FORMAT_ULAW: {
						view.setUint8(byteOffset, toUlaw(clamp(Math.round(32768 * value), -32768, 32767)));
					}; break;
					case PCM_FORMAT_ALAW: {
						view.setUint8(byteOffset, toAlaw(clamp(Math.round(32768 * value), -32768, 32767)));
					}; break;
					case PCM_FORMAT_U16_LE: {
						view.setUint16(byteOffset, clamp(Math.round(32768 * value) + 32768, 0, 65535), true);
					}; break;
					case PCM_FORMAT_U16_BE: {
						view.setUint16(byteOffset, clamp(Math.round(32768 * value) + 32768, 0, 65535), false);
					}; break;
					case PCM_FORMAT_S16_LE: {
						view.setInt16(byteOffset, clamp(Math.round(32768 * value), -32768, 32767), true);
					}; break;
					case PCM_FORMAT_S16_BE: {
						view.setInt16(byteOffset, clamp(Math.round(32768 * value), -32768, 32767), false);
					}; break;
					case PCM_FORMAT_U24_LE: {
						setUint24(view, byteOffset, clamp(Math.round(8388608 * value) + 8388608, 0, 16777215), true);
					}; break;
					case PCM_FORMAT_U24_BE: {
						setUint24(view, byteOffset, clamp(Math.round(8388608 * value) + 8388608, 0, 16777215), false);
					}; break;
					case PCM_FORMAT_S24_LE: {
						setInt24(view, byteOffset, clamp(Math.round(8388608 * value), -8388608, 8388607), true);
					}; break;
					case PCM_FORMAT_S24_BE: {
						setInt24(view, byteOffset, clamp(Math.round(8388608 * value), -8388608, 8388607), false);
					}; break;
					case PCM_FORMAT_U32_LE: {
						view.setUint32(
							byteOffset,
							clamp(Math.round(2147483648 * value) + 2147483648, 0, 4294967295),
							true,
						);
					}; break;
					case PCM_FORMAT_U32_BE: {
						view.setUint32(
							byteOffset,
							clamp(Math.round(2147483648 * value) + 2147483648, 0, 4294967295),
							false,
						);
					}; break;
					case PCM_FORMAT_S32_LE: {
						view.setInt32(
							byteOffset,
							clamp(Math.round(2147483648 * value), -2147483648, 2147483647),
							true,
						);
					}; break;
					case PCM_FORMAT_S32_BE: {
						view.setInt32(
							byteOffset,
							clamp(Math.round(2147483648 * value), -2147483648, 2147483647),
							false,
						);
					}; break;
					case PCM_FORMAT_F32_LE: {
						view.setFloat32(byteOffset, value, true);
					}; break;
					case PCM_FORMAT_F32_BE: {
						view.setFloat32(byteOffset, value, false);
					}; break;
					case PCM_FORMAT_F64_LE: {
						view.setFloat64(byteOffset, value, true);
					}; break;
					case PCM_FORMAT_F64_BE: {
						view.setFloat64(byteOffset, value, false);
					}; break;
				}
			}

			this._pcmScratchFrames += frameCount;
			frame += frameCount;

			if (this._pcmScratchFrames === PCM_ENCODER_PACKET_SIZE) {
				this._emitPcmScratchPacket();
				yield;
			}
		}
	}

	/** @internal */
	_emitPcmScratchPacket() {
		const decoderConfig = this._pcmDecoderConfig;
		assert(decoderConfig);
		assert(this._pcmScratchView);

		const { numberOfChannels, sampleRate } = decoderConfig;
		const byteLength = this._pcmScratchFrames * numberOfChannels * this._pcmSampleSize;

		const packet = new EncodedPacket({
			data: new Uint8Array(this._pcmScratchView.buffer, 0, byteLength),
			type: 'key',
			timestamp: this._pcmStartTimestamp + this._pcmEmittedFrames / sampleRate,
			duration: this._pcmScratchFrames / sampleRate,
			decoderConfig: this._resolveDecoderConfig(decoderConfig),
		});
		this._pcmEmittedFrames += this._pcmScratchFrames;

		// The packet now owns the buffer
		this._pcmScratchView = null;
		this._pcmScratchFrames = 0;

		if (this._emitPacket(packet)) {
			this._config.onEncodedPacket?.(packet, { decoderConfig });
		}
	}

	/** @internal */
	_getEncoderQueueSize() {
		if (this._customEncoder) {
			return this._customEncoderQueueSize;
		} else {
			return this._encoder?.encodeQueueSize ?? 0;
		}
	}

	/** @internal */
	_releaseEncoder() {
		this._resampler = null;
		return this._closeEncoders();
	}

	/** @internal */
	_closeEncoders() {
		let closePromise = Promise.resolve();

		if (this._customEncoder) {
			const customEncoder = this._customEncoder;
			closePromise = this._customEncoderCallSerializer
				.call(() => customEncoder.close())
				.catch(() => {});
			this._customEncoder = null;
		}
		if (this._encoder) {
			if (this._encoder.state !== 'closed') {
				this._encoder.close();
			}
			this._encoder = null;
		}

		this._isPcmEncoder = false;
		this._encoderParams = null;

		return closePromise;
	}
}

const audioEncoderPrimingShiftPromises = new Map<string, Promise<number>>();

// WebCodecs audio encoders have encoder priming delay but don't surface this delay whatsoever, meaning they typically
// just emit audio at incorrect timestamps. This priming delay depends heavily on the browser-OS combo, so instead of
// hardcoding it, we simply detect it locally.
const detectAudioEncoderPrimingShift = (codec: AudioCodec, codecString: string) => {
	let promise = audioEncoderPrimingShiftPromises.get(codecString);
	if (promise) {
		return promise;
	}

	promise = (async () => {
		if (typeof AudioDecoder === 'undefined') {
			return 0;
		}

		const numberOfChannels = 1;
		const sampleRate = 48000;
		const encoderConfig: AudioEncoderConfig = {
			codec: codecString,
			numberOfChannels,
			sampleRate,
			...getAudioEncoderConfigExtension(codec),
		};
		const impulseIndex = 4096;
		const numberOfFrames = 2 * impulseIndex;
		const format = 'f32-planar';

		const chunks: EncodedAudioChunk[] = [];
		let decoderConfig = null as AudioDecoderConfig | null;
		let peakIndex = null as number | null;
		let peakValue = -Infinity;
		let minValue = Infinity;
		let decodedFrames = 0;
		let codecError = null as DOMException | null;

		const encoder = new AudioEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig) {
					decoderConfig ??= meta.decoderConfig;
				}

				chunks.push(chunk);
			},
			error: (error) => {
				codecError ??= error;
			},
		});
		const decoder = new AudioDecoder({
			output: (audioData) => {
				const values = new Float32Array(audioData.numberOfFrames);
				audioData.copyTo(values, { planeIndex: 0, format });
				audioData.close();

				for (let i = 0; i < values.length; i++) {
					if (values[i]! > peakValue) {
						peakValue = values[i]!;
						peakIndex = decodedFrames + i;
					}
					if (values[i]! < minValue) {
						minValue = values[i]!;
					}
				}

				decodedFrames += values.length;
			},
			error: (error) => {
				codecError ??= error;
			},
		});

		try {
			encoder.configure(encoderConfig);

			if (codec === 'aac' && isWebKit()) {
				encodeAacSilencePrefix(encoder, format, numberOfChannels, sampleRate, 0);
			}

			const data = new Float32Array(numberOfChannels * numberOfFrames);
			data[impulseIndex] = 1;

			const audioData = new AudioData({
				data,
				format,
				numberOfChannels,
				numberOfFrames,
				sampleRate,
				timestamp: 0,
			});
			encoder.encode(audioData);
			audioData.close();

			await encoder.flush();

			assert(decoderConfig);
			fixAudioDecoderConfig(codec, encoderConfig, decoderConfig);

			decoder.configure(decoderConfig);
			for (const chunk of chunks) {
				decoder.decode(chunk);
			}

			await decoder.flush();
		} catch (error) {
			throw codecError ?? error;
		} finally {
			if (encoder.state !== 'closed') {
				encoder.close();
			}
			if (decoder.state !== 'closed') {
				decoder.close();
			}
		}

		if (peakIndex === null || peakValue === minValue) {
			// A flat output has no peak to locate, so it's treated as the impulse coming out where it went in
			peakIndex = impulseIndex;
		}

		const firstChunkTimestampInSamples = Math.round(chunks[0]!.timestamp / 1e6 * sampleRate);
		return peakIndex - impulseIndex + firstChunkTimestampInSamples;
	})();

	audioEncoderPrimingShiftPromises.set(codecString, promise);

	// Don't remember failures because they _could_ be transient
	promise.catch(() => audioEncoderPrimingShiftPromises.delete(codecString));

	return promise;
};

/** Works around https://bugs.webkit.org/show_bug.cgi?id=328491 */
const encodeAacSilencePrefix = (
	encoder: AudioEncoder,
	format: AudioSampleFormat, // Must match the format of the actual audio data for this workaround to work
	numberOfChannels: number,
	sampleRate: number,
	timestamp: number, // In seconds, the timestamp of the first actual sample
) => {
	const numberOfFrames = 1024;
	const bytesPerSample = getBytesPerSample(format);
	const data = new Uint8Array(bytesPerSample * numberOfFrames * numberOfChannels);
	if (format === 'u8' || format === 'u8-planar') {
		data.fill(2 ** 7); // Fill it with the silent value
	}

	const audioData = new AudioData({
		data,
		format,
		numberOfChannels,
		numberOfFrames,
		sampleRate,
		timestamp: Math.round(1e6 * (timestamp - numberOfFrames / sampleRate)),
	});
	encoder.encode(audioData);
	audioData.close();
};

const fixAudioDecoderConfig = (
	codec: AudioCodec,
	encoderConfig: AudioEncoderConfig,
	decoderConfig: AudioDecoderConfig,
) => {
	// WebKit emits an invalid description for AAC (https://bugs.webkit.org/show_bug.cgi?id=302253), which we try to
	// detect here. If detected, we'll provide our own description instead, derived from the codec string and audio
	// parameters.
	if (codec === 'aac') {
		if (
			decoderConfig.description
			&& decoderConfig.description.byteLength > 0
			&& toUint8Array(decoderConfig.description)[0] === 0x03
		) {
			// We were handed an ES descriptor instead of an AudioSpecificConfig
			const { decoderSpecificInfo } = readEsDescriptor(
				FileSlice.tempFromBytes(toUint8Array(decoderConfig.description)),
			);
			decoderConfig.description = decoderSpecificInfo ?? undefined;
		}

		let needsDescriptionOverwrite = false;
		if (!decoderConfig.description || decoderConfig.description.byteLength < 2) {
			needsDescriptionOverwrite = true;
		} else {
			const audioSpecificConfig = parseAacAudioSpecificConfig(toUint8Array(decoderConfig.description));
			needsDescriptionOverwrite = audioSpecificConfig.objectType === 0;
		}

		if (needsDescriptionOverwrite) {
			const objectType = Number(last(encoderConfig.codec.split('.')));

			decoderConfig.description = buildAacAudioSpecificConfig({
				objectType,
				outputNumberOfChannels: decoderConfig.numberOfChannels,
				outputSampleRate: decoderConfig.sampleRate,
				programConfigElement: null,
			});
		}
	}
};

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
		/** The width of the video in pixels. */
		width?: number;
		/** The height of the video in pixels. */
		height?: number;
		/** The desired quality of the encoded video. */
		quality?: Quality;
		/**
		 * The target bitrate for the encoded video, in bits per second. Alternatively, a {@link Quality} can
		 * be provided.
		 * @deprecated Use `quality` instead.
		 */
		bitrate?: number | Quality;
		/** The expected frame rate in hertz, if known. */
		frameRate?: number;
	} & VideoEncodingAdditionalOptions = {},
) => {
	const {
		width = 1280,
		height = 720,
		quality,
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		bitrate,
		frameRate,
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
	if (frameRate !== undefined && (!Number.isFinite(frameRate) || frameRate <= 0)) {
		throw new TypeError('frameRate, when provided, must be a finite positive number.');
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
			framerate: frameRate ?? restOptions.frameRateHint,
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
				const encoder = new VideoEncoder({
					output: () => {},
					error: () => resolve(false),
				});

				try {
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
				} finally {
					if (encoder.state !== 'closed') {
						encoder.close();
					}
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
		/** The number of audio channels. */
		numberOfChannels?: number;
		/** The sample rate in hertz. */
		sampleRate?: number;
		/** The desired quality of the encoded audio. */
		quality?: Quality;
		/**
		 * The target bitrate for the encoded audio, in bits per second. Alternatively, a {@link Quality} can
		 * be provided.
		 * @deprecated Use `quality` instead.
		 */
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

		return isAudioEncoderConfigSupported(codec, encoderConfig);
	})();
	canEncodeAudioMemo.set(key, promise);

	return promise;
};

const isAudioEncoderConfigSupported = async (codec: AudioCodec, encoderConfig: AudioEncoderConfig) => {
	if (codec === 'vorbis' && isFirefox()) {
		// Firefox's Vorbis encoder ignores its input and encodes silence.
		// See https://bugzilla.mozilla.org/show_bug.cgi?id=2098505
		return false;
	}

	try {
		const support = await AudioEncoder.isConfigSupported(encoderConfig);
		return support.supported === true;
	} catch {
		// Can type-error when unknown config features are used
		return false;
	}
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
		/** The width of the video in pixels. */
		width?: number;
		/** The height of the video in pixels. */
		height?: number;
		/** The desired quality of the encoded video. */
		quality?: Quality;
		/**
		 * The target bitrate for the encoded video, in bits per second. Alternatively, a {@link Quality} can
		 * be provided.
		 * @deprecated Use `quality` instead.
		 */
		bitrate?: number | Quality;
		/** The expected frame rate in hertz, if known. */
		frameRate?: number;
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
		/** The number of audio channels. */
		numberOfChannels?: number;
		/** The sample rate in hertz. */
		sampleRate?: number;
		/** The desired quality of the encoded audio. */
		quality?: Quality;
		/**
		 * The target bitrate for the encoded audio, in bits per second. Alternatively, a {@link Quality} can
		 * be provided.
		 * @deprecated Use `quality` instead.
		 */
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
		/** The width of the video in pixels. */
		width?: number;
		/** The height of the video in pixels. */
		height?: number;
		/** The desired quality of the encoded video. */
		quality?: Quality;
		/**
		 * The target bitrate for the encoded video, in bits per second. Alternatively, a {@link Quality} can
		 * be provided.
		 * @deprecated Use `quality` instead.
		 */
		bitrate?: number | Quality;
		/** The expected frame rate in hertz, if known. */
		frameRate?: number;
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
		/** The number of audio channels. */
		numberOfChannels?: number;
		/** The sample rate in hertz. */
		sampleRate?: number;
		/** The desired quality of the encoded audio. */
		quality?: Quality;
		/**
		 * The target bitrate for the encoded audio, in bits per second. Alternatively, a {@link Quality} can
		 * be provided.
		 * @deprecated Use `quality` instead.
		 */
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
