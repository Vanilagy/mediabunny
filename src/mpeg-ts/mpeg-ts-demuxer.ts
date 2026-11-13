/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from '../output';
import { SAMPLES_PER_AAC_FRAME } from '../adts/adts-demuxer';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import {
	aacChannelMap,
	aacFrequencyTable,
	getAacProgramConfigElementChannelCount,
	readAdtsProgramConfigElement,
} from '../../shared/aac-misc';
import {
	AacCodecInfo,
	AudioCodec,
	DtsFourCc,
	extractAudioCodecString,
	extractVideoCodecString,
	MediaCodec,
	VideoCodec,
} from '../codec';
import {
	AC3_ACMOD_CHANNEL_COUNTS,
	AC3_SAMPLES_PER_FRAME,
	AvcDecoderConfigurationRecord,
	AvcNalUnitType,
	determineVideoPacketType,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	EAC3_NUMBLKS_TABLE,
	getEac3ChannelCount,
	getEac3SampleRate,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	parseAc3SyncFrame,
	parseAvcSps,
	parseEac3SyncFrame,
	parseHevcSps,
	AC3_FRAME_SIZES,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	parseDtsFrame,
	parseDtsCoreFrameHeader,
	parseDtsExssHeader,
	DTS_CORE_FRAME_HEADER_SIZE,
	DTS_EXSS_HEADER_PREFIX_SIZE,
	DTS_EXSS_MAX_HEADER_SIZE,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { Logging } from '../logging';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	assert,
	binarySearchExact,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	floorToMultiple,
	isThenable,
	IDENTITY_MATRIX,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	readExpGolomb,
	roundIfAlmostInteger,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import {
	MP3_FRAME_HEADER_SIZE,
	getMp3ChannelCount,
	readMp3FrameHeader,
} from '../../shared/mp3-misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader, readU16Be, readU32Be, readU8 } from '../reader';
import {
	buildMpegTsMimeType,
	createTimestampWrapInfo,
	MpegTsStreamType,
	normalizeWrappedTimestamp,
	MPEG_TS_TIMESCALE,
	TimestampWrapInfo,
	TS_PACKET_SIZE,
} from './mpeg-ts-misc';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';
import { Bitstream } from '../../shared/bitstream';

// Resources:
// ISO/IEC 13818-1

const MISSING_PTS_ERROR_MESSAGE = 'PES packet is missing PTS where it was expected. PES packets without PTS are not'
	+ ' currently supported. If you think this file should be supported, please report it.';

const REGISTRATION_DESCRIPTOR_TAG = 0x05;

// The 'HDMV' and 'HDPR' format identifiers, which mark a program as Blu-ray-derived
const HDMV_FORMAT_IDENTIFIER = 0x48444d56;
const HDPR_FORMAT_IDENTIFIER = 0x48445052;

// 'DTS1', 'DTS2' and 'DTS3' all share this prefix
const DTS_FORMAT_IDENTIFIER_PREFIX = 0x44545300;

// Stream types that only mean DTS within a Blu-ray-derived program
const BLU_RAY_DTS_STREAM_TYPES = new Set<number>([
	MpegTsStreamType.BLU_RAY_DTS_HD,
	MpegTsStreamType.BLU_RAY_DTS_HD_MASTER,
	MpegTsStreamType.BLU_RAY_DTS_EXPRESS_SECONDARY,
]);

type ElementaryStream = {
	demuxer: MpegTsDemuxer;
	pid: number;
	streamType: number;
	initialized: boolean;
	firstSection: Section | null;
	/**
	 * Some muxers suck ass and don't correctly label key frames, meaning we'll need to use our skill to
	 * compensate for another programmer's skill issue.
	 */
	canBeTrustedWithKeyPackets: boolean;
	info: {
		type: 'video';
		codec: VideoCodec;
		decoderConfig: VideoDecoderConfig | null;
		avcCodecInfo: AvcDecoderConfigurationRecord | null;
		hevcCodecInfo: HevcDecoderConfigurationRecord | null;
		colorSpace: VideoColorSpaceInit;
		width: number;
		height: number;
		squarePixelWidth: number;
		squarePixelHeight: number;
		reorderSize: number;
	} | {
		type: 'audio';
		codec: AudioCodec;
		decoderConfig: AudioDecoderConfig | null;
		aacCodecInfo: AacCodecInfo | null;
		dtsFormat: DtsFourCc | null;
		numberOfChannels: number;
		sampleRate: number;
	};
	/**
	 * Reference PES packets, spread throughout the file, to be used to speed up repeated random access. Sorted by both
	 * byte offset and PTS.
	 */
	referencePesPackets: TimestampedPesPacketHeader[];
};

type ElementaryVideoStream = ElementaryStream & { info: { type: 'video' } };
type ElementaryAudioStream = ElementaryStream & { info: { type: 'audio' } };

type TsPacketHeader = {
	payloadUnitStartIndicator: number;
	pid: number;
	adaptationFieldControl: number;
};

type TsPacket = TsPacketHeader & {
	body: Uint8Array<ArrayBufferLike>;
};

type Section = {
	startPos: number;
	pid: number;
	payload: Uint8Array<ArrayBufferLike>;
	randomAccessIndicator: number;
};

// Remember them so the warning doesn't get spammed
const ignoredStreamTypes = new Set<number>();

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	trackBackingEntries: InputTrackBacking[] = [];
	packetOffset = 0;
	packetStride = -1;
	sectionEndPositions: number[] = [];
	seekChunkSize = 5 * 1024 * 1024; // 5 MiB, picked because most HLS segments are below this size
	minReferencePointByteDistance = -1;
	timestampWrapInfo: TimestampWrapInfo | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const lengthToCheck = TS_PACKET_SIZE + 16 + 1;
			let startingSlice = this.reader.requestSlice(0, lengthToCheck);
			if (isThenable(startingSlice)) startingSlice = await startingSlice;
			assert(startingSlice);

			const startingBytes = readBytes(startingSlice, lengthToCheck);

			if (startingBytes[0] === 0x47 && startingBytes[TS_PACKET_SIZE] === 0x47) {
				// Regular MPEG-TS
				this.packetOffset = 0;
				this.packetStride = TS_PACKET_SIZE;
			} else if (startingBytes[0] === 0x47 && startingBytes[TS_PACKET_SIZE + 16] === 0x47) {
				// MPEG-TS with Forward Error Correction
				this.packetOffset = 0;
				this.packetStride = TS_PACKET_SIZE + 16;
			} else if (startingBytes[4] === 0x47 && startingBytes[4 + TS_PACKET_SIZE + 4] === 0x47) {
				// MPEG-2-TS (DVHS)
				this.packetOffset = 4;
				this.packetStride = TS_PACKET_SIZE + 4;
			} else {
				throw new Error('Unreachable.');
			}

			const MIN_REFERENCE_POINT_PACKET_DISTANCE = 256;
			this.minReferencePointByteDistance = MIN_REFERENCE_POINT_PACKET_DISTANCE * this.packetStride;

			let currentPos = this.packetOffset;
			let programMapPid: number | null = null;
			// Some files contain these multiple times, but we only care about their first appearance
			let hasProgramAssociationTable = false;
			let hasProgramMap = false;

			while (true) {
				const packetHeader = await this.readPacketHeader(currentPos);
				if (!packetHeader) {
					break;
				}

				if (packetHeader.payloadUnitStartIndicator === 0) {
					// Not the start of a section
					currentPos += this.packetStride;
					continue;
				}

				if (
					hasProgramMap
					&& !this.elementaryStreams.some(x => x.pid === packetHeader.pid && !x.initialized)
				) {
					// Don't care about this PID (anymore)
					currentPos += this.packetStride;
					continue;
				}

				const isElementaryStreamPid = this.elementaryStreams.some(x => x.pid === packetHeader.pid);
				const section = await this.readSection(
					currentPos,
					!isElementaryStreamPid,
					!hasProgramMap, // Expect contiguous sections as long as we don't have the PMT
				);
				if (!section) {
					break;
				}

				const BITS_IN_CRC_32 = 32; // Duh

				// Some streams don't contain a PAT for some reason, so as long as we haven't seen one, we must do some
				// guesswork to figure out where the PMT is. Either way, the PMT PID may also carry private sections, so
				// the table ID tells us it's the PMT.
				let isProgramMap = false;
				if (
					!hasProgramMap
					&& section.pid !== 0
					&& (programMapPid === null || section.pid === programMapPid)
				) {
					const isPesPacket
						= section.payload[0] === 0x00 && section.payload[1] === 0x00 && section.payload[2] === 0x01;

					if (!isPesPacket) {
						// Assume it's a PSI

						const bitstream = new Bitstream(section.payload);
						const pointerField = bitstream.readAlignedByte();

						bitstream.skipBits(8 * pointerField);

						const tableId = bitstream.readBits(8);
						isProgramMap = tableId === 0x02; // 0x02 == TS_program_map_section
					}
				}

				if (section.pid === 0 && !hasProgramAssociationTable) {
					const bitstream = new Bitstream(section.payload);
					const pointerField = bitstream.readAlignedByte();

					bitstream.skipBits(8 * pointerField);

					bitstream.skipBits(14);
					const sectionLength = bitstream.readBits(10);
					const sectionEndPos = bitstream.pos + 8 * sectionLength;

					bitstream.skipBits(40);

					while (sectionEndPos - bitstream.pos > BITS_IN_CRC_32) {
						const programNumber = bitstream.readBits(16);
						bitstream.skipBits(3); // Reserved
						const id = bitstream.readBits(13);

						if (programNumber !== 0) {
							if (programMapPid !== null) {
								throw new Error('Only files with a single program are supported.');
							} else {
								programMapPid = id;
							}
						}
					}

					if (programMapPid === null) {
						throw new Error('Program Association Table must link to a Program Map Table.');
					}

					hasProgramAssociationTable = true;
				} else if (isProgramMap) {
					const bitstream = new Bitstream(section.payload);
					const pointerField = bitstream.readAlignedByte();

					bitstream.skipBits(8 * pointerField);

					bitstream.skipBits(12);
					const sectionLength = bitstream.readBits(12);
					const sectionEndPos = bitstream.pos + 8 * sectionLength;

					bitstream.skipBits(43);
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const pcrPid = bitstream.readBits(13);

					bitstream.skipBits(6);

					// "The remaining 10 bits specify the number of bytes of the descriptors immediately following the
					// program_info_length field"
					const programInfoLength = bitstream.readBits(10);

					// A few stream types only mean what Blu-ray says they mean, and the program's registration
					// descriptor is what tells us we're looking at a Blu-ray-derived stream.
					const programInfoEndPos = bitstream.pos + 8 * programInfoLength;
					let isBluRayProgram = false;

					while (bitstream.pos < programInfoEndPos) {
						const descriptorTag = bitstream.readBits(8);
						const descriptorLength = bitstream.readBits(8);
						const descriptorEndPos = bitstream.pos + 8 * descriptorLength;

						if (descriptorTag === REGISTRATION_DESCRIPTOR_TAG && descriptorLength >= 4) {
							const formatIdentifier = bitstream.readBits(32);
							isBluRayProgram ||= formatIdentifier === HDMV_FORMAT_IDENTIFIER
								|| formatIdentifier === HDPR_FORMAT_IDENTIFIER;
						}

						bitstream.pos = descriptorEndPos;
					}

					bitstream.pos = programInfoEndPos;

					while (sectionEndPos - bitstream.pos > BITS_IN_CRC_32) {
						const streamType = bitstream.readBits(8);
						bitstream.skipBits(3);
						const elementaryPid = bitstream.readBits(13);

						bitstream.skipBits(6);
						const esInfoLength = bitstream.readBits(10);

						// Check ES descriptors to detect AC-3/E-AC-3/DTS in System B
						const esInfoEndPos = bitstream.pos + 8 * esInfoLength;
						let hasAc3Descriptor = false;
						let hasEac3Descriptor = false;
						let hasDtsDescriptor = false;
						while (bitstream.pos < esInfoEndPos) {
							const descriptorTag = bitstream.readBits(8);
							const descriptorLength = bitstream.readBits(8);
							const descriptorEndPos = bitstream.pos + 8 * descriptorLength;

							if (descriptorTag === 0x6a) {
								hasAc3Descriptor = true;
							} else if (descriptorTag === 0x7a || descriptorTag === 0xcc) {
								hasEac3Descriptor = true;
							} else if (descriptorTag === 0x7b) {
								hasDtsDescriptor = true;
							} else if (descriptorTag === REGISTRATION_DESCRIPTOR_TAG && descriptorLength >= 4) {
								// DTS uses 'DTS1', 'DTS2' and 'DTS3' to also signal the stream's frame size,
								// which we work out from the bitstream anyway
								const formatIdentifier = bitstream.readBits(32);
								hasDtsDescriptor ||= (formatIdentifier & 0xffffff00) === DTS_FORMAT_IDENTIFIER_PREFIX;
							}

							bitstream.pos = descriptorEndPos;
						}

						let info: ElementaryStream['info'] | null = null;

						// Blu-ray has its own stream types for the DTS extensions
						const effectiveStreamType = isBluRayProgram && BLU_RAY_DTS_STREAM_TYPES.has(streamType)
							? MpegTsStreamType.DTS
							: streamType;

						switch (effectiveStreamType) {
							case MpegTsStreamType.AVC:
							case MpegTsStreamType.HEVC: {
								const codec = streamType === MpegTsStreamType.AVC ? 'avc' : 'hevc';

								info = {
									type: 'video',
									codec,
									decoderConfig: null,
									avcCodecInfo: null,
									hevcCodecInfo: null,
									colorSpace: {
										primaries: null,
										transfer: null,
										matrix: null,
										fullRange: null,
									},
									width: -1,
									height: -1,
									squarePixelWidth: -1,
									squarePixelHeight: -1,
									reorderSize: -1,
								};
							}; break;

							case MpegTsStreamType.MP3_MPEG1:
							case MpegTsStreamType.MP3_MPEG2:
							case MpegTsStreamType.AAC:
							case MpegTsStreamType.AC3_SYSTEM_A:
							case MpegTsStreamType.EAC3_SYSTEM_A:
							case MpegTsStreamType.DTS:
							case MpegTsStreamType.DTS_ATSC: {
								let codec: AudioCodec;
								if (
									effectiveStreamType === MpegTsStreamType.MP3_MPEG1
									|| effectiveStreamType === MpegTsStreamType.MP3_MPEG2
								) {
									codec = 'mp3';
								} else if (effectiveStreamType === MpegTsStreamType.AAC) {
									codec = 'aac';
								} else if (effectiveStreamType === MpegTsStreamType.AC3_SYSTEM_A) {
									codec = 'ac3';
								} else if (effectiveStreamType === MpegTsStreamType.EAC3_SYSTEM_A) {
									codec = 'eac3';
								} else {
									codec = 'dts';
								}

								info = {
									type: 'audio',
									codec,
									decoderConfig: null,
									aacCodecInfo: null,
									dtsFormat: null,
									numberOfChannels: -1,
									sampleRate: -1,
								};
							}; break;

							case MpegTsStreamType.PRIVATE_DATA: {
								if (hasEac3Descriptor) {
									info = {
										type: 'audio',
										codec: 'eac3',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								} else if (hasAc3Descriptor) {
									info = {
										type: 'audio',
										codec: 'ac3',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								} else if (hasDtsDescriptor) {
									info = {
										type: 'audio',
										codec: 'dts',
										decoderConfig: null,
										aacCodecInfo: null,
										dtsFormat: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								}
							}; break;

							default: {
								// If we don't recognize the codec, we don't surface the track at all. This is because
								// we can't determine its metadata and also have no idea how to packetize its data.

								if (!ignoredStreamTypes.has(streamType)) {
									Logging._warn(
										`Note: MPEG-TS streams with stream_type 0x${streamType.toString(16)} are not`
										+ ` currently supported.`,
									);
									ignoredStreamTypes.add(streamType);
								}
							}
						}

						if (info) {
							this.elementaryStreams.push({
								demuxer: this,
								pid: elementaryPid,
								streamType,
								initialized: false,
								firstSection: null,
								canBeTrustedWithKeyPackets: false,
								info,
								referencePesPackets: [],
							});
						}
					}

					hasProgramMap = true;
				} else {
					const elementaryStream = this.elementaryStreams.find(x => x.pid === section.pid);
					outer:
					if (elementaryStream && !elementaryStream.initialized) {
						const pesPacketHeader = readPesPacketHeader(this, section, true);
						if (!pesPacketHeader) {
							throw new Error(
								`Couldn't read first PES packet for Elementary Stream with PID ${elementaryStream.pid}`,
							);
						}

						elementaryStream.firstSection = section;
						elementaryStream.canBeTrustedWithKeyPackets = section.randomAccessIndicator === 1;

						if (this.input._initInput) {
							const initDemuxer = (await this.input._initInput._getDemuxer()) as MpegTsDemuxer;
							if (initDemuxer.constructor !== MpegTsDemuxer) {
								throw new Error('Init input must match the input\'s format.');
							}

							await initDemuxer.readMetadata();

							const matchingStream = initDemuxer.elementaryStreams.find(x => (
								x.pid === section.pid && x.info.codec === elementaryStream.info.codec && x.initialized
							));

							if (matchingStream) {
								elementaryStream.info = matchingStream.info;
								elementaryStream.initialized = true;

								break outer; // We have the stream info, we're done
							}
						}

						const context = new PacketReadingContext(elementaryStream, section.startPos);

						if (elementaryStream.info.type === 'video') {
							// We loop because in some files, the video parameters are not in the first packet
							while (true) {
								const contextAlias = context; // TyyyyypeScript 😩
								contextAlias.suppliedPacket = null;
								await context.markNextPacket();

								if (elementaryStream.info.codec === 'avc') {
									if (!context.suppliedPacket) {
										throw new Error(
											'Invalid AVC video stream; could not extract AVCDecoderConfigurationRecord'
											+ ' from any packet.',
										);
									}

									elementaryStream.info.avcCodecInfo
										= extractAvcDecoderConfigurationRecord(context.suppliedPacket.data);

									if (!elementaryStream.info.avcCodecInfo) {
										continue; // Search the next packet for it
									}

									const spsUnit = elementaryStream.info.avcCodecInfo.sequenceParameterSets[0];
									assert(spsUnit);
									const spsInfo = parseAvcSps(spsUnit)!;

									elementaryStream.info.width = spsInfo.displayWidth;
									elementaryStream.info.height = spsInfo.displayHeight;

									const num = spsInfo.pixelAspectRatio.num;
									const den = spsInfo.pixelAspectRatio.den;

									elementaryStream.info.squarePixelWidth = elementaryStream.info.width;
									elementaryStream.info.squarePixelHeight = elementaryStream.info.height;

									if (num > 0 && den > 0) {
										if (num > den) {
											elementaryStream.info.squarePixelWidth = Math.round(
												elementaryStream.info.width * num / den,
											);
										} else {
											elementaryStream.info.squarePixelHeight = Math.round(
												elementaryStream.info.height * den / num,
											);
										}
									}

									elementaryStream.info.colorSpace = {
										primaries:
											COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as
											VideoColorPrimaries | undefined,
										transfer:
											TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
											VideoTransferCharacteristics | undefined,
										matrix:
											MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
											VideoMatrixCoefficients | undefined,
										fullRange: !!spsInfo.fullRangeFlag,
									};
									elementaryStream.info.reorderSize = spsInfo.maxDecFrameBuffering;

									break;
								} else if (elementaryStream.info.codec === 'hevc') {
									if (!context.suppliedPacket) {
										throw new Error(
											'Invalid HEVC video stream; could not extract HVCDecoderConfigurationRecord'
											+ ' from first packet.',
										);
									}

									elementaryStream.info.hevcCodecInfo
										= extractHevcDecoderConfigurationRecord(context.suppliedPacket.data);

									if (!elementaryStream.info.hevcCodecInfo) {
										continue; // Search the next packet for it
									}

									const spsArray = elementaryStream.info.hevcCodecInfo.arrays.find(
										a => a.nalUnitType === HevcNalUnitType.SPS_NUT,
									)!;
									const spsUnit = spsArray.nalUnits[0];
									assert(spsUnit);
									const spsInfo = parseHevcSps(spsUnit)!;

									elementaryStream.info.width = spsInfo.displayWidth;
									elementaryStream.info.height = spsInfo.displayHeight;

									const num = spsInfo.pixelAspectRatio.num;
									const den = spsInfo.pixelAspectRatio.den;

									elementaryStream.info.squarePixelWidth = elementaryStream.info.width;
									elementaryStream.info.squarePixelHeight = elementaryStream.info.height;

									if (num > 0 && den > 0) {
										if (num > den) {
											elementaryStream.info.squarePixelWidth = Math.round(
												elementaryStream.info.width * num / den,
											);
										} else {
											elementaryStream.info.squarePixelHeight = Math.round(
												elementaryStream.info.height * den / num,
											);
										}
									}

									elementaryStream.info.colorSpace = {
										primaries:
											COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as
											VideoColorPrimaries | undefined,
										transfer:
											TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
											VideoTransferCharacteristics | undefined,
										matrix:
											MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
											VideoMatrixCoefficients | undefined,
										fullRange: !!spsInfo.fullRangeFlag,
									};
									elementaryStream.info.reorderSize = spsInfo.maxDecFrameBuffering;

									break;
								} else {
									throw new Error('Unhandled.');
								}
							}

							elementaryStream.info.decoderConfig = {
								codec: extractVideoCodecString({
									width: elementaryStream.info.width,
									height: elementaryStream.info.height,
									codec: elementaryStream.info.codec,
									codecDescription: null,
									colorSpace: elementaryStream.info.colorSpace,
									avcType: 1,
									avcCodecInfo: elementaryStream.info.avcCodecInfo,
									hevcType: 'hev1',
									hevcCodecInfo: elementaryStream.info.hevcCodecInfo,
									vp9CodecInfo: null,
									av1CodecInfo: null,
									proresFormat: null,
								}),
								codedWidth: elementaryStream.info.width,
								codedHeight: elementaryStream.info.height,
								colorSpace: elementaryStream.info.colorSpace,
							};

							if (
								elementaryStream.info.width !== elementaryStream.info.squarePixelWidth
								|| elementaryStream.info.height !== elementaryStream.info.squarePixelHeight
							) {
								elementaryStream.info.decoderConfig.displayAspectWidth
									= elementaryStream.info.squarePixelWidth;
								elementaryStream.info.decoderConfig.displayAspectHeight
									= elementaryStream.info.squarePixelHeight;
							}

							elementaryStream.initialized = true;
						} else {
							await context.markNextPacket();
							if (!context.suppliedPacket) {
								throw new Error(
									`Couldn't parse first media packet for Elementary Stream with`
									+ ` PID ${elementaryStream.pid}`,
								);
							}

							if (elementaryStream.info.codec === 'aac') {
								const slice = FileSlice.tempFromBytes(context.suppliedPacket.data);
								const header = readAdtsFrameHeader(slice);
								if (!header) {
									throw new Error(
										'Invalid AAC audio stream; could not read ADTS frame header from first packet.',
									);
								}

								elementaryStream.info.aacCodecInfo = {
									isMpeg2: false,
									objectType: header.objectType,
								};

								if (header.channelConfiguration === 0) {
									// The channel layout comes from the PCE at the start of the frame's raw data block
									const headerSize = header.crcCheck === null
										? MIN_ADTS_FRAME_HEADER_SIZE
										: MAX_ADTS_FRAME_HEADER_SIZE;
									const result = readAdtsProgramConfigElement(
										context.suppliedPacket.data.subarray(headerSize, header.frameLength),
									);
									if (!result) {
										throw new Error(
											'Invalid AAC audio stream; ADTS frames with channel configuration 0 must'
											+ ' begin with a program config element.',
										);
									}

									elementaryStream.info.numberOfChannels
										= getAacProgramConfigElementChannelCount(result.programConfigElement);
								} else {
									elementaryStream.info.numberOfChannels
										= aacChannelMap[header.channelConfiguration]!;
								}
								elementaryStream.info.sampleRate
									= aacFrequencyTable[header.samplingFrequencyIndex]!;
							} else if (elementaryStream.info.codec === 'mp3') {
								const word = readU32Be(FileSlice.tempFromBytes(context.suppliedPacket.data));
								const result = readMp3FrameHeader(word, context.suppliedPacket.data.byteLength);
								if (!result.header) {
									throw new Error(
										'Invalid MP3 audio stream; could not read frame header from first packet.',
									);
								}

								elementaryStream.info.numberOfChannels = getMp3ChannelCount(result.header.channel);
								elementaryStream.info.sampleRate = result.header.sampleRate;
							} else if (elementaryStream.info.codec === 'ac3') {
								const frameInfo = parseAc3SyncFrame(context.suppliedPacket.data);
								if (!frameInfo) {
									throw new Error(
										'Invalid AC-3 audio stream; could not read sync frame from first packet.',
									);
								}

								if (frameInfo.fscod === 3) {
									throw new Error(
										'Invalid AC-3 audio stream; reserved sample rate code found in first packet.',
									);
								}

								elementaryStream.info.numberOfChannels
									= AC3_ACMOD_CHANNEL_COUNTS[frameInfo.acmod]! + frameInfo.lfeon;
								elementaryStream.info.sampleRate = AC3_SAMPLE_RATES[frameInfo.fscod]!;
							} else if (elementaryStream.info.codec === 'eac3') {
								const frameInfo = parseEac3SyncFrame(context.suppliedPacket.data);
								if (!frameInfo) {
									throw new Error(
										'Invalid E-AC-3 audio stream; could not read sync frame from first packet.',
									);
								}

								const sampleRate = getEac3SampleRate(frameInfo);
								if (sampleRate === null) {
									throw new Error(
										'Invalid E-AC-3 audio stream; reserved sample rate code found in first packet.',
									);
								}

								elementaryStream.info.numberOfChannels = getEac3ChannelCount(frameInfo);
								elementaryStream.info.sampleRate = sampleRate;
							} else if (elementaryStream.info.codec === 'dts') {
								const frameInfo = parseDtsFrame(context.suppliedPacket.data);
								if (!frameInfo) {
									throw new Error(
										'Invalid DTS audio stream; could not read frame header from first packet.',
									);
								}

								elementaryStream.info.numberOfChannels = frameInfo.numberOfChannels;
								elementaryStream.info.sampleRate = frameInfo.sampleRate;

								if (frameInfo.core) {
									// Telling the two extension-only variants apart would need us to work out
									// whether the asset holds XLL or LBR data, so we leave those unlabeled
									elementaryStream.info.dtsFormat = frameInfo.hasExtensions ? 'dtsh' : 'dtsc';
								}
							} else {
								throw new Error('Unhandled.');
							}

							elementaryStream.info.decoderConfig = {
								codec: extractAudioCodecString({
									codec: elementaryStream.info.codec,
									codecDescription: null,
									aacCodecInfo: elementaryStream.info.aacCodecInfo,
									dtsFormat: elementaryStream.info.dtsFormat,
								}),
								numberOfChannels: elementaryStream.info.numberOfChannels,
								sampleRate: elementaryStream.info.sampleRate,
							};
							elementaryStream.initialized = true;
						}
					}
				}

				const isDone = hasProgramMap && this.elementaryStreams.every(x => x.initialized);
				if (isDone) {
					break;
				}

				currentPos += this.packetStride;
			}

			if (!hasProgramMap) {
				if (!hasProgramAssociationTable) {
					throw new Error('No Program Association Table found in the file.');
				}

				throw new Error('No Program Map Table found in the file.');
			}

			for (const stream of this.elementaryStreams) {
				if (!stream.initialized) {
					// Stream was declared but no initialization data for it was found
					continue;
				}

				if (stream.info.type === 'video') {
					this.trackBackingEntries.push(
						new MpegTsVideoTrackBacking(stream as ElementaryVideoStream),
					);
				} else {
					this.trackBackingEntries.push(
						new MpegTsAudioTrackBacking(stream as ElementaryAudioStream),
					);
				}
			}
		})();
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackingEntries;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {}; // Nothing for now
	}

	async getMimeType(): Promise<string> {
		await this.readMetadata();

		const codecStrings = await Promise.all(this.trackBackingEntries.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildMpegTsMimeType(codecStrings);
	}

	async readSection(startPos: number, full: boolean, contiguous = false): Promise<Section | null> {
		let endPos = startPos;
		let currentPos = startPos;
		const chunks: Uint8Array[] = [];
		let chunksByteLength = 0;
		let firstPacket: TsPacket | null = null;
		let mustAddSectionEnd = true;
		let randomAccessIndicator = 0;

		while (true) {
			const packet = await this.readPacket(currentPos);
			currentPos += this.packetStride;

			if (!packet) {
				break;
			}

			if (!firstPacket) {
				assert(packet.payloadUnitStartIndicator === 1); // Callers only start sections at such packets
				firstPacket = packet;
			} else {
				if (packet.pid !== firstPacket.pid) {
					if (contiguous) {
						// The section may well continue after the foreign packets, so this isn't necessarily its end
						mustAddSectionEnd = false;
						break;
					} else {
						continue; // Ignore this packet
					}
				}

				if (packet.payloadUnitStartIndicator === 1) {
					break;
				}
			}

			const hasAdaptationField = !!(packet.adaptationFieldControl & 0b10);
			const hasPayload = !!(packet.adaptationFieldControl & 0b01);

			let adaptationFieldLength = 0;
			if (hasAdaptationField) {
				adaptationFieldLength = 1 + packet.body[0]!;

				// Extract random_access_indicator from first packet's adaptation field
				if (packet === firstPacket && adaptationFieldLength > 1) {
					randomAccessIndicator = (packet.body[1]! >> 6) & 1;
				}
			}

			if (hasPayload) {
				if (adaptationFieldLength === 0) {
					chunks.push(packet.body);
					chunksByteLength += packet.body.byteLength;
				} else {
					chunks.push(packet.body.subarray(adaptationFieldLength));
					chunksByteLength += packet.body.byteLength - adaptationFieldLength;
				}
			}

			endPos = currentPos;

			// 64 is just "a bit of data", enough for the PES packet header
			if (!full && chunksByteLength >= 64) {
				mustAddSectionEnd = false; // Not the actual section end
				break;
			}

			// Check if we already know this is a section end
			const isKnownSectionEnd = binarySearchExact(this.sectionEndPositions, endPos, x => x) !== -1;
			if (isKnownSectionEnd) {
				mustAddSectionEnd = false;
				break;
			}
		}

		if (mustAddSectionEnd) {
			const index = binarySearchLessOrEqual(this.sectionEndPositions, endPos, x => x);
			this.sectionEndPositions.splice(index + 1, 0, endPos);
		}

		if (!firstPacket) {
			return null;
		}

		let merged: Uint8Array;
		if (chunks.length === 1) {
			merged = chunks[0]!;
		} else {
			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			merged = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}
		}

		return {
			startPos,
			pid: firstPacket.pid,
			payload: merged,
			randomAccessIndicator,
		};
	}

	async readPacketHeader(pos: number): Promise<TsPacketHeader | null> {
		let slice = this.reader.requestSlice(pos, 4);
		if (isThenable(slice)) slice = await slice;

		if (!slice) {
			return null;
		}

		const syncByte = readU8(slice);
		if (syncByte !== 0x47) {
			throw new Error('Invalid TS packet sync byte; the file is likely corrupted.');
		}

		const nextTwoBytes = readU16Be(slice);
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportErrorIndicator = nextTwoBytes >> 15;
		const payloadUnitStartIndicator = (nextTwoBytes >> 14) & 0x1;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportPriority = (nextTwoBytes >> 13) & 0x1;
		const pid = nextTwoBytes & 0x1FFF;

		const nextByte = readU8(slice);
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportScramblingControl = nextByte >> 6;
		const adaptationFieldControl = (nextByte >> 4) & 0x3;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const continuityCounter = nextByte & 0xF;

		return {
			payloadUnitStartIndicator,
			pid,
			adaptationFieldControl,
		};
	}

	async readPacket(pos: number): Promise<TsPacket | null> {
		// Code in here is duplicated from readPacketHeader for performance reasons
		let slice = this.reader.requestSlice(pos, TS_PACKET_SIZE);
		if (isThenable(slice)) slice = await slice;

		if (!slice) {
			return null;
		}

		const bytes = readBytes(slice, TS_PACKET_SIZE);

		const syncByte = bytes[0]!;
		if (syncByte !== 0x47) {
			throw new Error('Invalid TS packet sync byte; the file is likely corrupted.');
		}

		const nextTwoBytes = (bytes[1]! << 8) + bytes[2]!;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportErrorIndicator = nextTwoBytes >> 15;
		const payloadUnitStartIndicator = (nextTwoBytes >> 14) & 0x1;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportPriority = (nextTwoBytes >> 13) & 0x1;
		const pid = nextTwoBytes & 0x1FFF;

		const nextByte = bytes[3]!;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const transportScramblingControl = nextByte >> 6;
		const adaptationFieldControl = (nextByte >> 4) & 0x3;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const continuityCounter = nextByte & 0xF;

		return {
			payloadUnitStartIndicator,
			pid,
			adaptationFieldControl,
			body: bytes.subarray(4),
		};
	}

	normalizeTimestamp(timestamp: number) {
		// If there's no info yet, initialize it anchored on this timestamp. Since we process packets sequentially when
		// extracting metadata, this means we'll anchor to the first PTS in the file.
		this.timestampWrapInfo ??= createTimestampWrapInfo(timestamp);
		return normalizeWrappedTimestamp(timestamp, this.timestampWrapInfo);
	}
}

type PesPacketHeader = {
	sectionStartPos: number;
	pts: number | null;
	randomAccessIndicator: number;
};

type TimestampedPesPacketHeader = PesPacketHeader & {
	pts: number;
};

const readPesPacketHeader = <T extends boolean>(
	demuxer: MpegTsDemuxer,
	section: Section,
	expectPts: T,
): (T extends true ? TimestampedPesPacketHeader : PesPacketHeader) | null => {
	if (section.payload.byteLength < 3) {
		return null;
	}

	const bitstream = new Bitstream(section.payload);

	const startCodePrefix = bitstream.readBits(24);
	if (startCodePrefix !== 0x000001) {
		return null;
	}

	const streamId = bitstream.readBits(8);
	bitstream.skipBits(16);

	if (
		streamId === 0b10111100 // program_stream_map
		|| streamId === 0b10111110 // padding_stream
		|| streamId === 0b10111111 // private_stream_2
		|| streamId === 0b11110000 // ECM
		|| streamId === 0b11110001 // EMM
		|| streamId === 0b11111111 // program_stream_directory
		|| streamId === 0b11110010 // DSMCC_stream
		|| streamId === 0b11111000 // ITU-T Rec. H.222.1 type E stream
	) {
		return null;
	}

	bitstream.skipBits(8);

	const ptsDtsFlags = bitstream.readBits(2);

	bitstream.skipBits(14);

	let pts: number | null = null;
	if (ptsDtsFlags === 0b10 || ptsDtsFlags === 0b11) {
		pts = 0;

		bitstream.skipBits(4);
		pts += bitstream.readBits(3) * (1 << 30);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15) * (1 << 15);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15);

		pts = demuxer.normalizeTimestamp(pts);
	} else {
		if (expectPts) {
			throw new Error(MISSING_PTS_ERROR_MESSAGE);
		}
	}

	return {
		sectionStartPos: section.startPos,
		pts,
		randomAccessIndicator: section.randomAccessIndicator,
	} as T extends true ? TimestampedPesPacketHeader : PesPacketHeader;
};

abstract class MpegTsTrackBacking implements InputTrackBacking {
	packetBuffers = new WeakMap<EncodedPacket, PacketBuffer>();
	/** Used for recreating PacketBuffers if necessary. */
	packetSectionStarts = new WeakMap<EncodedPacket, number>();

	constructor(public elementaryStream: ElementaryStream) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	getNumber() {
		const demuxer = this.elementaryStream.demuxer;
		const trackType = this.elementaryStream.info.type;

		let number = 0;
		for (const backing of demuxer.trackBackingEntries) {
			if (backing.getType() === trackType) {
				number++;
			}

			assert(backing instanceof MpegTsTrackBacking);
			if (backing.elementaryStream === this.elementaryStream) {
				break;
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.elementaryStream.streamType;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			primary: false,
		};
	}

	getTimeResolution() {
		return MPEG_TS_TIMESCALE;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		return null;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	abstract allPacketsAreKeyPackets(): boolean;
	abstract getReorderSize(): number;

	createEncodedPacket(
		suppliedPacket: SuppliedPacket,
		duration: number,
		options: PacketRetrievalOptions,
	) {
		let packetType: PacketType;

		if (this.allPacketsAreKeyPackets()) {
			packetType = 'key';
		} else {
			packetType = suppliedPacket.randomAccessIndicator === 1
				? 'key'
				: 'delta';
		}

		return new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : suppliedPacket.data,
			packetType,
			suppliedPacket.pts / MPEG_TS_TIMESCALE,
			Math.max(duration / MPEG_TS_TIMESCALE, 0),
			suppliedPacket.sequenceNumber,
			suppliedPacket.data.byteLength,
		);
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const section = this.elementaryStream.firstSection;
		assert(section);

		const context = new PacketReadingContext(this.elementaryStream, section.startPos);
		const buffer = new PacketBuffer(this, context);

		const result = await buffer.readNext();
		if (!result) {
			return null;
		}

		const packet = this.createEncodedPacket(result.packet, result.duration, options);
		this.packetBuffers.set(packet, buffer);
		this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

		return packet;
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		let buffer = this.packetBuffers.get(packet);

		if (buffer) {
			// Remove PacketBuffer access from the old packet, it belongs to the next packet now. Remove it before any
			// async to prevent races
			this.packetBuffers.delete(packet);

			const result = await buffer.readNext();
			if (!result) {
				return null;
			}

			const newPacket = this.createEncodedPacket(result.packet, result.duration, options);
			this.packetBuffers.set(newPacket, buffer);
			this.packetSectionStarts.set(newPacket, result.packet.sectionStartPos);

			return newPacket;
		}

		// No buffer, we gotta do some rereading
		const sectionStartPos = this.packetSectionStarts.get(packet);
		if (sectionStartPos === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		const demuxer = this.elementaryStream.demuxer;

		// Rewind by reorderSize PES packets, since the reordering (and with it the packet durations) depends on the
		// packets decoded before this one
		let startPos = sectionStartPos;
		let pesPacketsToRewind = this.getReorderSize();
		let pos = sectionStartPos - demuxer.packetStride;

		while (pesPacketsToRewind > 0 && pos >= demuxer.packetOffset) {
			const packetHeader = await demuxer.readPacketHeader(pos);
			assert(packetHeader);

			if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
				const pesSection = await demuxer.readSection(pos, false);
				assert(pesSection);

				const pesHeader = readPesPacketHeader(demuxer, pesSection, false);
				if (pesHeader && pesHeader.pts !== null) {
					startPos = pos;
					pesPacketsToRewind--;
				}
			}

			pos -= demuxer.packetStride;
		}

		const context = new PacketReadingContext(this.elementaryStream, startPos);
		buffer = new PacketBuffer(this, context);

		// Advance until we pass the current packet's sequence number
		const targetSequenceNumber = packet.sequenceNumber;
		while (true) {
			const result = await buffer.readNext();
			if (!result) {
				return null;
			}

			if (result.packet.sequenceNumber > targetSequenceNumber) {
				// We found the next packet!
				const newPacket = this.createEncodedPacket(result.packet, result.duration, options);
				this.packetBuffers.set(newPacket, buffer);
				this.packetSectionStarts.set(newPacket, result.packet.sectionStartPos);
				return newPacket;
			}
		}
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		let currentPacket: EncodedPacket | null = packet;

		// Just loop until we hit one
		while (true) {
			currentPacket = await this.getNextPacket(currentPacket, options);

			if (!currentPacket) {
				return null;
			}

			if (currentPacket.type === 'key') {
				return currentPacket;
			}
		}
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.doPacketLookup(timestamp, false, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.doPacketLookup(timestamp, true, options);
	}

	/**
	 * Searches for the packet with the largest timestamp not larger than `timestamp` in the file, using a combination
	 * of chunk-based binary search and linear refinement. The reason the coarse search is done in large chunks is to
	 * make it more performant for small files and over high-latency readers such as the network.
	 */
	async doPacketLookup(
		timestamp: number,
		keyframesOnly: boolean,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const searchPts = roundIfAlmostInteger(timestamp * MPEG_TS_TIMESCALE);

		const demuxer = this.elementaryStream.demuxer;
		const { reader, seekChunkSize } = demuxer;
		const pid = this.elementaryStream.pid;

		const findFirstPesPacketHeaderInChunk = async (startPos: number, endPos: number) => {
			let currentPos = startPos;

			while (currentPos < endPos) {
				const packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					return null;
				}

				if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(currentPos, false);
					if (!section) {
						return null;
					}

					const pesPacketHeader = readPesPacketHeader(demuxer, section, false);
					if (pesPacketHeader && pesPacketHeader.pts !== null) {
						return pesPacketHeader as TimestampedPesPacketHeader;
					}
				}

				currentPos += demuxer.packetStride;
			}

			return null;
		};

		// Get the first PES packet of the track
		const firstSection = this.elementaryStream.firstSection;
		assert(firstSection);
		const firstPesPacketHeader = readPesPacketHeader(demuxer, firstSection, true);
		assert(firstPesPacketHeader);

		let scanStartPos: number;

		const referencePesPackets = this.elementaryStream.referencePesPackets;
		const referencePointIndex = binarySearchLessOrEqual(referencePesPackets, searchPts, x => x.pts);
		const referencePoint = referencePointIndex !== -1 ? referencePesPackets[referencePointIndex]! : null;
		if (referencePoint && searchPts - referencePoint.pts < MPEG_TS_TIMESCALE / 2) {
			// Reference point ain't too far away, prefer it over the chunk search
			scanStartPos = referencePoint.sectionStartPos;
		} else {
			let startChunkIndex = 0;

			if (
				reader.fileSize !== null
				// Packets presented before the first PES packet can only be leading frames right after it (think open
				// GOPs), so those don't need any searching
				&& searchPts >= firstPesPacketHeader.pts
			) {
				const numChunks = Math.ceil(reader.fileSize / seekChunkSize);

				if (numChunks > 1) {
					// Binary search to find the chunk with highest index whose first PES has pts <= searchPts
					let low = 0;
					let high = numChunks - 1;
					startChunkIndex = low;

					while (low <= high) {
						const mid = Math.floor((low + high) / 2);
						const chunkStartPos = floorToMultiple(mid * seekChunkSize, demuxer.packetStride)
							+ firstPesPacketHeader.sectionStartPos;
						const chunkEndPos = chunkStartPos + seekChunkSize;

						const pesPacketHeader = await findFirstPesPacketHeaderInChunk(chunkStartPos, chunkEndPos);

						if (!pesPacketHeader) {
							// No PES packet found in this chunk, search left
							high = mid - 1;
							continue;
						}

						if (pesPacketHeader.pts <= searchPts) {
							// This chunk's first PES is <= searchPts, it's a candidate
							startChunkIndex = mid;
							low = mid + 1; // Search right
						} else {
							// Search left
							high = mid - 1;
						}
					}
				}
			}

			scanStartPos = floorToMultiple(
				startChunkIndex * seekChunkSize,
				demuxer.packetStride,
			) + firstPesPacketHeader.sectionStartPos;
		}

		// Find the first PES packet at or after scanStartPos
		let currentPesHeader = await findFirstPesPacketHeaderInChunk(scanStartPos, reader.fileSize ?? Infinity);
		if (!currentPesHeader) {
			// Fall back to first packet
			currentPesHeader = firstPesPacketHeader;
		}

		const reorderSize = this.getReorderSize();

		const retrieveEncodedPacket = async (
			sectionStartPos: number,
			predicate: (packet: SuppliedPacket) => boolean,
		) => {
			const context = new PacketReadingContext(this.elementaryStream, sectionStartPos);
			const buffer = new PacketBuffer(this, context);

			// Advance until the top-most presentation timestamp crosses or equals searchPts
			while (true) {
				const topPts = last(buffer.presentationOrderPackets)?.pts ?? -Infinity;
				if (topPts >= searchPts) {
					break;
				}

				const didRead = await buffer.readNextPacket();
				if (!didRead) {
					break;
				}
			}

			const targetIndex = findLastIndex(buffer.presentationOrderPackets, predicate);
			if (targetIndex === -1) {
				return null;
			}

			const targetPacket = buffer.presentationOrderPackets[targetIndex]!;

			// Pop packets in decode order until we hit the target packet
			buffer.decodeOrderPackets.splice(0, buffer.decodeOrderPackets.indexOf(targetPacket));

			const result = await buffer.readNext();
			assert(result);

			const packet = this.createEncodedPacket(result.packet, result.duration, options);
			this.packetBuffers.set(packet, buffer);
			this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

			return packet;
		};

		if (!keyframesOnly || this.allPacketsAreKeyPackets()) {
			// Normat packet lookup case. Slightly easier since we just need to search (mostly) forward to find the
			// packet.

			// Linear scan to find the PES packet with largest pts <= searchPts. This will be used as the "midpoint"
			// of the next refinement step (which is needed because of B-frames).
			outer:
			while (true) {
				let currentPos = currentPesHeader.sectionStartPos + demuxer.packetStride;

				while (true) {
					const packetHeader = await demuxer.readPacketHeader(currentPos);
					if (!packetHeader) {
						break outer; // End of file
					}

					if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
						const section = await demuxer.readSection(currentPos, false);
						if (section) {
							const nextPesHeader = readPesPacketHeader(demuxer, section, false);
							if (nextPesHeader && nextPesHeader.pts !== null) {
								if (nextPesHeader.pts > searchPts) {
									break outer;
								}

								currentPesHeader = nextPesHeader as TimestampedPesPacketHeader;
								maybeInsertReferencePacket(this.elementaryStream, currentPesHeader);

								break;
							}
						}
					}

					currentPos += demuxer.packetStride;
				}
			}

			// Rewind by reorderSize + 1 PES packets (even for audio! To ensure proper durations), but never past the
			// track's first PES packet, since anything before it isn't part of the track
			outer:
			for (let i = 0; i < reorderSize + 1; i++) {
				let pos = currentPesHeader.sectionStartPos - demuxer.packetStride;

				while (pos >= firstPesPacketHeader.sectionStartPos) {
					const packetHeader = await demuxer.readPacketHeader(pos);
					if (!packetHeader) {
						break outer;
					}

					if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
						const section = await demuxer.readSection(pos, false);
						if (section) {
							const header = readPesPacketHeader(demuxer, section, false);
							if (header && header.pts !== null) {
								currentPesHeader = header as TimestampedPesPacketHeader;
								break;
							}
						}
					}

					pos -= demuxer.packetStride;
				}

				if (pos < firstPesPacketHeader.sectionStartPos) {
					break; // We've hit the track's first PES packet, there's nothing more to rewind
				}
			}

			return retrieveEncodedPacket(currentPesHeader.sectionStartPos, p => p.pts <= searchPts);
		} else {
			// Key packet lookup case. Slightly harder since the starting chunk may not have a key packet at all, which
			// means we might need to search the previous chunks until we find something.

			let currentChunkStartPos = scanStartPos;
			let nextChunkStartPos: number | null = null; // "next" as in later in the file, even tho we scan backwards

			while (true) {
				let bestKeyPesHeader: TimestampedPesPacketHeader | null = null;

				const isFirstChunk = currentChunkStartPos <= firstPesPacketHeader.sectionStartPos;

				let pesHeader: TimestampedPesPacketHeader | null;
				if (isFirstChunk) {
					pesHeader = firstPesPacketHeader;
				} else {
					pesHeader = await findFirstPesPacketHeaderInChunk(
						currentChunkStartPos,
						nextChunkStartPos ?? reader.fileSize ?? Infinity,
					);
				}

				let passedSearchPts = false;
				let lookaheadCount = 0;
				let context: PacketReadingContext | null = null; // Walks the chunk's packets in order

				outer:
				while (pesHeader) {
					if (nextChunkStartPos !== null && pesHeader.sectionStartPos >= nextChunkStartPos) {
						// Stop at the next chunk boundary
						break;
					}

					if (pesHeader.pts <= searchPts) {
						let isKeyPacket: boolean;
						if (this.elementaryStream.canBeTrustedWithKeyPackets) {
							isKeyPacket = pesHeader.randomAccessIndicator === 1;
						} else {
							context ??= new PacketReadingContext(this.elementaryStream, pesHeader.sectionStartPos);

							// Advance to the first packet that starts in this PES packet
							while (
								!context.suppliedPacket
								|| context.suppliedPacket.sectionStartPos < pesHeader.sectionStartPos
							) {
								context.suppliedPacket = null;
								await context.markNextPacket();

								if (!context.suppliedPacket) {
									break;
								}
							}

							isKeyPacket = context.suppliedPacket?.sectionStartPos === pesHeader.sectionStartPos
								&& context.suppliedPacket.randomAccessIndicator === 1;
						}

						if (isKeyPacket) {
							bestKeyPesHeader = pesHeader;
						}
					}

					if (pesHeader.pts > searchPts) {
						passedSearchPts = true;
					}

					// If we've passed searchPts, do lookahead for reorderSize more packets just to be sure
					if (passedSearchPts) {
						lookaheadCount++;

						if (lookaheadCount > reorderSize) {
							break;
						}
					}

					// Find next PES packet
					let currentPos = pesHeader.sectionStartPos + demuxer.packetStride;

					while (true) {
						const packetHeader = await demuxer.readPacketHeader(currentPos);
						if (!packetHeader) {
							break outer; // End of file
						}

						if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
							const section = await demuxer.readSection(currentPos, false);
							if (section) {
								const nextPesHeader = readPesPacketHeader(demuxer, section, false);

								if (nextPesHeader && nextPesHeader.pts !== null) {
									pesHeader = nextPesHeader as TimestampedPesPacketHeader;
									maybeInsertReferencePacket(this.elementaryStream, pesHeader);

									break;
								}
							}
						}

						currentPos += demuxer.packetStride;
					}
				}

				if (bestKeyPesHeader) {
					let startPesHeader = bestKeyPesHeader;

					if (lookaheadCount === 0) {
						// Packet is at the end of stream, let's rewind a little to obtain the correct packet duration
						outer:
						for (let i = 0; i < reorderSize + 1; i++) {
							let pos = startPesHeader.sectionStartPos - demuxer.packetStride;

							while (pos >= firstPesPacketHeader.sectionStartPos) {
								const packetHeader = await demuxer.readPacketHeader(pos);
								if (!packetHeader) {
									break outer;
								}

								if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
									const section = await demuxer.readSection(pos, false);
									if (section) {
										const header = readPesPacketHeader(demuxer, section, false);
										if (header && header.pts !== null) {
											startPesHeader = header as TimestampedPesPacketHeader;
											break;
										}
									}
								}

								pos -= demuxer.packetStride;
							}

							if (pos < firstPesPacketHeader.sectionStartPos) {
								break; // We've hit the track's first PES packet, there's nothing more to rewind
							}
						}
					}

					const encodedPacket = await retrieveEncodedPacket(
						startPesHeader.sectionStartPos,
						p => p.pts <= searchPts && p.randomAccessIndicator === 1,
					);
					if (encodedPacket) {
						return encodedPacket;
					} else {
						// The key packet didn't materialize (can happen with odd packetization where packets take their
						// timestamp from a later PES packet), so let's keep looking further back
					}
				}

				if (isFirstChunk) {
					return null;
				}

				// No key frame found in this chunk, move one chunk to the left
				nextChunkStartPos = currentChunkStartPos;
				currentChunkStartPos = Math.max(
					floorToMultiple(
						currentChunkStartPos - firstPesPacketHeader.sectionStartPos - seekChunkSize,
						demuxer.packetStride,
					) + firstPesPacketHeader.sectionStartPos,
					firstPesPacketHeader.sectionStartPos,
				);
			}
		}
	}
}

class MpegTsVideoTrackBacking extends MpegTsTrackBacking implements InputVideoTrackBacking {
	declare elementaryStream: ElementaryVideoStream;

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec {
		return this.elementaryStream.info.codec;
	}

	getCodedWidth() {
		return this.elementaryStream.info.width;
	}

	getCodedHeight() {
		return this.elementaryStream.info.height;
	}

	getSquarePixelWidth() {
		return this.elementaryStream.info.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return this.elementaryStream.info.squarePixelHeight;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.elementaryStream.info.colorSpace;
	}

	async canBeTransparent() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		assert(this.elementaryStream.info.decoderConfig);
		return this.elementaryStream.info.decoderConfig;
	}

	override allPacketsAreKeyPackets(): boolean {
		return false;
	}

	override getReorderSize(): number {
		return this.elementaryStream.info.reorderSize;
	}
}

class MpegTsAudioTrackBacking extends MpegTsTrackBacking implements InputAudioTrackBacking {
	declare elementaryStream: ElementaryAudioStream;

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec {
		return this.elementaryStream.info.codec;
	}

	getNumberOfChannels() {
		return this.elementaryStream.info.numberOfChannels;
	}

	getSampleRate() {
		return this.elementaryStream.info.sampleRate;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.elementaryStream.info.decoderConfig);
		return this.elementaryStream.info.decoderConfig;
	}

	override allPacketsAreKeyPackets(): boolean {
		return true;
	}

	override getReorderSize(): number {
		return 0; // No reordering, since no B-frames because goated
	}
}

const maybeInsertReferencePacket = (
	elementaryStream: ElementaryStream,
	pesPacketHeader: TimestampedPesPacketHeader,
) => {
	const referencePesPackets = elementaryStream.referencePesPackets;

	const index = binarySearchLessOrEqual(
		referencePesPackets,
		pesPacketHeader.sectionStartPos,
		x => x.sectionStartPos,
	);
	const minByteDistance = elementaryStream.demuxer.minReferencePointByteDistance;

	if (index >= 0) {
		// Since pts and file position don't necessarily have a monotonic relationship (since pts can go crazy),
		// let's see if inserting at the given index would violate the pts order. If so, return.
		const entry = referencePesPackets[index]!;
		if (pesPacketHeader.pts <= entry.pts) {
			return false;
		}

		if (pesPacketHeader.sectionStartPos - entry.sectionStartPos < minByteDistance) {
			// Too close
			return false;
		}
	}

	if (index < referencePesPackets.length - 1) {
		const nextEntry = referencePesPackets[index + 1]!;
		if (nextEntry.pts < pesPacketHeader.pts) {
			// Out of order
			return false;
		}

		if (nextEntry.sectionStartPos - pesPacketHeader.sectionStartPos < minByteDistance) {
			// Too close
			return false;
		}
	}

	referencePesPackets.splice(index + 1, 0, {
		sectionStartPos: pesPacketHeader.sectionStartPos,
		pts: pesPacketHeader.pts,
		randomAccessIndicator: pesPacketHeader.randomAccessIndicator,
	});
	return true;
};

type SuppliedPacket = {
	pts: number;
	intrinsicDuration: number;
	data: Uint8Array;
	sequenceNumber: number;
	sectionStartPos: number;
	randomAccessIndicator: number;
};

/** Stateful context used to extract exact encoded packets from the underlying data stream. */
class PacketReadingContext {
	elementaryStream: ElementaryStream;
	pid: number;
	demuxer: MpegTsDemuxer;

	nextTsPacketPos: number;
	reachedEnd = false;
	isInPesPacket = false;
	pesHeaderBytesLeft = 0;
	pesDataBytesLeft = 0;

	// Positions are relative to `pesPacketStartPos`
	currentPos = 0;
	endPos = 0;
	scratch = new Uint8Array(2 ** 16);
	scratchStartPos = 0;
	pesPackets: PesPacketHeader[] = [];
	pesPacketDataStartPositions: number[] = [];
	lastSuppliedPesPacket: PesPacketHeader | null = null;
	nextPts: number | null = null;

	suppliedPacket: SuppliedPacket | null = null;

	constructor(elementaryStream: ElementaryStream, pesPacketStartPos: number) {
		this.elementaryStream = elementaryStream;
		this.pid = elementaryStream.pid;
		this.demuxer = elementaryStream.demuxer;
		this.nextTsPacketPos = pesPacketStartPos;
	}

	ensureBuffered(length: number) {
		const remaining = this.endPos - this.currentPos;
		if (remaining >= length) {
			return length;
		}

		return this.bufferData(length - remaining)
			.then(() => Math.min(this.endPos - this.currentPos, length));
	}

	async bufferData(length: number): Promise<void> {
		const targetEndPos = this.endPos + length;

		// Data is taken in one TS packet at a time
		while (this.endPos < targetEndPos && !this.reachedEnd) {
			const pos = this.nextTsPacketPos;
			const packet = await this.demuxer.readPacket(pos);
			if (!packet) {
				this.reachedEnd = true;
				break;
			}

			this.nextTsPacketPos += this.demuxer.packetStride;

			if (packet.pid !== this.pid) {
				continue;
			}

			if (packet.payloadUnitStartIndicator === 1) {
				this.isInPesPacket = false;

				const section = await this.demuxer.readSection(pos, false);
				assert(section);

				const header = readPesPacketHeader(this.demuxer, section, false);
				if (!header) {
					continue; // Not a PES packet we can use, so skip over its whole section
				}

				const bitstream = new Bitstream(section.payload);
				bitstream.skipBits(32);
				const pesPacketLength = bitstream.readBits(16);
				const BYTES_UNTIL_END_OF_PES_PACKET_LENGTH = 6;

				bitstream.skipBits(16);
				const pesHeaderDataLength = bitstream.readBits(8);
				this.pesHeaderBytesLeft = bitstream.pos / 8 + pesHeaderDataLength;

				// "A value of 0 indicates that the PES packet length is neither specified nor bounded and is allowed
				// only in PES packets whose payload consists of bytes from a video elementary stream contained in
				// transport stream packets."
				this.pesDataBytesLeft = pesPacketLength > 0
					? Math.max(BYTES_UNTIL_END_OF_PES_PACKET_LENGTH + pesPacketLength - this.pesHeaderBytesLeft, 0)
					: Infinity;

				this.isInPesPacket = true;
				this.pesPackets.push(header);
				this.pesPacketDataStartPositions.push(this.endPos);
			}

			if (!this.isInPesPacket || !(packet.adaptationFieldControl & 0b01)) {
				continue;
			}

			const body = packet.body;
			let start = packet.adaptationFieldControl & 0b10 ? 1 + body[0]! : 0;

			const skippedHeaderBytes = Math.min(this.pesHeaderBytesLeft, Math.max(body.byteLength - start, 0));
			this.pesHeaderBytesLeft -= skippedHeaderBytes;
			start += skippedHeaderBytes;

			// Anything past the declared PES packet length is stuffing
			const end = Math.min(body.byteLength, start + this.pesDataBytesLeft);
			if (end <= start) {
				continue;
			}

			const byteCount = end - start;
			this.pesDataBytesLeft -= byteCount;

			const scratchLength = this.endPos - this.scratchStartPos;
			if (scratchLength + byteCount > this.scratch.byteLength) {
				const scratch = new Uint8Array(2 * this.scratch.byteLength);
				scratch.set(this.scratch.subarray(0, scratchLength));
				this.scratch = scratch;
			}

			this.scratch.set(body.subarray(start, end), scratchLength);
			this.endPos += byteCount;
		}
	}

	readBytes(length: number) {
		const start = this.currentPos - this.scratchStartPos;
		this.currentPos += length;

		return this.scratch.subarray(start, start + length);
	}

	readU8() {
		return this.scratch[this.currentPos++ - this.scratchStartPos]!;
	}

	seekTo(pos: number) {
		assert(pos >= this.scratchStartPos);
		this.currentPos = pos;
	}

	skip(n: number) {
		this.seekTo(this.currentPos + n);
	}

	async markNextPacket() {
		assert(!this.suppliedPacket);

		const elementaryStream = this.elementaryStream;

		if (elementaryStream.info.type === 'video') {
			// Our job here is to separate the video stream into access units. Sometimes this is easy (like when AUDs
			// are present), sometimes it's a little harder.

			const codec = elementaryStream.info.codec;
			const CHUNK_SIZE = 1024;

			if (codec !== 'avc' && codec !== 'hevc') {
				throw new Error('Unhandled.');
			}

			const nalHeaderSize = codec === 'avc' ? 1 : 2;
			let packetStartPos: number | null = null;
			let frameStartFound = false;
			let lastFirstMacroblockInSlice = 0;

			while (true) {
				let remaining = this.ensureBuffered(CHUNK_SIZE);
				if (isThenable(remaining)) remaining = await remaining;

				if (remaining === 0) {
					break;
				}

				const chunkStartPos = this.currentPos;
				const chunk = this.readBytes(remaining);
				const length = chunk.byteLength;

				let i = 0;
				while (i < length) {
					const zeroIndex = chunk.indexOf(0, i);
					if (zeroIndex === -1 || zeroIndex >= length) {
						break;
					}
					i = zeroIndex;

					const posBeforeZero = chunkStartPos + i;

					// Need 3 more bytes after the 0x00 to recognize a start code prefix
					if (i + 3 >= length) {
						// Not enough data in current chunk, seek back and let the next iteration handle it
						this.seekTo(posBeforeZero);
						break;
					}

					const b1 = chunk[i + 1]!;
					const b2 = chunk[i + 2]!;
					const b3 = chunk[i + 3]!;

					let startCodeLength = 0;

					// Check for 4-byte start code (0x00000001)
					if (b1 === 0x00 && b2 === 0x00 && b3 === 0x01) {
						startCodeLength = 4;
					} else if (b1 === 0x00 && b2 === 0x01) {
						// 3-byte start code (0x000001)
						startCodeLength = 3;
					}

					if (startCodeLength === 0) {
						// Not a start code, continue
						i++;
						continue;
					}

					const startCodePos = posBeforeZero;

					// The packet only really begins at the first NAL unit; anything before it isn't usable
					packetStartPos ??= startCodePos;

					const nalHeaderStart = i + startCodeLength;
					const payloadStart = nalHeaderStart + nalHeaderSize;

					// We read the NAL header plus, for slices, the start of the slice header to decode the
					// first_mb_in_slice / first_slice_segment_in_pic_flag. Make sure at least a byte of it is there.
					if (payloadStart + 1 > length) {
						this.seekTo(posBeforeZero);
						break;
					}

					const headerByte0 = chunk[nalHeaderStart]!;

					let nalUnitType: number;
					let isSlice: boolean;
					let isAccessUnitStart: boolean;
					let isAccessUnitDelimiter: boolean;

					if (codec === 'avc') {
						nalUnitType = extractNalUnitTypeForAvc(headerByte0);
						isSlice = nalUnitType === AvcNalUnitType.NON_IDR_SLICE
							|| nalUnitType === AvcNalUnitType.SLICE_DPA
							|| nalUnitType === AvcNalUnitType.IDR;
						isAccessUnitStart = nalUnitType === AvcNalUnitType.SEI
							|| nalUnitType === AvcNalUnitType.SPS
							|| nalUnitType === AvcNalUnitType.PPS
							|| nalUnitType === AvcNalUnitType.AUD;
						isAccessUnitDelimiter = nalUnitType === AvcNalUnitType.AUD;
					} else {
						nalUnitType = extractNalUnitTypeForHevc(headerByte0);
						const layerId = ((headerByte0 & 1) << 5) | (chunk[nalHeaderStart + 1]! >> 3);
						if (layerId > 0) {
							// Higher layers don't delimit the base-layer frames we care about
							i += startCodeLength;
							continue;
						}

						// VCL slices: 0..RASL_R, plus the IRAP range BLA_W_LP..CRA_NUT
						isSlice = nalUnitType <= HevcNalUnitType.RASL_R
							|| (nalUnitType >= HevcNalUnitType.BLA_W_LP && nalUnitType <= 21);
						// VPS..AUD, prefix SEI, and the reserved/unspecified non-VCL ranges
						isAccessUnitStart = (nalUnitType >= HevcNalUnitType.VPS_NUT && nalUnitType <= 35)
							|| nalUnitType === HevcNalUnitType.PREFIX_SEI_NUT
							|| (nalUnitType >= 41 && nalUnitType <= 44)
							|| (nalUnitType >= 48 && nalUnitType <= 55);
						isAccessUnitDelimiter = nalUnitType === HevcNalUnitType.AUD_NUT;
					}

					let isFrameBoundary = false;

					if (isSlice) {
						let startsNewPicture: boolean;

						if (codec === 'avc') {
							// first_mb_in_slice may not be fully buffered yet, in which case reading it either runs
							// past the end (where Bitstream reads zeros) or throws from all those zeros
							const bitstream = new Bitstream(chunk.subarray(payloadStart));
							let firstMacroblockInSlice: number | null;
							try {
								firstMacroblockInSlice = readExpGolomb(bitstream);
							} catch {
								firstMacroblockInSlice = null;
							}

							if (firstMacroblockInSlice === null || bitstream.getBitsLeft() < 0) {
								this.seekTo(posBeforeZero);
								break;
							}

							startsNewPicture = !frameStartFound || firstMacroblockInSlice <= lastFirstMacroblockInSlice;
							lastFirstMacroblockInSlice = firstMacroblockInSlice;
						} else {
							startsNewPicture = (chunk[payloadStart]! >> 7) === 1;
						}

						if (startsNewPicture) {
							if (frameStartFound) {
								isFrameBoundary = true;
							} else {
								frameStartFound = true;
							}
						}
					} else if (isAccessUnitStart && frameStartFound) {
						isFrameBoundary = true;
					} else if (isAccessUnitDelimiter) {
						// An AUD always begins a new access unit. We haven't seen a slice yet, so whatever came before
						// it holds no picture; let's drop it
						packetStartPos = startCodePos;
					}

					if (isFrameBoundary) {
						// End the packet at this start code (the next frame begins here)
						const packetLength = startCodePos - packetStartPos;
						this.seekTo(packetStartPos);
						return this.supplyPacket(packetLength, 0);
					}

					i += startCodeLength;
				}

				if (remaining < CHUNK_SIZE) {
					// End of stream
					break;
				}
			}

			// End of stream - emit whatever's left as the final packet, unless it holds no picture
			if (frameStartFound) {
				assert(packetStartPos !== null);

				const packetLength = this.endPos - packetStartPos;
				this.seekTo(packetStartPos);
				return this.supplyPacket(packetLength, 0);
			}
		} else {
			const codec = elementaryStream.info.codec;
			const CHUNK_SIZE = 128;

			while (true) {
				let remaining = this.ensureBuffered(CHUNK_SIZE);
				if (isThenable(remaining)) remaining = await remaining;

				const startPos = this.currentPos;

				while (this.currentPos - startPos < remaining) {
					const byte = this.readU8();

					if (codec === 'aac') {
						if (byte !== 0xff) {
							continue;
						}

						this.skip(-1);
						const possibleHeaderStartPos = this.currentPos;

						let remaining = this.ensureBuffered(MAX_ADTS_FRAME_HEADER_SIZE);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < MAX_ADTS_FRAME_HEADER_SIZE) {
							return;
						}

						const headerBytes = this.readBytes(MAX_ADTS_FRAME_HEADER_SIZE);
						const header = readAdtsFrameHeader(FileSlice.tempFromBytes(headerBytes));

						if (header) {
							this.seekTo(possibleHeaderStartPos);

							let remaining = this.ensureBuffered(header.frameLength);
							if (isThenable(remaining)) remaining = await remaining;

							return this.supplyPacket(
								remaining,
								SAMPLES_PER_AAC_FRAME * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate,
							);
						} else {
							this.seekTo(possibleHeaderStartPos + 1);
						}
					} else if (codec === 'mp3') {
						if (byte !== 0xff) {
							continue;
						}

						this.skip(-1);
						const possibleHeaderStartPos = this.currentPos;

						let remaining = this.ensureBuffered(MP3_FRAME_HEADER_SIZE);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < MP3_FRAME_HEADER_SIZE) {
							return;
						}

						const headerBytes = this.readBytes(MP3_FRAME_HEADER_SIZE);
						const word = toDataView(headerBytes).getUint32(0);
						const result = readMp3FrameHeader(word, null);

						if (result.header) {
							this.seekTo(possibleHeaderStartPos);

							let remaining = this.ensureBuffered(result.header.totalSize);
							if (isThenable(remaining)) remaining = await remaining;

							const duration = result.header.audioSamplesInFrame * MPEG_TS_TIMESCALE
								/ elementaryStream.info.sampleRate;
							return this.supplyPacket(remaining, duration);
						} else {
							this.seekTo(possibleHeaderStartPos + 1);
						}
					} else if (codec === 'ac3') {
						if (byte !== 0x0b) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						// Need at least 5 bytes for sync word + CRC + fscod/frmsizecod
						let remaining = this.ensureBuffered(5);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < 5) {
							return;
						}

						const headerBytes = this.readBytes(5);

						// Verify sync word (0x0B77)
						if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const fscod = headerBytes[4]! >> 6;
						const frmsizecod = headerBytes[4]! & 0x3f;

						if (fscod === 3 || frmsizecod > 37) {
							// Invalid
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const frameSize = AC3_FRAME_SIZES[3 * frmsizecod + fscod];
						assert(frameSize !== undefined);

						this.seekTo(possibleSyncPos);

						remaining = this.ensureBuffered(frameSize);
						if (isThenable(remaining)) remaining = await remaining;

						const duration = AC3_SAMPLES_PER_FRAME * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate;
						return this.supplyPacket(remaining, duration);
					} else if (codec === 'eac3') {
						if (byte !== 0x0b) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						// Need at least 5 bytes for E-AC-3 header parsing (sync word + frmsiz + fscod/numblkscod)
						let remaining = this.ensureBuffered(5);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < 5) {
							return;
						}

						const headerBytes = this.readBytes(5);

						if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						const frmsiz = ((headerBytes[2]! & 0x07) << 8) | headerBytes[3]!;
						let frameSize = (frmsiz + 1) * 2;
						const fscod = headerBytes[4]! >> 6;
						const numblkscod = fscod === 3 ? 3 : (headerBytes[4]! >> 4) & 0x03;
						const numblks = EAC3_NUMBLKS_TABLE[numblkscod]!;

						// Dependent substreams extend the frame before them to more channels, so they're part of its
						// access unit
						while (true) {
							this.seekTo(possibleSyncPos);

							const neededBytes = frameSize + 4;
							let remaining = this.ensureBuffered(neededBytes);
							if (isThenable(remaining)) remaining = await remaining;

							if (remaining < neededBytes) {
								break;
							}

							this.seekTo(possibleSyncPos + frameSize);
							const nextHeaderBytes = this.readBytes(4);

							if (
								nextHeaderBytes[0] !== 0x0b
								|| nextHeaderBytes[1] !== 0x77
								|| (nextHeaderBytes[2]! >> 6) !== 1 // strmtyp of a dependent substream
							) {
								break;
							}

							frameSize += 2 * ((((nextHeaderBytes[2]! & 0x07) << 8) | nextHeaderBytes[3]!) + 1);
						}

						this.seekTo(possibleSyncPos);

						remaining = this.ensureBuffered(frameSize);
						if (isThenable(remaining)) remaining = await remaining;

						// Duration = numblks * 256 samples per block
						const samplesPerFrame = numblks * 256;
						const duration = samplesPerFrame * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate;
						return this.supplyPacket(remaining, duration);
					} else if (codec === 'dts') {
						if (byte !== 0x7f && byte !== 0x64) {
							continue;
						}

						this.skip(-1);
						const possibleSyncPos = this.currentPos;

						let remaining = this.ensureBuffered(DTS_CORE_FRAME_HEADER_SIZE);
						if (isThenable(remaining)) remaining = await remaining;

						if (remaining < DTS_CORE_FRAME_HEADER_SIZE) {
							return;
						}

						const headerBytes = this.readBytes(DTS_CORE_FRAME_HEADER_SIZE);
						const core = parseDtsCoreFrameHeader(headerBytes);
						let leadingExss = core ? null : parseDtsExssHeader(headerBytes);

						if (!core && !leadingExss) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						if (leadingExss && !leadingExss.asset) {
							// The static fields and the asset descriptor reach past the bytes we read for the
							// core header, so take another look with the substream's whole header available
							this.seekTo(possibleSyncPos);

							const headerBound = Math.min(leadingExss.frameSize, DTS_EXSS_MAX_HEADER_SIZE);
							let remaining = this.ensureBuffered(headerBound);
							if (isThenable(remaining)) remaining = await remaining;

							leadingExss = parseDtsExssHeader(this.readBytes(remaining)) ?? leadingExss;
						}

						let frameSize = core ? core.frameSize : leadingExss!.frameSize;

						// Extension-only streams put exactly one substream in each frame, so it's only a core
						// frame that needs us to go looking for the extensions riding along with it. The core is
						// padded out to a 4-byte boundary before the first of them starts.
						if (core) {
							let nextSubstreamPos = Math.ceil(core.frameSize / 4) * 4;

							while (true) {
								this.seekTo(possibleSyncPos);

								const neededBytes = nextSubstreamPos + DTS_EXSS_HEADER_PREFIX_SIZE;
								let remaining = this.ensureBuffered(neededBytes);
								if (isThenable(remaining)) remaining = await remaining;

								if (remaining < neededBytes) {
									break;
								}

								this.seekTo(possibleSyncPos + nextSubstreamPos);

								const exss = parseDtsExssHeader(this.readBytes(DTS_EXSS_HEADER_PREFIX_SIZE));
								if (!exss) {
									break;
								}

								nextSubstreamPos += exss.frameSize;
								frameSize = nextSubstreamPos;
							}
						}

						// Only the substream leading the frame declares how many samples the frame holds
						const sampleCount = core?.sampleCount ?? leadingExss!.asset?.sampleCount;
						if (sampleCount === undefined) {
							this.seekTo(possibleSyncPos + 1);
							continue;
						}

						this.seekTo(possibleSyncPos);

						remaining = this.ensureBuffered(frameSize);
						if (isThenable(remaining)) remaining = await remaining;

						const duration = sampleCount * MPEG_TS_TIMESCALE / elementaryStream.info.sampleRate;
						return this.supplyPacket(remaining, duration);
					} else {
						throw new Error('Unhandled.');
					}
				}

				if (remaining < CHUNK_SIZE) {
					break;
				}
			}
		}
	}

	/** Supplies the context with a new encoded packet, beginning at the current position. */
	supplyPacket(packetLength: number, intrinsicDuration: number) {
		const pesPacketIndex = findLastIndex(this.pesPacketDataStartPositions, x => x <= this.currentPos);
		assert(pesPacketIndex !== -1);
		const currentPesPacket = this.pesPackets[pesPacketIndex]!;
		const currentPesPacketDataStartPos = this.pesPacketDataStartPositions[pesPacketIndex]!;

		let pts: number;
		if (this.lastSuppliedPesPacket === currentPesPacket) {
			assert(this.nextPts !== null);
			pts = this.nextPts;
		} else {
			if (currentPesPacket.pts === null) {
				throw new Error(MISSING_PTS_ERROR_MESSAGE);
			}

			pts = currentPesPacket.pts;

			maybeInsertReferencePacket(this.elementaryStream, currentPesPacket as TimestampedPesPacketHeader);
		}

		this.lastSuppliedPesPacket = currentPesPacket;
		this.nextPts = pts + intrinsicDuration;

		const sectionStartPos = currentPesPacket.sectionStartPos;
		// The sequence number is the starting position of the section the PES packet is in, PLUS the offset within the
		// PES packet where the packet starts.
		const sequenceNumber = sectionStartPos + (this.currentPos - currentPesPacketDataStartPos);
		const data = this.readBytes(packetLength).slice();

		let randomAccessIndicator = currentPesPacket.randomAccessIndicator;

		if (randomAccessIndicator === 0 && !this.elementaryStream.canBeTrustedWithKeyPackets) {
			if (this.elementaryStream.info.type === 'audio') {
				randomAccessIndicator = 1;
			} else {
				if (this.elementaryStream.info.decoderConfig) {
					const isKey = determineVideoPacketType(
						this.elementaryStream.info.codec,
						this.elementaryStream.info.decoderConfig,
						data,
					) === 'key';

					randomAccessIndicator = Number(isKey);
				} else {
					// We're reading packets before the decoder config is determined
				}
			}
		}

		const roundedPts = Math.round(pts);

		this.suppliedPacket = {
			pts: roundedPts,
			intrinsicDuration: Math.round(pts + intrinsicDuration) - roundedPts,
			data,
			sequenceNumber,
			sectionStartPos,
			randomAccessIndicator,
		};

		// Nothing before the end of the packet is needed anymore
		const keptStart = this.currentPos - this.scratchStartPos;
		this.scratch.copyWithin(0, keptStart, this.endPos - this.scratchStartPos);
		this.scratchStartPos = this.currentPos;

		const keptPesPacketIndex = findLastIndex(this.pesPacketDataStartPositions, x => x <= this.currentPos);
		this.pesPackets.splice(0, keptPesPacketIndex);
		this.pesPacketDataStartPositions.splice(0, keptPesPacketIndex);
	}
}

/**
 * A buffer that simulates decoder frame reordering to compute packet durations. Packets arrive in decode order but
 * durations are based on presentation order.
 */
class PacketBuffer {
	backing: MpegTsTrackBacking;
	context: PacketReadingContext;

	decodeOrderPackets: SuppliedPacket[] = [];
	reorderSize: number;
	reorderBuffer: SuppliedPacket[] = [];
	presentationOrderPackets: SuppliedPacket[] = [];
	reachedEnd = false;
	lastDuration = 0;

	constructor(backing: MpegTsTrackBacking, context: PacketReadingContext) {
		this.backing = backing;
		this.context = context;
		this.reorderSize = backing.getReorderSize();
		assert(this.reorderSize >= 0);
	}

	async readNext(): Promise<{ packet: SuppliedPacket; duration: number } | null> {
		if (this.decodeOrderPackets.length === 0) {
			// We need the next packet
			const didRead = await this.readNextPacket();
			if (!didRead) {
				return null;
			}
		}

		// Ensure we know the next packet in presentation order so we can compute the current packet's duration
		await this.ensureCurrentPacketHasNext();

		const packet = this.decodeOrderPackets[0]!;

		// Let's compute the duration
		const presentationIndex = this.presentationOrderPackets.indexOf(packet);

		let duration: number;
		if (presentationIndex !== -1 && presentationIndex < this.presentationOrderPackets.length - 1) {
			const nextPacket = this.presentationOrderPackets[presentationIndex + 1]!;
			duration = nextPacket.pts - packet.pts;
			this.lastDuration = duration;
		} else if (packet.intrinsicDuration > 0) {
			// The packet has no known successor (or isn't even placed yet when timestamps are messed up), but the codec
			// tells us how long it lasts
			duration = packet.intrinsicDuration;
		} else if (presentationIndex > 0) {
			// Let's say it lasts as long as the packet presented before it
			duration = packet.pts - this.presentationOrderPackets[presentationIndex - 1]!.pts;
		} else {
			duration = this.lastDuration; // Reasonable heuristic
		}

		this.decodeOrderPackets.shift();

		// Shrink the presentation array as much as possible
		while (this.presentationOrderPackets.length > 0) {
			const first = this.presentationOrderPackets[0]!;
			if (this.decodeOrderPackets.includes(first)) {
				break;
			}

			this.presentationOrderPackets.shift();
		}

		return { packet, duration };
	}

	async readNextPacket() {
		if (this.reachedEnd) {
			return false;
		}

		let suppliedPacket: SuppliedPacket | null;
		if (this.context.suppliedPacket) {
			// Small optimization: there was already a supplied packet in the context, so let's first use that one
			suppliedPacket = this.context.suppliedPacket;
		} else {
			await this.context.markNextPacket();
			suppliedPacket = this.context.suppliedPacket;
		}
		this.context.suppliedPacket = null;

		if (!suppliedPacket) {
			this.reachedEnd = true;
			this.flushReorderBuffer();

			return false;
		}

		this.decodeOrderPackets.push(suppliedPacket);
		this.processPacketThroughReorderBuffer(suppliedPacket);

		return true;
	}

	async ensureCurrentPacketHasNext() {
		const current = this.decodeOrderPackets[0];
		assert(current);

		while (true) {
			const presentationIndex = this.presentationOrderPackets.indexOf(current);

			// Check if current packet has a next packet
			if (presentationIndex !== -1 && presentationIndex <= this.presentationOrderPackets.length - 2) {
				break;
			}

			// Cap it so that nonsensical timestamps don't scan the entire file
			if (this.decodeOrderPackets.length > 4 * (this.reorderSize + 1)) {
				break;
			}

			const didRead = await this.readNextPacket();
			if (!didRead) {
				break;
			}
		}
	}

	processPacketThroughReorderBuffer(packet: SuppliedPacket) {
		this.reorderBuffer.push(packet);

		// If buffer is now overfull, output the packet with smallest PTS
		if (this.reorderBuffer.length > this.reorderSize) {
			let minIndex = 0;
			for (let i = 1; i < this.reorderBuffer.length; i++) {
				if (this.reorderBuffer[i]!.pts < this.reorderBuffer[minIndex]!.pts) {
					minIndex = i;
				}
			}

			const packet = this.reorderBuffer[minIndex]!;
			this.presentationOrderPackets.push(packet);
			this.reorderBuffer.splice(minIndex, 1);
		}
	}

	flushReorderBuffer() {
		this.reorderBuffer.sort((a, b) => a.pts - b.pts);
		this.presentationOrderPackets.push(...this.reorderBuffer);
		this.reorderBuffer.length = 0;
	}
}
