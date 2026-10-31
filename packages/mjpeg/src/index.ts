/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	CustomVideoDecoder,
	CustomVideoEncoder,
	EncodedPacket,
	registerDecoder,
	registerEncoder,
	VideoCodec,
	VideoSample,
} from 'mediabunny';
import { assert } from '../../../src/misc';

class MjpegDecoder extends CustomVideoDecoder {
	canvas: OffscreenCanvas | null = null;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, _config: VideoDecoderConfig): boolean {
		return codec === 'mjpeg';
	}

	init() {
		assert(this.config.codedWidth && this.config.codedHeight);
		this.canvas = new OffscreenCanvas(this.config.codedWidth, this.config.codedHeight);
	}

	async decode(packet: EncodedPacket) {
		const data = packet.data;
		const buffer
			= data.buffer instanceof ArrayBuffer
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data);
		const blob = new Blob([buffer], { type: 'image/jpeg' });
		const bitmap = await createImageBitmap(blob);
		try {
			const frame = new VideoFrame(bitmap, {
				timestamp: packet.microsecondTimestamp,
				duration: packet.microsecondDuration,
			});
			const sample = new VideoSample(frame, {
				timestamp: packet.timestamp,
				duration: packet.duration,
			});
			await this.onSample(sample);
		} finally {
			bitmap.close();
		}
	}

	flush() {
		// Each decode call awaits its output, so there is nothing buffered to flush.
	}

	close() {}
}

type BitrateState = {
	quality?: number;
	actualBytes: number;
	targetBytes: number;
	smoothedError: number;
};

class MjpegEncoder extends CustomVideoEncoder {
	canvas?: OffscreenCanvas;
	context?: OffscreenCanvasRenderingContext2D;
	metadata?: EncodedVideoChunkMetadata;
	framerate?: number;
	targetSize?: number;
	bitrateState: BitrateState = { actualBytes: 0, targetBytes: 0, smoothedError: 0 };

	static override supports(codec: VideoCodec): boolean {
		return codec === 'mjpeg';
	}

	init() {
		assert(this.config.width && this.config.height);
		this.framerate = this.config.framerate;
		if (this.config.bitrate !== undefined && this.framerate !== undefined) {
			this.targetSize = this.config.bitrate / (8 * this.framerate);
		}
		this.metadata = {
			decoderConfig: {
				codec: 'jpeg',
				codedWidth: this.config.width,
				codedHeight: this.config.height,
			},
		};
		this.canvas = new OffscreenCanvas(this.config.width, this.config.height);
		this.context = this.canvas.getContext('2d') ?? undefined;
	}

	private encodeAtQuality(videoSample: VideoSample, quality: number): Promise<Blob> {
		assert(this.context && this.canvas);
		videoSample.draw(this.context, 0, 0, this.config.width, this.config.height);
		return this.canvas.convertToBlob({ type: 'image/jpeg', quality });
	}

	private async calibrateFrame(videoSample: VideoSample, targetSize: number) {
		let quality = 1;
		let imageBlob = await this.encodeAtQuality(videoSample, quality);
		if (imageBlob.size <= targetSize) {
			return { quality, imageBlob };
		}

		quality = 0;
		imageBlob = await this.encodeAtQuality(videoSample, quality);
		if (imageBlob.size >= targetSize) {
			return { quality, imageBlob };
		}

		let lower = 0;
		let upper = 1;
		for (let i = 0; i < 7; i++) {
			const candidateQuality = (lower + upper) / 2;
			const candidate = await this.encodeAtQuality(videoSample, candidateQuality);
			if (candidate.size <= targetSize) {
				lower = candidateQuality;
				quality = candidateQuality;
				imageBlob = candidate;
			} else {
				upper = candidateQuality;
			}
		}
		return { quality, imageBlob };
	}

	private async encodeFrame(videoSample: VideoSample, options: VideoEncoderEncodeOptions): Promise<Blob> {
		const quantizer = options.mjpeg?.quantizer ?? null;
		if (quantizer !== null) {
			return this.encodeAtQuality(videoSample, 1 - quantizer / 100);
		}

		if (this.config.bitrate === undefined) {
			return this.encodeAtQuality(videoSample, 1);
		}
		if (this.targetSize === undefined) {
			this.framerate ??= videoSample.duration > 0 ? 1 / videoSample.duration : 30;
			this.targetSize = this.config.bitrate / (8 * this.framerate);
		}

		let quality = this.bitrateState.quality;
		let imageBlob: Blob;
		if (quality === undefined) {
			const calibratedFrame = await this.calibrateFrame(videoSample, this.targetSize);
			quality = calibratedFrame.quality;
			imageBlob = calibratedFrame.imageBlob;
		} else {
			imageBlob = await this.encodeAtQuality(videoSample, quality);
		}

		this.bitrateState.actualBytes += imageBlob.size;
		this.bitrateState.targetBytes += this.targetSize;
		const frameError = (this.targetSize - imageBlob.size) / this.targetSize;
		this.bitrateState.smoothedError = 0.5 * this.bitrateState.smoothedError + 0.5 * frameError;
		// Repay accumulated bitrate error gradually, without letting it dominate after an unattainable target.
		const accumulatedError = Math.max(
			-1,
			Math.min(1, (this.bitrateState.targetBytes - this.bitrateState.actualBytes) / (30 * this.targetSize)),
		);
		const adjustment = Math.max(
			-0.05,
			Math.min(0.05, 0.15 * this.bitrateState.smoothedError + 0.05 * accumulatedError),
		);
		this.bitrateState.quality = Math.max(0, Math.min(1, quality + adjustment));
		return imageBlob;
	}

	override async encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions) {
		const imageBlob = await this.encodeFrame(videoSample, options);
		const packetData = new Uint8Array(await imageBlob.arrayBuffer());

		const packet = new EncodedPacket(packetData, 'key', videoSample.timestamp, videoSample.duration);
		await this.onPacket(packet, this.metadata);
	}

	flush() {
		// Each encode call awaits its output, so there is nothing buffered to flush.
	}

	close() {}
}

let decoderRegistered = false;
let encoderRegistered = false;

/**
 * Registers an mjpeg decoder which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any decoding task.
 *
 * @group \@mediabunny/mjpeg
 * @public
 */
export const registerMjpegDecoder = () => {
	if (decoderRegistered) {
		return;
	}
	decoderRegistered = true;
	registerDecoder(MjpegDecoder);
};

/**
 * Registers an mjpeg encoder. Make sure to call
 * this function before starting any encoding task.
 *
 * @group \@mediabunny/mjpeg
 * @public
 */
export const registerMjpegEncoder = () => {
	if (encoderRegistered) {
		return;
	}
	encoderRegistered = true;
	registerEncoder(MjpegEncoder);
};
