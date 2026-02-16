/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SAMPLES_PER_AAC_FRAME } from '../adts/adts-demuxer';
import { MAX_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import {
	aacChannelMap,
	AacCodecInfo,
	aacFrequencyTable,
	AudioCodec,
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
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
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
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	binarySearchExact,
	binarySearchLessOrEqual,
	Bitstream,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	floorToMultiple,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	Rotation,
	roundIfAlmostInteger,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { FRAME_HEADER_SIZE as MP3_FRAME_HEADER_SIZE, readMp3FrameHeader } from '../../shared/mp3-misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader, readU16Be, readU32Be, readU8 } from '../reader';
import { buildMpegTsMimeType, MpegTsStreamType, TIMESCALE, TS_PACKET_SIZE } from './mpeg-ts-misc';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';

// Resources:
// ISO/IEC 13818-1

type ElementaryStream = {
	demuxer: MpegTsDemuxer;
	pid: number;
	streamType: number;
	initialized: boolean;
	firstSection: Section | null;
	info: {
		type: 'video';
		codec: VideoCodec;
		avcCodecInfo: AvcDecoderConfigurationRecord | null;
		hevcCodecInfo: HevcDecoderConfigurationRecord | null;
		colorSpace: VideoColorSpaceInit;
		width: number;
		height: number;
		reorderSize: number;
	} | {
		type: 'audio';
		codec: AudioCodec;
		aacCodecInfo: AacCodecInfo | null;
		numberOfChannels: number;
		sampleRate: number;
	};
	/**
	 * Reference PES packets, spread throughout the file, to be used to speed up repeated random access. Sorted by both
	 * byte offset and PTS.
	 */
	referencePesPackets: PesPacketHeader[];
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
	endPos: number | null; // null if the section was not read fully
	pid: number;
	payload: Uint8Array<ArrayBufferLike>;
	randomAccessIndicator: number;
};

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	tracks: InputTrack[] = [];
	packetOffset = 0;
	packetStride = -1;
	sectionEndPositions: number[] = [];
	seekChunkSize = 5 * 1024 * 1024; // 5 MiB, picked because most HLS segments are below this size
	minReferencePointByteDistance = -1;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const lengthToCheck = TS_PACKET_SIZE + 16 + 1;
			let startingSlice = this.reader.requestSlice(0, lengthToCheck);
			if (startingSlice instanceof Promise) startingSlice = await startingSlice;
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
			} else if (startingBytes[4] === 0x47 && startingBytes[4 + TS_PACKET_SIZE] === 0x47) {
				// MPEG-2-TS (DVHS)
				this.packetOffset = 4;
				this.packetStride = TS_PACKET_SIZE;
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

				const section = await this.readSection(
					currentPos,
					true,
					!hasProgramMap, // Expect contiguous sections as long as we don't have the PMT
				);
				if (!section) {
					break;
				}

				const BYTES_BEFORE_SECTION_LENGTH = 3;
				const BITS_IN_CRC_32 = 32; // Duh

				// Some streams don't contain a PAT for some reason, so we must do some guesswork to figure out where
				// the PMT is.
				let isProbablyProgramMap = false;
				if (!hasProgramMap && section.pid !== 0) {
					const isPesPacket
						= section.payload[0] === 0x00 && section.payload[1] === 0x00 && section.payload[2] === 0x01;

					if (!isPesPacket) {
						// Assume it's a PSI

						const bitstream = new Bitstream(section.payload);
						const pointerField = bitstream.readAlignedByte();

						bitstream.skipBits(8 * pointerField);

						const tableId = bitstream.readBits(8);
						isProbablyProgramMap = tableId === 0x02; // 0x02 == TS_program_map_section
					}
				}

				if (section.pid === 0 && !hasProgramAssociationTable) {
					const bitstream = new Bitstream(section.payload);
					const pointerField = bitstream.readAlignedByte();

					bitstream.skipBits(8 * pointerField);

					bitstream.skipBits(14);
					const sectionLength = bitstream.readBits(10);

					bitstream.skipBits(40);

					while (8 * (sectionLength + BYTES_BEFORE_SECTION_LENGTH) - bitstream.pos > BITS_IN_CRC_32) {
						const programNumber = bitstream.readBits(16);
						bitstream.skipBits(3); // Reserved

						if (programNumber !== 0) {
							if (programMapPid !== null) {
								throw new Error('Only files with a single program are supported.');
							} else {
								programMapPid = bitstream.readBits(13);
							}
						}
					}

					if (programMapPid === null) {
						throw new Error('Program Association Table must link to a Program Map Table.');
					}

					hasProgramAssociationTable = true;
				} else if ((section.pid === programMapPid || isProbablyProgramMap) && !hasProgramMap) {
					const bitstream = new Bitstream(section.payload);
					const pointerField = bitstream.readAlignedByte();

					bitstream.skipBits(8 * pointerField);

					bitstream.skipBits(12);
					const sectionLength = bitstream.readBits(12);

					bitstream.skipBits(43);
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const pcrPid = bitstream.readBits(13);

					bitstream.skipBits(6);

					// "The remaining 10 bits specify the number of bytes of the descriptors immediately following the
					// program_info_length field"
					const programInfoLength = bitstream.readBits(10);
					bitstream.skipBits(8 * programInfoLength);

					while (8 * (sectionLength + BYTES_BEFORE_SECTION_LENGTH) - bitstream.pos > BITS_IN_CRC_32) {
						const streamType = bitstream.readBits(8);
						bitstream.skipBits(3);
						const elementaryPid = bitstream.readBits(13);

						bitstream.skipBits(6);
						const esInfoLength = bitstream.readBits(10);

						// Check ES descriptors to detect AC-3/E-AC-3 in System B
						const esInfoEndPos = bitstream.pos + 8 * esInfoLength;
						let hasAc3Descriptor = false;
						let hasEac3Descriptor = false;
						while (bitstream.pos < esInfoEndPos) {
							const descriptorTag = bitstream.readBits(8);
							const descriptorLength = bitstream.readBits(8);
							if (descriptorTag === 0x6a) {
								hasAc3Descriptor = true;
							} else if (descriptorTag === 0x7a || descriptorTag === 0xcc) {
								hasEac3Descriptor = true;
							}
							bitstream.skipBits(8 * descriptorLength);
						}

						let info: ElementaryStream['info'] | null = null;

						switch (streamType) {
							case MpegTsStreamType.MP3_MPEG1:
							case MpegTsStreamType.MP3_MPEG2:
							case MpegTsStreamType.AAC: {
								const codec = streamType === MpegTsStreamType.AAC ? 'aac' : 'mp3';

								info = {
									type: 'audio',
									codec,
									aacCodecInfo: null,
									numberOfChannels: -1,
									sampleRate: -1,
								};
							}; break;

							case MpegTsStreamType.AVC:
							case MpegTsStreamType.HEVC: {
								const codec = streamType === MpegTsStreamType.AVC ? 'avc' : 'hevc';

								info = {
									type: 'video',
									codec: codec,
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
									reorderSize: -1,
								};
							}; break;

							case MpegTsStreamType.AC3_SYSTEM_A: {
								info = {
									type: 'audio',
									codec: 'ac3',
									aacCodecInfo: null,
									numberOfChannels: -1,
									sampleRate: -1,
								};
							}; break;

							case MpegTsStreamType.EAC3_SYSTEM_A: {
								info = {
									type: 'audio',
									codec: 'eac3',
									aacCodecInfo: null,
									numberOfChannels: -1,
									sampleRate: -1,
								};
							}; break;

							case MpegTsStreamType.PRIVATE_DATA: {
								if (hasEac3Descriptor) {
									info = {
										type: 'audio',
										codec: 'eac3',
										aacCodecInfo: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								} else if (hasAc3Descriptor) {
									info = {
										type: 'audio',
										codec: 'ac3',
										aacCodecInfo: null,
										numberOfChannels: -1,
										sampleRate: -1,
									};
								}
							}; break;

							default: {
								// If we don't recognize the codec, we don't surface the track at all. This is because
								// we can't determine its metadata and also have no idea how to packetize its data.
								console.warn(`Unsupported stream_type 0x${streamType.toString(16)}; ignoring stream.`);
							}
						}

						if (info) {
							this.elementaryStreams.push({
								demuxer: this,
								pid: elementaryPid,
								streamType,
								initialized: false,
								firstSection: null,
								info,
								referencePesPackets: [],
							});
						}
					}

					hasProgramMap = true;
				} else {
					const elementaryStream = this.elementaryStreams.find(x => x.pid === section.pid);
					if (elementaryStream && !elementaryStream.initialized) {
						const pesPacket = readPesPacket(section);
						if (!pesPacket) {
							throw new Error(
								`Couldn't read first PES packet for Elementary Stream with PID ${elementaryStream.pid}`,
							);
						}

						elementaryStream.firstSection = section;

						if (elementaryStream.info.type === 'video') {
							if (elementaryStream.info.codec === 'avc') {
								elementaryStream.info.avcCodecInfo
									= extractAvcDecoderConfigurationRecord(pesPacket.data);

								if (!elementaryStream.info.avcCodecInfo) {
									throw new Error(
										'Invalid AVC video stream; could not extract AVCDecoderConfigurationRecord'
										+ ' from first packet.',
									);
								}

								const spsUnit = elementaryStream.info.avcCodecInfo.sequenceParameterSets[0];
								assert(spsUnit);
								const spsInfo = parseAvcSps(spsUnit)!;

								elementaryStream.info.width = spsInfo.displayWidth;
								elementaryStream.info.height = spsInfo.displayHeight;
								elementaryStream.info.colorSpace = {
									primaries: COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as
										VideoColorPrimaries | undefined,
									transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
										VideoTransferCharacteristics | undefined,
									matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
										VideoMatrixCoefficients | undefined,
									fullRange: !!spsInfo.fullRangeFlag,
								};
								elementaryStream.info.reorderSize = spsInfo.maxDecFrameBuffering;

								elementaryStream.initialized = true;
							} else if (elementaryStream.info.codec === 'hevc') {
								elementaryStream.info.hevcCodecInfo
									= extractHevcDecoderConfigurationRecord(pesPacket.data);

								if (!elementaryStream.info.hevcCodecInfo) {
									throw new Error(
										'Invalid HEVC video stream; could not extract HVCDecoderConfigurationRecord'
										+ ' from first packet.',
									);
								}

								const spsArray = elementaryStream.info.hevcCodecInfo.arrays.find(
									a => a.nalUnitType === HevcNalUnitType.SPS_NUT,
								)!;
								const spsUnit = spsArray.nalUnits[0];
								assert(spsUnit);
								const spsInfo = parseHevcSps(spsUnit)!;

								elementaryStream.info.width = spsInfo.displayWidth;
								elementaryStream.info.height = spsInfo.displayHeight;
								elementaryStream.info.colorSpace = {
									primaries: COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as
										VideoColorPrimaries | undefined,
									transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
										VideoTransferCharacteristics | undefined,
									matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
										VideoMatrixCoefficients | undefined,
									fullRange: !!spsInfo.fullRangeFlag,
								};
								elementaryStream.info.reorderSize = spsInfo.maxDecFrameBuffering;

								elementaryStream.initialized = true;
							} else {
								throw new Error('Unhandled.');
							}
						} else {
							if (elementaryStream.info.codec === 'aac') {
								const slice = FileSlice.tempFromBytes(pesPacket.data);
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
								elementaryStream.info.numberOfChannels
									= aacChannelMap[header.channelConfiguration]!;
								elementaryStream.info.sampleRate
									= aacFrequencyTable[header.samplingFrequencyIndex]!;

								elementaryStream.initialized = true;
							} else if (elementaryStream.info.codec === 'mp3') {
								const word = readU32Be(FileSlice.tempFromBytes(pesPacket.data));
								const result = readMp3FrameHeader(word, pesPacket.data.byteLength);
								if (!result.header) {
									throw new Error(
										'Invalid MP3 audio stream; could not read frame header from first packet.',
									);
								}

								elementaryStream.info.numberOfChannels = result.header.channel === 3 ? 1 : 2;
								elementaryStream.info.sampleRate = result.header.sampleRate;

								elementaryStream.initialized = true;
							} else if (elementaryStream.info.codec === 'ac3') {
								const frameInfo = parseAc3SyncFrame(pesPacket.data);
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

								elementaryStream.initialized = true;
							} else if (elementaryStream.info.codec === 'eac3') {
								const frameInfo = parseEac3SyncFrame(pesPacket.data);
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

								elementaryStream.initialized = true;
							} else {
								throw new Error('Unhandled.');
							}
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
				if (stream.info.type === 'video') {
					this.tracks.push(new InputVideoTrack(
						this.input,
						new MpegTsVideoTrackBacking(stream as ElementaryVideoStream)),
					);
				} else {
					this.tracks.push(new InputAudioTrack(
						this.input,
						new MpegTsAudioTrackBacking(stream as ElementaryAudioStream)),
					);
				}
			}
		})();
	}

	async getTracks(): Promise<InputTrack[]> {
		await this.readMetadata();
		return this.tracks;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {}; // Nothing for now
	}

	async computeDuration() {
		const tracks = await this.getTracks();
		const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(0, ...trackDurations);
	}

	async getMimeType(): Promise<string> {
		await this.readMetadata();

		const tracks = await this.getTracks();
		const codecStrings = await Promise.all(tracks.map(x => x.getCodecParameterString()));

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
				if (packet.payloadUnitStartIndicator === 0) {
					break;
				}

				firstPacket = packet;
			} else {
				if (packet.pid !== firstPacket.pid) {
					if (contiguous) {
						break; // End of section
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
			endPos: full ? endPos : null,
			pid: firstPacket.pid,
			payload: merged,
			randomAccessIndicator,
		};
	}

	async readPacketHeader(pos: number): Promise<TsPacketHeader | null> {
		let slice = this.reader.requestSlice(pos, 4);
		if (slice instanceof Promise) slice = await slice;

		if (!slice) {
			return null;
		}

		const syncByte = readU8(slice);
		if (syncByte !== 0x47) {
			throw new Error('Invalid TS packet sync byte. Likely an internal bug, please report this file.');
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
		if (slice instanceof Promise) slice = await slice;

		if (!slice) {
			return null;
		}

		const bytes = readBytes(slice, TS_PACKET_SIZE);

		const syncByte = bytes[0]!;
		if (syncByte !== 0x47) {
			throw new Error('Invalid TS packet sync byte. Likely an internal bug, please report this file.');
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
}

type PesPacketHeader = {
	sectionStartPos: number;
	sectionEndPos: number | null; // null if the section wasn't read fully
	pts: number;
	randomAccessIndicator: number;
};

type PesPacket = PesPacketHeader & {
	data: Uint8Array<ArrayBufferLike>;
};

const readPesPacketHeader = (section: Section): PesPacketHeader | null => {
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

	let pts = 0;
	if (ptsDtsFlags === 0b10 || ptsDtsFlags === 0b11) {
		bitstream.skipBits(4);
		pts += bitstream.readBits(3) * (1 << 30);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15) * (1 << 15);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15);
	} else {
		throw new Error(
			'PES packets without PTS are not currently supported. If you think this file should be supported,'
			+ ' please report it.',
		);
	}

	return {
		sectionStartPos: section.startPos,
		sectionEndPos: section.endPos,
		pts,
		randomAccessIndicator: section.randomAccessIndicator,
	};
};

const readPesPacket = (section: Section): PesPacket | null => {
	assert(section.endPos !== null); // Can only read full PES packets from fully read sections

	const header = readPesPacketHeader(section);
	if (!header) {
		return null;
	}

	const bitstream = new Bitstream(section.payload);
	bitstream.skipBits(32);
	const pesPacketLength = bitstream.readBits(16);
	const BYTES_UNTIL_END_OF_PES_PACKET_LENGTH = 6;

	bitstream.skipBits(16);
	const pesHeaderDataLength = bitstream.readBits(8);
	const pesHeaderEndPos = bitstream.pos + 8 * pesHeaderDataLength;

	bitstream.pos = pesHeaderEndPos;

	const bytePos = pesHeaderEndPos / 8;
	assert(Number.isInteger(bytePos));

	const data = section.payload.subarray(
		bytePos,
		// "A value of 0 indicates that the PES packet length is neither specified nor bounded and is allowed only in
		// PES packets whose payload consists of bytes from a video elementary stream contained in
		// transport stream packets."
		pesPacketLength > 0
			? BYTES_UNTIL_END_OF_PES_PACKET_LENGTH + pesPacketLength
			: section.payload.byteLength,
	);

	return {
		...header,
		data,
	};
};

export abstract class MpegTsTrackBacking implements InputTrackBacking {
	packetBuffers = new WeakMap<EncodedPacket, PacketBuffer>();
	/** Used for recreating PacketBuffers if necessary. */
	packetSectionStarts = new WeakMap<EncodedPacket, number>();

	constructor(public elementaryStream: ElementaryStream) {}

	getId() {
		return this.elementaryStream.pid;
	}

	getNumber() {
		const demuxer = this.elementaryStream.demuxer;
		const trackType = this.elementaryStream.info.type;

		let number = 0;
		for (const track of demuxer.tracks) {
			if (track.type === trackType) {
				number++;
			}

			assert(track._backing instanceof MpegTsTrackBacking);
			if (track._backing.elementaryStream === this.elementaryStream) {
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

	getDisposition() {
		return DEFAULT_TRACK_DISPOSITION;
	}

	getTimeResolution() {
		return TIMESCALE;
	}

	async computeDuration(): Promise<number> {
		const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
	}

	async getFirstTimestamp(): Promise<number> {
		const firstPacket = await this.getFirstPacket({ metadataOnly: true });
		return firstPacket?.timestamp ?? 0;
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
			suppliedPacket.pts / TIMESCALE,
			Math.max(duration / TIMESCALE, 0),
			suppliedPacket.sequenceNumber,
			suppliedPacket.data.byteLength,
		);
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const section = this.elementaryStream.firstSection;
		assert(section);

		const pesPacket = readPesPacket(section);
		assert(pesPacket);

		const context = new PacketReadingContext(this.elementaryStream, pesPacket);
		const buffer = new PacketBuffer(this, context);

		const result = await buffer.readNext();
		if (!result) {
			return null;
		}

		// result.packet.randomAccessIndicator = 1; // Assume the first packet is always a key packet

		const packet = this.createEncodedPacket(result.packet, result.duration, options);
		this.packetBuffers.set(packet, buffer);
		this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

		return packet;
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		let buffer = this.packetBuffers.get(packet);

		if (buffer) {
			// Fast path
			const result = await buffer.readNext();
			if (!result) {
				return null;
			}

			// Remove PacketBuffer access from the old packet, it belongs to the next packet now
			this.packetBuffers.delete(packet);

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
		const section = await demuxer.readSection(sectionStartPos, true);
		assert(section);

		const pesPacket = readPesPacket(section);
		assert(pesPacket);

		const context = new PacketReadingContext(this.elementaryStream, pesPacket);
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
		const searchPts = roundIfAlmostInteger(timestamp * TIMESCALE);

		const demuxer = this.elementaryStream.demuxer;
		const { reader, seekChunkSize } = demuxer;
		const pid = this.elementaryStream.pid;

		const findFirstPesPacketHeaderInChunk = async (
			startPos: number,
			endPos: number,
		) => {
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

					const pesPacketHeader = readPesPacketHeader(section);
					if (pesPacketHeader) {
						return pesPacketHeader;
					}
				}

				currentPos += demuxer.packetStride;
			}

			return null;
		};

		// Get the first PES packet of the track (always treated as a key frame candidate)
		const firstSection = this.elementaryStream.firstSection;
		assert(firstSection);
		const firstPesPacketHeader = readPesPacketHeader(firstSection);
		assert(firstPesPacketHeader);

		if (searchPts < firstPesPacketHeader.pts) {
			// We're before the first packet, definitely nothing here
			return null;
		}

		let scanStartPos: number;

		const referencePesPackets = this.elementaryStream.referencePesPackets;
		const referencePointIndex = binarySearchLessOrEqual(referencePesPackets, searchPts, x => x.pts);
		const referencePoint = referencePointIndex !== -1 ? referencePesPackets[referencePointIndex]! : null;
		if (referencePoint && searchPts - referencePoint.pts < TIMESCALE / 2) {
			// Reference point ain't too far away, prefer it over the chunk search
			scanStartPos = referencePoint.sectionStartPos;
		} else {
			let startChunkIndex = 0;

			if (reader.fileSize !== null) {
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

						const pesHeader = await findFirstPesPacketHeaderInChunk(chunkStartPos, chunkEndPos);

						if (!pesHeader) {
							// No PES packet found in this chunk, search left
							high = mid - 1;
							continue;
						}

						if (pesHeader.pts <= searchPts) {
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
		let currentPesHeader = await findFirstPesPacketHeaderInChunk(
			scanStartPos,
			reader.fileSize ?? Infinity,
		);

		if (!currentPesHeader) {
			// Fallback to first packet
			currentPesHeader = firstPesPacketHeader;
		}

		const reorderSize = this.getReorderSize();

		const retrieveEncodedPacket = async (
			sectionStartPos: number,
			predicate: (packet: SuppliedPacket) => boolean,
		) => {
			// Load the relevant section in full
			const section = await demuxer.readSection(sectionStartPos, true);
			assert(section);

			const pesPacket = readPesPacket(section);
			assert(pesPacket);

			const context = new PacketReadingContext(this.elementaryStream, pesPacket);
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
			const lastDuration = targetIndex === 0
				? 0
				: targetPacket.pts - buffer.presentationOrderPackets[targetIndex - 1]!.pts;

			// Pop packets in decode order until we hit the target packet
			while (buffer.decodeOrderPackets[0] !== targetPacket) {
				buffer.decodeOrderPackets.shift();
			}
			buffer.lastDuration = lastDuration; // Kinda ugly but necessary fix

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
							const nextPesHeader = readPesPacketHeader(section);
							if (nextPesHeader) {
								if (nextPesHeader.pts > searchPts) {
									break outer;
								}

								currentPesHeader = nextPesHeader;
								maybeInsertReferencePacket(this.elementaryStream, nextPesHeader);

								break;
							}
						}
					}

					currentPos += demuxer.packetStride;
				}
			}

			// Rewind by reorderSize PES packets (even for audio! To ensure proper durations)
			outer:
			for (let i = 0; i < reorderSize; i++) {
				let pos = currentPesHeader.sectionStartPos - demuxer.packetStride;

				while (pos >= demuxer.packetOffset) {
					const packetHeader = await demuxer.readPacketHeader(pos);
					if (!packetHeader) {
						break outer;
					}

					if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
						const section = await demuxer.readSection(pos, false);
						if (section) {
							const header = readPesPacketHeader(section);
							if (header) {
								currentPesHeader = header;
								break;
							}
						}
					}

					pos -= demuxer.packetStride;
				}
			}

			return retrieveEncodedPacket(currentPesHeader.sectionStartPos, p => p.pts <= searchPts);
		} else {
			// Key packet lookup case. Slightly harder since the starting chunk may not have a key packet at all, which
			// means we might need to search the previous chunks until we find something.

			let currentChunkStartPos = scanStartPos;
			let nextChunkStartPos: number | null = null; // "next" as in later in the file, even tho we scan backwards

			while (true) {
				let bestKeyPesHeader: PesPacketHeader | null = null;

				const isFirstChunk = currentChunkStartPos <= firstPesPacketHeader.sectionStartPos;

				let pesHeader: PesPacketHeader | null;
				if (isFirstChunk) {
					pesHeader = firstPesPacketHeader;

					// Since we force the first packet to be seen as a key frame:
					bestKeyPesHeader = firstPesPacketHeader;
				} else {
					pesHeader = await findFirstPesPacketHeaderInChunk(
						currentChunkStartPos,
						reader.fileSize ?? Infinity,
					);
				}

				let passedSearchPts = false;
				let lookaheadCount = 0;

				outer:
				while (pesHeader) {
					if (nextChunkStartPos !== null && pesHeader.sectionStartPos >= nextChunkStartPos) {
						// Stop at the next chunk boundary
						break;
					}

					const isKeyCandidate = pesHeader.randomAccessIndicator === 1;
					if (isKeyCandidate && pesHeader.pts <= searchPts) {
						bestKeyPesHeader = pesHeader;
					}

					if (pesHeader.pts > searchPts) {
						passedSearchPts = true;
					}

					// If we've passed searchPts, do lookahead for reorderSize-1 more packets just to be sure
					if (passedSearchPts) {
						lookaheadCount++;

						if (lookaheadCount >= reorderSize) {
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
								pesHeader = readPesPacketHeader(section);
								if (pesHeader) {
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
						for (let i = 0; i < reorderSize - 1; i++) {
							let pos = startPesHeader.sectionStartPos - demuxer.packetStride;

							while (pos >= demuxer.packetOffset) {
								const packetHeader = await demuxer.readPacketHeader(pos);
								if (!packetHeader) {
									break outer;
								}

								if (packetHeader.pid === pid && packetHeader.payloadUnitStartIndicator === 1) {
									const section = await demuxer.readSection(pos, false);
									if (section) {
										const header = readPesPacketHeader(section);
										if (header) {
											startPesHeader = header;
											break;
										}
									}
								}

								pos -= demuxer.packetStride;
							}
						}
					}

					const encodedPacket = await retrieveEncodedPacket(
						startPesHeader.sectionStartPos,
						p => p.pts <= searchPts && p.randomAccessIndicator === 1,
					);
					assert(encodedPacket); // There must be one

					return encodedPacket;
				}

				assert(!isFirstChunk); // Impossible not to find a key frame in the first chunk

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
	override elementaryStream: ElementaryVideoStream;
	decoderConfig: VideoDecoderConfig;

	constructor(elementaryStream: ElementaryVideoStream) {
		super(elementaryStream);
		this.elementaryStream = elementaryStream;

		this.decoderConfig = {
			codec: extractVideoCodecString({
				width: this.elementaryStream.info.width,
				height: this.elementaryStream.info.height,
				codec: this.elementaryStream.info.codec,
				codecDescription: null,
				colorSpace: this.elementaryStream.info.colorSpace,
				avcType: 1,
				avcCodecInfo: this.elementaryStream.info.avcCodecInfo,
				hevcCodecInfo: this.elementaryStream.info.hevcCodecInfo,
				vp9CodecInfo: null,
				av1CodecInfo: null,
			}),
			codedWidth: this.elementaryStream.info.width,
			codedHeight: this.elementaryStream.info.height,
			colorSpace: this.elementaryStream.info.colorSpace,
		};
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

	getRotation(): Rotation {
		return 0;
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.elementaryStream.info.colorSpace;
	}

	async canBeTransparent() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.decoderConfig;
	}

	override allPacketsAreKeyPackets(): boolean {
		return false;
	}

	override getReorderSize(): number {
		return this.elementaryStream.info.reorderSize;
	}
}

class MpegTsAudioTrackBacking extends MpegTsTrackBacking implements InputAudioTrackBacking {
	override elementaryStream: ElementaryAudioStream;

	constructor(elementaryStream: ElementaryAudioStream) {
		super(elementaryStream);
		this.elementaryStream = elementaryStream;
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
		return {
			codec: extractAudioCodecString({
				codec: this.elementaryStream.info.codec,
				codecDescription: null,
				aacCodecInfo: this.elementaryStream.info.aacCodecInfo,
			}),
			numberOfChannels: this.elementaryStream.info.numberOfChannels,
			sampleRate: this.elementaryStream.info.sampleRate,
		};
	}

	override allPacketsAreKeyPackets(): boolean {
		return true;
	}

	override getReorderSize(): number {
		return 1; // No reordering, since no B-frames because goated
	}
}

const maybeInsertReferencePacket = (elementaryStream: ElementaryStream, pesPacketHeader: PesPacketHeader) => {
	const referencePesPackets = elementaryStream.referencePesPackets;

	const index = binarySearchLessOrEqual(
		referencePesPackets,
		pesPacketHeader.sectionStartPos,
		x => x.sectionStartPos,
	);
	if (index >= 0) {
		// Since pts and file position don't necessarily have a monotonic relationship (since pts can go crazy),
		// let's see if inserting at the given index would violate the pts order. If so, return.
		const entry = referencePesPackets[index]!;
		if (pesPacketHeader.pts <= entry.pts) {
			return false;
		}

		const minByteDistance = elementaryStream.demuxer.minReferencePointByteDistance;

		if (pesPacketHeader.sectionStartPos - entry.sectionStartPos < minByteDistance) {
			// Too close
			return false;
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
	}

	referencePesPackets.splice(index + 1, 0, pesPacketHeader);
	return true;
};

const markNextPacket = async (context: PacketReadingContext) => {
	assert(!context.suppliedPacket);

	const elementaryStream = context.elementaryStream;

	if (elementaryStream.info.type === 'video') {
		const codec = elementaryStream.info.codec;
		const CHUNK_SIZE = 1024;

		if (codec !== 'avc' && codec !== 'hevc') {
			throw new Error('Unhandled.');
		}

		let packetStartPos: number | null = null;

		while (true) {
			let remaining = context.ensureBuffered(CHUNK_SIZE);
			if (remaining instanceof Promise) remaining = await remaining;

			if (remaining === 0) {
				break;
			}

			const chunkStartPos = context.currentPos;
			const chunk = context.readBytes(remaining);
			const length = chunk.byteLength;

			let i = 0;
			while (i < length) {
				const zeroIndex = chunk.indexOf(0, i);
				if (zeroIndex === -1 || zeroIndex >= length) {
					break;
				}
				i = zeroIndex;

				// Check if we have enough bytes to identify a start code
				const posBeforeZero = chunkStartPos + i;

				// Need at least 4 more bytes after the 0x00 to check for start code + NAL type
				if (i + 4 >= length) {
					// Not enough data in current chunk, seek back and let the next iteration handle it
					context.seekTo(posBeforeZero);
					break;
				}

				const b1 = chunk[i + 1]!;
				const b2 = chunk[i + 2]!;
				const b3 = chunk[i + 3]!;

				let startCodeLength = 0;
				let nalUnitTypeByte: number | null = null;

				// Check for 4-byte start code (0x00000001)
				if (b1 === 0x00 && b2 === 0x00 && b3 === 0x01) {
					startCodeLength = 4;
					nalUnitTypeByte = chunk[i + 4]!;
				} else if (b1 === 0x00 && b2 === 0x01) {
					// 3-byte start code (0x000001)
					startCodeLength = 3;
					nalUnitTypeByte = b3;
				}

				if (startCodeLength === 0) {
					// Not a start code, continue
					i++;
					continue;
				}

				const startCodePos = posBeforeZero;

				if (packetStartPos === null) {
					// This is our first start code, mark packet start
					packetStartPos = startCodePos;
					i += startCodeLength;
					continue;
				}

				// We have a second start code. Check if it's an AUD.
				if (nalUnitTypeByte !== null) {
					const nalUnitType = codec === 'avc'
						? extractNalUnitTypeForAvc(nalUnitTypeByte)
						: extractNalUnitTypeForHevc(nalUnitTypeByte);
					const isAud = codec === 'avc'
						? nalUnitType === AvcNalUnitType.AUD
						: nalUnitType === HevcNalUnitType.AUD_NUT;

					if (isAud) {
						// End the packet at this start code (before the AUD)
						const packetLength = startCodePos - packetStartPos;
						context.seekTo(packetStartPos);
						return context.supplyPacket(packetLength, 0);
					}
				}

				// Not an AUD, continue searching
				i += startCodeLength;
			}

			if (remaining < CHUNK_SIZE) {
				// End of stream
				break;
			}
		}

		// End of stream - return remaining data if we have a packet start
		if (packetStartPos !== null) {
			const packetLength = context.endPos - packetStartPos;
			context.seekTo(packetStartPos);
			return context.supplyPacket(packetLength, 0);
		}
	} else {
		const codec = elementaryStream.info.codec;
		const CHUNK_SIZE = 128;

		while (true) {
			let remaining = context.ensureBuffered(CHUNK_SIZE);
			if (remaining instanceof Promise) remaining = await remaining;

			const startPos = context.currentPos;

			while (context.currentPos - startPos < remaining) {
				const byte = context.readU8();

				if (codec === 'aac') {
					if (byte !== 0xff) {
						continue;
					}

					context.skip(-1);
					const possibleHeaderStartPos = context.currentPos;

					let remaining = context.ensureBuffered(MAX_ADTS_FRAME_HEADER_SIZE);
					if (remaining instanceof Promise) remaining = await remaining;

					if (remaining < MAX_ADTS_FRAME_HEADER_SIZE) {
						return;
					}

					const headerBytes = context.readBytes(MAX_ADTS_FRAME_HEADER_SIZE);
					const header = readAdtsFrameHeader(FileSlice.tempFromBytes(headerBytes));

					if (header) {
						context.seekTo(possibleHeaderStartPos);

						let remaining = context.ensureBuffered(header.frameLength);
						if (remaining instanceof Promise) remaining = await remaining;

						return context.supplyPacket(
							remaining,
							Math.round(SAMPLES_PER_AAC_FRAME * TIMESCALE / elementaryStream.info.sampleRate),
						);
					} else {
						context.seekTo(possibleHeaderStartPos + 1);
					}
				} else if (codec === 'mp3') {
					if (byte !== 0xff) {
						continue;
					}

					context.skip(-1);
					const possibleHeaderStartPos = context.currentPos;

					let remaining = context.ensureBuffered(MP3_FRAME_HEADER_SIZE);
					if (remaining instanceof Promise) remaining = await remaining;

					if (remaining < MP3_FRAME_HEADER_SIZE) {
						return;
					}

					const headerBytes = context.readBytes(MP3_FRAME_HEADER_SIZE);
					const word = toDataView(headerBytes).getUint32(0);
					const result = readMp3FrameHeader(word, null);

					if (result.header) {
						context.seekTo(possibleHeaderStartPos);

						let remaining = context.ensureBuffered(result.header.totalSize);
						if (remaining instanceof Promise) remaining = await remaining;

						const duration = result.header.audioSamplesInFrame * TIMESCALE
							/ elementaryStream.info.sampleRate;
						return context.supplyPacket(remaining, Math.round(duration));
					} else {
						context.seekTo(possibleHeaderStartPos + 1);
					}
				} else if (codec === 'ac3') {
					if (byte !== 0x0b) {
						continue;
					}

					context.skip(-1);
					const possibleSyncPos = context.currentPos;

					// Need at least 5 bytes for sync word + CRC + fscod/frmsizecod
					let remaining = context.ensureBuffered(5);
					if (remaining instanceof Promise) remaining = await remaining;

					if (remaining < 5) {
						return;
					}

					const headerBytes = context.readBytes(5);

					// Verify sync word (0x0B77)
					if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
						context.seekTo(possibleSyncPos + 1);
						continue;
					}

					const fscod = headerBytes[4]! >> 6;
					const frmsizecod = headerBytes[4]! & 0x3f;

					if (fscod === 3 || frmsizecod > 37) {
						// Invalid
						context.seekTo(possibleSyncPos + 1);
						continue;
					}

					const frameSize = AC3_FRAME_SIZES[3 * frmsizecod + fscod];
					assert(frameSize !== undefined);

					context.seekTo(possibleSyncPos);

					remaining = context.ensureBuffered(frameSize);
					if (remaining instanceof Promise) remaining = await remaining;

					const duration = Math.round(
						AC3_SAMPLES_PER_FRAME * TIMESCALE / elementaryStream.info.sampleRate,
					);
					return context.supplyPacket(remaining, duration);
				} else if (codec === 'eac3') {
					if (byte !== 0x0b) {
						continue;
					}

					context.skip(-1);
					const possibleSyncPos = context.currentPos;

					// Need at least 5 bytes for E-AC-3 header parsing (sync word + frmsiz + fscod/numblkscod)
					let remaining = context.ensureBuffered(5);
					if (remaining instanceof Promise) remaining = await remaining;

					if (remaining < 5) {
						return;
					}

					const headerBytes = context.readBytes(5);

					if (headerBytes[0] !== 0x0b || headerBytes[1] !== 0x77) {
						context.seekTo(possibleSyncPos + 1);
						continue;
					}

					const frmsiz = ((headerBytes[2]! & 0x07) << 8) | headerBytes[3]!;
					const frameSize = (frmsiz + 1) * 2;
					const fscod = headerBytes[4]! >> 6;
					const numblkscod = fscod === 3 ? 3 : (headerBytes[4]! >> 4) & 0x03;
					const numblks = EAC3_NUMBLKS_TABLE[numblkscod]!;

					context.seekTo(possibleSyncPos);

					remaining = context.ensureBuffered(frameSize);
					if (remaining instanceof Promise) remaining = await remaining;

					// Duration = numblks * 256 samples per block
					const samplesPerFrame = numblks * 256;
					const duration = Math.round(
						samplesPerFrame * TIMESCALE / elementaryStream.info.sampleRate,
					);
					return context.supplyPacket(remaining, duration);
				} else {
					throw new Error('Unhandled.');
				}
			}

			if (remaining < CHUNK_SIZE) {
				break;
			}
		}
	}
};

type SuppliedPacket = {
	pts: number;
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
	startingPesPacket: PesPacket;

	currentPos = 0; // Relative to the data in startingPesPacket
	pesPackets: PesPacket[] = [];
	currentPesPacketIndex = 0;
	currentPesPacketPos = 0;
	endPos = 0;
	nextPts = 0;

	suppliedPacket: SuppliedPacket | null = null;

	constructor(elementaryStream: ElementaryStream, startingPesPacket: PesPacket) {
		this.elementaryStream = elementaryStream;
		this.pid = elementaryStream.pid;
		this.demuxer = elementaryStream.demuxer;
		this.startingPesPacket = startingPesPacket;
	}

	clone() {
		const clone = new PacketReadingContext(this.elementaryStream, this.startingPesPacket);
		clone.currentPos = this.currentPos;
		clone.pesPackets = [...this.pesPackets];
		clone.currentPesPacketIndex = this.currentPesPacketIndex;
		clone.currentPesPacketPos = this.currentPesPacketPos;
		clone.endPos = this.endPos;
		clone.nextPts = this.nextPts;

		return clone;
	}

	ensureBuffered(length: number) {
		const remaining = this.endPos - this.currentPos;
		if (remaining >= length) {
			return length;
		}

		return this.bufferData(length - remaining)
			.then(() => Math.min(this.endPos - this.currentPos, length));
	}

	getCurrentPesPacket() {
		const packet = this.pesPackets[this.currentPesPacketIndex];
		assert(packet);

		return packet;
	}

	async bufferData(length: number): Promise<void> {
		const targetEndPos = this.endPos + length;

		while (this.endPos < targetEndPos) {
			let pesPacket: PesPacket;
			if (this.pesPackets.length === 0) {
				pesPacket = this.startingPesPacket;
			} else {
				// Find the next PES packet
				let currentPos = last(this.pesPackets)!.sectionEndPos;
				assert(currentPos !== null);

				while (true) {
					const packetHeader = await this.demuxer.readPacketHeader(currentPos);
					if (!packetHeader) {
						return;
					}

					if (packetHeader.pid === this.pid) {
						const nextSection = await this.demuxer.readSection(currentPos, true);
						if (!nextSection) {
							return;
						}

						const nextPesPacket = readPesPacket(nextSection);
						if (nextPesPacket) {
							pesPacket = nextPesPacket;
							break;
						}
					}

					currentPos += this.demuxer.packetStride;
				}
			}

			this.pesPackets.push(pesPacket);
			this.endPos += pesPacket.data.byteLength;

			if (this.pesPackets.length === 1) {
				// It's the first PES packet, set the PTS
				this.nextPts = pesPacket.pts;
			}
		}
	}

	readBytes(length: number) {
		const currentPesPacket = this.getCurrentPesPacket();

		const relativeStartOffset = this.currentPos - this.currentPesPacketPos;
		const relativeEndOffset = relativeStartOffset + length;

		this.currentPos += length;

		if (relativeEndOffset <= currentPesPacket.data.byteLength) {
			// Request can be satisfied with one PES packet
			return currentPesPacket.data.subarray(relativeStartOffset, relativeEndOffset);
		}

		// Data spans multiple PES packets, we must do some merging
		const result = new Uint8Array(length);
		result.set(currentPesPacket.data.subarray(relativeStartOffset));
		let offset = currentPesPacket.data.byteLength - relativeStartOffset;

		while (true) {
			this.advanceCurrentPacket();
			const currentPesPacket = this.getCurrentPesPacket();
			const relativeEndOffset = length - offset;

			if (relativeEndOffset <= currentPesPacket.data.byteLength) {
				result.set(currentPesPacket.data.subarray(0, relativeEndOffset), offset);
				break;
			}

			result.set(currentPesPacket.data, offset);
			offset += currentPesPacket.data.byteLength;
		}

		return result;
	}

	readU8() {
		let currentPesPacket = this.getCurrentPesPacket();

		const relativeOffset = this.currentPos - this.currentPesPacketPos;
		this.currentPos++;

		if (relativeOffset < currentPesPacket.data.byteLength) {
			return currentPesPacket.data[relativeOffset]!;
		}

		this.advanceCurrentPacket();

		currentPesPacket = this.getCurrentPesPacket();
		return currentPesPacket.data[0]!;
	}

	seekTo(pos: number) {
		if (pos === this.currentPos) {
			return;
		}

		if (pos < this.currentPos) {
			while (pos < this.currentPesPacketPos) {
				// Move to the previous PES packet
				this.currentPesPacketIndex--;
				const currentPacket = this.getCurrentPesPacket();
				this.currentPesPacketPos -= currentPacket.data.byteLength;
				this.nextPts = currentPacket.pts;
			}
		} else {
			while (true) {
				// Move to the next PES packet
				const currentPesPacket = this.getCurrentPesPacket();
				const currentEndPos = this.currentPesPacketPos + currentPesPacket.data.byteLength;

				if (pos < currentEndPos) {
					break;
				}

				this.currentPesPacketPos += currentPesPacket.data.byteLength;
				this.currentPesPacketIndex++;

				this.nextPts = this.getCurrentPesPacket().pts;
			}
		}

		this.currentPos = pos;
	}

	skip(n: number) {
		this.seekTo(this.currentPos + n);
	}

	advanceCurrentPacket() {
		this.currentPesPacketPos += this.getCurrentPesPacket().data.byteLength;
		this.currentPesPacketIndex++;

		this.nextPts = this.getCurrentPesPacket().pts;
	}

	/** Supplies the context with a new encoded packet, beginning at the current position. */
	supplyPacket(packetLength: number, intrinsicDuration: number) {
		const currentPesPacket = this.getCurrentPesPacket();

		maybeInsertReferencePacket(this.elementaryStream, currentPesPacket);

		const pts = this.nextPts;
		this.nextPts += intrinsicDuration;

		const sectionStartPos = currentPesPacket.sectionStartPos;
		// The sequence number is the starting position of the section the PES packet is in, PLUS the offset within the
		// PES packet where the packet starts.
		const sequenceNumber = sectionStartPos + (this.currentPos - this.currentPesPacketPos);
		const data = this.readBytes(packetLength);

		let randomAccessIndicator = currentPesPacket.randomAccessIndicator;

		assert(this.elementaryStream.firstSection);
		if (currentPesPacket.sectionStartPos === this.elementaryStream.firstSection.startPos) {
			randomAccessIndicator = 1; // Force the first PES packet to behave like a key packet always
		}

		this.suppliedPacket = {
			pts,
			data,
			sequenceNumber,
			sectionStartPos,
			randomAccessIndicator,
		};

		this.pesPackets.splice(0, this.currentPesPacketIndex);
		this.currentPesPacketIndex = 0;
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
		assert(presentationIndex !== -1);

		let duration: number;
		if (presentationIndex === this.presentationOrderPackets.length - 1) {
			duration = this.lastDuration; // Reasonable heuristic
		} else {
			const nextPacket = this.presentationOrderPackets[presentationIndex + 1]!;
			duration = nextPacket.pts - packet.pts;
			this.lastDuration = duration;
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
			await markNextPacket(this.context);
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

			const didRead = await this.readNextPacket();
			if (!didRead) {
				break;
			}
		}
	}

	processPacketThroughReorderBuffer(packet: SuppliedPacket) {
		this.reorderBuffer.push(packet);

		// If buffer is full, output the packet with smallest PTS
		if (this.reorderBuffer.length >= this.reorderSize) {
			let minIndex = 0;
			for (let i = 1; i < this.reorderBuffer.length; i++) {
				if (this.reorderBuffer[i]!.pts < this.reorderBuffer[minIndex]!.pts) {
					minIndex = i;
				}
			}

			const packet = this.reorderBuffer.splice(minIndex, 1)[0]!;
			this.presentationOrderPackets.push(packet);
		}
	}

	flushReorderBuffer() {
		this.reorderBuffer.sort((a, b) => a.pts - b.pts);
		this.presentationOrderPackets.push(...this.reorderBuffer);
		this.reorderBuffer.length = 0;
	}
}
