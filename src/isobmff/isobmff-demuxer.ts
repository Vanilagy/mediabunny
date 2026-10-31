/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from '../output';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc';
import {
	AacCodecInfo,
	AudioCodec,
	DTS_FOURCCS,
	DtsFourCc,
	extractAudioCodecString,
	extractColorSpace,
	extractVideoCodecString,
	MediaCodec,
	MJPEG_FOURCCS,
	OPUS_SAMPLE_RATE,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	PRORES_FOURCCS,
	ProresFourCc,
	VideoCodec,
} from '../codec';
import {
	Av1CodecInfo,
	av1CodecInfoHasColorInfo,
	AvcDecoderConfigurationRecord,
	extractAv1CodecInfoFromPacket,
	extractProresCodecInfoFromPacket,
	extractVp9CodecInfoFromPacket,
	FlacBlockType,
	HevcDecoderConfigurationRecord,
	ProresCodecInfo,
	Vp9CodecInfo,
	vp9CodecInfoHasColorInfo,
	parseEac3Config,
	getEac3SampleRate,
	getEac3ChannelCount,
	extractDtsFourCcFromPacket,
	parseDtsSpecificBox,
	DTS_SPECIFIC_BOX_SIZE,
	AC3_ACMOD_CHANNEL_COUNTS,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	HevcNalUnitType,
	parseAvcSps,
	parseHevcSps,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	binarySearchExact,
	binarySearchLessOrEqual,
	bytesToHexString,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	IDENTITY_MATRIX,
	isIso639Dash2LanguageCode,
	isThenable,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	multiplyMatrices,
	Rational,
	textDecoder,
	TransformationMatrix,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
	toDataView,
	roundIfAlmostInteger,
	hexStringToBytes,
	HEX_STRING_REGEX,
	EMPTY_COLOR_SPACE,
	colorSpaceIsComplete,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import {
	buildIsobmffMimeType,
	parsePsshBoxContents,
	psshBoxesAreEqual,
	PsshBox,
	TIMESTAMP_OFFSET,
} from './isobmff-misc';
import {
	MAX_BOX_HEADER_SIZE,
	MIN_BOX_HEADER_SIZE,
	readBoxHeader,
	readDataBox,
	readFixed_16_16,
	readFixed_2_30,
	readEsDescriptor,
	readMetadataStringShort,
} from './isobmff-reader';
import {
	FileSlice,
	readBytes,
	readF64Be,
	readI16Be,
	readI32Be,
	readI64Be,
	Reader,
	readU16Be,
	readU24Be,
	readU32Be,
	readU64Be,
	readU8,
	readAscii,
} from '../reader';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, RichImageData, TrackDisposition } from '../metadata';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';
import { Bitstream } from '../../shared/bitstream';
import { Aes128CbcContext } from '../aes';
import { Logging } from '../logging';

const TRUEHD_CHANNEL_ASSIGNMENT_COUNTS = [2, 1, 1, 2, 2, 2, 2, 1, 1, 2, 2, 1, 1];

type InternalTrack = {
	id: number;
	demuxer: IsobmffDemuxer;
	trackBacking: InputTrackBacking | null;
	disposition: TrackDisposition;
	timescale: number;
	durationInMovieTimescale: number;
	durationInMediaTimescale: number;
	matrix: TransformationMatrix;
	internalCodecId: string | null;
	name: string | null;
	languageCode: string;
	sampleTableByteOffset: number | null; // null when the track's sample table is another file (ominous ik 👀)
	sampleTable: SampleTable | null;
	fragmentLookupTable: FragmentLookupTableEntry[];
	currentFragmentState: FragmentTrackState | null;
	/**
	 * List of all encountered fragment offsets alongside their timestamps. This list never gets truncated, but memory
	 * consumption should be negligible.
	 */
	fragmentPositionCache: {
		moofOffset: number;
		startTimestamp: number;
		endTimestamp: number;
	}[];
	/** The segment durations of all edit list entries leading up to the main one (from which the offset is taken.) */
	editListPreviousSegmentDurations: number;
	/** The media time offset of the main edit list entry (with media time !== -1) */
	editListOffset: number;
	/** Set when the track's samples are encrypted using a supported scheme (cenc/cens/cbcs), parsed from sinf/tenc. */
	encryptionInfo: TrackEncryptionInfo | null;
	/** For non-fragmented encrypted tracks: parsed saiz+saio from stbl; aux info is fetched lazily on first use. */
	encryptionAuxInfo: SampleEncryptionAuxInfo | null;
	frmaCodecString: string | null;
	/** In bits per second, from the btrt box if present. */
	maxBitrate: number | null;
	avgBitrate: number | null;
} & ({
	info: null;
} | {
	info: {
		type: 'video';
		width: number;
		height: number;
		squarePixelWidth: number;
		squarePixelHeight: number;
		codec: VideoCodec | null;
		codecDescription: Uint8Array | null;
		colorSpace: VideoColorSpaceInit;
		avcType: 1 | 3 | null;
		avcCodecInfo: AvcDecoderConfigurationRecord | null;
		hevcCodecInfo: HevcDecoderConfigurationRecord | null;
		vp9CodecInfo: Vp9CodecInfo | null;
		av1CodecInfo: Av1CodecInfo | null;
		proresCodecInfo: ProresCodecInfo | null;
		proresFormat: ProresFourCc | null;
	};
} | {
	info: {
		type: 'audio';
		numberOfChannels: number;
		sampleRate: number;
		codec: AudioCodec | null;
		codecDescription: Uint8Array | null;
		aacCodecInfo: AacCodecInfo | null;
		dtsFormat: DtsFourCc | null;
		pcmLittleEndian: boolean;
		pcmSampleSize: number | null;
	};
});

type InternalVideoTrack = InternalTrack & {	info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & {	info: { type: 'audio' } };

type SampleTable = {
	sampleTimingEntries: SampleTimingEntry[];
	sampleCompositionTimeOffsets: SampleCompositionTimeOffsetEntry[];
	sampleSizes: number[];
	sampleCount: number;
	cumulativeSampleSizes: number[] | null; // At i, the summed size of all samples before sample i
	keySampleIndices: number[] | null; // Samples that are keyframes
	chunkOffsets: number[];
	sampleToChunk: SampleToChunkEntry[];
	sortedCompositionTimeOffsets: SampleCompositionTimeOffsetEntry[] | null; // Sorted by presentation timestamp
};
type SampleTimingEntry = {
	startIndex: number;
	startDecodeTimestamp: number;
	count: number;
	delta: number;
};
type SampleCompositionTimeOffsetEntry = {
	startIndex: number;
	count: number;
	offset: number;
	startTimestamp: number; // Of the first sample
	lastTimestamp: number; // Of the last sample
	maxLastTimestamp: number; // Over this and all entries before it in presentation order
};
type SampleToChunkEntry = {
	startSampleIndex: number;
	startChunkIndex: number;
	samplesPerChunk: number;
	sampleDescriptionIndex: number;
};

type FragmentTrackDefaults = {
	trackId: number;
	defaultSampleDescriptionIndex: number;
	defaultSampleDuration: number;
	defaultSampleSize: number;
	defaultSampleFlags: number;
};

type FragmentLookupTableEntry = {
	timestamp: number;
	moofOffset: number;
	trunNumber: number; // 1-indexed
	sampleNumber: number; // 1-indexed
};

type FragmentTrackState = {
	baseDataOffset: number;
	sampleDescriptionIndex: number | null;
	defaultSampleDuration: number | null;
	defaultSampleSize: number | null;
	defaultSampleFlags: number | null;
	startTimestamp: number | null;
	encryptionAuxInfo: SampleEncryptionAuxInfo | null;
};

type FragmentTrackData = {
	track: InternalTrack;

	// Kept as state for the presence of multiple trun boxes
	currentTimestamp: number;
	currentOffset: number;

	startTimestamp: number;
	endTimestamp: number;
	firstKeyFrameTimestamp: number | null;
	samples: FragmentTrackSample[];
	presentationTimestamps: {
		presentationTimestamp: number;
		sampleIndex: number;
	}[];
	startTimestampIsFinal: boolean;
	trunSampleCounts: number[];
	encryptionAuxInfo: SampleEncryptionAuxInfo | null;
};

type FragmentTrackSample = {
	presentationTimestamp: number;
	duration: number;
	byteOffset: number;
	byteSize: number;
	isKeyFrame: boolean;
	encryption: SampleEncryptionInfo | null;
};

type Fragment = {
	moofOffset: number;
	moofSize: number;
	implicitBaseDataOffset: number;
	trackData: Map<InternalTrack['id'], FragmentTrackData>;
	psshBoxes: PsshBox[];
	sampleCount: number;
};

type FragmentSummary = {
	moofSize: number;
	trackIds: Set<number>; // The tracks with samples in the fragment
};

type TrackEncryptionInfo = {
	scheme: 'cenc' | 'cens' | 'cbcs';
	defaultKid: string | null;
	defaultIsProtected: boolean | null;
	defaultPerSampleIvSize: number | null;
	defaultConstantIv: Uint8Array | null;
	defaultCryptByteBlock: number | null;
	defaultSkipByteBlock: number | null;
};

type SampleEncryptionInfo = {
	iv: Uint8Array;
	subsamples: {
		clearLen: number;
		protectedLen: number;
	}[] | null;
};

/**
 * Holds parsed saiz+saio state. The encryption info itself lives at a file offset and is fetched lazily.
 * For fragmented files this state is per-traf; for non-fragmented files it's per-track (on stbl).
 */
type SampleEncryptionAuxInfo = {
	defaultSampleInfoSize: number;
	sampleSizes: Uint8Array | null;
	sampleCount: number;
	offset: number | null; // Absolute file offset of the first sample's aux info
	resolved: SampleEncryptionInfo[] | null;
};

// Anything beyond this is malicious
const MAX_BOX_NESTING_DEPTH = 64;

export class IsobmffDemuxer extends Demuxer {
	reader: Reader;
	moovSlice: FileSlice | null = null;

	currentTrack: InternalTrack | null = null;
	tracks: InternalTrack[] = [];
	idToTrack = new Map<number, InternalTrack>();
	metadataPromise: Promise<void> | null = null;
	movieTimescale = -1;
	movieDurationInTimescale = -1;
	movieMatrix = IDENTITY_MATRIX;
	isQuickTime = false;
	metadataTags: MetadataTags = {};
	currentMetadataKeys: Map<number, string> | null = null;

	isFragmented = false;
	fragmentTrackDefaults = new Map<number, FragmentTrackDefaults>();
	psshBoxes: PsshBox[] = [];
	currentFragment: Fragment | null = null;
	isReadingTraf = false;
	/**
	 * Caches the last fragment that was read. Based on the assumption that there will be multiple reads to the
	 * same fragment in quick succession.
	 */
	lastReadFragment: Fragment | null = null;
	fragmentSummaries = new Map<number, FragmentSummary>(); // Keyed by moof offset

	decryptionKeyCache = new Map<string, Promise<Uint8Array>>();
	boxNestingDepth = 0;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async getTrackBackings() {
		await this.readMetadata();
		return this.tracks.map(track => track.trackBacking!);
	}

	override async getMimeType() {
		await this.readMetadata();

		const backings = await this.getTrackBackings();
		const codecStrings = await Promise.all(backings.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildIsobmffMimeType({
			isQuickTime: this.isQuickTime,
			hasVideo: this.tracks.some(x => x.info?.type === 'video'),
			hasAudio: this.tracks.some(x => x.info?.type === 'audio'),
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			let currentPos = 0;
			let lookForMfraBox = false;
			let foundMovieBoxes = false;

			while (true) {
				let slice = this.reader.requestSliceRange(currentPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
				if (isThenable(slice)) slice = await slice;
				if (!slice) break;

				const startPos = currentPos;
				const boxInfo = readBoxHeader(slice);
				if (!boxInfo) {
					break;
				}

				if ((boxInfo.name === 'ftyp' || boxInfo.name === 'styp') && slice.remainingLength >= 4) {
					const majorBrand = readAscii(slice, 4);
					this.isQuickTime = majorBrand === 'qt  ';
				} else if (boxInfo.name === 'moov') {
					// Found moov, load it

					let moovSlice = this.reader.requestSlice(slice.filePos, boxInfo.contentSize);
					if (isThenable(moovSlice)) moovSlice = await moovSlice;
					if (!moovSlice) break;

					this.moovSlice = moovSlice;
					this.readContiguousBoxes(this.moovSlice);

					if (this.movieTimescale === -1) {
						throw new Error('Invalid moov box: missing mvhd box.');
					}

					for (const track of this.tracks) {
						// Modify the edit list offset based on the previous segment durations. They are in different
						// timescales, so we first convert to seconds and then into the track timescale.
						const previousSegmentDurationsInSeconds
							= track.editListPreviousSegmentDurations / this.movieTimescale;
						track.editListOffset -= Math.round(previousSegmentDurationsInSeconds * track.timescale);
					}

					lookForMfraBox = this.isFragmented
						&& this.reader.fileSize !== null
						&& this.reader.fileSize > startPos + boxInfo.totalSize; // There's more after the moov box
					foundMovieBoxes = true;

					break;
				} else if (boxInfo.name === 'moof') {
					if (!this.input._initInput) {
						throw new Error(
							'"moof" box encountered with no "moov" box present; this file is likely a Segment as'
							+ ' described in ISO/IEC 14496-12 Section 8.16. A separate init file that contains a "moov"'
							+ ' box is required to read this file, please provide it using InputOptions.initInput.',
						);
					}

					await this.copyMetadataFromInitInput(this.input._initInput);

					lookForMfraBox = false; // No point in doing it for segment files
					foundMovieBoxes = true;

					break;
				}

				currentPos = startPos + boxInfo.totalSize;
			}

			if (!foundMovieBoxes && this.input._initInput) {
				// A segment file is allowed to hold zero fragments, in which case there's no moof box to key off of.
				// It's still a perfectly valid segment, so let's take the tracks from the init input.
				await this.copyMetadataFromInitInput(this.input._initInput);
			}

			if (lookForMfraBox) {
				assert(this.reader.fileSize !== null);

				// The last 4 bytes may contain the size of the mfra box at the end of the file
				let lastWordSlice = this.reader.requestSlice(this.reader.fileSize - 4, 4);
				if (isThenable(lastWordSlice)) lastWordSlice = await lastWordSlice;
				assert(lastWordSlice);

				const lastWord = readU32Be(lastWordSlice);
				const potentialMfraPos = this.reader.fileSize - lastWord;

				if (potentialMfraPos >= 0 && potentialMfraPos <= this.reader.fileSize - MAX_BOX_HEADER_SIZE) {
					let mfraHeaderSlice = this.reader.requestSliceRange(
						potentialMfraPos,
						MIN_BOX_HEADER_SIZE,
						MAX_BOX_HEADER_SIZE,
					);
					if (isThenable(mfraHeaderSlice)) mfraHeaderSlice = await mfraHeaderSlice;

					if (mfraHeaderSlice) {
						const boxInfo = readBoxHeader(mfraHeaderSlice);

						if (boxInfo && boxInfo.name === 'mfra') {
							// We found the mfra box, allowing for much better random access. Let's parse it.
							let mfraSlice = this.reader.requestSlice(mfraHeaderSlice.filePos, boxInfo.contentSize);
							if (isThenable(mfraSlice)) mfraSlice = await mfraSlice;

							if (mfraSlice) {
								this.readContiguousBoxes(mfraSlice);
							}
						}
					}
				}
			}

			for (const track of this.tracks) {
				// Sort by timestamp in case it's not naturally sorted, and remove multiple entries for the same time
				const table = track.fragmentLookupTable;
				table.sort((a, b) => a.timestamp - b.timestamp);

				let writeIndex = 0;
				for (const entry of table) {
					if (writeIndex === 0 || entry.timestamp !== table[writeIndex - 1]!.timestamp) {
						table[writeIndex++] = entry;
					}
				}
				table.length = writeIndex;
			}
		})();
	}

	private async copyMetadataFromInitInput(initInput: Input) {
		const initDemuxer = (await initInput._getDemuxer()) as IsobmffDemuxer;
		if (initDemuxer.constructor !== IsobmffDemuxer) {
			throw new Error('Init input must match the input\'s format.');
		}

		await initDemuxer.readMetadata();

		this.movieTimescale = initDemuxer.movieTimescale;
		this.movieDurationInTimescale = initDemuxer.movieDurationInTimescale;
		this.movieMatrix = initDemuxer.movieMatrix;
		this.metadataTags = initDemuxer.metadataTags;
		this.isFragmented = true;
		this.fragmentTrackDefaults = initDemuxer.fragmentTrackDefaults;
		this.psshBoxes = initDemuxer.psshBoxes;

		// Create tracks from the init input's tracks
		for (const foreignTrack of initDemuxer.tracks) {
			const track: InternalTrack = {
				id: foreignTrack.id,
				demuxer: this,
				trackBacking: null,
				disposition: foreignTrack.disposition,
				timescale: foreignTrack.timescale,
				durationInMediaTimescale: foreignTrack.durationInMediaTimescale,
				durationInMovieTimescale: foreignTrack.durationInMovieTimescale,
				matrix: foreignTrack.matrix,
				internalCodecId: foreignTrack.internalCodecId,
				name: foreignTrack.name,
				languageCode: foreignTrack.languageCode,
				sampleTableByteOffset: null,
				sampleTable: null,
				fragmentLookupTable: [],
				currentFragmentState: null,
				fragmentPositionCache: [],
				editListPreviousSegmentDurations: foreignTrack.editListPreviousSegmentDurations,
				editListOffset: foreignTrack.editListOffset,
				encryptionInfo: foreignTrack.encryptionInfo,
				encryptionAuxInfo: null,
				frmaCodecString: null,
				maxBitrate: foreignTrack.maxBitrate,
				avgBitrate: foreignTrack.avgBitrate,
				info: foreignTrack.info,
			};

			if (foreignTrack.trackBacking) {
				assert(track.info);

				if (track.info.type === 'video' && track.info.width !== -1) {
					const videoTrack = track as InternalVideoTrack;
					track.trackBacking = new IsobmffVideoTrackBacking(videoTrack);
					this.tracks.push(track);
					this.idToTrack.set(track.id, track);
				} else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
					const audioTrack = track as InternalAudioTrack;
					track.trackBacking = new IsobmffAudioTrackBacking(audioTrack);
					this.tracks.push(track);
					this.idToTrack.set(track.id, track);
				}
			} else {
				// The track didn't have enough info to warrant a backing
			}
		}
	}

	getSampleTableForTrack(internalTrack: InternalTrack) {
		if (internalTrack.sampleTable) {
			return internalTrack.sampleTable;
		}

		const sampleTable: SampleTable = {
			sampleTimingEntries: [],
			sampleCompositionTimeOffsets: [],
			sampleSizes: [],
			sampleCount: 0,
			cumulativeSampleSizes: null,
			keySampleIndices: null,
			chunkOffsets: [],
			sampleToChunk: [],
			sortedCompositionTimeOffsets: null,
		};
		internalTrack.sampleTable = sampleTable;

		if (internalTrack.sampleTableByteOffset === null) {
			// There's no sample table to read, it's in another file (happens with segments)
			return sampleTable;
		}

		assert(this.moovSlice);

		const stblContainerSlice = this.moovSlice.slice(internalTrack.sampleTableByteOffset);

		this.currentTrack = internalTrack;
		try {
			this.traverseBox(stblContainerSlice);
		} catch (error) {
			internalTrack.sampleTable = null;
			throw error;
		} finally {
			this.currentTrack = null;
		}

		const lastTimingEntry = last(sampleTable.sampleTimingEntries);
		const lastChunkEntryIndex = binarySearchLessOrEqual(
			sampleTable.sampleToChunk,
			sampleTable.chunkOffsets.length - 1,
			x => x.startChunkIndex,
		);
		const lastChunkEntry = sampleTable.sampleToChunk[lastChunkEntryIndex];

		// Clamp the sample count on the minimum of what all the subentries tell us
		sampleTable.sampleCount = Math.min(
			sampleTable.sampleCount,
			lastTimingEntry ? lastTimingEntry.startIndex + lastTimingEntry.count : 0,
			lastChunkEntry
				? lastChunkEntry.startSampleIndex
				+ (sampleTable.chunkOffsets.length - lastChunkEntry.startChunkIndex) * lastChunkEntry.samplesPerChunk
				: 0,
		);

		capEntryCounts(sampleTable.sampleTimingEntries, sampleTable.sampleCount);
		capEntryCounts(sampleTable.sampleCompositionTimeOffsets, sampleTable.sampleCount);

		const isPcmCodec = internalTrack.info?.type === 'audio'
			&& internalTrack.info.codec
			&& (PCM_AUDIO_CODECS as readonly string[]).includes(internalTrack.info.codec);

		if (
			isPcmCodec
			&& sampleTable.sampleCompositionTimeOffsets.length === 0
			&& sampleTable.sampleTimingEntries.length > 0
		) {
			// If the audio has PCM samples, the way the samples are defined in the sample table is somewhat
			// suboptimal: Each individual audio sample is its own sample, meaning we can have 48000 samples per second.
			// Because we treat each sample as its own atomic unit that can be decoded, this would lead to a huge
			// amount of very short samples for PCM audio. So instead, we make a transformation: If the audio is in PCM,
			// we say that each chunk (that normally holds many samples) now is one big sample. We can this because
			// the samples in the chunk are contiguous and the format is PCM, so the entire chunk as one thing still
			// encodes valid audio information.

			assert(internalTrack.info?.type === 'audio');
			const pcmInfo = parsePcmCodec(internalTrack.info.codec as PcmAudioCodec);

			const newSampleTimingEntries: SampleTimingEntry[] = [];
			const newSampleSizes: number[] = [];

			for (let i = 0; i < sampleTable.sampleToChunk.length; i++) {
				const chunkEntry = sampleTable.sampleToChunk[i]!;
				const nextEntry = sampleTable.sampleToChunk[i + 1];
				const chunkCount = Math.min(
					nextEntry ? nextEntry.startChunkIndex : Infinity,
					sampleTable.chunkOffsets.length,
				) - chunkEntry.startChunkIndex;
				const newStartSampleIndex = newSampleSizes.length;

				for (let j = 0; j < chunkCount; j++) {
					const startSampleIndex = chunkEntry.startSampleIndex + j * chunkEntry.samplesPerChunk;
					const endSampleIndex = startSampleIndex + chunkEntry.samplesPerChunk; // Exclusive, outside of chunk

					const startTimingEntryIndex = binarySearchLessOrEqual(
						sampleTable.sampleTimingEntries,
						startSampleIndex,
						x => x.startIndex,
					);
					const startTimingEntry = sampleTable.sampleTimingEntries[startTimingEntryIndex]!;
					const endTimingEntryIndex = binarySearchLessOrEqual(
						sampleTable.sampleTimingEntries,
						endSampleIndex,
						x => x.startIndex,
					);
					const endTimingEntry = sampleTable.sampleTimingEntries[endTimingEntryIndex]!;

					const firstSampleTimestamp = startTimingEntry.startDecodeTimestamp
						+ (startSampleIndex - startTimingEntry.startIndex) * startTimingEntry.delta;
					const lastSampleTimestamp = endTimingEntry.startDecodeTimestamp
						+ (endSampleIndex - endTimingEntry.startIndex) * endTimingEntry.delta;
					const delta = lastSampleTimestamp - firstSampleTimestamp;

					const lastSampleTimingEntry = last(newSampleTimingEntries);
					if (lastSampleTimingEntry && lastSampleTimingEntry.delta === delta) {
						lastSampleTimingEntry.count++;
					} else {
						// One sample for the entire chunk
						newSampleTimingEntries.push({
							startIndex: newSampleSizes.length,
							startDecodeTimestamp: firstSampleTimestamp,
							count: 1,
							delta,
						});
					}

					// Instead of determining the chunk's size by looping over the samples sizes in the sample table, we
					// can directly compute it as we know how many PCM frames are in this chunk, and the size of each
					// PCM frame. This also improves compatibility with some files which fail to write proper sample
					// size values into their sample tables in the PCM case.
					const chunkSize = chunkEntry.samplesPerChunk
						* pcmInfo.sampleSize
						* internalTrack.info.numberOfChannels;

					newSampleSizes.push(chunkSize);
				}

				// The new samples are numbered consecutively, even if the chunks don't start at the first one
				chunkEntry.startSampleIndex = newStartSampleIndex;
				chunkEntry.samplesPerChunk = 1;
			}

			sampleTable.sampleTimingEntries = newSampleTimingEntries;
			sampleTable.sampleSizes = newSampleSizes;
			sampleTable.sampleCount = newSampleSizes.length;
		}

		if (sampleTable.sampleCompositionTimeOffsets.length > 0) {
			// Presentation order differs from decode order. Let's prepare the offset entries for timestamped-keyed
			// random access later
			const entries = sampleTable.sampleCompositionTimeOffsets;
			const lastEntry = last(entries)!;
			const coveredSampleCount = lastEntry.startIndex + lastEntry.count;
			if (coveredSampleCount < sampleTable.sampleCount) {
				// The remaining samples have no offset
				entries.push({
					startIndex: coveredSampleCount,
					count: sampleTable.sampleCount - coveredSampleCount,
					offset: 0,
					startTimestamp: -1,
					lastTimestamp: -1,
					maxLastTimestamp: -1,
				});
			}

			const sortedEntries = entries.filter(entry => entry.count > 0);

			const timingEntries = sampleTable.sampleTimingEntries;
			let timingEntryIndex = 0;
			const getDecodeTimestampAhead = (sampleIndex: number) => {
				while (
					timingEntryIndex + 1 < timingEntries.length
					&& timingEntries[timingEntryIndex + 1]!.startIndex <= sampleIndex
				) {
					timingEntryIndex++;
				}

				const timingEntry = timingEntries[timingEntryIndex]!;
				return timingEntry.startDecodeTimestamp + (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
			};

			for (const entry of sortedEntries) {
				const lastSampleIndex = entry.startIndex + entry.count - 1;
				entry.startTimestamp = getDecodeTimestampAhead(entry.startIndex) + entry.offset;
				entry.lastTimestamp = getDecodeTimestampAhead(lastSampleIndex) + entry.offset;
			}

			sortedEntries.sort((a, b) => a.startTimestamp - b.startTimestamp || a.startIndex - b.startIndex);

			let maxLastTimestamp = -Infinity;
			for (const entry of sortedEntries) {
				maxLastTimestamp = Math.max(maxLastTimestamp, entry.lastTimestamp);
				entry.maxLastTimestamp = maxLastTimestamp;
			}

			sampleTable.sortedCompositionTimeOffsets = sortedEntries;
		} else {
			// If they're not defined, we can simply use the decode timestamps as presentation timestamps
		}

		if (sampleTable.sampleSizes.length > 1) {
			sampleTable.cumulativeSampleSizes = [0];

			for (let i = 0; i < sampleTable.sampleSizes.length; i++) {
				sampleTable.cumulativeSampleSizes.push(
					sampleTable.cumulativeSampleSizes[i]! + sampleTable.sampleSizes[i]!,
				);
			}
		}

		return sampleTable;
	}

	async readFragment(startPos: number): Promise<Fragment | null> {
		if (this.lastReadFragment?.moofOffset === startPos) {
			return this.lastReadFragment;
		}

		let headerSlice = this.reader.requestSliceRange(startPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
		if (isThenable(headerSlice)) headerSlice = await headerSlice;
		assert(headerSlice);

		const moofBoxInfo = readBoxHeader(headerSlice);
		assert(moofBoxInfo?.name === 'moof');

		let entireSlice = this.reader.requestSlice(startPos, moofBoxInfo.totalSize);
		if (isThenable(entireSlice)) entireSlice = await entireSlice;
		if (!entireSlice) return null; // The moof box is cut off

		this.traverseBox(entireSlice);

		const fragment = this.lastReadFragment;
		assert(fragment && fragment.moofOffset === startPos);

		this.fragmentSummaries.set(startPos, {
			moofSize: fragment.moofSize,
			trackIds: new Set(fragment.trackData.keys()),
		});

		for (const [, trackData] of fragment.trackData) {
			const track = trackData.track;
			const { fragmentPositionCache } = track;

			if (!trackData.startTimestampIsFinal) {
				// It may be that some tracks don't define the base decode time, i.e. when the fragment begins. This
				// we'll need to figure out the start timestamp another way. We'll compute the timestamp by accessing
				// the lookup entries and fragment cache, which works out nicely with the lookup algorithm: If these
				// exist, then the lookup will automatically start at the furthest possible point. If they don't, the
				// lookup starts sequentially from the start, incrementally summing up all fragment durations. It's sort
				// of implicit, but it ends up working nicely.

				// The table is sorted by timestamp, which for any sane file means it's also sorted by offset
				const lookupEntryIndex = binarySearchExact(
					track.fragmentLookupTable,
					fragment.moofOffset,
					x => x.moofOffset,
				);
				const lookupEntry = track.fragmentLookupTable[lookupEntryIndex];
				const lookupEntryIsValid = lookupEntry
					&& trackData.trunSampleCounts.length >= lookupEntry.trunNumber
					&& trackData.trunSampleCounts[lookupEntry.trunNumber - 1]! >= lookupEntry.sampleNumber;

				if (lookupEntryIsValid) {
					// We ignore traf number here, since we've already matched based on track ID

					let sampleIndex = 0;
					for (let i = 1; i < lookupEntry.trunNumber; i++) {
						sampleIndex += trackData.trunSampleCounts[i - 1]!;
					}

					sampleIndex += lookupEntry.sampleNumber - 1;
					const sample = trackData.samples[sampleIndex];
					assert(sample); // Must hold due to the above range checks

					// The timestamp in the lookup entry describes the timestamp of the referenced sample
					const timestampOffset = lookupEntry.timestamp - sample.presentationTimestamp;
					offsetFragmentTrackDataByTimestamp(trackData, timestampOffset);
				} else {
					const lastCacheIndex = binarySearchLessOrEqual(
						fragmentPositionCache,
						fragment.moofOffset - 1,
						x => x.moofOffset,
					);
					if (lastCacheIndex !== -1) {
						// Let's use the end timestamp of the previous fragment in the cache
						const lastCache = fragmentPositionCache[lastCacheIndex]!;
						offsetFragmentTrackDataByTimestamp(trackData, lastCache.endTimestamp);
					} else {
						// We're the first fragment I guess, "offset by 0"
					}
				}

				trackData.startTimestampIsFinal = true;
			}

			// Let's remember that a fragment with a given timestamp is here, speeding up future lookups if no
			// lookup table exists
			const insertionIndex = binarySearchLessOrEqual(
				fragmentPositionCache,
				trackData.startTimestamp,
				x => x.startTimestamp,
			);
			const previousEntry = fragmentPositionCache[insertionIndex];
			const nextEntry = fragmentPositionCache[insertionIndex + 1];

			// Only remember it if the timestamp order matches the moof offset order
			if (
				(!previousEntry || previousEntry.moofOffset < fragment.moofOffset)
				&& (!nextEntry || nextEntry.moofOffset > fragment.moofOffset)
			) {
				fragmentPositionCache.splice(insertionIndex + 1, 0, {
					moofOffset: fragment.moofOffset,
					startTimestamp: trackData.startTimestamp,
					endTimestamp: trackData.endTimestamp,
				});
			}

			// If senc wasn't parsed but saiz+saio were, fetch the aux info now and stamp each sample with it
			if (trackData.encryptionAuxInfo && track.encryptionInfo) {
				const entries = await resolveEncryptionAuxInfo(
					this.reader,
					track.encryptionInfo,
					trackData.encryptionAuxInfo,
				);

				for (let i = 0; i < Math.min(trackData.samples.length, entries.length); i++) {
					const entry = entries[i]!;
					trackData.samples[i]!.encryption = entry;
				}
			}
		}

		return fragment;
	}

	readContiguousBoxes(slice: FileSlice) {
		if (this.boxNestingDepth === MAX_BOX_NESTING_DEPTH) {
			throw new Error('Invalid file: boxes are nested too deeply.');
		}

		const startIndex = slice.filePos;
		this.boxNestingDepth++;

		try {
			while (slice.filePos - startIndex <= slice.length - MIN_BOX_HEADER_SIZE) {
				const foundBox = this.traverseBox(slice);

				if (!foundBox) {
					break;
				}
			}
		} finally {
			this.boxNestingDepth--;
		}
	}

	// eslint-disable-next-line @stylistic/generator-star-spacing
	*iterateContiguousBoxes(slice: FileSlice) {
		const startIndex = slice.filePos;

		while (slice.filePos - startIndex <= slice.length - MIN_BOX_HEADER_SIZE) {
			const startPos = slice.filePos;
			const boxInfo = readBoxHeader(slice);
			if (!boxInfo) {
				break;
			}

			yield { boxInfo, slice };
			slice.filePos = startPos + boxInfo.totalSize;
		}
	}

	traverseBox(slice: FileSlice): boolean {
		const startPos = slice.filePos;
		const boxInfo = readBoxHeader(slice);
		if (!boxInfo) {
			return false;
		}

		const contentStartPos = slice.filePos;
		const boxEndPos = startPos + boxInfo.totalSize;

		switch (boxInfo.name) {
			case 'mdia':
			case 'minf':
			case 'dinf':
			case 'mfra':
			case 'edts':
			case 'sinf':
			case 'schi': {
				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'mvhd': {
				const version = readU8(slice);
				slice.skip(3); // Flags

				let creationTime: number;
				if (version === 1) {
					creationTime = readU64Be(slice);
					slice.skip(8); // Modification time
					this.movieTimescale = readU32Be(slice);
					this.movieDurationInTimescale = readU64Be(slice);
				} else {
					creationTime = readU32Be(slice);
					slice.skip(4); // Modification time
					this.movieTimescale = readU32Be(slice);
					this.movieDurationInTimescale = readU32Be(slice);
				}

				if (creationTime !== 0) {
					this.metadataTags.creationTime = new Date(1000 * (creationTime - TIMESTAMP_OFFSET));
				} else {
					// Assume this means the creation time isn't set (I doubt the file was created in 1904)
				}

				if (this.movieTimescale === 0) {
					throw new Error('Invalid mvhd box: timescale must not be 0.');
				}

				slice.skip(4 + 2 + 2 + 2 * 4); // Rate, volume, reserved
				this.movieMatrix = readMatrix(slice);
			}; break;

			case 'trak': {
				if (this.currentFragment || this.currentTrack) {
					break; // Misplaced
				}

				const track = {
					id: -1,
					demuxer: this,
					trackBacking: null,
					disposition: {
						...DEFAULT_TRACK_DISPOSITION,
						primary: false,
					},
					info: null,
					timescale: -1,
					durationInMovieTimescale: -1,
					durationInMediaTimescale: -1,
					matrix: IDENTITY_MATRIX,
					internalCodecId: null,
					name: null,
					languageCode: UNDETERMINED_LANGUAGE,
					sampleTableByteOffset: -1,
					sampleTable: null,
					fragmentLookupTable: [],
					currentFragmentState: null,
					fragmentPositionCache: [],
					editListPreviousSegmentDurations: 0,
					editListOffset: 0,
					encryptionInfo: null,
					encryptionAuxInfo: null,
					frmaCodecString: null,
					maxBitrate: null,
					avgBitrate: null,
				} satisfies InternalTrack as InternalTrack;
				this.currentTrack = track;

				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));

				if (
					track.id !== -1
					&& track.timescale !== -1
					&& track.info !== null
					&& track.sampleTableByteOffset !== -1
				) {
					if (track.info.type === 'video' && track.info.width !== -1) {
						const videoTrack = track as InternalVideoTrack;
						track.trackBacking = new IsobmffVideoTrackBacking(videoTrack);
						this.tracks.push(track);
						this.idToTrack.set(track.id, track);
					} else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
						const audioTrack = track as InternalAudioTrack;
						track.trackBacking = new IsobmffAudioTrackBacking(audioTrack);
						this.tracks.push(track);
						this.idToTrack.set(track.id, track);
					}
				}

				this.currentTrack = null;
			}; break;

			case 'tkhd': {
				const track = this.currentTrack;
				if (!track || this.currentFragment) {
					break;
				}

				const version = readU8(slice);
				const flags = readU24Be(slice);

				// Spec says disabled tracks are to be treated like they don't exist, but in practice, they are treated
				// more like non-default tracks.
				const trackEnabled = !!(flags & 0x1);
				track.disposition.default = trackEnabled;

				// Skip over creation & modification time to reach the track ID
				if (version === 0) {
					slice.skip(8);
					track.id = readU32Be(slice);
					slice.skip(4);
					track.durationInMovieTimescale = readU32Be(slice);
				} else if (version === 1) {
					slice.skip(16);
					track.id = readU32Be(slice);
					slice.skip(4);
					track.durationInMovieTimescale = readU64Be(slice);
				} else {
					throw new Error(`Incorrect track header version ${version}.`);
				}

				slice.skip(2 * 4 + 2 + 2 + 2 + 2);
				const trackMatrix = readMatrix(slice);

				// The track matrix maps into movie space, and the movie matrix then maps into the final output space
				track.matrix = multiplyMatrices(trackMatrix, this.movieMatrix);
			}; break;

			case 'elst': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags

				let relevantEntryFound = false;
				let previousSegmentDurations = 0;

				const entryCount = readU32Be(slice);
				for (let i = 0; i < entryCount; i++) {
					const segmentDuration = version === 1
						? readU64Be(slice)
						: readU32Be(slice);
					const mediaTime = version === 1
						? readI64Be(slice)
						: readI32Be(slice);
					const mediaRate = readFixed_16_16(slice);

					if (relevantEntryFound) {
						Logging._warn(
							'Unsupported edit list: multiple edits are not currently supported. Only using first edit.',
						);
						break;
					}

					if (mediaTime === -1) {
						previousSegmentDurations += segmentDuration;
						continue;
					}

					if (mediaRate !== 1) {
						Logging._warn('Unsupported edit list entry: media rate must be 1.');
						break;
					}

					track.editListPreviousSegmentDurations = previousSegmentDurations;
					track.editListOffset = mediaTime;
					relevantEntryFound = true;
				}
			}; break;

			case 'mdhd': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags

				if (version === 0) {
					slice.skip(8);
					track.timescale = readU32Be(slice);
					track.durationInMediaTimescale = readU32Be(slice);
				} else if (version === 1) {
					slice.skip(16);
					track.timescale = readU32Be(slice);
					track.durationInMediaTimescale = readU64Be(slice);
				}

				if (track.timescale === 0) {
					throw new Error('Invalid mdhd box: timescale must not be 0.');
				}

				let language = readU16Be(slice);

				if (language > 0) {
					track.languageCode = '';

					for (let i = 0; i < 3; i++) {
						track.languageCode = String.fromCharCode(0x60 + (language & 0b11111)) + track.languageCode;
						language >>= 5;
					}

					if (!isIso639Dash2LanguageCode(track.languageCode)) {
						// Sometimes the bytes are garbage
						track.languageCode = UNDETERMINED_LANGUAGE;
					}
				}
			}; break;

			case 'hdlr': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				slice.skip(8); // Version + flags + pre-defined
				const handlerType = readAscii(slice, 4);

				if (handlerType === 'vide') {
					track.info = {
						type: 'video',
						width: -1,
						height: -1,
						squarePixelWidth: -1,
						squarePixelHeight: -1,
						codec: null,
						codecDescription: null,
						colorSpace: { ...EMPTY_COLOR_SPACE },
						avcType: null,
						avcCodecInfo: null,
						hevcCodecInfo: null,
						vp9CodecInfo: null,
						av1CodecInfo: null,
						proresCodecInfo: null,
						proresFormat: null,
					};
				} else if (handlerType === 'soun') {
					track.info = {
						type: 'audio',
						numberOfChannels: -1,
						sampleRate: -1,
						codec: null,
						codecDescription: null,
						aacCodecInfo: null,
						dtsFormat: null,
						pcmLittleEndian: false,
						pcmSampleSize: null,
					};
				}
			}; break;

			case 'stbl': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				track.sampleTableByteOffset = startPos;

				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'stsd': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (track.info === null || track.sampleTable) {
					break;
				}

				const stsdVersion = readU8(slice);
				slice.skip(3); // Flags

				const entries = readU32Be(slice);

				for (let i = 0; i < entries; i++) {
					const sampleBoxStartPos = slice.filePos;
					const sampleBoxInfo = readBoxHeader(slice);
					if (!sampleBoxInfo) {
						break;
					}

					track.internalCodecId = sampleBoxInfo.name;
					const lowercaseBoxName = sampleBoxInfo.name.toLowerCase();

					if (track.info.type === 'video') {
						slice.skip(6 * 1 + 2 + 2 + 2 + 3 * 4);

						track.info.width = readU16Be(slice);
						track.info.height = readU16Be(slice);
						track.info.squarePixelWidth = track.info.width;
						track.info.squarePixelHeight = track.info.height;

						slice.skip(4 + 4 + 4 + 2 + 32 + 2 + 2);

						track.frmaCodecString = null;
						this.readContiguousBoxes(
							slice.slice(
								slice.filePos,
								(sampleBoxStartPos + sampleBoxInfo.totalSize) - slice.filePos,
							),
						);

						const codecName = lowercaseBoxName === 'encv'
							? track.frmaCodecString
							: lowercaseBoxName;
						track.frmaCodecString = null;

						if (codecName === 'mp4v') {
							// The codec is set by the esds box.
						} else if (codecName === 'avc1' || codecName === 'avc3') {
							track.info.codec = 'avc';
							track.info.avcType = codecName === 'avc1' ? 1 : 3;
						} else if (codecName === 'hvc1' || codecName === 'hev1') {
							track.info.codec = 'hevc';
						} else if (codecName === 'vp08') {
							track.info.codec = 'vp8';
						} else if (codecName === 'vp09') {
							track.info.codec = 'vp9';
						} else if (codecName === 'av01') {
							track.info.codec = 'av1';
						} else if ((MJPEG_FOURCCS as readonly string[]).includes(lowercaseBoxName)) {
							track.info.codec = 'mjpeg';
						} else if ((PRORES_FOURCCS as readonly string[]).includes(lowercaseBoxName)) {
							track.info.codec = 'prores';
							track.info.proresFormat = lowercaseBoxName as ProresFourCc;
						} else if (codecName === null) {
							Logging._warn(`Unknown encrypted video codec due to missing frma box.`);
						} else {
							Logging._warn(`Unsupported video codec (sample entry type '${sampleBoxInfo.name}').`);
						}
					} else {
						slice.skip(6 * 1 + 2);

						const version = readU16Be(slice);
						slice.skip(3 * 2);

						let channelCount = readU16Be(slice);
						let sampleSize = readU16Be(slice);

						slice.skip(2 * 2);

						// Can't use fixed16_16 as that's signed
						let sampleRate = readU32Be(slice) / 0x10000;
						let lpcmFlags: number | null = null;

						if (stsdVersion === 0 && version > 0) {
							// Additional QuickTime fields
							if (version === 1) {
								slice.skip(4);
								sampleSize = 8 * readU32Be(slice);
								slice.skip(2 * 4);
							} else if (version === 2) {
								slice.skip(4);
								sampleRate = readF64Be(slice);
								channelCount = readU32Be(slice);
								slice.skip(4); // Always 0x7f000000

								sampleSize = readU32Be(slice);

								lpcmFlags = readU32Be(slice);

								slice.skip(2 * 4);
							}
						}

						track.info.numberOfChannels = channelCount;
						track.info.sampleRate = sampleRate;

						track.frmaCodecString = null;
						this.readContiguousBoxes(
							slice.slice(
								slice.filePos,
								(sampleBoxStartPos + sampleBoxInfo.totalSize) - slice.filePos,
							),
						);

						const codecName = lowercaseBoxName === 'enca'
							? track.frmaCodecString
							: lowercaseBoxName;
						track.frmaCodecString = null;

						// developer.apple.com/documentation/quicktime-file-format/sound_sample_descriptions/
						if (codecName === 'mp4a') {
							// The codec is set by the esds box
						} else if (codecName === 'opus') {
							track.info.codec = 'opus';
							track.info.sampleRate = OPUS_SAMPLE_RATE; // Always the same
						} else if (codecName === 'flac') {
							track.info.codec = 'flac';
						} else if (codecName === 'ulaw') {
							track.info.codec = 'ulaw';
						} else if (codecName === 'alaw') {
							track.info.codec = 'alaw';
						} else if (codecName === 'ac-3') {
							track.info.codec = 'ac3';
						} else if (codecName === 'ec-3') {
							track.info.codec = 'eac3';
						} else if ((DTS_FOURCCS as readonly string[]).includes(codecName!)) {
							track.info.codec = 'dts';
							track.info.dtsFormat = codecName as DtsFourCc;
						} else if (codecName === 'mlpa') {
							track.info.codec = 'truehd';
						} else if (codecName === 'twos') {
							if (sampleSize === 8) {
								track.info.codec = 'pcm-s8';
							} else if (sampleSize === 16) {
								track.info.codec = track.info.pcmLittleEndian ? 'pcm-s16' : 'pcm-s16be';
							} else {
								Logging._warn(`Unsupported sample size ${sampleSize} for codec 'twos'.`);
								track.info.codec = null;
							}
						} else if (codecName === 'sowt') {
							if (sampleSize === 8) {
								track.info.codec = 'pcm-s8';
							} else if (sampleSize === 16) {
								track.info.codec = 'pcm-s16';
							} else {
								Logging._warn(`Unsupported sample size ${sampleSize} for codec 'sowt'.`);
								track.info.codec = null;
							}
						} else if (codecName === 'raw ') {
							track.info.codec = 'pcm-u8';
						} else if (codecName === 'in24') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-s24' : 'pcm-s24be';
						} else if (codecName === 'in32') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-s32' : 'pcm-s32be';
						} else if (codecName === 'fl32') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-f32' : 'pcm-f32be';
						} else if (codecName === 'fl64') {
							track.info.codec = track.info.pcmLittleEndian ? 'pcm-f64' : 'pcm-f64be';
						} else if (codecName === 'ipcm') {
							const pcmSampleSize = track.info.pcmSampleSize;

							if (track.info.pcmLittleEndian) {
								if (pcmSampleSize === 16) {
									track.info.codec = 'pcm-s16';
								} else if (pcmSampleSize === 24) {
									track.info.codec = 'pcm-s24';
								} else if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-s32';
								} else {
									Logging._warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							} else {
								if (pcmSampleSize === 16) {
									track.info.codec = 'pcm-s16be';
								} else if (pcmSampleSize === 24) {
									track.info.codec = 'pcm-s24be';
								} else if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-s32be';
								} else {
									Logging._warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							}
						} else if (codecName === 'fpcm') {
							const pcmSampleSize = track.info.pcmSampleSize;

							if (track.info.pcmLittleEndian) {
								if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-f32';
								} else if (pcmSampleSize === 64) {
									track.info.codec = 'pcm-f64';
								} else {
									Logging._warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							} else {
								if (pcmSampleSize === 32) {
									track.info.codec = 'pcm-f32be';
								} else if (pcmSampleSize === 64) {
									track.info.codec = 'pcm-f64be';
								} else {
									Logging._warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
									track.info.codec = null;
								}
							}
						} else if (codecName === 'lpcm' && lpcmFlags !== null) {
							const bytesPerSample = (sampleSize + 7) >> 3;
							const isFloat = Boolean(lpcmFlags & 1);
							const isBigEndian = Boolean(lpcmFlags & 2);
							const sFlags = lpcmFlags & 4 ? -1 : 0; // I guess it means "signed flags" or something?

							if (sampleSize > 0 && sampleSize <= 64) {
								if (isFloat) {
									if (sampleSize === 32) {
										track.info.codec = isBigEndian ? 'pcm-f32be' : 'pcm-f32';
									}
								} else {
									if (sFlags & (1 << (bytesPerSample - 1))) {
										if (bytesPerSample === 1) {
											track.info.codec = 'pcm-s8';
										} else if (bytesPerSample === 2) {
											track.info.codec = isBigEndian ? 'pcm-s16be' : 'pcm-s16';
										} else if (bytesPerSample === 3) {
											track.info.codec = isBigEndian ? 'pcm-s24be' : 'pcm-s24';
										} else if (bytesPerSample === 4) {
											track.info.codec = isBigEndian ? 'pcm-s32be' : 'pcm-s32';
										}
									} else {
										if (bytesPerSample === 1) {
											track.info.codec = 'pcm-u8';
										}
									}
								}
							}

							if (track.info.codec === null) {
								Logging._warn('Unsupported PCM format.');
							}
						} else if (codecName === null) {
							Logging._warn(`Unknown encrypted audio codec due to missing frma box.`);
						} else {
							Logging._warn(`Unsupported audio codec (sample entry type '${sampleBoxInfo.name}').`);
						}
					}

					slice.filePos = sampleBoxStartPos + sampleBoxInfo.totalSize;
				}
			}; break;

			case 'frma': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				const format = readAscii(slice, 4);
				const lowercase = format.toLowerCase();

				// Tells us what codec the encrypted track actually uses
				track.frmaCodecString = lowercase;
			}; break;

			case 'schm': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				slice.skip(4); // Version + flags

				const schemeType = readAscii(slice, 4);
				if (schemeType === 'cenc' || schemeType === 'cens' || schemeType === 'cbcs') {
					track.encryptionInfo = {
						scheme: schemeType,
						defaultKid: null,
						defaultIsProtected: null,
						defaultPerSampleIvSize: null,
						defaultConstantIv: null,
						defaultCryptByteBlock: null,
						defaultSkipByteBlock: null,
					};
				} else {
					Logging._warn(`Unsupported encryption scheme '${schemeType}'.`);
				}
			}; break;

			case 'tenc': {
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags
				slice.skip(1); // Reserved

				const patternByte = readU8(slice);
				if (version > 0) {
					track.encryptionInfo.defaultCryptByteBlock = patternByte >> 4;
					track.encryptionInfo.defaultSkipByteBlock = patternByte & 0xf;
				} else {
					track.encryptionInfo.defaultCryptByteBlock = 0;
					track.encryptionInfo.defaultSkipByteBlock = 0;
				}

				track.encryptionInfo.defaultIsProtected = readU8(slice) !== 0;
				track.encryptionInfo.defaultPerSampleIvSize = readU8(slice);
				track.encryptionInfo.defaultKid = bytesToHexString(readBytes(slice, 16));

				if (track.encryptionInfo.defaultPerSampleIvSize > 16) {
					throw new Error('Invalid tenc box: IV size must not exceed 16 bytes.');
				}

				if (track.encryptionInfo.defaultIsProtected && track.encryptionInfo.defaultPerSampleIvSize === 0) {
					const constantIvSize = readU8(slice);
					if (constantIvSize > 16) {
						throw new Error('Invalid tenc box: IV size must not exceed 16 bytes.');
					}

					const constantIv = new Uint8Array(16);
					constantIv.set(readBytes(slice, constantIvSize), 0);
					track.encryptionInfo.defaultConstantIv = constantIv;
				}
			}; break;

			case 'avcC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				if (boxInfo.contentSize === 0) {
					// avcC box is empty, let's treat this like an Annex B stream
					break;
				}

				track.info.codecDescription = readBytes(slice, boxInfo.contentSize);

				const sps = deserializeAvcDecoderConfigurationRecord(track.info.codecDescription)
					?.sequenceParameterSets[0];
				const spsInfo = sps && parseAvcSps(sps);
				if (spsInfo) {
					applySpsPixelAspectRatio(track, spsInfo.pixelAspectRatio);
				}
			}; break;

			case 'hvcC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				if (boxInfo.contentSize === 0) {
					// hvcC box is empty, let's treat this like an Annex B stream
					break;
				}

				track.info.codecDescription = readBytes(slice, boxInfo.contentSize);

				const sps = deserializeHevcDecoderConfigurationRecord(track.info.codecDescription)
					?.arrays.find(x => x.nalUnitType === HevcNalUnitType.SPS_NUT)?.nalUnits[0];
				const spsInfo = sps && parseHevcSps(sps);
				if (spsInfo) {
					applySpsPixelAspectRatio(track, spsInfo.pixelAspectRatio);
				}
			}; break;

			case 'vpcC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				slice.skip(4); // Version + flags

				const profile = readU8(slice);
				const level = readU8(slice);
				const thirdByte = readU8(slice);
				const bitDepth = thirdByte >> 4;
				const chromaSubsampling = (thirdByte >> 1) & 0b111;
				const videoFullRangeFlag = thirdByte & 1;
				const colourPrimaries = readU8(slice);
				const transferCharacteristics = readU8(slice);
				const matrixCoefficients = readU8(slice);

				track.info.vp9CodecInfo = {
					profile,
					level,
					bitDepth,
					chromaSubsampling,
					videoFullRangeFlag,
					colourPrimaries,
					transferCharacteristics,
					matrixCoefficients,
				};
			}; break;

			case 'av1C': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				slice.skip(1); // Marker + version

				const secondByte = readU8(slice);
				const profile = secondByte >> 5;
				const level = secondByte & 0b11111;

				const thirdByte = readU8(slice);
				const tier = thirdByte >> 7;
				const highBitDepth = (thirdByte >> 6) & 1;
				const twelveBit = (thirdByte >> 5) & 1;
				const monochrome = (thirdByte >> 4) & 1;
				const chromaSubsamplingX = (thirdByte >> 3) & 1;
				const chromaSubsamplingY = (thirdByte >> 2) & 1;
				const chromaSamplePosition = thirdByte & 0b11;

				// Logic from https://aomediacodec.github.io/av1-spec/av1-spec.pdf
				const bitDepth = profile === 2 && highBitDepth ? (twelveBit ? 12 : 10) : (highBitDepth ? 10 : 8);

				slice.skip(1); // Reserved bits + initial presentation delay

				// Parse config OBUs if there are any
				const configObus = readBytes(slice, boxInfo.contentSize - 4);
				const configObuInfo = extractAv1CodecInfoFromPacket(configObus);

				track.info.av1CodecInfo = {
					profile,
					level,
					tier,
					bitDepth,
					monochrome,
					chromaSubsamplingX,
					chromaSubsamplingY,
					chromaSamplePosition,
					videoFullRangeFlag: configObuInfo?.videoFullRangeFlag ?? 0,
					colourPrimaries: configObuInfo?.colourPrimaries ?? 2,
					transferCharacteristics: configObuInfo?.transferCharacteristics ?? 2,
					matrixCoefficients: configObuInfo?.matrixCoefficients ?? 2,
				};
			}; break;

			case 'colr': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				const colourType = readAscii(slice, 4);
				if (colourType !== 'nclx' && colourType !== 'nclc') {
					break;
				}

				const colourPrimaries = readU16Be(slice);
				const transferCharacteristics = readU16Be(slice);
				const matrixCoefficients = readU16Be(slice);

				let fullRange: boolean | undefined = undefined;
				if (colourType === 'nclx') {
					fullRange = Boolean(readU8(slice) & 0x80);
				}

				track.info.colorSpace = {
					primaries: COLOR_PRIMARIES_MAP_INVERSE[colourPrimaries],
					transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics],
					matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients],
					fullRange,
				} as VideoColorSpaceInit;
			}; break;

			case 'pasp': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'video') {
					break;
				}

				const num = readU32Be(slice);
				const den = readU32Be(slice);

				// https://github.com/Vanilagy/mediabunny/issues/362
				if (num > 0 && den > 0) {
					// The ratio may already be set by the SPS, but the pasp box wins
					track.info.squarePixelWidth = track.info.width;
					track.info.squarePixelHeight = track.info.height;

					if (num > den) {
						track.info.squarePixelWidth = Math.round(track.info.width * num / den);
					} else {
						track.info.squarePixelHeight = Math.round(track.info.height * den / num);
					}
				}
			}; break;

			case 'btrt': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				slice.skip(4); // Buffer size
				const maxBitrate = readU32Be(slice);
				const avgBitrate = readU32Be(slice);

				track.maxBitrate = maxBitrate > 0 ? maxBitrate : null;
				track.avgBitrate = avgBitrate > 0 ? avgBitrate : null;
			}; break;

			case 'wave': {
				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'esds': {
				const track = this.currentTrack;
				if (!track || !track.info) {
					break;
				}

				slice.skip(4); // Version + flags

				const { objectTypeIndication, decoderSpecificInfo } =
					readEsDescriptor(slice);
				if (track.info.type === 'audio') {
					if (objectTypeIndication === 0x40 || objectTypeIndication === 0x67) {
						track.info.codec = 'aac';
						track.info.aacCodecInfo = {
							isMpeg2: objectTypeIndication === 0x67,
							objectType: null,
						};
					} else if (objectTypeIndication === 0x69 || objectTypeIndication === 0x6b) {
						track.info.codec = 'mp3';
					} else if (objectTypeIndication === 0xdd) {
						track.info.codec = 'vorbis'; // "nonstandard, gpac uses it" - FFmpeg
					} else if (objectTypeIndication === 0xa9) {
						track.info.codec = 'dts';
					} else {
						Logging._warn(
							`Unsupported audio codec (objectTypeIndication ${
								objectTypeIndication
							}) - discarding track.`,
						);
					}
				} else if (track.info.type === 'video') {
					if (objectTypeIndication === 0x6c) {
						track.info.codec = 'mjpeg';
					} else {
						Logging._warn(`Unsupported video codec (objectTypeIndication ${objectTypeIndication}).`);
					}
					break;
				}

				if (decoderSpecificInfo) {
					track.info.codecDescription = decoderSpecificInfo;

					if (track.info.codec === 'aac') {
						// Let's try to deduce more accurate values directly from the AudioSpecificConfig:
						const audioSpecificConfig = parseAacAudioSpecificConfig(track.info.codecDescription);
						if (audioSpecificConfig.outputNumberOfChannels !== null) {
							track.info.numberOfChannels = audioSpecificConfig.outputNumberOfChannels;
						}
						if (audioSpecificConfig.outputSampleRate !== null) {
							track.info.sampleRate = audioSpecificConfig.outputSampleRate;
						}
					}
				}
			}; break;

			case 'enda': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				track.info.pcmLittleEndian = !!(readU16Be(slice) & 0xff); // 0xff is from FFmpeg
			}; break;

			case 'pcmC': {
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(1 + 3); // Version + flags

				// ISO/IEC 23003-5

				const formatFlags = readU8(slice);
				track.info.pcmLittleEndian = Boolean(formatFlags & 0x01);
				track.info.pcmSampleSize = readU8(slice);
			}; break;

			case 'dOps': { // Used for Opus audio
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(1); // Version

				// https://www.opus-codec.org/docs/opus_in_isobmff.html
				const outputChannelCount = readU8(slice);
				const preSkip = readU16Be(slice);
				const inputSampleRate = readU32Be(slice);
				const outputGain = readI16Be(slice);
				const channelMappingFamily = readU8(slice);

				let channelMappingTable: Uint8Array;
				if (channelMappingFamily !== 0) {
					channelMappingTable = readBytes(slice, 2 + outputChannelCount);
				} else {
					channelMappingTable = new Uint8Array(0);
				}

				// https://datatracker.ietf.org/doc/html/draft-ietf-codec-oggopus-06
				const description = new Uint8Array(8 + 1 + 1 + 2 + 4 + 2 + 1 + channelMappingTable.byteLength);
				const view = new DataView(description.buffer);
				view.setUint32(0, 0x4f707573, false); // 'Opus'
				view.setUint32(4, 0x48656164, false); // 'Head'
				view.setUint8(8, 1); // Version
				view.setUint8(9, outputChannelCount);
				view.setUint16(10, preSkip, true);
				view.setUint32(12, inputSampleRate, true);
				view.setInt16(16, outputGain, true);
				view.setUint8(18, channelMappingFamily);
				description.set(channelMappingTable, 19);

				track.info.codecDescription = description;
				track.info.numberOfChannels = outputChannelCount;
				// Don't copy the input sample rate, irrelevant, and output sample rate is fixed
			}; break;

			case 'dfLa': { // Used for FLAC audio
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				slice.skip(4); // Version + flags

				// https://datatracker.ietf.org/doc/rfc9639/

				const BLOCK_TYPE_MASK = 0x7f;
				const LAST_METADATA_BLOCK_FLAG_MASK = 0x80;

				const startPos = slice.filePos;

				while (slice.filePos < boxEndPos) {
					const flagAndType = readU8(slice);
					const metadataBlockLength = readU24Be(slice);
					const type = flagAndType & BLOCK_TYPE_MASK;

					// It's a STREAMINFO block; let's extract the actual sample rate and channel count
					if (type === FlacBlockType.STREAMINFO) {
						slice.skip(10);

						// Extract sample rate and channel count
						const word = readU32Be(slice);
						const sampleRate = word >>> 12;
						const numberOfChannels = ((word >> 9) & 0b111) + 1;

						track.info.sampleRate = sampleRate;
						track.info.numberOfChannels = numberOfChannels;

						slice.skip(20);
					} else {
						// Simply skip ahead to the next block
						slice.skip(metadataBlockLength);
					}

					if (flagAndType & LAST_METADATA_BLOCK_FLAG_MASK) {
						break;
					}
				}

				const endPos = slice.filePos;
				slice.filePos = startPos;
				const bytes = readBytes(slice, endPos - startPos);

				const description = new Uint8Array(4 + bytes.byteLength);
				const view = new DataView(description.buffer);
				view.setUint32(0, 0x664c6143, false); // 'fLaC'
				description.set(bytes, 4);

				// Set the codec description to be 'fLaC' + all metadata blocks
				track.info.codecDescription = description;
			}; break;

			case 'dac3': { // AC3SpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const bytes = readBytes(slice, 3);
				const bitstream = new Bitstream(bytes);

				const fscod = bitstream.readBits(2);
				bitstream.skipBits(5 + 3); // Skip bsid and bsmod
				const acmod = bitstream.readBits(3);
				const lfeon = bitstream.readBits(1);

				if (fscod < 3) {
					track.info.sampleRate = AC3_SAMPLE_RATES[fscod]!;
				}

				track.info.numberOfChannels = AC3_ACMOD_CHANNEL_COUNTS[acmod]! + lfeon;
			}; break;

			case 'dec3': { // EC3SpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const bytes = readBytes(slice, boxInfo.contentSize);
				const config = parseEac3Config(bytes);

				if (!config) {
					Logging._warn('Invalid dec3 box contents, ignoring.');
					break;
				}

				const sampleRate = getEac3SampleRate(config);
				if (sampleRate !== null) {
					track.info.sampleRate = sampleRate;
				}

				track.info.numberOfChannels = getEac3ChannelCount(config);
			}; break;

			case 'ddts': { // DTSSpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const bytes = readBytes(slice, Math.min(boxInfo.contentSize, DTS_SPECIFIC_BOX_SIZE));
				const config = parseDtsSpecificBox(bytes);

				if (!config) {
					Logging._warn('Invalid ddts box contents, ignoring.');
					break;
				}

				track.info.sampleRate = config.sampleRate;

				if (config.numberOfChannels !== null) {
					track.info.numberOfChannels = config.numberOfChannels;
				}
			}; break;

			case 'dmlp': { // MLPSpecificBox
				const track = this.currentTrack;
				if (!track || track.info?.type !== 'audio') {
					break;
				}

				const formatInfo = readU32Be(slice);

				const rateBits = formatInfo >>> 28;
				if (rateBits === 0xf) {
					Logging._warn('Invalid dmlp box contents, ignoring.');
					break;
				}

				track.info.sampleRate = (rateBits & 0x8 ? 44100 : 48000) << (rateBits & 0x7);

				// Prefer the 8-channel presentation's assignment, falling back to the 6-channel one
				const sixChannelAssignment = (formatInfo >>> 15) & 0x1f;
				const eightChannelAssignment = formatInfo & 0x1fff;
				const channelAssignment = eightChannelAssignment || sixChannelAssignment;

				let numberOfChannels = 0;
				for (let i = 0; i < TRUEHD_CHANNEL_ASSIGNMENT_COUNTS.length; i++) {
					if (channelAssignment & (1 << i)) {
						numberOfChannels += TRUEHD_CHANNEL_ASSIGNMENT_COUNTS[i]!;
					}
				}

				track.info.numberOfChannels = numberOfChannels;
			}; break;

			case 'stts': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = readU32Be(slice);

				let currentIndex = 0;
				let currentTimestamp = 0;

				for (let i = 0; i < entryCount; i++) {
					const sampleCount = readU32Be(slice);
					const sampleDelta = readU32Be(slice);

					track.sampleTable.sampleTimingEntries.push({
						startIndex: currentIndex,
						startDecodeTimestamp: currentTimestamp,
						count: sampleCount,
						delta: sampleDelta,
					});

					currentIndex += sampleCount;
					currentTimestamp += sampleCount * sampleDelta;
				}
			}; break;

			case 'ctts': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(1 + 3); // Version + flags

				const entryCount = readU32Be(slice);

				let sampleIndex = 0;
				for (let i = 0; i < entryCount; i++) {
					const sampleCount = readU32Be(slice);
					const sampleOffset = readI32Be(slice);

					track.sampleTable.sampleCompositionTimeOffsets.push({
						startIndex: sampleIndex,
						count: sampleCount,
						offset: sampleOffset,
						startTimestamp: -1,
						lastTimestamp: -1,
						maxLastTimestamp: -1,
					});

					sampleIndex += sampleCount;
				}
			}; break;

			case 'stsz': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4); // Version + flags

				const sampleSize = readU32Be(slice);
				const sampleCount = readU32Be(slice);

				if (sampleSize === 0) {
					for (let i = 0; i < sampleCount; i++) {
						const sampleSize = readU32Be(slice);
						track.sampleTable.sampleSizes.push(sampleSize);
					}
				} else {
					track.sampleTable.sampleSizes.push(sampleSize);
				}

				track.sampleTable.sampleCount = sampleCount;
			}; break;

			case 'stz2': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4); // Version + flags
				slice.skip(3); // Reserved

				const fieldSize = readU8(slice); // in bits
				const sampleCount = readU32Be(slice);

				if (fieldSize !== 4 && fieldSize !== 8 && fieldSize !== 16) {
					throw new Error(`Invalid stz2 box: unsupported field size ${fieldSize}.`);
				}

				const bytes = readBytes(slice, Math.ceil(sampleCount * fieldSize / 8));
				const bitstream = new Bitstream(bytes);

				for (let i = 0; i < sampleCount; i++) {
					const sampleSize = bitstream.readBits(fieldSize);
					track.sampleTable.sampleSizes.push(sampleSize);
				}

				track.sampleTable.sampleCount = sampleCount;
			}; break;

			case 'stss': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4); // Version + flags

				track.sampleTable.keySampleIndices = [];

				const entryCount = readU32Be(slice);
				for (let i = 0; i < entryCount; i++) {
					const sampleIndex = readU32Be(slice) - 1; // Convert to 0-indexed
					track.sampleTable.keySampleIndices.push(sampleIndex);
				}

				// We binary search this list, so it must be sorted
				track.sampleTable.keySampleIndices.sort((a, b) => a - b);

				if (track.sampleTable.keySampleIndices[0] !== 0) {
					// Some files don't mark the first sample a key sample, which is basically almost always incorrect.
					// Here, we correct for that mistake:
					track.sampleTable.keySampleIndices.unshift(0);
				}
			}; break;

			case 'stsc': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4);

				const entryCount = readU32Be(slice);
				let skippedEntryCount = 0;

				for (let i = 0; i < entryCount; i++) {
					const startChunkIndex = readU32Be(slice) - 1; // Convert to 0-indexed
					const samplesPerChunk = readU32Be(slice);
					const sampleDescriptionIndex = readU32Be(slice);

					const lastEntry = last(track.sampleTable.sampleToChunk);
					if (lastEntry && startChunkIndex <= lastEntry.startChunkIndex) {
						// Keeping it would mess up the sample-to-chunk mapping and make chunk iteration blow up
						skippedEntryCount++;
						continue;
					}

					track.sampleTable.sampleToChunk.push({
						startSampleIndex: -1,
						startChunkIndex,
						samplesPerChunk,
						sampleDescriptionIndex,
					});
				}

				if (skippedEntryCount > 0) {
					Logging._warn(
						`Skipped ${skippedEntryCount} invalid stsc entries whose chunk indices weren't strictly`
						+ ' increasing.',
					);
				}

				let startSampleIndex = 0;
				for (let i = 0; i < track.sampleTable.sampleToChunk.length; i++) {
					track.sampleTable.sampleToChunk[i]!.startSampleIndex = startSampleIndex;

					if (i < track.sampleTable.sampleToChunk.length - 1) {
						const nextChunk = track.sampleTable.sampleToChunk[i + 1]!;
						const chunkCount = nextChunk.startChunkIndex
							- track.sampleTable.sampleToChunk[i]!.startChunkIndex;
						startSampleIndex += chunkCount * track.sampleTable.sampleToChunk[i]!.samplesPerChunk;
					}
				}
			}; break;

			case 'stco': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = readU32Be(slice);

				for (let i = 0; i < entryCount; i++) {
					const chunkOffset = readU32Be(slice);
					track.sampleTable.chunkOffsets.push(chunkOffset);
				}
			}; break;

			case 'co64': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				if (!track.sampleTable) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = readU32Be(slice);

				for (let i = 0; i < entryCount; i++) {
					const chunkOffset = readU64Be(slice);
					track.sampleTable.chunkOffsets.push(chunkOffset);
				}
			}; break;

			case 'mvex': {
				this.isFragmented = true;
				this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
			}; break;

			case 'mehd': {
				const version = readU8(slice);
				slice.skip(3); // Flags

				const fragmentDuration = version === 1 ? readU64Be(slice) : readU32Be(slice);
				this.movieDurationInTimescale = fragmentDuration;
			}; break;

			case 'trex': {
				slice.skip(4); // Version + flags

				const trackId = readU32Be(slice);
				const defaultSampleDescriptionIndex = readU32Be(slice);
				const defaultSampleDuration = readU32Be(slice);
				const defaultSampleSize = readU32Be(slice);
				const defaultSampleFlags = readU32Be(slice);

				// We store these separately rather than in the tracks since the tracks may not exist yet
				this.fragmentTrackDefaults.set(trackId, {
					trackId,
					defaultSampleDescriptionIndex,
					defaultSampleDuration,
					defaultSampleSize,
					defaultSampleFlags,
				});
			}; break;

			case 'tfra': {
				const version = readU8(slice);
				slice.skip(3); // Flags

				const trackId = readU32Be(slice);
				const track = this.idToTrack.get(trackId);
				if (!track) {
					break;
				}

				const word = readU32Be(slice);

				const lengthSizeOfTrafNum = (word & 0b110000) >> 4;
				const lengthSizeOfTrunNum = (word & 0b001100) >> 2;
				const lengthSizeOfSampleNum = word & 0b000011;

				const functions = [readU8, readU16Be, readU24Be, readU32Be];

				const readTrafNum = functions[lengthSizeOfTrafNum]!;
				const readTrunNum = functions[lengthSizeOfTrunNum]!;
				const readSampleNum = functions[lengthSizeOfSampleNum]!;

				const numberOfEntries = readU32Be(slice);
				for (let i = 0; i < numberOfEntries; i++) {
					const time = version === 1 ? readU64Be(slice) : readU32Be(slice);
					const moofOffset = version === 1 ? readU64Be(slice) : readU32Be(slice);

					readTrafNum(slice); // Not used
					const trunNumber = readTrunNum(slice);
					const sampleNumber = readSampleNum(slice);

					if (trunNumber >= 1 && sampleNumber >= 1) {
						track.fragmentLookupTable.push({
							timestamp: time,
							moofOffset,
							trunNumber,
							sampleNumber,
						});
					} else {
						// Invalid
					}
				}

				// The table gets sorted and deduplicated once all metadata has been read
			}; break;

			case 'moof': {
				if (this.currentFragment) {
					break; // Nested moof boxes make no sense
				}

				this.currentFragment = {
					moofOffset: startPos,
					moofSize: boxInfo.totalSize,
					implicitBaseDataOffset: startPos,
					trackData: new Map(),
					psshBoxes: [],
					sampleCount: 0,
				};

				try {
					this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
					this.lastReadFragment = this.currentFragment;
				} finally {
					this.currentFragment = null;
					this.currentTrack = null;
				}
			}; break;

			case 'traf': {
				if (!this.currentFragment || this.isReadingTraf) {
					break;
				}

				this.isReadingTraf = true;
				try {
					this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
				} finally {
					this.isReadingTraf = false;
				}

				// It is possible that there is no current track, for example when we don't care about the track
				// referenced in the track fragment header.
				if (this.currentTrack) {
					const trackData = this.currentFragment.trackData.get(this.currentTrack.id);
					cond:
					if (trackData) {
						if (trackData.samples.length === 0) {
							// Don't associate the fragment with the track if it has no samples, this simplifies
							// other code
							this.currentFragment.trackData.delete(this.currentTrack.id);
							break cond;
						}

						trackData.presentationTimestamps = trackData.samples
							.map((x, i) => ({ presentationTimestamp: x.presentationTimestamp, sampleIndex: i }))
							.sort((a, b) => a.presentationTimestamp - b.presentationTimestamp);

						for (let i = 0; i < trackData.presentationTimestamps.length; i++) {
							const currentEntry = trackData.presentationTimestamps[i]!;
							const currentSample = trackData.samples[currentEntry.sampleIndex]!;

							if (trackData.firstKeyFrameTimestamp === null && currentSample.isKeyFrame) {
								trackData.firstKeyFrameTimestamp = currentSample.presentationTimestamp;
							}

							if (i < trackData.presentationTimestamps.length - 1) {
								// Update sample durations based on presentation order
								const nextEntry = trackData.presentationTimestamps[i + 1]!;
								const duration = nextEntry.presentationTimestamp - currentEntry.presentationTimestamp;

								currentSample.duration = duration;
							}
						}

						const firstSample = trackData.samples[trackData.presentationTimestamps[0]!.sampleIndex]!;
						const lastSample = trackData.samples[last(trackData.presentationTimestamps)!.sampleIndex]!;

						trackData.startTimestamp = firstSample.presentationTimestamp;
						trackData.endTimestamp = lastSample.presentationTimestamp + lastSample.duration;

						const { currentFragmentState } = this.currentTrack;
						assert(currentFragmentState);

						if (currentFragmentState.startTimestamp !== null) {
							offsetFragmentTrackDataByTimestamp(trackData, currentFragmentState.startTimestamp);
							trackData.startTimestampIsFinal = true;
						}

						// Transfer the buffered saiz+saio state onto the track data, so readFragment can resolve it
						// once all boxes are parsed. Only relevant if senc wasn't already used to populate samples.
						if (currentFragmentState.encryptionAuxInfo && !trackData.samples[0]!.encryption) {
							trackData.encryptionAuxInfo = currentFragmentState.encryptionAuxInfo;
						}
					}

					this.currentTrack.currentFragmentState = null;
					this.currentTrack = null;
				}
			}; break;

			case 'pssh': {
				if (this.input._formatOptions.isobmff?._suppressPsshParsing) {
					break;
				}

				const psshBox = parsePsshBoxContents(readBytes(slice, boxInfo.contentSize));

				if (this.currentFragment) {
					this.currentFragment.psshBoxes.push(psshBox);
				} else if (!this.currentTrack) {
					this.psshBoxes.push(psshBox);
				}
			}; break;

			case 'tfhd': {
				// Only the first tfhd of a traf counts; anywhere else, there'd be no traf to finish the track data
				if (!this.currentFragment || !this.isReadingTraf || this.currentTrack) {
					break;
				}

				slice.skip(1); // Version

				const flags = readU24Be(slice);
				const baseDataOffsetPresent = Boolean(flags & 0x000001);
				const sampleDescriptionIndexPresent = Boolean(flags & 0x000002);
				const defaultSampleDurationPresent = Boolean(flags & 0x000008);
				const defaultSampleSizePresent = Boolean(flags & 0x000010);
				const defaultSampleFlagsPresent = Boolean(flags & 0x000020);
				const durationIsEmpty = Boolean(flags & 0x010000);
				const defaultBaseIsMoof = Boolean(flags & 0x020000);

				const trackId = readU32Be(slice);
				const track = this.idToTrack.get(trackId);
				if (!track) {
					// We don't care about this track
					break;
				}

				if (this.currentFragment.trackData.has(trackId)) {
					Logging._warn(`Multiple traf boxes for track ${trackId} in the same moof box; skipping.`);
					break;
				}

				const defaults = this.fragmentTrackDefaults.get(trackId);

				this.currentTrack = track;
				track.currentFragmentState = {
					baseDataOffset: this.currentFragment.implicitBaseDataOffset,
					sampleDescriptionIndex: defaults?.defaultSampleDescriptionIndex ?? null,
					defaultSampleDuration: defaults?.defaultSampleDuration ?? null,
					defaultSampleSize: defaults?.defaultSampleSize ?? null,
					defaultSampleFlags: defaults?.defaultSampleFlags ?? null,
					startTimestamp: null,
					encryptionAuxInfo: null,
				};

				if (baseDataOffsetPresent) {
					track.currentFragmentState.baseDataOffset = readU64Be(slice);
				} else if (defaultBaseIsMoof) {
					track.currentFragmentState.baseDataOffset = this.currentFragment.moofOffset;
				}
				if (sampleDescriptionIndexPresent) {
					track.currentFragmentState.sampleDescriptionIndex = readU32Be(slice);
				}
				if (defaultSampleDurationPresent) {
					track.currentFragmentState.defaultSampleDuration = readU32Be(slice);
				}
				if (defaultSampleSizePresent) {
					track.currentFragmentState.defaultSampleSize = readU32Be(slice);
				}
				if (defaultSampleFlagsPresent) {
					track.currentFragmentState.defaultSampleFlags = readU32Be(slice);
				}
				if (durationIsEmpty) {
					track.currentFragmentState.defaultSampleDuration = 0;
				}
			}; break;

			case 'tfdt': {
				const track = this.currentTrack;
				if (!track?.currentFragmentState) {
					break;
				}

				const version = readU8(slice);
				slice.skip(3); // Flags

				const baseMediaDecodeTime = version === 0 ? readU32Be(slice) : readU64Be(slice);
				track.currentFragmentState.startTimestamp = baseMediaDecodeTime;
			}; break;

			case 'trun': {
				const track = this.currentTrack;
				if (!track?.currentFragmentState || !this.currentFragment) {
					break;
				}

				slice.skip(1); // Version
				const flags = readU24Be(slice);
				const dataOffsetPresent = Boolean(flags & 0x000001);
				const firstSampleFlagsPresent = Boolean(flags & 0x000004);
				const sampleDurationPresent = Boolean(flags & 0x000100);
				const sampleSizePresent = Boolean(flags & 0x000200);
				const sampleFlagsPresent = Boolean(flags & 0x000400);
				const sampleCompositionTimeOffsetsPresent = Boolean(flags & 0x000800);

				const sampleCount = readU32Be(slice);

				const { defaultSampleDuration, defaultSampleSize, defaultSampleFlags } = track.currentFragmentState;
				if (
					sampleCount > 0
					&& (
						(!sampleDurationPresent && defaultSampleDuration === null)
						|| (!sampleSizePresent && defaultSampleSize === null)
						|| (!sampleFlagsPresent && defaultSampleFlags === null)
					)
				) {
					throw new Error('Invalid trun box: sample values are missing and there are no defaults.');
				}

				this.currentFragment.sampleCount += sampleCount;
				if (this.currentFragment.sampleCount > 2 ** 20) {
					// Safety measure
					throw new Error('Too many (> 2^20) samples in fragment.');
				}

				let dataOffset: number | null = null;
				if (dataOffsetPresent) {
					dataOffset = readI32Be(slice);
				}
				let firstSampleFlags: number | null = null;
				if (firstSampleFlagsPresent) {
					firstSampleFlags = readU32Be(slice);
				}

				let trackData: FragmentTrackData;

				if (this.currentFragment.trackData.has(track.id)) {
					trackData = this.currentFragment.trackData.get(track.id)!;

					if (dataOffset !== null) {
						trackData.currentOffset = track.currentFragmentState.baseDataOffset + dataOffset;
					} else {
						// "If the data-offset is not present, then the data for this run starts immediately after the
						// data of the previous run"
					}
				} else {
					trackData = {
						track,
						currentTimestamp: 0,
						currentOffset: track.currentFragmentState.baseDataOffset + (dataOffset ?? 0),
						startTimestamp: 0,
						endTimestamp: 0,
						firstKeyFrameTimestamp: null,
						samples: [],
						presentationTimestamps: [],
						startTimestampIsFinal: false,
						trunSampleCounts: [],
						encryptionAuxInfo: null,
					};
					this.currentFragment.trackData.set(track.id, trackData);
				}

				trackData.trunSampleCounts.push(sampleCount);

				for (let i = 0; i < sampleCount; i++) {
					let sampleDuration: number;
					if (sampleDurationPresent) {
						sampleDuration = readU32Be(slice);
					} else {
						sampleDuration = defaultSampleDuration!;
					}

					let sampleSize: number;
					if (sampleSizePresent) {
						sampleSize = readU32Be(slice);
					} else {
						sampleSize = defaultSampleSize!;
					}

					let sampleFlags: number;
					if (sampleFlagsPresent) {
						sampleFlags = readU32Be(slice);
					} else {
						sampleFlags = defaultSampleFlags!;
					}
					if (i === 0 && firstSampleFlags !== null) {
						sampleFlags = firstSampleFlags;
					}

					let sampleCompositionTimeOffset = 0;
					if (sampleCompositionTimeOffsetsPresent) {
						// Technically unsigned for version 0, but some writers write signed values here without
						// changing the version. Since the large unsigned values make little sense anyway, it should be
						// safe to do this.
						sampleCompositionTimeOffset = readI32Be(slice);
					}

					const isKeyFrame = !(sampleFlags & 0x00010000);

					trackData.samples.push({
						presentationTimestamp: trackData.currentTimestamp + sampleCompositionTimeOffset,
						duration: sampleDuration,
						byteOffset: trackData.currentOffset,
						byteSize: sampleSize,
						isKeyFrame,
						encryption: null,
					});

					trackData.currentOffset += sampleSize;
					trackData.currentTimestamp += sampleDuration;
				}

				this.currentFragment.implicitBaseDataOffset = trackData.currentOffset;
			}; break;

			case 'saiz': {
				// Sample Auxiliary Information Sizes - per-sample sizes of (typically) the encryption aux info.
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				slice.skip(1); // Version
				const flags = readU24Be(slice);

				if (flags & 0x01) {
					const auxInfoType = readAscii(slice, 4);
					const auxInfoTypeParam = readU32Be(slice);
					if (auxInfoType !== track.encryptionInfo.scheme || auxInfoTypeParam !== 0) {
						// Not the encryption aux info
						break;
					}
				}

				const defaultSampleInfoSize = readU8(slice);
				const sampleCount = readU32Be(slice);

				let sampleSizes: Uint8Array | null = null;
				if (defaultSampleInfoSize === 0 && sampleCount > 0) {
					sampleSizes = readBytes(slice, sampleCount);
				}

				const aux = getOrCreateEncryptionAuxInfo(track);
				aux.defaultSampleInfoSize = defaultSampleInfoSize;
				aux.sampleSizes = sampleSizes;
				aux.sampleCount = sampleCount;
			}; break;

			case 'saio': {
				// Sample Auxiliary Information Offsets - file offset(s) where the aux info lives.
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				const version = readU8(slice);
				const flags = readU24Be(slice);

				if (flags & 0x01) {
					const auxInfoType = readAscii(slice, 4);
					const auxInfoTypeParam = readU32Be(slice);
					if (auxInfoType !== track.encryptionInfo.scheme || auxInfoTypeParam !== 0) {
						break;
					}
				}

				const entryCount = readU32Be(slice);
				if (entryCount === 0) {
					break;
				}
				if (entryCount > 1) {
					Logging._warn('Multiple saio entries are not supported; using the first offset only.');
				}

				let offset = version === 0 ? readU32Be(slice) : Number(readU64Be(slice));

				// Per ISO/IEC 23001-7: when saio is inside a moof, offsets are relative to the start of the moof box.
				if (this.currentFragment) {
					offset += this.currentFragment.moofOffset;
				}

				const aux = getOrCreateEncryptionAuxInfo(track);
				aux.offset = offset;
			}; break;

			case 'senc': {
				// Per-sample encryption info inside a 'traf'. Holds per-sample IV and optional subsample breakdown
				// for CENC-protected samples
				const track = this.currentTrack;
				if (!track || !track.encryptionInfo) {
					break;
				}

				const trackData = this.currentFragment?.trackData.get(track.id);
				if (!trackData) {
					break;
				}

				slice.skip(1); // Version
				const flags = readU24Be(slice);
				const useSubsamples = Boolean(flags & 0x000002);

				const sampleCount = readU32Be(slice);
				const ivSize = track.encryptionInfo.defaultPerSampleIvSize;
				if (ivSize === null) {
					throw new Error('Invalid file: encrypted track is missing its tenc box.');
				}

				for (let i = 0; i < Math.min(sampleCount, trackData.samples.length); i++) {
					// Normalize the IV to 16 bytes so downstream code can assume a full-length buffer. For CTR with
					// an 8-byte per-sample IV the lower 8 bytes are zero (that's the CENC spec's block counter start);
					// for CBC/cbcs the IV is always 16 bytes by spec.
					const iv = new Uint8Array(16);
					if (ivSize > 0) {
						iv.set(readBytes(slice, ivSize), 0);
					} else if (track.encryptionInfo.defaultConstantIv) {
						iv.set(track.encryptionInfo.defaultConstantIv, 0);
					} else {
						throw new Error('Invalid file: encrypted sample has no IV.');
					}

					let subsamples: SampleEncryptionInfo['subsamples'] = null;
					if (useSubsamples) {
						const subsampleCount = readU16Be(slice);
						subsamples = [];
						for (let j = 0; j < subsampleCount; j++) {
							const clearLen = readU16Be(slice);
							const protectedLen = readU32Be(slice);
							subsamples.push({ clearLen, protectedLen });
						}
					}

					const sample = trackData.samples[i]!;
					sample.encryption = { iv, subsamples };
				}
			}; break;

				// Metadata section
				// https://exiftool.org/TagNames/QuickTime.html
				// https://mp4workshop.com/about

			case 'udta': { // Contains either movie metadata or track metadata
				const iterator = this.iterateContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));

				for (const { boxInfo, slice } of iterator) {
					if (boxInfo.name !== 'meta' && !this.currentTrack) {
						const startPos = slice.filePos;
						this.metadataTags.raw ??= {};

						if (boxInfo.name[0] === '©') {
							// https://mp4workshop.com/about
							// Box name starting with © indicates "international text"
							this.metadataTags.raw[boxInfo.name] ??= readMetadataStringShort(slice);
						} else {
							this.metadataTags.raw[boxInfo.name] ??= readBytes(slice, boxInfo.contentSize);
						}

						slice.filePos = startPos;
					}

					switch (boxInfo.name) {
						case 'meta': {
							slice.skip(-boxInfo.headerSize);
							this.traverseBox(slice);
						}; break;

						case '©nam':
						case 'name': {
							if (this.currentTrack) {
								this.currentTrack.name = textDecoder.decode(readBytes(slice, boxInfo.contentSize));
							} else {
								this.metadataTags.title ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©des': {
							if (!this.currentTrack) {
								this.metadataTags.description ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©ART': {
							if (!this.currentTrack) {
								this.metadataTags.artist ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©alb': {
							if (!this.currentTrack) {
								this.metadataTags.album ??= readMetadataStringShort(slice);
							}
						}; break;

						case 'albr': {
							if (!this.currentTrack) {
								this.metadataTags.albumArtist ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©gen': {
							if (!this.currentTrack) {
								this.metadataTags.genre ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©day': {
							if (!this.currentTrack) {
								const date = new Date(readMetadataStringShort(slice));
								if (!Number.isNaN(date.getTime())) {
									this.metadataTags.date ??= date;
								}
							}
						}; break;

						case '©cmt': {
							if (!this.currentTrack) {
								this.metadataTags.comment ??= readMetadataStringShort(slice);
							}
						}; break;

						case '©lyr': {
							if (!this.currentTrack) {
								this.metadataTags.lyrics ??= readMetadataStringShort(slice);
							}
						}; break;
					}
				}
			}; break;

			case 'meta': {
				if (this.currentTrack) {
					break; // Only care about movie-level metadata for now
				}

				// The 'meta' box comes in two flavors, one with flags/version and one without. To know which is which,
				// let's read the next 4 bytes, which are either the version or the size of the first subbox.
				const word = readU32Be(slice);
				const isQuickTime = word !== 0;

				this.currentMetadataKeys = new Map();

				if (isQuickTime) {
					this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
				} else {
					this.readContiguousBoxes(slice.slice(contentStartPos + 4, boxInfo.contentSize - 4));
				}

				this.currentMetadataKeys = null;
			}; break;

			case 'keys': {
				if (!this.currentMetadataKeys) {
					break;
				}

				slice.skip(4); // Version + flags

				const entryCount = readU32Be(slice);

				for (let i = 0; i < entryCount; i++) {
					const keySize = readU32Be(slice);
					if (keySize < 8) {
						throw new Error('Invalid keys box: key size must be at least 8.');
					}

					slice.skip(4); // Key namespace
					const keyName = textDecoder.decode(readBytes(slice, keySize - 8));

					this.currentMetadataKeys.set(i + 1, keyName);
				}
			}; break;

			case 'ilst': {
				if (!this.currentMetadataKeys) {
					break;
				}

				const iterator = this.iterateContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));

				for (const { boxInfo, slice } of iterator) {
					let metadataKey = boxInfo.name;

					// Interpret the box name as a u32be
					const nameAsNumber = (metadataKey.charCodeAt(0) << 24)
						+ (metadataKey.charCodeAt(1) << 16)
						+ (metadataKey.charCodeAt(2) << 8)
						+ metadataKey.charCodeAt(3);

					if (this.currentMetadataKeys.has(nameAsNumber)) {
						// An entry exists for this number
						metadataKey = this.currentMetadataKeys.get(nameAsNumber)!;
					}

					const data = readDataBox(slice);

					this.metadataTags.raw ??= {};
					this.metadataTags.raw[metadataKey] ??= data;

					switch (metadataKey) {
						case '©nam':
						case 'titl':
						case 'com.apple.quicktime.title':
						case 'title': {
							if (typeof data === 'string') {
								this.metadataTags.title ??= data;
							}
						}; break;

						case '©des':
						case 'desc':
						case 'dscp':
						case 'com.apple.quicktime.description':
						case 'description': {
							if (typeof data === 'string') {
								this.metadataTags.description ??= data;
							}
						}; break;

						case '©ART':
						case 'com.apple.quicktime.artist':
						case 'artist': {
							if (typeof data === 'string') {
								this.metadataTags.artist ??= data;
							}
						}; break;

						case '©alb':
						case 'albm':
						case 'com.apple.quicktime.album':
						case 'album': {
							if (typeof data === 'string') {
								this.metadataTags.album ??= data;
							}
						}; break;

						case 'aART':
						case 'album_artist': {
							if (typeof data === 'string') {
								this.metadataTags.albumArtist ??= data;
							}
						}; break;

						case '©cmt':
						case 'com.apple.quicktime.comment':
						case 'comment': {
							if (typeof data === 'string') {
								this.metadataTags.comment ??= data;
							}
						}; break;

						case '©gen':
						case 'gnre':
						case 'com.apple.quicktime.genre':
						case 'genre': {
							if (typeof data === 'string') {
								this.metadataTags.genre ??= data;
							}
						}; break;

						case '©lyr':
						case 'lyrics': {
							if (typeof data === 'string') {
								this.metadataTags.lyrics ??= data;
							}
						}; break;

						case '©day':
						case 'rldt':
						case 'com.apple.quicktime.creationdate':
						case 'date': {
							if (typeof data === 'string') {
								const date = new Date(data);
								if (!Number.isNaN(date.getTime())) {
									this.metadataTags.date ??= date;
								}
							}
						}; break;

						case 'tmpo': {
							if (data instanceof Uint8Array && data.length >= 2) {
								const bpm = toDataView(data).getInt16(0, false);
								if (bpm > 0) {
									this.metadataTags.beatsPerMinute ??= bpm;
								}
							}
						}; break;

						case 'covr':
						case 'com.apple.quicktime.artwork': {
							if (data instanceof RichImageData) {
								this.metadataTags.images ??= [];
								this.metadataTags.images.push({
									data: data.data,
									kind: 'coverFront',
									mimeType: data.mimeType,
								});
							} else if (data instanceof Uint8Array) {
								this.metadataTags.images ??= [];
								this.metadataTags.images.push({
									data,
									kind: 'coverFront',
									mimeType: 'image/*',
								});
							}
						}; break;

						case 'track': {
							if (typeof data === 'string') {
								const parts = data.split('/');
								const trackNum = Number.parseInt(parts[0]!, 10);
								const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

								if (Number.isInteger(trackNum) && trackNum > 0) {
									this.metadataTags.trackNumber ??= trackNum;
								}
								if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
									this.metadataTags.tracksTotal ??= tracksTotal;
								}
							}
						}; break;

						case 'trkn': {
							if (data instanceof Uint8Array && data.length >= 6) {
								const view = toDataView(data);

								const trackNumber = view.getUint16(2, false);
								const tracksTotal = view.getUint16(4, false);

								if (trackNumber > 0) {
									this.metadataTags.trackNumber ??= trackNumber;
								}
								if (tracksTotal > 0) {
									this.metadataTags.tracksTotal ??= tracksTotal;
								}
							}
						}; break;

						case 'disc':
						case 'disk': {
							if (data instanceof Uint8Array && data.length >= 6) {
								const view = toDataView(data);

								const discNumber = view.getUint16(2, false);
								const discNumberMax = view.getUint16(4, false);

								if (discNumber > 0) {
									this.metadataTags.discNumber ??= discNumber;
								}
								if (discNumberMax > 0) {
									this.metadataTags.discsTotal ??= discNumberMax;
								}
							}
						}; break;
					}
				}
			}; break;
		}

		slice.filePos = boxEndPos;
		return true;
	}
}

abstract class IsobmffTrackBacking implements InputTrackBacking {
	packetToSampleIndex = new WeakMap<EncodedPacket, number>();
	packetToFragmentLocation = new WeakMap<EncodedPacket, {
		fragment: Fragment;
		sampleIndex: number;
	}>();

	constructor(public internalTrack: InternalTrack) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	getId() {
		return this.internalTrack.id;
	}

	getNumber() {
		const demuxer = this.internalTrack.demuxer;
		const trackType = this.internalTrack.trackBacking!.getType();

		let number = 0;
		for (const track of demuxer.tracks) {
			if (track.trackBacking!.getType() === trackType) {
				number++;
			}

			if (track === this.internalTrack) {
				break;
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.internalTrack.internalCodecId;
	}

	getName() {
		return this.internalTrack.name;
	}

	getLanguageCode() {
		return this.internalTrack.languageCode;
	}

	getTimeResolution() {
		return this.internalTrack.timescale;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getDisposition() {
		return this.internalTrack.disposition;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return this.internalTrack.maxBitrate;
	}

	getAverageBitrate() {
		return this.internalTrack.avgBitrate;
	}

	async getDurationFromMetadata() {
		const track = this.internalTrack;
		if (track.durationInMediaTimescale <= 0) {
			// The duration is often zero for fragmented files for example; return `null` to signal that the duration
			// must be computed instead.
			return null;
		}

		assert(track.trackBacking);

		const firstPacket = await track.trackBacking.getFirstPacket({ metadataOnly: true });
		return (firstPacket?.timestamp ?? 0) + track.durationInMediaTimescale / track.timescale;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		const regularPacket = await this.fetchPacketForSampleIndex(0, options);
		if (regularPacket || !this.internalTrack.demuxer.isFragmented) {
			// If there's a non-fragmented packet, always prefer that
			return regularPacket;
		}

		return this.performFragmentedLookup(
			null,
			(fragment) => {
				const trackData = fragment.trackData.get(this.internalTrack.id);
				if (trackData) {
					return {
						sampleIndex: 0,
						correctSampleFound: true,
					};
				}

				return {
					sampleIndex: -1,
					correctSampleFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	private mapTimestampIntoTimescale(timestamp: number) {
		// Do a little rounding to catch cases where the result is very close to an integer. If it is, it's likely
		// that the number was originally an integer divided by the timescale. For stability, it's best
		// to return the integer in this case.
		return roundIfAlmostInteger(timestamp * this.internalTrack.timescale) + this.internalTrack.editListOffset;
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleIndex = getSampleIndexForTimestamp(sampleTable, timestampInTimescale);
		const regularPacket = await this.fetchPacketForSampleIndex(sampleIndex, options);

		if (!sampleTableIsEmpty(sampleTable) || !this.internalTrack.demuxer.isFragmented) {
			// Prefer the non-fragmented packet
			return regularPacket;
		}

		return this.performFragmentedLookup(
			null,
			(fragment) => {
				const trackData = fragment.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { sampleIndex: -1, correctSampleFound: false };
				}

				const index = binarySearchLessOrEqual(
					trackData.presentationTimestamps,
					timestampInTimescale,
					x => x.presentationTimestamp,
				);

				const sampleIndex = index !== -1 ? trackData.presentationTimestamps[index]!.sampleIndex : -1;
				const correctSampleFound = index !== -1 && timestampInTimescale < trackData.endTimestamp;

				return { sampleIndex, correctSampleFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
		);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const regularSampleIndex = this.packetToSampleIndex.get(packet);

		if (regularSampleIndex !== undefined) {
			// Prefer the non-fragmented packet
			return this.fetchPacketForSampleIndex(regularSampleIndex + 1, options);
		}

		const locationInFragment = this.packetToFragmentLocation.get(packet);
		if (locationInFragment === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performFragmentedLookup(
			locationInFragment.fragment,
			(fragment) => {
				if (fragment === locationInFragment.fragment) {
					const trackData = fragment.trackData.get(this.internalTrack.id)!;
					if (locationInFragment.sampleIndex + 1 < trackData.samples.length) {
						// We can simply take the next sample in the fragment
						return {
							sampleIndex: locationInFragment.sampleIndex + 1,
							correctSampleFound: true,
						};
					}
				} else {
					const trackData = fragment.trackData.get(this.internalTrack.id);
					if (trackData) {
						return {
							sampleIndex: 0,
							correctSampleFound: true,
						};
					}
				}

				return {
					sampleIndex: -1,
					correctSampleFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleIndex = getKeyframeSampleIndexForTimestamp(sampleTable, timestampInTimescale);
		const regularPacket = await this.fetchPacketForSampleIndex(sampleIndex, options);

		if (!sampleTableIsEmpty(sampleTable) || !this.internalTrack.demuxer.isFragmented) {
			// Prefer the non-fragmented packet
			return regularPacket;
		}

		return this.performFragmentedLookup(
			null,
			(fragment) => {
				const trackData = fragment.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { sampleIndex: -1, correctSampleFound: false };
				}

				const index = findLastIndex(trackData.presentationTimestamps, (x) => {
					const sample = trackData.samples[x.sampleIndex]!;
					return sample.isKeyFrame && x.presentationTimestamp <= timestampInTimescale;
				});

				const sampleIndex = index !== -1 ? trackData.presentationTimestamps[index]!.sampleIndex : -1;
				const correctSampleFound = index !== -1 && timestampInTimescale < trackData.endTimestamp;

				return { sampleIndex, correctSampleFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
		);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const regularSampleIndex = this.packetToSampleIndex.get(packet);
		if (regularSampleIndex !== undefined) {
			// Prefer the non-fragmented packet
			const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
			const nextKeyFrameSampleIndex = getNextKeyframeIndexForSample(sampleTable, regularSampleIndex);
			return this.fetchPacketForSampleIndex(nextKeyFrameSampleIndex, options);
		}

		const locationInFragment = this.packetToFragmentLocation.get(packet);
		if (locationInFragment === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performFragmentedLookup(
			locationInFragment.fragment,
			(fragment) => {
				if (fragment === locationInFragment.fragment) {
					const trackData = fragment.trackData.get(this.internalTrack.id)!;

					for (let i = locationInFragment.sampleIndex + 1; i < trackData.samples.length; i++) {
						if (trackData.samples[i]!.isKeyFrame) {
							// We can simply take the next key frame in the fragment
							return {
								sampleIndex: i,
								correctSampleFound: true,
							};
						}
					}
				} else {
					const trackData = fragment.trackData.get(this.internalTrack.id);
					if (trackData && trackData.firstKeyFrameTimestamp !== null) {
						const keyFrameIndex = trackData.samples.findIndex(x => x.isKeyFrame);
						assert(keyFrameIndex !== -1); // There must be one

						return {
							sampleIndex: keyFrameIndex,
							correctSampleFound: true,
						};
					}
				}

				return {
					sampleIndex: -1,
					correctSampleFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	private async fetchPacketForSampleIndex(sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleInfo = getSampleInfo(sampleTable, sampleIndex);
		if (!sampleInfo) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.internalTrack.demuxer.reader.requestSlice(
				sampleInfo.sampleOffset,
				sampleInfo.sampleSize,
			);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null; // Data is outside
			}

			data = readBytes(slice, sampleInfo.sampleSize);

			if (this.internalTrack.encryptionInfo) {
				let sampleEncryption: SampleEncryptionInfo | null = null;

				if (this.internalTrack.encryptionAuxInfo) {
					const entries = await resolveEncryptionAuxInfo(
						this.internalTrack.demuxer.reader,
						this.internalTrack.encryptionInfo,
						this.internalTrack.encryptionAuxInfo,
					);

					if (sampleIndex < entries.length) {
						sampleEncryption = entries[sampleIndex]!;
					}
				}

				sampleEncryption ??= getDefaultSampleEncryption(this.internalTrack.encryptionInfo);
				if (sampleEncryption) {
					data = await decryptSample(this.internalTrack, sampleEncryption, data, null);
				}
			}
		}

		const timestamp = (sampleInfo.presentationTimestamp - this.internalTrack.editListOffset)
			/ this.internalTrack.timescale;
		const duration = sampleInfo.duration / this.internalTrack.timescale;
		const packet = new EncodedPacket(
			data,
			sampleInfo.isKeyFrame ? 'key' : 'delta',
			timestamp,
			duration,
			sampleIndex,
			sampleInfo.sampleSize,
		);

		this.packetToSampleIndex.set(packet, sampleIndex);

		return packet;
	}

	private async fetchPacketInFragment(fragment: Fragment, sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const trackData = fragment.trackData.get(this.internalTrack.id)!;
		const fragmentSample = trackData.samples[sampleIndex];
		assert(fragmentSample);

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.internalTrack.demuxer.reader.requestSlice(
				fragmentSample.byteOffset,
				fragmentSample.byteSize,
			);
			if (isThenable(slice)) slice = await slice;
			if (!slice) {
				return null; // Data is outside
			}

			data = readBytes(slice, fragmentSample.byteSize);

			if (this.internalTrack.encryptionInfo) {
				const sampleEncryption = fragmentSample.encryption
					?? getDefaultSampleEncryption(this.internalTrack.encryptionInfo);
				if (sampleEncryption) {
					data = await decryptSample(this.internalTrack, sampleEncryption, data, fragment);
				}
			}
		}

		const timestamp = (fragmentSample.presentationTimestamp - this.internalTrack.editListOffset)
			/ this.internalTrack.timescale;
		const duration = fragmentSample.duration / this.internalTrack.timescale;
		const packet = new EncodedPacket(
			data,
			fragmentSample.isKeyFrame ? 'key' : 'delta',
			timestamp,
			duration,
			fragment.moofOffset + sampleIndex,
			fragmentSample.byteSize,
		);

		this.packetToFragmentLocation.set(packet, { fragment, sampleIndex });

		return packet;
	}

	/** Looks for a packet in the fragments while trying to load as few fragments as possible to retrieve it. */
	private async performFragmentedLookup(
		// The fragment where we start looking
		startFragment: Fragment | null,
		// This function returns the best-matching sample in a given fragment
		getMatchInFragment: (fragment: Fragment) => { sampleIndex: number; correctSampleFound: boolean },
		// The timestamp with which we can search the lookup table
		searchTimestamp: number,
		// The timestamp for which we know the correct sample will not come after it
		latestTimestamp: number,
		options: PacketRetrievalOptions,
		// The position for which we know the correct sample will not come after it
		stopPos = Infinity,
		// How many times we've retried due to a faulty lookup table entry
		lookupRetryCount = 0,
	): Promise<EncodedPacket | null> {
		const demuxer = this.internalTrack.demuxer;

		let currentFragment: Fragment | null = null;
		let bestFragment: Fragment | null = null;
		let bestSampleIndex = -1;

		if (startFragment) {
			const { sampleIndex, correctSampleFound } = getMatchInFragment(startFragment);

			if (correctSampleFound) {
				return this.fetchPacketInFragment(startFragment, sampleIndex, options);
			}

			if (sampleIndex !== -1) {
				bestFragment = startFragment;
				bestSampleIndex = sampleIndex;
			}
		}

		// Search for a lookup entry; this way, we won't need to start searching from the start of the file
		// but can jump right into the correct fragment (or at least nearby).
		const lookupEntryIndex = binarySearchLessOrEqual(
			this.internalTrack.fragmentLookupTable,
			searchTimestamp,
			x => x.timestamp,
		);
		const lookupEntry = lookupEntryIndex !== -1
			? this.internalTrack.fragmentLookupTable[lookupEntryIndex]!
			: null;

		const positionCacheIndex = binarySearchLessOrEqual(
			this.internalTrack.fragmentPositionCache,
			searchTimestamp,
			x => x.startTimestamp,
		);
		const positionCacheEntry = positionCacheIndex !== -1
			? this.internalTrack.fragmentPositionCache[positionCacheIndex]!
			: null;

		const lookupEntryPosition = Math.max(
			lookupEntry?.moofOffset ?? 0,
			positionCacheEntry?.moofOffset ?? 0,
		) || null;
		const lookupTableWins = !!lookupEntry && lookupEntry.moofOffset >= (positionCacheEntry?.moofOffset ?? 0);

		let currentPos: number;

		if (!startFragment) {
			currentPos = lookupEntryPosition ?? 0;
		} else {
			if (lookupEntryPosition === null || startFragment.moofOffset >= lookupEntryPosition) {
				currentPos = startFragment.moofOffset + startFragment.moofSize;
				currentFragment = startFragment;
			} else {
				// Use the lookup entry
				currentPos = lookupEntryPosition;
			}
		}

		const scanStartPos = currentFragment ? currentFragment.moofOffset : currentPos;

		while (currentPos < stopPos) {
			if (currentFragment) {
				const trackData = currentFragment.trackData.get(this.internalTrack.id);
				if (trackData && trackData.startTimestamp > latestTimestamp) {
					// We're already past the upper bound, no need to keep searching
					break;
				}

				currentFragment = null; // So we don't process it again next iteration
			}

			const summary = demuxer.fragmentSummaries.get(currentPos);
			if (summary && !summary.trackIds.has(this.internalTrack.id)) {
				// We've read this fragment before and know it has nothing for this track, so let's not read it again
				currentPos += summary.moofSize;
				continue;
			}

			// Load the header
			let slice = demuxer.reader.requestSliceRange(currentPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
			if (isThenable(slice)) slice = await slice;
			if (!slice) break;

			const boxStartPos = currentPos;
			const boxInfo = readBoxHeader(slice);
			if (!boxInfo) {
				break;
			}

			if (boxInfo.name === 'moof') {
				currentFragment = await demuxer.readFragment(boxStartPos);
				if (!currentFragment) {
					break;
				}

				const { sampleIndex, correctSampleFound } = getMatchInFragment(currentFragment);
				if (correctSampleFound) {
					return this.fetchPacketInFragment(currentFragment, sampleIndex, options);
				}
				if (sampleIndex !== -1) {
					bestFragment = currentFragment;
					bestSampleIndex = sampleIndex;
				}
			}

			currentPos = boxStartPos + boxInfo.totalSize;
		}

		// Handle unsatisfactory lookup table entries or position cache entries
		if (lookupEntryPosition !== null && (!bestFragment || bestFragment.moofOffset < lookupEntryPosition)) {
			// We found a lookup entry but no fragment from there on that satisfied the match. In this case, let's
			// search again but using a previous entry of the kind we started from. Each time this happens, we double
			// the backwards step to perform better (and have more sequential reads) if it takes us a long time to find
			// the media.
			const step = 1 << lookupRetryCount;
			const previousEntryTimestamp = lookupTableWins
				? this.internalTrack.fragmentLookupTable[lookupEntryIndex - step]?.timestamp
				: this.internalTrack.fragmentPositionCache[positionCacheIndex - step]?.startTimestamp;
			const newSearchTimestamp = previousEntryTimestamp ?? -Infinity;

			return this.performFragmentedLookup(
				null,
				getMatchInFragment,
				newSearchTimestamp,
				latestTimestamp,
				options,
				scanStartPos, // So we don't read the same fragments again
				lookupRetryCount + 1,
			);
		}

		if (bestFragment) {
			// If we finished looping but didn't find a perfect match, still return the best match we found
			return this.fetchPacketInFragment(bestFragment, bestSampleIndex, options);
		}

		return null;
	}
}

class IsobmffVideoTrackBacking extends IsobmffTrackBacking implements InputVideoTrackBacking {
	declare internalTrack: InternalVideoTrack;
	decoderConfigPromise: Promise<VideoDecoderConfig> | null = null;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
	}

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec | null {
		return this.internalTrack.info.codec;
	}

	getCodedWidth() {
		return this.internalTrack.info.width;
	}

	getCodedHeight() {
		return this.internalTrack.info.height;
	}

	getSquarePixelWidth() {
		return this.internalTrack.info.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return this.internalTrack.info.squarePixelHeight;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...this.internalTrack.matrix];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		const decoderConfig = await this.getDecoderConfig();
		if (!decoderConfig) {
			return this.internalTrack.info.colorSpace;
		}

		return {
			primaries: decoderConfig.colorSpace?.primaries,
			transfer: decoderConfig.colorSpace?.transfer,
			matrix: decoderConfig.colorSpace?.matrix,
			fullRange: decoderConfig.colorSpace?.fullRange,
		};
	}

	async canBeTransparent() {
		return this.internalTrack.info.codec === 'prores' && (
			this.internalTrack.info.proresFormat === 'ap4h'
			|| this.internalTrack.info.proresFormat === 'ap4x'
		);
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
			if (this.internalTrack.info.codec === 'avc' && !this.internalTrack.info.codecDescription) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.avcCodecInfo
					= firstPacket && extractAvcDecoderConfigurationRecord(firstPacket.data);
			} else if (this.internalTrack.info.codec === 'hevc' && !this.internalTrack.info.codecDescription) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.hevcCodecInfo
					= firstPacket && extractHevcDecoderConfigurationRecord(firstPacket.data);
			} else if (
				this.internalTrack.info.codec === 'vp9'
				&& (
					!this.internalTrack.info.vp9CodecInfo
					// The codec info extracted from vpcC may claim the color space is "undefined"
					|| !vp9CodecInfoHasColorInfo(this.internalTrack.info.vp9CodecInfo)
				)
			) {
				const firstPacket = await this.getFirstPacket({});
				const packetInfo = firstPacket && extractVp9CodecInfoFromPacket(firstPacket.data);

				if (packetInfo) {
					this.internalTrack.info.vp9CodecInfo = {
						...(this.internalTrack.info.vp9CodecInfo ?? packetInfo),
						videoFullRangeFlag: packetInfo.videoFullRangeFlag,
						colourPrimaries: packetInfo.colourPrimaries,
						transferCharacteristics: packetInfo.transferCharacteristics,
						matrixCoefficients: packetInfo.matrixCoefficients,
					};
				}
			} else if (
				this.internalTrack.info.codec === 'av1'
				&& (
					!this.internalTrack.info.av1CodecInfo
					// The codec info extracted from av1C may not contain color space information
					|| !av1CodecInfoHasColorInfo(
						this.internalTrack.info.av1CodecInfo,
					)
				)
			) {
				const firstPacket = await this.getFirstPacket({});
				const packetInfo = firstPacket && extractAv1CodecInfoFromPacket(firstPacket.data);

				if (packetInfo) {
					this.internalTrack.info.av1CodecInfo = packetInfo;
				}
			} else if (this.internalTrack.info.codec === 'prores' && !this.internalTrack.info.proresCodecInfo) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.proresCodecInfo
					= firstPacket && extractProresCodecInfoFromPacket(firstPacket.data);
			}

			if (!colorSpaceIsComplete(this.internalTrack.info.colorSpace)) {
				const colorSpace = extractColorSpace(this.internalTrack.info);

				// Fill the missing values
				this.internalTrack.info.colorSpace.primaries ??= colorSpace.primaries;
				this.internalTrack.info.colorSpace.transfer ??= colorSpace.transfer;
				this.internalTrack.info.colorSpace.matrix ??= colorSpace.matrix;
				this.internalTrack.info.colorSpace.fullRange ??= colorSpace.fullRange;
			}

			const config: VideoDecoderConfig = {
				codec: extractVideoCodecString(this.internalTrack.info),
				codedWidth: this.internalTrack.info.width,
				codedHeight: this.internalTrack.info.height,
				description: this.internalTrack.info.codecDescription ?? undefined,
				colorSpace: this.internalTrack.info.colorSpace,
			};

			if (
				this.internalTrack.info.width !== this.internalTrack.info.squarePixelWidth
				|| this.internalTrack.info.height !== this.internalTrack.info.squarePixelHeight
			) {
				config.displayAspectWidth = this.internalTrack.info.squarePixelWidth;
				config.displayAspectHeight = this.internalTrack.info.squarePixelHeight;
			}

			return config;
		})();
	}
}

class IsobmffAudioTrackBacking extends IsobmffTrackBacking implements InputAudioTrackBacking {
	declare internalTrack: InternalAudioTrack;
	decoderConfigPromise: Promise<AudioDecoderConfig> | null = null;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
	}

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec | null {
		return this.internalTrack.info.codec;
	}

	getNumberOfChannels() {
		return this.internalTrack.info.numberOfChannels;
	}

	getSampleRate() {
		return this.internalTrack.info.sampleRate;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<AudioDecoderConfig> => {
			if (this.internalTrack.info.codec === 'dts' && !this.internalTrack.info.dtsFormat) {
				// Gotta check the packet to determine the DTS variant
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.dtsFormat = firstPacket && extractDtsFourCcFromPacket(firstPacket.data);
			}

			return {
				codec: extractAudioCodecString(this.internalTrack.info),
				numberOfChannels: this.internalTrack.info.numberOfChannels,
				sampleRate: this.internalTrack.info.sampleRate,
				description: this.internalTrack.info.codecDescription ?? undefined,
			};
		})();
	}
}

const getSampleIndexForTimestamp = (sampleTable: SampleTable, timescaleUnits: number) => {
	if (sampleTable.sortedCompositionTimeOffsets) {
		return performPresentationTimeLookup(sampleTable, timescaleUnits, false);
	} else {
		const index = binarySearchLessOrEqual(
			sampleTable.sampleTimingEntries,
			timescaleUnits,
			x => x.startDecodeTimestamp,
		);
		if (index === -1) {
			return -1;
		}

		const entry = sampleTable.sampleTimingEntries[index]!;
		if (entry.delta === 0) {
			return entry.startIndex + entry.count - 1; // All samples share the same timestamp
		}

		return entry.startIndex
			+ Math.min(
				Math.floor((timescaleUnits - entry.startDecodeTimestamp) / entry.delta),
				entry.count - 1,
			);
	}
};

const getKeyframeSampleIndexForTimestamp = (sampleTable: SampleTable, timescaleUnits: number) => {
	if (!sampleTable.keySampleIndices) {
		// Every sample is a keyframe
		return getSampleIndexForTimestamp(sampleTable, timescaleUnits);
	}

	if (sampleTable.sortedCompositionTimeOffsets) {
		return performPresentationTimeLookup(sampleTable, timescaleUnits, true);
	} else {
		const sampleIndex = getSampleIndexForTimestamp(sampleTable, timescaleUnits);

		const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, x => x);
		return sampleTable.keySampleIndices[index] ?? -1;
	}
};

type SampleInfo = {
	presentationTimestamp: number;
	duration: number;
	sampleOffset: number;
	sampleSize: number;
	chunkOffset: number;
	isKeyFrame: boolean;
};

const getSampleInfo = (sampleTable: SampleTable, sampleIndex: number): SampleInfo | null => {
	if (sampleIndex >= sampleTable.sampleCount) {
		return null;
	}

	const timingEntryIndex = binarySearchLessOrEqual(sampleTable.sampleTimingEntries, sampleIndex, x => x.startIndex);
	const timingEntry = sampleTable.sampleTimingEntries[timingEntryIndex]!;

	const decodeTimestamp = timingEntry.startDecodeTimestamp
		+ (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
	let presentationTimestamp = decodeTimestamp;
	const offsetEntryIndex = binarySearchLessOrEqual(
		sampleTable.sampleCompositionTimeOffsets,
		sampleIndex,
		x => x.startIndex,
	);
	const offsetEntry = sampleTable.sampleCompositionTimeOffsets[offsetEntryIndex];
	if (offsetEntry && sampleIndex - offsetEntry.startIndex < offsetEntry.count) {
		presentationTimestamp += offsetEntry.offset;
	}

	const sampleSize = sampleTable.sampleSizes[Math.min(sampleIndex, sampleTable.sampleSizes.length - 1)]!;
	const chunkEntryIndex = binarySearchLessOrEqual(sampleTable.sampleToChunk, sampleIndex, x => x.startSampleIndex);
	const chunkEntry = sampleTable.sampleToChunk[chunkEntryIndex]!;

	const chunkIndex = chunkEntry.startChunkIndex
		+ Math.floor((sampleIndex - chunkEntry.startSampleIndex) / chunkEntry.samplesPerChunk);
	const chunkOffset = sampleTable.chunkOffsets[chunkIndex]!;

	const startSampleIndexOfChunk = chunkEntry.startSampleIndex
		+ (chunkIndex - chunkEntry.startChunkIndex) * chunkEntry.samplesPerChunk;
	let sampleOffset = chunkOffset;

	if (sampleTable.sampleSizes.length === 1) {
		sampleOffset += sampleSize * (sampleIndex - startSampleIndexOfChunk);
	} else {
		sampleOffset += sampleTable.cumulativeSampleSizes![sampleIndex]!
			- sampleTable.cumulativeSampleSizes![startSampleIndexOfChunk]!;
	}

	let duration = timingEntry.delta;
	if (sampleTable.sortedCompositionTimeOffsets) {
		// In order to accurately compute the duration, we need to take the duration to the next sample in presentation
		// order, not in decode order
		const nextPresentationTimestamp = getNextPresentationTimestamp(sampleTable, sampleIndex, presentationTimestamp);
		if (nextPresentationTimestamp !== null) {
			duration = nextPresentationTimestamp - presentationTimestamp;
		}
	}

	return {
		presentationTimestamp,
		duration,
		sampleOffset,
		sampleSize,
		chunkOffset,
		isKeyFrame: sampleTable.keySampleIndices
			? binarySearchExact(sampleTable.keySampleIndices, sampleIndex, x => x) !== -1
			: true,
	};
};

const performPresentationTimeLookup = (
	sampleTable: SampleTable,
	timestamp: number,
	keyFramesOnly: boolean,
) => {
	const entries = sampleTable.sortedCompositionTimeOffsets!;
	let bestSampleIndex = -1;
	let bestTimestamp = -Infinity;

	// Walk back until no entry can beat the best sample found so far anymore
	const startIndex = binarySearchLessOrEqual(entries, timestamp, x => x.startTimestamp);
	for (let i = startIndex; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.maxLastTimestamp < bestTimestamp) {
			break;
		}

		let sampleIndex = entry.lastTimestamp <= timestamp
			? entry.startIndex + entry.count - 1
			: findFirstSampleInEntry(sampleTable, entry, (_, otherTimestamp) => otherTimestamp > timestamp) - 1;
		if (keyFramesOnly) {
			const keySampleIndex = binarySearchLessOrEqual(sampleTable.keySampleIndices!, sampleIndex, x => x);
			sampleIndex = sampleTable.keySampleIndices![keySampleIndex] ?? -1;
		}
		if (sampleIndex < entry.startIndex) {
			continue; // Nothing suitable in this entry
		}

		const presentationTimestamp = getDecodeTimestamp(sampleTable, sampleIndex) + entry.offset;
		if (
			presentationTimestamp > bestTimestamp
			|| (presentationTimestamp === bestTimestamp && sampleIndex > bestSampleIndex)
		) {
			bestSampleIndex = sampleIndex;
			bestTimestamp = presentationTimestamp;
		}
	}

	return bestSampleIndex;
};

const getNextPresentationTimestamp = (sampleTable: SampleTable, sampleIndex: number, presentationTimestamp: number) => {
	const entries = sampleTable.sortedCompositionTimeOffsets!;
	const lastStartedEntryIndex = binarySearchLessOrEqual(entries, presentationTimestamp, x => x.startTimestamp);

	// No entry starting later can beat the first one of them
	let nextTimestamp = entries[lastStartedEntryIndex + 1]?.startTimestamp ?? null;

	// Walk back until no entry can beat the best sample found so far anymore
	for (let i = lastStartedEntryIndex; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.maxLastTimestamp < presentationTimestamp) {
			break;
		}

		const nextSampleIndex = findFirstSampleInEntry(
			sampleTable,
			entry,
			(otherSampleIndex, otherTimestamp) => otherTimestamp > presentationTimestamp
				|| (otherTimestamp === presentationTimestamp && otherSampleIndex > sampleIndex),
		);
		if (nextSampleIndex === entry.startIndex + entry.count) {
			continue; // Nothing after the sample in this entry
		}

		const timestamp = getDecodeTimestamp(sampleTable, nextSampleIndex) + entry.offset;
		if (nextTimestamp === null || timestamp < nextTimestamp) {
			nextTimestamp = timestamp;
		}
	}

	return nextTimestamp;
};

const findFirstSampleInEntry = (
	sampleTable: SampleTable,
	entry: SampleCompositionTimeOffsetEntry,
	predicate: (sampleIndex: number, presentationTimestamp: number) => boolean,
) => {
	// The samples of an entry are in presentation order, so this binary searches for the first one satisfying the
	// predicate

	let low = entry.startIndex;
	let high = entry.startIndex + entry.count;

	while (low < high) {
		const mid = Math.floor((low + high) / 2);

		if (predicate(mid, getDecodeTimestamp(sampleTable, mid) + entry.offset)) {
			high = mid;
		} else {
			low = mid + 1;
		}
	}

	return low;
};

const getDecodeTimestamp = (sampleTable: SampleTable, sampleIndex: number) => {
	const timingEntryIndex = binarySearchLessOrEqual(sampleTable.sampleTimingEntries, sampleIndex, x => x.startIndex);
	const timingEntry = sampleTable.sampleTimingEntries[timingEntryIndex]!;

	return timingEntry.startDecodeTimestamp + (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
};

const getNextKeyframeIndexForSample = (sampleTable: SampleTable, sampleIndex: number) => {
	if (!sampleTable.keySampleIndices) {
		return sampleIndex + 1;
	}

	const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, x => x);
	return sampleTable.keySampleIndices[index + 1] ?? -1;
};

const offsetFragmentTrackDataByTimestamp = (trackData: FragmentTrackData, timestamp: number) => {
	trackData.startTimestamp += timestamp;
	trackData.endTimestamp += timestamp;

	for (const sample of trackData.samples) {
		sample.presentationTimestamp += timestamp;
	}
	for (const entry of trackData.presentationTimestamps) {
		entry.presentationTimestamp += timestamp;
	}
};

const readMatrix = (slice: FileSlice): TransformationMatrix => {
	return [
		readFixed_16_16(slice),
		readFixed_16_16(slice),
		readFixed_2_30(slice),
		readFixed_16_16(slice),
		readFixed_16_16(slice),
		readFixed_2_30(slice),
		readFixed_16_16(slice),
		readFixed_16_16(slice),
		readFixed_2_30(slice),
	];
};

const applySpsPixelAspectRatio = (track: InternalTrack, pixelAspectRatio: Rational) => {
	const info = track.info!;
	if (info.type !== 'video') {
		return;
	}

	const { num, den } = pixelAspectRatio;
	if (!(num > 0 && den > 0) || num === den) {
		return;
	}

	if (num > den) {
		info.squarePixelWidth = Math.round(info.width * num / den);
		info.squarePixelHeight = info.height;
	} else {
		info.squarePixelWidth = info.width;
		info.squarePixelHeight = Math.round(info.height * den / num);
	}
};

const sampleTableIsEmpty = (sampleTable: SampleTable) => {
	return sampleTable.sampleSizes.length === 0;
};

const capEntryCounts = (entries: { startIndex: number; count: number }[], sampleCount: number) => {
	while (entries.length > 0 && last(entries)!.startIndex >= sampleCount) {
		entries.pop();
	}

	const lastEntry = last(entries);
	if (lastEntry) {
		lastEntry.count = Math.min(lastEntry.count, sampleCount - lastEntry.startIndex);
	}
};

const getOrCreateEncryptionAuxInfo = (track: InternalTrack) => {
	if (track.currentFragmentState) {
		return track.currentFragmentState.encryptionAuxInfo ??= {
			defaultSampleInfoSize: 0,
			sampleSizes: null,
			sampleCount: 0,
			offset: null,
			resolved: null,
		};
	} else {
		return track.encryptionAuxInfo ??= {
			defaultSampleInfoSize: 0,
			sampleSizes: null,
			sampleCount: 0,
			offset: null,
			resolved: null,
		};
	}
};

const resolveEncryptionAuxInfo = async (
	reader: Reader,
	encryptionInfo: TrackEncryptionInfo,
	aux: SampleEncryptionAuxInfo,
) => {
	if (aux.resolved) {
		return aux.resolved;
	}

	if (aux.offset === null || aux.sampleCount === 0) {
		throw new Error('Incomplete saiz/saio info; cannot resolve encryption data.');
	}

	let totalSize = 0;
	if (aux.defaultSampleInfoSize > 0) {
		totalSize = aux.defaultSampleInfoSize * aux.sampleCount;
	} else {
		assert(aux.sampleSizes);
		for (let i = 0; i < aux.sampleCount; i++) {
			totalSize += aux.sampleSizes[i]!;
		}
	}

	let slice = reader.requestSlice(aux.offset, totalSize);
	if (isThenable(slice)) slice = await slice;
	if (!slice) {
		throw new Error('Failed to read auxiliary encryption info.');
	}

	const ivSize = encryptionInfo.defaultPerSampleIvSize;
	if (ivSize === null) {
		throw new Error('Invalid file: encrypted track is missing its tenc box.');
	}

	// Each aux entry has the same byte layout as a senc entry: IV (of size ivSize, or the constant IV from tenc
	// when ivSize is 0), then optionally subsample count + [clearLen, protectedLen] pairs. Subsamples are present
	// iff the entry is larger than the IV.
	const entries: SampleEncryptionInfo[] = [];
	for (let i = 0; i < aux.sampleCount; i++) {
		const entrySize = aux.defaultSampleInfoSize > 0
			? aux.defaultSampleInfoSize
			: aux.sampleSizes![i]!;

		const iv = new Uint8Array(16);
		if (ivSize > 0) {
			iv.set(readBytes(slice, ivSize), 0);
		} else if (encryptionInfo.defaultConstantIv) {
			iv.set(encryptionInfo.defaultConstantIv, 0);
		} else {
			throw new Error('Invalid file: encrypted sample has no IV.');
		}

		let subsamples: { clearLen: number; protectedLen: number }[] | null = null;
		if (entrySize > ivSize) {
			const subsampleCount = readU16Be(slice);
			subsamples = [];
			for (let j = 0; j < subsampleCount; j++) {
				const clearLen = readU16Be(slice);
				const protectedLen = readU32Be(slice);
				subsamples.push({ clearLen, protectedLen });
			}
		}

		entries.push({ iv, subsamples });
	}

	aux.resolved = entries;
	return entries;
};

const getDefaultSampleEncryption = (encryptionInfo: TrackEncryptionInfo): SampleEncryptionInfo | null => {
	if (!encryptionInfo.defaultConstantIv) {
		return null;
	}

	return {
		iv: encryptionInfo.defaultConstantIv,
		subsamples: null,
	};
};

const decryptSample = async (
	track: InternalTrack,
	sampleEncryption: SampleEncryptionInfo,
	data: Uint8Array,
	fragment: Fragment | null,
): Promise<Uint8Array> => {
	assert(track.encryptionInfo);
	const encryptionInfo = track.encryptionInfo;
	if (encryptionInfo.defaultKid === null) {
		throw new Error('Invalid file: encrypted track is missing its tenc box.');
	}

	const keyId = encryptionInfo.defaultKid;
	let keyBytes: Uint8Array;

	const cacheEntry = track.demuxer.decryptionKeyCache.get(keyId);
	if (cacheEntry) {
		keyBytes = await cacheEntry;
	} else {
		if (!track.demuxer.input._formatOptions.isobmff?.resolveKeyId) {
			throw new Error(
				'Encrypted media samples encountered. To decrypt them, please provide a callback for'
				+ ' InputOptions.formatOptions.isobmff.resolveKeyId.',
			);
		}

		const promise = (async () => {
			let psshBoxes = track.demuxer.psshBoxes;
			if (fragment) {
				psshBoxes = [
					...psshBoxes,
					...fragment.psshBoxes,
				].filter(x => x.keyIds === null || x.keyIds.includes(keyId));

				// Filter out duplicates
				for (let i = 0; i < psshBoxes.length - 1; i++) {
					for (let j = i + 1; j < psshBoxes.length; j++) {
						if (psshBoxesAreEqual(psshBoxes[i]!, psshBoxes[j]!)) {
							psshBoxes.splice(j, 1);
							j--;
						}
					}
				}
			}

			const keyResult = await track.demuxer.input._formatOptions.isobmff!.resolveKeyId!({ keyId, psshBoxes });

			if (!(
				(typeof keyResult === 'string' && keyResult.length === 32 && HEX_STRING_REGEX.test(keyResult))
				|| (keyResult instanceof Uint8Array && keyResult.byteLength === 16)
			)) {
				throw new TypeError(
					'resolveKeyId must return a 32-character hex string or a 16-byte Uint8Array containing the'
					+ ' decryption key.',
				);
			}

			return keyResult instanceof Uint8Array
				? keyResult
				: hexStringToBytes(keyResult);
		})();

		track.demuxer.decryptionKeyCache.set(keyId, promise);
		keyBytes = await promise;
	}

	if (encryptionInfo.scheme === 'cenc' || encryptionInfo.scheme === 'cens') {
		return decryptCtr(keyBytes, encryptionInfo, sampleEncryption, data);
	} else {
		return decryptCbcs(keyBytes, encryptionInfo, sampleEncryption, data);
	}
};

const decryptCtr = async (
	key: Uint8Array,
	encryptionInfo: TrackEncryptionInfo,
	sampleEncryption: SampleEncryptionInfo,
	data: Uint8Array,
) => {
	const counter = new Uint8Array(16);
	counter.set(sampleEncryption.iv, 0);

	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'AES-CTR' },
		false,
		['decrypt'],
	);

	const cryptApply = async (input: Uint8Array) => {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-CTR', counter, length: 64 },
			cryptoKey,
			input as BufferSource,
		);

		return new Uint8Array(plaintext);
	};

	if (!sampleEncryption.subsamples) {
		// Whole sample is protected, no pattern
		return cryptApply(data);
	}

	assert(encryptionInfo.defaultCryptByteBlock !== null && encryptionInfo.defaultSkipByteBlock !== null);
	const cryptRanges = collectCryptRanges(
		sampleEncryption.subsamples,
		encryptionInfo.defaultCryptByteBlock,
		encryptionInfo.defaultSkipByteBlock,
		data.length,
	);

	// Concatenate all crypt ranges into a single buffer so the continuous CTR counter behavior is preserved
	let totalCryptLen = 0;
	for (const range of cryptRanges) {
		for (const seg of range.perSubsample) {
			totalCryptLen += seg.length;
		}
	}
	const cryptBuffer = new Uint8Array(totalCryptLen);
	let writePos = 0;
	for (const range of cryptRanges) {
		for (const seg of range.perSubsample) {
			cryptBuffer.set(data.subarray(seg.offset, seg.offset + seg.length), writePos);
			writePos += seg.length;
		}
	}

	const plain = await cryptApply(cryptBuffer);

	// Now let's build the output
	const output = new Uint8Array(data);
	let readPos = 0;
	for (const range of cryptRanges) {
		for (const seg of range.perSubsample) {
			output.set(plain.subarray(readPos, readPos + seg.length), seg.offset);
			readPos += seg.length;
		}
	}

	return output;
};

const decryptCbcs = (
	key: Uint8Array,
	encryptionInfo: TrackEncryptionInfo,
	sampleEncryption: SampleEncryptionInfo,
	data: Uint8Array,
) => {
	const ctx = new Aes128CbcContext();
	ctx.init({ key, iv: sampleEncryption.iv });

	const cryptByteBlock = encryptionInfo.defaultCryptByteBlock;
	const skipByteBlock = encryptionInfo.defaultSkipByteBlock;
	assert(cryptByteBlock !== null && skipByteBlock !== null);

	if (!sampleEncryption.subsamples) {
		// Whole-sample encryption: straightforward CBC over floor(size / 16) blocks, any trailing bytes stay clear
		const output = new Uint8Array(data);
		const numBlocks = Math.floor(data.length / 16);

		for (let b = 0; b < numBlocks; b++) {
			const off = b * 16;
			ctx.in.set(data.subarray(off, off + 16));
			ctx.decrypt();
			output.set(ctx.out, off);
		}

		return output;
	}

	if (cryptByteBlock === 0 && skipByteBlock === 0) {
		throw new Error('cbcs with subsamples requires pattern encryption.');
	}

	const output = new Uint8Array(data);

	// Pattern decryption: IV is reset at the start of each subsample. Within a subsample, the CBC chain continues
	// across skipped blocks (the IV after a crypt group carries over to the next crypt group's first block).
	const cryptRanges = collectCryptRanges(sampleEncryption.subsamples, cryptByteBlock, skipByteBlock, data.length);
	const ivView = new DataView(sampleEncryption.iv.buffer, sampleEncryption.iv.byteOffset, 16);

	for (const range of cryptRanges) {
		// Reset IV per subsample
		ctx.iv[0] = ivView.getUint32(0, false);
		ctx.iv[1] = ivView.getUint32(4, false);
		ctx.iv[2] = ivView.getUint32(8, false);
		ctx.iv[3] = ivView.getUint32(12, false);

		for (const seg of range.perSubsample) {
			// Decrypt length / 16 blocks at this offset
			const numBlocks = seg.length / 16;

			for (let b = 0; b < numBlocks; b++) {
				const offset = seg.offset + b * 16;
				ctx.in.set(data.subarray(offset, offset + 16));
				ctx.decrypt();
				output.set(ctx.out, offset);
			}
		}
	}

	return output;
};

const collectCryptRanges = (
	subsamples: { clearLen: number; protectedLen: number }[],
	cryptByteBlock: number,
	skipByteBlock: number,
	dataLength: number,
) => {
	const ranges: { perSubsample: { offset: number; length: number }[] }[] = [];
	const hasPattern = cryptByteBlock !== 0 || skipByteBlock !== 0;

	let cursor = 0;
	for (const subsample of subsamples) {
		if (cursor + subsample.clearLen + subsample.protectedLen > dataLength) {
			throw new Error('Invalid encryption info: subsamples exceed the sample size.');
		}

		cursor += subsample.clearLen;

		const perSubsample: { offset: number; length: number }[] = [];

		if (!hasPattern) {
			if (subsample.protectedLen > 0) {
				perSubsample.push({ offset: cursor, length: subsample.protectedLen });
			}
			cursor += subsample.protectedLen;
		} else {
			let remaining = subsample.protectedLen;
			let pos = cursor;
			while (remaining > 0) {
				if (remaining < 16 * cryptByteBlock) {
					break; // Partial final crypt group stays clear
				}

				const cryptBytes = 16 * cryptByteBlock;
				perSubsample.push({ offset: pos, length: cryptBytes });
				pos += cryptBytes;
				remaining -= cryptBytes;

				const skipBytes = Math.min(16 * skipByteBlock, remaining);
				pos += skipBytes;
				remaining -= skipBytes;
			}
			cursor += subsample.protectedLen;
		}

		ranges.push({ perSubsample });
	}

	return ranges;
};
