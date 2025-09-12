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
	CustomVideoEncoder,
	registerDecoder,
	registerEncoder,
} from './custom-coder';
import { promiseWithResolvers, assert } from './misc';
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
		assert(this.alphaOutputResolverMap.size === 0);
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

		if (this.alphaCoderError || this.closed) {
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
	const resultFormat = isYUV // For VP8/VP9, only alpha supported format is yuva420p, so only I420
		? `${format.slice(0, 4)}A${format.slice(4, format.length)}` as VideoPixelFormat
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
		duration: main.duration,
		format: resultFormat,
		transfer: [data.buffer],
	} as VideoFrameBufferInit);
};

class WebMSeparateAlphaDecoder extends CustomVideoDecoder {
	coder = new Coder<VideoDecoder>();

	// Should check if input actually has alpha instead of by 'prefer-software', but no access to _backing here
	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		// Hardware accelerated have impractically worse performance in `copyTo` based implementation of _combineAlpha
		return ['vp9', 'vp8'].includes(codec)
			&& config.hardwareAcceleration === 'prefer-software'
			&& typeof VideoDecoder !== 'undefined'
			&& typeof VideoFrame !== 'undefined';
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
						this.coder.alphaOutputResolverMap.delete(output.timestamp);
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

let _isWebMSeparateAlphaDecoderRegistered = false;

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
export const registerWebMSeparateAlphaDecoder = () => {
	if (!_isWebMSeparateAlphaDecoderRegistered) {
		_isWebMSeparateAlphaDecoderRegistered = true;
		registerDecoder(WebMSeparateAlphaDecoder);
	}
};

/**
 * By a flag for tree shaking
 *
 * @internal
 */
export const isWebMSeparateAlphaDecoderRegistered = () => _isWebMSeparateAlphaDecoderRegistered;

const extractAlpha = async (videoSample: VideoSample) => {
	const format = videoSample.format || '';

	if (
		// Chrome v139: HEVC with alpha might give null, if so, cannot copyTo without explicit format change to RGB
		// But it is not supported in VideoSample.copyTo now, only in VideoFrame.copyTo
		!format
		|| !format.includes('A')
		|| videoSample._closed
		|| format.length > 5 // Not handling cases like I444AP12, not possible in browser now, will become null
	) {
		return {};
	};

	// RGB formats (like canvas) will get converted to 16-255 in browsers for VP8/VP9 encoding
	// Need to create I420 for alpha frame even for RGB format
	const isYUV = format.startsWith('I') || format.startsWith('N');
	const size = videoSample.allocationSize();
	const data = new Uint8Array(size);
	const alphaData = new Uint8Array(size);
	const pixels = videoSample.codedWidth * videoSample.codedHeight;

	await videoSample.copyTo(data);

	if (isYUV) {
		alphaData.set(data.subarray(size - pixels, size));
	} else {
		for (let i = 0; i < pixels; i++) {
			alphaData[i] = data[i * 4 + 3]!;
		}
	}

	// eslint-disable-next-line @stylistic/max-len
	// More expensive to encode otherwise, according to https://source.chromium.org/chromium/chromium/src/+/main:media/video/alpha_video_encoder_wrapper.cc;l=117
	alphaData.fill(255, pixels, alphaData.byteLength);

	return {
		alphaFrame: new VideoFrame(alphaData, {
			format: 'I420',
			timestamp: videoSample.microsecondTimestamp,
			codedWidth: videoSample.codedWidth,
			codedHeight: videoSample.codedHeight,
			transfer: [alphaData.buffer],
		} as VideoFrameBufferInit),
		mainFrame: new VideoFrame(data, {
			// Safari workaround: giving original I420A = broken color, fine to recreate I420 generally
			// OK to have BGRX here but I420 above, these 2 frames are pass to 2 separate encoder
			format: format.slice(0, 4),
			timestamp: videoSample.microsecondTimestamp,
			colorSpace: videoSample.colorSpace,
			codedWidth: videoSample.codedWidth,
			codedHeight: videoSample.codedHeight,
			transfer: [data.buffer],
		} as VideoFrameBufferInit),
	};
};

class WebMSeparateAlphaEncoder extends CustomVideoEncoder {
	coder = new Coder<VideoEncoder>();

	// Should check if output format supports also, but no access in CustomVideoEncoder
	static override supports(codec: VideoCodec, config: VideoEncoderConfig) {
		return config.alpha === 'keep'
			&& ['vp9', 'vp8'].includes(codec)
			&& typeof VideoEncoder !== 'undefined'
			&& typeof VideoFrame !== 'undefined';
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
					this.coder.alphaOutputResolverMap.delete(chunk.timestamp);
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
		let { alphaFrame, mainFrame } = await extractAlpha(videoSample).catch(() => {
			this.coder.setAlphaCoderError(new Error('Failed to extractAlpha'));
		}) || {};

		if (alphaFrame) {
			this.coder.alphaCoder.encode(alphaFrame, options);
			alphaFrame.close();
			alphaFrame = undefined;
		} else {
			resolver.resolve(null);
		}

		mainFrame ??= videoSample.toVideoFrame();
		this.coder.mainCoder.encode(mainFrame, options);
		mainFrame.close();
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
