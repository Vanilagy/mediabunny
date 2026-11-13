import { expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, EncodedPacketSink } from '../../src/media-sink.js';
import { assert, textEncoder } from '../../src/misc.js';

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

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	expect(firstPacket.data[0]).toBe(0xff);
	expect((firstPacket.data[1]! & 0xf0)).toBe(0xf0); // Second nibble is also all 1s
	expect(firstPacket.type).toBe('key');

	const secondPacket = await sink.getNextPacket(firstPacket);
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

	const sink = new AudioSampleSink(audioTrack);

	let count = 0;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('ID3v2 tag between frames', async () => {
	// Like timed metadata in HLS packed audio, or segments that were glued together
	const file = concat([...adtsFrames(5), id3V2Tag(), ...adtsFrames(5)]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(Array.from({ length: 10 }, (_, i) => 1024 * i / 44100));
});

test('Sample rate change between frames', async () => {
	// Like files that were glued together
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const file = concat([...adtsFrames(5, 7), ...adtsFrames(5), ...adtsFrames(5, 7)]);

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		timestamps.push(packet.timestamp);
	}

	// A track can only have one sample rate, so the stream ends where it changes
	expect(timestamps).toEqual(Array.from({ length: 5 }, (_, i) => 1024 * i / 22050));
	expect(warnSpy).toHaveBeenCalledTimes(1);
});

test('Single frame', async () => {
	using input = new Input({
		source: new BufferSource(adtsFrames(1)[0]!),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computePacketStats()).toMatchObject({ packetCount: 1 });
});

test('Packet lookup at packet end timestamps', async () => {
	using input = new Input({
		source: new BufferSource(concat(adtsFrames(100))),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	for (let i = 0; i < 99; i++) {
		const packet = await sink.getPacket(1024 * i / 44100 + 1024 / 44100);
		expect(packet!.sequenceNumber).toBe(i + 1);
	}
});

const concat = (parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}

	return result;
};

const adtsFrames = (count: number, samplingFrequencyIndex = 4) => Array.from({ length: count }, () => {
	const frameLength = 7 + 20;

	// AAC-LC, 44100 Hz by default, stereo, no CRC
	return new Uint8Array([
		0xff,
		0xf1,
		0x40 | (samplingFrequencyIndex << 2),
		0x80 | (frameLength >> 11),
		(frameLength >> 3) & 0xff,
		((frameLength & 7) << 5) | 0x1f,
		0xfc,
		...new Uint8Array(20),
	]);
});

const id3V2Tag = () => {
	const text = textEncoder.encode('Now playing');
	const frameSize = 1 + text.byteLength;

	return new Uint8Array([
		...textEncoder.encode('ID3'), 4, 0, 0, 0, 0, 0, 10 + frameSize,
		...textEncoder.encode('TIT2'), 0, 0, 0, frameSize, 0, 0,
		3, // UTF-8
		...text,
	]);
};
