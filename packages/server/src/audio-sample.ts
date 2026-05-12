/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioSampleResource } from 'mediabunny';
import * as NodeAv from 'node-av';
import { toAudioSampleFormat } from './misc';
import { assert, toUint8Array } from '../../../src/misc';

/**
 * A custom `AudioSampleResource` backed by NodeAV's
 * [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html), which in turn is backed by FFmpeg's
 * [`AVFrame`](https://ffmpeg.org/doxygen/2.7/structAVFrame.html). You can use this resource to create `AudioSample`
 * instances that are directly backed by FFmpeg's `AVFrame` without data having to be copied.
 *
 * @group \@mediabunny/server
 * @public
 */
export class NodeAvFrameAudioSampleResource extends AudioSampleResource {
	/** @internal */
	_frame: NodeAv.Frame | null;

	/**
	 * The NodeAV [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html) instance backing this resource.
	 * Access throws if the resource has already been closed.
	 */
	get frame() {
		if (!this._frame) {
			throw new Error('NodeAvFrameAudioSampleResource has been closed.');
		}

		return this._frame;
	}

	constructor(frame: NodeAv.Frame) {
		super();

		if (frame.getMediaType() !== NodeAv.AVMEDIA_TYPE_AUDIO) {
			throw new Error('NodeAvFrameAudioSampleResource must be initialized with an audio frame.');
		}

		this._frame = frame;
	}

	getFormat(): AudioSampleFormat {
		const result = toAudioSampleFormat(this.frame.format as NodeAv.AVSampleFormat);
		if (result === null) {
			throw new TypeError('Unsupported audio sample format: ' + this.frame.format);
		}

		return result;
	}

	getSampleRate(): number {
		return this.frame.sampleRate;
	}

	getNumberOfChannels(): number {
		return this.frame.channels;
	}

	getNumberOfFrames(): number {
		return this.frame.nbSamples;
	}

	getTimestamp(): number {
		return Number(this.frame.pts) / this.frame.timeBase.den;
	}

	close(): void {
		this.frame.free();
		this._frame = null;
	}

	getDataPlane(planeIndex: number): Uint8Array {
		assert(this.frame.data && planeIndex < this.frame.data.length);
		return toUint8Array(this.frame.data[planeIndex]!);
	}
}
