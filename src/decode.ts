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
	AV1_CODEC_STRING_REGEX,
	AVC_CODEC_STRING_REGEX,
	buildAudioCodecString,
	buildVideoCodecString,
	DTS_FOURCCS,
	guessDescriptionForAudio,
	guessDescriptionForVideo,
	HEVC_CODEC_STRING_REGEX,
	inferCodecFromCodecString,
	MediaCodec,
	OPUS_SAMPLE_RATE,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	PRORES_FOURCCS,
	VALID_AUDIO_CODEC_STRING_PREFIXES,
	VALID_VIDEO_CODEC_STRING_PREFIXES,
	VIDEO_CODECS,
	VideoCodec,
	VP9_CODEC_STRING_REGEX,
} from './codec';
import {
	addAvcBitstreamRestriction,
	AvcNalUnitType,
	concatAvcNalUnits,
	countShownVideoFrames,
	deserializeAvcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateAvcNalUnits,
	iterateHevcNalUnits,
	parseAvcSps,
	parseOpusIdentificationHeader,
	sanitizeHevcPacketForChromium,
	serializeAvcDecoderConfigurationRecord,
} from './codec-data';
import {
	CustomAudioDecoder,
	customAudioDecoders,
	CustomVideoDecoder,
	customVideoDecoders,
} from './custom-coder';
import {
	assert,
	assertNever,
	binarySearchLessOrEqual,
	CallSerializer,
	clamp,
	COLOR_PRIMARIES_MAP,
	colorSpaceIsComplete,
	createWorker,
	getInt24,
	getUint24,
	insertSorted,
	isAllowSharedBufferSource,
	isAndroid,
	isChromium,
	isWebKit,
	last,
	MATRIX_COEFFICIENTS_MAP,
	MaybePromise,
	polyfillSymbolDispose,
	promiseWithResolvers,
	removeItem,
	Rotation,
	roundToDivisor,
	SetOptional,
	toDataView,
	toUint8Array,
	TRANSFER_CHARACTERISTICS_MAP,
} from './misc';
import { EncodedPacket } from './packet';
import { fromAlaw, fromUlaw } from './pcm';
import { AudioSample, VideoSample, VideoSamplePixelFormat } from './sample';

polyfillSymbolDispose();

export type ExtendedVideoDecoderConfig = {
	/** The type of this decoder configuration. */
	type: 'video';
	/**
	 * The codec string describing the codec, which must adhere to the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview).
	 */
	codec: string;
	/**
	 * A sequence of codec-specific bytes, commonly known as extradata, which must adhere to the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview).
	 */
	description?: AllowSharedBufferSource;
	/**
	 * Width of the video frames in pixels, potentially including non-visible padding, and prior to considering
	 * potential ratio adjustments.
	 */
	codedWidth?: number;
	/**
	 * Height of the video frames in pixels, potentially including non-visible padding, and prior to considering
	 * potential ratio adjustments.
	 */
	codedHeight?: number;
	/** Horizontal dimension of the video's aspect ratio when displayed. */
	displayAspectWidth?: number;
	/** Vertical dimension of the video's aspect ratio when displayed. */
	displayAspectHeight?: number;
	/**
	 * Configures the color space of the decoded video frames. If provided, these values will override any in-band
	 * values from the bitstream.
	 */
	colorSpace?: VideoColorSpaceInit;
	/** Hint that configures hardware acceleration for this codec. Defaults to `'no-preference'`. */
	hardwareAcceleration?: HardwareAcceleration;
	/**
	 * Hint that the selected decoder should be configured to minimize the number of chunks that have to be decoded
	 * before a frame is output. Defaults to `false`.
	 */
	optimizeForLatency?: boolean;
	/** Sets the rotation of the decoded video frames. Defaults to `0`. */
	rotation?: number;
	/** Sets the flip of the decoded video frames. Defaults to `false`. */
	flip?: boolean;
};

export type ExtendedAudioDecoderConfig = {
	/** The type of this decoder configuration. */
	type: 'audio';
	/**
	 * The codec string describing the codec, which must adhere to the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview).
	 */
	codec: string;
	/**
	 * A sequence of codec-specific bytes, commonly known as extradata, which must adhere to the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview).
	 */
	description?: AllowSharedBufferSource;
	/** The number of frame samples per second. */
	sampleRate: number;
	/** The number of audio channels. */
	numberOfChannels: number;
};

export const validateExtendedVideoDecoderConfig = (
	config: Partial<ExtendedVideoDecoderConfig>,
	subject: string,
	optionalFields: { type?: boolean; codec?: boolean } = {},
) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError(`${subject} must be an object.`);
	}

	if ((config.type !== undefined || !optionalFields.type) && config.type !== 'video') {
		throw new TypeError(`${subject} type must be 'video'.`);
	}
	const codec = config.codec;
	if (codec !== undefined || !optionalFields.codec) {
		if (typeof codec !== 'string') {
			throw new TypeError(`${subject} must specify a codec string.`);
		}
		if (!VALID_VIDEO_CODEC_STRING_PREFIXES.some(prefix => codec.startsWith(prefix))) {
			throw new TypeError(
				`${subject} codec string must be a valid video codec string as specified in the Mediabunny Codec`
				+ ` Registry.`,
			);
		}
	}
	if (config.codedWidth !== undefined && (!Number.isInteger(config.codedWidth) || config.codedWidth <= 0)) {
		throw new TypeError(`${subject} codedWidth, when defined, must be a positive integer.`);
	}
	if (config.codedHeight !== undefined && (!Number.isInteger(config.codedHeight) || config.codedHeight <= 0)) {
		throw new TypeError(`${subject} codedHeight, when defined, must be a positive integer.`);
	}
	if ((config.codedWidth !== undefined) !== (config.codedHeight !== undefined)) {
		throw new TypeError(`${subject} must specify both codedWidth and codedHeight, or neither.`);
	}
	if (
		config.displayAspectWidth !== undefined
		&& (!Number.isInteger(config.displayAspectWidth) || config.displayAspectWidth <= 0)
	) {
		throw new TypeError(`${subject} displayAspectWidth, when defined, must be a positive integer.`);
	}
	if (
		config.displayAspectHeight !== undefined
		&& (!Number.isInteger(config.displayAspectHeight) || config.displayAspectHeight <= 0)
	) {
		throw new TypeError(`${subject} displayAspectHeight, when defined, must be a positive integer.`);
	}
	if ((config.displayAspectWidth !== undefined) !== (config.displayAspectHeight !== undefined)) {
		throw new TypeError(`${subject} must specify both displayAspectWidth and displayAspectHeight, or neither.`);
	}
	if (config.description !== undefined && !isAllowSharedBufferSource(config.description)) {
		throw new TypeError(`${subject} description, when defined, must be an ArrayBuffer or an ArrayBuffer view.`);
	}
	if (config.colorSpace !== undefined) {
		const { colorSpace } = config;

		if (typeof colorSpace !== 'object') {
			throw new TypeError(`${subject} colorSpace, when provided, must be an object.`);
		}

		const primariesValues = Object.keys(COLOR_PRIMARIES_MAP);
		if (colorSpace.primaries != null && !primariesValues.includes(colorSpace.primaries)) {
			throw new TypeError(
				`${subject} colorSpace primaries, when defined, must be one of ${primariesValues.join(', ')}.`,
			);
		}

		const transferValues = Object.keys(TRANSFER_CHARACTERISTICS_MAP);
		if (colorSpace.transfer != null && !transferValues.includes(colorSpace.transfer)) {
			throw new TypeError(
				`${subject} colorSpace transfer, when defined, must be one of ${transferValues.join(', ')}.`,
			);
		}

		const matrixValues = Object.keys(MATRIX_COEFFICIENTS_MAP);
		if (colorSpace.matrix != null && !matrixValues.includes(colorSpace.matrix)) {
			throw new TypeError(
				`${subject} colorSpace matrix, when defined, must be one of ${matrixValues.join(', ')}.`,
			);
		}

		if (colorSpace.fullRange != null && typeof colorSpace.fullRange !== 'boolean') {
			throw new TypeError(`${subject} colorSpace fullRange, when defined, must be a boolean.`);
		}
	}
	if (
		config.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(config.hardwareAcceleration)
	) {
		throw new TypeError(
			`${subject} hardwareAcceleration, when defined, must be 'no-preference', 'prefer-hardware' or`
			+ ` 'prefer-software'.`,
		);
	}
	if (config.optimizeForLatency !== undefined && typeof config.optimizeForLatency !== 'boolean') {
		throw new TypeError(`${subject} optimizeForLatency, when defined, must be a boolean.`);
	}
	if (
		config.rotation !== undefined
		&& (typeof config.rotation !== 'number' || !Number.isFinite(config.rotation))
	) {
		throw new TypeError(`${subject} rotation, when defined, must be a finite number.`);
	}
	if (config.flip !== undefined && typeof config.flip !== 'boolean') {
		throw new TypeError(`${subject} flip, when defined, must be a boolean.`);
	}

	if (codec === undefined) {
		return;
	}

	if (codec.startsWith('avc1') || codec.startsWith('avc3')) {
		// AVC-specific validation

		if (!AVC_CODEC_STRING_REGEX.test(codec)) {
			throw new TypeError(
				`${subject} codec string for AVC must be a valid AVC codec string as specified in Section 3.4 of`
				+ ` RFC 6381.`,
			);
		}

		// `description` may or may not be set, depending on if the format is AVCC or Annex B, so don't perform any
		// validation for it.
		// https://www.w3.org/TR/webcodecs-avc-codec-registration
	} else if (codec.startsWith('hev1') || codec.startsWith('hvc1')) {
		// HEVC-specific validation

		if (!HEVC_CODEC_STRING_REGEX.test(codec)) {
			throw new TypeError(
				`${subject} codec string for HEVC must be a valid HEVC codec string as specified in Section E.3 of`
				+ ` ISO 14496-15.`,
			);
		}

		// `description` may or may not be set, depending on if the format is HEVC or Annex B, so don't perform any
		// validation for it.
		// https://www.w3.org/TR/webcodecs-hevc-codec-registration
	} else if (codec.startsWith('vp8')) {
		// VP8-specific validation

		if (codec !== 'vp8') {
			throw new TypeError(`${subject} codec string for VP8 must be "vp8".`);
		}
	} else if (codec.startsWith('vp09')) {
		// VP9-specific validation

		if (!VP9_CODEC_STRING_REGEX.test(codec)) {
			throw new TypeError(
				`${subject} codec string for VP9 must be a valid VP9 codec string as specified in Section "Codecs`
				+ ` Parameter String" of https://www.webmproject.org/vp9/mp4/.`,
			);
		}
	} else if (codec.startsWith('av01')) {
		// AV1-specific validation

		if (!AV1_CODEC_STRING_REGEX.test(codec)) {
			throw new TypeError(
				`${subject} codec string for AV1 must be a valid AV1 codec string as specified in Section "Codecs`
				+ ` Parameter String" of https://aomediacodec.github.io/av1-isobmff/.`,
			);
		}
	} else if (PRORES_FOURCCS.some(x => codec.startsWith(x))) {
		// ProRes-specific validation

		if (!PRORES_FOURCCS.some(x => codec === x)) {
			throw new TypeError(
				`${subject} codec string for ProRes must be one of the valid ProRes four-character codes:`
				+ ` ${PRORES_FOURCCS.join(', ')}.`,
			);
		}
	}
};

export const validateExtendedAudioDecoderConfig = (
	config: Partial<ExtendedAudioDecoderConfig>,
	subject: string,
	optionalFields: { type?: boolean; codec?: boolean; numberOfChannels?: boolean; sampleRate?: boolean } = {},
) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError(`${subject} must be an object.`);
	}

	if ((config.type !== undefined || !optionalFields.type) && config.type !== 'audio') {
		throw new TypeError(`${subject} type must be 'audio'.`);
	}
	const codec = config.codec;
	if (codec !== undefined || !optionalFields.codec) {
		if (typeof codec !== 'string') {
			throw new TypeError(`${subject} must specify a codec string.`);
		}
		if (!VALID_AUDIO_CODEC_STRING_PREFIXES.some(prefix => codec.startsWith(prefix))) {
			throw new TypeError(
				`${subject} codec string must be a valid audio codec string as specified in the Mediabunny Codec`
				+ ` Registry.`,
			);
		}
	}
	if (
		(config.sampleRate !== undefined || !optionalFields.sampleRate)
		&& (!Number.isInteger(config.sampleRate) || config.sampleRate! <= 0)
	) {
		throw new TypeError(`${subject} must specify a valid sampleRate (positive integer).`);
	}
	if (
		(config.numberOfChannels !== undefined || !optionalFields.numberOfChannels)
		&& (!Number.isInteger(config.numberOfChannels) || config.numberOfChannels! <= 0)
	) {
		throw new TypeError(`${subject} must specify a valid numberOfChannels (positive integer).`);
	}
	if (config.description !== undefined && !isAllowSharedBufferSource(config.description)) {
		throw new TypeError(`${subject} description, when defined, must be an ArrayBuffer or an ArrayBuffer view.`);
	}

	if (codec === undefined) {
		return;
	}

	if (
		codec.startsWith('mp4a')
		// These three refer to MP3:
		&& codec !== 'mp4a.69'
		&& codec !== 'mp4a.6B'
		&& codec !== 'mp4a.6b'
	) {
		// AAC-specific validation

		const validStrings = [
			'mp4a.40.2', 'mp4a.40.02', 'mp4a.40.5', 'mp4a.40.05', 'mp4a.40.29', 'mp4a.40.42', 'mp4a.67',
		];
		if (!validStrings.includes(codec)) {
			throw new TypeError(
				`${subject} codec string for AAC must be a valid AAC codec string as specified in`
				+ ` https://www.w3.org/TR/webcodecs-aac-codec-registration/.`,
			);
		}

		// `description` may or may not be set, depending on if the format is AAC or ADTS, so don't perform any
		// validation for it.
		// https://www.w3.org/TR/webcodecs-aac-codec-registration
	} else if (codec.startsWith('mp3') || codec.startsWith('mp4a')) {
		// MP3-specific validation

		if (
			codec !== 'mp3'
			&& codec !== 'mp4a.69'
			&& codec !== 'mp4a.6B'
			&& codec !== 'mp4a.6b'
		) {
			throw new TypeError(`${subject} codec string for MP3 must be "mp3", "mp4a.69" or "mp4a.6B".`);
		}
	} else if (codec.startsWith('opus')) {
		// Opus-specific validation

		if (codec !== 'opus') {
			throw new TypeError(`${subject} codec string for Opus must be "opus".`);
		}

		if (config.description && config.description.byteLength < 18) {
			// Description is optional for Opus per-spec, so we shouldn't enforce it
			throw new TypeError(
				`${subject} description, when specified, is expected to be an Identification Header as specified in`
				+ ` Section 5.1 of RFC 7845.`,
			);
		}
	} else if (codec.startsWith('vorbis')) {
		// Vorbis-specific validation

		if (codec !== 'vorbis') {
			throw new TypeError(`${subject} codec string for Vorbis must be "vorbis".`);
		}

		if (!config.description) {
			throw new TypeError(
				`${subject} for Vorbis must include a description, which is expected to adhere to the format described`
				+ ` in https://www.w3.org/TR/webcodecs-vorbis-codec-registration/.`,
			);
		}
	} else if (codec.startsWith('flac')) {
		// FLAC-specific validation

		if (codec !== 'flac') {
			throw new TypeError(`${subject} codec string for FLAC must be "flac".`);
		}

		const minDescriptionSize = 4 + 4 + 34; // 'fLaC' + metadata block header + STREAMINFO block
		if (!config.description || config.description.byteLength < minDescriptionSize) {
			throw new TypeError(
				`${subject} for FLAC must include a description, which is expected to adhere to the format described`
				+ ` in https://www.w3.org/TR/webcodecs-flac-codec-registration/.`,
			);
		}
	} else if (codec.startsWith('ac-3') || codec.startsWith('ac3')) {
		// AC3-specific validation

		if (codec !== 'ac-3') {
			throw new TypeError(`${subject} codec string for AC-3 must be "ac-3".`);
		}
	} else if (codec.startsWith('ec-3') || codec.startsWith('eac3')) {
		// EAC3-specific validation

		if (codec !== 'ec-3') {
			throw new TypeError(`${subject} codec string for EC-3 must be "ec-3".`);
		}
	} else if (codec.startsWith('dts')) {
		// DTS-specific validation

		if (!(DTS_FOURCCS as readonly string[]).includes(codec)) {
			throw new TypeError(
				`${subject} codec string for DTS must be one of the following four-character codes:`
				+ ` ${DTS_FOURCCS.join(', ')}.`,
			);
		}
	} else if (codec.startsWith('mlpa')) {
		// TrueHD-specific validation

		if (codec !== 'mlpa') {
			throw new TypeError(`${subject} codec string for TrueHD must be "mlpa".`);
		}
	} else if (
		codec.startsWith('pcm')
		|| codec.startsWith('ulaw')
		|| codec.startsWith('alaw')
	) {
		// PCM-specific validation

		if (!(PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
			throw new TypeError(
				`${subject} codec string for PCM must be one of the supported PCM codecs`
				+ ` (${PCM_AUDIO_CODECS.join(', ')}).`,
			);
		}
	}
};

const MAX_QUEUE_SIZE = 4;

export abstract class PacketDecoder<
	MediaSample extends VideoSample | AudioSample,
> {
	/** @internal */
	_results: (MediaSample | null)[] = [];
	/** @internal */
	_pendingPulls: ReturnType<typeof promiseWithResolvers<MediaSample | null>>[] = [];
	/** @internal */
	_backpressure: ReturnType<typeof promiseWithResolvers<void>> | null = null;
	/** @internal */
	_pendingInputs: (EncodedPacket | null)[] = [];
	/** @internal */
	_flushInProgress = false;
	/** @internal */
	_dirty = false;
	/** @internal */
	_needsKeyPacket = true;
	/** @internal */
	_error: unknown = null;
	/** @internal */
	_hasError = false;
	/** @internal */
	_ended = false;
	/** @internal */
	_endEmitted = false;
	/** @internal */
	_done = false;
	/** @internal */
	_released = false;
	/** @internal */
	_finishedResolver = promiseWithResolvers();

	get ended() {
		return this._ended;
	}

	get done() {
		return this._done;
	}

	/** @internal */
	abstract _decodePacket(packet: EncodedPacket): void;
	/** @internal */
	abstract _flush(): Promise<void>;
	/** @internal */
	abstract _getDecoderQueueSize(): number;
	/** @internal */
	abstract _releaseDecoder(): void;

	push(packet: EncodedPacket | null) {
		if (packet !== null && !(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket or null.');
		}

		if (this._ended) {
			if (this._hasError) {
				throw this._error;
			}

			throw new Error('Cannot push after the decoder has been ended or closed.');
		}

		if (packet) {
			if (this._needsKeyPacket && packet.type !== 'key') {
				throw new Error(
					'The first packet of a packet stream must be a key packet.',
				);
			}

			this._needsKeyPacket = false;
		} else {
			this._needsKeyPacket = true;
		}

		if (
			this._pendingInputs.length === 0
			&& !this._flushInProgress
			&& (!packet || this._getAdmittedQueueSize() < MAX_QUEUE_SIZE)
		) {
			this._processInput(packet);
		} else {
			this._pendingInputs.push(packet);
		}

		if (this._hasError) {
			throw this._error;
		}

		return this._getBackpressurePromise();
	}

	pull(): MaybePromise<MediaSample | null> {
		if (this._hasError) {
			this._done = true;
			throw this._error;
		}
		if (this._done) {
			throw new Error('Cannot pull past the end of the decoder.');
		}

		if (this._results.length > 0) {
			const result = this._results.shift();
			assert(result !== undefined);

			if (result) {
				this._handleDequeue();
			} else if (this._endEmitted && this._results.length === 0) {
				this._done = true;
				this._finishedResolver.resolve();
			}

			return result;
		}

		const resolver = promiseWithResolvers<MediaSample | null>();
		this._pendingPulls.push(resolver);

		return resolver.promise;
	}

	end() {
		if (!this._ended) {
			this._ended = true;
			this._pendingInputs.push(null);
			this._processInputs();
		}

		return this._finishedResolver.promise;
	}

	close() {
		if (this._hasError || this._done) {
			return;
		}

		this._abort();
		this._emitEnd();
	}

	[Symbol.dispose]() {
		this.close();
	}

	/** @internal */
	_processInputs() {
		while (this._pendingInputs.length > 0 && !this._flushInProgress && !this._released) {
			const input = this._pendingInputs[0]!;

			// Packets wait here until the decoder has room, since handing them over copies their data
			if (input && this._getAdmittedQueueSize() >= MAX_QUEUE_SIZE) {
				break;
			}

			this._pendingInputs.shift();
			this._processInput(input);
		}
	}

	/** @internal */
	_processInput(input: EncodedPacket | null) {
		if (input) {
			this._dirty = true;

			try {
				this._decodePacket(input);
			} catch (error) {
				this._handleError(error);
			}
		} else {
			// The flush queued by end() is always the last input
			const isEnd = this._ended && this._pendingInputs.length === 0;

			if (!this._dirty) {
				this._finishFlush(isEnd);
			} else {
				this._dirty = false;
				this._flushInProgress = true;

				void this._flush().then(() => {
					this._flushInProgress = false;
					if (this._released) {
						return;
					}

					this._finishFlush(isEnd);
					this._processInputs();
				}, (error) => {
					this._handleError(error);
				});
			}
		}
	}

	/** @internal */
	_finishFlush(isEnd: boolean) {
		if (isEnd) {
			this._release();
			this._emitEnd();
		} else {
			this._emit(null);
		}
	}

	/** @internal */
	_handleDequeue() {
		this._processInputs();
		this._releaseBackpressureIfPossible();
	}

	/** @internal */
	_emitSample(sample: MediaSample) {
		if (this._released) {
			sample.close();
			return;
		}

		this._emit(sample);
	}

	/** @internal */
	_emit(result: MediaSample | null) {
		const pendingPull = this._pendingPulls.shift();
		if (pendingPull) {
			pendingPull.resolve(result);
		} else {
			this._results.push(result);
		}
	}

	/** @internal */
	_emitEnd() {
		this._endEmitted = true;

		const pendingPull = this._pendingPulls.shift();
		if (pendingPull) {
			this._done = true;
			this._finishedResolver.resolve();
			pendingPull.resolve(null);

			for (const pendingPull of this._pendingPulls) {
				pendingPull.reject(new Error('Cannot pull past the end of the decoder.'));
			}
			this._pendingPulls.length = 0;
		} else {
			this._results.push(null);
		}
	}

	/** @internal */
	_getBackpressurePromise() {
		if (this._getQueueSize() < MAX_QUEUE_SIZE) {
			return null;
		}

		this._backpressure ??= promiseWithResolvers();
		return this._backpressure.promise;
	}

	/** @internal */
	_releaseBackpressureIfPossible() {
		if (this._backpressure && this._getQueueSize() < MAX_QUEUE_SIZE) {
			this._backpressure.resolve();
			this._backpressure = null;
		}
	}

	/** @internal */
	_getQueueSize() {
		let size = this._getAdmittedQueueSize();
		for (const input of this._pendingInputs) {
			if (input) {
				size++;
			}
		}

		return size;
	}

	/** @internal */
	_getAdmittedQueueSize() {
		let size = this._getDecoderQueueSize();
		for (const result of this._results) {
			if (result) {
				size++;
			}
		}

		return size;
	}

	/** @internal */
	_handleError(error: unknown) {
		if (this._released) {
			return;
		}

		this._error = error;
		this._hasError = true;

		if (this._pendingPulls.length > 0) {
			this._done = true;
		}
		for (const pendingPull of this._pendingPulls) {
			pendingPull.reject(error);
		}
		this._pendingPulls.length = 0;

		this._abort();
	}

	/** @internal */
	_abort() {
		this._ended = true;
		this._pendingInputs.length = 0;

		for (const result of this._results) {
			result?.close();
		}
		this._results.length = 0;

		this._release();
		this._finishedResolver.resolve();
	}

	/** @internal */
	_release() {
		if (this._released) {
			return;
		}

		this._released = true;
		this._releaseDecoder();

		this._backpressure?.resolve();
		this._backpressure = null;
	}
}

export class VideoPacketDecoder extends PacketDecoder<VideoSample> {
	/** @internal */
	_codec: VideoCodec;
	/** @internal */
	_decoderConfig: VideoDecoderConfig;
	/** @internal */
	_rotation: Rotation;
	/** @internal */
	_flip: boolean;

	/** @internal */
	_decoder: VideoDecoder | null = null;

	/** @internal */
	_customDecoder: CustomVideoDecoder | null = null;
	/** @internal */
	_customDecoderCallSerializer = new CallSerializer();
	/** @internal */
	_customDecoderQueueSize = 0;

	/** @internal */
	_inputTimings: { timestamp: number; duration: number }[] = []; // Of the packets input into the decoder, sorted.
	/** @internal */
	_sampleQueue: VideoSample[] = []; // Safari-specific thing, check usage.
	/** @internal */
	_currentPacketIndex = 0;
	/** @internal */
	_raslSkipped = false; // For HEVC stuff

	// Alpha stuff
	/** @internal */
	_alphaDecoder: VideoDecoder | null = null;
	/** @internal */
	_alphaHadKeyframe = false;
	/** @internal */
	_colorQueue: VideoFrame[] = [];
	/** @internal */
	_alphaQueue: (VideoFrame | null)[] = [];
	/** @internal */
	_merger: ColorAlphaMerger | null = null;
	/** @internal */
	_decodedAlphaChunkCount = 0;
	/** @internal */
	_alphaDecoderQueueSize = 0;
	/**
	 * Each value is the number of decoded alpha chunks at which a null alpha frame should be added.
	 * @internal
	 */
	_nullAlphaFrameQueue: number[] = [];
	/** @internal */
	_currentAlphaPacketIndex = 0;
	/** @internal */
	_alphaRaslSkipped = false; // For HEVC stuff
	/** @internal */
	_finalSamples: { sample: VideoSample | null }[] = [];
	/** @internal */
	_mergeAlphaPromises: Promise<void>[] = [];
	/** @internal */
	_flushing = false;

	// Needed for a Chromium for Android workaround
	/** @internal */
	_frameCopyContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

	constructor(config: ExtendedVideoDecoderConfig) {
		validateExtendedVideoDecoderConfig(config, 'Decoder configuration');

		super();

		const { rotation, flip, ...decoderConfig } = config;
		const codec = inferCodecFromCodecString(decoderConfig.codec) as VideoCodec;
		this._codec = codec;
		this._decoderConfig = decoderConfig;
		const alignedRotation = 90 * Math.round((rotation ?? 0) / 90);
		this._rotation = (alignedRotation - 360 * Math.floor(alignedRotation / 360)) as Rotation;
		this._flip = flip ?? false;

		const MatchingCustomDecoder = customVideoDecoders.find(x => x.supports(codec, config));
		if (MatchingCustomDecoder) {
			// @ts-expect-error "Can't create instance of abstract class 🤓"
			this._customDecoder = new MatchingCustomDecoder() as CustomVideoDecoder;
			// @ts-expect-error It's technically readonly
			this._customDecoder.codec = codec;
			// @ts-expect-error It's technically readonly
			this._customDecoder.config = config;
			// @ts-expect-error It's technically readonly
			this._customDecoder.onSample = (sample) => {
				if (!(sample instanceof VideoSample)) {
					throw new TypeError('The argument passed to onSample must be a VideoSample.');
				}

				this._finalizeAndEmitSample(sample);
			};
			// @ts-expect-error It's technically readonly
			this._customDecoder.onError = (error) => {
				this._handleError(error);
			};

			void this._customDecoderCallSerializer
				.call(() => this._customDecoder!.init())
				.catch(error => this._handleError(error));
		} else {
			const colorHandler = (frame: VideoFrame) => {
				if (this._alphaQueue.length > 0) {
					// Even when no alpha data is present (most of the time), there will be nulls in this queue
					const alphaFrame = this._alphaQueue.shift();
					assert(alphaFrame !== undefined);

					void this._mergeAlpha(frame, alphaFrame);
				} else {
					this._colorQueue.push(frame);
				}
			};

			if (isChromium()) {
				if (codec === 'avc' && this._decoderConfig.description) {
					const record = deserializeAvcDecoderConfigurationRecord(
						toUint8Array(this._decoderConfig.description),
					);
					if (record && record.sequenceParameterSets.length > 0) {
						const firstSps = parseAvcSps(record.sequenceParameterSets[0]!);
						if (firstSps && firstSps.frameMbsOnlyFlag === 0) {
							// Chromium has/had a bug with playing interlaced AVC
							// (https://issues.chromium.org/issues/456919096) which can be worked around by
							// requesting that software decoding be used. So, here we peek into the AVC description,
							// if present, and switch to software decoding if we find interlaced content.
							this._decoderConfig = {
								...this._decoderConfig,
								hardwareAcceleration: 'prefer-software',
							};
						}

						// Modify the SPSs to fix potential loss of B frames
						let recordModified = false;
						for (let i = 0; i < record.sequenceParameterSets.length; i++) {
							const sps = parseAvcSps(record.sequenceParameterSets[i]!);
							if (sps && sps.maxDecFrameBuffering !== 0 && sps.bitstreamRestrictionFlag !== 1) {
								record.sequenceParameterSets[i] = addAvcBitstreamRestriction(sps);
								recordModified = true;
							}
						}

						if (recordModified) {
							this._decoderConfig = {
								...this._decoderConfig,
								description: serializeAvcDecoderConfigurationRecord(record),
							};
						}
					}
				}

				if (!colorSpaceIsComplete(this._decoderConfig.colorSpace)) {
					// Found via https://github.com/remotion-dev/remotion/issues/10841.
					// If the color space is incomplete (which is often that it's just partially filled), Chromium has
					// some nasty logic where it doesn't pass that information along to the GPU at all. The result is
					// that information is genuinely lost, like the color matrix for example. Chromium has other code
					// paths where it just fills the missing values with a hardcoded default, so we do the exact same
					// thing here, with the same hardcoded defaults:
					this._decoderConfig = {
						...this._decoderConfig,
						colorSpace: {
							primaries: this._decoderConfig.colorSpace?.primaries ?? 'bt709',
							matrix: this._decoderConfig.colorSpace?.matrix ?? 'bt709',
							transfer: this._decoderConfig.colorSpace?.transfer ?? 'bt709',
							fullRange: this._decoderConfig.colorSpace?.fullRange ?? false,
						},
					};
				}
			}

			const stack = new Error('Decoding error').stack;

			this._decoder = new VideoDecoder({
				output: (frame) => {
					try {
						colorHandler(this._copyFrameIfNeeded(frame));
					} catch (error) {
						this._handleError(error);
					}
				},
				error: (error) => {
					error.stack = stack; // Provide a more useful stack trace, the default one sucks
					this._handleError(error);
				},
			});
			this._decoder.addEventListener('dequeue', () => {
				this._handleDequeue();
			});
			this._decoder.configure(this._decoderConfig);
		}
	}

	/** @internal */
	_decodePacket(packet: EncodedPacket) {
		if (this._codec === 'hevc' && this._currentPacketIndex > 0 && !this._raslSkipped) {
			if (this._hasHevcRaslPicture(packet.data)) {
				return; // Drop
			}

			this._raslSkipped = true;
		}

		if (this._customDecoder) {
			this._customDecoderQueueSize++;
			void this._customDecoderCallSerializer
				.call(() => this._customDecoder!.decode(packet))
				.catch(error => this._handleError(error))
				.finally(() => {
					this._customDecoderQueueSize--;
					this._handleDequeue();
				});
		} else {
			assert(this._decoder);

			// It is important that we don't add timings for packets that won't produce a frame. If we did, it would
			// offset everything. See https://github.com/Vanilagy/mediabunny/issues/642.
			const shownFrameCount = countShownVideoFrames(this._codec, packet.data);
			for (let i = 0; i < shownFrameCount; i++) {
				// Make sure it doesn't grow indefinitely
				if (this._inputTimings.length >= 128) {
					this._inputTimings.shift();
				}

				insertSorted(
					this._inputTimings,
					{ timestamp: packet.timestamp, duration: packet.duration },
					x => x.timestamp,
				);
			}

			if (isChromium() && this._currentPacketIndex === 0) {
				const fixedData = this._fixFirstPacketDataForChromium(packet.data);
				if (fixedData) {
					packet = packet.clone({ data: fixedData });
				}
			}

			this._decoder.decode(packet.toEncodedVideoChunk());
			this._decodeAlphaData(packet);
		}

		this._currentPacketIndex++;
	}

	/** @internal */
	async _flush() {
		if (this._customDecoder) {
			await this._customDecoderCallSerializer.call(() => this._customDecoder!.flush());
		} else {
			assert(this._decoder);
			this._flushing = true;
			await Promise.all([
				this._decoder.flush(),
				this._alphaDecoder?.flush(),
			]);
			this._flushing = false;
			await Promise.all(this._mergeAlphaPromises);

			this._inputTimings.length = 0;

			this._colorQueue.forEach(x => x.close());
			this._colorQueue.length = 0;
			this._alphaQueue.forEach(x => x?.close());
			this._alphaQueue.length = 0;

			this._alphaHadKeyframe = false;
			this._decodedAlphaChunkCount = 0;
			this._alphaDecoderQueueSize = 0;
			this._nullAlphaFrameQueue.length = 0;
			this._currentAlphaPacketIndex = 0;
			this._alphaRaslSkipped = false;
		}

		if (isWebKit()) {
			for (const sample of this._sampleQueue) {
				this._finalizeAndEmitSample(sample);
			}

			this._sampleQueue.length = 0;
		}

		this._currentPacketIndex = 0;
		this._raslSkipped = false;
	}

	/** @internal */
	_decodeAlphaData(packet: EncodedPacket) {
		if (!packet.sideData.alpha) {
			// No alpha side data in the packet, most common case
			this._pushNullAlphaFrame();
			return;
		}

		if (!this._merger) {
			this._merger = new ColorAlphaMerger();
		}

		// Check if we need to set up the alpha decoder
		if (!this._alphaDecoder) {
			const alphaHandler = (frame: VideoFrame) => {
				if (this._colorQueue.length > 0) {
					const colorFrame = this._colorQueue.shift();
					assert(colorFrame !== undefined);

					void this._mergeAlpha(colorFrame, frame);
				} else {
					this._alphaQueue.push(frame);
				}

				// Check if any null frames have been queued for this point
				this._decodedAlphaChunkCount++;
				while (
					this._nullAlphaFrameQueue.length > 0
					&& this._nullAlphaFrameQueue[0] === this._decodedAlphaChunkCount
				) {
					this._nullAlphaFrameQueue.shift();

					if (this._colorQueue.length > 0) {
						const colorFrame = this._colorQueue.shift();
						assert(colorFrame !== undefined);

						void this._mergeAlpha(colorFrame, null);
					} else {
						this._alphaQueue.push(null);
					}
				}

				this._alphaDecoderQueueSize--;
			};

			const stack = new Error('Decoding error').stack;

			this._alphaDecoder = new VideoDecoder({
				output: (frame) => {
					try {
						alphaHandler(this._copyFrameIfNeeded(frame));
					} catch (error) {
						this._handleError(error);
					}
				},
				error: (error) => {
					error.stack = stack; // Provide a more useful stack trace, the default one sucks
					this._handleError(error);
				},
			});
			this._alphaDecoder.addEventListener('dequeue', () => {
				this._handleDequeue();
			});
			this._alphaDecoder.configure({
				...this._decoderConfig,
				// Alpha is always full range, regardless of what the color track says. The decoder only honors the
				// override if all fields are set tho.
				colorSpace: {
					fullRange: true,
					// These fields are irrelevant:
					matrix: 'bt709',
					primaries: 'bt709',
					transfer: 'bt709',
				},
			});
		}

		const type = determineVideoPacketType(this._codec, this._decoderConfig, packet.sideData.alpha);

		// Alpha packets might follow a different key frame rhythm than the main packets. Therefore, before we start
		// decoding, we must first find a packet that's actually a key frame. Until then, we treat the image as opaque.
		if (!this._alphaHadKeyframe) {
			this._alphaHadKeyframe = type === 'key';
		}

		if (this._alphaHadKeyframe) {
			// Same RASL skipping logic as for color, unlikely to be hit (since who uses HEVC with separate alpha??) but
			// here for symmetry.
			if (this._codec === 'hevc' && this._currentAlphaPacketIndex > 0 && !this._alphaRaslSkipped) {
				if (this._hasHevcRaslPicture(packet.sideData.alpha)) {
					this._pushNullAlphaFrame();
					return;
				}

				this._alphaRaslSkipped = true;
			}

			// The alpha decoder is a decoder of its own, so its first packet needs the same treatment
			if (isChromium() && this._currentAlphaPacketIndex === 0) {
				const fixedData = this._fixFirstPacketDataForChromium(packet.sideData.alpha);
				if (fixedData) {
					packet = packet.clone({
						sideData: {
							...packet.sideData,
							alpha: fixedData,
						},
					});
				}
			}

			this._currentAlphaPacketIndex++;
			this._alphaDecoder.decode(packet.alphaToEncodedVideoChunk(type ?? packet.type));
			this._alphaDecoderQueueSize++;
		} else {
			this._pushNullAlphaFrame();
		}
	}

	/** @internal */
	_fixFirstPacketDataForChromium(data: Uint8Array) {
		if (this._codec === 'avc') {
			// Workaround for https://issues.chromium.org/issues/470109459
			const filteredNalUnits: Uint8Array[] = [];
			let hasFrameData = false;

			for (const loc of iterateAvcNalUnits(data, this._decoderConfig)) {
				const type = extractNalUnitTypeForAvc(data[loc.offset]!);
				hasFrameData ||= type >= 1 && type <= 5;

				if (type === AvcNalUnitType.AUD) {
					if (hasFrameData) {
						// Already has actual frame data, so treat an AUD as simply the end of the packet
						break;
					} else {
						// If packets contain an AUD and have NALUs before it, this trips up Chromium's key frame
						// detector. Clear the NALUs if an AUD is encountered.
						// https://github.com/Vanilagy/mediabunny/issues/396
						filteredNalUnits.length = 0;
					}
				}

				// These trip up Chromium's key frame detection, so let's strip them
				if (!(type >= 20 && type <= 31)) {
					filteredNalUnits.push(data.subarray(loc.offset, loc.offset + loc.length));
				}
			}

			if (!this._decoderConfig.description) {
				// Do SPS fixups if necessary
				for (let i = 0; i < filteredNalUnits.length; i++) {
					const nalUnit = filteredNalUnits[i]!;
					if (extractNalUnitTypeForAvc(nalUnit[0]!) !== AvcNalUnitType.SPS) {
						continue;
					}

					const sps = parseAvcSps(nalUnit);
					if (sps && sps.maxDecFrameBuffering !== 0 && sps.bitstreamRestrictionFlag !== 1) {
						filteredNalUnits[i] = addAvcBitstreamRestriction(sps);
					}
				}
			}

			return concatAvcNalUnits(filteredNalUnits, this._decoderConfig);
		} else if (this._codec === 'hevc') {
			// Workaround for https://issues.chromium.org/issues/507611247
			return sanitizeHevcPacketForChromium(data, this._decoderConfig);
		} else {
			return null;
		}
	}

	/** @internal */
	_pushNullAlphaFrame() {
		if (this._alphaDecoderQueueSize === 0) {
			// Easy
			this._alphaQueue.push(null);
		} else {
			// There are still alpha chunks being decoded, so pushing `null` immediately would result in out-of-order
			// data and be incorrect. Instead, we need to enqueue a "null frame" for when the current decoder workload
			// has finished.
			this._nullAlphaFrameQueue.push(this._decodedAlphaChunkCount + this._alphaDecoderQueueSize);
		}
	}

	/**
	 * If we're using HEVC, we need to make sure to skip any RASL slices that follow a non-IDR key frame such as
	 * CRA_NUT. This is because RASL slices cannot be decoded without data before the CRA_NUT. Browsers behave
	 * differently here: Chromium drops the packets, Safari throws a decoder error. Either way, it's not good
	 * and causes bugs upstream. So, let's take the dropping into our own hands.
	 * @internal
	 */
	_hasHevcRaslPicture(packetData: Uint8Array) {
		for (const loc of iterateHevcNalUnits(packetData, this._decoderConfig)) {
			const type = extractNalUnitTypeForHevc(packetData[loc.offset]!);
			if (type === HevcNalUnitType.RASL_N || type === HevcNalUnitType.RASL_R) {
				return true;
			}
		}

		return false;
	}

	/** @internal */
	async _mergeAlpha(color: VideoFrame, alpha: VideoFrame | null) {
		const resolver = promiseWithResolvers();
		this._mergeAlphaPromises.push(resolver.promise);

		// Alpha merging is concurrent but the samples must still be emitted in the same order in which the merging
		// began. Therefore, serialize the results in an array.
		const result: { sample: VideoSample | null } = { sample: null };
		this._finalSamples.push(result);

		try {
			if (!alpha) {
				// Nothing needs to be merged
				result.sample = new VideoSample(color);
			} else {
				assert(this._merger);

				// The merger takes ownership of the frames, so no need to close them ourselves
				const finalFrame = await this._merger.merge(color, alpha);
				result.sample = new VideoSample(finalFrame);
			}

			// Emit any leading samples that are ready, preserving input order
			while (this._finalSamples.length > 0 && this._finalSamples[0]!.sample !== null) {
				const next = this._finalSamples.shift()!;
				this._sampleHandler(next.sample!);
			}
		} catch (error) {
			removeItem(this._finalSamples, result);

			// Samples that finished merging after this one were waiting on it and would be stuck forever otherwise
			while (this._finalSamples.length > 0 && this._finalSamples[0]!.sample !== null) {
				this._finalSamples.shift()!.sample!.close();
			}

			this._handleError(error);
		} finally {
			removeItem(this._mergeAlphaPromises, resolver.promise);
			resolver.resolve();
			this._handleDequeue();
		}
	}

	/**
	 * Handler for the WebCodecs VideoDecoder for ironing out browser differences.
	 * @internal
	 */
	_sampleHandler(sample: VideoSample) {
		if (isWebKit()) {
			// Safari keeps each frame's packet timestamp, but only to the microsecond and sometimes off by one, so we
			// take the timing of the packet with the closest timestamp
			const lowerIndex = binarySearchLessOrEqual(this._inputTimings, sample.timestamp, x => x.timestamp);
			let index = lowerIndex;
			if (
				lowerIndex + 1 < this._inputTimings.length
				&& (
					lowerIndex === -1
					|| this._inputTimings[lowerIndex + 1]!.timestamp - sample.timestamp
					< sample.timestamp - this._inputTimings[lowerIndex]!.timestamp
				)
			) {
				index = lowerIndex + 1;
			}

			if (index !== -1) {
				const timing = this._inputTimings[index]!;
				this._inputTimings.splice(index, 1);
				sample.setTimestamp(timing.timestamp);
				sample.setDuration(timing.duration);
			}

			// For correct B-frame handling, we don't just hand over the frames directly but instead add them to
			// a queue, because we want to ensure frames are emitted in presentation order. We flush the queue
			// each time we receive a frame with a timestamp larger than the highest we've seen so far, as we
			// can sure that is not a B-frame. Typically, WebCodecs automatically guarantees that frames are
			// emitted in presentation order, but Safari doesn't always follow this rule.
			if (this._sampleQueue.length > 0 && (sample.timestamp >= last(this._sampleQueue)!.timestamp)) {
				for (const sample of this._sampleQueue) {
					this._finalizeAndEmitSample(sample);
				}

				this._sampleQueue.length = 0;
			}

			insertSorted(this._sampleQueue, sample, x => x.timestamp);
		} else {
			// Assign it the next earliest timing from the input. We do this because browsers, by spec, are
			// required to emit decoded frames in presentation order *while* retaining the timestamp of their
			// originating EncodedVideoChunk. For files with B-frames but no out-of-order timestamps (like a
			// missing ctts box, for example), this causes a mismatch. We therefore fix the timestamps and
			// ensure they are sorted by doing this.
			const timing = this._inputTimings.shift();

			// There's no way we'd have more decoded frames than encoded packets we passed in. Actually, the
			// correspondence should be 1:1.
			assert(timing);

			sample.setTimestamp(timing.timestamp);
			sample.setDuration(timing.duration);
			this._finalizeAndEmitSample(sample);
		}
	}

	/** @internal */
	_finalizeAndEmitSample(sample: VideoSample) {
		sample.setRotation(this._rotation);
		sample.setFlip(this._flip);

		this._emitSample(sample);
	}

	/** @internal */
	_getDecoderQueueSize() {
		if (this._customDecoder) {
			return this._customDecoderQueueSize;
		} else {
			assert(this._decoder);

			return Math.max(
				this._decoder.decodeQueueSize,
				this._alphaDecoder?.decodeQueueSize ?? 0,
			) + this._finalSamples.length;
		}
	}

	/** @internal */
	_releaseDecoder() {
		if (this._customDecoder) {
			void this._customDecoderCallSerializer
				.call(() => this._customDecoder!.close())
				.catch(() => {});
		} else {
			assert(this._decoder);

			if (this._decoder.state !== 'closed') {
				this._decoder.close();
			}
			if (this._alphaDecoder && this._alphaDecoder.state !== 'closed') {
				this._alphaDecoder.close();
			}

			this._colorQueue.forEach(x => x.close());
			this._colorQueue.length = 0;
			this._alphaQueue.forEach(x => x?.close());
			this._alphaQueue.length = 0;

			this._merger?.close();
		}

		for (const sample of this._sampleQueue) {
			sample.close();
		}
		this._sampleQueue.length = 0;
	}

	/**
	 * This is a workaround for https://issues.chromium.org/issues/579043455. It circumvents the problem by instantly
	 * drawing a frame to a new region of GPU memory (a canvas), which we know for certain won't get fucked up by
	 * other draws.
	 * Also see: https://github.com/Vanilagy/mediabunny/issues/573
	 * @internal
	 */
	_copyFrameIfNeeded(frame: VideoFrame) {
		if (!isChromium() || !isAndroid()) {
			return frame;
		}

		const visibleRect = frame.visibleRect!;
		const width = visibleRect.width;
		const height = visibleRect.height;

		if (!this._frameCopyContext) {
			let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
			if (typeof OffscreenCanvas !== 'undefined') {
				context = new OffscreenCanvas(width, height).getContext('2d', { alpha: false });
			} else {
				context = document.createElement('canvas').getContext('2d', { alpha: false });
			}

			if (!context) {
				throw new Error('The \'2d\' canvas context is required to decode video on Chromium for Android.');
			}

			this._frameCopyContext = context;
		}

		const canvas = this._frameCopyContext.canvas;
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}

		// TODO: might need to make this more sophisticated once `rotation` and `flip` on VideoFrame are handled
		this._frameCopyContext.drawImage(frame, 0, 0, width, height);
		if (this._flushing) {
			// The draw only runs on the GPU later, so a codec reset could beat it and leave us copying a stale picture.
			// Reading back a pixel forces the draw to complete right now.
			this._frameCopyContext.getImageData(0, 0, 1, 1);
		}

		const copy = new VideoFrame(canvas, {
			timestamp: frame.timestamp,
			duration: frame.duration ?? undefined,
			displayWidth: frame.displayWidth,
			displayHeight: frame.displayHeight,
		});
		frame.close();

		return copy;
	}
}

/** Utility class that merges together color and alpha information on the CPU in a pool of workers. */
export class ColorAlphaMerger {
	private workers: Worker[] = [];
	private nextWorkerIndex = 0;
	private pendingRequests = new Map<number, ReturnType<typeof promiseWithResolvers<VideoFrame>>>();
	private nextRequestId = 0;

	merge(color: VideoFrame, alpha: VideoFrame): Promise<VideoFrame> {
		if (this.workers.length === 0) {
			const poolSize = clamp(navigator.hardwareConcurrency, 1, 4);
			for (let i = 0; i < poolSize; i++) {
				const worker = createWorker('color-alpha-merger', colorAlphaMergerWorkerCode);

				worker.addEventListener('message', (event: MessageEvent<ColorAlphaMergerWorkerResponse>) => {
					const data = event.data;
					const pending = this.pendingRequests.get(data.id);
					if (!pending) {
						if ('frame' in data) {
							data.frame.close(); // So it's still closed
						}

						return;
					}
					this.pendingRequests.delete(data.id);

					if ('error' in data) {
						pending.reject(new Error(data.error));
					} else {
						pending.resolve(data.frame);
					}
				});

				worker.addEventListener('error', (event) => {
					const error = new Error(event.message || 'Color/alpha merge worker error.');
					for (const pending of this.pendingRequests.values()) {
						pending.reject(error);
					}
					this.pendingRequests.clear();
				});

				this.workers.push(worker);
			}
		}

		const id = this.nextRequestId++;
		const pending = promiseWithResolvers<VideoFrame>();
		this.pendingRequests.set(id, pending);

		// Hand the job to the next worker in round-robin fashion
		const worker = this.workers[this.nextWorkerIndex]!;
		this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
		worker.postMessage({ id, color, alpha }, { transfer: [color, alpha] });

		return pending.promise;
	}

	close() {
		for (const worker of this.workers) {
			worker.terminate();
		}
		this.workers.length = 0;

		const error = new Error('Color/alpha merger closed.');
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

type ColorAlphaMergerWorkerRequest = {
	id: number;
	color: VideoFrame;
	alpha: VideoFrame;
};

type ColorAlphaMergerWorkerResponse =
	| { id: number; frame: VideoFrame }
	| { id: number; error: string };

export const colorAlphaMergerWorkerCode = () => {
	// These buffers are reused across frames as long as the size matches, since consecutive frames usually share
	// dimensions
	let cpuAlphaBuffer: Uint8Array | null = null;
	let cpuColorBuffer: Uint8Array | null = null;

	// Serialize execution internally so concurrent requests don't race on the shared cpu*Buffer state.
	let chain: Promise<void> = Promise.resolve();
	self.addEventListener('message', (event: MessageEvent<ColorAlphaMergerWorkerRequest>) => {
		const { id, color, alpha } = event.data;
		chain = chain.then(async () => {
			try {
				const frame = await merge(color, alpha);
				self.postMessage({ id, frame }, { transfer: [frame] });
			} catch (error) {
				self.postMessage({ id, error: (error as Error).message });
			} finally {
				// We took ownership of the inputs via transfer; close them now that the merge (or its error) is done.
				color.close();
				alpha.close();
			}
		});
	});

	const merge = async (color: VideoFrame, alpha: VideoFrame): Promise<VideoFrame> => {
		const format = color.format as VideoSamplePixelFormat | null;
		const alphaFormat = alpha.format as VideoSamplePixelFormat | null;
		if (!format || !alphaFormat) {
			throw new Error('CPU color/alpha merging requires a known VideoFrame format.');
		}

		// The alpha frame must have the same bit depth as the color frame
		const colorIs10 = format.includes('P10');
		const colorIs12 = format.includes('P12');
		const alphaIs10 = alphaFormat.includes('P10');
		const alphaIs12 = alphaFormat.includes('P12');
		if (alphaIs10 !== colorIs10 || alphaIs12 !== colorIs12) {
			throw new Error(
				`CPU color/alpha merging requires the alpha frame to have the same bit depth as the color frame`
				+ ` (color: '${format}', alpha: '${alphaFormat}').`,
			);
		}

		if (format === 'RGBX' || format === 'RGBA' || format === 'BGRX' || format === 'BGRA') {
			return await mergeInterleavedRgba(color, alpha, format);
		} else if (
			format === 'I420' || format === 'I420P10' || format === 'I420P12'
			|| format === 'I422' || format === 'I422P10' || format === 'I422P12'
			|| format === 'I444' || format === 'I444P10' || format === 'I444P12'
		) {
			return await mergePlanarYuv(color, alpha, format);
		} else if (format === 'NV12') {
			return await mergeNv12(color, alpha);
		}

		throw new Error(`CPU color/alpha merging does not support format '${format}'.`);
	};

	const mergeInterleavedRgba = async (
		color: VideoFrame,
		alpha: VideoFrame,
		format: 'RGBX' | 'RGBA' | 'BGRX' | 'BGRA',
	): Promise<VideoFrame> => {
		const width = color.visibleRect?.width ?? color.codedWidth;
		const height = color.visibleRect?.height ?? color.codedHeight;

		const pixelCount = width * height;
		const output = new Uint8Array(pixelCount * 4);

		// Color goes straight into the output buffer via copyTo, no intermediate copy needed
		await color.copyTo(output);

		// And now add the alpha data
		const alphaY = await readAlpha(alpha, width, height, 1);
		for (let i = 0, j = 3; i < pixelCount; i++, j += 4) {
			output[j] = alphaY[i]!;
		}

		const outputFormat = (format === 'RGBX' || format === 'RGBA') ? 'RGBA' : 'BGRA';
		const init = {
			format: outputFormat,
			codedWidth: width,
			codedHeight: height,
			displayWidth: color.displayWidth,
			displayHeight: color.displayHeight,
			colorSpace: color.colorSpace.toJSON(),
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
			transfer: [output.buffer],
		} as const;

		return new VideoFrame(output, init);
	};

	const mergePlanarYuv = async (
		color: VideoFrame,
		alpha: VideoFrame,
		format:
			| 'I420' | 'I420P10' | 'I420P12'
			| 'I422' | 'I422P10' | 'I422P12'
			| 'I444' | 'I444P10' | 'I444P12',
	): Promise<VideoFrame> => {
		const width = color.visibleRect?.width ?? color.codedWidth;
		const height = color.visibleRect?.height ?? color.codedHeight;

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

		const outputBytes = yBytes + 2 * uvBytes + aBytes;
		const output = new Uint8Array(outputBytes);

		// Write color planes directly into the output buffer via copyTo, no intermediate copy
		await color.copyTo(output);

		const alphaY = await readAlpha(alpha, width, height, bytesPerSample);
		const aOffset = yBytes + 2 * uvBytes;
		output.set(alphaY, aOffset);

		const outputFormat = (format.slice(0, 4) + 'A' + format.slice(4)) as VideoPixelFormat;

		const init = {
			format: outputFormat,
			codedWidth: width,
			codedHeight: height,
			displayWidth: color.displayWidth,
			displayHeight: color.displayHeight,
			colorSpace: color.colorSpace.toJSON(),
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
			transfer: [output.buffer],
		};

		return new VideoFrame(output, init);
	};

	const mergeNv12 = async (
		color: VideoFrame,
		alpha: VideoFrame,
	): Promise<VideoFrame> => {
		const width = color.visibleRect?.width ?? color.codedWidth;
		const height = color.visibleRect?.height ?? color.codedHeight;

		const ySize = width * height;
		const chromaW = Math.ceil(width / 2);
		const chromaH = Math.ceil(height / 2);
		const uvSize = chromaW * chromaH;

		const sourceSize = color.allocationSize();
		if (!cpuColorBuffer || cpuColorBuffer.byteLength !== sourceSize) {
			cpuColorBuffer = new Uint8Array(sourceSize);
		}
		await color.copyTo(cpuColorBuffer);

		const output = new Uint8Array(ySize + 2 * uvSize + ySize);

		// Y plane copies straight over
		output.set(cpuColorBuffer.subarray(0, ySize), 0);

		// Deinterleave the UV plane into separate U and V planes
		const uOffset = ySize;
		const vOffset = ySize + uvSize;
		const uvStart = ySize;
		for (let i = 0; i < uvSize; i++) {
			output[uOffset + i] = cpuColorBuffer[uvStart + i * 2]!;
			output[vOffset + i] = cpuColorBuffer[uvStart + i * 2 + 1]!;
		}

		const alphaY = await readAlpha(alpha, width, height, 1);
		output.set(alphaY, ySize + 2 * uvSize);

		const init = {
			format: 'I420A',
			codedWidth: width,
			codedHeight: height,
			displayWidth: color.displayWidth,
			displayHeight: color.displayHeight,
			colorSpace: color.colorSpace.toJSON(),
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
			transfer: [output.buffer],
		} as const;

		return new VideoFrame(output, init);
	};

	const readAlpha = async (alpha: VideoFrame, width: number, height: number, bytesPerSample: number) => {
		const size = alpha.allocationSize();
		if (!cpuAlphaBuffer || cpuAlphaBuffer.byteLength !== size) {
			cpuAlphaBuffer = new Uint8Array(size);
		}
		await alpha.copyTo(cpuAlphaBuffer);

		const format = alpha.format;
		if (format === 'RGBA' || format === 'BGRA' || format === 'RGBX' || format === 'BGRX') {
			// Pack alpha data tightly. Assume alpha is stored in RGB, so sample just from R for simplicity.
			const rOffset = (format === 'RGBA' || format === 'RGBX') ? 0 : 2;
			const pixelCount = width * height;
			for (let i = 0; i < pixelCount; i++) {
				cpuAlphaBuffer[i] = cpuAlphaBuffer[i * 4 + rOffset]!;
			}
			return cpuAlphaBuffer.subarray(0, pixelCount);
		} else {
			// For Y-plane-first formats (I*** and NV12), the leading width*height samples are the Y plane
			const yPlane = cpuAlphaBuffer.subarray(0, width * height * bytesPerSample);

			if (alpha.colorSpace.fullRange === false) {
				// Some decoders hand us limited-range alpha, so stretch it back out to full range
				const bitDepth = format!.includes('P12') ? 12 : format!.includes('P10') ? 10 : 8;
				const low = 16 << (bitDepth - 8);
				const high = 235 << (bitDepth - 8);
				const max = (1 << bitDepth) - 1;
				const samples = bytesPerSample === 2
					? new Uint16Array(yPlane.buffer, 0, width * height)
					: yPlane;

				for (let i = 0; i < samples.length; i++) {
					const value = Math.round((samples[i]! - low) * max / (high - low));
					samples[i] = Math.min(Math.max(value, 0), max);
				}
			}

			return yPlane;
		}
	};
};

const PCM_FORMAT_U8 = 0;
const PCM_FORMAT_S8 = 1;
const PCM_FORMAT_ULAW = 2;
const PCM_FORMAT_ALAW = 3;
const PCM_FORMAT_U16_LE = 4;
const PCM_FORMAT_U16_BE = 5;
const PCM_FORMAT_S16_LE = 6;
const PCM_FORMAT_S16_BE = 7;
const PCM_FORMAT_U24_LE = 8;
const PCM_FORMAT_U24_BE = 9;
const PCM_FORMAT_S24_LE = 10;
const PCM_FORMAT_S24_BE = 11;
const PCM_FORMAT_U32_LE = 12;
const PCM_FORMAT_U32_BE = 13;
const PCM_FORMAT_S32_LE = 14;
const PCM_FORMAT_S32_BE = 15;
const PCM_FORMAT_F32_LE = 16;
const PCM_FORMAT_F32_BE = 17;
const PCM_FORMAT_F64_LE = 18;
const PCM_FORMAT_F64_BE = 19;

export class AudioPacketDecoder extends PacketDecoder<AudioSample> {
	/** @internal */
	_codec: AudioCodec;
	/** @internal */
	_decoderConfig: AudioDecoderConfig;

	/** @internal */
	_decoder: AudioDecoder | null = null;

	/** @internal */
	_customDecoder: CustomAudioDecoder | null = null;
	/** @internal */
	_customDecoderCallSerializer = new CallSerializer();
	/** @internal */
	_customDecoderQueueSize = 0;

	// There are a lot of PCM variants not natively supported by the browser and by AudioData. Therefore we need a
	// simple decoder that maps any input PCM format into a PCM format supported by the browser.
	/** @internal */
	_isPcmDecoder = false;
	/** @internal */
	_pcmInputSampleSize = 0;
	/** @internal */
	_pcmInputFormat = PCM_FORMAT_U8;
	/** @internal */
	_pcmOutputSampleSize = 0;
	/** @internal */
	_pcmOutputSampleFormat: 'u8' | 's16' | 's32' | 'f32' | null = null;
	/** @internal */
	_pcmOutputFormat = PCM_FORMAT_U8;

	// Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
	// inaccurate) packet timestamps.
	/** @internal */
	_currentTimestamp: number | null = null;
	// Chromium does not respect negative packet timestamps, so we must do the fixin' ourselves
	/** @internal */
	_expectedFirstTimestamp: number | null = null;
	/** @internal */
	_timestampOffset = 0;
	// Index of the packet, since the last flush, whose timestamp the first decoded audio sample has
	/** @internal */
	_referencePacketIndex: number;
	/** @internal */
	_packetsSinceFlush = 0;
	/** @internal */
	_inputTimestampShift = 0;
	/** @internal */
	_opusPreSkip: number;

	constructor(config: ExtendedAudioDecoderConfig) {
		validateExtendedAudioDecoderConfig(config, 'Decoder configuration');

		super();

		const codec = inferCodecFromCodecString(config.codec) as AudioCodec;
		this._codec = codec;
		this._decoderConfig = config;

		// A Vorbis decoder outputs nada for the first packet it receives
		this._referencePacketIndex = codec === 'vorbis' ? 1 : 0;

		// WebCodecs impls discards the preskip (correct) but doesn't advance the timestamp (incorrect)
		this._opusPreSkip = codec === 'opus' && config.description
			? parseOpusIdentificationHeader(toUint8Array(config.description)).preSkip / OPUS_SAMPLE_RATE
			: 0;

		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
			this._isPcmDecoder = true;

			const { dataType, sampleSize, littleEndian } = parsePcmCodec(codec as PcmAudioCodec);
			this._pcmInputSampleSize = sampleSize;

			switch (sampleSize) {
				case 1: {
					if (dataType === 'unsigned') {
						this._pcmInputFormat = PCM_FORMAT_U8;
					} else if (dataType === 'signed') {
						this._pcmInputFormat = PCM_FORMAT_S8;
					} else if (dataType === 'ulaw') {
						this._pcmInputFormat = PCM_FORMAT_ULAW;
					} else if (dataType === 'alaw') {
						this._pcmInputFormat = PCM_FORMAT_ALAW;
					} else {
						assert(false);
					}
				}; break;
				case 2: {
					if (dataType === 'unsigned') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_U16_LE : PCM_FORMAT_U16_BE;
					} else if (dataType === 'signed') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_S16_LE : PCM_FORMAT_S16_BE;
					} else {
						assert(false);
					}
				}; break;
				case 3: {
					if (dataType === 'unsigned') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_U24_LE : PCM_FORMAT_U24_BE;
					} else if (dataType === 'signed') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_S24_LE : PCM_FORMAT_S24_BE;
					} else {
						assert(false);
					}
				}; break;
				case 4: {
					if (dataType === 'unsigned') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_U32_LE : PCM_FORMAT_U32_BE;
					} else if (dataType === 'signed') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_S32_LE : PCM_FORMAT_S32_BE;
					} else if (dataType === 'float') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_F32_LE : PCM_FORMAT_F32_BE;
					} else {
						assert(false);
					}
				}; break;
				case 8: {
					if (dataType === 'float') {
						this._pcmInputFormat = littleEndian ? PCM_FORMAT_F64_LE : PCM_FORMAT_F64_BE;
					} else {
						assert(false);
					}
				}; break;
				default: {
					assertNever(sampleSize);
					assert(false);
				};
			}

			switch (sampleSize) {
				case 1: {
					if (dataType === 'ulaw' || dataType === 'alaw') {
						this._pcmOutputSampleSize = 2;
						this._pcmOutputSampleFormat = 's16';
						this._pcmOutputFormat = PCM_FORMAT_S16_LE;
					} else {
						this._pcmOutputSampleSize = 1;
						this._pcmOutputSampleFormat = 'u8';
						this._pcmOutputFormat = PCM_FORMAT_U8;
					}
				}; break;
				case 2: {
					this._pcmOutputSampleSize = 2;
					this._pcmOutputSampleFormat = 's16';
					this._pcmOutputFormat = PCM_FORMAT_S16_LE;
				}; break;
				case 3: {
					this._pcmOutputSampleSize = 4;
					this._pcmOutputSampleFormat = 's32';
					// From https://www.w3.org/TR/webcodecs:
					// AudioData containing 24-bit samples SHOULD store those samples in s32 or f32. When samples are
					// stored in s32, each sample MUST be left-shifted by 8 bits.
					this._pcmOutputFormat = PCM_FORMAT_S24_LE;
				}; break;
				case 4: {
					this._pcmOutputSampleSize = 4;

					if (dataType === 'float') {
						this._pcmOutputSampleFormat = 'f32';
						this._pcmOutputFormat = PCM_FORMAT_F32_LE;
					} else {
						this._pcmOutputSampleFormat = 's32';
						this._pcmOutputFormat = PCM_FORMAT_S32_LE;
					}
				}; break;
				case 8: {
					this._pcmOutputSampleSize = 4;

					this._pcmOutputSampleFormat = 'f32';
					this._pcmOutputFormat = PCM_FORMAT_F32_LE;
				}; break;
				default: {
					assertNever(sampleSize);
					assert(false);
				};
			};
		} else {
			const MatchingCustomDecoder = customAudioDecoders.find(x => x.supports(codec, config));
			if (MatchingCustomDecoder) {
				// @ts-expect-error "Can't create instance of abstract class 🤓"
				this._customDecoder = new MatchingCustomDecoder() as CustomAudioDecoder;
				// @ts-expect-error It's technically readonly
				this._customDecoder.codec = codec;
				// @ts-expect-error It's technically readonly
				this._customDecoder.config = config;
				// @ts-expect-error It's technically readonly
				this._customDecoder.onSample = (sample) => {
					if (!(sample instanceof AudioSample)) {
						throw new TypeError('The argument passed to onSample must be an AudioSample.');
					}

					this._handleSample(sample);
				};
				// @ts-expect-error It's technically readonly
				this._customDecoder.onError = (error) => {
					this._handleError(error);
				};

				void this._customDecoderCallSerializer
					.call(() => this._customDecoder!.init())
					.catch(error => this._handleError(error));
			} else {
				const stack = new Error('Decoding error').stack;

				this._decoder = new AudioDecoder({
					output: (data) => {
						try {
							this._handleSample(new AudioSample(data));
						} catch (error) {
							this._handleError(error);
						}
					},
					error: (error) => {
						error.stack = stack; // Provide a more useful stack trace, the default one sucks
						this._handleError(error);
					},
				});
				this._decoder.addEventListener('dequeue', () => {
					this._handleDequeue();
				});
				this._decoder.configure(config);
			}
		}
	}

	/** @internal */
	_decodePacket(packet: EncodedPacket) {
		if (this._isPcmDecoder) {
			const inputFormat = this._pcmInputFormat;
			const outputFormat = this._pcmOutputFormat;
			const outputSampleFormat = this._pcmOutputSampleFormat;
			assert(outputSampleFormat);

			const inputView = toDataView(packet.data);
			const { numberOfChannels, sampleRate } = this._decoderConfig;

			// A trailing partial frame (only in malformed files) gets dropped
			const numberOfFrames = Math.floor(packet.byteLength / numberOfChannels / this._pcmInputSampleSize);
			if (numberOfFrames === 0) {
				// Skip empty samples, just like the regular decoder does
				return;
			}

			const valueCount = numberOfFrames * numberOfChannels;
			const outputBufferSize = valueCount * this._pcmOutputSampleSize;
			const outputBuffer = new ArrayBuffer(outputBufferSize);
			const outputView = new DataView(outputBuffer);

			// This loop is plenty fast. The important thing is that the switches use integer keys and not strings.
			for (let i = 0; i < valueCount; i++) {
				let value = 0;

				switch (inputFormat) {
					case PCM_FORMAT_U8: {
						value = inputView.getUint8(i) - 2 ** 7;
					}; break;
					case PCM_FORMAT_S8: {
						value = inputView.getInt8(i);
					}; break;
					case PCM_FORMAT_ULAW: {
						value = fromUlaw(inputView.getUint8(i));
					}; break;
					case PCM_FORMAT_ALAW: {
						value = fromAlaw(inputView.getUint8(i));
					}; break;
					case PCM_FORMAT_U16_LE: {
						value = inputView.getUint16(2 * i, true) - 2 ** 15;
					}; break;
					case PCM_FORMAT_U16_BE: {
						value = inputView.getUint16(2 * i, false) - 2 ** 15;
					}; break;
					case PCM_FORMAT_S16_LE: {
						value = inputView.getInt16(2 * i, true);
					}; break;
					case PCM_FORMAT_S16_BE: {
						value = inputView.getInt16(2 * i, false);
					}; break;
					case PCM_FORMAT_U24_LE: {
						value = getUint24(inputView, 3 * i, true) - 2 ** 23;
					}; break;
					case PCM_FORMAT_U24_BE: {
						value = getUint24(inputView, 3 * i, false) - 2 ** 23;
					}; break;
					case PCM_FORMAT_S24_LE: {
						value = getInt24(inputView, 3 * i, true);
					}; break;
					case PCM_FORMAT_S24_BE: {
						value = getInt24(inputView, 3 * i, false);
					}; break;
					case PCM_FORMAT_U32_LE: {
						value = inputView.getUint32(4 * i, true) - 2 ** 31;
					}; break;
					case PCM_FORMAT_U32_BE: {
						value = inputView.getUint32(4 * i, false) - 2 ** 31;
					}; break;
					case PCM_FORMAT_S32_LE: {
						value = inputView.getInt32(4 * i, true);
					}; break;
					case PCM_FORMAT_S32_BE: {
						value = inputView.getInt32(4 * i, false);
					}; break;
					case PCM_FORMAT_F32_LE: {
						value = inputView.getFloat32(4 * i, true);
					}; break;
					case PCM_FORMAT_F32_BE: {
						value = inputView.getFloat32(4 * i, false);
					}; break;
					case PCM_FORMAT_F64_LE: {
						value = inputView.getFloat64(8 * i, true);
					}; break;
					case PCM_FORMAT_F64_BE: {
						value = inputView.getFloat64(8 * i, false);
					}; break;
				}

				switch (outputFormat) {
					case PCM_FORMAT_U8: {
						outputView.setUint8(i, value + 2 ** 7);
					}; break;
					case PCM_FORMAT_S16_LE: {
						outputView.setInt16(2 * i, value, true);
					}; break;
					case PCM_FORMAT_S24_LE: {
						outputView.setInt32(4 * i, value << 8, true);
					}; break;
					case PCM_FORMAT_S32_LE: {
						outputView.setInt32(4 * i, value, true);
					}; break;
					case PCM_FORMAT_F32_LE: {
						outputView.setFloat32(4 * i, value, true);
					}; break;
				}
			}

			const preciseDuration = numberOfFrames / sampleRate;
			if (
				this._currentTimestamp === null
				|| Math.abs(packet.timestamp - this._currentTimestamp) >= preciseDuration
			) {
				// We need to sync with the packet timestamp again
				this._currentTimestamp = packet.timestamp;
			}

			const preciseTimestamp = this._currentTimestamp;
			this._currentTimestamp += preciseDuration;

			this._emitSample(new AudioSample({
				format: outputSampleFormat,
				data: outputBuffer,
				numberOfChannels,
				sampleRate,
				numberOfFrames,
				timestamp: roundToDivisor(preciseTimestamp, sampleRate),
				_doNotCopy: true,
			}));
		} else if (this._customDecoder) {
			this._customDecoderQueueSize++;
			void this._customDecoderCallSerializer
				.call(() => this._customDecoder!.decode(packet))
				.catch(error => this._handleError(error))
				.finally(() => {
					this._customDecoderQueueSize--;
					this._handleDequeue();
				});
		} else {
			assert(this._decoder);

			if (this._packetsSinceFlush === 0) {
				this._inputTimestampShift = -packet.timestamp;
			}
			if (this._packetsSinceFlush === this._referencePacketIndex) {
				this._expectedFirstTimestamp = packet.timestamp;
			}
			this._packetsSinceFlush++;

			// Some decoders mishandle negative or otherwise unusual timestamps, so we always feed them a stream that
			// starts at zero. Their output gets rebased onto expectedFirstTimestamp anyway.
			// See https://github.com/Vanilagy/mediabunny/issues/653
			const shiftedPacket = packet.clone({ timestamp: packet.timestamp + this._inputTimestampShift });
			this._decoder.decode(shiftedPacket.toEncodedAudioChunk());
		}
	}

	/** @internal */
	async _flush() {
		if (this._customDecoder) {
			await this._customDecoderCallSerializer.call(() => this._customDecoder!.flush());
		} else if (!this._isPcmDecoder) {
			assert(this._decoder);
			await this._decoder.flush();
		}

		this._currentTimestamp = null;
		this._expectedFirstTimestamp = null;
		this._packetsSinceFlush = 0;
		this._inputTimestampShift = 0;
		this._timestampOffset = 0;
	}

	/** @internal */
	_handleSample(sample: AudioSample) {
		if (sample.numberOfFrames === 0) {
			// We skip zero-data (empty) AudioSamples. These are sometimes emitted, for example, by Firefox when it
			// decodes Vorbis (at the start). Skip them before they can anchor the timestamp offset.
			sample.close();
			return;
		}

		let sampleTimestamp = sample.timestamp;

		if (this._expectedFirstTimestamp !== null && this._currentTimestamp === null) {
			this._timestampOffset = this._expectedFirstTimestamp + this._opusPreSkip - sampleTimestamp;
		}

		sampleTimestamp += this._timestampOffset;

		if (
			this._currentTimestamp === null
			|| Math.abs(sampleTimestamp - this._currentTimestamp) >= sample.duration
		) {
			// We need to sync with the sample timestamp again
			this._currentTimestamp = sampleTimestamp;
		}

		const preciseTimestamp = this._currentTimestamp;
		this._currentTimestamp += sample.duration;

		// Round the timestamp to the sample rate
		const sampleRate = this._decoderConfig.sampleRate;
		sample.setTimestamp(Math.round(preciseTimestamp * sampleRate) / sampleRate);

		this._emitSample(sample);
	}

	/** @internal */
	_getDecoderQueueSize() {
		if (this._isPcmDecoder) {
			return 0;
		} else if (this._customDecoder) {
			return this._customDecoderQueueSize;
		} else {
			assert(this._decoder);
			return this._decoder.decodeQueueSize;
		}
	}

	/** @internal */
	_releaseDecoder() {
		if (this._customDecoder) {
			void this._customDecoderCallSerializer
				.call(() => this._customDecoder!.close())
				.catch(() => {});
		} else if (!this._isPcmDecoder) {
			assert(this._decoder);

			if (this._decoder.state !== 'closed') {
				this._decoder.close();
			}
		}
	}
}

/**
 * Checks if the browser is able to decode the given codec.
 * @group Decoding
 * @public
 */
export const canDecode = async (codec: MediaCodec) => {
	if ((VIDEO_CODECS as readonly string[]).includes(codec)) {
		return canDecodeVideo(codec as VideoCodec);
	} else if ((AUDIO_CODECS as readonly string[]).includes(codec)) {
		return canDecodeAudio(codec as AudioCodec);
	}

	return false;
};

export const canDecodeVideoMemo = new Map<string, Promise<boolean>>();

/**
 * Checks if the browser is able to decode the given video codec with the given parameters.
 * @group Decoding
 * @public
 */
export const canDecodeVideo = async (
	codec: VideoCodec,
	options: SetOptional<ExtendedVideoDecoderConfig, 'type' | 'codec'> = {},
) => {
	if (!VIDEO_CODECS.includes(codec)) {
		return false;
	}

	validateExtendedVideoDecoderConfig(options, 'options', { type: true, codec: true });
	if (options.codec !== undefined && inferCodecFromCodecString(options.codec) !== codec) {
		throw new TypeError(`options.codec, when provided, must match the specified codec (${codec}).`);
	}

	const codedWidth = options.codedWidth ?? 1280;
	const codedHeight = options.codedHeight ?? 720;
	const resolvedOptions: ExtendedVideoDecoderConfig = {
		...options,
		type: 'video',
		codedWidth,
		codedHeight,
		codec: options.codec ?? buildVideoCodecString(codec, codedWidth, codedHeight, 1e6, false),
	};
	resolvedOptions.description ??= guessDescriptionForVideo(resolvedOptions);

	const key = getDecoderConfigMemoKey(resolvedOptions);
	const memoized = canDecodeVideoMemo.get(key);
	if (memoized) {
		return memoized;
	}

	const promise = (async () => {
		if (customVideoDecoders.some(x => x.supports(codec, resolvedOptions))) {
			return true;
		}
		if (typeof VideoDecoder === 'undefined') {
			return false;
		}

		const support = await VideoDecoder.isConfigSupported(resolvedOptions);
		return support.supported === true;
	})();
	canDecodeVideoMemo.set(key, promise);

	return promise;
};

export const canDecodeAudioMemo = new Map<string, Promise<boolean>>();

/**
 * Checks if the browser is able to decode the given audio codec with the given parameters.
 * @group Decoding
 * @public
 */
export const canDecodeAudio = async (
	codec: AudioCodec,
	options: SetOptional<ExtendedAudioDecoderConfig, 'type' | 'codec' | 'numberOfChannels' | 'sampleRate'> = {},
) => {
	if (!AUDIO_CODECS.includes(codec)) {
		return false;
	}

	validateExtendedAudioDecoderConfig(options, 'options', {
		type: true,
		codec: true,
		numberOfChannels: true,
		sampleRate: true,
	});
	if (options.codec !== undefined && inferCodecFromCodecString(options.codec) !== codec) {
		throw new TypeError(`options.codec, when provided, must match the specified codec (${codec}).`);
	}

	const resolvedOptions: ExtendedAudioDecoderConfig = {
		...options,
		type: 'audio',
		numberOfChannels: options.numberOfChannels ?? 2,
		sampleRate: options.sampleRate ?? 48000,
		codec: options.codec ?? buildAudioCodecString(codec),
	};

	if (resolvedOptions.description === undefined) {
		const generatedDescription = guessDescriptionForAudio(resolvedOptions);
		if (generatedDescription === false) {
			return false;
		}

		resolvedOptions.description = generatedDescription;
	}

	const key = getDecoderConfigMemoKey(resolvedOptions);
	const memoized = canDecodeAudioMemo.get(key);
	if (memoized) {
		return memoized;
	}

	const promise = (async () => {
		if (customAudioDecoders.some(x => x.supports(codec, resolvedOptions))) {
			return true;
		}
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
			return true;
		}
		if (typeof AudioDecoder === 'undefined') {
			return false;
		}

		const support = await AudioDecoder.isConfigSupported(resolvedOptions);
		return support.supported === true;
	})();
	canDecodeAudioMemo.set(key, promise);

	return promise;
};

const getDecoderConfigMemoKey = (config: VideoDecoderConfig | AudioDecoderConfig) => JSON.stringify({
	...config,
	description: config.description && [...toUint8Array(config.description)], // So it gets serialized properly
});

/**
 * Returns the list of all media codecs that can be decoded by the browser.
 * @group Decoding
 * @public
 */
export const getDecodableCodecs = async (): Promise<MediaCodec[]> => {
	const [videoCodecs, audioCodecs] = await Promise.all([
		getDecodableVideoCodecs(),
		getDecodableAudioCodecs(),
	]);

	return [...videoCodecs, ...audioCodecs];
};

/**
 * Returns the list of all video codecs that can be decoded by the browser.
 * @group Decoding
 * @public
 */
export const getDecodableVideoCodecs = async (
	checkedCodecs: VideoCodec[] = VIDEO_CODECS as unknown as VideoCodec[],
	options?: SetOptional<ExtendedVideoDecoderConfig, 'type' | 'codec'>,
): Promise<VideoCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canDecodeVideo(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the list of all audio codecs that can be decoded by the browser.
 * @group Decoding
 * @public
 */
export const getDecodableAudioCodecs = async (
	checkedCodecs: AudioCodec[] = AUDIO_CODECS as unknown as AudioCodec[],
	options?: SetOptional<ExtendedAudioDecoderConfig, 'type' | 'codec' | 'numberOfChannels' | 'sampleRate'>,
): Promise<AudioCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canDecodeAudio(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};
