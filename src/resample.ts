/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert } from './misc';
import { AudioSample } from './sample';

/**
 * Options for streaming audio resampling and channel remixing.
 * @group Samples
 * @public
 */
export type AudioResamplerOptions = {
	/** The output sample rate in hertz. Must be a positive integer. */
	targetSampleRate: number;
	/** The output channel count. Must be a positive integer. */
	targetNumberOfChannels: number;
	/**
	 * Receives resampled f32 audio. The callback owns each sample and must close it when finished.
	 * Its promise is awaited before producing more output, providing backpressure.
	 */
	onSample: (sample: AudioSample) => Promise<void>;
};

/**
 * Incrementally resamples audio and remixes channels without an encoder or output container.
 * Uses the same linear interpolation and channel mapping as AudioSampleSource transformations.
 * Output is buffered in chunks of up to five seconds; call finalize to emit the remaining audio.
 *
 * Call add sequentially with samples from one stream, with constant sample rate and channel count.
 * Output timestamps use the first input timestamp as their time origin.
 * To abandon processing, stop calling add and discard the resampler without calling finalize. No input samples are
 * retained, and buffered PCM is garbage collected with the resampler. After an operation rejects, discard the instance.
 * @group Samples
 * @public
 */
export class AudioResampler {
	/** @internal */
	private sourceSampleRate: number | null = null;
	/** @internal */
	private targetSampleRate: number;
	/** @internal */
	private sourceNumberOfChannels: number | null = null;
	/** @internal */
	private targetNumberOfChannels: number;
	/** @internal */
	private startTime: number | null = null;
	/** @internal */
	private onSample: (sample: AudioSample) => Promise<void>;

	/** @internal */
	private bufferSizeInFrames: number;
	/** @internal */
	private bufferSizeInSamples: number;
	/** @internal */
	private bufferCapacityInFrames!: number;
	/** @internal */
	private outputBuffer!: Float32Array;
	/** Start frame of current buffer. @internal */
	private bufferStartFrame = 0;
	/** The highest index written to in the current buffer. @internal */
	private maxWrittenFrame: number | null = null;
	/** @internal */
	private channelMixer!: (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => number;
	/** @internal */
	private tempSourceBuffer!: Float32Array;

	/** Creates a resampler for one audio stream. */
	constructor(options: AudioResamplerOptions) {
		if (!Number.isInteger(options.targetSampleRate) || options.targetSampleRate <= 0) {
			throw new TypeError('options.targetSampleRate must be a positive integer.');
		}
		if (!Number.isInteger(options.targetNumberOfChannels) || options.targetNumberOfChannels <= 0) {
			throw new TypeError('options.targetNumberOfChannels must be a positive integer.');
		}
		this.targetSampleRate = options.targetSampleRate;
		this.targetNumberOfChannels = options.targetNumberOfChannels;
		this.onSample = options.onSample;

		this.bufferSizeInFrames = Math.floor(this.targetSampleRate * 5.0); // 5 seconds
		this.bufferSizeInSamples = this.bufferSizeInFrames * this.targetNumberOfChannels;
	}

	/**
	 * Sets up the channel mixer to handle up/downmixing in the case where input and output channel counts don't match.
	 * @internal
	 */
	private doChannelMixerSetup(): void {
		assert(this.sourceNumberOfChannels !== null);

		const sourceNum = this.sourceNumberOfChannels;
		const targetNum = this.targetNumberOfChannels;

		// Logic taken from
		// https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API
		// Most of the mapping functions are branchless.

		if (sourceNum === 1 && targetNum === 2) {
			// Mono to Stereo: M -> L, M -> R
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]!;
			};
		} else if (sourceNum === 1 && targetNum === 4) {
			// Mono to Quad: M -> L, M -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 1 && targetNum === 6) {
			// Mono to 5.1: 0 -> L, 0 -> R, M -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex === 2);
			};
		} else if (sourceNum === 2 && targetNum === 1) {
			// Stereo to Mono: 0.5 * (L + R)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!);
			};
		} else if (sourceNum === 2 && targetNum === 4) {
			// Stereo to Quad: L -> L, R -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < 2
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		} else if (sourceNum === 2 && targetNum === 6) {
			// Stereo to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < 2
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		} else if (sourceNum === 4 && targetNum === 1) {
			// Quad to Mono: 0.25 * (L + R + SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.25 * (
					sourceData[baseIdx]! + sourceData[baseIdx + 1]!
					+ sourceData[baseIdx + 2]! + sourceData[baseIdx + 3]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 2) {
			// Quad to Stereo: 0.5 * (L + SL), 0.5 * (R + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (
					sourceData[baseIdx + targetChannelIndex]!
					+ sourceData[baseIdx + targetChannelIndex + 2]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 6) {
			// Quad to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, SL -> SL, SR -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) return sourceData[baseIdx + targetChannelIndex]!; // L, R
				if (targetChannelIndex === 2 || targetChannelIndex === 3) return 0; // C, LFE
				return sourceData[baseIdx + targetChannelIndex - 2]!; // SL, SR
			};
		} else if (sourceNum === 6 && targetNum === 1) {
			// 5.1 to Mono: sqrt(1/2) * (L + R) + C + 0.5 * (SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return Math.SQRT1_2 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!)
					+ sourceData[baseIdx + 2]!
					+ 0.5 * (sourceData[baseIdx + 4]! + sourceData[baseIdx + 5]!);
			};
		} else if (sourceNum === 6 && targetNum === 2) {
			// 5.1 to Stereo: L + sqrt(1/2) * (C + SL), R + sqrt(1/2) * (C + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return sourceData[baseIdx + targetChannelIndex]!
					+ Math.SQRT1_2 * (sourceData[baseIdx + 2]! + sourceData[baseIdx + targetChannelIndex + 4]!);
			};
		} else if (sourceNum === 6 && targetNum === 4) {
			// 5.1 to Quad: L + sqrt(1/2) * C, R + sqrt(1/2) * C, SL, SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) {
					return sourceData[baseIdx + targetChannelIndex]! + Math.SQRT1_2 * sourceData[baseIdx + 2]!;
				}
				return sourceData[baseIdx + targetChannelIndex + 2]!; // SL, SR
			};
		} else {
			// Discrete fallback: direct mapping with zero-fill or drop
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < sourceNum
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		}
	}

	/** @internal */
	private ensureTempBufferSize(requiredSamples: number): void {
		let length = this.tempSourceBuffer.length;

		while (length < requiredSamples) {
			length *= 2;
		}

		if (length !== this.tempSourceBuffer.length) {
			const newBuffer = new Float32Array(length);
			newBuffer.set(this.tempSourceBuffer);
			this.tempSourceBuffer = newBuffer;
		}
	}

	/**
	 * Copies input PCM into the resampler, awaiting any output callbacks. The caller retains ownership of the input
	 * sample and may close it when this promise settles. Do not call concurrently with add or finalize.
	 */
	async add(audioSample: AudioSample) {
		if (this.sourceSampleRate === null) {
			// This is the first sample, so let's init the missing data. Initing the sample rate from the decoded
			// sample is more reliable than using the file's metadata, because decoders are free to emit any sample rate
			// they see fit.
			this.sourceSampleRate = audioSample.sampleRate;
			this.sourceNumberOfChannels = audioSample.numberOfChannels;
			this.startTime = audioSample.timestamp;

			// An input sample may map to more than one output sample, which is why we need padding in the buffer to not
			// lose any data
			const overflowFrames = Math.ceil(this.targetSampleRate / this.sourceSampleRate);
			this.bufferCapacityInFrames = this.bufferSizeInFrames + overflowFrames;
			this.outputBuffer = new Float32Array(
				this.bufferCapacityInFrames * this.targetNumberOfChannels,
			);

			// Pre-allocate temporary buffer for source data
			this.tempSourceBuffer = new Float32Array(this.sourceSampleRate * this.sourceNumberOfChannels);

			this.doChannelMixerSetup();
		}

		assert(this.startTime !== null);

		const requiredSamples = audioSample.numberOfFrames * audioSample.numberOfChannels;
		this.ensureTempBufferSize(requiredSamples);

		// Copy the audio data to the temp buffer
		const sourceDataSize = audioSample.allocationSize({ planeIndex: 0, format: 'f32' });
		const sourceView = new Float32Array(this.tempSourceBuffer.buffer, 0, sourceDataSize / 4);
		audioSample.copyTo(sourceView, { planeIndex: 0, format: 'f32' });

		// Audio sample is snapped to the input sample rate grid
		const sourceStartFrame = Math.round((audioSample.timestamp - this.startTime) * this.sourceSampleRate);
		const sourceEndFrame = sourceStartFrame + audioSample.numberOfFrames;

		// Compute which output frames are affected by this sample
		const outputStartFrame = Math.floor(
			(sourceStartFrame - 1) * this.targetSampleRate / this.sourceSampleRate,
		) + 1;
		const outputEndFrame = Math.ceil(sourceEndFrame * this.targetSampleRate / this.sourceSampleRate);

		for (let outputFrame = outputStartFrame; outputFrame < outputEndFrame; outputFrame++) {
			if (outputFrame < this.bufferStartFrame) {
				continue; // Skip writes to the past
			}

			while (outputFrame >= this.bufferStartFrame + this.bufferCapacityInFrames) {
				// The write is wholly after the current buffer, so finalize it
				await this.finalizeCurrentBuffer();
				this.bufferStartFrame += this.bufferSizeInFrames;
			}

			const bufferFrameIndex = outputFrame - this.bufferStartFrame;
			assert(bufferFrameIndex < this.bufferCapacityInFrames);

			const sourcePosition = outputFrame * this.sourceSampleRate / this.targetSampleRate - sourceStartFrame;

			const sourceLowerFrame = Math.floor(sourcePosition);
			const sourceUpperFrame = Math.ceil(sourcePosition);
			const fraction = sourcePosition - sourceLowerFrame;

			// Process each output channel
			for (let targetChannel = 0; targetChannel < this.targetNumberOfChannels; targetChannel++) {
				let lowerSample = 0;
				let upperSample = 0;

				if (sourceLowerFrame >= 0 && sourceLowerFrame < audioSample.numberOfFrames) {
					lowerSample = this.channelMixer(sourceView, sourceLowerFrame, targetChannel);
				}

				if (sourceUpperFrame >= 0 && sourceUpperFrame < audioSample.numberOfFrames) {
					upperSample = this.channelMixer(sourceView, sourceUpperFrame, targetChannel);
				}

				// For resampling, we do naive linear interpolation to find the in-between sample. This produces
				// suboptimal results especially for downsampling (for which a low-pass filter would first need to be
				// applied), but AudioContext doesn't do this either, so, whatever, for now.
				const outputSample = lowerSample + fraction * (upperSample - lowerSample);

				// Write to output buffer (interleaved)
				const outputIndex = bufferFrameIndex * this.targetNumberOfChannels + targetChannel;
				this.outputBuffer[outputIndex]! += outputSample; // Add in case of overlapping samples
			}

			if (this.maxWrittenFrame === null) {
				this.maxWrittenFrame = bufferFrameIndex;
			} else {
				this.maxWrittenFrame = Math.max(this.maxWrittenFrame, bufferFrameIndex);
			}
		}
	}

	/** @internal */
	private async finalizeCurrentBuffer() {
		if (this.maxWrittenFrame === null) {
			return; // Nothing to finalize
		}

		assert(this.startTime !== null);

		const samplesWritten = Math.min(this.maxWrittenFrame + 1, this.bufferSizeInFrames)
			* this.targetNumberOfChannels;

		const outputData = new Float32Array(samplesWritten);
		outputData.set(this.outputBuffer.subarray(0, samplesWritten));

		const audioSample = new AudioSample({
			format: 'f32',
			sampleRate: this.targetSampleRate,
			numberOfChannels: this.targetNumberOfChannels,
			timestamp: this.startTime + this.bufferStartFrame / this.targetSampleRate,
			data: outputData,
		});

		await this.onSample(audioSample);

		this.outputBuffer.copyWithin(0, this.bufferSizeInSamples);
		this.outputBuffer.fill(0, this.outputBuffer.length - this.bufferSizeInSamples);
		this.maxWrittenFrame = this.maxWrittenFrame >= this.bufferSizeInFrames
			? this.maxWrittenFrame - this.bufferSizeInFrames
			: null;
	}

	/** Emits all remaining buffered audio, awaiting output callbacks. Do not add more input afterward. */
	async finalize() {
		while (this.maxWrittenFrame !== null) {
			await this.finalizeCurrentBuffer();
			this.bufferStartFrame += this.bufferSizeInFrames;
		}
	}
}
