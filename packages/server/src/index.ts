import { registerDecoder, registerEncoder } from 'mediabunny';
import * as NodeAv from 'node-av';
import { NodeAvVideoDecoder } from './video-decoder';
import { NodeAvVideoEncoder } from './video-encoder';
import { NodeAvAudioDecoder } from './audio-decoder';
import { NodeAvAudioEncoder } from './audio-encoder';

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
};
