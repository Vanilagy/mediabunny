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
import { sendCommand, refWorker, unrefWorker } from './worker-client';
import { assert, BATCH_SAMPLE_COUNT, EncodedChunk } from './shared';
import { TRUEHD_CHANNEL_COUNTS, TRUEHD_MAJOR_SYNC_WORD, TRUEHD_SAMPLE_RATES } from '../../../shared/truehd-misc';

class TrueHdEncoder extends CustomAudioEncoder {
	private ctx = 0;
	private encoderFrameSize = 0;
	private sampleRate = 0;
	private numberOfChannels = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};

	// Accumulate interleaved f32 samples until we have a full batch
	private pendingBuffer = new Float32Array(2 ** 16);
	private pendingFrames = 0;
	private nextSampleTimestampInSamples: number | null = null;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		return codec === 'truehd'
			&& TRUEHD_CHANNEL_COUNTS.includes(config.numberOfChannels)
			&& TRUEHD_SAMPLE_RATES.includes(config.sampleRate);
	}

	async init() {
		await refWorker();

		this.sampleRate = this.config.sampleRate;
		this.numberOfChannels = this.config.numberOfChannels;

		const result = await sendCommand({
			type: 'init-encoder',
			data: {
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		});

		this.ctx = result.ctx;
		this.encoderFrameSize = result.frameSize;

		this.resetInternalState();
	}

	private resetInternalState() {
		this.pendingFrames = 0;
		this.nextSampleTimestampInSamples = null;

		this.chunkMetadata = {
			decoderConfig: {
				codec: 'mlpa',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		};
	}

	async encode(audioSample: AudioSample) {
		if (this.nextSampleTimestampInSamples === null) {
			this.nextSampleTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate);
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

		if (this.pendingFrames >= BATCH_SAMPLE_COUNT) {
			// Only whole frames for now, since the encoder accepts a short frame only at the very end
			await this.encodePendingFrames(this.pendingFrames - this.pendingFrames % this.encoderFrameSize);
		}
	}

	async flush() {
		if (this.pendingFrames > 0) {
			await this.encodePendingFrames(this.pendingFrames);
		}

		const result = await sendCommand({ type: 'flush-encoder', data: { ctx: this.ctx } });
		this.emitPackets(result.packets);

		this.resetInternalState();
	}

	close() {
		// Close shouldn't throw
		sendCommand({ type: 'close-encoder', data: { ctx: this.ctx } }).catch(() => {});
		void unrefWorker();
	}

	private async encodePendingFrames(frameCount: number) {
		assert(this.nextSampleTimestampInSamples !== null);

		const channels = this.numberOfChannels;
		const sampleCount = frameCount * channels;

		const audioData = this.pendingBuffer.slice(0, sampleCount).buffer;

		// Shift remaining using copyWithin
		this.pendingFrames -= frameCount;
		if (this.pendingFrames > 0) {
			this.pendingBuffer.copyWithin(0, sampleCount, sampleCount + this.pendingFrames * channels);
		}

		const result = await sendCommand({
			type: 'encode',
			data: {
				ctx: this.ctx,
				audioData,
				sampleCount: frameCount,
				timestamp: this.nextSampleTimestampInSamples,
			},
		}, [audioData]);

		this.nextSampleTimestampInSamples += frameCount;

		this.emitPackets(result.packets);
	}

	private emitPackets(packets: EncodedChunk[]) {
		for (const { encodedData, pts, duration } of packets) {
			// Only access units carrying a major sync are restart points
			const syncWord = encodedData.byteLength >= 8 ? new DataView(encodedData).getUint32(4) : null;

			const packet = new EncodedPacket(
				new Uint8Array(encodedData),
				syncWord === TRUEHD_MAJOR_SYNC_WORD ? 'key' : 'delta',
				pts / this.sampleRate,
				duration / this.sampleRate,
			);

			this.onPacket(
				packet,
				this.chunkMetadata,
			);

			this.chunkMetadata = {};
		}
	}
}

let registered = false;

/**
 * Registers a TrueHD audio encoder, which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any encoding task.
 *
 * @group \@mediabunny/truehd
 * @public
 */
export const registerTrueHdEncoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerEncoder(TrueHdEncoder);
};
