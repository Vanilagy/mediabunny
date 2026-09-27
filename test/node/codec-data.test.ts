import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOpusTocByte } from '../../src/codec-data.js';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	OggOutputFormat,
	Output,
} from '../../src/index.js';
import { computeOggPageCrc } from '../../src/ogg/ogg-misc.js';

const OPUS_IDENTIFICATION_HEADER = new Uint8Array([
	0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // 'OpusHead'
	0x01, // Version
	0x01, // Channel count
	0x38, 0x01, // Pre-skip
	0x80, 0xbb, 0x00, 0x00, // Input sample rate
	0x00, 0x00, // Output gain
	0x00, // Channel mapping family
]);

const OPUS_COMMENT_HEADER = new Uint8Array([
	0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, // 'OpusTags'
	0x00, 0x00, 0x00, 0x00, // Vendor string length
	0x00, 0x00, 0x00, 0x00, // Comment count
]);

const createOggPage = (
	packets: Uint8Array[],
	sequenceNumber: number,
	headerType: number,
	serialNumber = 0x01234567,
	granulePosition = sequenceNumber >= 2 ? 480 : 0,
) => {
	const lacingValues: number[] = [];
	let payloadLength = 0;

	for (const packet of packets) {
		let remainingPacketLength = packet.length;
		while (remainingPacketLength >= 255) {
			lacingValues.push(255);
			remainingPacketLength -= 255;
		}
		lacingValues.push(remainingPacketLength);
		payloadLength += packet.length;
	}

	const page = new Uint8Array(27 + lacingValues.length + payloadLength);
	const view = new DataView(page.buffer);

	page.set([0x4f, 0x67, 0x67, 0x53]); // 'OggS'
	view.setUint8(4, 0); // Version
	view.setUint8(5, headerType);
	view.setUint32(6, granulePosition, true); // Granule position
	view.setInt32(10, 0, true);
	view.setUint32(14, serialNumber, true); // Serial number
	view.setUint32(18, sequenceNumber, true);
	view.setUint32(22, 0, true); // Checksum placeholder
	view.setUint8(26, lacingValues.length);
	page.set(lacingValues, 27);

	let payloadOffset = 27 + lacingValues.length;
	for (const packet of packets) {
		page.set(packet, payloadOffset);
		payloadOffset += packet.length;
	}

	view.setUint32(22, computeOggPageCrc(page), true);

	return page;
};

const createOggOpusStream = (audioPageSpecs: { packets: Uint8Array[]; headerType: number }[]) => {
	const pages = [
		createOggPage([OPUS_IDENTIFICATION_HEADER], 0, 0x02), // Beginning of stream
		createOggPage([OPUS_COMMENT_HEADER], 1, 0),
		...audioPageSpecs.map((spec, index) => createOggPage(spec.packets, index + 2, spec.headerType)),
	];
	const data = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0));

	let offset = 0;
	for (const page of pages) {
		data.set(page, offset);
		offset += page.length;
	}

	return { data, audioPages: pages.slice(2) };
};

test('Opus TOC rejects an empty packet', () => {
	expect(() => parseOpusTocByte(new Uint8Array())).toThrowError(/^Opus packet must not be empty\.$/);
});

test('Ogg output rejects an empty Opus packet', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source, {
		decoderConfig: {
			codec: 'opus',
			numberOfChannels: 1,
			sampleRate: 48000,
			description: OPUS_IDENTIFICATION_HEADER,
		},
	});

	await output.start();
	try {
		await expect(source.add(
			new EncodedPacket(new Uint8Array(), 'key', 0, 0),
		)).rejects.toThrowError(/^Opus packet must not be empty\.$/);
	} finally {
		await output.cancel();
	}
});

test('Ogg input rejects an explicit empty Opus packet', async () => {
	const { data, audioPages } = createOggOpusStream([
		{ packets: [new Uint8Array()], headerType: 0x04 },
	]);
	const audioPage = audioPages[0]!;
	const audioPageView = new DataView(audioPage.buffer, audioPage.byteOffset, audioPage.byteLength);

	expect(audioPage).toHaveLength(28);
	expect(audioPage[5]! & 0x04).toBe(0x04);
	expect(audioPage[26]).toBe(1);
	expect(audioPage[27]).toBe(0);
	expect(audioPageView.getUint32(22, true)).toBe(0x955e019e);

	using input = new Input({
		source: new BufferSource(data),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();

	expect(track).not.toBeNull();
	expect(await track!.getCodec()).toBe('opus');

	const sink = new EncodedPacketSink(track!);
	await expect(sink.getFirstPacket()).rejects.toThrowError(/^Opus packet must not be empty\.$/);
});

test('Ogg input rejects an empty non-EOS Opus packet', async () => {
	const { data, audioPages } = createOggOpusStream([
		{ packets: [new Uint8Array()], headerType: 0 },
		{ packets: [new Uint8Array([0])], headerType: 0x04 },
	]);

	expect(audioPages[0]![5]! & 0x04).toBe(0);
	expect(audioPages[1]![5]! & 0x04).toBe(0x04);

	using input = new Input({
		source: new BufferSource(data),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();

	expect(track).not.toBeNull();

	const sink = new EncodedPacketSink(track!);
	await expect(sink.getFirstPacket()).rejects.toThrowError(/^Opus packet must not be empty\.$/);
});

test('Ogg input rejects an empty non-final Opus packet on an EOS page', async () => {
	const { data, audioPages } = createOggOpusStream([
		{ packets: [new Uint8Array(), new Uint8Array([0])], headerType: 0x04 },
	]);
	const audioPage = audioPages[0]!;

	expect(audioPage[5]! & 0x04).toBe(0x04);
	expect(audioPage[26]).toBe(2);
	expect(audioPage.subarray(27, 29)).toEqual(new Uint8Array([0, 1]));
	expect(audioPage.subarray(29)).toEqual(new Uint8Array([0]));

	using input = new Input({
		source: new BufferSource(data),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();

	expect(track).not.toBeNull();

	const sink = new EncodedPacketSink(track!);
	await expect(sink.getFirstPacket()).rejects.toThrowError(/^Opus packet must not be empty\.$/);
});

test('Ogg input keeps reading after an empty non-final packet on a Vorbis EOS page', async () => {
	const fixture = new Uint8Array(readFileSync(new URL('../public/vorbis-eos.ogg', import.meta.url)));
	const originalEosPage = fixture.subarray(fixture.length - 28);
	const originalEosPageView = new DataView(
		originalEosPage.buffer,
		originalEosPage.byteOffset,
		originalEosPage.byteLength,
	);

	expect(originalEosPage.subarray(0, 4)).toEqual(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
	expect(originalEosPage[5]! & 0x04).toBe(0x04);
	expect(originalEosPage.subarray(26)).toEqual(new Uint8Array([1, 0]));

	using fixtureInput = new Input({
		source: new BufferSource(fixture),
		formats: ALL_FORMATS,
	});
	const fixtureTrack = await fixtureInput.getPrimaryAudioTrack();

	expect(fixtureTrack).not.toBeNull();

	const fixtureSink = new EncodedPacketSink(fixtureTrack!);
	const lastPacket = await fixtureSink.getPacket(Infinity);

	expect(lastPacket).not.toBeNull();
	expect(lastPacket!.data).toHaveLength(355);

	const replacementEosPage = createOggPage(
		[new Uint8Array(), lastPacket!.data],
		originalEosPageView.getUint32(18, true),
		originalEosPage[5]!,
		originalEosPageView.getUint32(14, true),
		originalEosPageView.getUint32(6, true),
	);

	expect(replacementEosPage[26]).toBe(3);
	expect(replacementEosPage.subarray(27, 30)).toEqual(new Uint8Array([0, 255, 100]));

	const data = new Uint8Array(fixture.length - originalEosPage.length + replacementEosPage.length);
	data.set(fixture.subarray(0, fixture.length - originalEosPage.length));
	data.set(replacementEosPage, fixture.length - originalEosPage.length);

	using input = new Input({
		source: new BufferSource(data),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();

	expect(track).not.toBeNull();

	const sink = new EncodedPacketSink(track!);
	let packet = await sink.getFirstPacket();
	let sawEmptyPacket = false;
	let packetAfterEmpty = null;

	while (packet) {
		if (sawEmptyPacket) {
			packetAfterEmpty = packet;
			break;
		}

		sawEmptyPacket = packet.data.length === 0;
		packet = await sink.getNextPacket(packet);
	}

	expect(sawEmptyPacket).toBe(true);
	expect(packetAfterEmpty?.data).toEqual(lastPacket!.data);
});

test('Ogg input demuxes a normal Opus EOS stream', async () => {
	const { data, audioPages } = createOggOpusStream([
		{ packets: [new Uint8Array([0])], headerType: 0x04 },
	]);
	const audioPage = audioPages[0]!;

	expect(audioPage[5]! & 0x04).toBe(0x04);
	expect(audioPage[26]).toBe(1);
	expect(audioPage[27]).toBe(1);

	using input = new Input({
		source: new BufferSource(data),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();

	expect(track).not.toBeNull();

	const sink = new EncodedPacketSink(track!);
	const firstPacket = await sink.getFirstPacket();

	expect(firstPacket).not.toBeNull();
	expect(firstPacket!.data).toEqual(new Uint8Array([0]));
	expect(firstPacket!.duration).toBe((480 - 312) / 48000);
	expect(await sink.getNextPacket(firstPacket!)).toBeNull();
});

test('Opus TOC accepts a zero-valued TOC byte', () => {
	expect(parseOpusTocByte(new Uint8Array([0]))).toEqual({
		durationInSamples: 480,
	});
});

test('Opus TOC rejects a code 3 packet without a frame count byte', () => {
	const packet = new Uint8Array([(31 << 3) | 0b11]);

	expect(() => parseOpusTocByte(packet)).toThrowError(
		/^Code 3 Opus packet is missing its frame count byte\.$/,
	);
});

test('Opus TOC rejects a masked zero frame count', () => {
	const packet = new Uint8Array([(31 << 3) | 0b11, 0b11000000]);

	expect(() => parseOpusTocByte(packet)).toThrowError(/^Opus packet must contain at least one frame\.$/);
});

test('Opus TOC rejects a packet duration over 120 milliseconds', () => {
	const packet = new Uint8Array([(31 << 3) | 0b11, 7]); // Seven 20 ms frames

	expect(() => parseOpusTocByte(packet)).toThrowError(
		/^Opus packet duration must not exceed 120 milliseconds\.$/,
	);
});

test('Opus TOC accepts a multi-frame packet at 120 milliseconds', () => {
	const packet = new Uint8Array([(31 << 3) | 0b11, 6]); // Six 20 ms frames

	expect(parseOpusTocByte(packet)).toEqual({
		durationInSamples: 5760,
	});
});

test('Opus TOC accepts 48 short frames at 120 milliseconds', () => {
	const packet = new Uint8Array([(16 << 3) | 0b11, 48]); // 48 2.5 ms frames

	expect(parseOpusTocByte(packet)).toEqual({
		durationInSamples: 5760,
	});
});
