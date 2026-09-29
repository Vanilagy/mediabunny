import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget, NullTarget } from '../../src/target.js';
import { AudioBufferSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Quality } from '../../src/encode.js';
import { assert } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS, OggInputFormat } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

test('maximumPageDuration option', async () => {
	const sampleRate = 48000;
	const durationSeconds = 2;
	const audioBuffer = new AudioBuffer({ numberOfChannels: 1, length: sampleRate * durationSeconds, sampleRate });

	// First, create an Ogg file without the maximumPageDuration option
	let pageCountWithoutOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				onPage: () => {
					pageCountWithoutOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64000 }) });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	// Then, create an Ogg file with maximumPageDuration set to 0.1 seconds
	let pageCountWithOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				maximumPageDuration: 0.1,
				onPage: () => {
					pageCountWithOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64000 }) });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	expect(pageCountWithoutOption).toBe(3);
	expect(pageCountWithOption).toBe(23); // It created more pages
});

test('Multi-frame Opus packets', async () => {
	const SAMPLE_RATE = 48000;
	const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

	const createOpusHead = () => {
		const bytes = new Uint8Array(19);
		const view = new DataView(bytes.buffer);

		bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
		bytes[8] = 1; // Version
		bytes[9] = 1; // Channel count
		view.setUint16(10, 312, true); // Pre-skip
		view.setUint32(12, SAMPLE_RATE, true); // Input sample rate
		view.setInt16(16, 0, true); // Output gain
		bytes[18] = 0; // Channel mapping family

		return bytes;
	};

	const createOpusPacket = (frameCount: number) => {
		const data = new Uint8Array(2 + 3 * frameCount);

		data[0] = (31 << 3) | 0b11; // TOC byte: config 31 (CELT fullband, 20 ms), code 3
		data[1] = frameCount; // CBR, no padding, `frameCount` frames

		return data;
	};

	const framesPerPacket = 3;
	const packetCount = 10;
	const packetDuration = (framesPerPacket * SAMPLES_PER_FRAME) / SAMPLE_RATE;

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);

	await output.start();

	for (let i = 0; i < packetCount; i++) {
		await audioSource.add(
			new EncodedPacket(
				createOpusPacket(framesPerPacket),
				'key',
				i * packetDuration,
				packetDuration,
			),
			{
				decoderConfig: {
					codec: 'opus',
					numberOfChannels: 1,
					sampleRate: SAMPLE_RATE,
					description: createOpusHead(),
				},
			},
		);
	}

	audioSource.close();
	await output.finalize();

	assert(output.target.buffer);

	const input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBeInstanceOf(OggInputFormat);

	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	// The first packet is shortened by the pre-skip, so check the second one
	const packet = await sink.getNextPacket(firstPacket);

	expect(packet?.duration).toBe(packetDuration);
});

test('Opus start offset and end trimming survive a demux-mux roundtrip', async () => {
	const SAMPLE_RATE = 48000;
	const PRE_SKIP = 312;
	const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

	const opusHead = new Uint8Array(19);
	const opusHeadView = new DataView(opusHead.buffer);
	opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
	opusHead[8] = 1; // Version
	opusHead[9] = 1; // Channel count
	opusHeadView.setUint16(10, PRE_SKIP, true);
	opusHeadView.setUint32(12, SAMPLE_RATE, true);

	const decoderConfig: AudioDecoderConfig = {
		codec: 'opus',
		numberOfChannels: 1,
		sampleRate: SAMPLE_RATE,
		description: opusHead,
	};

	const mux = async (packets: EncodedPacket[]) => {
		const output = new Output({
			format: new OggOutputFormat(),
			target: new BufferTarget(),
		});

		const audioSource = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(audioSource);
		await output.start();

		for (const packet of packets) {
			await audioSource.add(packet, { decoderConfig });
		}

		audioSource.close();
		await output.finalize();

		assert(output.target.buffer);
		return output.target.buffer;
	};

	const demux = async (buffer: ArrayBuffer) => {
		const input = new Input({
			source: new BufferSource(buffer),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		return { packets, duration: await track.computeDuration() };
	};

	// A stream whose audible part starts at 1 second and ends 312 samples into its final packet
	const startInSamples = SAMPLE_RATE - PRE_SKIP;
	const packetCount = 50;
	const lastPacketDurationInSamples = 312;

	const packets: EncodedPacket[] = [];
	for (let i = 0; i < packetCount; i++) {
		const isLast = i === packetCount - 1;

		packets.push(new EncodedPacket(
			new Uint8Array([31 << 3, 0]), // TOC byte: config 31 (CELT fullband, 20 ms), code 0
			'key',
			(startInSamples + i * SAMPLES_PER_FRAME) / SAMPLE_RATE,
			(isLast ? lastPacketDurationInSamples : SAMPLES_PER_FRAME) / SAMPLE_RATE,
		));
	}

	const first = await demux(await mux(packets));

	const expectedEndInSamples = startInSamples + (packetCount - 1) * SAMPLES_PER_FRAME + lastPacketDurationInSamples;
	expect(first.packets[0]!.timestamp).toBe(startInSamples / SAMPLE_RATE);
	expect(first.duration).toBe(expectedEndInSamples / SAMPLE_RATE);
	expect(first.packets.at(-1)!.duration).toBe(lastPacketDurationInSamples / SAMPLE_RATE);

	const second = await demux(await mux(first.packets));

	const toTiming = (packet: EncodedPacket) => [packet.timestamp, packet.duration];
	expect(second.packets.map(toTiming)).toEqual(first.packets.map(toTiming));
	expect(second.duration).toBe(first.duration);

	// A stream starting at zero has the pre-skip precede it, which is reflected in a shortened first packet
	const fromZero = await demux(await mux(packets.map((packet, i) => new EncodedPacket(
		packet.data,
		'key',
		i * SAMPLES_PER_FRAME / SAMPLE_RATE,
		SAMPLES_PER_FRAME / SAMPLE_RATE,
	))));

	expect(fromZero.packets[0]!.timestamp).toBe(0);
	expect(fromZero.packets[0]!.duration).toBe((SAMPLES_PER_FRAME - PRE_SKIP) / SAMPLE_RATE);
	expect(fromZero.duration).toBe((packetCount * SAMPLES_PER_FRAME - PRE_SKIP) / SAMPLE_RATE);
});
