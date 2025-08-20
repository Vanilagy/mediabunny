/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AacCodecInfo,
	AudioCodec,
	extractAudioCodecString,
	extractVideoCodecString,
	MediaCodec,
	parseAacAudioSpecificConfig,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	VideoCodec,
} from '../codec';
import {
	AvcDecoderConfigurationRecord,
	HevcDecoderConfigurationRecord,
	Vp9CodecInfo,
	Av1CodecInfo,
	extractVp9CodecInfoFromPacket,
	extractAv1CodecInfoFromPacket,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	COLOR_PRIMARIES_MAP_INVERSE,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	binarySearchLessOrEqual,
	binarySearchExact,
	Rotation,
	last,
	AsyncMutex,
	findLastIndex,
	UNDETERMINED_LANGUAGE,
	TransformationMatrix,
	roundToPrecision,
	isIso639Dash2LanguageCode,
	roundToMultiple,
	normalizeRotation,
	Bitstream,
	insertSorted,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { Reader } from '../reader';
import { buildIsobmffMimeType } from './isobmff-misc';
import { IsobmffReader, MAX_BOX_HEADER_SIZE, MIN_BOX_HEADER_SIZE } from './isobmff-reader';

type InternalTrack = {
	id: number;
	demuxer: IsobmffDemuxer;
	inputTrack: InputTrack | null;
	timescale: number;
	durationInMovieTimescale: number;
	durationInMediaTimescale: number;
	rotation: Rotation;
	languageCode: string;
	sampleTableByteOffset: number;
	sampleTable: SampleTable | null;
	fragmentLookupTable: FragmentLookupTableEntry[] | null;
	currentFragmentState: FragmentTrackState | null;
	fragments: Fragment[];
	fragmentsWithKeyFrame: Fragment[];
	/** The segment durations of all edit list entries leading up to the main one (from which the offset is taken.) */
	editListPreviousSegmentDurations: number;
	/** The media time offset of the main edit list entry (with media time !== -1) */
	editListOffset: number;
} & ({
	info: null;
} | {
	info: {
		type: 'video';
		width: number;
		height: number;
		codec: VideoCodec | null;
		codecDescription: Uint8Array | null;
		colorSpace: VideoColorSpaceInit | null;
		avcCodecInfo: AvcDecoderConfigurationRecord | null;
		hevcCodecInfo: HevcDecoderConfigurationRecord | null;
		vp9CodecInfo: Vp9CodecInfo | null;
		av1CodecInfo: Av1CodecInfo | null;
	};
} | {
	info: {
		type: 'audio';
		numberOfChannels: number;
		sampleRate: number;
		codec: AudioCodec | null;
		codecDescription: Uint8Array | null;
		aacCodecInfo: AacCodecInfo | null;
	};
});

type InternalVideoTrack = InternalTrack & {	info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & {	info: { type: 'audio' } };

type SampleTable = {
	sampleTimingEntries: SampleTimingEntry[];
	sampleCompositionTimeOffsets: SampleCompositionTimeOffsetEntry[];
	sampleSizes: number[];
	keySampleIndices: number[] | null; // Samples that are keyframes
	chunkOffsets: number[];
	sampleToChunk: SampleToChunkEntry[];
	presentationTimestamps: {
		presentationTimestamp: number;
		sampleIndex: number;
	}[] | null;
	/**
	 * Provides a fast map from sample index to index in the sorted presentation timestamps array - so, a fast map from
	 * decode order to presentation order.
	 */
	presentationTimestampIndexMap: number[] | null;
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
};

type FragmentTrackState = {
	baseDataOffset: number;
	sampleDescriptionIndex: number | null;
	defaultSampleDuration: number | null;
	defaultSampleSize: number | null;
	defaultSampleFlags: number | null;
	startTimestamp: number | null;
};

type FragmentTrackData = {
	startTimestamp: number;
	endTimestamp: number;
	firstKeyFrameTimestamp: number | null;
	samples: FragmentTrackSample[];
	presentationTimestamps: {
		presentationTimestamp: number;
		sampleIndex: number;
	}[];
	startTimestampIsFinal: boolean;
};

type FragmentTrackSample = {
	presentationTimestamp: number;
	duration: number;
	byteOffset: number;
	byteSize: number;
	isKeyFrame: boolean;
};

type Fragment = {
	moofOffset: number;
	moofSize: number;
	implicitBaseDataOffset: number;
	trackData: Map<InternalTrack['id'], FragmentTrackData>;
	dataStart: number;
	dataEnd: number;
	nextFragment: Fragment | null;
	isKnownToBeFirstFragment: boolean;
};

export class IsobmffDemuxer extends Demuxer {
	metadataReader: IsobmffReader;
	currentTrack: InternalTrack | null = null;
	tracks: InternalTrack[] = [];
	metadataPromise: Promise<void> | null = null;
	movieTimescale = -1;
	movieDurationInTimescale = -1;
	isQuickTime = false;

	isFragmented = false;
	fragmentTrackDefaults: FragmentTrackDefaults[] = [];
	fragments: Fragment[] = [];
	currentFragment: Fragment | null = null;
	fragmentLookupMutex = new AsyncMutex();

	chunkReader: IsobmffReader;

	constructor(input: Input) {
		super(input);

		this.metadataReader = new IsobmffReader(input._mainReader);
		this.chunkReader = new IsobmffReader(new Reader(input.source, 64 * 2 ** 20)); // Max 64 MiB of stored chunks
	}

	override async computeDuration() {
		const tracks = await this.getTracks();
		const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(0, ...trackDurations);
	}

	override async getTracks() {
		await this.readMetadata();
		return this.tracks.map(track => track.inputTrack!);
	}

	override async getMimeType() {
		await this.readMetadata();

		const codecStrings = await Promise.all(this.tracks.map(x => x.inputTrack!.getCodecParameterString()));

		return buildIsobmffMimeType({
			isQuickTime: this.isQuickTime,
			hasVideo: this.tracks.some(x => x.info?.type === 'video'),
			hasAudio: this.tracks.some(x => x.info?.type === 'audio'),
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			const sourceSize = await this.metadataReader.reader.source.getSize();

			while (this.metadataReader.pos < sourceSize) {
				await this.metadataReader.reader.loadRange(
					this.metadataReader.pos,
					this.metadataReader.pos + MAX_BOX_HEADER_SIZE,
				);
				const startPos = this.metadataReader.pos;
				const boxInfo = this.metadataReader.readBoxHeader();

				if (boxInfo.name === 'ftyp') {
					const majorBrand = this.metadataReader.readAscii(4);
					this.isQuickTime = majorBrand === 'qt  ';
				} else if (boxInfo.name === 'moov') {
					// Found moov, load it
					await this.metadataReader.reader.loadRange(
						this.metadataReader.pos,
						this.metadataReader.pos + boxInfo.contentSize,
					);
					this.readContiguousBoxes(boxInfo.contentSize);

					for (const track of this.tracks) {
						// Modify the edit list offset based on the previous segment durations. They are in different
						// timescales, so we first convert to seconds and then into the track timescale.
						const previousSegmentDurationsInSeconds
							= track.editListPreviousSegmentDurations / this.movieTimescale;
						track.editListOffset -= Math.round(previousSegmentDurationsInSeconds * track.timescale);
					}

					break;
				}

				this.metadataReader.pos = startPos + boxInfo.totalSize;
			}

			if (this.isFragmented) {
				// The last 4 bytes may contain the size of the mfra box at the end of the file
				await this.metadataReader.reader.loadRange(sourceSize - 4, sourceSize);

				this.metadataReader.pos = sourceSize - 4;
				const lastWord = this.metadataReader.readU32();
				const potentialMfraPos = sourceSize - lastWord;

				if (potentialMfraPos >= 0 && potentialMfraPos < sourceSize) {
					await this.metadataReader.reader.loadRange(potentialMfraPos, sourceSize);

					this.metadataReader.pos = potentialMfraPos;
					const boxInfo = this.metadataReader.readBoxHeader();

					if (boxInfo.name === 'mfra') {
						// We found the mfra box, allowing for much better random access. Let's parse it:
						this.readContiguousBoxes(boxInfo.contentSize);
					}
				}
			}
		})();
	}

	getSampleTableForTrack(internalTrack: InternalTrack) {
		if (internalTrack.sampleTable) {
			return internalTrack.sampleTable;
		}

		const sampleTable: SampleTable = {
			sampleTimingEntries: [],
			sampleCompositionTimeOffsets: [],
			sampleSizes: [],
			keySampleIndices: null,
			chunkOffsets: [],
			sampleToChunk: [],
			presentationTimestamps: null,
			presentationTimestampIndexMap: null,
		};
		internalTrack.sampleTable = sampleTable;

		this.metadataReader.pos = internalTrack.sampleTableByteOffset;
		this.currentTrack = internalTrack;
		this.traverseBox();
		this.currentTrack = null;

		const isPcmCodec = internalTrack.info?.type === 'audio'
			&& internalTrack.info.codec
			&& (PCM_AUDIO_CODECS as readonly string[]).includes(internalTrack.info.codec);

		if (isPcmCodec && sampleTable.sampleCompositionTimeOffsets.length === 0) {
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
				const chunkCount = (nextEntry ? nextEntry.startChunkIndex : sampleTable.chunkOffsets.length)
					- chunkEntry.startChunkIndex;

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
							startIndex: chunkEntry.startChunkIndex + j,
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

				chunkEntry.startSampleIndex = chunkEntry.startChunkIndex;
				chunkEntry.samplesPerChunk = 1;
			}

			sampleTable.sampleTimingEntries = newSampleTimingEntries;
			sampleTable.sampleSizes = newSampleSizes;
		}

		if (sampleTable.sampleCompositionTimeOffsets.length > 0) {
			// If composition time offsets are defined, we must build a list of all presentation timestamps and then
			// sort them
			sampleTable.presentationTimestamps = [];

			for (const entry of sampleTable.sampleTimingEntries) {
				for (let i = 0; i < entry.count; i++) {
					sampleTable.presentationTimestamps.push({
						presentationTimestamp: entry.startDecodeTimestamp + i * entry.delta,
						sampleIndex: entry.startIndex + i,
					});
				}
			}

			for (const entry of sampleTable.sampleCompositionTimeOffsets) {
				for (let i = 0; i < entry.count; i++) {
					const sampleIndex = entry.startIndex + i;
					const sample = sampleTable.presentationTimestamps[sampleIndex];
					if (!sample) {
						continue;
					}

					sample.presentationTimestamp += entry.offset;
				}
			}

			sampleTable.presentationTimestamps.sort((a, b) => a.presentationTimestamp - b.presentationTimestamp);

			sampleTable.presentationTimestampIndexMap = Array(sampleTable.presentationTimestamps.length).fill(-1);
			for (let i = 0; i < sampleTable.presentationTimestamps.length; i++) {
				sampleTable.presentationTimestampIndexMap[sampleTable.presentationTimestamps[i]!.sampleIndex] = i;
			}
		} else {
			// If they're not defined, we can simply use the decode timestamps as presentation timestamps
		}

		return sampleTable;
	}

	async readFragment(): Promise<Fragment> {
		const startPos = this.metadataReader.pos;

		await this.metadataReader.reader.loadRange(
			this.metadataReader.pos,
			this.metadataReader.pos + MAX_BOX_HEADER_SIZE,
		);

		const moofBoxInfo = this.metadataReader.readBoxHeader();
		assert(moofBoxInfo.name === 'moof');

		const contentStart = this.metadataReader.pos;
		await this.metadataReader.reader.loadRange(contentStart, contentStart + moofBoxInfo.contentSize);

		this.metadataReader.pos = startPos;
		this.traverseBox();

		const index = binarySearchExact(this.fragments, startPos, x => x.moofOffset);
		assert(index !== -1);

		const fragment = this.fragments[index]!;
		assert(fragment.moofOffset === startPos);

		// We have read everything in the moof box, there's no need to keep the data around anymore
		// (keep the header tho)
		this.metadataReader.reader.forgetRange(contentStart, contentStart + moofBoxInfo.contentSize);

		// It may be that some tracks don't define the base decode time, i.e. when the fragment begins. This means the
		// only other option is to sum up the duration of all previous fragments.
		for (const [trackId, trackData] of fragment.trackData) {
			if (trackData.startTimestampIsFinal) {
				continue;
			}

			const internalTrack = this.tracks.find(x => x.id === trackId)!;

			this.metadataReader.pos = 0;
			let currentFragment: Fragment | null = null;
			let lastFragment: Fragment | null = null;

			const index = binarySearchLessOrEqual(
				internalTrack.fragments,
				startPos - 1,
				x => x.moofOffset,
			);
			if (index !== -1) {
				// Instead of starting at the start of the file, let's start at the previous fragment instead (which
				// already has final timestamps).
				currentFragment = internalTrack.fragments[index]!;
				lastFragment = currentFragment;
				this.metadataReader.pos = currentFragment.moofOffset + currentFragment.moofSize;
			}

			let nextFragmentIsFirstFragment = this.metadataReader.pos === 0;

			while (this.metadataReader.pos < startPos) {
				if (currentFragment?.nextFragment) {
					currentFragment = currentFragment.nextFragment;
					this.metadataReader.pos = currentFragment.moofOffset + currentFragment.moofSize;
				} else {
					await this.metadataReader.reader.loadRange(
						this.metadataReader.pos,
						this.metadataReader.pos + MAX_BOX_HEADER_SIZE,
					);
					const startPos = this.metadataReader.pos;
					const boxInfo = this.metadataReader.readBoxHeader();

					if (boxInfo.name === 'moof') {
						const index = binarySearchExact(this.fragments, startPos, x => x.moofOffset);

						let fragment: Fragment;
						if (index === -1) {
							this.metadataReader.pos = startPos;

							fragment = await this.readFragment(); // Recursive call
						} else {
							// We already know this fragment
							fragment = this.fragments[index]!;
						}

						// Even if we already know the fragment, we might not yet know its predecessor; always do this
						if (currentFragment) currentFragment.nextFragment = fragment;
						currentFragment = fragment;

						if (nextFragmentIsFirstFragment) {
							fragment.isKnownToBeFirstFragment = true;
							nextFragmentIsFirstFragment = false;
						}
					}

					this.metadataReader.pos = startPos + boxInfo.totalSize;
				}

				if (currentFragment && currentFragment.trackData.has(trackId)) {
					lastFragment = currentFragment;
				}
			}

			if (lastFragment) {
				const otherTrackData = lastFragment.trackData.get(trackId)!;
				assert(otherTrackData.startTimestampIsFinal);

				offsetFragmentTrackDataByTimestamp(trackData, otherTrackData.endTimestamp);
			}

			trackData.startTimestampIsFinal = true;
		}

		return fragment;
	}

	readContiguousBoxes(totalSize: number) {
		const startIndex = this.metadataReader.pos;

		while (this.metadataReader.pos - startIndex <= totalSize - MIN_BOX_HEADER_SIZE) {
			this.traverseBox();
		}
	}

	traverseBox() {
		const startPos = this.metadataReader.pos;
		const boxInfo = this.metadataReader.readBoxHeader();
		const boxEndPos = startPos + boxInfo.totalSize;

		switch (boxInfo.name) {
			case 'mdia':
			case 'minf':
			case 'dinf':
			case 'mfra':
			case 'edts': {
				this.readContiguousBoxes(boxInfo.contentSize);
			}; break;

			case 'mvhd': {
				const version = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				if (version === 1) {
					this.metadataReader.pos += 8 + 8;
					this.movieTimescale = this.metadataReader.readU32();
					this.movieDurationInTimescale = this.metadataReader.readU64();
				} else {
					this.metadataReader.pos += 4 + 4;
					this.movieTimescale = this.metadataReader.readU32();
					this.movieDurationInTimescale = this.metadataReader.readU32();
				}
			}; break;

			case 'trak': {
				const track = {
					id: -1,
					demuxer: this,
					inputTrack: null,
					info: null,
					timescale: -1,
					durationInMovieTimescale: -1,
					durationInMediaTimescale: -1,
					rotation: 0,
					languageCode: UNDETERMINED_LANGUAGE,
					sampleTableByteOffset: -1,
					sampleTable: null,
					fragmentLookupTable: null,
					currentFragmentState: null,
					fragments: [],
					fragmentsWithKeyFrame: [],
					editListPreviousSegmentDurations: 0,
					editListOffset: 0,
				} satisfies InternalTrack as InternalTrack;
				this.currentTrack = track;

				this.readContiguousBoxes(boxInfo.contentSize);

				if (track.id !== -1 && track.timescale !== -1 && track.info !== null) {
					if (track.info.type === 'video' && track.info.width !== -1) {
						const videoTrack = track as InternalVideoTrack;
						track.inputTrack = new InputVideoTrack(new IsobmffVideoTrackBacking(videoTrack));
						this.tracks.push(track);
					} else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
						const audioTrack = track as InternalAudioTrack;
						track.inputTrack = new InputAudioTrack(new IsobmffAudioTrackBacking(audioTrack));
						this.tracks.push(track);
					}
				}

				this.currentTrack = null;
			}; break;

			case 'tkhd': {
				const track = this.currentTrack;
				assert(track);

				const version = this.metadataReader.readU8();
				const flags = this.metadataReader.readU24();

				const trackEnabled = (flags & 0x1) !== 0;
				if (!trackEnabled) {
					break;
				}

				// Skip over creation & modification time to reach the track ID
				if (version === 0) {
					this.metadataReader.pos += 8;
					track.id = this.metadataReader.readU32();
					this.metadataReader.pos += 4;
					track.durationInMovieTimescale = this.metadataReader.readU32();
				} else if (version === 1) {
					this.metadataReader.pos += 16;
					track.id = this.metadataReader.readU32();
					this.metadataReader.pos += 4;
					track.durationInMovieTimescale = this.metadataReader.readU64();
				} else {
					throw new Error(`Incorrect track header version ${version}.`);
				}

				this.metadataReader.pos += 2 * 4 + 2 + 2 + 2 + 2;
				const matrix: TransformationMatrix = [
					this.metadataReader.readFixed_16_16(),
					this.metadataReader.readFixed_16_16(),
					this.metadataReader.readFixed_2_30(),
					this.metadataReader.readFixed_16_16(),
					this.metadataReader.readFixed_16_16(),
					this.metadataReader.readFixed_2_30(),
					this.metadataReader.readFixed_16_16(),
					this.metadataReader.readFixed_16_16(),
					this.metadataReader.readFixed_2_30(),
				];

				const rotation = normalizeRotation(roundToMultiple(extractRotationFromMatrix(matrix), 90));
				assert(rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270);

				track.rotation = rotation;
			}; break;

			case 'elst': {
				const track = this.currentTrack;
				assert(track);

				const version = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				let relevantEntryFound = false;
				let previousSegmentDurations = 0;

				const entryCount = this.metadataReader.readU32();
				for (let i = 0; i < entryCount; i++) {
					const segmentDuration = version === 1
						? this.metadataReader.readU64()
						: this.metadataReader.readU32();
					const mediaTime = version === 1
						? this.metadataReader.readI64()
						: this.metadataReader.readI32();
					const mediaRate = this.metadataReader.readFixed_16_16();

					if (segmentDuration === 0) {
						// Don't care
						continue;
					}

					if (relevantEntryFound) {
						console.warn(
							'Unsupported edit list: multiple edits are not currently supported. Only using first edit.',
						);
						break;
					}

					if (mediaTime === -1) {
						previousSegmentDurations += segmentDuration;
						continue;
					}

					if (mediaRate !== 1) {
						console.warn('Unsupported edit list entry: media rate must be 1.');
						break;
					}

					track.editListPreviousSegmentDurations = previousSegmentDurations;
					track.editListOffset = mediaTime;
					relevantEntryFound = true;
				}
			}; break;

			case 'mdhd': {
				const track = this.currentTrack;
				assert(track);

				const version = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				if (version === 0) {
					this.metadataReader.pos += 8;
					track.timescale = this.metadataReader.readU32();
					track.durationInMediaTimescale = this.metadataReader.readU32();
				} else if (version === 1) {
					this.metadataReader.pos += 16;
					track.timescale = this.metadataReader.readU32();
					track.durationInMediaTimescale = this.metadataReader.readU64();
				}

				let language = this.metadataReader.readU16();

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
				assert(track);

				this.metadataReader.pos += 8; // Version + flags + pre-defined
				const handlerType = this.metadataReader.readAscii(4);

				if (handlerType === 'vide') {
					track.info = {
						type: 'video',
						width: -1,
						height: -1,
						codec: null,
						codecDescription: null,
						colorSpace: null,
						avcCodecInfo: null,
						hevcCodecInfo: null,
						vp9CodecInfo: null,
						av1CodecInfo: null,
					};
				} else if (handlerType === 'soun') {
					track.info = {
						type: 'audio',
						numberOfChannels: -1,
						sampleRate: -1,
						codec: null,
						codecDescription: null,
						aacCodecInfo: null,
					};
				}
			}; break;

			case 'stbl': {
				const track = this.currentTrack;
				assert(track);

				track.sampleTableByteOffset = startPos;

				this.readContiguousBoxes(boxInfo.contentSize);
			}; break;

			case 'stsd': {
				const track = this.currentTrack;
				assert(track);

				if (track.info === null || track.sampleTable) {
					break;
				}

				const stsdVersion = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				const entries = this.metadataReader.readU32();

				for (let i = 0; i < entries; i++) {
					const startPos = this.metadataReader.pos;
					const sampleBoxInfo = this.metadataReader.readBoxHeader();
					const lowercaseBoxName = sampleBoxInfo.name.toLowerCase();

					if (track.info.type === 'video') {
						if (lowercaseBoxName === 'avc1') {
							track.info.codec = 'avc';
						} else if (lowercaseBoxName === 'hvc1' || lowercaseBoxName === 'hev1') {
							track.info.codec = 'hevc';
						} else if (lowercaseBoxName === 'vp08') {
							track.info.codec = 'vp8';
						} else if (lowercaseBoxName === 'vp09') {
							track.info.codec = 'vp9';
						} else if (lowercaseBoxName === 'av01') {
							track.info.codec = 'av1';
						} else {
							console.warn(`Unsupported video codec (sample entry type '${sampleBoxInfo.name}').`);
						}

						this.metadataReader.pos += 6 * 1 + 2 + 2 + 2 + 3 * 4;

						track.info.width = this.metadataReader.readU16();
						track.info.height = this.metadataReader.readU16();

						this.metadataReader.pos += 4 + 4 + 4 + 2 + 32 + 2 + 2;

						this.readContiguousBoxes((startPos + sampleBoxInfo.totalSize) - this.metadataReader.pos);
					} else {
						if (lowercaseBoxName === 'mp4a') {
							// We don't know the codec yet (might be AAC, might be MP3), need to read the esds box
						} else if (lowercaseBoxName === 'opus') {
							track.info.codec = 'opus';
						} else if (lowercaseBoxName === 'flac') {
							track.info.codec = 'flac';
						} else if (
							lowercaseBoxName === 'twos'
							|| lowercaseBoxName === 'sowt'
							|| lowercaseBoxName === 'raw '
							|| lowercaseBoxName === 'in24'
							|| lowercaseBoxName === 'in32'
							|| lowercaseBoxName === 'fl32'
							|| lowercaseBoxName === 'fl64'
							|| lowercaseBoxName === 'lpcm'
							|| lowercaseBoxName === 'ipcm' // ISO/IEC 23003-5
							|| lowercaseBoxName === 'fpcm' // "
						) {
							// It's PCM
							// developer.apple.com/documentation/quicktime-file-format/sound_sample_descriptions/
						} else if (lowercaseBoxName === 'ulaw') {
							track.info.codec = 'ulaw';
						} else if (lowercaseBoxName === 'alaw') {
							track.info.codec = 'alaw';
						} else {
							console.warn(`Unsupported audio codec (sample entry type '${sampleBoxInfo.name}').`);
						}

						this.metadataReader.pos += 6 * 1 + 2;

						const version = this.metadataReader.readU16();
						this.metadataReader.pos += 3 * 2;

						let channelCount = this.metadataReader.readU16();
						let sampleSize = this.metadataReader.readU16();

						this.metadataReader.pos += 2 * 2;

						// Can't use fixed16_16 as that's signed
						let sampleRate = this.metadataReader.readU32() / 0x10000;

						if (stsdVersion === 0 && version > 0) {
							// Additional QuickTime fields
							if (version === 1) {
								this.metadataReader.pos += 4;
								sampleSize = 8 * this.metadataReader.readU32();
								this.metadataReader.pos += 2 * 4;
							} else if (version === 2) {
								this.metadataReader.pos += 4;
								sampleRate = this.metadataReader.readF64();
								channelCount = this.metadataReader.readU32();
								this.metadataReader.pos += 4; // Always 0x7f000000

								sampleSize = this.metadataReader.readU32();

								const flags = this.metadataReader.readU32();

								this.metadataReader.pos += 2 * 4;

								if (lowercaseBoxName === 'lpcm') {
									const bytesPerSample = (sampleSize + 7) >> 3;
									const isFloat = Boolean(flags & 1);
									const isBigEndian = Boolean(flags & 2);
									const sFlags = flags & 4 ? -1 : 0; // I guess it means "signed flags" or something?

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
										console.warn('Unsupported PCM format.');
									}
								}
							}
						}

						track.info.numberOfChannels = channelCount;
						track.info.sampleRate = sampleRate;

						// PCM codec assignments
						if (lowercaseBoxName === 'twos') {
							if (sampleSize === 8) {
								track.info.codec = 'pcm-s8';
							} else if (sampleSize === 16) {
								track.info.codec = 'pcm-s16be';
							} else {
								console.warn(`Unsupported sample size ${sampleSize} for codec 'twos'.`);
								track.info.codec = null;
							}
						} else if (lowercaseBoxName === 'sowt') {
							if (sampleSize === 8) {
								track.info.codec = 'pcm-s8';
							} else if (sampleSize === 16) {
								track.info.codec = 'pcm-s16';
							} else {
								console.warn(`Unsupported sample size ${sampleSize} for codec 'sowt'.`);
								track.info.codec = null;
							}
						} else if (lowercaseBoxName === 'raw ') {
							track.info.codec = 'pcm-u8';
						} else if (lowercaseBoxName === 'in24') {
							track.info.codec = 'pcm-s24be';
						} else if (lowercaseBoxName === 'in32') {
							track.info.codec = 'pcm-s32be';
						} else if (lowercaseBoxName === 'fl32') {
							track.info.codec = 'pcm-f32be';
						} else if (lowercaseBoxName === 'fl64') {
							track.info.codec = 'pcm-f64be';
						} else if (lowercaseBoxName === 'ipcm') {
							track.info.codec = 'pcm-s16be'; // Placeholder, will be adjusted by the pcmC box
						} else if (lowercaseBoxName === 'fpcm') {
							track.info.codec = 'pcm-f32be'; // Placeholder, will be adjusted by the pcmC box
						}

						this.readContiguousBoxes((startPos + sampleBoxInfo.totalSize) - this.metadataReader.pos);
					}
				}
			}; break;

			case 'avcC': {
				const track = this.currentTrack;
				assert(track && track.info);

				track.info.codecDescription = this.metadataReader.readBytes(boxInfo.contentSize);
			}; break;

			case 'hvcC': {
				const track = this.currentTrack;
				assert(track && track.info);

				track.info.codecDescription = this.metadataReader.readBytes(boxInfo.contentSize);
			}; break;

			case 'vpcC': {
				const track = this.currentTrack;
				assert(track && track.info?.type === 'video');

				this.metadataReader.pos += 4; // Version + flags

				const profile = this.metadataReader.readU8();
				const level = this.metadataReader.readU8();
				const thirdByte = this.metadataReader.readU8();
				const bitDepth = thirdByte >> 4;
				const chromaSubsampling = (thirdByte >> 1) & 0b111;
				const videoFullRangeFlag = thirdByte & 1;
				const colourPrimaries = this.metadataReader.readU8();
				const transferCharacteristics = this.metadataReader.readU8();
				const matrixCoefficients = this.metadataReader.readU8();

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
				assert(track && track.info?.type === 'video');

				this.metadataReader.pos += 1; // Marker + version

				const secondByte = this.metadataReader.readU8();
				const profile = secondByte >> 5;
				const level = secondByte & 0b11111;

				const thirdByte = this.metadataReader.readU8();
				const tier = thirdByte >> 7;
				const highBitDepth = (thirdByte >> 6) & 1;
				const twelveBit = (thirdByte >> 5) & 1;
				const monochrome = (thirdByte >> 4) & 1;
				const chromaSubsamplingX = (thirdByte >> 3) & 1;
				const chromaSubsamplingY = (thirdByte >> 2) & 1;
				const chromaSamplePosition = thirdByte & 0b11;

				// Logic from https://aomediacodec.github.io/av1-spec/av1-spec.pdf
				const bitDepth = profile === 2 && highBitDepth ? (twelveBit ? 12 : 10) : (highBitDepth ? 10 : 8);

				track.info.av1CodecInfo = {
					profile,
					level,
					tier,
					bitDepth,
					monochrome,
					chromaSubsamplingX,
					chromaSubsamplingY,
					chromaSamplePosition,
				};
			}; break;

			case 'colr': {
				const track = this.currentTrack;
				assert(track && track.info?.type === 'video');

				const colourType = this.metadataReader.readAscii(4);
				if (colourType !== 'nclx') {
					break;
				}

				const colourPrimaries = this.metadataReader.readU16();
				const transferCharacteristics = this.metadataReader.readU16();
				const matrixCoefficients = this.metadataReader.readU16();
				const fullRangeFlag = Boolean(this.metadataReader.readU8() & 0x80);

				track.info.colorSpace = {
					primaries: COLOR_PRIMARIES_MAP_INVERSE[colourPrimaries],
					transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics],
					matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients],
					fullRange: fullRangeFlag,
				} as VideoColorSpaceInit;
			}; break;

			case 'wave': {
				this.readContiguousBoxes(boxInfo.contentSize);
			}; break;

			case 'esds': {
				const track = this.currentTrack;
				assert(track && track.info?.type === 'audio');

				this.metadataReader.pos += 4; // Version + flags

				const tag = this.metadataReader.readU8();
				assert(tag === 0x03); // ES Descriptor

				this.metadataReader.readIsomVariableInteger(); // Length

				this.metadataReader.pos += 2; // ES ID
				const mixed = this.metadataReader.readU8();

				const streamDependenceFlag = (mixed & 0x80) !== 0;
				const urlFlag = (mixed & 0x40) !== 0;
				const ocrStreamFlag = (mixed & 0x20) !== 0;

				if (streamDependenceFlag) {
					this.metadataReader.pos += 2;
				}
				if (urlFlag) {
					const urlLength = this.metadataReader.readU8();
					this.metadataReader.pos += urlLength;
				}
				if (ocrStreamFlag) {
					this.metadataReader.pos += 2;
				}

				const decoderConfigTag = this.metadataReader.readU8();
				assert(decoderConfigTag === 0x04); // DecoderConfigDescriptor

				const decoderConfigDescriptorLength = this.metadataReader.readIsomVariableInteger(); // Length

				const payloadStart = this.metadataReader.pos;

				const objectTypeIndication = this.metadataReader.readU8();
				if (objectTypeIndication === 0x40 || objectTypeIndication === 0x67) {
					track.info.codec = 'aac';
					track.info.aacCodecInfo = { isMpeg2: objectTypeIndication === 0x67 };
				} else if (objectTypeIndication === 0x69 || objectTypeIndication === 0x6b) {
					track.info.codec = 'mp3';
				} else if (objectTypeIndication === 0xdd) {
					track.info.codec = 'vorbis'; // "nonstandard, gpac uses it" - FFmpeg
				} else {
					console.warn(
						`Unsupported audio codec (objectTypeIndication ${objectTypeIndication}) - discarding track.`,
					);
				}

				this.metadataReader.pos += 1 + 3 + 4 + 4;

				if (decoderConfigDescriptorLength > this.metadataReader.pos - payloadStart) {
					// There's a DecoderSpecificInfo at the end, let's read it

					const decoderSpecificInfoTag = this.metadataReader.readU8();
					assert(decoderSpecificInfoTag === 0x05); // DecoderSpecificInfo

					const decoderSpecificInfoLength = this.metadataReader.readIsomVariableInteger();
					track.info.codecDescription = this.metadataReader.readBytes(decoderSpecificInfoLength);

					if (track.info.codec === 'aac') {
						// Let's try to deduce more accurate values directly from the AudioSpecificConfig:
						const audioSpecificConfig = parseAacAudioSpecificConfig(track.info.codecDescription);
						if (audioSpecificConfig.numberOfChannels !== null) {
							track.info.numberOfChannels = audioSpecificConfig.numberOfChannels;
						}
						if (audioSpecificConfig.sampleRate !== null) {
							track.info.sampleRate = audioSpecificConfig.sampleRate;
						}
					}
				}
			}; break;

			case 'enda': {
				const track = this.currentTrack;
				assert(track && track.info?.type === 'audio');

				const littleEndian = this.metadataReader.readU16() & 0xff; // 0xff is from FFmpeg

				if (littleEndian) {
					if (track.info.codec === 'pcm-s16be') {
						track.info.codec = 'pcm-s16';
					} else if (track.info.codec === 'pcm-s24be') {
						track.info.codec = 'pcm-s24';
					} else if (track.info.codec === 'pcm-s32be') {
						track.info.codec = 'pcm-s32';
					} else if (track.info.codec === 'pcm-f32be') {
						track.info.codec = 'pcm-f32';
					} else if (track.info.codec === 'pcm-f64be') {
						track.info.codec = 'pcm-f64';
					}
				}
			}; break;

			case 'pcmC': {
				const track = this.currentTrack;
				assert(track && track.info?.type === 'audio');

				this.metadataReader.pos += 1 + 3; // Version + flags

				// ISO/IEC 23003-5

				const formatFlags = this.metadataReader.readU8();
				const isLittleEndian = Boolean(formatFlags & 0x01);
				const pcmSampleSize = this.metadataReader.readU8();

				if (track.info.codec === 'pcm-s16be') {
					// ipcm

					if (isLittleEndian) {
						if (pcmSampleSize === 16) {
							track.info.codec = 'pcm-s16';
						} else if (pcmSampleSize === 24) {
							track.info.codec = 'pcm-s24';
						} else if (pcmSampleSize === 32) {
							track.info.codec = 'pcm-s32';
						} else {
							console.warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
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
							console.warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
							track.info.codec = null;
						}
					}
				} else if (track.info.codec === 'pcm-f32be') {
					// fpcm

					if (isLittleEndian) {
						if (pcmSampleSize === 32) {
							track.info.codec = 'pcm-f32';
						} else if (pcmSampleSize === 64) {
							track.info.codec = 'pcm-f64';
						} else {
							console.warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
							track.info.codec = null;
						}
					} else {
						if (pcmSampleSize === 32) {
							track.info.codec = 'pcm-f32be';
						} else if (pcmSampleSize === 64) {
							track.info.codec = 'pcm-f64be';
						} else {
							console.warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
							track.info.codec = null;
						}
					}
				}

				break;
			};

			case 'dOps': { // Used for Opus audio
				const track = this.currentTrack;
				assert(track && track.info?.type === 'audio');

				this.metadataReader.pos += 1; // Version

				// https://www.opus-codec.org/docs/opus_in_isobmff.html
				const outputChannelCount = this.metadataReader.readU8();
				const preSkip = this.metadataReader.readU16();
				const inputSampleRate = this.metadataReader.readU32();
				const outputGain = this.metadataReader.readI16();
				const channelMappingFamily = this.metadataReader.readU8();

				let channelMappingTable: Uint8Array;
				if (channelMappingFamily !== 0) {
					channelMappingTable = this.metadataReader.readBytes(2 + outputChannelCount);
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
				track.info.sampleRate = inputSampleRate;
			}; break;

			case 'dfLa': { // Used for FLAC audio
				const track = this.currentTrack;
				assert(track && track.info?.type === 'audio');

				this.metadataReader.pos += 4; // Version + flags

				// https://datatracker.ietf.org/doc/rfc9639/

				const BLOCK_TYPE_MASK = 0x7f;
				const LAST_METADATA_BLOCK_FLAG_MASK = 0x80;

				const startPos = this.metadataReader.pos;

				while (this.metadataReader.pos < boxEndPos) {
					const flagAndType = this.metadataReader.readU8();
					const metadataBlockLength = this.metadataReader.readU24();
					const type = flagAndType & BLOCK_TYPE_MASK;

					// It's a STREAMINFO block; let's extract the actual sample rate and channel count
					if (type === 0) {
						this.metadataReader.pos += 10;

						// Extract sample rate
						const word = this.metadataReader.readU32();
						const sampleRate = word >>> 12;
						const numberOfChannels = ((word >> 9) & 0b111) + 1;

						track.info.sampleRate = sampleRate;
						track.info.numberOfChannels = numberOfChannels;

						this.metadataReader.pos += 20;
					} else {
						// Simply skip ahead to the next block
						this.metadataReader.pos += metadataBlockLength;
					}

					if (flagAndType & LAST_METADATA_BLOCK_FLAG_MASK) {
						break;
					}
				}

				const endPos = this.metadataReader.pos;
				this.metadataReader.pos = startPos;
				const bytes = this.metadataReader.readBytes(endPos - startPos);

				const description = new Uint8Array(4 + bytes.byteLength);
				const view = new DataView(description.buffer);
				view.setUint32(0, 0x664c6143, false); // 'fLaC'
				description.set(bytes, 4);

				// Set the codec description to be 'fLaC' + all metadata blocks
				track.info.codecDescription = description;
			}; break;

			case 'stts': {
				const track = this.currentTrack;
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4; // Version + flags

				const entryCount = this.metadataReader.readU32();

				let currentIndex = 0;
				let currentTimestamp = 0;

				for (let i = 0; i < entryCount; i++) {
					const sampleCount = this.metadataReader.readU32();
					const sampleDelta = this.metadataReader.readU32();

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
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 1 + 3; // Version + flags

				const entryCount = this.metadataReader.readU32();

				let sampleIndex = 0;
				for (let i = 0; i < entryCount; i++) {
					const sampleCount = this.metadataReader.readU32();
					const sampleOffset = this.metadataReader.readI32();

					track.sampleTable.sampleCompositionTimeOffsets.push({
						startIndex: sampleIndex,
						count: sampleCount,
						offset: sampleOffset,
					});

					sampleIndex += sampleCount;
				}
			}; break;

			case 'stsz': {
				const track = this.currentTrack;
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4; // Version + flags

				const sampleSize = this.metadataReader.readU32();
				const sampleCount = this.metadataReader.readU32();

				if (sampleSize === 0) {
					for (let i = 0; i < sampleCount; i++) {
						const sampleSize = this.metadataReader.readU32();
						track.sampleTable.sampleSizes.push(sampleSize);
					}
				} else {
					track.sampleTable.sampleSizes.push(sampleSize);
				}
			}; break;

			case 'stz2': {
				const track = this.currentTrack;
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4; // Version + flags
				this.metadataReader.pos += 3; // Reserved

				const fieldSize = this.metadataReader.readU8(); // in bits
				const sampleCount = this.metadataReader.readU32();

				const bytes = this.metadataReader.readBytes(Math.ceil(sampleCount * fieldSize / 8));
				const bitstream = new Bitstream(bytes);

				for (let i = 0; i < sampleCount; i++) {
					const sampleSize = bitstream.readBits(fieldSize);
					track.sampleTable.sampleSizes.push(sampleSize);
				}
			}; break;

			case 'stss': {
				const track = this.currentTrack;
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4; // Version + flags

				track.sampleTable.keySampleIndices = [];

				const entryCount = this.metadataReader.readU32();
				for (let i = 0; i < entryCount; i++) {
					const sampleIndex = this.metadataReader.readU32() - 1; // Convert to 0-indexed
					track.sampleTable.keySampleIndices.push(sampleIndex);
				}

				if (track.sampleTable.keySampleIndices[0] !== 0) {
					// Some files don't mark the first sample a key sample, which is basically almost always incorrect.
					// Here, we correct for that mistake:
					track.sampleTable.keySampleIndices.unshift(0);
				}
			}; break;

			case 'stsc': {
				const track = this.currentTrack;
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4;

				const entryCount = this.metadataReader.readU32();

				for (let i = 0; i < entryCount; i++) {
					const startChunkIndex = this.metadataReader.readU32() - 1; // Convert to 0-indexed
					const samplesPerChunk = this.metadataReader.readU32();
					const sampleDescriptionIndex = this.metadataReader.readU32();

					track.sampleTable.sampleToChunk.push({
						startSampleIndex: -1,
						startChunkIndex,
						samplesPerChunk,
						sampleDescriptionIndex,
					});
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
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4; // Version + flags

				const entryCount = this.metadataReader.readU32();

				for (let i = 0; i < entryCount; i++) {
					const chunkOffset = this.metadataReader.readU32();
					track.sampleTable.chunkOffsets.push(chunkOffset);
				}
			}; break;

			case 'co64': {
				const track = this.currentTrack;
				assert(track);

				if (!track.sampleTable) {
					break;
				}

				this.metadataReader.pos += 4; // Version + flags

				const entryCount = this.metadataReader.readU32();

				for (let i = 0; i < entryCount; i++) {
					const chunkOffset = this.metadataReader.readU64();
					track.sampleTable.chunkOffsets.push(chunkOffset);
				}
			}; break;

			case 'mvex': {
				this.isFragmented = true;
				this.readContiguousBoxes(boxInfo.contentSize);
			}; break;

			case 'mehd': {
				const version = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				const fragmentDuration = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();
				this.movieDurationInTimescale = fragmentDuration;
			}; break;

			case 'trex': {
				this.metadataReader.pos += 4; // Version + flags

				const trackId = this.metadataReader.readU32();
				const defaultSampleDescriptionIndex = this.metadataReader.readU32();
				const defaultSampleDuration = this.metadataReader.readU32();
				const defaultSampleSize = this.metadataReader.readU32();
				const defaultSampleFlags = this.metadataReader.readU32();

				// We store these separately rather than in the tracks since the tracks may not exist yet
				this.fragmentTrackDefaults.push({
					trackId,
					defaultSampleDescriptionIndex,
					defaultSampleDuration,
					defaultSampleSize,
					defaultSampleFlags,
				});
			}; break;

			case 'tfra': {
				const version = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				const trackId = this.metadataReader.readU32();
				const track = this.tracks.find(x => x.id === trackId);
				if (!track) {
					break;
				}

				track.fragmentLookupTable = [];

				const word = this.metadataReader.readU32();

				const lengthSizeOfTrafNum = (word & 0b110000) >> 4;
				const lengthSizeOfTrunNum = (word & 0b001100) >> 2;
				const lengthSizeOfSampleNum = word & 0b000011;

				const x = this.metadataReader;
				const functions = [x.readU8.bind(x), x.readU16.bind(x), x.readU24.bind(x), x.readU32.bind(x)];

				const readTrafNum = functions[lengthSizeOfTrafNum]!;
				const readTrunNum = functions[lengthSizeOfTrunNum]!;
				const readSampleNum = functions[lengthSizeOfSampleNum]!;

				const numberOfEntries = this.metadataReader.readU32();
				for (let i = 0; i < numberOfEntries; i++) {
					const time = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();
					const moofOffset = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();

					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const trafNumber = readTrafNum();
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const trunNumber = readTrunNum();
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const sampleNumber = readSampleNum();

					track.fragmentLookupTable.push({
						timestamp: time,
						moofOffset,
					});
				}
			}; break;

			case 'moof': {
				this.currentFragment = {
					moofOffset: startPos,
					moofSize: boxInfo.totalSize,
					implicitBaseDataOffset: startPos,
					trackData: new Map(),
					dataStart: Infinity,
					dataEnd: 0,
					nextFragment: null,
					isKnownToBeFirstFragment: false,
				};

				this.readContiguousBoxes(boxInfo.contentSize);

				insertSorted(this.fragments, this.currentFragment, x => x.moofOffset);

				// Compute the byte range of the sample data in this fragment, so we can load the whole fragment at once
				for (const [, trackData] of this.currentFragment.trackData) {
					const firstSample = trackData.samples[0]!;
					const lastSample = last(trackData.samples)!;

					this.currentFragment.dataStart = Math.min(
						this.currentFragment.dataStart,
						firstSample.byteOffset,
					);
					this.currentFragment.dataEnd = Math.max(
						this.currentFragment.dataEnd,
						lastSample.byteOffset + lastSample.byteSize,
					);
				}

				this.currentFragment = null;
			}; break;

			case 'traf': {
				assert(this.currentFragment);

				this.readContiguousBoxes(boxInfo.contentSize);

				// It is possible that there is no current track, for example when we don't care about the track
				// referenced in the track fragment header.
				if (this.currentTrack) {
					const trackData = this.currentFragment.trackData.get(this.currentTrack.id);
					if (trackData) {
						// We know there is sample data for this track in this fragment, so let's add it to the
						// track's fragments:
						insertSorted(this.currentTrack.fragments, this.currentFragment, x => x.moofOffset);

						const hasKeyFrame = trackData.firstKeyFrameTimestamp !== null;
						if (hasKeyFrame) {
							insertSorted(
								this.currentTrack.fragmentsWithKeyFrame,
								this.currentFragment,
								x => x.moofOffset,
							);
						}

						const { currentFragmentState } = this.currentTrack;
						assert(currentFragmentState);

						if (currentFragmentState.startTimestamp !== null) {
							offsetFragmentTrackDataByTimestamp(trackData, currentFragmentState.startTimestamp);
							trackData.startTimestampIsFinal = true;
						}
					}

					this.currentTrack.currentFragmentState = null;
					this.currentTrack = null;
				}
			}; break;

			case 'tfhd': {
				assert(this.currentFragment);

				this.metadataReader.pos += 1; // Version

				const flags = this.metadataReader.readU24();
				const baseDataOffsetPresent = Boolean(flags & 0x000001);
				const sampleDescriptionIndexPresent = Boolean(flags & 0x000002);
				const defaultSampleDurationPresent = Boolean(flags & 0x000008);
				const defaultSampleSizePresent = Boolean(flags & 0x000010);
				const defaultSampleFlagsPresent = Boolean(flags & 0x000020);
				const durationIsEmpty = Boolean(flags & 0x010000);
				const defaultBaseIsMoof = Boolean(flags & 0x020000);

				const trackId = this.metadataReader.readU32();
				const track = this.tracks.find(x => x.id === trackId);
				if (!track) {
					// We don't care about this track
					break;
				}

				const defaults = this.fragmentTrackDefaults.find(x => x.trackId === trackId);

				this.currentTrack = track;
				track.currentFragmentState = {
					baseDataOffset: this.currentFragment.implicitBaseDataOffset,
					sampleDescriptionIndex: defaults?.defaultSampleDescriptionIndex ?? null,
					defaultSampleDuration: defaults?.defaultSampleDuration ?? null,
					defaultSampleSize: defaults?.defaultSampleSize ?? null,
					defaultSampleFlags: defaults?.defaultSampleFlags ?? null,
					startTimestamp: null,
				};

				if (baseDataOffsetPresent) {
					track.currentFragmentState.baseDataOffset = this.metadataReader.readU64();
				} else if (defaultBaseIsMoof) {
					track.currentFragmentState.baseDataOffset = this.currentFragment.moofOffset;
				}
				if (sampleDescriptionIndexPresent) {
					track.currentFragmentState.sampleDescriptionIndex = this.metadataReader.readU32();
				}
				if (defaultSampleDurationPresent) {
					track.currentFragmentState.defaultSampleDuration = this.metadataReader.readU32();
				}
				if (defaultSampleSizePresent) {
					track.currentFragmentState.defaultSampleSize = this.metadataReader.readU32();
				}
				if (defaultSampleFlagsPresent) {
					track.currentFragmentState.defaultSampleFlags = this.metadataReader.readU32();
				}
				if (durationIsEmpty) {
					track.currentFragmentState.defaultSampleDuration = 0;
				}
			}; break;

			case 'tfdt': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				assert(track.currentFragmentState);

				// break;

				const version = this.metadataReader.readU8();
				this.metadataReader.pos += 3; // Flags

				const baseMediaDecodeTime = version === 0
					? this.metadataReader.readU32()
					: this.metadataReader.readU64();
				track.currentFragmentState.startTimestamp = baseMediaDecodeTime;
			}; break;

			case 'trun': {
				const track = this.currentTrack;
				if (!track) {
					break;
				}

				assert(this.currentFragment);
				assert(track.currentFragmentState);

				if (this.currentFragment.trackData.has(track.id)) {
					console.warn('Can\'t have two trun boxes for the same track in one fragment. Ignoring...');
					break;
				}

				const version = this.metadataReader.readU8();

				const flags = this.metadataReader.readU24();
				const dataOffsetPresent = Boolean(flags & 0x000001);
				const firstSampleFlagsPresent = Boolean(flags & 0x000004);
				const sampleDurationPresent = Boolean(flags & 0x000100);
				const sampleSizePresent = Boolean(flags & 0x000200);
				const sampleFlagsPresent = Boolean(flags & 0x000400);
				const sampleCompositionTimeOffsetsPresent = Boolean(flags & 0x000800);

				const sampleCount = this.metadataReader.readU32();

				let dataOffset = track.currentFragmentState.baseDataOffset;
				if (dataOffsetPresent) {
					dataOffset += this.metadataReader.readI32();
				}
				let firstSampleFlags: number | null = null;
				if (firstSampleFlagsPresent) {
					firstSampleFlags = this.metadataReader.readU32();
				}

				let currentOffset = dataOffset;

				if (sampleCount === 0) {
					// Don't associate the fragment with the track if it has no samples, this simplifies other code
					this.currentFragment.implicitBaseDataOffset = currentOffset;
					break;
				}

				let currentTimestamp = 0;

				const trackData: FragmentTrackData = {
					startTimestamp: 0,
					endTimestamp: 0,
					firstKeyFrameTimestamp: null,
					samples: [],
					presentationTimestamps: [],
					startTimestampIsFinal: false,
				};
				this.currentFragment.trackData.set(track.id, trackData);

				for (let i = 0; i < sampleCount; i++) {
					let sampleDuration: number;
					if (sampleDurationPresent) {
						sampleDuration = this.metadataReader.readU32();
					} else {
						assert(track.currentFragmentState.defaultSampleDuration !== null);
						sampleDuration = track.currentFragmentState.defaultSampleDuration;
					}

					let sampleSize: number;
					if (sampleSizePresent) {
						sampleSize = this.metadataReader.readU32();
					} else {
						assert(track.currentFragmentState.defaultSampleSize !== null);
						sampleSize = track.currentFragmentState.defaultSampleSize;
					}

					let sampleFlags: number;
					if (sampleFlagsPresent) {
						sampleFlags = this.metadataReader.readU32();
					} else {
						assert(track.currentFragmentState.defaultSampleFlags !== null);
						sampleFlags = track.currentFragmentState.defaultSampleFlags;
					}
					if (i === 0 && firstSampleFlags !== null) {
						sampleFlags = firstSampleFlags;
					}

					let sampleCompositionTimeOffset = 0;
					if (sampleCompositionTimeOffsetsPresent) {
						if (version === 0) {
							sampleCompositionTimeOffset = this.metadataReader.readU32();
						} else {
							sampleCompositionTimeOffset = this.metadataReader.readI32();
						}
					}

					const isKeyFrame = !(sampleFlags & 0x00010000);

					trackData.samples.push({
						presentationTimestamp: currentTimestamp + sampleCompositionTimeOffset,
						duration: sampleDuration,
						byteOffset: currentOffset,
						byteSize: sampleSize,
						isKeyFrame,
					});

					currentOffset += sampleSize;
					currentTimestamp += sampleDuration;
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
						currentSample.duration = nextEntry.presentationTimestamp - currentEntry.presentationTimestamp;
					}
				}

				const firstSample = trackData.samples[trackData.presentationTimestamps[0]!.sampleIndex]!;
				const lastSample = trackData.samples[last(trackData.presentationTimestamps)!.sampleIndex]!;

				trackData.startTimestamp = firstSample.presentationTimestamp;
				trackData.endTimestamp = lastSample.presentationTimestamp + lastSample.duration;

				this.currentFragment.implicitBaseDataOffset = currentOffset;
			}; break;
		}

		this.metadataReader.pos = boxEndPos;
	}
}

abstract class IsobmffTrackBacking implements InputTrackBacking {
	packetToSampleIndex = new WeakMap<EncodedPacket, number>();
	packetToFragmentLocation = new WeakMap<EncodedPacket, {
		fragment: Fragment;
		sampleIndex: number;
	}>();

	constructor(public internalTrack: InternalTrack) {}

	getId() {
		return this.internalTrack.id;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getLanguageCode() {
		return this.internalTrack.languageCode;
	}

	getTimeResolution() {
		return this.internalTrack.timescale;
	}

	async computeDuration() {
		const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
	}

	async getFirstTimestamp() {
		const firstPacket = await this.getFirstPacket({ metadataOnly: true });
		return firstPacket?.timestamp ?? 0;
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		const regularPacket = await this.fetchPacketForSampleIndex(0, options);
		if (regularPacket || !this.internalTrack.demuxer.isFragmented) {
			// If there's a non-fragmented packet, always prefer that
			return regularPacket;
		}

		return this.performFragmentedLookup(
			() => {
				const startFragment = this.internalTrack.demuxer.fragments[0] ?? null;
				if (startFragment?.isKnownToBeFirstFragment) {
					// Walk from the very first fragment in the file until we find one with our track in it
					let currentFragment: Fragment | null = startFragment;
					while (currentFragment) {
						const trackData = currentFragment.trackData.get(this.internalTrack.id);
						if (trackData) {
							return {
								fragmentIndex: binarySearchExact(
									this.internalTrack.fragments,
									currentFragment.moofOffset,
									x => x.moofOffset,
								),
								sampleIndex: 0,
								correctSampleFound: true,
							};
						}

						currentFragment = currentFragment.nextFragment;
					}
				}

				return {
					fragmentIndex: -1,
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
		return roundToPrecision(timestamp * this.internalTrack.timescale, 14) + this.internalTrack.editListOffset;
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
			() => this.findSampleInFragmentsForTimestamp(timestampInTimescale),
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

		const trackData = locationInFragment.fragment.trackData.get(this.internalTrack.id)!;

		const fragmentIndex = binarySearchExact(
			this.internalTrack.fragments,
			locationInFragment.fragment.moofOffset,
			x => x.moofOffset,
		);
		assert(fragmentIndex !== -1);

		return this.performFragmentedLookup(
			() => {
				if (locationInFragment.sampleIndex + 1 < trackData.samples.length) {
					// We can simply take the next sample in the fragment
					return {
						fragmentIndex,
						sampleIndex: locationInFragment.sampleIndex + 1,
						correctSampleFound: true,
					};
				} else {
					// Walk the list of fragments until we find the next fragment for this track
					let currentFragment = locationInFragment.fragment;
					while (currentFragment.nextFragment) {
						currentFragment = currentFragment.nextFragment;

						const trackData = currentFragment.trackData.get(this.internalTrack.id);
						if (trackData) {
							const fragmentIndex = binarySearchExact(
								this.internalTrack.fragments,
								currentFragment.moofOffset,
								x => x.moofOffset,
							);
							assert(fragmentIndex !== -1);

							return {
								fragmentIndex,
								sampleIndex: 0,
								correctSampleFound: true,
							};
						}
					}

					return {
						fragmentIndex,
						sampleIndex: -1,
						correctSampleFound: false,
					};
				}
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
			Infinity,
			options,
		);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);

		const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
		const sampleIndex = getSampleIndexForTimestamp(sampleTable, timestampInTimescale);
		const keyFrameSampleIndex = sampleIndex === -1
			? -1
			: getRelevantKeyframeIndexForSample(sampleTable, sampleIndex);
		const regularPacket = await this.fetchPacketForSampleIndex(keyFrameSampleIndex, options);

		if (!sampleTableIsEmpty(sampleTable) || !this.internalTrack.demuxer.isFragmented) {
			// Prefer the non-fragmented packet
			return regularPacket;
		}

		return this.performFragmentedLookup(
			() => this.findKeySampleInFragmentsForTimestamp(timestampInTimescale),
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

		const trackData = locationInFragment.fragment.trackData.get(this.internalTrack.id)!;

		const fragmentIndex = binarySearchExact(
			this.internalTrack.fragments,
			locationInFragment.fragment.moofOffset,
			x => x.moofOffset,
		);
		assert(fragmentIndex !== -1);

		return this.performFragmentedLookup(
			() => {
				const nextKeyFrameIndex = trackData.samples.findIndex(
					(x, i) => x.isKeyFrame && i > locationInFragment.sampleIndex,
				);

				if (nextKeyFrameIndex !== -1) {
					// We can simply take the next key frame in the fragment
					return {
						fragmentIndex,
						sampleIndex: nextKeyFrameIndex,
						correctSampleFound: true,
					};
				} else {
					// Walk the list of fragments until we find the next fragment for this track with a key frame
					let currentFragment = locationInFragment.fragment;
					while (currentFragment.nextFragment) {
						currentFragment = currentFragment.nextFragment;

						const trackData = currentFragment.trackData.get(this.internalTrack.id);
						if (trackData && trackData.firstKeyFrameTimestamp !== null) {
							const fragmentIndex = binarySearchExact(
								this.internalTrack.fragments,
								currentFragment.moofOffset,
								x => x.moofOffset,
							);
							assert(fragmentIndex !== -1);

							const keyFrameIndex = trackData.samples.findIndex(x => x.isKeyFrame);
							assert(keyFrameIndex !== -1); // There must be one

							return {
								fragmentIndex,
								sampleIndex: keyFrameIndex,
								correctSampleFound: true,
							};
						}
					}

					return {
						fragmentIndex,
						sampleIndex: -1,
						correctSampleFound: false,
					};
				}
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
			// Load the entire chunk
			await this.internalTrack.demuxer.chunkReader.reader.loadRange(
				sampleInfo.chunkOffset,
				sampleInfo.chunkOffset + sampleInfo.chunkSize,
			);

			this.internalTrack.demuxer.chunkReader.pos = sampleInfo.sampleOffset;
			data = this.internalTrack.demuxer.chunkReader.readBytes(sampleInfo.sampleSize);
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
			// Load the entire fragment
			await this.internalTrack.demuxer.chunkReader.reader.loadRange(fragment.dataStart, fragment.dataEnd);

			this.internalTrack.demuxer.chunkReader.pos = fragmentSample.byteOffset;
			data = this.internalTrack.demuxer.chunkReader.readBytes(fragmentSample.byteSize);
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

	private findSampleInFragmentsForTimestamp(timestampInTimescale: number) {
		const fragmentIndex = binarySearchLessOrEqual(
			// This array is technically not sorted by start timestamp, but for any reasonable file, it basically is.
			this.internalTrack.fragments,
			timestampInTimescale,
			x => x.trackData.get(this.internalTrack.id)!.startTimestamp,
		);
		let sampleIndex = -1;
		let correctSampleFound = false;

		if (fragmentIndex !== -1) {
			const fragment = this.internalTrack.fragments[fragmentIndex]!;
			const trackData = fragment.trackData.get(this.internalTrack.id)!;

			const index = binarySearchLessOrEqual(
				trackData.presentationTimestamps,
				timestampInTimescale,
				x => x.presentationTimestamp,
			);
			assert(index !== -1);

			sampleIndex = trackData.presentationTimestamps[index]!.sampleIndex;
			correctSampleFound = timestampInTimescale < trackData.endTimestamp;
		}

		return { fragmentIndex, sampleIndex, correctSampleFound };
	}

	private findKeySampleInFragmentsForTimestamp(timestampInTimescale: number) {
		const indexInKeyFrameFragments = binarySearchLessOrEqual(
			// This array is technically not sorted by start timestamp, but for any reasonable file, it basically is.
			this.internalTrack.fragmentsWithKeyFrame,
			timestampInTimescale,
			x => x.trackData.get(this.internalTrack.id)!.startTimestamp,
		);

		let fragmentIndex = -1;
		let sampleIndex = -1;
		let correctSampleFound = false;

		if (indexInKeyFrameFragments !== -1) {
			const fragment = this.internalTrack.fragmentsWithKeyFrame[indexInKeyFrameFragments]!;

			// Now, let's find the actual index of the fragment in the list of ALL fragments, not just key frame ones
			fragmentIndex = binarySearchExact(
				this.internalTrack.fragments,
				fragment.moofOffset,
				x => x.moofOffset,
			);
			assert(fragmentIndex !== -1);

			const trackData = fragment.trackData.get(this.internalTrack.id)!;
			const index = findLastIndex(trackData.presentationTimestamps, (x) => {
				const sample = trackData.samples[x.sampleIndex]!;
				return sample.isKeyFrame && x.presentationTimestamp <= timestampInTimescale;
			});
			assert(index !== -1); // It's a key frame fragment, so there must be a key frame

			const entry = trackData.presentationTimestamps[index]!;
			sampleIndex = entry.sampleIndex;
			correctSampleFound = timestampInTimescale < trackData.endTimestamp;
		}

		return { fragmentIndex, sampleIndex, correctSampleFound };
	}

	/** Looks for a packet in the fragments while trying to load as few fragments as possible to retrieve it. */
	private async performFragmentedLookup(
		getBestMatch: () => { fragmentIndex: number; sampleIndex: number; correctSampleFound: boolean },
		searchTimestamp: number,
		latestTimestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const demuxer = this.internalTrack.demuxer;
		const release = await demuxer.fragmentLookupMutex.acquire(); // The algorithm requires exclusivity

		try {
			const { fragmentIndex, sampleIndex, correctSampleFound } = getBestMatch();
			if (correctSampleFound) {
				// The correct sample already exists, easy path.
				const fragment = this.internalTrack.fragments[fragmentIndex]!;
				return this.fetchPacketInFragment(fragment, sampleIndex, options);
			}

			const metadataReader = demuxer.metadataReader;
			const sourceSize = await metadataReader.reader.source.getSize();

			let prevFragment: Fragment | null = null;
			let bestFragmentIndex = fragmentIndex;
			let bestSampleIndex = sampleIndex;

			// Search for a lookup entry; this way, we won't need to start searching from the start of the file
			// but can jump right into the correct fragment (or at least nearby).
			const lookupEntryIndex = this.internalTrack.fragmentLookupTable
				? binarySearchLessOrEqual(
						this.internalTrack.fragmentLookupTable,
						searchTimestamp,
						x => x.timestamp,
					)
				: -1;
			const lookupEntry = lookupEntryIndex !== -1
				? this.internalTrack.fragmentLookupTable![lookupEntryIndex]!
				: null;

			let nextFragmentIsFirstFragment = false;

			if (fragmentIndex === -1) {
				metadataReader.pos = lookupEntry?.moofOffset ?? 0;
				nextFragmentIsFirstFragment = metadataReader.pos === 0;
			} else {
				const fragment = this.internalTrack.fragments[fragmentIndex]!;

				if (!lookupEntry || fragment.moofOffset >= lookupEntry.moofOffset) {
					metadataReader.pos = fragment.moofOffset + fragment.moofSize;
					prevFragment = fragment;
				} else {
					// Use the lookup entry
					metadataReader.pos = lookupEntry.moofOffset;
				}
			}

			while (metadataReader.pos < sourceSize) {
				if (prevFragment) {
					const trackData = prevFragment.trackData.get(this.internalTrack.id);
					if (trackData && trackData.startTimestamp > latestTimestamp) {
						// We're already past the upper bound, no need to keep searching
						break;
					}

					if (prevFragment.nextFragment) {
						// Skip ahead quickly without needing to read the file again
						metadataReader.pos = prevFragment.nextFragment.moofOffset + prevFragment.nextFragment.moofSize;
						if (prevFragment.nextFragment === prevFragment) {
							// prevent infinite while loop
							break;
						}
						prevFragment = prevFragment.nextFragment;
						continue;
					}
				}

				// Load the header
				await metadataReader.reader.loadRange(metadataReader.pos, metadataReader.pos + MAX_BOX_HEADER_SIZE);
				const startPos = metadataReader.pos;
				const boxInfo = metadataReader.readBoxHeader();

				if (boxInfo.name === 'moof') {
					const index = binarySearchExact(demuxer.fragments, startPos, x => x.moofOffset);

					let fragment: Fragment;
					if (index === -1) {
						// This is the first time we've seen this fragment
						metadataReader.pos = startPos;
						fragment = await demuxer.readFragment();
					} else {
						// We already know this fragment
						fragment = demuxer.fragments[index]!;
					}

					// Even if we already know the fragment, we might not yet know its predecessor, so always do this
					if (prevFragment) prevFragment.nextFragment = fragment;
					prevFragment = fragment;

					if (nextFragmentIsFirstFragment) {
						fragment.isKnownToBeFirstFragment = true;
						nextFragmentIsFirstFragment = false;
					}

					const { fragmentIndex, sampleIndex, correctSampleFound } = getBestMatch();
					if (correctSampleFound) {
						const fragment = this.internalTrack.fragments[fragmentIndex]!;
						return this.fetchPacketInFragment(fragment, sampleIndex, options);
					}
					if (fragmentIndex !== -1) {
						bestFragmentIndex = fragmentIndex;
						bestSampleIndex = sampleIndex;
					}
				}

				metadataReader.pos = startPos + boxInfo.totalSize;
			}

			let result: EncodedPacket | null = null;
			const bestFragment = bestFragmentIndex !== -1 ? this.internalTrack.fragments[bestFragmentIndex]! : null;
			if (bestFragment) {
				// If we finished looping but didn't find a perfect match, still return the best match we found
				result = await this.fetchPacketInFragment(bestFragment, bestSampleIndex, options);
			}

			// Catch faulty lookup table entries
			if (!result && lookupEntry && (!bestFragment || bestFragment.moofOffset < lookupEntry.moofOffset)) {
				// The lookup table entry lied to us! We found a lookup entry but no fragment there that satisfied
				// the match. In this case, let's search again but using the lookup entry before that.
				const previousLookupEntry = this.internalTrack.fragmentLookupTable![lookupEntryIndex - 1];
				const newSearchTimestamp = previousLookupEntry?.timestamp ?? -Infinity;
				return this.performFragmentedLookup(getBestMatch, newSearchTimestamp, latestTimestamp, options);
			}

			return result;
		} finally {
			release();
		}
	}
}

class IsobmffVideoTrackBacking extends IsobmffTrackBacking implements InputVideoTrackBacking {
	override internalTrack: InternalVideoTrack;
	decoderConfigPromise: Promise<VideoDecoderConfig> | null = null;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
		this.internalTrack = internalTrack;
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

	getRotation() {
		return this.internalTrack.rotation;
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return {
			primaries: this.internalTrack.info.colorSpace?.primaries,
			transfer: this.internalTrack.info.colorSpace?.transfer,
			matrix: this.internalTrack.info.colorSpace?.matrix,
			fullRange: this.internalTrack.info.colorSpace?.fullRange,
		};
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
			if (this.internalTrack.info.codec === 'vp9' && !this.internalTrack.info.vp9CodecInfo) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.vp9CodecInfo = firstPacket && extractVp9CodecInfoFromPacket(firstPacket.data);
			} else if (this.internalTrack.info.codec === 'av1' && !this.internalTrack.info.av1CodecInfo) {
				const firstPacket = await this.getFirstPacket({});
				this.internalTrack.info.av1CodecInfo = firstPacket && extractAv1CodecInfoFromPacket(firstPacket.data);
			}

			return {
				codec: extractVideoCodecString(this.internalTrack.info),
				codedWidth: this.internalTrack.info.width,
				codedHeight: this.internalTrack.info.height,
				description: this.internalTrack.info.codecDescription ?? undefined,
				colorSpace: this.internalTrack.info.colorSpace ?? undefined,
			};
		})();
	}
}

class IsobmffAudioTrackBacking extends IsobmffTrackBacking implements InputAudioTrackBacking {
	override internalTrack: InternalAudioTrack;
	decoderConfig: AudioDecoderConfig | null = null;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
		this.internalTrack = internalTrack;
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

		return this.decoderConfig ??= {
			codec: extractAudioCodecString(this.internalTrack.info),
			numberOfChannels: this.internalTrack.info.numberOfChannels,
			sampleRate: this.internalTrack.info.sampleRate,
			description: this.internalTrack.info.codecDescription ?? undefined,
		};
	}
}

const getSampleIndexForTimestamp = (sampleTable: SampleTable, timescaleUnits: number) => {
	if (sampleTable.presentationTimestamps) {
		const index = binarySearchLessOrEqual(
			sampleTable.presentationTimestamps,
			timescaleUnits,
			x => x.presentationTimestamp,
		);
		if (index === -1) {
			return -1;
		}

		return sampleTable.presentationTimestamps[index]!.sampleIndex;
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
		return entry.startIndex
			+ Math.min(Math.floor((timescaleUnits - entry.startDecodeTimestamp) / entry.delta), entry.count - 1);
	}
};

type SampleInfo = {
	presentationTimestamp: number;
	duration: number;
	sampleOffset: number;
	sampleSize: number;
	chunkOffset: number;
	chunkSize: number;
	isKeyFrame: boolean;
};

const getSampleInfo = (sampleTable: SampleTable, sampleIndex: number): SampleInfo | null => {
	const timingEntryIndex = binarySearchLessOrEqual(sampleTable.sampleTimingEntries, sampleIndex, x => x.startIndex);
	const timingEntry = sampleTable.sampleTimingEntries[timingEntryIndex];
	if (!timingEntry || timingEntry.startIndex + timingEntry.count <= sampleIndex) {
		return null;
	}

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
	const chunkEntry = sampleTable.sampleToChunk[chunkEntryIndex];
	assert(chunkEntry);

	const chunkIndex = chunkEntry.startChunkIndex
		+ Math.floor((sampleIndex - chunkEntry.startSampleIndex) / chunkEntry.samplesPerChunk);
	const chunkOffset = sampleTable.chunkOffsets[chunkIndex]!;

	const startSampleIndexOfChunk = chunkEntry.startSampleIndex
		+ (chunkIndex - chunkEntry.startChunkIndex) * chunkEntry.samplesPerChunk;
	let chunkSize = 0;
	let sampleOffset = chunkOffset;

	if (sampleTable.sampleSizes.length === 1) {
		sampleOffset += sampleSize * (sampleIndex - startSampleIndexOfChunk);
		chunkSize += sampleSize * chunkEntry.samplesPerChunk;
	} else {
		for (let i = startSampleIndexOfChunk; i < startSampleIndexOfChunk + chunkEntry.samplesPerChunk; i++) {
			const sampleSize = sampleTable.sampleSizes[i]!;

			if (i < sampleIndex) {
				sampleOffset += sampleSize;
			}
			chunkSize += sampleSize;
		}
	}

	let duration = timingEntry.delta;
	if (sampleTable.presentationTimestamps) {
		// In order to accurately compute the duration, we need to take the duration to the next sample in presentation
		// order, not in decode order
		const presentationIndex = sampleTable.presentationTimestampIndexMap![sampleIndex];
		assert(presentationIndex !== undefined);

		if (presentationIndex < sampleTable.presentationTimestamps.length - 1) {
			const nextEntry = sampleTable.presentationTimestamps[presentationIndex + 1]!;
			const nextPresentationTimestamp = nextEntry.presentationTimestamp;
			duration = nextPresentationTimestamp - presentationTimestamp;
		}
	}

	return {
		presentationTimestamp,
		duration,
		sampleOffset,
		sampleSize,
		chunkOffset,
		chunkSize,
		isKeyFrame: sampleTable.keySampleIndices
			? binarySearchExact(sampleTable.keySampleIndices, sampleIndex, x => x) !== -1
			: true,
	};
};

const getRelevantKeyframeIndexForSample = (sampleTable: SampleTable, sampleIndex: number) => {
	if (!sampleTable.keySampleIndices) {
		return sampleIndex;
	}

	const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, x => x);
	return sampleTable.keySampleIndices[index] ?? -1;
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

/** Extracts the rotation component from a transformation matrix, in degrees. */
const extractRotationFromMatrix = (matrix: TransformationMatrix) => {
	const [m11, , , m21] = matrix;

	const scaleX = Math.hypot(m11, m21);

	const cosTheta = m11 / scaleX;
	const sinTheta = m21 / scaleX;

	// Invert the rotation because matrices are post-multiplied in ISOBMFF
	return -Math.atan2(sinTheta, cosTheta) * (180 / Math.PI);
};

const sampleTableIsEmpty = (sampleTable: SampleTable) => {
	return sampleTable.sampleSizes.length === 0;
};
