import { afterEach, expect, test, vi } from 'vitest';
import { canDecodeVideo } from '../../src/decode.js';
import { canEncodeVideo } from '../../src/encode.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { UrlSource } from '../../src/source.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test('canDecodeVideo with differing ArrayBuffer descriptions', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig?.description);

	const validDescription = toUint8Array(decoderConfig.description).slice().buffer;
	const invalidDescription = new ArrayBuffer(8);

	expect(await canDecodeVideo('avc', { codec: decoderConfig.codec, description: invalidDescription })).toBe(false);
	expect(await canDecodeVideo('avc', { codec: decoderConfig.codec, description: validDescription })).toBe(true);
});

// Keep this test last, and keep anything that calls isFirefox() out of this file: isFirefox() caches its first
// result, so the faked user agent only takes effect if nothing ran it before, and it stays true afterwards
test('canEncodeVideo encoder probing on Firefox', async () => {
	const userAgent = navigator.userAgent;
	vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`${userAgent} Firefox/140.0`);

	const encoders: VideoEncoder[] = [];
	vi.stubGlobal('VideoEncoder', class extends VideoEncoder {
		constructor(init: VideoEncoderInit) {
			super(init);
			encoders.push(this);
		}
	});

	expect(await canEncodeVideo('vp8', { width: 64, height: 64 })).toBe(true);
	expect(encoders.length).toBeGreaterThan(0);
	expect(encoders.every(x => x.state === 'closed')).toBe(true);
});
