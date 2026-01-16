import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { iterateAvcNalUnits } from '../../src/codec-data.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Annex B to length-prefixed conversion, MP4', async () => {
	using originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/annex-b-avc.mkv')),
		formats: ALL_FORMATS,
	});
	const originalVideoTrack = (await originalInput.getPrimaryVideoTrack())!;
	const originalDecoderConfig = (await originalVideoTrack.getDecoderConfig())!;
	expect(originalDecoderConfig.description).toBeUndefined();
	expect(originalVideoTrack.codec).toBe('avc');

	const originalSink = new EncodedPacketSink(originalVideoTrack);
	const originalFirstPacket = await originalSink.getFirstPacket();
	expect([...originalFirstPacket!.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

	const originalNalUnits = [...iterateAvcNalUnits(originalFirstPacket!.data, originalDecoderConfig)]
		.map(loc => originalFirstPacket!.data.subarray(loc.offset, loc.offset + loc.length));

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input: originalInput, output });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const newVideoTrack = (await newInput.getPrimaryVideoTrack())!;
	const newDecoderConfig = (await newVideoTrack.getDecoderConfig())!;
	expect(newDecoderConfig.description).toBeDefined();
	expect(newVideoTrack.codec).toBe('avc');

	const newSink = new EncodedPacketSink(newVideoTrack);
	const newFirstPacket = await newSink.getFirstPacket();
	expect([...newFirstPacket!.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]); // Successfully converted

	const newNalUnits = [...iterateAvcNalUnits(newFirstPacket!.data, newDecoderConfig)]
		.map(loc => newFirstPacket!.data.subarray(loc.offset, loc.offset + loc.length));
	expect(newNalUnits).toEqual(originalNalUnits); // Content is the same though
});
