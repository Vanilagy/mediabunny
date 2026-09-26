import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleCursor, PacketCursor } from '../../src/cursors.js';

test('ADTS demuxing', async () => {
	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getSampleRate()).toBe(44100);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);

	const decoderConfig = await audioTrack.getDecoderConfig();
	assert(decoderConfig);

	expect(decoderConfig).toEqual({
		codec: 'mp4a.40.2',
		sampleRate: 44100,
		numberOfChannels: 2,
		// No description
	});

	const cursor = new PacketCursor(audioTrack);

	const firstPacket = await cursor.seekToFirst();
	assert(firstPacket);

	expect(firstPacket.data[0]).toBe(0xff);
	expect((firstPacket.data[1]! & 0xf0)).toBe(0xf0); // Second nibble is also all 1s
	expect(firstPacket.type).toBe('key');

	const secondPacket = await cursor.next();
	assert(secondPacket);

	expect(secondPacket.data[0]).toBe(0xff);
	expect((secondPacket.data[1]! & 0xf0)).toBe(0xf0);
	expect(secondPacket.type).toBe('key');
});

test('ADTS packet decodability', async () => {
	using input = new Input({
		source: new UrlSource('/sample3.aac'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const cursor = new AudioSampleCursor(audioTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of cursor) {
		count++;
	}

	expect(count).toBeGreaterThan(0);
});
