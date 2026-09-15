import { expect, test } from 'vitest';
import {
	type AudioCodec,
	type AudioEncodingConfig,
	AudioSample,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	canDecode,
	canDecodeAudio,
	canDecodeVideo,
	canEncode,
	canEncodeAudio,
	canEncodeVideo,
	CustomAudioDecoder,
	CustomAudioEncoder,
	type CustomDemuxer,
	CustomInputFormat,
	type CustomMuxer,
	CustomOutputFormat,
	CustomVideoDecoder,
	Conversion,
	CustomVideoEncoder,
	EncodedPacket,
	EncodedVideoPacketSource,
	FilePathSource,
	getAllAudioCodecs,
	getAllVideoCodecs,
	getDecodableVideoCodecs,
	getEncodableVideoCodecs,
	HLS,
	Input,
	Logging,
	Mp4OutputFormat,
	Output,
	QUALITY_MEDIUM,
	registerAudioCodec,
	registerDecoder,
	registerEncoder,
	registerVideoCodec,
	type VideoCodec,
	VideoDecoderWrapper,
	type VideoEncodingConfig,
	VideoSample,
	VideoSampleSource,
} from '../../src/index.js';
import { buildVideoCodecString, inferCodecFromCodecString } from '../../src/codec.js';
import { determineVideoPacketType } from '../../src/codec-data.js';
import { AudioDecoderWrapper } from '../../src/decode.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stubVideoDecoder = (name: string) => class extends CustomVideoDecoder {
	static override supports(codec: VideoCodec) { return codec === name; }
	init() {}
	decode() {}
	flush() {}
	close() {}
};
const stubAudioDecoder = (name: string) => class extends CustomAudioDecoder {
	static override supports(codec: AudioCodec) { return codec === name; }
	init() {}
	decode() {}
	flush() {}
	close() {}
};
const stubVideoEncoder = (name: string) => class extends CustomVideoEncoder {
	static override supports(codec: VideoCodec) { return codec === name; }
	init() {}
	encode(sample: VideoSample) {
		this.onPacket(new EncodedPacket(new Uint8Array(1), 'key', sample.timestamp, sample.duration));
	}

	flush() {}
	close() {}
};
const stubAudioEncoder = (name: string, supports = (config: AudioEncoderConfig) => !!config) => {
	return class extends CustomAudioEncoder {
		static override supports(codec: AudioCodec, config: AudioEncoderConfig) {
			return codec === name && supports(config);
		}

		init() {}
		encode(sample: AudioSample) {
			this.onPacket(new EncodedPacket(new Uint8Array(1), 'key', sample.timestamp, sample.duration));
		}

		flush() {}
		close() {}
	};
};
const TestDecoder = stubVideoDecoder('test-decoder');

const testOutputFormat = (
	codecs: string[],
	tracks: { video: number; audio: number },
	createMuxer: () => CustomMuxer,
) => {
	return new (class extends CustomOutputFormat {
		createMuxer() { return createMuxer(); }
		get name() { return 'Test'; }
		get fileExtension() { return '.test'; }
		get mimeType() { return 'video/test'; }
		getSupportedCodecs() { return codecs; }
		getSupportedTrackCounts() {
			const total = tracks.video + tracks.audio;
			return {
				video: { min: tracks.video, max: tracks.video },
				audio: { min: tracks.audio, max: tracks.audio },
				subtitle: { min: 0, max: 0 },
				total: { min: total, max: total },
			};
		}

		get supportsVideoRotationMetadata() { return false; }
		get supportsTimestampedMediaData() { return true; }
	})();
};

test('Codec registration lifetime', () => {
	const inspect = (data = new Uint8Array(0)) => determineVideoPacketType('test-video', { codec: 'test-video' }, data);
	const controller = new AbortController();
	const remove = registerVideoCodec('test-video', { determinePacketType: () => 'key', signal: controller.signal });
	expect(getAllVideoCodecs()).toContain('test-video');
	expect(inferCodecFromCodecString('test-video')).toBe('test-video');
	expect(inspect()).toBe('key');
	controller.abort();
	expect(getAllVideoCodecs()).not.toContain('test-video');
	const removeNext = registerVideoCodec('test-video', { determinePacketType: () => 'delta' });
	remove(); // A stale remover leaves the newer registration alone
	expect(inspect()).toBe('delta');
	removeNext();
	expect(inspect()).toBeNull();
	class Options {
		keyByte = 7;
		determinePacketType(data: Uint8Array) { return data[0] === this.keyByte ? 'key' as const : 'delta' as const; }
	}
	const removeProto = registerVideoCodec('test-video', new Options());
	// The callback keeps its prototype and its `this`
	expect(inspect(new Uint8Array([7]))).toBe('key');
	expect(inspect(new Uint8Array([0]))).toBe('delta');
	removeProto();
	const removeBad = registerVideoCodec('test-video', { determinePacketType: () => 'keyframe' as never });
	expect(inspect).toThrow('must return');
	removeBad();
	const removeAudio = registerAudioCodec('test-audio');
	expect(getAllAudioCodecs()).toContain('test-audio');
	removeAudio();
	expect(getAllAudioCodecs()).not.toContain('test-audio');
});

test('Invalid codec registration', () => {
	expect(() => registerAudioCodec('invalid-options', { signal: {} as AbortSignal })).toThrow('signal');
	expect(getAllAudioCodecs()).not.toContain('invalid-options');
	expect(() => registerVideoCodec('avc')).toThrow('built-in');
	expect(() => registerVideoCodec('avc1-custom')).toThrow('prefix');
	expect(() => registerAudioCodec('pcm-custom')).toThrow('prefix');
	expect(() => registerVideoCodec('Mpeg4')).toThrow('lowercase');
	expect(() => registerVideoCodec('test-video', { determinePacketType: 'key' as never })).toThrow('function');
	const remove = registerVideoCodec('test-video');
	const warnings: unknown[][] = [];
	const stopListening = Logging.on('warn', args => warnings.push(args));
	try {
		expect(() => registerAudioCodec('test-video')).toThrow('other media kind');
		// Registering the same name again for the same kind is harmless, like registering a decoder twice
		const removeAgain = registerVideoCodec('test-video');
		expect(warnings).toHaveLength(1);
		removeAgain();
		expect(getAllVideoCodecs()).toContain('test-video');
	} finally {
		stopListening();
		remove();
	}
	const controller = new AbortController();
	controller.abort();
	registerVideoCodec('already-aborted', { signal: controller.signal });
	registerAudioCodec('already-aborted', { signal: controller.signal });
	expect(getAllVideoCodecs()).not.toContain('already-aborted');
	expect(getAllAudioCodecs()).not.toContain('already-aborted');
});

test('A registered codec may carry its own full codec string', () => {
	const remove = registerVideoCodec('string-video');
	const removeAudio = registerAudioCodec('string-audio');
	try {
		// Mediabunny can't know what a third-party codec's string looks like, so it only checks that it is one
		expect(() => new VideoSampleSource({
			codec: 'string-video', bitrate: 1e6, fullCodecString: 'sv01.2.3',
		})).not.toThrow();
		expect(() => new AudioSampleSource({
			codec: 'string-audio', bitrate: 1e5, fullCodecString: 'sa01.7',
		})).not.toThrow();
		expect(() => new VideoSampleSource({
			codec: 'string-video', bitrate: 1e6, fullCodecString: 7 as never,
		})).toThrow('must be a string');
		// Built-in codecs keep the stricter check, on both track kinds
		expect(() => new VideoSampleSource({
			codec: 'avc', bitrate: 1e6, fullCodecString: 'sv01.2.3',
		})).toThrow('matches the specified codec');
		expect(() => new VideoSampleSource({
			codec: 'avc', bitrate: 1e6, fullCodecString: 'avc1.42c00a',
		})).not.toThrow();
		expect(() => new AudioSampleSource({
			codec: 'aac', bitrate: 1e5, fullCodecString: 'sa01.7',
		})).toThrow('matches the specified codec');
		expect(() => new AudioSampleSource({
			codec: 'aac', bitrate: 1e5, fullCodecString: 'mp4a.40.2',
		})).not.toThrow();
	} finally {
		remove();
		removeAudio();
	}
});

test('A registered codec may be probed with its own decoder configuration', async () => {
	// DNxHD and DNxHR share one name and differ only in the fourcc their decoder reads from the config
	const remove = registerVideoCodec('probe-video');
	const removeAudio = registerAudioCodec('probe-audio');
	// Registered up front: registering later would clear the memos and hide a shared cache key
	const removeOther = registerVideoCodec('probe-other');
	class FourccDecoder extends CustomVideoDecoder {
		static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
			return codec === 'probe-video' && config.codec === 'AVdn';
		}

		init() {}
		decode() {}
		flush() {}
		close() {}
	}
	class DescriptionlessDecoder extends CustomAudioDecoder {
		static override supports(codec: AudioCodec, config: AudioDecoderConfig) {
			// A registered codec gets no guessed description, whatever string its config borrows
			return codec === 'probe-audio' && config.description === undefined;
		}

		init() {}
		decode() {}
		flush() {}
		close() {}
	}
	registerDecoder(FourccDecoder);
	registerDecoder(DescriptionlessDecoder);
	try {
		expect(await canDecodeVideo('probe-video', { codec: 'AVdn' })).toBe(true);
		expect(await canDecodeVideo('probe-video', { codec: 'AVdh' })).toBe(false);
		const flacish = { codec: 'flac', numberOfChannels: 2, sampleRate: 48000 };
		expect(await canDecodeAudio('probe-audio', flacish)).toBe(true);
		// Two registered codecs resolving to the same config must not share a cached answer
		expect(await canDecodeVideo('probe-other', { codec: 'AVdn' })).toBe(false);
		// Built-in codecs keep the stricter check
		await expect(canDecodeVideo('avc', { codec: 'AVdn' })).rejects.toThrow('must match the specified codec');
	} finally {
		remove();
		removeAudio();
		removeOther();
	}
});

test('Capability checks do not confuse two codecs with the same encoder config', async () => {
	// Both names resolve to the same encoder config, but the encoder is asked about the name, not the config
	const removeYes = registerVideoCodec('memo-yes');
	const removeNo = registerVideoCodec('memo-no');
	class OnlyYesEncoder extends CustomVideoEncoder {
		static override supports(codec: VideoCodec) {
			return codec === 'memo-yes';
		}

		init() {}
		encode() {}
		flush() {}
		close() {}
	}
	registerEncoder(OnlyYesEncoder);
	try {
		expect(await canEncodeVideo('memo-yes', { bitrate: 1e5, fullCodecString: 'memo-no' })).toBe(true);
		expect(await canEncodeVideo('memo-no', { bitrate: 1e5 })).toBe(false);
		// A built-in's answer must not leak into a registered codec that borrows its codec string either
		expect(await canEncodeVideo('vp8', { bitrate: 1e5 })).toBe(false);
		expect(await canEncodeVideo('memo-yes', { bitrate: 1e5, fullCodecString: 'vp8' })).toBe(true);
	} finally {
		removeYes();
		removeNo();
	}
});

test('Codec name and options are validated in order', () => {
	expect(() => registerVideoCodec(1 as never)).toThrow('codec must be a string.');
	expect(() => registerVideoCodec('test-order', 'nope' as never)).toThrow('options must be an object.');
	// The name is checked before the options, so a built-in name reports that and not the callback
	expect(() => registerVideoCodec('avc', { determinePacketType: 5 as never })).toThrow('built-in');
});

test('An options getter cannot register the same name for both kinds', () => {
	// The signal is read once, before the conflict check, so a getter that registers mid-call can't slip past it
	let registered = false;
	const remove = () => {
		const options = {
			get signal() {
				if (!registered) {
					registered = true;
					registerAudioCodec('getter-codec');
				}
				return undefined;
			},
		};
		expect(() => registerVideoCodec('getter-codec', options)).toThrow('other media kind');
	};
	try {
		remove();
		expect(getAllVideoCodecs()).not.toContain('getter-codec');
		expect(getAllAudioCodecs()).toContain('getter-codec');
	} finally {
		const removeAudio = registerAudioCodec('getter-codec');
		removeAudio();
	}
});

test('Registering a name invalidates capability checks of both kinds', async () => {
	// A custom coder's supports() may consult either registry, so a name change must clear all of the memos
	class CrossKindDecoder extends CustomVideoDecoder {
		static override supports(codec: VideoCodec) {
			return codec === 'cross-video' && getAllAudioCodecs().includes('cross-audio');
		}

		init() {}
		decode() {}
		flush() {}
		close() {}
	}
	const removeVideo = registerVideoCodec('cross-video');
	registerDecoder(CrossKindDecoder);
	try {
		expect(await canDecodeVideo('cross-video')).toBe(false);
		const removeAudio = registerAudioCodec('cross-audio');
		expect(await canDecodeVideo('cross-video')).toBe(true);
		removeAudio();
		expect(await canDecodeVideo('cross-video')).toBe(false);
	} finally {
		removeVideo();
	}
});

test('Custom decoder admission', async () => {
	const remove = registerVideoCodec('test-decoder');
	try {
		expect(await canDecodeVideo('test-decoder')).toBe(false);
		registerDecoder(TestDecoder);
		expect(await canDecodeVideo('test-decoder')).toBe(true);
		expect(await canDecode('test-decoder')).toBe(true);
		expect(await getDecodableVideoCodecs()).toContain('test-decoder');
		expect(buildVideoCodecString('test-decoder', 16, 16, 10000, false)).toBe('test-decoder');
	} finally {
		remove();
	}
	expect(await canDecodeVideo('test-decoder')).toBe(false);
});

test('Custom codec bitrate', async () => {
	// A name that is also an Object.prototype key, so a plain-object lookup would find a truthy non-number
	const remove = registerVideoCodec('constructor');
	const removeAudio = registerAudioCodec('test-audio');
	try {
		// Qualities resolve to the AVC and AAC reference rates for registered codecs
		const avcBitrate = QUALITY_MEDIUM._toVideoBitrate('avc', 16, 16);
		expect(QUALITY_MEDIUM._toVideoBitrate('constructor', 16, 16)).toBe(avcBitrate);
		expect(QUALITY_MEDIUM._toAudioBitrate('test-audio')).toBe(QUALITY_MEDIUM._toAudioBitrate('aac'));
		expect(await canEncodeVideo('constructor', { bitrate: QUALITY_MEDIUM })).toBe(false); // No encoder yet
		registerEncoder(stubVideoEncoder('constructor'));
		expect(await canEncodeVideo('constructor', { bitrate: QUALITY_MEDIUM })).toBe(true);
		expect(await getEncodableVideoCodecs(undefined, { bitrate: QUALITY_MEDIUM })).toContain('constructor');
	} finally {
		remove();
		removeAudio();
	}
});

test('Encoding options cannot swap the checked codec', async () => {
	registerEncoder(stubVideoEncoder('yes-video'));
	registerEncoder(stubAudioEncoder('yes-audio'));
	const removers = [
		registerVideoCodec('yes-video'), registerVideoCodec('no-video'),
		registerAudioCodec('yes-audio'), registerAudioCodec('no-audio'),
	];
	try {
		await withNativeSpies(async () => {
			// An encoding config passed as the options object carries its own codec, which must not win
			const options: VideoEncodingConfig = { codec: 'yes-video', bitrate: 1e5 };
			expect(await canEncodeVideo('yes-video', options)).toBe(true);
			expect(await canEncodeVideo('no-video', options)).toBe(false);
			const audioOptions: AudioEncodingConfig = { codec: 'yes-audio', bitrate: 1e5 };
			expect(await canEncodeAudio('yes-audio', audioOptions)).toBe(true);
			expect(await canEncodeAudio('no-audio', audioOptions)).toBe(false);
			expect(await canEncode('yes-video')).toBe(true);
			expect(await canDecode('yes-video')).toBe(false);
		});
		// The default enumerations see registered names too
		expect(await getEncodableVideoCodecs(undefined, { bitrate: 1e5 })).toContain('yes-video');
		expect(await getDecodableVideoCodecs()).not.toContain('yes-video');
	} finally {
		removers.forEach(remove => remove());
	}
});

test('Registered codecs need a custom encoder', async () => {
	const remove = registerAudioCodec('test-encoder');
	try {
		const format = testOutputFormat(['test-encoder'], { video: 0, audio: 1 }, () => ({
			start() {}, getMimeType: () => 'audio/test', finalize() {},
		}));
		const output = new Output({ target: new BufferTarget(), format });
		const source = new AudioSampleSource({ codec: 'test-encoder', bitrate: 1e5 });
		output.addAudioTrack(source);
		await output.start();
		const sample = new AudioSample({
			data: new Float32Array(48), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
		});
		await expect(source.add(sample)).rejects.toThrow('custom encoder');
		sample.close();
		await output.cancel();
	} finally {
		remove();
	}
});

// Native coders that count and refuse any use, so a test can prove a codec name never reached them, plus a log
// listener to prove nothing was swallowed either
const withNativeSpies = async (run: () => Promise<void>) => {
	const native = { calls: 0 };
	const errors: unknown[][] = [];
	const stopListening = Logging.on('error', args => errors.push(args));
	const spy = class {
		static isConfigSupported() {
			native.calls++;
			throw new Error('Native coder consulted.');
		}

		constructor() {
			native.calls++;
			throw new Error('Native coder constructed.');
		}
	};
	const globals = globalThis as Record<string, unknown>;
	const names = ['VideoDecoder', 'AudioDecoder', 'VideoEncoder', 'AudioEncoder'];
	const previous = names.map(name => globals[name]);
	names.forEach(name => globals[name] = spy);
	try {
		await run();
		expect(native.calls).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		stopListening();
		names.forEach((name, i) => globals[name] = previous[i]);
	}
};

test('Unregistered codec names never reach native coders', async () => {
	await withNativeSpies(async () => {
		const ReviewVideoDecoder = stubVideoDecoder('review-video');
		const ReviewAudioDecoder = stubAudioDecoder('review-audio');
		// Unregistered names are rejected before any decoder is consulted, with or without a decoder class
		expect(await canDecodeVideo('review-video')).toBe(false);
		expect(await canDecodeAudio('review-audio')).toBe(false);
		// Registered names without a decoder class aren't decodable either, and no native decoder is asked
		const removeBareVideo = registerVideoCodec('bare-video');
		const removeBareAudio = registerAudioCodec('bare-audio');
		try {
			expect(await canDecodeVideo('bare-video')).toBe(false);
			expect(await canDecodeAudio('bare-audio', { numberOfChannels: 1, sampleRate: 8000 })).toBe(false);
			expect(await canEncodeVideo('bare-video', { bitrate: 1e5 })).toBe(false);
			expect(await canEncodeAudio('bare-audio', { bitrate: 1e5 })).toBe(false);
		} finally {
			removeBareVideo();
			removeBareAudio();
		}
		registerDecoder(ReviewVideoDecoder);
		registerDecoder(ReviewAudioDecoder);
		expect(await canDecodeVideo('review-video')).toBe(false);
		expect(await canDecodeAudio('review-audio')).toBe(false);
		// Registered names are answered by the decoder classes alone
		const removeVideo = registerVideoCodec('review-video');
		const removeAudio = registerAudioCodec('review-audio');
		try {
			expect(await canDecodeVideo('review-video')).toBe(true);
			expect(await canDecodeAudio('review-audio', { numberOfChannels: 1, sampleRate: 8000 })).toBe(true);
		} finally {
			removeVideo();
			removeAudio();
		}
		// The decoder wrappers refuse to fall back to native decoders for names they don't know
		const config = { codec: 'other-video', codedWidth: 16, codedHeight: 16 };
		expect(() => new VideoDecoderWrapper(() => {}, () => {}, 'other-video', config, 0, 1))
			.toThrow('No custom decoder supports');
		expect(() => new AudioDecoderWrapper(() => {}, () => {}, 'other-audio', {
			codec: 'other-audio', numberOfChannels: 1, sampleRate: 8000,
		})).toThrow('No custom decoder supports');
	});
});

test('Registered names are served by custom coders alone', async () => {
	await withNativeSpies(async () => {
		const ServedVideoDecoder = stubVideoDecoder('served-video');
		const ServedAudioDecoder = stubAudioDecoder('served-audio');
		registerDecoder(ServedVideoDecoder);
		registerDecoder(ServedAudioDecoder);
		registerEncoder(stubVideoEncoder('served-video'));
		registerEncoder(stubAudioEncoder('served-audio'));
		const removeVideo = registerVideoCodec('served-video');
		const removeAudio = registerAudioCodec('served-audio');
		try {
			// The decoder wrappers construct the matching custom decoder, whatever the config's codec string says
			const video = new VideoDecoderWrapper(() => {}, () => {}, 'served-video', {
				codec: 'avc1.42001e', codedWidth: 16, codedHeight: 16,
			}, 0, 1);
			expect(video.customDecoder).toBeInstanceOf(ServedVideoDecoder);
			video.close();
			const audio = new AudioDecoderWrapper(() => {}, () => {}, 'served-audio', {
				codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 8000,
			});
			expect(audio.customDecoder).toBeInstanceOf(ServedAudioDecoder);
			audio.close();

			// Encoding capability comes from the custom encoders, and the sample sources use them
			expect(await canEncodeVideo('served-video', { bitrate: 1e5 })).toBe(true);
			expect(await canEncodeAudio('served-audio', { bitrate: 1e5 })).toBe(true);
			const packets = { video: 0, audio: 0 };
			const format = testOutputFormat(['served-video', 'served-audio'], { video: 1, audio: 1 }, () => ({
				start() {},
				getMimeType: () => 'video/test',
				addEncodedVideoPacket() { packets.video++; },
				addEncodedAudioPacket() { packets.audio++; },
				finalize() {},
			}));
			const output = new Output({ target: new BufferTarget(), format });
			const videoSource = new VideoSampleSource({ codec: 'served-video', bitrate: 1e5 });
			const audioSource = new AudioSampleSource({ codec: 'served-audio', bitrate: 1e5 });
			output.addVideoTrack(videoSource);
			output.addAudioTrack(audioSource);
			await output.start();
			const videoSample = new VideoSample(new Uint8Array(16 * 16 * 4), {
				format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp: 0, duration: 1,
			});
			await videoSource.add(videoSample);
			videoSample.close();
			const audioSample = new AudioSample({
				data: new Float32Array(48), format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: 0,
			});
			await audioSource.add(audioSample);
			audioSample.close();
			await output.finalize();
			expect(packets).toEqual({ video: 1, audio: 1 });
		} finally {
			removeVideo();
			removeAudio();
		}
	});
});

test('Conversion through registered codecs', async () => {
	// A source whose tracks carry registered names, decoded and encoded by custom coders only
	class ConvInputFormat extends CustomInputFormat {
		canReadInput() { return true; }
		createDemuxer(): CustomDemuxer {
			const packet = (index: number) => {
				return index < 2 ? new EncodedPacket(new Uint8Array(2), 'key', index, 1, index) : null;
			};
			const shared = {
				timeResolution: 1,
				getFirstPacket: () => packet(0),
				getNextPacket: (previous: EncodedPacket) => packet(previous.sequenceNumber + 1),
				getPacket: (timestamp: number) => packet(Math.min(Math.floor(timestamp), 1)),
				getKeyPacket: (timestamp: number) => packet(Math.min(Math.floor(timestamp), 1)),
				getNextKeyPacket: (previous: EncodedPacket) => packet(previous.sequenceNumber + 1),
			};
			return {
				getTracks: () => [{
					...shared, id: 1, type: 'video', codec: 'conv-video', codedWidth: 16, codedHeight: 16,
					getDecoderConfig: () => ({ codec: 'conv-video', codedWidth: 16, codedHeight: 16 }),
				}, {
					...shared, id: 2, type: 'audio', codec: 'conv-audio', numberOfChannels: 1, sampleRate: 32000,
					getDecoderConfig: () => ({ codec: 'conv-audio', numberOfChannels: 1, sampleRate: 32000 }),
				}],
				getMimeType: () => 'video/conv',
			};
		}

		get name() { return 'Conv'; }
		get mimeType() { return 'video/conv'; }
	}
	class ConvDecoder extends CustomVideoDecoder {
		static override supports(codec: VideoCodec) { return codec === 'conv-video'; }
		init() {}
		decode(packet: EncodedPacket) {
			this.onSample(new VideoSample(new Uint8Array(16 * 16 * 4), {
				format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp: packet.timestamp, duration: 1,
			}));
		}

		flush() {}
		close() {}
	}
	class ConvAudioDecoder extends CustomAudioDecoder {
		static override supports(codec: AudioCodec) { return codec === 'conv-audio'; }
		init() {}
		decode(packet: EncodedPacket) {
			this.onSample(new AudioSample({
				data: new Float32Array(32000), format: 'f32', numberOfChannels: 1, sampleRate: 32000,
				timestamp: packet.timestamp,
			}));
		}

		flush() {}
		close() {}
	}
	registerDecoder(ConvDecoder);
	registerDecoder(ConvAudioDecoder);
	registerEncoder(stubVideoEncoder('conv-video'));
	registerEncoder(stubAudioEncoder('conv-audio'));
	const removeVideo = registerVideoCodec('conv-video');
	const removeAudio = registerAudioCodec('conv-audio');
	try {
		const packets = { video: 0, audio: 0 };
		// AAC is listed first but has no encoder here; the custom codec must still be picked, not discarded
		const format = testOutputFormat(['aac', 'conv-audio', 'conv-video'], { video: 1, audio: 1 }, () => ({
			start() {},
			getMimeType: () => 'video/test',
			addEncodedVideoPacket() { packets.video++; },
			addEncodedAudioPacket() { packets.audio++; },
			finalize() {},
		}));
		const convFormat = new ConvInputFormat();
		using input = new Input({ source: new BufferSource(new Uint8Array(8)), formats: [convFormat] });
		const output = new Output({ target: new BufferTarget(), format });
		const conversion = await Conversion.init({
			input,
			output,
			video: { forceTranscode: true, codec: 'conv-video' }, // The default quality resolves for registered codecs
			audio: { forceTranscode: true, bitrate: 1e5 },
		});
		expect(conversion.isValid).toBe(true);
		expect(conversion.discardedTracks).toEqual([]);
		await conversion.execute();
		expect(packets.video).toBe(2);
		expect(packets.audio).toBeGreaterThan(0);

		// A registered codec that its encoder only takes at 48 kHz gets the same resampling fallback as a built-in one
		registerEncoder(stubAudioEncoder('picky-audio', config => config.sampleRate === 48000));
		const removePicky = registerAudioCodec('picky-audio');
		try {
			let pickyPackets = 0;
			const pickyFormat = testOutputFormat(['picky-audio'], { video: 0, audio: 1 }, () => ({
				start() {}, getMimeType: () => 'audio/test', addEncodedAudioPacket() { pickyPackets++; }, finalize() {},
			}));
			using pickyInput = new Input({ source: new BufferSource(new Uint8Array(8)), formats: [convFormat] });
			const pickyConversion = await Conversion.init({
				input: pickyInput,
				output: new Output({ target: new BufferTarget(), format: pickyFormat }),
				video: { discard: true },
				audio: { forceTranscode: true, bitrate: 1e5 },
			});
			expect(pickyConversion.utilizedTracks).toHaveLength(1);
			await pickyConversion.execute();
			expect(pickyPackets).toBeGreaterThan(0);
		} finally {
			removePicky();
		}

		// A registered name without an encoder, listed beside PCM, must not cost the track its PCM fallback
		const removeBare = registerAudioCodec('bare-audio');
		try {
			const pcmFormat = testOutputFormat(['bare-audio', 'pcm-s16'], { video: 0, audio: 1 }, () => ({
				start() {}, getMimeType: () => 'audio/test', addEncodedAudioPacket() {}, finalize() {},
			}));
			using pcmInput = new Input({ source: new BufferSource(new Uint8Array(8)), formats: [convFormat] });
			const pcmConversion = await Conversion.init({
				input: pcmInput,
				output: new Output({ target: new BufferTarget(), format: pcmFormat }),
				video: { discard: true },
				audio: { forceTranscode: true },
			});
			expect(pcmConversion.discardedTracks.map(t => t.reason)).toEqual(['discarded_by_user']); // The video
			expect(pcmConversion.utilizedTracks).toHaveLength(1);
		} finally {
			removeBare();
		}
	} finally {
		removeVideo();
		removeAudio();
	}
});

test('Outputs and HLS still need registered names', async () => {
	// A container can read a codec name it found, but writing it means asserting the name is real
	expect(() => new EncodedVideoPacketSource('mpeg4')).toThrow('Invalid video codec');
	const remove = registerVideoCodec('mpeg4');
	try {
		const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat() });
		expect(() => output.addVideoTrack(new EncodedVideoPacketSource('mpeg4'))).toThrow('cannot be contained');
		await output.cancel();
	} finally {
		remove();
	}

	// HLS learns codecs from playlist strings, which only inference over registered names can resolve
	const dir = mkdtempSync(join(tmpdir(), 'mediabunny-'));
	const playlist = join(dir, 'master.m3u8');
	writeFileSync(playlist, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="review-video"\nvideo.m3u8\n');
	{
		using input = new Input({ source: new FilePathSource(playlist), formats: [HLS] });
		expect(await input.getVideoTracks()).toHaveLength(0);
	}
	const removeReview = registerVideoCodec('review-video');
	try {
		using input = new Input({ source: new FilePathSource(playlist), formats: [HLS] });
		const tracks = await input.getVideoTracks();
		expect(tracks).toHaveLength(1);
		expect(await tracks[0]!.getCodec()).toBe('review-video');
		// A registered codec's config string is its decoder's business, so the check no longer rejects one that
		// looks built in; the decoder registered for the name is what decides
		expect(await canDecodeVideo('review-video', { codec: 'avc1.42c00a' })).toBe(true);
		removeReview();
		expect(await tracks[0]!.getCodec()).toBeNull(); // Inference goes through the current registry
		const errors: unknown[][] = [];
		const stopListening = Logging.on('error', args => errors.push(args));
		expect(await tracks[0]!.canDecode()).toBe(false); // And a track without a codec is simply undecodable
		stopListening();
		expect(errors).toEqual([]);
	} finally {
		removeReview();
	}
	const audioPlaylist = join(dir, 'audio.m3u8');
	writeFileSync(audioPlaylist, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="review-audio"\naudio.m3u8\n');
	const removeAudio = registerAudioCodec('review-audio');
	try {
		using input = new Input({ source: new FilePathSource(audioPlaylist), formats: [HLS] });
		expect(await input.getAudioTracks()).toHaveLength(1);
	} finally {
		removeAudio();
		rmSync(dir, { recursive: true });
	}
});
