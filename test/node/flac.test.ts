import { expect, test } from 'vitest';
import path from 'node:path';
import { assert } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should be able to loop over all samples', async () => {
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
	let samples = 0;
	let lastSampleTimestamp = 0;
	for await (const sample of sink.packets()) {
		samples++;
		lastSampleTimestamp = sample.timestamp;
		if (sample.sequenceNumber === 212) {
			// Last frame is a bit shorter
			expect(sample.duration).toEqual(0.023764172335600908);
		} else {
			expect(sample.duration).toEqual(0.09287981859410431);
		}
	}
	expect(samples).toBe(213);
	expect(lastSampleTimestamp).toBe(19.690521541950112);
});

test('should be able to do random access', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	const input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const packetSink = new EncodedPacketSink(track);

	const packet = await packetSink.getPacket(10);
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.data.byteLength).toBe(8345);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);

	const nextPacket = await packetSink.getNextPacket(packet);
	assert(nextPacket);
	expect(nextPacket.timestamp).toBe(10.031020408163265);
	expect(nextPacket.data.byteLength).toBe(8988);
	expect(nextPacket.sequenceNumber).toBe(108);
	expect(nextPacket.duration).toBe(0.09287981859410431);

	const priorPacket = await packetSink.getPacket(3);
	assert(priorPacket);
	expect(priorPacket.timestamp).toBe(2.972154195011338);
	expect(priorPacket.data.byteLength).toBe(6877);
	expect(priorPacket.sequenceNumber).toBe(32);
	expect(priorPacket.duration).toBe(0.09287981859410431);
});

test('should be able to get metadata-only packets', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	const input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const packetSink = new EncodedPacketSink(track);

	const packet = await packetSink.getPacket(10, { metadataOnly: true });
	assert(packet);
	expect(packet.timestamp).toBe(9.93814058956916);
	expect(packet.data.byteLength).toBe(0);
	expect(packet.sequenceNumber).toBe(107);
	expect(packet.duration).toBe(0.09287981859410431);
});

test('should be able to get metadata', async () => {
	const filePath = path.join(__dirname, '..', 'public/sample.flac');
	const input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const descriptiveMetadata = await input.getMetadataTags();
	expect(descriptiveMetadata).toEqual({
		title: 'The Happy Meeting',
		date: new Date('2020'),
		album: 'Samples files',
		artist: 'Samples Files',
		trackNumber: 4,
		genre: 'Ambient',
	});
});
