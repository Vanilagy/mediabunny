/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { decodeSynchsafe, encodeSynchsafe } from '../shared/mp3-misc';
import { MetadataTags } from './metadata';
import {
	coalesceIndex,
	textDecoder,
	textEncoder,
	isIso88591Compatible,
	assertNever,
	keyValueIterator,
	toDataView,
} from './misc';
import { FileSlice, readAscii, readBytes, readU32Be, readU8 } from './reader';
import { Writer } from './writer';

export type Id3V2Header = {
	majorVersion: number;
	revision: number;
	flags: number;
	size: number;
};

export enum Id3V2HeaderFlags {
	Unsynchronisation = 1 << 7,
	ExtendedHeader = 1 << 6,
	ExperimentalIndicator = 1 << 5,
	Footer = 1 << 4,
}

export enum Id3V2TextEncoding {
	ISO_8859_1,
	UTF_16_WITH_BOM,
	UTF_16_BE_NO_BOM,
	UTF_8,
}

export const ID3_V1_TAG_SIZE = 128;
export const ID3_V2_HEADER_SIZE = 10;

export const ID3_V1_GENRES = [
	'Blues', 'Classic rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-hop', 'Jazz',
	'Metal', 'New age', 'Oldies', 'Other', 'Pop', 'Rhythm and blues', 'Rap', 'Reggae', 'Rock',
	'Techno', 'Industrial', 'Alternative', 'Ska', 'Death metal', 'Pranks', 'Soundtrack',
	'Euro-techno', 'Ambient', 'Trip-hop', 'Vocal', 'Jazz & funk', 'Fusion', 'Trance', 'Classical',
	'Instrumental', 'Acid', 'House', 'Game', 'Sound clip', 'Gospel', 'Noise', 'Alternative rock',
	'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental pop', 'Instrumental rock',
	'Ethnic', 'Gothic', 'Darkwave', 'Techno-industrial', 'Electronic', 'Pop-folk', 'Eurodance',
	'Dream', 'Southern rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian rap', 'Pop/funk',
	'Jungle music', 'Native US', 'Cabaret', 'New wave', 'Psychedelic', 'Rave', 'Showtunes',
	'Trailer', 'Lo-fi', 'Tribal', 'Acid punk', 'Acid jazz', 'Polka', 'Retro', 'Musical',
	'Rock \'n\' roll', 'Hard rock', 'Folk', 'Folk rock', 'National folk', 'Swing', 'Fast fusion',
	'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic rock',
	'Progressive rock', 'Psychedelic rock', 'Symphonic rock', 'Slow rock', 'Big band', 'Chorus',
	'Easy listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber music',
	'Sonata', 'Symphony', 'Booty bass', 'Primus', 'Porn groove', 'Satire', 'Slow jam', 'Club',
	'Tango', 'Samba', 'Folklore', 'Ballad', 'Power ballad', 'Rhythmic Soul', 'Freestyle', 'Duet',
	'Punk rock', 'Drum solo', 'A cappella', 'Euro-house', 'Dance hall', 'Goa music', 'Drum & bass',
	'Club-house', 'Hardcore techno', 'Terror', 'Indie', 'Britpop', 'Negerpunk', 'Polsk punk',
	'Beat', 'Christian gangsta rap', 'Heavy metal', 'Black metal', 'Crossover',
	'Contemporary Christian', 'Christian rock', 'Merengue', 'Salsa', 'Thrash metal', 'Anime',
	'Jpop', 'Synthpop', 'Christmas', 'Art rock', 'Baroque', 'Bhangra', 'Big beat', 'Breakbeat',
	'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro', 'Electroclash', 'Emo',
	'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band',
	'Krautrock', 'Leftfield', 'Lounge', 'Math rock', 'New romantic', 'Nu-breakz', 'Post-punk',
	'Post-rock', 'Psytrance', 'Shoegaze', 'Space rock', 'Trop rock', 'World music', 'Neoclassical',
	'Audiobook', 'Audio theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie rock', 'G-Funk',
	'Dubstep', 'Garage rock', 'Psybient',
];

export const parseId3V1Tag = (slice: FileSlice, tags: MetadataTags) => {
	const startPos = slice.filePos;
	tags.raw ??= {};
	tags.raw['TAG'] ??= readBytes(slice, ID3_V1_TAG_SIZE - 3); // Dump the whole tag into the raw metadata
	slice.filePos = startPos;

	const title = readId3V1String(slice, 30);
	if (title) tags.title ??= title;

	const artist = readId3V1String(slice, 30);
	if (artist) tags.artist ??= artist;

	const album = readId3V1String(slice, 30);
	if (album) tags.album ??= album;

	const yearText = readId3V1String(slice, 4);
	const year = Number.parseInt(yearText, 10);
	if (Number.isInteger(year) && year > 0) {
		tags.date ??= new Date(year, 0, 1);
	}

	const commentBytes = readBytes(slice, 30);
	let comment: string;

	// Check for the ID3v1.1 track number format:
	// The 29th byte (index 28) is a null terminator, and the 30th byte is the track number.
	if (commentBytes[28] === 0 && commentBytes[29] !== 0) {
		const trackNum = commentBytes[29]!;
		if (trackNum > 0) {
			tags.trackNumber ??= trackNum;
		}

		slice.skip(-30);
		comment = readId3V1String(slice, 28);
		slice.skip(2);
	} else {
		slice.skip(-30);
		comment = readId3V1String(slice, 30);
	}

	if (comment) tags.comment ??= comment;

	const genreIndex = readU8(slice);
	if (genreIndex < ID3_V1_GENRES.length) {
		tags.genre ??= ID3_V1_GENRES[genreIndex];
	}
};

export const readId3V1String = (slice: FileSlice, length: number) => {
	const bytes = readBytes(slice, length);

	const endIndex = coalesceIndex(bytes.indexOf(0), bytes.length);
	const relevantBytes = bytes.subarray(0, endIndex);

	// Decode as ISO-8859-1
	let str = '';
	for (let i = 0; i < relevantBytes.length; i++) {
		str += String.fromCharCode(relevantBytes[i]!);
	}

	return str.trimEnd(); // String also may be padded with spaces
};

export const readId3V2Header = (slice: FileSlice): Id3V2Header | null => {
	const startPos = slice.filePos;

	const tag = readAscii(slice, 3);
	const majorVersion = readU8(slice);
	const revision = readU8(slice);
	const flags = readU8(slice);
	const sizeRaw = readU32Be(slice);

	if (tag !== 'ID3' || majorVersion === 0xff || revision === 0xff || (sizeRaw & 0x80808080) !== 0) {
		slice.filePos = startPos;
		return null;
	}

	const size = decodeSynchsafe(sizeRaw);

	return { majorVersion, revision, flags, size };
};

export const parseId3V2Tag = (slice: FileSlice, header: Id3V2Header, tags: MetadataTags) => {
	// https://id3.org/id3v2.3.0

	if (![2, 3, 4].includes(header.majorVersion)) {
		console.warn(`Unsupported ID3v2 major version: ${header.majorVersion}`);
		return;
	}

	const bytes = readBytes(slice, header.size);
	const reader = new Id3V2Reader(header, bytes);

	if (header.flags & Id3V2HeaderFlags.Footer) {
		reader.removeFooter();
	}

	if ((header.flags & Id3V2HeaderFlags.Unsynchronisation) && header.majorVersion === 3) {
		reader.ununsynchronizeAll();
	}

	if (header.flags & Id3V2HeaderFlags.ExtendedHeader) {
		const extendedHeaderSize = reader.readU32();

		if (header.majorVersion === 3) {
			reader.pos += extendedHeaderSize; // The extended header size excludes itself
		} else {
			reader.pos += extendedHeaderSize - 4; // The extended header size includes itself
		}
	}

	while (reader.pos <= reader.bytes.length - reader.frameHeaderSize()) {
		const frame = reader.readId3V2Frame();
		if (!frame) {
			break;
		}

		const frameStartPos = reader.pos;
		const frameEndPos = reader.pos + frame.size;

		let	frameEncrypted = false;
		let frameCompressed = false;
		let frameUnsynchronized = false;

		if (header.majorVersion === 3) {
			frameEncrypted = !!(frame.flags & (1 << 6));
			frameCompressed = !!(frame.flags & (1 << 7));
		} else if (header.majorVersion === 4) {
			frameEncrypted = !!(frame.flags & (1 << 2));
			frameCompressed = !!(frame.flags & (1 << 3));
			frameUnsynchronized = !!(frame.flags & (1 << 1))
				|| !!(header.flags & Id3V2HeaderFlags.Unsynchronisation);
		}

		if (frameEncrypted) {
			console.warn(`Skipping encrypted ID3v2 frame ${frame.id}`);
			reader.pos = frameEndPos;
			continue;
		}

		if (frameCompressed) {
			console.warn(`Skipping compressed ID3v2 frame ${frame.id}`); // Maybe someday? Idk
			reader.pos = frameEndPos;
			continue;
		}

		if (frameUnsynchronized) {
			reader.ununsynchronizeRegion(reader.pos, frameEndPos);
		}

		tags.raw ??= {};
		if (frame.id[0] === 'T') {
			// It's a text frame, let's decode as text
			tags.raw[frame.id] ??= reader.readId3V2EncodingAndText(frameEndPos);
		} else {
			// For the others, let's just get the bytes
			tags.raw[frame.id] ??= reader.readBytes(frame.size);
		}

		reader.pos = frameStartPos;

		switch (frame.id) {
			case 'TIT2':
			case 'TT2': {
				tags.title ??= reader.readId3V2EncodingAndText(frameEndPos);
			}; break;

			case 'TIT3':
			case 'TT3': {
				tags.description ??= reader.readId3V2EncodingAndText(frameEndPos);
			}; break;

			case 'TPE1':
			case 'TP1': {
				tags.artist ??= reader.readId3V2EncodingAndText(frameEndPos);
			}; break;

			case 'TALB':
			case 'TAL': {
				tags.album ??= reader.readId3V2EncodingAndText(frameEndPos);
			}; break;

			case 'TPE2':
			case 'TP2': {
				tags.albumArtist ??= reader.readId3V2EncodingAndText(frameEndPos);
			}; break;

			case 'TRCK':
			case 'TRK': {
				const trackText = reader.readId3V2EncodingAndText(frameEndPos);
				const parts = trackText.split('/');
				const trackNum = Number.parseInt(parts[0]!, 10);
				const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

				if (Number.isInteger(trackNum) && trackNum > 0) {
					tags.trackNumber ??= trackNum;
				}
				if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
					tags.tracksTotal ??= tracksTotal;
				}
			}; break;

			case 'TPOS':
			case 'TPA': {
				const discText = reader.readId3V2EncodingAndText(frameEndPos);
				const parts = discText.split('/');
				const discNum = Number.parseInt(parts[0]!, 10);
				const discsTotal = parts[1] && Number.parseInt(parts[1], 10);

				if (Number.isInteger(discNum) && discNum > 0) {
					tags.discNumber ??= discNum;
				}
				if (discsTotal && Number.isInteger(discsTotal) && discsTotal > 0) {
					tags.discsTotal ??= discsTotal;
				}
			}; break;

			case 'TCON':
			case 'TCO': {
				const genreText = reader.readId3V2EncodingAndText(frameEndPos);
				let match = /^\((\d+)\)/.exec(genreText);
				if (match) {
					const genreNumber = Number.parseInt(match[1]!);
					if (ID3_V1_GENRES[genreNumber] !== undefined) {
						tags.genre ??= ID3_V1_GENRES[genreNumber];
						break;
					}
				}

				match = /^\d+$/.exec(genreText);
				if (match) {
					const genreNumber = Number.parseInt(match[0]);
					if (ID3_V1_GENRES[genreNumber] !== undefined) {
						tags.genre ??= ID3_V1_GENRES[genreNumber];
						break;
					}
				}

				tags.genre ??= genreText;
			}; break;

			case 'TDRC':
			case 'TDAT': {
				const dateText = reader.readId3V2EncodingAndText(frameEndPos);
				const date = new Date(dateText);

				if (!Number.isNaN(date.getTime())) {
					tags.date ??= date;
				}
			}; break;

			case 'TYER':
			case 'TYE': {
				const yearText = reader.readId3V2EncodingAndText(frameEndPos);
				const year = Number.parseInt(yearText, 10);

				if (Number.isInteger(year)) {
					tags.date ??= new Date(year, 0, 1);
				}
			}; break;

			case 'USLT':
			case 'ULT': {
				const encoding = reader.readU8();
				reader.pos += 3; // Skip language
				reader.readId3V2Text(encoding, frameEndPos); // Short content description
				tags.lyrics ??= reader.readId3V2Text(encoding, frameEndPos);
			}; break;

			case 'COMM':
			case 'COM': {
				const encoding = reader.readU8();
				reader.pos += 3; // Skip language
				reader.readId3V2Text(encoding, frameEndPos); // Short content description
				tags.comment ??= reader.readId3V2Text(encoding, frameEndPos);
			}; break;

			case 'APIC':
			case 'PIC': {
				const encoding = reader.readId3V2TextEncoding();

				let mimeType: string;
				if (header.majorVersion === 2) {
					const imageFormat = reader.readAscii(3);
					mimeType = imageFormat === 'PNG'
						? 'image/png'
						: imageFormat === 'JPG'
							? 'image/jpeg'
							: 'image/*';
				} else {
					mimeType = reader.readId3V2Text(encoding, frameEndPos);
				}

				const pictureType = reader.readU8();
				const description = reader.readId3V2Text(encoding, frameEndPos).trimEnd(); // Trim ending spaces

				const imageDataSize = frameEndPos - reader.pos;
				if (imageDataSize >= 0) {
					const imageData = reader.readBytes(imageDataSize);

					if (!tags.images) tags.images = [];
					tags.images.push({
						data: imageData,
						mimeType,
						kind: pictureType === 3
							? 'coverFront'
							: pictureType === 4
								? 'coverBack'
								: 'unknown',
						description,
					});
				}
			}; break;

			default: {
				reader.pos += frame.size;
			}; break;
		}

		reader.pos = frameEndPos;
	}
};

// https://id3.org/id3v2.3.0
export class Id3V2Reader {
	pos = 0;
	view: DataView;

	constructor(public header: Id3V2Header, public bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	frameHeaderSize() {
		return this.header.majorVersion === 2 ? 6 : 10;
	}

	ununsynchronizeAll() {
		const newBytes: number[] = [];

		for (let i = 0; i < this.bytes.length; i++) {
			const value1 = this.bytes[i]!;
			newBytes.push(value1);

			if (value1 === 0xff && i !== this.bytes.length - 1) {
				const value2 = this.bytes[i]!;
				if (value2 === 0x00) {
					i++;
				}
			}
		}

		this.bytes = new Uint8Array(newBytes);
		this.view = new DataView(this.bytes.buffer);
	}

	ununsynchronizeRegion(start: number, end: number) {
		const newBytes: number[] = [];

		for (let i = start; i < end; i++) {
			const value1 = this.bytes[i]!;
			newBytes.push(value1);

			if (value1 === 0xff && i !== end - 1) {
				const value2 = this.bytes[i + 1]!;
				if (value2 === 0x00) {
					i++;
				}
			}
		}

		const before = this.bytes.subarray(0, start);
		const after = this.bytes.subarray(end);

		this.bytes = new Uint8Array(before.length + newBytes.length + after.length);
		this.bytes.set(before, 0);
		this.bytes.set(newBytes, before.length);
		this.bytes.set(after, before.length + newBytes.length);

		this.view = new DataView(this.bytes.buffer);
	}

	removeFooter() {
		this.bytes = this.bytes.subarray(0, this.bytes.length - ID3_V2_HEADER_SIZE);
		this.view = new DataView(this.bytes.buffer);
	}

	readBytes(length: number) {
		const slice = this.bytes.subarray(this.pos, this.pos + length);
		this.pos += length;
		return slice;
	}

	readU8() {
		const value = this.view.getUint8(this.pos);
		this.pos += 1;
		return value;
	}

	readU16() {
		const value = this.view.getUint16(this.pos, false);
		this.pos += 2;
		return value;
	}

	readU24() {
		const high = this.view.getUint16(this.pos, false);
		const low = this.view.getUint8(this.pos + 1);
		this.pos += 3;
		return high * 0x100 + low;
	}

	readU32() {
		const value = this.view.getUint32(this.pos, false);
		this.pos += 4;
		return value;
	}

	readAscii(length: number) {
		let str = '';
		for (let i = 0; i < length; i++) {
			str += String.fromCharCode(this.view.getUint8(this.pos + i));
		}
		this.pos += length;
		return str;
	}

	readId3V2Frame() {
		if (this.header.majorVersion === 2) {
			const id = this.readAscii(3);
			if (id === '\x00\x00\x00') {
				return null;
			}

			const size = this.readU24();

			return { id, size, flags: 0 };
		} else {
			const id = this.readAscii(4);
			if (id === '\x00\x00\x00\x00') {
				// We've landed in the padding section
				return null;
			}

			const sizeRaw = this.readU32();
			let size = this.header.majorVersion === 4
				? decodeSynchsafe(sizeRaw)
				: sizeRaw;
			const flags = this.readU16();
			const headerEndPos = this.pos;

			// Some files may have incorrectly synchsafed/unsynchsafed sizes. To validate which interpretation is valid,
			// we validate a size by skipping ahead and seeing if we land at a valid frame header (or at the end of the
			// tag.

			const isSizeValid = (size: number) => {
				const nextPos = this.pos + size;
				if (nextPos > this.bytes.length) {
					return false;
				}

				if (nextPos <= this.bytes.length - this.frameHeaderSize()) {
					this.pos += size;
					const nextId = this.readAscii(4);
					if (nextId !== '\x00\x00\x00\x00' && !/[0-9A-Z]{4}/.test(nextId)) {
						return false;
					}
				}

				return true;
			};

			if (!isSizeValid(size)) {
				// Flip the synchsafing, and try if this one makes more sense
				const otherSize = this.header.majorVersion === 4
					? sizeRaw
					: decodeSynchsafe(sizeRaw);

				if (isSizeValid(otherSize)) {
					size = otherSize;
				}
			}

			this.pos = headerEndPos;
			return { id, size, flags };
		}
	}

	readId3V2TextEncoding(): Id3V2TextEncoding {
		const number = this.readU8();
		if (number > 3) {
			throw new Error(`Unsupported text encoding: ${number}`);
		}
		return number;
	}

	readId3V2Text(encoding: Id3V2TextEncoding, until: number): string {
		const startPos = this.pos;
		const data = this.readBytes(until - this.pos);

		switch (encoding) {
			case Id3V2TextEncoding.ISO_8859_1: {
				let str = '';

				for (let i = 0; i < data.length; i++) {
					const value = data[i]!;
					if (value === 0) {
						this.pos = startPos + i + 1;
						break;
					}
					str += String.fromCharCode(value);
				}

				return str;
			}

			case Id3V2TextEncoding.UTF_16_WITH_BOM: {
				if (data[0] === 0xff && data[1] === 0xfe) {
					const decoder = new TextDecoder('utf-16le');
					const endIndex = coalesceIndex(
						data.findIndex((x, i) => x === 0 && data[i + 1] === 0 && i % 2 === 0),
						data.length,
					);
					this.pos = startPos + Math.min(endIndex + 2, data.length);
					return decoder.decode(data.subarray(2, endIndex));
				} else if (data[0] === 0xfe && data[1] === 0xff) {
					const decoder = new TextDecoder('utf-16be');
					const endIndex = coalesceIndex(
						data.findIndex((x, i) => x === 0 && data[i + 1] === 0 && i % 2 === 0),
						data.length,
					);
					this.pos = startPos + Math.min(endIndex + 2, data.length);
					return decoder.decode(data.subarray(2, endIndex));
				} else {
					// Treat it like UTF-8, some files do this
					const endIndex = coalesceIndex(data.findIndex(x => x === 0), data.length);
					this.pos = startPos + Math.min(endIndex + 1, data.length);
					return textDecoder.decode(data.subarray(0, endIndex));
				}
			}

			case Id3V2TextEncoding.UTF_16_BE_NO_BOM: {
				const decoder = new TextDecoder('utf-16be');
				const endIndex = coalesceIndex(
					data.findIndex((x, i) => x === 0 && data[i + 1] === 0 && i % 2 === 0),
					data.length,
				);
				this.pos = startPos + Math.min(endIndex + 2, data.length);
				return decoder.decode(data.subarray(0, endIndex));
			}

			case Id3V2TextEncoding.UTF_8: {
				const endIndex = coalesceIndex(data.findIndex(x => x === 0), data.length);
				this.pos = startPos + Math.min(endIndex + 1, data.length);
				return textDecoder.decode(data.subarray(0, endIndex));
			}
		}
	}

	readId3V2EncodingAndText(until: number) {
		if (this.pos >= until) {
			return '';
		}

		const encoding = this.readId3V2TextEncoding();
		return this.readId3V2Text(encoding, until);
	}
}

export class Id3V2Writer {
	writer: Writer;
	helper = new Uint8Array(8);
	helperView = toDataView(this.helper);

	constructor(writer: Writer) {
		this.writer = writer;
	}

	writeId3V2Tag(metadata: MetadataTags): number {
		const tagStartPos = this.writer.getPos();

		// Write ID3v2.4 header
		this.writeAscii('ID3');
		this.writeU8(0x04); // Version 2.4
		this.writeU8(0x00); // Revision 0
		this.writeU8(0x00); // Flags
		this.writeSynchsafeU32(0); // Size placeholder

		const framesStartPos = this.writer.getPos();
		const writtenTags = new Set<string>();

		// Write all metadata frames
		for (const { key, value } of keyValueIterator(metadata)) {
			switch (key) {
				case 'title': {
					this.writeId3V2TextFrame('TIT2', value);
					writtenTags.add('TIT2');
				}; break;

				case 'description': {
					this.writeId3V2TextFrame('TIT3', value);
					writtenTags.add('TIT3');
				}; break;

				case 'artist': {
					this.writeId3V2TextFrame('TPE1', value);
					writtenTags.add('TPE1');
				}; break;

				case 'album': {
					this.writeId3V2TextFrame('TALB', value);
					writtenTags.add('TALB');
				}; break;

				case 'albumArtist': {
					this.writeId3V2TextFrame('TPE2', value);
					writtenTags.add('TPE2');
				}; break;

				case 'trackNumber': {
					const string = metadata.tracksTotal !== undefined
						? `${value}/${metadata.tracksTotal}`
						: value.toString();
					this.writeId3V2TextFrame('TRCK', string);
					writtenTags.add('TRCK');
				}; break;

				case 'discNumber': {
					const string = metadata.discsTotal !== undefined
						? `${value}/${metadata.discsTotal}`
						: value.toString();
					this.writeId3V2TextFrame('TPOS', string);
					writtenTags.add('TPOS');
				}; break;

				case 'genre': {
					this.writeId3V2TextFrame('TCON', value);
					writtenTags.add('TCON');
				}; break;

				case 'date': {
					this.writeId3V2TextFrame('TDRC', value.toISOString().slice(0, 10));
					writtenTags.add('TDRC');
				}; break;

				case 'lyrics': {
					this.writeId3V2LyricsFrame(value);
					writtenTags.add('USLT');
				}; break;

				case 'comment': {
					this.writeId3V2CommentFrame(value);
					writtenTags.add('COMM');
				}; break;

				case 'images': {
					const pictureTypeMap = { coverFront: 0x03, coverBack: 0x04, unknown: 0x00 };
					for (const image of value) {
						const pictureType = pictureTypeMap[image.kind] ?? 0x00;
						const description = image.description ?? '';
						this.writeId3V2ApicFrame(image.mimeType, pictureType, description, image.data);
					}
				}; break;

				case 'tracksTotal':
				case 'discsTotal': {
					// Handled with trackNumber and discNumber respectively
				}; break;

				case 'raw': {
					// Handled later
				}; break;

				default: {
					assertNever(key);
				}
			}
		}

		if (metadata.raw) {
			for (const key in metadata.raw) {
				const value = metadata.raw[key];
				if (value == null || key.length !== 4 || writtenTags.has(key)) {
					continue;
				}

				let bytes: Uint8Array;
				if (typeof value === 'string') {
					const encoded = textEncoder.encode(value);
					bytes = new Uint8Array(encoded.byteLength + 2);
					bytes[0] = Id3V2TextEncoding.UTF_8;
					bytes.set(encoded, 1);
					// Last byte is the null terminator
				} else if (value instanceof Uint8Array) {
					bytes = value;
				} else {
					continue;
				}

				this.writeAscii(key);
				this.writeSynchsafeU32(bytes.byteLength);
				this.writeU16(0x0000);
				this.writer.write(bytes);
			}
		}

		const framesEndPos = this.writer.getPos();
		const framesSize = framesEndPos - framesStartPos;

		// Update the size field in the header (synchsafe)
		this.writer.seek(tagStartPos + 6); // Skip 'ID3' + version + revision + flags
		this.writeSynchsafeU32(framesSize);
		this.writer.seek(framesEndPos);

		return framesSize + 10; // +10 for the header size
	}

	writeU8(value: number) {
		this.helper[0] = value;
		this.writer.write(this.helper.subarray(0, 1));
	}

	writeU16(value: number) {
		this.helperView.setUint16(0, value, false);
		this.writer.write(this.helper.subarray(0, 2));
	}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeAscii(text: string) {
		for (let i = 0; i < text.length; i++) {
			this.helper[i] = text.charCodeAt(i);
		}
		this.writer.write(this.helper.subarray(0, text.length));
	}

	writeSynchsafeU32(value: number) {
		this.writeU32(encodeSynchsafe(value));
	}

	writeIsoString(text: string) {
		const bytes = new Uint8Array(text.length + 1);
		for (let i = 0; i < text.length; i++) {
			bytes[i] = text.charCodeAt(i);
		}
		bytes[text.length] = 0x00;
		this.writer.write(bytes);
	}

	writeUtf8String(text: string) {
		const utf8Data = textEncoder.encode(text);
		this.writer.write(utf8Data);
		this.writeU8(0x00);
	}

	writeId3V2TextFrame(frameId: string, text: string) {
		const useIso88591 = isIso88591Compatible(text);
		const textDataLength = useIso88591 ? text.length : textEncoder.encode(text).byteLength;
		const frameSize = 1 + textDataLength + 1;

		this.writeAscii(frameId);
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);
		if (useIso88591) {
			this.writeIsoString(text);
		} else {
			this.writeUtf8String(text);
		}
	}

	writeId3V2LyricsFrame(lyrics: string) {
		const useIso88591 = isIso88591Compatible(lyrics);
		const shortDescription = '';
		const frameSize = 1 + 3 + shortDescription.length + 1 + lyrics.length + 1;

		this.writeAscii('USLT');
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);
		this.writeAscii('und');

		if (useIso88591) {
			this.writeIsoString(shortDescription);
			this.writeIsoString(lyrics);
		} else {
			this.writeUtf8String(shortDescription);
			this.writeUtf8String(lyrics);
		}
	}

	writeId3V2CommentFrame(comment: string) {
		const useIso88591 = isIso88591Compatible(comment);
		const textDataLength = useIso88591 ? comment.length : textEncoder.encode(comment).byteLength;
		const shortDescription = '';
		const frameSize = 1 + 3 + shortDescription.length + 1 + textDataLength + 1;

		this.writeAscii('COMM');
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);
		this.writeU8(0x75); // 'u'
		this.writeU8(0x6E); // 'n'
		this.writeU8(0x64); // 'd'

		if (useIso88591) {
			this.writeIsoString(shortDescription);
			this.writeIsoString(comment);
		} else {
			this.writeUtf8String(shortDescription);
			this.writeUtf8String(comment);
		}
	}

	writeId3V2ApicFrame(mimeType: string, pictureType: number, description: string, imageData: Uint8Array) {
		const useIso88591 = isIso88591Compatible(mimeType) && isIso88591Compatible(description);
		const descriptionDataLength = useIso88591
			? description.length
			: textEncoder.encode(description).byteLength;
		const frameSize = 1 + mimeType.length + 1 + 1 + descriptionDataLength + 1 + imageData.byteLength;

		this.writeAscii('APIC');
		this.writeSynchsafeU32(frameSize);
		this.writeU16(0x0000);

		this.writeU8(useIso88591 ? Id3V2TextEncoding.ISO_8859_1 : Id3V2TextEncoding.UTF_8);

		if (useIso88591) {
			this.writeIsoString(mimeType);
		} else {
			this.writeUtf8String(mimeType);
		}

		this.writeU8(pictureType);

		if (useIso88591) {
			this.writeIsoString(description);
		} else {
			this.writeUtf8String(description);
		}

		this.writer.write(imageData);
	}
}
