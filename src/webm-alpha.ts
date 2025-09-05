/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { VideoCodec } from './codec';
import {
	CustomVideoDecoder,
	customVideoDecoders,
	CustomVideoEncoder,
	registerDecoder,
	registerEncoder,
} from './custom-coder';
import { isSafari, promiseWithResolvers } from './misc';
import { EncodedPacket } from './packet';
import { VideoSample } from './sample';

type CoderType = VideoDecoder | VideoEncoder;
type CoderOutput<T extends CoderType> = T extends VideoDecoder
	? VideoFrame
	: EncodedVideoChunk;

class Coder<T extends CoderType> {
	mainCoder!: T;
	alphaCoder!: T;

	mainCoderError: Error | null = null;
	alphaCoderError: Error | null = null;

	// Main output needs to wait for alpha output to be ready, or null due to unexpected issue
	alphaOutputResolverMap = new Map<
		number,
		ReturnType<typeof promiseWithResolvers<CoderOutput<T> | null>>
	>();

	closed = false;

	setAlphaCoderError(error: Error) {
		if (this.alphaCoderError) {
			return;
		}

		for (const resolver of this.alphaOutputResolverMap.values()) {
			resolver.resolve(null);
		}

		this.alphaOutputResolverMap.clear();
		this.alphaCoderError = error;
	}

	async flush() {
		await Promise.all([
			this.mainCoder.flush(),
			this.alphaCoder.flush(),
		]);

		const promises = [];

		for (const resolver of this.alphaOutputResolverMap.values()) {
			promises.push(resolver.promise);
		}

		await Promise.allSettled(promises);
	}

	close() {
		if (this.mainCoder.state !== 'closed') this.mainCoder.close();
		if (this.alphaCoder.state !== 'closed') this.alphaCoder.close();
		this.closed = true;
		this.alphaOutputResolverMap.clear();
	}

	getAlphaOutputResolver(microsecondTimestamp: number) {
		if (!this.alphaOutputResolverMap.has(microsecondTimestamp)) {
			this.alphaOutputResolverMap.set(microsecondTimestamp, promiseWithResolvers());
		}

		const resolver = this.alphaOutputResolverMap.get(microsecondTimestamp)!;

		if (this.alphaCoderError || closed) {
			resolver.resolve(null);
		}

		return resolver;
	}

	shouldIgnoreAlphaOutput() {
		return this.mainCoderError || this.alphaCoderError || this.closed;
	}
}

const combineAlpha = async (main: VideoFrame, alpha?: VideoFrame | null | void) => {
	// No alpha, or closed
	if (!alpha || alpha.displayWidth === 0) {
		return main;
	}

	const format = main.format || '';
	const isYUV = format.startsWith('I');
	const resultFormat = isYUV
		? `${format.slice(0, 4)}A${format.slice(4, format.length)}` as VideoPixelFormat // e.g. I420AP12
		: format.endsWith('X')
			? `${format.slice(0, 3)}A` as VideoPixelFormat
			: format;

	// Already has A, or NV12 (mainly from hardware accelerated cases)
	if (!format || resultFormat === format) {
		return main;
	};

	const mainSize = main.allocationSize();
	const alphaSize = alpha.allocationSize();
	const data = new Uint8Array(mainSize + alphaSize);
	const alphaArray = data.subarray(mainSize, data.byteLength);

	await Promise.all([
		main.copyTo(data.subarray(0, mainSize)),
		alpha.copyTo(alphaArray),
	]);

	// YUV planar format are ready as-is.
	// But for RGB formats, need to copy 1 channel to X channel.
	// For alpha channel, UV are dummy
	// Optimization: most implementation should give the same RGB values by filling UV with max value
	// Otherwise need luminanceToAlpha, ref: https://www.w3.org/TR/SVG11/filters.html#feColorMatrixElement
	// e.g. Chrome: I420, Firefox: BGRX.
	if (!isYUV) {
		for (let i = 0; i < alphaSize; i += 4) {
			data[i + 3] = data[mainSize + i]!;
		}
	}

	return new VideoFrame(data, {
		codedWidth: main.displayWidth, // As a result of copyTo
		codedHeight: main.displayHeight,
		displayWidth: main.displayWidth,
		displayHeight: main.displayHeight,
		colorSpace: main.colorSpace,
		timestamp: main.timestamp,
		duration: main.duration ?? undefined,
		format: resultFormat,
		transfer: [data.buffer],
	} as VideoFrameBufferInit);
};

class WebMSeparateAlphaDecoder extends CustomVideoDecoder {
	coder = new Coder<VideoDecoder>();

	// Should check if input actually has alpha instead of by 'prefer-software', but no access to _backing here
	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		// Hardware accelerated have impractically worse performance in `copyTo` based implementation of _combineAlpha
		return ['vp9', 'av1', 'vp8'].includes(codec)
			&& config.hardwareAcceleration === 'prefer-software'
			&& typeof VideoDecoder !== 'undefined'
			&& typeof VideoFrame !== 'undefined'
			&& !isSafari(); // Safari v18.6: broken when creating I420A, I420 works with the same data buffer
	}

	override init() {
		this.coder.mainCoder = new VideoDecoder({
			output: (output) => {
				const resolver = this.coder.getAlphaOutputResolver(output.timestamp);

				(async () => {
					let alpha;
					let frame;

					try {
						alpha = await resolver.promise.catch(() => {});
						frame = await combineAlpha(output, alpha).catch(() => {
							this.coder.setAlphaCoderError(new Error('Failed to combine alpha'));
							return output;
						});
						this.onSample(new VideoSample(frame));
					} finally {
						if (frame !== output) output.close();
						alpha?.close();
					}
				})().catch(() => {});
			},
			error: (error) => {
				this.coder.mainCoderError = error;
				this.close();
			},
		});
		this.coder.mainCoder.configure(this.config);
		this.coder.alphaCoder = new VideoDecoder({
			output: (output) => {
				if (this.coder.shouldIgnoreAlphaOutput()) {
					return output.close();
				}

				this.coder.getAlphaOutputResolver(output.timestamp).resolve(output);
			},
			error: error => this.coder.setAlphaCoderError(error),
		});
		this.coder.alphaCoder.configure(this.config);
	}

	override decode(packet: EncodedPacket) {
		const resolver = this.coder.getAlphaOutputResolver(packet.microsecondTimestamp);

		if (packet.additions) {
			this.coder.alphaCoder.decode(
				new EncodedPacket(
					packet.additions,
					packet.type,
					packet.timestamp,
					packet.duration,
					packet.sequenceNumber,
				).toEncodedVideoChunk(),
			);
		} else {
			resolver.resolve(null);
		}

		this.coder.mainCoder.decode(packet.toEncodedVideoChunk());
	}

	override close = () => this.coder.close();
	override flush = () => this.coder.flush();
}

/**
 * Registers the experimental custom decoder for handling supported packets with alpha channel in `VideoCodec` for WebM
 * By internally creating 2 `VideoDecoder` to handle main color data and additional data (alpha) separately and combine.
 * Supports `VideoDecodingConfig.hardwareAcceleration: 'prefer-software'`, also as an implicit opt-in mechanism.
 * For convenience, registering this will make matroska-demuxer auto opt-in.
 *
 * ```ts
 * import { registerWebMSeparateAlphaDecoder, type VideoDecodingConfig } from 'mediabunny';
 *
 * registerWebMSeparateAlphaDecoder();
 *
 * // Default: 'no-preference'
 * const config: VideoDecodingConfig = { ...others, hardwareAcceleration: 'prefer-software' };
 * ```
 *
 * @alpha
 */
export const registerWebMSeparateAlphaDecoder = () => registerDecoder(WebMSeparateAlphaDecoder);

/** @internal */
export const isWebMSeparateAlphaDecoderRegistered = () => customVideoDecoders.includes(WebMSeparateAlphaDecoder);

const extractAlpha = async (videoSample: VideoSample) => {
	const format = videoSample.format || '';

	if (
		!format.includes('A') // Chrome v139: HEVC with alpha might give null, but cannot copyTo anyway
		|| videoSample._closed
		|| format.length > 5 // Not handling cases like I444AP12, not possible in browser now, will become null
	) {
		return null;
	};

	// RGB formats (like canvas) will get converted to 16-255 in browsers, and give broken result
	const isYUV = format.startsWith('I') || format.startsWith('N');
	const finalFormat = isYUV ? format.slice(0, 4) : 'I420';
	const size = videoSample.allocationSize();
	const data = new Uint8Array(size);
	const pixels = videoSample.codedWidth * videoSample.codedHeight;

	await videoSample.copyTo(data);

	if (isYUV) {
		data.set(data.subarray(size - pixels, size));
	} else {
		for (let i = 0; i < pixels; i++) {
			data[i] = data[i * 4 + 3]!;
		}
	}

	// eslint-disable-next-line @stylistic/max-len
	// More expensive to encode otherwise, according to https://source.chromium.org/chromium/chromium/src/+/main:media/video/alpha_video_encoder_wrapper.cc;l=117
	data.fill(255, pixels, data.byteLength);

	return new VideoFrame(data, {
		timestamp: videoSample.microsecondTimestamp,
		duration: videoSample.microsecondDuration,
		format: finalFormat,
		codedWidth: videoSample.codedWidth,
		codedHeight: videoSample.codedHeight,
		transfer: [data.buffer],
	} as VideoFrameBufferInit);
};

class WebMSeparateAlphaEncoder extends CustomVideoEncoder {
	coder = new Coder<VideoEncoder>();

	// Should check if output format supports also, but no access in CustomVideoEncoder
	static override supports(codec: VideoCodec, config: VideoEncoderConfig) {
		return config.alpha === 'keep'
			&& ['vp9', 'av1', 'vp8'].includes(codec)
			&& typeof VideoEncoder !== 'undefined'
			&& typeof VideoFrame !== 'undefined'
			&& !isSafari(); // Need handling like VideoEncoderWrapper
	}

	override init() {
		const config: VideoEncoderConfig = {
			...this.config,
			alpha: 'discard',
		};

		this.coder.mainCoder = new VideoEncoder({
			output: (chunk, metadata) => {
				const resolver = this.coder.getAlphaOutputResolver(chunk.timestamp);
				const packet = EncodedPacket.fromEncodedChunk(chunk);

				(async () => {
					const alpha = await resolver.promise.catch(() => {});

					if (alpha) {
						const alphaPacket = EncodedPacket.fromEncodedChunk(alpha);

						/** @ts-expect-error Technically readonly */
						packet.additions = alphaPacket.data ?? undefined;
					}
					this.onPacket(packet, metadata);
				})().catch(() => {});
			},
			error: (error) => {
				this.coder.mainCoderError = error;
				this.close();
			},
		});
		this.coder.mainCoder.configure(config);

		// Better add when there is really data and properly check configure in supports first
		// Need refactoring of current API
		this.coder.alphaCoder = new VideoEncoder({
			output: (chunk) => {
				if (this.coder.shouldIgnoreAlphaOutput()) {
					return;
				}
				this.coder.getAlphaOutputResolver(chunk.timestamp).resolve(chunk);
			},
			error: error => this.coder.setAlphaCoderError(error),
		});
		this.coder.alphaCoder.configure(config);
	}

	override async encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions) {
		if (this.coder.mainCoderError) {
			/** @ts-expect-error ECMAScript target */
			throw new Error('Cannot encode on a closed VideoEncoder', { cause: this.coder.mainCoderError });
		}

		const resolver = this.coder.getAlphaOutputResolver(videoSample.microsecondTimestamp);
		const alpha = await extractAlpha(videoSample).catch(() => {
			this.coder.setAlphaCoderError(new Error('Failed to extractAlpha'));
		});

		if (alpha) {
			this.coder.alphaCoder.encode(alpha, options);
			alpha.close();
		} else {
			resolver.resolve(null);
		}

		const frame = videoSample.toVideoFrame();

		this.coder.mainCoder.encode(frame, options);
		frame.close();
	}

	override close = () => this.coder.close();
	override flush = () => this.coder.flush();
}

/**
 * Registers the experimental custom decoder for handling supported packets with alpha channel in `VideoCodec` for WebM.
 * By internally splitting input into 2 separate video track and 2 `VideoEncoder` to decode separately, then combine.
 * Without this, alpha channel will be ignored since there is no native API to provide the alpha data currently.
 * Then: `VideoEncoderConfig.alpha: 'keep'`.
 *
 * ```ts
 * import { canEncode, registerWebMSeparateAlphaEncoder, type VideoEncoderConfig } from 'mediabunny';
 *
 * // 'av1', 'vp9', 'vp8'
 * if (!canEncode('vp9', { alpha: 'keep' })) registerWebMSeparateAlphaEncoder();
 *
 * const config: VideoEncoderConfig = { ...others, alpha: 'keep' }; // default 'discard'
 * ```
 *
 * @alpha
 */
export const registerWebMSeparateAlphaEncoder = () => registerEncoder(WebMSeparateAlphaEncoder);
