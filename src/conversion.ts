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
	NON_PCM_AUDIO_CODECS,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import {
	getEncodableAudioCodecs,
	getFirstEncodableVideoCodec,
	Quality,
	QUALITY_HIGH,
	VideoEncodingConfig,
} from './encode';
import { Input } from './input';
import { InputAudioTrack, InputTrack, InputVideoTrack } from './input-track';
import {
	AudioSampleSink,
	CanvasSink,
	EncodedPacketSink,
	VideoSampleSink,
} from './media-sink';
import {
	AudioSource,
	EncodedVideoPacketSource,
	EncodedAudioPacketSource,
	VideoSource,
	VideoSampleSource,
	AudioSampleSource,
} from './media-source';
import {
	assert,
	clamp,
	isIso639Dash2LanguageCode,
	MaybePromise,
	normalizeRotation,
	promiseWithResolvers,
	Rotation,
} from './misc';
import { Output, TrackType } from './output';
import { Mp4OutputFormat } from './output-format';
import { AudioSample, clampCropRectangle, validateCropRectangle, VideoSample } from './sample';
import { MetadataTags, validateMetadataTags } from './metadata';
import { NullTarget } from './target';

/**
 * The options for media file conversion.
 * @group Conversion
 * @public
 */
export type ConversionOptions = {
	/** The input file. */
	input: Input;
	/** The output file. */
	output: Output;

	/**
	 * Video-specific options. When passing an object, the same options are applied to all video tracks. When passing a
	 * function, it will be invoked for each video track and is expected to return or resolve to the options
	 * for that specific track. The function is passed an instance of {@link InputVideoTrack} as well as a number `n`,
	 * which is the 1-based index of the track in the list of all video tracks. Using `n` is deprecated, prefer the
	 * identical `track.number` instead.
	 */
	video?: ConversionVideoOptions
		| ((track: InputVideoTrack, n: number) => MaybePromise<ConversionVideoOptions | undefined>);

	/**
	 * Audio-specific options. When passing an object, the same options are applied to all audio tracks. When passing a
	 * function, it will be invoked for each audio track and is expected to return or resolve to the options
	 * for that specific track. The function is passed an instance of {@link InputAudioTrack} as well as a number `n`,
	 * which is the 1-based index of the track in the list of all audio tracks. Using `n` is deprecated, prefer the
	 * identical `track.number` instead.
	 */
	audio?: ConversionAudioOptions
		| ((track: InputAudioTrack, n: number) => MaybePromise<ConversionAudioOptions | undefined>);

	/** Options to trim the input file. */
	trim?: {
		/**
		 * The time in the input file in seconds at which the output file should start. Must be less than `end`.
		 * When omitted, defaults to the start timestamp of the input or to 0, whichever is higher.
		 */
		start?: number;
		/**
		 * The time in the input file in seconds at which the output file should end. Must be greater than `start`.
		 * Defaults to the duration of the input when omitted.
		 */
		end?: number;
	};

	/**
	 * An object or a callback that returns or resolves to an object containing the descriptive metadata tags that
	 * should be written to the output file. If a function is passed, it will be passed the tags of the input file as
	 * its first argument, allowing you to modify, augment or extend them.
	 *
	 * If no function is set, the input's metadata tags will be copied to the output.
	 */
	tags?: MetadataTags | ((inputTags: MetadataTags) => MaybePromise<MetadataTags>);

	/**
	 * Whether to show potential console warnings about discarded tracks after calling `Conversion.init()`, defaults to
	 * `true`. Set this to `false` if you're properly handling the `discardedTracks` and `isValid` fields already and
	 * want to keep the console output clean.
	 */
	showWarnings?: boolean;
};

/**
 * Video-specific options.
 * @group Conversion
 * @public
 */
export type ConversionVideoOptions = {
	/** If `true`, all video tracks will be discarded and will not be present in the output. */
	discard?: boolean;
	/**
	 * The desired width of the output video in pixels, defaulting to the video's natural display width. If height
	 * is not set, it will be deduced automatically based on aspect ratio.
	 */
	width?: number;
	/**
	 * The desired height of the output video in pixels, defaulting to the video's natural display height. If width
	 * is not set, it will be deduced automatically based on aspect ratio.
	 */
	height?: number;
	/**
	 * The fitting algorithm in case both width and height are set, or if the input video changes its size over time.
	 *
	 * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
	 * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
	 * letterboxing.
	 * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
	 */
	fit?: 'fill' | 'contain' | 'cover';
	/**
	 * The angle in degrees to rotate the input video by, clockwise. Rotation is applied before cropping and resizing.
	 * This rotation is _in addition to_ the natural rotation of the input video as specified in input file's metadata.
	 */
	rotate?: Rotation;
	/**
	 * Defaults to `true`. When enabaled, Mediabunny will use the rotation metadata in the output file to perform video
	 * rotation whenever possible. Set this field to `false` if you want to ensure the output file does not make use of
	 * rotation metadata and that any rotation is baked into the video frames directly.
	 */
	allowRotationMetadata?: boolean;
	/**
	 * Specifies the rectangular region of the input video to crop to. The crop region will automatically be clamped to
	 * the dimensions of the input video track. Cropping is performed after rotation but before resizing.
	 */
	crop?: {
		/** The distance in pixels from the left edge of the source frame to the left edge of the crop rectangle. */
		left: number;
		/** The distance in pixels from the top edge of the source frame to the top edge of the crop rectangle. */
		top: number;
		/** The width in pixels of the crop rectangle. */
		width: number;
		/** The height in pixels of the crop rectangle. */
		height: number;
	};
	/**
	 * The desired frame rate of the output video, in hertz. If not specified, the original input frame rate will
	 * be used (which may be variable).
	 */
	frameRate?: number;
	/** The desired output video codec. */
	codec?: VideoCodec;
	/** The desired bitrate of the output video. */
	bitrate?: number | Quality;
	/**
	 * Whether to discard or keep the transparency information of the input video. The default is `'discard'`. Note that
	 * for `'keep'` to produce a transparent video, you must use an output config that supports it, such as WebM with
	 * VP9.
	 */
	alpha?: 'discard' | 'keep';
	/**
	 * The interval, in seconds, of how often frames are encoded as a key frame. The default is 5 seconds. Frequent key
	 * frames improve seeking behavior but increase file size. When using multiple video tracks, you should give them
	 * all the same key frame interval.
	 *
	 * Setting this fields forces a transcode.
	 */
	keyFrameInterval?: number;
	/**
	 * A hint that configures the hardware acceleration method used when transcoding. This is best left on
	 * `'no-preference'`, the default.
	 */
	hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
	/** When `true`, video will always be re-encoded instead of directly copying over the encoded samples. */
	forceTranscode?: boolean;
	/**
	 * Allows for custom user-defined processing of video frames, e.g. for applying overlays, color transformations, or
	 * timestamp modifications. Will be called for each input video sample after transformations and frame rate
	 * corrections.
	 *
	 * Must return a {@link VideoSample} or a `CanvasImageSource`, an array of them, or `null` for dropping the frame.
	 * When non-timestamped data is returned, the timestamp and duration from the source sample will be used. Rotation
	 * metadata of the returned sample will be ignored.
	 *
	 * This function can also be used to manually resize frames. When doing so, you should signal the post-process
	 * dimensions using the `processedWidth` and `processedHeight` fields, which enables the encoder to better know what
	 * to expect. If these fields aren't set, Mediabunny will assume you won't perform any resizing.
	 */
	process?: (sample: VideoSample) => MaybePromise<
		CanvasImageSource | VideoSample | (CanvasImageSource | VideoSample)[] | null
	>;
	/**
	 * An optional hint specifying the width of video samples returned by the `process` function, for better
	 * encoder configuration.
	 */
	processedWidth?: number;
	/**
	 * An optional hint specifying the height of video samples returned by the `process` function, for better
	 * encoder configuration.
	 */
	processedHeight?: number;
};

/**
 * Audio-specific options.
 * @group Conversion
 * @public
 */
export type ConversionAudioOptions = {
	/** If `true`, all audio tracks will be discarded and will not be present in the output. */
	discard?: boolean;
	/** The desired channel count of the output audio. */
	numberOfChannels?: number;
	/** The desired sample rate of the output audio, in hertz. */
	sampleRate?: number;
	/** The desired output audio codec. */
	codec?: AudioCodec;
	/** The desired bitrate of the output audio. */
	bitrate?: number | Quality;
	/** When `true`, audio will always be re-encoded instead of directly copying over the encoded samples. */
	forceTranscode?: boolean;
	/**
	 * Allows for custom user-defined processing of audio samples, e.g. for applying audio effects, transformations, or
	 * timestamp modifications. Will be called for each input audio sample after remixing and resampling.
	 *
	 * Must return an {@link AudioSample}, an array of them, or `null` for dropping the sample.
	 *
	 * This function can also be used to manually perform remixing or resampling. When doing so, you should signal the
	 * post-process parameters using the `processedNumberOfChannels` and `processedSampleRate` fields, which enables the
	 * encoder to better know what to expect. If these fields aren't set, Mediabunny will assume you won't perform
	 * remixing or resampling.
	 */
	process?: (sample: AudioSample) => MaybePromise<
		AudioSample | AudioSample[] | null
	>;
	/**
	 * An optional hint specifying the channel count of audio samples returned by the `process` function, for better
	 * encoder configuration.
	 */
	processedNumberOfChannels?: number;
	/**
	 * An optional hint specifying the sample rate of audio samples returned by the `process` function, for better
	 * encoder configuration.
	 */
	processedSampleRate?: number;
};

const validateVideoOptions = (videoOptions: ConversionVideoOptions | undefined) => {
	if (videoOptions !== undefined && (!videoOptions || typeof videoOptions !== 'object')) {
		throw new TypeError('options.video, when provided, must be an object.');
	}
	if (videoOptions?.discard !== undefined && typeof videoOptions.discard !== 'boolean') {
		throw new TypeError('options.video.discard, when provided, must be a boolean.');
	}
	if (videoOptions?.forceTranscode !== undefined && typeof videoOptions.forceTranscode !== 'boolean') {
		throw new TypeError('options.video.forceTranscode, when provided, must be a boolean.');
	}
	if (videoOptions?.codec !== undefined && !VIDEO_CODECS.includes(videoOptions.codec)) {
		throw new TypeError(
			`options.video.codec, when provided, must be one of: ${VIDEO_CODECS.join(', ')}.`,
		);
	}
	if (
		videoOptions?.bitrate !== undefined
		&& !(videoOptions.bitrate instanceof Quality)
		&& (!Number.isInteger(videoOptions.bitrate) || videoOptions.bitrate <= 0)
	) {
		throw new TypeError('options.video.bitrate, when provided, must be a positive integer or a quality.');
	}
	if (
		videoOptions?.width !== undefined
		&& (!Number.isInteger(videoOptions.width) || videoOptions.width <= 0)
	) {
		throw new TypeError('options.video.width, when provided, must be a positive integer.');
	}
	if (
		videoOptions?.height !== undefined
		&& (!Number.isInteger(videoOptions.height) || videoOptions.height <= 0)
	) {
		throw new TypeError('options.video.height, when provided, must be a positive integer.');
	}
	if (videoOptions?.fit !== undefined && !['fill', 'contain', 'cover'].includes(videoOptions.fit)) {
		throw new TypeError('options.video.fit, when provided, must be one of \'fill\', \'contain\', or \'cover\'.');
	}
	if (
		videoOptions?.width !== undefined
		&& videoOptions.height !== undefined
		&& videoOptions.fit === undefined
	) {
		throw new TypeError(
			'When both options.video.width and options.video.height are provided, options.video.fit must also be'
			+ ' provided.',
		);
	}
	if (videoOptions?.rotate !== undefined && ![0, 90, 180, 270].includes(videoOptions.rotate)) {
		throw new TypeError('options.video.rotate, when provided, must be 0, 90, 180 or 270.');
	}
	if (videoOptions?.allowRotationMetadata !== undefined && typeof videoOptions.allowRotationMetadata !== 'boolean') {
		throw new TypeError('options.video.allowRotationMetadata, when provided, must be a boolean.');
	}
	if (videoOptions?.crop !== undefined) {
		validateCropRectangle(videoOptions.crop, 'options.video.');
	}
	if (
		videoOptions?.frameRate !== undefined
		&& (!Number.isFinite(videoOptions.frameRate) || videoOptions.frameRate <= 0)
	) {
		throw new TypeError('options.video.frameRate, when provided, must be a finite positive number.');
	}
	if (videoOptions?.alpha !== undefined && !['discard', 'keep'].includes(videoOptions.alpha)) {
		throw new TypeError('options.video.alpha, when provided, must be either \'discard\' or \'keep\'.');
	}
	if (
		videoOptions?.keyFrameInterval !== undefined
		&& (!Number.isFinite(videoOptions.keyFrameInterval) || videoOptions.keyFrameInterval < 0)
	) {
		throw new TypeError('options.video.keyFrameInterval, when provided, must be a non-negative number.');
	}
	if (videoOptions?.process !== undefined && typeof videoOptions.process !== 'function') {
		throw new TypeError('options.video.process, when provided, must be a function.');
	}
	if (
		videoOptions?.processedWidth !== undefined
		&& (!Number.isInteger(videoOptions.processedWidth) || videoOptions.processedWidth <= 0)
	) {
		throw new TypeError('options.video.processedWidth, when provided, must be a positive integer.');
	}
	if (
		videoOptions?.processedHeight !== undefined
		&& (!Number.isInteger(videoOptions.processedHeight) || videoOptions.processedHeight <= 0)
	) {
		throw new TypeError('options.video.processedHeight, when provided, must be a positive integer.');
	}
	if (
		videoOptions?.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(videoOptions.hardwareAcceleration)
	) {
		throw new TypeError(
			'options.video.hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
			+ ' \'prefer-software\'.',
		);
	}
};

const validateAudioOptions = (audioOptions: ConversionAudioOptions | undefined) => {
	if (audioOptions !== undefined && (!audioOptions || typeof audioOptions !== 'object')) {
		throw new TypeError('options.audio, when provided, must be an object.');
	}
	if (audioOptions?.discard !== undefined && typeof audioOptions.discard !== 'boolean') {
		throw new TypeError('options.audio.discard, when provided, must be a boolean.');
	}
	if (audioOptions?.forceTranscode !== undefined && typeof audioOptions.forceTranscode !== 'boolean') {
		throw new TypeError('options.audio.forceTranscode, when provided, must be a boolean.');
	}
	if (audioOptions?.codec !== undefined && !AUDIO_CODECS.includes(audioOptions.codec)) {
		throw new TypeError(
			`options.audio.codec, when provided, must be one of: ${AUDIO_CODECS.join(', ')}.`,
		);
	}
	if (
		audioOptions?.bitrate !== undefined
		&& !(audioOptions.bitrate instanceof Quality)
		&& (!Number.isInteger(audioOptions.bitrate) || audioOptions.bitrate <= 0)
	) {
		throw new TypeError('options.audio.bitrate, when provided, must be a positive integer or a quality.');
	}
	if (
		audioOptions?.numberOfChannels !== undefined
		&& (!Number.isInteger(audioOptions.numberOfChannels) || audioOptions.numberOfChannels <= 0)
	) {
		throw new TypeError('options.audio.numberOfChannels, when provided, must be a positive integer.');
	}
	if (
		audioOptions?.sampleRate !== undefined
		&& (!Number.isInteger(audioOptions.sampleRate) || audioOptions.sampleRate <= 0)
	) {
		throw new TypeError('options.audio.sampleRate, when provided, must be a positive integer.');
	}
	if (audioOptions?.process !== undefined && typeof audioOptions.process !== 'function') {
		throw new TypeError('options.audio.process, when provided, must be a function.');
	}
	if (
		audioOptions?.processedNumberOfChannels !== undefined
		&& (!Number.isInteger(audioOptions.processedNumberOfChannels) || audioOptions.processedNumberOfChannels <= 0)
	) {
		throw new TypeError('options.audio.processedNumberOfChannels, when provided, must be a positive integer.');
	}
	if (
		audioOptions?.processedSampleRate !== undefined
		&& (!Number.isInteger(audioOptions.processedSampleRate) || audioOptions.processedSampleRate <= 0)
	) {
		throw new TypeError('options.audio.processedSampleRate, when provided, must be a positive integer.');
	}
};

const FALLBACK_NUMBER_OF_CHANNELS = 2;
const FALLBACK_SAMPLE_RATE = 48000;

/**
 * An input track that was discarded (excluded) from a {@link Conversion} alongside the discard reason.
 * @group Conversion
 * @public
 */
export type DiscardedTrack = {
	/** The track that was discarded. */
	track: InputTrack;
	/**
	 * The reason for discarding the track.
	 *
	 * - `'discarded_by_user'`: You discarded this track by setting `discard: true`.
	 * - `'max_track_count_reached'`: The output had no more room for another track.
	 * - `'max_track_count_of_type_reached'`: The output had no more room for another track of this type, or the output
	 * doesn't support this track type at all.
	 * - `'unknown_source_codec'`: We don't know the codec of the input track and therefore don't know what to do
	 * with it.
	 * - `'undecodable_source_codec'`: The input track's codec is known, but we are unable to decode it.
	 * - `'no_encodable_target_codec'`: We can't find a codec that we are able to encode and that can be contained
	 * within the output format. This reason can be hit if the environment doesn't support the necessary encoders, or if
	 * you requested a codec that cannot be contained within the output format.
	 */
	reason:
		| 'discarded_by_user'
		| 'max_track_count_reached'
		| 'max_track_count_of_type_reached'
		| 'unknown_source_codec'
		| 'undecodable_source_codec'
		| 'no_encodable_target_codec';
};

/**
 * Represents a media file conversion process, used to convert one media file into another. In addition to conversion,
 * this class can be used to resize and rotate video, resample audio, drop tracks, or trim to a specific time range.
 * @group Conversion
 * @public
 */
export class Conversion {
	/** The input file. */
	readonly input: Input;
	/** The output file. */
	readonly output: Output;

	/** @internal */
	_options: ConversionOptions;
	/** @internal */
	_startTimestamp!: number;
	/** @internal */
	_endTimestamp!: number;

	/** @internal */
	_addedCounts: Record<TrackType, number> = {
		video: 0,
		audio: 0,
		subtitle: 0,
	};

	/** @internal */
	_totalTrackCount = 0;

	/** @internal */
	_trackPromises: Promise<void>[] = [];

	/** @internal */
	_started: Promise<void>;
	/** @internal */
	_start: () => void;
	/** @internal */
	_executed = false;

	/** @internal */
	_synchronizer = new TrackSynchronizer();

	/** @internal */
	_totalDuration: number | null = null;
	/** @internal */
	_maxTimestamps = new Map<number, number>(); // Track ID -> timestamp

	/** @internal */
	_canceled = false;

	/**
	 * A callback that is fired whenever the conversion progresses. Returns a number between 0 and 1, indicating the
	 * completion of the conversion. Note that a progress of 1 doesn't necessarily mean the conversion is complete;
	 * the conversion is complete once `execute()` resolves.
	 *
	 * In order for progress to be computed, this property must be set before `execute` is called.
	 */
	onProgress?: (progress: number) => unknown = undefined;
	/** @internal */
	_computeProgress = false;
	/** @internal */
	_lastProgress = 0;

	/**
	 * Whether this conversion, as it has been configured, is valid and can be executed. If this field is `false`, check
	 * the `discardedTracks` field for reasons.
	 */
	isValid = false;
	/** The list of tracks that are included in the output file. */
	readonly utilizedTracks: InputTrack[] = [];
	/** The list of tracks from the input file that have been discarded, alongside the discard reason. */
	readonly discardedTracks: DiscardedTrack[] = [];

	/** Initializes a new conversion process without starting the conversion. */
	static async init(options: ConversionOptions) {
		const conversion = new Conversion(options);
		await conversion._init();

		return conversion;
	}

	/** Creates a new Conversion instance (duh). */
	private constructor(options: ConversionOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!(options.input instanceof Input)) {
			throw new TypeError('options.input must be an Input.');
		}
		if (!(options.output instanceof Output)) {
			throw new TypeError('options.output must be an Output.');
		}
		if (
			options.output._tracks.length > 0
			|| Object.keys(options.output._metadataTags).length > 0
			|| options.output.state !== 'pending'
		) {
			throw new TypeError('options.output must be fresh: no tracks or metadata tags added and not started.');
		}

		if (typeof options.video !== 'function') {
			validateVideoOptions(options.video);
		} else {
			// We'll validate the return value later
		}

		if (typeof options.audio !== 'function') {
			validateAudioOptions(options.audio);
		} else {
			// We'll validate the return value later
		}

		if (options.trim !== undefined && (!options.trim || typeof options.trim !== 'object')) {
			throw new TypeError('options.trim, when provided, must be an object.');
		}
		if (options.trim?.start !== undefined && (!Number.isFinite(options.trim.start))) {
			throw new TypeError('options.trim.start, when provided, must be a finite number.');
		}
		if (options.trim?.end !== undefined && (!Number.isFinite(options.trim.end))) {
			throw new TypeError('options.trim.end, when provided, must be a finite number.');
		}
		if (
			options.trim?.start !== undefined
			&& options.trim.end !== undefined
			&& options.trim.start >= options.trim.end) {
			throw new TypeError('options.trim.start must be less than options.trim.end.');
		}
		if (
			options.tags !== undefined
			&& (typeof options.tags !== 'object' || !options.tags)
			&& typeof options.tags !== 'function'
		) {
			throw new TypeError('options.tags, when provided, must be an object or a function.');
		}
		if (typeof options.tags === 'object') {
			validateMetadataTags(options.tags);
		}
		if (options.showWarnings !== undefined && typeof options.showWarnings !== 'boolean') {
			throw new TypeError('options.showWarnings, when provided, must be a boolean.');
		}

		this._options = options;
		this.input = options.input;
		this.output = options.output;

		const { promise: started, resolve: start } = promiseWithResolvers();
		this._started = started;
		this._start = start;
	}

	/** @internal */
	async _init() {
		this._startTimestamp = this._options.trim?.start ?? Math.max(
			await this.input.getFirstTimestamp(),
			// Samples can also have negative timestamps, but the meaning typically is "don't present me", so let's cut
			// those out by default.
			0,
		);
		this._endTimestamp = Math.max(this._options.trim?.end ?? Infinity, this._startTimestamp);

		const inputTracks = await this.input.getTracks();
		const outputTrackCounts = this.output.format.getSupportedTrackCounts();

		let nVideo = 1;
		let nAudio = 1;

		for (const track of inputTracks) {
			let trackOptions: ConversionVideoOptions | ConversionAudioOptions | undefined = undefined;
			if (track.isVideoTrack()) {
				if (this._options.video) {
					if (typeof this._options.video === 'function') {
						trackOptions = await this._options.video(track, nVideo);
						validateVideoOptions(trackOptions);
						nVideo++;
					} else {
						trackOptions = this._options.video;
					}
				}
			} else if (track.isAudioTrack()) {
				if (this._options.audio) {
					if (typeof this._options.audio === 'function') {
						trackOptions = await this._options.audio(track, nAudio);
						validateAudioOptions(trackOptions);
						nAudio++;
					} else {
						trackOptions = this._options.audio;
					}
				}
			} else {
				assert(false);
			}

			if (trackOptions?.discard) {
				this.discardedTracks.push({
					track,
					reason: 'discarded_by_user',
				});
				continue;
			}

			if (this._totalTrackCount === outputTrackCounts.total.max) {
				this.discardedTracks.push({
					track,
					reason: 'max_track_count_reached',
				});
				continue;
			}

			if (this._addedCounts[track.type] === outputTrackCounts[track.type].max) {
				this.discardedTracks.push({
					track,
					reason: 'max_track_count_of_type_reached',
				});
				continue;
			}

			if (track.isVideoTrack()) {
				await this._processVideoTrack(track, (trackOptions ?? {}) as ConversionVideoOptions);
			} else if (track.isAudioTrack()) {
				await this._processAudioTrack(track, (trackOptions ?? {}) as ConversionAudioOptions);
			}
		}

		// Now, let's deal with metadata tags

		const inputTags = await this.input.getMetadataTags();
		let outputTags: MetadataTags;

		if (this._options.tags) {
			const result = typeof this._options.tags === 'function'
				? await this._options.tags(inputTags)
				: this._options.tags;
			validateMetadataTags(result);

			outputTags = result;
		} else {
			outputTags = inputTags;
		}

		// Somewhat dirty but pragmatic
		const inputAndOutputFormatMatch = (await this.input.getFormat()).mimeType === this.output.format.mimeType;
		const rawTagsAreUnchanged = inputTags.raw === outputTags.raw;

		if (inputTags.raw && rawTagsAreUnchanged && !inputAndOutputFormatMatch) {
			// If the input and output formats aren't the same, copying over raw metadata tags makes no sense and only
			// results in junk tags, so let's cut them out.
			delete outputTags.raw;
		}

		this.output.setMetadataTags(outputTags);

		// Let's check if the conversion can actually be executed
		this.isValid = this._totalTrackCount >= outputTrackCounts.total.min
			&& this._addedCounts.video >= outputTrackCounts.video.min
			&& this._addedCounts.audio >= outputTrackCounts.audio.min
			&& this._addedCounts.subtitle >= outputTrackCounts.subtitle.min;

		if (this._options.showWarnings ?? true) {
			const warnElements: unknown[] = [];

			const unintentionallyDiscardedTracks = this.discardedTracks.filter(x => x.reason !== 'discarded_by_user');
			if (unintentionallyDiscardedTracks.length > 0) {
				// Let's give the user a notice/warning about discarded tracks so they aren't confused
				warnElements.push(
					'Some tracks had to be discarded from the conversion:', unintentionallyDiscardedTracks,
				);
			}

			if (!this.isValid) {
				warnElements.push('\n\n' + this._getInvalidityExplanation().join(''));
			}

			if (warnElements.length > 0) {
				console.warn(...warnElements);
			}
		}
	}

	/** @internal */
	_getInvalidityExplanation() {
		const elements: string[] = [];

		if (this.discardedTracks.length === 0) {
			elements.push(
				'Due to missing tracks, this conversion cannot be executed.',
			);
		} else {
			const encodabilityIsTheProblem = this.discardedTracks.every(x =>
				x.reason === 'discarded_by_user' || x.reason === 'no_encodable_target_codec',
			);

			elements.push(
				'Due to discarded tracks, this conversion cannot be executed.',
			);

			if (encodabilityIsTheProblem) {
				const codecs = this.discardedTracks.flatMap((x) => {
					if (x.reason === 'discarded_by_user') return [];

					if (x.track.type === 'video') {
						return this.output.format.getSupportedVideoCodecs();
					} else if (x.track.type === 'audio') {
						return this.output.format.getSupportedAudioCodecs();
					} else {
						return this.output.format.getSupportedSubtitleCodecs();
					}
				});

				if (codecs.length === 1) {
					elements.push(
						`\nTracks were discarded because your environment is not able to encode '${codecs[0]}'.`,
					);
				} else {
					elements.push(
						'\nTracks were discarded because your environment is not able to encode any of the following'
						+ ` codecs: ${codecs.map(x => `'${x}'`).join(', ')}.`,
					);
				}

				if (codecs.includes('mp3')) {
					elements.push(
						`\nThe @mediabunny/mp3-encoder extension package provides support for encoding MP3.`,
					);
				}

				if (codecs.includes('ac3') || codecs.includes('eac3')) {
					elements.push(
						'\nThe @mediabunny/ac3 extension package provides support'
						+ ' for encoding and decoding AC-3/E-AC-3.',
					);
				}
			} else {
				elements.push('\nCheck the discardedTracks field for more info.');
			}
		}

		return elements;
	}

	/**
	 * Executes the conversion process. Resolves once conversion is complete.
	 *
	 * Will throw if `isValid` is `false`.
	 */
	async execute() {
		if (!this.isValid) {
			throw new Error(
				'Cannot execute this conversion because its output configuration is invalid. Make sure to always check'
				+ ' the isValid field before executing a conversion.\n'
				+ this._getInvalidityExplanation().join(''),
			);
		}

		if (this._executed) {
			throw new Error('Conversion cannot be executed twice.');
		}
		this._executed = true;

		if (this.onProgress) {
			// Compute duration using only the utilized tracks
			const durationPromises = this.utilizedTracks.map(x => x.computeDuration());
			const duration = Math.max(0, ...await Promise.all(durationPromises));

			this._computeProgress = true;
			this._totalDuration = Math.min(
				duration - this._startTimestamp,
				this._endTimestamp - this._startTimestamp,
			);

			for (const track of this.utilizedTracks) {
				this._maxTimestamps.set(track.id, 0);
			}

			this.onProgress?.(0);
		}

		await this.output.start();
		this._start();

		try {
			await Promise.all(this._trackPromises);
		} catch (error) {
			if (!this._canceled) {
				// Make sure to cancel to stop other encoding processes and clean up resources
				void this.cancel();
			}

			throw error;
		}

		if (this._canceled) {
			throw new ConversionCanceledError();
		}

		await this.output.finalize();

		if (this._computeProgress) {
			this.onProgress?.(1);
		}
	}

	/**
	 * Cancels the conversion process, causing any ongoing `execute` call to throw a `ConversionCanceledError`.
	 * Does nothing if the conversion is already complete.
	 */
	async cancel() {
		if (this.output.state === 'finalizing' || this.output.state === 'finalized') {
			return;
		}

		if (this._canceled) {
			console.warn('Conversion already canceled.');
			return;
		}

		this._canceled = true;
		await this.output.cancel();
	}

	/** @internal */
	async _processVideoTrack(track: InputVideoTrack, trackOptions: ConversionVideoOptions) {
		const sourceCodec = track.codec;
		if (!sourceCodec) {
			this.discardedTracks.push({
				track,
				reason: 'unknown_source_codec',
			});
			return;
		}

		let videoSource: VideoSource;

		const totalRotation = normalizeRotation(track.rotation + (trackOptions.rotate ?? 0));
		const canUseRotationMetadata = this.output.format.supportsVideoRotationMetadata
			&& (trackOptions.allowRotationMetadata ?? true);

		const [rotatedWidth, rotatedHeight] = totalRotation % 180 === 0
			? [track.codedWidth, track.codedHeight]
			: [track.codedHeight, track.codedWidth];

		const crop = trackOptions.crop;
		if (crop) {
			clampCropRectangle(crop, rotatedWidth, rotatedHeight);
		}

		const [originalWidth, originalHeight] = crop
			? [crop.width, crop.height]
			: [rotatedWidth, rotatedHeight];

		let width = originalWidth;
		let height = originalHeight;
		const aspectRatio = width / height;

		// A lot of video encoders require that the dimensions be multiples of 2
		const ceilToMultipleOfTwo = (value: number) => Math.ceil(value / 2) * 2;

		if (trackOptions.width !== undefined && trackOptions.height === undefined) {
			width = ceilToMultipleOfTwo(trackOptions.width);
			height = ceilToMultipleOfTwo(Math.round(width / aspectRatio));
		} else if (trackOptions.width === undefined && trackOptions.height !== undefined) {
			height = ceilToMultipleOfTwo(trackOptions.height);
			width = ceilToMultipleOfTwo(Math.round(height * aspectRatio));
		} else if (trackOptions.width !== undefined && trackOptions.height !== undefined) {
			width = ceilToMultipleOfTwo(trackOptions.width);
			height = ceilToMultipleOfTwo(trackOptions.height);
		}

		const firstTimestamp = await track.getFirstTimestamp();
		const needsTranscode = !!trackOptions.forceTranscode
			|| firstTimestamp < this._startTimestamp
			|| !!trackOptions.frameRate
			|| trackOptions.keyFrameInterval !== undefined
			|| trackOptions.process !== undefined;
		let needsRerender = width !== originalWidth
			|| height !== originalHeight
			// TODO This is suboptimal: Forcing a rerender when both rotation and process are set is not
			// performance-optimal, but right now there's no other way because we can't change the track rotation
			// metadata after the output has already started. Should be possible with API changes in v2, though!
			|| (totalRotation !== 0 && (!canUseRotationMetadata || trackOptions.process !== undefined))
			|| !!crop;

		const alpha = trackOptions.alpha ?? 'discard';

		let videoCodecs = this.output.format.getSupportedVideoCodecs();
		if (
			!needsTranscode
			&& !trackOptions.bitrate
			&& !needsRerender
			&& videoCodecs.includes(sourceCodec)
			&& (!trackOptions.codec || trackOptions.codec === sourceCodec)
		) {
			// Fast path, we can simply copy over the encoded packets

			const source = new EncodedVideoPacketSource(sourceCodec);
			videoSource = source;

			this._trackPromises.push((async () => {
				await this._started;

				const sink = new EncodedPacketSink(track);
				const decoderConfig = await track.getDecoderConfig();
				const meta: EncodedVideoChunkMetadata = { decoderConfig: decoderConfig ?? undefined };
				const endPacket = Number.isFinite(this._endTimestamp)
					? await sink.getPacket(this._endTimestamp, { metadataOnly: true }) ?? undefined
					: undefined;

				for await (const packet of sink.packets(undefined, endPacket, { verifyKeyPackets: true })) {
					if (this._canceled) {
						return;
					}

					const modifiedPacket = packet.clone({
						timestamp: packet.timestamp - this._startTimestamp,
						sideData: alpha === 'discard'
							? {} // Remove alpha side data
							: packet.sideData,
					});
					assert(modifiedPacket.timestamp >= 0);

					this._reportProgress(track.id, modifiedPacket.timestamp);
					await source.add(modifiedPacket, meta);

					if (this._synchronizer.shouldWait(track.id, modifiedPacket.timestamp)) {
						await this._synchronizer.wait(modifiedPacket.timestamp);
					}
				}

				source.close();
				this._synchronizer.closeTrack(track.id);
			})());
		} else {
			// We need to decode & reencode the video

			const canDecode = await track.canDecode();
			if (!canDecode) {
				this.discardedTracks.push({
					track,
					reason: 'undecodable_source_codec',
				});
				return;
			}

			if (trackOptions.codec) {
				videoCodecs = videoCodecs.filter(codec => codec === trackOptions.codec);
			}

			const bitrate = trackOptions.bitrate ?? QUALITY_HIGH;

			const encodableCodec = await getFirstEncodableVideoCodec(videoCodecs, {
				width: trackOptions.process && trackOptions.processedWidth
					? trackOptions.processedWidth
					: width,
				height: trackOptions.process && trackOptions.processedHeight
					? trackOptions.processedHeight
					: height,
				bitrate,
			});
			if (!encodableCodec) {
				this.discardedTracks.push({
					track,
					reason: 'no_encodable_target_codec',
				});
				return;
			}

			const encodingConfig: VideoEncodingConfig = {
				codec: encodableCodec,
				bitrate,
				keyFrameInterval: trackOptions.keyFrameInterval,
				sizeChangeBehavior: trackOptions.fit ?? 'passThrough',
				alpha,
				hardwareAcceleration: trackOptions.hardwareAcceleration,
			};

			const source = new VideoSampleSource(encodingConfig);
			videoSource = source;

			if (!needsRerender) {
				// If we're directly passing decoded samples back to the encoder, sometimes the encoder may error due
				// to lack of support of certain video frame formats, like when HDR is at play. To check for this, we
				// first try to pass a single frame to the encoder to see how it behaves. If it throws, we then fall
				// back to the rerender path.
				//
				// Creating a new temporary Output is sort of hacky, but due to a lack of an isolated encoder API right
				// now, this is the simplest way. Will refactor in the future! TODO

				const tempOutput = new Output({
					format: new Mp4OutputFormat(), // Supports all video codecs
					target: new NullTarget(),
				});

				const tempSource = new VideoSampleSource(encodingConfig);
				tempOutput.addVideoTrack(tempSource);

				await tempOutput.start();

				const sink = new VideoSampleSink(track);
				const firstSample = await sink.getSample(firstTimestamp); // Let's just use the first sample

				if (firstSample) {
					try {
						await tempSource.add(firstSample);
						firstSample.close();
						await tempOutput.finalize();
					} catch (error) {
						console.info('Error when probing encoder support. Falling back to rerender path.', error);
						needsRerender = true;
						void tempOutput.cancel();
					}
				} else {
					await tempOutput.cancel();
				}
			}

			if (needsRerender) {
				this._trackPromises.push((async () => {
					await this._started;

					const sink = new CanvasSink(track, {
						width,
						height,
						fit: trackOptions.fit ?? 'fill',
						rotation: totalRotation, // Bake the rotation into the output
						crop: trackOptions.crop,
						poolSize: 1,
						alpha: alpha === 'keep',
					});
					const iterator = sink.canvases(this._startTimestamp, this._endTimestamp);
					const frameRate = trackOptions.frameRate;

					let lastCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
					let lastCanvasTimestamp: number | null = null;
					let lastCanvasEndTimestamp: number | null = null;

					/** Repeats the last sample to pad out the time until the specified timestamp. */
					const padFrames = async (until: number) => {
						assert(lastCanvas);
						assert(frameRate !== undefined);

						const frameDifference = Math.round((until - lastCanvasTimestamp!) * frameRate);

						for (let i = 1; i < frameDifference; i++) {
							const sample = new VideoSample(lastCanvas, {
								timestamp: lastCanvasTimestamp! + i / frameRate,
								duration: 1 / frameRate,
							});
							await this._registerVideoSample(track, trackOptions, source, sample);
							sample.close();
						}
					};

					for await (const { canvas, timestamp, duration } of iterator) {
						if (this._canceled) {
							return;
						}

						let adjustedSampleTimestamp = Math.max(timestamp - this._startTimestamp, 0);
						lastCanvasEndTimestamp = adjustedSampleTimestamp + duration;

						if (frameRate !== undefined) {
							// Logic for skipping/repeating frames when a frame rate is set
							const alignedTimestamp = Math.floor(adjustedSampleTimestamp * frameRate) / frameRate;

							if (lastCanvas !== null) {
								if (alignedTimestamp <= lastCanvasTimestamp!) {
									lastCanvas = canvas;
									lastCanvasTimestamp = alignedTimestamp;

									// Skip this sample, since we already added one for this frame
									continue;
								} else {
									// Check if we may need to repeat the previous frame
									await padFrames(alignedTimestamp);
								}
							}

							adjustedSampleTimestamp = alignedTimestamp;
						}

						const sample = new VideoSample(canvas, {
							timestamp: adjustedSampleTimestamp,
							duration: frameRate !== undefined ? 1 / frameRate : duration,
						});
						await this._registerVideoSample(track, trackOptions, source, sample);
						sample.close();

						if (frameRate !== undefined) {
							lastCanvas = canvas;
							lastCanvasTimestamp = adjustedSampleTimestamp;
						}
					}

					if (lastCanvas) {
						assert(lastCanvasEndTimestamp !== null);
						assert(frameRate !== undefined);

						// If necessary, pad until the end timestamp of the last sample
						await padFrames(Math.floor(lastCanvasEndTimestamp * frameRate) / frameRate);
					}

					source.close();
					this._synchronizer.closeTrack(track.id);
				})());
			} else {
				this._trackPromises.push((async () => {
					await this._started;

					const sink = new VideoSampleSink(track);
					const frameRate = trackOptions.frameRate;

					let lastSample: VideoSample | null = null;
					let lastSampleTimestamp: number | null = null;
					let lastSampleEndTimestamp: number | null = null;

					/** Repeats the last sample to pad out the time until the specified timestamp. */
					const padFrames = async (until: number) => {
						assert(lastSample);
						assert(frameRate !== undefined);

						const frameDifference = Math.round((until - lastSampleTimestamp!) * frameRate);

						for (let i = 1; i < frameDifference; i++) {
							lastSample.setTimestamp(lastSampleTimestamp! + i / frameRate);
							lastSample.setDuration(1 / frameRate);
							await this._registerVideoSample(track, trackOptions, source, lastSample);
						}

						lastSample.close();
					};

					for await (const sample of sink.samples(this._startTimestamp, this._endTimestamp)) {
						if (this._canceled) {
							sample.close();
							lastSample?.close();
							return;
						}

						let adjustedSampleTimestamp = Math.max(sample.timestamp - this._startTimestamp, 0);
						lastSampleEndTimestamp = adjustedSampleTimestamp + sample.duration;

						if (frameRate !== undefined) {
							// Logic for skipping/repeating frames when a frame rate is set
							const alignedTimestamp = Math.floor(adjustedSampleTimestamp * frameRate) / frameRate;

							if (lastSample !== null) {
								if (alignedTimestamp <= lastSampleTimestamp!) {
									lastSample.close();
									lastSample = sample;
									lastSampleTimestamp = alignedTimestamp;

									// Skip this sample, since we already added one for this frame
									continue;
								} else {
									// Check if we may need to repeat the previous frame
									await padFrames(alignedTimestamp);
								}
							}

							adjustedSampleTimestamp = alignedTimestamp;
							sample.setDuration(1 / frameRate);
						}

						sample.setTimestamp(adjustedSampleTimestamp);
						await this._registerVideoSample(track, trackOptions, source, sample);

						if (frameRate !== undefined) {
							lastSample = sample;
							lastSampleTimestamp = adjustedSampleTimestamp;
						} else {
							sample.close();
						}
					}

					if (lastSample) {
						assert(lastSampleEndTimestamp !== null);
						assert(frameRate !== undefined);

						// If necessary, pad until the end timestamp of the last sample
						await padFrames(Math.floor(lastSampleEndTimestamp * frameRate) / frameRate);
					}

					source.close();
					this._synchronizer.closeTrack(track.id);
				})());
			}
		}

		this.output.addVideoTrack(videoSource, {
			frameRate: trackOptions.frameRate,
			// TODO: This condition can be removed when all demuxers properly homogenize to BCP47 in v2
			languageCode: isIso639Dash2LanguageCode(track.languageCode) ? track.languageCode : undefined,
			name: track.name ?? undefined,
			disposition: track.disposition,
			rotation: needsRerender ? 0 : totalRotation, // Rerendering will bake the rotation into the output
		});
		this._addedCounts.video++;
		this._totalTrackCount++;

		this.utilizedTracks.push(track);
	}

	/** @internal */
	async _registerVideoSample(
		track: InputVideoTrack,
		trackOptions: ConversionVideoOptions,
		source: VideoSampleSource,
		sample: VideoSample,
	) {
		if (this._canceled) {
			return;
		}

		this._reportProgress(track.id, sample.timestamp);

		let finalSamples: VideoSample[];
		if (!trackOptions.process) {
			finalSamples = [sample];
		} else {
			let processed = trackOptions.process(sample);
			if (processed instanceof Promise) processed = await processed;

			if (!Array.isArray(processed)) {
				processed = processed === null ? [] : [processed];
			}

			finalSamples = processed.map((x) => {
				if (x instanceof VideoSample) {
					return x;
				}

				if (typeof VideoFrame !== 'undefined' && x instanceof VideoFrame) {
					return new VideoSample(x);
				}

				// Calling the VideoSample constructor here will automatically handle input validation for us
				// (it throws for any non-legal argument).
				return new VideoSample(x, {
					timestamp: sample.timestamp,
					duration: sample.duration,
				});
			});
		}

		for (const finalSample of finalSamples) {
			if (this._canceled) {
				break;
			}

			await source.add(finalSample);

			if (this._synchronizer.shouldWait(track.id, finalSample.timestamp)) {
				await this._synchronizer.wait(finalSample.timestamp);
			}
		}

		for (const finalSample of finalSamples) {
			if (finalSample !== sample) {
				finalSample.close();
			}
		}
	}

	/** @internal */
	async _processAudioTrack(track: InputAudioTrack, trackOptions: ConversionAudioOptions) {
		const sourceCodec = track.codec;
		if (!sourceCodec) {
			this.discardedTracks.push({
				track,
				reason: 'unknown_source_codec',
			});
			return;
		}

		let audioSource: AudioSource;

		const originalNumberOfChannels = track.numberOfChannels;
		const originalSampleRate = track.sampleRate;

		const firstTimestamp = await track.getFirstTimestamp();

		let numberOfChannels = trackOptions.numberOfChannels ?? originalNumberOfChannels;
		let sampleRate = trackOptions.sampleRate ?? originalSampleRate;
		let needsResample = numberOfChannels !== originalNumberOfChannels
			|| sampleRate !== originalSampleRate
			|| firstTimestamp < this._startTimestamp
			|| (firstTimestamp > this._startTimestamp && !this.output.format.supportsTimestampedMediaData);

		let audioCodecs = this.output.format.getSupportedAudioCodecs();
		if (
			!trackOptions.forceTranscode
			&& !trackOptions.bitrate
			&& !needsResample
			&& audioCodecs.includes(sourceCodec)
			&& (!trackOptions.codec || trackOptions.codec === sourceCodec)
			&& !trackOptions.process
		) {
			// Fast path, we can simply copy over the encoded packets

			const source = new EncodedAudioPacketSource(sourceCodec);
			audioSource = source;

			this._trackPromises.push((async () => {
				await this._started;

				const sink = new EncodedPacketSink(track);
				const decoderConfig = await track.getDecoderConfig();
				const meta: EncodedAudioChunkMetadata = { decoderConfig: decoderConfig ?? undefined };
				const endPacket = Number.isFinite(this._endTimestamp)
					? await sink.getPacket(this._endTimestamp, { metadataOnly: true }) ?? undefined
					: undefined;

				for await (const packet of sink.packets(undefined, endPacket)) {
					if (this._canceled) {
						return;
					}

					const modifiedPacket = packet.clone({
						timestamp: packet.timestamp - this._startTimestamp,
					});
					assert(modifiedPacket.timestamp >= 0);

					this._reportProgress(track.id, modifiedPacket.timestamp);
					await source.add(modifiedPacket, meta);

					if (this._synchronizer.shouldWait(track.id, modifiedPacket.timestamp)) {
						await this._synchronizer.wait(modifiedPacket.timestamp);
					}
				}

				source.close();
				this._synchronizer.closeTrack(track.id);
			})());
		} else {
			// We need to decode & reencode the audio

			const canDecode = await track.canDecode();
			if (!canDecode) {
				this.discardedTracks.push({
					track,
					reason: 'undecodable_source_codec',
				});
				return;
			}

			let codecOfChoice: AudioCodec | null = null;

			if (trackOptions.codec) {
				audioCodecs = audioCodecs.filter(codec => codec === trackOptions.codec);
			}

			const bitrate = trackOptions.bitrate ?? QUALITY_HIGH;

			const encodableCodecs = await getEncodableAudioCodecs(audioCodecs, {
				numberOfChannels: trackOptions.process && trackOptions.processedNumberOfChannels
					? trackOptions.processedNumberOfChannels
					: numberOfChannels,
				sampleRate: trackOptions.process && trackOptions.processedSampleRate
					? trackOptions.processedSampleRate
					: sampleRate,
				bitrate,
			});

			if (
				!encodableCodecs.some(codec => (NON_PCM_AUDIO_CODECS as readonly string[]).includes(codec))
				&& audioCodecs.some(codec => (NON_PCM_AUDIO_CODECS as readonly string[]).includes(codec))
				&& (numberOfChannels !== FALLBACK_NUMBER_OF_CHANNELS || sampleRate !== FALLBACK_SAMPLE_RATE)
			) {
				// We could not find a compatible non-PCM codec despite the container supporting them. This can be
				// caused by strange channel count or sample rate configurations. Therefore, let's try again but with
				// fallback parameters.

				const encodableCodecsWithDefaultParams = await getEncodableAudioCodecs(audioCodecs, {
					numberOfChannels: FALLBACK_NUMBER_OF_CHANNELS,
					sampleRate: FALLBACK_SAMPLE_RATE,
					bitrate,
				});

				const nonPcmCodec = encodableCodecsWithDefaultParams
					.find(codec => (NON_PCM_AUDIO_CODECS as readonly string[]).includes(codec));
				if (nonPcmCodec) {
					// We are able to encode using a non-PCM codec, but it'll require resampling
					needsResample = true;
					codecOfChoice = nonPcmCodec;
					numberOfChannels = FALLBACK_NUMBER_OF_CHANNELS;
					sampleRate = FALLBACK_SAMPLE_RATE;
				}
			} else {
				codecOfChoice = encodableCodecs[0] ?? null;
			}

			if (codecOfChoice === null) {
				this.discardedTracks.push({
					track,
					reason: 'no_encodable_target_codec',
				});
				return;
			}

			if (needsResample) {
				audioSource = this._resampleAudio(
					track,
					trackOptions,
					codecOfChoice,
					numberOfChannels,
					sampleRate,
					bitrate,
				);
			} else {
				const source = new AudioSampleSource({
					codec: codecOfChoice,
					bitrate,
				});
				audioSource = source;

				this._trackPromises.push((async () => {
					await this._started;

					const sink = new AudioSampleSink(track);
					for await (const sample of sink.samples(undefined, this._endTimestamp)) {
						if (this._canceled) {
							sample.close();
							return;
						}

						// Offset the timestamp as needed
						sample.setTimestamp(sample.timestamp - this._startTimestamp);

						await this._registerAudioSample(track, trackOptions, source, sample);
						sample.close();
					}

					source.close();
					this._synchronizer.closeTrack(track.id);
				})());
			}
		}

		this.output.addAudioTrack(audioSource, {
			// TODO: This condition can be removed when all demuxers properly homogenize to BCP47 in v2
			languageCode: isIso639Dash2LanguageCode(track.languageCode) ? track.languageCode : undefined,
			name: track.name ?? undefined,
			disposition: track.disposition,
		});
		this._addedCounts.audio++;
		this._totalTrackCount++;

		this.utilizedTracks.push(track);
	}

	/** @internal */
	async _registerAudioSample(
		track: InputAudioTrack,
		trackOptions: ConversionAudioOptions,
		source: AudioSampleSource,
		sample: AudioSample,
	) {
		if (this._canceled) {
			return;
		}

		this._reportProgress(track.id, sample.timestamp);

		let finalSamples: AudioSample[];
		if (!trackOptions.process) {
			finalSamples = [sample];
		} else {
			let processed = trackOptions.process(sample);
			if (processed instanceof Promise) processed = await processed;

			if (!Array.isArray(processed)) {
				processed = processed === null ? [] : [processed];
			}

			if (!processed.every(x => x instanceof AudioSample)) {
				throw new TypeError(
					'The audio process function must return an AudioSample, null, or an array of AudioSamples.',
				);
			}

			finalSamples = processed;
		}

		for (const finalSample of finalSamples) {
			if (this._canceled) {
				break;
			}

			await source.add(finalSample);

			if (this._synchronizer.shouldWait(track.id, finalSample.timestamp)) {
				await this._synchronizer.wait(finalSample.timestamp);
			}
		}

		for (const finalSample of finalSamples) {
			if (finalSample !== sample) {
				finalSample.close();
			}
		}
	}

	/** @internal */
	_resampleAudio(
		track: InputAudioTrack,
		trackOptions: ConversionAudioOptions,
		codec: AudioCodec,
		targetNumberOfChannels: number,
		targetSampleRate: number,
		bitrate: number | Quality,
	) {
		const source = new AudioSampleSource({
			codec,
			bitrate,
		});

		this._trackPromises.push((async () => {
			await this._started;

			const resampler = new AudioResampler({
				targetNumberOfChannels,
				targetSampleRate,
				startTime: this._startTimestamp,
				endTime: this._endTimestamp,
				onSample: async (sample) => {
					await this._registerAudioSample(track, trackOptions, source, sample);
					sample.close();
				},
			});

			const sink = new AudioSampleSink(track);
			const iterator = sink.samples(this._startTimestamp, this._endTimestamp);

			for await (const sample of iterator) {
				if (this._canceled) {
					sample.close();
					return;
				}

				await resampler.add(sample);
				sample.close();
			}

			await resampler.finalize();

			source.close();
			this._synchronizer.closeTrack(track.id);
		})());

		return source;
	}

	/** @internal */
	_reportProgress(trackId: number, endTimestamp: number) {
		if (!this._computeProgress) {
			return;
		}
		assert(this._totalDuration !== null);

		this._maxTimestamps.set(
			trackId,
			Math.max(endTimestamp, this._maxTimestamps.get(trackId)!),
		);

		const minTimestamp = Math.min(...this._maxTimestamps.values());
		const newProgress = clamp(minTimestamp / this._totalDuration, 0, 1);

		if (newProgress !== this._lastProgress) {
			this._lastProgress = newProgress;
			this.onProgress?.(newProgress);
		}
	}
}

/**
 * Thrown when a conversion couldn't complete due to being canceled.
 * @group Conversion
 * @public
 */
export class ConversionCanceledError extends Error {
	/** Creates a new {@link ConversionCanceledError}. */
	constructor(message = 'Conversion has been canceled.') {
		super(message);
		this.name = 'ConversionCanceledError';
	}
}

const MAX_TIMESTAMP_GAP = 5;

/**
 * Utility class for synchronizing multiple track packet consumers with one another. We don't want one consumer to get
 * too out-of-sync with the others, as that may lead to a large number of packets that need to be internally buffered
 * before they can be written. Therefore, we use this class to slow down a consumer if it is too far ahead of the
 * slowest consumer.
 */
class TrackSynchronizer {
	maxTimestamps = new Map<number, number>(); // Track ID -> timestamp
	resolvers: {
		timestamp: number;
		resolve: () => void;
	}[] = [];

	computeMinAndMaybeResolve() {
		let newMin = Infinity;
		for (const [, timestamp] of this.maxTimestamps) {
			newMin = Math.min(newMin, timestamp);
		}

		for (let i = 0; i < this.resolvers.length; i++) {
			const entry = this.resolvers[i]!;

			if (entry.timestamp - newMin < MAX_TIMESTAMP_GAP) {
				// The gap has gotten small enough again, the consumer can continue again
				entry.resolve();
				this.resolvers.splice(i, 1);
				i--;
			}
		}

		return newMin;
	}

	shouldWait(trackId: number, timestamp: number) {
		this.maxTimestamps.set(trackId, Math.max(timestamp, this.maxTimestamps.get(trackId) ?? -Infinity));

		const newMin = this.computeMinAndMaybeResolve();
		return timestamp - newMin >= MAX_TIMESTAMP_GAP; // Should wait if it is too far ahead of the slowest consumer
	}

	wait(timestamp: number) {
		const { promise, resolve } = promiseWithResolvers();

		this.resolvers.push({
			timestamp,
			resolve,
		});

		return promise;
	}

	closeTrack(trackId: number) {
		this.maxTimestamps.delete(trackId);
		this.computeMinAndMaybeResolve();
	}
}

/**
 * Utility class to handle audio resampling, handling both sample rate resampling as well as channel up/downmixing.
 * The advantage over doing this manually rather than using OfflineAudioContext to do it for us is the artifact-free
 * handling of putting multiple resampled audio samples back to back, which produces flaky results using
 * OfflineAudioContext.
 */
export class AudioResampler {
	sourceSampleRate: number | null = null;
	targetSampleRate: number;
	sourceNumberOfChannels: number | null = null;
	targetNumberOfChannels: number;
	startTime: number;
	endTime: number;
	onSample: (sample: AudioSample) => Promise<void>;

	bufferSizeInFrames: number;
	bufferSizeInSamples: number;
	outputBuffer: Float32Array;
	/** Start frame of current buffer */
	bufferStartFrame: number;
	/** The highest index written to in the current buffer */
	maxWrittenFrame: number;
	channelMixer!: (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => number;
	tempSourceBuffer!: Float32Array;

	constructor(options: {
		targetSampleRate: number;
		targetNumberOfChannels: number;
		startTime: number;
		endTime: number;
		onSample: (sample: AudioSample) => Promise<void>;
	}) {
		this.targetSampleRate = options.targetSampleRate;
		this.targetNumberOfChannels = options.targetNumberOfChannels;
		this.startTime = options.startTime;
		this.endTime = options.endTime;
		this.onSample = options.onSample;

		this.bufferSizeInFrames = Math.floor(this.targetSampleRate * 5.0); // 5 seconds
		this.bufferSizeInSamples = this.bufferSizeInFrames * this.targetNumberOfChannels;

		this.outputBuffer = new Float32Array(this.bufferSizeInSamples);
		this.bufferStartFrame = 0;
		this.maxWrittenFrame = -1;
	}

	/**
	 * Sets up the channel mixer to handle up/downmixing in the case where input and output channel counts don't match.
	 */
	doChannelMixerSetup(): void {
		assert(this.sourceNumberOfChannels !== null);

		const sourceNum = this.sourceNumberOfChannels;
		const targetNum = this.targetNumberOfChannels;

		// Logic taken from
		// https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API
		// Most of the mapping functions are branchless.

		if (sourceNum === 1 && targetNum === 2) {
			// Mono to Stereo: M -> L, M -> R
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]!;
			};
		} else if (sourceNum === 1 && targetNum === 4) {
			// Mono to Quad: M -> L, M -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 1 && targetNum === 6) {
			// Mono to 5.1: 0 -> L, 0 -> R, M -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex === 2);
			};
		} else if (sourceNum === 2 && targetNum === 1) {
			// Stereo to Mono: 0.5 * (L + R)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!);
			};
		} else if (sourceNum === 2 && targetNum === 4) {
			// Stereo to Quad: L -> L, R -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 2 && targetNum === 6) {
			// Stereo to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 4 && targetNum === 1) {
			// Quad to Mono: 0.25 * (L + R + SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.25 * (
					sourceData[baseIdx]! + sourceData[baseIdx + 1]!
					+ sourceData[baseIdx + 2]! + sourceData[baseIdx + 3]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 2) {
			// Quad to Stereo: 0.5 * (L + SL), 0.5 * (R + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (
					sourceData[baseIdx + targetChannelIndex]!
					+ sourceData[baseIdx + targetChannelIndex + 2]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 6) {
			// Quad to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, SL -> SL, SR -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) return sourceData[baseIdx + targetChannelIndex]!; // L, R
				if (targetChannelIndex === 2 || targetChannelIndex === 3) return 0; // C, LFE
				return sourceData[baseIdx + targetChannelIndex - 2]!; // SL, SR
			};
		} else if (sourceNum === 6 && targetNum === 1) {
			// 5.1 to Mono: sqrt(1/2) * (L + R) + C + 0.5 * (SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return Math.SQRT1_2 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!)
					+ sourceData[baseIdx + 2]!
					+ 0.5 * (sourceData[baseIdx + 4]! + sourceData[baseIdx + 5]!);
			};
		} else if (sourceNum === 6 && targetNum === 2) {
			// 5.1 to Stereo: L + sqrt(1/2) * (C + SL), R + sqrt(1/2) * (C + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return sourceData[baseIdx + targetChannelIndex]!
					+ Math.SQRT1_2 * (sourceData[baseIdx + 2]! + sourceData[baseIdx + targetChannelIndex + 4]!);
			};
		} else if (sourceNum === 6 && targetNum === 4) {
			// 5.1 to Quad: L + sqrt(1/2) * C, R + sqrt(1/2) * C, SL, SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) {
					return sourceData[baseIdx + targetChannelIndex]! + Math.SQRT1_2 * sourceData[baseIdx + 2]!;
				}
				return sourceData[baseIdx + targetChannelIndex + 2]!; // SL, SR
			};
		} else {
			// Discrete fallback: direct mapping with zero-fill or drop
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < sourceNum
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		}
	}

	ensureTempBufferSize(requiredSamples: number): void {
		let length = this.tempSourceBuffer.length;

		while (length < requiredSamples) {
			length *= 2;
		}

		if (length !== this.tempSourceBuffer.length) {
			const newBuffer = new Float32Array(length);
			newBuffer.set(this.tempSourceBuffer);
			this.tempSourceBuffer = newBuffer;
		}
	}

	async add(audioSample: AudioSample) {
		if (this.sourceSampleRate === null) {
			// This is the first sample, so let's init the missing data. Initting the sample rate from the decoded
			// sample is more reliable than using the file's metadata, because decoders are free to emit any sample rate
			// they see fit.
			this.sourceSampleRate = audioSample.sampleRate;
			this.sourceNumberOfChannels = audioSample.numberOfChannels;

			// Pre-allocate temporary buffer for source data
			this.tempSourceBuffer = new Float32Array(this.sourceSampleRate * this.sourceNumberOfChannels);

			this.doChannelMixerSetup();
		}

		const requiredSamples = audioSample.numberOfFrames * audioSample.numberOfChannels;
		this.ensureTempBufferSize(requiredSamples);

		// Copy the audio data to the temp buffer
		const sourceDataSize = audioSample.allocationSize({ planeIndex: 0, format: 'f32' });
		const sourceView = new Float32Array(this.tempSourceBuffer.buffer, 0, sourceDataSize / 4);
		audioSample.copyTo(sourceView, { planeIndex: 0, format: 'f32' });

		const inputStartTime = audioSample.timestamp - this.startTime;
		const inputDuration = audioSample.numberOfFrames / this.sourceSampleRate;
		const inputEndTime = Math.min(inputStartTime + inputDuration, this.endTime - this.startTime);

		// Compute which output frames are affected by this sample
		const outputStartFrame = Math.floor(inputStartTime * this.targetSampleRate);
		const outputEndFrame = Math.ceil(inputEndTime * this.targetSampleRate);

		for (let outputFrame = outputStartFrame; outputFrame < outputEndFrame; outputFrame++) {
			if (outputFrame < this.bufferStartFrame) {
				continue; // Skip writes to the past
			}

			while (outputFrame >= this.bufferStartFrame + this.bufferSizeInFrames) {
				// The write is after the current buffer, so finalize it
				await this.finalizeCurrentBuffer();
				this.bufferStartFrame += this.bufferSizeInFrames;
			}

			const bufferFrameIndex = outputFrame - this.bufferStartFrame;
			assert(bufferFrameIndex < this.bufferSizeInFrames);

			const outputTime = outputFrame / this.targetSampleRate;
			const inputTime = outputTime - inputStartTime;
			const sourcePosition = inputTime * this.sourceSampleRate;

			const sourceLowerFrame = Math.floor(sourcePosition);
			const sourceUpperFrame = Math.ceil(sourcePosition);
			const fraction = sourcePosition - sourceLowerFrame;

			// Process each output channel
			for (let targetChannel = 0; targetChannel < this.targetNumberOfChannels; targetChannel++) {
				let lowerSample = 0;
				let upperSample = 0;

				if (sourceLowerFrame >= 0 && sourceLowerFrame < audioSample.numberOfFrames) {
					lowerSample = this.channelMixer(sourceView, sourceLowerFrame, targetChannel);
				}

				if (sourceUpperFrame >= 0 && sourceUpperFrame < audioSample.numberOfFrames) {
					upperSample = this.channelMixer(sourceView, sourceUpperFrame, targetChannel);
				}

				// For resampling, we do naive linear interpolation to find the in-between sample. This produces
				// suboptimal results especially for downsampling (for which a low-pass filter would first need to be
				// applied), but AudioContext doesn't do this either, so, whatever, for now.
				const outputSample = lowerSample + fraction * (upperSample - lowerSample);

				// Write to output buffer (interleaved)
				const outputIndex = bufferFrameIndex * this.targetNumberOfChannels + targetChannel;
				this.outputBuffer[outputIndex]! += outputSample; // Add in case of overlapping samples
			}

			this.maxWrittenFrame = Math.max(this.maxWrittenFrame, bufferFrameIndex);
		}
	}

	async finalizeCurrentBuffer() {
		if (this.maxWrittenFrame < 0) {
			return; // Nothing to finalize
		}

		const samplesWritten = (this.maxWrittenFrame + 1) * this.targetNumberOfChannels;

		const outputData = new Float32Array(samplesWritten);
		outputData.set(this.outputBuffer.subarray(0, samplesWritten));

		const timestampSeconds = this.bufferStartFrame / this.targetSampleRate;
		const audioSample = new AudioSample({
			format: 'f32',
			sampleRate: this.targetSampleRate,
			numberOfChannels: this.targetNumberOfChannels,
			timestamp: timestampSeconds,
			data: outputData,
		});

		await this.onSample(audioSample);

		this.outputBuffer.fill(0);
		this.maxWrittenFrame = -1;
	}

	finalize() {
		return this.finalizeCurrentBuffer();
	}
}
