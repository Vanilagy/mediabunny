/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomAudioDecoder, CustomAudioEncoder, AudioCodec, EncodedPacket, AudioSample, registerDecoder, registerEncoder } from 'mediabunny';
import type { DecoderCommand, EncoderCommand, DecoderResponseData, EncoderResponseData, WorkerResponse } from './shared';
import decodeWorkerUrl from './decode.worker?url';
import encodeWorkerUrl from './encode.worker?url';

const createWorker = (url: string): Worker => {
	return new Worker(url, { type: 'module' });
};

const AV_CODEC_ID_AC3 = 0x15003;
const AV_CODEC_ID_EAC3 = 0x15028;

class Eac3Decoder extends CustomAudioDecoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: DecoderResponseData) => void;
		reject: (reason?: unknown) => void;
	}>();

	static override supports(codec: AudioCodec, config: AudioDecoderConfig): boolean {
		return codec === 'eac3' || codec === 'ac3';
	}

	async init() {
		this.worker = createWorker(decodeWorkerUrl);

		const onMessage = (event: MessageEvent<WorkerResponse>) => {
			const data = event.data;
			const pending = this.pendingMessages.get(data.id);
			assert(pending !== undefined);

			this.pendingMessages.delete(data.id);
			if (data.success) {
				pending.resolve(data.data as DecoderResponseData);
			} else {
				pending.reject(data.error);
			}
		};

		this.worker.addEventListener('message', onMessage);

		await this.sendCommand({
			type: 'init',
			data: {
				sampleRate: this.config.sampleRate,
				channels: this.config.numberOfChannels,
				codec: this.codec as 'eac3' | 'ac3',
			},
		});
	}

	async decode(packet: EncodedPacket) {
		const packetData = packet.data.slice().buffer;

		const result = await this.sendCommand({
			type: 'decode',
			data: { packetData },
		}, [packetData]);

		if (!result || !('pcmData' in result)) {
			return;
		}

		const audioSample = new AudioSample({
			data: new Float32Array(result.pcmData),
			format: 'f32',
			numberOfChannels: result.channels,
			sampleRate: result.sampleRate,
			timestamp: packet.timestamp,
		});

		this.onSample(audioSample);
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
		command: DecoderCommand,
		transferables?: Transferable[],
	) {
		return new Promise<DecoderResponseData>((resolve, reject) => {
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

class Eac3Encoder extends CustomAudioEncoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: EncoderResponseData) => void;
		reject: (reason?: unknown) => void;
	}>();

	private currentTimestamp = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		return codec === 'eac3' || codec === 'ac3';
	}

	async init() {
		this.worker = createWorker(encodeWorkerUrl);

		const onMessage = (event: MessageEvent<WorkerResponse>) => {
			const data = event.data;
			const pending = this.pendingMessages.get(data.id);
			assert(pending !== undefined);

			this.pendingMessages.delete(data.id);
			if (data.success) {
				pending.resolve(data.data as EncoderResponseData);
			} else {
				pending.reject(data.error);
			}
		};

		this.worker.addEventListener('message', onMessage);

		assert(this.config.bitrate);

		await this.sendCommand({
			type: 'init',
			data: {
				sampleRate: this.config.sampleRate,
				channels: this.config.numberOfChannels,
				bitrate: this.config.bitrate,
				codec: this.codec as 'eac3' | 'ac3',
			},
		});

		this.chunkMetadata = {
			decoderConfig: {
				codec: this.codec === 'eac3' ? 'ec-3' : 'ac3',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		};
	}

	async encode(audioSample: AudioSample) {
		const sizePerChannel = audioSample.allocationSize({
			format: 'f32-planar',
			planeIndex: 0,
		});

		const requiredBytes = audioSample.numberOfChannels * sizePerChannel;
		const audioData = new ArrayBuffer(requiredBytes);
		const audioBytes = new Uint8Array(audioData);

		for (let i = 0; i < audioSample.numberOfChannels; i++) {
			audioSample.copyTo(audioBytes.subarray(i * sizePerChannel), {
				format: 'f32-planar',
				planeIndex: i,
			});
		}

		const result = await this.sendCommand({
			type: 'encode',
			data: {
				pcmData: audioData,
				numberOfFrames: audioSample.numberOfFrames,
			},
		}, [audioData]);

		assert(result && 'encodedData' in result);

		const duration = audioSample.numberOfFrames / this.config.sampleRate;
		const encodedPacket = new EncodedPacket(
			new Uint8Array(result.encodedData),
			'key',
			this.currentTimestamp,
			duration,
		);

		this.onPacket(encodedPacket, this.currentTimestamp === 0 ? this.chunkMetadata : undefined);

		if (this.currentTimestamp === 0) {
			this.chunkMetadata = {};
		}

		this.currentTimestamp += duration;
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
		command: EncoderCommand,
		transferables?: Transferable[],
	) {
		return new Promise<EncoderResponseData>((resolve, reject) => {
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
 * Registers the E-AC-3/AC-3 decoder, which Mediabunny will then use automatically when applicable.
 * Make sure to call this function before starting any decoding task.
 *
 * @group \@mediabunny/eac3
 * @public
 */
export const registerEac3Decoder = () => {
	registerDecoder(Eac3Decoder);
};

/**
 * Registers the E-AC-3/AC-3 encoder, which Mediabunny will then use automatically when applicable.
 * Make sure to call this function before starting any encoding task.
 *
 * @group \@mediabunny/eac3
 * @public
 */
export const registerEac3Encoder = () => {
	registerEncoder(Eac3Encoder);
};

function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}
