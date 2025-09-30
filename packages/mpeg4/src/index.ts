/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomVideoDecoder, CustomVideoEncoder, VideoCodec, EncodedPacket, VideoSample, registerDecoder, registerEncoder } from 'mediabunny';
import type { WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';
import decodeWorkerUrl from './decode.worker?url';
import encodeWorkerUrl from './encode.worker?url';

const createWorker = (url: string): Worker => {
	return new Worker(url, { type: 'module' });
};

class Mpeg4Decoder extends CustomVideoDecoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: WorkerResponseData) => void;
		reject: (reason?: unknown) => void;
	}>();

	static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
		return codec === 'mpeg4';
	}

	async init() {
		this.worker = createWorker(decodeWorkerUrl);

		const onMessage = (event: MessageEvent<WorkerResponse>) => {
			const data = event.data;
			const pending = this.pendingMessages.get(data.id);
			assert(pending !== undefined);

			this.pendingMessages.delete(data.id);
			if (data.success) {
				pending.resolve(data.data);
			} else {
				pending.reject(data.error);
			}
		};

		this.worker.addEventListener('message', onMessage);

		await this.sendCommand({
			type: 'init',
			data: {
				width: this.config.codedWidth!,
				height: this.config.codedHeight!,
			},
		});
	}

	async decode(packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		const frameData = packet.data.slice().buffer;

		const result = await this.sendCommand({
			type: 'decode',
			data: {
				frameData,
			},
		}, [frameData]);

		if (!result || !('yuvData' in result)) {
			return;
		}

		const videoFrame = new VideoFrame(new Uint8Array(result.yuvData), {
			format: 'I420',
			codedWidth: result.width,
			codedHeight: result.height,
			timestamp: packet.timestamp * 1_000_000,
		});

		const videoSample = new VideoSample(videoFrame);
		this.onSample(videoSample);
	}

	async flush() {
		await this.sendCommand({ type: 'flush' });
	}

	close() {
		if (this.worker) {
			void this.sendCommand({ type: 'close' });
			this.worker.terminate();
		}
	}

	private sendCommand(
		command: WorkerCommand,
		transferables?: Transferable[],
	) {
		return new Promise<WorkerResponseData>((resolve, reject) => {
			const id = this.nextMessageId++;
			this.pendingMessages.set(id, { resolve, reject });

			assert(this.worker !== null);

			if (transferables) {
				this.worker.postMessage({ id, command }, transferables);
			} else {
				this.worker.postMessage({ id, command });
			}
		});
	}
}

class Mpeg4Encoder extends CustomVideoEncoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: { encodedData: ArrayBuffer } | { closed: true } | null) => void;
		reject: (reason?: unknown) => void;
	}>();

	private frameCount = 0;

	static override supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		return codec === 'mpeg4';
	}

	async init() {
		this.worker = createWorker(encodeWorkerUrl);

		const onMessage = (event: MessageEvent<{ id: number; success: boolean; data: { encodedData: ArrayBuffer } | { closed: true } | null; error?: Error }>) => {
			const data = event.data;
			const pending = this.pendingMessages.get(data.id);
			assert(pending !== undefined);

			this.pendingMessages.delete(data.id);
			if (data.success) {
				pending.resolve(data.data);
			} else {
				pending.reject(data.error);
			}
		};

		this.worker.addEventListener('message', onMessage);

		const fpsNum = Math.round((this.config.framerate ?? 30) * 1000);
		const fpsDen = 1000;

		await this.sendCommand({
			type: 'init',
			data: {
				width: this.config.width,
				height: this.config.height,
				bitrate: this.config.bitrate ?? 2000000,
				fpsNum,
				fpsDen,
			},
		});
	}

	async encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions) {
		const yuvSize = videoSample.codedWidth * videoSample.codedHeight * 3 / 2;
		const yuvData = new ArrayBuffer(yuvSize);
		const yuvBytes = new Uint8Array(yuvData);

		await videoSample.copyTo(yuvBytes);

		const result = await this.sendCommand({
			type: 'encode',
			data: {
				yuvData,
				forceKeyframe: options.keyFrame ?? false,
			},
		}, [yuvData]);

		assert(result && 'encodedData' in result);

		const encodedPacket = new EncodedPacket(
			new Uint8Array(result.encodedData),
			options.keyFrame ? 'key' : 'delta',
			videoSample.timestamp,
			videoSample.duration,
			this.frameCount++,
		);

		this.onPacket(encodedPacket, this.frameCount === 1
			? {
					decoderConfig: {
						codec: 'mpeg4',
						codedWidth: this.config.width,
						codedHeight: this.config.height,
					},
				}
			: undefined);
	}

	async flush() {
	}

	close() {
		if (this.worker) {
			void this.sendCommand({ type: 'close' });
			this.worker.terminate();
		}
	}

	private sendCommand(
		command: { type: 'init'; data: { width: number; height: number; bitrate: number; fpsNum: number; fpsDen: number } } | { type: 'encode'; data: { yuvData: ArrayBuffer; forceKeyframe: boolean } } | { type: 'close' },
		transferables?: Transferable[],
	) {
		return new Promise<{ encodedData: ArrayBuffer } | { closed: true } | null>((resolve, reject) => {
			const id = this.nextMessageId++;
			this.pendingMessages.set(id, { resolve, reject });

			assert(this.worker !== null);

			if (transferables) {
				this.worker.postMessage({ id, command }, transferables);
			} else {
				this.worker.postMessage({ id, command });
			}
		});
	}
}

/**
 * The MPEG-4 Part 2 decoder class.
 * @internal
 */
export { Mpeg4Decoder };

/**
 * The MPEG-4 Part 2 encoder class.
 * @internal
 */
export { Mpeg4Encoder };

/**
 * Registers the MPEG-4 Part 2 (Xvid) decoder, which Mediabunny will then use automatically when applicable.
 * Make sure to call this function before starting any decoding task.
 *
 * @group \@mediabunny/mpeg4
 * @public
 */
export const registerMpeg4Decoder = () => {
	registerDecoder(Mpeg4Decoder);
};

/**
 * Registers the MPEG-4 Part 2 (Xvid) encoder, which Mediabunny will then use automatically when applicable.
 * Make sure to call this function before starting any encoding task.
 *
 * @group \@mediabunny/mpeg4
 * @public
 */
export const registerMpeg4Encoder = () => {
	registerEncoder(Mpeg4Encoder);
};

function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}
