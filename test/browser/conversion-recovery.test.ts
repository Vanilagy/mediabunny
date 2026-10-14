import { expect, test, vi } from 'vitest';
declare const __RECOVERY_TEST_MEDIA__: string;
import {
	RecoverableConversion,
	type ConversionCheckpoint,
	type ConversionRecoveryStore,
} from '../../src/conversion-recovery.js';
import {
	Conversion,
	ConversionCanceledError,
	type ConversionOptions,
} from '../../src/conversion.js';
import { Quality, canEncodeAudio, canEncodeVideo } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, VideoSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import {
	EncodedAudioPacketSource,
	AudioSampleSource,
	CanvasSource,
	VideoSampleSource,
} from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import {
	Mp4OutputFormat,
	WebMOutputFormat,
	MovOutputFormat,
	MkvOutputFormat,
	OggOutputFormat,
	WavOutputFormat,
	AdtsOutputFormat,
	MpegTsOutputFormat,
} from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { EncodedPacket } from '../../src/packet.js';
import { BlobSource, BufferSource, CustomSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';
import { registerAc3Decoder } from '@mediabunny/ac3';
import { registerDtsDecoder } from '@mediabunny/dts';

registerAc3Decoder();
registerDtsDecoder();

// Chromium on Linux does not expose a native AAC encoder. Keep non-AAC recovery
// coverage active there rather than failing while constructing an unrelated fixture.
const aacTest = test.skipIf(!(await canEncodeAudio('aac')));

const memoryStore = () => {
	const objects: Uint8Array[] = [];
	let checkpoint: ConversionCheckpoint | undefined;
	const store: ConversionRecoveryStore = {
		readSegment: async index => objects[index]!.slice(),
		commit: async (index, bytes, next) => {
			objects[index] = bytes.slice();
			checkpoint = JSON.parse(JSON.stringify(next)) as ConversionCheckpoint;
		},
	};
	return { store, objects, checkpoint: () => checkpoint };
};

test('copy recovery uses metadata-only planning, linear reads, and raw binary storage', async () => {
	const packetCount = 1024;
	const packetBytes = 4096;
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const audio = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(audio);
	await output.start();
	const duration = packetBytes / 2 / 48000;
	for (let i = 0; i < packetCount; i++) {
		const data = Uint8Array.from({ length: packetBytes }, (_, j) => (i + j) % 256);
		await audio.add(new EncodedPacket(data, 'key', i * duration, duration), {
			decoderConfig: { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 },
		});
	}
	await output.finalize();
	const bytes = new Uint8Array(output.target.buffer!);
	const saved = memoryStore();
	let planningBytes = 0;
	let processingBytes = 0;
	let planning = true;
	let largestRead = 0;
	const open = () =>
		new Input({
			formats: ALL_FORMATS,
			source: new CustomSource({
				getSize: () => bytes.byteLength,
				maxCacheSize: packetBytes,
				prefetchProfile: 'none',
				read: (start, end) => {
					largestRead = Math.max(largestRead, end - start);
					if (planning) {
						planningBytes += end - start;
					} else {
						processingBytes += end - start;
					}
					return bytes.slice(start, end);
				},
			}),
		});
	const options = {
		store: saved.store,
		sourceIdentity: 'immutable-copy-read-fixture-v1',
		conversion: { copy: { mode: 'forced' as const } },
	};
	let done = false;
	while (!done) {
		using input = open();
		planning = true;
		const before = planningBytes;
		const recovery = await RecoverableConversion.init({
			...options,
			source: input,
			checkpoint: saved.checkpoint(),
		});
		// Packet indexes and decoder configuration are permitted; reading media payload
		// to hash or discover batches is not. Each restart has a fresh tiny source cache.
		expect(planningBytes - before).toBeLessThan((packetCount * packetBytes) / 10);
		planning = false;
		try {
			done = !(await recovery.step());
		} finally {
			recovery.dispose();
		}
	}
	const payloadBytes = packetCount * packetBytes;
	expect(saved.objects.length).toBeGreaterThanOrEqual(4);
	// Metadata probes may cache the first/last few PCM bytes before step().
	expect(processingBytes).toBeGreaterThan(payloadBytes * 0.9);
	expect(processingBytes).toBeLessThan(payloadBytes * 1.5);
	expect(largestRead).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
	const durableBytes = saved.objects.reduce((sum, object) => sum + object.byteLength, 0);
	// Binary storage may add per-packet metadata, but not JSON number arrays/base64.
	expect(durableBytes).toBeGreaterThanOrEqual(payloadBytes);
	expect(durableBytes).toBeLessThan(payloadBytes * 1.1);
	using input = open();
	planning = true;
	const recovery = await RecoverableConversion.init({
		...options,
		source: input,
		checkpoint: saved.checkpoint(),
	});
	const readsBeforeAssembly = planningBytes + processingBytes;
	try {
		const target = new BufferTarget();
		await recovery.assemble(target);
		expect(planningBytes + processingBytes).toBe(readsBeforeAssembly);
		using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await result.getPrimaryAudioTrack())!;
		let offset = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			// PCM muxers may regroup packets; compare the byte stream and sample clock,
			// not container-specific packet boundaries.
			expect(packet.timestamp).toBeCloseTo(offset / 2 / 48000, 5);
			const expected = Uint8Array.from({ length: packet.data.byteLength }, (_, j) => {
				const position = offset + j;
				return (Math.floor(position / packetBytes) + (position % packetBytes)) % 256;
			});
			expect(packet.data).toEqual(expected);
			offset += packet.data.byteLength;
		}
		expect(offset).toBe(payloadBytes);
	} finally {
		recovery.dispose();
	}
}, 120_000);

const fixture = async (audioCodec: 'aac' | 'opus' | 'pcm-s16' | null = 'aac') => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(320, 320);
	const context = canvas.getContext('2d')!;
	const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 100_000 });
	const audio = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: 128_000 }) : null;
	output.addVideoTrack(video);
	if (audio) {
		output.addAudioTrack(audio);
	}
	await output.start();
	for (let i = 0; i < 30; i++) {
		context.fillStyle = i < 10 ? 'red' : i < 20 ? 'green' : 'blue';
		context.fillRect(0, 0, 320, 320);
		await video.add(i / 10, 0.1);
		const data = new Int16Array(4800);
		for (let j = 0; j < data.length; j++) {
			const t = (i * 4800 + j) / 48000;
			data[j] = Math.round(
				12000 * Math.sin(2 * Math.PI * (440 * t + 350 * t * t))
				+ 2000 * Math.sin(2 * Math.PI * 7123 * t)
				+ ((i * 4800 + j) % 997 === 0 ? 10000 : 0),
			);
		}
		using sample = new AudioSample({
			data,
			format: 's16',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: i / 10,
		});
		await audio?.add(sample);
	}
	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

aacTest.each(['aac', 'opus', 'pcm-s16'] as const)(
	'durable conversion recovers %s input with continuous AAC and valid video boundaries',
	async (codec) => {
		const source = await fixture(codec);
		using sourceInput = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
		expect(await (await sourceInput.getPrimaryAudioTrack())!.getCodec()).toBe(codec);
		const segments: Uint8Array[] = [];
		let published: ConversionCheckpoint | undefined;
		let failCommit = false;
		let failAfterPublish = false;
		const store: ConversionRecoveryStore = {
			readSegment: async index => segments[index]!.slice(),
			commit: async (index, bytes, checkpoint) => {
				segments[index] = bytes.slice();
				if (failCommit) {
					throw new Error('power loss before checkpoint publish');
				}
				published = JSON.parse(JSON.stringify(checkpoint)) as ConversionCheckpoint;
				if (failAfterPublish) {
					throw new Error('lost commit acknowledgement');
				}
			},
		};
		const options = {
			source,
			segmentDuration: 1,
			store,
			conversion: {
				trim: { start: 0, end: 3 },
				video: {
					frameRate: 10,
					width: 320,
					height: 320,
					fit: 'contain' as const,
					bitrate: 100_000,
				},
			},
		};
		let recovery = await RecoverableConversion.init(options);
		await expect(recovery.assemble(new BufferTarget())).rejects.toThrow('incomplete');
		expect(await recovery.step()).toBe(true);
		using segmentInput = new Input({
			source: new BufferSource(segments[0]!),
			formats: ALL_FORMATS,
		});
		expect(await segmentInput.getPrimaryVideoTrack()).toBeNull();
		expect(await (await segmentInput.getPrimaryAudioTrack())!.getCodec()).toBe('pcm-f32');
		recovery.dispose();

		// Recreate everything, including source and JSON checkpoint; no old codec/output object survives.
		recovery = await RecoverableConversion.init({
			...options,
			source: source.slice(),
			checkpoint: published,
		});
		failCommit = true;
		await expect(recovery.step()).rejects.toThrow('power loss');
		await expect(recovery.step()).rejects.toThrow('reopening');
		recovery.dispose();
		failCommit = false;
		const firstSegment = segments[0]!.slice();
		recovery = await RecoverableConversion.init({ ...options, checkpoint: published });
		await recovery.step();
		recovery.dispose();
		expect(segments[0]).toEqual(firstSegment);
		recovery = await RecoverableConversion.init({ ...options, checkpoint: published });
		failAfterPublish = true;
		await expect(recovery.step()).rejects.toThrow('acknowledgement');
		recovery.dispose();
		failAfterPublish = false;
		recovery = await RecoverableConversion.init({ ...options, checkpoint: published });
		while (await recovery.step()) {
			// Continue until all durable units are committed.
		}
		recovery.dispose();
		recovery = await RecoverableConversion.init({ ...options, checkpoint: published });
		await expect(
			recovery.assemble(
				new BufferTarget({
					onFinalize: () => {
						throw new Error('assembly interrupted');
					},
				}),
			),
		).rejects.toThrow('assembly interrupted');
		recovery.dispose();
		recovery = await RecoverableConversion.init({ ...options, checkpoint: published });
		const target = new BufferTarget();
		await recovery.execute(target);
		expect(published!.segments).toHaveLength(6);
		// Compare every saved native-rate PCM sample to one continuous decode of the compressed/PCM source.
		const expectedPcm: number[] = [];
		for await (const sample of new AudioSampleSink(
			(await sourceInput.getPrimaryAudioTrack())!,
		).samples(0, 3)) {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			const from = Math.max(0, Math.round(-sample.timestamp * sample.sampleRate));
			const to = Math.min(data.length, Math.round((3 - sample.timestamp) * sample.sampleRate));
			for (let i = from; i < to; i++) {
				expectedPcm.push(data[i]!);
			}
			sample.close();
		}
		let savedFrames = 0;
		for (let chunk = 0; chunk < 3; chunk++) {
			using pcm = new Input({ source: new BufferSource(segments[chunk]!), formats: ALL_FORMATS });
			for await (const sample of new AudioSampleSink(
				(await pcm.getPrimaryAudioTrack())!,
			).samples()) {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				for (const value of data) {
					expect(value).toBeCloseTo(expectedPcm[savedFrames++]!, 5);
				}
				sample.close();
			}
		}
		expect(savedFrames).toBe(expectedPcm.length);
		expect(await recovery.step()).toBe(false);
		recovery.dispose();

		using result = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer!) });
		const video = (await result.getPrimaryVideoTrack())!;
		const audio = (await result.getPrimaryAudioTrack())!;
		expect(await video.computeDuration()).toBeCloseTo(3, 5);
		expect(await audio.getCodec()).toBe('aac');
		// AAC has encoder priming/tail padding. Recovery must match one uninterrupted Conversion,
		// rather than adding encoder delay once per recovered video segment.
		using original = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
		const baselineOutput = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		const baseline = await Conversion.init({
			input: original,
			output: baselineOutput,
			copy: false,
			trim: { start: 0, end: 3 },
			video: { discard: true },
			audio: { codec: 'aac', bitrate: 128_000 },
		});
		await baseline.execute();
		using baselineInput = new Input({
			source: new BufferSource(baselineOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const baselineAudio = (await baselineInput.getPrimaryAudioTrack())!;
		expect(await audio.computeDuration()).toBeCloseTo(await baselineAudio.computeDuration(), 5);
		expect(Math.abs((await audio.computeDuration()) - 3)).toBeLessThan(0.1);
		let frames = 0;
		const decodedCanvas = new OffscreenCanvas(320, 320);
		const decodedContext = decodedCanvas.getContext('2d')!;
		for await (const sample of new VideoSampleSink(video).samples(0, 3)) {
			expect(sample.timestamp).toBeCloseTo(frames / 10, 5);
			sample.draw(decodedContext, 0, 0);
			const pixel = decodedContext.getImageData(160, 160, 1, 1).data;
			const channel = Math.floor(frames / 10);
			expect(pixel[channel]).toBeGreaterThan(100);
			expect(pixel[(channel + 1) % 3]).toBeLessThan(20);
			expect(pixel[(channel + 2) % 3]).toBeLessThan(20);
			frames++;
			sample.close();
		}
		expect(frames).toBe(30);
		let audioEnd: number | undefined;
		const boundaryEnergy = [0, 0];
		const boundarySamples = [0, 0];
		for await (const sample of new AudioSampleSink(audio).samples()) {
			if (audioEnd !== undefined) {
				expect(sample.timestamp).toBeCloseTo(audioEnd, 5);
			}
			audioEnd = sample.timestamp + sample.duration;
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			for (let i = 0; i < data.length; i++) {
				const time = sample.timestamp + i / sample.sampleRate;
				for (let b = 0; b < 2; b++) {
					if (Math.abs(time - (b + 1)) < 0.02) {
						boundaryEnergy[b]! += data[i]! ** 2;
						boundarySamples[b]!++;
					}
				}
			}
			sample.close();
		}
		expect(audioEnd).toBeGreaterThanOrEqual(3);
		for (let b = 0; b < 2; b++) {
			expect(boundarySamples[b]).toBeGreaterThan(1800);
			expect(Math.sqrt(boundaryEnergy[b]! / boundarySamples[b]!)).toBeGreaterThan(0.2);
		}

		await expect(
			RecoverableConversion.init({
				...options,
				checkpoint: { ...published!, version: 99 } as never,
			}),
		).rejects.toThrow('checkpoint');
		await expect(
			RecoverableConversion.init({
				...options,
				conversion: {
					...options.conversion,
					video: { ...options.conversion.video, bitrate: 200_000 },
				},
				checkpoint: published,
			}),
		).rejects.toThrow('configuration');
		const changed = source.slice();
		changed[changed.length - 1]! ^= 1;
		await expect(
			RecoverableConversion.init({ ...options, source: changed, checkpoint: published }),
		).rejects.toThrow('source');
		await expect(
			RecoverableConversion.init({
				...options,
				conversion: { ...options.conversion, trim: { end: 4 } },
			}),
		).rejects.toThrow('covering');
		await expect(
			RecoverableConversion.init({
				...options,
				checkpoint: { ...published!, segments: [null] } as never,
			}),
		).rejects.toThrow('checkpoint');
		await expect(
			RecoverableConversion.init({
				...options,
				checkpoint: {
					...published!,
					segments: [...published!.segments, published!.segments[0]!],
				},
			}),
		).rejects.toThrow('checkpoint');
		await expect(RecoverableConversion.init({ ...options, segmentDuration: 0 })).rejects.toThrow(
			'segmentDuration',
		);
		segments[0]![0]! ^= 1;
		await expect(RecoverableConversion.init({ ...options, checkpoint: published })).rejects.toThrow(
			'corrupt',
		);
	},
	120_000,
);

test('Opus resume decodes only bounded one-second preroll and excludes it from durable PCM', async () => {
	const source = await fixture('opus');
	const saved = memoryStore();
	const options = {
		source,
		store: saved.store,
		segmentDuration: 0.2,
		format: new WavOutputFormat(),
		conversion: {
			video: { discard: true },
			audio: { codec: 'pcm-s16' as const },
			trim: { end: 3 },
		},
	};
	const first = await RecoverableConversion.init(options);
	for (let i = 0; i < 10; i++) {
		expect(await first.step()).toBe(true);
	}
	first.dispose();
	const resumed = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
	const original = Object.getOwnPropertyDescriptor(AudioSampleSink.prototype, 'samples')!
		.value as AudioSampleSink['samples'];
	const ranges: { start: number; end: number }[] = [];
	const decode = vi.spyOn(AudioSampleSink.prototype, 'samples').mockImplementation(function (
		this: AudioSampleSink,
		start,
		end,
		options,
	) {
		ranges.push({ start: start!, end: end! });
		return original.call(this, start, end, options);
	});
	try {
		expect(await resumed.step()).toBe(true);
	} finally {
		decode.mockRestore();
		resumed.dispose();
	}
	expect(
		ranges.some(range => Math.abs(range.start - 1) < 0.01 && Math.abs(range.end - 2.2) < 0.01),
	).toBe(true);
	using committed = new Input({
		source: new BufferSource(saved.objects[10]!),
		formats: ALL_FORMATS,
	});
	const track = (await committed.getPrimaryAudioTrack())!;
	expect(await track.computeDuration()).toBeCloseTo(0.2, 5);
	let frames = 0;
	for await (using sample of new AudioSampleSink(track).samples()) {
		frames += sample.numberOfFrames;
	}
	expect(frames).toBe(9600);
}, 120_000);

test('resumed video recovery rejects changed encoder configuration before checkpoint publication', async () => {
	const source = await fixture(null);
	const saved = memoryStore();
	const options = {
		source,
		store: saved.store,
		segmentDuration: 1,
		conversion: { video: { codec: 'avc' as const, bitrate: 100_000 } },
	};
	const first = await RecoverableConversion.init(options);
	await first.step();
	first.dispose();
	const checkpoint = saved.checkpoint()!;
	const original = saved.objects[0]!.slice();
	const resumed = await RecoverableConversion.init({ ...options, checkpoint });
	// Model a fresh encoder producing a different valid decoder configuration.
	// The stored first segment remains unchanged; only the new segment's encoding differs.
	const originalInit = Conversion.init.bind(Conversion);
	const encoding = vi.spyOn(Conversion, 'init').mockImplementation(async (options) => {
		const video = options.video;
		if (typeof video !== 'function') {
			throw new Error('Expected the recovery video-track selector');
		}
		return originalInit({
			...options,
			video: async (track, index) => ({
				...(await video(track, index)),
				width: 160,
			}),
		});
	});
	try {
		await expect(resumed.step()).rejects.toThrow('configuration changed');
		expect(saved.checkpoint()).toEqual(checkpoint);
		expect(saved.objects).toHaveLength(1);
		expect(saved.objects[0]).toEqual(original);
	} finally {
		encoding.mockRestore();
		resumed.dispose();
	}
	const valid = await RecoverableConversion.init({ ...options, checkpoint });
	try {
		expect(await valid.step()).toBe(true);
		expect(saved.checkpoint()!.segments).toHaveLength(2);
	} finally {
		valid.dispose();
	}
}, 120_000);

test('video-only recovery accepts file-backed Input identity and fractional duration', async () => {
	const bytes = await fixture(null);
	const segments: Uint8Array[] = [];
	let checkpoint: ConversionCheckpoint | undefined;
	const store: ConversionRecoveryStore = {
		readSegment: async index => segments[index]!.slice(),
		commit: async (index, data, next) => {
			segments[index] = data.slice();
			checkpoint = JSON.parse(JSON.stringify(next)) as ConversionCheckpoint;
		},
	};
	const options = {
		segmentDuration: 0.9,
		store,
		conversion: {
			trim: { end: 2.7 },
			video: { frameRate: 10, width: 320, height: 320, fit: 'contain' as const, bitrate: 100_000 },
		},
	};
	using first = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS });
	await expect(RecoverableConversion.init({ ...options, source: first })).rejects.toThrow(
		'sourceIdentity',
	);
	const initial = await RecoverableConversion.init({
		...options,
		source: first,
		sourceIdentity: 'immutable-v1',
	});
	await initial.step();
	initial.dispose();
	expect(first.disposed).toBe(false);
	using fresh = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS });
	await expect(
		RecoverableConversion.init({
			...options,
			source: fresh,
			sourceIdentity: 'changed-v2',
			checkpoint,
		}),
	).rejects.toThrow('source');
	const recovery = await RecoverableConversion.init({
		...options,
		source: fresh,
		sourceIdentity: 'immutable-v1',
		checkpoint,
	});
	const target = new BufferTarget();
	await recovery.execute(target);
	recovery.dispose();
	using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	expect(await result.getPrimaryAudioTrack()).toBeNull();
	const video = (await result.getPrimaryVideoTrack())!;
	expect(await video.computeDuration()).toBeCloseTo(2.7, 5);
	let frames = 0;
	for await (const sample of new VideoSampleSink(video).samples()) {
		expect(sample.timestamp).toBeCloseTo(frames / 10, 5);
		frames++;
		sample.close();
	}
	expect(frames).toBe(27);
}, 120_000);

test.for(['mp4', 'webm'] as const)(
	'audio-only %s commits continuous resampling and reopens without source decoding',
	{ timeout: 120_000 },
	async (format, context) => {
		if (format === 'mp4' && !(await canEncodeAudio('aac'))) {
			context.skip(true, 'AAC encoder unavailable');
			return;
		}
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const audio = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(audio);
		await output.start();
		const samples = new Int16Array(44100 * 2);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.round(12000 * Math.sin((i * 2 * Math.PI * 440) / 44100));
		}
		using sample = new AudioSample({
			data: samples,
			format: 's16',
			sampleRate: 44100,
			numberOfChannels: 1,
			timestamp: 2,
		});
		await audio.add(sample);
		await output.finalize();
		const source = new Uint8Array(output.target.buffer!);
		const saved = memoryStore();
		const options = {
			source,
			format,
			segmentDuration: 0.2,
			store: saved.store,
			conversion: {
				trim: { start: 2.123, end: 3.789 },
				audio: {
					codec: format === 'webm' ? ('opus' as const) : ('aac' as const),
					sampleRate: 48000,
					numberOfChannels: 2,
					bitrate: 96_000,
				},
			},
		};
		const initial = await RecoverableConversion.init(options);
		await initial.step();
		initial.dispose();
		const recovery = await RecoverableConversion.init({
			...options,
			checkpoint: saved.checkpoint(),
		});
		const originalSamples = Object.getOwnPropertyDescriptor(AudioSampleSink.prototype, 'samples')!
			.value as AudioSampleSink['samples'];
		const decodedStarts: number[] = [];
		const sourceDecode = vi
			.spyOn(AudioSampleSink.prototype, 'samples')
			.mockImplementation(function (this: AudioSampleSink, start, end, options) {
				decodedStarts.push(start!);
				return originalSamples.call(this, start, end, options);
			});
		try {
			while (await recovery.step()) {
				// Continue until all durable units are committed.
			}
		} finally {
			sourceDecode.mockRestore();
		}
		expect(Math.min(...decodedStarts)).toBeGreaterThan(2.32);
		let pcmFrames = 0;
		for (const bytes of saved.objects) {
			expect(bytes.byteLength).toBeLessThan(44100 * 0.21 * 4 + 4096);
			using pcmInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const pcmTrack = (await pcmInput.getPrimaryAudioTrack())!;
			for await (const sample of new AudioSampleSink(pcmTrack).samples()) {
				const data = new Float32Array(sample.numberOfFrames);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				for (let i = 0; i < data.length; i++) {
					const originalIndex = Math.round(0.123 * 44100) + pcmFrames + i;
					expect(data[i]).toBeCloseTo(samples[originalIndex]! / 32768, 5);
				}
				pcmFrames += sample.numberOfFrames;
				sample.close();
			}
		}
		expect(pcmFrames).toBe(Math.round(1.789 * 44100) - Math.round(0.123 * 44100));
		const target = new BufferTarget();
		const noConversion = vi.spyOn(Conversion, 'init').mockImplementation(async () => {
			throw new Error('Committed assembly must not recreate a conversion or source decoder');
		});
		try {
			await recovery.assemble(target);
		} finally {
			noConversion.mockRestore();
		}
		recovery.dispose();
		using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		expect(await result.getPrimaryVideoTrack()).toBeNull();
		const track = (await result.getPrimaryAudioTrack())!;
		expect(await track.getSampleRate()).toBe(48000);
		expect(await track.getNumberOfChannels()).toBe(2);
		expect(await track.getCodec()).toBe(format === 'webm' ? 'opus' : 'aac');
		using durable = new Input({
			source: new BufferSource(saved.objects[0]!),
			formats: ALL_FORMATS,
		});
		const committed = (await durable.getPrimaryAudioTrack())!;
		expect(await committed.getCodec()).toBe('pcm-f32');
		const decode = async (input: Input) => {
			const values: number[] = [];
			for await (using decoded of new AudioSampleSink(
				(await input.getPrimaryAudioTrack())!,
			).samples()) {
				const data = new Float32Array(decoded.numberOfFrames * decoded.numberOfChannels);
				decoded.copyTo(data, { planeIndex: 0, format: 'f32' });
				for (const value of data) values.push(value);
			}
			return values;
		};
		using baselineInput = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
		const baselineOutput = new Output({
			format: format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const baseline = await Conversion.init({
			input: baselineInput,
			output: baselineOutput,
			...options.conversion,
		});
		await baseline.execute();
		using baselineResult = new Input({
			source: new BufferSource(baselineOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const actual = await decode(result);
		const expected = await decode(baselineResult);
		expect(actual.length).toBe(expected.length);
		let squaredError = 0;
		for (let i = 0; i < actual.length; i++) squaredError += (actual[i]! - expected[i]!) ** 2;
		expect(Math.sqrt(squaredError / actual.length)).toBeLessThan(0.001);
	},
);

aacTest.each([
	[false, false],
	[true, false],
	[false, true],
	[true, true],
])(
	'terminated worker resumes IndexedDB checkpoints; mid-commit=%s copy=%s',
	async (midCommit, copy) => {
		const source = await fixture('aac');
		const database = `recovery-${crypto.randomUUID()}`;
		const launch = (finish: boolean) => {
			const worker = new Worker(new URL('./conversion-recovery.worker.ts', import.meta.url), {
				type: 'module',
			});
			const result = new Promise<{
				committed?: number;
				resumed?: number;
				buffer?: ArrayBuffer;
				midCommit?: boolean;
			}>((resolve, reject) => {
				worker.onmessage = (
					event: MessageEvent<{
						error?: string;
						committed?: number;
						resumed?: number;
						buffer?: ArrayBuffer;
						midCommit?: boolean;
					}>,
				) => {
					if (event.data.error) {
						reject(new Error(event.data.error));
					} else {
						resolve(event.data);
					}
				};
				worker.onerror = event => reject(new Error(event.message));
			});
			worker.postMessage({ source, database, finish, midCommit: !finish && midCommit, copy });
			return { worker, result };
		};
		const first = launch(false);
		try {
			const result = await first.result;
			if (midCommit) {
				expect(result.midCommit).toBe(true);
			} else {
				expect(result.committed).toBe(1);
			}
		} finally {
			first.worker.terminate();
		}
		const fresh = launch(true);
		try {
			const result = await fresh.result;
			expect(result.resumed).toBe(1);
			using input = new Input({ source: new BufferSource(result.buffer!), formats: ALL_FORMATS });
			const track = (await input.getPrimaryAudioTrack())!;
			expect(await track.getCodec()).toBe('aac');
			let frames = 0;
			for await (const sample of new AudioSampleSink(track).samples()) {
				frames += sample.numberOfFrames;
				sample.close();
			}
			expect(frames).toBeGreaterThanOrEqual(144000);
		} finally {
			fresh.worker.terminate();
			indexedDB.deleteDatabase(database);
		}
	},
	120_000,
);

test('rejects negative frameRate in second video variant before source planning', async () => {
	const source = await fixture(null);
	const saved = memoryStore();
	// A broken validator must fail fast in this regression, not enter an infinite
	// negative-step frame-grid loop. Planning is forbidden for invalid options.
	const planning = vi
		.spyOn(Input.prototype, 'getTracks')
		.mockRejectedValue(new Error('Unexpected source planning'));
	try {
		await expect(
			RecoverableConversion.init({
				source,
				store: saved.store,
				conversion: { video: [{ frameRate: 10 }, { frameRate: -1 }] },
			}),
		).rejects.toThrow(/frameRate/);
		expect(planning).not.toHaveBeenCalled();
		expect(saved.objects).toHaveLength(0);
	} finally {
		planning.mockRestore();
	}
});

test('snapshots nested options and rejects concurrent operations while committing', async () => {
	const source = await fixture(null);
	const crop = { left: 0, top: 0, width: 160, height: 160 };
	const tags = { title: 'original' };
	const quality = new Quality({ bitrate: 100000 });
	let release!: () => void;
	let entered!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const committing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const saved = memoryStore();
	const recovery = await RecoverableConversion.init({
		source,
		segmentDuration: 3,
		conversion: { video: { crop, quality }, tags },
		store: {
			...saved.store,
			commit: async (...args) => {
				entered();
				await blocked;
				await saved.store.commit(...args);
			},
		},
	});
	crop.width = 40;
	tags.title = 'mutated';
	quality._bitrate = 900000;
	const step = recovery.step();
	await committing;
	try {
		await expect(recovery.step()).rejects.toThrow('busy');
		await expect(recovery.assemble(new BufferTarget())).rejects.toThrow('busy');
		expect(() => recovery.dispose()).toThrow('during');
	} finally {
		release();
	}
	await step;
	const target = new BufferTarget();
	await recovery.assemble(target);
	using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	expect((await result.getMetadataTags()).title).toBe('original');
	expect(await (await result.getPrimaryVideoTrack())!.getDisplayWidth()).toBe(160);
	expect(recovery.checkpoint.configuration).toContain('100000');
	recovery.dispose();
});

test.for(['video', 'audio', 'assembly'] as const)(
	'cancels %s work without advancing checkpoint and resumes in a fresh instance',
	{ timeout: 120_000 },
	async (stage, context) => {
		if (stage !== 'video' && !(await canEncodeAudio('aac'))) {
			context.skip(true, 'AAC encoder unavailable');
			return;
		}
		const bytes = await fixture(stage === 'video' ? null : 'aac');
		const saved = memoryStore();
		const options = {
			source: bytes,
			store: saved.store,
			segmentDuration: 1,
			conversion: { video: { frameRate: 10, bitrate: 100_000 } },
		};
		let recovery = await RecoverableConversion.init(options);
		await recovery.step();
		recovery.dispose();
		const committed = saved.objects[0]!.slice();
		const previous = saved.checkpoint()!;
		if (stage === 'assembly') {
			recovery = await RecoverableConversion.init({ ...options, checkpoint: previous });
			while (await recovery.step()) {
				// Continue until all durable units are committed.
			}
			recovery.dispose();
		}
		recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalVideo = Object.getOwnPropertyDescriptor(VideoSampleSource.prototype, 'add')!
			.value as VideoSampleSource['add'];
		const originalSamples = Object.getOwnPropertyDescriptor(AudioSampleSink.prototype, 'samples')!
			.value as AudioSampleSink['samples'];
		const originalRead = saved.store.readSegment.bind(saved.store);
		let spy: { mockRestore: () => void } | undefined;
		if (stage === 'video') {
			spy = vi.spyOn(VideoSampleSource.prototype, 'add').mockImplementation(async function (
				this: VideoSampleSource,
				...args
			) {
				entered();
				await blocked;
				return originalVideo.apply(this, args);
			});
		} else if (stage === 'audio') {
			spy = vi.spyOn(AudioSampleSink.prototype, 'samples').mockImplementation(function (
				this: AudioSampleSink,
				...args
			) {
				const iterable = originalSamples.apply(this, args);
				return (async function* () {
					entered();
					await blocked;
					yield* iterable;
				})();
			});
		} else {
			spy = vi.spyOn(saved.store, 'readSegment').mockImplementation(async (index) => {
				entered();
				await blocked;
				return originalRead(index);
			});
		}
		const before = saved.checkpoint()!;
		const pending = stage === 'assembly' ? recovery.assemble(new BufferTarget()) : recovery.step();
		try {
			await started;
			const cancelling = recovery.cancel();
			await expect(recovery.step()).rejects.toThrow(/busy|canceled/);
			await expect(recovery.assemble(new BufferTarget())).rejects.toThrow(/busy|canceled/);
			expect(() => recovery.dispose()).toThrow('during');
			release();
			await expect(pending).rejects.toBeInstanceOf(ConversionCanceledError);
			await cancelling;
		} finally {
			release();
			spy?.mockRestore();
		}
		expect(saved.checkpoint()).toEqual(before);
		expect(saved.objects[0]).toEqual(committed);
		recovery.dispose();
		const fresh = await RecoverableConversion.init({
			...options,
			source: bytes.slice(),
			checkpoint: saved.checkpoint(),
		});
		const target = new BufferTarget();
		try {
			await fresh.execute(target);
			using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
			if (stage !== 'video') {
				expect(await (await result.getPrimaryAudioTrack())!.getCodec()).toBe('aac');
			}
			expect(await (await result.getPrimaryVideoTrack())!.computeDuration()).toBeCloseTo(3, 2);
		} finally {
			fresh.dispose();
		}
	},
);

test('decodes oversized PCM packets only within requested checkpoint range', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedAudioPacketSource('pcm-f32');
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1600000), 'key', 0, 400000 / 48000), {
		decoderConfig: { codec: 'pcm-f32', numberOfChannels: 1, sampleRate: 48000 },
	});
	await output.finalize();
	const saved = memoryStore();
	const recovery = await RecoverableConversion.init({
		source: new Uint8Array(output.target.buffer!),
		segmentDuration: 0.1,
		store: saved.store,
	});
	await recovery.step();
	expect(saved.objects[0]!.length).toBeLessThan(25000);
	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const sink = new AudioSampleSink((await input.getPrimaryAudioTrack())!);
	sink._trimPcmBeforeDecode = true;
	let frames = 0;
	for await (using sample of sink.samples(7, 7.1)) {
		expect(sample.numberOfFrames).toBeLessThanOrEqual(4801);
		frames += sample.numberOfFrames;
	}
	expect(frames).toBeGreaterThanOrEqual(4800);
	recovery.dispose();
});

for (const extension of ['mp3', 'flac', 'ogg', 'ac3.mkv', 'eac3.mkv', 'dts.mkv']) {
	test(`ffmpeg ${extension} recovery matches continuous decode or rejects unbounded preroll`, async (context) => {
		if (!__RECOVERY_TEST_MEDIA__) {
			context.skip(true, 'Run npm run test-recovery to generate fixtures');
			return;
		}
		const response = await fetch(`${__RECOVERY_TEST_MEDIA__}/recovery.${extension}`);
		expect(response.ok, `Missing generated recovery.${extension}`).toBe(true);
		const bytes = new Uint8Array(await response.arrayBuffer());
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		expect(track, `${extension} audio track`).not.toBeNull();
		expect(await track!.canDecode(), `${extension} decoder must be registered and available`).toBe(
			true,
		);
		if (extension !== 'flac') {
			const saved = memoryStore();
			const decode = vi.spyOn(AudioSampleSink.prototype, 'samples');
			try {
				await expect(
					RecoverableConversion.init({
						source: bytes,
						store: saved.store,
						conversion: { audio: { codec: 'pcm-s16' }, trim: { end: 2.5 } },
						format: new WavOutputFormat(),
					}),
				).rejects.toThrow('bounded seek preroll');
				expect(decode).not.toHaveBeenCalled();
				expect(saved.objects).toHaveLength(0);
			} finally {
				decode.mockRestore();
			}
			return;
		}
		const expected: number[] = [];
		for await (using sample of new AudioSampleSink(track!).samples(0, 2.5)) {
			const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			const first = Math.max(0, Math.round(-sample.timestamp * sample.sampleRate));
			const last = Math.min(
				sample.numberOfFrames,
				Math.round((2.5 - sample.timestamp) * sample.sampleRate),
			);
			for (let i = first * sample.numberOfChannels; i < last * sample.numberOfChannels; i++) {
				expected.push(data[i]!);
			}
		}
		const saved = memoryStore();
		const options = {
			source: bytes,
			segmentDuration: 0.5,
			store: saved.store,
			conversion: { trim: { start: 0, end: 2.5 } },
		};
		for (let i = 0; i < 5; i++) {
			const recovery = await RecoverableConversion.init({
				...options,
				checkpoint: saved.checkpoint(),
			});
			await recovery.step();
			recovery.dispose();
		}
		let offset = 0;
		for (const chunk of saved.objects) {
			using pcm = new Input({ source: new BufferSource(chunk), formats: ALL_FORMATS });
			for await (using sample of new AudioSampleSink(
				(await pcm.getPrimaryAudioTrack())!,
			).samples()) {
				const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
				sample.copyTo(data, { planeIndex: 0, format: 'f32' });
				for (const value of data) expect(value).toBeCloseTo(expected[offset++]!, 5);
			}
		}
		expect(offset).toBe(expected.length);
	}, 120000);
}

test.for(['mov', 'mkv', 'ogg', 'wav', 'adts', 'ts'] as const)(
	'assembles into incumbent %s output format',
	async (name, context) => {
		if (name !== 'wav' && name !== 'ogg' && !(await canEncodeAudio('aac'))) {
			context.skip(true, 'AAC encoder unavailable');
			return;
		}
		const format = {
			mov: new MovOutputFormat(),
			mkv: new MkvOutputFormat(),
			ogg: new OggOutputFormat(),
			wav: new WavOutputFormat(),
			adts: new AdtsOutputFormat(),
			ts: new MpegTsOutputFormat(),
		}[name];
		const source = await fixture('pcm-s16');
		const codec = name === 'wav' ? 'pcm-s16' : name === 'ogg' ? 'opus' : 'aac';
		const recovery = await RecoverableConversion.init({
			source,
			format,
			segmentDuration: 1,
			store: memoryStore().store,
			conversion: { video: { discard: true }, audio: { codec } },
		});
		const target = new BufferTarget();
		await recovery.execute(target);
		recovery.dispose();
		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		expect(await (await input.getPrimaryAudioTrack())!.getCodec()).toBe(codec);
	},
);

for (const codec of ['hevc', 'av1', 'vp8'] as const) {
	test(`recovers ${codec} video when an encoder is available`, async (context) => {
		if (!(await canEncodeVideo(codec))) {
			context.skip(true, `${codec} encoder unavailable`);
			return;
		}
		const saved = memoryStore();
		const options = {
			source: await fixture(null),
			format: codec === 'hevc' ? new Mp4OutputFormat() : new WebMOutputFormat(),
			segmentDuration: 1,
			store: saved.store,
			conversion: { video: { codec, bitrate: 100000 } },
		};
		const first = await RecoverableConversion.init(options);
		await first.step();
		first.dispose();
		const recovery = await RecoverableConversion.init({
			...options,
			checkpoint: saved.checkpoint(),
		});
		const target = new BufferTarget();
		await recovery.execute(target);
		recovery.dispose();
		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const track = (await input.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe(codec);
		let frames = 0;
		for await (using sample of new VideoSampleSink(track).samples(0, 3)) {
			expect(sample.timestamp).toBeGreaterThanOrEqual(0);
			frames++;
		}
		expect(frames).toBe(30);
	}, 120000);
}

aacTest.each(['mp4', 'mkv'])(
	'recovers two audio tracks with distinct rates offsets languages plus video from %s',
	async (container) => {
		const output = new Output({
			format: container === 'mkv' ? new MkvOutputFormat() : new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const canvas = new OffscreenCanvas(320, 320);
		canvas.getContext('2d')!.fillRect(0, 0, 320, 320);
		const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 100000 });
		output.addVideoTrack(video, { name: 'picture', languageCode: 'eng' });
		const audioA = new AudioSampleSource({ codec: 'pcm-s16' });
		const audioB = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(audioA, { languageCode: 'eng', name: 'English' });
		output.addAudioTrack(audioB, {
			languageCode: 'fra',
			name: 'French',
			disposition: { commentary: true },
		});
		await output.start();
		for (let i = 0; i < 20; i++) {
			await video.add(i / 10, 0.1);
			for (const [source, rate, offset] of [
				[audioA, 44100, 0],
				[audioB, 48000, 0.25],
			] as const) {
				const data = new Int16Array(rate / 10).fill(i * 100);
				using sample = new AudioSample({
					data,
					format: 's16',
					numberOfChannels: 1,
					sampleRate: rate,
					timestamp: offset + i / 10,
				});
				await source.add(sample);
			}
		}
		await output.finalize();
		const saved = memoryStore();
		const options = {
			source: new Uint8Array(output.target.buffer!),
			format: new MkvOutputFormat(),
			segmentDuration: 0.5,
			store: saved.store,
			conversion: {
				trim: { end: 2 },
				audio: { codec: 'aac' as const },
				video: { codec: 'avc' as const },
			},
		};
		if (container === 'mkv') {
			// Matroska PCM packets have no bounded seek path; refuse before writing
			// rather than silently replaying the entire source at every checkpoint.
			await expect(RecoverableConversion.init(options)).rejects.toThrow('bounded seek preroll');
			expect(saved.objects).toHaveLength(0);
			return;
		}
		let recovery = await RecoverableConversion.init(options);
		while (await recovery.step()) {
			recovery.dispose();
			recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
		}
		const target = new BufferTarget();
		await recovery.assemble(target);
		recovery.dispose();
		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const audios = await input.getAudioTracks();
		expect(audios.length).toBe(2);
		expect(await audios[0]!.getLanguageCode()).toBe('eng');
		expect(await audios[1]!.getLanguageCode()).toBe('fra');
		expect(await audios[1]!.getName()).toBe('French');
		using original = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		expect(await audios[1]!.getDisposition()).toEqual(
			await (await original.getAudioTracks())[1]!.getDisposition(),
		);
		expect(await audios[0]!.getSampleRate()).toBe(44100);
		expect(await audios[1]!.getSampleRate()).toBe(48000);
		expect(await audios[1]!.getFirstTimestamp()).toBeGreaterThan(0.2);
		expect((await input.getVideoTracks()).length).toBe(1);
	},
	120000,
);

aacTest(
	'reconstructs multiple video tracks and declarative audio/video variants',
	async () => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const canvas = new OffscreenCanvas(320, 320);
		canvas.getContext('2d')!.fillRect(0, 0, 320, 320);
		const videos = [
			new CanvasSource(canvas, { codec: 'avc', bitrate: 100000 }),
			new CanvasSource(canvas, { codec: 'avc', bitrate: 100000 }),
		];
		videos.forEach((source, index) => output.addVideoTrack(source, { name: `camera${index}` }));
		const audio = new AudioSampleSource({ codec: 'pcm-s16' });
		output.addAudioTrack(audio, { languageCode: 'fra' });
		await output.start();
		for (let i = 0; i < 10; i++) {
			await videos[0]!.add(i / 10, 0.1);
			if (i < 6) {
				await videos[1]!.add(0.2 + i / 10, 0.1);
			}
			using sample = new AudioSample({
				data: new Int16Array(4800),
				format: 's16',
				numberOfChannels: 1,
				sampleRate: 48000,
				timestamp: 0.2 + i / 10,
			});
			await audio.add(sample);
		}
		await output.finalize();
		const saved = memoryStore();
		const options = {
			source: new Uint8Array(output.target.buffer!),
			store: saved.store,
			segmentDuration: 0.5,
			conversion: {
				trim: { end: 1 },
				video: [{ width: 160 }, { width: 320 }],
				audio: [{ sampleRate: 44100 }, { sampleRate: 48000 }],
			},
		};
		let recovery = await RecoverableConversion.init(options);
		while (await recovery.step()) {
			recovery.dispose();
			recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
		}
		let audioChunks = 0;
		for (const object of saved.objects) {
			using chunk = new Input({ source: new BufferSource(object), formats: ALL_FORMATS });
			if (await chunk.getPrimaryAudioTrack()) {
				audioChunks++;
			}
		}
		expect(audioChunks).toBe(2); // Shared across both output variants.
		const target = new BufferTarget();
		await recovery.assemble(target);
		recovery.dispose();
		using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		const resultVideos = await input.getVideoTracks();
		expect(resultVideos.length).toBe(4);
		for (const [index, track] of resultVideos.entries()) {
			expect(await track.getFirstTimestamp()).toBeCloseTo(index >= 2 ? 0.2 : 0, 5);
			expect(await track.computeDuration()).toBeCloseTo(index >= 2 ? 0.8 : 1, 5);
		}
		expect(await Promise.all(resultVideos.map(track => track.getDisplayWidth()))).toEqual([
			160, 320, 160, 320,
		]);
		const resultAudio = await input.getAudioTracks();
		expect(await Promise.all(resultAudio.map(track => track.getSampleRate()))).toEqual([
			44100, 48000,
		]);
		for (const track of resultAudio) {
			expect(await track.getLanguageCode()).toBe('fra');
			expect(await track.getFirstTimestamp()).toBeGreaterThan(0.15);
		}
	},
	120000,
);

aacTest.each(['expand', 'shrink'] as const)(
	'global copy iterator matches executed Conversion with %s boundaries',
	async (boundaryPolicy) => {
		using input = new Input({
			source: new BufferSource(await fixture('aac')),
			formats: ALL_FORMATS,
		});
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			trim: { start: 0.23, end: 2.37 },
			copy: {
				mode: 'forced',
				boundaryPolicy,
				boundaryTolerance: Infinity,
				shiftTolerance: Infinity,
			},
		});
		expect(conversion.isValid).toBe(true);
		const expected: EncodedPacket[][] = [];
		for (const plan of conversion._copyPlans) {
			const packets: EncodedPacket[] = [];
			for await (const packet of conversion._copyPackets(plan.outputTrackId)) packets.push(packet);
			expected.push(packets);
		}
		for (const [index, plan] of conversion._copyPlans.entries()) {
			let count = 2;
			for await (const packet of conversion._copyPackets(plan.outputTrackId, 2)) {
				expect(packet.data).toEqual(expected[index]![count]!.data);
				expect(packet.timestamp).toBe(expected[index]![count++]!.timestamp);
			}
			expect(count).toBe(expected[index]!.length);
		}
		await conversion.execute();
		using result = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const tracks = await result.getTracks();
		expect(tracks.length).toBe(expected.length);
		for (const [index, track] of tracks.entries()) {
			let n = 0;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				const original = expected[index]![n++]!;
				expect(packet.data).toEqual(original.data);
				expect(packet.timestamp).toBeCloseTo(original.timestamp, 4);
				expect(packet.duration).toBeCloseTo(original.duration, 4);
			}
			expect(n).toBe(expected[index]!.length);
		}
	},
	120000,
);

test.for(['mp4', 'webm'] as const)(
	'multi-batch %s copy preserves original packet identity across fresh trimmed recovery',
	{ timeout: 120_000 },
	async (container, context) => {
		if (!__RECOVERY_TEST_MEDIA__) {
			context.skip(true, 'Generate recovery fixtures with npm run test-recovery');
			return;
		}
		const response = await fetch(
			`${__RECOVERY_TEST_MEDIA__}/${container === 'mp4' ? 'recovery-bframes.mp4' : 'recovery-copy.webm'}`,
		);
		expect(response.ok).toBe(true);
		const source = new Uint8Array(await response.arrayBuffer());
		const format = () => (container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat());
		const saved = memoryStore();
		const conversion = {
			trim: { start: 0.23, end: 11.37 },
			copy: {
				mode: 'forced' as const,
				boundaryPolicy: 'expand' as const,
				boundaryTolerance: Infinity,
				shiftTolerance: Infinity,
			},
		};
		const options = { source, store: saved.store, conversion, format: format() };
		let recovery = await RecoverableConversion.init(options);
		try {
			while (await recovery.step()) {
				recovery.dispose();
				recovery = await RecoverableConversion.init({
					...options,
					source: source.slice(),
					checkpoint: saved.checkpoint(),
				});
			}
			// More than 256 video packets: continuation must cross multiple 128-packet
			// batches, not merely seek once into a small single-batch fixture.
			expect(saved.objects.length).toBeGreaterThanOrEqual(3);
			const target = new BufferTarget();
			await recovery.assemble(target);
			using input = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
			const baseline = new Output({ format: format(), target: new BufferTarget() });
			await (await Conversion.init({ ...conversion, input, output: baseline })).execute();
			using expected = new Input({
				source: new BufferSource(baseline.target.buffer!),
				formats: ALL_FORMATS,
			});
			using actual = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
			const expectedTracks = await expected.getTracks();
			const actualTracks = await actual.getTracks();
			expect(actualTracks).toHaveLength(expectedTracks.length);
			for (const [index, track] of actualTracks.entries()) {
				const packets: EncodedPacket[] = [];
				for await (const packet of new EncodedPacketSink(expectedTracks[index]!).packets()) {
					packets.push(packet);
				}
				if (index === 0) {
					expect(packets.length).toBeGreaterThan(256);
					if (container === 'mp4') {
						expect(
							packets.some((packet, i) => i > 0 && packet.timestamp < packets[i - 1]!.timestamp),
						).toBe(true);
					}
				}
				let count = 0;
				for await (const packet of new EncodedPacketSink(track).packets()) {
					const original = packets[count++]!;
					expect(packet.data).toEqual(original.data);
					expect(packet.timestamp).toBeCloseTo(original.timestamp, 6);
					expect(packet.duration).toBeCloseTo(original.duration, 6);
					expect(packet.type).toBe(original.type);
					expect(packet.sideData).toEqual(original.sideData);
				}
				expect(count).toBe(packets.length);
			}
		} finally {
			recovery.dispose();
		}
	},
);

for (const [boundaryPolicy, mode, bframes] of [
	['expand', 'forced', false],
	['shrink', 'forced', false],
	['expand', 'preferred', false],
	['shrink', 'preferred', false],
	['expand', 'forced', true],
	['shrink', 'forced', true],
] as const) {
	const register = bframes ? (__RECOVERY_TEST_MEDIA__ ? test : test.skip) : aacTest;
	register(
		`durable copy survives fresh instances with ${boundaryPolicy} boundaries, ${mode} mode, Bframes=${bframes}`,
		async () => {
			const response = bframes ? await fetch(`${__RECOVERY_TEST_MEDIA__}/recovery-bframes.mp4`) : undefined;
			if (response) {
				expect(response.ok, 'Missing generated B-frame fixture').toBe(true);
			}
			const source = response ? new Uint8Array(await response.arrayBuffer()) : await fixture('aac');
			const saved = memoryStore();
			const conversion = {
				trim: { start: 0.23, end: 2.37 },
				copy: { mode, boundaryPolicy, boundaryTolerance: Infinity, shiftTolerance: Infinity },
			};
			const options = { source, store: saved.store, conversion, format: new Mp4OutputFormat() };
			let recovery = await RecoverableConversion.init(options);
			while (await recovery.step()) {
				recovery.dispose();
				recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
			}
			await expect(
				RecoverableConversion.init({
					...options,
					checkpoint: saved.checkpoint(),
					conversion: { ...conversion, trim: { start: 0.24, end: 2.37 } },
				}),
			).rejects.toThrow('checkpoint');
			const original = saved.objects[0]!.slice();
			saved.objects[0]![0]! ^= 1;
			await expect(
				RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() }),
			).rejects.toThrow('corrupt');
			saved.objects[0] = original;
			const target = new BufferTarget();
			await recovery.assemble(target);
			recovery.dispose();
			using input = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
			const baseline = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
			await (await Conversion.init({ ...conversion, input, output: baseline })).execute();
			using actual = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
			using expected = new Input({
				source: new BufferSource(baseline.target.buffer!),
				formats: ALL_FORMATS,
			});
			const tracks = await expected.getTracks();
			for (const [index, track] of (await actual.getTracks()).entries()) {
				const packets: EncodedPacket[] = [];
				for await (const packet of new EncodedPacketSink(tracks[index]!).packets()) {
					packets.push(packet);
				}
				let n = 0;
				for await (const packet of new EncodedPacketSink(track).packets()) {
					const original = packets[n++]!;
					expect(packet.data).toEqual(original.data);
					expect(packet.timestamp).toBeCloseTo(original.timestamp, 6);
					expect(packet.duration).toBeCloseTo(original.duration, 6);
					expect(packet.sideData).toEqual(original.sideData);
				}
				expect(n).toBe(packets.length);
			}
		},
		120000,
	);
}

aacTest.each(['video', 'audio'] as const)(
	'mixed recovery copies %s and transcodes the other track with trim and resume',
	async (copied) => {
		const source = await fixture('aac');
		const saved = memoryStore();
		const conversion = {
			trim: { start: 0.23, end: 2.37 },
			copy: {
				mode: 'preferred' as const,
				boundaryPolicy: 'expand' as const,
				boundaryTolerance: Infinity,
				shiftTolerance: Infinity,
			},
			video:
				copied === 'video' ? {} : { forceTranscode: true, codec: 'avc' as const, bitrate: 100_000 },
			audio:
				copied === 'audio' ? {} : { forceTranscode: true, codec: 'aac' as const, bitrate: 128_000 },
		};
		const options = { source, store: saved.store, conversion, segmentDuration: 0.8 };
		let recovery = await RecoverableConversion.init(options);
		await recovery.step();
		recovery.dispose();
		recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
		const target = new BufferTarget();
		await recovery.execute(target);
		recovery.dispose();
		const fullyCommitted = saved.checkpoint()!;
		const interrupted = await RecoverableConversion.init({
			...options,
			checkpoint: fullyCommitted,
		});
		await expect(
			interrupted.assemble(
				new BufferTarget({
					onFinalize: () => {
						throw new Error('interrupted assembly');
					},
				}),
			),
		).rejects.toThrow('interrupted assembly');
		interrupted.dispose();
		const replay = await RecoverableConversion.init({ ...options, checkpoint: fullyCommitted });
		const replayTarget = new BufferTarget();
		await replay.assemble(replayTarget);
		replay.dispose();
		expect(saved.checkpoint()).toEqual(fullyCommitted);
		using input = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
		const baselineOutput = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new BufferTarget(),
		});
		const baseline = await Conversion.init({ ...conversion, input, output: baselineOutput });
		expect(baseline._copyPlans).toHaveLength(1);
		await baseline.execute();
		using result = new Input({
			source: new BufferSource(replayTarget.buffer!),
			formats: ALL_FORMATS,
		});
		using expected = new Input({
			source: new BufferSource(baselineOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const actualTracks = await result.getTracks();
		const expectedTracks = await expected.getTracks();
		expect(actualTracks.map(track => track.type)).toEqual(
			expectedTracks.map(track => track.type),
		);
		for (let i = 0; i < actualTracks.length; i++) {
			const actual = actualTracks[i]!;
			const reference = expectedTracks[i]!;
			expect(await actual.getCodec()).toBe(await reference.getCodec());
			const actualPackets: EncodedPacket[] = [];
			const referencePackets: EncodedPacket[] = [];
			for await (const packet of new EncodedPacketSink(actual).packets()) {
				actualPackets.push(packet);
			}
			for await (const packet of new EncodedPacketSink(reference).packets()) {
				referencePackets.push(packet);
			}
			if (actual.type === copied) {
				expect(actualPackets.length).toBe(referencePackets.length);
				for (let j = 0; j < actualPackets.length; j++) {
					expect(actualPackets[j]!.data).toEqual(referencePackets[j]!.data);
					expect(actualPackets[j]!.timestamp).toBeCloseTo(referencePackets[j]!.timestamp, 5);
					expect(actualPackets[j]!.sideData).toEqual(referencePackets[j]!.sideData);
				}
			} else {
				expect(actualPackets.length).toBeGreaterThan(0);
				expect(actualPackets[0]!.timestamp).toBeCloseTo(referencePackets[0]!.timestamp, 2);
				expect(await actual.computeDuration()).toBeCloseTo(await reference.computeDuration(), 1);
			}
		}
	},
	120000,
);

aacTest(
	'mixed variants preserve source-order metadata and packet side data',
	async () => {
		const source = await fixture('aac');
		const saved = memoryStore();
		const conversion = {
			trim: { start: 0.23, end: 2.37 },
			audio: { discard: true },
			video: [
				{},
				{ forceTranscode: true, width: 160, codec: 'avc' as const, bitrate: 100_000 },
			],
			copy: {
				mode: 'preferred' as const,
				boundaryPolicy: 'expand' as const,
				boundaryTolerance: Infinity,
				shiftTolerance: Infinity,
			},
		};
		const options = { source, store: saved.store, conversion, segmentDuration: 0.8 };
		let recovery = await RecoverableConversion.init(options);
		await recovery.step();
		recovery.dispose();
		recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
		const target = new BufferTarget();
		await recovery.execute(target);
		recovery.dispose();
		using original = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
		const baselineOutput = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const baseline = await Conversion.init({
			...conversion,
			input: original,
			output: baselineOutput,
		});
		expect(baseline._copyPlans).toHaveLength(1);
		await baseline.execute();
		using actual = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
		using expected = new Input({
			source: new BufferSource(baselineOutput.target.buffer!),
			formats: ALL_FORMATS,
		});
		const actualTracks = await actual.getVideoTracks();
		const expectedTracks = await expected.getVideoTracks();
		expect(actualTracks).toHaveLength(2);
		for (let i = 0; i < 2; i++) {
			expect(await actualTracks[i]!.getDisplayWidth()).toBe(
				await expectedTracks[i]!.getDisplayWidth(),
			);
			expect(await actualTracks[i]!.getName()).toBe(await expectedTracks[i]!.getName());
			expect(await actualTracks[i]!.getFirstTimestamp()).toBeCloseTo(
				await expectedTracks[i]!.getFirstTimestamp(),
				2,
			);
		}
		const actualPackets: EncodedPacket[] = [];
		const expectedPackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(actualTracks[0]!).packets()) {
			actualPackets.push(packet);
		}
		for await (const packet of new EncodedPacketSink(expectedTracks[0]!).packets()) {
			expectedPackets.push(packet);
		}
		expect(actualPackets.map(x => x.data)).toEqual(expectedPackets.map(x => x.data));
		expect(actualPackets.map(x => x.sideData)).toEqual(expectedPackets.map(x => x.sideData));
	},
	120000,
);

test('mixed recovery rejects forced copy when a requested transcode cannot be copied', async () => {
	await expect(
		RecoverableConversion.init({
			source: await fixture(null),
			store: memoryStore().store,
			conversion: { video: { forceTranscode: true }, copy: { mode: 'forced' } },
		}),
	).rejects.toThrow('requested output variant');
});

test('rational CFR recovery keeps one global frame grid across arbitrary trim', async () => {
	const source = await fixture(null);
	const saved = memoryStore();
	const rate = 30000 / 1001;
	const options = {
		source,
		store: saved.store,
		segmentDuration: 0.7,
		conversion: {
			trim: { start: 0.123, end: 2.789 },
			video: {
				frameRate: rate,
				codec: 'avc' as const,
				width: 320,
				height: 320,
				fit: 'contain' as const,
				bitrate: 200_000,
			},
		},
	};
	let recovery = await RecoverableConversion.init(options);
	await recovery.step();
	recovery.dispose();
	recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
	const target = new BufferTarget();
	await recovery.execute(target);
	recovery.dispose();
	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const video = (await input.getPrimaryVideoTrack())!;
	let frames = 0;
	for await (const sample of new VideoSampleSink(video).samples()) {
		expect(sample.timestamp).toBeCloseTo(frames / rate, 4);
		frames++;
		sample.close();
	}
	expect(frames).toBe(Math.floor((2.789 - 0.123) * rate));
	expect(await video.computeDuration()).toBeCloseTo(Math.floor(2.666 * rate) / rate, 4);
	await expect(
		RecoverableConversion.init({
			...options,
			conversion: { video: { process: sample => sample } },
		}),
	).rejects.toThrow('callbacks');
	const copied = await RecoverableConversion.init({
		...options,
		conversion: { copy: { mode: 'forced' } },
	});
	copied.dispose();
}, 120_000);

const parityOutputs = async (
	source: Uint8Array,
	conversion: Pick<ConversionOptions, 'video' | 'audio' | 'trim' | 'copy'>,
	format: 'mp4' | 'wav' = 'mp4',
	segmentDuration = 0.4,
) => {
	const saved = memoryStore();
	const recovery = await RecoverableConversion.init({
		source,
		conversion,
		format: format === 'wav' ? new WavOutputFormat() : format,
		segmentDuration,
		store: saved.store,
	});
	const target = new BufferTarget();
	try {
		await recovery.execute(target);
	} finally {
		recovery.dispose();
	}
	using original = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
	const output = new Output({
		format: format === 'wav' ? new WavOutputFormat() : new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const baseline = await Conversion.init({ input: original, output, ...conversion });
	const copiedTracks = baseline._copyPlans.length;
	await baseline.execute();
	return { actual: target.buffer!, expected: output.target.buffer!, copiedTracks };
};

test.each(['transcode', 'mixed'] as const)(
	'%s video variants preserve incumbent input-track-first identity order',
	async (mode) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const canvas = new OffscreenCanvas(320, 320);
		const videos = [
			new CanvasSource(canvas, { codec: 'avc', bitrate: 100_000 }),
			new CanvasSource(canvas, { codec: 'avc', bitrate: 100_000 }),
		];
		videos.forEach((video, i) => output.addVideoTrack(video, { name: `camera-${i}` }));
		await output.start();
		for (let i = 0; i < 8; i++) {
			canvas.getContext('2d')!.fillStyle = i % 2 ? 'blue' : 'red';
			canvas.getContext('2d')!.fillRect(0, 0, 320, 320);
			for (const video of videos) await video.add(i / 10, 0.1);
		}
		await output.finalize();
		const conversion = {
			video: [
				{ width: 320, forceTranscode: mode === 'transcode', codec: 'avc' as const },
				{ width: 160, forceTranscode: true, codec: 'avc' as const },
			],
			audio: { discard: true },
			...(mode === 'mixed' ? { copy: { mode: 'preferred' as const } } : {}),
		};
		const { actual, expected, copiedTracks } = await parityOutputs(
			new Uint8Array(output.target.buffer!),
			conversion,
		);
		expect(copiedTracks).toBe(mode === 'mixed' ? 2 : 0);
		using result = openTestInput(actual);
		using baseline = openTestInput(expected);
		const identity = async (input: Input) =>
			Promise.all(
				(await input.getVideoTracks()).map(async track => ({
					name: await track.getName(),
					width: await track.getDisplayWidth(),
				})),
			);
		expect(await identity(result)).toEqual(await identity(baseline));
		expect(await identity(result)).toEqual([
			{ name: 'camera-0', width: 320 },
			{ name: 'camera-0', width: 160 },
			{ name: 'camera-1', width: 320 },
			{ name: 'camera-1', width: 160 },
		]);
	},
	120_000,
);

const openTestInput = (bytes: ArrayBuffer) =>
	new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

test.each([0, 0.123] as const)(
	'late off-grid CFR video samples match global Conversion grid with trim %s',
	async (trimStart) => {
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const canvas = new OffscreenCanvas(320, 320);
		const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 180_000 });
		output.addVideoTrack(video);
		await output.start();
		for (let i = 0; i < 9; i++) {
			const context = canvas.getContext('2d')!;
			context.fillStyle = `rgb(${20 + i * 25}, 0, 0)`;
			context.fillRect(0, 0, 320, 320);
			await video.add(0.25 + i * 0.1, 0.1);
		}
		await output.finalize();
		const conversion = {
			trim: { start: trimStart, end: 1.15 },
			video: { frameRate: 10, codec: 'avc' as const, bitrate: 180_000 },
		};
		const { actual, expected } = await parityOutputs(
			new Uint8Array(output.target.buffer!),
			conversion,
			'mp4',
			0.35,
		);
		const frames = async (bytes: ArrayBuffer) => {
			using input = openTestInput(bytes);
			const canvas = new OffscreenCanvas(320, 320);
			const context = canvas.getContext('2d')!;
			const result: { timestamp: number; red: number }[] = [];
			for await (using sample of new VideoSampleSink(
				(await input.getPrimaryVideoTrack())!,
			).samples()) {
				sample.draw(context, 0, 0);
				result.push({
					timestamp: sample.timestamp,
					red: context.getImageData(160, 160, 1, 1).data[0]!,
				});
			}
			return result;
		};
		const observed = await frames(actual);
		const reference = await frames(expected);
		expect(observed.length).toBe(reference.length);
		for (let i = 0; i < observed.length; i++) {
			expect(observed[i]!.timestamp).toBeCloseTo(reference[i]!.timestamp, 3);
			expect(observed[i]!.red).toBeCloseTo(reference[i]!.red, -1);
		}
	},
	120_000,
);

test('late WAV audio pads silence to the incumbent output duration and decoded samples', async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const audio = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(audio);
	await output.start();
	using sample = new AudioSample({
		data: new Int16Array(24000).fill(12000),
		format: 's16',
		numberOfChannels: 1,
		sampleRate: 48000,
		timestamp: 0.25,
	});
	await audio.add(sample);
	await output.finalize();
	const { actual, expected } = await parityOutputs(
		new Uint8Array(output.target.buffer!),
		{ trim: { start: 0, end: 0.75 }, audio: { codec: 'pcm-s16' }, video: { discard: true } },
		'wav',
		0.2,
	);
	const decode = async (bytes: ArrayBuffer) => {
		using input = openTestInput(bytes);
		const track = (await input.getPrimaryAudioTrack())!;
		const values: number[] = [];
		for await (using decoded of new AudioSampleSink(track).samples()) {
			const data = new Float32Array(decoded.numberOfFrames);
			decoded.copyTo(data, { planeIndex: 0, format: 'f32' });
			values.push(...data);
		}
		return { duration: await track.computeDuration(), values };
	};
	const reference = await decode(expected);
	const observed = await decode(actual);
	expect(reference.values.length).toBe(36000);
	expect(reference.values.slice(0, 12000).every(value => value === 0)).toBe(true);
	expect(observed.duration).toBeCloseTo(reference.duration, 5);
	expect(observed.values.length).toBe(reference.values.length);
	for (let i = 0; i < reference.values.length; i++) {
		expect(observed.values[i]).toBeCloseTo(reference.values[i]!, 4);
	}
}, 120_000);

test.each([
	'pcm-s16',
	'pcm-s24',
	'pcm-s32',
	'pcm-f32',
	'pcm-f64',
	'pcm-u8',
	'ulaw',
	'alaw',
] as const)(
	'fresh recovery WAV %s output matches uninterrupted Conversion samples',
	async (codec) => {
		const sourceOutput = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const sourceAudio = new AudioSampleSource({ codec: 'pcm-s16' });
		sourceOutput.addAudioTrack(sourceAudio);
		await sourceOutput.start();
		const data = new Int16Array(48000);
		for (let i = 0; i < data.length; i++) {
			data[i] = Math.round(17000 * Math.sin((i * 2 * Math.PI * 330) / 48000));
		}
		using sample = new AudioSample({
			data,
			format: 's16',
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: 0,
		});
		await sourceAudio.add(sample);
		await sourceOutput.finalize();
		const bytes = new Uint8Array(sourceOutput.target.buffer!);
		const conversion = { audio: { codec }, trim: { start: 0.1, end: 0.83 } };
		const saved = memoryStore();
		const options = {
			source: bytes,
			store: saved.store,
			format: new WavOutputFormat(),
			segmentDuration: 0.2,
			conversion,
		};
		let recovery = await RecoverableConversion.init(options);
		let steps = 0;
		while (await recovery.step()) {
			steps++;
			recovery.dispose();
			recovery = await RecoverableConversion.init({
				...options,
				source: bytes.slice(),
				checkpoint: saved.checkpoint(),
			});
		}
		expect(steps).toBe(4);
		const target = new BufferTarget();
		await recovery.assemble(target);
		recovery.dispose();
		using baselineInput = openTestInput(bytes.buffer);
		const baselineOutput = new Output({
			format: new WavOutputFormat(),
			target: new BufferTarget(),
		});
		await (
			await Conversion.init({ input: baselineInput, output: baselineOutput, ...conversion })
		).execute();
		const decode = async (buffer: ArrayBuffer) => {
			using input = openTestInput(buffer);
			const track = (await input.getPrimaryAudioTrack())!;
			expect(await track.getCodec()).toBe(codec);
			const values: number[] = [];
			for await (using decoded of new AudioSampleSink(track).samples()) {
				const floats = new Float32Array(decoded.numberOfFrames);
				decoded.copyTo(floats, { planeIndex: 0, format: 'f32' });
				values.push(...floats);
			}
			return values;
		};
		const actual = await decode(target.buffer!);
		const expected = await decode(baselineOutput.target.buffer!);
		expect(actual.length).toBe(expected.length);
		expect(actual.length).toBe(35040);
		for (let i = 0; i < actual.length; i++) {
			expect(actual[i]).toBeCloseTo(expected[i]!, 5);
		}
	},
	120_000,
);

test('WebM VP9 alpha VFR recovery preserves encoded alpha and arbitrary nonzero trim', async () => {
	const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
	const canvas = new OffscreenCanvas(320, 320);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'rgba(255, 0, 0, 0.5)';
	context.fillRect(0, 0, 320, 320);
	const video = new CanvasSource(canvas, { codec: 'vp9', alpha: 'keep', bitrate: 300_000 });
	output.addVideoTrack(video);
	await output.start();
	for (const [start, end] of [
		[2, 2.2],
		[2.2, 2.7],
		[2.7, 3.1],
		[3.1, 4],
	]) {
		await video.add(start!, end! - start!);
	}
	await output.finalize();
	const source = new Uint8Array(output.target.buffer!);
	const saved = memoryStore();
	const options = {
		source,
		store: saved.store,
		format: 'webm' as const,
		segmentDuration: 0.6,
		conversion: {
			trim: { start: 2.123, end: 3.789 },
			video: {
				codec: 'vp9' as const,
				alpha: 'keep' as const,
				width: 160,
				height: 160,
				fit: 'contain' as const,
				bitrate: 200_000,
			},
		},
	};
	let recovery = await RecoverableConversion.init(options);
	await recovery.step();
	recovery.dispose();
	recovery = await RecoverableConversion.init({ ...options, checkpoint: saved.checkpoint() });
	const target = new BufferTarget();
	await recovery.execute(target);
	recovery.dispose();
	using result = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = (await result.getPrimaryVideoTrack())!;
	expect(await track.getCodec()).toBe('vp9');
	expect(await track.getDisplayWidth()).toBe(160);
	expect(await track.computeDuration()).toBeCloseTo(1.666, 2);
	let packets = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.sideData.alpha?.byteLength).toBeGreaterThan(0);
		packets++;
	}
	expect(packets).toBe(4);
	const decodedCanvas = new OffscreenCanvas(160, 160);
	const decodedContext = decodedCanvas.getContext('2d')!;
	let frames = 0;
	for await (const sample of new VideoSampleSink(track).samples()) {
		decodedContext.clearRect(0, 0, 160, 160);
		sample.draw(decodedContext, 0, 0);
		const alpha = decodedContext.getImageData(80, 80, 1, 1).data[3]!;
		expect(alpha).toBeGreaterThan(100);
		expect(alpha).toBeLessThan(150);
		sample.close();
		frames++;
	}
	expect(frames).toBe(packets);
}, 120_000);
