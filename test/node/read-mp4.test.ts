import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeAvVideoDecoder } from '../../packages/server/src/video-decoder.js';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
	VideoSample,
} from '../../src/index.js';
import { assert, base64ToBytes, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const DEFAULT_MOVIE_TIMESCALE = 57600;
const DEFAULT_TRACK_TIMESCALE = 1000;
const DEFAULT_EDIT_DURATION = 2.5 * DEFAULT_MOVIE_TIMESCALE;

const AVC_DECODER_CONFIG: VideoDecoderConfig = {
	codec: 'avc1.4d400a',
	codedWidth: 16,
	codedHeight: 16,
	description: base64ToBytes('AU1ACv/hABZnTUAK6I9gIgAAAwACAAADAAQeJEokAQAFaOvjyyA='),
};

// Four valid AVC frames encoded with x264 using two non-pyramidal B-frames. Their presentation order is I/B/B/P,
// while their required decode order is I/P/B/B. The SEI encoder-identification NAL was removed from the I-frame.
const AVC_PACKET_DATA = [
	base64ToBytes(
		'AAAA6mWIhAH/uAfRb167CBcO5VOaU0iXfWNnDEF0nkwbitGIDjdIe2iF7qGQNWccYeHFfwcUm4orb43L'
		+ 'A+tMU8irTJEQqAbUNm6JMsxvlLAFMQwL1GCjueh3szWrUNLlQEwy3WghC4aod6HODkp9fMTeQ4VQ5TRtD'
		+ 'XS5euxVkT7UL0Dwx8cMsTVtBE6LIIDiVnUxHn+XEWwWfsg4jOR888u6cYQz16A9jLkgKpTrbFFamUzjd4'
		+ '6Nk+AtuOOaeV7xznV8piraZnftERc4mU0gp/ulub0dNjXWEG8SKVAyo33F8XlyQa8N0/k39J9d4Q==',
	),
	base64ToBytes(
		'AAAAYkGaJtj/14TdylZe2p0KtI8gm4HV+tpd+SSeqGBHDAC7NzmuRCkqQRs8Lz5n737TukqjllO6nG49'
		+ 'P2X2usyvjhyscnqE3qYifxj1KmpppnvABdEmqvZ7zEU3u2iBm89ORvi4',
	),
	base64ToBytes('AAAAQQGeQvP/8ZSZebzHNIaEx/0QEfavpUWhsHWKSsQqHi7wFATwnkrjMuVSbYDMcvvw+9UByxCKhc/J/d7eH2WHFS3P'),
	base64ToBytes('AAAAGgGeRPP/5YszdHZZJBA2r5ZQFbCUpjjJS2cz'),
];
const AVC_PACKET_TYPES = ['key', 'delta', 'delta', 'delta'] as const;

type EditListEntry = {
	segmentDuration: number | bigint;
	mediaTime: number | bigint;
};

type PacketTiming = {
	timestamp: number;
	duration: number;
};

const DEFAULT_PACKET_TIMINGS: PacketTiming[] = [
	{ timestamp: 0, duration: 1 },
	{ timestamp: 3, duration: 1 },
	{ timestamp: 1, duration: 1 },
	{ timestamp: 2, duration: 1 },
];

type BoxLocation = {
	type: string;
	start: number;
	contentStart: number;
	end: number;
	size: number;
};

const readFourCc = (bytes: Uint8Array, offset: number) => {
	return String.fromCharCode(...bytes.subarray(offset, offset + 4));
};

const writeFourCc = (bytes: Uint8Array, offset: number, value: string) => {
	assert(value.length === 4);

	for (let i = 0; i < value.length; i++) {
		bytes[offset + i] = value.charCodeAt(i);
	}
};

const readBoxAt = (bytes: Uint8Array, offset: number, end: number): BoxLocation => {
	assert(offset + 8 <= end);

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let size = view.getUint32(offset, false);
	let headerSize = 8;

	if (size === 1) {
		assert(offset + 16 <= end);
		size = view.getUint32(offset + 8, false) * 2 ** 32 + view.getUint32(offset + 12, false);
		headerSize = 16;
	} else if (size === 0) {
		size = end - offset;
	}

	assert(size >= headerSize && offset + size <= end);

	return {
		type: readFourCc(bytes, offset + 4),
		start: offset,
		contentStart: offset + headerSize,
		end: offset + size,
		size,
	};
};

const findDirectBox = (
	bytes: Uint8Array,
	type: string,
	start = 0,
	end = bytes.byteLength,
) => {
	let offset = start;

	while (offset < end) {
		const box = readBoxAt(bytes, offset, end);
		if (box.type === type) {
			return box;
		}

		offset = box.end;
	}

	assert(offset === end);
	return null;
};

const findDirectBoxes = (
	bytes: Uint8Array,
	type: string,
	start = 0,
	end = bytes.byteLength,
) => {
	const boxes: BoxLocation[] = [];
	let offset = start;

	while (offset < end) {
		const box = readBoxAt(bytes, offset, end);
		if (box.type === type) {
			boxes.push(box);
		}
		offset = box.end;
	}

	assert(offset === end);
	return boxes;
};

const findNestedBox = (bytes: Uint8Array, path: string[]) => {
	let start = 0;
	let end = bytes.byteLength;
	let result: BoxLocation | null = null;

	for (const type of path) {
		result = findDirectBox(bytes, type, start, end);
		if (!result) {
			return null;
		}
		start = result.contentStart;
		end = result.end;
	}

	return result;
};

const findEditListBox = (bytes: Uint8Array) => {
	const moov = findDirectBox(bytes, 'moov');
	assert(moov);
	const trak = findDirectBox(bytes, 'trak', moov.contentStart, moov.end);
	assert(trak);
	const edts = findDirectBox(bytes, 'edts', trak.contentStart, trak.end);

	return edts && findDirectBox(bytes, 'elst', edts.contentStart, edts.end);
};

const createEditBox = (entries: EditListEntry[], version: 0 | 1 = 0) => {
	const bytes = new Uint8Array(24 + (version === 0 ? 12 : 20) * entries.length);
	const view = new DataView(bytes.buffer);

	view.setUint32(0, bytes.byteLength, false);
	writeFourCc(bytes, 4, 'edts');
	view.setUint32(8, bytes.byteLength - 8, false);
	writeFourCc(bytes, 12, 'elst');
	view.setUint32(16, version << 24, false); // Version and flags 0
	view.setUint32(20, entries.length, false);

	let offset = 24;
	for (const entry of entries) {
		const segmentDuration = BigInt(entry.segmentDuration);
		const mediaTime = BigInt(entry.mediaTime);

		if (version === 0) {
			assert(segmentDuration >= 0n && segmentDuration <= 0xffffffffn);
			assert(mediaTime >= -0x80000000n && mediaTime <= 0x7fffffffn);
			view.setUint32(offset, Number(segmentDuration), false);
			view.setInt32(offset + 4, Number(mediaTime), false);
			offset += 8;
		} else {
			view.setBigUint64(offset, segmentDuration, false);
			view.setBigInt64(offset + 8, mediaTime, false);
			offset += 16;
		}

		view.setInt16(offset, 1, false);
		view.setInt16(offset + 2, 0, false);
		offset += 4;
	}

	return bytes;
};

const concatenateBytes = (parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}

	return result;
};

const u32Bytes = (value: number) => {
	const result = new Uint8Array(4);
	new DataView(result.buffer).setUint32(0, value, false);
	return result;
};

const i32Bytes = (value: number) => {
	const result = new Uint8Array(4);
	new DataView(result.buffer).setInt32(0, value, false);
	return result;
};

const u64Bytes = (value: bigint) => {
	const result = new Uint8Array(8);
	new DataView(result.buffer).setBigUint64(0, value, false);
	return result;
};

const createBox = (type: string, ...contents: Uint8Array[]) => {
	const content = concatenateBytes(contents);
	const result = new Uint8Array(8 + content.byteLength);
	const view = new DataView(result.buffer);
	view.setUint32(0, result.byteLength, false);
	writeFourCc(result, 4, type);
	result.set(content, 8);

	return result;
};

const createFullBox = (type: string, version: number, flags: number, ...contents: Uint8Array[]) => {
	const versionAndFlags = u32Bytes(version * 2 ** 24 + flags);
	return createBox(type, versionAndFlags, ...contents);
};

const splitFragmentedSamplesIntoMoofs = (
	bytes: Uint8Array,
	packetTimings: PacketTiming[],
	packetTypes: readonly ('key' | 'delta')[],
	trackTimescale: number,
) => {
	const originalMoof = findDirectBox(bytes, 'moof');
	assert(originalMoof);
	const originalTraf = findDirectBox(bytes, 'traf', originalMoof.contentStart, originalMoof.end);
	assert(originalTraf);
	const originalTfhd = findDirectBox(bytes, 'tfhd', originalTraf.contentStart, originalTraf.end);
	assert(originalTfhd);
	const originalView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const trackId = originalView.getUint32(originalTfhd.contentStart + 4, false);
	const decodeTimestamps = packetTimings.map(timing => timing.timestamp).sort((a, b) => a - b);
	const fragments: Uint8Array[] = [];

	for (let i = 0; i < packetTimings.length; i++) {
		const timing = packetTimings[i]!;
		const decodeTimestamp = decodeTimestamps[i]!;
		const decodeTime = Math.round(decodeTimestamp * trackTimescale);
		const compositionOffset = Math.round((timing.timestamp - decodeTimestamp) * trackTimescale);
		const duration = Math.round(timing.duration * trackTimescale);
		const sampleFlags = packetTypes[i] === 'key' ? 0x02000000 : 0x01010000;
		const sampleData = AVC_PACKET_DATA[i]!;

		const mfhd = createFullBox('mfhd', 0, 0, u32Bytes(i + 1));
		const tfhd = createFullBox('tfhd', 0, 0x020000, u32Bytes(trackId));
		const tfdt = createFullBox('tfdt', 1, 0, u64Bytes(BigInt(decodeTime)));
		const createTrun = (dataOffset: number) => createFullBox(
			'trun',
			1,
			0x000f01,
			u32Bytes(1),
			u32Bytes(dataOffset),
			u32Bytes(duration),
			u32Bytes(sampleData.byteLength),
			u32Bytes(sampleFlags),
			i32Bytes(compositionOffset),
		);

		let traf = createBox('traf', tfhd, tfdt, createTrun(0));
		let moof = createBox('moof', mfhd, traf);
		traf = createBox('traf', tfhd, tfdt, createTrun(moof.byteLength + 8));
		moof = createBox('moof', mfhd, traf);
		fragments.push(moof, createBox('mdat', sampleData));
	}

	return concatenateBytes([bytes.slice(0, originalMoof.start), ...fragments]);
};

const writeU64 = (view: DataView, offset: number, value: number) => {
	view.setUint32(offset, Math.floor(value / 2 ** 32), false);
	view.setUint32(offset + 4, value, false);
};

const readU64 = (view: DataView, offset: number) => {
	return view.getUint32(offset, false) * 2 ** 32 + view.getUint32(offset + 4, false);
};

const patchFullBoxDuration = (
	bytes: Uint8Array,
	box: BoxLocation,
	version0Offset: number,
	version1Offset: number,
	value: number,
) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint8(box.contentStart);

	if (version === 0) {
		view.setUint32(box.contentStart + version0Offset, value, false);
	} else {
		assert(version === 1);
		writeU64(view, box.contentStart + version1Offset, value);
	}
};

const patchFullBoxTimescale = (
	bytes: Uint8Array,
	box: BoxLocation,
	version0Offset: number,
	version1Offset: number,
	value: number,
) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint8(box.contentStart);
	const offset = version === 0 ? version0Offset : version1Offset;
	assert(version === 0 || version === 1);
	view.setUint32(box.contentStart + offset, value, false);
};

const addEditList = (
	bytes: Uint8Array,
	entries: EditListEntry[],
	movieTimescale: number,
	version: 0 | 1 = 0,
	patchPresentationDuration = true,
) => {
	const moov = findDirectBox(bytes, 'moov');
	assert(moov);
	const mvhd = findDirectBox(bytes, 'mvhd', moov.contentStart, moov.end);
	assert(mvhd);
	const trak = findDirectBox(bytes, 'trak', moov.contentStart, moov.end);
	assert(trak);
	const tkhd = findDirectBox(bytes, 'tkhd', trak.contentStart, trak.end);
	assert(tkhd);
	assert(!findDirectBox(bytes, 'edts', trak.contentStart, trak.end));
	const placeholder = findDirectBox(bytes, 'udta', trak.contentStart, trak.end);
	assert(placeholder);

	const editBox = createEditBox(entries, version);
	assert(placeholder.size === editBox.byteLength);
	const result = bytes.slice();
	result.set(editBox, placeholder.start);

	patchFullBoxTimescale(result, mvhd, 12, 20, movieTimescale);
	if (patchPresentationDuration) {
		const presentationDuration = entries.reduce((sum, entry) => sum + BigInt(entry.segmentDuration), 0n);
		assert(presentationDuration <= BigInt(Number.MAX_SAFE_INTEGER));
		patchFullBoxDuration(result, mvhd, 16, 24, Number(presentationDuration));
		patchFullBoxDuration(result, tkhd, 20, 28, Number(presentationDuration));
	}

	return result;
};

const parseFixtureEditList = (bytes: Uint8Array) => {
	const elst = findEditListBox(bytes);
	assert(elst);

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const versionAndFlags = view.getUint32(elst.contentStart, false);
	const version = versionAndFlags >>> 24;
	const flags = versionAndFlags & 0xffffff;
	const entryCount = view.getUint32(elst.contentStart + 4, false);
	let offset = elst.contentStart + 8;
	const entries = [] as {
		segmentDuration: number | bigint;
		mediaTime: number | bigint;
		mediaRateInteger: number;
		mediaRateFraction: number;
	}[];

	for (let i = 0; i < entryCount; i++) {
		let segmentDuration: number | bigint;
		let mediaTime: number | bigint;

		if (version === 1) {
			segmentDuration = view.getBigUint64(offset, false);
			mediaTime = view.getBigInt64(offset + 8, false);
			offset += 16;
		} else {
			assert(version === 0);
			segmentDuration = view.getUint32(offset, false);
			mediaTime = view.getInt32(offset + 4, false);
			offset += 8;
		}

		entries.push({
			segmentDuration,
			mediaTime,
			mediaRateInteger: view.getInt16(offset, false),
			mediaRateFraction: view.getInt16(offset + 2, false),
		});
		offset += 4;
	}

	assert(offset === elst.end);
	return { version, flags, entryCount, entries };
};

const createEditListFixture = async ({
	fragmented,
	movieTimescale = DEFAULT_MOVIE_TIMESCALE,
	trackTimescale = DEFAULT_TRACK_TIMESCALE,
	entries = [{ segmentDuration: DEFAULT_EDIT_DURATION, mediaTime: 0 }],
	packetTimings = DEFAULT_PACKET_TIMINGS,
	packetTypes = AVC_PACKET_TYPES,
	editListVersion = 0,
	patchPresentationDuration = true,
	fragmentPerPacket = false,
	omitMfra = false,
}: {
	fragmented: boolean;
	movieTimescale?: number;
	trackTimescale?: number;
	entries?: EditListEntry[];
	packetTimings?: PacketTiming[];
	packetTypes?: readonly ('key' | 'delta')[];
	editListVersion?: 0 | 1;
	patchPresentationDuration?: boolean;
	fragmentPerPacket?: boolean;
	omitMfra?: boolean;
}) => {
	assert(packetTimings.length <= AVC_PACKET_DATA.length);
	assert(packetTypes.length >= packetTimings.length);
	assert(!fragmentPerPacket || fragmented);
	assert(!omitMfra || fragmented);
	const editBox = createEditBox(entries, editListVersion);
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : false }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('avc');
	// The udta size is 16 bytes plus the UTF-8 track-name length. Matching it to edts/elst permits an in-place swap.
	// Replacing it in place keeps every parent size, media offset, fragment offset, and random-access index intact.
	output.addVideoTrack(source, {
		frameRate: trackTimescale,
		name: 'x'.repeat(editBox.byteLength - 16),
	});

	await output.start();

	for (let i = 0; i < packetTimings.length; i++) {
		const timing = packetTimings[i]!;
		const packet = new EncodedPacket(
			AVC_PACKET_DATA[i]!,
			packetTypes[i]!,
			timing.timestamp,
			timing.duration,
		);
		await source.add(packet, i === 0 ? { decoderConfig: AVC_DECODER_CONFIG } : undefined);
	}

	await output.finalize();

	let withoutEditList = new Uint8Array(output.target.buffer!).slice();
	if (fragmentPerPacket) {
		withoutEditList = splitFragmentedSamplesIntoMoofs(
			withoutEditList,
			packetTimings,
			packetTypes,
			trackTimescale,
		);
	}
	if (omitMfra) {
		const mfra = findDirectBox(withoutEditList, 'mfra');
		if (mfra) {
			assert(mfra.end === withoutEditList.byteLength);
			withoutEditList = withoutEditList.slice(0, mfra.start);
		}
		expect(findDirectBox(withoutEditList, 'mfra')).toBeNull();
	}
	return {
		withoutEditList,
		withEditList: addEditList(
			withoutEditList,
			entries,
			movieTimescale,
			editListVersion,
			patchPresentationDuration,
		),
	};
};

const splitFragmentedFile = (bytes: Uint8Array) => {
	const firstMoof = findDirectBox(bytes, 'moof');
	assert(firstMoof);

	return {
		init: bytes.slice(0, firstMoof.start),
		media: bytes.slice(firstMoof.start),
	};
};

const withInput = async <T>(
	bytes: Uint8Array,
	initBytes: Uint8Array | null,
	callback: (input: Input) => Promise<T>,
) => {
	const initInput = initBytes && new Input({
		source: new BufferSource(initBytes),
		formats: ALL_FORMATS,
	});
	const input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
		initInput: initInput ?? undefined,
	});

	try {
		return await callback(input);
	} finally {
		input.dispose();
		initInput?.dispose();
	}
};

const inspectTrack = async (bytes: Uint8Array, initBytes: Uint8Array | null = null) => {
	return withInput(bytes, initBytes, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);
		const packets: EncodedPacket[] = [];

		for await (const packet of sink.packets()) {
			packets.push(packet);
		}

		return {
			packets,
			presentationPackets: await Promise.all([0, 1, 2].map(timestamp => sink.getPacket(timestamp))),
			lastPresentationPacket: await sink.getPacket(Infinity),
			packetAtThreeSeconds: await sink.getPacket(3),
			duration: await track.computeDuration(),
			metadataDuration: await track.getDurationFromMetadata(),
			timeResolution: await track.getTimeResolution(),
		};
	});
};

const parseHeaderTiming = (bytes: Uint8Array, box: BoxLocation) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint8(box.contentStart);
	assert(version === 0 || version === 1);
	const timescaleOffset = box.contentStart + (version === 0 ? 12 : 20);
	const durationOffset = box.contentStart + (version === 0 ? 16 : 24);

	return {
		timescale: view.getUint32(timescaleOffset, false),
		duration: version === 0 ? view.getUint32(durationOffset, false) : readU64(view, durationOffset),
	};
};

const parseTrackHeaderDuration = (bytes: Uint8Array, box: BoxLocation) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint8(box.contentStart);
	assert(version === 0 || version === 1);
	const durationOffset = box.contentStart + (version === 0 ? 20 : 28);

	return version === 0 ? view.getUint32(durationOffset, false) : readU64(view, durationOffset);
};

const parseNonFragmentedSampleTimings = (bytes: Uint8Array) => {
	const stts = findNestedBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
	assert(stts);
	const ctts = findNestedBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'ctts']);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const durations: number[] = [];

	let offset = stts.contentStart + 4;
	const sttsEntryCount = view.getUint32(offset, false);
	offset += 4;
	for (let i = 0; i < sttsEntryCount; i++) {
		const sampleCount = view.getUint32(offset, false);
		const sampleDuration = view.getUint32(offset + 4, false);
		for (let j = 0; j < sampleCount; j++) {
			durations.push(sampleDuration);
		}
		offset += 8;
	}
	assert(offset === stts.end);

	const compositionOffsets: number[] = [];
	if (ctts) {
		const version = view.getUint8(ctts.contentStart);
		offset = ctts.contentStart + 4;
		const cttsEntryCount = view.getUint32(offset, false);
		offset += 4;
		for (let i = 0; i < cttsEntryCount; i++) {
			const sampleCount = view.getUint32(offset, false);
			const compositionOffset = version === 0
				? view.getUint32(offset + 4, false)
				: view.getInt32(offset + 4, false);
			for (let j = 0; j < sampleCount; j++) {
				compositionOffsets.push(compositionOffset);
			}
			offset += 8;
		}
		assert(offset === ctts.end);
	} else {
		compositionOffsets.push(...durations.map(() => 0));
	}
	assert(compositionOffsets.length === durations.length);

	let decodeTimestamp = 0;
	return durations.map((duration, index) => {
		const timing = {
			presentationTimestamp: decodeTimestamp + compositionOffsets[index]!,
			duration,
		};
		decodeTimestamp += duration;
		return timing;
	});
};

const parseTrackFragmentHeader = (bytes: Uint8Array, tfhd: BoxLocation) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const flags = view.getUint32(tfhd.contentStart, false) & 0xffffff;
	let offset = tfhd.contentStart + 8; // Full-box header and track_ID

	if (flags & 0x000001) {
		offset += 8;
	}
	if (flags & 0x000002) {
		offset += 4;
	}
	const defaultSampleDuration = flags & 0x000008 ? view.getUint32(offset, false) : null;
	if (flags & 0x000008) {
		offset += 4;
	}
	if (flags & 0x000010) {
		offset += 4;
	}
	if (flags & 0x000020) {
		offset += 4;
	}
	assert(offset === tfhd.end);

	return defaultSampleDuration;
};

const parseFragmentedSampleTimings = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const timings: { presentationTimestamp: number; duration: number }[] = [];

	for (const moof of findDirectBoxes(bytes, 'moof')) {
		for (const traf of findDirectBoxes(bytes, 'traf', moof.contentStart, moof.end)) {
			const tfhd = findDirectBox(bytes, 'tfhd', traf.contentStart, traf.end);
			const tfdt = findDirectBox(bytes, 'tfdt', traf.contentStart, traf.end);
			assert(tfhd && tfdt);
			const defaultSampleDuration = parseTrackFragmentHeader(bytes, tfhd);
			const tfdtVersion = view.getUint8(tfdt.contentStart);
			let decodeTimestamp = tfdtVersion === 0
				? view.getUint32(tfdt.contentStart + 4, false)
				: readU64(view, tfdt.contentStart + 4);

			for (const trun of findDirectBoxes(bytes, 'trun', traf.contentStart, traf.end)) {
				const version = view.getUint8(trun.contentStart);
				const flags = view.getUint32(trun.contentStart, false) & 0xffffff;
				let offset = trun.contentStart + 4;
				const sampleCount = view.getUint32(offset, false);
				offset += 4;
				if (flags & 0x000001) {
					offset += 4;
				}
				if (flags & 0x000004) {
					offset += 4;
				}

				for (let i = 0; i < sampleCount; i++) {
					const duration = flags & 0x000100 ? view.getUint32(offset, false) : defaultSampleDuration;
					assert(duration !== null);
					if (flags & 0x000100) {
						offset += 4;
					}
					if (flags & 0x000200) {
						offset += 4;
					}
					if (flags & 0x000400) {
						offset += 4;
					}
					let compositionOffset = 0;
					if (flags & 0x000800) {
						compositionOffset = version === 0
							? view.getUint32(offset, false)
							: view.getInt32(offset, false);
						offset += 4;
					}

					timings.push({
						presentationTimestamp: decodeTimestamp + compositionOffset,
						duration,
					});
					decodeTimestamp += duration;
				}
				assert(offset === trun.end);
			}
		}
	}

	return timings;
};

const parseFragmentDecodeTimes = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return findDirectBoxes(bytes, 'moof').map((moof) => {
		const traf = findDirectBox(bytes, 'traf', moof.contentStart, moof.end);
		assert(traf);
		const tfdt = findDirectBox(bytes, 'tfdt', traf.contentStart, traf.end);
		assert(tfdt);
		const version = view.getUint8(tfdt.contentStart);
		assert(version === 0 || version === 1);

		return version === 0
			? view.getUint32(tfdt.contentStart + 4, false)
			: readU64(view, tfdt.contentStart + 4);
	});
};

const probeFixture = (bytes: Uint8Array) => {
	const mvhd = findNestedBox(bytes, ['moov', 'mvhd']);
	const tkhd = findNestedBox(bytes, ['moov', 'trak', 'tkhd']);
	const mdhd = findNestedBox(bytes, ['moov', 'trak', 'mdia', 'mdhd']);
	const stsz = findNestedBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
	assert(mvhd && tkhd && mdhd && stsz);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const moofs = findDirectBoxes(bytes, 'moof');
	const trunCount = moofs.reduce((sum, moof) => {
		return sum + findDirectBoxes(bytes, 'traf', moof.contentStart, moof.end).reduce((trafSum, traf) => {
			return trafSum + findDirectBoxes(bytes, 'trun', traf.contentStart, traf.end).length;
		}, 0);
	}, 0);

	return {
		movieHeader: parseHeaderTiming(bytes, mvhd),
		trackHeaderDuration: parseTrackHeaderDuration(bytes, tkhd),
		mediaHeader: parseHeaderTiming(bytes, mdhd),
		structure: {
			moofCount: moofs.length,
			trunCount,
			sampleTableSampleCount: view.getUint32(stsz.contentStart + 8, false),
			hasCompositionTimeTable:
				findNestedBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'ctts']) !== null,
		},
		sampleTimings: moofs.length > 0
			? parseFragmentedSampleTimings(bytes)
			: parseNonFragmentedSampleTimings(bytes),
	};
};

const patchMediaTimescale = (bytes: Uint8Array, mediaTimescale: number) => {
	const result = bytes.slice();
	const mdhd = findNestedBox(result, ['moov', 'trak', 'mdia', 'mdhd']);
	assert(mdhd);
	patchFullBoxTimescale(result, mdhd, 12, 20, mediaTimescale);

	return result;
};

const patchFirstFragmentDecodeTime = (bytes: Uint8Array, decodeTime: bigint) => {
	const result = bytes.slice();
	const moof = findDirectBox(result, 'moof');
	assert(moof);
	const traf = findDirectBox(result, 'traf', moof.contentStart, moof.end);
	assert(traf);
	const tfdt = findDirectBox(result, 'tfdt', traf.contentStart, traf.end);
	assert(tfdt);

	const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
	expect(view.getUint8(tfdt.contentStart)).toBe(1);
	view.setBigUint64(tfdt.contentStart + 4, decodeTime, false);

	return result;
};

const patchAdversarialMediaTimescale = (
	bytes: Uint8Array,
	mediaTimescale: number,
	compositionOffsets: readonly [number, number, number] = [0, mediaTimescale - 2, mediaTimescale - 2],
) => {
	const result = bytes.slice();
	const mdhd = findNestedBox(result, ['moov', 'trak', 'mdia', 'mdhd']);
	const stts = findNestedBox(result, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
	const ctts = findNestedBox(result, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'ctts']);
	assert(mdhd && stts && ctts);
	patchFullBoxTimescale(result, mdhd, 12, 20, mediaTimescale);
	patchFullBoxDuration(result, mdhd, 16, 24, AVC_PACKET_DATA.length);

	const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
	expect(view.getUint32(stts.contentStart + 4, false)).toBe(1);
	expect(view.getUint32(stts.contentStart + 8, false)).toBe(4);
	view.setUint32(stts.contentStart + 12, 1, false);
	expect(view.getUint32(ctts.contentStart + 4, false)).toBe(3);
	expect(view.getUint32(ctts.contentStart + 8, false)).toBe(1);
	expect(view.getUint32(ctts.contentStart + 16, false)).toBe(1);
	expect(view.getUint32(ctts.contentStart + 24, false)).toBe(2);
	view.setUint32(ctts.contentStart + 12, compositionOffsets[0], false);
	view.setUint32(ctts.contentStart + 20, compositionOffsets[1], false);
	view.setUint32(ctts.contentStart + 28, compositionOffsets[2], false);

	return result;
};

const decodePacketSubset = async (packetIndices: number[]) => {
	const decoder = new NodeAvVideoDecoder();
	const samples: VideoSample[] = [];
	let decoderError: unknown = null;

	// @ts-expect-error Readonly custom-decoder initialization fields
	decoder.codec = 'avc';
	// @ts-expect-error Readonly custom-decoder initialization fields
	decoder.config = { ...AVC_DECODER_CONFIG, hardwareAcceleration: 'prefer-software' };
	// @ts-expect-error Readonly custom-decoder initialization fields
	decoder.onSample = (sample: VideoSample) => samples.push(sample);
	// @ts-expect-error Readonly custom-decoder initialization fields
	decoder.onError = (error) => {
		decoderError = error;
		return undefined;
	};

	await decoder.init();
	try {
		for (const index of packetIndices) {
			const timing = DEFAULT_PACKET_TIMINGS[index]!;
			await decoder.decode(new EncodedPacket(
				AVC_PACKET_DATA[index]!,
				AVC_PACKET_TYPES[index]!,
				timing.timestamp,
				timing.duration,
			));
		}
		await decoder.flush();
		if (decoderError) {
			throw decoderError instanceof Error ? decoderError : new Error('Decoder failed.');
		}

		const result = [] as { timestamp: number; rgbaSha256: string }[];
		for (const sample of samples) {
			const rgba = new Uint8Array(sample.allocationSize({ format: 'RGBA' }));
			await sample.copyTo(rgba, { format: 'RGBA' });
			result.push({
				timestamp: sample.timestamp,
				rgbaSha256: createHash('sha256').update(rgba).digest('hex'),
			});
		}
		return result;
	} finally {
		samples.forEach(sample => sample.close());
		await decoder.close();
	}
};

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const sink = new EncodedPacketSink(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

// Annex B isn't supposed to exist in MP4, but some files have it anyway, with an empty avcC box
test('Annex B', async () => {
	const filePath = path.join(__dirname, '..', 'public/annex-b.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('avc1.424028');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const firstPacket = (await sink.getFirstPacket())!;
	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
});

test('HE-AAC v2 audio config is parsed correctly', async () => {
	const filePath = path.join(__dirname, '..', 'public/he-aac-v2.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.getNumberOfChannels()).toBe(2);

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('mp4a.40.29');
	expect(decoderConfig.sampleRate).toBe(44100);
	expect(decoderConfig.numberOfChannels).toBe(2);
	expect([...toUint8Array(decoderConfig.description!)]).toEqual([0xeb, 0x8a, 0x08, 0x00]);
});

for (const fixtureMode of [
	{ name: 'non-fragmented', fragmented: false, split: false },
	{ name: 'fragmented', fragmented: true, split: false },
	{ name: 'split init/media', fragmented: true, split: true },
]) {
	test(`ISOBMFF edit end separates presentation from decode order (${fixtureMode.name})`, async () => {
		const fixture = await createEditListFixture({ fragmented: fixtureMode.fragmented });
		const controlParts = fixtureMode.split ? splitFragmentedFile(fixture.withoutEditList) : null;
		const editedParts = fixtureMode.split ? splitFragmentedFile(fixture.withEditList) : null;
		if (editedParts) {
			expect(findDirectBox(editedParts.init, 'moov')).not.toBeNull();
			expect(findDirectBox(editedParts.init, 'moof')).toBeNull();
			expect(findDirectBox(editedParts.media, 'moov')).toBeNull();
			expect(findDirectBox(editedParts.media, 'moof')).not.toBeNull();
		}
		const control = await inspectTrack(
			controlParts?.media ?? fixture.withoutEditList,
			controlParts?.init ?? null,
		);
		const edited = await inspectTrack(
			editedParts?.media ?? fixture.withEditList,
			editedParts?.init ?? null,
		);

		expect(findEditListBox(fixture.withoutEditList)).toBeNull();
		expect(parseFixtureEditList(fixture.withEditList)).toEqual({
			version: 0,
			flags: 0,
			entryCount: 1,
			entries: [{
				segmentDuration: 144000,
				mediaTime: 0,
				mediaRateInteger: 1,
				mediaRateFraction: 0,
			}],
		});

		const rawProof = probeFixture(fixture.withEditList);
		expect(rawProof.movieHeader).toEqual({ timescale: 57600, duration: 144000 });
		expect(rawProof.trackHeaderDuration).toBe(144000);
		expect(rawProof.mediaHeader).toEqual({
			timescale: 1000,
			duration: fixtureMode.fragmented ? 0 : 4000,
		});
		expect(rawProof.structure).toEqual(fixtureMode.fragmented
			? {
					moofCount: 1,
					trunCount: 1,
					sampleTableSampleCount: 0,
					hasCompositionTimeTable: false,
				}
			: {
					moofCount: 0,
					trunCount: 0,
					sampleTableSampleCount: 4,
					hasCompositionTimeTable: true,
				});
		expect(rawProof.sampleTimings).toEqual([
			{ presentationTimestamp: 0, duration: 1000 },
			{ presentationTimestamp: 3000, duration: 1000 },
			{ presentationTimestamp: 1000, duration: 1000 },
			{ presentationTimestamp: 2000, duration: 1000 },
		]);

		expect(control.timeResolution).toBe(1000);
		expect(control.packets.map(packet => packet.timestamp * 1000)).toEqual([0, 3000, 1000, 2000]);
		expect(control.packets.map(packet => packet.duration * 1000)).toEqual([1000, 1000, 1000, 1000]);
		expect(edited.timeResolution).toBe(1000);
		expect(edited.packets.map(packet => packet.timestamp * 1000)).toEqual([0, 3000, 1000, 2000]);
		expect(edited.packets.map(packet => packet.duration * 1000)).toEqual([1000, 0, 1000, 500]);
		expect(edited.presentationPackets.map(packet => packet?.timestamp)).toEqual([0, 1, 2]);
		expect(edited.presentationPackets.map(packet => packet && packet.duration * 1000))
			.toEqual([1000, 1000, 500]);
		expect(edited.packets[1]!.data).toEqual(AVC_PACKET_DATA[1]);
		expect(edited.packets[1]!.sequenceNumber).toBeLessThan(edited.packets[3]!.sequenceNumber);

		const lastPacket = edited.lastPresentationPacket;
		assert(lastPacket);
		expect(lastPacket.data).toEqual(AVC_PACKET_DATA[3]);
		expect(lastPacket.timestamp).toBe(2);
		expect(lastPacket.duration).toBe(0.5);
		expect(lastPacket.timestamp + lastPacket.duration).toBe(2.5);
		expect(edited.packetAtThreeSeconds?.sequenceNumber).toBe(lastPacket.sequenceNumber);
		expect(edited.duration).toBe(2.5);
		expect(edited.metadataDuration).toBe(2.5);
	});
}

for (const fragmented of [false, true]) {
	test(`ISOBMFF packet iteration preserves a 100 ms edit and its decode dependencies (${fragmented})`, async () => {
		const fixture = await createEditListFixture({
			fragmented,
			movieTimescale: 1000,
			entries: [{ segmentDuration: 100, mediaTime: 0 }],
			packetTimings: [0, 0.12, 0.04, 0.08].map(timestamp => ({ timestamp, duration: 0.04 })),
		});
		const { packets } = await inspectTrack(fixture.withEditList);
		expect(packets.map(packet => [packet.timestamp, packet.duration])).toEqual([
			[0, 0.04], [0.12, 0], [0.04, 0.04], [0.08, 0.02],
		]);
		expect(packets.map(packet => packet.data)).toEqual(AVC_PACKET_DATA);
	});
}

test('ISOBMFF fragmented edit lookup scans later lower-PTS moofs on fresh and warm inputs', async () => {
	const fixture = await createEditListFixture({
		fragmented: true,
		fragmentPerPacket: true,
		omitMfra: true,
	});
	const rawProof = probeFixture(fixture.withEditList);

	expect(findDirectBox(fixture.withEditList, 'mfra')).toBeNull();
	expect(rawProof.structure).toEqual({
		moofCount: 4,
		trunCount: 4,
		sampleTableSampleCount: 0,
		hasCompositionTimeTable: false,
	});
	expect(rawProof.sampleTimings).toEqual([
		{ presentationTimestamp: 0, duration: 1000 },
		{ presentationTimestamp: 3000, duration: 1000 },
		{ presentationTimestamp: 1000, duration: 1000 },
		{ presentationTimestamp: 2000, duration: 1000 },
	]);
	expect(parseFragmentDecodeTimes(fixture.withEditList)).toEqual([0, 1000, 2000, 3000]);

	const freshPacket = await withInput(fixture.withEditList, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getPacket(Infinity);
		assert(packet);
		return [packet.timestamp, packet.duration];
	});
	const freshDuration = await withInput(fixture.withEditList, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		return track.computeDuration();
	});
	const warm = await withInput(fixture.withEditList, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const sink = new EncodedPacketSink(track);
		const decodeOrder: [number, number][] = [];
		for await (const packet of sink.packets()) {
			decodeOrder.push([packet.timestamp, packet.duration]);
		}

		const packet = await sink.getPacket(Infinity);
		assert(packet);
		return {
			decodeOrder,
			packet: [packet.timestamp, packet.duration],
			duration: await track.computeDuration(),
		};
	});

	expect(freshPacket).toEqual([2, 0.5]);
	expect(freshDuration).toBe(2.5);
	expect(warm).toEqual({
		decodeOrder: [[0, 1], [3, 0], [1, 1], [2, 0.5]],
		packet: [2, 0.5],
		duration: 2.5,
	});
});

test('ISOBMFF getKeyPacket caps a later key packet at the edit end', async () => {
	const fixture = await createEditListFixture({
		fragmented: false,
		packetTypes: ['key', 'key', 'delta', 'delta'],
	});

	const getLastKeyPacket = (bytes: Uint8Array) => withInput(bytes, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getKeyPacket(Infinity);
		assert(packet);
		return [packet.timestamp, packet.duration];
	});

	expect(await getLastKeyPacket(fixture.withoutEditList)).toEqual([3, 1]);
	expect(await getLastKeyPacket(fixture.withEditList)).toEqual([0, 1]);
});

test('ISOBMFF edit fixture proves its AVC future-reference dependency', async () => {
	const completeDecode = await decodePacketSubset([0, 1, 2, 3]);
	const decodeWithoutFutureReference = await decodePacketSubset([0, 2, 3]);

	expect(completeDecode.map(frame => frame.timestamp)).toEqual([0, 1, 2, 3]);
	expect(decodeWithoutFutureReference.map(frame => frame.timestamp)).toEqual([0, 1, 2]);

	const digestsWithFutureReference = completeDecode.map(frame => frame.rgbaSha256);
	const digestsWithoutFutureReference = decodeWithoutFutureReference.map(frame => frame.rgbaSha256);
	expect(digestsWithoutFutureReference[0]).toBe(digestsWithFutureReference[0]);
	expect(digestsWithoutFutureReference[1]).not.toBe(digestsWithFutureReference[1]);
	expect(digestsWithoutFutureReference[2]).not.toBe(digestsWithFutureReference[2]);
});

test('ISOBMFF edit end preserves the time-resolution contract across independent timescales', async () => {
	const fixture = await createEditListFixture({
		fragmented: false,
		movieTimescale: 3,
		trackTimescale: 2,
		entries: [{ segmentDuration: 1, mediaTime: 0 }],
		packetTimings: DEFAULT_PACKET_TIMINGS.map(timing => ({
			timestamp: timing.timestamp / 2,
			duration: 0.5,
		})),
	});
	const edited = await inspectTrack(fixture.withEditList);
	const lastPacket = edited.lastPresentationPacket;
	assert(lastPacket);

	expect(probeFixture(fixture.withEditList).mediaHeader.timescale).toBe(2);
	expect(edited.timeResolution).toBe(6);
	expect(edited.packets.map(packet => packet.timestamp * 6)).toEqual([0, 9, 3, 6]);
	expect(edited.packets.map(packet => packet.duration * 6)).toEqual([2, 0, 0, 0]);
	expect(lastPacket.timestamp).toBe(0);
	expect(lastPacket.duration).toBe(1 / 3);
	expect(lastPacket.duration * edited.timeResolution).toBe(2);
	expect(edited.duration).toBe(1 / 3);
});

test('ISOBMFF version-1 edit boundary preserves 64-bit packet eligibility', async () => {
	const movieTimescale = 4294967294;
	const mediaTimescale = 2147483647;
	const segmentDuration = 2n ** 53n + 1n;
	const eligibleTick = 2n ** 52n;
	const scaffold = await createEditListFixture({
		fragmented: true,
		movieTimescale,
		entries: [{ segmentDuration, mediaTime: 0n }],
		packetTimings: [{ timestamp: 0, duration: 1 }],
		editListVersion: 1,
		patchPresentationDuration: false,
		omitMfra: true,
	});
	const fixture = patchFirstFragmentDecodeTime(
		patchMediaTimescale(scaffold.withEditList, mediaTimescale),
		eligibleTick,
	);
	const endpointRemainder = segmentDuration * BigInt(mediaTimescale)
		- eligibleTick * BigInt(movieTimescale);

	expect(endpointRemainder * 2n).toBe(BigInt(movieTimescale));
	expect(parseFixtureEditList(fixture)).toEqual({
		version: 1,
		flags: 0,
		entryCount: 1,
		entries: [{
			segmentDuration,
			mediaTime: 0n,
			mediaRateInteger: 1,
			mediaRateFraction: 0,
		}],
	});
	expect(probeFixture(fixture).mediaHeader.timescale).toBe(mediaTimescale);
	expect(probeFixture(fixture).sampleTimings).toEqual([{
		presentationTimestamp: Number(eligibleTick),
		duration: 1000,
	}]);

	await withInput(fixture, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getPacket(Infinity);
		assert(packet);
		expect(packet.timestamp * mediaTimescale).toBe(Number(eligibleTick));
		expect(packet.duration).toBe(1 / movieTimescale);
	});
});

test('ISOBMFF multi-edit list does not clamp valid later entries to the first edit', async () => {
	const fixture = await createEditListFixture({
		fragmented: false,
		movieTimescale: 1000,
		entries: [
			{ segmentDuration: 1000, mediaTime: 0 },
			{ segmentDuration: 1000, mediaTime: 1000 },
		],
	});

	expect(parseFixtureEditList(fixture.withEditList).entries).toEqual([
		{ segmentDuration: 1000, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 },
		{ segmentDuration: 1000, mediaTime: 1000, mediaRateInteger: 1, mediaRateFraction: 0 },
	]);
	await withInput(fixture.withEditList, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const packet = await new EncodedPacketSink(track).getPacket(1);
		assert(packet);
		expect(packet.timestamp).toBe(1);
		expect(packet.duration).toBe(1);
		expect(await track.getTimeResolution()).toBe(1000);
	});
});

test('ISOBMFF edit boundary uses exact integer arithmetic at integral and adjacent ticks', async () => {
	const integralFixture = await createEditListFixture({
		fragmented: false,
		entries: [{ segmentDuration: 115776, mediaTime: 0 }],
	});
	const integral = await inspectTrack(integralFixture.withEditList);
	const integralLastPacket = integral.lastPresentationPacket;
	assert(integralLastPacket);
	expect(integralLastPacket.timestamp).toBe(2);
	expect(integralLastPacket.duration * 1000).toBe(10);
	expect(integral.duration).toBe(2.01);

	const adjacentTickFixture = await createEditListFixture({
		fragmented: false,
		movieTimescale: 1000,
		entries: [{ segmentDuration: 2500, mediaTime: 0 }],
		packetTimings: [
			{ timestamp: 0, duration: 0.001 },
			{ timestamp: 2.499, duration: 0.001 },
			{ timestamp: 2.5, duration: 0.001 },
			{ timestamp: 2.501, duration: 0.001 },
		],
	});
	const adjacentTicks = await inspectTrack(adjacentTickFixture.withEditList);
	const adjacentLastPacket = adjacentTicks.lastPresentationPacket;
	assert(adjacentLastPacket);
	expect(adjacentTicks.packets.map(packet => packet.timestamp * 1000)).toEqual([0, 2499, 2500, 2501]);
	expect(adjacentLastPacket.timestamp * 1000).toBe(2499);
	expect(adjacentLastPacket.duration * 1000).toBe(1);
	expect(adjacentTicks.duration).toBe(2.5);
});

test('ISOBMFF edit boundary preserves a genuine sub-tick fraction', async () => {
	const movieTimescale = 30000001;
	const trackTimescale = 30000000;
	const scaffold = await createEditListFixture({
		fragmented: false,
		movieTimescale,
		trackTimescale: 1000,
		entries: [{ segmentDuration: 30000000, mediaTime: 0 }],
	});
	const fixture = {
		withoutEditList: patchAdversarialMediaTimescale(scaffold.withoutEditList, trackTimescale),
		withEditList: patchAdversarialMediaTimescale(scaffold.withEditList, trackTimescale),
	};
	const edited = await inspectTrack(fixture.withEditList);
	const lastPacket = edited.lastPresentationPacket;
	assert(lastPacket);

	expect(edited.timeResolution).toBe(900000030000000);
	expect(lastPacket.timestamp).toBe(29999999 / 30000000);
	expect(lastPacket.duration).toBe(1 / 900000030000000);
	expect(lastPacket.duration * edited.timeResolution).toBe(1);
	expect(edited.duration).toBe(30000000 / 30000001);
});

test('ISOBMFF time resolution refuses an unsafe exact least common multiple', async () => {
	const movieTimescale = 100000007;
	const trackTimescale = 100000037;
	const scaffold = await createEditListFixture({
		fragmented: false,
		movieTimescale,
		trackTimescale: 1000,
		entries: [{ segmentDuration: 1, mediaTime: 0 }],
	});
	const fixture = patchAdversarialMediaTimescale(
		scaffold.withEditList,
		trackTimescale,
		[0, 0, 0],
	);
	const rawProof = probeFixture(fixture);

	expect(parseFixtureEditList(fixture)).toEqual({
		version: 0,
		flags: 0,
		entryCount: 1,
		entries: [{
			segmentDuration: 1,
			mediaTime: 0,
			mediaRateInteger: 1,
			mediaRateFraction: 0,
		}],
	});
	expect(rawProof.movieHeader.timescale).toBe(movieTimescale);
	expect(rawProof.mediaHeader).toEqual({ timescale: trackTimescale, duration: 4 });
	expect(rawProof.sampleTimings).toEqual([
		{ presentationTimestamp: 0, duration: 1 },
		{ presentationTimestamp: 1, duration: 1 },
		{ presentationTimestamp: 2, duration: 1 },
		{ presentationTimestamp: 3, duration: 1 },
	]);

	await withInput(fixture, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		await expect(track.getTimeResolution()).rejects.toBeInstanceOf(RangeError);
		await expect(track.getTimeResolution()).rejects.toThrowError(
			'The exact track time resolution (10000004400000259) exceeds Number.MAX_SAFE_INTEGER and cannot be'
			+ ' returned without violating InputTrack.getTimeResolution().',
		);
	});
});

test('ISOBMFF leading empty edit contributes to time resolution', async () => {
	const fixture = await createEditListFixture({
		fragmented: false,
		movieTimescale: 3,
		trackTimescale: 2,
		entries: [
			{ segmentDuration: 1, mediaTime: -1 },
			{ segmentDuration: 3, mediaTime: 0 },
		],
	});

	expect(probeFixture(fixture.withEditList).mediaHeader.timescale).toBe(2);
	await withInput(fixture.withEditList, null, async (input) => {
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
		assert(firstPacket);
		expect(firstPacket.timestamp).toBe(1 / 3);
		expect(firstPacket.timestamp * 6).toBe(2);
		expect(await track.getTimeResolution()).toBe(6);
	});
});

test('ISOBMFF edit mapping supports a leading empty edit and nonzero media_time', async () => {
	const leadingEmptyFixture = await createEditListFixture({
		fragmented: false,
		movieTimescale: 1000,
		entries: [
			{ segmentDuration: 500, mediaTime: -1 },
			{ segmentDuration: 2000, mediaTime: 0 },
		],
	});
	const leadingEmpty = await inspectTrack(leadingEmptyFixture.withEditList);
	expect(leadingEmpty.packets.map(packet => packet.timestamp)).toEqual([0.5, 3.5, 1.5, 2.5]);
	expect(leadingEmpty.lastPresentationPacket?.timestamp).toBe(1.5);
	expect(leadingEmpty.lastPresentationPacket?.duration).toBe(1);
	expect(leadingEmpty.duration).toBe(2.5);

	const nonzeroMediaTimeFixture = await createEditListFixture({
		fragmented: false,
		movieTimescale: 1000,
		entries: [{ segmentDuration: 2000, mediaTime: 500 }],
	});
	const nonzeroMediaTime = await inspectTrack(nonzeroMediaTimeFixture.withEditList);
	expect(nonzeroMediaTime.packets.map(packet => packet.timestamp)).toEqual([-0.5, 2.5, 0.5, 1.5]);
	expect(nonzeroMediaTime.lastPresentationPacket?.timestamp).toBe(1.5);
	expect(nonzeroMediaTime.lastPresentationPacket?.duration).toBe(0.5);
	expect(nonzeroMediaTime.duration).toBe(2);
});

for (const fragmented of [false, true]) {
	test(`ISOBMFF zero-duration edit preserves its offset without ending the track (${fragmented})`, async () => {
		const fixture = await createEditListFixture({
			fragmented,
			entries: [{ segmentDuration: 0, mediaTime: 500 }],
			patchPresentationDuration: false,
		});
		const edited = await inspectTrack(fixture.withEditList);
		expect(edited.packets.map(packet => packet.timestamp)).toEqual([-0.5, 2.5, 0.5, 1.5]);
		expect(edited.lastPresentationPacket?.timestamp).toBe(2.5);
		expect(edited.lastPresentationPacket?.duration).toBe(1);
		expect(edited.duration).toBe(3.5);
	});
}
