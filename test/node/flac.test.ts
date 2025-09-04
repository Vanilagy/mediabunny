import { test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS, Input, FilePathSource } from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	const input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await input.getPrimaryAudioTrack();
});
