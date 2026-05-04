/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	type AdtsHeaderTemplate,
	buildAdtsHeaderTemplate,
	parseAacAudioSpecificConfig,
	writeAdtsFrameLength,
} from '../../../shared/aac-misc';
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

const AAC_SAMPLE_RATES = [
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

class AacEncoder extends CustomAudioEncoder {
	private worker: Worker | null = null;
	private nextMessageId = 0;
	private pendingMessages = new Map<number, {
		resolve: (value: WorkerResponseData) => void;
		reject: (reason?: unknown) => void;
	}>();

	private ctx = 0;
	private encoderFrameSize = 0;
	private sampleRate = 0;
	private numberOfChannels = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};
	private useAdts = false;
	private adtsHeaderTemplate: AdtsHeaderTemplate | null = null;
	private description: Uint8Array | null = null;

	// Accumulate interleaved f32 samples until we have a full frame
	private pendingBuffer = new Float32Array(2 ** 16);
	private pendingFrames = 0;
	private nextSampleTimestampInSamples: number | null = null;
	private nextPacketTimestampInSamples: number | null = null;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		return codec === 'aac'
			&& config.numberOfChannels >= 1
			&& config.numberOfChannels <= 8
			&& AAC_SAMPLE_RATES.includes(config.sampleRate)
			&& config.bitrate !== undefined;
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

		assert(this.config.bitrate !== undefined);
		this.sampleRate = this.config.sampleRate;
		this.numberOfChannels = this.config.numberOfChannels;

		const result = await this.sendCommand({
			type: 'init',
			data: {
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				bitrate: this.config.bitrate,
			},
		});

		this.ctx = result.ctx;
		this.encoderFrameSize = result.frameSize;

		// The ffmpeg encoder provides an AudioSpecificConfig as extradata after init
		const description = new Uint8Array(result.extradata);

		const aacConfig = (this.config as { aac?: { format?: 'aac' | 'adts' } }).aac;
		this.useAdts = aacConfig?.format === 'adts';

		if (this.useAdts) {
			const audioSpecificConfig = parseAacAudioSpecificConfig(description);
			this.adtsHeaderTemplate = buildAdtsHeaderTemplate(audioSpecificConfig);
		}

		this.description = this.useAdts ? null : description;
		this.resetInternalState();
	}

	private resetInternalState() {
		this.pendingFrames = 0;
		this.nextSampleTimestampInSamples = null;
		this.nextPacketTimestampInSamples = null;

		this.chunkMetadata = {
			decoderConfig: {
				codec: 'mp4a.40.2',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				...(this.description ? { description: this.description } : {}),
			},
		};
	}

	async encode(audioSample: AudioSample) {
		if (this.nextSampleTimestampInSamples === null) {
			this.nextSampleTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate);
			this.nextPacketTimestampInSamples = this.nextSampleTimestampInSamples;
		}

		const channels = this.numberOfChannels;
		const incomingFrames = audioSample.numberOfFrames;

		// Extract interleaved f32 data
		const totalBytes = audioSample.allocationSize({ format: 'f32', planeIndex: 0 });
		const audioBytes = new Uint8Array(totalBytes);
		audioSample.copyTo(audioBytes, { format: 'f32', planeIndex: 0 });
		const incomingData = new Float32Array(audioBytes.buffer);

		const requiredSamples = (this.pendingFrames + incomingFrames) * channels;
		if (requiredSamples > this.pendingBuffer.length) {
			let newSize = this.pendingBuffer.length;
			while (newSize < requiredSamples) {
				newSize *= 2;
			}
			const newBuffer = new Float32Array(newSize);
			newBuffer.set(this.pendingBuffer.subarray(0, this.pendingFrames * channels));
			this.pendingBuffer = newBuffer;
		}
		this.pendingBuffer.set(incomingData, this.pendingFrames * channels);
		this.pendingFrames += incomingFrames;

		while (this.pendingFrames >= this.encoderFrameSize) {
			await this.encodeOneFrame();
		}
	}

	async flush() {
		// Pad remaining samples with silence to fill a full frame
		if (this.pendingFrames > 0) {
			const channels = this.numberOfChannels;
			const frameSize = this.encoderFrameSize;
			const usedSamples = this.pendingFrames * channels;
			const frameSamples = frameSize * channels;

			this.pendingBuffer.fill(0, usedSamples, frameSamples);
			this.pendingFrames = frameSize;

			await this.encodeOneFrame();
		}

		const result = await this.sendCommand({ type: 'flush', data: { ctx: this.ctx } });
		this.emitPackets(result.packets);

		this.resetInternalState();
	}

	close() {
		this.worker?.terminate();
	}

	private async encodeOneFrame() {
		assert(this.nextSampleTimestampInSamples !== null);
		assert(this.nextPacketTimestampInSamples !== null);

		const channels = this.numberOfChannels;
		const frameSize = this.encoderFrameSize;
		const frameSamples = frameSize * channels;

		const frameData = this.pendingBuffer.slice(0, frameSamples);

		// Shift remaining using copyWithin
		this.pendingFrames -= frameSize;
		if (this.pendingFrames > 0) {
			this.pendingBuffer.copyWithin(0, frameSamples, frameSamples + this.pendingFrames * channels);
		}

		const audioData = frameData.buffer;
		const result = await this.sendCommand({
			type: 'encode',
			data: {
				ctx: this.ctx,
				audioData,
				timestamp: this.nextSampleTimestampInSamples,
			},
		}, [audioData]);

		this.nextSampleTimestampInSamples += frameSize;

		this.emitPackets(result.packets);
	}

	private emitPackets(packets: PacketInfo[]) {
		assert(this.nextPacketTimestampInSamples !== null);

		for (const p of packets) {
			let data = new Uint8Array(p.encodedData);

			if (this.useAdts) {
				assert(this.adtsHeaderTemplate !== null);
				const { header, bitstream } = this.adtsHeaderTemplate;
				const frameLength = header.byteLength + data.byteLength;
				writeAdtsFrameLength(bitstream, frameLength);

				const adtsFrame = new Uint8Array(frameLength);
				adtsFrame.set(header, 0);
				adtsFrame.set(data, header.byteLength);
				data = adtsFrame;
			}

			const packet = new EncodedPacket(
				data,
				'key',
				this.nextPacketTimestampInSamples / this.sampleRate,
				p.duration / this.sampleRate,
			);

			this.nextPacketTimestampInSamples += p.duration;

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
 * Registers the AAC encoder, which Mediabunny will then use automatically when applicable. Make sure to call this
 * function before starting any encoding task.
 *
 * Preferably, wrap the call in a condition to avoid overriding any native AAC encoder:
 *
 * ```ts
 * import { canEncodeAudio } from 'mediabunny';
 * import { registerAacEncoder } from '@mediabunny/aac-encoder';
 *
 * if (!(await canEncodeAudio('aac'))) {
 *     registerAacEncoder();
 * }
 * ```
 *
 * @group \@mediabunny/aac-encoder
 * @public
 */
export const registerAacEncoder = () => {
	registerEncoder(AacEncoder);
};

function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}
