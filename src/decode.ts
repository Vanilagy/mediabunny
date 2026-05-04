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
	guessDescriptionForAudio,
	guessDescriptionForVideo,
	inferCodecFromCodecString,
	MediaCodec,
	PCM_AUDIO_CODECS,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { customAudioDecoders, customVideoDecoders } from './custom-coder';
import { isAllowSharedBufferSource, SetOptional } from './misc';

export const canDecodeVideoMemo = new Map<string, Promise<boolean>>();
export const canDecodeAudioMemo = new Map<string, Promise<boolean>>();

const validateVideoDecodingConfig = (codec: VideoCodec, options: SetOptional<VideoDecoderConfig, 'codec'>) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.codec !== undefined && typeof options.codec !== 'string') {
		throw new TypeError('options.codec, when provided, must be a string.');
	}
	if (options.codec !== undefined && inferCodecFromCodecString(options.codec) !== codec) {
		throw new TypeError(`options.codec, when provided, must match the specified codec (${codec}).`);
	}
	if (
		options.codedWidth !== undefined
		&& (!Number.isInteger(options.codedWidth) || options.codedWidth <= 0)
	) {
		throw new TypeError('options.codedWidth, when provided, must be a positive integer.');
	}
	if (
		options.codedHeight !== undefined
		&& (!Number.isInteger(options.codedHeight) || options.codedHeight <= 0)
	) {
		throw new TypeError('options.codedHeight, when provided, must be a positive integer.');
	}
	if (
		options.displayAspectWidth !== undefined
		&& (!Number.isInteger(options.displayAspectWidth) || options.displayAspectWidth <= 0)
	) {
		throw new TypeError('options.displayAspectWidth, when provided, must be a positive integer.');
	}
	if (
		options.displayAspectHeight !== undefined
		&& (!Number.isInteger(options.displayAspectHeight) || options.displayAspectHeight <= 0)
	) {
		throw new TypeError('options.displayAspectHeight, when provided, must be a positive integer.');
	}
	if (options.description !== undefined && !isAllowSharedBufferSource(options.description)) {
		throw new TypeError('options.description, when provided, must be a buffer source.');
	}
	if (
		options.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(options.hardwareAcceleration)
	) {
		throw new TypeError(
			'options.hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
			+ ' \'prefer-software\'.',
		);
	}
	if (options.optimizeForLatency !== undefined && typeof options.optimizeForLatency !== 'boolean') {
		throw new TypeError('options.optimizeForLatency, when provided, must be a boolean.');
	}
};

const validateAudioDecodingConfig = (
	codec: AudioCodec,
	options: SetOptional<AudioDecoderConfig, 'codec' | 'numberOfChannels' | 'sampleRate'>,
) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.codec !== undefined && typeof options.codec !== 'string') {
		throw new TypeError('options.codec, when provided, must be a string.');
	}
	if (options.codec !== undefined && inferCodecFromCodecString(options.codec) !== codec) {
		throw new TypeError(`options.codec, when provided, must match the specified codec (${codec}).`);
	}
	if (
		options.numberOfChannels !== undefined
		&& (!Number.isInteger(options.numberOfChannels) || options.numberOfChannels <= 0)
	) {
		throw new TypeError('options.numberOfChannels, when provided, must be a positive integer.');
	}
	if (
		options.sampleRate !== undefined
		&& (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0)
	) {
		throw new TypeError('options.sampleRate, when provided, must be a positive integer.');
	}
	if (options.description !== undefined && !isAllowSharedBufferSource(options.description)) {
		throw new TypeError('options.description, when provided, must be a buffer source.');
	}
};

/**
 * Checks if the browser is able to decode the given codec.
 * @group Decoding
 * @public
 */
export const canDecode = (codec: MediaCodec) => {
	if ((VIDEO_CODECS as readonly string[]).includes(codec)) {
		return canDecodeVideo(codec as VideoCodec);
	} else if ((AUDIO_CODECS as readonly string[]).includes(codec)) {
		return canDecodeAudio(codec as AudioCodec);
	}

	return false;
};

/**
 * Checks if the browser is able to decode the given video codec with the given parameters.
 * @group Decoding
 * @public
 */
export const canDecodeVideo = async (
	codec: VideoCodec,
	options: SetOptional<VideoDecoderConfig, 'codec'> = {},
) => {
	if (!VIDEO_CODECS.includes(codec)) {
		return false;
	}

	validateVideoDecodingConfig(codec, options);

	const resolvedOptions: VideoDecoderConfig = {
		...options,
		codedWidth: options.codedWidth ?? 1280,
		codedHeight: options.codedHeight ?? 720,
		codec: options.codec ?? buildVideoCodecString(codec, 1280, 720, 1e6),
	};
	resolvedOptions.description ??= guessDescriptionForVideo(resolvedOptions);

	const key = JSON.stringify(resolvedOptions);
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

/**
 * Checks if the browser is able to decode the given audio codec with the given parameters.
 * @group Decoding
 * @public
 */
export const canDecodeAudio = async (
	codec: AudioCodec,
	options: SetOptional<AudioDecoderConfig, 'codec' | 'numberOfChannels' | 'sampleRate'> = {},
) => {
	if (!AUDIO_CODECS.includes(codec)) {
		return false;
	}

	validateAudioDecodingConfig(codec, options);

	const resolvedOptions: AudioDecoderConfig = {
		...options,
		numberOfChannels: options.numberOfChannels ?? 2,
		sampleRate: options.sampleRate ?? 48000,
		codec: options.codec ?? buildAudioCodecString(codec, 2, 48000),
	};

	if (resolvedOptions.description === undefined) {
		const generatedDescription = guessDescriptionForAudio(resolvedOptions);
		if (generatedDescription === false) {
			return false;
		}

		resolvedOptions.description = generatedDescription;
	}

	const key = JSON.stringify(resolvedOptions);
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
	options?: SetOptional<VideoDecoderConfig, 'codec'>,
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
	options?: SetOptional<AudioDecoderConfig, 'codec' | 'numberOfChannels' | 'sampleRate'>,
): Promise<AudioCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canDecodeAudio(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};
