import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(outputTrack.codec).toBe('aac');
	expect(outputTrack.sampleRate).toBe(inputTrack.sampleRate);
	expect(outputTrack.numberOfChannels).toBe(inputTrack.numberOfChannels);

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	// video.mp4 is H.264 with has_b_frames=2 and AAC audio.
	// When CTS is lost (bug), PTS == DTS and timestamps are monotonically
	// increasing in decode order. With correct CTS, B-frame PTS is non-monotonic.

	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	// Re-read the fragmented output
	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	// Collect video packet timestamps in decode order
	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps.length).toBeGreaterThan(0);

	// For B-frame content, PTS should NOT be monotonically increasing in decode order.
	// If CTS=0 (the bug), PTS == DTS and timestamps would be monotonically increasing.
	let isMonotonic = true;
	for (let i = 1; i < timestamps.length; i++) {
		if (timestamps[i]! < timestamps[i - 1]!) {
			isMonotonic = false;
			break;
		}
	}

	expect(isMonotonic).toBe(false);
});
