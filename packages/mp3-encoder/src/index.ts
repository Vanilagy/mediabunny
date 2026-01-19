/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomAudioEncoder, AudioCodec, AudioSample, EncodedPacket, registerEncoder } from 'mediabunny';
import { FRAME_HEADER_SIZE, readMp3FrameHeader, SAMPLING_RATES } from '../../../shared/mp3-misc';
import type { WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';
// @ts-expect-error An esbuild plugin handles this, TypeScript doesn't need to understand
import createWorker from './encode.worker';

class Mp3Encoder extends CustomAudioEncoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: WorkerResponseData) => void;
		reject: (reason?: unknown) => void;
	}>();

	private buffer = new Uint8Array(2 ** 16);
	private currentBufferOffset = 0;
	private currentTimestamp: number | null = null;
	private chunkMetadata: EncodedAudioChunkMetadata = {};

	static override supports(codec: AudioCodec, config: AudioDecoderConfig): boolean {
		return codec === 'mp3'
			&& (config.numberOfChannels === 1 || config.numberOfChannels === 2)
			&& Object.values(SAMPLING_RATES).some(x =>
				x === config.sampleRate || (x / 2) === config.sampleRate || (x / 4) === config.sampleRate,
			);
	}

	async init() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.worker = (await createWorker()) as Worker; // The actual encoding takes place in this worker

		const onMessage = (data: WorkerResponse) => {
			const pending = this.pendingMessages.get(data.id);
			assert(pending !== undefined);

			this.pendingMessages.delete(data.id);
			if (data.success) {
				pending.resolve(data.data);
			} else {
				pending.reject(data.error);
			}
		};

		if (this.worker.addEventListener) {
			this.worker.addEventListener('message', event => onMessage(event.data as WorkerResponse));
		} else {
			const nodeWorker = this.worker as unknown as {
				on: (event: string, listener: (data: never) => void) => void;
			};
			nodeWorker.on('message', onMessage);
		}

		assert(this.config.bitrate);

		await this.sendCommand({
			type: 'init',
			data: {
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				bitrate: this.config.bitrate,
			},
		});

		this.chunkMetadata = {
			decoderConfig: {
				codec: 'mp3',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		};
	}

	async encode(audioSample: AudioSample) {
		if (this.currentTimestamp === null) {
			// The first sample's timestamp determines where we start
			this.currentTimestamp = audioSample.timestamp;
		}

		const sizePerChannel = audioSample.allocationSize({
			format: 's16-planar',
			planeIndex: 0,
		});

		const requiredBytes = audioSample.numberOfChannels * sizePerChannel;
		const audioData = new ArrayBuffer(requiredBytes);
		const audioBytes = new Uint8Array(audioData);

		for (let i = 0; i < audioSample.numberOfChannels; i++) {
			audioSample.copyTo(audioBytes.subarray(i * sizePerChannel), {
				format: 's16-planar', // LAME wants it in this format
				planeIndex: i,
			});
		}

		const result = await this.sendCommand({
			type: 'encode',
			data: {
				audioData,
				numberOfFrames: audioSample.numberOfFrames,
			},
		}, [audioData]);

		assert('encodedData' in result);
		this.digestOutput(new Uint8Array(result.encodedData));
	}

	async flush() {
		const result = await this.sendCommand({ type: 'flush' });

		assert('flushedData' in result);
		this.digestOutput(new Uint8Array(result.flushedData));
	}

	close() {
		this.worker?.terminate();
	}

	/**
	 * LAME returns data in chunks, but a chunk doesn't need to contain a full MP3 frame. Therefore, we must accumulate
	 * these chunks and extract the MP3 frames only when they're complete.
	 */
	private digestOutput(bytes: Uint8Array) {
		assert(this.currentTimestamp !== null);

		const requiredBufferSize = this.currentBufferOffset + bytes.length;
		if (requiredBufferSize > this.buffer.length) {
			// Grow the buffer to the required size
			const newSize = 1 << Math.ceil(Math.log2(requiredBufferSize));
			const newBuffer = new Uint8Array(newSize);
			newBuffer.set(this.buffer);
			this.buffer = newBuffer;
		}

		this.buffer.set(bytes, this.currentBufferOffset);
		this.currentBufferOffset = requiredBufferSize;

		let pos = 0;
		while (pos <= this.currentBufferOffset - FRAME_HEADER_SIZE) {
			const word = new DataView(this.buffer.buffer).getUint32(pos, false);
			const header = readMp3FrameHeader(word, null).header;
			if (!header) {
				break;
			}

			const fits = header.totalSize <= this.currentBufferOffset - pos;
			if (!fits) {
				// The frame isn't complete yet
				break;
			}

			const data = this.buffer.slice(pos, pos + header.totalSize);
			const duration = header.audioSamplesInFrame / header.sampleRate;
			this.onPacket(new EncodedPacket(data, 'key', this.currentTimestamp, duration), this.chunkMetadata);

			if (this.currentTimestamp === 0) {
				this.chunkMetadata = {}; // Mimic WebCodecs-like behavior
			}

			this.currentTimestamp += duration;
			pos += header.totalSize;
		}

		if (pos > 0) {
			// Shift the data
			this.buffer.set(this.buffer.subarray(pos, this.currentBufferOffset), 0);
			this.currentBufferOffset -= pos;
		}
	}

	private sendCommand(
		command: WorkerCommand,
		transferables?: Transferable[],
	) {
		return new Promise<WorkerResponseData>((resolve, reject) => {
			const id = this.nextMessageId++;
			this.pendingMessages.set(id, { resolve, reject });

			assert(this.worker);

			if (transferables) {
				this.worker.postMessage({ id, command }, transferables);
			} else {
				this.worker.postMessage({ id, command });
			}
		});
	}
}

/**
 * Registers the LAME MP3 encoder, which Mediabunny will then use automatically when applicable. Make sure to call this
 * function before starting any encoding task.
 *
 * Preferably, wrap the call in a condition to avoid overriding any native MP3 encoder:
 *
 * ```ts
 * import { canEncodeAudio } from 'mediabunny';
 * import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
 *
 * if (!(await canEncodeAudio('mp3'))) {
 *     registerMp3Encoder();
 * }
 * ```
 *
 * @group \@mediabunny/mp3-encoder
 * @public
 */
export const registerMp3Encoder = () => {
	registerEncoder(Mp3Encoder);
};

function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}
