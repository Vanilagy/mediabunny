import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import fs from 'node:fs';
import { ALL_FORMATS, MP3 } from '../../src/input-format.js';
import { PacketReader } from '../../src/cursors.js';
import { InputAudioTrack } from '../../src/input-track.js';
import { assert } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('MP3 demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/AudacityTest1.mp3')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP3);
	expect(await input.getMimeType()).toBe('audio/mpeg');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack).toBeInstanceOf(InputAudioTrack);

	expect(audioTrack.numberOfChannels).toBe(1);
	expect(audioTrack.sampleRate).toBe(44100);

	const decoderConfig = await audioTrack.getDecoderConfig();
	expect(decoderConfig!.codec).toBe('mp3');
	expect(decoderConfig!.numberOfChannels).toBe(audioTrack.numberOfChannels);
	expect(decoderConfig!.sampleRate).toBe(audioTrack.sampleRate);
	expect(decoderConfig!.description).toBeUndefined();

	const reader = new PacketReader(audioTrack);
	const first = await reader.readFirst();
	expect(first).not.toBe(null);
	expect(first!.timestamp).toBe(0);
	expect(first!.data[0]).toBe(255);

	const next = await reader.readNext(first!);
	expect(next).not.toBe(null);
	expect(next!.timestamp).toBeCloseTo(first!.timestamp + first!.duration);
	expect(next!.sequenceNumber).toBeGreaterThan(first!.sequenceNumber);

	const nextKey = await reader.readNextKey(first!);
	expect(nextKey).not.toBe(null);
	expect(nextKey!.timestamp).toBe(next!.timestamp);

	const seeked = await reader.readAt(1);
	expect(seeked).not.toBe(null);
	expect(seeked!.timestamp).toBeGreaterThan(0.9);
	expect(seeked!.timestamp).toBeLessThanOrEqual(1);
	expect(seeked!.sequenceNumber).toBeGreaterThan(next!.sequenceNumber);

	const seekedKey = await reader.readKeyAt(1);
	expect(seekedKey).not.toBe(null);
	expect(seeked!.sequenceNumber).toBe(seeked!.sequenceNumber);

	const last = await reader.readAt(Infinity);
	expect(last).not.toBe(null);
	expect(last!.sequenceNumber).toBeGreaterThan(seeked!.sequenceNumber);

	const afterLast = await reader.readNext(last!);
	expect(afterLast).toBe(null);

	const firstTimestamp = await audioTrack.getFirstTimestamp();
	expect(firstTimestamp).toBe(0);

	const duration = await audioTrack.computeDuration();
	expect(duration).toBe(last!.timestamp + last!.duration);
});

test('Sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/AudacityTest1.mp3'))),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const reader = new PacketReader(audioTrack);

	let current = reader.readFirst() as EncodedPacket | null;
	let count = 0;
	while (current) {
		current = reader.readNext(current) as EncodedPacket | null;
		count++;
	}

	expect(count).toBe(475);
});
