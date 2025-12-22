import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import fs from 'node:fs';
import { ADTS, ALL_FORMATS, MP3, MP4, OGG, QTFF, WAVE, WEBM } from '../../src/input-format.js';
import { PacketReader } from '../../src/cursors.js';
import { InputAudioTrack, InputTrack } from '../../src/input-track.js';
import { assert } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = new URL('.', import.meta.url).pathname;

const testBasicPacketReading = async (track: InputTrack) => {
	const reader = new PacketReader(track);
	const first = await reader.readFirst();
	expect(first).not.toBe(null);
	expect(first!.timestamp).toBe(0);

	const next = await reader.readNext(first!);
	expect(next).not.toBe(null);
	expect(next!.timestamp).toBeCloseTo(first!.timestamp + first!.duration);
	expect(next!.sequenceNumber).toBeGreaterThan(first!.sequenceNumber);

	const nextKey = await reader.readNextKey(first!);
	expect(nextKey).not.toBe(null);
	expect(nextKey!.type).toBe('key');
	expect(nextKey!.timestamp).toBeGreaterThanOrEqual(next!.timestamp);

	const seeked = await reader.readAt(1);
	expect(seeked).not.toBe(null);
	expect(seeked!.timestamp).toBeGreaterThan(0.9);
	expect(seeked!.timestamp).toBeLessThanOrEqual(1);
	expect(seeked!.sequenceNumber).toBeGreaterThan(next!.sequenceNumber);

	const seekedKey = await reader.readKeyAt(1);
	expect(seekedKey).not.toBe(null);
	expect(seekedKey!.type).toBe('key');
	expect(seekedKey!.sequenceNumber).toBeGreaterThanOrEqual(first!.sequenceNumber);
	expect(seekedKey!.sequenceNumber).toBeLessThanOrEqual(seeked!.sequenceNumber);

	const last = await reader.readAt(Infinity);
	expect(last).not.toBe(null);
	expect(last!.sequenceNumber).toBeGreaterThan(seeked!.sequenceNumber);

	const afterLast = await reader.readNext(last!);
	expect(afterLast).toBe(null);
};

const testSyncPacketReading = (track: InputTrack) => {
	const reader = new PacketReader(track);

	const seeked = reader.readAt(1) as EncodedPacket | null;
	expect(seeked).toBeInstanceOf(EncodedPacket);

	let current = reader.readFirst() as EncodedPacket | null;
	expect(current).toBeInstanceOf(EncodedPacket);

	let count = 0;
	while (current) {
		current = reader.readNext(current) as EncodedPacket | null;
		expect(current instanceof EncodedPacket || current === null).toBe(true);
		count++;
	}

	expect(count).toBeGreaterThan(0);

	return count;
};

test('Regular ISOBMFF demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.mov')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(QTFF);
	expect(await input.getMimeType()).toBe('video/quicktime; codecs="avc1.4d4029, mp4a.40.2"');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);

	await testBasicPacketReading(videoTrack);

	expect(await input.computeDuration()).toBeCloseTo(5.041666666666667);
});

test('Fragmented ISOBMFF demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/frag-buck-bunny.mp4')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640014, mp4a.40.2"');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);

	await testBasicPacketReading(videoTrack);

	expect(await input.computeDuration()).toBeCloseTo(5);
});

test('Regular ISOBMFF sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/trim-buck-bunny.mov'))),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const count = testSyncPacketReading(videoTrack);
	expect(count).toBe(121);
});

test('Fragmented ISOBMFF sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/frag-buck-bunny.mp4'))),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const count = testSyncPacketReading(videoTrack);
	expect(count).toBe(120);
});

test('Matroska demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.webm')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(WEBM);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	await testBasicPacketReading(videoTrack);

	expect(await input.computeDuration()).toBeCloseTo(5);
});

test('Matroska sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/trim-buck-bunny.webm'))),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const count = testSyncPacketReading(videoTrack);
	expect(count).toBe(120);
});

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

	await testBasicPacketReading(audioTrack);

	const firstTimestamp = await audioTrack.getFirstTimestamp();
	expect(firstTimestamp).toBe(0);

	const duration = await audioTrack.computeDuration();
	expect(duration).toBeGreaterThan(0);
});

test('MP3 sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/AudacityTest1.mp3'))),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const count = testSyncPacketReading(audioTrack);
	expect(count).toBe(475);
});

test('WAVE demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(WAVE);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	await testBasicPacketReading(audioTrack);

	expect(await input.computeDuration()).toBeCloseTo(9.637188208616779);
});

test('WAVE sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/glitch-hop-is-dead.wav'))),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const count = testSyncPacketReading(audioTrack);
	expect(count).toBe(208);
});

test('ADTS demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);
	expect(await input.getMimeType()).toBe('audio/aac');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack).toBeInstanceOf(InputAudioTrack);

	expect(audioTrack.codec).toBe('aac');
	expect(audioTrack.numberOfChannels).toBeGreaterThan(0);
	expect(audioTrack.sampleRate).toBeGreaterThan(0);

	await testBasicPacketReading(audioTrack);

	const duration = await audioTrack.computeDuration();
	expect(duration).toBeCloseTo(4.992);
});

test('ADTS sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/trim-buck-bunny.aac'))),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const count = testSyncPacketReading(audioTrack);
	expect(count).toBe(234);
});

test('Ogg demuxing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/beach-party.ogg')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(OGG);
	expect(await input.getMimeType()).toBe('audio/ogg; codecs="vorbis"');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack).toBeInstanceOf(InputAudioTrack);

	expect(audioTrack.codec).toBe('vorbis');
	expect(audioTrack.numberOfChannels).toBeGreaterThan(0);
	expect(audioTrack.sampleRate).toBeGreaterThan(0);

	await testBasicPacketReading(audioTrack);

	const duration = await audioTrack.computeDuration();
	expect(duration).toBeCloseTo(57.325714285714284);
});

test('Ogg sync reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/beach-party.ogg'))),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const count = testSyncPacketReading(audioTrack);
	expect(count).toBe(5041);
});
