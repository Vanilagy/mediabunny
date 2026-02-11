/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Box, free, ftyp, IsobmffBoxWriter, mdat, mfra, moof, moov, vtta, vttc, vtte } from './isobmff-boxes';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from '../output';
import { BufferTargetWriter, Writer } from '../writer';
import { assert, computeRationalApproximation, last, promiseWithResolvers } from '../misc';
import { IsobmffOutputFormatOptions, IsobmffOutputFormat, MovOutputFormat } from '../output-format';
import { inlineTimestampRegex, SubtitleConfig, SubtitleCue, SubtitleMetadata } from '../subtitles';
import {
	aacChannelMap,
	aacFrequencyTable,
	buildAacAudioSpecificConfig,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	SubtitleCodec,
	validateAudioChunkMetadata,
	validateSubtitleMetadata,
	validateVideoChunkMetadata,
} from '../codec';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import { FileSlice } from '../reader';
import { BufferTarget } from '../target';
import { EncodedPacket, PacketType } from '../packet';
import {
	concatNalUnitsInLengthPrefixed,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	iterateNalUnitsInAnnexB,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../codec-data';
import { buildIsobmffMimeType } from './isobmff-misc';
import { MAX_BOX_HEADER_SIZE, MIN_BOX_HEADER_SIZE } from './isobmff-reader';

export const GLOBAL_TIMESCALE = 1000;
const TIMESTAMP_OFFSET = 2_082_844_800; // Seconds between Jan 1 1904 and Jan 1 1970

export type Sample = {
	timestamp: number;
	decodeTimestamp: number;
	duration: number;
	data: Uint8Array | null;
	size: number;
	type: PacketType;
	timescaleUnitsToNextSample: number;
};

type Chunk = {
	/** The lowest presentation timestamp in this chunk */
	startTimestamp: number;
	samples: Sample[];
	offset: number | null;
	// In the case of a fragmented file, this indicates the position of the moof box pointing to the data in this chunk
	moofOffset: number | null;
};

export type IsobmffTrackData = {
	muxer: IsobmffMuxer;
	timescale: number;
	samples: Sample[];
	sampleQueue: Sample[]; // For fragmented files
	timestampProcessingQueue: Sample[];

	timeToSampleTable: { sampleCount: number; sampleDelta: number }[];
	compositionTimeOffsetTable: { sampleCount: number; sampleCompositionTimeOffset: number }[];
	lastTimescaleUnits: number | null;
	lastSample: Sample | null;

	finalizedChunks: Chunk[];
	currentChunk: Chunk | null;
	compactlyCodedChunkTable: {
		firstChunk: number;
		samplesPerChunk: number;
	}[];
} & ({
	track: OutputVideoTrack;
	type: 'video';
	info: {
		width: number;
		height: number;
		decoderConfig: VideoDecoderConfig;
		/**
		 * The "Annex B transformation" involves converting the raw packet data from Annex B to
		 * "MP4" (length-prefixed) format.
		 * https://stackoverflow.com/questions/24884827
		 */
		requiresAnnexBTransformation: boolean;
	};
} | {
	track: OutputAudioTrack;
	type: 'audio';
	info: {
		numberOfChannels: number;
		sampleRate: number;
		decoderConfig: AudioDecoderConfig;
		/**
		 * The "PCM transformation" is making every sample in the sample table be exactly one PCM audio sample long.
		 * Some players expect this for PCM audio.
		 */
		requiresPcmTransformation: boolean;
		/**
		 * The "ADTS stripping" involves removing the ADTS header from each AAC packet. SOBMFF stores raw AAC data, not
		 * ADTS-wrapped data.
		 */
		requiresAdtsStripping: boolean;
		firstPacket: EncodedPacket;
	};
} | {
	track: OutputSubtitleTrack;
	type: 'subtitle';
	info: {
		config: SubtitleConfig;
	};
	lastCueEndTimestamp: number;
	cueQueue: SubtitleCue[];
	nextSourceId: number;
	cueToSourceId: WeakMap<SubtitleCue, number>;
});

export type IsobmffVideoTrackData = IsobmffTrackData & { type: 'video' };
export type IsobmffAudioTrackData = IsobmffTrackData & { type: 'audio' };
export type IsobmffSubtitleTrackData = IsobmffTrackData & { type: 'subtitle' };

export type IsobmffMetadata = {
	name?: string;
};

export const getTrackMetadata = (trackData: IsobmffTrackData) => {
	const metadata: IsobmffMetadata = {};
	const track = trackData.track as OutputTrack;

	if (track.metadata.name !== undefined) {
		metadata.name = track.metadata.name;
	}

	return metadata;
};

export const intoTimescale = (timeInSeconds: number, timescale: number, round = true) => {
	const value = timeInSeconds * timescale;
	return round ? Math.round(value) : value;
};

export class IsobmffMuxer extends Muxer {
	format: IsobmffOutputFormat;
	private writer: Writer;
	private boxWriter: IsobmffBoxWriter;
	private fastStart: NonNullable<IsobmffOutputFormatOptions['fastStart']>;
	isFragmented: boolean;

	isQuickTime: boolean;

	private auxTarget = new BufferTarget();
	private auxWriter = this.auxTarget._createWriter();
	private auxBoxWriter = new IsobmffBoxWriter(this.auxWriter);

	private mdat: Box | null = null;
	private ftypSize: number | null = null;

	trackDatas: IsobmffTrackData[] = [];
	private allTracksKnown = promiseWithResolvers();

	creationTime = Math.floor(Date.now() / 1000) + TIMESTAMP_OFFSET;
	private finalizedChunks: Chunk[] = [];

	private nextFragmentNumber = 1;
	// Only relevant for fragmented files, to make sure new fragments start with the highest timestamp seen so far
	private maxWrittenTimestamp = -Infinity;
	private minimumFragmentDuration: number;

	constructor(output: Output, format: IsobmffOutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;
		this.boxWriter = new IsobmffBoxWriter(this.writer);

		this.isQuickTime = format instanceof MovOutputFormat;

		// If the fastStart option isn't defined, enable in-memory fast start if the target is an ArrayBuffer, as the
		// memory usage remains identical
		const fastStartDefault = this.writer instanceof BufferTargetWriter ? 'in-memory' : false;
		this.fastStart = format._options.fastStart ?? fastStartDefault;
		this.isFragmented = this.fastStart === 'fragmented';

		if (this.fastStart === 'in-memory' || this.isFragmented) {
			this.writer.ensureMonotonicity = true;
		}

		this.minimumFragmentDuration = format._options.minimumFragmentDuration ?? 1;
	}

	async start() {
		const release = await this.mutex.acquire();

		const holdsAvc = this.output._tracks.some(x => x.type === 'video' && x.source._codec === 'avc');

		// Write the header
		{
			if (this.format._options.onFtyp) {
				this.writer.startTrackingWrites();
			}

			this.boxWriter.writeBox(ftyp({
				isQuickTime: this.isQuickTime,
				holdsAvc: holdsAvc,
				fragmented: this.isFragmented,
			}));

			if (this.format._options.onFtyp) {
				const { data, start } = this.writer.stopTrackingWrites();
				this.format._options.onFtyp(data, start);
			}
		}

		this.ftypSize = this.writer.getPos();

		if (this.fastStart === 'in-memory') {
			// We're write at finalization
		} else if (this.fastStart === 'reserve') {
			// Validate that all tracks have set maximumPacketCount
			for (const track of this.output._tracks) {
				if (track.metadata.maximumPacketCount === undefined) {
					throw new Error(
						'All tracks must specify maximumPacketCount in their metadata when using'
						+ ' fastStart: \'reserve\'.',
					);
				}
			}

			// We'll start writing once we know all tracks
		} else if (this.isFragmented) {
			// We write the moov box once we write out the first fragment to make sure we get the decoder configs
		} else {
			if (this.format._options.onMdat) {
				this.writer.startTrackingWrites();
			}

			this.mdat = mdat(true); // Reserve large size by default, can refine this when finalizing.
			this.boxWriter.writeBox(this.mdat);
		}

		await this.writer.flush();

		release();
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

		return buildIsobmffMimeType({
			isQuickTime: this.isQuickTime,
			hasVideo: this.trackDatas.some(x => x.type === 'video'),
			hasAudio: this.trackDatas.some(x => x.type === 'audio'),
			codecStrings,
		});
	}

	private getVideoTrackData(track: OutputVideoTrack, packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData as IsobmffVideoTrackData;
		}

		validateVideoChunkMetadata(meta);

		assert(meta);
		assert(meta.decoderConfig);

		const decoderConfig = { ...meta.decoderConfig };
		assert(decoderConfig.codedWidth !== undefined);
		assert(decoderConfig.codedHeight !== undefined);

		let requiresAnnexBTransformation = false;

		if (track.source._codec === 'avc' && !decoderConfig.description) {
			// ISOBMFF can only hold AVC in the AVCC format, not in Annex B, but the missing description indicates
			// Annex B. This means we'll need to do some converterino.

			const decoderConfigurationRecord = extractAvcDecoderConfigurationRecord(packet.data);
			if (!decoderConfigurationRecord) {
				throw new Error(
					'Couldn\'t extract an AVCDecoderConfigurationRecord from the AVC packet. Make sure the packets are'
					+ ' in Annex B format (as specified in ITU-T-REC-H.264) when not providing a description, or'
					+ ' provide a description (must be an AVCDecoderConfigurationRecord as specified in ISO 14496-15)'
					+ ' and ensure the packets are in AVCC format.',
				);
			}

			decoderConfig.description = serializeAvcDecoderConfigurationRecord(decoderConfigurationRecord);
			requiresAnnexBTransformation = true;
		} else if (track.source._codec === 'hevc' && !decoderConfig.description) {
			// ISOBMFF can only hold HEVC in the HEVC format, not in Annex B, but the missing description indicates
			// Annex B. This means we'll need to do some converterino.

			const decoderConfigurationRecord = extractHevcDecoderConfigurationRecord(packet.data);
			if (!decoderConfigurationRecord) {
				throw new Error(
					'Couldn\'t extract an HEVCDecoderConfigurationRecord from the HEVC packet. Make sure the packets'
					+ ' are in Annex B format (as specified in ITU-T-REC-H.265) when not providing a description, or'
					+ ' provide a description (must be an HEVCDecoderConfigurationRecord as specified in ISO 14496-15)'
					+ ' and ensure the packets are in HEVC format.',
				);
			}

			decoderConfig.description = serializeHevcDecoderConfigurationRecord(decoderConfigurationRecord);
			requiresAnnexBTransformation = true;
		}

		// The frame rate set by the user may not be an integer. Since timescale is an integer, we'll approximate the
		// frame time (inverse of frame rate) with a rational number, then use that approximation's denominator
		// as the timescale.
		const timescale = computeRationalApproximation(1 / (track.metadata.frameRate ?? 57600), 1e6).denominator;

		const newTrackData: IsobmffVideoTrackData = {
			muxer: this,
			track,
			type: 'video',
			info: {
				width: decoderConfig.codedWidth,
				height: decoderConfig.codedHeight,
				decoderConfig: decoderConfig,
				requiresAnnexBTransformation,
			},
			timescale,
			samples: [],
			sampleQueue: [],
			timestampProcessingQueue: [],
			timeToSampleTable: [],
			compositionTimeOffsetTable: [],
			lastTimescaleUnits: null,
			lastSample: null,
			finalizedChunks: [],
			currentChunk: null,
			compactlyCodedChunkTable: [],
		};

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
			return existingTrackData as IsobmffAudioTrackData;
		}

		validateAudioChunkMetadata(meta);

		assert(meta);
		assert(meta.decoderConfig);

		const decoderConfig = { ...meta.decoderConfig };
		let requiresAdtsStripping = false;

		if (track.source._codec === 'aac' && !decoderConfig.description) {
			// ISOBMFF can only hold AAC in raw format, not ADTS, but the missing description indicates ADTS.
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

		const newTrackData: IsobmffAudioTrackData = {
			muxer: this,
			track,
			type: 'audio',
			info: {
				numberOfChannels: meta.decoderConfig.numberOfChannels,
				sampleRate: meta.decoderConfig.sampleRate,
				decoderConfig,
				requiresPcmTransformation:
					!this.isFragmented
					&& (PCM_AUDIO_CODECS as readonly string[]).includes(track.source._codec),
				requiresAdtsStripping,
				firstPacket: packet,
			},
			timescale: decoderConfig.sampleRate,
			samples: [],
			sampleQueue: [],
			timestampProcessingQueue: [],
			timeToSampleTable: [],
			compositionTimeOffsetTable: [],
			lastTimescaleUnits: null,
			lastSample: null,
			finalizedChunks: [],
			currentChunk: null,
			compactlyCodedChunkTable: [],
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
			return existingTrackData as IsobmffSubtitleTrackData;
		}

		validateSubtitleMetadata(meta);

		assert(meta);
		assert(meta.config);

		const newTrackData: IsobmffSubtitleTrackData = {
			muxer: this,
			track,
			type: 'subtitle',
			info: {
				config: meta.config,
			},
			timescale: 1000, // Reasonable
			samples: [],
			sampleQueue: [],
			timestampProcessingQueue: [],
			timeToSampleTable: [],
			compositionTimeOffsetTable: [],
			lastTimescaleUnits: null,
			lastSample: null,
			finalizedChunks: [],
			currentChunk: null,
			compactlyCodedChunkTable: [],

			lastCueEndTimestamp: 0,
			cueQueue: [],
			nextSourceId: 0,
			cueToSourceId: new WeakMap(),
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

			let packetData = packet.data;
			if (trackData.info.requiresAnnexBTransformation) {
				const nalUnits = [...iterateNalUnitsInAnnexB(packetData)]
					.map(loc => packetData.subarray(loc.offset, loc.offset + loc.length));
				if (nalUnits.length === 0) {
					// It's not valid Annex B data
					throw new Error(
						'Failed to transform packet data. Make sure all packets are provided in Annex B format, as'
						+ ' specified in ITU-T-REC-H.264 and ITU-T-REC-H.265.',
					);
				}

				// We don't strip things like SPS or PPS NALUs here, mainly because they can also appear in the middle
				// of a stream and potentially modify the parameters of it. So, let's just leave them in to be sure.
				packetData = concatNalUnitsInLengthPrefixed(nalUnits, 4);
			}

			const timestamp = this.validateAndNormalizeTimestamp(
				trackData.track,
				packet.timestamp,
				packet.type === 'key',
			);
			const internalSample = this.createSampleForTrack(
				trackData,
				packetData,
				timestamp,
				packet.duration,
				packet.type,
			);

			await this.registerSample(trackData, internalSample);
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

			const timestamp = this.validateAndNormalizeTimestamp(
				trackData.track,
				packet.timestamp,
				packet.type === 'key',
			);
			const internalSample = this.createSampleForTrack(
				trackData,
				packetData,
				timestamp,
				packet.duration,
				packet.type,
			);

			if (trackData.info.requiresPcmTransformation) {
				await this.maybePadWithSilence(trackData, timestamp);
			}

			await this.registerSample(trackData, internalSample);
		} finally {
			release();
		}
	}

	private async maybePadWithSilence(trackData: IsobmffAudioTrackData, untilTimestamp: number) {
		// The PCM transformation assumes that all samples are contiguous. This is not something that is enforced, so
		// we need to pad the "holes" in between samples (and before the first sample) with additional
		// "silence samples".

		const lastSample = last(trackData.samples);
		const lastEndTimestamp = lastSample
			? lastSample.timestamp + lastSample.duration
			: 0;

		const delta = untilTimestamp - lastEndTimestamp;
		const deltaInTimescale = intoTimescale(delta, trackData.timescale);

		if (deltaInTimescale > 0) {
			const { sampleSize, silentValue } = parsePcmCodec(
				trackData.info.decoderConfig.codec as PcmAudioCodec,
			);
			const samplesNeeded = deltaInTimescale * trackData.info.numberOfChannels;
			const data = new Uint8Array(sampleSize * samplesNeeded).fill(silentValue);

			const paddingSample = this.createSampleForTrack(
				trackData,
				new Uint8Array(data.buffer),
				lastEndTimestamp,
				delta,
				'key',
			);
			await this.registerSample(trackData, paddingSample);
		}
	}

	async addSubtitleCue(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getSubtitleTrackData(track, meta);

			this.validateAndNormalizeTimestamp(trackData.track, cue.timestamp, true);

			if (track.source._codec === 'webvtt') {
				trackData.cueQueue.push(cue);
				await this.processWebVTTCues(trackData, cue.timestamp);
			} else {
				// TODO
			}
		} finally {
			release();
		}
	}

	private async processWebVTTCues(trackData: IsobmffSubtitleTrackData, until: number) {
		// WebVTT cues need to undergo special processing as empty sections need to be padded out with samples, and
		// overlapping samples require special logic. The algorithm produces the format specified in ISO 14496-30.

		while (trackData.cueQueue.length > 0) {
			const timestamps = new Set<number>([]);
			for (const cue of trackData.cueQueue) {
				assert(cue.timestamp <= until);
				assert(trackData.lastCueEndTimestamp <= cue.timestamp + cue.duration);

				timestamps.add(Math.max(cue.timestamp, trackData.lastCueEndTimestamp)); // Start timestamp
				timestamps.add(cue.timestamp + cue.duration); // End timestamp
			}

			const sortedTimestamps = [...timestamps].sort((a, b) => a - b);

			// These are the timestamps of the next sample we'll create:
			const sampleStart = sortedTimestamps[0]!;
			const sampleEnd = sortedTimestamps[1] ?? sampleStart;

			if (until < sampleEnd) {
				break;
			}

			// We may need to pad out empty space with an vtte box
			if (trackData.lastCueEndTimestamp < sampleStart) {
				this.auxWriter.seek(0);
				const box = vtte();
				this.auxBoxWriter.writeBox(box);

				const body = this.auxWriter.getSlice(0, this.auxWriter.getPos());
				const sample = this.createSampleForTrack(
					trackData,
					body,
					trackData.lastCueEndTimestamp,
					sampleStart - trackData.lastCueEndTimestamp,
					'key',
				);

				await this.registerSample(trackData, sample);
				trackData.lastCueEndTimestamp = sampleStart;
			}

			this.auxWriter.seek(0);

			for (let i = 0; i < trackData.cueQueue.length; i++) {
				const cue = trackData.cueQueue[i]!;

				if (cue.timestamp >= sampleEnd) {
					break;
				}

				inlineTimestampRegex.lastIndex = 0;
				const containsTimestamp = inlineTimestampRegex.test(cue.text);

				const endTimestamp = cue.timestamp + cue.duration;
				let sourceId = trackData.cueToSourceId.get(cue);
				if (sourceId === undefined && sampleEnd < endTimestamp) {
					// We know this cue will appear in more than one sample, therefore we need to mark it with a
					// unique ID
					sourceId = trackData.nextSourceId++;
					trackData.cueToSourceId.set(cue, sourceId);
				}

				if (cue.notes) {
					// Any notes/comments are included in a special vtta box
					const box = vtta(cue.notes);
					this.auxBoxWriter.writeBox(box);
				}

				const box = vttc(
					cue.text,
					containsTimestamp ? sampleStart : null,
					cue.identifier ?? null,
					cue.settings ?? null,
					sourceId ?? null,
				);
				this.auxBoxWriter.writeBox(box);

				if (endTimestamp === sampleEnd) {
					// The cue won't appear in any future sample, so we're done with it
					trackData.cueQueue.splice(i--, 1);
				}
			}

			const body = this.auxWriter.getSlice(0, this.auxWriter.getPos());
			const sample = this.createSampleForTrack(trackData, body, sampleStart, sampleEnd - sampleStart, 'key');

			await this.registerSample(trackData, sample);
			trackData.lastCueEndTimestamp = sampleEnd;
		}
	}

	private createSampleForTrack(
		trackData: IsobmffTrackData,
		data: Uint8Array,
		timestamp: number,
		duration: number,
		type: PacketType,
	) {
		const sample: Sample = {
			timestamp,
			decodeTimestamp: timestamp, // This may be refined later
			duration,
			data,
			size: data.byteLength,
			type,
			timescaleUnitsToNextSample: intoTimescale(duration, trackData.timescale), // Will be refined
		};

		return sample;
	}

	private processTimestamps(trackData: IsobmffTrackData, nextSample?: Sample) {
		if (trackData.timestampProcessingQueue.length === 0) {
			return;
		}

		if (trackData.type === 'audio' && trackData.info.requiresPcmTransformation) {
			let totalDuration = 0;

			// Compute the total duration in the track timescale (which is equal to the amount of PCM audio samples)
			// and simply say that's how many new samples there are.

			for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
				const sample = trackData.timestampProcessingQueue[i]!;
				const duration = intoTimescale(sample.duration, trackData.timescale);
				totalDuration += duration;
			}

			if (trackData.timeToSampleTable.length === 0) {
				trackData.timeToSampleTable.push({
					sampleCount: totalDuration,
					sampleDelta: 1,
				});
			} else {
				const lastEntry = last(trackData.timeToSampleTable)!;
				lastEntry.sampleCount += totalDuration;
			}

			trackData.timestampProcessingQueue.length = 0;
			return;
		}

		const sortedTimestamps = trackData.timestampProcessingQueue.map(x => x.timestamp).sort((a, b) => a - b);

		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const sample = trackData.timestampProcessingQueue[i]!;

			// Since the user only supplies presentation time, but these may be out of order, we reverse-engineer from
			// that a sensible decode timestamp. The notion of a decode timestamp doesn't really make sense
			// (presentation timestamp & decode order are all you need), but it is a concept in ISOBMFF so we need to
			// model it.
			sample.decodeTimestamp = sortedTimestamps[i]!;

			if (!this.isFragmented && trackData.lastTimescaleUnits === null) {
				// In non-fragmented files, the first decode timestamp is always zero. If the first presentation
				// timestamp isn't zero, we'll simply use the composition time offset to achieve it.
				sample.decodeTimestamp = 0;
			}

			const sampleCompositionTimeOffset
				= intoTimescale(sample.timestamp - sample.decodeTimestamp, trackData.timescale);
			const durationInTimescale = intoTimescale(sample.duration, trackData.timescale);

			if (trackData.lastTimescaleUnits !== null) {
				assert(trackData.lastSample);

				const timescaleUnits = intoTimescale(sample.decodeTimestamp, trackData.timescale, false);
				const delta = Math.round(timescaleUnits - trackData.lastTimescaleUnits);
				assert(delta >= 0);

				trackData.lastTimescaleUnits += delta;
				trackData.lastSample.timescaleUnitsToNextSample = delta;

				if (!this.isFragmented) {
					let lastTableEntry = last(trackData.timeToSampleTable);
					assert(lastTableEntry);

					if (lastTableEntry.sampleCount === 1) {
						lastTableEntry.sampleDelta = delta;

						const entryBefore = trackData.timeToSampleTable[trackData.timeToSampleTable.length - 2];
						if (entryBefore && entryBefore.sampleDelta === delta) {
							// If the delta is the same as the previous one, merge the two entries
							entryBefore.sampleCount++;
							trackData.timeToSampleTable.pop();
							lastTableEntry = entryBefore;
						}
					} else if (lastTableEntry.sampleDelta !== delta) {
						// The delta has changed, so we need a new entry to reach the current sample
						lastTableEntry.sampleCount--;
						trackData.timeToSampleTable.push(lastTableEntry = {
							sampleCount: 1,
							sampleDelta: delta,
						});
					}

					if (lastTableEntry.sampleDelta === durationInTimescale) {
						// The sample's duration matches the delta, so we can increment the count
						lastTableEntry.sampleCount++;
					} else {
						// Add a new entry in order to maintain the last sample's true duration
						trackData.timeToSampleTable.push({
							sampleCount: 1,
							sampleDelta: durationInTimescale,
						});
					}

					const lastCompositionTimeOffsetTableEntry = last(trackData.compositionTimeOffsetTable);
					assert(lastCompositionTimeOffsetTableEntry);

					if (
						lastCompositionTimeOffsetTableEntry.sampleCompositionTimeOffset === sampleCompositionTimeOffset
					) {
						// Simply increment the count
						lastCompositionTimeOffsetTableEntry.sampleCount++;
					} else {
						// The composition time offset has changed, so create a new entry with the new composition time
						// offset
						trackData.compositionTimeOffsetTable.push({
							sampleCount: 1,
							sampleCompositionTimeOffset: sampleCompositionTimeOffset,
						});
					}
				}
			} else {
				// Decode timestamp of the first sample
				trackData.lastTimescaleUnits = intoTimescale(sample.decodeTimestamp, trackData.timescale, false);

				if (!this.isFragmented) {
					trackData.timeToSampleTable.push({
						sampleCount: 1,
						sampleDelta: durationInTimescale,
					});
					trackData.compositionTimeOffsetTable.push({
						sampleCount: 1,
						sampleCompositionTimeOffset: sampleCompositionTimeOffset,
					});
				}
			}

			trackData.lastSample = sample;
		}

		trackData.timestampProcessingQueue.length = 0;

		assert(trackData.lastSample);
		assert(trackData.lastTimescaleUnits !== null);

		if (nextSample !== undefined && trackData.lastSample.timescaleUnitsToNextSample === 0) {
			assert(nextSample.type === 'key');

			// Given the next sample, we can make a guess about the duration of the last sample. This avoids having
			// the last sample's duration in each fragment be "0" for fragmented files. The guess we make here is
			// actually correct most of the time, since typically, no delta frame with a lower timestamp follows the key
			// frame (although it can happen).
			const timescaleUnits = intoTimescale(nextSample.timestamp, trackData.timescale, false);
			const delta = Math.round(timescaleUnits - trackData.lastTimescaleUnits);
			trackData.lastSample.timescaleUnitsToNextSample = delta;
		}
	}

	private async registerSample(trackData: IsobmffTrackData, sample: Sample) {
		if (sample.type === 'key') {
			this.processTimestamps(trackData, sample);
		}
		trackData.timestampProcessingQueue.push(sample);

		if (this.isFragmented) {
			trackData.sampleQueue.push(sample);
			await this.interleaveSamples();
		} else if (this.fastStart === 'reserve') {
			await this.registerSampleFastStartReserve(trackData, sample);
		} else {
			await this.addSampleToTrack(trackData, sample);
		}
	}

	private async addSampleToTrack(trackData: IsobmffTrackData, sample: Sample) {
		if (!this.isFragmented) {
			trackData.samples.push(sample);

			if (this.fastStart === 'reserve') {
				const maximumPacketCount = trackData.track.metadata.maximumPacketCount;
				assert(maximumPacketCount !== undefined);

				if (trackData.samples.length > maximumPacketCount) {
					throw new Error(
						`Track #${trackData.track.id} has already reached the maximum packet count`
						+ ` (${maximumPacketCount}). Either add less packets or increase the maximum packet count.`,
					);
				}
			}
		}

		let beginNewChunk = false;
		if (!trackData.currentChunk) {
			beginNewChunk = true;
		} else {
			// Timestamp don't need to be monotonic (think B-frames), so we may need to update the start timestamp of
			// the chunk
			trackData.currentChunk.startTimestamp = Math.min(
				trackData.currentChunk.startTimestamp,
				sample.timestamp,
			);

			const currentChunkDuration = sample.timestamp - trackData.currentChunk.startTimestamp;

			if (this.isFragmented) {
				// We can only finalize this fragment (and begin a new one) if we know that each track will be able to
				// start the new one with a key frame.
				const keyFrameQueuedEverywhere = this.trackDatas.every((otherTrackData) => {
					if (trackData === otherTrackData) {
						return sample.type === 'key';
					}

					const firstQueuedSample = otherTrackData.sampleQueue[0];
					if (firstQueuedSample) {
						return firstQueuedSample.type === 'key';
					}

					return otherTrackData.track.source._closed;
				});

				if (
					currentChunkDuration >= this.minimumFragmentDuration
					&& keyFrameQueuedEverywhere
					&& sample.timestamp > this.maxWrittenTimestamp
				) {
					beginNewChunk = true;
					await this.finalizeFragment();
				}
			} else {
				beginNewChunk = currentChunkDuration >= 0.5; // Chunk is long enough, we need a new one
			}
		}

		if (beginNewChunk) {
			if (trackData.currentChunk) {
				await this.finalizeCurrentChunk(trackData);
			}

			trackData.currentChunk = {
				startTimestamp: sample.timestamp,
				samples: [],
				offset: null,
				moofOffset: null,
			};
		}

		assert(trackData.currentChunk);
		trackData.currentChunk.samples.push(sample);

		if (this.isFragmented) {
			this.maxWrittenTimestamp = Math.max(this.maxWrittenTimestamp, sample.timestamp);
		}
	}

	private async finalizeCurrentChunk(trackData: IsobmffTrackData) {
		assert(!this.isFragmented);

		if (!trackData.currentChunk) return;

		trackData.finalizedChunks.push(trackData.currentChunk);
		this.finalizedChunks.push(trackData.currentChunk);

		let sampleCount = trackData.currentChunk.samples.length;
		if (trackData.type === 'audio' && trackData.info.requiresPcmTransformation) {
			sampleCount = trackData.currentChunk.samples
				.reduce((acc, sample) => acc + intoTimescale(sample.duration, trackData.timescale), 0);
		}

		if (
			trackData.compactlyCodedChunkTable.length === 0
			|| last(trackData.compactlyCodedChunkTable)!.samplesPerChunk !== sampleCount
		) {
			trackData.compactlyCodedChunkTable.push({
				firstChunk: trackData.finalizedChunks.length, // 1-indexed
				samplesPerChunk: sampleCount,
			});
		}

		if (this.fastStart === 'in-memory') {
			trackData.currentChunk.offset = 0; // We'll compute the proper offset when finalizing
			return;
		}

		// Write out the data
		trackData.currentChunk.offset = this.writer.getPos();
		for (const sample of trackData.currentChunk.samples) {
			assert(sample.data);
			this.writer.write(sample.data);
			sample.data = null; // Can be GC'd
		}

		await this.writer.flush();
	}

	private async interleaveSamples(isFinalCall = false) {
		assert(this.isFragmented);

		if (!isFinalCall && !this.allTracksAreKnown()) {
			return; // We can't interleave yet as we don't yet know how many tracks we'll truly have
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: IsobmffTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (!isFinalCall && trackData.sampleQueue.length === 0 && !trackData.track.source._closed) {
					break outer;
				}

				if (trackData.sampleQueue.length > 0 && trackData.sampleQueue[0]!.timestamp < minTimestamp) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.sampleQueue[0]!.timestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const sample = trackWithMinTimestamp.sampleQueue.shift()!;
			await this.addSampleToTrack(trackWithMinTimestamp, sample);
		}
	}

	private async finalizeFragment(flushWriter = true) {
		assert(this.isFragmented);

		const fragmentNumber = this.nextFragmentNumber++;

		if (fragmentNumber === 1) {
			if (this.format._options.onMoov) {
				this.writer.startTrackingWrites();
			}

			// Write the moov box now that we have all decoder configs
			const movieBox = moov(this);
			this.boxWriter.writeBox(movieBox);

			if (this.format._options.onMoov) {
				const { data, start } = this.writer.stopTrackingWrites();
				this.format._options.onMoov(data, start);
			}
		}

		// Not all tracks need to be present in every fragment
		const tracksInFragment = this.trackDatas.filter(x => x.currentChunk);

		// Create an initial moof box and measure it; we need this to know where the following mdat box will begin
		const moofBox = moof(fragmentNumber, tracksInFragment);
		const moofOffset = this.writer.getPos();
		const mdatStartPos = moofOffset + this.boxWriter.measureBox(moofBox);

		let currentPos = mdatStartPos + MIN_BOX_HEADER_SIZE;
		let fragmentStartTimestamp = Infinity;
		for (const trackData of tracksInFragment) {
			trackData.currentChunk!.offset = currentPos;
			trackData.currentChunk!.moofOffset = moofOffset;

			for (const sample of trackData.currentChunk!.samples) {
				currentPos += sample.size;
			}

			fragmentStartTimestamp = Math.min(fragmentStartTimestamp, trackData.currentChunk!.startTimestamp);
		}

		const mdatSize = currentPos - mdatStartPos;
		const needsLargeMdatSize = mdatSize >= 2 ** 32;

		if (needsLargeMdatSize) {
			// Shift all offsets by 8. Previously, all chunks were shifted assuming the large box size, but due to what
			// I suspect is a bug in WebKit, it failed in Safari (when livestreaming with MSE, not for static playback).
			for (const trackData of tracksInFragment) {
				trackData.currentChunk!.offset! += MAX_BOX_HEADER_SIZE - MIN_BOX_HEADER_SIZE;
			}
		}

		if (this.format._options.onMoof) {
			this.writer.startTrackingWrites();
		}

		const newMoofBox = moof(fragmentNumber, tracksInFragment);
		this.boxWriter.writeBox(newMoofBox);

		if (this.format._options.onMoof) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onMoof(data, start, fragmentStartTimestamp);
		}

		assert(this.writer.getPos() === mdatStartPos);

		if (this.format._options.onMdat) {
			this.writer.startTrackingWrites();
		}

		const mdatBox = mdat(needsLargeMdatSize);
		mdatBox.size = mdatSize;
		this.boxWriter.writeBox(mdatBox);

		this.writer.seek(mdatStartPos + (needsLargeMdatSize ? MAX_BOX_HEADER_SIZE : MIN_BOX_HEADER_SIZE));

		// Write sample data
		for (const trackData of tracksInFragment) {
			for (const sample of trackData.currentChunk!.samples) {
				this.writer.write(sample.data!);
				sample.data = null; // Can be GC'd
			}
		}

		if (this.format._options.onMdat) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onMdat(data, start);
		}

		for (const trackData of tracksInFragment) {
			trackData.finalizedChunks.push(trackData.currentChunk!);
			this.finalizedChunks.push(trackData.currentChunk!);
			trackData.currentChunk = null;
		}

		if (flushWriter) {
			await this.writer.flush();
		}
	}

	private async registerSampleFastStartReserve(trackData: IsobmffTrackData, sample: Sample) {
		if (this.allTracksAreKnown()) {
			if (!this.mdat) {
				// We finally know all tracks, let's reserve space for the moov box
				const moovBox = moov(this);
				const moovSize = this.boxWriter.measureBox(moovBox);

				const reservedSize = moovSize
					+ this.computeSampleTableSizeUpperBound()
					+ 4096; // Just a little extra headroom

				assert(this.ftypSize !== null);
				this.writer.seek(this.ftypSize + reservedSize);

				if (this.format._options.onMdat) {
					this.writer.startTrackingWrites();
				}

				this.mdat = mdat(true);
				this.boxWriter.writeBox(this.mdat);

				// Now write everything that was queued
				for (const trackData of this.trackDatas) {
					for (const sample of trackData.sampleQueue) {
						await this.addSampleToTrack(trackData, sample);
					}
					trackData.sampleQueue.length = 0;
				}
			}

			await this.addSampleToTrack(trackData, sample);
		} else {
			// Queue it for when we know all tracks
			trackData.sampleQueue.push(sample);
		}
	}

	private computeSampleTableSizeUpperBound() {
		assert(this.fastStart === 'reserve');

		let upperBound = 0;

		for (const trackData of this.trackDatas) {
			const n = trackData.track.metadata.maximumPacketCount;
			assert(n !== undefined); // We validated this earlier

			// Given the max allowed packet count, compute the space they'll take up in the Sample Table Box, assuming
			// the worst case for each individual box:

			// stts box - since it is compactly coded, the maximum length of this table will be 2/3n
			upperBound += (4 + 4) * Math.ceil(2 / 3 * n);
			// stss box - 1 entry per sample
			upperBound += 4 * n;
			// ctts box - since it is compactly coded, the maximum length of this table will be 2/3n
			upperBound += (4 + 4) * Math.ceil(2 / 3 * n);
			// stsc box - since it is compactly coded, the maximum length of this table will be 2/3n
			upperBound += (4 + 4 + 4) * Math.ceil(2 / 3 * n);
			// stsz box - 1 entry per sample
			upperBound += 4 * n;
			// co64 box - we assume 1 sample per chunk and 64-bit chunk offsets (co64 instead of stco)
			upperBound += 8 * n;
		}

		return upperBound;
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		if (track.type === 'subtitle' && track.source._codec === 'webvtt') {
			const trackData = this.trackDatas.find(x => x.track === track) as IsobmffSubtitleTrackData;
			if (trackData) {
				await this.processWebVTTCues(trackData, Infinity);
			}
		}

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		if (this.isFragmented) {
			// Since a track is now closed, we may be able to write out chunks that were previously waiting
			await this.interleaveSamples();
		}

		release();
	}

	/** Finalizes the file, making it ready for use. Must be called after all video and audio chunks have been added. */
	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			if (trackData.type === 'subtitle' && trackData.track.source._codec === 'webvtt') {
				await this.processWebVTTCues(trackData, Infinity);
			}
		}

		if (this.isFragmented) {
			await this.interleaveSamples(true);

			for (const trackData of this.trackDatas) {
				this.processTimestamps(trackData);
			}

			await this.finalizeFragment(false); // Don't flush the last fragment as we will flush it with the mfra box
		} else {
			for (const trackData of this.trackDatas) {
				this.processTimestamps(trackData);
				await this.finalizeCurrentChunk(trackData);
			}
		}

		if (this.fastStart === 'in-memory') {
			this.mdat = mdat(false);
			let mdatSize: number;

			// We know how many chunks there are, but computing the chunk positions requires an iterative approach:
			// In order to know where the first chunk should go, we first need to know the size of the moov box. But we
			// cannot write a proper moov box without first knowing all chunk positions. So, we generate a tentative
			// moov box with placeholder values (0) for the chunk offsets to be able to compute its size. If it then
			// turns out that appending all chunks exceeds 4 GiB, we need to repeat this process, now with the co64 box
			// being used in the moov box instead, which will make it larger. After that, we definitely know the final
			// size of the moov box and can compute the proper chunk positions.

			for (let i = 0; i < 2; i++) {
				const movieBox = moov(this);
				const movieBoxSize = this.boxWriter.measureBox(movieBox);
				mdatSize = this.boxWriter.measureBox(this.mdat);
				let currentChunkPos = this.writer.getPos() + movieBoxSize + mdatSize;

				for (const chunk of this.finalizedChunks) {
					chunk.offset = currentChunkPos;
					for (const { data } of chunk.samples) {
						assert(data);
						currentChunkPos += data.byteLength;
						mdatSize += data.byteLength;
					}
				}

				if (currentChunkPos < 2 ** 32) break;
				if (mdatSize >= 2 ** 32) this.mdat.largeSize = true;
			}

			if (this.format._options.onMoov) {
				this.writer.startTrackingWrites();
			}

			const movieBox = moov(this);
			this.boxWriter.writeBox(movieBox);

			if (this.format._options.onMoov) {
				const { data, start } = this.writer.stopTrackingWrites();
				this.format._options.onMoov(data, start);
			}

			if (this.format._options.onMdat) {
				this.writer.startTrackingWrites();
			}

			this.mdat.size = mdatSize!;
			this.boxWriter.writeBox(this.mdat);

			for (const chunk of this.finalizedChunks) {
				for (const sample of chunk.samples) {
					assert(sample.data);
					this.writer.write(sample.data);
					sample.data = null;
				}
			}

			if (this.format._options.onMdat) {
				const { data, start } = this.writer.stopTrackingWrites();
				this.format._options.onMdat(data, start);
			}
		} else if (this.isFragmented) {
			// Append the mfra box to the end of the file for better random access
			const startPos = this.writer.getPos();
			const mfraBox = mfra(this.trackDatas);
			this.boxWriter.writeBox(mfraBox);

			// Patch the 'size' field of the mfro box at the end of the mfra box now that we know its actual size
			const mfraBoxSize = this.writer.getPos() - startPos;
			this.writer.seek(this.writer.getPos() - 4);
			this.boxWriter.writeU32(mfraBoxSize);
		} else {
			assert(this.mdat);

			const mdatPos = this.boxWriter.offsets.get(this.mdat);
			assert(mdatPos !== undefined);
			const mdatSize = this.writer.getPos() - mdatPos;
			this.mdat.size = mdatSize;
			this.mdat.largeSize = mdatSize >= 2 ** 32; // Only use the large size if we need it
			this.boxWriter.patchBox(this.mdat);

			if (this.format._options.onMdat) {
				const { data, start } = this.writer.stopTrackingWrites();
				this.format._options.onMdat(data, start);
			}

			const movieBox = moov(this);

			if (this.fastStart === 'reserve') {
				assert(this.ftypSize !== null);
				this.writer.seek(this.ftypSize);

				if (this.format._options.onMoov) {
					this.writer.startTrackingWrites();
				}

				this.boxWriter.writeBox(movieBox);

				// Fill the remaining space with a free box. If there are less than 8 bytes left, sucks I guess
				const remainingSpace = this.boxWriter.offsets.get(this.mdat)! - this.writer.getPos();
				this.boxWriter.writeBox(free(remainingSpace));
			} else {
				if (this.format._options.onMoov) {
					this.writer.startTrackingWrites();
				}

				this.boxWriter.writeBox(movieBox);
			}

			if (this.format._options.onMoov) {
				const { data, start } = this.writer.stopTrackingWrites();
				this.format._options.onMoov(data, start);
			}
		}

		release();
	}
}
