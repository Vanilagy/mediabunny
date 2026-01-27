/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractVp9CodecInfoFromPacket,
} from '../codec-data';
import {
	AacCodecInfo,
	AudioCodec,
	extractAudioCodecString,
	extractVideoCodecString,
	MediaCodec,
	OPUS_SAMPLE_RATE,
	VideoCodec,
} from '../codec';
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
import { AttachedFile, DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	isIso639Dash2LanguageCode,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	normalizeRotation,
	Rotation,
	roundIfAlmostInteger,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, EncodedPacketSideData, PLACEHOLDER_DATA } from '../packet';
import {
	assertDefinedSize,
	CODEC_STRING_MAP,
	EBMLId,
	LEVEL_0_AND_1_EBML_IDS,
	LEVEL_1_EBML_IDS,
	MAX_HEADER_SIZE,
	MIN_HEADER_SIZE,
	readAsciiString,
	readUnicodeString,
	readElementHeader,
	readElementId,
	readFloat,
	readUnsignedInt,
	readVarInt,
	resync,
	searchForNextElementId,
	readUnsignedBigInt,
} from './ebml';
import { buildMatroskaMimeType } from './matroska-misc';
import { FileSlice, readBytes, Reader, readI16Be, readU8 } from '../reader';

type Segment = {
	seekHeadSeen: boolean;
	infoSeen: boolean;
	tracksSeen: boolean;
	cuesSeen: boolean;
	attachmentsSeen: boolean;
	tagsSeen: boolean;

	timestampScale: number;
	timestampFactor: number;
	duration: number;
	seekEntries: SeekEntry[];
	tracks: InternalTrack[];
	cuePoints: CuePoint[];

	dataStartPos: number;
	elementEndPos: number | null;
	clusterSeekStartPos: number;

	/**
	 * Caches the last cluster that was read. Based on the assumption that there will be multiple reads to the
	 * same cluster in quick succession.
	 */
	lastReadCluster: Cluster | null;

	metadataTags: MetadataTags;
	metadataTagsCollected: boolean;
};

type SeekEntry = {
	id: number;
	segmentPosition: number;
};

type Cluster = {
	segment: Segment;
	elementStartPos: number;
	elementEndPos: number;
	dataStartPos: number;
	timestamp: number;
	trackData: Map<number, ClusterTrackData>;
};

type ClusterTrackData = {
	track: InternalTrack;
	startTimestamp: number;
	endTimestamp: number;
	firstKeyFrameTimestamp: number | null;
	blocks: ClusterBlock[];
	presentationTimestamps: {
		timestamp: number;
		blockIndex: number;
	}[];
};

enum BlockLacing {
	None,
	Xiph,
	FixedSize,
	Ebml,
}

type ClusterBlock = {
	timestamp: number;
	duration: number;
	isKeyFrame: boolean;
	data: Uint8Array;
	lacing: BlockLacing;
	decoded: boolean;
	mainAdditional: Uint8Array | null;
};

type CuePoint = {
	time: number;
	trackId: number;
	clusterPosition: number;
};

enum ContentEncodingScope {
	Block = 1,
	Private = 2,
	Next = 4,
}

enum ContentCompAlgo {
	Zlib,
	Bzlib,
	lzo1x,
	HeaderStripping,
}

type DecodingInstruction = {
	order: number;
	scope: ContentEncodingScope;
	data: {
		type: 'decompress';
		algorithm: ContentCompAlgo | null;
		settings: Uint8Array | null;
	} | {
		type: 'decrypt';
		// Don't store more yet since this operation is unsupported
	} | null;
};

type InternalTrack = {
	id: number;
	demuxer: MatroskaDemuxer;
	segment: Segment;
	/**
	 * List of all encountered cluster offsets alongside their timestamps. This list never gets truncated, but memory
	 * consumption should be negligible.
	 */
	clusterPositionCache: {
		elementStartPos: number;
		startTimestamp: number;
	}[];
	cuePoints: CuePoint[];

	disposition: TrackDisposition;
	inputTrack: InputTrack | null;
	codecId: string | null;
	codecPrivate: Uint8Array | null;
	defaultDuration: number | null;
	defaultDurationNs: number | null;
	name: string | null;
	languageCode: string;
	decodingInstructions: DecodingInstruction[];

	info:
		| null
		| {
			type: 'video';
			width: number;
			height: number;
			rotation: Rotation;
			codec: VideoCodec | null;
			codecDescription: Uint8Array | null;
			colorSpace: VideoColorSpaceInit | null;
			alphaMode: boolean;
		}
		| {
			type: 'audio';
			numberOfChannels: number;
			sampleRate: number;
			bitDepth: number;
			codec: AudioCodec | null;
			codecDescription: Uint8Array | null;
			aacCodecInfo: AacCodecInfo | null;
		};
};
type InternalVideoTrack = InternalTrack & { info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & { info: { type: 'audio' } };

const METADATA_ELEMENTS = [
	{ id: EBMLId.SeekHead, flag: 'seekHeadSeen' },
	{ id: EBMLId.Info, flag: 'infoSeen' },
	{ id: EBMLId.Tracks, flag: 'tracksSeen' },
	{ id: EBMLId.Cues, flag: 'cuesSeen' },
] as const;
const MAX_RESYNC_LENGTH = 10 * 2 ** 20; // 10 MiB

export class MatroskaDemuxer extends Demuxer {
	reader: Reader;

	readMetadataPromise: Promise<void> | null = null;

	segments: Segment[] = [];
	currentSegment: Segment | null = null;
	currentTrack: InternalTrack | null = null;
	currentCluster: Cluster | null = null;
	currentBlock: ClusterBlock | null = null;
	currentBlockAdditional: {
		addId: number;
		data: Uint8Array | null;
	} | null = null;

	currentCueTime: number | null = null;
	currentDecodingInstruction: DecodingInstruction | null = null;
	currentTagTargetIsMovie: boolean = true;
	currentSimpleTagName: string | null = null;
	currentAttachedFile: {
		fileUid: bigint | null;
		fileName: string | null;
		fileMediaType: string | null;
		fileData: Uint8Array | null;
		fileDescription: string | null;
	} | null = null;

	isWebM = false;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async computeDuration() {
		const tracks = await this.getTracks();
		const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(0, ...trackDurations);
	}

	async getTracks() {
		await this.readMetadata();
		return this.segments.flatMap(segment => segment.tracks.map(track => track.inputTrack!));
	}

	override async getMimeType() {
		await this.readMetadata();

		const tracks = await this.getTracks();
		const codecStrings = await Promise.all(tracks.map(x => x.getCodecParameterString()));

		return buildMatroskaMimeType({
			isWebM: this.isWebM,
			hasVideo: this.segments.some(segment => segment.tracks.some(x => x.info?.type === 'video')),
			hasAudio: this.segments.some(segment => segment.tracks.some(x => x.info?.type === 'audio')),
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	async getMetadataTags() {
		await this.readMetadata();

		// Load metadata tags from each segment lazily (only once)
		for (const segment of this.segments) {
			if (!segment.metadataTagsCollected) {
				if (this.reader.fileSize !== null) {
					await this.loadSegmentMetadata(segment);
				} else {
					// The seeking would be too crazy, let's not
				}

				segment.metadataTagsCollected = true;
			}
		}

		// This is kinda handwavy, and how we handle multiple segments isn't suuuuper well-defined anyway; so we just
		// shallow-merge metadata tags from all (usually just one) segments.
		let metadataTags: MetadataTags = {};
		for (const segment of this.segments) {
			metadataTags = { ...metadataTags, ...segment.metadataTags };
		}

		return metadataTags;
	}

	readMetadata() {
		return this.readMetadataPromise ??= (async () => {
			let currentPos = 0;

			// Loop over all top-level elements in the file
			while (true) {
				let slice = this.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
				if (slice instanceof Promise) slice = await slice;
				if (!slice) break;

				const header = readElementHeader(slice);
				if (!header) {
					break; // Zero padding at the end of the file triggers this, for example
				}

				const id = header.id;
				let size = header.size;
				const dataStartPos = slice.filePos;

				if (id === EBMLId.EBML) {
					assertDefinedSize(size);

					let slice = this.reader.requestSlice(dataStartPos, size);
					if (slice instanceof Promise) slice = await slice;
					if (!slice) break;

					this.readContiguousElements(slice);
				} else if (id === EBMLId.Segment) { // Segment found!
					await this.readSegment(dataStartPos, size);

					if (size === undefined) {
						// Segment sizes can be undefined (common in livestreamed files), so assume this is the last
						// and only segment
						break;
					}

					if (this.reader.fileSize === null) {
						break; // Stop at the first segment
					}
				} else if (id === EBMLId.Cluster) {
					if (this.reader.fileSize === null) {
						break; // Shouldn't be reached anyway, since we stop at the first segment
					}

					// Clusters are not a top-level element in Matroska, but some files contain a Segment whose size
					// doesn't contain any of the clusters that follow it. In the case, we apply the following logic: if
					// we find a top-level cluster, attribute it to the previous segment.

					if (size === undefined) {
						// Just in case this is one of those weird sizeless clusters, let's do our best and still try to
						// determine its size.
						const nextElementPos = await searchForNextElementId(
							this.reader,
							dataStartPos,
							LEVEL_0_AND_1_EBML_IDS,
							this.reader.fileSize,
						);
						size = nextElementPos.pos - dataStartPos;
					}

					const lastSegment = last(this.segments);
					if (lastSegment) {
						// Extend the previous segment's size
						lastSegment.elementEndPos = dataStartPos + size;
					}
				}

				assertDefinedSize(size);
				currentPos = dataStartPos + size;
			}
		})();
	}

	async readSegment(segmentDataStart: number, dataSize: number | undefined) {
		this.currentSegment = {
			seekHeadSeen: false,
			infoSeen: false,
			tracksSeen: false,
			cuesSeen: false,
			tagsSeen: false,
			attachmentsSeen: false,

			timestampScale: -1,
			timestampFactor: -1,
			duration: -1,
			seekEntries: [],
			tracks: [],
			cuePoints: [],

			dataStartPos: segmentDataStart,
			elementEndPos: dataSize === undefined
				? null // Assume it goes until the end of the file
				: segmentDataStart + dataSize,
			clusterSeekStartPos: segmentDataStart,

			lastReadCluster: null,

			metadataTags: {},
			metadataTagsCollected: false,
		};
		this.segments.push(this.currentSegment);

		let currentPos = segmentDataStart;

		while (this.currentSegment.elementEndPos === null || currentPos < this.currentSegment.elementEndPos) {
			let slice = this.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice) break;

			const elementStartPos = currentPos;
			const header = readElementHeader(slice);

			if (!header || (!LEVEL_1_EBML_IDS.includes(header.id) && header.id !== EBMLId.Void)) {
				// Potential junk. Let's try to resync

				const nextPos = await resync(
					this.reader,
					elementStartPos,
					LEVEL_1_EBML_IDS,
					Math.min(this.currentSegment.elementEndPos ?? Infinity, elementStartPos + MAX_RESYNC_LENGTH),
				);

				if (nextPos) {
					currentPos = nextPos;
					continue;
				} else {
					break; // Resync failed
				}
			}

			const { id, size } = header;
			const dataStartPos = slice.filePos;

			const metadataElementIndex = METADATA_ELEMENTS.findIndex(x => x.id === id);
			if (metadataElementIndex !== -1) {
				const field = METADATA_ELEMENTS[metadataElementIndex]!.flag;
				this.currentSegment[field] = true;

				assertDefinedSize(size);

				let slice = this.reader.requestSlice(dataStartPos, size);
				if (slice instanceof Promise) slice = await slice;

				if (slice) {
					this.readContiguousElements(slice);
				}
			} else if (id === EBMLId.Tags || id === EBMLId.Attachments) {
				// Metadata found at the beginning of the segment, great, let's parse it
				if (id === EBMLId.Tags) {
					this.currentSegment.tagsSeen = true;
				} else {
					this.currentSegment.attachmentsSeen = true;
				}

				assertDefinedSize(size);

				let slice = this.reader.requestSlice(dataStartPos, size);
				if (slice instanceof Promise) slice = await slice;

				if (slice) {
					this.readContiguousElements(slice);
				}
			} else if (id === EBMLId.Cluster) {
				this.currentSegment.clusterSeekStartPos = elementStartPos;
				break; // Stop at the first cluster
			}

			if (size === undefined) {
				break;
			} else {
				currentPos = dataStartPos + size;
			}
		}

		// Sort the seek entries by file position so reading them exhibits a sequential pattern
		this.currentSegment.seekEntries.sort((a, b) => a.segmentPosition - b.segmentPosition);

		if (this.reader.fileSize !== null) {
			// Use the seek head to read missing metadata elements
			for (const seekEntry of this.currentSegment.seekEntries) {
				const target = METADATA_ELEMENTS.find(x => x.id === seekEntry.id);
				if (!target) {
					continue;
				}

				if (this.currentSegment[target.flag]) continue;

				let slice = this.reader.requestSliceRange(
					segmentDataStart + seekEntry.segmentPosition,
					MIN_HEADER_SIZE,
					MAX_HEADER_SIZE,
				);
				if (slice instanceof Promise) slice = await slice;
				if (!slice) continue;

				const header = readElementHeader(slice);
				if (!header) continue;

				const { id, size } = header;
				if (id !== target.id) continue;

				assertDefinedSize(size);

				this.currentSegment[target.flag] = true;

				let dataSlice = this.reader.requestSlice(slice.filePos, size);
				if (dataSlice instanceof Promise) dataSlice = await dataSlice;
				if (!dataSlice) continue;

				this.readContiguousElements(dataSlice);
			}
		}

		if (this.currentSegment.timestampScale === -1) {
			// TimestampScale element is missing. Technically an invalid file, but let's default to the typical value,
			// which is 1e6.
			this.currentSegment.timestampScale = 1e6;
			this.currentSegment.timestampFactor = 1e9 / 1e6;
		}

		// Compute default duration for all tracks now that we have the timestamp factor
		for (const track of this.currentSegment.tracks) {
			if (track.defaultDurationNs !== null) {
				track.defaultDuration = (this.currentSegment.timestampFactor * track.defaultDurationNs) / 1e9;
			}
		}

		// Put default tracks first
		this.currentSegment.tracks.sort((a, b) => Number(b.disposition.default) - Number(a.disposition.default));

		// Now, let's distribute the cue points to the tracks
		const idToTrack = new Map(this.currentSegment.tracks.map(x => [x.id, x]));

		// Assign cue points to their respective tracks
		for (const cuePoint of this.currentSegment.cuePoints) {
			const track = idToTrack.get(cuePoint.trackId);
			if (track) {
				track.cuePoints.push(cuePoint);
			}
		}

		for (const track of this.currentSegment.tracks) {
			// Sort cue points by time
			track.cuePoints.sort((a, b) => a.time - b.time);

			// Remove multiple cue points for the same time
			for (let i = 0; i < track.cuePoints.length - 1; i++) {
				const cuePoint1 = track.cuePoints[i]!;
				const cuePoint2 = track.cuePoints[i + 1]!;

				if (cuePoint1.time === cuePoint2.time) {
					track.cuePoints.splice(i + 1, 1);
					i--;
				}
			}
		}

		let trackWithMostCuePoints: InternalTrack | null = null;
		let maxCuePointCount = -Infinity;
		for (const track of this.currentSegment.tracks) {
			if (track.cuePoints.length > maxCuePointCount) {
				maxCuePointCount = track.cuePoints.length;
				trackWithMostCuePoints = track;
			}
		}

		// For every track that has received 0 cue points (can happen, often only the video track receives cue points),
		// we still want to have better seeking. Therefore, let's give it the cue points of the track with the most cue
		// points, which should provide us with the most fine-grained seeking.
		for (const track of this.currentSegment.tracks) {
			if (track.cuePoints.length === 0) {
				track.cuePoints = trackWithMostCuePoints!.cuePoints;
			}
		}

		this.currentSegment = null;
	}

	async readCluster(startPos: number, segment: Segment) {
		if (segment.lastReadCluster?.elementStartPos === startPos) {
			return segment.lastReadCluster;
		}

		let headerSlice = this.reader.requestSliceRange(startPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
		if (headerSlice instanceof Promise) headerSlice = await headerSlice;
		assert(headerSlice);

		const elementStartPos = startPos;
		const elementHeader = readElementHeader(headerSlice);
		assert(elementHeader);

		const id = elementHeader.id;
		assert(id === EBMLId.Cluster);

		let size = elementHeader.size;
		const dataStartPos = headerSlice.filePos;

		if (size === undefined) {
			// The cluster's size is undefined (can happen in livestreamed files). We'd still like to know the size of
			// it, so we have no other choice but to iterate over the EBML structure until we find an element at level
			// 0 or 1, indicating the end of the cluster (all elements inside the cluster are at level 2).
			const nextElementPos = await searchForNextElementId(
				this.reader,
				dataStartPos,
				LEVEL_0_AND_1_EBML_IDS,
				segment.elementEndPos,
			);

			size = nextElementPos.pos - dataStartPos;
		}

		// Load the entire cluster
		let dataSlice = this.reader.requestSlice(dataStartPos, size);
		if (dataSlice instanceof Promise) dataSlice = await dataSlice;

		const cluster: Cluster = {
			segment,
			elementStartPos,
			elementEndPos: dataStartPos + size,
			dataStartPos,
			timestamp: -1,
			trackData: new Map(),
		};
		this.currentCluster = cluster;

		if (dataSlice) {
			// Read the children of the cluster, stopping early at level 0 or 1 EBML elements. We do this because some
			// clusters have incorrect sizes that are too large
			const endPos = this.readContiguousElements(dataSlice, LEVEL_0_AND_1_EBML_IDS);
			cluster.elementEndPos = endPos;
		}

		for (const [, trackData] of cluster.trackData) {
			const track = trackData.track;

			// This must hold, as track datas only get created if a block for that track is encountered
			assert(trackData.blocks.length > 0);

			let hasLacedBlocks = false;

			for (let i = 0; i < trackData.blocks.length; i++) {
				const block = trackData.blocks[i]!;
				block.timestamp += cluster.timestamp;

				hasLacedBlocks ||= block.lacing !== BlockLacing.None;
			}

			trackData.presentationTimestamps = trackData.blocks
				.map((block, i) => ({ timestamp: block.timestamp, blockIndex: i }))
				.sort((a, b) => a.timestamp - b.timestamp);

			for (let i = 0; i < trackData.presentationTimestamps.length; i++) {
				const currentEntry = trackData.presentationTimestamps[i]!;
				const currentBlock = trackData.blocks[currentEntry.blockIndex]!;

				if (trackData.firstKeyFrameTimestamp === null && currentBlock.isKeyFrame) {
					trackData.firstKeyFrameTimestamp = currentBlock.timestamp;
				}

				if (i < trackData.presentationTimestamps.length - 1) {
					// Update block durations based on presentation order
					const nextEntry = trackData.presentationTimestamps[i + 1]!;
					currentBlock.duration = nextEntry.timestamp - currentBlock.timestamp;
				} else if (currentBlock.duration === 0) {
					if (track.defaultDuration != null) {
						if (currentBlock.lacing === BlockLacing.None) {
							currentBlock.duration = track.defaultDuration;
						} else {
							// Handled by the lace resolution code
						}
					}
				}
			}

			if (hasLacedBlocks) {
				// Perform lace resolution. Here, we expand each laced block into multiple blocks where each contains
				// one frame of the lace. We do this after determining block timestamps so we can properly distribute
				// the block's duration across the laced frames.
				this.expandLacedBlocks(trackData.blocks, track);

				// Recompute since blocks have changed
				trackData.presentationTimestamps = trackData.blocks
					.map((block, i) => ({ timestamp: block.timestamp, blockIndex: i }))
					.sort((a, b) => a.timestamp - b.timestamp);
			}

			const firstBlock = trackData.blocks[trackData.presentationTimestamps[0]!.blockIndex]!;
			const lastBlock = trackData.blocks[last(trackData.presentationTimestamps)!.blockIndex]!;

			trackData.startTimestamp = firstBlock.timestamp;
			trackData.endTimestamp = lastBlock.timestamp + lastBlock.duration;

			// Let's remember that a cluster with a given timestamp is here, speeding up future lookups if no cues exist
			const insertionIndex = binarySearchLessOrEqual(
				track.clusterPositionCache,
				trackData.startTimestamp,
				x => x.startTimestamp,
			);
			if (
				insertionIndex === -1
				|| track.clusterPositionCache[insertionIndex]!.elementStartPos !== elementStartPos
			) {
				track.clusterPositionCache.splice(insertionIndex + 1, 0, {
					elementStartPos: cluster.elementStartPos,
					startTimestamp: trackData.startTimestamp,
				});
			}
		}

		segment.lastReadCluster = cluster;
		return cluster;
	}

	getTrackDataInCluster(cluster: Cluster, trackNumber: number) {
		let trackData = cluster.trackData.get(trackNumber);
		if (!trackData) {
			const track = cluster.segment.tracks.find(x => x.id === trackNumber);
			if (!track) {
				return null;
			}

			trackData = {
				track,
				startTimestamp: 0,
				endTimestamp: 0,
				firstKeyFrameTimestamp: null,
				blocks: [],
				presentationTimestamps: [],
			};
			cluster.trackData.set(trackNumber, trackData);
		}

		return trackData;
	}

	expandLacedBlocks(blocks: ClusterBlock[], track: InternalTrack) {
		// https://www.matroska.org/technical/notes.html#block-lacing

		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const originalBlock = blocks[blockIndex]!;
			if (originalBlock.lacing === BlockLacing.None) {
				continue;
			}

			// Decode the block data if it hasn't been decoded yet (needed for lacing expansion)
			if (!originalBlock.decoded) {
				originalBlock.data = this.decodeBlockData(track, originalBlock.data);
				originalBlock.decoded = true;
			}

			const slice = FileSlice.tempFromBytes(originalBlock.data);

			const frameSizes: number[] = [];
			const frameCount = readU8(slice) + 1;

			switch (originalBlock.lacing) {
				case BlockLacing.Xiph: {
					let totalUsedSize = 0;

					// Xiph lacing, just like in Ogg
					for (let i = 0; i < frameCount - 1; i++) {
						let frameSize = 0;

						while (slice.bufferPos < slice.length) {
							const value = readU8(slice);
							frameSize += value;

							if (value < 255) {
								frameSizes.push(frameSize);
								totalUsedSize += frameSize;

								break;
							}
						}
					}

					// Compute the last frame's size from whatever's left
					frameSizes.push(slice.length - (slice.bufferPos + totalUsedSize));
				}; break;

				case BlockLacing.FixedSize: {
					// Fixed size lacing: all frames have same size
					const totalDataSize = slice.length - 1; // Minus the frame count byte
					const frameSize = Math.floor(totalDataSize / frameCount);

					for (let i = 0; i < frameCount; i++) {
						frameSizes.push(frameSize);
					}
				}; break;

				case BlockLacing.Ebml: {
					// EBML lacing: first size absolute, subsequent ones are coded as signed differences from the last
					const firstResult = readVarInt(slice);
					assert(firstResult !== null); // Assume it's not an invalid VINT

					let currentSize = firstResult;
					frameSizes.push(currentSize);

					let totalUsedSize = currentSize;

					for (let i = 1; i < frameCount - 1; i++) {
						const startPos = slice.bufferPos;
						const diffResult = readVarInt(slice);
						assert(diffResult !== null);

						const unsignedDiff = diffResult;
						const width = slice.bufferPos - startPos;
						const bias = (1 << (width * 7 - 1)) - 1; // Typo-corrected version of 2^((7*n)-1)^-1
						const diff = unsignedDiff - bias;

						currentSize += diff;
						frameSizes.push(currentSize);

						totalUsedSize += currentSize;
					}

					// Compute the last frame's size from whatever's left
					frameSizes.push(slice.length - (slice.bufferPos + totalUsedSize));
				}; break;

				default: assert(false);
			}

			assert(frameSizes.length === frameCount);

			blocks.splice(blockIndex, 1); // Remove the original block

			const blockDuration = originalBlock.duration || frameCount * (track.defaultDuration ?? 0);

			// Now, let's insert each frame as its own block
			for (let i = 0; i < frameCount; i++) {
				const frameSize = frameSizes[i]!;
				const frameData = readBytes(slice, frameSize);

				// Distribute timestamps evenly across the block duration
				const frameTimestamp = originalBlock.timestamp + (blockDuration * i / frameCount);
				const frameDuration = blockDuration / frameCount;

				blocks.splice(blockIndex + i, 0, {
					timestamp: frameTimestamp,
					duration: frameDuration,
					isKeyFrame: originalBlock.isKeyFrame,
					data: frameData,
					lacing: BlockLacing.None,
					decoded: true,
					mainAdditional: originalBlock.mainAdditional,
				});
			}

			blockIndex += frameCount; // Skip the blocks we just added
			blockIndex--;
		}
	}

	async loadSegmentMetadata(segment: Segment) {
		for (const seekEntry of segment.seekEntries) {
			if (seekEntry.id === EBMLId.Tags && !segment.tagsSeen) {
				// We need to load the tags
			} else if (seekEntry.id === EBMLId.Attachments && !segment.attachmentsSeen) {
				// We need to load the attachments
			} else {
				continue;
			}

			let slice = this.reader.requestSliceRange(
				segment.dataStartPos + seekEntry.segmentPosition,
				MIN_HEADER_SIZE,
				MAX_HEADER_SIZE,
			);
			if (slice instanceof Promise) slice = await slice;
			if (!slice) continue;

			const header = readElementHeader(slice);
			if (!header || header.id !== seekEntry.id) continue;

			const { size } = header;
			assertDefinedSize(size);

			assert(!this.currentSegment);
			this.currentSegment = segment;

			let dataSlice = this.reader.requestSlice(slice.filePos, size);
			if (dataSlice instanceof Promise) dataSlice = await dataSlice;
			if (dataSlice) {
				this.readContiguousElements(dataSlice);
			}

			this.currentSegment = null;

			// Mark as seen
			if (seekEntry.id === EBMLId.Tags) {
				segment.tagsSeen = true;
			} else if (seekEntry.id === EBMLId.Attachments) {
				segment.attachmentsSeen = true;
			}
		}
	}

	readContiguousElements(slice: FileSlice, stopIds?: number[]) {
		while (slice.remainingLength >= MIN_HEADER_SIZE) {
			const startPos = slice.filePos;
			const foundElement = this.traverseElement(slice, stopIds);

			if (!foundElement) {
				return startPos;
			}
		}

		return slice.filePos;
	}

	traverseElement(slice: FileSlice, stopIds?: number[]): boolean {
		const header = readElementHeader(slice);
		if (!header) {
			return false;
		}

		if (stopIds && stopIds.includes(header.id)) {
			return false;
		}

		const { id, size } = header;
		const dataStartPos = slice.filePos;
		assertDefinedSize(size);

		switch (id) {
			case EBMLId.DocType: {
				this.isWebM = readAsciiString(slice, size) === 'webm';
			}; break;

			case EBMLId.Seek: {
				if (!this.currentSegment) break;
				const seekEntry: SeekEntry = { id: -1, segmentPosition: -1 };
				this.currentSegment.seekEntries.push(seekEntry);
				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (seekEntry.id === -1 || seekEntry.segmentPosition === -1) {
					this.currentSegment.seekEntries.pop();
				}
			}; break;

			case EBMLId.SeekID: {
				const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
				if (!lastSeekEntry) break;

				lastSeekEntry.id = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.SeekPosition: {
				const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
				if (!lastSeekEntry) break;

				lastSeekEntry.segmentPosition = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.TimestampScale: {
				if (!this.currentSegment) break;

				this.currentSegment.timestampScale = readUnsignedInt(slice, size);
				this.currentSegment.timestampFactor = 1e9 / this.currentSegment.timestampScale;
			}; break;

			case EBMLId.Duration: {
				if (!this.currentSegment) break;

				this.currentSegment.duration = readFloat(slice, size);
			}; break;

			case EBMLId.TrackEntry: {
				if (!this.currentSegment) break;

				this.currentTrack = {
					id: -1,
					segment: this.currentSegment,
					demuxer: this,
					clusterPositionCache: [],
					cuePoints: [],

					disposition: {
						...DEFAULT_TRACK_DISPOSITION,
					},
					inputTrack: null,
					codecId: null,
					codecPrivate: null,
					defaultDuration: null,
					defaultDurationNs: null,
					name: null,
					languageCode: UNDETERMINED_LANGUAGE,
					decodingInstructions: [],

					info: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));

				// Check if track was disabled during parsing (e.g., by FlagEnabled being 0)
				if (!this.currentTrack) {
					break;
				}

				if (this.currentTrack.decodingInstructions.some((instruction) => {
					return instruction.data?.type !== 'decompress'
						|| instruction.scope !== ContentEncodingScope.Block
						|| instruction.data.algorithm !== ContentCompAlgo.HeaderStripping;
				})) {
					console.warn(`Track #${this.currentTrack.id} has an unsupported content encoding; dropping.`);
					this.currentTrack = null;
				}

				if (
					this.currentTrack
					&& this.currentTrack.id !== -1
					&& this.currentTrack.codecId
					&& this.currentTrack.info
				) {
					const slashIndex = this.currentTrack.codecId.indexOf('/');
					const codecIdWithoutSuffix = slashIndex === -1
						? this.currentTrack.codecId
						: this.currentTrack.codecId.slice(0, slashIndex);

					if (
						this.currentTrack.info.type === 'video'
						&& this.currentTrack.info.width !== -1
						&& this.currentTrack.info.height !== -1
					) {
						if (this.currentTrack.codecId === CODEC_STRING_MAP.avc) {
							this.currentTrack.info.codec = 'avc';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (this.currentTrack.codecId === CODEC_STRING_MAP.hevc) {
							this.currentTrack.info.codec = 'hevc';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp8) {
							this.currentTrack.info.codec = 'vp8';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp9) {
							this.currentTrack.info.codec = 'vp9';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.av1) {
							this.currentTrack.info.codec = 'av1';
						}

						const videoTrack = this.currentTrack as InternalVideoTrack;
						const inputTrack = new InputVideoTrack(this.input, new MatroskaVideoTrackBacking(videoTrack));
						this.currentTrack.inputTrack = inputTrack;
						this.currentSegment.tracks.push(this.currentTrack);
					} else if (
						this.currentTrack.info.type === 'audio'
						&& this.currentTrack.info.numberOfChannels !== -1
						&& this.currentTrack.info.sampleRate !== -1
					) {
						if (codecIdWithoutSuffix === CODEC_STRING_MAP.aac) {
							this.currentTrack.info.codec = 'aac';
							this.currentTrack.info.aacCodecInfo = {
								isMpeg2: this.currentTrack.codecId.includes('MPEG2'),
								objectType: null,
							};
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (this.currentTrack.codecId === CODEC_STRING_MAP.mp3) {
							this.currentTrack.info.codec = 'mp3';
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.opus) {
							this.currentTrack.info.codec = 'opus';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
							this.currentTrack.info.sampleRate = OPUS_SAMPLE_RATE; // Always the same
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vorbis) {
							this.currentTrack.info.codec = 'vorbis';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.flac) {
							this.currentTrack.info.codec = 'flac';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.ac3) {
							this.currentTrack.info.codec = 'ac3';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (codecIdWithoutSuffix === CODEC_STRING_MAP.eac3) {
							this.currentTrack.info.codec = 'eac3';
							this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
						} else if (this.currentTrack.codecId === 'A_PCM/INT/LIT') {
							if (this.currentTrack.info.bitDepth === 8) {
								this.currentTrack.info.codec = 'pcm-u8';
							} else if (this.currentTrack.info.bitDepth === 16) {
								this.currentTrack.info.codec = 'pcm-s16';
							} else if (this.currentTrack.info.bitDepth === 24) {
								this.currentTrack.info.codec = 'pcm-s24';
							} else if (this.currentTrack.info.bitDepth === 32) {
								this.currentTrack.info.codec = 'pcm-s32';
							}
						} else if (this.currentTrack.codecId === 'A_PCM/INT/BIG') {
							if (this.currentTrack.info.bitDepth === 8) {
								this.currentTrack.info.codec = 'pcm-u8';
							} else if (this.currentTrack.info.bitDepth === 16) {
								this.currentTrack.info.codec = 'pcm-s16be';
							} else if (this.currentTrack.info.bitDepth === 24) {
								this.currentTrack.info.codec = 'pcm-s24be';
							} else if (this.currentTrack.info.bitDepth === 32) {
								this.currentTrack.info.codec = 'pcm-s32be';
							}
						} else if (this.currentTrack.codecId === 'A_PCM/FLOAT/IEEE') {
							if (this.currentTrack.info.bitDepth === 32) {
								this.currentTrack.info.codec = 'pcm-f32';
							} else if (this.currentTrack.info.bitDepth === 64) {
								this.currentTrack.info.codec = 'pcm-f64';
							}
						}

						const audioTrack = this.currentTrack as InternalAudioTrack;
						const inputTrack = new InputAudioTrack(this.input, new MatroskaAudioTrackBacking(audioTrack));
						this.currentTrack.inputTrack = inputTrack;
						this.currentSegment.tracks.push(this.currentTrack);
					}
				}

				this.currentTrack = null;
			}; break;

			case EBMLId.TrackNumber: {
				if (!this.currentTrack) break;

				this.currentTrack.id = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.TrackType: {
				if (!this.currentTrack) break;

				const type = readUnsignedInt(slice, size);
				if (type === 1) {
					this.currentTrack.info = {
						type: 'video',
						width: -1,
						height: -1,
						rotation: 0,
						codec: null,
						codecDescription: null,
						colorSpace: null,
						alphaMode: false,
					};
				} else if (type === 2) {
					this.currentTrack.info = {
						type: 'audio',
						numberOfChannels: -1,
						sampleRate: -1,
						bitDepth: -1,
						codec: null,
						codecDescription: null,
						aacCodecInfo: null,
					};
				}
			}; break;

			case EBMLId.FlagEnabled: {
				if (!this.currentTrack) break;

				const enabled = readUnsignedInt(slice, size);
				if (!enabled) {
					this.currentTrack = null;
				}
			}; break;

			case EBMLId.FlagDefault: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.default = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagForced: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.forced = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagOriginal: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.original = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagHearingImpaired: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.hearingImpaired = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagVisualImpaired: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.visuallyImpaired = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.FlagCommentary: {
				if (!this.currentTrack) break;

				this.currentTrack.disposition.commentary = !!readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CodecID: {
				if (!this.currentTrack) break;

				this.currentTrack.codecId = readAsciiString(slice, size);
			}; break;

			case EBMLId.CodecPrivate: {
				if (!this.currentTrack) break;

				this.currentTrack.codecPrivate = readBytes(slice, size);
			}; break;

			case EBMLId.DefaultDuration: {
				if (!this.currentTrack) break;
				this.currentTrack.defaultDurationNs = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.Name: {
				if (!this.currentTrack) break;

				this.currentTrack.name = readUnicodeString(slice, size);
			}; break;

			case EBMLId.Language: {
				if (!this.currentTrack) break;
				if (this.currentTrack.languageCode !== UNDETERMINED_LANGUAGE) {
					// LanguageBCP47 was present, which takes precedence
					break;
				}

				this.currentTrack.languageCode = readAsciiString(slice, size);

				if (!isIso639Dash2LanguageCode(this.currentTrack.languageCode)) {
					this.currentTrack.languageCode = UNDETERMINED_LANGUAGE;
				}
			}; break;

			case EBMLId.LanguageBCP47: {
				if (!this.currentTrack) break;

				const bcp47 = readAsciiString(slice, size);
				const languageSubtag = bcp47.split('-')[0];

				if (languageSubtag) {
					// Technically invalid, for now: The language subtag might be a language code from ISO 639-1,
					// ISO 639-2, ISO 639-3, ISO 639-5 or some other thing (source: Wikipedia). But, `languageCode` is
					// documented as ISO 639-2. Changing the definition would be a breaking change. This will get
					// cleaned up in the future by defining languageCode to be BCP 47 instead.
					this.currentTrack.languageCode = languageSubtag;
				} else {
					this.currentTrack.languageCode = UNDETERMINED_LANGUAGE;
				}
			}; break;

			case EBMLId.Video: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.PixelWidth: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.width = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.PixelHeight: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.height = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.AlphaMode: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.alphaMode = readUnsignedInt(slice, size) === 1;
			}; break;

			case EBMLId.Colour: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.currentTrack.info.colorSpace = {};
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.MatrixCoefficients: {
				if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace) break;

				const matrixCoefficients = readUnsignedInt(slice, size);
				const mapped = MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients] ?? null;
				this.currentTrack.info.colorSpace.matrix = mapped as VideoColorSpaceInit['matrix'];
			}; break;

			case EBMLId.Range: {
				if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace) break;

				this.currentTrack.info.colorSpace.fullRange = readUnsignedInt(slice, size) === 2;
			}; break;

			case EBMLId.TransferCharacteristics: {
				if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace) break;

				const transferCharacteristics = readUnsignedInt(slice, size);
				const mapped = TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics] ?? null;
				this.currentTrack.info.colorSpace.transfer = mapped as VideoColorSpaceInit['transfer'];
			}; break;

			case EBMLId.Primaries: {
				if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace) break;

				const primaries = readUnsignedInt(slice, size);
				const mapped = COLOR_PRIMARIES_MAP_INVERSE[primaries] ?? null;
				this.currentTrack.info.colorSpace.primaries = mapped as VideoColorSpaceInit['primaries'];
			}; break;

			case EBMLId.Projection: {
				if (this.currentTrack?.info?.type !== 'video') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.ProjectionPoseRoll: {
				if (this.currentTrack?.info?.type !== 'video') break;

				const rotation = readFloat(slice, size);
				const flippedRotation = -rotation; // Convert counter-clockwise to clockwise

				try {
					this.currentTrack.info.rotation = normalizeRotation(flippedRotation);
				} catch {
					// It wasn't a valid rotation
				}
			}; break;

			case EBMLId.Audio: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.SamplingFrequency: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				this.currentTrack.info.sampleRate = readFloat(slice, size);
			}; break;

			case EBMLId.Channels: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				this.currentTrack.info.numberOfChannels = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.BitDepth: {
				if (this.currentTrack?.info?.type !== 'audio') break;

				this.currentTrack.info.bitDepth = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CuePoint: {
				if (!this.currentSegment) break;

				this.readContiguousElements(slice.slice(dataStartPos, size));
				this.currentCueTime = null;
			}; break;

			case EBMLId.CueTime: {
				this.currentCueTime = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CueTrackPositions: {
				if (this.currentCueTime === null) break;
				assert(this.currentSegment);

				const cuePoint: CuePoint = { time: this.currentCueTime, trackId: -1, clusterPosition: -1 };
				this.currentSegment.cuePoints.push(cuePoint);
				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (cuePoint.trackId === -1 || cuePoint.clusterPosition === -1) {
					this.currentSegment.cuePoints.pop();
				}
			}; break;

			case EBMLId.CueTrack: {
				const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
				if (!lastCuePoint) break;

				lastCuePoint.trackId = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.CueClusterPosition: {
				const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
				if (!lastCuePoint) break;

				assert(this.currentSegment);
				lastCuePoint.clusterPosition = this.currentSegment.dataStartPos + readUnsignedInt(slice, size);
			}; break;

			case EBMLId.Timestamp: {
				if (!this.currentCluster) break;

				this.currentCluster.timestamp = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.SimpleBlock: {
				if (!this.currentCluster) break;

				const trackNumber = readVarInt(slice);
				if (trackNumber === null) break;

				const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
				if (!trackData) break; // Not a track we care about

				const relativeTimestamp = readI16Be(slice);

				const flags = readU8(slice);
				const lacing = (flags >> 1) & 0x3 as BlockLacing; // If the block is laced, we'll expand it later

				let isKeyFrame = !!(flags & 0x80);
				if (trackData.track.info?.type === 'audio' && trackData.track.info.codec) {
					// Some files don't mark their audio packets as key packets (I'm looking at you, Firefox). But, we
					// can fix this in most cases: if we recognize the codec of the track, then we know every packet is
					// necessarily a key packet, no matter what the container says.
					// https://github.com/Vanilagy/mediabunny/issues/192
					isKeyFrame = true;
				}

				const blockData = readBytes(slice, size - (slice.filePos - dataStartPos));
				const hasDecodingInstructions = trackData.track.decodingInstructions.length > 0;

				trackData.blocks.push({
					timestamp: relativeTimestamp, // We'll add the cluster's timestamp to this later
					duration: 0, // Will set later
					isKeyFrame,
					data: blockData,
					lacing,
					decoded: !hasDecodingInstructions,
					mainAdditional: null,
				});
			}; break;

			case EBMLId.BlockGroup: {
				if (!this.currentCluster) break;

				this.readContiguousElements(slice.slice(dataStartPos, size));

				this.currentBlock = null;
			}; break;

			case EBMLId.Block: {
				if (!this.currentCluster) break;

				const trackNumber = readVarInt(slice);
				if (trackNumber === null) break;

				const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
				if (!trackData) break;

				const relativeTimestamp = readI16Be(slice);

				const flags = readU8(slice);
				const lacing = (flags >> 1) & 0x3 as BlockLacing; // If the block is laced, we'll expand it later

				const blockData = readBytes(slice, size - (slice.filePos - dataStartPos));
				const hasDecodingInstructions = trackData.track.decodingInstructions.length > 0;

				this.currentBlock = {
					timestamp: relativeTimestamp, // We'll add the cluster's timestamp to this later
					duration: 0, // Will set later
					isKeyFrame: true,
					data: blockData,
					lacing,
					decoded: !hasDecodingInstructions,
					mainAdditional: null,
				};
				trackData.blocks.push(this.currentBlock);
			}; break;

			case EBMLId.BlockAdditions: {
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.BlockMore: {
				if (!this.currentBlock) break;

				this.currentBlockAdditional = {
					addId: 1,
					data: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (this.currentBlockAdditional.data && this.currentBlockAdditional.addId === 1) {
					this.currentBlock.mainAdditional = this.currentBlockAdditional.data;
				}
				this.currentBlockAdditional = null;
			}; break;

			case EBMLId.BlockAdditional: {
				if (!this.currentBlockAdditional) break;

				this.currentBlockAdditional.data = readBytes(slice, size);
			}; break;

			case EBMLId.BlockAddID: {
				if (!this.currentBlockAdditional) break;

				this.currentBlockAdditional.addId = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.BlockDuration: {
				if (!this.currentBlock) break;

				this.currentBlock.duration = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ReferenceBlock: {
				if (!this.currentBlock) break;

				this.currentBlock.isKeyFrame = false;
				// We ignore the actual value here, we just use the reference as an indicator for "not a key frame".
				// This is in line with FFmpeg's behavior.
			}; break;

			case EBMLId.Tag: {
				this.currentTagTargetIsMovie = true;
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.Targets: {
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.TargetTypeValue: {
				const targetTypeValue = readUnsignedInt(slice, size);
				if (targetTypeValue !== 50) {
					this.currentTagTargetIsMovie = false;
				}
			}; break;

			case EBMLId.TagTrackUID:
			case EBMLId.TagEditionUID:
			case EBMLId.TagChapterUID:
			case EBMLId.TagAttachmentUID: {
				this.currentTagTargetIsMovie = false;
			}; break;

			case EBMLId.SimpleTag: {
				if (!this.currentTagTargetIsMovie) break;

				this.currentSimpleTagName = null;
				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.TagName: {
				this.currentSimpleTagName = readUnicodeString(slice, size);
			}; break;

			case EBMLId.TagString: {
				if (!this.currentSimpleTagName) break;

				const value = readUnicodeString(slice, size);
				this.processTagValue(this.currentSimpleTagName, value);
			}; break;

			case EBMLId.TagBinary: {
				if (!this.currentSimpleTagName) break;

				const value = readBytes(slice, size);
				this.processTagValue(this.currentSimpleTagName, value);
			}; break;

			case EBMLId.AttachedFile: {
				if (!this.currentSegment) break;

				this.currentAttachedFile = {
					fileUid: null,
					fileName: null,
					fileMediaType: null,
					fileData: null,
					fileDescription: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));

				const tags = this.currentSegment.metadataTags;

				if (this.currentAttachedFile.fileUid && this.currentAttachedFile.fileData) {
					// All attached files get surfaced in the `raw` metadata tags
					tags.raw ??= {};
					tags.raw[this.currentAttachedFile.fileUid.toString()] = new AttachedFile(
						this.currentAttachedFile.fileData,
						this.currentAttachedFile.fileMediaType ?? undefined,
						this.currentAttachedFile.fileName ?? undefined,
						this.currentAttachedFile.fileDescription ?? undefined,
					);
				}

				// Only process image attachments
				if (this.currentAttachedFile.fileMediaType?.startsWith('image/') && this.currentAttachedFile.fileData) {
					const fileName = this.currentAttachedFile.fileName;
					let kind: 'coverFront' | 'coverBack' | 'unknown' = 'unknown';

					if (fileName) {
						const lowerName = fileName.toLowerCase();
						if (lowerName.startsWith('cover.')) {
							kind = 'coverFront';
						} else if (lowerName.startsWith('back.')) {
							kind = 'coverBack';
						}
					}

					tags.images ??= [];
					tags.images.push({
						data: this.currentAttachedFile.fileData,
						mimeType: this.currentAttachedFile.fileMediaType,
						kind,
						name: this.currentAttachedFile.fileName ?? undefined,
						description: this.currentAttachedFile.fileDescription ?? undefined,
					});
				}

				this.currentAttachedFile = null;
			}; break;

			case EBMLId.FileUID: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileUid = readUnsignedBigInt(slice, size);
			}; break;

			case EBMLId.FileName: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileName = readUnicodeString(slice, size);
			}; break;

			case EBMLId.FileMediaType: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileMediaType = readAsciiString(slice, size);
			}; break;

			case EBMLId.FileData: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileData = readBytes(slice, size);
			}; break;

			case EBMLId.FileDescription: {
				if (!this.currentAttachedFile) break;

				this.currentAttachedFile.fileDescription = readUnicodeString(slice, size);
			}; break;

			case EBMLId.ContentEncodings: {
				if (!this.currentTrack) break;

				this.readContiguousElements(slice.slice(dataStartPos, size));

				// "**MUST** start with the `ContentEncoding` with the highest `ContentEncodingOrder`"
				this.currentTrack.decodingInstructions.sort((a, b) => b.order - a.order);
			}; break;

			case EBMLId.ContentEncoding: {
				this.currentDecodingInstruction = {
					order: 0,
					scope: ContentEncodingScope.Block,
					data: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));

				if (this.currentDecodingInstruction.data) {
					this.currentTrack!.decodingInstructions.push(this.currentDecodingInstruction);
				}

				this.currentDecodingInstruction = null;
			}; break;

			case EBMLId.ContentEncodingOrder: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.order = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ContentEncodingScope: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.scope = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ContentCompression: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.data = {
					type: 'decompress',
					algorithm: ContentCompAlgo.Zlib,
					settings: null,
				};

				this.readContiguousElements(slice.slice(dataStartPos, size));
			}; break;

			case EBMLId.ContentCompAlgo: {
				if (this.currentDecodingInstruction?.data?.type !== 'decompress') break;

				this.currentDecodingInstruction.data.algorithm = readUnsignedInt(slice, size);
			}; break;

			case EBMLId.ContentCompSettings: {
				if (this.currentDecodingInstruction?.data?.type !== 'decompress') break;

				this.currentDecodingInstruction.data.settings = readBytes(slice, size);
			}; break;

			case EBMLId.ContentEncryption: {
				if (!this.currentDecodingInstruction) break;

				this.currentDecodingInstruction.data = {
					type: 'decrypt',
				};
			}; break;
		}

		slice.filePos = dataStartPos + size;
		return true;
	}

	decodeBlockData(track: InternalTrack, rawData: Uint8Array) {
		assert(track.decodingInstructions.length > 0); // This method shouldn't be called otherwise

		let currentData = rawData;

		for (const instruction of track.decodingInstructions) {
			assert(instruction.data);

			switch (instruction.data.type) {
				case 'decompress': {
					switch (instruction.data.algorithm) {
						case ContentCompAlgo.HeaderStripping: {
							if (instruction.data.settings && instruction.data.settings.length > 0) {
								const prefix = instruction.data.settings;
								const newData = new Uint8Array(prefix.length + currentData.length);

								newData.set(prefix, 0);
								newData.set(currentData, prefix.length);

								currentData = newData;
							}
						}; break;

						default: {
							// Unhandled
						};
					}
				}; break;

				default: {
					// Unhandled
				};
			}
		}

		return currentData;
	}

	processTagValue(name: string, value: string | Uint8Array) {
		if (!this.currentSegment?.metadataTags) return;

		const metadataTags = this.currentSegment.metadataTags;
		metadataTags.raw ??= {};
		metadataTags.raw[name] ??= value;

		if (typeof value === 'string') {
			switch (name.toLowerCase()) {
				case 'title': {
					metadataTags.title ??= value;
				}; break;

				case 'description': {
					metadataTags.description ??= value;
				}; break;

				case 'artist': {
					metadataTags.artist ??= value;
				}; break;

				case 'album': {
					metadataTags.album ??= value;
				}; break;

				case 'album_artist': {
					metadataTags.albumArtist ??= value;
				}; break;

				case 'genre': {
					metadataTags.genre ??= value;
				}; break;

				case 'comment': {
					metadataTags.comment ??= value;
				}; break;

				case 'lyrics': {
					metadataTags.lyrics ??= value;
				}; break;

				case 'date': {
					const date = new Date(value);
					if (!Number.isNaN(date.getTime())) {
						metadataTags.date ??= date;
					}
				}; break;

				case 'track_number':
				case 'part_number': {
					const parts = value.split('/');
					const trackNum = Number.parseInt(parts[0]!, 10);
					const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);

					if (Number.isInteger(trackNum) && trackNum > 0) {
						metadataTags.trackNumber ??= trackNum;
					}
					if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
						metadataTags.tracksTotal ??= tracksTotal;
					}
				}; break;

				case 'disc_number':
				case 'disc': {
					const discParts = value.split('/');
					const discNum = Number.parseInt(discParts[0]!, 10);
					const discsTotal = discParts[1] && Number.parseInt(discParts[1], 10);

					if (Number.isInteger(discNum) && discNum > 0) {
						metadataTags.discNumber ??= discNum;
					}
					if (discsTotal && Number.isInteger(discsTotal) && discsTotal > 0) {
						metadataTags.discsTotal ??= discsTotal;
					}
				}; break;
			}
		}
	}
}

abstract class MatroskaTrackBacking implements InputTrackBacking {
	packetToClusterLocation = new WeakMap<EncodedPacket, {
		cluster: Cluster;
		blockIndex: number;
	}>();

	constructor(public internalTrack: InternalTrack) {}

	getId() {
		return this.internalTrack.id;
	}

	getNumber() {
		const demuxer = this.internalTrack.demuxer;
		const inputTrack = this.internalTrack.inputTrack!;
		const trackType = inputTrack.type;

		let number = 0;
		for (const segment of demuxer.segments) {
			for (const track of segment.tracks) {
				if (track.inputTrack!.type === trackType) {
					number++;
				}

				if (track === this.internalTrack) {
					break;
				}
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.internalTrack.codecId;
	}

	async computeDuration() {
		const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
	}

	getName() {
		return this.internalTrack.name;
	}

	getLanguageCode() {
		return this.internalTrack.languageCode;
	}

	async getFirstTimestamp() {
		const firstPacket = await this.getFirstPacket({ metadataOnly: true });
		return firstPacket?.timestamp ?? 0;
	}

	getTimeResolution() {
		return this.internalTrack.segment.timestampFactor;
	}

	getDisposition() {
		return this.internalTrack.disposition;
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		return this.performClusterLookup(
			null,
			(cluster) => {
				const trackData = cluster.trackData.get(this.internalTrack.id);
				if (trackData) {
					return {
						blockIndex: 0,
						correctBlockFound: true,
					};
				}

				return {
					blockIndex: -1,
					correctBlockFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the cues
			Infinity,
			options,
		);
	}

	private intoTimescale(timestamp: number) {
		// Do a little rounding to catch cases where the result is very close to an integer. If it is, it's likely
		// that the number was originally an integer divided by the timescale. For stability, it's best
		// to return the integer in this case.
		return roundIfAlmostInteger(timestamp * this.internalTrack.segment.timestampFactor);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.intoTimescale(timestamp);

		return this.performClusterLookup(
			null,
			(cluster) => {
				const trackData = cluster.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { blockIndex: -1, correctBlockFound: false };
				}

				const index = binarySearchLessOrEqual(
					trackData.presentationTimestamps,
					timestampInTimescale,
					x => x.timestamp,
				);

				const blockIndex = index !== -1 ? trackData.presentationTimestamps[index]!.blockIndex : -1;
				const correctBlockFound = index !== -1 && timestampInTimescale < trackData.endTimestamp;

				return { blockIndex, correctBlockFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
		);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const locationInCluster = this.packetToClusterLocation.get(packet);
		if (locationInCluster === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performClusterLookup(
			locationInCluster.cluster,
			(cluster) => {
				if (cluster === locationInCluster.cluster) {
					const trackData = cluster.trackData.get(this.internalTrack.id)!;
					if (locationInCluster.blockIndex + 1 < trackData.blocks.length) {
						// We can simply take the next block in the cluster
						return {
							blockIndex: locationInCluster.blockIndex + 1,
							correctBlockFound: true,
						};
					}
				} else {
					const trackData = cluster.trackData.get(this.internalTrack.id);
					if (trackData) {
						return {
							blockIndex: 0,
							correctBlockFound: true,
						};
					}
				}

				return {
					blockIndex: -1,
					correctBlockFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the cues
			Infinity,
			options,
		);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		const timestampInTimescale = this.intoTimescale(timestamp);

		return this.performClusterLookup(
			null,
			(cluster) => {
				const trackData = cluster.trackData.get(this.internalTrack.id);
				if (!trackData) {
					return { blockIndex: -1, correctBlockFound: false };
				}

				const index = findLastIndex(trackData.presentationTimestamps, (x) => {
					const block = trackData.blocks[x.blockIndex]!;
					return block.isKeyFrame && x.timestamp <= timestampInTimescale;
				});

				const blockIndex = index !== -1 ? trackData.presentationTimestamps[index]!.blockIndex : -1;
				const correctBlockFound = index !== -1 && timestampInTimescale < trackData.endTimestamp;

				return { blockIndex, correctBlockFound };
			},
			timestampInTimescale,
			timestampInTimescale,
			options,
		);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const locationInCluster = this.packetToClusterLocation.get(packet);
		if (locationInCluster === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		return this.performClusterLookup(
			locationInCluster.cluster,
			(cluster) => {
				if (cluster === locationInCluster.cluster) {
					const trackData = cluster.trackData.get(this.internalTrack.id)!;
					const nextKeyFrameIndex = trackData.blocks.findIndex(
						(x, i) => x.isKeyFrame && i > locationInCluster.blockIndex,
					);

					if (nextKeyFrameIndex !== -1) {
						// We can simply take the next key frame in the cluster
						return {
							blockIndex: nextKeyFrameIndex,
							correctBlockFound: true,
						};
					}
				} else {
					const trackData = cluster.trackData.get(this.internalTrack.id);
					if (trackData && trackData.firstKeyFrameTimestamp !== null) {
						const keyFrameIndex = trackData.blocks.findIndex(x => x.isKeyFrame);
						assert(keyFrameIndex !== -1); // There must be one

						return {
							blockIndex: keyFrameIndex,
							correctBlockFound: true,
						};
					}
				}

				return {
					blockIndex: -1,
					correctBlockFound: false,
				};
			},
			-Infinity, // Use -Infinity as a search timestamp to avoid using the cues
			Infinity,
			options,
		);
	}

	private async fetchPacketInCluster(cluster: Cluster, blockIndex: number, options: PacketRetrievalOptions) {
		if (blockIndex === -1) {
			return null;
		}

		const trackData = cluster.trackData.get(this.internalTrack.id)!;
		const block = trackData.blocks[blockIndex];
		assert(block);

		// Perform lazy decoding if needed
		if (!block.decoded) {
			block.data = this.internalTrack.demuxer.decodeBlockData(this.internalTrack, block.data);
			block.decoded = true;
		}

		const data = options.metadataOnly ? PLACEHOLDER_DATA : block.data;
		const timestamp = block.timestamp / this.internalTrack.segment.timestampFactor;
		const duration = block.duration / this.internalTrack.segment.timestampFactor;

		const sideData: EncodedPacketSideData = {};
		if (block.mainAdditional && this.internalTrack.info?.type === 'video' && this.internalTrack.info.alphaMode) {
			sideData.alpha = options.metadataOnly ? PLACEHOLDER_DATA : block.mainAdditional;
			sideData.alphaByteLength = block.mainAdditional.byteLength;
		}

		const packet = new EncodedPacket(
			data,
			block.isKeyFrame ? 'key' : 'delta',
			timestamp,
			duration,
			cluster.dataStartPos + blockIndex,
			block.data.byteLength,
			sideData,
		);

		this.packetToClusterLocation.set(packet, { cluster, blockIndex });

		return packet;
	}

	/** Looks for a packet in the clusters while trying to load as few clusters as possible to retrieve it. */
	private async performClusterLookup(
		// The cluster where we start looking
		startCluster: Cluster | null,
		// This function returns the best-matching block in a given cluster
		getMatchInCluster: (cluster: Cluster) => { blockIndex: number; correctBlockFound: boolean },
		// The timestamp with which we can search the lookup table
		searchTimestamp: number,
		// The timestamp for which we know the correct block will not come after it
		latestTimestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const { demuxer, segment } = this.internalTrack;

		let currentCluster: Cluster | null = null;
		let bestCluster: Cluster | null = null;
		let bestBlockIndex = -1;

		if (startCluster) {
			const { blockIndex, correctBlockFound } = getMatchInCluster(startCluster);

			if (correctBlockFound) {
				return this.fetchPacketInCluster(startCluster, blockIndex, options);
			}

			if (blockIndex !== -1) {
				bestCluster = startCluster;
				bestBlockIndex = blockIndex;
			}
		}

		// Search for a cue point; this way, we won't need to start searching from the start of the file
		// but can jump right into the correct cluster (or at least nearby).
		const cuePointIndex = binarySearchLessOrEqual(
			this.internalTrack.cuePoints,
			searchTimestamp,
			x => x.time,
		);
		const cuePoint = cuePointIndex !== -1
			? this.internalTrack.cuePoints[cuePointIndex]!
			: null;

		// Also check the position cache
		const positionCacheIndex = binarySearchLessOrEqual(
			this.internalTrack.clusterPositionCache,
			searchTimestamp,
			x => x.startTimestamp,
		);
		const positionCacheEntry = positionCacheIndex !== -1
			? this.internalTrack.clusterPositionCache[positionCacheIndex]!
			: null;

		const lookupEntryPosition = Math.max(
			cuePoint?.clusterPosition ?? 0,
			positionCacheEntry?.elementStartPos ?? 0,
		) || null;

		let currentPos: number;

		if (!startCluster) {
			currentPos = lookupEntryPosition ?? segment.clusterSeekStartPos;
		} else {
			if (lookupEntryPosition === null || startCluster.elementStartPos >= lookupEntryPosition) {
				currentPos = startCluster.elementEndPos;
				currentCluster = startCluster;
			} else {
				// Use the lookup entry
				currentPos = lookupEntryPosition;
			}
		}

		while (segment.elementEndPos === null || currentPos <= segment.elementEndPos - MIN_HEADER_SIZE) {
			if (currentCluster) {
				const trackData = currentCluster.trackData.get(this.internalTrack.id);
				if (trackData && trackData.startTimestamp > latestTimestamp) {
					// We're already past the upper bound, no need to keep searching
					break;
				}
			}

			// Load the header
			let slice = demuxer.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice) break;

			const elementStartPos = currentPos;
			const elementHeader = readElementHeader(slice);

			if (
				!elementHeader
				|| (!LEVEL_1_EBML_IDS.includes(elementHeader.id) && elementHeader.id !== EBMLId.Void)
			) {
				// There's an element here that shouldn't be here. Might be garbage. In this case, let's
				// try and resync to the next valid element.
				const nextPos = await resync(
					demuxer.reader,
					elementStartPos,
					LEVEL_1_EBML_IDS,
					Math.min(segment.elementEndPos ?? Infinity, elementStartPos + MAX_RESYNC_LENGTH),
				);

				if (nextPos) {
					currentPos = nextPos;
					continue;
				} else {
					break; // Resync failed
				}
			}

			const id = elementHeader.id;
			let size = elementHeader.size;
			const dataStartPos = slice.filePos;

			if (id === EBMLId.Cluster) {
				currentCluster = await demuxer.readCluster(elementStartPos, segment);
				// readCluster computes the proper size even if it's undefined in the header, so let's use that instead
				size = currentCluster.elementEndPos - dataStartPos;

				const { blockIndex, correctBlockFound } = getMatchInCluster(currentCluster);
				if (correctBlockFound) {
					return this.fetchPacketInCluster(currentCluster, blockIndex, options);
				}

				if (blockIndex !== -1) {
					bestCluster = currentCluster;
					bestBlockIndex = blockIndex;
				}
			}

			if (size === undefined) {
				// Undefined element size (can happen in livestreamed files). In this case, we need to do some
				// searching to determine the actual size of the element.

				assert(id !== EBMLId.Cluster); // Undefined cluster sizes are fixed further up

				// Search for the next element at level 0 or 1
				const nextElementPos = await searchForNextElementId(
					demuxer.reader,
					dataStartPos,
					LEVEL_0_AND_1_EBML_IDS,
					segment.elementEndPos,
				);

				size = nextElementPos.pos - dataStartPos;
			}

			const endPos = dataStartPos + size;
			if (segment.elementEndPos === null) {
				// Check the next element. If it's a new segment, we know this segment ends here. The new
				// segment is just ignored, since we're likely in a livestreamed file and thus only care about
				// the first segment.

				let slice = demuxer.reader.requestSliceRange(endPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
				if (slice instanceof Promise) slice = await slice;
				if (!slice) break;

				const elementId = readElementId(slice);
				if (elementId === EBMLId.Segment) {
					segment.elementEndPos = endPos; // We now know the segment's size
					break;
				}
			}

			currentPos = endPos;
		}

		// Catch faulty cue points
		if (cuePoint && (!bestCluster || bestCluster.elementStartPos < cuePoint.clusterPosition)) {
			// The cue point lied to us! We found a cue point but no cluster there that satisfied the match. In this
			// case, let's search again but using the cue point before that.
			const previousCuePoint = this.internalTrack.cuePoints[cuePointIndex - 1];
			assert(!previousCuePoint || previousCuePoint.time < cuePoint.time);

			const newSearchTimestamp = previousCuePoint?.time ?? -Infinity;
			return this.performClusterLookup(null, getMatchInCluster, newSearchTimestamp, latestTimestamp, options);
		}

		if (bestCluster) {
			// If we finished looping but didn't find a perfect match, still return the best match we found
			return this.fetchPacketInCluster(bestCluster, bestBlockIndex, options);
		}

		return null;
	}
}

class MatroskaVideoTrackBacking extends MatroskaTrackBacking implements InputVideoTrackBacking {
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
		return this.internalTrack.info.rotation;
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return {
			primaries: this.internalTrack.info.colorSpace?.primaries,
			transfer: this.internalTrack.info.colorSpace?.transfer,
			matrix: this.internalTrack.info.colorSpace?.matrix,
			fullRange: this.internalTrack.info.colorSpace?.fullRange,
		};
	}

	async canBeTransparent() {
		return this.internalTrack.info.alphaMode;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		if (!this.internalTrack.info.codec) {
			return null;
		}

		return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
			let firstPacket: EncodedPacket | null = null;
			const needsPacketForAdditionalInfo
				= this.internalTrack.info.codec === 'vp9'
					|| this.internalTrack.info.codec === 'av1'
					// Packets are in Annex B format:
					|| (this.internalTrack.info.codec === 'avc' && !this.internalTrack.info.codecDescription)
					// Packets are in Annex B format:
					|| (this.internalTrack.info.codec === 'hevc' && !this.internalTrack.info.codecDescription);

			if (needsPacketForAdditionalInfo) {
				firstPacket = await this.getFirstPacket({});
			}

			return {
				codec: extractVideoCodecString({
					width: this.internalTrack.info.width,
					height: this.internalTrack.info.height,
					codec: this.internalTrack.info.codec,
					codecDescription: this.internalTrack.info.codecDescription,
					colorSpace: this.internalTrack.info.colorSpace,
					avcType: 1, // We don't know better (or do we?) so just assume 'avc1'
					avcCodecInfo: this.internalTrack.info.codec === 'avc' && firstPacket
						? extractAvcDecoderConfigurationRecord(firstPacket.data)
						: null,
					hevcCodecInfo: this.internalTrack.info.codec === 'hevc' && firstPacket
						? extractHevcDecoderConfigurationRecord(firstPacket.data)
						: null,
					vp9CodecInfo: this.internalTrack.info.codec === 'vp9' && firstPacket
						? extractVp9CodecInfoFromPacket(firstPacket.data)
						: null,
					av1CodecInfo: this.internalTrack.info.codec === 'av1' && firstPacket
						? extractAv1CodecInfoFromPacket(firstPacket.data)
						: null,
				}),
				codedWidth: this.internalTrack.info.width,
				codedHeight: this.internalTrack.info.height,
				description: this.internalTrack.info.codecDescription ?? undefined,
				colorSpace: this.internalTrack.info.colorSpace ?? undefined,
			};
		})();
	}
}

class MatroskaAudioTrackBacking extends MatroskaTrackBacking implements InputAudioTrackBacking {
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
			codec: extractAudioCodecString({
				codec: this.internalTrack.info.codec,
				codecDescription: this.internalTrack.info.codecDescription,
				aacCodecInfo: this.internalTrack.info.aacCodecInfo,
			}),
			numberOfChannels: this.internalTrack.info.numberOfChannels,
			sampleRate: this.internalTrack.info.sampleRate,
			description: this.internalTrack.info.codecDescription ?? undefined,
		};
	}
}
