/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { registerDecoder, registerEncoder, registerVideoSampleTransformer } from 'mediabunny';
import * as NodeAv from 'node-av';
import { NodeAvVideoDecoder } from './video-decoder';
import { NodeAvVideoEncoder } from './video-encoder';
import { NodeAvAudioDecoder } from './audio-decoder';
import { NodeAvAudioEncoder } from './audio-encoder';
import { transformVideoSample } from './video-sample';

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

export { NodeAvFrameVideoSampleResource } from './video-sample';
export { NodeAvFrameAudioSampleResource } from './audio-sample';
