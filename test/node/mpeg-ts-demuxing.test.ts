import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource, ReadableStreamSource, CustomSource } from '../../src/source.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { concatNalUnitsInAnnexB } from '../../src/codec-data.js';
import { MpegTsDemuxer } from '../../src/mpeg-ts/mpeg-ts-demuxer.js';
import { MpegTsStreamType } from '../../src/mpeg-ts/mpeg-ts-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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

	expect(videoTrack.id).toBe(1);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect(await videoTrack.getInternalCodecId()).toBe(0x1b);
	expect(await videoTrack.getDisplayWidth()).toEqual(720);
	expect(await videoTrack.getDisplayHeight()).toEqual(720);
	expect(await videoTrack.getTimeResolution()).toBe(90_000);

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

	expect(audioTrack.id).toBe(2);
	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);

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

test('MPEG-TS seeking race condition test', { timeout: 30_000 }, async () => {
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

test('MPEG-TS video key packets', { timeout: 30_000 }, async () => {
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

	expect(await videoTrack.getCodec()).toBe('hevc');
	expect(await videoTrack.getInternalCodecId()).toBe(0x24);
	expect(await videoTrack.getDisplayWidth()).toBe(1920);
	expect(await videoTrack.getDisplayHeight()).toBe(1080);

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

	expect(await audioTrack.getCodec()).toBe('mp3');
	expect(await audioTrack.getInternalCodecId()).toBe(0x03);

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

	expect(await audioTrack.getCodec()).toBe('ac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.AC3_SYSTEM_A);

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

	expect(await audioTrack.getCodec()).toBe('ac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.PRIVATE_DATA);

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

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.EAC3_SYSTEM_A);

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

	expect(await audioTrack.getCodec()).toBe('eac3');
	expect(await audioTrack.getInternalCodecId()).toBe(MpegTsStreamType.PRIVATE_DATA);

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
		source: new CustomSource({
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

test('MPEG-TS init input without stream data', async () => {
	const buffer = await fs.promises.readFile(path.join(__dirname, '../public/0.ts'));

	// Only the PAT and PMT, so the streams are declared but never set up
	using initInput = new Input({
		source: new BufferSource(buffer.subarray(0, 2 * 188)),
		formats: ALL_FORMATS,
	});
	await initInput.getTracks();

	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
		initInput,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);
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

test('MPEG-TS without initial key packet', async () => {
	for (let i = 0; i < 2; i++) {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '../public/no-initial-keyframe.ts')),
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
		expect(firstPacket.type).toBe('delta'); // First packet is delta

		const noPacket = await sink.getKeyPacket(firstPacket.timestamp);
		expect(noPacket).toBeNull();

		const aKeyPacket = await sink.getKeyPacket(Infinity);
		assert(aKeyPacket);
		expect(aKeyPacket.type).toBe('key');
	}
});

test('MPEG-TS with "extension" PES packets without PTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/entry24-segment3.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const packetSizes: number[] = [];
	const sink = new EncodedPacketSink(videoTrack);

	for await (const packet of sink.packets()) {
		packetSizes.push(packet.data.byteLength);

		const seeked = await sink.getPacket(packet.timestamp);
		expect(seeked!.timestamp).toBe(packet.timestamp);
		expect(seeked!.sequenceNumber).toBe(packet.sequenceNumber);
	}

	expect(packetSizes).toEqual([
		// These reference values come from ffprobe
		30635, 5980, 3452, 2076, 2692, 9559, 5754, 2171, 2989, 13962,
		4156, 209260, 25698, 152, 2299, 128, 94, 102, 74, 28898,
		233, 127, 99, 1449, 130, 99, 3988, 202, 130, 139,
		92, 18652, 200, 146, 98, 8666, 190, 151, 156, 108,
		9991, 162, 97, 81, 9929, 130, 106, 13362, 133, 117,
		7606, 274, 109, 106, 12359, 218, 123, 111, 24109, 261,
		142, 120, 13417, 789, 153, 139, 12490, 549, 192, 135,
		13191, 428, 159, 150, 30815, 309, 135, 119, 9231, 354,
		147, 116, 11835, 263, 162, 103, 6693, 202, 100, 101,
		4693, 223, 144, 174, 118, 9155, 1188, 379, 169, 213,
	]);
});

test('MPEG-TS with AUD-less video packets', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/no-aud.ts')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);
	const thirdPacket = await sink.getNextPacket(secondPacket);
	assert(thirdPacket);

	expect(firstPacket.data.byteLength).toBe(331774);
	expect(secondPacket.data.byteLength).toBe(1749);
	expect(thirdPacket.data.byteLength).toBe(4273);
});

const PMT_PID = 0x1000;
const STREAM_PID = 0x100;

test('PES packet straddling the PAT and PMT', async () => {
	// Like a capture that joins mid-broadcast: the first audio PES packet begins before the tables and ends after them
	const straddlingPackets = packetize(STREAM_PID, pes(0xc0, 1000, adtsFrame(400)));
	const laterPackets = Array.from({ length: 10 }, (_, i) => packetize(
		STREAM_PID,
		pes(0xc0, 1000 + 1920 * (i + 1), adtsFrame(400)),
	));

	using input = new Input({
		source: new BufferSource(concat(
			straddlingPackets[0]!,
			...packetize(0, psi(pat())),
			...packetize(PMT_PID, psi(pmt(0x0f))),
			...straddlingPackets.slice(1),
			...laterPackets.flat(),
		)),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	const seekedPacket = await sink.getPacket(firstPacket.timestamp);
	assert(seekedPacket);
	expect(seekedPacket.timestamp).toBe(firstPacket.timestamp);
	expect(seekedPacket.duration).toBe(firstPacket.duration);
	expect(seekedPacket.sequenceNumber).toBe(firstPacket.sequenceNumber);
	expect(seekedPacket.byteLength).toBe(firstPacket.byteLength);
});

test('Negative timestamps after a positive first PES packet', async () => {
	// The first PES packet anchors the wrap detection, and the other track starts slightly before it, below zero
	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat())),
			...packetize(PMT_PID, psi(pmt(0x0f, [0x100, 0x101]))),
			...packetize(0x100, pes(0xc0, 900, adtsFrame(16))),
			...packetize(0x101, pes(0xc0, 2 ** 33 - 900, adtsFrame(16))),
			...packetize(0x100, pes(0xc0, 900 + 1920, adtsFrame(16))),
			...packetize(0x101, pes(0xc0, 1920 - 900, adtsFrame(16))),
		)),
		formats: ALL_FORMATS,
	});

	const [firstTrack, secondTrack] = await input.getAudioTracks();
	expect(await firstTrack!.getFirstTimestamp()).toBe(0.01);

	const timestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(secondTrack!).packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual([-900 / 90000, 1020 / 90000]);
});

test('PAT with a pointer field', async () => {
	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat(), 3)),
			...packetize(PMT_PID, psi(pmt(0x0f))),
			...packetize(STREAM_PID, pes(0xc0, 0, adtsFrame(16))),
		)),
		formats: ALL_FORMATS,
	});

	expect(await input.getAudioTracks()).toHaveLength(1);
});

test('PMT with a pointer field', async () => {
	// Once the pointer field reaches past the ES_info of the last stream, that stream used to get cut off
	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat())),
			...packetize(PMT_PID, psi(pmt(0x0f, [0x100, 0x101]), 4)),
			...packetize(0x100, pes(0xc0, 0, adtsFrame(16))),
			...packetize(0x101, pes(0xc0, 0, adtsFrame(16))),
		)),
		formats: ALL_FORMATS,
	});

	expect(await input.getAudioTracks()).toHaveLength(2);
});

test('Program map section on a PID other than the one named by the PAT', async () => {
	// Like the PMT of another program the PAT doesn't list; once the PAT names the PMT PID, only that one counts
	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat())),
			...packetize(PMT_PID + 1, psi(pmt(0x03, [STREAM_PID + 1]))),
			...packetize(PMT_PID, psi(pmt(0x0f))),
			...packetize(STREAM_PID, pes(0xc0, 0, adtsFrame(16))),
			...packetize(STREAM_PID + 1, pes(0xc0, 0, adtsFrame(16))),
		)),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(await Promise.all(tracks.map(track => track.getInternalCodecId()))).toEqual([0x0f]);
});

test('Private section on the PMT PID', async () => {
	// ISO/IEC 13818-1 allows private sections on PMT PIDs, so they mustn't be mistaken for the PMT
	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat())),
			...packetize(PMT_PID, psi(concat([0x80, 0x30, 8], new Uint8Array(8).fill(0xe1)))),
			...packetize(PMT_PID, psi(pmt(0x0f))),
			...packetize(STREAM_PID, pes(0xc0, 0, adtsFrame(16))),
		)),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(await Promise.all(tracks.map(track => track.getInternalCodecId()))).toEqual([0x0f]);
});

test('ADTS frames spanning PES packets with sync words in their payload', async () => {
	// Seeking into a PES packet that begins mid-frame means scanning the frame's payload for the next one, so this
	// payload had better not stop us with what looks like a header with channel configuration 0
	const frame = adtsFrame(400);
	for (let i = 7; i + 4 <= frame.length; i += 50) {
		frame.set([0xff, 0xf1, 0x4c, 0x00], i);
	}
	const frames = concat(...Array.from({ length: 20 }, () => frame));

	// One and a half frames per PES packet, timestamped by the first frame beginning in it
	const pesPackets: Uint8Array[] = [];
	for (let offset = 0; offset < frames.length; offset += 610) {
		const frameIndex = Math.ceil(offset / frame.length);
		pesPackets.push(...packetize(STREAM_PID, pes(0xc0, 1920 * frameIndex, frames.subarray(offset, offset + 610))));
	}

	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat())),
			...packetize(PMT_PID, psi(pmt(0x0f))),
			...pesPackets,
		)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(Array.from({ length: 20 }, (_, i) => 1920 * i / 90000));

	for (const timestamp of timestamps) {
		expect((await sink.getPacket(timestamp))?.timestamp).toBe(timestamp);
	}
});

// 48 kHz stereo AAC-LC, so that a frame lasts exactly 1920 ticks
const adtsFrame = (payloadSize: number) => {
	const frameLength = 7 + payloadSize;
	return concat(
		[
			0xff,
			0xf1,
			(1 << 6) | (3 << 2),
			(2 << 6) | ((frameLength >> 11) & 3),
			(frameLength >> 3) & 0xff,
			((frameLength & 7) << 5) | 0x1f,
			0xfc,
		],
		new Uint8Array(payloadSize),
	);
};

test('Init input whose metadata was never read', async () => {
	using initInput = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	// No parameter sets anywhere, so the video track can only be set up through the init input
	const startCode = [0, 0, 0, 1];
	const accessUnit = concat(startCode, [0x09, 0xf0], startCode, [0x41, 0x9a], new Uint8Array(30).fill(0x55));
	const pesPackets = Array.from({ length: 5 }, (_, i) => packetize(
		STREAM_PID,
		pes(0xe0, 1000 + 3000 * i, accessUnit),
	));

	using input = new Input({
		source: new BufferSource(concat(
			...packetize(0, psi(pat())),
			...packetize(PMT_PID, psi(pmt(0x1b))),
			...pesPackets.flat(),
		)),
		formats: ALL_FORMATS,
		initInput,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getCodedWidth()).toBe(720);
	expect(await track.getCodedHeight()).toBe(720);
});

const psi = (section: Uint8Array, pointerField = 0) => {
	const stuffingLength = (184 - (1 + pointerField + section.length) % 184) % 184;
	return concat(
		[pointerField],
		new Uint8Array(pointerField).fill(0xff), // The tail of a previous section
		section,
		new Uint8Array(stuffingLength).fill(0xff),
	);
};

const pat = () => concat(
	[0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00],
	[0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff],
	new Uint8Array(4), // CRC_32, which isn't checked
);

const pmt = (streamType: number, pids = [STREAM_PID]) => {
	const streams = pids.flatMap(pid => [streamType, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00]);
	return concat(
		[0x02, 0xb0, 9 + streams.length + 4, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xff, 0xff, 0xf0, 0x00],
		streams,
		new Uint8Array(4), // CRC_32, which isn't checked
	);
};

const packetize = (pid: number, payload: Uint8Array) => {
	const packets: Uint8Array[] = [];
	let offset = 0;

	while (offset < payload.length) {
		const packet = new Uint8Array(188);
		packet.set([0x47, (offset === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff], 0);

		const remaining = payload.length - offset;
		let headerEnd = 4;

		if (remaining < 184) {
			// Pad the last packet with an adaptation field
			const adaptationFieldLength = 183 - remaining;
			packet[3] = 0x30;
			packet[4] = adaptationFieldLength;
			if (adaptationFieldLength > 0) {
				packet[5] = 0x00;
				packet.fill(0xff, 6, 5 + adaptationFieldLength);
			}
			headerEnd = 5 + adaptationFieldLength;
		} else {
			packet[3] = 0x10;
		}

		const length = Math.min(188 - headerEnd, remaining);
		packet.set(payload.subarray(offset, offset + length), headerEnd);
		offset += length;
		packets.push(packet);
	}

	return packets;
};

const pes = (streamId: number, pts: number, data: Uint8Array) => concat(
	[0x00, 0x00, 0x01, streamId],
	[(8 + data.length) >> 8, (8 + data.length) & 0xff],
	[0x80, 0x80, 5],
	[0x21 | ((Math.floor(pts / 2 ** 30) % 8) << 1)],
	u16(((Math.floor(pts / 2 ** 15) % 2 ** 15) << 1) | 1),
	u16(((pts % 2 ** 15) << 1) | 1),
	data,
);

const u16 = (value: number) => [value >> 8, value & 0xff];

const concat = (...parts: (Uint8Array | number[])[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;

	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

test('Concurrent next packet requests for the same packet', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);

	// What a trimmed conversion's B-frame lookahead does while the packet iterator is still fetching the same successor
	const [a, b] = await Promise.all([sink.getNextPacket(secondPacket), sink.getNextPacket(secondPacket)]);
	assert(a);
	assert(b);
	expect(a.sequenceNumber).toBe(b.sequenceNumber);
	expect(a.timestamp).toBe(b.timestamp);

	const [c, d] = await Promise.all([sink.getNextPacket(a), sink.getNextPacket(b)]);
	assert(c);
	assert(d);
	expect(c.sequenceNumber).toBe(d.sequenceNumber);
	expect(c.sequenceNumber).toBeGreaterThan(a.sequenceNumber);
});

test('Next packet retrieved a second time, with B-frames', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/0.ts')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	let packet = await sink.getFirstPacket();
	assert(packet);

	while (true) {
		const nextPacket = await sink.getNextPacket(packet);
		if (!nextPacket) {
			break;
		}

		// The packet has handed its read state on to the next one by now, so this one has to reread the file
		const rereadNextPacket = await sink.getNextPacket(packet);
		assert(rereadNextPacket);
		expect(rereadNextPacket.sequenceNumber).toBe(nextPacket.sequenceNumber);
		expect(rereadNextPacket.timestamp).toBe(nextPacket.timestamp);
		expect(rereadNextPacket.duration).toBe(nextPacket.duration);

		packet = nextPacket;
	}
});

// NAL units of 16x16 gray frames encoded by x264
const BASELINE_SPS = new Uint8Array([
	0x67, 0x42, 0xc0, 0x0a, 0xda, 0x7b, 0x01, 0x10, 0x00, 0x00, 0x03,
	0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0x20, 0xf1, 0x22, 0x6a,
]);
const BASELINE_PPS = new Uint8Array([0x68, 0xce, 0x0f, 0xc8]);
const IDR_SLICE = new Uint8Array([0x65, 0x88, 0x84, 0x0b, 0xff, 0xff, 0xfc, 0x3d, 0x14, 0x7e]);

const FRAME_DURATION = 1 / 25;

test('Tiny final AVC slice', async () => {
	const skippedPSlice = new Uint8Array([0x41, 0x9a, 0x20, 0x2f, 0xd4]);
	const bytes = await muxAvc('avc1.42c00a', [
		avcPacket([BASELINE_SPS, BASELINE_PPS, IDR_SLICE], 0, 'key'),
		avcPacket([skippedPSlice], 1),
		avcPacket([skippedPSlice], 2),
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets).toHaveLength(3);
	expect(packets[2]!.timestamp).toBeCloseTo(2 * FRAME_DURATION);
});

test('Last key packet of intra-only AVC', async () => {
	// Intra-only, which (via constraint_set3_flag) means there's no frame reordering whatsoever
	const intraSps = new Uint8Array([
		0x67, 0x64, 0x10, 0x0a, 0xac, 0xbb, 0xd8, 0x08, 0x80, 0x00, 0x00, 0x03, 0x00, 0x80, 0x00, 0x00, 0x19, 0x02,
	]);
	const intraPps = new Uint8Array([0x68, 0xee, 0x0f, 0x2c, 0x8b]);
	const bytes = await muxAvc('avc1.64100a', [
		avcPacket([intraSps, intraPps, IDR_SLICE], 0, 'key'),
		avcPacket([intraSps, intraPps, IDR_SLICE], 1, 'key'),
		avcPacket([intraSps, intraPps, IDR_SLICE], 2, 'key'),
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.duration).toBeCloseTo(FRAME_DURATION);

	const lastKeyPacket = await sink.getKeyPacket(Infinity);
	assert(lastKeyPacket);
	expect(lastKeyPacket.sequenceNumber).toBe(lastPacket.sequenceNumber);
	expect(lastKeyPacket.duration).toBe(lastPacket.duration);
});

// With B-frames, giving a reorder size of 3
const HIGH_SPS = new Uint8Array([
	0x67, 0x64, 0x00, 0x0a, 0xac, 0xd1, 0x1e, 0xc0, 0x44, 0x00, 0x00, 0x03,
	0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c, 0x48, 0x94, 0x48,
]);
const HIGH_PPS = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
// Made up past their slice headers' first_mb_in_slice, which is as far as the demuxer looks
const P_SLICE = new Uint8Array([0x41, 0x9a, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
const B_SLICE = new Uint8Array([0x01, 0x9e, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);

test('PES packets preceding the PMT', async () => {
	const bytes = await muxAvc('avc1.64000a', [
		avcPacket([HIGH_SPS, HIGH_PPS, IDR_SLICE], 0, 'key'),
		avcPacket([P_SLICE], 3),
		avcPacket([B_SLICE], 1),
		avcPacket([HIGH_SPS, HIGH_PPS, B_SLICE], 2),
		avcPacket([HIGH_SPS, HIGH_PPS, IDR_SLICE], 4, 'key'),
	]);

	// Move the PAT and PMT behind the first three PES packets, like in a recording that starts mid-stream. The
	// track then only consists of the frames at 2 and 4.
	const tsPackets: Uint8Array[] = [];
	for (let pos = 0; pos < bytes.byteLength; pos += 188) {
		tsPackets.push(bytes.subarray(pos, pos + 188));
	}
	const tables = tsPackets.splice(0, 2);
	const pesStartIndices = tsPackets.flatMap((packet, i) => {
		const payloadUnitStartIndicator = (packet[1]! >> 6) & 1;
		return payloadUnitStartIndicator ? [i] : [];
	});
	tsPackets.splice(pesStartIndices[3]!, 0, ...tables);

	const reordered = new Uint8Array(bytes.byteLength);
	tsPackets.forEach((packet, i) => reordered.set(packet, 188 * i));

	using input = new Input({
		source: new BufferSource(reordered),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);
	expect(firstPacket.timestamp).toBeCloseTo(2 * FRAME_DURATION);
	expect(firstPacket.duration).toBeCloseTo(2 * FRAME_DURATION);
	expect(secondPacket.timestamp).toBeCloseTo(4 * FRAME_DURATION);
	expect(secondPacket.duration).toBeCloseTo(2 * FRAME_DURATION);

	const packet = await sink.getPacket(3 * FRAME_DURATION);
	assert(packet);
	expect(packet.sequenceNumber).toBe(firstPacket.sequenceNumber);
	expect(packet.duration).toBe(firstPacket.duration);

	const keyPacket = await sink.getKeyPacket(Infinity);
	assert(keyPacket);
	expect(keyPacket.sequenceNumber).toBe(secondPacket.sequenceNumber);
	expect(keyPacket.duration).toBe(secondPacket.duration);
});

test('Leading frames presented before the first packet', async () => {
	const bytes = await muxAvc('avc1.64000a', [
		avcPacket([HIGH_SPS, HIGH_PPS, IDR_SLICE], 3, 'key'),
		avcPacket([B_SLICE], 1),
		avcPacket([B_SLICE], 2),
		avcPacket([P_SLICE], 6),
		avcPacket([B_SLICE], 4),
		avcPacket([B_SLICE], 5),
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	const secondPacket = await sink.getNextPacket(firstPacket);
	assert(secondPacket);
	expect(secondPacket.timestamp).toBeCloseTo(FRAME_DURATION);

	const packet = await sink.getPacket(1.5 * FRAME_DURATION);
	assert(packet);
	expect(packet.sequenceNumber).toBe(secondPacket.sequenceNumber);
	expect(packet.duration).toBe(secondPacket.duration);

	expect(await sink.getPacket(0.5 * FRAME_DURATION)).toBeNull();
	expect(await sink.getKeyPacket(2 * FRAME_DURATION)).toBeNull();
});

test('Padding PES packet spanning multiple TS packets', async () => {
	const bytes = await muxAvc('avc1.42c00a', [
		avcPacket([BASELINE_SPS, BASELINE_PPS, IDR_SLICE], 0, 'key'),
		avcPacket([P_SLICE], 1),
		avcPacket([P_SLICE], 2),
	]);

	// Two TS packets on the video PID holding a padding_stream PES packet
	const padding = new Uint8Array(2 * 188).fill(0xff);
	padding.set([0x47, 0x41, 0x00, 0x10, 0x00, 0x00, 0x01, 0xbe, 0x01, 0x6a]);
	padding.set([0x47, 0x01, 0x00, 0x11], 188);

	// Put it behind the PAT, the PMT and the first frame
	const withPadding = new Uint8Array(bytes.byteLength + padding.byteLength);
	withPadding.set(bytes.subarray(0, 3 * 188));
	withPadding.set(padding, 3 * 188);
	withPadding.set(bytes.subarray(3 * 188), 5 * 188);

	using input = new Input({
		source: new BufferSource(withPadding),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets).toHaveLength(3);
});

const muxAvc = async (codec: string, packets: EncodedPacket[]) => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();

	for (const packet of packets) {
		await source.add(packet, {
			decoderConfig: {
				codec,
				codedWidth: 16,
				codedHeight: 16,
			},
		});
	}

	await output.finalize();

	assert(output.target.buffer);
	return new Uint8Array(output.target.buffer);
};

const avcPacket = (nalUnits: Uint8Array[], frame: number, type: PacketType = 'delta') => new EncodedPacket(
	concatNalUnitsInAnnexB(nalUnits),
	type,
	frame * FRAME_DURATION,
	FRAME_DURATION,
);

test('HEVC end of sequence NAL unit', async () => {
	// Parameter sets and IDR slice of a 64x64 gray frame encoded by x265
	const vps = new Uint8Array([
		0x40, 0x01, 0x0c, 0x01, 0xff, 0xff, 0x04, 0x08, 0x00, 0x00, 0x03, 0x00,
		0x9f, 0xa8, 0x00, 0x00, 0x03, 0x00, 0x00, 0x1e, 0xba, 0x02, 0x40,
	]);
	const sps = new Uint8Array([
		0x42, 0x01, 0x01, 0x04, 0x08, 0x00, 0x00, 0x03, 0x00, 0x9f, 0xa8, 0x00, 0x00, 0x03, 0x00, 0x00, 0x1e, 0xa0,
		0x20, 0x81, 0x05, 0x96, 0xea, 0x49, 0x32, 0xbc, 0x05, 0xa0, 0x20, 0x00, 0x00, 0x03, 0x00, 0x20, 0x00, 0x00,
		0x03, 0x03, 0x21,
	]);
	const pps = new Uint8Array([0x44, 0x01, 0xc1, 0x72, 0xb0, 0x22, 0x40]);
	const idrSlice = new Uint8Array([0x28, 0x01, 0xaf, 0x78, 0xeb, 0xae, 0xfb, 0xfe, 0x75, 0x57, 0xcb, 0x4f]);
	const endOfSequence = new Uint8Array([0x48, 0x01]);

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('hevc');
	output.addVideoTrack(source);
	await output.start();

	for (const [i, nalUnits] of [[vps, sps, pps, idrSlice, endOfSequence], [vps, sps, pps, idrSlice]].entries()) {
		const packet = new EncodedPacket(concatNalUnitsInAnnexB(nalUnits), 'key', i * FRAME_DURATION, FRAME_DURATION);
		await source.add(packet, {
			decoderConfig: {
				codec: 'hev1.1.6.L30.90',
				codedWidth: 64,
				codedHeight: 64,
			},
		});
	}

	await output.finalize();
	assert(output.target.buffer);

	using input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	// The end of sequence NAL unit is the last one of the access unit it ends
	expect(packets).toHaveLength(2);
	expect([...packets[0]!.data.subarray(-6)]).toEqual([0x00, 0x00, 0x00, 0x01, 0x48, 0x01]);
	expect([...packets[1]!.data.subarray(-idrSlice.byteLength)]).toEqual([...idrSlice]);
});

test('Multiple 44.1 kHz AAC frames per PES packet', async () => {
	// An ADTS frame for AAC-LC at 44.1 kHz, whose 1024 samples don't make up a whole number of 90 kHz ticks
	const frame = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 0x21, 0x10, 0x05, 0x00]);
	const frameCount = 10;
	const data = new Uint8Array(frameCount * frame.byteLength);
	for (let i = 0; i < frameCount; i++) {
		data.set(frame, i * frame.byteLength);
	}

	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);
	await output.start();

	// The ADTS data gets written as-is, so all frames end up in one PES packet
	await source.add(new EncodedPacket(data, 'key', 0, 1024 * frameCount / 44100), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 44100,
		},
	});
	await output.finalize();
	assert(output.target.buffer);

	using input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	expect(packets).toHaveLength(frameCount);
	for (const [i, packet] of packets.entries()) {
		expect(Math.abs(packet.timestamp - 1024 * i / 44100)).toBeLessThanOrEqual(0.5 / 90_000);
	}
});

test('Duration of the only packet of an audio track', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/no-aud.ts')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	// 1024 samples at 16 kHz
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect(packet!.duration).toBe(0.064);
	expect(await track.computeDuration()).toBe(0.128);
});

test('Duration of the last video packet with B-frames', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/193039199_mp4_h264_aac_fhd_7.ts')),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);

	let lastPacket: EncodedPacket | null = null;
	for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
		if (!lastPacket || packet.timestamp > lastPacket.timestamp) {
			lastPacket = packet;
		}
	}

	// The same packet, looked up directly instead of reached by iteration
	const seekedPacket = await sink.getPacket(Infinity, { metadataOnly: true });
	expect(seekedPacket!.sequenceNumber).toBe(lastPacket!.sequenceNumber);
	expect(seekedPacket!.duration).toBe(lastPacket!.duration);
});
