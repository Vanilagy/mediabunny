import { expect, test } from 'vitest';
import path from 'node:path';
import { ALL_FORMATS, Input, FilePathSource, EncodedPacketSink } from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should be able to get metadata and packets from a .FLAC file', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	const input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toEqual(19.714285714285715);
	expect(await track.getDecoderConfig()).toEqual({
		codec: 'flac',
		numberOfChannels: 2,
		sampleRate: 44100,
		description: new Uint8Array([
			0x66, 0x4c, 0x61, 0x43,
			16, 0, 16, 0, 0, 6, 45, 0, 37, 173, 10, 196, 66, 240, 0, 13, 68, 24, 85,
			22, 231, 0, 113, 139, 185, 1, 33, 54, 155, 80, 241, 191, 203, 112]),
	});
	expect(await track.getCodecParameterString()).toEqual('flac');
	expect(track.timeResolution).toEqual(44100);
	expect(await input.getMimeType()).toEqual('audio/flac');

	const sink = new EncodedPacketSink(track);
	for await (const sample of sink.packets()) {
		console.log(sample.timestamp, sample.duration);
	}
});
