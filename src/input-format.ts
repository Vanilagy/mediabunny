/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from './demuxer';
import { Input } from './input';
import { IsobmffDemuxer } from './isobmff/isobmff-demuxer';
import { IsobmffReader } from './isobmff/isobmff-reader';
import { EBMLId, EBMLReader, MIN_HEADER_SIZE } from './matroska/ebml';
import { MatroskaDemuxer } from './matroska/matroska-demuxer';
import { Mp3Demuxer } from './mp3/mp3-demuxer';
import { FRAME_HEADER_SIZE } from '../shared/mp3-misc';
import { ID3_V2_HEADER_SIZE, Mp3Reader } from './mp3/mp3-reader';
import { OggDemuxer } from './ogg/ogg-demuxer';
import { OggReader } from './ogg/ogg-reader';
import { RiffReader } from './wave/riff-reader';
import { WaveDemuxer } from './wave/wave-demuxer';
import { AdtsReader, MAX_FRAME_HEADER_SIZE } from './adts/adts-reader';
import { AdtsDemuxer } from './adts/adts-demuxer';

/**
 * Base class representing an input media file format.
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
 * @public
 */
export abstract class IsobmffInputFormat extends InputFormat {
	/** @internal */
	protected async _getMajorBrand(input: Input) {
		const sourceSize = await input._mainReader.source.getSize();
		if (sourceSize < 12) {
			return null;
		}

		const isobmffReader = new IsobmffReader(input._mainReader);
		isobmffReader.pos = 4;
		const fourCc = isobmffReader.readAscii(4);

		if (fourCc !== 'ftyp') {
			return null;
		}

		return isobmffReader.readAscii(4);
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new IsobmffDemuxer(input);
	}
}

/**
 * MPEG-4 Part 14 (MP4) file format.
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

function foo() {
	return 5;
}

/**
 * Matroska file format.
 * @public
 */
export class MatroskaInputFormat extends InputFormat {
	/** @internal */
	protected async isSupportedEBMLOfDocType(input: Input, desiredDocType: string) {
		const sourceSize = await input._mainReader.source.getSize();
		if (sourceSize < 8) {
			return false;
		}

		const ebmlReader = new EBMLReader(input._mainReader);
		const varIntSize = ebmlReader.readVarIntSize();
		if (varIntSize === null) {
			return false;
		}

		foo();

		if (varIntSize < 1 || varIntSize > 8) {
			return false;
		}

		const id = ebmlReader.readUnsignedInt(varIntSize);
		if (id !== EBMLId.EBML) {
			return false;
		}

		const dataSize = ebmlReader.readElementSize();
		if (dataSize === null) {
			return false; // Miss me with that shit
		}

		const startPos = ebmlReader.pos;
		while (ebmlReader.pos <= startPos + dataSize - MIN_HEADER_SIZE) {
			const header = ebmlReader.readElementHeader();
			if (!header) break;

			const { id, size } = header;
			const dataStartPos = ebmlReader.pos;
			if (size === null) return false;

			switch (id) {
				case EBMLId.EBMLVersion: {
					const ebmlVersion = ebmlReader.readUnsignedInt(size);
					if (ebmlVersion !== 1) {
						return false;
					}
				}; break;
				case EBMLId.EBMLReadVersion: {
					const ebmlReadVersion = ebmlReader.readUnsignedInt(size);
					if (ebmlReadVersion !== 1) {
						return false;
					}
				}; break;
				case EBMLId.DocType: {
					const docType = ebmlReader.readAsciiString(size);
					if (docType !== desiredDocType) {
						return false;
					}
				}; break;
				case EBMLId.DocTypeVersion: {
					const docTypeVersion = ebmlReader.readUnsignedInt(size);
					if (docTypeVersion > 4) { // Support up to Matroska v4
						return false;
					}
				}; break;
			}

			ebmlReader.pos = dataStartPos + size;
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
 * @public
 */
export class Mp3InputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const sourceSize = await input._mainReader.source.getSize();
		if (sourceSize < 4) {
			return false;
		}

		const mp3Reader = new Mp3Reader(input._mainReader);
		mp3Reader.fileSize = sourceSize;

		let id3V2HeaderFound = false;

		while (true) {
			await mp3Reader.reader.loadRange(mp3Reader.pos, mp3Reader.pos + ID3_V2_HEADER_SIZE);

			const id3V2Header = mp3Reader.readId3V2Header();
			if (!id3V2Header) {
				break;
			}

			id3V2HeaderFound = true;
			mp3Reader.pos += id3V2Header.size;
		}

		const framesStartPos = mp3Reader.pos;
		await mp3Reader.reader.loadRange(mp3Reader.pos, mp3Reader.pos + 4096);

		const firstHeader = mp3Reader.readNextFrameHeader(Math.min(framesStartPos + 4096, sourceSize));
		if (!firstHeader) {
			return false;
		}

		if (id3V2HeaderFound) {
			// If there was an ID3v2 tag at the start, we can be pretty sure this is MP3 by now
			return true;
		}

		// Fine, we found one frame header, but we're still not entirely sure this is MP3. Let's check if we can find
		// another header right after it:
		mp3Reader.pos = firstHeader.startPos + firstHeader.totalSize;
		await mp3Reader.reader.loadRange(mp3Reader.pos, mp3Reader.pos + FRAME_HEADER_SIZE);
		const secondHeader = mp3Reader.readNextFrameHeader(mp3Reader.pos + FRAME_HEADER_SIZE);
		if (!secondHeader) {
			return false;
		}

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
 * @public
 */
export class WaveInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const sourceSize = await input._mainReader.source.getSize();
		if (sourceSize < 12) {
			return false;
		}

		const riffReader = new RiffReader(input._mainReader);
		const riffType = riffReader.readAscii(4);
		if (riffType !== 'RIFF' && riffType !== 'RIFX' && riffType !== 'RF64') {
			return false;
		}

		riffReader.pos = 8;
		const format = riffReader.readAscii(4);
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
 * @public
 */
export class OggInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const sourceSize = await input._mainReader.source.getSize();
		if (sourceSize < 4) {
			return false;
		}

		const oggReader = new OggReader(input._mainReader);
		return oggReader.readAscii(4) === 'OggS';
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
 * ADTS file format.
 * @public
 */
export class AdtsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input) {
		const sourceSize = await input._mainReader.source.getSize();
		if (sourceSize < MAX_FRAME_HEADER_SIZE) {
			return false;
		}

		const adtsReader = new AdtsReader(input._mainReader);
		const firstHeader = adtsReader.readFrameHeader();
		if (!firstHeader) {
			return false;
		}

		if (sourceSize < firstHeader.frameLength + MAX_FRAME_HEADER_SIZE) {
			return false;
		}

		adtsReader.pos = firstHeader.frameLength;
		await adtsReader.reader.loadRange(adtsReader.pos, adtsReader.pos + MAX_FRAME_HEADER_SIZE);
		const secondHeader = adtsReader.readFrameHeader();
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
 * MP4 input format singleton.
 * @public
 */
export const MP4 = new Mp4InputFormat();
/**
 * QuickTime File Format input format singleton.
 * @public
 */
export const QTFF = new QuickTimeInputFormat();
/**
 * Matroska input format singleton.
 * @public
 */
export const MATROSKA = new MatroskaInputFormat();
/**
 * WebM input format singleton.
 * @public
 */
export const WEBM = new WebMInputFormat();
/**
 * MP3 input format singleton.
 * @public
 */
export const MP3 = new Mp3InputFormat();
/**
 * WAVE input format singleton.
 * @public
 */
export const WAVE = new WaveInputFormat();
/**
 * Ogg input format singleton.
 * @public
 */
export const OGG = new OggInputFormat();
/**
 * ADTS input format singleton.
 * @public
 */
export const ADTS = new AdtsInputFormat();

/**
 * List of all input format singletons. If you don't need to support all input formats, you should specify the
 * formats individually for better tree shaking.
 * @public
 */
export const ALL_FORMATS: InputFormat[] = [MP4, QTFF, MATROSKA, WEBM, WAVE, OGG, MP3, ADTS];
