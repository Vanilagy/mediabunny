/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	Bitstream,
	COLOR_PRIMARIES_MAP,
	MATRIX_COEFFICIENTS_MAP,
	TRANSFER_CHARACTERISTICS_MAP,
	UNDETERMINED_LANGUAGE,
	assert,
	assertNever,
	colorSpaceIsComplete,
	imageMimeTypeToExtension,
	keyValueIterator,
	normalizeRotation,
	promiseWithResolvers,
	roundToMultiple,
	textEncoder,
	toUint8Array,
	uint8ArraysAreEqual,
	writeBits,
} from '../misc';
import {
	CODEC_STRING_MAP,
	EBML,
	EBMLElement,
	EBMLFloat32,
	EBMLFloat64,
	EBMLId,
	EBMLSignedInt,
	EBMLUnicodeString,
	EBMLWriter,
} from './ebml';
import { buildMatroskaMimeType } from './matroska-misc';
import { MkvOutputFormat, WebMOutputFormat } from '../output-format';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from '../output';
import {
	SubtitleConfig,
	SubtitleCue,
	SubtitleMetadata,
	formatSubtitleTimestamp,
	inlineTimestampRegex,
	parseSubtitleTimestamp,
} from '../subtitles';
import {
	aacChannelMap,
	aacFrequencyTable,
	buildAacAudioSpecificConfig,
	OPUS_SAMPLE_RATE,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	SubtitleCodec,
	generateAv1CodecConfigurationFromCodecString,
	generateVp9CodecConfigurationFromCodecString,
	parsePcmCodec,
	validateAudioChunkMetadata,
	validateSubtitleMetadata,
	validateVideoChunkMetadata,
} from '../codec';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import { FileSlice } from '../reader';
import { Muxer } from '../muxer';
import { Writer } from '../writer';
import { EncodedPacket } from '../packet';
import { parseOpusIdentificationHeader } from '../codec-data';
import { AttachedFile } from '../metadata';

const MIN_CLUSTER_TIMESTAMP_MS = -(2 ** 15);
const MAX_CLUSTER_TIMESTAMP_MS = 2 ** 15 - 1;
const APP_NAME = 'Mediabunny';
const SEGMENT_SIZE_BYTES = 6;
const CLUSTER_SIZE_BYTES = 5;

type InternalMediaChunk = {
	data: Uint8Array;
	type: 'key' | 'delta';
	timestamp: number;
	duration: number;
	additions: Uint8Array | null;
};

type MatroskaTrackData = {
	chunkQueue: InternalMediaChunk[];
	lastWrittenMsTimestamp: number | null;
} & ({
	track: OutputVideoTrack;
	type: 'video';
	info: {
		width: number;
		height: number;
		decoderConfig: VideoDecoderConfig;
		alphaMode: boolean;
	};
} | {
	track: OutputAudioTrack;
	type: 'audio';
	info: {
		numberOfChannels: number;
		sampleRate: number;
		decoderConfig: AudioDecoderConfig;
		/**
		 * The "ADTS stripping" involves removing the ADTS header from each AAC packet. SOBMFF stores raw AAC data, not
		 * ADTS-wrapped data.
		 */
		requiresAdtsStripping: boolean;
	};
} | {
	track: OutputSubtitleTrack;
	type: 'subtitle';
	info: {
		config: SubtitleConfig;
	};
});

type MatroskaVideoTrackData = MatroskaTrackData & { type: 'video' };
type MatroskaAudioTrackData = MatroskaTrackData & { type: 'audio' };
type MatroskaSubtitleTrackData = MatroskaTrackData & { type: 'subtitle' };

const TRACK_TYPE_MAP: Record<OutputTrack['type'], number> = {
	video: 1,
	audio: 2,
	subtitle: 17,
};

export class MatroskaMuxer extends Muxer {
	private writer: Writer;
	private ebmlWriter: EBMLWriter;
	private format: WebMOutputFormat | MkvOutputFormat;

	private trackDatas: MatroskaTrackData[] = [];
	private allTracksKnown = promiseWithResolvers();

	private segment: EBMLElement | null = null;
	private segmentInfo: EBMLElement | null = null;
	private seekHead: EBMLElement | null = null;
	private tracksElement: EBMLElement | null = null;
	private tagsElement: EBMLElement | null = null;
	private attachmentsElement: EBMLElement | null = null;
	private segmentDuration: EBMLElement | null = null;
	private cues: EBMLElement | null = null;

	private currentCluster: EBMLElement | null = null;
	private currentClusterStartMsTimestamp: number | null = null;
	private currentClusterMaxMsTimestamp: number | null = null;
	private trackDatasInCurrentCluster = new Map<MatroskaTrackData, {
		firstMsTimestamp: number;
	}>();

	private duration = 0;

	constructor(output: Output, format: MkvOutputFormat) {
		super(output);

		this.writer = output._writer;
		this.format = format;

		this.ebmlWriter = new EBMLWriter(this.writer);

		if (this.format._options.appendOnly) {
			this.writer.ensureMonotonicity = true;
		}
	}

	async start() {
		const release = await this.mutex.acquire();

		this.writeEBMLHeader();

		this.createSegmentInfo();
		this.createCues();

		await this.writer.flush();

		release();
	}

	private writeEBMLHeader() {
		if (this.format._options.onEbmlHeader) {
			this.writer.startTrackingWrites();
		}

		const ebmlHeader: EBML = { id: EBMLId.EBML, data: [
			{ id: EBMLId.EBMLVersion, data: 1 },
			{ id: EBMLId.EBMLReadVersion, data: 1 },
			{ id: EBMLId.EBMLMaxIDLength, data: 4 },
			{ id: EBMLId.EBMLMaxSizeLength, data: 8 },
			{ id: EBMLId.DocType, data: this.format instanceof WebMOutputFormat ? 'webm' : 'matroska' },
			{ id: EBMLId.DocTypeVersion, data: 2 },
			{ id: EBMLId.DocTypeReadVersion, data: 2 },
		] };
		this.ebmlWriter.writeEBML(ebmlHeader);

		if (this.format._options.onEbmlHeader) {
			const { data, start } = this.writer.stopTrackingWrites(); // start should be 0
			this.format._options.onEbmlHeader(data, start);
		}
	}

	/**
	 * Creates a SeekHead element which is positioned near the start of the file and allows the media player to seek to
	 * relevant sections more easily. Since we don't know the positions of those sections yet, we'll set them later.
	 */
	private maybeCreateSeekHead(writeOffsets: boolean) {
		if (this.format._options.appendOnly) {
			return;
		}

		const kaxCues = new Uint8Array([0x1c, 0x53, 0xbb, 0x6b]);
		const kaxInfo = new Uint8Array([0x15, 0x49, 0xa9, 0x66]);
		const kaxTracks = new Uint8Array([0x16, 0x54, 0xae, 0x6b]);
		const kaxAttachments = new Uint8Array([0x19, 0x41, 0xa4, 0x69]);
		const kaxTags = new Uint8Array([0x12, 0x54, 0xc3, 0x67]);

		const seekHead = { id: EBMLId.SeekHead, data: [
			{ id: EBMLId.Seek, data: [
				{ id: EBMLId.SeekID, data: kaxCues },
				{
					id: EBMLId.SeekPosition,
					size: 5,
					data: writeOffsets
						? this.ebmlWriter.offsets.get(this.cues!)! - this.segmentDataOffset
						: 0,
				},
			] },
			{ id: EBMLId.Seek, data: [
				{ id: EBMLId.SeekID, data: kaxInfo },
				{
					id: EBMLId.SeekPosition,
					size: 5,
					data: writeOffsets
						? this.ebmlWriter.offsets.get(this.segmentInfo!)! - this.segmentDataOffset
						: 0,
				},
			] },
			{ id: EBMLId.Seek, data: [
				{ id: EBMLId.SeekID, data: kaxTracks },
				{
					id: EBMLId.SeekPosition,
					size: 5,
					data: writeOffsets
						? this.ebmlWriter.offsets.get(this.tracksElement!)! - this.segmentDataOffset
						: 0,
				},
			] },
			this.attachmentsElement
				? { id: EBMLId.Seek, data: [
						{ id: EBMLId.SeekID, data: kaxAttachments },
						{
							id: EBMLId.SeekPosition,
							size: 5,
							data: writeOffsets
								? this.ebmlWriter.offsets.get(this.attachmentsElement)! - this.segmentDataOffset
								: 0,
						},
					] }
				: null,
			this.tagsElement
				? { id: EBMLId.Seek, data: [
						{ id: EBMLId.SeekID, data: kaxTags },
						{
							id: EBMLId.SeekPosition,
							size: 5,
							data: writeOffsets
								? this.ebmlWriter.offsets.get(this.tagsElement)! - this.segmentDataOffset
								: 0,
						},
					] }
				: null,
		] };
		this.seekHead = seekHead;
	}

	private createSegmentInfo() {
		const segmentDuration: EBML = { id: EBMLId.Duration, data: new EBMLFloat64(0) };
		this.segmentDuration = segmentDuration;

		const segmentInfo: EBML = { id: EBMLId.Info, data: [
			{ id: EBMLId.TimestampScale, data: 1e6 },
			{ id: EBMLId.MuxingApp, data: APP_NAME },
			{ id: EBMLId.WritingApp, data: APP_NAME },
			!this.format._options.appendOnly ? segmentDuration : null,
		] };
		this.segmentInfo = segmentInfo;
	}

	private createTracks() {
		const tracksElement = { id: EBMLId.Tracks, data: [] as EBML[] };
		this.tracksElement = tracksElement;

		for (const trackData of this.trackDatas) {
			const codecId = CODEC_STRING_MAP[trackData.track.source._codec];
			assert(codecId);

			let seekPreRollNs = 0;
			if (trackData.type === 'audio' && trackData.track.source._codec === 'opus') {
				seekPreRollNs = 1e6 * 80; // In "Matroska ticks" (nanoseconds)

				const description = trackData.info.decoderConfig.description;
				if (description) {
					const bytes = toUint8Array(description);
					const header = parseOpusIdentificationHeader(bytes);

					// Use the preSkip value from the header
					seekPreRollNs = Math.round(1e9 * (header.preSkip / OPUS_SAMPLE_RATE));
				}
			}

			tracksElement.data.push({ id: EBMLId.TrackEntry, data: [
				{ id: EBMLId.TrackNumber, data: trackData.track.id },
				{ id: EBMLId.TrackUID, data: trackData.track.id },
				{ id: EBMLId.TrackType, data: TRACK_TYPE_MAP[trackData.type] },
				trackData.track.metadata.disposition?.default === false
					? { id: EBMLId.FlagDefault, data: 0 }
					: null,
				trackData.track.metadata.disposition?.forced
					? { id: EBMLId.FlagForced, data: 1 }
					: null,
				trackData.track.metadata.disposition?.hearingImpaired
					? { id: EBMLId.FlagHearingImpaired, data: 1 }
					: null,
				trackData.track.metadata.disposition?.visuallyImpaired
					? { id: EBMLId.FlagVisualImpaired, data: 1 }
					: null,
				trackData.track.metadata.disposition?.original
					? { id: EBMLId.FlagOriginal, data: 1 }
					: null,
				trackData.track.metadata.disposition?.commentary
					? { id: EBMLId.FlagCommentary, data: 1 }
					: null,
				{ id: EBMLId.FlagLacing, data: 0 },
				{ id: EBMLId.Language, data: trackData.track.metadata.languageCode ?? UNDETERMINED_LANGUAGE },
				{ id: EBMLId.CodecID, data: codecId },
				{ id: EBMLId.CodecDelay, data: 0 },
				{ id: EBMLId.SeekPreRoll, data: seekPreRollNs },
				trackData.track.metadata.name !== undefined
					? { id: EBMLId.Name, data: new EBMLUnicodeString(trackData.track.metadata.name) }
					: null,
				(trackData.type === 'video' ? this.videoSpecificTrackInfo(trackData) : null),
				(trackData.type === 'audio' ? this.audioSpecificTrackInfo(trackData) : null),
				(trackData.type === 'subtitle' ? this.subtitleSpecificTrackInfo(trackData) : null),
			] });
		}
	}

	private videoSpecificTrackInfo(trackData: MatroskaVideoTrackData) {
		const { frameRate, rotation } = trackData.track.metadata;

		const elements: EBMLElement['data'] = [
			(trackData.info.decoderConfig.description
				? {
						id: EBMLId.CodecPrivate,
						data: toUint8Array(trackData.info.decoderConfig.description),
					}
				: null),
			(frameRate
				? {
						id: EBMLId.DefaultDuration,
						data: 1e9 / frameRate,
					}
				: null),
		];

		// Convert from clockwise to counter-clockwise
		const flippedRotation = rotation ? normalizeRotation(-rotation) : 0;

		const colorSpace = trackData.info.decoderConfig.colorSpace;
		const videoElement: EBMLElement = { id: EBMLId.Video, data: [
			{ id: EBMLId.PixelWidth, data: trackData.info.width },
			{ id: EBMLId.PixelHeight, data: trackData.info.height },
			trackData.info.alphaMode ? { id: EBMLId.AlphaMode, data: 1 } : null,
			(colorSpaceIsComplete(colorSpace)
				? {
						id: EBMLId.Colour,
						data: [
							{
								id: EBMLId.MatrixCoefficients,
								data: MATRIX_COEFFICIENTS_MAP[colorSpace.matrix],
							},
							{
								id: EBMLId.TransferCharacteristics,
								data: TRANSFER_CHARACTERISTICS_MAP[colorSpace.transfer],
							},
							{
								id: EBMLId.Primaries,
								data: COLOR_PRIMARIES_MAP[colorSpace.primaries],
							},
							{
								id: EBMLId.Range,
								data: colorSpace.fullRange ? 2 : 1,
							},
						],
					}
				: null),
			(flippedRotation
				? {
						id: EBMLId.Projection,
						data: [
							{
								id: EBMLId.ProjectionType,
								data: 0, // rectangular
							},
							{
								id: EBMLId.ProjectionPoseRoll,
								data: new EBMLFloat32((flippedRotation + 180) % 360 - 180), // [0, 270] -> [-180, 90]
							},
						],
					}
				: null),
		] };

		elements.push(videoElement);

		return elements;
	}

	private audioSpecificTrackInfo(trackData: MatroskaAudioTrackData) {
		const pcmInfo = (PCM_AUDIO_CODECS as readonly string[]).includes(trackData.track.source._codec)
			? parsePcmCodec(trackData.track.source._codec as PcmAudioCodec)
			: null;

		return [
			(trackData.info.decoderConfig.description
				? {
						id: EBMLId.CodecPrivate,
						data: toUint8Array(trackData.info.decoderConfig.description),
					}
				: null),
			{ id: EBMLId.Audio, data: [
				{ id: EBMLId.SamplingFrequency, data: new EBMLFloat32(trackData.info.sampleRate) },
				{ id: EBMLId.Channels, data: trackData.info.numberOfChannels },
				pcmInfo ? { id: EBMLId.BitDepth, data: 8 * pcmInfo.sampleSize } : null,
			] },
		];
	}

	private subtitleSpecificTrackInfo(trackData: MatroskaSubtitleTrackData) {
		return [
			{ id: EBMLId.CodecPrivate, data: textEncoder.encode(trackData.info.config.description) },
		];
	}

	private maybeCreateTags() {
		const simpleTags: EBMLElement[] = [];

		const addSimpleTag = (key: string, value: string | Uint8Array) => {
			simpleTags.push({ id: EBMLId.SimpleTag, data: [
				{ id: EBMLId.TagName, data: new EBMLUnicodeString(key) },
				typeof value === 'string'
					? { id: EBMLId.TagString, data: new EBMLUnicodeString(value) }
					: { id: EBMLId.TagBinary, data: value },
			] });
		};

		const metadataTags = this.output._metadataTags;
		const writtenTags = new Set<string>();

		for (const { key, value } of keyValueIterator(metadataTags)) {
			switch (key) {
				case 'title': {
					addSimpleTag('TITLE', value);
					writtenTags.add('TITLE');
				}; break;

				case 'description': {
					addSimpleTag('DESCRIPTION', value);
					writtenTags.add('DESCRIPTION');
				}; break;

				case 'artist': {
					addSimpleTag('ARTIST', value);
					writtenTags.add('ARTIST');
				}; break;

				case 'album': {
					addSimpleTag('ALBUM', value);
					writtenTags.add('ALBUM');
				}; break;

				case 'albumArtist': {
					addSimpleTag('ALBUM_ARTIST', value);
					writtenTags.add('ALBUM_ARTIST');
				}; break;

				case 'genre': {
					addSimpleTag('GENRE', value);
					writtenTags.add('GENRE');
				}; break;

				case 'comment': {
					addSimpleTag('COMMENT', value);
					writtenTags.add('COMMENT');
				}; break;

				case 'lyrics': {
					addSimpleTag('LYRICS', value);
					writtenTags.add('LYRICS');
				}; break;

				case 'date': {
					addSimpleTag('DATE', value.toISOString().slice(0, 10));
					writtenTags.add('DATE');
				}; break;

				case 'trackNumber': {
					const string = metadataTags.tracksTotal !== undefined
						? `${value}/${metadataTags.tracksTotal}`
						: value.toString();

					addSimpleTag('PART_NUMBER', string);
					writtenTags.add('PART_NUMBER');
				}; break;

				case 'discNumber': {
					const string = metadataTags.discsTotal !== undefined
						? `${value}/${metadataTags.discsTotal}`
						: value.toString();

					addSimpleTag('DISC', string);
					writtenTags.add('DISC');
				}; break;

				case 'tracksTotal':
				case 'discsTotal': {
					// Handled with trackNumber and discNumber respectively
				}; break;

				case 'images':
				case 'raw': {
					// Handled elsewhere
				}; break;

				default: assertNever(key);
			}
		}

		if (metadataTags.raw) {
			for (const key in metadataTags.raw) {
				const value = metadataTags.raw[key]!;
				if (value == null || writtenTags.has(key)) {
					continue;
				}

				if (typeof value === 'string' || value instanceof Uint8Array) {
					addSimpleTag(key, value);
				}
			}
		}

		if (simpleTags.length === 0) {
			return;
		}

		this.tagsElement = {
			id: EBMLId.Tags,
			data: [{ id: EBMLId.Tag, data: [
				{ id: EBMLId.Targets, data: [
					{ id: EBMLId.TargetTypeValue, data: 50 },
					{ id: EBMLId.TargetType, data: 'MOVIE' },
				] },
				...simpleTags,
			] }],
		};
	}

	private maybeCreateAttachments() {
		const metadataTags = this.output._metadataTags;
		const elements: EBMLElement[] = [];

		const existingFileUids = new Set<bigint>();
		const images = metadataTags.images ?? [];

		for (const image of images) {
			let imageName = image.name;
			if (imageName === undefined) {
				const baseName = image.kind === 'coverFront' ? 'cover' : image.kind === 'coverBack' ? 'back' : 'image';
				imageName = baseName + (imageMimeTypeToExtension(image.mimeType) ?? '');
			}

			let fileUid: bigint;
			while (true) {
				// Generate a random 64-bit unsigned integer
				fileUid = 0n;
				for (let i = 0; i < 8; i++) {
					fileUid <<= 8n;
					fileUid |= BigInt(Math.floor(Math.random() * 256));
				}

				if (fileUid !== 0n && !existingFileUids.has(fileUid)) {
					break;
				}
			}

			existingFileUids.add(fileUid);

			elements.push({
				id: EBMLId.AttachedFile,
				data: [
					image.description !== undefined
						? { id: EBMLId.FileDescription, data: new EBMLUnicodeString(image.description) }
						: null,
					{ id: EBMLId.FileName, data: new EBMLUnicodeString(imageName) },
					{ id: EBMLId.FileMediaType, data: image.mimeType },
					{ id: EBMLId.FileData, data: image.data },
					{ id: EBMLId.FileUID, data: fileUid },
				],
			});
		}

		// Add all AttachedFiles from the raw metadata
		for (const [key, value] of Object.entries(metadataTags.raw ?? {})) {
			if (!(value instanceof AttachedFile)) {
				continue;
			}

			const keyIsNumeric = /^\d+$/.test(key);
			if (!keyIsNumeric) {
				continue;
			}

			if (images.find(x => x.mimeType === value.mimeType && uint8ArraysAreEqual(x.data, value.data))) {
				// This attached file has very likely already been added as an image above
				// (happens when remuxing Matroska)
				continue;
			}

			elements.push({
				id: EBMLId.AttachedFile,
				data: [
					value.description !== undefined
						? { id: EBMLId.FileDescription, data: new EBMLUnicodeString(value.description) }
						: null,
					{ id: EBMLId.FileName, data: new EBMLUnicodeString(value.name ?? '') },
					{ id: EBMLId.FileMediaType, data: value.mimeType ?? '' },
					{ id: EBMLId.FileData, data: value.data },
					{ id: EBMLId.FileUID, data: BigInt(key) },
				],
			});
		}

		if (elements.length === 0) {
			return;
		}

		this.attachmentsElement = { id: EBMLId.Attachments, data: elements };
	}

	private createSegment() {
		this.createTracks();
		this.maybeCreateTags();
		this.maybeCreateAttachments();
		this.maybeCreateSeekHead(false);

		const segment: EBML = {
			id: EBMLId.Segment,
			size: this.format._options.appendOnly ? -1 : SEGMENT_SIZE_BYTES,
			data: [
				this.seekHead, // null if append-only
				this.segmentInfo,
				this.tracksElement,
				// Matroska spec says put this at the end of the file, but I think placing it before the first cluster
				// makes more sense, and FFmpeg agrees (argumentum ad ffmpegum fallacy)
				this.attachmentsElement,
				this.tagsElement,
			],
		};
		this.segment = segment;

		if (this.format._options.onSegmentHeader) {
			this.writer.startTrackingWrites();
		}

		this.ebmlWriter.writeEBML(segment);

		if (this.format._options.onSegmentHeader) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onSegmentHeader(data, start);
		}
	}

	private createCues() {
		this.cues = { id: EBMLId.Cues, data: [] };
	}

	private get segmentDataOffset() {
		assert(this.segment);
		return this.ebmlWriter.dataOffsets.get(this.segment)!;
	}

	private allTracksAreKnown() {
		for (const track of this.output._tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	async getMimeType() {
		await this.allTracksKnown.promise;

		const codecStrings = this.trackDatas.map((trackData) => {
			if (trackData.type === 'video') {
				return trackData.info.decoderConfig.codec;
			} else if (trackData.type === 'audio') {
				return trackData.info.decoderConfig.codec;
			} else {
				const map: Record<SubtitleCodec, string> = {
					webvtt: 'wvtt',
				};
				return map[trackData.track.source._codec];
			}
		});

		return buildMatroskaMimeType({
			isWebM: this.format instanceof WebMOutputFormat,
			hasVideo: this.trackDatas.some(x => x.type === 'video'),
			hasAudio: this.trackDatas.some(x => x.type === 'audio'),
			codecStrings,
		});
	}

	private getVideoTrackData(track: OutputVideoTrack, packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData as MatroskaVideoTrackData;
		}

		validateVideoChunkMetadata(meta);

		assert(meta);
		assert(meta.decoderConfig);
		assert(meta.decoderConfig.codedWidth !== undefined);
		assert(meta.decoderConfig.codedHeight !== undefined);

		const newTrackData: MatroskaVideoTrackData = {
			track,
			type: 'video',
			info: {
				width: meta.decoderConfig.codedWidth,
				height: meta.decoderConfig.codedHeight,
				decoderConfig: meta.decoderConfig,
				alphaMode: !!packet.sideData.alpha, // The first packet determines if this track has alpha or not
			},
			chunkQueue: [],
			lastWrittenMsTimestamp: null,
		};

		if (track.source._codec === 'vp9') {
			// https://www.webmproject.org/docs/container specifies that VP9 "SHOULD" make use of the CodecPrivate
			// field. Since WebCodecs makes no use of the description field for VP9, we need to derive it ourselves:
			newTrackData.info.decoderConfig = {
				...newTrackData.info.decoderConfig,
				description: new Uint8Array(
					generateVp9CodecConfigurationFromCodecString(newTrackData.info.decoderConfig.codec),
				),
			};
		} else if (track.source._codec === 'av1') {
			// Per https://github.com/ietf-wg-cellar/matroska-specification/blob/master/codec/av1.md, AV1 requires
			// CodecPrivate to be set, but WebCodecs makes no use of the description field for AV1. Thus, let's derive
			// it ourselves:
			newTrackData.info.decoderConfig = {
				...newTrackData.info.decoderConfig,
				description: new Uint8Array(
					generateAv1CodecConfigurationFromCodecString(newTrackData.info.decoderConfig.codec),
				),
			};
		}

		this.trackDatas.push(newTrackData);
		this.trackDatas.sort((a, b) => a.track.id - b.track.id);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private getAudioTrackData(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData as MatroskaAudioTrackData;
		}

		validateAudioChunkMetadata(meta);

		assert(meta);
		assert(meta.decoderConfig);

		const decoderConfig = { ...meta.decoderConfig };
		let requiresAdtsStripping = false;

		if (track.source._codec === 'aac' && !decoderConfig.description) {
			// Matroska stores raw AAC with AudioSpecificConfig in CodecPrivate, not ADTS-wrapped data.
			// Parse the first packet to extract the AudioSpecificConfig.
			const adtsFrame = readAdtsFrameHeader(FileSlice.tempFromBytes(packet.data));
			if (!adtsFrame) {
				throw new Error(
					'Couldn\'t parse ADTS header from the AAC packet. Make sure the packets are in ADTS format'
					+ ' (as specified in ISO 13818-7) when not providing a description, or provide a description'
					+ ' (must be an AudioSpecificConfig as specified in ISO 14496-3) and ensure the packets'
					+ ' are raw AAC data.',
				);
			}

			const sampleRate = aacFrequencyTable[adtsFrame.samplingFrequencyIndex];
			const numberOfChannels = aacChannelMap[adtsFrame.channelConfiguration];

			if (sampleRate === undefined || numberOfChannels === undefined) {
				throw new Error('Invalid ADTS frame header.');
			}

			decoderConfig.description = buildAacAudioSpecificConfig({
				objectType: adtsFrame.objectType,
				sampleRate,
				numberOfChannels,
			});
			requiresAdtsStripping = true;
		}

		const newTrackData: MatroskaAudioTrackData = {
			track,
			type: 'audio',
			info: {
				numberOfChannels: meta.decoderConfig.numberOfChannels,
				sampleRate: meta.decoderConfig.sampleRate,
				decoderConfig,
				requiresAdtsStripping,
			},
			chunkQueue: [],
			lastWrittenMsTimestamp: null,
		};

		this.trackDatas.push(newTrackData);
		this.trackDatas.sort((a, b) => a.track.id - b.track.id);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private getSubtitleTrackData(track: OutputSubtitleTrack, meta?: SubtitleMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData as MatroskaAudioTrackData;
		}

		validateSubtitleMetadata(meta);

		assert(meta);
		assert(meta.config);

		const newTrackData: MatroskaSubtitleTrackData = {
			track,
			type: 'subtitle',
			info: {
				config: meta.config,
			},
			chunkQueue: [],
			lastWrittenMsTimestamp: null,
		};

		this.trackDatas.push(newTrackData);
		this.trackDatas.sort((a, b) => a.track.id - b.track.id);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	async addEncodedVideoPacket(track: OutputVideoTrack, packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getVideoTrackData(track, packet, meta);

			const isKeyFrame = packet.type === 'key';
			let timestamp = this.validateAndNormalizeTimestamp(trackData.track, packet.timestamp, isKeyFrame);
			let duration = packet.duration;

			if (track.metadata.frameRate !== undefined) {
				// Constrain the time values to the frame rate
				timestamp = roundToMultiple(timestamp, 1 / track.metadata.frameRate);
				duration = roundToMultiple(duration, 1 / track.metadata.frameRate);
			}

			const additions = trackData.info.alphaMode
				? packet.sideData.alpha ?? null
				: null;

			const videoChunk = this.createInternalChunk(packet.data, timestamp, duration, packet.type, additions);
			if (track.source._codec === 'vp9') this.fixVP9ColorSpace(trackData, videoChunk);

			trackData.chunkQueue.push(videoChunk);
			await this.interleaveChunks();
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getAudioTrackData(track, packet, meta);

			let packetData = packet.data;
			if (trackData.info.requiresAdtsStripping) {
				const adtsFrame = readAdtsFrameHeader(FileSlice.tempFromBytes(packetData));
				if (!adtsFrame) {
					throw new Error('Expected ADTS frame, didn\'t get one.');
				}

				const headerLength = adtsFrame.crcCheck === null
					? MIN_ADTS_FRAME_HEADER_SIZE
					: MAX_ADTS_FRAME_HEADER_SIZE;
				packetData = packetData.subarray(headerLength);
			}

			const isKeyFrame = packet.type === 'key';
			const timestamp = this.validateAndNormalizeTimestamp(trackData.track, packet.timestamp, isKeyFrame);
			const audioChunk = this.createInternalChunk(packetData, timestamp, packet.duration, packet.type);

			trackData.chunkQueue.push(audioChunk);
			await this.interleaveChunks();
		} finally {
			release();
		}
	}

	async addSubtitleCue(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getSubtitleTrackData(track, meta);

			const timestamp = this.validateAndNormalizeTimestamp(trackData.track, cue.timestamp, true);

			let bodyText = cue.text;
			const timestampMs = Math.round(timestamp * 1000);

			// Replace in-body timestamps so that they're relative to the cue start time
			inlineTimestampRegex.lastIndex = 0;
			bodyText = bodyText.replace(inlineTimestampRegex, (match) => {
				const time = parseSubtitleTimestamp(match.slice(1, -1));
				const offsetTime = time - timestampMs;

				return `<${formatSubtitleTimestamp(offsetTime)}>`;
			});

			const body = textEncoder.encode(bodyText);
			const additions = `${cue.settings ?? ''}\n${cue.identifier ?? ''}\n${cue.notes ?? ''}`;

			const subtitleChunk = this.createInternalChunk(
				body,
				timestamp,
				cue.duration,
				'key',
				additions.trim() ? textEncoder.encode(additions) : null,
			);

			trackData.chunkQueue.push(subtitleChunk);
			await this.interleaveChunks();
		} finally {
			release();
		}
	}

	private async interleaveChunks(isFinalCall = false) {
		if (!isFinalCall && !this.allTracksAreKnown()) {
			return; // We can't interleave yet as we don't yet know how many tracks we'll truly have
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: MatroskaTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (!isFinalCall && trackData.chunkQueue.length === 0 && !trackData.track.source._closed) {
					break outer;
				}

				if (trackData.chunkQueue.length > 0 && trackData.chunkQueue[0]!.timestamp < minTimestamp) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.chunkQueue[0]!.timestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const chunk = trackWithMinTimestamp.chunkQueue.shift()!;
			this.writeBlock(trackWithMinTimestamp, chunk);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	/**
	 * Due to [a bug in Chromium](https://bugs.chromium.org/p/chromium/issues/detail?id=1377842), VP9 streams often
 	 * lack color space information. This method patches in that information.
	 */
	private fixVP9ColorSpace(
		trackData: MatroskaVideoTrackData,
		chunk: InternalMediaChunk,
	) {
		// http://downloads.webmproject.org/docs/vp9/vp9-bitstream_superframe-and-uncompressed-header_v1.0.pdf

		if (chunk.type !== 'key') return;
		if (!trackData.info.decoderConfig.colorSpace || !trackData.info.decoderConfig.colorSpace.matrix) return;

		const bitstream = new Bitstream(chunk.data);

		bitstream.skipBits(2);

		const profileLowBit = bitstream.readBits(1);
		const profileHighBit = bitstream.readBits(1);
		const profile = (profileHighBit << 1) + profileLowBit;

		if (profile === 3) bitstream.skipBits(1);

		const showExistingFrame = bitstream.readBits(1);
		if (showExistingFrame) return;

		const frameType = bitstream.readBits(1);
		if (frameType !== 0) return; // Just to be sure

		bitstream.skipBits(2);

		const syncCode = bitstream.readBits(24);
		if (syncCode !== 0x498342) return;

		if (profile >= 2) bitstream.skipBits(1);

		const colorSpaceID = {
			rgb: 7,
			bt709: 2,
			bt470bg: 1,
			smpte170m: 3,
		}[trackData.info.decoderConfig.colorSpace.matrix];

		// The bitstream position is now at the start of the color space bits.
		// We can use the global writeBits function here as requested.
		writeBits(chunk.data, bitstream.pos, bitstream.pos + 3, colorSpaceID);
	}

	/** Converts a read-only external chunk into an internal one for easier use. */
	private createInternalChunk(
		data: Uint8Array,
		timestamp: number,
		duration: number,
		type: 'key' | 'delta',
		additions: Uint8Array | null = null,
	) {
		const internalChunk: InternalMediaChunk = {
			data,
			type,
			timestamp,
			duration,
			additions,
		};

		return internalChunk;
	}

	/** Writes a block containing media data to the file. */
	private writeBlock(trackData: MatroskaTrackData, chunk: InternalMediaChunk) {
		// Due to the interlacing algorithm, this code will be run once we've seen one chunk from every media track.
		if (!this.segment) {
			this.createSegment();
		}

		const msTimestamp = Math.round(1000 * chunk.timestamp);

		// We wanna only finalize this cluster (and begin a new one) if we know that each track will be able to
		// start the new one with a key frame.
		const keyFrameQueuedEverywhere = this.trackDatas.every((otherTrackData) => {
			if (trackData === otherTrackData) {
				return chunk.type === 'key';
			}

			const firstQueuedSample = otherTrackData.chunkQueue[0];
			if (firstQueuedSample) {
				return firstQueuedSample.type === 'key';
			}

			return otherTrackData.track.source._closed;
		});

		let shouldCreateNewCluster = false;
		if (!this.currentCluster) {
			shouldCreateNewCluster = true;
		} else {
			assert(this.currentClusterStartMsTimestamp !== null);
			assert(this.currentClusterMaxMsTimestamp !== null);

			const relativeTimestamp = msTimestamp - this.currentClusterStartMsTimestamp;

			shouldCreateNewCluster = (
				keyFrameQueuedEverywhere
				// This check is required because that means there is already a block with this timestamp in the
				// CURRENT chunk, meaning that starting the next cluster at the same timestamp is forbidden (since
				// the already-written block would belong into it instead).
				&& msTimestamp > this.currentClusterMaxMsTimestamp
				&& relativeTimestamp >= 1000 * (this.format._options.minimumClusterDuration ?? 1)
			)
			// The cluster would exceed its maximum allowed length. This puts us in an unfortunate position and forces
			// us to begin the next cluster with a delta frame. Although this is undesirable, it is not forbidden by the
			// spec and is supported by players.
			|| relativeTimestamp > MAX_CLUSTER_TIMESTAMP_MS;
		}

		if (shouldCreateNewCluster) {
			this.createNewCluster(msTimestamp);
		}

		const relativeTimestamp = msTimestamp - this.currentClusterStartMsTimestamp!;
		if (relativeTimestamp < MIN_CLUSTER_TIMESTAMP_MS) {
			// The block lies too far in the past, it's not representable within this cluster
			return;
		}

		const prelude = new Uint8Array(4);
		const view = new DataView(prelude.buffer);
		// 0x80 to indicate it's the last byte of a multi-byte number
		view.setUint8(0, 0x80 | trackData.track.id);
		view.setInt16(1, relativeTimestamp, false);

		const msDuration = Math.round(1000 * chunk.duration);

		if (!chunk.additions) {
			// No additions, we can write out a SimpleBlock
			view.setUint8(3, Number(chunk.type === 'key') << 7); // Flags (keyframe flag only present for SimpleBlock)

			const simpleBlock = { id: EBMLId.SimpleBlock, data: [
				prelude,
				chunk.data,
			] };
			this.ebmlWriter.writeEBML(simpleBlock);
		} else {
			const blockGroup = { id: EBMLId.BlockGroup, data: [
				{ id: EBMLId.Block, data: [
					prelude,
					chunk.data,
				] },
				chunk.type === 'delta'
					? {
							id: EBMLId.ReferenceBlock,
							data: new EBMLSignedInt(trackData.lastWrittenMsTimestamp! - msTimestamp),
						}
					: null,
				chunk.additions
					? { id: EBMLId.BlockAdditions, data: [
							{ id: EBMLId.BlockMore, data: [
								{ id: EBMLId.BlockAddID, data: 1 }, // Some players expect BlockAddID to come first
								{ id: EBMLId.BlockAdditional, data: chunk.additions },
							] },
						] }
					: null,
				msDuration > 0 ? { id: EBMLId.BlockDuration, data: msDuration } : null,
			] };
			this.ebmlWriter.writeEBML(blockGroup);
		}

		this.duration = Math.max(this.duration, msTimestamp + msDuration);
		trackData.lastWrittenMsTimestamp = msTimestamp;

		if (!this.trackDatasInCurrentCluster.has(trackData)) {
			this.trackDatasInCurrentCluster.set(trackData, {
				firstMsTimestamp: msTimestamp,
			});
		}
		this.currentClusterMaxMsTimestamp = Math.max(this.currentClusterMaxMsTimestamp!, msTimestamp);
	}

	/** Creates a new Cluster element to contain media chunks. */
	private createNewCluster(msTimestamp: number) {
		if (this.currentCluster) {
			this.finalizeCurrentCluster();
		}

		if (this.format._options.onCluster) {
			this.writer.startTrackingWrites();
		}

		this.currentCluster = {
			id: EBMLId.Cluster,
			size: this.format._options.appendOnly ? -1 : CLUSTER_SIZE_BYTES,
			data: [
				{ id: EBMLId.Timestamp, data: msTimestamp },
			],
		};
		this.ebmlWriter.writeEBML(this.currentCluster);

		this.currentClusterStartMsTimestamp = msTimestamp;
		this.currentClusterMaxMsTimestamp = msTimestamp;
		this.trackDatasInCurrentCluster.clear();
	}

	private finalizeCurrentCluster() {
		assert(this.currentCluster);

		if (!this.format._options.appendOnly) {
			const clusterSize = this.writer.getPos() - this.ebmlWriter.dataOffsets.get(this.currentCluster)!;
			const endPos = this.writer.getPos();

			// Write the size now that we know it
			this.writer.seek(this.ebmlWriter.offsets.get(this.currentCluster)! + 4);
			this.ebmlWriter.writeVarInt(clusterSize, CLUSTER_SIZE_BYTES);
			this.writer.seek(endPos);
		}

		if (this.format._options.onCluster) {
			assert(this.currentClusterStartMsTimestamp !== null);

			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onCluster(data, start, this.currentClusterStartMsTimestamp / 1000);
		}

		const clusterOffsetFromSegment
			= this.ebmlWriter.offsets.get(this.currentCluster)! - this.segmentDataOffset;

		// Group tracks by their first timestamp and create a CuePoint for each unique timestamp
		const groupedByTimestamp = new Map<number, MatroskaTrackData[]>();
		for (const [trackData, { firstMsTimestamp }] of this.trackDatasInCurrentCluster) {
			if (!groupedByTimestamp.has(firstMsTimestamp)) {
				groupedByTimestamp.set(firstMsTimestamp, []);
			}
			groupedByTimestamp.get(firstMsTimestamp)!.push(trackData);
		}

		const groupedAndSortedByTimestamp = [...groupedByTimestamp.entries()].sort((a, b) => a[0] - b[0]);

		// Add CuePoints to the Cues element for better seeking
		for (const [msTimestamp, trackDatas] of groupedAndSortedByTimestamp) {
			assert(this.cues);
			(this.cues.data as EBML[]).push({ id: EBMLId.CuePoint, data: [
				{ id: EBMLId.CueTime, data: msTimestamp },
				// Create CueTrackPositions for each track that starts at this timestamp
				...trackDatas.map((trackData) => {
					return { id: EBMLId.CueTrackPositions, data: [
						{ id: EBMLId.CueTrack, data: trackData.track.id },
						{ id: EBMLId.CueClusterPosition, data: clusterOffsetFromSegment },
					] };
				}),
			] });
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose() {
		const release = await this.mutex.acquire();

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		// Since a track is now closed, we may be able to write out chunks that were previously waiting
		await this.interleaveChunks();

		release();
	}

	/** Finalizes the file, making it ready for use. Must be called after all media chunks have been added. */
	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		if (!this.segment) {
			this.createSegment();
		}

		// Flush any remaining queued chunks to the file
		await this.interleaveChunks(true);

		if (this.currentCluster) {
			this.finalizeCurrentCluster();
		}

		assert(this.cues);
		this.ebmlWriter.writeEBML(this.cues);

		if (!this.format._options.appendOnly) {
			const endPos = this.writer.getPos();

			// Write the Segment size
			const segmentSize = this.writer.getPos() - this.segmentDataOffset;
			this.writer.seek(this.ebmlWriter.offsets.get(this.segment!)! + 4);
			this.ebmlWriter.writeVarInt(segmentSize, SEGMENT_SIZE_BYTES);

			// Write the duration of the media to the Segment
			this.segmentDuration!.data = new EBMLFloat64(this.duration);
			this.writer.seek(this.ebmlWriter.offsets.get(this.segmentDuration!)!);
			this.ebmlWriter.writeEBML(this.segmentDuration);

			// Fill in SeekHead position data and write it again
			assert(this.seekHead);
			this.writer.seek(this.ebmlWriter.offsets.get(this.seekHead)!);
			this.maybeCreateSeekHead(true);
			this.ebmlWriter.writeEBML(this.seekHead);

			this.writer.seek(endPos);
		}

		release();
	}
}
