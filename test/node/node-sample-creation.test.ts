import { expect, test } from 'vitest';
import { AudioSample, VideoSample } from '../../src/sample.js';
import {
	ALL_FORMATS, CustomVideoDecoder, EncodedPacket, FilePathSource, Input, registerDecoder, VideoSampleSink,
} from '../../src/index.js';

test('VideoSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new VideoSample(bytes, {
		codedWidth: 1280,
		codedHeight: 720,
		format: 'RGBA',
		timestamp: 0,
	});

	sample.close();
});

test('AudioSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new AudioSample({
		data: bytes,
		numberOfChannels: 2,
		format: 's16',
		sampleRate: 48000,
		timestamp: 0,
	});

	sample.close();
});

// Regression from Kino end-of-media seeks: iterator cleanup closed an already-delivered fallback.
test('Delivered EOF fallback samples survive source iterator cleanup', async () => {
	class PacketDecoder extends CustomVideoDecoder {
		static override supports() { return true; }
		init() {}
		decode(packet: EncodedPacket) {
			this.onSample(new VideoSample(new Uint8Array(16), {
				format: 'RGBA', codedWidth: 2, codedHeight: 2,
				timestamp: packet.timestamp, duration: packet.duration,
			}));
		}

		flush() {}
		close() {}
	}
	registerDecoder(PacketDecoder);
	using input = new Input({
		formats: ALL_FORMATS,
		source: new FilePathSource(new URL('../public/video.mp4', import.meta.url).pathname),
	});
	const track = (await input.getPrimaryVideoTrack())!;
	const end = await track.computeDuration();
	for (const start of [0.1, end + 0.5]) {
		const iterator = new VideoSampleSink(track).samples(start);
		const { value: sample } = await iterator.next();
		expect(sample).toBeDefined();
		try {
			const before = sample!.clone();
			before.close();
			await iterator.return();
			const after = sample!.clone();
			expect(after.timestamp).toBe(sample!.timestamp);
			after.close();
		} finally {
			sample?.close();
			await iterator.return();
		}
	}
});
