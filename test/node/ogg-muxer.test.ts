import { expect, test } from 'vitest';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { assert } from '../../src/misc.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferTarget } from '../../src/target.js';

const OGGS = 0x5367674f; // 'OggS'
const SAMPLE_RATE = 48000;
const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

/** Minimal OpusHead identification header (19 bytes), mono at 48 kHz. */
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

/**
 * Creates an Opus packet holding `frameCount` frames of 20 ms each, using TOC code 3 (arbitrary frame count). This is
 * what Chromium's MediaRecorder emits; the muxer only reads the TOC, so the frame payloads can be zeroed.
 */
const createOpusPacket = (frameCount: number) => {
	const data = new Uint8Array(2 + 3 * frameCount);

	data[0] = (31 << 3) | 0b11; // TOC byte: config 31 (CELT fullband, 20 ms), code 3
	data[1] = frameCount; // CBR, no padding, `frameCount` frames

	return data;
};

/** Reads the granule position of the last page in an Ogg bitstream. */
const readFinalGranulePosition = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let lastPageStart = -1;
	for (let i = 0; i <= bytes.length - 27; i++) {
		if (view.getUint32(i, true) === OGGS) {
			lastPageStart = i;
		}
	}

	assert(lastPageStart !== -1);

	return Number(view.getBigInt64(lastPageStart + 6, true));
};

test('Ogg muxer derives granule positions from multi-frame Opus packets', async () => {
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

	// An Opus packet's duration is the frame duration times the number of frames it carries, not the duration of a
	// single frame. Counting one frame per packet would declare a third of the real duration here.
	const expectedGranulePosition = packetCount * framesPerPacket * SAMPLES_PER_FRAME;
	expect(readFinalGranulePosition(new Uint8Array(output.target.buffer))).toBe(expectedGranulePosition);
});
