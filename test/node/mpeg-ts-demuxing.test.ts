import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { FilePathSource, ReadableStreamSource, StreamSource } from '../../src/source.js';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { MpegTsDemuxer } from '../../src/mpeg-ts/mpeg-ts-demuxer.js';
import { MpegTsStreamType } from '../../src/mpeg-ts/mpeg-ts-misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('MPEG-TS input format', async () => {
	expect(MPEG_TS.mimeType).toBe('video/MP2T');
	expect(MPEG_TS.name).toBe('MPEG Transport Stream');
});

test('MPEG-TS metadata reading', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MPEG_TS);
	expect((await input.getFormat()).mimeType).toBe('video/MP2T');
	expect(await input.getMimeType()).toBe('video/MP2T; codecs="avc1.640020, mp4a.40.2"');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(videoTrack.id).toBe(0x100);
	expect(videoTrack.codec).toBe('avc');
	expect(videoTrack.internalCodecId).toBe(0x1b);
	expect(videoTrack.displayWidth).toEqual(720);
	expect(videoTrack.displayHeight).toEqual(720);
	expect(videoTrack.timeResolution).toBe(90_000);

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	expect(videoDecoderConfig).toEqual({
		codec: 'avc1.640020',
		codedWidth: 720,
		codedHeight: 720,
		colorSpace: {
			primaries: 'bt2020',
			transfer: 'hlg',
			matrix: 'bt2020-ncl',
			fullRange: false,
		},
		// No description, it's Annex B
	});

	expect(await videoTrack.getFirstTimestamp()).toBe(10.033333333333333);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.id).toBe(0x101);
	expect(audioTrack.codec).toBe('aac');
	expect(audioTrack.numberOfChannels).toBe(2);
	expect(audioTrack.sampleRate).toBe(48000);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		// No description, it's ADTS audio
	});

	expect(await audioTrack.getFirstTimestamp()).toBe(10.012);
});

test('MPEG-TS durations', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const firstTimestamp = await input.getFirstTimestamp();
	expect(firstTimestamp).toBe(10.012);

	const duration = await input.computeDuration();
	expect(duration).toBeCloseTo(15.004);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const videoFirstTimestamp = await videoTrack.getFirstTimestamp();
	expect(videoFirstTimestamp).toBe(10.033333333333333);

	const videoDuration = await videoTrack.computeDuration();
	expect(videoDuration).toBeCloseTo(15);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const audioFirstTimestamp = await audioTrack.getFirstTimestamp();
	expect(audioFirstTimestamp).toBe(10.012);

	const audioDuration = await audioTrack.computeDuration();
	expect(audioDuration).toBeCloseTo(15.004);
});

test('MPEG-TS AVC video packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
	expect(firstPacket.data.byteLength).toBe(23813);
	expect(firstPacket.type).toBe('key');
	expect(firstPacket.timestamp).toBe(10.033333333333333);
	expect(firstPacket.duration).toBe(0.016666666666666666);
	expect(firstPacket.sequenceNumber).not.toBe(-1);

	const firstPacketMetadataOnly = await sink.getFirstPacket({ metadataOnly: true });
	assert(firstPacketMetadataOnly);
	expect(firstPacketMetadataOnly.data).toHaveLength(0);
	expect(firstPacketMetadataOnly.byteLength).toBe(23813);

	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);

	expect([...secondPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
	expect(secondPacket.data.byteLength).toBe(5700);
	expect(secondPacket.type).toBe('delta');
	expect(secondPacket.timestamp).toBe(10.1);
	expect(secondPacket.duration).toBe(0.016666666666666666);
	expect(secondPacket.sequenceNumber).toBeGreaterThan(firstPacket.sequenceNumber);

	let currentPacket: EncodedPacket | null = firstPacket;
	let count = 0;

	while (currentPacket) {
		expect(currentPacket.duration).toBe(0.016666666666666666);

		currentPacket = await sink.getNextPacket(currentPacket);
		count++;
	}

	expect(count).toBe(298);
});

test('MPEG-TS AAC audio packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	expect(firstPacket.data[0]).toEqual(0xff);
	expect(firstPacket.data.byteLength).toBe(348);
	expect(firstPacket.type).toBe('key');
	expect(firstPacket.timestamp).toBe(10.012);
	expect(firstPacket.duration).toBe(0.021333333333333333);
	expect(firstPacket.sequenceNumber).not.toBe(-1);

	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);

	expect(secondPacket.data[0]).toEqual(0xff);
	expect(secondPacket.data.byteLength).toBe(349);
	expect(secondPacket.type).toBe('key');
	expect(secondPacket.timestamp).toBeCloseTo(10.033333333333333);
	expect(secondPacket.duration).toBe(0.021333333333333333);
	expect(secondPacket.sequenceNumber).toBeGreaterThan(firstPacket.sequenceNumber);

	let currentPacket: EncodedPacket | null = firstPacket;
	let count = 0;

	while (currentPacket) {
		expect(currentPacket.duration).toBe(0.021333333333333333);

		currentPacket = await sink.getNextPacket(currentPacket);
		count++;
	}

	expect(count).toBe(234);
});

test('MPEG-TS video seeking', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstTimestamp = await videoTrack.getFirstTimestamp();
		const firstPacket = await sink.getPacket(firstTimestamp);
		assert(firstPacket);
		expect(firstPacket.timestamp).toBe(firstTimestamp);
		expect(firstPacket.duration).toBe(0.016666666666666666);
		expect(firstPacket.sequenceNumber).toBe((await sink.getFirstPacket())?.sequenceNumber);

		const lastPacket = await sink.getPacket(Infinity);
		assert(lastPacket);
		expect(lastPacket.timestamp).toBeCloseTo(14.983333333333333);
		expect(lastPacket.duration).toBe(0.016666666666666666);

		const beforeFirst = await sink.getPacket(-10);
		expect(beforeFirst).toBeNull();

		const middlePacket = await sink.getPacket(12.5);
		assert(middlePacket);
		expect(middlePacket.timestamp).toBeCloseTo(12.5);
		expect(middlePacket.duration).toBe(0.016666666666666666);

		const allPackets: EncodedPacket[] = [];
		let currentPacket: EncodedPacket | null = firstPacket;

		while (currentPacket) {
			allPackets.push(currentPacket);
			currentPacket = await sink.getNextPacket(currentPacket);
		}

		expect(allPackets).toHaveLength(298);

		for (const packet of allPackets) {
			const seekedPacket = await sink.getPacket(packet.timestamp);
			assert(seekedPacket);
			expect(seekedPacket.timestamp).toBe(packet.timestamp);
			expect(seekedPacket.duration).toBe(packet.duration);
			expect(seekedPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS audio seeking', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(audioTrack);

		const firstTimestamp = await audioTrack.getFirstTimestamp();
		const firstPacket = await sink.getPacket(firstTimestamp);
		assert(firstPacket);
		expect(firstPacket.timestamp).toBe(firstTimestamp);
		expect(firstPacket.duration).toBe(0.021333333333333333);
		expect(firstPacket.sequenceNumber).toBe((await sink.getFirstPacket())?.sequenceNumber);

		const lastPacket = await sink.getPacket(Infinity);
		assert(lastPacket);
		expect(lastPacket.timestamp).toBeCloseTo(14.982666666666667);
		expect(lastPacket.duration).toBe(0.021333333333333333);

		const beforeFirst = await sink.getPacket(-10);
		expect(beforeFirst).toBeNull();

		const middlePacket = await sink.getPacket(12.5);
		assert(middlePacket);
		expect(middlePacket.timestamp).toBeCloseTo(12.486666666666666);
		expect(middlePacket.duration).toBe(0.021333333333333333);

		const allPackets: EncodedPacket[] = [];
		let currentPacket: EncodedPacket | null = firstPacket;

		while (currentPacket) {
			allPackets.push(currentPacket);
			currentPacket = await sink.getNextPacket(currentPacket);
		}

		expect(allPackets).toHaveLength(234);

		for (const packet of allPackets) {
			const seekedPacket = await sink.getPacket(packet.timestamp);
			assert(seekedPacket);
			expect(seekedPacket.timestamp).toBe(packet.timestamp); // The correct timestamp was retrieved
			expect(seekedPacket.duration).toBe(packet.duration); // The correct duration was retrieved
			expect(seekedPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS seeking race condition test', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const allPackets: EncodedPacket[] = [];
		let currentPacket: EncodedPacket | null = await sink.getFirstPacket();

		while (currentPacket) {
			allPackets.push(currentPacket);
			currentPacket = await sink.getNextPacket(currentPacket);
		}

		// Perform all seeks concurrently
		const seekPromises = allPackets.map(packet => sink.getPacket(packet.timestamp));
		const seekedPackets = await Promise.all(seekPromises);

		for (let j = 0; j < allPackets.length; j++) {
			const originalPacket = allPackets[j]!;
			const seekedPacket = seekedPackets[j]!;
			assert(seekedPacket);
			expect(seekedPacket.timestamp).toBe(originalPacket.timestamp);
			expect(seekedPacket.duration).toBe(originalPacket.duration);
			expect(seekedPacket.sequenceNumber).toBe(originalPacket.sequenceNumber);
		}
	}
});

test('MPEG-TS video key packets', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny-ffmpeg.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');

		const secondPacket = await sink.getNextPacket(firstPacket);
		assert(secondPacket);
		expect(secondPacket.type).toBe('delta');

		const nextKeyPacket = await sink.getNextKeyPacket(firstPacket);
		assert(nextKeyPacket);
		expect(nextKeyPacket.type).toBe('key');
		expect(nextKeyPacket.sequenceNumber).toBeGreaterThan(secondPacket.sequenceNumber);

		const firstKeyPacket = await sink.getKeyPacket(firstPacket.timestamp + 0.5);
		assert(firstKeyPacket);
		expect(firstKeyPacket.type).toBe('key');
		expect(firstKeyPacket.sequenceNumber).toBe(firstPacket.sequenceNumber);

		const afterKeyPacket = await sink.getNextPacket(firstKeyPacket);
		expect(afterKeyPacket).not.toBe(null);
		expect(afterKeyPacket!.type).toBe('delta');
		expect(afterKeyPacket!.sequenceNumber).toBe(secondPacket.sequenceNumber);

		const secondKeyPacket = await sink.getKeyPacket(2.5);
		assert(secondKeyPacket);
		expect(secondKeyPacket.type).toBe('key');
		expect(secondKeyPacket.sequenceNumber).toBe(nextKeyPacket.sequenceNumber);

		const lastKeyPacket = await sink.getKeyPacket(Infinity);
		assert(lastKeyPacket);
		expect(lastKeyPacket.type).toBe('key');
		expect(lastKeyPacket.sequenceNumber).toBeGreaterThan(secondKeyPacket.sequenceNumber);

		const allKeyPackets: EncodedPacket[] = [];
		let currentKeyPacket: EncodedPacket | null = firstPacket;

		while (currentKeyPacket) {
			allKeyPackets.push(currentKeyPacket);
			currentKeyPacket = await sink.getNextKeyPacket(currentKeyPacket);
		}

		for (const packet of allKeyPackets) {
			const keyPacket = await sink.getKeyPacket(packet.timestamp);
			assert(keyPacket);
			expect(keyPacket.timestamp).toBe(packet.timestamp); // The correct timestamp was retrieved for this packet
			expect(keyPacket.duration).toBe(packet.duration); // The correct duration was retrieved for this packet
			expect(keyPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS audio key packets', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
			formats: ALL_FORMATS,
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		assert(audioTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(audioTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');

		const secondPacket = await sink.getNextPacket(firstPacket);
		assert(secondPacket);
		expect(secondPacket.type).toBe('key');

		const nextKeyPacket = await sink.getNextKeyPacket(firstPacket);
		assert(nextKeyPacket);
		expect(nextKeyPacket.type).toBe('key');
		expect(nextKeyPacket.sequenceNumber).toBe(secondPacket.sequenceNumber); // All audio packets are key packets

		const middleKeyPacket = await sink.getKeyPacket(12.5);
		assert(middleKeyPacket);
		expect(middleKeyPacket.type).toBe('key');

		const afterKeyPacket = await sink.getNextPacket(middleKeyPacket);
		expect(afterKeyPacket).not.toBe(null);
		expect(afterKeyPacket!.type).toBe('key');

		const lastPacket = await sink.getPacket(Infinity);
		assert(lastPacket);

		const lastKeyPacket = await sink.getKeyPacket(Infinity);
		assert(lastKeyPacket);
		expect(lastKeyPacket.type).toBe('key');
		expect(lastKeyPacket.sequenceNumber).toBe(lastPacket.sequenceNumber); // It's actually the last packet

		const allKeyPackets: EncodedPacket[] = [];
		let currentKeyPacket: EncodedPacket | null = firstPacket;

		while (currentKeyPacket) {
			allKeyPackets.push(currentKeyPacket);
			currentKeyPacket = await sink.getNextKeyPacket(currentKeyPacket);
		}

		for (const packet of allKeyPackets) {
			const keyPacket = await sink.getKeyPacket(packet.timestamp);
			assert(keyPacket);
			expect(keyPacket.timestamp).toBe(packet.timestamp); // The correct timestamp was retrieved for this packet
			expect(keyPacket.duration).toBe(packet.duration); // The correct duration was retrieved for this packet
			expect(keyPacket.sequenceNumber).toBe(packet.sequenceNumber);
		}
	}
});

test('MPEG-TS with unknown file size (ReadableStreamSource)', async () => {
	for (let i = 0; i < 2; i++) {
		const filePath = path.join(__dirname, '../public/0.ts');
		const fileStream = fs.createReadStream(filePath);
		const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;

		using input = new Input({
			source: new ReadableStreamSource(webStream),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');
		expect(firstPacket.timestamp).toBe(10.033333333333333);

		const middlePacket = await sink.getPacket(12.5);
		assert(middlePacket);
		expect(middlePacket.timestamp).toBeCloseTo(12.5);

		const duration = await videoTrack.computeDuration();
		expect(duration).toBeCloseTo(15);
	}
});

test('MPEG-TS transmuxed by FFmpeg', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny-ffmpeg.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const videoPacketStats = await videoTrack.computePacketStats();
	const audioPacketStats = await audioTrack.computePacketStats();

	expect(videoPacketStats.packetCount).toBe(121);
	expect(audioPacketStats.packetCount).toBe(235);
});

test('MPEG-TS with HEVC video', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/hevc.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(videoTrack.codec).toBe('hevc');
	expect(videoTrack.internalCodecId).toBe(0x24);
	expect(videoTrack.displayWidth).toBe(1920);
	expect(videoTrack.displayHeight).toBe(1080);

	const videoDecoderConfig = await videoTrack.getDecoderConfig();
	expect(videoDecoderConfig).toEqual({
		codec: 'hev1.1.6.L120.90',
		codedWidth: 1920,
		codedHeight: 1080,
		colorSpace: {
			primaries: 'bt709',
			transfer: 'bt709',
			matrix: 'bt709',
			fullRange: false,
		},
		// No description, it's Annex B
	});

	const sink = new EncodedPacketSink(videoTrack);

	let i = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1])); // Annex B
		expect(packet.duration).toBeCloseTo(0.04166666666);
		expect(packet.type).toBe(i > 0 ? 'delta' : 'key');
		i++;
	}
});

test('MPEG-TS with MP3 audio', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/mp3.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.codec).toBe('mp3');
	expect(audioTrack.internalCodecId).toBe(0x03);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'mp3',
		numberOfChannels: 2,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0xff);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with AC-3 audio (System A)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/ac3.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.codec).toBe('ac3');
	expect(audioTrack.internalCodecId).toBe(MpegTsStreamType.AC3_SYSTEM_A);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ac-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with AC-3 audio (System B)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/ac3-system-b.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.codec).toBe('ac3');
	expect(audioTrack.internalCodecId).toBe(MpegTsStreamType.PRIVATE_DATA);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ac-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with E-AC-3 audio (System A)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/eac3.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.codec).toBe('eac3');
	expect(audioTrack.internalCodecId).toBe(MpegTsStreamType.EAC3_SYSTEM_A);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ec-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS with E-AC-3 audio (System B)', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/eac3-system-b.ts')),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(audioTrack.codec).toBe('eac3');
	expect(audioTrack.internalCodecId).toBe(MpegTsStreamType.PRIVATE_DATA);

	const audioDecoderConfig = await audioTrack.getDecoderConfig();
	expect(audioDecoderConfig).toEqual({
		codec: 'ec-3',
		numberOfChannels: 6,
		sampleRate: 48000,
	});

	const sink = new EncodedPacketSink(audioTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let count = 0;
	for await (const packet of sink.packets()) {
		expect(packet.data[0]).toBe(0x0b);
		expect(packet.data[1]).toBe(0x77);
		expect(packet.type).toBe('key');
		count++;
	}

	expect(count).toBeGreaterThan(0);
});

test('MPEG-TS partial reading', async () => {
	const fullPath = path.join(__dirname, '../public/193039199_mp4_h264_aac_fhd_7.ts');
	const buffer = await fs.promises.readFile(fullPath);
	let maxEnd = 0;

	using input = new Input({
		source: new StreamSource({
			getSize: () => {
				return buffer.byteLength;
			},
			read: (start, end) => {
				maxEnd = Math.max(maxEnd, end);
				return buffer.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});

	await input.getTracks();

	// Not much of the file has been read since we only requested metadata
	expect(maxEnd).toBeLessThanOrEqual(86480);
});

test('MPEG-TS first packet key packet forcing', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/missing-keyframe-labels.ts')),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);

		if (i === 1) {
			const demuxer = (await input._demuxerPromise) as MpegTsDemuxer;
			demuxer.seekChunkSize = 250_000; // Try it again with a smaller chunk size
		}

		const sink = new EncodedPacketSink(videoTrack);

		// Test that the first packet is indeed a key packet even if the file doesn't label it that way (L muxer)
		const firstPacket = await sink.getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.type).toBe('key');

		const firstPacketSeeked = await sink.getPacket(firstPacket.timestamp);
		assert(firstPacketSeeked);
		expect(firstPacketSeeked.type).toBe('key');
		expect(firstPacketSeeked.sequenceNumber).toBe(firstPacket.sequenceNumber);

		const firstKeyPacketSeeked = await sink.getKeyPacket(firstPacket.timestamp);
		assert(firstKeyPacketSeeked);
		expect(firstKeyPacketSeeked.type).toBe('key');
		expect(firstKeyPacketSeeked.sequenceNumber).toBe(firstPacket.sequenceNumber);
	}
});
