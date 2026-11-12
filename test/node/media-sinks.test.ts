import { afterEach, expect, test, vi } from 'vitest';
import { VideoSampleSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { VideoSample } from '../../src/sample.js';

afterEach(() => vi.unstubAllGlobals());

const prepare = async () => {
	vi.stubGlobal('VideoDecoder', class extends EventTarget {
		state = 'configured';
		configure() {}
		decode() {}
		async flush() {}
		close() {}
	});
	vi.stubGlobal('EncodedVideoChunk', class {});
	const sink = Object.create(VideoSampleSink.prototype) as VideoSampleSink;
	sink._decoderOptions = {};
	// Isolate timestamp bookkeeping from demuxing and platform decoding.
	sink._track = {
		canDecode: async () => true,
		getCodec: async () => 'avc',
		getRotation: async () => 0,
		getFlip: async () => false,
		getDecoderConfig: async () => ({ codec: 'avc1.42001e' }),
		getTimeResolution: async () => 30,
	} as unknown as VideoSampleSink['_track'];
	const output: number[] = [];
	const decoder = await sink._createDecoder(sample => output.push(sample.timestamp * 30), (error) => {
		throw error;
	});
	const submit = (frame: number) => decoder.decode(new EncodedPacket(new Uint8Array(), 'key', frame / 30, 1 / 30));
	const emit = (frame: number) => decoder.sampleHandler({
		timestamp: frame / 30,
		duration: 1 / 30,
		setTimestamp(this: { timestamp: number }, value: number) { this.timestamp = value; },
		setDuration() {},
		setRotation() {},
		setFlip() {},
	} as unknown as VideoSample);
	return { decoder, submit, emit, output };
};

// Frame-accurate trimming must preserve later pictures after a missing native output.
test('a missing decoded B-frame does not relabel later pictures', async () => {
	const d = await prepare();
	d.submit(0);
	d.emit(0);
	for (const frame of [3, 1, 2, 6, 4, 5]) {
		d.submit(frame);
	}
	for (const frame of [2, 3, 4, 5, 6]) {
		d.emit(frame);
	}
	expect(d.output).toEqual([0, 2, 3, 4, 5, 6]);
	await d.decoder.flush();
	d.submit(0);
	d.emit(0);
	expect(d.output.at(-1)).toBe(0);
	d.decoder.close();
});

test('flush discards unmatched aliases while monotonic streams retain timestamp repair', async () => {
	const d = await prepare();
	for (const frame of [0, 1, 2, 3]) {
		d.submit(frame);
	}
	for (const frame of [0, 2, 3]) {
		d.emit(frame);
	}
	expect(d.output).toEqual([0, 1, 2]);
	await d.decoder.flush();
	d.submit(30);
	d.emit(30);
	expect(d.output).toEqual([0, 1, 2, 30]);
	await d.decoder.flush();
	d.submit(0);
	d.emit(0);
	expect(d.decoder.hasReorderedPresentationTimestamps).toBe(false);
	expect(d.output.at(-1)).toBe(0);
	d.decoder.close();
});
