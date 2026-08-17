import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';

// https://github.com/Vanilagy/mediabunny/issues/370
test('Negative audio timestamps are preserved', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getFirstTimestamp()).toBeLessThan(0);

	const sink = new AudioSampleSink(track);

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBe(await track.getFirstTimestamp());
		break;
	}
});

// A decoder the platform fails is already closed by the time the pump's finally block closes it: per the Close
// VideoDecoder algorithm, [[state]] becomes "closed" (step 2) before the error callback is invoked (step 4). Closing it
// again throws InvalidStateError inside a promise chain nobody holds, which no consumer can catch.
test('A platform-closed decoder does not produce an uncatchable rejection', async () => {
	const RealVideoDecoder = globalThis.VideoDecoder;
	let decodesUntilFailure = 3;

	class PlatformFailingVideoDecoder extends RealVideoDecoder {
		private readonly errorCallback: VideoDecoderInit['error'];

		constructor(init: VideoDecoderInit) {
			super(init);
			this.errorCallback = init.error;
		}

		override decode(chunk: EncodedVideoChunk) {
			if (decodesUntilFailure > 0) {
				decodesUntilFailure--;
				super.decode(chunk);
				return;
			}

			// Mimic the platform: close the codec first, then report the error.
			if (this.state !== 'closed') {
				super.close();
			}

			this.errorCallback(new DOMException('Simulated decoding error.', 'EncodingError'));
		}
	}

	const rejections: unknown[] = [];
	const onUnhandledRejection = (event: PromiseRejectionEvent) => {
		rejections.push(event.reason);
		event.preventDefault();
	};

	window.addEventListener('unhandledrejection', onUnhandledRejection);
	globalThis.VideoDecoder = PlatformFailingVideoDecoder;

	let caught: unknown = null;

	try {
		using input = new Input({
			source: new UrlSource('/video.mp4'),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);

		const sink = new VideoSampleSink(track);

		try {
			for await (const sample of sink.samples()) {
				sample.close();
			}
		} catch (error) {
			caught = error;
		}
	} finally {
		globalThis.VideoDecoder = RealVideoDecoder;
		// unhandledrejection is queued as a task, so give it one to land in
		await new Promise(resolve => setTimeout(resolve, 500));
		window.removeEventListener('unhandledrejection', onUnhandledRejection);
	}

	// The consumer must see the decode failure through the iterator...
	expect(caught).toBeInstanceOf(DOMException);
	// ...and that must be the only place it surfaces.
	expect(rejections).toEqual([]);
});
