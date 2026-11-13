import { expect, test, vi } from 'vitest';
import { Output } from '../../src/output.js';
import { BufferTarget, StreamTarget, StreamTargetChunk, Target } from '../../src/target.js';
import { MkvOutputFormat, Mp4OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import {
	AudioSampleSource,
	EncodedAudioPacketSource,
	EncodedVideoPacketSource,
	MediaStreamVideoTrackSource,
	VideoSampleSource,
} from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { CustomAudioEncoder, CustomVideoEncoder, registerEncoder } from '../../src/custom-coder.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { Quality } from '../../src/encode.js';
import { assert, toDataView, wait } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const AAC_META = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 1,
		sampleRate: 48000,
		description: new Uint8Array([0x11, 0x88]),
	},
};

type TestEncoderBehavior = {
	init?: () => void;
	encode?: (encoder: TestVideoEncoder, sample: VideoSample, options: VideoEncoderEncodeOptions) => void;
	flush?: (encoder: TestVideoEncoder) => void;
};

let testEncoderBehavior: TestEncoderBehavior = {};
const testEncoderEvents: string[] = [];

class TestVideoEncoder extends CustomVideoEncoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp9';
	}

	init() {
		testEncoderBehavior.init?.();
	}

	encode(sample: VideoSample, options: VideoEncoderEncodeOptions) {
		testEncoderEvents.push('encode');
		testEncoderBehavior.encode?.(this, sample, options);
	}

	flush() {
		testEncoderEvents.push('flush');
		testEncoderBehavior.flush?.(this);
	}

	close() {
		testEncoderEvents.push('close');
	}
}

registerEncoder(TestVideoEncoder);

let activeAudioEncoder: typeof TestAudioEncoder | null = null;

class TestAudioEncoder extends CustomAudioEncoder {
	static override supports(codec: AudioCodec) {
		return codec === 'aac' && activeAudioEncoder === this;
	}

	init(): Promise<void> | void {}

	encode(sample: AudioSample) {
		this.onPacket(
			new EncodedPacket(new Uint8Array(16), 'key', sample.timestamp, sample.duration),
			AAC_META,
		);
	}

	flush() {}

	close() {}
}

test('Muxer error when closing a source', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'reserve' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addVideoTrack(videoSource, { maximumPacketCount: 1 });
	output.addAudioTrack(audioSource, { maximumPacketCount: 1 });

	await output.start();

	// The audio track isn't known yet, so the muxer holds on to these instead of writing them
	const videoMeta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	await videoSource.add(new EncodedPacket(new Uint8Array(8), 'key', 0, 0.1), videoMeta);
	await videoSource.add(new EncodedPacket(new Uint8Array(8), 'delta', 0.1, 0.1));

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		// Now all tracks are known, so the muxer writes the held packets, exceeding the maximum packet count
		audioSource.close();
		await new Promise(resolve => setTimeout(resolve, 10));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
	await expect(output.finalize()).rejects.toThrow('maximum packet count');
});

test('Custom encoder failing to encode', async () => {
	useTestEncoder({
		encode: () => {
			throw new Error('Encoding failed.');
		},
	});

	const { output, source } = await startVideoOutput(new BufferTarget());
	await addSample(source, 0);

	await expect(output.finalize()).rejects.toThrow('Encoding failed.');
	expect(testEncoderEvents).toEqual(['encode', 'close']);
});

test('Custom encoder failing to initialize', async () => {
	useTestEncoder({
		init: () => {
			throw new Error('Initialization failed.');
		},
	});

	const { output, source } = await startVideoOutput(new BufferTarget());
	const addAssertion = expect(addSample(source, 0)).rejects.toThrow('Initialization failed.');

	await expect(output.finalize()).rejects.toThrow('Initialization failed.');
	await addAssertion;
});

test('Key frame request for a negative first timestamp', async () => {
	const keyFrameFlags: (boolean | undefined)[] = [];
	useTestEncoder({
		encode: (encoder, sample, options) => {
			keyFrameFlags.push(options.keyFrame);
		},
	});

	const { output, source } = await startVideoOutput(new BufferTarget());
	await addSample(source, -1);
	await addSample(source, -0.5);
	await output.cancel();

	expect(keyFrameFlags).toEqual([true, false]);
});

test('Muxer error for a packet emitted during the encoder flush', async () => {
	useTestEncoder({
		flush: (encoder) => {
			const decoderConfig = { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 };
			encoder.onPacket(new EncodedPacket(new Uint8Array(8), 'key', 0, 0.3), { decoderConfig });
			encoder.onPacket(new EncodedPacket(new Uint8Array(8), 'delta', 0.3, 0.3));
			// Completes the first chunk, making the muxer wait for the slow target
			encoder.onPacket(new EncodedPacket(new Uint8Array(8), 'key', 0.6, 0.3));
			// Invalid since it lies before the end of the previous GOP
			encoder.onPacket(new EncodedPacket(new Uint8Array(8), 'delta', 0.1, 0.3));
		},
	});

	const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
		write: () => new Promise(resolve => setTimeout(resolve, 50)),
	}));
	const { output, source } = await startVideoOutput(target);
	await addSample(source, 0);

	await expect(output.finalize()).rejects.toThrow('Timestamps cannot be smaller');
});

test('Frame rate normalization with overlapping adds', async () => {
	const timestamps: number[] = [];
	useTestEncoder({
		encode: (encoder, sample) => {
			timestamps.push(Math.round(10 * sample.timestamp));
		},
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('medium'),
		transform: { frameRate: 10 },
	});
	output.addVideoTrack(source);
	await output.start();

	// Like MediaStreamVideoTrackSource, we don't wait for an add to finish before starting the next one, or finalizing
	const addPromise = Promise.all([0, 0.35, 0.45, 0.75].map(timestamp => addSample(source, timestamp)));
	await output.finalize();
	await addPromise;

	expect(timestamps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

const useTestEncoder = (behavior: TestEncoderBehavior) => {
	testEncoderBehavior = behavior;
	testEncoderEvents.length = 0;
};

const startVideoOutput = async (target: Target) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target,
	});

	const source = new VideoSampleSource({
		codec: 'vp9',
		quality: new Quality('medium'),
	});
	output.addVideoTrack(source);

	await output.start();

	return { output, source };
};

const addSample = async (source: VideoSampleSource, timestamp: number) => {
	using sample = new VideoSample(new Uint8Array(4 * 64 * 64), {
		format: 'RGBA',
		codedWidth: 64,
		codedHeight: 64,
		timestamp,
		duration: 0.5,
	});

	await source.add(sample);
};

test('Custom encoder close after an encode error', async () => {
	const events: string[] = [];

	useAudioEncoder(class extends TestAudioEncoder {
		override encode(sample: AudioSample) {
			events.push('encode');
			if (sample.timestamp > 0) {
				throw new Error('Encode failed');
			}
		}

		override close() {
			events.push('close');
		}
	});

	const { output, source } = await startAudioOutput();

	await source.add(makeAudioSample(0));
	await source.add(makeAudioSample(0.1));
	await wait(10);

	await expect(source.add(makeAudioSample(0.2))).rejects.toThrow('Encode failed');
	await output.cancel();

	expect(events).toEqual(['encode', 'encode', 'close']);
});

test('Custom encoder close after its first encode fails', async () => {
	const events: string[] = [];

	useAudioEncoder(class extends TestAudioEncoder {
		override encode() {
			events.push('encode');
			throw new Error('Encode failed');
		}

		override close() {
			events.push('close');
		}
	});

	const { output, source } = await startAudioOutput();
	await source.add(makeAudioSample(0));

	await expect(output.finalize()).rejects.toThrow('Encode failed');
	expect(events).toEqual(['encode', 'close']);
});

test('Custom encoder close after a flush error', async () => {
	const events: string[] = [];

	useAudioEncoder(class extends TestAudioEncoder {
		override encode() {
			events.push('encode');
		}

		override flush() {
			events.push('flush');
			throw new Error('Flush failed');
		}

		override close() {
			events.push('close');
		}
	});

	const { output, source } = await startAudioOutput();
	await source.add(makeAudioSample(0));

	await expect(output.finalize()).rejects.toThrow('Flush failed');
	expect(events).toEqual(['encode', 'flush', 'close']);
});

test('Custom audio encoder failing to initialize', async () => {
	useAudioEncoder(class extends TestAudioEncoder {
		override init() {
			throw new Error('Initialization failed.');
		}
	});

	const { output, source } = await startAudioOutput();
	const addAssertion = expect(source.add(makeAudioSample(0))).rejects.toThrow('Initialization failed.');

	await expect(output.finalize()).rejects.toThrow('Initialization failed.');
	await addAssertion;
});

test('Custom encoder init pending during cancel', async () => {
	const events = useSlowInitAudioEncoder();
	const { output, source } = await startAudioOutput();

	const addPromise = source.add(makeAudioSample(0));
	await output.cancel();
	await addPromise;

	expect(events[0]).toBe('init');
	expect(events.at(-1)).toBe('close');
});

test('Custom encoder init pending during finalize', async () => {
	const events = useSlowInitAudioEncoder();
	const { output, source } = await startAudioOutput();

	const addPromise = source.add(makeAudioSample(0));
	await output.finalize();
	await addPromise;

	expect(events).toEqual(['init', 'encode', 'flush', 'close']);
});

const useSlowInitAudioEncoder = () => {
	const events: string[] = [];

	useAudioEncoder(class extends TestAudioEncoder {
		override async init() {
			await wait(50);
			events.push('init');
		}

		override encode(sample: AudioSample) {
			events.push('encode');
			super.encode(sample);
		}

		override flush() {
			events.push('flush');
		}

		override close() {
			events.push('close');
		}
	});

	return events;
};

test('Process function returning its input sample', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({
		codec: 'pcm-s16',
		transform: { process: sample => sample },
	});
	output.addAudioTrack(source);
	await output.start();

	using sample = makeAudioSample(0);
	await source.add(sample);

	// The sample still belongs to us, so it must not have been closed
	expect(() => sample.clone().close()).not.toThrow();

	await output.finalize();
});

test('Muxer error for a packet emitted by the final flush', async () => {
	useAudioEncoder(class extends TestAudioEncoder {
		override flush() {
			// The first packet keeps the muxer busy with the slow target while the second one is still queued up
			this.onPacket(new EncodedPacket(new Uint8Array(16), 'key', 0.1, 0.1), AAC_META);
			this.onPacket(new EncodedPacket(new Uint8Array(16), 'key', -1, 0.1), AAC_META);
		}
	});

	const { output, source } = await startAudioOutput(new StreamTarget(new WritableStream({
		write: async () => {
			await wait(30);
		},
	})));
	await source.add(makeAudioSample(0));

	await expect(output.finalize()).rejects.toThrow('Timestamps cannot be smaller');
});

const useAudioEncoder = (encoder: typeof TestAudioEncoder) => {
	activeAudioEncoder = encoder;
	registerEncoder(encoder);
};

const startAudioOutput = async (target: Target = new BufferTarget()) => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target,
	});
	const source = new AudioSampleSource({
		codec: 'aac',
		quality: new Quality('medium'),
	});
	output.addAudioTrack(source);
	await output.start();

	return { output, source };
};

const makeAudioSample = (timestamp: number) => {
	return new AudioSample({
		data: new Float32Array(4800),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp,
	});
};

test('Non-finite MediaStreamVideoTrackSource frame rate', () => {
	// The options are validated before the track is ever used, so a stand-in track works outside the browser too
	vi.stubGlobal('MediaStreamTrack', class {});

	try {
		const track = Object.assign(Object.create(MediaStreamTrack.prototype) as object, { kind: 'video' });
		const createSource = (frameRate: number) => new MediaStreamVideoTrackSource(
			track as MediaStreamVideoTrack,
			{ codec: 'vp8', quality: new Quality('low') },
			{ frameRate },
		);

		expect(() => createSource(Infinity)).toThrow('options.frameRate');
		expect(() => createSource(NaN)).toThrow('options.frameRate');
	} finally {
		vi.unstubAllGlobals();
	}
});

test('Audio with overlapping adds', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();

	const frameCount = 3000;
	const samples = Array.from({ length: 10 }, (_, i) => new AudioSample({
		data: new Float32Array(frameCount).fill((i + 1) / 16),
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: i * frameCount / 48000,
	}));

	// Not waiting for an add to finish before starting the next one is perfectly valid
	await Promise.all(samples.map(sample => source.add(sample)));
	await output.finalize();
	samples.forEach(sample => sample.close());

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const values: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		const view = toDataView(packet.data);
		for (let i = 0; i < packet.data.byteLength; i += 2) {
			values.push(view.getInt16(i, true));
		}
	}

	// Each sample's frames must come out whole and in order, without mixing with other samples' frames
	expect(values).toHaveLength(10 * frameCount);
	for (let i = 0; i < 10; i++) {
		const sampleValues = new Set(values.slice(i * frameCount, (i + 1) * frameCount));
		expect(sampleValues.size).toBe(1);
		expect([...sampleValues][0]).toBeGreaterThan(values[i * frameCount - 1] ?? -Infinity);
	}
});

test('Add while the source is closing', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	// The source is still flushing, but no more data must come in
	source.close();
	expect(() => source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.1), AAC_META))
		.toThrow('Source is closed.');

	await output.finalize();
});
