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
import { AC3_SAMPLE_RATES } from '../../../shared/ac3-misc';

class Ac3Encoder extends CustomAudioEncoder {
	private ctx = 0;
	private encoderFrameSize = 0;
	private sampleRate = 0;
	private numberOfChannels = 0;
	private chunkMetadata: EncodedAudioChunkMetadata = {};

	// Accumulate interleaved f32 samples until we have a full frame
	private pendingBuffer = new Float32Array(2 ** 16);
	private pendingFrames = 0;
	private nextSampleTimestampInSamples: number | null = null;
	private encodedEndTimestampInSamples = 0;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		// FFmpeg's encoders top out at 5.1 and can't do E-AC-3's reduced sample rates
		return (codec === 'ac3' || codec === 'eac3')
			&& config.numberOfChannels >= 1
			&& config.numberOfChannels <= 6
			&& AC3_SAMPLE_RATES.includes(config.sampleRate)
			&& config.bitrate !== undefined
			// FFmpeg snaps AC-3 bitrates to the closest valid one, but rejects E-AC-3 bitrates outside of what
			// six-block and single-block syncframes can hold
			&& (
				codec === 'ac3'
				|| (
					config.bitrate >= 16 * Math.ceil(config.sampleRate / 1536)
					&& config.bitrate <= 16 * Math.floor(2048 * config.sampleRate / 256)
				)
			);
	}

	async init() {
		await refWorker();

		assert(this.config.bitrate !== undefined);
		this.sampleRate = this.config.sampleRate;
		this.numberOfChannels = this.config.numberOfChannels;

		const result = await sendCommand({
			type: 'init-encoder',
			data: {
				codec: this.codec,
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

		this.chunkMetadata = {
			decoderConfig: {
				codec: this.codec === 'ac3' ? 'ac-3' : 'ec-3',
				numberOfChannels: this.config.numberOfChannels,
				sampleRate: this.config.sampleRate,
			},
		};
	}

	async encode(audioSample: AudioSample) {
		if (this.nextSampleTimestampInSamples === null) {
			this.nextSampleTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate);
			this.encodedEndTimestampInSamples = this.nextSampleTimestampInSamples;
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

		// Shift the remainder to the front only once at the end, as doing it per frame is quadratic for big samples
		let encodedFrames = 0;
		while (this.pendingFrames - encodedFrames >= this.encoderFrameSize) {
			await this.encodeOneFrame(encodedFrames);
			encodedFrames += this.encoderFrameSize;
		}

		this.pendingBuffer.copyWithin(0, encodedFrames * channels, this.pendingFrames * channels);
		this.pendingFrames -= encodedFrames;
	}

	async flush() {
		if (this.nextSampleTimestampInSamples !== null) {
			const channels = this.numberOfChannels;
			const frameSize = this.encoderFrameSize;
			const endTimestampInSamples = this.nextSampleTimestampInSamples + this.pendingFrames;

			// Pad with silence until every sample has made it out. The encoder's output lags behind its input, so this
			// can take an extra frame (the bridge drops whatever flushing the encoder would yield).
			while (this.encodedEndTimestampInSamples < endTimestampInSamples) {
				this.pendingBuffer.fill(0, this.pendingFrames * channels, frameSize * channels);
				this.pendingFrames = 0;

				await this.encodeOneFrame(0);
			}
		}

		await sendCommand({ type: 'flush-encoder', data: { ctx: this.ctx } });

		this.resetInternalState();
	}

	close() {
		// Close shouldn't throw
		sendCommand({ type: 'close-encoder', data: { ctx: this.ctx } }).catch(() => {});
		void unrefWorker();
	}

	private async encodeOneFrame(startFrame: number) {
		assert(this.nextSampleTimestampInSamples !== null);

		const channels = this.numberOfChannels;
		const frameData = this.pendingBuffer.slice(
			startFrame * channels,
			(startFrame + this.encoderFrameSize) * channels,
		);

		const audioData = frameData.buffer;
		const result = await sendCommand({
			type: 'encode',
			data: {
				ctx: this.ctx,
				audioData,
				timestamp: this.nextSampleTimestampInSamples,
			},
		}, [audioData]);

		this.nextSampleTimestampInSamples += this.encoderFrameSize;
		this.encodedEndTimestampInSamples = result.pts + result.duration;

		// We always get exactly one packet because we encode the correct frame size
		const packet = new EncodedPacket(
			new Uint8Array(result.encodedData),
			'key',
			result.pts / this.sampleRate,
			result.duration / this.sampleRate,
		);

		this.onPacket(
			packet,
			this.chunkMetadata,
		);

		this.chunkMetadata = {};
	}
}

let registered = false;

/**
 * Registers AC-3 and E-AC-3 encoders, which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any encoding task.
 *
 * @group \@mediabunny/ac3
 * @public
 */
export const registerAc3Encoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerEncoder(Ac3Encoder);
};
