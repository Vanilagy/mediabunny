/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, VideoCodec } from './codec';
import { MaybePromise } from './misc';
import { EncodedPacket } from './packet';
import { AudioSample, VideoSample } from './sample';

/**
 * Base class for custom video decoders. To add your own custom video decoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the decoder using {@link registerDecoder}.
 * @group Custom coders
 * @public
 */
export abstract class CustomVideoDecoder {
	/** The input video's codec. */
	readonly codec!: VideoCodec;
	/** The input video's decoder config. */
	readonly config!: VideoDecoderConfig;
	/** The callback to call when a decoded VideoSample is available. */
	readonly onSample!: (sample: VideoSample) => unknown;

	/** Returns true if and only if the decoder can decode the given codec configuration. */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
		return false;
	}

	/** Called after decoder creation; can be used for custom initialization logic. */
	abstract init(): MaybePromise<void>;
	/** Decodes the provided encoded packet. */
	abstract decode(packet: EncodedPacket): MaybePromise<void>;
	/** Decodes all remaining packets and then resolves. */
	abstract flush(): MaybePromise<void>;
	/** Called when the decoder is no longer needed and its resources can be freed. */
	abstract close(): MaybePromise<void>;
}

/**
 * Base class for custom audio decoders. To add your own custom audio decoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the decoder using {@link registerDecoder}.
 * @group Custom coders
 * @public
 */
export abstract class CustomAudioDecoder {
	/** The input audio's codec. */
	readonly codec!: AudioCodec;
	/** The input audio's decoder config. */
	readonly config!: AudioDecoderConfig;
	/** The callback to call when a decoded AudioSample is available. */
	readonly onSample!: (sample: AudioSample) => unknown;

	/** Returns true if and only if the decoder can decode the given codec configuration. */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static supports(codec: AudioCodec, config: AudioDecoderConfig): boolean {
		return false;
	}

	/** Called after decoder creation; can be used for custom initialization logic. */
	abstract init(): MaybePromise<void>;
	/** Decodes the provided encoded packet. */
	abstract decode(packet: EncodedPacket): MaybePromise<void>;
	/** Decodes all remaining packets and then resolves. */
	abstract flush(): MaybePromise<void>;
	/** Called when the decoder is no longer needed and its resources can be freed. */
	abstract close(): MaybePromise<void>;
}

/**
 * Base class for custom video encoders. To add your own custom video encoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the encoder using {@link registerEncoder}.
 * @group Custom coders
 * @public
 */
export abstract class CustomVideoEncoder {
	/** The codec with which to encode the video. */
	readonly codec!: VideoCodec;
	/** Config for the encoder. */
	readonly config!: VideoEncoderConfig;
	/** The callback to call when an EncodedPacket is available. */
	readonly onPacket!: (packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) => unknown;

	/** Returns true if and only if the encoder can encode the given codec configuration. */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		return false;
	}

	/** Called after encoder creation; can be used for custom initialization logic. */
	abstract init(): MaybePromise<void>;
	/** Encodes the provided video sample. */
	abstract encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions): MaybePromise<void>;
	/** Encodes all remaining video samples and then resolves. */
	abstract flush(): MaybePromise<void>;
	/** Called when the encoder is no longer needed and its resources can be freed. */
	abstract close(): MaybePromise<void>;
}

/**
 * Base class for custom audio encoders. To add your own custom audio encoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the encoder using {@link registerEncoder}.
 * @group Custom coders
 * @public
 */
export abstract class CustomAudioEncoder {
	/** The codec with which to encode the audio. */
	readonly codec!: AudioCodec;
	/** Config for the encoder. */
	readonly config!: AudioEncoderConfig;
	/** The callback to call when an EncodedPacket is available. */
	readonly onPacket!: (packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) => unknown;

	/** Returns true if and only if the encoder can encode the given codec configuration. */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		return false;
	}

	/** Called after encoder creation; can be used for custom initialization logic. */
	abstract init(): MaybePromise<void>;
	/** Encodes the provided audio sample. */
	abstract encode(audioSample: AudioSample): MaybePromise<void>;
	/** Encodes all remaining audio samples and then resolves. */
	abstract flush(): MaybePromise<void>;
	/** Called when the encoder is no longer needed and its resources can be freed. */
	abstract close(): MaybePromise<void>;
}

export const customVideoDecoders: typeof CustomVideoDecoder[] = [];
export const customAudioDecoders: typeof CustomAudioDecoder[] = [];
export const customVideoEncoders: typeof CustomVideoEncoder[] = [];
export const customAudioEncoders: typeof CustomAudioEncoder[] = [];

/**
 * Registers a custom video or audio decoder. Registered decoders will automatically be used for decoding whenever
 * possible.
 * @group Custom coders
 * @public
 */
export const registerDecoder = (decoder: typeof CustomVideoDecoder | typeof CustomAudioDecoder) => {
	if (decoder.prototype instanceof CustomVideoDecoder) {
		const casted = decoder as typeof CustomVideoDecoder;

		if (customVideoDecoders.includes(casted)) {
			console.warn('Video decoder already registered.');
			return;
		}

		customVideoDecoders.push(casted);
	} else if (decoder.prototype instanceof CustomAudioDecoder) {
		const casted = decoder as typeof CustomAudioDecoder;

		if (customAudioDecoders.includes(casted)) {
			console.warn('Audio decoder already registered.');
			return;
		}

		customAudioDecoders.push(casted);
	} else {
		throw new TypeError('Decoder must be a CustomVideoDecoder or CustomAudioDecoder.');
	}
};

/**
 * Registers a custom video or audio encoder. Registered encoders will automatically be used for encoding whenever
 * possible.
 * @group Custom coders
 * @public
 */
export const registerEncoder = (encoder: typeof CustomVideoEncoder | typeof CustomAudioEncoder) => {
	if (encoder.prototype instanceof CustomVideoEncoder) {
		const casted = encoder as typeof CustomVideoEncoder;

		if (customVideoEncoders.includes(casted)) {
			console.warn('Video encoder already registered.');
			return;
		}

		customVideoEncoders.push(casted);
	} else if (encoder.prototype instanceof CustomAudioEncoder) {
		const casted = encoder as typeof CustomAudioEncoder;

		if (customAudioEncoders.includes(casted)) {
			console.warn('Audio encoder already registered.');
			return;
		}

		customAudioEncoders.push(casted);
	} else {
		throw new TypeError('Encoder must be a CustomVideoEncoder or CustomAudioEncoder.');
	}
};
