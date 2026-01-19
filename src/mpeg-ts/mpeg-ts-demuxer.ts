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
	AvcDecoderConfigurationRecord,
	AvcNalUnitType,
	determineVideoPacketType,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	parseAvcSps,
	parseHevcSps,
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
	AsyncMutex,
	binarySearchLessOrEqual,
	Bitstream,
	COLOR_PRIMARIES_MAP_INVERSE,
	findLastIndex,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	Rotation,
	roundIfAlmostInteger,
	roundToMultiple,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { FRAME_HEADER_SIZE as MP3_FRAME_HEADER_SIZE, readMp3FrameHeader } from '../../shared/mp3-misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader, readU16Be, readU32Be, readU8 } from '../reader';
import { buildMpegTsMimeType, MpegTsStreamType, TIMESCALE, TS_PACKET_SIZE } from './mpeg-ts-misc';

const MISSING_PES_PACKET_ERROR = 'No PES packet found where one was expected.';

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
};

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	tracks: InputTrack[] = [];
	packetOffset = 0;
	packetStride = -1;

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

			let currentPos = this.packetOffset;
			let programMapPid: number | null = null;
			// Some files contain these multiple times, but we only care about their first appearance
			let hasProgramAssociationTable = false;
			let hasProgramMap = false;

			while (true) {
				const section = await this.readSection(currentPos, true);
				if (!section) {
					break;
				}

				const BYTES_BEFORE_SECTION_LENGTH = 3;
				const BITS_IN_CRC_32 = 32; // Duh

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
				} else if (section.pid === programMapPid && !hasProgramMap) {
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

						bitstream.skipBits(8 * esInfoLength);

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

							default: {
								// If we don't recognize the codec, we don't surface the track at all. This is because
								// we can't determine its metadata and also have no idea how to packetize its data.
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

				assert(section.endPos !== null);
				currentPos = section.endPos;
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

	async readSection(startPos: number, full: boolean): Promise<Section | null> {
		let endPos = startPos;
		let currentPos = startPos;
		const chunks: Uint8Array[] = [];
		let chunksByteLength = 0;

		let firstPacket: TsPacket | null = null;

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
					continue; // Ignore this packet
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
				break;
			}
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
};

type PesPacket = PesPacketHeader & {
	data: Uint8Array<ArrayBufferLike>;
};

const readPesPacketHeader = (section: Section): PesPacketHeader | null => {
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
	/**
	 * Reference PES packets, spread throughout the file, to be used to speed up random access and perform
	 * binary search for packets.
	 */
	referencePesPackets: PesPacketHeader[] = [];
	endReferencePesPacketAdded = false;
	packetBuffers = new WeakMap<EncodedPacket, PacketBuffer>();
	/** Used for recreating PacketBuffers if necessary. */
	packetSectionStarts = new WeakMap<EncodedPacket, number>();
	mutex = new AsyncMutex();

	constructor(public elementaryStream: ElementaryStream) {}

	getId() {
		return this.elementaryStream.pid;
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

	abstract getPacketType(packetData: Uint8Array): PacketType;
	abstract markNextPacket(context: PacketReadingContext): Promise<void>;
	abstract getReorderSize(): number;

	createEncodedPacket(
		suppliedPacket: SuppliedPacket,
		duration: number,
		options: PacketRetrievalOptions,
	) {
		return new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : suppliedPacket.data,
			this.getPacketType(suppliedPacket.data),
			suppliedPacket.pts / TIMESCALE,
			Math.max(duration / TIMESCALE, 0),
			suppliedPacket.sequenceNumber,
			suppliedPacket.data.byteLength,
		);
	}

	maybeInsertReferencePacket(pesPacketHeader: PesPacketHeader, force: boolean, dropIfMutexLocked: boolean) {
		if (dropIfMutexLocked && this.mutex.pending > 0) {
			return; // Drop this one to avoid race conditions
		}

		const index = binarySearchLessOrEqual(this.referencePesPackets, pesPacketHeader.pts, x => x.pts);
		if (index >= 0) {
			// Since pts and file position don't necessarily have a monotonic relationship (since pts can go crazy),
			// let's see if inserting at the given index would violate the file position order. If so, return.
			const entry = this.referencePesPackets[index]!;
			if (pesPacketHeader.sectionStartPos <= entry.sectionStartPos) {
				return false;
			}

			// Too close temporally
			if (!force && pesPacketHeader.pts - entry.pts < TIMESCALE / 2) {
				return false;
			}

			if (index < this.referencePesPackets.length - 1) {
				const nextEntry = this.referencePesPackets[index + 1]!;
				if (nextEntry.sectionStartPos < pesPacketHeader.sectionStartPos) {
					// Out of order
					return false;
				}

				// Too close temporally
				if (!force && nextEntry.pts - pesPacketHeader.pts < TIMESCALE / 2) {
					return false;
				}
			}
		}

		this.referencePesPackets.splice(index + 1, 0, pesPacketHeader);
		return true;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const section = this.elementaryStream.firstSection;
		assert(section);

		const pesPacket = readPesPacket(section);
		assert(pesPacket);

		const context = new PacketReadingContext(this, pesPacket, true);
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

		const context = new PacketReadingContext(this, pesPacket, true);
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
	 * of binary search and linear refinement.
	 */
	async doPacketLookup(
		timestamp: number,
		keyframesOnly: boolean,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const searchPts = roundIfAlmostInteger(timestamp * TIMESCALE);

		const demuxer = this.elementaryStream.demuxer;
		const reader = demuxer.reader;

		const release = await this.mutex.acquire();
		let currentPesPacketHeader: PesPacketHeader;

		try {
			if (this.referencePesPackets.length === 0) {
				const section = this.elementaryStream.firstSection;
				assert(section);

				const pesPacketHeader = readPesPacketHeader(section);
				assert(pesPacketHeader);

				this.maybeInsertReferencePacket(pesPacketHeader, false, false);

				// @ts-expect-error Faulty inference
				assert(this.referencePesPackets.length === 1);
			}

			let currentIndex = binarySearchLessOrEqual(this.referencePesPackets, searchPts, x => x.pts);
			if (currentIndex === -1) {
				return null; // We're before the first packet
			}

			// If we're at the end of the reference array, we must make sure we also know about the last packet of the
			// track. Without it, we can't perform binary search. This optimization is only possible when we know the
			// file size, otherwise the linear refinement will naturally discover the end.
			const needsToLookForLastPacket
			= reader.fileSize !== null
				&& currentIndex === this.referencePesPackets.length - 1
				&& !this.endReferencePesPacketAdded;
			if (needsToLookForLastPacket) {
				let currentPos = reader.fileSize! - demuxer.packetStride + demuxer.packetOffset;
				let packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					return null;
				}

				while (packetHeader.pid !== this.elementaryStream.pid || packetHeader.payloadUnitStartIndicator === 0) {
					currentPos -= demuxer.packetStride;
					const previousPacketHeader = await demuxer.readPacketHeader(currentPos);
					if (!previousPacketHeader) {
						return null;
					}

					packetHeader = previousPacketHeader;
				}

				const section = await demuxer.readSection(currentPos, false);
				assert(section);

				const pesPacketHeader = readPesPacketHeader(section);
				if (!pesPacketHeader) {
					throw new Error(MISSING_PES_PACKET_ERROR);
				}

				this.maybeInsertReferencePacket(pesPacketHeader, true, false);
				this.endReferencePesPacketAdded = true;
			}

			// Find the reference point closest to the search timestamp
			currentIndex = binarySearchLessOrEqual(this.referencePesPackets, searchPts, x => x.pts);
			assert(currentIndex !== -1);

			// Perform binary search based on the reference PES packets, narrowing in to the timestamp we're
			// interested in
			while (reader.fileSize !== null) { // Only do the binary search if the file size is known
				const currentEntry = this.referencePesPackets[currentIndex]!;
				const nextEntry = this.referencePesPackets[currentIndex + 1];

				if (searchPts - currentEntry.pts < TIMESCALE || !nextEntry) {
					// We're at the end or close enough to the entry to the left, stop
					break;
				}

				// Jump in between the two entries, and then find a fitting packet there
				const midpoint = roundToMultiple(
					(currentEntry.sectionStartPos + nextEntry.sectionStartPos) / 2,
					demuxer.packetStride,
				) + demuxer.packetOffset;
				let currentPos = midpoint;
				let packetHeader = await demuxer.readPacketHeader(currentPos);
				assert(packetHeader);

				while (
					currentPos < nextEntry.sectionStartPos
					&& (packetHeader.pid !== this.elementaryStream.pid || packetHeader.payloadUnitStartIndicator === 0)
				) {
					currentPos += demuxer.packetStride;
					const previousPacketHeader = await demuxer.readPacketHeader(currentPos);
					if (!previousPacketHeader) {
						return null;
					}

					packetHeader = previousPacketHeader;
				}

				if (currentPos >= nextEntry.sectionStartPos) {
					// We couldn't find a packet in the middle
					break;
				}

				const section = await demuxer.readSection(currentPos, false);
				assert(section);

				const pesPacketHeader = readPesPacketHeader(section);
				if (!pesPacketHeader) {
					throw new Error(MISSING_PES_PACKET_ERROR);
				}

				const addedPoint = this.maybeInsertReferencePacket(pesPacketHeader, false, false);
				if (!addedPoint) {
					break; // Should rarely kick
				}

				if (pesPacketHeader.pts <= searchPts) {
					// The midpoint packet is to the left of our search timestamp, so continue with the right half now
					currentIndex++;
				}
			}

			currentPesPacketHeader = this.referencePesPackets[currentIndex]!;
			assert(currentPesPacketHeader.pts <= searchPts);
		} finally {
			release();
		}

		release();

		// Starting from the binary search guess, let's now find the moment where the packet timestamps cross the
		// search timestamp. This point will then be used as the center around which we search.
		outer:
		while (true) {
			let currentPos = currentPesPacketHeader.sectionStartPos + demuxer.packetStride;

			while (true) {
				const packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					break outer; // End of file
				}

				if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
					break;
				}

				currentPos += demuxer.packetStride;
			}

			const nextSection = await demuxer.readSection(currentPos, false);
			if (!nextSection) {
				break;
			}

			const nextPesPacketHeader = readPesPacketHeader(nextSection);
			if (!nextPesPacketHeader) {
				throw new Error(MISSING_PES_PACKET_ERROR);
			}

			if (nextPesPacketHeader.pts > searchPts) {
				// The timestamps cross the search timestamp, stop
				break;
			}

			currentPesPacketHeader = nextPesPacketHeader;

			if (reader.fileSize === null) {
				// If the file size is undefined, that means that the binary search step is skipped, meaning no
				// reference packets are inserted. So, let's instead insert reference packets in the linear search step.
				this.maybeInsertReferencePacket(nextPesPacketHeader, false, true);
			}
		}

		const reorderSize = this.getReorderSize();

		// Rewind by reorderSize PES packets (even for audio! To ensure proper durations)
		for (let i = 0; i < reorderSize; i++) {
			let pos = currentPesPacketHeader.sectionStartPos - demuxer.packetStride;

			while (true) {
				const packetHeader = await demuxer.readPacketHeader(pos);
				if (!packetHeader) {
					break; // Hit start of file
				}

				if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
					const headerSection = await demuxer.readSection(pos, false);
					assert(headerSection);

					const header = readPesPacketHeader(headerSection);
					if (!header) {
						throw new Error(MISSING_PES_PACKET_ERROR);
					}

					currentPesPacketHeader = header;
					break;
				}

				pos -= demuxer.packetStride;
			}
		}

		// Read the full section and create a PacketBuffer
		const section = await demuxer.readSection(currentPesPacketHeader.sectionStartPos, true);
		assert(section);

		const pesPacket = readPesPacket(section);
		assert(pesPacket);

		const context = new PacketReadingContext(this, pesPacket, true);
		const buffer = new PacketBuffer(this, context);

		// Advance until the top-most presentation timestamp crosses or equals searchPts
		while (true) {
			const topPts = last(buffer.presentationOrderPackets)?.pts ?? -Infinity;
			if (topPts >= searchPts) {
				break;
			}

			const didRead = await buffer.readNextDecodeOrderPacket();
			if (!didRead) {
				break;
			}
		}

		// Find the target packet: the one with largest PTS <= searchPts that is also a keyframe if required
		const targetIndex = findLastIndex(
			buffer.presentationOrderPackets,
			p => p.pts <= searchPts && (!keyframesOnly || this.getPacketType(p.data) === 'key'),
		);

		if (targetIndex !== -1) {
			const targetPacket = buffer.presentationOrderPackets[targetIndex]!;
			const lastDuration = targetIndex === 0
				? 0
				: targetPacket.pts - buffer.presentationOrderPackets[targetIndex - 1]!.pts;

			// Pop packets in decode order until we hit the target packet
			while (buffer.decodeOrderPackets[0] !== targetPacket) {
				buffer.decodeOrderPackets.shift();
			}
			buffer.lastDuration = lastDuration;

			// Now consume the target packet through readNext to get proper duration
			const result = await buffer.readNext();
			assert(result);

			const packet = this.createEncodedPacket(result.packet, result.duration, options);
			this.packetBuffers.set(packet, buffer);
			this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

			return packet;
		}

		if (!keyframesOnly) {
			// We didn't find a suitable packet
			return null;
		}

		// Go backwards looking for a PES packet with a keyframe
		let searchPos = currentPesPacketHeader.sectionStartPos;

		while (true) {
			searchPos -= demuxer.packetStride;

			const packetHeader = await demuxer.readPacketHeader(searchPos);
			if (!packetHeader) {
				return null; // Hit start of file
			}

			if (packetHeader.pid !== this.elementaryStream.pid || packetHeader.payloadUnitStartIndicator !== 1) {
				continue;
			}

			const section = await demuxer.readSection(searchPos, true);
			assert(section);

			const pesPacket = readPesPacket(section);
			if (!pesPacket) {
				throw new Error(MISSING_PES_PACKET_ERROR);
			}

			const context = new PacketReadingContext(this, pesPacket, false);
			await this.markNextPacket(context);

			if (!context.suppliedPacket) {
				continue;
			}

			// Check if this packet is a keyframe
			if (this.getPacketType(context.suppliedPacket.data) !== 'key') {
				continue;
			}

			context.uncapped = true; // Upgrade it to an uncapped context
			const buffer = new PacketBuffer(this, context);

			const result = await buffer.readNext();
			assert(result); // How else?

			const packet = this.createEncodedPacket(result.packet, result.duration, options);
			this.packetBuffers.set(packet, buffer);
			this.packetSectionStarts.set(packet, result.packet.sectionStartPos);

			return packet;
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

	override getPacketType(packetData: Uint8Array): PacketType {
		return determineVideoPacketType(this.elementaryStream.info.codec, this.decoderConfig, packetData) ?? 'key';
	}

	override getReorderSize(): number {
		return this.elementaryStream.info.reorderSize;
	}

	override async markNextPacket(context: PacketReadingContext): Promise<void> {
		assert(!context.suppliedPacket);

		const codec = this.elementaryStream.info.codec;
		const CHUNK_SIZE = 1024;

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

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	override getPacketType(packetData: Uint8Array): PacketType {
		return 'key';
	}

	override getReorderSize(): number {
		return 1; // No reordering, since no B-frames because goated
	}

	override async markNextPacket(context: PacketReadingContext): Promise<void> {
		assert(!context.suppliedPacket);

		const codec = this.elementaryStream.info.codec;
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
							Math.round(SAMPLES_PER_AAC_FRAME * TIMESCALE / this.elementaryStream.info.sampleRate),
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
							/ this.elementaryStream.info.sampleRate;
						return context.supplyPacket(remaining, Math.round(duration));
					} else {
						context.seekTo(possibleHeaderStartPos + 1);
					}
				} else {
					throw new Error('Unreachable');
				}
			}

			if (remaining < CHUNK_SIZE) {
				break;
			}
		}
	}
}

type SuppliedPacket = {
	pts: number;
	data: Uint8Array;
	sequenceNumber: number;
	sectionStartPos: number;
};

/** Stateful context used to extract exact encoded packets from the underlying data stream. */
class PacketReadingContext {
	backing: MpegTsTrackBacking;
	pid: number;
	demuxer: MpegTsDemuxer;
	startingPesPacket: PesPacket;
	uncapped: boolean;

	currentPos = 0; // Relative to the data in startingPesPacket
	pesPackets: PesPacket[] = [];
	currentPesPacketIndex = 0;
	currentPesPacketPos = 0;
	endPos = 0;
	nextPts = 0;

	suppliedPacket: SuppliedPacket | null = null;

	constructor(backing: MpegTsTrackBacking, startingPesPacket: PesPacket, uncapped: boolean) {
		this.backing = backing;
		this.pid = backing.elementaryStream.pid;
		this.demuxer = backing.elementaryStream.demuxer;
		this.startingPesPacket = startingPesPacket;
		this.uncapped = uncapped;
	}

	clone() {
		const clone = new PacketReadingContext(this.backing, this.startingPesPacket, true); // Close isn't capped
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
						break;
					}

					currentPos += this.demuxer.packetStride;
				}

				const nextSection = await this.demuxer.readSection(currentPos, true);
				if (!nextSection) {
					return;
				}

				const nextPesPacket = readPesPacket(nextSection);
				if (!nextPesPacket) {
					throw new Error(MISSING_PES_PACKET_ERROR);
				}

				pesPacket = nextPesPacket;
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
		if (!this.uncapped && currentPesPacket !== this.startingPesPacket) {
			// The packet is "outside" of the valid region, the valid region is any packet starting in the starting
			// section
			this.suppliedPacket = null;
			return;
		}

		this.backing.maybeInsertReferencePacket(currentPesPacket, false, true);

		const pts = this.nextPts;
		this.nextPts += intrinsicDuration;

		const sectionStartPos = currentPesPacket.sectionStartPos;
		// The sequence number is the starting position of the section the PES packet is in, PLUS the offset within the
		// PES packet where the packet starts.
		const sequenceNumber = sectionStartPos + (this.currentPos - this.currentPesPacketPos);
		const data = this.readBytes(packetLength);

		this.suppliedPacket = {
			pts,
			data,
			sequenceNumber,
			sectionStartPos,
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
			const didRead = await this.readNextDecodeOrderPacket();
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

	async readNextDecodeOrderPacket() {
		if (this.reachedEnd) {
			return false;
		}

		let suppliedPacket: SuppliedPacket | null;
		if (this.context.suppliedPacket) {
			// Small optimization: there was already a supplied packet in the context, so let's first use that one
			suppliedPacket = this.context.suppliedPacket;
		} else {
			await this.backing.markNextPacket(this.context);
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

			const didRead = await this.readNextDecodeOrderPacket();
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
