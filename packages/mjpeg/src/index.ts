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
import { assert, clamp } from '../../../src/misc';

class MjpegDecoder extends CustomVideoDecoder {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, _config: VideoDecoderConfig): boolean {
		return codec === 'mjpeg';
	}

	displayDimensions: {
		displayWidth: number;
		displayHeight: number;
	} | {
		displayWidth: undefined;
		displayHeight: undefined;
	} = { displayWidth: undefined, displayHeight: undefined };

	init() {
		if (typeof this.config.displayAspectWidth === 'number' && typeof this.config.displayAspectHeight === 'number') {
			this.displayDimensions = {
				displayWidth: this.config.displayAspectWidth,
				displayHeight: this.config.displayAspectHeight,
			};
		}
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
				displayWidth: this.displayDimensions.displayWidth,
				displayHeight: this.displayDimensions.displayHeight,
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
	calibratedTargetSizeBytes?: number; // Bytes per frame at the last calibration.
	bitrateState: BitrateState = { actualBytes: 0, targetBytes: 0, smoothedError: 0 };

	static override supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		return codec === 'mjpeg' && config.alpha !== 'keep';
	}

	init() {
		assert(this.config.width && this.config.height);
		assert(this.config.displayWidth && this.config.displayHeight);
		this.metadata = {
			decoderConfig: {
				codec: 'jpeg',
				codedWidth: this.config.width,
				codedHeight: this.config.height,
				displayAspectWidth: this.config.displayWidth,
				displayAspectHeight: this.config.displayHeight,
			},
		};
		this.canvas = new OffscreenCanvas(this.config.width, this.config.height);
		this.context = this.canvas.getContext('2d') ?? undefined;
	}

	private encodeAtQuality(videoSample: VideoSample, quality: number): Promise<Blob> {
		assert(this.context && this.canvas);
		this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
		videoSample.draw(this.context, 0, 0, this.config.width, this.config.height);
		return this.canvas.convertToBlob({ type: 'image/jpeg', quality });
	}

	// Blob.size is in bytes; all quality values and search bounds are unitless, from 0 to 1.
	private async calibrateFrame(videoSample: VideoSample, targetSizeBytes: number) {
		let quality = 1;
		let imageBlob = await this.encodeAtQuality(videoSample, quality);
		if (imageBlob.size <= targetSizeBytes) {
			return { quality, imageBlob };
		}

		const minimumBlob = await this.encodeAtQuality(videoSample, 0);
		if (minimumBlob.size >= targetSizeBytes) {
			return { quality: 0, imageBlob: minimumBlob };
		}

		if (Math.abs(minimumBlob.size - targetSizeBytes) < Math.abs(imageBlob.size - targetSizeBytes)) {
			quality = 0;
			imageBlob = minimumBlob;
		}

		let lowerQuality = 0;
		let upperQuality = 1;
		for (let i = 0; i < 7; i++) {
			const candidateQuality = (lowerQuality + upperQuality) / 2;
			const candidate = await this.encodeAtQuality(videoSample, candidateQuality);
			// Bitrate is an average target, so keep the closest result on either side.
			if (Math.abs(candidate.size - targetSizeBytes) < Math.abs(imageBlob.size - targetSizeBytes)) {
				quality = candidateQuality;
				imageBlob = candidate;
			}
			if (candidate.size <= targetSizeBytes) {
				lowerQuality = candidateQuality;
			} else {
				upperQuality = candidateQuality;
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
		const targetSizeBytes = (this.config.bitrate * videoSample.duration) / 8;
		const errorRepaymentFrames = 30;
		const accumulatedErrorBytes = this.bitrateState.targetBytes - this.bitrateState.actualBytes;
		const frameErrorRatio = targetSizeBytes !== 0
			? clamp(accumulatedErrorBytes / (errorRepaymentFrames * targetSizeBytes), -1, 1)
			: 0;

		let quality = this.bitrateState.quality;
		let imageBlob: Blob;
		if (
			quality === undefined
			|| this.calibratedTargetSizeBytes === undefined
			|| Math.abs(targetSizeBytes / this.calibratedTargetSizeBytes - 1) > 0.1
		) {
			const calibrationTargetSizeBytes = targetSizeBytes * (1 + frameErrorRatio);
			const calibratedFrame = await this.calibrateFrame(videoSample, calibrationTargetSizeBytes);
			quality = calibratedFrame.quality;
			imageBlob = calibratedFrame.imageBlob;
			this.calibratedTargetSizeBytes = targetSizeBytes;
			this.bitrateState.smoothedError = 0;
		} else {
			imageBlob = await this.encodeAtQuality(videoSample, quality);
		}

		this.bitrateState.actualBytes += imageBlob.size;
		this.bitrateState.targetBytes += targetSizeBytes;
		const frameError = (targetSizeBytes - imageBlob.size) / targetSizeBytes;
		this.bitrateState.smoothedError = 0.5 * this.bitrateState.smoothedError + 0.5 * frameError;
		const maxQualityChange = 0.05;
		const qualityAdjustment = clamp(
			0.15 * this.bitrateState.smoothedError + 0.05 * frameErrorRatio,
			-maxQualityChange,
			maxQualityChange,
		);
		this.bitrateState.quality = clamp(quality + qualityAdjustment, 0, 1);
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
