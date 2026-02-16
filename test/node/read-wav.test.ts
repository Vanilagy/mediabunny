import { test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS, EncodedPacketSink, Input, FilePathSource } from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should handle WAV file with ID3 chunk without slicing error', async () => {
	const filePath = path.join(__dirname, '..', 'public/slicing-error.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});
