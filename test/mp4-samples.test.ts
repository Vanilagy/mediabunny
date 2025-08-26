/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { expect, test } from 'vitest';
import { Input } from '../src/input.js';
import { ALL_FORMATS, MP4 } from '../src/input-format.js';
import { StreamSource } from '../src/source.js';
import { open } from 'node:fs/promises';
import { EncodedPacketSink } from '../src/media-sink.js';

const __dirname = new URL('.', import.meta.url).pathname;

const fileHandle = await open(
	`${__dirname}/files/video.mp4`,
	'r',
);

const source = new StreamSource({
	read: async (start, end) => {
		const buffer = Buffer.alloc(end - start);
		await fileHandle.read(buffer, 0, end - start, start);
		return buffer;
	},
	getSize: async () => {
		const { size } = await fileHandle.stat();
		return size;
	},
});

test('mp4 samples', async () => {
	const input = new Input({
		formats: ALL_FORMATS,
		source,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const sink = new EncodedPacketSink(await input.getPrimaryVideoTrack());

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48
	]);
});
