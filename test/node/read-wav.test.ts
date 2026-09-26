import { test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, Input, FilePathSource, PacketCursor } from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const cursor = new PacketCursor(track);

	for await (const packet of cursor) {
		void packet;
	}
});
