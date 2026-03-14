/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseAacAudioSpecificConfig, validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import {
	AvcDecoderConfigurationRecord,
	concatNalUnitsInAnnexB,
	deserializeAvcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	findNalUnitsInAnnexB,
} from '../codec-data';
import { assert, Bitstream, promiseWithResolvers, setUint24, toDataView, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputTrack, OutputVideoTrack } from '../output';
import { MpegTsOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import { buildMpegTsMimeType, MpegTsStreamType, TIMESCALE, TS_PACKET_SIZE } from './mpeg-ts-misc';

// Resources:
// ISO/IEC 13818-1

const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const FIRST_TRACK_PID = 0x0100;

const VIDEO_STREAM_ID_BASE = 0xE0;
const AUDIO_STREAM_ID_BASE = 0xC0;

const AVC_AUD_NAL = new Uint8Array([0x09, 0xF0]);
const HEVC_AUD_NAL = new Uint8Array([0x46, 0x01]);

type MpegTsTrackData = {
	track: OutputVideoTrack | OutputAudioTrack;
	pid: number;
	streamType: MpegTsStreamType;
	streamId: number;
	codecString: string;
	timestampProcessingQueue: QueuedPacket[];
	packetQueue: QueuedPacket[];
	inputIsAnnexB: boolean | null;
	inputIsAdts: boolean | null;
	avcDecoderConfig: AvcDecoderConfigurationRecord | null;
	hevcLengthSize: 1 | 2 | 3 | 4 | null;
	hevcParameterSets: Uint8Array[];
	adtsHeader: Uint8Array | null;
	adtsHeaderBitstream: Bitstream | null;
	firstPacketWritten: boolean;
};

type QueuedPacket = {
	data: Uint8Array;
	presentationTimestamp: number;
	decodeTimestamp: number | null;
	isKeyframe: boolean;
};

export class MpegTsMuxer extends Muxer {
	private format: MpegTsOutputFormat;
	private writer: Writer;

	private trackDatas: MpegTsTrackData[] = [];
	private tablesWritten = false;
	private continuityCounters = new Map<number, number>();
	private packetBuffer = new Uint8Array(TS_PACKET_SIZE);
	private packetView = toDataView(this.packetBuffer);
	private allTracksKnown = promiseWithResolvers();

	private videoTrackIndex = 0;
	private audioTrackIndex = 0;

	private adaptationFieldBuffer = new Uint8Array(184);
	private payloadBuffer = new Uint8Array(184);

	constructor(output: Output, format: MpegTsOutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;
		this.writer.ensureMonotonicity = true;
	}

	async start() {
		// Nothing to do here
	}

	async getMimeType() {
		await this.allTracksKnown.promise;
		return buildMpegTsMimeType(this.trackDatas.map(x => x.codecString));
	}

	private getVideoTrackData(track: OutputVideoTrack, meta?: EncodedVideoChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		validateVideoChunkMetadata(meta);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'avc' || codec === 'hevc');

		const streamType = codec === 'avc'
			? MpegTsStreamType.AVC
			: MpegTsStreamType.HEVC;
		const pid = FIRST_TRACK_PID + this.trackDatas.length;
		const streamId = VIDEO_STREAM_ID_BASE + this.videoTrackIndex++;

		const newTrackData: MpegTsTrackData = {
			track,
			pid,
			streamType,
			streamId,
			codecString: meta.decoderConfig.codec,
			timestampProcessingQueue: [],
			packetQueue: [],
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcLengthSize: null,
			hevcParameterSets: [],
			adtsHeader: null,
			adtsHeaderBitstream: null,
			firstPacketWritten: false,
		};

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private getAudioTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		validateAudioChunkMetadata(meta);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'aac' || codec === 'mp3');

		let streamType: MpegTsStreamType;
		let streamId: number;

		switch (codec) {
			case 'aac': {
				streamType = MpegTsStreamType.AAC;
				streamId = AUDIO_STREAM_ID_BASE + this.audioTrackIndex++;
			}; break;

			case 'mp3': {
				streamType = MpegTsStreamType.MP3_MPEG1;
				streamId = AUDIO_STREAM_ID_BASE + this.audioTrackIndex++;
			}; break;
		}

		const pid = FIRST_TRACK_PID + this.trackDatas.length;

		const newTrackData: MpegTsTrackData = {
			track,
			pid,
			streamType,
			streamId,
			codecString: meta.decoderConfig.codec,
			timestampProcessingQueue: [],
			packetQueue: [],
			inputIsAnnexB: null,
			inputIsAdts: null,
			avcDecoderConfig: null,
			hevcLengthSize: null,
			hevcParameterSets: [],
			adtsHeader: null,
			adtsHeaderBitstream: null,
			firstPacketWritten: false,
		};

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		const trackData = this.getVideoTrackData(track, meta);

		const timestamp = this.validateAndNormalizeTimestamp(
			trackData.track,
			packet.timestamp,
			packet.type === 'key',
		);

		const preparedData = this.prepareVideoPacket(trackData, packet, meta);

		if (packet.type === 'key') {
			await this.flushTimestampQueue(trackData);
		}

		trackData.timestampProcessingQueue.push({
			data: preparedData,
			presentationTimestamp: timestamp,
			decodeTimestamp: null,
			isKeyframe: packet.type === 'key',
		});
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		const trackData = this.getAudioTrackData(track, meta);

		const timestamp = this.validateAndNormalizeTimestamp(
			trackData.track,
			packet.timestamp,
			packet.type === 'key',
		);

		const preparedData = this.prepareAudioPacket(trackData, packet, meta);

		if (packet.type === 'key') {
			await this.flushTimestampQueue(trackData);
		}

		trackData.timestampProcessingQueue.push({
			data: preparedData,
			presentationTimestamp: timestamp,
			decodeTimestamp: null,
			isKeyframe: packet.type === 'key',
		});
	}

	async addSubtitleCue(): Promise<void> {
		throw new Error('MPEG-TS does not support subtitles.');
	}

	private prepareVideoPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): Uint8Array {
		const codec = (trackData.track as OutputVideoTrack).source._codec;

		if (trackData.inputIsAnnexB === null) {
			// This is the first packet
			const description = meta?.decoderConfig?.description;
			trackData.inputIsAnnexB = !description;

			if (!trackData.inputIsAnnexB) {
				const bytes = toUint8Array(description!);
				if (codec === 'avc') {
					trackData.avcDecoderConfig = deserializeAvcDecoderConfigurationRecord(bytes);
				} else {
					trackData.hevcLengthSize = ((bytes[21]! & 0b11) + 1) as 1 | 2 | 3 | 4;
					trackData.hevcParameterSets = this.extractHevcParameterSets(bytes);
				}
			}
		}

		if (trackData.inputIsAnnexB) {
			return this.prepareAnnexBVideoPacket(packet.data, codec as 'avc' | 'hevc');
		} else {
			return this.prepareLengthPrefixedVideoPacket(trackData, packet, codec as 'avc' | 'hevc');
		}
	}

	private prepareAnnexBVideoPacket(data: Uint8Array, codec: 'avc' | 'hevc'): Uint8Array {
		const nalUnits: Uint8Array[] = [];

		for (const nalUnit of findNalUnitsInAnnexB(data)) {
			const isAud = codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit) === 9
				: extractNalUnitTypeForHevc(nalUnit) === 35;

			if (!isAud) {
				nalUnits.push(nalUnit);
			}
		}

		// Pretend the AUD
		const aud = codec === 'avc'
			? AVC_AUD_NAL
			: HEVC_AUD_NAL;
		nalUnits.unshift(aud);

		return concatNalUnitsInAnnexB(nalUnits);
	}

	private prepareLengthPrefixedVideoPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		codec: 'avc' | 'hevc',
	): Uint8Array {
		const data = packet.data;
		const lengthSize = codec === 'avc'
			? (trackData.avcDecoderConfig!.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4
			: trackData.hevcLengthSize!;

		const nalUnits: Uint8Array[] = [];

		for (const nalUnit of this.splitLengthPrefixedNalUnits(data, lengthSize)) {
			const isAud = codec === 'avc'
				? extractNalUnitTypeForAvc(nalUnit) === 9
				: extractNalUnitTypeForHevc(nalUnit) === 35;

			if (!isAud) {
				nalUnits.push(nalUnit);
			}
		}

		if (packet.type === 'key') {
			// Add whichever NALUs are missing
			if (codec === 'avc') {
				const config = trackData.avcDecoderConfig!;
				for (const pps of config.pictureParameterSets) {
					nalUnits.unshift(pps);
				}
				for (const sps of config.sequenceParameterSets) {
					nalUnits.unshift(sps);
				}
			} else {
				for (let i = trackData.hevcParameterSets.length - 1; i >= 0; i--) {
					nalUnits.unshift(trackData.hevcParameterSets[i]!);
				}
			}
		}

		// Prepend the AUD
		const aud = codec === 'avc'
			? AVC_AUD_NAL
			: HEVC_AUD_NAL;
		nalUnits.unshift(aud);

		return concatNalUnitsInAnnexB(nalUnits);
	}

	private splitLengthPrefixedNalUnits(data: Uint8Array, lengthSize: 1 | 2 | 3 | 4) {
		const nalUnits: Uint8Array[] = [];
		const view = toDataView(data);
		let offset = 0;

		while (offset + lengthSize <= data.byteLength) {
			let nalUnitLength = 0;

			switch (lengthSize) {
				case 1: {
					nalUnitLength = view.getUint8(offset);
				}; break;
				case 2: {
					nalUnitLength = view.getUint16(offset, false);
				}; break;
				case 3: {
					nalUnitLength = view.getUint8(offset) * 2 ** 16 + view.getUint16(offset + 1, false);
				}; break;
				case 4: {
					nalUnitLength = view.getUint32(offset, false);
				}; break;
			}

			offset += lengthSize;
			if (offset + nalUnitLength > data.byteLength) {
				break;
			}

			nalUnits.push(data.subarray(offset, offset + nalUnitLength));
			offset += nalUnitLength;
		}

		return nalUnits;
	}

	private extractHevcParameterSets(description: Uint8Array) {
		const nalUnits: Uint8Array[] = [];

		if (description.byteLength < 23) {
			return nalUnits;
		}

		const view = toDataView(description);
		const numOfArrays = description[22]!;
		let offset = 23;

		for (let i = 0; i < numOfArrays; i++) {
			if (offset + 3 > description.byteLength) break;

			const nalUnitType = description[offset]! & 0x3f;
			offset += 1;

			const numNalus = view.getUint16(offset, false);
			offset += 2;

			for (let j = 0; j < numNalus; j++) {
				if (offset + 2 > description.byteLength) break;

				const nalUnitLength = view.getUint16(offset, false);
				offset += 2;

				if (offset + nalUnitLength > description.byteLength) break;

				if (nalUnitType === 32 || nalUnitType === 33 || nalUnitType === 34) {
					nalUnits.push(description.subarray(offset, offset + nalUnitLength));
				}

				offset += nalUnitLength;
			}
		}

		return nalUnits;
	}

	private prepareAudioPacket(
		trackData: MpegTsTrackData,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Uint8Array {
		const codec = (trackData.track as OutputAudioTrack).source._codec;

		if (codec === 'mp3') {
			// We're good
			return packet.data;
		}

		if (trackData.inputIsAdts === null) {
			// It's the first packet
			const description = meta?.decoderConfig?.description;
			trackData.inputIsAdts = !description;

			if (!trackData.inputIsAdts) {
				const config = parseAacAudioSpecificConfig(toUint8Array(description!));

				trackData.adtsHeader = new Uint8Array(7);
				trackData.adtsHeaderBitstream = new Bitstream(trackData.adtsHeader);

				const profile = config.objectType - 1;
				trackData.adtsHeaderBitstream.writeBits(12, 0b1111_11111111);
				trackData.adtsHeaderBitstream.writeBits(1, 0);
				trackData.adtsHeaderBitstream.writeBits(2, 0);
				trackData.adtsHeaderBitstream.writeBits(1, 1);
				trackData.adtsHeaderBitstream.writeBits(2, profile);
				trackData.adtsHeaderBitstream.writeBits(4, config.frequencyIndex);
				trackData.adtsHeaderBitstream.writeBits(1, 0);
				trackData.adtsHeaderBitstream.writeBits(3, config.channelConfiguration);
				trackData.adtsHeaderBitstream.writeBits(1, 0);
				trackData.adtsHeaderBitstream.writeBits(1, 0);
				trackData.adtsHeaderBitstream.writeBits(1, 0);
				trackData.adtsHeaderBitstream.writeBits(1, 0);
				trackData.adtsHeaderBitstream.skipBits(13);
				trackData.adtsHeaderBitstream.writeBits(11, 0x7ff);
				trackData.adtsHeaderBitstream.writeBits(2, 0);
			}
		}

		if (trackData.inputIsAdts) {
			return packet.data;
		}

		assert(trackData.adtsHeader);
		assert(trackData.adtsHeaderBitstream);

		const header = trackData.adtsHeader;
		const frameLength = packet.data.byteLength + header.byteLength;
		trackData.adtsHeaderBitstream.pos = 30;
		trackData.adtsHeaderBitstream.writeBits(13, frameLength);

		const result = new Uint8Array(frameLength);
		result.set(header, 0);
		result.set(packet.data, header.byteLength);

		return result;
	}

	private allTracksAreKnown() {
		for (const track of this.output._tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false;
			}
		}

		return true;
	}

	private async flushTimestampQueue(trackData: MpegTsTrackData, alsoInterleave = true) {
		if (trackData.timestampProcessingQueue.length === 0) {
			return;
		}

		const sortedTimestamps = trackData.timestampProcessingQueue
			.map(packet => packet.presentationTimestamp)
			.sort((a, b) => a - b);

		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const queuedPacket = trackData.timestampProcessingQueue[i]!;
			queuedPacket.decodeTimestamp = sortedTimestamps[i]!;
			trackData.packetQueue.push(queuedPacket);
		}

		trackData.timestampProcessingQueue.length = 0;

		if (alsoInterleave) {
			await this.interleavePackets();
		}
	}

	private async interleavePackets(isFinalCall = false) {
		if (!this.tablesWritten) {
			if (!this.allTracksAreKnown() && !isFinalCall) {
				return;
			}

			this.writeTables();
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: MpegTsTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length === 0
					&& !trackData.track.source._closed
				) {
					break outer;
				}

				if (
					trackData.packetQueue.length > 0
					&& trackData.packetQueue[0]!.presentationTimestamp < minTimestamp
				) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.packetQueue[0]!.presentationTimestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const queuedPacket = trackWithMinTimestamp.packetQueue.shift()!;
			this.writePesPacket(trackWithMinTimestamp, queuedPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	private writeTables() {
		assert(!this.tablesWritten);

		this.writePsiSection(PAT_PID, PAT_SECTION);
		this.writePsiSection(PMT_PID, buildPmt(this.trackDatas));

		this.tablesWritten = true;
	}

	private writePsiSection(pid: number, section: Uint8Array) {
		let offset = 0;
		let isFirst = true;

		// Long PSI sections might span more than one TS packet
		while (offset < section.length) {
			const pointerFieldSize = isFirst ? 1 : 0;
			const availablePayload = 184 - pointerFieldSize;
			const remainingData = section.length - offset;
			const chunkSize = Math.min(availablePayload, remainingData);

			let payload: Uint8Array;
			if (isFirst) {
				payload = this.payloadBuffer.subarray(0, 1 + chunkSize);
				payload[0] = 0x00; // pointer_field
				payload.set(section.subarray(offset, offset + chunkSize), 1);
			} else {
				payload = section.subarray(offset, offset + chunkSize);
			}

			this.writeTsPacket(pid, isFirst, null, payload);

			offset += chunkSize;
			isFirst = false;
		}
	}

	private writePesPacket(trackData: MpegTsTrackData, queuedPacket: QueuedPacket) {
		const includeDts = trackData.track.type === 'video';
		const headerDataLength = includeDts ? 10 : 5;
		const pesHeaderBuffer = new Uint8Array(9 + headerDataLength);
		const pesView = toDataView(pesHeaderBuffer);
		const ptsDtsBitstream = new Bitstream(pesHeaderBuffer.subarray(9));

		setUint24(pesView, 0, 0x000001, false); // packet_start_code_prefix
		pesHeaderBuffer[3] = trackData.streamId; // stream_id

		const pesPacketLength = trackData.track.type === 'video'
			? 0 // Unbounded
			: Math.min(8 + queuedPacket.data.length, 0xFFFF); // Required for audio for some reason
		pesView.setUint16(4, pesPacketLength, false);

		// '10' marker, PES_scrambling_control=0, PES_priority=0,
		// data_alignment_indicator=1, copyright=0, original_or_copy=0
		pesView.setUint8(6, 0x84);
		pesView.setUint8(7, includeDts ? 0xC0 : 0x80); // PTS_DTS_flags, other flags=0
		pesView.setUint8(8, headerDataLength); // PES_header_data_length

		const pts = Math.round(queuedPacket.presentationTimestamp * TIMESCALE);
		ptsDtsBitstream.pos = 0;
		ptsDtsBitstream.writeBits(4, includeDts ? 0b0011 : 0b0010); // marker
		ptsDtsBitstream.writeBits(3, (pts >>> 30) & 0x7); // PTS[32:30]
		ptsDtsBitstream.writeBits(1, 1); // marker_bit
		ptsDtsBitstream.writeBits(15, (pts >>> 15) & 0x7FFF); // PTS[29:15]
		ptsDtsBitstream.writeBits(1, 1); // marker_bit
		ptsDtsBitstream.writeBits(15, pts & 0x7FFF); // PTS[14:0]
		ptsDtsBitstream.writeBits(1, 1); // marker_bit

		if (includeDts) {
			assert(queuedPacket.decodeTimestamp !== null);

			const dts = Math.round(queuedPacket.decodeTimestamp * TIMESCALE);
			ptsDtsBitstream.writeBits(4, 0b0001);
			ptsDtsBitstream.writeBits(3, (dts >>> 30) & 0x7); // DTS[32:30]
			ptsDtsBitstream.writeBits(1, 1); // marker_bit
			ptsDtsBitstream.writeBits(15, (dts >>> 15) & 0x7FFF); // DTS[29:15]
			ptsDtsBitstream.writeBits(1, 1); // marker_bit
			ptsDtsBitstream.writeBits(15, dts & 0x7FFF); // DTS[14:0]
			ptsDtsBitstream.writeBits(1, 1); // marker_bit
		}

		const totalLength = pesHeaderBuffer.length + queuedPacket.data.length;
		let offset = 0;
		let isFirstTsPacket = true;

		while (offset < totalLength) {
			const pusi = isFirstTsPacket;
			const remainingData = totalLength - offset;

			const randomAccessIndicator = isFirstTsPacket && queuedPacket.isKeyframe;
			const discontinuityIndicator = isFirstTsPacket && !trackData.firstPacketWritten;
			const basePaddingNeeded = Math.max(0, 184 - remainingData);

			let adaptationFieldSize: number;
			if (randomAccessIndicator || discontinuityIndicator) {
				// We need at least two bytes
				adaptationFieldSize = Math.max(2, basePaddingNeeded);
			} else {
				adaptationFieldSize = basePaddingNeeded;
			}

			let adaptationField: Uint8Array | null = null;
			if (adaptationFieldSize > 0) {
				const buf = this.adaptationFieldBuffer;

				if (adaptationFieldSize === 1) {
					buf[0] = 0; // adaptation_field_length
				} else {
					buf[0] = adaptationFieldSize - 1; // adaptation_field_length
					buf[1]
						= (Number(discontinuityIndicator) << 7) // discontinuity_indicator
							| (Number(randomAccessIndicator) << 6); // random_access_indicator
					buf.fill(0xFF, 2, adaptationFieldSize); // stuffing_bytes
				}

				adaptationField = buf.subarray(0, adaptationFieldSize);
			}

			const payloadSize = Math.min(184 - adaptationFieldSize, remainingData);
			const payload = this.payloadBuffer.subarray(0, payloadSize);

			let payloadOffset = 0;
			if (offset < pesHeaderBuffer.length) {
				const headerBytes = Math.min(pesHeaderBuffer.length - offset, payloadSize);
				payload.set(pesHeaderBuffer.subarray(offset, offset + headerBytes), 0);
				payloadOffset = headerBytes;
			}

			const dataStart = Math.max(0, offset - pesHeaderBuffer.length);
			const dataEnd = dataStart + (payloadSize - payloadOffset);
			if (payloadOffset < payloadSize) {
				payload.set(queuedPacket.data.subarray(dataStart, dataEnd), payloadOffset);
			}

			this.writeTsPacket(trackData.pid, pusi, adaptationField, payload);

			offset += payloadSize;
			isFirstTsPacket = false;
		}

		trackData.firstPacketWritten = true;
	}

	private writeTsPacket(
		pid: number,
		pusi: boolean,
		adaptationField: Uint8Array | null,
		payload: Uint8Array,
	) {
		const cc = this.continuityCounters.get(pid) ?? 0;
		const hasPayload = payload.length > 0;
		const adaptCtrl = adaptationField
			? (hasPayload ? 0b11 : 0b10)
			: (hasPayload ? 0b01 : 0b00);

		this.packetBuffer[0] = 0x47; // sync_byte
		this.packetView.setUint16(1, (pusi ? 0x4000 : 0) | (pid & 0x1FFF), false); // TEI=0, PUSI, priority=0, PID
		// scrambling=0, adaptation_field_control, continuity_counter
		this.packetBuffer[3] = (adaptCtrl << 4) | (cc & 0x0F);

		if (hasPayload) {
			this.continuityCounters.set(pid, (cc + 1) & 0x0F);
		}

		let offset = 4;

		if (adaptationField) {
			this.packetBuffer.set(adaptationField, offset);
			offset += adaptationField.length;
		}

		this.packetBuffer.set(payload, offset);
		offset += payload.length;

		if (offset < TS_PACKET_SIZE) {
			this.packetBuffer.fill(0xFF, offset); // stuffing_bytes
		}

		const startPos = this.writer.getPos();
		this.writer.write(this.packetBuffer);

		if (this.format._options.onPacket) {
			this.format._options.onPacket(this.packetBuffer.slice(), startPos);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		const trackData = this.trackDatas.find(x => x.track === track);
		if (trackData) {
			await this.flushTimestampQueue(trackData, false);
		}

		await this.interleavePackets();
	}

	async finalize() {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			await this.flushTimestampQueue(trackData, false);
		}

		await this.interleavePackets(true);
	}
}

// CRC-32 for MPEG-TS (polynomial 0x04C11DB7, initial value 0xFFFFFFFF)
const MPEG_TS_CRC_POLYNOMIAL = 0x04c11db7;
const MPEG_TS_CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let crc = n << 24;

	for (let k = 0; k < 8; k++) {
		crc = (crc & 0x80000000)
			? ((crc << 1) ^ MPEG_TS_CRC_POLYNOMIAL)
			: (crc << 1);
	}

	MPEG_TS_CRC_TABLE[n] = (crc >>> 0) & 0xffffffff;
}

const computeMpegTsCrc32 = (data: Uint8Array) => {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		const byte = data[i]!;
		crc = ((crc << 8) ^ MPEG_TS_CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}
	return crc;
};

const PAT_SECTION = new Uint8Array(16);
{
	const view = toDataView(PAT_SECTION);
	PAT_SECTION[0] = 0x00; // table_id
	view.setUint16(1, 0xB00D, false); // section_syntax_indicator=1, '0', reserved=11, section_length=13
	view.setUint16(3, 0x0001, false); // transport_stream_id
	PAT_SECTION[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	PAT_SECTION[6] = 0x00; // section_number
	PAT_SECTION[7] = 0x00; // last_section_number
	view.setUint16(8, 0x0001, false); // program_number
	view.setUint16(10, 0xE000 | (PMT_PID & 0x1FFF), false); // reserved=111, program_map_PID
	view.setUint32(12, computeMpegTsCrc32(PAT_SECTION.subarray(0, 12)), false); // CRC_32
}

const buildPmt = (trackDatas: MpegTsTrackData[]) => {
	let totalEsBytes = 0;
	for (const _trackData of trackDatas) {
		void _trackData;
		totalEsBytes += 5;
	}

	const sectionLength = 9 + totalEsBytes + 4;
	const section = new Uint8Array(3 + sectionLength - 4);
	const view = toDataView(section);

	section[0] = 0x02; // table_id
	// section_syntax_indicator=1, '0', reserved=11, section_length
	view.setUint16(1, 0xB000 | (sectionLength & 0x0FFF), false);
	view.setUint16(3, 0x0001, false); // program_number
	section[5] = 0xC1; // reserved=11, version_number=0, current_next_indicator=1
	section[6] = 0x00; // section_number
	section[7] = 0x00; // last_section_number
	view.setUint16(8, 0xE000 | 0x1FFF, false); // reserved=111, PCR_PID=0x1FFF (none)
	view.setUint16(10, 0xF000, false); // reserved=1111, program_info_length=0

	let offset = 12;
	for (const trackData of trackDatas) {
		section[offset++] = trackData.streamType; // stream_type
		view.setUint16(offset, 0xE000 | (trackData.pid & 0x1FFF), false); // reserved=111, elementary_PID
		offset += 2;
		view.setUint16(offset, 0xF000, false); // reserved=1111, ES_info_length=0
		offset += 2;
	}

	const crc = computeMpegTsCrc32(section);
	const result = new Uint8Array(section.length + 4);
	result.set(section, 0);
	toDataView(result).setUint32(section.length, crc, false); // CRC_32

	return result;
};
