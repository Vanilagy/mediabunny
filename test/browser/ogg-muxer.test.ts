import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget, NullTarget } from '../../src/target.js';
import { AudioBufferSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
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

		const audioSource = new AudioBufferSource({ codec: 'opus', bitrate: 64000 });
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

		const audioSource = new AudioBufferSource({ codec: 'opus', bitrate: 64000 });
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
	const packet = await sink.getFirstPacket();

	expect(packet?.duration).toBe(packetDuration);
});
