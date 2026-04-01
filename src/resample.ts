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
 * Utility class to handle audio resampling, handling both sample rate resampling as well as channel up/downmixing.
 * The advantage over doing this manually rather than using OfflineAudioContext to do it for us is the artifact-free
 * handling of putting multiple resampled audio samples back to back, which produces flaky results using
 * OfflineAudioContext.
 */
export class AudioResampler {
	sourceSampleRate: number | null = null;
	targetSampleRate: number;
	sourceNumberOfChannels: number | null = null;
	targetNumberOfChannels: number;
	startTime: number;
	endTime: number;
	onSample: (sample: AudioSample) => Promise<void>;

	bufferSizeInFrames: number;
	bufferSizeInSamples: number;
	outputBuffer: Float32Array;
	/** Start frame of current buffer */
	bufferStartFrame: number;
	/** The highest index written to in the current buffer */
	maxWrittenFrame: number | null = null;
	channelMixer!: (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => number;
	tempSourceBuffer!: Float32Array;

	constructor(options: {
		targetSampleRate: number;
		targetNumberOfChannels: number;
		startTime: number;
		endTime: number;
		onSample: (sample: AudioSample) => Promise<void>;
	}) {
		this.targetSampleRate = options.targetSampleRate;
		this.targetNumberOfChannels = options.targetNumberOfChannels;
		this.startTime = options.startTime;
		this.endTime = options.endTime;
		this.onSample = options.onSample;

		this.bufferSizeInFrames = Math.floor(this.targetSampleRate * 5.0); // 5 seconds
		this.bufferSizeInSamples = this.bufferSizeInFrames * this.targetNumberOfChannels;

		this.outputBuffer = new Float32Array(this.bufferSizeInSamples);
		this.bufferStartFrame = Math.floor(this.startTime * this.targetSampleRate);
	}

	/**
	 * Sets up the channel mixer to handle up/downmixing in the case where input and output channel counts don't match.
	 */
	doChannelMixerSetup(): void {
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
				return sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 2 && targetNum === 6) {
			// Stereo to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]! * +(targetChannelIndex < 2);
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

	ensureTempBufferSize(requiredSamples: number): void {
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

	async add(audioSample: AudioSample) {
		if (this.sourceSampleRate === null) {
			// This is the first sample, so let's init the missing data. Initting the sample rate from the decoded
			// sample is more reliable than using the file's metadata, because decoders are free to emit any sample rate
			// they see fit.
			this.sourceSampleRate = audioSample.sampleRate;
			this.sourceNumberOfChannels = audioSample.numberOfChannels;

			// Pre-allocate temporary buffer for source data
			this.tempSourceBuffer = new Float32Array(this.sourceSampleRate * this.sourceNumberOfChannels);

			this.doChannelMixerSetup();
		}

		const requiredSamples = audioSample.numberOfFrames * audioSample.numberOfChannels;
		this.ensureTempBufferSize(requiredSamples);

		// Copy the audio data to the temp buffer
		const sourceDataSize = audioSample.allocationSize({ planeIndex: 0, format: 'f32' });
		const sourceView = new Float32Array(this.tempSourceBuffer.buffer, 0, sourceDataSize / 4);
		audioSample.copyTo(sourceView, { planeIndex: 0, format: 'f32' });

		const inputStartTime = audioSample.timestamp;
		const inputEndTime = Math.min(audioSample.timestamp + audioSample.duration, this.endTime);

		// Compute which output frames are affected by this sample
		const outputStartFrame = Math.floor(inputStartTime * this.targetSampleRate);
		const outputEndFrame = Math.ceil(inputEndTime * this.targetSampleRate);

		for (let outputFrame = outputStartFrame; outputFrame < outputEndFrame; outputFrame++) {
			if (outputFrame < this.bufferStartFrame) {
				continue; // Skip writes to the past
			}

			while (outputFrame >= this.bufferStartFrame + this.bufferSizeInFrames) {
				// The write is after the current buffer, so finalize it
				await this.finalizeCurrentBuffer();
				this.bufferStartFrame += this.bufferSizeInFrames;
			}

			const bufferFrameIndex = outputFrame - this.bufferStartFrame;
			assert(bufferFrameIndex < this.bufferSizeInFrames);

			const outputTime = outputFrame / this.targetSampleRate;
			const inputTime = outputTime - inputStartTime;
			const sourcePosition = inputTime * this.sourceSampleRate;

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

	async finalizeCurrentBuffer() {
		if (this.maxWrittenFrame === null) {
			return; // Nothing to finalize
		}

		const samplesWritten = (this.maxWrittenFrame + 1) * this.targetNumberOfChannels;

		const outputData = new Float32Array(samplesWritten);
		outputData.set(this.outputBuffer.subarray(0, samplesWritten));

		const timestampSeconds = this.bufferStartFrame / this.targetSampleRate;
		const audioSample = new AudioSample({
			format: 'f32',
			sampleRate: this.targetSampleRate,
			numberOfChannels: this.targetNumberOfChannels,
			timestamp: timestampSeconds,
			data: outputData,
		});

		await this.onSample(audioSample);

		this.outputBuffer.fill(0);
		this.maxWrittenFrame = null;
	}

	finalize() {
		return this.finalizeCurrentBuffer();
	}
}
