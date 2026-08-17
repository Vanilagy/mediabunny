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
import { assert } from './shared';
import { DTS_CHANNEL_COUNTS, DTS_SAMPLE_RATES, dtsBitrateFits } from '../../../shared/dts-misc';

class DtsEncoder extends CustomAudioEncoder {
	private ctx = 0;
	private encoderFrameSize = 0;
	private sampleRate = 0;
	private numberOfChannels = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};

	// Accumulate interleaved f32 samples until we have a full frame
	private pendingBuffer = new Float32Array(2 ** 16);
	private pendingFrames = 0;
	private nextSampleTimestampInSamples: number | null = null;
	private nextPacketTimestampInSamples: number | null = null;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		return codec === 'dts'
			&& DTS_CHANNEL_COUNTS.includes(config.numberOfChannels)
			&& DTS_SAMPLE_RATES.includes(config.sampleRate)
			&& config.bitrate !== undefined
			&& dtsBitrateFits(config.bitrate, config.sampleRate, config.numberOfChannels);
	}

	async init() {
		await refWorker();

		assert(this.config.bitrate !== undefined);
		this.sampleRate = this.config.sampleRate;
		this.numberOfChannels = this.config.numberOfChannels;

		const result = await sendCommand({
			type: 'init-encoder',
			data: {
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
				bitrate: this.config.bitrate,
			},
		});

		this.ctx = result.ctx;
		this.encoderFrameSize = result.frameSize;

		this.resetInternalState();
	}

	private resetInternalState() {
		this.pendingFrames = 0;
		this.nextSampleTimestampInSamples = null;
		this.nextPacketTimestampInSamples = null;

		this.chunkMetadata = {
			decoderConfig: {
				codec: 'dtsc',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
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

		await sendCommand({ type: 'flush-encoder', data: { ctx: this.ctx } });

		this.resetInternalState();
	}

	close() {
		void sendCommand({ type: 'close-encoder', data: { ctx: this.ctx } });
		void unrefWorker();
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
		const result = await sendCommand({
			type: 'encode',
			data: {
				ctx: this.ctx,
				audioData,
				timestamp: this.nextSampleTimestampInSamples,
			},
		}, [audioData]);

		this.nextSampleTimestampInSamples += frameSize;

		// We always get exactly one packet because we encode the correct frame size
		const packet = new EncodedPacket(
			new Uint8Array(result.encodedData),
			'key',
			this.nextPacketTimestampInSamples / this.sampleRate,
			result.duration / this.sampleRate,
		);

		this.nextPacketTimestampInSamples += result.duration;

		this.onPacket(
			packet,
			this.chunkMetadata,
		);

		this.chunkMetadata = {};
	}
}

let registered = false;

/**
 * Registers a DTS audio encoder, which Mediabunny will then use automatically when applicable. Make sure to call this
 * function before starting any encoding task.
 *
 * @group \@mediabunny/dts
 * @public
 */
export const registerDtsEncoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerEncoder(DtsEncoder);
};
