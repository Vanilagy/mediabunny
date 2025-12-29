import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { extractAvcNalUnits } from '../../src/codec-data.js';
import { PacketReader } from '../../src/cursors.js';

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

	const originalReader = new PacketReader(originalVideoTrack);
	const originalFirstPacket = await originalReader.readFirst();
	expect([...originalFirstPacket!.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);

	const originalNalUnits = extractAvcNalUnits(originalFirstPacket!.data, originalDecoderConfig);

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

	const newReader = new PacketReader(newVideoTrack);
	const newFirstPacket = await newReader.readFirst();
	expect([...newFirstPacket!.data.slice(0, 4)]).not.toEqual([0, 0, 0, 1]); // Successfully converted

	const newNalUnits = extractAvcNalUnits(newFirstPacket!.data, newDecoderConfig);
	expect(newNalUnits).toEqual(originalNalUnits); // Content is the same though
});
