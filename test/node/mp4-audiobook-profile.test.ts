import { expect, test } from 'vitest';
import { buildAacAudioSpecificConfig } from '../../src/codec.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { BufferTarget } from '../../src/target.js';

type ParsedBox = {
	type: string;
	start: number;
	end: number;
	contentStart: number;
	contentEnd: number;
	children: ParsedBox[];
};

const CONTAINER_BOX_TYPES = new Set([
	'moov',
	'trak',
	'mdia',
	'minf',
	'stbl',
	'tref',
	'udta',
	'meta',
	'ilst',
]);

const boxTypeFrom = (bytes: Uint8Array, offset: number) => {
	return String.fromCharCode(
		bytes[offset]!,
		bytes[offset + 1]!,
		bytes[offset + 2]!,
		bytes[offset + 3]!,
	);
};

const readU32 = (bytes: Uint8Array, offset: number) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getUint32(offset, false);
};

const readU64 = (bytes: Uint8Array, offset: number) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Number(view.getBigUint64(offset, false));
};

const parseBoxes = (bytes: Uint8Array, start: number, end: number): ParsedBox[] => {
	const boxes: ParsedBox[] = [];
	let offset = start;

	while (offset + 8 <= end) {
		let size = readU32(bytes, offset);
		const type = boxTypeFrom(bytes, offset + 4);
		let headerSize = 8;

		if (size === 1) {
			if (offset + 16 > end) break;
			size = readU64(bytes, offset + 8);
			headerSize = 16;
		} else if (size === 0) {
			size = end - offset;
		}

		if (size < headerSize || offset + size > end) break;

		const contentStart = offset + headerSize;
		const contentEnd = offset + size;
		const childStart = type === 'meta'
			? Math.min(contentEnd, contentStart + 4)
			: contentStart;
		const box: ParsedBox = {
			type,
			start: offset,
			end: contentEnd,
			contentStart,
			contentEnd,
			children: CONTAINER_BOX_TYPES.has(type)
				? parseBoxes(bytes, childStart, contentEnd)
				: [],
		};

		boxes.push(box);
		offset += size;
	}

	return boxes;
};

type FtypSnapshot = {
	majorBrand: string;
	minorVersion: number;
	compatibleBrands: string[];
};

const parseFtypSnapshot = (mp4: Uint8Array): FtypSnapshot => {
	const topLevel = parseBoxes(mp4, 0, mp4.byteLength);
	const ftyp = topLevel.find((box) => box.type === 'ftyp');
	expect(ftyp).toBeTruthy();

	const majorBrand = boxTypeFrom(mp4, ftyp!.contentStart);
	const minorVersion = readU32(mp4, ftyp!.contentStart + 4);
	const compatibleBrands: string[] = [];

	for (let offset = ftyp!.contentStart + 8; offset + 4 <= ftyp!.contentEnd; offset += 4) {
		compatibleBrands.push(boxTypeFrom(mp4, offset));
	}

	return { majorBrand, minorVersion, compatibleBrands };
};

type DataEntry = {
	typeIndicator: number;
	payload: Uint8Array;
};

const parseMetadataDataEntry = (mp4: Uint8Array, key: string): DataEntry | null => {
	const topLevel = parseBoxes(mp4, 0, mp4.byteLength);
	const moov = topLevel.find((box) => box.type === 'moov');
	if (!moov) return null;

	const udta = moov.children.find((box) => box.type === 'udta');
	if (!udta) return null;

	const meta = udta.children.find((box) => box.type === 'meta');
	if (!meta) return null;

	const ilst = meta.children.find((box) => box.type === 'ilst');
	if (!ilst) return null;

	const entry = ilst.children.find((box) => box.type === key);
	if (!entry) return null;

	const data = parseBoxes(mp4, entry.contentStart, entry.contentEnd)
		.find((box) => box.type === 'data');
	if (!data || data.contentStart + 8 > data.contentEnd) return null;

	const typeIndicator = readU32(mp4, data.contentStart);
	const payload = mp4.subarray(data.contentStart + 8, data.contentEnd);
	return { typeIndicator, payload };
};

const writeSinglePacketMp4 = async (format: Mp4OutputFormat) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	output.setMetadataTags({ title: 'Book' });

	const source = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(source);

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array([0x12, 0x10, 0x56]), 'key', 0, 1), {
		decoderConfig: {
			codec: 'mp4a.40.2',
			sampleRate: 24000,
			numberOfChannels: 1,
			description: buildAacAudioSpecificConfig({
				objectType: 2,
				sampleRate: 24000,
				numberOfChannels: 1,
			}),
		},
	});
	source.close();
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

test('MP4 default branding and metadata stay unchanged', async () => {
	const bytes = await writeSinglePacketMp4(new Mp4OutputFormat());
	const ftyp = parseFtypSnapshot(bytes);

	expect(ftyp.majorBrand).toBe('isom');
	expect(ftyp.minorVersion).toBe(0x200);
	expect(ftyp.compatibleBrands).toContain('isom');
	expect(ftyp.compatibleBrands).toContain('mp41');

	expect(parseMetadataDataEntry(bytes, 'stik')).toBeNull();
});

test('MP4 appleAudiobook mode writes M4B brand and stik=2 metadata', async () => {
	const bytes = await writeSinglePacketMp4(new Mp4OutputFormat({ appleAudiobook: true }));
	const ftyp = parseFtypSnapshot(bytes);

	expect(ftyp.majorBrand).toBe('M4B ');
	expect(ftyp.minorVersion).toBe(0);
	expect(ftyp.compatibleBrands).toContain('M4A ');
	expect(ftyp.compatibleBrands).toContain('isom');
	expect(ftyp.compatibleBrands).not.toContain('mp41');

	const stik = parseMetadataDataEntry(bytes, 'stik');
	expect(stik).toBeTruthy();
	expect(stik!.typeIndicator).toBe(21);
	expect(Array.from(stik!.payload)).toEqual([2]);
});
