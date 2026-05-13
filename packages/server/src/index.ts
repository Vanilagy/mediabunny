/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioSample, registerDecoder, registerEncoder, registerVideoSampleTransformer, VideoSample } from 'mediabunny';
import * as NodeAv from 'node-av';
import { NodeAvVideoDecoder } from './video-decoder';
import { NodeAvVideoEncoder } from './video-encoder';
import { NodeAvAudioDecoder } from './audio-decoder';
import { NodeAvAudioEncoder } from './audio-encoder';
import { copyVideoSampleToAvFrame, AvFrameVideoSampleResource, transformVideoSample } from './video-sample';
import { copyAudioSampleToAvFrame, AvFrameAudioSampleResource } from './audio-sample';

const SERVER_LOADED_SYMBOL = Symbol.for('@mediabunny/server loaded');
if ((globalThis as Record<symbol, unknown>)[SERVER_LOADED_SYMBOL]) {
	console.error(
		'[WARNING]\n@mediabunny/server was loaded twice.'
		+ ' This will likely cause the package not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of @mediabunny/server,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[SERVER_LOADED_SYMBOL] = true;

let registered = false;

/**
 * Registers video and audio decoders and encoders for all codecs, using FFmpeg's libavcodec under the hood.
 * Additionally, a custom `VideoSample` transformer based on libavfilter is registered to enable resizing, rotation and
 * cropping of video frames.
 *
 * Make sure to call this function before interacting with Mediabunny.
 *
 * The decoders and encoders will automatically detect hardware acceleration support for each codec and platform and
 * make use of it if applicable.
 *
 * @group \@mediabunny/server
 * @public
 */
export const registerMediabunnyServer = () => {
	if (registered) {
		return;
	}
	registered = true;

	NodeAv.Log.setLevel(NodeAv.AV_LOG_ERROR);

	// Video
	registerDecoder(NodeAvVideoDecoder);
	registerEncoder(NodeAvVideoEncoder);

	// Audio
	registerDecoder(NodeAvAudioDecoder);
	registerEncoder(NodeAvAudioEncoder);

	registerVideoSampleTransformer(transformVideoSample);
};

export { AvFrameVideoSampleResource } from './video-sample';
export { AvFrameAudioSampleResource } from './audio-sample';

/**
 * Copies a `VideoSample` or `AudioSample` into the given NodeAV
 * [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html), setting up the frame's format, media type,
 * timing and data. When the sample is already backed by an `AVFrame` (via `AvFrameVideoSampleResource` or
 * `AvFrameAudioSampleResource`), the frame is ref'd instead of copied for zero-copy reuse.
 *
 * For video samples, the frame's time base is always set to 1/1000000 (microsecond accuracy). For audio samples, the
 * frame's time base is always set to 1/sampleRate.
 *
 * @group \@mediabunny/server
 * @public
 */
export const toAvFrame = async (sample: VideoSample | AudioSample, frame: NodeAv.Frame) => {
	if (sample instanceof VideoSample) {
		if (sample._data instanceof AvFrameVideoSampleResource) {
			frame.ref(sample._data.frame);
		} else {
			if (sample.format === null) {
				throw new Error('Cannot convert foreign VideoSample with unknown (null) format.');
			}

			await copyVideoSampleToAvFrame(sample, frame, null);
		}

		frame.pts = BigInt(sample.microsecondTimestamp);
		frame.duration = BigInt(sample.microsecondDuration);
		frame.timeBase = new NodeAv.Rational(1, 1e6);
	} else {
		if (sample._data instanceof AvFrameAudioSampleResource) {
			frame.ref(sample._data.frame);
		} else {
			copyAudioSampleToAvFrame(sample, frame);
		}

		frame.timeBase = new NodeAv.Rational(1, sample.sampleRate);
		frame.pts = BigInt(Math.round(sample.timestamp * sample.sampleRate));
		frame.duration = BigInt(sample.numberOfFrames);
	}
};
