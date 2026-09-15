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
	isBuiltInAudioCodec,
	isBuiltInVideoCodec,
	SUBTITLE_CODECS,
	VALID_AUDIO_CODEC_STRING_PREFIXES,
	VALID_VIDEO_CODEC_STRING_PREFIXES,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { canDecodeAudioMemo, canDecodeVideoMemo } from './decode';
import { canEncodeAudioMemo, canEncodeVideoMemo } from './encode';
import { Logging } from './logging';
import { PacketType } from './packet';

/**
 * Options for registering a codec name.
 * @group Codecs
 * @public
 */
export type CodecRegistrationOptions = {
	/** Removes the registration when aborted. An already-aborted signal leaves the registry unchanged. */
	signal?: AbortSignal;
};

/**
 * Options for registering a video codec name.
 * @group Codecs
 * @public
 */
export type VideoCodecRegistrationOptions = CodecRegistrationOptions & {
	/**
	 * Determines a packet's type from its encoded bytes, or returns null if it cannot be determined. It is called with
	 * the track's decoder configuration when reading, and with the configuration the encoder emitted when writing.
	 * Anything it throws reaches the caller, and returning something other than a packet type or null is an error.
	 */
	determinePacketType?: (data: Uint8Array, config: VideoDecoderConfig) => PacketType | null;
};

export const registeredVideoCodecs = new Map<string, VideoCodecRegistrationOptions>();
export const registeredAudioCodecs = new Map<string, CodecRegistrationOptions>();

const CODEC_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

// Evaluated lazily: this module and codec.ts import each other
const hasCodecNameShape = (codec: unknown): codec is string => {
	return typeof codec === 'string' && CODEC_NAME_REGEX.test(codec);
};

const isBuiltInCodecName = (codec: string) => {
	return isBuiltInVideoCodec(codec)
		|| isBuiltInAudioCodec(codec)
		|| (SUBTITLE_CODECS as readonly string[]).includes(codec);
};

const usesBuiltInCodecStringPrefix = (codec: string) => {
	// If a registered name looked like a built-in codec string, codec string inference would mistake it for one
	return [...VALID_VIDEO_CODEC_STRING_PREFIXES, ...VALID_AUDIO_CODEC_STRING_PREFIXES]
		.some(prefix => codec.startsWith(prefix));
};

export const isCustomCodecName = (codec: unknown): codec is string => {
	return hasCodecNameShape(codec) && !isBuiltInCodecName(codec) && !usesBuiltInCodecStringPrefix(codec);
};

export const isVideoCodec = (codec: string | null) => {
	return codec !== null && (isBuiltInVideoCodec(codec) || registeredVideoCodecs.has(codec));
};

export const isAudioCodec = (codec: string | null) => {
	return codec !== null && (isBuiltInAudioCodec(codec) || registeredAudioCodecs.has(codec));
};

// A custom coder's supports() may consult either registry, so every name change can affect both kinds
const clearCodecMemos = () => {
	canDecodeVideoMemo.clear();
	canEncodeVideoMemo.clear();
	canDecodeAudioMemo.clear();
	canEncodeAudioMemo.clear();
};

const validateCodecName = (codec: string) => {
	if (typeof codec !== 'string') {
		throw new TypeError('codec must be a string.');
	}
	if (!CODEC_NAME_REGEX.test(codec)) {
		throw new TypeError('codec must contain lowercase letters, digits or hyphens and start with a letter.');
	}
	if (isBuiltInCodecName(codec)) {
		throw new TypeError('codec must not be a built-in codec.');
	}
	if (usesBuiltInCodecStringPrefix(codec)) {
		throw new TypeError('codec must not use a built-in codec string prefix.');
	}
};

// The signal is read once: a getter could otherwise run between the checks below and change what they saw
const validateOptions = (options: CodecRegistrationOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}

	const signal = options.signal;
	if (signal !== undefined && !(signal instanceof AbortSignal)) {
		throw new TypeError('options.signal, when provided, must be an AbortSignal.');
	}

	return signal;
};

const register = <T extends CodecRegistrationOptions>(
	registry: Map<string, T>,
	otherRegistry: Map<string, CodecRegistrationOptions>,
	codec: string,
	options: T,
	signal: AbortSignal | undefined,
) => {
	if (otherRegistry.has(codec)) {
		throw new TypeError('codec must not already be registered for the other media kind.');
	}

	if (registry.has(codec)) {
		Logging._warn(`Codec '${codec}' already registered.`);
		return () => {};
	}

	let active = false;
	const unregister = () => {
		if (active) {
			registry.delete(codec);
			clearCodecMemos();
			active = false;
		}

		signal?.removeEventListener('abort', unregister);
	};
	if (!signal?.aborted) {
		registry.set(codec, options);
		clearCodecMemos();
		active = true;
		signal?.addEventListener('abort', unregister, { once: true });
	}

	return unregister;
};

/**
 * Registers a video codec name, which lets encoders, outputs and capability checks accept it. Returns a function that
 * removes the registration. Decoders, encoders and container mappings must be provided separately.
 * @group Codecs
 * @public
 */
export const registerVideoCodec = (codec: VideoCodec, options: VideoCodecRegistrationOptions = {}) => {
	validateCodecName(codec);
	const signal = validateOptions(options);

	const determinePacketType = options.determinePacketType;
	if (determinePacketType !== undefined && typeof determinePacketType !== 'function') {
		throw new TypeError('options.determinePacketType, when provided, must be a function.');
	}

	return register(registeredVideoCodecs, registeredAudioCodecs, codec, options, signal);
};

/**
 * Registers an audio codec name. Returns a function that removes the registration. As with
 * {@link registerVideoCodec}, a decoder or encoder must be registered separately.
 * @group Codecs
 * @public
 */
export const registerAudioCodec = (codec: AudioCodec, options: CodecRegistrationOptions = {}) => {
	validateCodecName(codec);
	const signal = validateOptions(options);

	return register(registeredAudioCodecs, registeredVideoCodecs, codec, options, signal);
};

/**
 * Returns the built-in video codec names, followed by the registered ones.
 * @group Codecs
 * @public
 */
export const getAllVideoCodecs = (): VideoCodec[] => [...VIDEO_CODECS, ...registeredVideoCodecs.keys()];

/**
 * Returns the built-in audio codec names, followed by the registered ones.
 * @group Codecs
 * @public
 */
export const getAllAudioCodecs = (): AudioCodec[] => [...AUDIO_CODECS, ...registeredAudioCodecs.keys()];
