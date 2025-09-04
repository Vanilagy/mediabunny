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
import { promiseWithResolvers, assert } from './misc';
import { EncodedPacket } from './packet';
import { VideoSample } from './sample';

class WebMSeparateAlphaDecoder extends CustomVideoDecoder {
	private mainCoder!: VideoDecoder;
	private alphaCoder!: VideoDecoder;

	private mainCoderError: DOMException | null = null;
	private alphaCoderError: DOMException | null = null;

	// Main output needs to wait for alpha output to be ready, or null due to unexpected issue
	private alphaOutputResolverMap = new Map<
		number,
		ReturnType<typeof promiseWithResolvers<VideoFrame | null>>
	>();

	private closed = false;

	static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
		// Hardware accelerated have impractically worse performance in current implementation of _combineAlpha
		// Does not support 'prefer-hardware' now
		return ['vp9', 'av1', 'vp8'].includes(codec)
			&& config.hardwareAcceleration === 'prefer-software'
			&& typeof VideoDecoder !== 'undefined'
			&& typeof VideoFrame !== 'undefined';
	}

	override init() {
		this.mainCoder = new VideoDecoder({
			output: (output) => {
				const resolver = this._getAlphaOutputResolver(output.timestamp);
				(async () => {
					const alpha = await resolver.promise.catch(() => {});
					const frame = await this._combineAlpha(output, alpha);

					this.onSample(new VideoSample(frame));
				})().catch(() => {});
			},

			error: (error) => {
				this.mainCoderError = error;
				this.close();
			},
		});
		this.mainCoder.configure(this.config);
		this.alphaCoder = new VideoDecoder({
			output: (output) => {
				if (this.mainCoderError || this.alphaCoderError || this.closed) {
					return output.close();
				}

				this._getAlphaOutputResolver(output.timestamp).resolve(output);
			},
			error: (error) => {
				this.alphaCoderError = error;
			},
		});
		this.alphaCoder.configure(this.config);
	}

	override decode(packet: EncodedPacket) {
		const resolver = this._getAlphaOutputResolver(packet.microsecondTimestamp);

		if (packet.additions) {
			this.alphaCoder.decode(
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

		this.mainCoder.decode(packet.toEncodedVideoChunk());
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

	override close() {
		if (this.mainCoder.state !== 'closed') this.mainCoder.close();
		if (this.alphaCoder.state !== 'closed') this.alphaCoder.close();
		this.closed = true;
	}

	/** @internal */
	_getAlphaOutputResolver(microsecondTimestamp: number) {
		if (!this.alphaOutputResolverMap.has(microsecondTimestamp)) {
			this.alphaOutputResolverMap.set(microsecondTimestamp, promiseWithResolvers());
		}

		const resolver = this.alphaOutputResolverMap.get(microsecondTimestamp)!;

		if (this.alphaCoderError || closed) {
			resolver.resolve(null);
		}

		return resolver;
	}

	/** @internal */
	async _combineAlpha(main: VideoFrame, alpha?: VideoFrame | null | void) {
		// No alpha, or closed
		if (!alpha || alpha.displayWidth === 0) {
			return main;
		}

		const format = main.format || '';
		const formatPrefix = format.slice(0, 4); // e.g. I420
		const formatAffix = format.slice(4, format.length); // e.g. P12

		if (
			formatPrefix.at(0) !== 'I' // Only support planar YUV, expected when using prefer-software
			|| formatAffix.at(0) === 'A' // Already include alpha, ignore
		) {
			return main;
		};

		try {
			const uint8 = new Uint8Array(main.allocationSize() + alpha.allocationSize());
			const mainData = uint8.subarray(0, main.allocationSize());
			const alphaData = uint8.subarray(main.allocationSize(), uint8.byteLength);

			// Y, U, V + A (alpha's Y as A)
			// Extra U, V data from alpha main are dummy and discarded
			await Promise.all([
				main.copyTo(mainData),
				alpha.copyTo(alphaData),
			]);

			return new VideoFrame(uint8, {
				codedWidth: main.displayWidth, // As a result of copyTo
				codedHeight: main.displayHeight,
				displayWidth: main.displayWidth,
				displayHeight: main.displayHeight,
				colorSpace: main.colorSpace,
				timestamp: main.timestamp,
				duration: main.duration ?? undefined,
				format: `${formatPrefix}A${formatAffix}` as VideoPixelFormat,
				transfer: [uint8.buffer],
			} as VideoFrameBufferInit);
		} finally {
			main.close();
			alpha?.close();
		}
	}
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

class WebMSeparateAlphaEncoder extends CustomVideoEncoder {
	private mainCoder!: VideoEncoder;
	private alphaCoder!: VideoEncoder;

	private mainCoderError: DOMException | null = null;
	private alphaCoderError: DOMException | null = null;

	// Main output needs to wait for alpha output to be ready, or null due to unexpected issue
	private alphaOutputResolverMap = new Map<
		number,
		ReturnType<typeof promiseWithResolvers<EncodedVideoChunk | null>>
	>();

	private canvas?: OffscreenCanvas;

	private closed = false;

	static override supports(codec: VideoCodec, config: VideoEncoderConfig) {
		return config.alpha === 'keep'
			&& ['vp9', 'av1', 'vp8'].includes(codec)
			&& typeof VideoEncoder !== 'undefined'
			&& typeof VideoFrame !== 'undefined'
			&& typeof OffscreenCanvas !== 'undefined';
	}

	override init() {
		const config: VideoEncoderConfig = {
			...this.config,
			alpha: 'discard',
		};

		this.mainCoder = new VideoEncoder({
			output: (chunk, metadata) => {
				const resolver = this._getAlphaOutputResolver(chunk.timestamp);
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
				this.mainCoderError = error;
				this.close();
			},
		});
		this.mainCoder.configure(config);

		// Better add when there is really data and properly check configure in supports first
		// Need refactoring of current API
		// FIXME: problem with limited range, 0 alpha become 16...
		this.alphaCoder = new VideoEncoder({
			output: (chunk) => {
				if (this.mainCoderError || this.alphaCoderError || this.closed) {
					return;
				}

				this._getAlphaOutputResolver(chunk.timestamp).resolve(chunk);
			},
			error: (error) => {
				this.alphaCoderError = error;
			},
		});
		this.alphaCoder.configure(config);
	}

	override async encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions) {
		if (this.mainCoderError) {
			/** @ts-expect-error ES target version issue? */
			throw new Error('Cannot encode on a closed VideoEncoder', { cause: this.mainCoderError });
		}

		const alpha = await this._extractAlpha(videoSample);

		if (alpha) {
			this.alphaCoder.encode(alpha, options);
			alpha.close();
		} else {
			this._getAlphaOutputResolver(videoSample.microsecondTimestamp).resolve(null);
		}

		const frame = videoSample.toVideoFrame();

		this.mainCoder.encode(frame, options);
		frame.close();
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

	override close() {
		if (this.mainCoder.state !== 'closed') this.mainCoder.close();
		if (this.alphaCoder.state !== 'closed') this.alphaCoder.close();
		this.closed = true;
		delete this.canvas;
	}

	/** @internal */
	_getAlphaOutputResolver(microsecondTimestamp: number) {
		if (!this.alphaOutputResolverMap.has(microsecondTimestamp)) {
			this.alphaOutputResolverMap.set(microsecondTimestamp, promiseWithResolvers());
		}

		const resolver = this.alphaOutputResolverMap.get(microsecondTimestamp)!;

		if (this.mainCoderError || this.alphaCoderError || this.closed) {
			resolver.resolve(null);
		}

		return resolver;
	}

	/** @internal */
	async _extractAlpha(videoSample: VideoSample) {
		const format = videoSample.format || '';
		const alpha = format.includes('A')
			|| videoSample.format === null; // Edge case: somehow null for HEVC with alpha at Chrome 139

		if (!alpha || videoSample._closed || this.alphaCoderError) {
			return null;
		};

		this.canvas ??= new OffscreenCanvas(videoSample.codedWidth, videoSample.codedHeight);

		const ctx = this.canvas.getContext('2d');

		assert(ctx);
		ctx.globalCompositeOperation = 'copy';
		ctx.drawImage(videoSample.toCanvasImageSource(), 0, 0);
		ctx.globalCompositeOperation = 'source-in';
		ctx.fillStyle = 'white';
		ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

		return new VideoFrame(this.canvas, {
			timestamp: videoSample.microsecondTimestamp,
			duration: videoSample.microsecondDuration,
			alpha: 'discard',
		});
	}
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
