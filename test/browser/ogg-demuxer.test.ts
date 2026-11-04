import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioBufferSink, EncodedPacketSink } from '../../src/media-sink.js';
import { assert, findLast, roundToDivisor, toDataView } from '../../src/misc.js';
import { computeOggPageCrc } from '../../src/ogg/ogg-misc.js';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

// VLC creates OGG files with an empty EOS page, which previously caused decoding errors
test('can decode OGG Vorbis file with empty EOS page', async () => {
	using input = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const sink = new AudioBufferSink(track);
	const buffers: AudioBuffer[] = [];

	for await (const { buffer } of sink.buffers(4, 10)) {
		buffers.push(buffer);
	}

	expect(buffers.length).toBeGreaterThan(0);
});

test('Pages completing only packets begun on earlier pages', async () => {
	// Cutting pages mid-packet, like libogg used to do once a page reached 4 kB, makes this happen for large packets
	await testOpusPackets(Array.from({ length: 30 }, (_, i) => opusPacket(i, 520)), 2, 0);
});

test('Opus start trimming', async () => {
	// A first page granule position below its packets' sample count means the difference is to be discarded at the
	// start. Opus forbids this, but FFmpeg does it anyway when cutting with stream copy, to mark the preroll it keeps.
	await testOpusPackets(Array.from({ length: 30 }, (_, i) => opusPacket(i, 3)), 10, -1000);
});

const OPUS_PACKET_DURATION = 960; // The TOC byte 0xf8 signals a single 20 ms CELT frame

test('Granule position on a page without packet ends', async () => {
	// Such a page should have a granule position of -1. If seeking lands right behind it, it can't step back to the
	// packet before the one it's looking for, which used to make it lose track of the timestamps.
	const pages = [
		oggPage(2, 0, 0, [opusHead()]),
		oggPage(0, 0, 1, [opusTags()]),
		oggPage(0, OPUS_PACKET_DURATION, 2, [opusPacket(0, 10)]),
		oggPage(0, -1, 3, [opusPacket(1, 255)]),
		oggPage(1, OPUS_PACKET_DURATION, 4, [new Uint8Array(255).fill(1)]),
		oggPage(1, 2 * OPUS_PACKET_DURATION, 5, [new Uint8Array(10).fill(1)]),
	];
	for (let i = 2; i < 17; i++) {
		pages.push(oggPage(i === 16 ? 4 : 0, OPUS_PACKET_DURATION * (i + 1), pages.length, [opusPacket(i, 10)]));
	}

	await testOpusFile(concat(pages), 17, 0);
});

test('Empty packets', async () => {
	// VLC ends streams with an empty packet on a page of its own
	const pages = [
		oggPage(2, 0, 0, [opusHead()]),
		oggPage(0, 0, 1, [opusTags()]),
	];
	for (let i = 0; i < 10; i++) {
		pages.push(oggPage(0, OPUS_PACKET_DURATION * (i + 1), pages.length, [opusPacket(i, 10)]));
	}
	pages.push(oggPage(4, OPUS_PACKET_DURATION * 10, pages.length, [new Uint8Array(0)]));

	await testOpusFile(concat(pages), 10, 0);

	// Anywhere else, they're invalid
	pages[6] = oggPage(0, OPUS_PACKET_DURATION * 5, 6, [opusPacket(4, 10), new Uint8Array(0)]);

	using input = new Input({
		source: new BufferSource(concat(pages)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	await expect((async () => {
		for await (const packet of new EncodedPacketSink(track).packets()) {
			void packet;
		}
	})()).rejects.toThrow('empty packets are only allowed at the very end of a stream');
});

const opusPacket = (index: number, size: number) => {
	const packet = new Uint8Array(size).fill(index);
	packet[0] = 0xf8;

	return packet;
};

const testOpusPackets = async (packets: Uint8Array[], segmentsPerPage: number, granuleOffset: number) => {
	await testOpusFile(oggOpusFile(packets, segmentsPerPage, granuleOffset), packets.length, granuleOffset);
};

const OPUS_PRE_SKIP = 312;

// Expects packets made by opusPacket, each one's index matching its position in the stream
const testOpusFile = async (file: Uint8Array, packetCount: number, granuleOffset: number) => {
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const expectedTimestamps = Array.from(
		{ length: packetCount },
		(_, i) => (OPUS_PACKET_DURATION * i + granuleOffset - OPUS_PRE_SKIP) / 48000,
	);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}
	expect(timestamps).toEqual(expectedTimestamps);

	for (let i = 0; i < packetCount; i++) {
		const packet = await sink.getPacket(expectedTimestamps[i]!);
		expect(packet?.timestamp).toBe(expectedTimestamps[i]);
		expect(packet?.data[1]).toBe(i);
	}

	expect(await track.computeDuration())
		.toBe((OPUS_PACKET_DURATION * packetCount + granuleOffset - OPUS_PRE_SKIP) / 48000);
};

// Lays out the packets' segments and then cuts them into pages of a fixed segment count, regardless of where packets
// begin or end
const oggOpusFile = (packets: Uint8Array[], segmentsPerPage: number, granuleOffset: number) => {
	const segments: { data: Uint8Array; endGranule: number | null }[] = [];
	for (let i = 0; i < packets.length; i++) {
		const packet = packets[i]!;

		for (let offset = 0; ; offset += 255) {
			const data = packet.subarray(offset, offset + 255);
			const endsPacket = data.length < 255;
			segments.push({
				data,
				endGranule: endsPacket ? OPUS_PACKET_DURATION * (i + 1) + granuleOffset : null,
			});

			if (endsPacket) {
				break;
			}
		}
	}

	const pages = [
		oggPage(2, 0, 0, [opusHead()]),
		oggPage(0, 0, 1, [opusTags()]),
	];
	for (let i = 0; i < segments.length; i += segmentsPerPage) {
		const pageSegments = segments.slice(i, i + segmentsPerPage);
		const isContinued = i > 0 && segments[i - 1]!.endGranule === null;
		const isLast = i + segmentsPerPage >= segments.length;

		pages.push(oggPage(
			(isContinued ? 1 : 0) | (isLast ? 4 : 0),
			findLast(pageSegments, x => x.endGranule !== null)?.endGranule ?? -1,
			pages.length,
			pageSegments.map(x => x.data),
		));
	}

	return concat(pages);
};

const opusHead = () => {
	const bytes = new Uint8Array(19);
	const view = new DataView(bytes.buffer);
	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // 'OpusHead'
	bytes[8] = 1; // Version
	bytes[9] = 2; // Channel count
	view.setUint16(10, OPUS_PRE_SKIP, true);
	view.setUint32(12, 48000, true);

	return bytes;
};

const opusTags = () => {
	const bytes = new Uint8Array(16);
	bytes.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // 'OpusTags', followed by no vendor and no comments

	return bytes;
};

const concat = (arrays: Uint8Array[]) => {
	const result = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));

	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.length;
	}

	return result;
};

test('MIME type without known codecs', async () => {
	using input = new Input({
		source: new BufferSource(oggPage(2, 0, 0, [new TextEncoder().encode('Speex   1.2.1')])),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(0);
	expect(await input.getMimeType()).toBe('audio/ogg');
});

// Each segment must be at most 255 bytes, and only the last one of a packet may be shorter than that
const oggPage = (headerType: number, granule: number, sequence: number, segments: Uint8Array[]) => {
	const dataSize = segments.reduce((sum, segment) => sum + segment.length, 0);
	const page = new Uint8Array(27 + segments.length + dataSize);
	const view = new DataView(page.buffer);

	page.set([0x4f, 0x67, 0x67, 0x53]); // 'OggS'
	page[5] = headerType;
	view.setUint32(6, granule >>> 0, true);
	view.setInt32(10, Math.floor(granule / 2 ** 32), true);
	view.setUint32(14, 1234, true); // Serial number
	view.setUint32(18, sequence, true);
	page[26] = segments.length;

	let offset = 27 + segments.length;
	for (let i = 0; i < segments.length; i++) {
		page[27 + i] = segments[i]!.length;
		page.set(segments[i]!, offset);
		offset += segments[i]!.length;
	}

	view.setUint32(22, computeOggPageCrc(page), true);
	return page;
};

test('Vorbis start trimming', async () => {
	// The fixture's granule positions are a bit off from its packet durations, so let's remux it to get exact ones
	const vorbis = await readVorbisFixture();

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(source);
	await output.start();

	for (const packet of vorbis.packets) {
		await source.add(packet, { decoderConfig: vorbis.decoderConfig });
	}
	await output.finalize();

	// Lowering all granule positions by the same amount means that many samples are to be discarded at the start.
	// FFmpeg does this when cutting with stream copy, to mark the preroll packets it keeps.
	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	for (let pos = 0; pos < file.length;) {
		const segmentCount = file[pos + 26]!;
		const dataSize = file.subarray(pos + 27, pos + 27 + segmentCount).reduce((a, b) => a + b, 0);
		const pageSize = 27 + segmentCount + dataSize;

		const granule = view.getBigInt64(pos + 6, true);
		if (granule > 0n) {
			view.setBigInt64(pos + 6, granule - 100n, true);
			view.setUint32(pos + 22, computeOggPageCrc(file.subarray(pos, pos + pageSize)), true);
		}

		pos += pageSize;
	}

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	expect(vorbis.packets[0]!.timestamp).toBe(-45 / 44100);
	expect(await track.getFirstTimestamp()).toBe(-145 / 44100);

	let lastPacket: EncodedPacket | null = null;
	for await (const packet of sink.packets()) {
		const seekedPacket = await sink.getPacket(packet.timestamp);
		expect(seekedPacket?.sequenceNumber).toBe(packet.sequenceNumber);
		expect(seekedPacket?.timestamp).toBe(packet.timestamp);
		lastPacket = packet;
	}

	assert(lastPacket);
	expect(await track.computeDuration()).toBe(roundToDivisor(lastPacket.timestamp + lastPacket.duration, 44100));
});

test('Vorbis seeking to a short block ahead of an empty final packet', async () => {
	// A short block following a long one is the kind of packet whose duration depends on the one before it
	const vorbis = await readVorbisFixture();
	const durations = vorbis.packets.map(packet => Math.round(44100 * packet.duration));
	const lastIndex = durations.findIndex((duration, i) => duration === 576 && durations[i + 1] === 128);

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(source);
	await output.start();

	for (const packet of vorbis.packets.slice(0, lastIndex + 1)) {
		await source.add(packet, { decoderConfig: vorbis.decoderConfig });
	}
	await output.finalize();

	// Like VLC does, end the stream with an empty packet on a page of its own instead
	const file = new Uint8Array(output.target.buffer!);
	let lastPagePos = 0;
	for (let pos = 0; pos < file.length;) {
		lastPagePos = pos;
		const segmentCount = file[pos + 26]!;
		pos += 27 + segmentCount + file.subarray(pos + 27, pos + 27 + segmentCount).reduce((a, b) => a + b, 0);
	}
	file[lastPagePos + 5] = 0;
	const lastPage = file.subarray(lastPagePos);
	toDataView(lastPage).setUint32(22, 0, true);
	toDataView(lastPage).setUint32(22, computeOggPageCrc(lastPage), true);

	const eosPage = new Uint8Array(28);
	eosPage.set(lastPage.subarray(0, 26));
	eosPage[5] = 4;
	toDataView(eosPage).setUint32(18, toDataView(lastPage).getUint32(18, true) + 1, true);
	toDataView(eosPage).setUint32(22, 0, true);
	eosPage[26] = 1; // A single segment of length 0
	toDataView(eosPage).setUint32(22, computeOggPageCrc(eosPage), true);

	using input = new Input({
		source: new BufferSource(concat([file, eosPage])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	let lastPacket: EncodedPacket | null = null;
	for await (const packet of sink.packets()) {
		lastPacket = packet;
	}
	assert(lastPacket);

	const seekedPacket = await sink.getPacket(Infinity);
	expect(seekedPacket?.sequenceNumber).toBe(lastPacket.sequenceNumber);
	expect(seekedPacket?.timestamp).toBe(lastPacket.timestamp);
	expect(seekedPacket?.duration).toBe(lastPacket.duration);
});

const readVorbisFixture = async () => {
	using input = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return { decoderConfig, packets };
};
