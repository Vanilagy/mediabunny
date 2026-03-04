/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	CustomAudioEncoder,
	AudioCodec,
	AudioSample,
	EncodedPacket,
	registerEncoder,
} from 'mediabunny';
import type { PacketInfo, WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';
// @ts-expect-error An esbuild plugin handles this, TypeScript doesn't need to understand
import createWorker from './encode.worker';

const FLAC_SAMPLE_RATES = [
	8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
];

class FlacEncoder extends CustomAudioEncoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: WorkerResponseData) => void;
		reject: (reason?: unknown) => void;
	}>();

	private ctx = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};
	private description: Uint8Array | null = null;
	private nextTimestampInSamples: number | null = null;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		return codec === 'flac'
			&& config.numberOfChannels >= 1
			&& config.numberOfChannels <= 8
			&& FLAC_SAMPLE_RATES.includes(config.sampleRate);
	}

	async init() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.worker = (await createWorker()) as Worker;

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

		const result = await this.sendCommand({
			type: 'init',
			data: {
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		});

		this.ctx = result.ctx;

		this.description = new Uint8Array(result.header);
		this.resetInternalState();
	}

	private resetInternalState() {
		this.nextTimestampInSamples = null;

		this.chunkMetadata = {
			decoderConfig: {
				codec: 'flac',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				description: this.description!,
			},
		};
	}

	async encode(audioSample: AudioSample) {
		if (this.nextTimestampInSamples === null) {
			this.nextTimestampInSamples = Math.round(audioSample.timestamp * this.config.sampleRate);
		}

		const totalBytes = audioSample.allocationSize({ format: 's16', planeIndex: 0 });
		const audioBytes = new Uint8Array(totalBytes);
		audioSample.copyTo(audioBytes, { format: 's16', planeIndex: 0 });

		const audioData = audioBytes.buffer;
		const result = await this.sendCommand({
			type: 'encode',
			data: {
				ctx: this.ctx,
				audioData,
				numSamples: audioSample.numberOfFrames,
			},
		}, [audioData]);

		this.emitPackets(result.packets);
	}

	async flush() {
		const result = await this.sendCommand({ type: 'flush', data: { ctx: this.ctx } });
		this.emitPackets(result.packets);

		this.resetInternalState();
	}

	close() {
		this.worker?.terminate();
	}

	private emitPackets(packets: PacketInfo[]) {
		assert(this.nextTimestampInSamples !== null);

		for (const p of packets) {
			const data = new Uint8Array(p.encodedData);

			const packet = new EncodedPacket(
				data,
				'key',
				this.nextTimestampInSamples / this.config.sampleRate,
				p.samples / this.config.sampleRate,
			);
			this.nextTimestampInSamples += p.samples;

			this.onPacket(
				packet,
				this.chunkMetadata,
			);

			this.chunkMetadata = {};
		}
	}

	private sendCommand<T extends string>(
		command: WorkerCommand & { type: T },
		transferables?: Transferable[],
	) {
		return new Promise<WorkerResponseData & { type: T }>((resolve, reject) => {
			const id = this.nextMessageId++;
			this.pendingMessages.set(id, {
				resolve: resolve as (value: WorkerResponseData) => void,
				reject,
			});

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
 * Registers the FLAC encoder, which Mediabunny will then use automatically when applicable. Make sure to call this
 * function before starting any encoding task.
 *
 * Preferably, wrap the call in a condition to avoid overriding any native FLAC encoder:
 *
 * ```ts
 * import { canEncodeAudio } from 'mediabunny';
 * import { registerFlacEncoder } from '@mediabunny/flac-encoder';
 *
 * if (!(await canEncodeAudio('flac'))) {
 *     registerFlacEncoder();
 * }
 * ```
 *
 * @group \@mediabunny/flac-encoder
 * @public
 */
export const registerFlacEncoder = () => {
	registerEncoder(FlacEncoder);
};

function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}
