import { afterEach, expect, test, vi } from 'vitest';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import {
	CustomAudioDecoder,
	CustomVideoDecoder,
	registerDecoder,
	unregisterDecoder,
} from '../../src/custom-coder.js';
import {
	AudioPacketDecoder,
	CoderClosedError,
	ExtendedAudioDecoderConfig,
	ExtendedVideoDecoderConfig,
	PacketDecoder,
	VideoPacketDecoder,
} from '../../src/decode.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { Input } from '../../src/input.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert, isThenable, last, MaybePromise, promiseWithResolvers } from '../../src/misc.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { fromAlaw, fromUlaw } from '../../src/pcm.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { UrlSource } from '../../src/source.js';

afterEach(() => {
	vi.unstubAllGlobals();

	for (const decoder of registeredCustomDecoders) {
		unregisterDecoder(decoder);
	}
	registeredCustomDecoders.length = 0;
	customHooks = {};
	customCalls.length = 0;
});

type AnyPacketDecoder = PacketDecoder<VideoSample> | PacketDecoder<AudioSample>;

type AnyDecoderConfig = ExtendedVideoDecoderConfig | ExtendedAudioDecoderConfig;

type DecoderType = {
	globalName: 'VideoDecoder' | 'AudioDecoder';
	getMockClass: () => typeof MockVideoDecoder | typeof MockAudioDecoder;
	getCustomDecoderClass: () => typeof TestCustomVideoDecoder | typeof TestCustomAudioDecoder;
	createDecoder: (options?: { highWaterMark?: number }) => AnyPacketDecoder;
	createPacket: (index: number, type?: PacketType, decoderConfig?: AnyDecoderConfig | null) => EncodedPacket;
	decoderConfig: AnyDecoderConfig;
	otherDecoderConfig: AnyDecoderConfig;
	foreignDecoderConfig: AnyDecoderConfig;
	packetDuration: number;
};

const VIDEO_PACKET_DURATION = 0.04;
const AUDIO_PACKET_DURATION = 0.02;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_PACKET_FRAMES = Math.round(AUDIO_SAMPLE_RATE * AUDIO_PACKET_DURATION);

const VIDEO_DECODER_CONFIG: ExtendedVideoDecoderConfig = {
	type: 'video',
	codec: 'vp8',
};
const AUDIO_DECODER_CONFIG: ExtendedAudioDecoderConfig = {
	type: 'audio',
	codec: 'opus',
	sampleRate: AUDIO_SAMPLE_RATE,
	numberOfChannels: AUDIO_CHANNELS,
};

const VIDEO: DecoderType = {
	globalName: 'VideoDecoder',
	getMockClass: () => MockVideoDecoder,
	getCustomDecoderClass: () => TestCustomVideoDecoder,
	createDecoder: options => new VideoPacketDecoder(options),
	// The byte marks the frame as shown, in VP8 as well as in VP9
	createPacket: (index, type = 'key', decoderConfig = VIDEO_DECODER_CONFIG) => new EncodedPacket({
		data: new Uint8Array([0x92]),
		type,
		timestamp: VIDEO_PACKET_DURATION * index,
		duration: VIDEO_PACKET_DURATION,
		decoderConfig: decoderConfig ?? undefined,
	}),
	decoderConfig: VIDEO_DECODER_CONFIG,
	otherDecoderConfig: {
		type: 'video',
		codec: 'vp09.00.10.08',
	},
	foreignDecoderConfig: AUDIO_DECODER_CONFIG,
	packetDuration: VIDEO_PACKET_DURATION,
};

const AUDIO: DecoderType = {
	globalName: 'AudioDecoder',
	getMockClass: () => MockAudioDecoder,
	getCustomDecoderClass: () => TestCustomAudioDecoder,
	createDecoder: options => new AudioPacketDecoder(options),
	createPacket: (index, type = 'key', decoderConfig = AUDIO_DECODER_CONFIG) => new EncodedPacket({
		data: new Uint8Array(8),
		type,
		timestamp: AUDIO_PACKET_DURATION * index,
		duration: AUDIO_PACKET_DURATION,
		decoderConfig: decoderConfig ?? undefined,
	}),
	decoderConfig: AUDIO_DECODER_CONFIG,
	otherDecoderConfig: {
		type: 'audio',
		codec: 'mp4a.40.2',
		sampleRate: AUDIO_SAMPLE_RATE,
		numberOfChannels: AUDIO_CHANNELS,
	},
	foreignDecoderConfig: VIDEO_DECODER_CONFIG,
	packetDuration: AUDIO_PACKET_DURATION,
};

test('Video decoding', () => testDecoding(VIDEO));
test('Audio decoding', () => testDecoding(AUDIO));

const testDecoding = async (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type);

	for (let i = 0; i < 3; i++) {
		expect(decoder.push(type.createPacket(i))).toBe(null);
	}
	void decoder.end();

	const samples = await pullUntilNull(decoder);
	expectTimestamps(samples, [0, type.packetDuration, 2 * type.packetDuration]);
	for (const sample of samples) {
		expect(sample.duration).toBeCloseTo(type.packetDuration, 10);
		sample.close();
	}

	expect(decoder.pullable).toBe(false);
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video pull before output', () => testPullBeforeOutput(VIDEO));
test('Audio pull before output', () => testPullBeforeOutput(AUDIO));

const testPullBeforeOutput = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	const first = decoder.pull();
	const second = decoder.pull();
	expect(isThenable(first)).toBe(true);
	expect(isThenable(second)).toBe(true);

	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1));
	mock.resume();

	const samples = [await first, await second];
	expectTimestamps(samples, [0, type.packetDuration]);
	samples.forEach(x => x?.close());

	decoder.close();
};

const expectTimestamps = (samples: (VideoSample | AudioSample | null)[], expected: number[]) => {
	expect(samples.length).toBe(expected.length);
	for (let i = 0; i < samples.length; i++) {
		expect(samples[i]!.timestamp).toBeCloseTo(expected[i]!, 10);
	}
};

test('Video flush markers', () => testFlushMarkers(VIDEO));
test('Audio flush markers', () => testFlushMarkers(AUDIO));

const testFlushMarkers = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);

	// Nothing to flush, so the marker comes out right away
	void decoder.push(null);
	expect(decoder.pull()).toBe(null);

	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1));
	void decoder.push(null);
	void decoder.push(null);

	const results = await pullCount(decoder, 4);
	expect(results.map(x => x === null)).toEqual([false, false, true, true]);
	results.forEach(x => x?.close());
	expect(decoder.pullable).toBe(true);

	// Ending right after a flush still gives a final marker, without flushing again
	void decoder.end();
	expect(mock.flushCount).toBe(1);
	expect(decoder.pull()).toBe(null);
	expect(decoder.pullable).toBe(false);
};

test('Video decoding during flush', () => testDecodingDuringFlush(VIDEO));
test('Audio decoding during flush', () => testDecodingDuringFlush(AUDIO));

const testDecodingDuringFlush = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	void decoder.push(type.createPacket(0));
	void decoder.push(null);
	void decoder.push(type.createPacket(1));
	void decoder.push(type.createPacket(2, 'delta'));
	void decoder.push(null);

	// Everything after the flush waits for it to finish
	expect(mock.decodedChunks.length).toBe(1);

	mock.resume();
	const results = await pullCount(decoder, 5);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		null,
		expect.closeTo(type.packetDuration, 10),
		expect.closeTo(2 * type.packetDuration, 10),
		null,
	]);
	expect(mock.decodedChunks.length).toBe(3);
	expect(mock.flushCount).toBe(2);
	results.forEach(x => x?.close());

	decoder.close();
};

test('Video key packet requirement', () => testKeyPacketRequirement(VIDEO));
test('Audio key packet requirement', () => testKeyPacketRequirement(AUDIO));

const testKeyPacketRequirement = async (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type);
	const message = 'The first packet of a packet stream must be a key packet.';

	expect(() => decoder.push(type.createPacket(0, 'delta'))).toThrow(message);
	expect(decoder.pushable).toBe(true);

	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1, 'delta'));
	void decoder.push(null);
	expect(() => decoder.push(type.createPacket(2, 'delta'))).toThrow(message);
	void decoder.push(type.createPacket(2));
	void decoder.end();

	const results = await pullCount(decoder, 5);
	expect(results.map(x => x === null)).toEqual([false, false, true, false, true]);
	results.forEach(x => x?.close());
};

test('Video backpressure', () => testBackpressure(VIDEO));
test('Audio backpressure', () => testBackpressure(AUDIO));

const testBackpressure = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	expect(decoder.push(type.createPacket(0))).toBe(null);
	expect(decoder.push(type.createPacket(1))).toBe(null);
	expect(decoder.push(type.createPacket(2))).toBe(null);

	const backpressure = decoder.push(type.createPacket(3));
	assert(backpressure);
	const released = trackSettlement(backpressure);

	// The signal can be ignored, packets keep getting decoded
	expect(decoder.push(type.createPacket(4))).toBe(backpressure);

	// Decoded samples nobody pulled yet still count
	mock.resume();
	await tick();
	expect(released.settled).toBe(false);

	(await decoder.pull())!.close();
	await tick();
	expect(released.settled).toBe(false);

	(await decoder.pull())!.close();
	await tick();
	expect(released.settled).toBe(true);

	expect(decoder.push(type.createPacket(5))).not.toBe(null);
	decoder.close();

	const custom = createMockedDecoder(type, { paused: true }, () => type.createDecoder({ highWaterMark: 2 }));
	expect(custom.decoder.push(type.createPacket(0))).toBe(null);
	expect(custom.decoder.push(type.createPacket(1))).not.toBe(null);
	custom.decoder.close();
};

test('Video backpressure with waiting pull', () => testBackpressureWithWaitingPull(VIDEO));
test('Audio backpressure with waiting pull', () => testBackpressureWithWaitingPull(AUDIO));

const testBackpressureWithWaitingPull = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	const pulled = decoder.pull();
	for (let i = 0; i < 3; i++) {
		void decoder.push(type.createPacket(i));
	}
	const backpressure = decoder.push(type.createPacket(3));
	assert(backpressure);

	// The first sample goes straight to the waiting pull, so the decoder dequeueing alone frees up space
	mock.resume();
	await backpressure;
	(await pulled)!.close();

	decoder.close();
};

test('Video packets waiting for room', () => testPacketsWaitingForRoom(VIDEO));
test('Audio packets waiting for room', () => testPacketsWaitingForRoom(AUDIO));

const testPacketsWaitingForRoom = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	for (let i = 0; i < 6; i++) {
		void decoder.push(type.createPacket(i));
	}
	void decoder.push(null);
	void decoder.push(type.createPacket(6));
	void decoder.push(type.createPacket(7, 'delta'));
	void decoder.end();

	// Only as many packets as the decoder has room for get handed over, the rest waits in line
	expect(mock.decodedChunks.length).toBe(4);

	// Unpulled samples take up room too, so it's the pulling that lets the rest through
	mock.resume();
	await tick();
	expect(mock.decodedChunks.length).toBeLessThan(8);

	const results = await pullCount(decoder, 10);
	expect(decoder.pullable).toBe(false);
	expect(mock.state).toBe('closed');
	expect(mock.decodedChunks.length).toBe(8);
	expect(mock.flushCount).toBe(2);

	expect(results.map(x => x === null)).toEqual([false, false, false, false, false, false, true, false, false, true]);
	expectTimestamps(results.filter(x => x !== null), [0, 1, 2, 3, 4, 5, 6, 7].map(i => i * type.packetDuration));
	results.forEach(x => x?.close());
};

test('Video close with waiting packets', () => testCloseWithWaitingPackets(VIDEO));
test('Audio close with waiting packets', () => testCloseWithWaitingPackets(AUDIO));

const testCloseWithWaitingPackets = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	for (let i = 0; i < 6; i++) {
		void decoder.push(type.createPacket(i));
	}
	decoder.close();

	mock.resume();
	await tick();
	expect(mock.decodedChunks.length).toBe(4);
};

test('Video error on waiting packet', () => testErrorOnWaitingPacket(VIDEO));
test('Audio error on waiting packet', () => testErrorOnWaitingPacket(AUDIO));

const testErrorOnWaitingPacket = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true, rejectedChunkIndex: 4 });

	// The failing packet waits, so the error only shows once it reaches the decoder
	for (let i = 0; i < 5; i++) {
		void decoder.push(type.createPacket(i));
	}
	expect(decoder.pushable).toBe(true);

	mock.resume();
	await tick();
	expect(decoder.pushable).toBe(false);
	expect(mock.state).toBe('closed');
	expect(() => decoder.pull()).toThrow('Malformed chunk.');
	expect(() => decoder.push(type.createPacket(5))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);
};

test('Video flush markers excluded from backpressure', () => testMarkerBackpressure(VIDEO));
test('Audio flush markers excluded from backpressure', () => testMarkerBackpressure(AUDIO));

const testMarkerBackpressure = async (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type);

	for (let i = 0; i < 3; i++) {
		void decoder.push(type.createPacket(i));
	}
	void decoder.push(null);
	await tick();

	for (let i = 0; i < 5; i++) {
		expect(decoder.push(null)).toBe(null);
	}
	expect(decoder.push(type.createPacket(3))).not.toBe(null);

	decoder.close();
};

test('Video end', () => testEnd(VIDEO));
test('Audio end', () => testEnd(AUDIO));

const testEnd = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	const pulls = [decoder.pull(), decoder.pull(), decoder.pull()];
	void decoder.push(type.createPacket(0));

	const finished = decoder.end();
	expect(decoder.end()).toBe(finished);
	expect(decoder.pushable).toBe(false);
	expect(decoder.pullable).toBe(true);
	const message = 'Cannot push after the decoder has been ended or closed.';
	expect(() => decoder.push(type.createPacket(1))).toThrow(message);
	expect(() => decoder.push(null)).toThrow(message);

	// The decoder stays open until its final flush is done
	const settlement = trackSettlement(finished);
	await tick();
	expect(mock.state).toBe('configured');
	expect(settlement.settled).toBe(false);

	mock.resume();
	(await pulls[0])!.close();
	expect(await pulls[1]).toBe(null);
	expect(decoder.pullable).toBe(false);
	expect(mock.state).toBe('closed');
	expect(mock.flushCount).toBe(1);
	await finished;

	await expect(pulls[2]).rejects.toThrow('Cannot pull past the end of the decoder.');
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');

	// Closing a done decoder changes nothing
	decoder.close();
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video end without packets', () => testEndWithoutPackets(VIDEO));
test('Audio end without packets', () => testEndWithoutPackets(AUDIO));

const testEndWithoutPackets = (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type);

	// Without a decoder config, no WebCodecs decoder was ever needed
	void decoder.end();
	expect(mockInstances.length).toBe(0);
	expect(decoder.pull()).toBe(null);
	expect(decoder.pullable).toBe(false);
};

test('Video end during flush', () => testEndDuringFlush(VIDEO));
test('Audio end during flush', () => testEndDuringFlush(AUDIO));

const testEndDuringFlush = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	void decoder.push(type.createPacket(0));
	void decoder.push(null);
	void decoder.end();

	mock.resume();
	const results = await pullCount(decoder, 3);
	expect(results.map(x => x === null)).toEqual([false, true, true]);
	results.forEach(x => x?.close());
	expect(mock.flushCount).toBe(1);
	expect(decoder.pullable).toBe(false);
};

test('Video end without pulling', () => testEndWithoutPulling(VIDEO));
test('Audio end without pulling', () => testEndWithoutPulling(AUDIO));

const testEndWithoutPulling = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);

	// The decoder is released once it's finished, even though the results are still waiting to be pulled
	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1));
	const finished = decoder.end();
	const settlement = trackSettlement(finished);
	await tick();
	expect(mock.state).toBe('closed');

	// But ending only completes once everything has been pulled
	expect(settlement.settled).toBe(false);

	const results = await pullCount(decoder, 3);
	expect(results.map(x => x === null)).toEqual([false, false, true]);
	results.forEach(x => x?.close());
	expect(decoder.pullable).toBe(false);
	await finished;
};

test('Video close', () => testClose(VIDEO));
test('Audio close', () => testClose(AUDIO));

const testClose = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);

	for (let i = 0; i < 3; i++) {
		void decoder.push(type.createPacket(i));
	}
	await tick();

	const queued = [...decoder._results];
	expect(queued.length).toBe(3);

	decoder.close();
	expect(queued.every(x => x!._closed)).toBe(true);
	expect(mock.state).toBe('closed');
	expect(decoder.pushable).toBe(false);
	expect(decoder.pullable).toBe(false);
	expect(() => decoder.push(type.createPacket(3))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);

	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');

	decoder.close();
	void decoder.end();
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video close with waiting pull', () => testCloseWithWaitingPull(VIDEO));
test('Audio close with waiting pull', () => testCloseWithWaitingPull(AUDIO));

const testCloseWithWaitingPull = async (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type, { paused: true });

	const pulls = [decoder.pull(), decoder.pull()];
	for (let i = 0; i < 3; i++) {
		void decoder.push(type.createPacket(i));
	}
	const backpressure = decoder.push(type.createPacket(3));
	assert(backpressure);

	decoder.close();
	await Promise.all(pulls.map(async (pull) => {
		await expect(pull).rejects.toThrow(CoderClosedError);
		await expect(pull).rejects.toThrow('The decoder was closed during a pending pull.');
	}));
	expect(decoder.pullable).toBe(false);
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
	await backpressure;
};

test('Video close after end', () => testCloseAfterEnd(VIDEO));
test('Audio close after end', () => testCloseAfterEnd(AUDIO));

const testCloseAfterEnd = async (type: DecoderType) => {
	// During the final flush
	const first = createMockedDecoder(type, { paused: true });

	void first.decoder.push(type.createPacket(0));
	void first.decoder.push(null);
	void first.decoder.push(type.createPacket(1));
	void first.decoder.end();

	first.decoder.close();
	expect(first.mock.state).toBe('closed');
	expect(first.decoder.pullable).toBe(false);
	expect(() => first.decoder.pull()).toThrow('Cannot pull past the end of the decoder.');

	// The aborted flush isn't reported as an error, and the waiting packet never reaches the decoder
	first.mock.resume();
	await tick();
	expect(first.decoder._hasError).toBe(false);
	expect(first.mock.decodedChunks.length).toBe(1);

	// After the final flush, with results still waiting to be pulled
	const second = createMockedDecoder(type);

	void second.decoder.push(type.createPacket(0));
	void second.decoder.push(type.createPacket(1));
	const finished = second.decoder.end();
	await tick();

	const queued = [...second.decoder._results];
	expect(queued.length).toBe(3);

	second.decoder.close();
	await finished;
	expect(queued.every(x => !x || x._closed)).toBe(true);
	expect(second.decoder.pullable).toBe(false);
	expect(() => second.decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video dispose', () => testDispose(VIDEO));
test('Audio dispose', () => testDispose(AUDIO));

const testDispose = (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);
	{
		using disposed = decoder;
		void disposed.push(type.createPacket(0));
		void disposed.push(type.createPacket(1));
	}

	// Disposing closes the decoder right away
	expect(mock.state).toBe('closed');
	expect(decoder.pushable).toBe(false);
	expect(decoder.pullable).toBe(false);
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video producer and consumer failures', () => testProducerAndConsumerFailures(VIDEO));
test('Audio producer and consumer failures', () => testProducerAndConsumerFailures(AUDIO));

const testProducerAndConsumerFailures = async (type: DecoderType) => {
	// Failing producer
	const first = createMockedDecoder(type);
	const produceAndFail = async () => {
		using decoder = first.decoder;
		for (let i = 0; i < 10; i++) {
			const backpressure = decoder.push(type.createPacket(i));
			if (backpressure) await backpressure;
		}
		while (decoder._pendingPulls.length === 0) {
			await tick();
		}

		throw new Error('Packet retrieval failed.');
	};
	const consume = async () => {
		while (true) {
			using sample = await first.decoder.pull();
			if (!sample) {
				return;
			}
		}
	};

	const [produced, consumed] = await Promise.allSettled([produceAndFail(), consume()]);
	expect(produced.status).toBe('rejected');
	assert(consumed.status === 'rejected');
	expect(consumed.reason).toBeInstanceOf(CoderClosedError);
	expect(first.decoder.pullable).toBe(false);

	// Failing consumer
	const second = createMockedDecoder(type);
	const produce = async () => {
		using decoder = second.decoder;
		for (let i = 0; i < 10; i++) {
			const backpressure = decoder.push(type.createPacket(i));
			if (backpressure) await backpressure;
		}

		await decoder.end();
	};
	const consumeAndFail = async () => {
		using decoder = second.decoder;
		(await decoder.pull())!.close();

		throw new Error('Processing failed.');
	};

	await Promise.all([
		expect(produce()).rejects.toThrow('Cannot push after the decoder has been ended or closed.'),
		expect(consumeAndFail()).rejects.toThrow('Processing failed.'),
	]);
	expect(second.mock.state).toBe('closed');
};

test('Video invalid decode arguments', () => testInvalidDecodeArguments(VIDEO));
test('Audio invalid decode arguments', () => testInvalidDecodeArguments(AUDIO));

const testInvalidDecodeArguments = (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type);

	expect(() => decoder.push(undefined as unknown as null)).toThrow(TypeError);
	expect(() => decoder.push({} as EncodedPacket)).toThrow('packet must be an EncodedPacket or null.');
	expect(decoder.pushable).toBe(true);

	decoder.close();

	expect(() => type.createDecoder({ highWaterMark: 0 })).toThrow(
		'options.highWaterMark, when provided, must be a positive integer.',
	);
	expect(() => type.createDecoder({ highWaterMark: 1.5 })).toThrow(
		'options.highWaterMark, when provided, must be a positive integer.',
	);
};

test('Video configure throwing', () => testConfigureThrowing(VIDEO));
test('Audio configure throwing', () => testConfigureThrowing(AUDIO));

const testConfigureThrowing = async (type: DecoderType) => {
	const first = createMockedDecoder(type, { rejectedConfigIndex: 0 });

	expect(first.decoder.push(type.createPacket(0))).toBe(null);
	expect(first.decoder.pushable).toBe(false);
	expect(() => first.decoder.pull()).toThrow('Invalid configuration.');

	const second = createMockedDecoder(type, { rejectedConfigIndex: 1 });

	void second.decoder.push(type.createPacket(0));
	void second.decoder.push(null);
	await tick();
	(await second.decoder.pull())!.close();
	expect(second.decoder.pull()).toBe(null);
	expect(second.decoder.push(type.createPacket(1, 'key', type.otherDecoderConfig))).toBe(null);
	expect(second.decoder.pushable).toBe(false);
	expect(() => second.decoder.pull()).toThrow('Invalid configuration.');

	const third = createMockedDecoder(type, { rejectedConfigIndex: 1 });

	void third.decoder.push(type.createPacket(0));
	expect(third.decoder.push(type.createPacket(1, 'key', type.otherDecoderConfig))).toBe(null);
	await tick();
	expect(() => third.decoder.push(type.createPacket(2, 'key', null))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);
	using thirdSample = await third.decoder.pull();
	expectTimestamps([thirdSample], [0]);
	expect(() => third.decoder.pull()).toThrow('Invalid configuration.');
};

test('Video unsupported config', () => testUnsupportedConfig(VIDEO));
test('Audio unsupported config', () => testUnsupportedConfig(AUDIO));

const testUnsupportedConfig = async (type: DecoderType) => {
	const first = createMockedDecoder(type, { failingConfigIndex: 0 });

	void first.decoder.push(type.createPacket(0));
	await expect(first.decoder.pull()).rejects.toThrow('Unsupported configuration.');
	expect(first.decoder.pushable).toBe(false);
	expect(first.decoder.pullable).toBe(false);
	expect(() => first.decoder.push(type.createPacket(0))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);
	expect(() => first.decoder.pull()).toThrow('Cannot pull past the end of the decoder.');

	const second = createMockedDecoder(type, { failingConfigIndex: 1 });

	void second.decoder.push(type.createPacket(0));
	void second.decoder.push(type.createPacket(1, 'key', type.otherDecoderConfig));
	await tick();
	await tick();
	expect(second.decoder.pushable).toBe(false);
	using secondSample = await second.decoder.pull();
	expectTimestamps([secondSample], [0]);
	expect(() => second.decoder.pull()).toThrow('Unsupported configuration.');
};

test('Video error after setup', () => testErrorAfterSetup(VIDEO));
test('Audio error after setup', () => testErrorAfterSetup(AUDIO));

const testErrorAfterSetup = (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	void decoder.push(type.createPacket(0));
	mock.fail(new DOMException('Codec reclaimed.', 'QuotaExceededError'));
	expect(decoder.pushable).toBe(false);
	expect(() => decoder.push(type.createPacket(1))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);

	expect(decoder.pullable).toBe(true);
	expect(() => decoder.pull()).toThrow('Codec reclaimed.');
	expect(decoder.pullable).toBe(false);
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');

	// Ending and closing an errored decoder changes nothing
	void decoder.end();
	decoder.close();
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video decode throwing', () => testDecodeThrowing(VIDEO));
test('Audio decode throwing', () => testDecodeThrowing(AUDIO));

const testDecodeThrowing = (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { rejectedChunkIndex: 1 });

	void decoder.push(type.createPacket(0));
	expect(decoder.push(type.createPacket(1))).toBe(null);
	expect(decoder.pushable).toBe(false);
	expect(mock.state).toBe('closed');
	expect(() => decoder.pull()).toThrow('Malformed chunk.');
	expect(() => decoder.push(type.createPacket(2))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);
};

test('Video decoding error', () => testDecodingError(VIDEO));
test('Audio decoding error', () => testDecodingError(AUDIO));

const testDecodingError = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { failingChunkIndex: 2 });

	for (let i = 0; i < 4; i++) {
		void decoder.push(type.createPacket(i));
	}
	await tick();
	expect(decoder.pushable).toBe(false);
	expect(() => decoder.push(type.createPacket(4))).toThrow(
		'Cannot push after the decoder has been ended or closed.',
	);

	expect(mock.outputs.length).toBe(2);
	const samples = await pullCount(decoder, 2);
	expectTimestamps(samples, [0, type.packetDuration]);
	samples.forEach(x => x?.close());
	expect(decoder.pullable).toBe(true);
	expect(() => decoder.pull()).toThrow('Decoding failed.');
	expect(decoder.pullable).toBe(false);
};

test('Video close with an unpulled error', () => testCloseWithUnpulledError(VIDEO));
test('Audio close with an unpulled error', () => testCloseWithUnpulledError(AUDIO));

const testCloseWithUnpulledError = async (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type, { failingChunkIndex: 2 });

	for (let i = 0; i < 4; i++) {
		void decoder.push(type.createPacket(i));
	}
	await tick();

	const queued = [...decoder._results];
	expect(queued.length).toBe(2);
	decoder.close();
	expect(queued.every(x => x!._closed)).toBe(true);
	expect(decoder.pullable).toBe(false);
	expect(() => decoder.pull()).toThrow('Cannot pull past the end of the decoder.');
};

test('Video decoding error with waiting pull', () => testDecodingErrorWithWaitingPull(VIDEO));
test('Audio decoding error with waiting pull', () => testDecodingErrorWithWaitingPull(AUDIO));

const testDecodingErrorWithWaitingPull = async (type: DecoderType) => {
	const { decoder } = createMockedDecoder(type, { failingChunkIndex: 0 });

	const pulled = decoder.pull();
	void decoder.push(type.createPacket(0));
	await expect(pulled).rejects.toThrow('Decoding failed.');
	expect(decoder.pullable).toBe(false);
};

test('Video error during flush', () => testErrorDuringFlush(VIDEO));
test('Audio error during flush', () => testErrorDuringFlush(AUDIO));

const testErrorDuringFlush = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	void decoder.push(type.createPacket(0));
	void decoder.push(null);
	void decoder.push(type.createPacket(1));
	const pulled = decoder.pull();

	mock.fail(new DOMException('Decoding failed.', 'EncodingError'));
	await expect(pulled).rejects.toThrow('Decoding failed.');
	expect(mock.decodedChunks.length).toBe(1);
};

test('Video error during end', () => testErrorDuringEnd(VIDEO));
test('Audio error during end', () => testErrorDuringEnd(AUDIO));

const testErrorDuringEnd = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	void decoder.push(type.createPacket(0));
	const finished = decoder.end();

	// Ending completes rather than failing, the error comes out of pull()
	mock.fail(new DOMException('Decoding failed.', 'EncodingError'));
	await finished;
	expect(mock.state).toBe('closed');
	expect(() => decoder.pull()).toThrow('Decoding failed.');
};

test('Video error with backpressure', () => testErrorWithBackpressure(VIDEO));
test('Audio error with backpressure', () => testErrorWithBackpressure(AUDIO));

const testErrorWithBackpressure = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	for (let i = 0; i < 3; i++) {
		void decoder.push(type.createPacket(i));
	}
	const backpressure = decoder.push(type.createPacket(3));
	assert(backpressure);

	// Backpressure only ever resolves, the error comes out of pull()
	mock.fail(new DOMException('Decoding failed.', 'EncodingError'));
	await backpressure;
	expect(() => decoder.pull()).toThrow('Decoding failed.');
};

type MockOptions = {
	paused?: boolean;
	// configure() throws synchronously for the config at this index
	rejectedConfigIndex?: number;
	// Configuring with the config at this index fails the decoder
	failingConfigIndex?: number;
	// decode() throws synchronously for the chunk at this index
	rejectedChunkIndex?: number;
	// Decoding the chunk at this index fails the decoder
	failingChunkIndex?: number;
};

let mockOptions: MockOptions = {};
const mockInstances: MockDecoder<VideoFrame | AudioData>[] = [];

const createMockedDecoder = (
	type: DecoderType,
	options: MockOptions = {},
	createDecoder = type.createDecoder,
) => {
	mockOptions = options;
	mockInstances.length = 0;
	vi.stubGlobal(type.globalName, type.getMockClass());

	const decoder = createDecoder();

	// The WebCodecs decoder only comes into existence with the first decoder config, so this looks it up on use
	const mock = new Proxy({} as MockDecoder<VideoFrame | AudioData>, {
		get: (_, key) => {
			const instance = mockInstances[0];
			assert(instance);

			const value: unknown = Reflect.get(instance, key);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
		},
	});

	return { decoder, mock };
};

type MockControlMessage<Chunk> =
	| { chunk: Chunk }
	| { flush: ReturnType<typeof promiseWithResolvers<void>> };

// Behaves like a WebCodecs decoder as specified in https://www.w3.org/TR/webcodecs, but under the test's control
abstract class MockDecoder<
	Output extends VideoFrame | AudioData,
	Chunk extends EncodedVideoChunk | EncodedAudioChunk = EncodedVideoChunk | EncodedAudioChunk,
> extends EventTarget {
	state: CodecState = 'unconfigured';
	decodeQueueSize = 0;
	ondequeue: ((event: Event) => unknown) | null = null;
	paused = mockOptions.paused ?? false;
	decodedChunks: Chunk[] = [];
	outputs: Output[] = [];
	configs: (VideoDecoderConfig | AudioDecoderConfig)[] = [];
	flushCount = 0;
	resetCount = 0;
	controlQueue: MockControlMessage<Chunk>[] = [];
	keyChunkRequired = true;
	processingScheduled = false;

	constructor(public init: { output(output: Output): void; error(error: DOMException): void }) {
		super();
		mockInstances.push(this);
	}

	abstract createOutput(chunk: Chunk): Output;

	configure(config: VideoDecoderConfig | AudioDecoderConfig) {
		if (this.state === 'closed') {
			throw new DOMException('Cannot configure a closed codec.', 'InvalidStateError');
		}
		if (this.configs.length === mockOptions.rejectedConfigIndex) {
			throw new TypeError('Invalid configuration.');
		}

		this.configs.push(config);
		this.state = 'configured';
		this.keyChunkRequired = true;

		if (this.configs.length - 1 === mockOptions.failingConfigIndex) {
			setTimeout(() => this.fail(new DOMException('Unsupported configuration.', 'NotSupportedError')));
		}
	}

	decode(chunk: Chunk) {
		if (this.state !== 'configured') {
			throw new DOMException('Cannot decode with an unconfigured codec.', 'InvalidStateError');
		}
		if (this.keyChunkRequired && chunk.type !== 'key') {
			throw new DOMException('A key frame is required.', 'DataError');
		}
		if (this.decodedChunks.length === mockOptions.rejectedChunkIndex) {
			throw new DOMException('Malformed chunk.', 'DataError');
		}

		this.keyChunkRequired = false;
		this.decodedChunks.push(chunk);
		this.decodeQueueSize++;
		this.controlQueue.push({ chunk });
		this.scheduleProcessing();
	}

	flush() {
		if (this.state !== 'configured') {
			return Promise.reject(new DOMException('Cannot flush an unconfigured codec.', 'InvalidStateError'));
		}

		this.keyChunkRequired = true;
		this.flushCount++;
		const resolver = promiseWithResolvers();
		this.controlQueue.push({ flush: resolver });
		this.scheduleProcessing();

		return resolver.promise;
	}

	reset() {
		if (this.state === 'closed') {
			throw new DOMException('Cannot reset a closed codec.', 'InvalidStateError');
		}

		this.abortControlQueue(new DOMException('Aborted due to reset.', 'AbortError'));
		this.state = 'unconfigured';
		this.resetCount++;
	}

	close() {
		if (this.state === 'closed') {
			throw new DOMException('Cannot close a closed codec.', 'InvalidStateError');
		}

		this.abortControlQueue(new DOMException('Aborted due to close.', 'AbortError'));
		this.state = 'closed';
	}

	// The spec's "close with exception" algorithm
	fail(error: DOMException) {
		this.abortControlQueue(error);
		this.state = 'closed';
		this.init.error(error);
	}

	resume() {
		this.paused = false;
		this.scheduleProcessing();
	}

	abortControlQueue(error: DOMException) {
		this.decodeQueueSize = 0;

		for (const message of this.controlQueue) {
			if ('flush' in message) {
				message.flush.reject(error);
			}
		}
		this.controlQueue.length = 0;
	}

	scheduleProcessing() {
		if (this.paused || this.processingScheduled) {
			return;
		}

		this.processingScheduled = true;
		setTimeout(() => {
			this.processingScheduled = false;
			this.process();
		});
	}

	process() {
		while (!this.paused && this.state === 'configured' && this.controlQueue.length > 0) {
			const message = this.controlQueue.shift()!;
			if ('flush' in message) {
				message.flush.resolve();
				continue;
			}

			this.decodeQueueSize--;
			const dequeueEvent = new Event('dequeue');
			this.dispatchEvent(dequeueEvent);
			this.ondequeue?.(dequeueEvent);

			// The event's listeners may have closed the decoder
			if (this.state !== 'configured') {
				return;
			}

			if (this.decodedChunks.indexOf(message.chunk) === mockOptions.failingChunkIndex) {
				this.fail(new DOMException('Decoding failed.', 'EncodingError'));
				return;
			}

			const output = this.createOutput(message.chunk);
			this.outputs.push(output);
			this.init.output(output);
		}
	}
}

class MockVideoDecoder extends MockDecoder<VideoFrame> implements VideoDecoder {
	createOutput(chunk: EncodedVideoChunk) {
		return new VideoFrame(new Uint8Array(16), {
			format: 'RGBA',
			codedWidth: 2,
			codedHeight: 2,
			timestamp: chunk.timestamp,
			duration: chunk.duration ?? undefined,
		});
	}
}

class MockAudioDecoder extends MockDecoder<AudioData> implements AudioDecoder {
	createOutput(chunk: EncodedAudioChunk) {
		return new AudioData({
			format: 'f32',
			sampleRate: AUDIO_SAMPLE_RATE,
			numberOfFrames: AUDIO_PACKET_FRAMES,
			numberOfChannels: AUDIO_CHANNELS,
			timestamp: chunk.timestamp,
			data: new Float32Array(AUDIO_CHANNELS * AUDIO_PACKET_FRAMES),
		});
	}
}

test('Video custom decoder', () => testCustomDecoder(VIDEO));
test('Audio custom decoder', () => testCustomDecoder(AUDIO));

const testCustomDecoder = async (type: DecoderType) => {
	registerCustomDecoder(type);
	const decoder = type.createDecoder();

	for (let i = 0; i < 3; i++) {
		void decoder.push(type.createPacket(i));
	}
	void decoder.push(null);
	void decoder.push(type.createPacket(3));
	void decoder.end();

	const results = await pullCount(decoder, 6);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		expect.closeTo(type.packetDuration, 10),
		expect.closeTo(2 * type.packetDuration, 10),
		null,
		expect.closeTo(3 * type.packetDuration, 10),
		null,
	]);
	results.forEach(x => x?.close());

	await tick();
	expect(customCalls).toEqual(['init', 'decode', 'decode', 'decode', 'flush', 'decode', 'flush', 'close']);
};

const pullCount = async (decoder: AnyPacketDecoder, count: number) => {
	const results: (VideoSample | AudioSample | null)[] = [];
	for (let i = 0; i < count; i++) {
		results.push(await decoder.pull());
	}

	return results;
};

test('Video custom decoder close', () => testCustomDecoderClose(VIDEO));
test('Audio custom decoder close', () => testCustomDecoderClose(AUDIO));

const testCustomDecoderClose = async (type: DecoderType) => {
	registerCustomDecoder(type);
	const decoder = type.createDecoder();

	void decoder.push(type.createPacket(0));
	decoder.close();
	expect(decoder.pullable).toBe(false);

	// The custom decoder finishes its queued calls before closing, and what comes out late is discarded
	await tick();
	expect(customCalls).toEqual(['init', 'decode', 'close']);
	expect(decoder._results.length).toBe(0);
};

test('Video custom decoder backpressure', () => testCustomDecoderBackpressure(VIDEO));
test('Audio custom decoder backpressure', () => testCustomDecoderBackpressure(AUDIO));

const testCustomDecoderBackpressure = async (type: DecoderType) => {
	const pendingDecodes: (() => void)[] = [];
	customHooks = {
		decode: (emit) => {
			const { promise, resolve } = promiseWithResolvers();
			pendingDecodes.push(() => {
				emit();
				resolve();
			});

			return promise;
		},
	};
	registerCustomDecoder(type);
	const decoder = type.createDecoder();

	for (let i = 0; i < 3; i++) {
		expect(decoder.push(type.createPacket(i))).toBe(null);
	}
	const backpressure = decoder.push(type.createPacket(3));
	assert(backpressure);
	const released = trackSettlement(backpressure);

	// The finished decode's sample takes its place in the queue
	await tick();
	pendingDecodes.shift()!();
	await tick();
	expect(released.settled).toBe(false);

	(await decoder.pull())!.close();
	await tick();
	expect(released.settled).toBe(true);

	// Once the custom decoder has four calls queued, further packets wait
	void decoder.push(type.createPacket(4));
	void decoder.push(type.createPacket(5));
	expect(decoder._pendingInputs.length).toBe(1);

	decoder.close();
	while (pendingDecodes.length > 0) {
		pendingDecodes.shift()!();
		await tick();
	}
};

const trackSettlement = (promise: Promise<unknown>) => {
	const state = { settled: false };
	void promise.then(() => {
		state.settled = true;
	});

	return state;
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Video custom decoder errors', () => testCustomDecoderErrors(VIDEO));
test('Audio custom decoder errors', () => testCustomDecoderErrors(AUDIO));

const testCustomDecoderErrors = async (type: DecoderType) => {
	await expectCustomDecoderFailure(type, {
		init: () => {
			throw new Error('Init failed.');
		},
	}, 'Init failed.');
	await expectCustomDecoderFailure(type, {
		decode: () => {
			throw new Error('Decode failed.');
		},
	}, 'Decode failed.');
	await expectCustomDecoderFailure(type, {
		decode: (_, decoder) => decoder.onError(new Error('Out-of-band failure.')),
	}, 'Out-of-band failure.');
	await expectCustomDecoderFailure(type, {
		decode: (_, decoder) => decoder.onSample({} as never),
	}, /^The argument passed to onSample must be an? (Video|Audio)Sample\.$/);
	await expectCustomDecoderFailure(type, {
		flush: () => {
			throw new Error('Flush failed.');
		},
	}, 'Flush failed.');
};

const expectCustomDecoderFailure = async (type: DecoderType, hooks: CustomHooks, error: string | RegExp) => {
	customHooks = hooks;
	registerCustomDecoder(type);
	const decoder = type.createDecoder();

	void decoder.push(type.createPacket(0));
	void decoder.push(null);
	await expect((async () => {
		while (true) {
			const result = await decoder.pull();
			result?.close();
		}
	})()).rejects.toThrow(error);
	expect(decoder.pushable).toBe(false);
	expect(decoder.pullable).toBe(false);

	unregisterDecoder(type.getCustomDecoderClass());
	customCalls.length = 0;
};

type CustomHooks = {
	init?: () => MaybePromise<void>;
	decode?: (emit: () => void, decoder: TestCustomVideoDecoder | TestCustomAudioDecoder) => MaybePromise<unknown>;
	flush?: () => MaybePromise<void>;
};

let customHooks: CustomHooks = {};
const customCalls: string[] = [];
const registeredCustomDecoders: (typeof TestCustomVideoDecoder | typeof TestCustomAudioDecoder)[] = [];

const registerCustomDecoder = (type: DecoderType) => {
	const CustomDecoder = type.getCustomDecoderClass();
	registerDecoder(CustomDecoder);
	registeredCustomDecoders.push(CustomDecoder);
};

class TestCustomVideoDecoder extends CustomVideoDecoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp8';
	}

	init() {
		customCalls.push('init');
		return customHooks.init?.();
	}

	async decode(packet: EncodedPacket) {
		customCalls.push('decode');
		const emit = () => this.onSample(new VideoSample(new Uint8Array(16), {
			format: 'RGBA',
			codedWidth: 2,
			codedHeight: 2,
			timestamp: packet.timestamp,
			duration: packet.duration,
		}));

		if (customHooks.decode) {
			await customHooks.decode(emit, this);
		} else {
			emit();
		}
	}

	flush() {
		customCalls.push('flush');
		return customHooks.flush?.();
	}

	close() {
		customCalls.push('close');
	}
}

class TestCustomAudioDecoder extends CustomAudioDecoder {
	static override supports(codec: AudioCodec) {
		return codec === 'opus';
	}

	init() {
		customCalls.push('init');
		return customHooks.init?.();
	}

	async decode(packet: EncodedPacket) {
		customCalls.push('decode');
		const emit = () => this.onSample(new AudioSample({
			format: 'f32',
			data: new Float32Array(AUDIO_CHANNELS * AUDIO_PACKET_FRAMES),
			numberOfChannels: AUDIO_CHANNELS,
			sampleRate: AUDIO_SAMPLE_RATE,
			timestamp: packet.timestamp,
		}));

		if (customHooks.decode) {
			await customHooks.decode(emit, this);
		} else {
			emit();
		}
	}

	flush() {
		customCalls.push('flush');
		return customHooks.flush?.();
	}

	close() {
		customCalls.push('close');
	}
}

test('Video decoder config requirement', () => testDecoderConfigRequirement(VIDEO));
test('Audio decoder config requirement', () => testDecoderConfigRequirement(AUDIO));

const testDecoderConfigRequirement = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);
	const message = 'The first packet of a packet stream must have a decoder config.';

	expect(() => decoder.push(type.createPacket(0, 'key', null))).toThrow(message);
	expect(() => decoder.push(type.createPacket(0, 'key', type.foreignDecoderConfig))).toThrow(
		`Packets for this decoder must have a ${type.decoderConfig.type} decoder config.`,
	);
	expect(decoder.pushable).toBe(true);

	// Packets without a config keep using the current one
	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1, 'delta', null));
	void decoder.push(type.createPacket(2, 'key', null));

	// A flush starts a new packet stream, which needs a config again
	void decoder.push(null);
	expect(() => decoder.push(type.createPacket(3, 'key', null))).toThrow(message);
	void decoder.push(type.createPacket(3));
	void decoder.end();

	const results = await pullCount(decoder, 6);
	expect(results.map(x => x === null)).toEqual([false, false, false, true, false, true]);
	results.forEach(x => x?.close());
	expect(mock.configs.length).toBe(1);
};

test('Video unchanged decoder config', () => testUnchangedDecoderConfig(VIDEO));
test('Audio unchanged decoder config', () => testUnchangedDecoderConfig(AUDIO));

const testUnchangedDecoderConfig = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);
	const withDescription = (lastByte: number) => ({
		...type.decoderConfig,
		description: new Uint8Array([...new Uint8Array(18), lastByte]),
	});

	// The same object, an equal copy, and an equal copy after a flush all leave the decoder as it is
	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1, 'delta', type.decoderConfig));
	void decoder.push(type.createPacket(2, 'delta', { ...type.decoderConfig }));
	void decoder.push(null);
	void decoder.push(type.createPacket(3, 'key', { ...type.decoderConfig }));

	// Descriptions are compared by their bytes
	void decoder.push(type.createPacket(4, 'key', withDescription(1)));
	void decoder.push(type.createPacket(5, 'key', withDescription(1)));
	void decoder.push(type.createPacket(6, 'key', withDescription(2)));
	void decoder.end();

	const results = await pullCount(decoder, 9);
	expect(results.map(x => x === null)).toEqual([false, false, false, true, false, false, false, false, true]);
	results.forEach(x => x?.close());
	expect(mock.configs.length).toBe(3);
	expect(mock.resetCount).toBe(2);
};

test('Video decoder config change', () => testDecoderConfigChange(VIDEO));
test('Audio decoder config change', () => testDecoderConfigChange(AUDIO));

const testDecoderConfigChange = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type, { paused: true });

	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1, 'delta', null));
	expect(() => decoder.push(type.createPacket(2, 'delta', type.otherDecoderConfig))).toThrow(
		'A packet that changes the decoder config must be a key packet.',
	);

	// The packets for the new config wait for the old one to be flushed out, and the config doesn't count as a packet
	expect(decoder.push(type.createPacket(2, 'key', type.otherDecoderConfig))).toBe(null);
	void decoder.push(type.createPacket(3, 'delta', null));
	expect(decoder._pendingInputs.length).toBe(2);
	expect(mock.decodedChunks.length).toBe(2);
	expect(mock.flushCount).toBe(1);

	mock.resume();
	void decoder.end();

	// That flush doesn't show up as a flush marker
	const results = await pullCount(decoder, 5);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		expect.closeTo(type.packetDuration, 10),
		expect.closeTo(2 * type.packetDuration, 10),
		expect.closeTo(3 * type.packetDuration, 10),
		null,
	]);
	results.forEach(x => x?.close());

	// The same WebCodecs decoder was reset and reconfigured
	expect(mockInstances.length).toBe(1);
	expect(mock.resetCount).toBe(1);
	expect(mock.configs.map(x => x.codec)).toEqual([type.decoderConfig.codec, type.otherDecoderConfig.codec]);
	expect(mock.decodedChunks.length).toBe(4);
	expect(mock.flushCount).toBe(2);
};

test('Video decoder config change after flush', () => testDecoderConfigChangeAfterFlush(VIDEO));
test('Audio decoder config change after flush', () => testDecoderConfigChangeAfterFlush(AUDIO));

const testDecoderConfigChangeAfterFlush = async (type: DecoderType) => {
	const { decoder, mock } = createMockedDecoder(type);

	// Everything was flushed already, so the decoder is reconfigured right away
	void decoder.push(type.createPacket(0));
	void decoder.push(null);
	void decoder.push(type.createPacket(1, 'key', type.otherDecoderConfig));
	void decoder.end();

	const results = await pullCount(decoder, 4);
	expect(results.map(x => x === null)).toEqual([false, true, false, true]);
	results.forEach(x => x?.close());
	expect(mock.flushCount).toBe(2);
	expect(mock.configs.length).toBe(2);
};

test('Video custom decoder config changes', () => testCustomDecoderConfigChanges(VIDEO));
test('Audio custom decoder config changes', () => testCustomDecoderConfigChanges(AUDIO));

const testCustomDecoderConfigChanges = async (type: DecoderType) => {
	registerCustomDecoder(type);
	const { decoder, mock } = createMockedDecoder(type);

	// Custom decoders can't be reconfigured, so each config gets a fresh one. Configs they don't support go to
	// WebCodecs instead.
	void decoder.push(type.createPacket(0));
	void decoder.push(type.createPacket(1, 'key', {
		...type.decoderConfig,
		description: new Uint8Array(19),
	}));
	void decoder.push(type.createPacket(2, 'key', type.otherDecoderConfig));
	void decoder.push(type.createPacket(3));
	void decoder.end();

	const results = await pullCount(decoder, 5);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		expect.closeTo(type.packetDuration, 10),
		expect.closeTo(2 * type.packetDuration, 10),
		expect.closeTo(3 * type.packetDuration, 10),
		null,
	]);
	results.forEach(x => x?.close());

	await tick();
	expect(customCalls).toEqual([
		'init', 'decode', 'flush', 'close',
		'init', 'decode', 'flush', 'close',
		'init', 'decode', 'flush', 'close',
	]);
	expect(mock.decodedChunks.length).toBe(1);
	expect(mock.state).toBe('closed');
};

test('Video decoder options', async () => {
	expect(() => new VideoPacketDecoder(5 as never)).toThrow('options must be an object.');
	expect(() => new VideoPacketDecoder({ hardwareAcceleration: 'fast' } as never)).toThrow(
		'options.hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
		+ ' \'prefer-software\'.',
	);
	expect(() => new VideoPacketDecoder({ optimizeForLatency: 1 } as never)).toThrow(
		'options.optimizeForLatency, when provided, must be a boolean.',
	);

	const { decoder, mock } = createMockedDecoder(VIDEO, {}, () => new VideoPacketDecoder({
		optimizeForLatency: true,
	}));

	// The options override the packets' configs where they're set. Since these hints configure the decoder, a
	// change in them is a config change too.
	void decoder.push(VIDEO.createPacket(0, 'key', {
		...VIDEO_DECODER_CONFIG,
		hardwareAcceleration: 'prefer-hardware',
		optimizeForLatency: false,
	}));
	void decoder.push(VIDEO.createPacket(1, 'key', {
		...VIDEO_DECODER_CONFIG,
		hardwareAcceleration: 'prefer-software',
		optimizeForLatency: false,
	}));
	void decoder.end();

	const results = await pullCount(decoder, 3);
	results.forEach(x => x?.close());
	expect((mock.configs as VideoDecoderConfig[]).map(x => [x.hardwareAcceleration, x.optimizeForLatency])).toEqual([
		['prefer-hardware', true],
		['prefer-software', true],
	]);

	// Custom decoders find the result in their config
	registerCustomDecoder(VIDEO);
	const customDecoder = new VideoPacketDecoder({ hardwareAcceleration: 'prefer-software' });
	void customDecoder.push(VIDEO.createPacket(0, 'key', {
		...VIDEO_DECODER_CONFIG,
		hardwareAcceleration: 'prefer-hardware',
		optimizeForLatency: true,
	}));
	expect(customDecoder._customDecoder!.config).toMatchObject({
		hardwareAcceleration: 'prefer-software',
		optimizeForLatency: true,
	});
	customDecoder.close();
});

test('Video alpha decoding in software', () => {
	const createAlphaPacket = (index: number, decoderConfig: ExtendedVideoDecoderConfig | null) => {
		const packet = VIDEO.createPacket(index, 'key', decoderConfig);
		return packet.clone({ sideData: { alpha: new Uint8Array([0x92]) } });
	};
	const getHardwareAccelerations = () => mockInstances.map(x => (last(x.configs) as VideoDecoderConfig)
		.hardwareAcceleration);

	// Without a preference, both decoders are pulled to software decoding, which makes the merging much faster
	const first = createMockedDecoder(VIDEO, { paused: true });
	void first.decoder.push(createAlphaPacket(0, VIDEO_DECODER_CONFIG));
	expect(getHardwareAccelerations()).toEqual([
		'prefer-software',
		'prefer-software',
	]);
	first.decoder.close();

	// An explicit preference is left alone
	const second = createMockedDecoder(VIDEO, { paused: true });
	void second.decoder.push(createAlphaPacket(0, {
		...VIDEO_DECODER_CONFIG,
		hardwareAcceleration: 'prefer-hardware',
	}));
	expect(getHardwareAccelerations()).toEqual([
		'prefer-hardware',
		'prefer-hardware',
	]);
	second.decoder.close();

	// When alpha only comes in later, it's too late for the color decoder, but not for the alpha decoder
	const third = createMockedDecoder(VIDEO, { paused: true });
	void third.decoder.push(VIDEO.createPacket(0));
	void third.decoder.push(createAlphaPacket(1, null));
	expect(getHardwareAccelerations()).toEqual([
		undefined,
		'prefer-software',
	]);
	third.decoder.close();
});

test('Video rotation and flip changes', async () => {
	const { decoder, mock } = createMockedDecoder(VIDEO);

	void decoder.push(VIDEO.createPacket(0));
	void decoder.push(VIDEO.createPacket(1, 'key', {
		...VIDEO_DECODER_CONFIG,
		rotation: 90,
		flip: true,
	}));
	void decoder.push(VIDEO.createPacket(2, 'delta', null));
	void decoder.end();

	const results = await pullCount(decoder, 4);
	const samples = results.slice(0, 3) as VideoSample[];
	expect(samples.map(x => [x.rotation, x.flip])).toEqual([[0, false], [90, true], [90, true]]);
	results.forEach(x => x?.close());

	// They're applied to the samples, not handed to WebCodecs
	expect(mock.configs.length).toBe(2);
	expect(mock.configs[1]).not.toHaveProperty('rotation');
	expect(mock.configs[1]).not.toHaveProperty('flip');
});

test('Audio PCM decoder config changes', async () => {
	createMockedDecoder(AUDIO);
	const decoder = new AudioPacketDecoder();
	const pcmPacket = new EncodedPacket({
		data: new Uint8Array(2 * AUDIO_CHANNELS * AUDIO_PACKET_FRAMES),
		type: 'key',
		timestamp: AUDIO_PACKET_DURATION,
		duration: AUDIO_PACKET_DURATION,
		decoderConfig: {
			type: 'audio',
			codec: 'pcm-s16',
			sampleRate: AUDIO_SAMPLE_RATE,
			numberOfChannels: AUDIO_CHANNELS,
		},
	});

	// Switching to PCM closes the WebCodecs decoder, so switching back needs a new one
	void decoder.push(AUDIO.createPacket(0));
	void decoder.push(pcmPacket);
	void decoder.push(AUDIO.createPacket(2));
	void decoder.end();

	const results = await pullCount(decoder, 4);
	expect(results.map(x => x?.format ?? null)).toEqual(['f32', 's16', 'f32', null]);
	expectTimestamps(results.slice(0, 3), [0, AUDIO_PACKET_DURATION, 2 * AUDIO_PACKET_DURATION]);
	results.forEach(x => x?.close());

	expect(mockInstances.length).toBe(2);
	expect(mockInstances.every(x => x.state === 'closed')).toBe(true);
});

test('Invalid video configs', () => {
	const expectInvalid = (config: object, message: string) => {
		expect(() => new EncodedPacket({
			data: new Uint8Array(1),
			type: 'key',
			timestamp: 0,
			duration: 0,
			decoderConfig: {
				type: 'video',
				...config,
			} as ExtendedVideoDecoderConfig,
		})).toThrow(message);
	};

	expectInvalid({ codec: 5 }, 'decoderConfig must specify a codec string.');
	expectInvalid({ codec: 'mp3' }, 'codec string must be a valid video codec string');
	expectInvalid({ codec: 'avc1.xyz' }, 'codec string for AVC must be a valid AVC codec string');
	expectInvalid({ codec: 'vp8', codedWidth: 0, codedHeight: 2 }, 'codedWidth, when defined, must be a positive');
	expectInvalid({ codec: 'vp8', codedWidth: 2 }, 'must specify both codedWidth and codedHeight, or neither.');
	expectInvalid(
		{ codec: 'vp8', displayAspectWidth: 2 },
		'must specify both displayAspectWidth and displayAspectHeight, or neither.',
	);
	expectInvalid({ codec: 'vp8', description: 'abc' }, 'description, when defined, must be an ArrayBuffer');
	expectInvalid({ codec: 'vp8', colorSpace: { primaries: 'nope' } }, 'colorSpace primaries, when defined');
	expectInvalid({ codec: 'vp8', hardwareAcceleration: 'fast' }, 'hardwareAcceleration, when defined');
	expectInvalid({ codec: 'vp8', optimizeForLatency: 1 }, 'optimizeForLatency, when defined, must be a boolean.');
	expectInvalid({ codec: 'vp8', rotation: '90' }, 'rotation, when defined, must be a finite number.');
	expectInvalid({ codec: 'vp8', rotation: Infinity }, 'rotation, when defined, must be a finite number.');
	expectInvalid({ codec: 'vp8', flip: 1 }, 'flip, when defined, must be a boolean.');
});

test('Invalid audio configs', () => {
	const expectInvalid = (config: object, message: string) => {
		expect(() => new EncodedPacket({
			data: new Uint8Array(1),
			type: 'key',
			timestamp: 0,
			duration: 0,
			decoderConfig: {
				type: 'audio',
				...config,
			} as ExtendedAudioDecoderConfig,
		})).toThrow(message);
	};
	const base = { sampleRate: 48000, numberOfChannels: 2 };

	expectInvalid({ ...base, codec: null }, 'decoderConfig must specify a codec string.');
	expectInvalid({ ...base, codec: 'vp8' }, 'codec string must be a valid audio codec string');
	expectInvalid({ ...base, codec: 'mp4a.40.99' }, 'codec string for AAC must be a valid AAC codec string');
	expectInvalid({ ...base, codec: 'opus', sampleRate: 0 }, 'must specify a valid sampleRate (positive integer).');
	expectInvalid(
		{ ...base, codec: 'opus', numberOfChannels: 1.5 },
		'must specify a valid numberOfChannels (positive integer).',
	);
	expectInvalid({ ...base, codec: 'opus', description: 5 }, 'description, when defined, must be an ArrayBuffer');
	expectInvalid({ ...base, codec: 'opus', description: new Uint8Array(4) }, 'Identification Header');
	expectInvalid({ ...base, codec: 'vorbis' }, 'for Vorbis must include a description');
	expectInvalid({ ...base, codec: 'flac', description: new Uint8Array(4) }, 'for FLAC must include a description');
	expectInvalid({ ...base, codec: 'pcm-s7' }, 'codec string for PCM must be one of the supported PCM codecs');
});

test('Video decoding with WebCodecs', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const { packets, results } = await decodeTrack(createDecoderForTrack(track), track, () => 0);
	expect(results.length).toBe(packets.length + 1);
	expect(results.at(-1)).toBe(null);

	const samples = results.slice(0, -1) as VideoSample[];
	expect(samples.map(x => x.timestamp)).toEqual(packets.map(x => x.timestamp).sort((a, b) => a - b));
	samples.forEach(x => x.close());
});

test('Audio decoding with WebCodecs', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const { results } = await decodeTrack(createDecoderForTrack(track), track, () => 0);
	expect(results.at(-1)).toBe(null);

	const samples = results.slice(0, -1) as AudioSample[];
	expect(samples.length).toBeGreaterThan(200);

	// Snapped to the sample rate and seamless
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]!;
		const frameIndex = sample.sampleRate * sample.timestamp;
		expect(frameIndex).toBeCloseTo(Math.round(frameIndex), 6);

		if (i > 0) {
			const previous = samples[i - 1]!;
			expect(sample.timestamp).toBeCloseTo(previous.timestamp + previous.duration, 6);
		}
	}
	samples.forEach(x => x.close());
});

test('Video flush patterns with WebCodecs', () => testFlushPatternsWithWebCodecs('video'));
test('Audio flush patterns with WebCodecs', () => testFlushPatternsWithWebCodecs('audio'));

const testFlushPatternsWithWebCodecs = async (trackType: 'video' | 'audio') => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const track = trackType === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
	assert(track);

	// Flush every 25 packets at a key packet, alternating between one flush and two consecutive ones
	const getFlushCount = (packet: EncodedPacket, index: number) => {
		return packet.type === 'key' && index > 0 && index % 25 === 0 ? 1 + (index / 25) % 2 : 0;
	};
	const { packets, results } = await decodeTrack(createDecoderForTrack(track), track, getFlushCount);

	const batchSizes: number[] = [0];
	for (const result of results) {
		if (result) {
			batchSizes[batchSizes.length - 1]!++;
			result.close();
		} else {
			batchSizes.push(0);
		}
	}

	// Each marker ends a batch, so consecutive flushes leave empty batches
	const expectedNonEmpty: boolean[] = [];
	packets.forEach((packet, index) => {
		const flushCount = getFlushCount(packet, index);
		if (flushCount > 0) {
			expectedNonEmpty.push(true);
			for (let i = 1; i < flushCount; i++) {
				expectedNonEmpty.push(false);
			}
		}
	});
	expectedNonEmpty.push(true, false);

	expect(expectedNonEmpty.length).toBeGreaterThan(4);
	expect(batchSizes.map(x => x > 0)).toEqual(expectedNonEmpty);

	if (trackType === 'video') {
		expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(packets.length);
	}
};

const decodeTrack = async (
	decoder: AnyPacketDecoder,
	track: InputVideoTrack | InputAudioTrack,
	getFlushCount: (packet: EncodedPacket, index: number) => number,
) => {
	const packets: EncodedPacket[] = [];
	const results: (VideoSample | AudioSample | null)[] = [];

	const produce = async () => {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			const flushCount = getFlushCount(packet, packets.length);
			for (let i = 0; i < flushCount; i++) {
				void decoder.push(null);
			}

			packets.push(packet);
			const backpressure = decoder.push(packet);
			if (backpressure) await backpressure;
		}

		void decoder.end();
	};

	const consume = async () => {
		while (true) {
			let result: MaybePromise<VideoSample | AudioSample | null> = decoder.pull();
			if (isThenable(result)) result = await result;
			results.push(result);

			if (!result && !decoder.pullable) {
				return;
			}
		}
	};

	await Promise.all([produce(), consume()]);
	return { packets, results };
};

test('Video close with WebCodecs', () => testCloseWithWebCodecs('video'));
test('Audio close with WebCodecs', () => testCloseWithWebCodecs('audio'));

const testCloseWithWebCodecs = async (trackType: 'video' | 'audio') => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const track = trackType === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
	assert(track);
	const decoder = createDecoderForTrack(track);

	let decodedCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		if (decoder.push(packet) || ++decodedCount === 10) {
			break;
		}
	}
	// Decoders may hold on to their output until flushed
	void decoder.push(null);

	// Samples pulled before closing stay intact
	const sample = await decoder.pull();
	assert(sample);
	decoder.close();

	expect(sample._closed).toBe(false);
	sample.close();
	expect(decoder.pullable).toBe(false);
};

const createDecoderForTrack = (track: InputVideoTrack | InputAudioTrack) => {
	return track.isVideoTrack() ? new VideoPacketDecoder() : new AudioPacketDecoder();
};

test('Video rotation and flip', async () => {
	using input = new Input({
		source: new UrlSource('/rotate-buck-bunny.mp4'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	assert(packet);

	// The track's config carries the rotation from the file
	expect(decoderConfig.rotation).toBe(90);
	expect(decoderConfig.flip).toBe(false);

	const decodeFirstSample = async (rotation: number | undefined, flip: boolean | undefined) => {
		const decoder = new VideoPacketDecoder();
		void decoder.push(packet.clone({
			decoderConfig: {
				...decoderConfig,
				rotation,
				flip,
			},
		}));
		void decoder.end();

		const sample = await decoder.pull();
		assert(sample);
		sample.close();

		return [sample.rotation, sample.flip];
	};

	expect(await decodeFirstSample(90, false)).toEqual([90, false]);
	expect(await decodeFirstSample(undefined, undefined)).toEqual([0, false]);
	expect(await decodeFirstSample(0, true)).toEqual([0, true]);

	// Rotations snap to the nearest multiple of 90, with ties going up
	expect(await decodeFirstSample(-90, false)).toEqual([270, false]);
	expect(await decodeFirstSample(45, false)).toEqual([90, false]);
	expect(await decodeFirstSample(135, false)).toEqual([180, false]);
	expect(await decodeFirstSample(-45, false)).toEqual([0, false]);
	expect(await decodeFirstSample(-46, false)).toEqual([270, false]);
	expect(await decodeFirstSample(450, false)).toEqual([90, false]);
});

test('Video timing from packets', async () => {
	using input = new Input({
		source: new UrlSource('/rotate-buck-bunny.mp4'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const { packets, results } = await decodeTrack(createDecoderForTrack(track), track, () => 0);
	const samples = results.slice(0, -1) as VideoSample[];

	// WebCodecs works in microseconds, which can't hold 24 FPS timings exactly, so they're taken from the packets
	expect(packets.some(x => x.duration !== Math.round(1e6 * x.duration) / 1e6)).toBe(true);
	expect(samples.map(x => [x.timestamp, x.duration])).toEqual(
		packets.map(x => [x.timestamp, x.duration]).sort((a, b) => a[0]! - b[0]!),
	);
	samples.forEach(x => x.close());
});

test('Track configs with WebCodecs', async () => {
	using input = new Input({
		source: new UrlSource('/rotate-buck-bunny.mp4'),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack && audioTrack);

	const videoConfig = await videoTrack.getDecoderConfig();
	const audioConfig = await audioTrack.getDecoderConfig();
	assert(videoConfig && audioConfig);

	expect((await VideoDecoder.isConfigSupported(videoConfig)).supported).toBe(true);
	expect((await AudioDecoder.isConfigSupported(audioConfig)).supported).toBe(true);
});

test('PCM decoding', async () => {
	const float32 = (value: number, littleEndian: boolean) => {
		const view = new DataView(new ArrayBuffer(4));
		view.setFloat32(0, value, littleEndian);
		return [...new Uint8Array(view.buffer)];
	};
	const float64 = (value: number, littleEndian: boolean) => {
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value, littleEndian);
		return [...new Uint8Array(view.buffer)];
	};

	const decodeValue = async (codec: string, bytes: number[]) => {
		const decoder = new AudioPacketDecoder();
		void decoder.push(new EncodedPacket({
			data: new Uint8Array(bytes),
			type: 'key',
			timestamp: 0,
			duration: 1 / 8000,
			decoderConfig: {
				type: 'audio',
				codec,
				sampleRate: 8000,
				numberOfChannels: 1,
			},
		}));
		void decoder.end();

		const sample = await decoder.pull();
		assert(sample);
		const data = new Float32Array(1);
		sample.copyTo(data, { planeIndex: 0, format: 'f32' });
		sample.close();

		return [sample.format, data[0]];
	};

	expect(await decodeValue('pcm-u8', [0xc0])).toEqual(['u8', 0.5]);
	expect(await decodeValue('pcm-s8', [0x40])).toEqual(['u8', 0.5]);
	expect(await decodeValue('pcm-s16', [0x00, 0x40])).toEqual(['s16', 0.5]);
	expect(await decodeValue('pcm-s16be', [0x40, 0x00])).toEqual(['s16', 0.5]);
	expect(await decodeValue('pcm-s24', [0x00, 0x00, 0x40])).toEqual(['s32', 0.5]);
	expect(await decodeValue('pcm-s24be', [0x40, 0x00, 0x00])).toEqual(['s32', 0.5]);
	expect(await decodeValue('pcm-s32', [0x00, 0x00, 0x00, 0x40])).toEqual(['s32', 0.5]);
	expect(await decodeValue('pcm-s32be', [0x40, 0x00, 0x00, 0x00])).toEqual(['s32', 0.5]);
	expect(await decodeValue('pcm-f32', float32(0.5, true))).toEqual(['f32', 0.5]);
	expect(await decodeValue('pcm-f32be', float32(0.5, false))).toEqual(['f32', 0.5]);
	expect(await decodeValue('pcm-f64', float64(0.5, true))).toEqual(['f32', 0.5]);
	expect(await decodeValue('pcm-f64be', float64(0.5, false))).toEqual(['f32', 0.5]);
	expect(await decodeValue('ulaw', [0x12])).toEqual(['s16', fromUlaw(0x12) / 0x8000]);
	expect(await decodeValue('alaw', [0x12])).toEqual(['s16', fromAlaw(0x12) / 0x8000]);
});

test('PCM timestamps', async () => {
	const decoder = new AudioPacketDecoder();
	const decoderConfig: ExtendedAudioDecoderConfig = {
		type: 'audio',
		codec: 'pcm-s16',
		sampleRate: 3,
		numberOfChannels: 2,
	};
	const createPacket = (frameCount: number, timestamp: number, extraBytes = 0) => {
		return new EncodedPacket({
			data: new Uint8Array(4 * frameCount + extraBytes),
			type: 'key',
			timestamp,
			duration: frameCount / 3,
			decoderConfig,
		});
	};

	void decoder.push(createPacket(1, 0));
	// Slightly off, but within a frame of where the previous one ended
	void decoder.push(createPacket(1, 0.3));
	// Packets without a whole frame are dropped, and so are partial trailing frames
	void decoder.push(createPacket(0, 0.6, 3));
	void decoder.push(createPacket(1, 0.6, 3));
	// Far off, so the timeline resyncs
	void decoder.push(createPacket(1, 5));
	void decoder.end();

	const samples = await pullUntilNull(decoder) as AudioSample[];
	expect(samples.map(x => [x.timestamp, x.numberOfFrames])).toEqual([[0, 1], [1 / 3, 1], [2 / 3, 1], [5, 1]]);
	samples.forEach(x => x.close());
});

const pullUntilNull = async (decoder: AnyPacketDecoder) => {
	const samples: (VideoSample | AudioSample)[] = [];
	while (true) {
		const sample = await decoder.pull();
		if (!sample) {
			return samples;
		}

		samples.push(sample);
	}
};
