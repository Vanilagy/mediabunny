/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { VideoCodec, VP9_LEVEL_TABLE } from './codec';
import {
	assert,
	assertNever,
	base64ToBytes,
	Bitstream,
	bytesToBase64,
	keyValueIterator,
	getUint24,
	last,
	readExpGolomb,
	readSignedExpGolomb,
	textDecoder,
	textEncoder,
	toDataView,
	toUint8Array,
} from './misc';
import { PacketType } from './packet';
import { MetadataTags } from './metadata';

// References for AVC/HEVC code:
// ISO 14496-15
// Rec. ITU-T H.264
// Rec. ITU-T H.265
// https://stackoverflow.com/questions/24884827

export enum AvcNalUnitType {
	IDR = 5,
	SPS = 7,
	PPS = 8,
	SPS_EXT = 13,
}

export enum HevcNalUnitType {
	RASL_N = 8,
	RASL_R = 9,
	BLA_W_LP = 16,
	RSV_IRAP_VCL23 = 23,
	VPS_NUT = 32,
	SPS_NUT = 33,
	PPS_NUT = 34,
	PREFIX_SEI_NUT = 39,
	SUFFIX_SEI_NUT = 40,
}

/** Finds all NAL units in an AVC packet in Annex B format. */
export const findNalUnitsInAnnexB = (packetData: Uint8Array) => {
	const nalUnits: Uint8Array[] = [];
	let i = 0;

	while (i < packetData.length) {
		let startCodePos = -1;
		let startCodeLength = 0;

		for (let j = i; j < packetData.length - 3; j++) {
			// Check for 3-byte start code (0x000001)
			if (packetData[j] === 0 && packetData[j + 1] === 0 && packetData[j + 2] === 1) {
				startCodePos = j;
				startCodeLength = 3;
				break;
			}

			// Check for 4-byte start code (0x00000001)
			if (
				j < packetData.length - 4
				&& packetData[j] === 0
				&& packetData[j + 1] === 0
				&& packetData[j + 2] === 0
				&& packetData[j + 3] === 1
			) {
				startCodePos = j;
				startCodeLength = 4;
				break;
			}
		}

		if (startCodePos === -1) {
			break; // No more start codes found
		}

		// If this isn't the first start code, extract the previous NAL unit
		if (i > 0 && startCodePos > i) {
			const nalData = packetData.subarray(i, startCodePos);
			if (nalData.length > 0) {
				nalUnits.push(nalData);
			}
		}

		i = startCodePos + startCodeLength;
	}

	// Extract the last NAL unit if there is one
	if (i < packetData.length) {
		const nalData = packetData.subarray(i);
		if (nalData.length > 0) {
			nalUnits.push(nalData);
		}
	}

	return nalUnits;
};

/** Finds all NAL units in an AVC packet in length-prefixed format. */
const findNalUnitsInLengthPrefixed = (packetData: Uint8Array, lengthSize: 1 | 2 | 3 | 4) => {
	const nalUnits: Uint8Array[] = [];
	let offset = 0;

	const dataView = new DataView(packetData.buffer, packetData.byteOffset, packetData.byteLength);

	while (offset + lengthSize <= packetData.length) {
		let nalUnitLength: number;
		if (lengthSize === 1) {
			nalUnitLength = dataView.getUint8(offset);
		} else if (lengthSize === 2) {
			nalUnitLength = dataView.getUint16(offset, false);
		} else if (lengthSize === 3) {
			nalUnitLength = getUint24(dataView, offset, false);
		} else if (lengthSize === 4) {
			nalUnitLength = dataView.getUint32(offset, false);
		} else {
			assertNever(lengthSize);
			assert(false);
		}

		offset += lengthSize;

		const nalUnit = packetData.subarray(offset, offset + nalUnitLength);
		nalUnits.push(nalUnit);

		offset += nalUnitLength;
	}

	return nalUnits;
};

const removeEmulationPreventionBytes = (data: Uint8Array) => {
	const result: number[] = [];
	const len = data.length;

	for (let i = 0; i < len; i++) {
		// Look for the 0x000003 pattern
		if (i + 2 < len && data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x03) {
			result.push(0x00, 0x00); // Push the first two bytes
			i += 2; // Skip the 0x03 byte
		} else {
			result.push(data[i]!);
		}
	}

	return new Uint8Array(result);
};

/** Converts an AVC packet in Annex B format to length-prefixed format. */
export const transformAnnexBToLengthPrefixed = (packetData: Uint8Array) => {
	const NAL_UNIT_LENGTH_SIZE = 4;

	const nalUnits = findNalUnitsInAnnexB(packetData);

	if (nalUnits.length === 0) {
		// If no NAL units were found, it's not valid Annex B data
		return null;
	}

	let totalSize = 0;
	for (const nalUnit of nalUnits) {
		totalSize += NAL_UNIT_LENGTH_SIZE + nalUnit.byteLength;
	}

	const avccData = new Uint8Array(totalSize);
	const dataView = new DataView(avccData.buffer);
	let offset = 0;

	// Write each NAL unit with its length prefix
	for (const nalUnit of nalUnits) {
		const length = nalUnit.byteLength;

		dataView.setUint32(offset, length, false);
		offset += 4;

		avccData.set(nalUnit, offset);
		offset += nalUnit.byteLength;
	}

	return avccData;
};

// Data specified in ISO 14496-15
export type AvcDecoderConfigurationRecord = {
	configurationVersion: number;
	avcProfileIndication: number;
	profileCompatibility: number;
	avcLevelIndication: number;
	lengthSizeMinusOne: number;
	sequenceParameterSets: Uint8Array[];
	pictureParameterSets: Uint8Array[];

	// Fields only for specific profiles:
	chromaFormat: number | null;
	bitDepthLumaMinus8: number | null;
	bitDepthChromaMinus8: number | null;
	sequenceParameterSetExt: Uint8Array[] | null;
};

export const extractAvcNalUnits = (packetData: Uint8Array, decoderConfig: VideoDecoderConfig) => {
	if (decoderConfig.description) {
		// Stream is length-prefixed. Let's extract the size of the length prefix from the decoder config

		const bytes = toUint8Array(decoderConfig.description);
		const lengthSizeMinusOne = bytes[4]! & 0b11;
		const lengthSize = (lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;

		return findNalUnitsInLengthPrefixed(packetData, lengthSize);
	} else {
		// Stream is in Annex B format
		return findNalUnitsInAnnexB(packetData);
	}
};

const extractNalUnitTypeForAvc = (data: Uint8Array) => {
	return data[0]! & 0x1F;
};

/** Builds an AvcDecoderConfigurationRecord from an AVC packet in Annex B format. */
export const extractAvcDecoderConfigurationRecord = (packetData: Uint8Array): AvcDecoderConfigurationRecord | null => {
	try {
		const nalUnits = findNalUnitsInAnnexB(packetData);

		const spsUnits = nalUnits.filter(unit => extractNalUnitTypeForAvc(unit) === AvcNalUnitType.SPS);
		const ppsUnits = nalUnits.filter(unit => extractNalUnitTypeForAvc(unit) === AvcNalUnitType.PPS);
		const spsExtUnits = nalUnits.filter(unit => extractNalUnitTypeForAvc(unit) === AvcNalUnitType.SPS_EXT);

		if (spsUnits.length === 0) {
			return null;
		}

		if (ppsUnits.length === 0) {
			return null;
		}

		// Let's get the first SPS for profile and level information
		const spsData = spsUnits[0]!;
		const spsInfo = parseAvcSps(spsData);
		assert(spsInfo !== null);

		const hasExtendedData = spsInfo.profileIdc === 100
			|| spsInfo.profileIdc === 110
			|| spsInfo.profileIdc === 122
			|| spsInfo.profileIdc === 144;

		return {
			configurationVersion: 1,
			avcProfileIndication: spsInfo.profileIdc,
			profileCompatibility: spsInfo.constraintFlags,
			avcLevelIndication: spsInfo.levelIdc,
			lengthSizeMinusOne: 3, // Typically 4 bytes for length field
			sequenceParameterSets: spsUnits,
			pictureParameterSets: ppsUnits,
			chromaFormat: hasExtendedData ? spsInfo.chromaFormatIdc : null,
			bitDepthLumaMinus8: hasExtendedData ? spsInfo.bitDepthLumaMinus8 : null,
			bitDepthChromaMinus8: hasExtendedData ? spsInfo.bitDepthChromaMinus8 : null,
			sequenceParameterSetExt: hasExtendedData ? spsExtUnits : null,
		};
	} catch (error) {
		console.error('Error building AVC Decoder Configuration Record:', error);
		return null;
	}
};

/** Serializes an AvcDecoderConfigurationRecord into the format specified in Section 5.3.3.1 of ISO 14496-15. */
export const serializeAvcDecoderConfigurationRecord = (record: AvcDecoderConfigurationRecord) => {
	const bytes: number[] = [];

	// Write header
	bytes.push(record.configurationVersion);
	bytes.push(record.avcProfileIndication);
	bytes.push(record.profileCompatibility);
	bytes.push(record.avcLevelIndication);
	bytes.push(0xFC | (record.lengthSizeMinusOne & 0x03)); // Reserved bits (6) + lengthSizeMinusOne (2)

	// Reserved bits (3) + numOfSequenceParameterSets (5)
	bytes.push(0xE0 | (record.sequenceParameterSets.length & 0x1F));

	// Write SPS
	for (const sps of record.sequenceParameterSets) {
		const length = sps.byteLength;
		bytes.push(length >> 8); // High byte
		bytes.push(length & 0xFF); // Low byte

		for (let i = 0; i < length; i++) {
			bytes.push(sps[i]!);
		}
	}

	bytes.push(record.pictureParameterSets.length);

	// Write PPS
	for (const pps of record.pictureParameterSets) {
		const length = pps.byteLength;
		bytes.push(length >> 8); // High byte
		bytes.push(length & 0xFF); // Low byte

		for (let i = 0; i < length; i++) {
			bytes.push(pps[i]!);
		}
	}

	if (
		record.avcProfileIndication === 100
		|| record.avcProfileIndication === 110
		|| record.avcProfileIndication === 122
		|| record.avcProfileIndication === 144
	) {
		assert(record.chromaFormat !== null);
		assert(record.bitDepthLumaMinus8 !== null);
		assert(record.bitDepthChromaMinus8 !== null);
		assert(record.sequenceParameterSetExt !== null);

		bytes.push(0xFC | (record.chromaFormat & 0x03)); // Reserved bits + chroma_format
		bytes.push(0xF8 | (record.bitDepthLumaMinus8 & 0x07)); // Reserved bits + bit_depth_luma_minus8
		bytes.push(0xF8 | (record.bitDepthChromaMinus8 & 0x07)); // Reserved bits + bit_depth_chroma_minus8

		bytes.push(record.sequenceParameterSetExt.length);

		// Write SPS Ext
		for (const spsExt of record.sequenceParameterSetExt) {
			const length = spsExt.byteLength;
			bytes.push(length >> 8); // High byte
			bytes.push(length & 0xFF); // Low byte

			for (let i = 0; i < length; i++) {
				bytes.push(spsExt[i]!);
			}
		}
	}

	return new Uint8Array(bytes);
};

/** Deserializes an AvcDecoderConfigurationRecord from the format specified in Section 5.3.3.1 of ISO 14496-15. */
export const deserializeAvcDecoderConfigurationRecord = (data: Uint8Array): AvcDecoderConfigurationRecord | null => {
	try {
		const view = toDataView(data);
		let offset = 0;

		// Read header
		const configurationVersion = view.getUint8(offset++);
		const avcProfileIndication = view.getUint8(offset++);
		const profileCompatibility = view.getUint8(offset++);
		const avcLevelIndication = view.getUint8(offset++);
		const lengthSizeMinusOne = view.getUint8(offset++) & 0x03;

		const numOfSequenceParameterSets = view.getUint8(offset++) & 0x1F;

		// Read SPS
		const sequenceParameterSets: Uint8Array[] = [];
		for (let i = 0; i < numOfSequenceParameterSets; i++) {
			const length = view.getUint16(offset, false);
			offset += 2;

			sequenceParameterSets.push(data.subarray(offset, offset + length));
			offset += length;
		}

		const numOfPictureParameterSets = view.getUint8(offset++);

		// Read PPS
		const pictureParameterSets: Uint8Array[] = [];
		for (let i = 0; i < numOfPictureParameterSets; i++) {
			const length = view.getUint16(offset, false);
			offset += 2;

			pictureParameterSets.push(data.subarray(offset, offset + length));
			offset += length;
		}

		const record: AvcDecoderConfigurationRecord = {
			configurationVersion,
			avcProfileIndication,
			profileCompatibility,
			avcLevelIndication,
			lengthSizeMinusOne,
			sequenceParameterSets,
			pictureParameterSets,
			chromaFormat: null,
			bitDepthLumaMinus8: null,
			bitDepthChromaMinus8: null,
			sequenceParameterSetExt: null,
		};

		// Check if there are extended profile fields
		if (
			(
				avcProfileIndication === 100
				|| avcProfileIndication === 110
				|| avcProfileIndication === 122
				|| avcProfileIndication === 144
			)
			&& offset + 4 <= data.length
		) {
			const chromaFormat = view.getUint8(offset++) & 0x03;
			const bitDepthLumaMinus8 = view.getUint8(offset++) & 0x07;
			const bitDepthChromaMinus8 = view.getUint8(offset++) & 0x07;
			const numOfSequenceParameterSetExt = view.getUint8(offset++);

			record.chromaFormat = chromaFormat;
			record.bitDepthLumaMinus8 = bitDepthLumaMinus8;
			record.bitDepthChromaMinus8 = bitDepthChromaMinus8;

			// Read SPS Ext
			const sequenceParameterSetExt: Uint8Array[] = [];
			for (let i = 0; i < numOfSequenceParameterSetExt; i++) {
				const length = view.getUint16(offset, false);
				offset += 2;

				sequenceParameterSetExt.push(data.subarray(offset, offset + length));
				offset += length;
			}

			record.sequenceParameterSetExt = sequenceParameterSetExt;
		}

		return record;
	} catch (error) {
		console.error('Error deserializing AVC Decoder Configuration Record:', error);
		return null;
	}
};

export type AvcSpsInfo = {
	profileIdc: number;
	constraintFlags: number;
	levelIdc: number;
	frameMbsOnlyFlag: number;
	chromaFormatIdc: number | null;
	bitDepthLumaMinus8: number | null;
	bitDepthChromaMinus8: number | null;
};

/** Parses an AVC SPS (Sequence Parameter Set) to extract basic information. */
export const parseAvcSps = (sps: Uint8Array): AvcSpsInfo | null => {
	try {
		const bitstream = new Bitstream(removeEmulationPreventionBytes(sps));

		bitstream.skipBits(1); // forbidden_zero_bit
		bitstream.skipBits(2); // nal_ref_idc
		const nalUnitType = bitstream.readBits(5);

		if (nalUnitType !== 7) { // SPS NAL unit type is 7
			return null;
		}

		const profileIdc = bitstream.readAlignedByte();
		const constraintFlags = bitstream.readAlignedByte();
		const levelIdc = bitstream.readAlignedByte();

		readExpGolomb(bitstream); // seq_parameter_set_id

		let chromaFormatIdc: number | null = null;
		let bitDepthLumaMinus8: number | null = null;
		let bitDepthChromaMinus8: number | null = null;

		// Handle high profile chroma_format_idc
		if (
			profileIdc === 100
			|| profileIdc === 110
			|| profileIdc === 122
			|| profileIdc === 244
			|| profileIdc === 44
			|| profileIdc === 83
			|| profileIdc === 86
			|| profileIdc === 118
			|| profileIdc === 128
		) {
			chromaFormatIdc = readExpGolomb(bitstream);
			if (chromaFormatIdc === 3) {
				bitstream.skipBits(1); // separate_colour_plane_flag
			}
			bitDepthLumaMinus8 = readExpGolomb(bitstream);
			bitDepthChromaMinus8 = readExpGolomb(bitstream);
			bitstream.skipBits(1); // qpprime_y_zero_transform_bypass_flag
			const seqScalingMatrixPresentFlag = bitstream.readBits(1);
			if (seqScalingMatrixPresentFlag) {
				for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
					const seqScalingListPresentFlag = bitstream.readBits(1);
					if (seqScalingListPresentFlag) {
						const sizeOfScalingList = i < 6 ? 16 : 64;
						let lastScale = 8;
						let nextScale = 8;
						for (let j = 0; j < sizeOfScalingList; j++) {
							if (nextScale !== 0) {
								const deltaScale = readSignedExpGolomb(bitstream);
								nextScale = (lastScale + deltaScale + 256) % 256;
							}
							lastScale = nextScale === 0 ? lastScale : nextScale;
						}
					}
				}
			}
		}

		readExpGolomb(bitstream); // log2_max_frame_num_minus4

		const picOrderCntType = readExpGolomb(bitstream);
		if (picOrderCntType === 0) {
			readExpGolomb(bitstream); // log2_max_pic_order_cnt_lsb_minus4
		} else if (picOrderCntType === 1) {
			bitstream.skipBits(1); // delta_pic_order_always_zero_flag
			readSignedExpGolomb(bitstream); // offset_for_non_ref_pic
			readSignedExpGolomb(bitstream); // offset_for_top_to_bottom_field
			const numRefFramesInPicOrderCntCycle = readExpGolomb(bitstream);
			for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
				readSignedExpGolomb(bitstream); // offset_for_ref_frame[i]
			}
		}

		readExpGolomb(bitstream); // max_num_ref_frames
		bitstream.skipBits(1); // gaps_in_frame_num_value_allowed_flag

		readExpGolomb(bitstream); // pic_width_in_mbs_minus1
		readExpGolomb(bitstream); // pic_height_in_map_units_minus1

		const frameMbsOnlyFlag = bitstream.readBits(1);

		return {
			profileIdc,
			constraintFlags,
			levelIdc,
			frameMbsOnlyFlag,
			chromaFormatIdc,
			bitDepthLumaMinus8,
			bitDepthChromaMinus8,
		};
	} catch (error) {
		console.error('Error parsing AVC SPS:', error);
		return null;
	}
};

// Data specified in ISO 14496-15
export type HevcDecoderConfigurationRecord = {
	configurationVersion: number;
	generalProfileSpace: number;
	generalTierFlag: number;
	generalProfileIdc: number;
	generalProfileCompatibilityFlags: number;
	generalConstraintIndicatorFlags: Uint8Array; // 6 bytes long
	generalLevelIdc: number;
	minSpatialSegmentationIdc: number;
	parallelismType: number;
	chromaFormatIdc: number;
	bitDepthLumaMinus8: number;
	bitDepthChromaMinus8: number;
	avgFrameRate: number;
	constantFrameRate: number;
	numTemporalLayers: number;
	temporalIdNested: number;
	lengthSizeMinusOne: number;
	arrays: {
		arrayCompleteness: number;
		nalUnitType: number;
		nalUnits: Uint8Array[];
	}[];
};

export const extractHevcNalUnits = (packetData: Uint8Array, decoderConfig: VideoDecoderConfig) => {
	if (decoderConfig.description) {
		// Stream is length-prefixed. Let's extract the size of the length prefix from the decoder config

		const bytes = toUint8Array(decoderConfig.description);
		const lengthSizeMinusOne = bytes[21]! & 0b11;
		const lengthSize = (lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;

		return findNalUnitsInLengthPrefixed(packetData, lengthSize);
	} else {
		// Stream is in Annex B format
		return findNalUnitsInAnnexB(packetData);
	}
};

export const extractNalUnitTypeForHevc = (data: Uint8Array) => {
	return (data[0]! >> 1) & 0x3F;
};

/** Builds a HevcDecoderConfigurationRecord from an HEVC packet in Annex B format. */
export const extractHevcDecoderConfigurationRecord = (
	packetData: Uint8Array,
) => {
	try {
		const nalUnits = findNalUnitsInAnnexB(packetData);

		const vpsUnits = nalUnits.filter(unit => extractNalUnitTypeForHevc(unit) === HevcNalUnitType.VPS_NUT);
		const spsUnits = nalUnits.filter(unit => extractNalUnitTypeForHevc(unit) === HevcNalUnitType.SPS_NUT);
		const ppsUnits = nalUnits.filter(unit => extractNalUnitTypeForHevc(unit) === HevcNalUnitType.PPS_NUT);
		const seiUnits = nalUnits.filter(
			unit => extractNalUnitTypeForHevc(unit) === HevcNalUnitType.PREFIX_SEI_NUT
				|| extractNalUnitTypeForHevc(unit) === HevcNalUnitType.SUFFIX_SEI_NUT,
		);

		if (spsUnits.length === 0 || ppsUnits.length === 0) return null;

		const sps = spsUnits[0]!;
		const bitstream = new Bitstream(removeEmulationPreventionBytes(sps));

		bitstream.skipBits(16); // NAL header

		bitstream.readBits(4); // sps_video_parameter_set_id
		const sps_max_sub_layers_minus1 = bitstream.readBits(3);
		const sps_temporal_id_nesting_flag = bitstream.readBits(1);

		const {
			general_profile_space,
			general_tier_flag,
			general_profile_idc,
			general_profile_compatibility_flags,
			general_constraint_indicator_flags,
			general_level_idc,
		} = parseProfileTierLevel(bitstream, sps_max_sub_layers_minus1);

		readExpGolomb(bitstream); // sps_seq_parameter_set_id

		const chroma_format_idc = readExpGolomb(bitstream);
		if (chroma_format_idc === 3) bitstream.skipBits(1); // separate_colour_plane_flag

		readExpGolomb(bitstream); // pic_width_in_luma_samples
		readExpGolomb(bitstream); // pic_height_in_luma_samples

		if (bitstream.readBits(1)) { // conformance_window_flag
			readExpGolomb(bitstream); // conf_win_left_offset
			readExpGolomb(bitstream); // conf_win_right_offset
			readExpGolomb(bitstream); // conf_win_top_offset
			readExpGolomb(bitstream); // conf_win_bottom_offset
		}

		const bit_depth_luma_minus8 = readExpGolomb(bitstream);
		const bit_depth_chroma_minus8 = readExpGolomb(bitstream);

		readExpGolomb(bitstream); // log2_max_pic_order_cnt_lsb_minus4

		const sps_sub_layer_ordering_info_present_flag = bitstream.readBits(1);
		const maxNum = sps_sub_layer_ordering_info_present_flag ? 0 : sps_max_sub_layers_minus1;
		for (let i = maxNum; i <= sps_max_sub_layers_minus1; i++) {
			readExpGolomb(bitstream); // sps_max_dec_pic_buffering_minus1[i]
			readExpGolomb(bitstream); // sps_max_num_reorder_pics[i]
			readExpGolomb(bitstream); // sps_max_latency_increase_plus1[i]
		}

		readExpGolomb(bitstream); // log2_min_luma_coding_block_size_minus3
		readExpGolomb(bitstream); // log2_diff_max_min_luma_coding_block_size
		readExpGolomb(bitstream); // log2_min_luma_transform_block_size_minus2
		readExpGolomb(bitstream); // log2_diff_max_min_luma_transform_block_size
		readExpGolomb(bitstream); // max_transform_hierarchy_depth_inter
		readExpGolomb(bitstream); // max_transform_hierarchy_depth_intra

		if (bitstream.readBits(1)) { // scaling_list_enabled_flag
			if (bitstream.readBits(1)) {
				skipScalingListData(bitstream);
			}
		}

		bitstream.skipBits(1); // amp_enabled_flag
		bitstream.skipBits(1); // sample_adaptive_offset_enabled_flag

		if (bitstream.readBits(1)) { // pcm_enabled_flag
			bitstream.skipBits(4); // pcm_sample_bit_depth_luma_minus1
			bitstream.skipBits(4); // pcm_sample_bit_depth_chroma_minus1
			readExpGolomb(bitstream); // log2_min_pcm_luma_coding_block_size_minus3
			readExpGolomb(bitstream); // log2_diff_max_min_pcm_luma_coding_block_size
			bitstream.skipBits(1); // pcm_loop_filter_disabled_flag
		}

		const num_short_term_ref_pic_sets = readExpGolomb(bitstream);
		skipAllStRefPicSets(bitstream, num_short_term_ref_pic_sets);

		if (bitstream.readBits(1)) { // long_term_ref_pics_present_flag
			const num_long_term_ref_pics_sps = readExpGolomb(bitstream);
			for (let i = 0; i < num_long_term_ref_pics_sps; i++) {
				readExpGolomb(bitstream); // lt_ref_pic_poc_lsb_sps[i]
				bitstream.skipBits(1); // used_by_curr_pic_lt_sps_flag[i]
			}
		}

		bitstream.skipBits(1); // sps_temporal_mvp_enabled_flag
		bitstream.skipBits(1); // strong_intra_smoothing_enabled_flag

		let min_spatial_segmentation_idc = 0;
		if (bitstream.readBits(1)) { // vui_parameters_present_flag
			min_spatial_segmentation_idc = parseVuiForMinSpatialSegmentationIdc(bitstream, sps_max_sub_layers_minus1);
		}

		// Parse PPS for parallelismType
		let parallelismType = 0;
		if (ppsUnits.length > 0) {
			const pps = ppsUnits[0]!;
			const ppsBitstream = new Bitstream(removeEmulationPreventionBytes(pps));

			ppsBitstream.skipBits(16); // NAL header
			readExpGolomb(ppsBitstream); // pps_pic_parameter_set_id
			readExpGolomb(ppsBitstream); // pps_seq_parameter_set_id
			ppsBitstream.skipBits(1); // dependent_slice_segments_enabled_flag
			ppsBitstream.skipBits(1); // output_flag_present_flag
			ppsBitstream.skipBits(3); // num_extra_slice_header_bits
			ppsBitstream.skipBits(1); // sign_data_hiding_enabled_flag
			ppsBitstream.skipBits(1); // cabac_init_present_flag
			readExpGolomb(ppsBitstream); // num_ref_idx_l0_default_active_minus1
			readExpGolomb(ppsBitstream); // num_ref_idx_l1_default_active_minus1
			readSignedExpGolomb(ppsBitstream); // init_qp_minus26
			ppsBitstream.skipBits(1); // constrained_intra_pred_flag
			ppsBitstream.skipBits(1); // transform_skip_enabled_flag
			if (ppsBitstream.readBits(1)) { // cu_qp_delta_enabled_flag
				readExpGolomb(ppsBitstream); // diff_cu_qp_delta_depth
			}
			readSignedExpGolomb(ppsBitstream); // pps_cb_qp_offset
			readSignedExpGolomb(ppsBitstream); // pps_cr_qp_offset
			ppsBitstream.skipBits(1); // pps_slice_chroma_qp_offsets_present_flag
			ppsBitstream.skipBits(1); // weighted_pred_flag
			ppsBitstream.skipBits(1); // weighted_bipred_flag
			ppsBitstream.skipBits(1); // transquant_bypass_enabled_flag
			const tiles_enabled_flag = ppsBitstream.readBits(1);
			const entropy_coding_sync_enabled_flag = ppsBitstream.readBits(1);

			if (!tiles_enabled_flag && !entropy_coding_sync_enabled_flag) parallelismType = 0;
			else if (tiles_enabled_flag && !entropy_coding_sync_enabled_flag) parallelismType = 2;
			else if (!tiles_enabled_flag && entropy_coding_sync_enabled_flag) parallelismType = 3;
			else parallelismType = 0;
		}

		const arrays = [
			...(vpsUnits.length
				? [
						{
							arrayCompleteness: 1,
							nalUnitType: HevcNalUnitType.VPS_NUT,
							nalUnits: vpsUnits,
						},
					]
				: []),
			...(spsUnits.length
				? [
						{
							arrayCompleteness: 1,
							nalUnitType: HevcNalUnitType.SPS_NUT,
							nalUnits: spsUnits,
						},
					]
				: []),
			...(ppsUnits.length
				? [
						{
							arrayCompleteness: 1,
							nalUnitType: HevcNalUnitType.PPS_NUT,
							nalUnits: ppsUnits,
						},
					]
				: []),
			...(seiUnits.length
				? [
						{
							arrayCompleteness: 1,
							nalUnitType: extractNalUnitTypeForHevc(seiUnits[0]!),
							nalUnits: seiUnits,
						},
					]
				: []),
		];

		const record: HevcDecoderConfigurationRecord = {
			configurationVersion: 1,
			generalProfileSpace: general_profile_space,
			generalTierFlag: general_tier_flag,
			generalProfileIdc: general_profile_idc,
			generalProfileCompatibilityFlags: general_profile_compatibility_flags,
			generalConstraintIndicatorFlags: general_constraint_indicator_flags,
			generalLevelIdc: general_level_idc,
			minSpatialSegmentationIdc: min_spatial_segmentation_idc,
			parallelismType,
			chromaFormatIdc: chroma_format_idc,
			bitDepthLumaMinus8: bit_depth_luma_minus8,
			bitDepthChromaMinus8: bit_depth_chroma_minus8,
			avgFrameRate: 0,
			constantFrameRate: 0,
			numTemporalLayers: sps_max_sub_layers_minus1 + 1,
			temporalIdNested: sps_temporal_id_nesting_flag,
			lengthSizeMinusOne: 3,
			arrays,
		};

		return record;
	} catch (error) {
		console.error('Error building HEVC Decoder Configuration Record:', error);
		return null;
	}
};

const parseProfileTierLevel = (
	bitstream: Bitstream,
	maxNumSubLayersMinus1: number,
) => {
	const general_profile_space = bitstream.readBits(2);
	const general_tier_flag = bitstream.readBits(1);
	const general_profile_idc = bitstream.readBits(5);

	let general_profile_compatibility_flags = 0;
	for (let i = 0; i < 32; i++) {
		general_profile_compatibility_flags = (general_profile_compatibility_flags << 1) | bitstream.readBits(1);
	}

	const general_constraint_indicator_flags = new Uint8Array(6);
	for (let i = 0; i < 6; i++) {
		general_constraint_indicator_flags[i] = bitstream.readBits(8);
	}

	const general_level_idc = bitstream.readBits(8);

	const sub_layer_profile_present_flag: number[] = [];
	const sub_layer_level_present_flag: number[] = [];
	for (let i = 0; i < maxNumSubLayersMinus1; i++) {
		sub_layer_profile_present_flag.push(bitstream.readBits(1));
		sub_layer_level_present_flag.push(bitstream.readBits(1));
	}
	if (maxNumSubLayersMinus1 > 0) {
		for (let i = maxNumSubLayersMinus1; i < 8; i++) {
			bitstream.skipBits(2); // reserved_zero_2bits
		}
	}
	for (let i = 0; i < maxNumSubLayersMinus1; i++) {
		if (sub_layer_profile_present_flag[i]) bitstream.skipBits(88);
		if (sub_layer_level_present_flag[i]) bitstream.skipBits(8);
	}

	return {
		general_profile_space,
		general_tier_flag,
		general_profile_idc,
		general_profile_compatibility_flags,
		general_constraint_indicator_flags,
		general_level_idc,
	};
};

const skipScalingListData = (bitstream: Bitstream) => {
	for (let sizeId = 0; sizeId < 4; sizeId++) {
		for (let matrixId = 0; matrixId < (sizeId === 3 ? 2 : 6); matrixId++) {
			const scaling_list_pred_mode_flag = bitstream.readBits(1);
			if (!scaling_list_pred_mode_flag) {
				readExpGolomb(bitstream); // scaling_list_pred_matrix_id_delta
			} else {
				const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
				if (sizeId > 1) {
					readSignedExpGolomb(bitstream); // scaling_list_dc_coef_minus8
				}
				for (let i = 0; i < coefNum; i++) {
					readSignedExpGolomb(bitstream); // scaling_list_delta_coef
				}
			}
		}
	}
};

const skipAllStRefPicSets = (bitstream: Bitstream, num_short_term_ref_pic_sets: number) => {
	const NumDeltaPocs: number[] = [];
	for (let stRpsIdx = 0; stRpsIdx < num_short_term_ref_pic_sets; stRpsIdx++) {
		NumDeltaPocs[stRpsIdx] = skipStRefPicSet(bitstream, stRpsIdx, num_short_term_ref_pic_sets, NumDeltaPocs);
	}
};

const skipStRefPicSet = (
	bitstream: Bitstream,
	stRpsIdx: number,
	num_short_term_ref_pic_sets: number,
	NumDeltaPocs: number[],
) => {
	let NumDeltaPocsThis = 0;
	let inter_ref_pic_set_prediction_flag = 0;
	let RefRpsIdx = 0;

	if (stRpsIdx !== 0) {
		inter_ref_pic_set_prediction_flag = bitstream.readBits(1);
	}
	if (inter_ref_pic_set_prediction_flag) {
		if (stRpsIdx === num_short_term_ref_pic_sets) {
			const delta_idx_minus1 = readExpGolomb(bitstream);
			RefRpsIdx = stRpsIdx - (delta_idx_minus1 + 1);
		} else {
			RefRpsIdx = stRpsIdx - 1;
		}
		bitstream.readBits(1); // delta_rps_sign
		readExpGolomb(bitstream); // abs_delta_rps_minus1

		// The number of iterations is NumDeltaPocs[RefRpsIdx] + 1
		const numDelta = NumDeltaPocs[RefRpsIdx] ?? 0;
		for (let j = 0; j <= numDelta; j++) {
			const used_by_curr_pic_flag = bitstream.readBits(1);
			if (!used_by_curr_pic_flag) {
				bitstream.readBits(1); // use_delta_flag
			}
		}
		NumDeltaPocsThis = NumDeltaPocs[RefRpsIdx]!;
	} else {
		const num_negative_pics = readExpGolomb(bitstream);
		const num_positive_pics = readExpGolomb(bitstream);

		for (let i = 0; i < num_negative_pics; i++) {
			readExpGolomb(bitstream); // delta_poc_s0_minus1[i]
			bitstream.readBits(1); // used_by_curr_pic_s0_flag[i]
		}
		for (let i = 0; i < num_positive_pics; i++) {
			readExpGolomb(bitstream); // delta_poc_s1_minus1[i]
			bitstream.readBits(1); // used_by_curr_pic_s1_flag[i]
		}
		NumDeltaPocsThis = num_negative_pics + num_positive_pics;
	}
	return NumDeltaPocsThis;
};

const parseVuiForMinSpatialSegmentationIdc = (bitstream: Bitstream, sps_max_sub_layers_minus1: number) => {
	if (bitstream.readBits(1)) { // aspect_ratio_info_present_flag
		const aspect_ratio_idc = bitstream.readBits(8);
		if (aspect_ratio_idc === 255) {
			bitstream.readBits(16); // sar_width
			bitstream.readBits(16); // sar_height
		}
	}
	if (bitstream.readBits(1)) { // overscan_info_present_flag
		bitstream.readBits(1); // overscan_appropriate_flag
	}
	if (bitstream.readBits(1)) { // video_signal_type_present_flag
		bitstream.readBits(3); // video_format
		bitstream.readBits(1); // video_full_range_flag
		if (bitstream.readBits(1)) {
			bitstream.readBits(8); // colour_primaries
			bitstream.readBits(8); // transfer_characteristics
			bitstream.readBits(8); // matrix_coeffs
		}
	}
	if (bitstream.readBits(1)) { // chroma_loc_info_present_flag
		readExpGolomb(bitstream); // chroma_sample_loc_type_top_field
		readExpGolomb(bitstream); // chroma_sample_loc_type_bottom_field
	}
	bitstream.readBits(1); // neutral_chroma_indication_flag
	bitstream.readBits(1); // field_seq_flag
	bitstream.readBits(1); // frame_field_info_present_flag
	if (bitstream.readBits(1)) { // default_display_window_flag
		readExpGolomb(bitstream); // def_disp_win_left_offset
		readExpGolomb(bitstream); // def_disp_win_right_offset
		readExpGolomb(bitstream); // def_disp_win_top_offset
		readExpGolomb(bitstream); // def_disp_win_bottom_offset
	}
	if (bitstream.readBits(1)) { // vui_timing_info_present_flag
		bitstream.readBits(32); // vui_num_units_in_tick
		bitstream.readBits(32); // vui_time_scale
		if (bitstream.readBits(1)) { // vui_poc_proportional_to_timing_flag
			readExpGolomb(bitstream); // vui_num_ticks_poc_diff_one_minus1
		}
		if (bitstream.readBits(1)) {
			skipHrdParameters(bitstream, true, sps_max_sub_layers_minus1);
		}
	}
	if (bitstream.readBits(1)) { // bitstream_restriction_flag
		bitstream.readBits(1); // tiles_fixed_structure_flag
		bitstream.readBits(1); // motion_vectors_over_pic_boundaries_flag
		bitstream.readBits(1); // restricted_ref_pic_lists_flag
		const min_spatial_segmentation_idc = readExpGolomb(bitstream);
		// skip the rest
		readExpGolomb(bitstream); // max_bytes_per_pic_denom
		readExpGolomb(bitstream); // max_bits_per_min_cu_denom
		readExpGolomb(bitstream); // log2_max_mv_length_horizontal
		readExpGolomb(bitstream); // log2_max_mv_length_vertical
		return min_spatial_segmentation_idc;
	}
	return 0;
};

const skipHrdParameters = (
	bitstream: Bitstream,
	commonInfPresentFlag: boolean,
	maxNumSubLayersMinus1: number,
) => {
	let nal_hrd_parameters_present_flag = false;
	let vcl_hrd_parameters_present_flag = false;
	let sub_pic_hrd_params_present_flag = false;

	if (commonInfPresentFlag) {
		nal_hrd_parameters_present_flag = bitstream.readBits(1) === 1;
		vcl_hrd_parameters_present_flag = bitstream.readBits(1) === 1;
		if (nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag) {
			sub_pic_hrd_params_present_flag = bitstream.readBits(1) === 1;
			if (sub_pic_hrd_params_present_flag) {
				bitstream.readBits(8); // tick_divisor_minus2
				bitstream.readBits(5); // du_cpb_removal_delay_increment_length_minus1
				bitstream.readBits(1); // sub_pic_cpb_params_in_pic_timing_sei_flag
				bitstream.readBits(5); // dpb_output_delay_du_length_minus1
			}
			bitstream.readBits(4); // bit_rate_scale
			bitstream.readBits(4); // cpb_size_scale
			if (sub_pic_hrd_params_present_flag) {
				bitstream.readBits(4); // cpb_size_du_scale
			}
			bitstream.readBits(5); // initial_cpb_removal_delay_length_minus1
			bitstream.readBits(5); // au_cpb_removal_delay_length_minus1
			bitstream.readBits(5); // dpb_output_delay_length_minus1
		}
	}

	for (let i = 0; i <= maxNumSubLayersMinus1; i++) {
		const fixed_pic_rate_general_flag = bitstream.readBits(1) === 1;
		let fixed_pic_rate_within_cvs_flag = true; // Default assumption if general is true
		if (!fixed_pic_rate_general_flag) {
			fixed_pic_rate_within_cvs_flag = bitstream.readBits(1) === 1;
		}

		let low_delay_hrd_flag = false; // Default assumption
		if (fixed_pic_rate_within_cvs_flag) {
			readExpGolomb(bitstream); // elemental_duration_in_tc_minus1[i]
		} else {
			low_delay_hrd_flag = bitstream.readBits(1) === 1;
		}

		let CpbCnt = 1; // Default if low_delay is true
		if (!low_delay_hrd_flag) {
			const cpb_cnt_minus1 = readExpGolomb(bitstream); // cpb_cnt_minus1[i]
			CpbCnt = cpb_cnt_minus1 + 1;
		}

		if (nal_hrd_parameters_present_flag) {
			skipSubLayerHrdParameters(bitstream, CpbCnt, sub_pic_hrd_params_present_flag);
		}
		if (vcl_hrd_parameters_present_flag) {
			skipSubLayerHrdParameters(bitstream, CpbCnt, sub_pic_hrd_params_present_flag);
		}
	}
};

const skipSubLayerHrdParameters = (
	bitstream: Bitstream,
	CpbCnt: number,
	sub_pic_hrd_params_present_flag: boolean,
) => {
	for (let i = 0; i < CpbCnt; i++) {
		readExpGolomb(bitstream); // bit_rate_value_minus1[i]
		readExpGolomb(bitstream); // cpb_size_value_minus1[i]
		if (sub_pic_hrd_params_present_flag) {
			readExpGolomb(bitstream); // cpb_size_du_value_minus1[i]
			readExpGolomb(bitstream); // bit_rate_du_value_minus1[i]
		}
		bitstream.readBits(1); // cbr_flag[i]
	}
};

/** Serializes an HevcDecoderConfigurationRecord into the format specified in Section 8.3.3.1 of ISO 14496-15. */
export const serializeHevcDecoderConfigurationRecord = (record: HevcDecoderConfigurationRecord) => {
	const bytes: number[] = [];

	bytes.push(record.configurationVersion);

	bytes.push(
		((record.generalProfileSpace & 0x3) << 6)
		| ((record.generalTierFlag & 0x1) << 5)
		| (record.generalProfileIdc & 0x1F),
	);

	bytes.push((record.generalProfileCompatibilityFlags >>> 24) & 0xFF);
	bytes.push((record.generalProfileCompatibilityFlags >>> 16) & 0xFF);
	bytes.push((record.generalProfileCompatibilityFlags >>> 8) & 0xFF);
	bytes.push(record.generalProfileCompatibilityFlags & 0xFF);

	bytes.push(...record.generalConstraintIndicatorFlags);

	bytes.push(record.generalLevelIdc & 0xFF);

	bytes.push(0xF0 | ((record.minSpatialSegmentationIdc >> 8) & 0x0F)); // Reserved + high nibble
	bytes.push(record.minSpatialSegmentationIdc & 0xFF); // Low byte

	bytes.push(0xFC | (record.parallelismType & 0x03));

	bytes.push(0xFC | (record.chromaFormatIdc & 0x03));

	bytes.push(0xF8 | (record.bitDepthLumaMinus8 & 0x07));

	bytes.push(0xF8 | (record.bitDepthChromaMinus8 & 0x07));

	bytes.push((record.avgFrameRate >> 8) & 0xFF); // High byte
	bytes.push(record.avgFrameRate & 0xFF); // Low byte

	bytes.push(
		((record.constantFrameRate & 0x03) << 6)
		| ((record.numTemporalLayers & 0x07) << 3)
		| ((record.temporalIdNested & 0x01) << 2)
		| (record.lengthSizeMinusOne & 0x03),
	);

	bytes.push(record.arrays.length & 0xFF);

	for (const arr of record.arrays) {
		bytes.push(
			((arr.arrayCompleteness & 0x01) << 7)
			| (0 << 6)
			| (arr.nalUnitType & 0x3F),
		);

		bytes.push((arr.nalUnits.length >> 8) & 0xFF); // High byte
		bytes.push(arr.nalUnits.length & 0xFF); // Low byte

		for (const nal of arr.nalUnits) {
			bytes.push((nal.length >> 8) & 0xFF); // High byte
			bytes.push(nal.length & 0xFF); // Low byte

			for (let i = 0; i < nal.length; i++) {
				bytes.push(nal[i]!);
			}
		}
	}

	return new Uint8Array(bytes);
};

export type Vp9CodecInfo = {
	profile: number;
	level: number;
	bitDepth: number;
	chromaSubsampling: number;
	videoFullRangeFlag: number;
	colourPrimaries: number;
	transferCharacteristics: number;
	matrixCoefficients: number;
};

export const extractVp9CodecInfoFromPacket = (
	packet: Uint8Array,
): Vp9CodecInfo | null => {
	// eslint-disable-next-line @stylistic/max-len
	// https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.7-20170222-draft.pdf
	// http://downloads.webmproject.org/docs/vp9/vp9-bitstream_superframe-and-uncompressed-header_v1.0.pdf

	const bitstream = new Bitstream(packet);

	// Frame marker (0b10)
	const frameMarker = bitstream.readBits(2);
	if (frameMarker !== 2) {
		return null;
	}

	// Profile
	const profileLowBit = bitstream.readBits(1);
	const profileHighBit = bitstream.readBits(1);
	const profile = (profileHighBit << 1) + profileLowBit;

	// Skip reserved bit for profile 3
	if (profile === 3) {
		bitstream.skipBits(1);
	}

	// show_existing_frame
	const showExistingFrame = bitstream.readBits(1);

	if (showExistingFrame === 1) {
		return null;
	}

	// frame_type (0 = key frame)
	const frameType = bitstream.readBits(1);

	if (frameType !== 0) {
		return null;
	}

	// Skip show_frame and error_resilient_mode
	bitstream.skipBits(2);

	// Sync code (0x498342)
	const syncCode = bitstream.readBits(24);
	if (syncCode !== 0x498342) {
		return null;
	}

	// Color config
	let bitDepth = 8;
	if (profile >= 2) {
		const tenOrTwelveBit = bitstream.readBits(1);
		bitDepth = tenOrTwelveBit ? 12 : 10;
	}

	// Color space
	const colorSpace = bitstream.readBits(3);

	let chromaSubsampling = 0;
	let videoFullRangeFlag = 0;

	if (colorSpace !== 7) { // 7 is CS_RGB
		const colorRange = bitstream.readBits(1);
		videoFullRangeFlag = colorRange;

		if (profile === 1 || profile === 3) {
			const subsamplingX = bitstream.readBits(1);
			const subsamplingY = bitstream.readBits(1);

			// 0 = 4:2:0 vertical
			// 1 = 4:2:0 colocated
			// 2 = 4:2:2
			// 3 = 4:4:4
			chromaSubsampling = !subsamplingX && !subsamplingY
				? 3 // 0,0 = 4:4:4
				: subsamplingX && !subsamplingY
					? 2 // 1,0 = 4:2:2
					: 1; // 1,1 = 4:2:0 colocated (default)

			// Skip reserved bit
			bitstream.skipBits(1);
		} else {
			// For profile 0 and 2, always 4:2:0
			chromaSubsampling = 1; // Using colocated as default
		}
	} else {
		// RGB is always 4:4:4
		chromaSubsampling = 3;
		videoFullRangeFlag = 1;
	}

	// Parse frame size
	const widthMinusOne = bitstream.readBits(16);
	const heightMinusOne = bitstream.readBits(16);

	const width = widthMinusOne + 1;
	const height = heightMinusOne + 1;

	// Calculate level based on dimensions
	const pictureSize = width * height;
	let level = last(VP9_LEVEL_TABLE)!.level; // Default to highest level
	for (const entry of VP9_LEVEL_TABLE) {
		if (pictureSize <= entry.maxPictureSize) {
			level = entry.level;
			break;
		}
	}

	// Map color_space to standard values
	const matrixCoefficients = colorSpace === 7
		? 0
		: colorSpace === 2
			? 1
			: colorSpace === 1
				? 6
				: 2;

	const colourPrimaries = colorSpace === 2
		? 1
		: colorSpace === 1
			? 6
			: 2;

	const transferCharacteristics = colorSpace === 2
		? 1
		: colorSpace === 1
			? 6
			: 2;

	return {
		profile,
		level,
		bitDepth,
		chromaSubsampling,
		videoFullRangeFlag,
		colourPrimaries,
		transferCharacteristics,
		matrixCoefficients,
	};
};

export type Av1CodecInfo = {
	profile: number;
	level: number;
	tier: number;
	bitDepth: number;
	monochrome: number;
	chromaSubsamplingX: number;
	chromaSubsamplingY: number;
	chromaSamplePosition: number;
};

/** Iterates over all OBUs in an AV1 packet bistream. */
export const iterateAv1PacketObus = function* (packet: Uint8Array) {
	// https://aomediacodec.github.io/av1-spec/av1-spec.pdf

	const bitstream = new Bitstream(packet);

	const readLeb128 = (): number | null => {
		let value = 0;

		for (let i = 0; i < 8; i++) {
			const byte = bitstream.readAlignedByte();

			value |= ((byte & 0x7f) << (i * 7));

			if (!(byte & 0x80)) {
				break;
			}

			// Spec requirement
			if (i === 7 && (byte & 0x80)) {
				return null;
			}
		}

		// Spec requirement
		if (value >= 2 ** 32 - 1) {
			return null;
		}

		return value;
	};

	while (bitstream.getBitsLeft() >= 8) {
		// Parse OBU header
		bitstream.skipBits(1);
		const obuType = bitstream.readBits(4);
		const obuExtension = bitstream.readBits(1);
		const obuHasSizeField = bitstream.readBits(1);
		bitstream.skipBits(1);

		// Skip extension header if present
		if (obuExtension) {
			bitstream.skipBits(8);
		}

		// Read OBU size if present
		let obuSize: number;
		if (obuHasSizeField) {
			const obuSizeValue = readLeb128();
			if (obuSizeValue === null) return; // It was invalid
			obuSize = obuSizeValue;
		} else {
			// Calculate remaining bits and convert to bytes, rounding down
			obuSize = Math.floor(bitstream.getBitsLeft() / 8);
		}

		assert(bitstream.pos % 8 === 0);

		yield {
			type: obuType,
			data: packet.subarray(bitstream.pos / 8, bitstream.pos / 8 + obuSize),
		};

		// Move to next OBU
		bitstream.skipBits(obuSize * 8);
	}
};

/**
 * When AV1 codec information is not provided by the container, we can still try to extract the information by digging
 * into the AV1 bitstream.
 */
export const extractAv1CodecInfoFromPacket = (
	packet: Uint8Array,
): Av1CodecInfo | null => {
	// https://aomediacodec.github.io/av1-spec/av1-spec.pdf

	for (const { type, data } of iterateAv1PacketObus(packet)) {
		if (type !== 1) {
			continue; // 1 == OBU_SEQUENCE_HEADER
		}

		const bitstream = new Bitstream(data);

		// Read sequence header fields
		const seqProfile = bitstream.readBits(3);

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const stillPicture = bitstream.readBits(1);

		const reducedStillPictureHeader = bitstream.readBits(1);

		let seqLevel = 0;
		let seqTier = 0;
		let bufferDelayLengthMinus1 = 0;

		if (reducedStillPictureHeader) {
			seqLevel = bitstream.readBits(5);
		} else {
			// Parse timing_info_present_flag
			const timingInfoPresentFlag = bitstream.readBits(1);

			if (timingInfoPresentFlag) {
				// Skip timing info (num_units_in_display_tick, time_scale, equal_picture_interval)
				bitstream.skipBits(32); // num_units_in_display_tick
				bitstream.skipBits(32); // time_scale
				const equalPictureInterval = bitstream.readBits(1);

				if (equalPictureInterval) {
					// Skip num_ticks_per_picture_minus_1 (uvlc)
					// Since this is variable length, we'd need to implement uvlc reading
					// For now, we'll return null as this is rare
					return null;
				}
			}

			// Parse decoder_model_info_present_flag
			const decoderModelInfoPresentFlag = bitstream.readBits(1);

			if (decoderModelInfoPresentFlag) {
				// Store buffer_delay_length_minus_1 instead of just skipping
				bufferDelayLengthMinus1 = bitstream.readBits(5);
				bitstream.skipBits(32); // num_units_in_decoding_tick
				bitstream.skipBits(5); // buffer_removal_time_length_minus_1
				bitstream.skipBits(5); // frame_presentation_time_length_minus_1
			}

			// Parse operating_points_cnt_minus_1
			const operatingPointsCntMinus1 = bitstream.readBits(5);

			// For each operating point
			for (let i = 0; i <= operatingPointsCntMinus1; i++) {
				// operating_point_idc[i]
				bitstream.skipBits(12);

				// seq_level_idx[i]
				const seqLevelIdx = bitstream.readBits(5);

				if (i === 0) {
					seqLevel = seqLevelIdx;
				}

				if (seqLevelIdx > 7) {
					// seq_tier[i]
					const seqTierTemp = bitstream.readBits(1);
					if (i === 0) {
						seqTier = seqTierTemp;
					}
				}

				if (decoderModelInfoPresentFlag) {
					// decoder_model_present_for_this_op[i]
					const decoderModelPresentForThisOp = bitstream.readBits(1);

					if (decoderModelPresentForThisOp) {
						const n = bufferDelayLengthMinus1 + 1;
						bitstream.skipBits(n); // decoder_buffer_delay[op]
						bitstream.skipBits(n); // encoder_buffer_delay[op]
						bitstream.skipBits(1); // low_delay_mode_flag[op]
					}
				}

				// initial_display_delay_present_flag
				const initialDisplayDelayPresentFlag = bitstream.readBits(1);

				if (initialDisplayDelayPresentFlag) {
					// initial_display_delay_minus_1[i]
					bitstream.skipBits(4);
				}
			}
		}

		const highBitdepth = bitstream.readBits(1);

		let bitDepth = 8;
		if (seqProfile === 2 && highBitdepth) {
			const twelveBit = bitstream.readBits(1);
			bitDepth = twelveBit ? 12 : 10;
		} else if (seqProfile <= 2) {
			bitDepth = highBitdepth ? 10 : 8;
		}

		let monochrome = 0;
		if (seqProfile !== 1) {
			monochrome = bitstream.readBits(1);
		}

		let chromaSubsamplingX = 1;
		let chromaSubsamplingY = 1;
		let chromaSamplePosition = 0;

		if (!monochrome) {
			if (seqProfile === 0) {
				chromaSubsamplingX = 1;
				chromaSubsamplingY = 1;
			} else if (seqProfile === 1) {
				chromaSubsamplingX = 0;
				chromaSubsamplingY = 0;
			} else {
				if (bitDepth === 12) {
					chromaSubsamplingX = bitstream.readBits(1);
					if (chromaSubsamplingX) {
						chromaSubsamplingY = bitstream.readBits(1);
					}
				}
			}

			if (chromaSubsamplingX && chromaSubsamplingY) {
				chromaSamplePosition = bitstream.readBits(2);
			}
		}

		return {
			profile: seqProfile,
			level: seqLevel,
			tier: seqTier,
			bitDepth,
			monochrome,
			chromaSubsamplingX,
			chromaSubsamplingY,
			chromaSamplePosition,
		};
	}

	return null;
};

export const parseOpusIdentificationHeader = (bytes: Uint8Array) => {
	const view = toDataView(bytes);

	const outputChannelCount = view.getUint8(9);
	const preSkip = view.getUint16(10, true);
	const inputSampleRate = view.getUint32(12, true);
	const outputGain = view.getInt16(16, true);
	const channelMappingFamily = view.getUint8(18);

	let channelMappingTable: Uint8Array | null = null;
	if (channelMappingFamily) {
		channelMappingTable = bytes.subarray(19, 19 + 2 + outputChannelCount);
	}

	return {
		outputChannelCount,
		preSkip,
		inputSampleRate,
		outputGain,
		channelMappingFamily,
		channelMappingTable,
	};
};

// From https://datatracker.ietf.org/doc/html/rfc6716, in 48 kHz samples
const OPUS_FRAME_DURATION_TABLE = [
	480, 960, 1920, 2880,
	480, 960, 1920, 2880,
	480, 960, 1920, 2880,
	480, 960,
	480, 960,
	120, 240, 480, 960,
	120, 240, 480, 960,
	120, 240, 480, 960,
	120, 240, 480, 960,
];

export const parseOpusTocByte = (packet: Uint8Array) => {
	const config = packet[0]! >> 3;

	return {
		durationInSamples: OPUS_FRAME_DURATION_TABLE[config]!,
	};
};

// Based on vorbis_parser.c from FFmpeg.
export const parseModesFromVorbisSetupPacket = (setupHeader: Uint8Array) => {
	// Verify that this is a Setup header.
	if (setupHeader.length < 7) {
		throw new Error('Setup header is too short.');
	}
	if (setupHeader[0] !== 5) {
		throw new Error('Wrong packet type in Setup header.');
	}
	const signature = String.fromCharCode(...setupHeader.slice(1, 7));
	if (signature !== 'vorbis') {
		throw new Error('Invalid packet signature in Setup header.');
	}

	// Reverse the entire buffer.
	const bufSize = setupHeader.length;
	const revBuffer = new Uint8Array(bufSize);
	for (let i = 0; i < bufSize; i++) {
		revBuffer[i] = setupHeader[bufSize - 1 - i]!;
	}

	// Initialize a Bitstream on the reversed buffer.
	const bitstream = new Bitstream(revBuffer);

	// --- Find the framing bit.
	// In FFmpeg code, we scan until get_bits1() returns 1.
	let gotFramingBit = 0;
	while (bitstream.getBitsLeft() > 97) {
		if (bitstream.readBits(1) === 1) {
			gotFramingBit = bitstream.pos;
			break;
		}
	}
	if (gotFramingBit === 0) {
		throw new Error('Invalid Setup header: framing bit not found.');
	}

	// --- Search backwards for a valid mode header.
	// We try to “guess” the number of modes by reading a fixed pattern.
	let modeCount = 0;
	let gotModeHeader = false;
	let lastModeCount = 0;
	while (bitstream.getBitsLeft() >= 97) {
		const tempPos = bitstream.pos;
		const a = bitstream.readBits(8);
		const b = bitstream.readBits(16);
		const c = bitstream.readBits(16);
		// If a > 63 or b or c nonzero, assume we’ve gone too far.
		if (a > 63 || b !== 0 || c !== 0) {
			bitstream.pos = tempPos;
			break;
		}
		bitstream.skipBits(1);
		modeCount++;
		if (modeCount > 64) {
			break;
		}
		const bsClone = bitstream.clone();
		const candidate = bsClone.readBits(6) + 1;
		if (candidate === modeCount) {
			gotModeHeader = true;
			lastModeCount = modeCount;
		}
	}
	if (!gotModeHeader) {
		throw new Error('Invalid Setup header: mode header not found.');
	}
	if (lastModeCount > 63) {
		throw new Error(`Unsupported mode count: ${lastModeCount}.`);
	}
	const finalModeCount = lastModeCount;

	// --- Reinitialize the bitstream.
	bitstream.pos = 0;
	// Skip the bits up to the found framing bit.
	bitstream.skipBits(gotFramingBit);

	// --- Now read, for each mode (in reverse order), 40 bits then one bit.
	// That one bit is the mode blockflag.
	const modeBlockflags = Array(finalModeCount).fill(0) as	number[];
	for (let i = finalModeCount - 1; i >= 0; i--) {
		bitstream.skipBits(40);
		modeBlockflags[i] = bitstream.readBits(1);
	}

	return { modeBlockflags };
};

/** Determines a packet's type (key or delta) by digging into the packet bitstream. */
export const determineVideoPacketType = (
	codec: VideoCodec,
	decoderConfig: VideoDecoderConfig,
	packetData: Uint8Array,
): PacketType | null => {
	switch (codec) {
		case 'avc': {
			const nalUnits = extractAvcNalUnits(packetData, decoderConfig);
			const isKeyframe = nalUnits.some(x => extractNalUnitTypeForAvc(x) === AvcNalUnitType.IDR);

			return isKeyframe ? 'key' : 'delta';
		};

		case 'hevc': {
			const nalUnits = extractHevcNalUnits(packetData, decoderConfig);
			const isKeyframe = nalUnits.some((x) => {
				const type = extractNalUnitTypeForHevc(x);
				return HevcNalUnitType.BLA_W_LP <= type && type <= HevcNalUnitType.RSV_IRAP_VCL23;
			});

			return isKeyframe ? 'key' : 'delta';
		};

		case 'vp8': {
			// VP8, once again, by far the easiest to deal with.
			const frameType = packetData[0]! & 0b1;
			return frameType === 0 ? 'key' : 'delta';
		};

		case 'vp9': {
			const bitstream = new Bitstream(packetData);

			if (bitstream.readBits(2) !== 2) {
				return null;
			};

			const profileLowBit = bitstream.readBits(1);
			const profileHighBit = bitstream.readBits(1);
			const profile = (profileHighBit << 1) + profileLowBit;

			// Skip reserved bit for profile 3
			if (profile === 3) {
				bitstream.skipBits(1);
			}

			const showExistingFrame = bitstream.readBits(1);
			if (showExistingFrame) {
				return null;
			}

			const frameType = bitstream.readBits(1);
			return frameType === 0 ? 'key' : 'delta';
		};

		case 'av1': {
			let reducedStillPictureHeader = false;

			for (const { type, data } of iterateAv1PacketObus(packetData)) {
				if (type === 1) { // OBU_SEQUENCE_HEADER
					const bitstream = new Bitstream(data);

					bitstream.skipBits(4);
					reducedStillPictureHeader = !!bitstream.readBits(1);
				} else if (
					type === 3 // OBU_FRAME_HEADER
					|| type === 6 // OBU_FRAME
					|| type === 7 // OBU_REDUNDANT_FRAME_HEADER
				) {
					if (reducedStillPictureHeader) {
						return 'key';
					}

					const bitstream = new Bitstream(data);
					const showExistingFrame = bitstream.readBits(1);
					if (showExistingFrame) {
						return null;
					}

					const frameType = bitstream.readBits(2);
					return frameType === 0 ? 'key' : 'delta';
				}
			}

			return null;
		};

		default: {
			assertNever(codec);
			assert(false);
		};
	}
};

export enum FlacBlockType {
	STREAMINFO = 0,
	VORBIS_COMMENT = 4,
	PICTURE = 6,
}

export const readVorbisComments = (bytes: Uint8Array, metadataTags: MetadataTags) => {
	// https://datatracker.ietf.org/doc/html/rfc7845#section-5.2

	const commentView = toDataView(bytes);
	let commentPos = 0;

	const vendorStringLength = commentView.getUint32(commentPos, true);
	commentPos += 4;

	const vendorString = textDecoder.decode(
		bytes.subarray(commentPos, commentPos + vendorStringLength),
	);
	commentPos += vendorStringLength;

	if (vendorStringLength > 0) {
		// Expose the vendor string in the raw metadata
		metadataTags.raw ??= {};
		metadataTags.raw['vendor'] ??= vendorString;
	}

	const listLength = commentView.getUint32(commentPos, true);
	commentPos += 4;

	// Loop over all metadata tags
	for (let i = 0; i < listLength; i++) {
		const stringLength = commentView.getUint32(commentPos, true);
		commentPos += 4;

		const string = textDecoder.decode(
			bytes.subarray(commentPos, commentPos + stringLength),
		);
		commentPos += stringLength;

		const separatorIndex = string.indexOf('=');
		if (separatorIndex === -1) {
			continue;
		}

		const key = string.slice(0, separatorIndex).toUpperCase();
		const value = string.slice(separatorIndex + 1);

		metadataTags.raw ??= {};
		metadataTags.raw[key] ??= value;

		switch (key) {
			case 'TITLE': {
				metadataTags.title ??= value;
			}; break;

			case 'DESCRIPTION': {
				metadataTags.description ??= value;
			}; break;

			case 'ARTIST': {
				metadataTags.artist ??= value;
			}; break;

			case 'ALBUM': {
				metadataTags.album ??= value;
			}; break;

			case 'ALBUMARTIST': {
				metadataTags.albumArtist ??= value;
			}; break;

			case 'COMMENT': {
				metadataTags.comment ??= value;
			}; break;

			case 'LYRICS': {
				metadataTags.lyrics ??= value;
			}; break;

			case 'TRACKNUMBER': {
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

			case 'TRACKTOTAL': {
				const tracksTotal = Number.parseInt(value, 10);
				if (Number.isInteger(tracksTotal) && tracksTotal > 0) {
					metadataTags.tracksTotal ??= tracksTotal;
				}
			}; break;

			case 'DISCNUMBER': {
				const parts = value.split('/');
				const discNum = Number.parseInt(parts[0]!, 10);
				const discsTotal = parts[1] && Number.parseInt(parts[1], 10);

				if (Number.isInteger(discNum) && discNum > 0) {
					metadataTags.discNumber ??= discNum;
				}
				if (discsTotal && Number.isInteger(discsTotal) && discsTotal > 0) {
					metadataTags.discsTotal ??= discsTotal;
				}
			}; break;

			case 'DISCTOTAL': {
				const discsTotal = Number.parseInt(value, 10);
				if (Number.isInteger(discsTotal) && discsTotal > 0) {
					metadataTags.discsTotal ??= discsTotal;
				}
			}; break;

			case 'DATE': {
				const date = new Date(value);
				if (!Number.isNaN(date.getTime())) {
					metadataTags.date ??= date;
				}
			}; break;

			case 'GENRE': {
				metadataTags.genre ??= value;
			}; break;

			case 'METADATA_BLOCK_PICTURE': {
				// https://datatracker.ietf.org/doc/rfc9639/ Section 8.8
				const decoded = base64ToBytes(value);

				const view = toDataView(decoded);
				const pictureType = view.getUint32(0, false);
				const mediaTypeLength = view.getUint32(4, false);
				const mediaType = String.fromCharCode(...decoded.subarray(8, 8 + mediaTypeLength)); // ASCII
				const descriptionLength = view.getUint32(8 + mediaTypeLength, false);
				const description = textDecoder.decode(decoded.subarray(
					12 + mediaTypeLength,
					12 + mediaTypeLength + descriptionLength,
				));
				const dataLength = view.getUint32(mediaTypeLength + descriptionLength + 28);
				const data = decoded.subarray(
					mediaTypeLength + descriptionLength + 32,
					mediaTypeLength + descriptionLength + 32 + dataLength,
				);

				metadataTags.images ??= [];
				metadataTags.images.push({
					data,
					mimeType: mediaType,
					kind: pictureType === 3 ? 'coverFront' : pictureType === 4 ? 'coverBack' : 'unknown',
					name: undefined,
					description: description || undefined,
				});
			}; break;
		}
	}
};

export const createVorbisComments = (headerBytes: Uint8Array, tags: MetadataTags, writeImages: boolean) => {
	// https://datatracker.ietf.org/doc/html/rfc7845#section-5.2

	const commentHeaderParts: Uint8Array[] = [
		headerBytes,
	];

	const vendorString = 'Mediabunny';
	const encodedVendorString = textEncoder.encode(vendorString);

	let currentBuffer = new Uint8Array(4 + encodedVendorString.length);
	let currentView = new DataView(currentBuffer.buffer);
	currentView.setUint32(0, encodedVendorString.length, true);
	currentBuffer.set(encodedVendorString, 4);

	commentHeaderParts.push(currentBuffer);

	const writtenTags = new Set<string>();
	const addCommentTag = (key: string, value: string) => {
		const joined = `${key}=${value}`;
		const encoded = textEncoder.encode(joined);

		currentBuffer = new Uint8Array(4 + encoded.length);
		currentView = new DataView(currentBuffer.buffer);

		currentView.setUint32(0, encoded.length, true);
		currentBuffer.set(encoded, 4);

		commentHeaderParts.push(currentBuffer);
		writtenTags.add(key);
	};

	for (const { key, value } of keyValueIterator(tags)) {
		switch (key) {
			case 'title': {
				addCommentTag('TITLE', value);
			}; break;

			case 'description': {
				addCommentTag('DESCRIPTION', value);
			}; break;

			case 'artist': {
				addCommentTag('ARTIST', value);
			}; break;

			case 'album': {
				addCommentTag('ALBUM', value);
			}; break;

			case 'albumArtist': {
				addCommentTag('ALBUMARTIST', value);
			}; break;

			case 'genre': {
				addCommentTag('GENRE', value);
			}; break;

			case 'date': {
				const rawVersion = tags.raw?.['DATE'] ?? tags.raw?.['date'];
				if (rawVersion && typeof rawVersion === 'string') {
					addCommentTag('DATE', rawVersion);
				} else {
					addCommentTag('DATE', value.toISOString().slice(0, 10));
				}
			}; break;

			case 'comment': {
				addCommentTag('COMMENT', value);
			}; break;

			case 'lyrics': {
				addCommentTag('LYRICS', value);
			}; break;

			case 'trackNumber': {
				addCommentTag('TRACKNUMBER', value.toString());
			}; break;

			case 'tracksTotal': {
				addCommentTag('TRACKTOTAL', value.toString());
			}; break;

			case 'discNumber': {
				addCommentTag('DISCNUMBER', value.toString());
			}; break;

			case 'discsTotal': {
				addCommentTag('DISCTOTAL', value.toString());
			}; break;

			case 'images': {
				// For example, in .flac, we put the pictures in a different section,
				// not in the Vorbis comment header.
				if (!writeImages) {
					break;
				}
				for (const image of value) {
					// https://datatracker.ietf.org/doc/rfc9639/ Section 8.8
					const pictureType = image.kind === 'coverFront' ? 3 : image.kind === 'coverBack' ? 4 : 0;
					const encodedMediaType = new Uint8Array(image.mimeType.length);

					for (let i = 0; i < image.mimeType.length; i++) {
						encodedMediaType[i] = image.mimeType.charCodeAt(i);
					}

					const encodedDescription = textEncoder.encode(image.description ?? '');

					const buffer = new Uint8Array(
						4 // Picture type
						+ 4 // MIME type length
						+ encodedMediaType.length // MIME type
						+ 4 // Description length
						+ encodedDescription.length // Description
						+ 16 // Width, height, color depth, number of colors
						+ 4 // Picture data length
						+ image.data.length, // Picture data
					);
					const view = toDataView(buffer);

					view.setUint32(0, pictureType, false);
					view.setUint32(4, encodedMediaType.length, false);
					buffer.set(encodedMediaType, 8);
					view.setUint32(8 + encodedMediaType.length, encodedDescription.length, false);
					buffer.set(encodedDescription, 12 + encodedMediaType.length);
					// Skip a bunch of fields (width, height, color depth, number of colors)
					view.setUint32(
						28 + encodedMediaType.length + encodedDescription.length, image.data.length, false,
					);
					buffer.set(
						image.data,
						32 + encodedMediaType.length + encodedDescription.length,
					);

					const encoded = bytesToBase64(buffer);
					addCommentTag('METADATA_BLOCK_PICTURE', encoded);
				}
			}; break;

			case 'raw': {
				// Handled later
			}; break;

			default: assertNever(key);
		}
	}

	if (tags.raw) {
		for (const key in tags.raw) {
			const value = tags.raw[key] ?? tags.raw[key.toLowerCase()];
			if (key === 'vendor' || value == null || writtenTags.has(key)) {
				continue;
			}

			if (typeof value === 'string') {
				addCommentTag(key, value);
			}
		}
	}

	const listLengthBuffer = new Uint8Array(4);
	toDataView(listLengthBuffer).setUint32(0, writtenTags.size, true);
	commentHeaderParts.splice(2, 0, listLengthBuffer); // Insert after the header and vendor section

	// Merge all comment header parts into a single buffer
	const commentHeaderLength = commentHeaderParts.reduce((a, b) => a + b.length, 0);
	const commentHeader = new Uint8Array(commentHeaderLength);

	let pos = 0;
	for (const part of commentHeaderParts) {
		commentHeader.set(part, pos);
		pos += part.length;
	}

	return commentHeader;
};
