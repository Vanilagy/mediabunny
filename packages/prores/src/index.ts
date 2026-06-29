/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, EncodedPacket, Logging, registerDecoder, VideoCodec, VideoSample } from 'mediabunny';
import { Decoder, Frame, PixelFormat, PIXEL_FORMATS, FilledFrame } from 'turbores';
import {
	assert,
	isWebKit,
} from '../../../src/misc';
import { type ProresFourCc } from '../../../src/codec';

const PRORES_LOADED_SYMBOL = Symbol.for('@mediabunny/prores loaded');
if ((globalThis as Record<symbol, unknown>)[PRORES_LOADED_SYMBOL]) {
	Logging._error(
		'[WARNING]\n@mediabunny/prores was loaded twice.'
		+ ' This will likely cause the decoder not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of @mediabunny/prores,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[PRORES_LOADED_SYMBOL] = true;

class ProresDecoder extends CustomVideoDecoder {
	private decoder: Decoder | null = null;
	private framePool: Frame[] = [];

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
		return codec === 'prores';
	}

	/** @internal */
	static _supportedVideoFrameFormats: PixelFormat[] | null = null;

	/** @internal */
	static _determineSupportedVideoFrameFormats() {
		const result: PixelFormat[] = [];
		const data = new Uint8Array(32);

		for (const format of PIXEL_FORMATS) {
			try {
				const frame = new VideoFrame(data, {
					format: format as VideoPixelFormat,
					codedWidth: 2,
					codedHeight: 2,
					timestamp: 0,
					duration: 0,
				});
				frame.close();

				result.push(format);
			} catch {
				// Format is not supported
			}
		}

		return result;
	}

	async init() {
		if (typeof VideoFrame !== 'undefined') {
			// Not all VideoFrame implementations support all pixel formats, therefore let's determine the supported set
			ProresDecoder._supportedVideoFrameFormats ??= ProresDecoder._determineSupportedVideoFrameFormats();
		}

		const decoder = await Decoder.create({
			proresFourCc: this.config.codec as ProresFourCc,
			useSharedMemory: Decoder.canUseSharedMemory(),
			allowedOutputFormats: ProresDecoder._supportedVideoFrameFormats ?? undefined,
		});
		if (decoder instanceof Error) {
			throw decoder;
		}

		this.decoder = decoder;
	}

	async decode(packet: EncodedPacket) {
		assert(this.decoder);

		if (this.decoder.useSharedMemory) {
			await this.runDecode(packet);
		} else {
			while (this.decoder.decodeQueueSize >= this.decoder.concurrency) {
				await this.decoder.dequeued;
			}

			void this.runDecode(packet)
				.catch(error => this.onError(error));
		}
	}

	private async runDecode(packet: EncodedPacket) {
		assert(this.decoder);

		let frame: Frame;
		if (this.framePool.length > 0) {
			frame = this.framePool.shift()!;
		} else {
			frame = new Frame();
		}

		const result = await this.decoder.decode(packet.data, frame);
		this.framePool.push(frame);

		if (result instanceof Error) {
			throw result;
		}

		if (result.visibleHeight < result.codedHeight && isWebKit()) {
			// WebKit has (had) a bug with displaying height-trimmed YUV frames, so we must compact the frame data a
			// little https://bugs.webkit.org/show_bug.cgi?id=317524
			this.trimCodedHeightToVisibleHeight(result);
		}

		const sample = new VideoSample(result.frameData, {
			format: result.pixelFormat,
			codedWidth: result.codedWidth,
			codedHeight: result.codedHeight,
			visibleRect: {
				left: 0,
				top: 0,
				width: result.visibleWidth,
				height: result.visibleHeight,
			},
			timestamp: packet.timestamp,
			duration: packet.duration,
			colorSpace: {
				primaries: result.colorPrimariesString as VideoColorPrimaries | undefined,
				matrix: result.colorMatrixString as VideoMatrixCoefficients | undefined,
				transfer: result.colorTransferString as VideoTransferCharacteristics | undefined,
				fullRange: result.colorRangeFull,
			},
		});
		this.onSample(sample);
	}

	private trimCodedHeightToVisibleHeight(result: FilledFrame) {
		const bytesPerSample = result.pixelFormat.includes('P') ? 2 : 1;
		const subWidth = result.pixelFormat.includes('444') ? 1 : 2;
		const subHeight = result.pixelFormat.includes('420') ? 2 : 1;

		const chromaCodedWidth = result.codedWidth / subWidth;
		const chromaCodedHeight = result.codedHeight / subHeight;
		const chromaVisibleHeight = Math.ceil(result.visibleHeight / subHeight);

		const lumaCodedPixels = result.codedWidth * result.codedHeight;
		const lumaVisiblePixels = result.codedWidth * result.visibleHeight;
		const chromaCodedPixels = chromaCodedWidth * chromaCodedHeight;
		const chromaVisiblePixels = chromaCodedWidth * chromaVisibleHeight;

		// U
		result.frameData.set(
			result.frameData.subarray(
				bytesPerSample * lumaCodedPixels,
				bytesPerSample * (lumaCodedPixels + chromaCodedPixels),
			),
			bytesPerSample * lumaVisiblePixels,
		);
		// V
		result.frameData.set(
			result.frameData.subarray(
				bytesPerSample * (lumaCodedPixels + chromaCodedPixels),
				bytesPerSample * (lumaCodedPixels + 2 * chromaCodedPixels),
			),
			bytesPerSample * (lumaVisiblePixels + chromaVisiblePixels),
		);

		result.codedHeight = result.visibleHeight;
	}

	async flush() {
		assert(this.decoder);

		while (this.decoder.decodeQueueSize > 0) {
			await this.decoder.dequeued;
		}
	}

	async close() {
		assert(this.decoder);

		await this.decoder.close();

		for (const frame of this.framePool) {
			frame.clear();
		}
	}
}

let registered = false;

/**
 * Registers an Apple ProRes decoder which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any decoding task.
 *
 * @group \@mediabunny/prores
 * @public
 */
export const registerProresDecoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerDecoder(ProresDecoder);
};
