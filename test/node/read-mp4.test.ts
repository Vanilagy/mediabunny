import { expect, test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS, MP4, Input, FilePathSource, PacketCursor } from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const cursor = new PacketCursor(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of cursor) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});
