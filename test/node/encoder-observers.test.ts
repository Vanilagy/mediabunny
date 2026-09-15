import { afterEach, describe, expect, test, vi } from 'vitest';
import { Quality, validateAudioEncodingConfig, validateVideoEncodingConfig } from '../../src/encode.js';
import { AudioSampleSource, ColorAlphaSplitter, VideoSampleSource } from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('encoder observer validation', () => {
	test.each([
		['onEncoderError', 123],
		['onEncoderSupport', {}],
	] as const)('rejects a non-function video %s callback', (key, value) => {
		expect(() => validateVideoEncodingConfig({
			codec: 'vp8',
			quality: new Quality('medium'),
			[key]: value,
		})).toThrow(`config.${key}, when provided, must be a function.`);
	});

	test.each([
		['onEncoderError', 123],
		['onEncoderSupport', {}],
	] as const)('rejects a non-function audio %s callback', (key, value) => {
		expect(() => validateAudioEncodingConfig({
			codec: 'opus',
			quality: new Quality('medium'),
			[key]: value,
		})).toThrow(`config.${key}, when provided, must be a function.`);
	});
});

describe('video encoder observers', () => {
	test('reports support query lifecycle with detached config snapshots', async () => {
		const nativeConfigs: VideoEncoderConfig[] = [];
		const events: { config: Readonly<VideoEncoderConfig>; status: string }[] = [];
		installVideoEncoder({
			isConfigSupported: async (config) => {
				nativeConfigs.push(config);
				return { supported: true, config };
			},
		});

		const source = makeVideoSource({
			codec: 'avc',
			onEncoderSupport: (config, event) => {
				events.push({ config, status: event.status });
				(config as VideoEncoderConfig).width = 999;
				(config.avc as { format: string }).format = 'annexb';
				if (event.status === 'started') {
					throw new Error('observer failed');
				}
			},
		});
		await source.add(makeVideoSample());

		expect(events.map(x => x.status)).toEqual(['started', 'supported']);
		expect(events[0]!.config).not.toBe(events[1]!.config);
		expect(nativeConfigs[0]!.width).toBe(2);
		expect(nativeConfigs[0]!.avc!.format).toBe('avc');
	});

	test('reports the exact unsupported error that is propagated', async () => {
		const events: { status: string; error?: unknown }[] = [];
		installVideoEncoder({ isConfigSupported: async config => ({ supported: false, config }) });

		const source = makeVideoSource({
			onEncoderSupport: (_config, event) => events.push(event),
		});
		const error = await source.add(makeVideoSample()).catch((caught: unknown) => caught);

		expect(events.map(x => x.status)).toEqual(['started', 'unsupported']);
		expect(events[1]!.error).toBe(error);
	});

	test('reports support query errors without changing existing fallback behavior', async () => {
		const queryError = new Error('query failed');
		const events: { status: string; error?: unknown }[] = [];
		installVideoEncoder({ isConfigSupported: async () => Promise.reject(queryError) });

		const source = makeVideoSource({
			onEncoderSupport: (_config, event) => events.push(event),
		});
		const error = await source.add(makeVideoSample()).catch((caught: unknown) => caught);

		expect(events.map(x => x.status)).toEqual(['started', 'error']);
		expect(events[1]!.error).toBe(queryError);
		expect(error).not.toBe(queryError);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('not supported');
	});

	test.each(['create', 'configure', 'encode'] as const)(
		'reports %s failures without replacing their identity',
		async (stage) => {
			const nativeError = new Error(`${stage} failed`);
			const observed: [unknown, string][] = [];
			installVideoEncoder({ [stage]: nativeError });

			const source = makeVideoSource({
				onEncoderError: (error, errorStage) => {
					observed.push([error, errorStage]);
					throw new Error('observer failed');
				},
			});
			const error = await source.add(makeVideoSample()).catch((caught: unknown) => caught);

			expect(error).toBe(nativeError);
			expect(observed).toEqual([[nativeError, stage]]);
		},
	);

	test('reports flush failures without replacing their identity', async () => {
		const nativeError = new Error('flush failed');
		const observed: [unknown, string][] = [];
		installVideoEncoder({ flush: nativeError });

		const source = makeVideoSource({
			onEncoderError: (error, stage) => observed.push([error, stage]),
		});
		await source.add(makeVideoSample());
		const error = await source._flushAndClose(false).catch((caught: unknown) => caught);

		expect(error).toBe(nativeError);
		expect(observed).toEqual([[nativeError, 'flush']]);
	});

	test('reports asynchronous encoder errors even when the observer throws', async () => {
		const nativeError = new DOMException('async failure', 'EncodingError');
		const observed: [unknown, string][] = [];
		installVideoEncoder({ asyncError: nativeError });

		const source = makeVideoSource({
			onEncoderError: (error, stage) => {
				observed.push([error, stage]);
				throw new Error('observer failed');
			},
		});
		await source.add(makeVideoSample());
		const error = await source._flushAndClose(false).catch((caught: unknown) => caught);

		expect(error).toBe(nativeError);
		expect(observed).toEqual([[nativeError, 'error']]);
	});

	test.each(['create', 'configure'] as const)('reports %s failures from the alpha encoder', async (stage) => {
		const nativeError = new Error(`alpha ${stage} failed`);
		const observed: [unknown, string][] = [];
		installVideoEncoder({ [`${stage}Call`]: 2, [stage]: nativeError });

		const source = makeVideoSource({
			alpha: 'keep',
			onEncoderError: (error, errorStage) => observed.push([error, errorStage]),
		});
		const error = await source.add(makeVideoSample()).catch((caught: unknown) => caught);

		expect(error).toBe(nativeError);
		expect(observed).toEqual([[nativeError, stage]]);
	});

	test('reports encode failures from the alpha encoder', async () => {
		const nativeError = new Error('alpha encode failed');
		const observed: [unknown, string][] = [];
		const encoderControl = installVideoEncoder({ encode: nativeError, encodeCall: 2 });
		vi.spyOn(ColorAlphaSplitter.prototype, 'split').mockResolvedValue({
			colorFrame: new FakeVideoFrame(new Uint8Array(), { format: 'RGBA', timestamp: 0 } as VideoFrameBufferInit),
			alphaFrame: new FakeVideoFrame(new Uint8Array(), { format: 'RGBA', timestamp: 0 } as VideoFrameBufferInit),
		} as never);

		const source = makeVideoSource({
			alpha: 'keep',
			onEncoderError: (error, stage) => observed.push([error, stage]),
		});
		await source.add(makeVideoSample());

		const error = encoderControl.emitPrimaryOutput().catch((caught: unknown) => caught);
		expect(await error).toBe(nativeError);
		expect(observed).toEqual([[nativeError, 'encode']]);
	});
});

describe('audio encoder observers', () => {
	test('reports support and native operation failures', async () => {
		const encodeError = new Error('audio encode failed');
		const supportEvents: string[] = [];
		const errors: [unknown, string][] = [];
		installAudioEncoder({ encode: encodeError });

		const source = makeAudioSource({
			onEncoderSupport: (_config, event) => supportEvents.push(event.status),
			onEncoderError: (error, stage) => errors.push([error, stage]),
		});
		const error = await source.add(makeAudioSample()).catch((caught: unknown) => caught);

		expect(error).toBe(encodeError);
		expect(supportEvents).toEqual(['started', 'supported']);
		expect(errors).toEqual([[encodeError, 'encode']]);
	});
});

type VideoEncoderBehavior = {
	isConfigSupported?: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;
	create?: Error;
	createCall?: number;
	configure?: Error;
	configureCall?: number;
	encode?: Error;
	encodeCall?: number;
	flush?: Error;
	asyncError?: DOMException;
};

const installVideoEncoder = (behavior: VideoEncoderBehavior) => {
	let createCalls = 0;
	let configureCalls = 0;
	let encodeCalls = 0;
	const encoderInits: VideoEncoderInit[] = [];

	class FakeVideoEncoder {
		static isConfigSupported = behavior.isConfigSupported
			?? (async (config: VideoEncoderConfig) => ({ supported: true, config }));

		state: CodecState = 'unconfigured';
		encodeQueueSize = 0;
		private init: VideoEncoderInit;

		constructor(init: VideoEncoderInit) {
			createCalls++;
			if (behavior.create && createCalls === (behavior.createCall ?? 1)) {
				throw behavior.create;
			}
			this.init = init;
			encoderInits.push(init);
		}

		configure() {
			configureCalls++;
			if (behavior.configure && configureCalls === (behavior.configureCall ?? 1)) {
				throw behavior.configure;
			}
			this.state = 'configured';
		}

		encode() {
			encodeCalls++;
			if (behavior.encode && encodeCalls === (behavior.encodeCall ?? 1)) {
				throw behavior.encode;
			}
			if (behavior.asyncError) {
				this.init.error(behavior.asyncError);
			}
		}

		flush() {
			return behavior.flush ? Promise.reject(behavior.flush) : Promise.resolve();
		}

		close() {
			this.state = 'closed';
		}

		addEventListener() {}
	}

	vi.stubGlobal('VideoEncoder', FakeVideoEncoder);
	vi.stubGlobal('VideoFrame', FakeVideoFrame);

	return {
		emitPrimaryOutput: async () => encoderInits[0]!.output({ type: 'key' } as EncodedVideoChunk, undefined),
	};
};

type AudioEncoderBehavior = {
	encode?: Error;
};

const installAudioEncoder = (behavior: AudioEncoderBehavior) => {
	class FakeAudioEncoder {
		static isConfigSupported = async (config: AudioEncoderConfig): Promise<AudioEncoderSupport> => ({
			supported: true,
			config,
		});

		state: CodecState = 'unconfigured';
		encodeQueueSize = 0;

		constructor() {}

		configure() {
			this.state = 'configured';
		}

		encode() {
			if (behavior.encode) {
				throw behavior.encode;
			}
		}

		flush() {
			return Promise.resolve();
		}

		close() {
			this.state = 'closed';
		}

		addEventListener() {}
	}

	vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
	vi.stubGlobal('AudioData', FakeAudioData);
};

class FakeVideoFrame {
	readonly timestamp: number;
	readonly format: VideoPixelFormat | null;

	constructor(data: AllowSharedBufferSource, init: VideoFrameBufferInit) {
		void data;
		this.timestamp = init.timestamp;
		this.format = init.format;
	}

	close() {}
}

class FakeAudioData {
	constructor() {}
	close() {}
}

const makeVideoSource = (config: Partial<ConstructorParameters<typeof VideoSampleSource>[0]> = {}) => {
	const source = new VideoSampleSource({
		codec: 'vp8',
		bitrate: 1_000_000,
		...config,
	});
	source._connectedTrack = {
		metadata: {},
		output: {
			state: 'started',
			_muxer: { addEncodedVideoPacket: vi.fn(async () => {}) },
		},
	} as never;
	return source;
};

const makeAudioSource = (config: Partial<ConstructorParameters<typeof AudioSampleSource>[0]> = {}) => {
	const source = new AudioSampleSource({
		codec: 'opus',
		bitrate: 128_000,
		...config,
	});
	source._connectedTrack = {
		output: {
			state: 'started',
			_muxer: { addEncodedAudioPacket: vi.fn(async () => {}) },
		},
	} as never;
	return source;
};

const makeVideoSample = () => new VideoSample(new Uint8Array(2 * 2 * 4), {
	format: 'RGBA',
	codedWidth: 2,
	codedHeight: 2,
	timestamp: 0,
	duration: 1 / 30,
});

const makeAudioSample = () => new AudioSample({
	data: new Float32Array(2),
	format: 'f32-planar',
	sampleRate: 48_000,
	numberOfChannels: 1,
	numberOfFrames: 2,
	timestamp: 0,
});
