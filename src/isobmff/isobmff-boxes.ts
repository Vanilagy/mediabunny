/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	toUint8Array,
	assert,
	isU32,
	last,
	TransformationMatrix,
	textEncoder,
	COLOR_PRIMARIES_MAP,
	TRANSFER_CHARACTERISTICS_MAP,
	MATRIX_COEFFICIENTS_MAP,
	colorSpaceIsComplete,
	UNDETERMINED_LANGUAGE,
	assertNever,
	keyValueIterator,
	Bitstream,
} from '../misc';
import {
	AudioCodec,
	generateAv1CodecConfigurationFromCodecString,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	SubtitleCodec,
	VideoCodec,
} from '../codec';
import { formatSubtitleTimestamp } from '../subtitles';
import { Writer } from '../writer';
import {
	getTrackMetadata,
	GLOBAL_TIMESCALE,
	intoTimescale,
	IsobmffAudioTrackData,
	IsobmffMuxer,
	IsobmffSubtitleTrackData,
	IsobmffTrackData,
	IsobmffVideoTrackData,
	Sample,
} from './isobmff-muxer';
import { parseAc3SyncFrame, parseEac3SyncFrame, parseOpusIdentificationHeader } from '../codec-data';
import { MetadataTags, RichImageData } from '../metadata';

export class IsobmffBoxWriter {
	private helper = new Uint8Array(8);
	private helperView = new DataView(this.helper.buffer);

	/**
	 * Stores the position from the start of the file to where boxes elements have been written. This is used to
	 * rewrite/edit elements that were already added before, and to measure sizes of things.
	 */
	offsets = new WeakMap<Box, number>();

	constructor(private writer: Writer) {}

	writeU32(value: number) {
		this.helperView.setUint32(0, value, false);
		this.writer.write(this.helper.subarray(0, 4));
	}

	writeU64(value: number) {
		this.helperView.setUint32(0, Math.floor(value / 2 ** 32), false);
		this.helperView.setUint32(4, value, false);
		this.writer.write(this.helper.subarray(0, 8));
	}

	writeAscii(text: string) {
		for (let i = 0; i < text.length; i++) {
			this.helperView.setUint8(i % 8, text.charCodeAt(i));
			if (i % 8 === 7) this.writer.write(this.helper);
		}

		if (text.length % 8 !== 0) {
			this.writer.write(this.helper.subarray(0, text.length % 8));
		}
	}

	writeBox(box: Box) {
		this.offsets.set(box, this.writer.getPos());

		if (box.contents && !box.children) {
			this.writeBoxHeader(box, box.size ?? box.contents.byteLength + 8);
			this.writer.write(box.contents);
		} else {
			const startPos = this.writer.getPos();
			this.writeBoxHeader(box, 0);

			if (box.contents) this.writer.write(box.contents);
			if (box.children) for (const child of box.children) if (child) this.writeBox(child);

			const endPos = this.writer.getPos();
			const size = box.size ?? endPos - startPos;
			this.writer.seek(startPos);
			this.writeBoxHeader(box, size);
			this.writer.seek(endPos);
		}
	}

	writeBoxHeader(box: Box, size: number) {
		this.writeU32(box.largeSize ? 1 : size);
		this.writeAscii(box.type);
		if (box.largeSize) this.writeU64(size);
	}

	measureBoxHeader(box: Box) {
		return 8 + (box.largeSize ? 8 : 0);
	}

	patchBox(box: Box) {
		const boxOffset = this.offsets.get(box);
		assert(boxOffset !== undefined);

		const endPos = this.writer.getPos();
		this.writer.seek(boxOffset);
		this.writeBox(box);
		this.writer.seek(endPos);
	}

	measureBox(box: Box) {
		if (box.contents && !box.children) {
			const headerSize = this.measureBoxHeader(box);
			return headerSize + box.contents.byteLength;
		} else {
			let result = this.measureBoxHeader(box);
			if (box.contents) result += box.contents.byteLength;
			if (box.children) for (const child of box.children) if (child) result += this.measureBox(child);

			return result;
		}
	}
}

const bytes = /* #__PURE__ */ new Uint8Array(8);
const view = /* #__PURE__ */ new DataView(bytes.buffer);

const u8 = (value: number) => {
	return [(value % 0x100 + 0x100) % 0x100];
};

const u16 = (value: number) => {
	view.setUint16(0, value, false);
	return [bytes[0], bytes[1]] as number[];
};

const i16 = (value: number) => {
	view.setInt16(0, value, false);
	return [bytes[0], bytes[1]] as number[];
};

const u24 = (value: number) => {
	view.setUint32(0, value, false);
	return [bytes[1], bytes[2], bytes[3]] as number[];
};

const u32 = (value: number) => {
	view.setUint32(0, value, false);
	return [bytes[0], bytes[1], bytes[2], bytes[3]] as number[];
};

const i32 = (value: number) => {
	view.setInt32(0, value, false);
	return [bytes[0], bytes[1], bytes[2], bytes[3]] as number[];
};

const u64 = (value: number) => {
	view.setUint32(0, Math.floor(value / 2 ** 32), false);
	view.setUint32(4, value, false);
	return [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]] as number[];
};

const fixed_8_8 = (value: number) => {
	view.setInt16(0, 2 ** 8 * value, false);
	return [bytes[0], bytes[1]] as number[];
};

const fixed_16_16 = (value: number) => {
	view.setInt32(0, 2 ** 16 * value, false);
	return [bytes[0], bytes[1], bytes[2], bytes[3]] as number[];
};

const fixed_2_30 = (value: number) => {
	view.setInt32(0, 2 ** 30 * value, false);
	return [bytes[0], bytes[1], bytes[2], bytes[3]] as number[];
};

const variableUnsignedInt = (value: number, byteLength?: number) => {
	const bytes: number[] = [];
	let remaining = value;

	do {
		let byte = remaining & 0x7f;
		remaining >>= 7;

		// If this isn't the first byte we're adding (meaning there will be more bytes after it
		// when we reverse the array), set the continuation bit
		if (bytes.length > 0) {
			byte |= 0x80;
		}

		bytes.push(byte);

		if (byteLength !== undefined) {
			byteLength--;
		}
	} while (remaining > 0 || byteLength);

	// Reverse the array since we built it backwards
	return bytes.reverse();
};

const ascii = (text: string, nullTerminated = false) => {
	const bytes = Array(text.length).fill(null).map((_, i) => text.charCodeAt(i));
	if (nullTerminated) bytes.push(0x00);
	return bytes;
};

const lastPresentedSample = (samples: Sample[]) => {
	let result: Sample | null = null;

	for (const sample of samples) {
		if (!result || sample.timestamp > result.timestamp) {
			result = sample;
		}
	}

	return result;
};

const rotationMatrix = (rotationInDegrees: number): TransformationMatrix => {
	const theta = rotationInDegrees * (Math.PI / 180);
	const cosTheta = Math.round(Math.cos(theta));
	const sinTheta = Math.round(Math.sin(theta));

	// Matrices are post-multiplied in ISOBMFF, meaning this is the transpose of your typical rotation matrix
	return [
		cosTheta, sinTheta, 0,
		-sinTheta, cosTheta, 0,
		0, 0, 1,
	];
};
const IDENTITY_MATRIX = /* #__PURE__ */ rotationMatrix(0);

const matrixToBytes = (matrix: TransformationMatrix) => {
	return [
		fixed_16_16(matrix[0]), fixed_16_16(matrix[1]), fixed_2_30(matrix[2]),
		fixed_16_16(matrix[3]), fixed_16_16(matrix[4]), fixed_2_30(matrix[5]),
		fixed_16_16(matrix[6]), fixed_16_16(matrix[7]), fixed_2_30(matrix[8]),
	];
};

export interface Box {
	type: string;
	contents?: Uint8Array;
	children?: (Box | null)[];
	size?: number;
	largeSize?: boolean;
}

type NestedNumberArray = (number | NestedNumberArray)[];

export const box = (type: string, contents?: NestedNumberArray, children?: (Box | null)[]): Box => ({
	type,
	contents: contents && new Uint8Array(contents.flat(10) as number[]),
	children,
});

/** A FullBox always starts with a version byte, followed by three flag bytes. */
export const fullBox = (
	type: string,
	version: number,
	flags: number,
	contents?: NestedNumberArray,
	children?: Box[],
) => box(
	type,
	[u8(version), u24(flags), contents ?? []],
	children,
);

/**
 * File Type Compatibility Box: Allows the reader to determine whether this is a type of file that the
 * reader understands.
 */
export const ftyp = (details: {
	isQuickTime: boolean;
	holdsAvc: boolean;
	fragmented: boolean;
}) => {
	// You can find the full logic for this at
	// https://github.com/FFmpeg/FFmpeg/blob/de2fb43e785773738c660cdafb9309b1ef1bc80d/libavformat/movenc.c#L5518
	// Obviously, this lib only needs a small subset of that logic.

	const minorVersion = 0x200;

	if (details.isQuickTime) {
		return box('ftyp', [
			ascii('qt  '), // Major brand
			u32(minorVersion), // Minor version
			// Compatible brands
			ascii('qt  '),
		]);
	}

	if (details.fragmented) {
		return box('ftyp', [
			ascii('iso5'), // Major brand
			u32(minorVersion), // Minor version
			// Compatible brands
			ascii('iso5'),
			ascii('iso6'),
			ascii('mp41'),
		]);
	}

	return box('ftyp', [
		ascii('isom'), // Major brand
		u32(minorVersion), // Minor version
		// Compatible brands
		ascii('isom'),
		details.holdsAvc ? ascii('avc1') : [],
		ascii('mp41'),
	]);
};

/** Movie Sample Data Box. Contains the actual frames/samples of the media. */
export const mdat = (reserveLargeSize: boolean): Box => ({ type: 'mdat', largeSize: reserveLargeSize });

/** Free Space Box: A box that designates unused space in the movie data file. */
export const free = (size: number): Box => ({ type: 'free', size });

/**
 * Movie Box: Used to specify the information that defines a movie - that is, the information that allows
 * an application to interpret the sample data that is stored elsewhere.
 */
export const moov = (muxer: IsobmffMuxer) => box('moov', undefined, [
	mvhd(muxer.creationTime, muxer.trackDatas),
	...muxer.trackDatas.map(x => trak(x, muxer.creationTime)),
	muxer.isFragmented ? mvex(muxer.trackDatas) : null,
	udta(muxer),
]);

/** Movie Header Box: Used to specify the characteristics of the entire movie, such as timescale and duration. */
export const mvhd = (
	creationTime: number,
	trackDatas: IsobmffTrackData[],
) => {
	const duration = intoTimescale(Math.max(
		0,
		...trackDatas
			.filter(x => x.samples.length > 0)
			.map((x) => {
				const lastSample = lastPresentedSample(x.samples)!;
				return lastSample.timestamp + lastSample.duration;
			}),
	), GLOBAL_TIMESCALE);
	const nextTrackId = Math.max(0, ...trackDatas.map(x => x.track.id)) + 1;

	// Conditionally use u64 if u32 isn't enough
	const needsU64 = !isU32(creationTime) || !isU32(duration);
	const u32OrU64 = needsU64 ? u64 : u32;

	return fullBox('mvhd', +needsU64, 0, [
		u32OrU64(creationTime), // Creation time
		u32OrU64(creationTime), // Modification time
		u32(GLOBAL_TIMESCALE), // Timescale
		u32OrU64(duration), // Duration
		fixed_16_16(1), // Preferred rate
		fixed_8_8(1), // Preferred volume
		Array(10).fill(0), // Reserved
		matrixToBytes(IDENTITY_MATRIX), // Matrix
		Array(24).fill(0), // Pre-defined
		u32(nextTrackId), // Next track ID
	]);
};

/**
 * Track Box: Defines a single track of a movie. A movie may consist of one or more tracks. Each track is
 * independent of the other tracks in the movie and carries its own temporal and spatial information. Each Track Box
 * contains its associated Media Box.
 */
export const trak = (trackData: IsobmffTrackData, creationTime: number) => {
	const trackMetadata = getTrackMetadata(trackData);

	return box('trak', undefined, [
		tkhd(trackData, creationTime),
		mdia(trackData, creationTime),
		trackMetadata.name !== undefined
			? box('udta', undefined, [
					box('name', [ // VLC (and Mediabunny) also recognize ©nam
						...textEncoder.encode(trackMetadata.name),
					]),
				])
			: null,
	]);
};

/** Track Header Box: Specifies the characteristics of a single track within a movie. */
export const tkhd = (
	trackData: IsobmffTrackData,
	creationTime: number,
) => {
	const lastSample = lastPresentedSample(trackData.samples);
	const durationInGlobalTimescale = intoTimescale(
		lastSample ? lastSample.timestamp + lastSample.duration : 0,
		GLOBAL_TIMESCALE,
	);

	const needsU64 = !isU32(creationTime) || !isU32(durationInGlobalTimescale);
	const u32OrU64 = needsU64 ? u64 : u32;

	let matrix: TransformationMatrix;
	if (trackData.type === 'video') {
		const rotation = trackData.track.metadata.rotation;
		matrix = rotationMatrix(rotation ?? 0);
	} else {
		matrix = IDENTITY_MATRIX;
	}

	let flags = 0x2; // Track in movie
	if (trackData.track.metadata.disposition?.default !== false) {
		flags |= 0x1; // Track enabled
	}

	return fullBox('tkhd', +needsU64, flags, [
		u32OrU64(creationTime), // Creation time
		u32OrU64(creationTime), // Modification time
		u32(trackData.track.id), // Track ID
		u32(0), // Reserved
		u32OrU64(durationInGlobalTimescale), // Duration
		Array(8).fill(0), // Reserved
		u16(0), // Layer
		u16(trackData.track.id), // Alternate group
		fixed_8_8(trackData.type === 'audio' ? 1 : 0), // Volume
		u16(0), // Reserved
		matrixToBytes(matrix), // Matrix
		fixed_16_16(trackData.type === 'video' ? trackData.info.width : 0), // Track width
		fixed_16_16(trackData.type === 'video' ? trackData.info.height : 0), // Track height
	]);
};

/** Media Box: Describes and define a track's media type and sample data. */
export const mdia = (trackData: IsobmffTrackData, creationTime: number) => box('mdia', undefined, [
	mdhd(trackData, creationTime),
	hdlr(true, TRACK_TYPE_TO_COMPONENT_SUBTYPE[trackData.type], TRACK_TYPE_TO_HANDLER_NAME[trackData.type]),
	minf(trackData),
]);

/** Media Header Box: Specifies the characteristics of a media, including timescale and duration. */
export const mdhd = (
	trackData: IsobmffTrackData,
	creationTime: number,
) => {
	const lastSample = lastPresentedSample(trackData.samples);
	const localDuration = intoTimescale(
		lastSample ? lastSample.timestamp + lastSample.duration : 0,
		trackData.timescale,
	);

	const needsU64 = !isU32(creationTime) || !isU32(localDuration);
	const u32OrU64 = needsU64 ? u64 : u32;

	return fullBox('mdhd', +needsU64, 0, [
		u32OrU64(creationTime), // Creation time
		u32OrU64(creationTime), // Modification time
		u32(trackData.timescale), // Timescale
		u32OrU64(localDuration), // Duration
		u16(getLanguageCodeInt(trackData.track.metadata.languageCode ?? UNDETERMINED_LANGUAGE)), // Language
		u16(0), // Quality
	]);
};

const TRACK_TYPE_TO_COMPONENT_SUBTYPE: Record<IsobmffTrackData['type'], string> = {
	video: 'vide',
	audio: 'soun',
	subtitle: 'text',
};

const TRACK_TYPE_TO_HANDLER_NAME: Record<IsobmffTrackData['type'], string> = {
	video: 'MediabunnyVideoHandler',
	audio: 'MediabunnySoundHandler',
	subtitle: 'MediabunnyTextHandler',
};

/** Handler Reference Box. */
export const hdlr = (
	hasComponentType: boolean,
	handlerType: string,
	name: string,
	manufacturer = '\0\0\0\0',
) => fullBox('hdlr', 0, 0, [
	hasComponentType ? ascii('mhlr') : u32(0), // Component type
	ascii(handlerType), // Component subtype
	ascii(manufacturer), // Component manufacturer
	u32(0), // Component flags
	u32(0), // Component flags mask
	ascii(name, true), // Component name
]);

/**
 * Media Information Box: Stores handler-specific information for a track's media data. The media handler uses this
 * information to map from media time to media data and to process the media data.
 */
export const minf = (trackData: IsobmffTrackData) => box('minf', undefined, [
	TRACK_TYPE_TO_HEADER_BOX[trackData.type](),
	dinf(),
	stbl(trackData),
]);

/** Video Media Information Header Box: Defines specific color and graphics mode information. */
export const vmhd = () => fullBox('vmhd', 0, 1, [
	u16(0), // Graphics mode
	u16(0), // Opcolor R
	u16(0), // Opcolor G
	u16(0), // Opcolor B
]);

/** Sound Media Information Header Box: Stores the sound media's control information, such as balance. */
export const smhd = () => fullBox('smhd', 0, 0, [
	u16(0), // Balance
	u16(0), // Reserved
]);

/** Null Media Header Box. */
export const nmhd = () => fullBox('nmhd', 0, 0);

const TRACK_TYPE_TO_HEADER_BOX: Record<IsobmffTrackData['type'], () => Box> = {
	video: vmhd,
	audio: smhd,
	subtitle: nmhd,
};

/**
 * Data Information Box: Contains information specifying the data handler component that provides access to the
 * media data. The data handler component uses the Data Information Box to interpret the media's data.
 */
export const dinf = () => box('dinf', undefined, [
	dref(),
]);

/**
 * Data Reference Box: Contains tabular data that instructs the data handler component how to access the media's data.
 */
export const dref = () => fullBox('dref', 0, 0, [
	u32(1), // Entry count
], [
	url(),
]);

export const url = () => fullBox('url ', 0, 1); // Self-reference flag enabled

/**
 * Sample Table Box: Contains information for converting from media time to sample number to sample location. This box
 * also indicates how to interpret the sample (for example, whether to decompress the video data and, if so, how).
 */
export const stbl = (trackData: IsobmffTrackData) => {
	const needsCtts = trackData.compositionTimeOffsetTable.length > 1
		|| trackData.compositionTimeOffsetTable.some(x => x.sampleCompositionTimeOffset !== 0);

	return box('stbl', undefined, [
		stsd(trackData),
		stts(trackData),
		needsCtts ? ctts(trackData) : null,
		needsCtts ? cslg(trackData) : null,
		stsc(trackData),
		stsz(trackData),
		stco(trackData),
		stss(trackData),
	]);
};

/**
 * Sample Description Box: Stores information that allows you to decode samples in the media. The data stored in the
 * sample description varies, depending on the media type.
 */
export const stsd = (trackData: IsobmffTrackData) => {
	let sampleDescription: Box;

	if (trackData.type === 'video') {
		sampleDescription = videoSampleDescription(
			videoCodecToBoxName(trackData.track.source._codec, trackData.info.decoderConfig.codec),
			trackData,
		);
	} else if (trackData.type === 'audio') {
		const boxName = audioCodecToBoxName(trackData.track.source._codec, trackData.muxer.isQuickTime);
		assert(boxName);

		sampleDescription = soundSampleDescription(
			boxName,
			trackData,
		);
	} else if (trackData.type === 'subtitle') {
		sampleDescription = subtitleSampleDescription(
			SUBTITLE_CODEC_TO_BOX_NAME[trackData.track.source._codec],
			trackData,
		);
	}

	assert(sampleDescription!);

	return fullBox('stsd', 0, 0, [
		u32(1), // Entry count
	], [
		sampleDescription,
	]);
};

/** Video Sample Description Box: Contains information that defines how to interpret video media data. */
export const videoSampleDescription = (
	compressionType: string,
	trackData: IsobmffVideoTrackData,
) => box(compressionType, [
	Array(6).fill(0), // Reserved
	u16(1), // Data reference index
	u16(0), // Pre-defined
	u16(0), // Reserved
	Array(12).fill(0), // Pre-defined
	u16(trackData.info.width), // Width
	u16(trackData.info.height), // Height
	u32(0x00480000), // Horizontal resolution
	u32(0x00480000), // Vertical resolution
	u32(0), // Reserved
	u16(1), // Frame count
	Array(32).fill(0), // Compressor name
	u16(0x0018), // Depth
	i16(0xffff), // Pre-defined
], [
	VIDEO_CODEC_TO_CONFIGURATION_BOX[trackData.track.source._codec](trackData),
	colorSpaceIsComplete(trackData.info.decoderConfig.colorSpace) ? colr(trackData) : null,
]);

/** Colour Information Box: Specifies the color space of the video. */
export const colr = (trackData: IsobmffVideoTrackData) => box('colr', [
	ascii('nclx'), // Colour type
	u16(COLOR_PRIMARIES_MAP[trackData.info.decoderConfig.colorSpace!.primaries!]), // Colour primaries
	u16(TRANSFER_CHARACTERISTICS_MAP[trackData.info.decoderConfig.colorSpace!.transfer!]), // Transfer characteristics
	u16(MATRIX_COEFFICIENTS_MAP[trackData.info.decoderConfig.colorSpace!.matrix!]), // Matrix coefficients
	u8((trackData.info.decoderConfig.colorSpace!.fullRange ? 1 : 0) << 7), // Full range flag
]);

/** AVC Configuration Box: Provides additional information to the decoder. */
export const avcC = (trackData: IsobmffVideoTrackData) => trackData.info.decoderConfig && box('avcC', [
	// For AVC, description is an AVCDecoderConfigurationRecord, so nothing else to do here
	...toUint8Array(trackData.info.decoderConfig.description!),
]);

/** HEVC Configuration Box: Provides additional information to the decoder. */
export const hvcC = (trackData: IsobmffVideoTrackData) => trackData.info.decoderConfig && box('hvcC', [
	// For HEVC, description is an HEVCDecoderConfigurationRecord, so nothing else to do here
	...toUint8Array(trackData.info.decoderConfig.description!),
]);

/** VP Configuration Box: Provides additional information to the decoder. */
export const vpcC = (trackData: IsobmffVideoTrackData) => {
	// Reference: https://www.webmproject.org/vp9/mp4/

	if (!trackData.info.decoderConfig) {
		return null;
	}

	const decoderConfig = trackData.info.decoderConfig;

	const parts = decoderConfig.codec.split('.'); // We can derive the required values from the codec string
	const profile = Number(parts[1]);
	const level = Number(parts[2]);

	const bitDepth = Number(parts[3]);
	const chromaSubsampling = parts[4] ? Number(parts[4]) : 1; // 4:2:0 colocated with luma (0,0)
	const videoFullRangeFlag = parts[8] ? Number(parts[8]) : Number(decoderConfig.colorSpace?.fullRange ?? 0);
	const thirdByte = (bitDepth << 4) + (chromaSubsampling << 1) + videoFullRangeFlag;

	const colourPrimaries = parts[5]
		? Number(parts[5])
		: decoderConfig.colorSpace?.primaries
			? COLOR_PRIMARIES_MAP[decoderConfig.colorSpace.primaries]
			: 2; // Default to undetermined
	const transferCharacteristics = parts[6]
		? Number(parts[6])
		: decoderConfig.colorSpace?.transfer
			? TRANSFER_CHARACTERISTICS_MAP[decoderConfig.colorSpace.transfer]
			: 2;
	const matrixCoefficients = parts[7]
		? Number(parts[7])
		: decoderConfig.colorSpace?.matrix
			? MATRIX_COEFFICIENTS_MAP[decoderConfig.colorSpace.matrix]
			: 2;

	return fullBox('vpcC', 1, 0, [
		u8(profile), // Profile
		u8(level), // Level
		u8(thirdByte), // Bit depth, chroma subsampling, full range
		u8(colourPrimaries), // Colour primaries
		u8(transferCharacteristics), // Transfer characteristics
		u8(matrixCoefficients), // Matrix coefficients
		u16(0), // Codec initialization data size
	]);
};

/** AV1 Configuration Box: Provides additional information to the decoder. */
export const av1C = (trackData: IsobmffVideoTrackData) => {
	return box('av1C', generateAv1CodecConfigurationFromCodecString(trackData.info.decoderConfig.codec));
};

/** Sound Sample Description Box: Contains information that defines how to interpret sound media data. */
export const soundSampleDescription = (
	compressionType: string,
	trackData: IsobmffAudioTrackData,
) => {
	let version = 0;
	let contents: NestedNumberArray;

	let sampleSizeInBits = 16;
	if ((PCM_AUDIO_CODECS as readonly AudioCodec[]).includes(trackData.track.source._codec)) {
		const codec = trackData.track.source._codec as PcmAudioCodec;
		const { sampleSize } = parsePcmCodec(codec);
		sampleSizeInBits = 8 * sampleSize;

		if (sampleSizeInBits > 16) {
			version = 1;
		}
	}

	if (version === 0) {
		contents = [
			Array(6).fill(0), // Reserved
			u16(1), // Data reference index
			u16(version), // Version
			u16(0), // Revision level
			u32(0), // Vendor
			u16(trackData.info.numberOfChannels), // Number of channels
			u16(sampleSizeInBits), // Sample size (bits)
			u16(0), // Compression ID
			u16(0), // Packet size
			u16(trackData.info.sampleRate < 2 ** 16 ? trackData.info.sampleRate : 0), // Sample rate (upper)
			u16(0), // Sample rate (lower)
		];
	} else {
		contents = [
			Array(6).fill(0), // Reserved
			u16(1), // Data reference index
			u16(version), // Version
			u16(0), // Revision level
			u32(0), // Vendor
			u16(trackData.info.numberOfChannels), // Number of channels
			u16(Math.min(sampleSizeInBits, 16)), // Sample size (bits)
			u16(0), // Compression ID
			u16(0), // Packet size
			u16(trackData.info.sampleRate < 2 ** 16 ? trackData.info.sampleRate : 0), // Sample rate (upper)
			u16(0), // Sample rate (lower)
			u32(1), // Samples per packet (must be 1 for uncompressed formats)
			u32(sampleSizeInBits / 8), // Bytes per packet
			u32(trackData.info.numberOfChannels * sampleSizeInBits / 8), // Bytes per frame
			u32(2), // Bytes per sample (constant in FFmpeg)
		];
	}

	return box(compressionType, contents, [
		audioCodecToConfigurationBox(trackData.track.source._codec, trackData.muxer.isQuickTime)?.(trackData) ?? null,
	]);
};

/** MPEG-4 Elementary Stream Descriptor Box. */
export const esds = (trackData: IsobmffAudioTrackData) => {
	// We build up the bytes in a layered way which reflects the nested structure

	let objectTypeIndication: number;
	switch (trackData.track.source._codec) {
		case 'aac': {
			objectTypeIndication = 0x40;
		}; break;
		case 'mp3': {
			objectTypeIndication = 0x6b;
		}; break;
		case 'vorbis': {
			objectTypeIndication = 0xdd;
		}; break;
		default: throw new Error(`Unhandled audio codec: ${trackData.track.source._codec}`);
	}

	let bytes = [
		...u8(objectTypeIndication), // Object type indication
		...u8(0x15), // stream type(6bits)=5 audio, flags(2bits)=1
		...u24(0), // 24bit buffer size
		...u32(0), // max bitrate
		...u32(0), // avg bitrate
	];
	if (trackData.info.decoderConfig.description) {
		const description = toUint8Array(trackData.info.decoderConfig.description);

		// Add the decoder description to the end
		bytes = [
			...bytes,
			...u8(0x05), // TAG(5) = DecoderSpecificInfo
			...variableUnsignedInt(description.byteLength),
			...description,
		];
	}

	bytes = [
		...u16(1), // ES_ID = 1
		...u8(0x00), // flags etc = 0
		...u8(0x04), // TAG(4) = ES Descriptor
		...variableUnsignedInt(bytes.length),
		...bytes,
		...u8(0x06), // TAG(6)
		...u8(0x01), // length
		...u8(0x02), // data
	];
	bytes = [
		...u8(0x03), // TAG(3) = Object Descriptor
		...variableUnsignedInt(bytes.length),
		...bytes,
	];

	return fullBox('esds', 0, 0, bytes);
};

export const wave = (trackData: IsobmffAudioTrackData) => {
	return box('wave', undefined, [
		frma(trackData),
		enda(trackData),
		box('\x00\x00\x00\x00'), // NULL tag at the end
	]);
};

export const frma = (trackData: IsobmffAudioTrackData) => {
	return box('frma', [
		ascii(audioCodecToBoxName(trackData.track.source._codec, trackData.muxer.isQuickTime)),
	]);
};

// This box specifies PCM endianness
export const enda = (trackData: IsobmffAudioTrackData) => {
	const { littleEndian } = parsePcmCodec(trackData.track.source._codec as PcmAudioCodec);

	return box('enda', [
		u16(+littleEndian),
	]);
};

/** Opus Specific Box. */
export const dOps = (trackData: IsobmffAudioTrackData) => {
	let outputChannelCount = trackData.info.numberOfChannels;
	// Default PreSkip, should be at least 80 milliseconds worth of playback, measured in 48000 Hz samples
	let preSkip = 3840;
	let inputSampleRate = trackData.info.sampleRate;
	let outputGain = 0;
	let channelMappingFamily = 0;
	let channelMappingTable: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	// Read preskip and from codec private data from the encoder
	// https://www.rfc-editor.org/rfc/rfc7845#section-5
	const description = trackData.info.decoderConfig?.description;
	if (description) {
		assert(description.byteLength >= 18);

		const bytes = toUint8Array(description);
		const header = parseOpusIdentificationHeader(bytes);

		outputChannelCount = header.outputChannelCount;
		preSkip = header.preSkip;
		inputSampleRate = header.inputSampleRate;
		outputGain = header.outputGain;
		channelMappingFamily = header.channelMappingFamily;

		if (header.channelMappingTable) {
			channelMappingTable = header.channelMappingTable;
		}
	}

	// https://www.opus-codec.org/docs/opus_in_isobmff.html
	return box('dOps', [
		u8(0), // Version
		u8(outputChannelCount), // OutputChannelCount
		u16(preSkip), // PreSkip
		u32(inputSampleRate), // InputSampleRate
		i16(outputGain), // OutputGain
		u8(channelMappingFamily), // ChannelMappingFamily
		...channelMappingTable,
	]);
};

/** FLAC specific box. */
export const dfLa = (trackData: IsobmffAudioTrackData) => {
	const description = trackData.info.decoderConfig?.description;
	assert(description);

	const bytes = toUint8Array(description);

	return fullBox('dfLa', 0, 0, [
		...bytes.subarray(4),
	]);
};

/** PCM Configuration Box, ISO/IEC 23003-5. */
const pcmC = (trackData: IsobmffAudioTrackData) => {
	const { littleEndian, sampleSize } = parsePcmCodec(trackData.track.source._codec as PcmAudioCodec);
	const formatFlags = +littleEndian;

	return fullBox('pcmC', 0, 0, [
		u8(formatFlags),
		u8(8 * sampleSize),
	]);
};

/** AC3SpecificBox */
const dac3 = (trackData: IsobmffAudioTrackData) => {
	const frameInfo = parseAc3SyncFrame(trackData.info.firstPacket.data);
	if (!frameInfo) {
		throw new Error(
			'Couldn\'t extract AC-3 frame info from the audio packet. '
			+ 'Ensure the packets contain valid AC-3 sync frames (as specified in ETSI TS 102 366).',
		);
	}

	const bytes = new Uint8Array(3);
	const bitstream = new Bitstream(bytes);

	bitstream.writeBits(2, frameInfo.fscod);
	bitstream.writeBits(5, frameInfo.bsid);
	bitstream.writeBits(3, frameInfo.bsmod);
	bitstream.writeBits(3, frameInfo.acmod);
	bitstream.writeBits(1, frameInfo.lfeon);
	bitstream.writeBits(5, frameInfo.bitRateCode);
	bitstream.writeBits(5, 0); // reserved

	return box('dac3', [...bytes]);
};

/** EC3SpecificBox */
const dec3 = (trackData: IsobmffAudioTrackData) => {
	const frameInfo = parseEac3SyncFrame(trackData.info.firstPacket.data);
	if (!frameInfo) {
		throw new Error(
			'Couldn\'t extract E-AC-3 frame info from the audio packet. '
			+ 'Ensure the packets contain valid E-AC-3 sync frames (as specified in ETSI TS 102 366).',
		);
	}

	// Calculate size
	let totalBits = 16; // header: data_rate (13) + num_ind_sub (3)
	for (const sub of frameInfo.substreams) {
		totalBits += 23; // fixed fields per substream
		if (sub.numDepSub > 0) {
			totalBits += 9; // chan_loc
		} else {
			totalBits += 1; // reserved
		}
	}
	const size = Math.ceil(totalBits / 8);

	const bytes = new Uint8Array(size);
	const bitstream = new Bitstream(bytes);

	bitstream.writeBits(13, frameInfo.dataRate);
	bitstream.writeBits(3, frameInfo.substreams.length - 1); // num_ind_sub

	for (const sub of frameInfo.substreams) {
		bitstream.writeBits(2, sub.fscod);
		bitstream.writeBits(5, sub.bsid);
		bitstream.writeBits(1, 0); // reserved
		bitstream.writeBits(1, 0); // asvc = 0
		bitstream.writeBits(3, sub.bsmod);
		bitstream.writeBits(3, sub.acmod);
		bitstream.writeBits(1, sub.lfeon);
		bitstream.writeBits(3, 0); // reserved
		bitstream.writeBits(4, sub.numDepSub);

		if (sub.numDepSub > 0) {
			bitstream.writeBits(9, sub.chanLoc);
		} else {
			bitstream.writeBits(1, 0); // reserved
		}
	}

	return box('dec3', [...bytes]);
};

export const subtitleSampleDescription = (
	compressionType: string,
	trackData: IsobmffSubtitleTrackData,
) => box(compressionType, [
	Array(6).fill(0), // Reserved
	u16(1), // Data reference index
], [
	SUBTITLE_CODEC_TO_CONFIGURATION_BOX[trackData.track.source._codec](trackData),
]);

export const vttC = (trackData: IsobmffSubtitleTrackData) => box('vttC', [
	...textEncoder.encode(trackData.info.config.description),
]);

export const txtC = (textConfig: Uint8Array) => fullBox('txtC', 0, 0, [
	...textConfig, 0, // Text config (null-terminated)
]);

/**
 * Time-To-Sample Box: Stores duration information for a media's samples, providing a mapping from a time in a media
 * to the corresponding data sample. The table is compact, meaning that consecutive samples with the same time delta
 * will be grouped.
 */
export const stts = (trackData: IsobmffTrackData) => {
	return fullBox('stts', 0, 0, [
		u32(trackData.timeToSampleTable.length), // Number of entries
		trackData.timeToSampleTable.map(x => [ // Time-to-sample table
			u32(x.sampleCount), // Sample count
			u32(x.sampleDelta), // Sample duration
		]),
	]);
};

/** Sync Sample Box: Identifies the key frames in the media, marking the random access points within a stream. */
export const stss = (trackData: IsobmffTrackData) => {
	if (trackData.samples.every(x => x.type === 'key')) return null; // No stss box -> every frame is a key frame

	const keySamples = [...trackData.samples.entries()].filter(([, sample]) => sample.type === 'key');
	return fullBox('stss', 0, 0, [
		u32(keySamples.length), // Number of entries
		keySamples.map(([index]) => u32(index + 1)), // Sync sample table
	]);
};

/**
 * Sample-To-Chunk Box: As samples are added to a media, they are collected into chunks that allow optimized data
 * access. A chunk contains one or more samples. Chunks in a media may have different sizes, and the samples within a
 * chunk may have different sizes. The Sample-To-Chunk Box stores chunk information for the samples in a media, stored
 * in a compactly-coded fashion.
 */
export const stsc = (trackData: IsobmffTrackData) => {
	return fullBox('stsc', 0, 0, [
		u32(trackData.compactlyCodedChunkTable.length), // Number of entries
		trackData.compactlyCodedChunkTable.map(x => [ // Sample-to-chunk table
			u32(x.firstChunk), // First chunk
			u32(x.samplesPerChunk), // Samples per chunk
			u32(1), // Sample description index
		]),
	]);
};

/** Sample Size Box: Specifies the byte size of each sample in the media. */
export const stsz = (trackData: IsobmffTrackData) => {
	if (trackData.type === 'audio' && trackData.info.requiresPcmTransformation) {
		const { sampleSize } = parsePcmCodec(trackData.track.source._codec as PcmAudioCodec);

		// With PCM, every sample has the same size
		return fullBox('stsz', 0, 0, [
			u32(sampleSize * trackData.info.numberOfChannels), // Sample size
			u32(trackData.samples.reduce((acc, x) => acc + intoTimescale(x.duration, trackData.timescale), 0)),
		]);
	}

	return fullBox('stsz', 0, 0, [
		u32(0), // Sample size (0 means non-constant size)
		u32(trackData.samples.length), // Number of entries
		trackData.samples.map(x => u32(x.size)), // Sample size table
	]);
};

/** Chunk Offset Box: Identifies the location of each chunk of data in the media's data stream, relative to the file. */
export const stco = (trackData: IsobmffTrackData) => {
	if (trackData.finalizedChunks.length > 0 && last(trackData.finalizedChunks)!.offset! >= 2 ** 32) {
		// If the file is large, use the co64 box
		return fullBox('co64', 0, 0, [
			u32(trackData.finalizedChunks.length), // Number of entries
			trackData.finalizedChunks.map(x => u64(x.offset!)), // Chunk offset table
		]);
	}

	return fullBox('stco', 0, 0, [
		u32(trackData.finalizedChunks.length), // Number of entries
		trackData.finalizedChunks.map(x => u32(x.offset!)), // Chunk offset table
	]);
};

/**
 * Composition Time to Sample Box: Stores composition time offset information (PTS-DTS) for a
 * media's samples. The table is compact, meaning that consecutive samples with the same time
 * composition time offset will be grouped.
 */
export const ctts = (trackData: IsobmffTrackData) => {
	return fullBox('ctts', 1, 0, [
		u32(trackData.compositionTimeOffsetTable.length), // Number of entries
		trackData.compositionTimeOffsetTable.map(x => [ // Time-to-sample table
			u32(x.sampleCount), // Sample count
			i32(x.sampleCompositionTimeOffset), // Sample offset
		]),
	]);
};

/**
 * Composition to Decode Box: Stores information about the composition and display times of the media samples.
 */
export const cslg = (trackData: IsobmffTrackData) => {
	let leastDecodeToDisplayDelta = Infinity;
	let greatestDecodeToDisplayDelta = -Infinity;
	let compositionStartTime = Infinity;
	let compositionEndTime = -Infinity;

	assert(trackData.compositionTimeOffsetTable.length > 0);
	assert(trackData.samples.length > 0);

	for (let i = 0; i < trackData.compositionTimeOffsetTable.length; i++) {
		const entry = trackData.compositionTimeOffsetTable[i]!;
		leastDecodeToDisplayDelta = Math.min(leastDecodeToDisplayDelta, entry.sampleCompositionTimeOffset);
		greatestDecodeToDisplayDelta = Math.max(greatestDecodeToDisplayDelta, entry.sampleCompositionTimeOffset);
	}

	for (let i = 0; i < trackData.samples.length; i++) {
		const sample = trackData.samples[i]!;
		compositionStartTime = Math.min(
			compositionStartTime,
			intoTimescale(sample.timestamp, trackData.timescale),
		);
		compositionEndTime = Math.max(
			compositionEndTime,
			intoTimescale(sample.timestamp + sample.duration, trackData.timescale),
		);
	}

	const compositionToDtsShift = Math.max(-leastDecodeToDisplayDelta, 0);

	if (compositionEndTime >= 2 ** 31) {
		// For very large files, the composition end time can't be represented in i32, so let's just scrap the box in
		// that case. QuickTime fails to read the file if there's a cslg box with version 1, so that's sadly not an
		// option.
		return null;
	}

	return fullBox('cslg', 0, 0, [
		i32(compositionToDtsShift), // Composition to DTS shift
		i32(leastDecodeToDisplayDelta), // Least decode to display delta
		i32(greatestDecodeToDisplayDelta), // Greatest decode to display delta
		i32(compositionStartTime), // Composition start time
		i32(compositionEndTime), // Composition end time
	]);
};

/**
 * Movie Extends Box: This box signals to readers that the file is fragmented. Contains a single Track Extends Box
 * for each track in the movie.
 */
export const mvex = (trackDatas: IsobmffTrackData[]) => {
	return box('mvex', undefined, trackDatas.map(trex));
};

/** Track Extends Box: Contains the default values used by the movie fragments. */
export const trex = (trackData: IsobmffTrackData) => {
	return fullBox('trex', 0, 0, [
		u32(trackData.track.id), // Track ID
		u32(1), // Default sample description index
		u32(0), // Default sample duration
		u32(0), // Default sample size
		u32(0), // Default sample flags
	]);
};

/**
 * Movie Fragment Box: The movie fragments extend the presentation in time. They provide the information that would
 * previously have been	in the Movie Box.
 */
export const moof = (sequenceNumber: number, trackDatas: IsobmffTrackData[]) => {
	return box('moof', undefined, [
		mfhd(sequenceNumber),
		...trackDatas.map(traf),
	]);
};

/** Movie Fragment Header Box: Contains a sequence number as a safety check. */
export const mfhd = (sequenceNumber: number) => {
	return fullBox('mfhd', 0, 0, [
		u32(sequenceNumber), // Sequence number
	]);
};

const fragmentSampleFlags = (sample: Sample) => {
	let byte1 = 0;
	let byte2 = 0;
	const byte3 = 0;
	const byte4 = 0;

	const sampleIsDifferenceSample = sample.type === 'delta';
	byte2 |= +sampleIsDifferenceSample;

	if (sampleIsDifferenceSample) {
		byte1 |= 1; // There is redundant coding in this sample
	} else {
		byte1 |= 2; // There is no redundant coding in this sample
	}

	// Note that there are a lot of other flags to potentially set here, but most are irrelevant / non-necessary
	return byte1 << 24 | byte2 << 16 | byte3 << 8 | byte4;
};

/** Track Fragment Box */
export const traf = (trackData: IsobmffTrackData) => {
	return box('traf', undefined, [
		tfhd(trackData),
		tfdt(trackData),
		trun(trackData),
	]);
};

/** Track Fragment Header Box: Provides a reference to the extended track, and flags. */
export const tfhd = (trackData: IsobmffTrackData) => {
	assert(trackData.currentChunk);

	let tfFlags = 0;
	tfFlags |= 0x00008; // Default sample duration present
	tfFlags |= 0x00010; // Default sample size present
	tfFlags |= 0x00020; // Default sample flags present
	tfFlags |= 0x20000; // Default base is moof

	// Prefer the second sample over the first one, as the first one is a sync sample and therefore the "odd one out"
	const referenceSample = trackData.currentChunk.samples[1] ?? trackData.currentChunk.samples[0]!;
	const referenceSampleInfo = {
		duration: referenceSample.timescaleUnitsToNextSample,
		size: referenceSample.size,
		flags: fragmentSampleFlags(referenceSample),
	};

	return fullBox('tfhd', 0, tfFlags, [
		u32(trackData.track.id), // Track ID
		u32(referenceSampleInfo.duration), // Default sample duration
		u32(referenceSampleInfo.size), // Default sample size
		u32(referenceSampleInfo.flags), // Default sample flags
	]);
};

/**
 * Track Fragment Decode Time Box: Provides the absolute decode time of the first sample of the fragment. This is
 * useful for performing random access on the media file.
 */
export const tfdt = (trackData: IsobmffTrackData) => {
	assert(trackData.currentChunk);

	return fullBox('tfdt', 1, 0, [
		u64(intoTimescale(trackData.currentChunk.startTimestamp, trackData.timescale)), // Base Media Decode Time
	]);
};

/** Track Run Box: Specifies a run of contiguous samples for a given track. */
export const trun = (trackData: IsobmffTrackData) => {
	assert(trackData.currentChunk);

	const allSampleDurations = trackData.currentChunk.samples.map(x => x.timescaleUnitsToNextSample);
	const allSampleSizes = trackData.currentChunk.samples.map(x => x.size);
	const allSampleFlags = trackData.currentChunk.samples.map(fragmentSampleFlags);
	const allSampleCompositionTimeOffsets = trackData.currentChunk.samples
		.map(x => intoTimescale(x.timestamp - x.decodeTimestamp, trackData.timescale));

	const uniqueSampleDurations = new Set(allSampleDurations);
	const uniqueSampleSizes = new Set(allSampleSizes);
	const uniqueSampleFlags = new Set(allSampleFlags);
	const uniqueSampleCompositionTimeOffsets = new Set(allSampleCompositionTimeOffsets);

	const firstSampleFlagsPresent = uniqueSampleFlags.size === 2 && allSampleFlags[0] !== allSampleFlags[1];
	const sampleDurationPresent = uniqueSampleDurations.size > 1;
	const sampleSizePresent = uniqueSampleSizes.size > 1;
	const sampleFlagsPresent = !firstSampleFlagsPresent && uniqueSampleFlags.size > 1;
	const sampleCompositionTimeOffsetsPresent
		= uniqueSampleCompositionTimeOffsets.size > 1 || [...uniqueSampleCompositionTimeOffsets].some(x => x !== 0);

	let flags = 0;
	flags |= 0x0001; // Data offset present
	flags |= 0x0004 * +firstSampleFlagsPresent; // First sample flags present
	flags |= 0x0100 * +sampleDurationPresent; // Sample duration present
	flags |= 0x0200 * +sampleSizePresent; // Sample size present
	flags |= 0x0400 * +sampleFlagsPresent; // Sample flags present
	flags |= 0x0800 * +sampleCompositionTimeOffsetsPresent; // Sample composition time offsets present

	return fullBox('trun', 1, flags, [
		u32(trackData.currentChunk.samples.length), // Sample count
		u32(trackData.currentChunk.offset! - trackData.currentChunk.moofOffset! || 0), // Data offset
		firstSampleFlagsPresent ? u32(allSampleFlags[0]!) : [],
		trackData.currentChunk.samples.map((_, i) => [
			sampleDurationPresent ? u32(allSampleDurations[i]!) : [], // Sample duration
			sampleSizePresent ? u32(allSampleSizes[i]!) : [], // Sample size
			sampleFlagsPresent ? u32(allSampleFlags[i]!) : [], // Sample flags
			// Sample composition time offsets
			sampleCompositionTimeOffsetsPresent ? i32(allSampleCompositionTimeOffsets[i]!) : [],
		]),
	]);
};

/**
 * Movie Fragment Random Access Box: For each track, provides pointers to sync samples within the file
 * for random access.
 */
export const mfra = (trackDatas: IsobmffTrackData[]) => {
	return box('mfra', undefined, [
		...trackDatas.map(tfra),
		mfro(),
	]);
};

/** Track Fragment Random Access Box: Provides pointers to sync samples within the file for random access. */
export const tfra = (trackData: IsobmffTrackData, trackIndex: number) => {
	const version = 1; // Using this version allows us to use 64-bit time and offset values

	return fullBox('tfra', version, 0, [
		u32(trackData.track.id), // Track ID
		u32(0b111111), // This specifies that traf number, trun number and sample number are 32-bit ints
		u32(trackData.finalizedChunks.length), // Number of entries
		trackData.finalizedChunks.map(chunk => [
			u64(intoTimescale(chunk.samples[0]!.timestamp, trackData.timescale)), // Time (in presentation time)
			u64(chunk.moofOffset!), // moof offset
			u32(trackIndex + 1), // traf number
			u32(1), // trun number
			u32(1), // Sample number
		]),
	]);
};

/**
 * Movie Fragment Random Access Offset Box: Provides the size of the enclosing mfra box. This box can be used by readers
 * to quickly locate the mfra box by searching from the end of the file.
 */
export const mfro = () => {
	return fullBox('mfro', 0, 0, [
		// This value needs to be overwritten manually from the outside, where the actual size of the enclosing mfra box
		// is known
		u32(0), // Size
	]);
};

/** VTT Empty Cue Box */
export const vtte = () => box('vtte');

/** VTT Cue Box */
export const vttc = (
	payload: string,
	timestamp: number | null,
	identifier: string | null,
	settings: string | null,
	sourceId: number | null,
) => box('vttc', undefined, [
	sourceId !== null ? box('vsid', [i32(sourceId)]) : null,
	identifier !== null ? box('iden', [...textEncoder.encode(identifier)]) : null,
	timestamp !== null ? box('ctim', [...textEncoder.encode(formatSubtitleTimestamp(timestamp))]) : null,
	settings !== null ? box('sttg', [...textEncoder.encode(settings)]) : null,
	box('payl', [...textEncoder.encode(payload)]),
]);

/** VTT Additional Text Box */
export const vtta = (notes: string) => box('vtta', [...textEncoder.encode(notes)]);

/** User Data Box */
const udta = (muxer: IsobmffMuxer) => {
	const boxes: Box[] = [];

	const metadataFormat = muxer.format._options.metadataFormat ?? 'auto';
	const metadataTags = muxer.output._metadataTags;

	// Depending on the format, metadata tags are written differently
	if (metadataFormat === 'mdir' || (metadataFormat === 'auto' && !muxer.isQuickTime)) {
		const metaBox = metaMdir(metadataTags);
		if (metaBox) boxes.push(metaBox);
	} else if (metadataFormat === 'mdta') {
		const metaBox = metaMdta(metadataTags);
		if (metaBox) boxes.push(metaBox);
	} else if (metadataFormat === 'udta' || (metadataFormat === 'auto' && muxer.isQuickTime)) {
		addQuickTimeMetadataTagBoxes(boxes, muxer.output._metadataTags);
	}

	if (boxes.length === 0) {
		return null;
	}

	return box('udta', undefined, boxes);
};

const addQuickTimeMetadataTagBoxes = (boxes: Box[], tags: MetadataTags) => {
	// https://exiftool.org/TagNames/QuickTime.html (QuickTime UserData Tags)
	// For QuickTime files, metadata tags are dumped into the udta box

	for (const { key, value } of keyValueIterator(tags)) {
		switch (key) {
			case 'title': {
				boxes.push(metadataTagStringBoxShort('©nam', value));
			}; break;

			case 'description': {
				boxes.push(metadataTagStringBoxShort('©des', value));
			}; break;

			case 'artist': {
				boxes.push(metadataTagStringBoxShort('©ART', value));
			}; break;

			case 'album': {
				boxes.push(metadataTagStringBoxShort('©alb', value));
			}; break;

			case 'albumArtist': {
				boxes.push(metadataTagStringBoxShort('albr', value));
			}; break;

			case 'genre': {
				boxes.push(metadataTagStringBoxShort('©gen', value));
			}; break;

			case 'date': {
				boxes.push(metadataTagStringBoxShort('©day', value.toISOString().slice(0, 10)));
			}; break;

			case 'comment': {
				boxes.push(metadataTagStringBoxShort('©cmt', value));
			}; break;

			case 'lyrics': {
				boxes.push(metadataTagStringBoxShort('©lyr', value));
			}; break;

			case 'raw': {
				// Handled later
			}; break;

			case 'discNumber':
			case 'discsTotal':
			case 'trackNumber':
			case 'tracksTotal':
			case 'images': {
				// Not written for QuickTime (common Apple L)
			}; break;

			default: assertNever(key);
		}
	}

	if (tags.raw) {
		for (const key in tags.raw) {
			const value = tags.raw[key];
			if (value == null || key.length !== 4 || boxes.some(x => x.type === key)) {
				continue;
			}

			if (typeof value === 'string') {
				boxes.push(metadataTagStringBoxShort(key, value));
			} else if (value instanceof Uint8Array) {
				boxes.push(box(key, Array.from(value)));
			}
		}
	}
};

const metadataTagStringBoxShort = (name: string, value: string) => {
	const encoded = textEncoder.encode(value);

	return box(name, [
		u16(encoded.length),
		u16(getLanguageCodeInt('und')),
		Array.from(encoded),
	]);
};

const DATA_BOX_MIME_TYPE_MAP: Record<string, number> = {
	'image/jpeg': 13,
	'image/png': 14,
	'image/bmp': 27,
};

/**
 * Generates key-value metadata for inclusion in the "meta" box.
 */
const generateMetadataPairs = (tags: MetadataTags, isMdta: boolean) => {
	const pairs: {
		key: string;
		value: Box;
	}[] = [];

	// https://exiftool.org/TagNames/QuickTime.html (QuickTime ItemList Tags)
	// This is the metadata format used for MP4 files

	for (const { key, value } of keyValueIterator(tags)) {
		switch (key) {
			case 'title': {
				pairs.push({ key: isMdta ? 'title' : '©nam', value: dataStringBoxLong(value) });
			}; break;

			case 'description': {
				pairs.push({ key: isMdta ? 'description' : '©des', value: dataStringBoxLong(value) });
			}; break;

			case 'artist': {
				pairs.push({ key: isMdta ? 'artist' : '©ART', value: dataStringBoxLong(value) });
			}; break;

			case 'album': {
				pairs.push({ key: isMdta ? 'album' : '©alb', value: dataStringBoxLong(value) });
			}; break;

			case 'albumArtist': {
				pairs.push({ key: isMdta ? 'album_artist' : 'aART', value: dataStringBoxLong(value) });
			}; break;

			case 'comment': {
				pairs.push({ key: isMdta ? 'comment' : '©cmt', value: dataStringBoxLong(value) });
			}; break;

			case 'genre': {
				pairs.push({ key: isMdta ? 'genre' : '©gen', value: dataStringBoxLong(value) });
			}; break;

			case 'lyrics': {
				pairs.push({ key: isMdta ? 'lyrics' : '©lyr', value: dataStringBoxLong(value) });
			}; break;

			case 'date': {
				pairs.push({
					key: isMdta ? 'date' : '©day',
					value: dataStringBoxLong(value.toISOString().slice(0, 10)),
				});
			}; break;

			case 'images': {
				for (const image of value) {
					if (image.kind !== 'coverFront') {
						continue;
					}

					pairs.push({ key: 'covr', value: box('data', [
						u32(DATA_BOX_MIME_TYPE_MAP[image.mimeType] ?? 0), // Type indicator
						u32(0), // Locale indicator
						Array.from(image.data), // Kinda slow, hopefully temp
					]) });
				}
			}; break;

			case 'trackNumber': {
				if (isMdta) {
					const string = tags.tracksTotal !== undefined
						? `${value}/${tags.tracksTotal}`
						: value.toString();

					pairs.push({ key: 'track', value: dataStringBoxLong(string) });
				} else {
					pairs.push({ key: 'trkn', value: box('data', [
						u32(0), // 8 bytes empty
						u32(0),
						u16(0), // Empty
						u16(value),
						u16(tags.tracksTotal ?? 0),
						u16(0), // Empty
					]) });
				}
			}; break;

			case 'discNumber': {
				if (!isMdta) {
					// Only written for mdir
					pairs.push({ key: 'disc', value: box('data', [
						u32(0), // 8 bytes empty
						u32(0),
						u16(0), // Empty
						u16(value),
						u16(tags.discsTotal ?? 0),
						u16(0), // Empty
					]) });
				}
			}; break;

			case 'tracksTotal':
			case 'discsTotal':{
				// These are included with 'trackNumber' and 'discNumber' respectively
			}; break;

			case 'raw': {
				// Handled later
			}; break;

			default: assertNever(key);
		}
	}

	if (tags.raw) {
		for (const key in tags.raw) {
			const value = tags.raw[key];
			if (value == null || (!isMdta && key.length !== 4) || pairs.some(x => x.key === key)) {
				continue;
			}

			if (typeof value === 'string') {
				pairs.push({ key, value: dataStringBoxLong(value) });
			} else if (value instanceof Uint8Array) {
				pairs.push({ key, value: box('data', [
					u32(0), // Type indicator
					u32(0), // Locale indicator
					Array.from(value),
				]) });
			} else if (value instanceof RichImageData) {
				pairs.push({ key, value: box('data', [
					u32(DATA_BOX_MIME_TYPE_MAP[value.mimeType] ?? 0), // Type indicator
					u32(0), // Locale indicator
					Array.from(value.data), // Kinda slow, hopefully temp
				]) });
			}
		}
	}

	return pairs;
};

/** Metadata Box (mdir format) */
const metaMdir = (tags: MetadataTags) => {
	const pairs = generateMetadataPairs(tags, false);

	if (pairs.length === 0) {
		return null;
	}

	// fullBox format
	return fullBox('meta', 0, 0, undefined, [
		hdlr(false, 'mdir', '', 'appl'), // mdir handler
		box('ilst', undefined, pairs.map(pair => box(pair.key, undefined, [pair.value]))), // Item list without keys box
	]);
};

/** Metadata Box (mdta format with keys box) */
const metaMdta = (tags: MetadataTags) => {
	const pairs = generateMetadataPairs(tags, true);

	if (pairs.length === 0) {
		return null;
	}

	// box without version and flags
	return box('meta', undefined, [
		hdlr(false, 'mdta', ''), // mdta handler
		fullBox('keys', 0, 0, [
			u32(pairs.length),
		], pairs.map(pair => box('mdta', [ // Hacky since these aren't boxes technically, but if not box why box-shaped?
			...textEncoder.encode(pair.key),
		]))),
		box('ilst', undefined, pairs.map((pair, i) => {
			const boxName = String.fromCharCode(...u32(i + 1));
			return box(boxName, undefined, [pair.value]);
		})),
	]);
};

const dataStringBoxLong = (value: string) => {
	return box('data', [
		u32(1), // Type indicator (UTF-8)
		u32(0), // Locale indicator
		...textEncoder.encode(value),
	]);
};

const videoCodecToBoxName = (codec: VideoCodec, fullCodecString: string) => {
	switch (codec) {
		case 'avc': return fullCodecString.startsWith('avc3') ? 'avc3' : 'avc1';
		case 'hevc': return 'hvc1';
		case 'vp8': return 'vp08';
		case 'vp9': return 'vp09';
		case 'av1': return 'av01';
	}
};

const VIDEO_CODEC_TO_CONFIGURATION_BOX: Record<VideoCodec, (trackData: IsobmffVideoTrackData) => Box | null> = {
	avc: avcC,
	hevc: hvcC,
	vp8: vpcC,
	vp9: vpcC,
	av1: av1C,
};

const audioCodecToBoxName = (codec: AudioCodec, isQuickTime: boolean): string => {
	switch (codec) {
		case 'aac': return 'mp4a';
		case 'mp3': return 'mp4a';
		case 'opus': return 'Opus';
		case 'vorbis': return 'mp4a';
		case 'flac': return 'fLaC';
		case 'ulaw': return 'ulaw';
		case 'alaw': return 'alaw';
		case 'pcm-u8': return 'raw ';
		case 'pcm-s8': return 'sowt';
		case 'ac3': return 'ac-3';
		case 'eac3': return 'ec-3';
	}

	// Logic diverges here
	if (isQuickTime) {
		switch (codec) {
			case 'pcm-s16': return 'sowt';
			case 'pcm-s16be': return 'twos';
			case 'pcm-s24': return 'in24';
			case 'pcm-s24be': return 'in24';
			case 'pcm-s32': return 'in32';
			case 'pcm-s32be': return 'in32';
			case 'pcm-f32': return 'fl32';
			case 'pcm-f32be': return 'fl32';
			case 'pcm-f64': return 'fl64';
			case 'pcm-f64be': return 'fl64';
		}
	} else {
		switch (codec) {
			case 'pcm-s16': return 'ipcm';
			case 'pcm-s16be': return 'ipcm';
			case 'pcm-s24': return 'ipcm';
			case 'pcm-s24be': return 'ipcm';
			case 'pcm-s32': return 'ipcm';
			case 'pcm-s32be': return 'ipcm';
			case 'pcm-f32': return 'fpcm';
			case 'pcm-f32be': return 'fpcm';
			case 'pcm-f64': return 'fpcm';
			case 'pcm-f64be': return 'fpcm';
		}
	}
};

const audioCodecToConfigurationBox = (codec: AudioCodec, isQuickTime: boolean) => {
	switch (codec) {
		case 'aac': return esds;
		case 'mp3': return esds;
		case 'opus': return dOps;
		case 'vorbis': return esds;
		case 'flac': return dfLa;
		case 'ac3': return dac3;
		case 'eac3': return dec3;
	}

	// Logic diverges here
	if (isQuickTime) {
		switch (codec) {
			case 'pcm-s24': return wave;
			case 'pcm-s24be': return wave;
			case 'pcm-s32': return wave;
			case 'pcm-s32be': return wave;
			case 'pcm-f32': return wave;
			case 'pcm-f32be': return wave;
			case 'pcm-f64': return wave;
			case 'pcm-f64be': return wave;
		}
	} else {
		switch (codec) {
			case 'pcm-s16': return pcmC;
			case 'pcm-s16be': return pcmC;
			case 'pcm-s24': return pcmC;
			case 'pcm-s24be': return pcmC;
			case 'pcm-s32': return pcmC;
			case 'pcm-s32be': return pcmC;
			case 'pcm-f32': return pcmC;
			case 'pcm-f32be': return pcmC;
			case 'pcm-f64': return pcmC;
			case 'pcm-f64be': return pcmC;
		}
	}

	return null;
};

const SUBTITLE_CODEC_TO_BOX_NAME: Record<SubtitleCodec, string> = {
	webvtt: 'wvtt',
};

const SUBTITLE_CODEC_TO_CONFIGURATION_BOX: Record<
	SubtitleCodec,
	(trackData: IsobmffSubtitleTrackData) => Box | null
> = {
	webvtt: vttC,
};

const getLanguageCodeInt = (code: string) => {
	assert(code.length === 3); ;

	let language = 0;
	for (let i = 0; i < 3; i++) {
		language <<= 5;
		language += code.charCodeAt(i) - 0x60;
	}

	return language;
};
