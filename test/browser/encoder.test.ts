import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { CustomAudioEncoder, CustomVideoEncoder, registerEncoder } from '../../src/custom-coder.js';
import {
	AudioEncodingConfig,
	AudioSampleEncoder,
	PCM_ENCODER_PACKET_SIZE,
	Quality,
	SampleEncoder,
	VideoEncodingConfig,
	VideoSampleEncoder,
} from '../../src/encode.js';
import { CoderClosedError, VideoPacketDecoder } from '../../src/decode.js';
import { assert, isThenable, last, MaybePromise, promiseWithResolvers } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample, VideoSample } from '../../src/sample.js';

beforeAll(async () => {
	// Gets the priming shift detection's throwaway encoder out of the way
	vi.stubGlobal('AudioEncoder', MockAudioEncoder);
	vi.stubGlobal('AudioDecoder', MockAudioDecoder);
	const encoder = AUDIO.createEncoder();
	using sample = AUDIO.createSample(0);
	void encoder.push(sample);
	void encoder.end();
	await pullUntilNull(encoder);
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();

	customEncodersEnabled = false;
	customHooks = {};
	customCalls.length = 0;
});

type AnySample = VideoSample | AudioSample;

type AnySampleEncoder = SampleEncoder<AnySample> & {
	push(sample: AnySample | null, encodeOptions?: VideoEncoderEncodeOptions): Promise<void> | null;
};

type EncoderType = {
	globalName: 'VideoEncoder' | 'AudioEncoder';
	getMockClass: () => typeof MockVideoEncoder | typeof MockAudioEncoder;
	createEncoder: (config?: Record<string, unknown>) => AnySampleEncoder;
	createSample: (index: number) => AnySample;
	createOtherSample: (index: number) => AnySample;
	sampleDuration: number;
};

const VIDEO_SAMPLE_DURATION = 0.04;
const AUDIO_SAMPLE_DURATION = 0.02;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_SAMPLE_FRAMES = Math.round(AUDIO_SAMPLE_RATE * AUDIO_SAMPLE_DURATION);

const VIDEO: EncoderType = {
	globalName: 'VideoEncoder',
	getMockClass: () => MockVideoEncoder,
	createEncoder: config => new VideoSampleEncoder({
		codec: 'vp8',
		quality: new Quality('medium'),
		...config,
	} as VideoEncodingConfig) as unknown as AnySampleEncoder,
	createSample: index => createVideoSample(index, 2),
	createOtherSample: index => createVideoSample(index, 4),
	sampleDuration: VIDEO_SAMPLE_DURATION,
};

const AUDIO: EncoderType = {
	globalName: 'AudioEncoder',
	getMockClass: () => MockAudioEncoder,
	createEncoder: config => new AudioSampleEncoder({
		codec: 'opus',
		quality: new Quality('medium'),
		...config,
	} as AudioEncodingConfig) as unknown as AnySampleEncoder,
	createSample: index => createAudioSample(index, AUDIO_CHANNELS),
	createOtherSample: index => createAudioSample(index, 1),
	sampleDuration: AUDIO_SAMPLE_DURATION,
};

const createVideoSample = (index: number, size: number) => new VideoSample(new Uint8Array(4 * size * size), {
	format: 'RGBA',
	codedWidth: size,
	codedHeight: size,
	timestamp: VIDEO_SAMPLE_DURATION * index,
	duration: VIDEO_SAMPLE_DURATION,
});

const createAudioSample = (index: number, numberOfChannels: number) => new AudioSample({
	format: 'f32',
	data: new Float32Array(numberOfChannels * AUDIO_SAMPLE_FRAMES),
	numberOfChannels,
	sampleRate: AUDIO_SAMPLE_RATE,
	timestamp: AUDIO_SAMPLE_DURATION * index,
});

test('Video encoding', () => testEncoding(VIDEO));
test('Audio encoding', () => testEncoding(AUDIO));

const testEncoding = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type);

	for (let i = 0; i < 3; i++) {
		expect(pushSample(encoder, type, i)).toBe(null);
	}
	void encoder.end();

	const packets = await pullUntilNull(encoder);
	expectTimestamps(packets, [0, type.sampleDuration, 2 * type.sampleDuration]);
	expect(packets[0]!.type).toBe('key');
	for (const packet of packets) {
		expect(packet.duration).toBeCloseTo(type.sampleDuration, 10);
	}

	const decoderConfig = packets[0]!.decoderConfig;
	assert(decoderConfig);
	expect(decoderConfig.type).toBe(type === VIDEO ? 'video' : 'audio');
	expect(packets.every(x => x.decoderConfig === decoderConfig)).toBe(true);

	expect(mock.configs.length).toBe(1);
	expect(mock.state).toBe('closed');
	expect(encoder.pullable).toBe(false);
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

const pushSample = (encoder: AnySampleEncoder, type: EncoderType, index: number) => {
	using sample = type.createSample(index);
	return encoder.push(sample);
};

const expectTimestamps = (packets: (EncodedPacket | null)[], expected: number[]) => {
	expect(packets.length).toBe(expected.length);
	for (let i = 0; i < packets.length; i++) {
		expect(packets[i]!.timestamp).toBeCloseTo(expected[i]!, 10);
	}
};

test('Video pull before output', () => testPullBeforeOutput(VIDEO));
test('Audio pull before output', () => testPullBeforeOutput(AUDIO));

const testPullBeforeOutput = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	const first = encoder.pull();
	const second = encoder.pull();
	expect(isThenable(first)).toBe(true);
	expect(isThenable(second)).toBe(true);

	void pushSample(encoder, type, 0);
	void pushSample(encoder, type, 1);
	await tick();
	mock.resume();

	expectTimestamps([await first, await second], [0, type.sampleDuration]);

	encoder.close();
};

test('Video flush markers', () => testFlushMarkers(VIDEO));
test('Audio flush markers', () => testFlushMarkers(AUDIO));

const testFlushMarkers = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type);

	void encoder.push(null);
	expect(encoder.pull()).toBe(null);

	void pushSample(encoder, type, 0);
	void pushSample(encoder, type, 1);
	void encoder.push(null);
	void encoder.push(null);

	const results = await pullCount(encoder, 4);
	expect(results.map(x => x === null)).toEqual([false, false, true, true]);
	expect(encoder.pullable).toBe(true);

	void encoder.end();
	expect(mock.flushCount).toBe(1);
	expect(encoder.pull()).toBe(null);
	expect(encoder.pullable).toBe(false);
};

const pullCount = async (encoder: AnySampleEncoder, count: number) => {
	const results: (EncodedPacket | null)[] = [];
	for (let i = 0; i < count; i++) {
		results.push(await encoder.pull());
	}

	return results;
};

test('Video encoding during flush', () => testEncodingDuringFlush(VIDEO));
test('Audio encoding during flush', () => testEncodingDuringFlush(AUDIO));

const testEncodingDuringFlush = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	void pushSample(encoder, type, 0);
	void encoder.push(null);
	void pushSample(encoder, type, 1);
	void pushSample(encoder, type, 2);
	void encoder.push(null);

	await tick();
	expect(mock.inputs.length).toBe(1);

	mock.resume();
	const results = await pullCount(encoder, 5);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		null,
		expect.closeTo(type.sampleDuration, 10),
		expect.closeTo(2 * type.sampleDuration, 10),
		null,
	]);
	expect(mock.flushCount).toBe(2);

	expect(results.map(x => x?.type ?? null)).toEqual(['key', null, 'key', type === VIDEO ? 'delta' : 'key', null]);

	encoder.close();
};

test('Video flush resetting the encoder', () => testFlushReset(VIDEO));
test('Audio flush resetting the encoder', () => testFlushReset(AUDIO));

const testFlushReset = async (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type, { configAfterFlush: true });

	void pushSample(encoder, type, 0);
	void encoder.push(null);
	void pushSample(encoder, type, 1);
	void encoder.push(null);

	const otherSample = type.createOtherSample(2);
	void encoder.push(otherSample);
	otherSample.close();
	void encoder.end();

	const results = await pullCount(encoder, 6);
	expect(results.map(x => x === null)).toEqual([false, true, false, true, false, true]);
	const [first, , second, , third] = results;
	assert(first && second && third);

	expect(mockInstances.length).toBe(2);
	expect(mockInstances[0]!.configs.length).toBe(1);
	expect(mockInstances[0]!.state).toBe('closed');

	expect(second.decoderConfig).toBe(first.decoderConfig);
	expect(third.decoderConfig).not.toBe(first.decoderConfig);
	if (type === VIDEO) {
		expect(first.decoderConfig).toMatchObject({ codedWidth: 2 });
		expect(third.decoderConfig).toMatchObject({ codedWidth: 4 });
	} else {
		expect(first.decoderConfig).toMatchObject({ numberOfChannels: 2 });
		expect(third.decoderConfig).toMatchObject({ numberOfChannels: 1 });
	}
};

test('Video decoder config change', () => testDecoderConfigChange(VIDEO));
test('Audio decoder config change', () => testDecoderConfigChange(AUDIO));

const testDecoderConfigChange = async (type: EncoderType) => {
	type Meta = EncodedVideoChunkMetadata | EncodedAudioChunkMetadata | undefined;
	const metas: Meta[] = [];
	const { encoder } = createMockedEncoder(type, { changedConfigIndex: 2 }, {
		onEncodedPacket: (_: EncodedPacket, meta: Meta) => metas.push(meta),
	});

	for (let i = 0; i < 4; i++) {
		void pushSample(encoder, type, i);
	}
	void encoder.end();

	const packets = await pullUntilNull(encoder);
	const [first, second, third, fourth] = packets;
	assert(first && second && third && fourth);

	expect(second.decoderConfig).toBe(first.decoderConfig);
	expect(third.decoderConfig).not.toBe(first.decoderConfig);
	expect(fourth.decoderConfig).toBe(third.decoderConfig);
	if (type === VIDEO) {
		expect(first.decoderConfig).not.toHaveProperty('colorSpace');
		expect(third.decoderConfig).toMatchObject({ colorSpace: { primaries: 'bt709' } });
	} else {
		expect(first.decoderConfig).toMatchObject({ numberOfChannels: 2 });
		expect(third.decoderConfig).toMatchObject({ numberOfChannels: 1 });
	}

	expect(metas.map(x => !!x?.decoderConfig)).toEqual([true, false, true, false]);
};

test('Video sample validation', () => testSampleValidation(VIDEO));
test('Audio sample validation', () => testSampleValidation(AUDIO));

const testSampleValidation = async (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type);
	const message = type === VIDEO
		? 'Video sample size must remain constant.'
		: 'Audio parameters must remain constant.';

	void pushSample(encoder, type, 0);

	using otherSample = type.createOtherSample(1);
	expect(() => encoder.push(otherSample)).toThrow(message);
	expect(encoder.pushable).toBe(true);

	void encoder.push(null);
	void encoder.push(otherSample);
	void encoder.end();

	const results = await pullCount(encoder, 4);
	expect(results.map(x => x === null)).toEqual([false, true, false, true]);
};

test('Video invalid push arguments', () => testInvalidPushArguments(VIDEO));
test('Audio invalid push arguments', () => testInvalidPushArguments(AUDIO));

const testInvalidPushArguments = (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type);
	const sampleName = type === VIDEO ? 'VideoSample' : 'AudioSample';

	expect(() => encoder.push(undefined as unknown as null)).toThrow(TypeError);
	expect(() => encoder.push({} as AnySample)).toThrow(
		`sample must be a${type === VIDEO ? '' : 'n'} ${sampleName} or null.`,
	);

	const closedSample = type.createSample(0);
	closedSample.close();
	expect(() => encoder.push(closedSample)).toThrow('Cannot encode a closed sample.');

	if (type === VIDEO) {
		using sample = type.createSample(0);
		expect(() => encoder.push(sample, null as unknown as VideoEncoderEncodeOptions)).toThrow(
			'encodeOptions, when provided, must be an object.',
		);
	}

	expect(encoder.pushable).toBe(true);
	encoder.close();

	expect(() => type.createEncoder({ codec: 'nope' as VideoCodec & AudioCodec })).toThrow(TypeError);
	expect(() => type.createEncoder({ highWaterMark: 0 })).toThrow(
		'options.highWaterMark, when provided, must be a positive integer.',
	);
	expect(() => type.createEncoder({ highWaterMark: 1.5 })).toThrow(
		'options.highWaterMark, when provided, must be a positive integer.',
	);
};

test('Video backpressure', () => testBackpressure(VIDEO));
test('Audio backpressure', () => testBackpressure(AUDIO));

const testBackpressure = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	expect(pushSample(encoder, type, 0)).toBe(null);
	expect(pushSample(encoder, type, 1)).toBe(null);
	expect(pushSample(encoder, type, 2)).toBe(null);

	const backpressure = pushSample(encoder, type, 3);
	assert(backpressure);
	const released = trackSettlement(backpressure);

	expect(pushSample(encoder, type, 4)).toBe(backpressure);

	await tick();
	mock.resume();
	await tick();
	await tick();
	expect(mock.inputs.length).toBe(4);
	expect(released.settled).toBe(false);

	await encoder.pull();
	await tick();
	await tick();
	expect(mock.inputs.length).toBe(5);
	expect(released.settled).toBe(true);

	encoder.close();

	const custom = createMockedEncoder(type, { paused: true }, { highWaterMark: 2 });
	expect(pushSample(custom.encoder, type, 0)).toBe(null);
	expect(pushSample(custom.encoder, type, 1)).not.toBe(null);
	custom.encoder.close();
};

const trackSettlement = (promise: Promise<unknown>) => {
	const state = { settled: false };
	void promise.then(() => {
		state.settled = true;
	});

	return state;
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Video samples waiting for room', () => testSamplesWaitingForRoom(VIDEO));
test('Audio samples waiting for room', () => testSamplesWaitingForRoom(AUDIO));

const testSamplesWaitingForRoom = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	for (let i = 0; i < 6; i++) {
		void pushSample(encoder, type, i);
	}
	void encoder.push(null);
	void pushSample(encoder, type, 6);
	void pushSample(encoder, type, 7);
	void encoder.end();

	await tick();
	expect(mock.inputs.length).toBe(4);

	mock.resume();
	await tick();
	await tick();
	expect(mock.inputs.length).toBeLessThan(8);

	const results = await pullCount(encoder, 10);
	expect(encoder.pullable).toBe(false);
	expect(mock.state).toBe('closed');
	expect(mock.inputs.length).toBe(8);
	expect(mock.flushCount).toBe(2);

	expect(results.map(x => x === null)).toEqual([false, false, false, false, false, false, true, false, false, true]);
	expectTimestamps(results.filter(x => x !== null), [0, 1, 2, 3, 4, 5, 6, 7].map(i => i * type.sampleDuration));
};

test('Video close with waiting samples', () => testCloseWithWaitingSamples(VIDEO));
test('Audio close with waiting samples', () => testCloseWithWaitingSamples(AUDIO));

const testCloseWithWaitingSamples = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	for (let i = 0; i < 7; i++) {
		void pushSample(encoder, type, i);
	}
	await tick();

	const waiting = encoder._pendingInputs.map(x => x!.sample);
	expect(waiting.length).toBe(2);
	encoder.close();
	expect(waiting.every(x => x._closed)).toBe(true);
	expect(mock.state).toBe('closed');

	mock.resume();
	await tick();
	expect(mock.inputs.length).toBe(4);
};

test('Video end', () => testEnd(VIDEO));
test('Audio end', () => testEnd(AUDIO));

const testEnd = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	const pulls = [encoder.pull(), encoder.pull(), encoder.pull()];
	void pushSample(encoder, type, 0);

	const finished = encoder.end();
	expect(encoder.end()).toBe(finished);
	expect(encoder.pushable).toBe(false);
	expect(encoder.pullable).toBe(true);
	const message = 'Cannot push after the encoder has been ended or closed.';
	expect(() => pushSample(encoder, type, 1)).toThrow(message);
	expect(() => encoder.push(null)).toThrow(message);

	const settlement = trackSettlement(finished);
	await tick();
	expect(mock.state).toBe('configured');
	expect(settlement.settled).toBe(false);

	mock.resume();
	expect(await pulls[0]).not.toBe(null);
	expect(await pulls[1]).toBe(null);
	expect(encoder.pullable).toBe(false);
	expect(mock.state).toBe('closed');
	expect(mock.flushCount).toBe(1);
	await finished;

	await expect(pulls[2]).rejects.toThrow('Cannot pull past the end of the encoder.');
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');

	encoder.close();
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video end without samples', () => testEndWithoutSamples(VIDEO));
test('Audio end without samples', () => testEndWithoutSamples(AUDIO));

const testEndWithoutSamples = (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type);

	void encoder.end();
	expect(mockInstances.length).toBe(0);
	expect(encoder.pull()).toBe(null);
	expect(encoder.pullable).toBe(false);
};

test('Video end without pulling', () => testEndWithoutPulling(VIDEO));
test('Audio end without pulling', () => testEndWithoutPulling(AUDIO));

const testEndWithoutPulling = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type);

	void pushSample(encoder, type, 0);
	void pushSample(encoder, type, 1);
	const finished = encoder.end();
	const settlement = trackSettlement(finished);
	while (encoder._results.length < 3) {
		await tick();
	}
	expect(mock.state).toBe('closed');

	expect(settlement.settled).toBe(false);

	const results = await pullCount(encoder, 3);
	expect(results.map(x => x === null)).toEqual([false, false, true]);
	expect(encoder.pullable).toBe(false);
	await finished;
};

test('Video close', () => testClose(VIDEO));
test('Audio close', () => testClose(AUDIO));

const testClose = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type);

	for (let i = 0; i < 3; i++) {
		void pushSample(encoder, type, i);
	}
	while (encoder._results.length < 3) {
		await tick();
	}

	encoder.close();
	expect(encoder._results.length).toBe(0);
	expect(mock.state).toBe('closed');
	expect(encoder.pushable).toBe(false);
	expect(encoder.pullable).toBe(false);
	expect(() => pushSample(encoder, type, 3)).toThrow('Cannot push after the encoder has been ended or closed.');

	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');

	encoder.close();
	void encoder.end();
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video close with waiting pull', () => testCloseWithWaitingPull(VIDEO));
test('Audio close with waiting pull', () => testCloseWithWaitingPull(AUDIO));

const testCloseWithWaitingPull = async (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type, { paused: true });

	const pulls = [encoder.pull(), encoder.pull()];
	for (let i = 0; i < 3; i++) {
		void pushSample(encoder, type, i);
	}
	const backpressure = pushSample(encoder, type, 3);
	assert(backpressure);

	encoder.close();
	await Promise.all(pulls.map(async (pull) => {
		await expect(pull).rejects.toThrow(CoderClosedError);
		await expect(pull).rejects.toThrow('The encoder was closed during a pending pull.');
	}));
	expect(encoder.pullable).toBe(false);
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
	await backpressure;
};

test('Video process resolving after close', () => testProcessResolvingAfterClose(VIDEO));
test('Audio process resolving after close', () => testProcessResolvingAfterClose(AUDIO));

const testProcessResolvingAfterClose = async (type: EncoderType) => {
	const processed = promiseWithResolvers<AnySample>();
	const encoderConfigs: (VideoEncoderConfig | AudioEncoderConfig)[] = [];
	const { encoder } = createMockedEncoder(type, {}, {
		transform: { process: () => processed.promise },
		onEncoderConfig: (config: VideoEncoderConfig | AudioEncoderConfig) => encoderConfigs.push(config),
	});

	void pushSample(encoder, type, 0);
	await tick();
	encoder.close();

	const sample = type.createSample(0);
	processed.resolve(sample);
	await tick();
	expect(sample._closed).toBe(true);
	expect(encoderConfigs.length).toBe(0);
	expect(mockInstances.length).toBe(0);
};

test('Video close after end', () => testCloseAfterEnd(VIDEO));
test('Audio close after end', () => testCloseAfterEnd(AUDIO));

const testCloseAfterEnd = async (type: EncoderType) => {
	// During the final flush
	const first = createMockedEncoder(type, { paused: true });

	void pushSample(first.encoder, type, 0);
	void first.encoder.push(null);
	void pushSample(first.encoder, type, 1);
	void first.encoder.end();
	await tick();

	first.encoder.close();
	expect(first.mock.state).toBe('closed');
	expect(first.encoder.pullable).toBe(false);
	expect(() => first.encoder.pull()).toThrow('Cannot pull past the end of the encoder.');

	first.mock.resume();
	await tick();
	expect(first.encoder._hasError).toBe(false);
	expect(first.mock.inputs.length).toBe(1);

	// After the final flush
	const second = createMockedEncoder(type);

	void pushSample(second.encoder, type, 0);
	void pushSample(second.encoder, type, 1);
	const finished = second.encoder.end();
	while (second.encoder._results.length < 3) {
		await tick();
	}

	second.encoder.close();
	await finished;
	expect(second.encoder._results.length).toBe(0);
	expect(second.encoder.pullable).toBe(false);
	expect(() => second.encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video dispose', () => testDispose(VIDEO));
test('Audio dispose', () => testDispose(AUDIO));

const testDispose = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type);
	{
		using disposed = encoder;
		void pushSample(disposed, type, 0);
		await tick();
	}

	expect(mock.state).toBe('closed');
	expect(encoder.pushable).toBe(false);
	expect(encoder.pullable).toBe(false);
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video producer and consumer failures', () => testProducerAndConsumerFailures(VIDEO));
test('Audio producer and consumer failures', () => testProducerAndConsumerFailures(AUDIO));

const testProducerAndConsumerFailures = async (type: EncoderType) => {
	// Failing producer
	const first = createMockedEncoder(type);
	const produceAndFail = async () => {
		using encoder = first.encoder;
		for (let i = 0; i < 10; i++) {
			const backpressure = pushSample(encoder, type, i);
			if (backpressure) await backpressure;
		}
		while (encoder._pendingPulls.length === 0) {
			await tick();
		}

		throw new Error('Sample retrieval failed.');
	};

	const [produced, consumed] = await Promise.allSettled([produceAndFail(), pullUntilNull(first.encoder)]);
	expect(produced.status).toBe('rejected');
	assert(consumed.status === 'rejected');
	expect(consumed.reason).toBeInstanceOf(CoderClosedError);
	expect(first.encoder.pullable).toBe(false);

	// Failing consumer
	const second = createMockedEncoder(type);
	const produce = async () => {
		using encoder = second.encoder;
		for (let i = 0; i < 10; i++) {
			const backpressure = pushSample(encoder, type, i);
			if (backpressure) await backpressure;
		}

		await encoder.end();
	};
	const consumeAndFail = async () => {
		using encoder = second.encoder;
		await encoder.pull();

		throw new Error('Processing failed.');
	};

	await Promise.all([
		expect(produce()).rejects.toThrow('Cannot push after the encoder has been ended or closed.'),
		expect(consumeAndFail()).rejects.toThrow('Processing failed.'),
	]);
	expect(second.mock.state).toBe('closed');
};

test('Video configure throwing', () => testConfigureThrowing(VIDEO));
test('Audio configure throwing', () => testConfigureThrowing(AUDIO));

const testConfigureThrowing = async (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type, { rejectedConfigIndex: 0 });

	expect(pushSample(encoder, type, 0)).toBe(null);
	await expect(encoder.pull()).rejects.toThrow('Invalid configuration.');
	expect(encoder.pushable).toBe(false);
	expect(encoder.pullable).toBe(false);
	expect(() => pushSample(encoder, type, 1)).toThrow('Cannot push after the encoder has been ended or closed.');
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video unsupported config', () => testUnsupportedConfig(VIDEO));
test('Audio unsupported config', () => testUnsupportedConfig(AUDIO));

const testUnsupportedConfig = async (type: EncoderType) => {
	const encoderConfigs: (VideoEncoderConfig | AudioEncoderConfig)[] = [];
	const { encoder } = createMockedEncoder(type, { unsupported: true }, {
		onEncoderConfig: (config: VideoEncoderConfig | AudioEncoderConfig) => encoderConfigs.push(config),
	});

	void pushSample(encoder, type, 0);
	await expect(encoder.pull()).rejects.toThrow('is not supported in this environment.');
	expect(mockInstances.length).toBe(0);
	expect(encoder.pushable).toBe(false);

	expect(encoderConfigs.length).toBe(1);
};

test('Video encode throwing', () => testEncodeThrowing(VIDEO));
test('Audio encode throwing', () => testEncodeThrowing(AUDIO));

const testEncodeThrowing = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { rejectedInputIndex: 1 });

	void pushSample(encoder, type, 0);
	void pushSample(encoder, type, 1);
	await expect(pullUntilNull(encoder)).rejects.toThrow('Malformed input.');
	expect(mock.state).toBe('closed');
	expect(() => pushSample(encoder, type, 2)).toThrow('Cannot push after the encoder has been ended or closed.');
};

test('Video encoding error', () => testEncodingError(VIDEO));
test('Audio encoding error', () => testEncodingError(AUDIO));

const testEncodingError = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { failingInputIndex: 2 });

	for (let i = 0; i < 4; i++) {
		void pushSample(encoder, type, i);
	}
	while (!encoder._hasError) {
		await tick();
	}
	expect(encoder.pushable).toBe(false);
	expect(() => pushSample(encoder, type, 4)).toThrow('Cannot push after the encoder has been ended or closed.');

	expect(mock.outputs.length).toBe(2);
	expectTimestamps(await pullCount(encoder, 2), [0, type.sampleDuration]);
	expect(encoder.pullable).toBe(true);
	expect(() => encoder.pull()).toThrow('Encoding failed.');
	expect(encoder.pullable).toBe(false);
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video close with an unpulled error', () => testCloseWithUnpulledError(VIDEO));
test('Audio close with an unpulled error', () => testCloseWithUnpulledError(AUDIO));

const testCloseWithUnpulledError = async (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type, { failingInputIndex: 2 });

	for (let i = 0; i < 4; i++) {
		void pushSample(encoder, type, i);
	}
	while (!encoder._hasError) {
		await tick();
	}

	expect(encoder._results.length).toBe(2);
	encoder.close();
	expect(encoder._results.length).toBe(0);
	expect(encoder.pullable).toBe(false);
	expect(() => encoder.pull()).toThrow('Cannot pull past the end of the encoder.');
};

test('Video encoding error with waiting pull', () => testEncodingErrorWithWaitingPull(VIDEO));
test('Audio encoding error with waiting pull', () => testEncodingErrorWithWaitingPull(AUDIO));

const testEncodingErrorWithWaitingPull = async (type: EncoderType) => {
	const { encoder } = createMockedEncoder(type, { failingInputIndex: 0 });

	const pulled = encoder.pull();
	void pushSample(encoder, type, 0);
	await expect(pulled).rejects.toThrow('Encoding failed.');
	expect(encoder.pullable).toBe(false);
};

test('Video error during flush', () => testErrorDuringFlush(VIDEO));
test('Audio error during flush', () => testErrorDuringFlush(AUDIO));

const testErrorDuringFlush = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	void pushSample(encoder, type, 0);
	void encoder.push(null);
	void pushSample(encoder, type, 1);
	const pulled = encoder.pull();
	await tick();

	mock.fail(new DOMException('Encoding failed.', 'EncodingError'));
	await expect(pulled).rejects.toThrow('Encoding failed.');
	expect(mock.inputs.length).toBe(1);
};

test('Video error during end', () => testErrorDuringEnd(VIDEO));
test('Audio error during end', () => testErrorDuringEnd(AUDIO));

const testErrorDuringEnd = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	void pushSample(encoder, type, 0);
	const finished = encoder.end();
	await tick();

	mock.fail(new DOMException('Encoding failed.', 'EncodingError'));
	await finished;
	expect(mock.state).toBe('closed');
	expect(() => encoder.pull()).toThrow('Encoding failed.');
};

test('Video error with backpressure', () => testErrorWithBackpressure(VIDEO));
test('Audio error with backpressure', () => testErrorWithBackpressure(AUDIO));

const testErrorWithBackpressure = async (type: EncoderType) => {
	const { encoder, mock } = createMockedEncoder(type, { paused: true });

	for (let i = 0; i < 3; i++) {
		void pushSample(encoder, type, i);
	}
	const backpressure = pushSample(encoder, type, 3);
	assert(backpressure);
	await tick();

	mock.fail(new DOMException('Encoding failed.', 'EncodingError'));
	await backpressure;
	expect(() => encoder.pull()).toThrow('Encoding failed.');
};

test('Video callbacks', () => testCallbacks(VIDEO));
test('Audio callbacks', () => testCallbacks(AUDIO));

const testCallbacks = async (type: EncoderType) => {
	const encoderConfigs: (VideoEncoderConfig | AudioEncoderConfig)[] = [];
	const encodedSamples: AnySample[] = [];
	const encodedPackets: EncodedPacket[] = [];
	const { encoder, mock } = createMockedEncoder(type, {}, {
		onEncoderConfig: (config: VideoEncoderConfig | AudioEncoderConfig) => encoderConfigs.push(config),
		onEncodedSample: (sample: AnySample) => encodedSamples.push(sample),
		onEncodedPacket: (packet: EncodedPacket) => encodedPackets.push(packet),
	});

	void pushSample(encoder, type, 0);
	void pushSample(encoder, type, 1);
	void encoder.end();
	const packets = await pullUntilNull(encoder);

	expect(encoderConfigs).toEqual([mock.configs[0]]);
	expect(encodedSamples.map(x => x.timestamp)).toEqual([0, type.sampleDuration]);

	expect(encodedPackets).toEqual(packets);
	expect(encodedPackets[0]).toBe(packets[0]);
};

type MockOptions = {
	paused?: boolean;
	// configure() throws synchronously for the config at this index
	rejectedConfigIndex?: number;
	// encode() throws synchronously for the input at this index
	rejectedInputIndex?: number;
	// Encoding the input at this index fails the encoder
	failingInputIndex?: number;
	// isConfigSupported() reports every config as unsupported
	unsupported?: boolean;
	// The encoder emits its decoder config again after each flush
	configAfterFlush?: boolean;
	// The output for the input at this index comes with a different decoder config
	changedConfigIndex?: number;
	// The audio encoder's timestamps keep counting across flushes
	continuousTimestamps?: boolean;
};

let mockOptions: MockOptions = {};
const mockInstances: MockEncoder<VideoFrame | AudioData>[] = [];

const createMockedEncoder = (
	type: EncoderType,
	options: MockOptions = {},
	config: Record<string, unknown> = {},
) => {
	mockOptions = options;
	mockInstances.length = 0;
	vi.stubGlobal(type.globalName, type.getMockClass());

	const encoder = type.createEncoder(config);

	const mock = new Proxy({} as MockEncoder<VideoFrame | AudioData>, {
		get: (_, key) => {
			const instance = mockInstances[0];
			assert(instance);

			const value: unknown = Reflect.get(instance, key);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
		},
	});

	return { encoder, mock };
};

type MockControlMessage<Input> =
	| { input: Input; keyFrame: boolean }
	| { flush: ReturnType<typeof promiseWithResolvers<void>> };

abstract class MockEncoder<
	Input extends VideoFrame | AudioData,
	Chunk extends EncodedVideoChunk | EncodedAudioChunk = EncodedVideoChunk | EncodedAudioChunk,
> extends EventTarget {
	static isConfigSupported(config: VideoEncoderConfig | AudioEncoderConfig) {
		return Promise.resolve({ supported: !mockOptions.unsupported, config });
	}

	state: CodecState = 'unconfigured';
	encodeQueueSize = 0;
	ondequeue: ((event: Event) => unknown) | null = null;
	paused = mockOptions.paused ?? false;
	inputs: { timestamp: number; keyFrame: boolean }[] = [];
	outputs: Chunk[] = [];
	configs: (VideoEncoderConfig | AudioEncoderConfig)[] = [];
	flushCount = 0;
	controlQueue: MockControlMessage<Input>[] = [];
	configPending = false;
	processingScheduled = false;

	constructor(public init: {
		output(chunk: Chunk, meta?: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata): void;
		error(error: DOMException): void;
	}) {
		super();
		mockInstances.push(this);
	}

	abstract copyInput(input: Input): Input;
	abstract createChunk(input: Input, keyFrame: boolean): Chunk;
	abstract createDecoderConfig(changed: boolean): VideoDecoderConfig | AudioDecoderConfig;

	configure(config: VideoEncoderConfig | AudioEncoderConfig) {
		if (this.state === 'closed') {
			throw new DOMException('Cannot configure a closed codec.', 'InvalidStateError');
		}
		if (this.configs.length === mockOptions.rejectedConfigIndex) {
			throw new TypeError('Invalid configuration.');
		}

		this.configs.push(config);
		this.state = 'configured';
		this.configPending = true;
	}

	encode(input: Input, options?: VideoEncoderEncodeOptions) {
		if (this.state !== 'configured') {
			throw new DOMException('Cannot encode with an unconfigured codec.', 'InvalidStateError');
		}
		if (this.inputs.length === mockOptions.rejectedInputIndex) {
			throw new TypeError('Malformed input.');
		}

		const keyFrame = options?.keyFrame ?? false;
		this.inputs.push({ timestamp: input.timestamp, keyFrame });
		this.encodeQueueSize++;
		this.controlQueue.push({ input: this.copyInput(input), keyFrame });
		this.scheduleProcessing();
	}

	flush() {
		if (this.state !== 'configured') {
			return Promise.reject(new DOMException('Cannot flush an unconfigured codec.', 'InvalidStateError'));
		}

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
		this.encodeQueueSize = 0;

		for (const message of this.controlQueue) {
			if ('flush' in message) {
				message.flush.reject(error);
			} else {
				message.input.close();
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
				if (mockOptions.configAfterFlush) {
					this.configPending = true;
				}

				message.flush.resolve();
				continue;
			}

			this.encodeQueueSize--;
			const dequeueEvent = new Event('dequeue');
			this.dispatchEvent(dequeueEvent);
			this.ondequeue?.(dequeueEvent);

			// The event's listeners may have closed the encoder
			if (this.state !== 'configured') {
				message.input.close();
				return;
			}

			const index = this.outputs.length;
			if (index === mockOptions.failingInputIndex) {
				message.input.close();
				this.fail(new DOMException('Encoding failed.', 'EncodingError'));
				return;
			}

			const chunk = this.createChunk(message.input, message.keyFrame);
			message.input.close();

			let meta: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata | undefined;
			const configChanged = index === mockOptions.changedConfigIndex;
			if (this.configPending || configChanged) {
				this.configPending = false;
				meta = { decoderConfig: this.createDecoderConfig(configChanged) };
			}

			this.outputs.push(chunk);
			this.init.output(chunk, meta);
		}
	}
}

class MockVideoEncoder extends MockEncoder<VideoFrame> implements VideoEncoder {
	copyInput(frame: VideoFrame) {
		return frame.clone();
	}

	createChunk(frame: VideoFrame, keyFrame: boolean) {
		return new EncodedVideoChunk({
			type: keyFrame ? 'key' : 'delta',
			timestamp: frame.timestamp,
			duration: frame.duration ?? undefined,
			data: new Uint8Array([0x92]),
		});
	}

	createDecoderConfig(changed: boolean): VideoDecoderConfig {
		const config = last(this.configs) as VideoEncoderConfig;

		return {
			codec: 'vp8',
			codedWidth: config.width,
			codedHeight: config.height,
			...(changed
				? {
						colorSpace: {
							primaries: 'bt709',
							transfer: 'bt709',
							matrix: 'bt709',
							fullRange: false,
						},
					}
				: {}),
		};
	}
}

class MockAudioEncoder extends MockEncoder<AudioData> implements AudioEncoder {
	nextTimestamp: number | null = null;

	copyInput(audioData: AudioData) {
		return audioData.clone();
	}

	createChunk(audioData: AudioData) {
		const data = new Float32Array(audioData.numberOfChannels * audioData.numberOfFrames);
		audioData.copyTo(data, { planeIndex: 0, format: 'f32' });

		let timestamp = audioData.timestamp;
		if (mockOptions.continuousTimestamps) {
			timestamp = this.nextTimestamp ?? timestamp;
			this.nextTimestamp = timestamp + audioData.duration;
		}

		return new EncodedAudioChunk({
			type: 'key',
			timestamp,
			duration: audioData.duration,
			data,
		});
	}

	createDecoderConfig(changed: boolean): AudioDecoderConfig {
		const config = last(this.configs) as AudioEncoderConfig;

		return {
			codec: config.codec,
			sampleRate: config.sampleRate,
			numberOfChannels: changed ? 1 : config.numberOfChannels,
		};
	}
}

class MockAudioDecoder {
	state: CodecState = 'unconfigured';
	config: AudioDecoderConfig | null = null;
	chunks: EncodedAudioChunk[] = [];

	constructor(public init: { output(output: AudioData): void; error(error: DOMException): void }) {}

	configure(config: AudioDecoderConfig) {
		this.config = config;
		this.state = 'configured';
	}

	decode(chunk: EncodedAudioChunk) {
		this.chunks.push(chunk);
	}

	flush() {
		assert(this.config);

		for (const chunk of this.chunks) {
			const data = new Float32Array(chunk.byteLength / 4);
			chunk.copyTo(data);

			this.init.output(new AudioData({
				format: 'f32',
				sampleRate: this.config.sampleRate,
				numberOfChannels: this.config.numberOfChannels,
				numberOfFrames: data.length / this.config.numberOfChannels,
				timestamp: chunk.timestamp,
				data,
			}));
		}
		this.chunks.length = 0;

		return Promise.resolve();
	}

	close() {
		this.state = 'closed';
	}
}

test('Video custom encoder', () => testCustomEncoder(VIDEO));
test('Audio custom encoder', () => testCustomEncoder(AUDIO));

const testCustomEncoder = async (type: EncoderType) => {
	customEncodersEnabled = true;
	const encoder = type.createEncoder();

	for (let i = 0; i < 3; i++) {
		void pushSample(encoder, type, i);
	}
	void encoder.push(null);
	void pushSample(encoder, type, 3);
	void encoder.end();

	const results = await pullCount(encoder, 6);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		expect.closeTo(type.sampleDuration, 10),
		expect.closeTo(2 * type.sampleDuration, 10),
		null,
		expect.closeTo(3 * type.sampleDuration, 10),
		null,
	]);

	const decoderConfig = results[0]!.decoderConfig;
	assert(decoderConfig);
	expect(results.every(x => !x || x.decoderConfig === decoderConfig)).toBe(true);

	await tick();
	expect(customCalls).toEqual(['init', 'encode', 'encode', 'encode', 'flush', 'encode', 'flush', 'close']);
};

test('Video custom encoder close', () => testCustomEncoderClose(VIDEO));
test('Audio custom encoder close', () => testCustomEncoderClose(AUDIO));

const testCustomEncoderClose = async (type: EncoderType) => {
	customEncodersEnabled = true;
	const pendingEncodes: (() => void)[] = [];
	customHooks = {
		encode: (emit) => {
			const { promise, resolve } = promiseWithResolvers();
			pendingEncodes.push(() => {
				emit();
				resolve();
			});

			return promise;
		},
	};
	const encoder = type.createEncoder();

	void pushSample(encoder, type, 0);
	while (pendingEncodes.length === 0) {
		await tick();
	}

	encoder.close();
	expect(encoder.pullable).toBe(false);

	pendingEncodes.shift()!();
	await encoder._releasePromise;
	expect(customCalls).toEqual(['init', 'encode', 'close']);
	expect(encoder._results.length).toBe(0);
};

test('Video custom encoder backpressure', () => testCustomEncoderBackpressure(VIDEO));
test('Audio custom encoder backpressure', () => testCustomEncoderBackpressure(AUDIO));

const testCustomEncoderBackpressure = async (type: EncoderType) => {
	customEncodersEnabled = true;
	const pendingEncodes: (() => void)[] = [];
	customHooks = {
		encode: (emit) => {
			const { promise, resolve } = promiseWithResolvers();
			pendingEncodes.push(() => {
				emit();
				resolve();
			});

			return promise;
		},
	};
	const encoder = type.createEncoder();

	for (let i = 0; i < 3; i++) {
		expect(pushSample(encoder, type, i)).toBe(null);
	}
	const backpressure = pushSample(encoder, type, 3);
	assert(backpressure);
	const released = trackSettlement(backpressure);

	await tick();
	expect(encoder._getEncoderQueueSize()).toBe(4);
	expect(customCalls.filter(x => x === 'encode').length).toBe(1);

	pendingEncodes.shift()!();
	await tick();
	expect(released.settled).toBe(false);

	await encoder.pull();
	await tick();
	expect(released.settled).toBe(true);

	encoder.close();
	while (pendingEncodes.length > 0) {
		pendingEncodes.shift()!();
		await tick();
	}
};

const VIDEO_DECODER_CONFIG = {
	type: 'video' as const,
	codec: 'vp8',
	codedWidth: 2,
	codedHeight: 2,
};
const AUDIO_DECODER_CONFIG = {
	type: 'audio' as const,
	codec: 'opus',
	sampleRate: AUDIO_SAMPLE_RATE,
	numberOfChannels: AUDIO_CHANNELS,
};

test('Video custom encoder errors', () => testCustomEncoderErrors(VIDEO));
test('Audio custom encoder errors', () => testCustomEncoderErrors(AUDIO));

const testCustomEncoderErrors = async (type: EncoderType) => {
	await expectCustomEncoderFailure(type, {
		init: () => {
			throw new Error('Init failed.');
		},
	}, 'Init failed.');
	await expectCustomEncoderFailure(type, {
		encode: () => {
			throw new Error('Encode failed.');
		},
	}, 'Encode failed.');
	await expectCustomEncoderFailure(type, {
		encode: (_, encoder) => encoder.onError(new Error('Out-of-band failure.')),
	}, 'Out-of-band failure.');
	await expectCustomEncoderFailure(type, {
		encode: (_, encoder) => encoder.onPacket({} as never),
	}, 'The first argument passed to onPacket must be an EncodedPacket.');
	await expectCustomEncoderFailure(type, {
		encode: (_, encoder) => encoder.onPacket(createCustomPacket(0, null), null as never),
	}, 'The second argument passed to onPacket must be an object or undefined.');
	await expectCustomEncoderFailure(type, {
		encode: (_, encoder) => encoder.onPacket(createCustomPacket(0, null)),
	}, 'The first packet emitted by an encoder must come with a decoder config.');
	await expectCustomEncoderFailure(type, {
		encode: (_, encoder) => encoder.onPacket(createCustomPacket(
			0,
			type === VIDEO ? AUDIO_DECODER_CONFIG : VIDEO_DECODER_CONFIG,
		)),
	}, /^The packet passed to onPacket must not have an? (audio|video) decoder config\.$/);
	await expectCustomEncoderFailure(type, {
		flush: () => {
			throw new Error('Flush failed.');
		},
	}, 'Flush failed.');
};

const expectCustomEncoderFailure = async (type: EncoderType, hooks: CustomHooks, error: string | RegExp) => {
	customEncodersEnabled = true;
	customHooks = hooks;
	const encoder = type.createEncoder();

	void pushSample(encoder, type, 0);
	void encoder.push(null);
	await expect(pullUntilNull(encoder)).rejects.toThrow(error);
	expect(encoder.pushable).toBe(false);
	expect(encoder.pullable).toBe(false);

	customCalls.length = 0;
};

test('Video custom encoder in-band decoder config', () => testCustomEncoderInBandDecoderConfig(VIDEO));
test('Audio custom encoder in-band decoder config', () => testCustomEncoderInBandDecoderConfig(AUDIO));

const testCustomEncoderInBandDecoderConfig = async (type: EncoderType) => {
	customEncodersEnabled = true;
	const decoderConfig = type === VIDEO ? VIDEO_DECODER_CONFIG : AUDIO_DECODER_CONFIG;
	customHooks = {
		encode: (_, encoder, sample) => encoder.onPacket(createCustomPacket(sample.timestamp, decoderConfig)),
	};
	const encoder = type.createEncoder();

	void pushSample(encoder, type, 0);
	void pushSample(encoder, type, 1);
	void encoder.end();

	const packets = await pullUntilNull(encoder);
	expect(packets.length).toBe(2);
	expect(packets.every(x => x.decoderConfig === decoderConfig)).toBe(true);
};

const createCustomPacket = (
	timestamp: number,
	decoderConfig: typeof VIDEO_DECODER_CONFIG | typeof AUDIO_DECODER_CONFIG | null,
) => new EncodedPacket({
	data: new Uint8Array([0x92]),
	type: 'key',
	timestamp,
	duration: 0.02,
	decoderConfig: decoderConfig ?? undefined,
});

type CustomHooks = {
	init?: () => MaybePromise<void>;
	encode?: (
		emit: () => void,
		encoder: TestCustomVideoEncoder | TestCustomAudioEncoder,
		sample: AnySample,
	) => MaybePromise<unknown>;
	flush?: () => MaybePromise<void>;
};

let customEncodersEnabled = false;
let customHooks: CustomHooks = {};
const customCalls: string[] = [];

class TestCustomVideoEncoder extends CustomVideoEncoder {
	emittedPackets = 0;

	static override supports(codec: VideoCodec) {
		return customEncodersEnabled && codec === 'vp8';
	}

	init() {
		customCalls.push('init');
		return customHooks.init?.();
	}

	async encode(sample: VideoSample, options: VideoEncoderEncodeOptions) {
		customCalls.push('encode');
		const emit = () => {
			const packet = new EncodedPacket({
				data: new Uint8Array([0x92]),
				type: options.keyFrame ? 'key' : 'delta',
				timestamp: sample.timestamp,
				duration: sample.duration,
			});
			const meta = { decoderConfig: { codec: 'vp8', codedWidth: 2, codedHeight: 2 } };
			this.onPacket(packet, this.emittedPackets++ === 0 ? meta : undefined);
		};

		if (customHooks.encode) {
			await customHooks.encode(emit, this, sample);
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

class TestCustomAudioEncoder extends CustomAudioEncoder {
	emittedPackets = 0;

	static override supports(codec: AudioCodec) {
		return customEncodersEnabled && codec === 'opus';
	}

	init() {
		customCalls.push('init');
		return customHooks.init?.();
	}

	async encode(sample: AudioSample) {
		customCalls.push('encode');
		const emit = () => {
			const packet = new EncodedPacket({
				data: new Uint8Array(8),
				type: 'key',
				timestamp: sample.timestamp,
				duration: sample.duration,
			});
			const meta = {
				decoderConfig: {
					codec: 'opus',
					sampleRate: AUDIO_SAMPLE_RATE,
					numberOfChannels: AUDIO_CHANNELS,
				},
			};
			this.onPacket(packet, this.emittedPackets++ === 0 ? meta : undefined);
		};

		if (customHooks.encode) {
			await customHooks.encode(emit, this, sample);
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

registerEncoder(TestCustomVideoEncoder);
registerEncoder(TestCustomAudioEncoder);

test('Video key frames', async () => {
	const { encoder, mock } = createMockedEncoder(VIDEO, {}, { keyFrameInterval: 0.1 });

	for (let i = 0; i < 4; i++) {
		void pushSample(encoder, VIDEO, i);
	}
	using sample = VIDEO.createSample(4);
	void encoder.push(sample, { keyFrame: false });

	void encoder.push(null);
	void pushSample(encoder, VIDEO, 5);
	using keySample = VIDEO.createSample(6);
	void encoder.push(keySample, { keyFrame: true });
	void encoder.end();

	await pullUntilNull(encoder);
	await pullUntilNull(encoder);
	expect(mock.inputs.map(x => x.keyFrame)).toEqual([true, false, false, true, false, true, true]);
});

test('Video frame rate normalization', async () => {
	const { encoder, mock } = createMockedEncoder(VIDEO, {}, { transform: { frameRate: 10 } });

	using first = new VideoSample(new Uint8Array(16), {
		format: 'RGBA',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
		duration: 0.2,
	});
	using second = new VideoSample(new Uint8Array(16), {
		format: 'RGBA',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0.2,
		duration: 0.3,
	});
	void encoder.push(first);
	void encoder.push(second);
	void encoder.end();

	const packets = await pullUntilNull(encoder);
	expectTimestamps(packets, [0, 0.1, 0.2, 0.3, 0.4]);
	expect(mock.inputs.length).toBe(5);

	expect(second.timestamp).toBe(0.2);
	expect(second.duration).toBe(0.3);
});

test('Video frame rate normalization during close', async () => {
	// During padding
	const first = createMockedEncoder(VIDEO, { paused: true }, {
		transform: { frameRate: 1 / VIDEO_SAMPLE_DURATION },
	});

	for (const index of [0, 1, 2, 3, 5]) {
		void pushSample(first.encoder, VIDEO, index);
	}
	while (!first.encoder._room) {
		await tick();
	}

	first.encoder.close();
	await tick();
	expect((first.encoder as unknown as VideoSampleEncoder)._frameRateLastSample).toBe(null);

	// During a transform
	const second = createMockedEncoder(VIDEO, {}, {
		transform: { frameRate: 1 / VIDEO_SAMPLE_DURATION, width: 4 },
	});

	void pushSample(second.encoder, VIDEO, 0);
	second.encoder.close();
	while (second.encoder._processing) {
		await tick();
	}
	expect((second.encoder as unknown as VideoSampleEncoder)._frameRateLastSample).toBe(null);
});

test('Video alpha', async () => {
	const { encoder } = createMockedEncoder(VIDEO, {}, { alpha: 'keep' });

	void pushSample(encoder, VIDEO, 0);
	void pushSample(encoder, VIDEO, 1);
	void encoder.end();
	const packets = await pullUntilNull(encoder);

	expect(mockInstances.length).toBe(2);
	expect(mockInstances[1]!.inputs.map(x => x.keyFrame)).toEqual([true, false]);
	expect(packets.length).toBe(2);
	expect(packets.every(x => x.sideData.alpha instanceof Uint8Array)).toBe(true);
	expect(mockInstances.every(x => x.state === 'closed')).toBe(true);
});

test('Audio PCM encoding', async () => {
	const encoder = new AudioSampleEncoder({ codec: 'pcm-s16' });

	const createPcmSample = (timestamp: number, numberOfChannels: number) => new AudioSample({
		format: 'f32',
		data: new Float32Array(numberOfChannels * 1500).fill(0.5),
		numberOfChannels,
		sampleRate: AUDIO_SAMPLE_RATE,
		timestamp,
	});

	for (let i = 0; i < 2; i++) {
		using sample = createPcmSample(1500 / AUDIO_SAMPLE_RATE * i, 2);
		void encoder.push(sample);
	}

	void encoder.push(null);
	using monoSample = createPcmSample(1, 1);
	void encoder.push(monoSample);
	void encoder.end();

	const results = await pullCount(encoder, 5);
	expect(results.map(x => x === null)).toEqual([false, false, true, false, true]);
	const [first, second, , third] = results;
	assert(first && second && third);

	expect(first.byteLength).toBe(2 * 2 * PCM_ENCODER_PACKET_SIZE);
	expect(second.byteLength).toBe(2 * 2 * (3000 - PCM_ENCODER_PACKET_SIZE));
	expect(second.timestamp).toBeCloseTo(PCM_ENCODER_PACKET_SIZE / AUDIO_SAMPLE_RATE, 10);
	expect(new DataView(first.data.buffer).getInt16(0, true)).toBe(16384);

	expect(second.decoderConfig).toBe(first.decoderConfig);
	expect(first.decoderConfig).toEqual({
		type: 'audio',
		codec: 'pcm-s16',
		numberOfChannels: 2,
		sampleRate: AUDIO_SAMPLE_RATE,
	});
	expect(third.timestamp).toBe(1);
	expect(third.decoderConfig).toMatchObject({ numberOfChannels: 1 });
});

test('Audio PCM backpressure', async () => {
	const encoder = new AudioSampleEncoder({ codec: 'pcm-s16' });

	using sample = new AudioSample({
		format: 'f32',
		data: new Float32Array(20 * PCM_ENCODER_PACKET_SIZE),
		numberOfChannels: 1,
		sampleRate: AUDIO_SAMPLE_RATE,
		timestamp: 0,
	});
	void encoder.push(sample);
	void encoder.end();
	await tick();
	expect(encoder._results.length).toBe(4);

	for (let i = 0; i < 20; i++) {
		const packet = encoder.pull();
		assert(packet instanceof EncodedPacket);
		expect(packet.timestamp).toBeCloseTo(PCM_ENCODER_PACKET_SIZE * i / AUDIO_SAMPLE_RATE, 10);
		expect(encoder._results.length).toBe(Math.min(4, 19 - i));
	}

	expect(await encoder.pull()).toBe(null);
	expect(encoder.pullable).toBe(false);
});

test('Audio resampling', async () => {
	const { encoder, mock } = createMockedEncoder(AUDIO, {}, { transform: { sampleRate: 24000 } });

	void pushSample(encoder, AUDIO, 0);

	void encoder.push(null);
	const packets = await pullUntilNull(encoder);
	expect(packets.length).toBeGreaterThan(0);
	expect((mock.configs[0] as AudioEncoderConfig).sampleRate).toBe(24000);

	encoder.close();
});

test('Audio timestamps after flush', async () => {
	const { encoder } = createMockedEncoder(AUDIO, { continuousTimestamps: true });

	for (const start of [0, 1, 2]) {
		for (let i = 0; i < 2; i++) {
			using sample = createAudioSample(i, AUDIO_CHANNELS);
			sample.setTimestamp(start + AUDIO_SAMPLE_DURATION * i);
			void encoder.push(sample);
		}
		void encoder.push(null);
	}
	void encoder.end();

	const results = await pullCount(encoder, 10);
	expect(results.map(x => x?.timestamp ?? null)).toEqual([
		0,
		expect.closeTo(AUDIO_SAMPLE_DURATION, 10),
		null,
		expect.closeTo(1, 10),
		expect.closeTo(1 + AUDIO_SAMPLE_DURATION, 10),
		null,
		expect.closeTo(2, 10),
		expect.closeTo(2 + AUDIO_SAMPLE_DURATION, 10),
		null,
		null,
	]);
});

test('Video encoding with WebCodecs', async () => {
	const encoder = new VideoSampleEncoder({ codec: 'vp8', quality: new Quality('medium') });

	const createFrame = (index: number, size: number) => {
		const canvas = new OffscreenCanvas(size, size);
		const context = canvas.getContext('2d')!;
		context.fillStyle = `rgb(${50 * index}, 0, 0)`;
		context.fillRect(0, 0, size, size);

		return new VideoSample(canvas, { timestamp: VIDEO_SAMPLE_DURATION * index, duration: VIDEO_SAMPLE_DURATION });
	};

	for (let i = 0; i < 3; i++) {
		using sample = createFrame(i, 64);
		void encoder.push(sample);
	}
	void encoder.push(null);
	for (let i = 3; i < 5; i++) {
		using sample = createFrame(i, 32);
		void encoder.push(sample);
	}
	void encoder.end();

	const results = await pullCount(encoder as unknown as AnySampleEncoder, 7);
	expect(results.map(x => x?.type ?? null)).toEqual(['key', 'delta', 'delta', null, 'key', 'delta', null]);
	const packets = results.filter(x => x !== null);
	expectTimestamps(packets, [0, 1, 2, 3, 4].map(i => VIDEO_SAMPLE_DURATION * i));
	expect(packets[0]!.decoderConfig).toMatchObject({ type: 'video', codec: 'vp8', codedWidth: 64 });
	expect(packets[3]!.decoderConfig).toMatchObject({ codedWidth: 32 });

	const decoder = new VideoPacketDecoder();
	for (const packet of packets) {
		void decoder.push(packet);
	}
	void decoder.end();

	const samples: VideoSample[] = [];
	while (true) {
		const sample = await decoder.pull();
		if (!sample) {
			break;
		}

		samples.push(sample);
	}
	expect(samples.map(x => x.codedWidth)).toEqual([64, 64, 64, 32, 32]);
	samples.forEach(x => x.close());
});

test('Audio encoding with WebCodecs', async () => {
	const encoder = new AudioSampleEncoder({ codec: 'opus', quality: new Quality('medium') });

	for (const start of [0, 1]) {
		for (let i = 0; i < 3; i++) {
			using sample = createAudioSample(i, AUDIO_CHANNELS);
			sample.setTimestamp(start + AUDIO_SAMPLE_DURATION * i);
			void encoder.push(sample);
		}
		void encoder.push(null);
	}
	void encoder.end();

	const first = await pullUntilNull(encoder as unknown as AnySampleEncoder);
	const second = await pullUntilNull(encoder as unknown as AnySampleEncoder);
	expect(await encoder.pull()).toBe(null);
	expect(encoder.pullable).toBe(false);

	const decoderConfig = first[0]!.decoderConfig;
	assert(decoderConfig);
	expect([...first, ...second].every(x => x.decoderConfig === decoderConfig)).toBe(true);
	const preSkip = first[0]!.timestamp;
	expect(preSkip).toBeLessThanOrEqual(0);
	expect(second[0]!.timestamp).toBeCloseTo(1 + preSkip, 10);
	expect(second.length).toBe(first.length);
});

const pullUntilNull = async (encoder: AnySampleEncoder) => {
	const packets: EncodedPacket[] = [];
	while (true) {
		const packet = await encoder.pull();
		if (!packet) {
			return packets;
		}

		packets.push(packet);
	}
};
