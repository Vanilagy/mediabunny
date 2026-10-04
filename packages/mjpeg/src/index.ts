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
import { assert, MaybePromise } from '../../../src/misc';

class MjpegDecoder extends CustomVideoDecoder {
	canvas: OffscreenCanvas | null = null;

	_pendingSamples = 0;
	_flushPromise: { promise: Promise<void>; resolve: () => void } | null = null;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, _config: VideoDecoderConfig): boolean {
		return codec === 'mjpeg';
	}

	init() {
		assert(this.config.codedWidth && this.config.codedHeight);
		this.canvas = new OffscreenCanvas(this.config.codedWidth, this.config.codedHeight);
	}

	async decode(packet: EncodedPacket) {
		this._pendingSamples += 1;

		try {
			const data = packet.data;
			const buffer = data.buffer instanceof ArrayBuffer
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data);
			const blob = new Blob([buffer], { type: 'image/jpeg' });
			const bitmap = await createImageBitmap(blob);
			const frame = new VideoFrame(bitmap, { timestamp: packet.microsecondTimestamp, duration: packet.microsecondDuration });
			const sample = new VideoSample(frame, { timestamp: packet.timestamp, duration: packet.duration });
			this.onSample(sample);
			bitmap.close();
		} finally {
			this._pendingSamples -= 1;
			this._checkFlushPromise();
		}
	}

	_checkFlushPromise() {
		if (this._flushPromise && this._pendingSamples === 0) {
			this._flushPromise.resolve();
			this._flushPromise = null;
		}
	}

	flush() {
		if (this._flushPromise) {
			this._checkFlushPromise();
			return this._flushPromise.promise;
		}
		if (this._pendingSamples === 0) {
			return;
		}
		let resolve;
		const promise = new Promise<void>((res) => {
			resolve = res;
		});
		assert(resolve);
		this._flushPromise = { resolve, promise };
		return promise;
	}

	async close() {
		await this.flush();
	}
}

class MjpegEncoder extends CustomVideoEncoder {
	_pendingSamples: number = 0;
	_flushPromise: { promise: Promise<void>; resolve: () => void } | null = null;
	canvas?: OffscreenCanvas;
	context?: OffscreenCanvasRenderingContext2D;
	metadata?: EncodedVideoChunkMetadata;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		return codec === 'mjpeg';
	}

	init(): MaybePromise<void> {
		assert(this.config.width && this.config.height);
		this.canvas = new OffscreenCanvas(this.config.width, this.config.height);
		this.context = this.canvas.getContext('2d') ?? undefined;
		this.metadata = {
			decoderConfig: {
				codec: 'jpeg',
				codedWidth: this.config.width,
				codedHeight: this.config.height,
			},
		};
	}

	override async encode(videoSample: VideoSample, meta?: VideoEncoderEncodeOptions) {
		assert(this.context && this.canvas);
		this._pendingSamples += 1;

		try {
			videoSample.draw(this.context, 0, 0, this.config.width, this.config.height);

			const imageBlob = await this.canvas.convertToBlob({ type: 'image/jpeg', quality: 0 });
			const packetData = new Uint8Array(await imageBlob.arrayBuffer());

			const packet = new EncodedPacket(packetData, 'key', videoSample.timestamp, videoSample.duration);
			this.onPacket(packet, this.metadata);
		} finally {
			this._pendingSamples -= 1;
			this._checkFlushPromise();
		}
	}

	_checkFlushPromise() {
		if (this._flushPromise && this._pendingSamples === 0) {
			this._flushPromise.resolve();
			this._flushPromise = null;
		}
	}

	flush(): MaybePromise<void> {
		if (this._flushPromise) {
			this._checkFlushPromise();
			return this._flushPromise.promise;
		}
		if (this._pendingSamples === 0) {
			return;
		}
		let resolve;
		const promise = new Promise<void>(res => {
			resolve = res;
		})
		this._flushPromise = { resolve: resolve!, promise };
		return promise;
	}

	close(): MaybePromise<void> {
		return this._flushPromise?.promise;
	}
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
