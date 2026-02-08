import { expect, test } from 'vitest';
import { buildAacAudioSpecificConfig } from '../../src/codec.js';
import { EncodedAudioPacketSource, TextSubtitleSource } from '../../src/media-source.js';
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
	'tref',
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
		const box: ParsedBox = {
			type,
			start: offset,
			end: contentEnd,
			contentStart,
			contentEnd,
			children: CONTAINER_BOX_TYPES.has(type)
				? parseBoxes(bytes, contentStart, contentEnd)
				: [],
		};

		boxes.push(box);
		offset += size;
	}

	return boxes;
};

type TrackSnapshot = {
	trackId: number;
	handlerType: string | null;
	chapterTrackIds: number[];
};

const parseTrackSnapshots = (mp4: Uint8Array): TrackSnapshot[] => {
	const topLevel = parseBoxes(mp4, 0, mp4.byteLength);
	const moov = topLevel.find((box) => box.type === 'moov');
	expect(moov).toBeTruthy();

	const tracks = moov!.children.filter((box) => box.type === 'trak');
	return tracks.map((trak): TrackSnapshot => {
		const tkhd = trak.children.find((box) => box.type === 'tkhd');
		expect(tkhd).toBeTruthy();

		const version = mp4[tkhd!.contentStart]!;
		const trackIdOffset = tkhd!.contentStart + (version === 1 ? 20 : 12);
		const trackId = readU32(mp4, trackIdOffset);

		const mdia = trak.children.find((box) => box.type === 'mdia');
		const hdlr = mdia?.children.find((box) => box.type === 'hdlr') ?? null;
		const handlerType = hdlr
			? boxTypeFrom(mp4, hdlr.contentStart + 8)
			: null;

		const tref = trak.children.find((box) => box.type === 'tref');
		const chap = tref?.children.find((box) => box.type === 'chap') ?? null;
		const chapterTrackIds: number[] = [];
		if (chap) {
			for (let offset = chap.contentStart; offset + 4 <= chap.contentEnd; offset += 4) {
				chapterTrackIds.push(readU32(mp4, offset));
			}
		}

		return { trackId, handlerType, chapterTrackIds };
	});
};

test('MP4 chapter track references are written as tref/chap', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	const subtitleSource = new TextSubtitleSource('webvtt');

	output.addAudioTrack(audioSource, { name: 'Main Audio' });
	output.addSubtitleTrack(subtitleSource, {
		name: 'Chapters',
		disposition: { default: false },
	});
	output.setChapterTrackReference(1, 2);

	await output.start();

	await audioSource.add(new EncodedPacket(new Uint8Array([0x12, 0x10, 0x56]), 'key', 0, 1), {
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
	await subtitleSource.add('WEBVTT\n\n00:00.000 --> 00:01.000\nPage 1\n');

	audioSource.close();
	subtitleSource.close();
	await output.finalize();

	const fileBytes = new Uint8Array(output.target.buffer!);
	const tracks = parseTrackSnapshots(fileBytes);

	const audioTrack = tracks.find((track) => track.handlerType === 'soun');
	const chapterTrack = tracks.find((track) => track.handlerType === 'text');
	expect(audioTrack).toBeTruthy();
	expect(chapterTrack).toBeTruthy();
	expect(audioTrack!.chapterTrackIds).toEqual([chapterTrack!.trackId]);
});

test('setChapterTrackReference validates that track IDs exist', () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	const subtitleSource = new TextSubtitleSource('webvtt');
	output.addAudioTrack(audioSource);
	output.addSubtitleTrack(subtitleSource);

	expect(() => output.setChapterTrackReference(1, 3)).toThrow(/track id/i);
});
