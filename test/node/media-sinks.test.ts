import { expect, test, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioBufferSink,
	AudioCodec,
	AudioSample,
	AudioSampleSink,
	BufferSource,
	BufferTarget,
	CustomAudioDecoder,
	CustomVideoDecoder,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	Input,
	InputAudioTrack,
	InputDisposedError,
	MkvOutputFormat,
	Output,
	registerDecoder,
	VideoCodec,
	VideoSample,
	VideoSampleSink,
} from '../../src/index.js';
import { assert, last, promiseWithResolvers } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const QUERY_TIMESTAMPS = Array.from({ length: 30 }, (_, i) => i / 10);

const decoders: (FakeVideoDecoder | FailingAudioDecoder | FakeAudioDecoder)[] = [];

class FakeVideoDecoder extends CustomVideoDecoder {
	static failing = false;

	decodedCount = 0;
	closed = false;

	static override supports(codec: VideoCodec) {
		return codec === 'vp9';
	}

	init() {
		decoders.push(this);
	}

	decode(packet: EncodedPacket) {
		if (FakeVideoDecoder.failing) {
			throw new Error('Decode failed');
		}

		this.decodedCount++;
		this.onSample(new VideoSample(new Uint8Array(4), {
			format: 'RGBA',
			codedWidth: 1,
			codedHeight: 1,
			timestamp: packet.timestamp,
			duration: packet.duration,
		}));
	}

	flush() {}

	close() {
		this.closed = true;
	}
}

class FailingAudioDecoder extends CustomAudioDecoder {
	closed = false;

	static override supports(codec: AudioCodec) {
		return codec === 'mp3';
	}

	init() {
		decoders.push(this);
	}

	decode() {
		throw new Error('Decode failed');
	}

	flush() {}

	close() {
		this.closed = true;
	}
}

class FakeAudioDecoder extends CustomAudioDecoder {
	samples: AudioSample[] = [];
	closed = false;

	static override supports(codec: AudioCodec) {
		return codec === 'flac';
	}

	init() {
		decoders.push(this);
	}

	decode(packet: EncodedPacket) {
		const { numberOfChannels, sampleRate } = this.config;
		const sample = new AudioSample({
			data: new Float32Array(numberOfChannels * Math.round(sampleRate * packet.duration)),
			format: 'f32',
			numberOfChannels,
			sampleRate,
			timestamp: packet.timestamp,
		});
		this.samples.push(sample);
		this.onSample(sample);
	}

	flush() {}

	close() {
		this.closed = true;
	}
}

registerDecoder(FakeVideoDecoder);
registerDecoder(FailingAudioDecoder);
registerDecoder(FakeAudioDecoder);

test('Range iterator closes its decoder after throwing on disposal', async () => {
	await testDecoderClosedAfterThrow(sink => sink.samples(), 'dispose');
});

test('Range iterator closes its decoder after throwing a decoder error', async () => {
	await testDecoderClosedAfterThrow(sink => sink.samples(), 'decoderError');
});

test('Timestamp iterator closes its decoder after throwing on disposal', async () => {
	await testDecoderClosedAfterThrow(sink => sink.samplesAtTimestamps(QUERY_TIMESTAMPS), 'dispose');
});

test('Timestamp iterator closes its decoder after throwing a decoder error', async () => {
	await testDecoderClosedAfterThrow(sink => sink.samplesAtTimestamps(QUERY_TIMESTAMPS), 'decoderError');
});

test('Range iterator closes its decoder after throw()', async () => {
	await testDecoderClosedAfterThrow(sink => sink.samples(), 'throw');
});

test('Timestamp iterator closes its decoder after throw()', async () => {
	await testDecoderClosedAfterThrow(sink => sink.samplesAtTimestamps(QUERY_TIMESTAMPS), 'throw');
});

const testDecoderClosedAfterThrow = async (
	createIterator: (sink: VideoSampleSink) => AsyncGenerator<VideoSample | null, void, unknown>,
	cause: 'dispose' | 'decoderError' | 'throw',
) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/frames.webm')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const iterator = createIterator(new VideoSampleSink(track));
	const { value: sample } = await iterator.next();
	assert(sample);
	sample.close();

	// Let the pump fill up the sample queue until it stalls, waiting for the consumer
	const decoder = last(decoders);
	assert(decoder instanceof FakeVideoDecoder);
	let decodedCount = -1;
	while (decoder.decodedCount !== decodedCount) {
		decodedCount = decoder.decodedCount;
		await new Promise(resolve => setTimeout(resolve, 50));
	}

	if (cause === 'dispose') {
		input.dispose();
		await expect(iterator.next()).rejects.toThrow(InputDisposedError);
	} else if (cause === 'decoderError') {
		decoder.onError(new Error('Decoding failed'));
		await expect(iterator.next()).rejects.toThrow('Decoding failed');
	} else {
		await expect(iterator.throw(new Error('Stopped'))).rejects.toThrow('Stopped');
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
	}

	await vi.waitFor(() => expect(decoder.closed).toBe(true));
};

test('PCM ranges split at packet boundaries', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetTimestamps = await getPacketTimestamps(track);
	const sink = new AudioSampleSink(track);

	for (let i = 1; i < 30; i++) {
		const timestamps: number[] = [];
		for await (using sample of sink.samples(0, packetTimestamps[i])) {
			timestamps.push(sample.timestamp);
		}

		expect(timestamps).toEqual(packetTimestamps.slice(0, i));
	}
});

test('PCM samplesAtTimestamps going back within a packet', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetTimestamps = await getPacketTimestamps(track);
	const sink = new AudioSampleSink(track);

	for (const timestamp of packetTimestamps.slice(0, 60)) {
		const timestamps: (number | null)[] = [];
		for await (using sample of sink.samplesAtTimestamps([timestamp + 0.001, timestamp + 0.0005])) {
			timestamps.push(sample?.timestamp ?? null);
		}

		expect(timestamps).toEqual([timestamp, timestamp]);
	}
});

const getPacketTimestamps = async (track: InputAudioTrack) => {
	const packetSink = new EncodedPacketSink(track);
	const timestamps: number[] = [];
	for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
		timestamps.push(packet.timestamp);
	}

	return timestamps;
};

test('Failing custom audio decoder', async () => {
	await testFailingCustomDecoder('Toothsome-Meme.VBRv2.mp3', async (input) => {
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		return new AudioSampleSink(track);
	});
});

test('Failing custom video decoder', async () => {
	// Decoders stay registered for the whole file, so we make the fake one fail instead of registering another one
	FakeVideoDecoder.failing = true;

	try {
		await testFailingCustomDecoder('frames.webm', async (input) => {
			const track = await input.getPrimaryVideoTrack();
			assert(track);

			return new VideoSampleSink(track);
		});
	} finally {
		FakeVideoDecoder.failing = false;
	}
});

const testFailingCustomDecoder = async (
	fileName: string,
	createSink: (input: Input) => Promise<AudioSampleSink | VideoSampleSink>,
) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', fileName)),
		formats: ALL_FORMATS,
	});

	const sink = await createSink(input);
	await expect(async () => {
		for await (using sample of sink.samples()) {
			void sample;
		}
	}).rejects.toThrow('Decode failed');

	const decoder = last(decoders);
	assert(decoder);
	await vi.waitFor(() => expect(decoder.closed).toBe(true));
};

test('Timestamp iterator closes its decoder on return() while waiting for timestamps', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/frames.webm')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const { promise: stall, resolve: unstall } = promiseWithResolvers();
	const timestamps = async function* () {
		yield 0;
		await stall;
		yield 1;
	};

	const iterator = new VideoSampleSink(track).samplesAtTimestamps(timestamps());
	const nextPromise = iterator.next();

	// The sample for 0 only comes out once the next timestamp is known, so we're stuck waiting on the source
	await new Promise(resolve => setTimeout(resolve, 50));
	const decoder = last(decoders);
	assert(decoder instanceof FakeVideoDecoder);

	await iterator.return();
	expect(await nextPromise).toEqual({ value: undefined, done: true });
	await vi.waitFor(() => expect(decoder.closed).toBe(true));

	unstall();
});

test('AudioBufferSink iterator closes its decoder and samples when the conversion throws', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample.flac')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	// AudioBuffer doesn't exist in Node, so converting the first sample throws
	const iterator = new AudioBufferSink(track).buffers();
	await expect(iterator.next()).rejects.toThrow('AudioBuffer is not defined');

	const decoder = last(decoders);
	assert(decoder instanceof FakeAudioDecoder);
	await vi.waitFor(() => expect(decoder.closed).toBe(true));
	expect(decoder.samples.length).toBeGreaterThan(0);
	expect(decoder.samples.every(x => x._closed)).toBe(true);
});

test('PCM packets smaller than a frame', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();

	const meta = {
		decoderConfig: {
			codec: 'pcm-s16',
			numberOfChannels: 2,
			sampleRate: 48000,
		},
	};
	await source.add(new EncodedPacket(new Uint8Array(4 * 480), 'key', 0, 0.01), meta);
	await source.add(new EncodedPacket(new Uint8Array(0), 'key', 0.01, 0));
	await source.add(new EncodedPacket(new Uint8Array(4 * 480), 'key', 0.01, 0.01));
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const frameCounts: number[] = [];
	for await (using sample of new AudioSampleSink(track).samples()) {
		frameCounts.push(sample.numberOfFrames);
	}

	expect(frameCounts).toEqual([480, 480]);
});
