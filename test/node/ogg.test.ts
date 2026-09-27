import { beforeAll, expect, test } from 'vitest';
import { AudioCodec } from '../../src/codec.js';
import { CustomAudioEncoder, registerEncoder } from '../../src/custom-coder.js';
import { Quality, type AudioTransformOptions } from '../../src/encode.js';
import { Input } from '../../src/input.js';
import { OggInputFormat } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { AudioSampleSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { computeOggPageCrc, OGGS } from '../../src/ogg/ogg-misc.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample } from '../../src/sample.js';
import { BufferSource, FilePathSource, ReadableStreamSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

const OPUS_SAMPLE_RATE = 48000;
const OPUS_PRE_SKIP = 312;
const ALTERNATE_OPUS_PRE_SKIP = 120;
const OPUS_PACKET_DURATION_IN_SAMPLES = 960;
const ACTUAL_PCM_DURATION_IN_SAMPLES = 1400;
const TWO_PACKET_ENCODER_BITRATE = 123456;
const ONE_PACKET_ENCODER_BITRATE = 123457;
const FULL_PAGE_ENCODER_BITRATE = 123458;
const FULL_PAGE_PACKET_COUNT = 255;
const OGG_SERIAL_NUMBER = 0x12345678;

const createOpusHead = (preSkip = OPUS_PRE_SKIP, inputSampleRate = OPUS_SAMPLE_RATE) => {
	const bytes = new Uint8Array(19);
	const view = new DataView(bytes.buffer);

	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // 'OpusHead'
	bytes[8] = 1; // Version
	bytes[9] = 1; // Channel count
	view.setUint16(10, preSkip, true);
	view.setUint32(12, inputSampleRate, true);

	return bytes;
};

const createOpusTags = () => {
	const bytes = new Uint8Array(16);
	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // 'OpusTags'
	// Empty vendor string and no comments
	return bytes;
};

const createOpusAudioPacket = () => new Uint8Array([
	(31 << 3) | 0b00, // TOC: one 20 ms frame
	0,
]);

type OggPageOptions = {
	headerType: number;
	granulePosition: number;
	sequenceNumber: number;
	packets: Uint8Array[];
};

type OpusAudioPageOptions = {
	headerType: number;
	granulePosition: number;
	packetCount: number;
};

const createOggPage = (options: OggPageOptions) => {
	const lacingValues: number[] = [];
	for (const packet of options.packets) {
		let remainingLength = packet.byteLength;
		while (remainingLength >= 255) {
			lacingValues.push(255);
			remainingLength -= 255;
		}
		lacingValues.push(remainingLength);
	}

	const dataSize = options.packets.reduce((sum, packet) => sum + packet.byteLength, 0);
	const bytes = new Uint8Array(27 + lacingValues.length + dataSize);
	const view = new DataView(bytes.buffer);

	view.setUint32(0, OGGS, true);
	view.setUint8(5, options.headerType);
	view.setBigInt64(6, BigInt(options.granulePosition), true);
	view.setUint32(14, OGG_SERIAL_NUMBER, true);
	view.setUint32(18, options.sequenceNumber, true);
	view.setUint8(26, lacingValues.length);
	bytes.set(lacingValues, 27);

	let offset = 27 + lacingValues.length;
	for (const packet of options.packets) {
		bytes.set(packet, offset);
		offset += packet.byteLength;
	}

	view.setUint32(22, computeOggPageCrc(bytes), true);
	return bytes;
};

const concatenateBytes = (...chunks: Uint8Array[]) => {
	const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
};

const createOpusStream = (options: {
	audioPages: OpusAudioPageOptions[];
	preSkip?: number;
	inputSampleRate?: number;
}) => concatenateBytes(
	createOggPage({
		headerType: 0x02,
		granulePosition: 0,
		sequenceNumber: 0,
		packets: [createOpusHead(options.preSkip, options.inputSampleRate)],
	}),
	createOggPage({
		headerType: 0,
		granulePosition: 0,
		sequenceNumber: 1,
		packets: [createOpusTags()],
	}),
	...options.audioPages.map((page, index) => createOggPage({
		headerType: page.headerType,
		granulePosition: page.granulePosition,
		sequenceNumber: index + 2,
		packets: Array.from({ length: page.packetCount }, createOpusAudioPacket),
	})),
);

const createMinimalOpusStream = (options: OpusAudioPageOptions & {
	preSkip?: number;
	inputSampleRate?: number;
}) => createOpusStream({
	audioPages: [options],
	preSkip: options.preSkip,
	inputSampleRate: options.inputSampleRate,
});

const createPositiveOffsetTwoPageOpusStream = () => createOpusStream({
	preSkip: 0,
	audioPages: [{
		headerType: 0,
		granulePosition: 1060,
		packetCount: 1,
	}, {
		headerType: 0x04,
		granulePosition: 1560,
		packetCount: 1,
	}],
});

const readAudioPackets = async (bytes: Uint8Array) => {
	using input = new Input({
		source: new BufferSource(bytes),
		formats: [new OggInputFormat()],
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return packets;
};

type EncoderFeed = {
	bitrate: number;
	receivedSamples: {
		frames: number;
		rate: number;
	}[];
};

const encoderFeeds: EncoderFeed[] = [];

class FixedPacketOpusEncoder extends CustomAudioEncoder {
	private hasInput = false;
	private feed!: EncoderFeed;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig) {
		return codec === 'opus'
			&& (
				config.bitrate === TWO_PACKET_ENCODER_BITRATE
				|| config.bitrate === ONE_PACKET_ENCODER_BITRATE
				|| config.bitrate === FULL_PAGE_ENCODER_BITRATE
			);
	}

	init() {
		const { bitrate } = this.config;
		assert(bitrate !== undefined);
		this.feed = {
			bitrate,
			receivedSamples: [],
		};
		encoderFeeds.push(this.feed);
	}

	encode(audioSample: AudioSample) {
		this.feed.receivedSamples.push({
			frames: audioSample.numberOfFrames,
			rate: audioSample.sampleRate,
		});
		this.hasInput ||= audioSample.numberOfFrames > 0;
	}

	flush() {
		if (!this.hasInput) {
			return;
		}

		const packetCount = this.config.bitrate === ONE_PACKET_ENCODER_BITRATE
			? 1
			: this.config.bitrate === FULL_PAGE_ENCODER_BITRATE
				? FULL_PAGE_PACKET_COUNT
				: 2;
		const preSkip = packetCount === 1 ? ALTERNATE_OPUS_PRE_SKIP : OPUS_PRE_SKIP;

		for (let i = 0; i < packetCount; i++) {
			let metadata: EncodedAudioChunkMetadata | undefined;
			if (i === 0) {
				metadata = {
					decoderConfig: {
						codec: 'opus',
						numberOfChannels: 1,
						sampleRate: this.config.sampleRate,
						description: createOpusHead(preSkip, this.config.sampleRate),
					},
				};
			}

			this.onPacket(
				new EncodedPacket(
					createOpusAudioPacket(),
					'key',
					i * OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE,
					OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE,
				),
				metadata,
			);
		}
	}

	close() {}
}

beforeAll(() => {
	registerEncoder(FixedPacketOpusEncoder);
});

const captureEosGranule = () => {
	let eosGranulePosition: bigint | null = null;
	let eosLacingValueCount: number | null = null;
	const output = new Output({
		format: new OggOutputFormat({
			onPage: (bytes) => {
				if (bytes[5]! & 0x04) {
					const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
					eosGranulePosition = view.getBigInt64(6, true);
					eosLacingValueCount = view.getUint8(26);
				}
			},
		}),
		target: new BufferTarget(),
	});

	return {
		output,
		getEosGranulePosition: () => eosGranulePosition,
		getEosLacingValueCount: () => eosLacingValueCount,
	};
};

const createSilentAudioSample = (options: {
	frameCount: number;
	sampleRate: number;
	timestamp: number;
}) => new AudioSample({
	data: new Float32Array(options.frameCount),
	format: 'f32',
	numberOfChannels: 1,
	sampleRate: options.sampleRate,
	timestamp: options.timestamp,
});

const writeRawOpus = async (options: {
	sampleRate: number;
	bitrate: number;
	samples: { frameCount: number; timestamp: number }[];
	transform?: AudioTransformOptions;
}) => {
	const encoderFeedStartIndex = encoderFeeds.length;
	const { output, getEosGranulePosition, getEosLacingValueCount } = captureEosGranule();
	const source = new AudioSampleSource({
		codec: 'opus',
		quality: new Quality({ bitrate: options.bitrate }),
		transform: options.transform,
	});
	output.addAudioTrack(source);

	await output.start();
	for (const sampleOptions of options.samples) {
		using sample = createSilentAudioSample({
			frameCount: sampleOptions.frameCount,
			sampleRate: options.sampleRate,
			timestamp: sampleOptions.timestamp,
		});
		await source.add(sample);
	}
	await output.finalize();

	const eosGranulePosition = getEosGranulePosition();
	assert(eosGranulePosition !== null);
	return {
		granulePosition: eosGranulePosition,
		lacingValueCount: getEosLacingValueCount(),
		encoderFeeds: encoderFeeds.slice(encoderFeedStartIndex),
	};
};

test('Ogg demuxing clips the full EOS-page Opus packet sequence to pre-skip and GP 1712', async () => {
	const packets = await readAudioPackets(createMinimalOpusStream({
		headerType: 0x04,
		granulePosition: OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES,
		packetCount: 2,
	}));

	expect(packets).toHaveLength(2);
	expect(packets[0]!.timestamp).toBe(0);
	expect(packets[0]!.duration).toBe((OPUS_PACKET_DURATION_IN_SAMPLES - OPUS_PRE_SKIP) / OPUS_SAMPLE_RATE);
	expect(packets[1]!.timestamp).toBe((OPUS_PACKET_DURATION_IN_SAMPLES - OPUS_PRE_SKIP) / OPUS_SAMPLE_RATE);
	expect(packets[1]!.duration).toBe(
		(ACTUAL_PCM_DURATION_IN_SAMPLES - OPUS_PACKET_DURATION_IN_SAMPLES + OPUS_PRE_SKIP) / OPUS_SAMPLE_RATE,
	);
});

test('Ogg packets entirely removed by EOS trim stay at the declared end', async () => {
	using input = new Input({
		source: new BufferSource(createMinimalOpusStream({
			headerType: 0x04, granulePosition: OPUS_PRE_SKIP + 1400, packetCount: 3,
		})),
		formats: [new OggInputFormat()],
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets = [];
	for await (const packet of sink.packets()) packets.push(packet);
	expect(packets.map(packet => [packet.timestamp, packet.duration])).toEqual([
		[0, 648 / OPUS_SAMPLE_RATE],
		[648 / OPUS_SAMPLE_RATE, 752 / OPUS_SAMPLE_RATE],
		[1400 / OPUS_SAMPLE_RATE, 0],
	]);
	expect(await track.computeDuration()).toBe(1400 / OPUS_SAMPLE_RATE);
	expect((await sink.getPacket(Infinity))!.timestamp).toBe(1400 / OPUS_SAMPLE_RATE);
});

test('Ogg demuxing reports 100 samples for one Opus packet with pre-skip 312 and EOS GP 412', async () => {
	const packets = await readAudioPackets(createMinimalOpusStream({
		headerType: 0x04,
		granulePosition: OPUS_PRE_SKIP + 100,
		packetCount: 1,
	}));

	expect(packets).toHaveLength(1);
	expect(packets[0]!.timestamp).toBe(0);
	expect(packets[0]!.duration).toBe(100 / OPUS_SAMPLE_RATE);
});

test('Ogg demuxing keeps nominal durations for an RFC-conforming non-EOS GP 1920 page', async () => {
	const packets = await readAudioPackets(createMinimalOpusStream({
		headerType: 0,
		granulePosition: 2 * OPUS_PACKET_DURATION_IN_SAMPLES,
		packetCount: 2,
	}));

	expect(packets).toHaveLength(2);
	expect(packets[0]!.timestamp).toBe(0);
	expect(packets[0]!.duration).toBe(OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE);
	expect(packets[1]!.timestamp).toBe((OPUS_PACKET_DURATION_IN_SAMPLES - OPUS_PRE_SKIP) / OPUS_SAMPLE_RATE);
	expect(packets[1]!.duration).toBe(OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE);
});

test('Ogg demuxing does not EOS-trim explicitly malformed non-EOS GP 1712 input', async () => {
	const packets = await readAudioPackets(createMinimalOpusStream({
		headerType: 0,
		granulePosition: OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES,
		packetCount: 2,
	}));

	expect(packets).toHaveLength(2);
	expect(packets[0]!.duration).toBe(OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE);
	expect(packets[1]!.duration).toBe(OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE);
});

test('Ogg demuxing preserves stream origin across non-EOS GP 1060 to EOS GP 1560', async () => {
	const packets = await readAudioPackets(createPositiveOffsetTwoPageOpusStream());

	expect(packets).toHaveLength(2);
	expect(packets.map(packet => [
		packet.timestamp * OPUS_SAMPLE_RATE,
		packet.duration * OPUS_SAMPLE_RATE,
	])).toEqual([
		[100, 960],
		[1060, 500],
	]);
});

test('Ogg demuxing random access honors the positive 100-sample stream origin', async () => {
	const bytes = createPositiveOffsetTwoPageOpusStream();
	const paddedBytes = new Uint8Array(bytes.byteLength + 1024);
	paddedBytes.set(bytes);
	using input = new Input({
		source: new ReadableStreamSource(new ReadableStream({
			start(controller) {
				// Keep this source unsized so getPacket exercises the sequential random-access implementation.
				controller.enqueue(paddedBytes);
			},
		})),
		formats: [new OggInputFormat()],
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	expect(await sink.getPacket(0)).toBeNull();
	const secondPacket = await sink.getPacket(1060 / OPUS_SAMPLE_RATE);
	assert(secondPacket);
	expect(secondPacket.timestamp * OPUS_SAMPLE_RATE).toBe(1060);
	expect(secondPacket.duration * OPUS_SAMPLE_RATE).toBe(500);
});

test('Ogg seeking terminates for a tiny two-page stream', async () => {
	using input = new Input({
		source: new BufferSource(createPositiveOffsetTwoPageOpusStream()),
		formats: [new OggInputFormat()],
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toBe(1560 / OPUS_SAMPLE_RATE);
});

test('Ogg muxing writes EOS GP 1712 for 1400 zero-based encoder-fed frames', async () => {
	const { granulePosition } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: ACTUAL_PCM_DURATION_IN_SAMPLES, timestamp: 0 }],
	});

	expect(granulePosition).toBe(BigInt(OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES));
});

test('Ogg muxing ignores a nonzero source start and writes EOS GP 1712 for 1400 fed frames', async () => {
	const { granulePosition } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: ACTUAL_PCM_DURATION_IN_SAMPLES, timestamp: 1 }],
	});

	expect(granulePosition).toBe(BigInt(OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES));
});

test('Ogg muxing counts overlapping samples in feed order and writes EOS GP 1712', async () => {
	const { granulePosition } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [
			{ frameCount: 700, timestamp: 0 },
			{ frameCount: 700, timestamp: 0 },
		],
	});

	expect(granulePosition).toBe(BigInt(OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES));
});

test('Ogg muxing counts synthesized silence passed to the encoder and writes EOS GP 1712', async () => {
	const { granulePosition } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [
			{ frameCount: 500, timestamp: 0 },
			{ frameCount: 500, timestamp: 900 / OPUS_SAMPLE_RATE },
		],
	});

	expect(granulePosition).toBe(BigInt(OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES));
});

test('Ogg muxing is immune to a transform.process Unix-scale timestamp and writes EOS GP 1712', async () => {
	const { granulePosition } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: ACTUAL_PCM_DURATION_IN_SAMPLES, timestamp: 0 }],
		transform: {
			process: (sample) => {
				sample.setTimestamp(1_700_000_000);
				return sample;
			},
		},
	});

	expect(granulePosition).toBe(BigInt(OPUS_PRE_SKIP + ACTUAL_PCM_DURATION_IN_SAMPLES));
});

test('Ogg muxing maps 441 fed frames at 44.1 kHz to 480 granules plus pre-skip 120 (GP 600)', async () => {
	const { granulePosition } = await writeRawOpus({
		sampleRate: 44100,
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: 441, timestamp: 0 }],
	});

	expect(granulePosition).toBe(600n);
});

test('Ogg muxing counts post-transform drop/split frames [200, 300] at 48 kHz and writes GP 620', async () => {
	const { granulePosition, encoderFeeds: newEncoderFeeds } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		samples: [
			{ frameCount: 400, timestamp: 0 },
			{ frameCount: 600, timestamp: 400 / OPUS_SAMPLE_RATE },
		],
		transform: {
			process: (sample) => {
				if (sample.numberOfFrames === 400) {
					return null;
				}

				return [
					createSilentAudioSample({
						frameCount: 200,
						sampleRate: sample.sampleRate,
						timestamp: sample.timestamp,
					}),
					createSilentAudioSample({
						frameCount: 300,
						sampleRate: sample.sampleRate,
						timestamp: sample.timestamp + 200 / sample.sampleRate,
					}),
				];
			},
		},
	});

	expect(newEncoderFeeds).toEqual([{
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		receivedSamples: [
			{ frames: 200, rate: OPUS_SAMPLE_RATE },
			{ frames: 300, rate: OPUS_SAMPLE_RATE },
		],
	}]);
	expect(granulePosition).toBe(620n);
});

test('Ogg muxing rejects a transform.process sample rate change from 48 kHz to 44.1 kHz', async () => {
	await expect(writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [
			{ frameCount: 960, timestamp: 0 },
			{ frameCount: 960, timestamp: 960 / OPUS_SAMPLE_RATE },
		],
		transform: {
			process: (sample) => {
				if (sample.timestamp === 0) {
					return sample;
				}

				return createSilentAudioSample({
					frameCount: 882,
					sampleRate: 44100,
					timestamp: sample.timestamp,
				});
			},
		},
	})).rejects.toThrow('Audio sample rate must remain constant after processing. Expected 48000 Hz, got 44100 Hz.');
});

test('Ogg muxing counts six post-resampler frames at 48 kHz from five 44.1 kHz frames and writes GP 126', async () => {
	const { granulePosition, encoderFeeds: newEncoderFeeds } = await writeRawOpus({
		sampleRate: 44100,
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: 5, timestamp: 0 }],
		transform: { sampleRate: OPUS_SAMPLE_RATE },
	});

	expect(newEncoderFeeds).toEqual([{
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		receivedSamples: [{ frames: 6, rate: OPUS_SAMPLE_RATE }],
	}]);
	expect(granulePosition).toBe(126n);
});

test('Ogg muxing isolates encoder-feed counts for two sources at EOS GPs 420 and 1312', async () => {
	const encoderFeedStartIndex = encoderFeeds.length;
	const eosGranules = new Map<object, bigint>();
	const output = new Output({
		format: new OggOutputFormat({
			onPage: (bytes, _start, source) => {
				if (bytes[5]! & 0x04) {
					const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
					eosGranules.set(source, view.getBigInt64(6, true));
				}
			},
		}),
		target: new BufferTarget(),
	});
	const firstSource = new AudioSampleSource({
		codec: 'opus',
		quality: new Quality({ bitrate: ONE_PACKET_ENCODER_BITRATE }),
	});
	const secondSource = new AudioSampleSource({
		codec: 'opus',
		quality: new Quality({ bitrate: TWO_PACKET_ENCODER_BITRATE }),
	});
	output.addAudioTrack(firstSource);
	output.addAudioTrack(secondSource);

	await output.start();
	using firstSample = createSilentAudioSample({
		frameCount: 300,
		sampleRate: OPUS_SAMPLE_RATE,
		timestamp: 0,
	});
	using secondSample = createSilentAudioSample({
		frameCount: 1000,
		sampleRate: OPUS_SAMPLE_RATE,
		timestamp: 0,
	});
	await firstSource.add(firstSample);
	await secondSource.add(secondSample);
	await output.finalize();

	expect(encoderFeeds.slice(encoderFeedStartIndex)).toEqual([{
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		receivedSamples: [{ frames: 300, rate: OPUS_SAMPLE_RATE }],
	}, {
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		receivedSamples: [{ frames: 1000, rate: OPUS_SAMPLE_RATE }],
	}]);
	expect(eosGranules.get(firstSource)).toBe(420n);
	expect(eosGranules.get(secondSource)).toBe(1312n);
});

test('Ogg muxing clamps a 412-sample computed end to the final packet start GP 960', async () => {
	const { granulePosition, encoderFeeds: newEncoderFeeds } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: 100, timestamp: 0 }],
	});

	expect(newEncoderFeeds).toEqual([{
		bitrate: TWO_PACKET_ENCODER_BITRATE,
		receivedSamples: [{ frames: 100, rate: OPUS_SAMPLE_RATE }],
	}]);
	expect(granulePosition).toBe(960n);
});

test('Ogg muxing rounds fractional 44.1-to-48 kHz conversions to nearest: GPs 121 and 131', async () => {
	const oneFrameResult = await writeRawOpus({
		sampleRate: 44100,
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: 1, timestamp: 0 }],
	});
	const tenFrameResult = await writeRawOpus({
		sampleRate: 44100,
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		samples: [{ frameCount: 10, timestamp: 0 }],
	});

	expect(oneFrameResult.encoderFeeds).toEqual([{
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		receivedSamples: [{ frames: 1, rate: 44100 }],
	}]);
	expect(tenFrameResult.encoderFeeds).toEqual([{
		bitrate: ONE_PACKET_ENCODER_BITRATE,
		receivedSamples: [{ frames: 10, rate: 44100 }],
	}]);
	expect(oneFrameResult.granulePosition).toBe(121n); // round(1.088...) = 1; ceil would produce GP 122
	expect(tenFrameResult.granulePosition).toBe(131n); // round(10.884...) = 11; floor would produce GP 130
});

test('Ogg muxing keeps EncodedAudioPacketSource at nominal EOS GP 1920 without trim metadata', async () => {
	const { output, getEosGranulePosition } = captureEosGranule();
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(
			createOpusAudioPacket(),
			'key',
			0,
			OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE,
		),
		{
			decoderConfig: {
				codec: 'opus',
				numberOfChannels: 1,
				sampleRate: OPUS_SAMPLE_RATE,
				description: createOpusHead(),
			},
		},
	);
	await source.add(new EncodedPacket(
		createOpusAudioPacket(),
		'key',
		OPUS_PACKET_DURATION_IN_SAMPLES / OPUS_SAMPLE_RATE,
		752 / OPUS_SAMPLE_RATE,
	));
	await output.finalize();

	expect(getEosGranulePosition()).toBe(BigInt(2 * OPUS_PACKET_DURATION_IN_SAMPLES));
});

test('Ogg Vorbis EOS excludes final encoder fill', async () => {
	using input = new Input({
		source: new FilePathSource(new URL('../public/vorbis-eos.ogg', import.meta.url).pathname),
		formats: [new OggInputFormat()],
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);
	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
		if (packets.length === 4) break;
	}
	const lastPacket = packets[packets.length - 1]!;
	const frameCount = Math.round((lastPacket.timestamp + lastPacket.duration) * decoderConfig.sampleRate) - 1;

	class FixedVorbisEncoder extends CustomAudioEncoder {
		static override supports(codec: AudioCodec) { return codec === 'vorbis'; }
		init() {}
		encode() {}
		flush() {
			for (const packet of packets) this.onPacket(packet, { decoderConfig: decoderConfig! });
		}

		close() {}
	}
	registerEncoder(FixedVorbisEncoder);
	const { output, getEosGranulePosition } = captureEosGranule();
	const source = new AudioSampleSource({ codec: 'vorbis', quality: new Quality({ bitrate: 128000 }) });
	output.addAudioTrack(source);
	await output.start();
	using sample = new AudioSample({
		data: new Float32Array(frameCount * decoderConfig.numberOfChannels),
		format: 'f32',
		numberOfChannels: decoderConfig.numberOfChannels,
		sampleRate: decoderConfig.sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();
	expect(getEosGranulePosition()).toBe(BigInt(frameCount));
});

test('Ogg muxing writes the current EOS GP when the final packet completes lacing value 255', async () => {
	const finalPacketEndInSamples = FULL_PAGE_PACKET_COUNT * OPUS_PACKET_DURATION_IN_SAMPLES;
	const { granulePosition, lacingValueCount } = await writeRawOpus({
		sampleRate: OPUS_SAMPLE_RATE,
		bitrate: FULL_PAGE_ENCODER_BITRATE,
		samples: [{ frameCount: finalPacketEndInSamples - OPUS_PRE_SKIP, timestamp: 0 }],
	});

	expect(lacingValueCount).toBe(FULL_PAGE_PACKET_COUNT);
	expect(granulePosition).toBe(BigInt(finalPacketEndInSamples));
});
