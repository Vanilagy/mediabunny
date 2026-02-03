/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from './demuxer';
import { Input } from './input';
import { IsobmffDemuxer } from './isobmff/isobmff-demuxer';
import {
	EBMLId,
	MAX_HEADER_SIZE,
	MIN_HEADER_SIZE,
	readAsciiString,
	readElementHeader,
	readElementSize,
	readUnsignedInt,
	readVarIntSize,
} from './matroska/ebml';
import { MatroskaDemuxer } from './matroska/matroska-demuxer';
import { Mp3Demuxer } from './mp3/mp3-demuxer';
import { FRAME_HEADER_SIZE, getXingOffset, INFO, XING } from '../shared/mp3-misc';
import { ID3_V2_HEADER_SIZE, readId3V2Header } from './id3';
import { readNextMp3FrameHeader } from './mp3/mp3-reader';
import { OggDemuxer } from './ogg/ogg-demuxer';
import { WaveDemuxer } from './wave/wave-demuxer';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from './adts/adts-reader';
import { AdtsDemuxer } from './adts/adts-demuxer';
import { readAscii, readBytes, readU32Be } from './reader';
import { FlacDemuxer } from './flac/flac-demuxer';
import { MpegTsDemuxer } from './mpeg-ts/mpeg-ts-demuxer';
import { TS_PACKET_SIZE } from './mpeg-ts/mpeg-ts-misc';

/**
 * Base class representing an input media file format.
 * @group Input formats
 * @public
 */
export abstract class InputFormat {
	/** @internal */
	abstract _canReadInput(input: Input): Promise<boolean>;

	/** @internal */
	abstract _createDemuxer(input: Input): Demuxer;

	/** Returns the name of the input format. */
	abstract get name(): string;
	/** Returns the typical base MIME type of the input format. */
	abstract get mimeType(): string;
}

/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @group Input formats
 * @public
 */
export abstract class IsobmffInputFormat extends InputFormat {
	/** @internal */
	protected async _getMajorBrand(input: Input) {
		let slice = input._reader.requestSlice(0, 12);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return null;

		slice.skip(4);
		const fourCc = readAscii(slice, 4);

		if (fourCc !== 'ftyp') {
			return null;
		}

		return readAscii(slice, 4);
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new IsobmffDemuxer(input);
	}
}

/**
 * MPEG-4 Part 14 (MP4) file format.
 *
 * Do not instantiate this class; use the {@link MP4} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class Mp4InputFormat extends IsobmffInputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const majorBrand = await this._getMajorBrand(input);
		return !!majorBrand && majorBrand !== 'qt  ';
	}

	get name() {
		return 'MP4';
	}

	get mimeType() {
		return 'video/mp4';
	}
}

/**
 * QuickTime File Format (QTFF), often called MOV.
 *
 * Do not instantiate this class; use the {@link QTFF} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class QuickTimeInputFormat extends IsobmffInputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const majorBrand = await this._getMajorBrand(input);
		return majorBrand === 'qt  ';
	}

	get name() {
		return 'QuickTime File Format';
	}

	get mimeType() {
		return 'video/quicktime';
	}
}

/**
 * Matroska file format.
 *
 * Do not instantiate this class; use the {@link MATROSKA} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class MatroskaInputFormat extends InputFormat {
	/** @internal */
	protected async isSupportedEBMLOfDocType(input: Input, desiredDocType: string) {
		let headerSlice = input._reader.requestSlice(0, MAX_HEADER_SIZE);
		if (headerSlice instanceof Promise) headerSlice = await headerSlice;
		if (!headerSlice) return false;

		const varIntSize = readVarIntSize(headerSlice);
		if (varIntSize === null) {
			return false;
		}

		if (varIntSize < 1 || varIntSize > 8) {
			return false;
		}

		const id = readUnsignedInt(headerSlice, varIntSize);
		if (id !== EBMLId.EBML) {
			return false;
		}

		const dataSize = readElementSize(headerSlice);
		if (typeof dataSize !== 'number') {
			return false; // Miss me with that shit
		}

		let dataSlice = input._reader.requestSlice(headerSlice.filePos, dataSize);
		if (dataSlice instanceof Promise) dataSlice = await dataSlice;
		if (!dataSlice) return false;

		const startPos = headerSlice.filePos;

		while (dataSlice.filePos <= startPos + dataSize - MIN_HEADER_SIZE) {
			const header = readElementHeader(dataSlice);
			if (!header) break;

			const { id, size } = header;
			const dataStartPos = dataSlice.filePos;
			if (size === undefined) return false;

			switch (id) {
				case EBMLId.EBMLVersion: {
					const ebmlVersion = readUnsignedInt(dataSlice, size);
					if (ebmlVersion !== 1) {
						return false;
					}
				}; break;
				case EBMLId.EBMLReadVersion: {
					const ebmlReadVersion = readUnsignedInt(dataSlice, size);
					if (ebmlReadVersion !== 1) {
						return false;
					}
				}; break;
				case EBMLId.DocType: {
					const docType = readAsciiString(dataSlice, size);
					if (docType !== desiredDocType) {
						return false;
					}
				}; break;
				case EBMLId.DocTypeVersion: {
					const docTypeVersion = readUnsignedInt(dataSlice, size);
					if (docTypeVersion > 4) { // Support up to Matroska v4
						return false;
					}
				}; break;
			}

			dataSlice.filePos = dataStartPos + size;
		}

		return true;
	}

	/** @internal */
	_canReadInput(input: Input) {
		return this.isSupportedEBMLOfDocType(input, 'matroska');
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new MatroskaDemuxer(input);
	}

	get name() {
		return 'Matroska';
	}

	get mimeType() {
		return 'video/x-matroska';
	}
}

/**
 * WebM file format, based on Matroska.
 *
 * Do not instantiate this class; use the {@link WEBM} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class WebMInputFormat extends MatroskaInputFormat {
	/** @internal */
	override _canReadInput(input: Input) {
		return this.isSupportedEBMLOfDocType(input, 'webm');
	}

	override get name() {
		return 'WebM';
	}

	override get mimeType() {
		return 'video/webm';
	}
}

/**
 * MP3 file format.
 *
 * Do not instantiate this class; use the {@link MP3} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class Mp3InputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let currentPos = 0;

		while (true) {
			let slice = input._reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice) break;

			const id3V2Header = readId3V2Header(slice);
			if (!id3V2Header) {
				break;
			}

			currentPos = slice.filePos + id3V2Header.size;
		}

		const firstResult = await readNextMp3FrameHeader(input._reader, currentPos, currentPos + 4096);
		if (!firstResult) {
			return false;
		}

		const firstHeader = firstResult.header;
		const xingOffset = getXingOffset(firstHeader.mpegVersionId, firstHeader.channel);

		let slice = input._reader.requestSlice(firstResult.startPos + xingOffset, 4);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		const word = readU32Be(slice);
		const isXing = word === XING || word === INFO;

		if (isXing) {
			// Gotta be MP3
			return true;
		}

		currentPos = firstResult.startPos + firstResult.header.totalSize;

		// Fine, we found one frame header, but we're still not entirely sure this is MP3. Let's check if we can find
		// another header right after it:
		const secondResult = await readNextMp3FrameHeader(input._reader, currentPos, currentPos + FRAME_HEADER_SIZE);
		if (!secondResult) {
			return false;
		}

		const secondHeader = secondResult.header;

		// In a well-formed MP3 file, we'd expect these two frames to share some similarities:
		if (firstHeader.channel !== secondHeader.channel || firstHeader.sampleRate !== secondHeader.sampleRate) {
			return false;
		}

		// We have found two matching consecutive MP3 frames, a strong indicator that this is an MP3 file
		return true;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new Mp3Demuxer(input);
	}

	get name() {
		return 'MP3';
	}

	get mimeType() {
		return 'audio/mpeg';
	}
}

/**
 * WAVE file format, based on RIFF.
 *
 * Do not instantiate this class; use the {@link WAVE} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class WaveInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let slice = input._reader.requestSlice(0, 12);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		const riffType = readAscii(slice, 4);
		if (riffType !== 'RIFF' && riffType !== 'RIFX' && riffType !== 'RF64') {
			return false;
		}

		slice.skip(4);

		const format = readAscii(slice, 4);
		return format === 'WAVE';
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new WaveDemuxer(input);
	}

	get name() {
		return 'WAVE';
	}

	get mimeType() {
		return 'audio/wav';
	}
}

/**
 * Ogg file format.
 *
 * Do not instantiate this class; use the {@link OGG} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class OggInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let slice = input._reader.requestSlice(0, 4);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		return readAscii(slice, 4) === 'OggS';
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new OggDemuxer(input);
	}

	get name() {
		return 'Ogg';
	}

	get mimeType() {
		return 'application/ogg';
	}
}
/**
 * FLAC file format.
 *
 * Do not instantiate this class; use the {@link FLAC} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class FlacInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let slice = input._reader.requestSlice(0, 4);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		return readAscii(slice, 4) === 'fLaC';
	}

	get name() {
		return 'FLAC';
	}

	get mimeType() {
		return 'audio/flac';
	}

	/** @internal */
	_createDemuxer(input: Input): Demuxer {
		return new FlacDemuxer(input);
	}
}

/**
 * ADTS file format.
 *
 * Do not instantiate this class; use the {@link ADTS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class AdtsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		let currentPos = 0;

		while (true) {
			let slice = input._reader.requestSlice(currentPos, ID3_V2_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice) break;

			const id3V2Header = readId3V2Header(slice);
			if (!id3V2Header) {
				break;
			}

			currentPos = slice.filePos + id3V2Header.size;
		}

		let slice = input._reader.requestSliceRange(
			currentPos,
			MIN_ADTS_FRAME_HEADER_SIZE,
			MAX_ADTS_FRAME_HEADER_SIZE,
		);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		const firstHeader = readAdtsFrameHeader(slice);
		if (!firstHeader) {
			return false;
		}

		currentPos += firstHeader.frameLength;

		slice = input._reader.requestSliceRange(
			currentPos,
			MIN_ADTS_FRAME_HEADER_SIZE,
			MAX_ADTS_FRAME_HEADER_SIZE,
		);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		const secondHeader = readAdtsFrameHeader(slice);
		if (!secondHeader) {
			return false;
		}

		return firstHeader.objectType === secondHeader.objectType
			&& firstHeader.samplingFrequencyIndex === secondHeader.samplingFrequencyIndex
			&& firstHeader.channelConfiguration === secondHeader.channelConfiguration;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new AdtsDemuxer(input);
	}

	get name() {
		return 'ADTS';
	}

	get mimeType() {
		return 'audio/aac';
	}
}

/**
 * MPEG Transport Stream (MPEG-TS) file format.
 *
 * Do not instantiate this class; use the {@link MPEG_TS} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class MpegTsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const lengthToCheck = TS_PACKET_SIZE + 16 + 1;
		let slice = input._reader.requestSlice(0, lengthToCheck);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		const bytes = readBytes(slice, lengthToCheck);

		if (bytes[0] === 0x47 && bytes[TS_PACKET_SIZE] === 0x47) {
			// Regular MPEG-TS
			return true;
		} else if (bytes[0] === 0x47 && bytes[TS_PACKET_SIZE + 16] === 0x47) {
			// MPEG-TS with Forward Error Correction
			return true;
		} else if (bytes[4] === 0x47 && bytes[4 + TS_PACKET_SIZE] === 0x47) {
			// MPEG-2-TS (DVHS)
			return true;
		}

		return false;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new MpegTsDemuxer(input);
	}

	get name() {
		return 'MPEG Transport Stream';
	}

	get mimeType() {
		return 'video/MP2T';
	}
}

/**
 * MP4 input format singleton.
 * @group Input formats
 * @public
 */
export const MP4 = /* #__PURE__ */ new Mp4InputFormat();
/**
 * QuickTime File Format input format singleton.
 * @group Input formats
 * @public
 */
export const QTFF = /* #__PURE__ */ new QuickTimeInputFormat();
/**
 * Matroska input format singleton.
 * @group Input formats
 * @public
 */
export const MATROSKA = /* #__PURE__ */ new MatroskaInputFormat();
/**
 * WebM input format singleton.
 * @group Input formats
 * @public
 */
export const WEBM = /* #__PURE__ */ new WebMInputFormat();
/**
 * MP3 input format singleton.
 * @group Input formats
 * @public
 */
export const MP3 = /* #__PURE__ */ new Mp3InputFormat();
/**
 * WAVE input format singleton.
 * @group Input formats
 * @public
 */
export const WAVE = /* #__PURE__ */ new WaveInputFormat();
/**
 * Ogg input format singleton.
 * @group Input formats
 * @public
 */
export const OGG = /* #__PURE__ */ new OggInputFormat();
/**
 * ADTS input format singleton.
 * @group Input formats
 * @public
 */
export const ADTS = /* #__PURE__ */ new AdtsInputFormat();

/**
 * FLAC input format singleton.
 * @group Input formats
 * @public
 */
export const FLAC = /* #__PURE__ */ new FlacInputFormat();

/**
 * MPEG-TS input format singleton.
 * @group Input formats
 * @public
 */
export const MPEG_TS = /* #__PURE__ */ new MpegTsInputFormat();

/**
 * List of all input format singletons. If you don't need to support all input formats, you should specify the
 * formats individually for better tree shaking.
 * @group Input formats
 * @public
 */
export const ALL_FORMATS: InputFormat[] = [MP4, QTFF, MATROSKA, WEBM, WAVE, OGG, FLAC, MP3, ADTS, MPEG_TS];
