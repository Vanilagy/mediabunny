import { SAMPLES_PER_AAC_FRAME } from '../adts/adts-demuxer';
import { MAX_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
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
	extractNalUnitTypeForAvc,
	findNalUnitsInAnnexB,
	parseAvcSps,
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
	binarySearchLessOrEqual,
	Bitstream,
	COLOR_PRIMARIES_MAP_INVERSE,
	last,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	Rotation,
	roundIfAlmostInteger,
	roundToMultiple,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader, readU16Be, readU8 } from '../reader';

const TIMESCALE = 90_000; // MPEG-TS timestamps run on a 90 kHz clock
const TS_PACKET_SIZE = 188;
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
		colorSpace: VideoColorSpaceInit;
		width: number;
		height: number;
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
			let hasProgramMap = false;

			while (true) {
				const section = await this.readSection(currentPos, true);
				if (!section) {
					break;
				}

				const BYTES_BEFORE_SECTION_LENGTH = 3;
				const BITS_IN_CRC_32 = 32; // Duh

				if (section.pid === 0) {
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
				} else if (section.pid === programMapPid) {
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
							case 0xf: {
								info = {
									type: 'audio',
									codec: 'aac',
									aacCodecInfo: null,
									numberOfChannels: -1,
									sampleRate: -1,
								};
							}; break;

							case 0x1b: {
								info = {
									type: 'video',
									codec: 'avc',
									avcCodecInfo: null,
									colorSpace: {
										primaries: null,
										transfer: null,
										matrix: null,
										fullRange: null,
									},
									width: -1,
									height: -1,
								};
							}; break;
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

								const nalUnits = findNalUnitsInAnnexB(pesPacket.data);
								const spsUnit = nalUnits.find(x => extractNalUnitTypeForAvc(x) === AvcNalUnitType.SPS)!;
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

								elementaryStream.initialized = true;
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
		return {}; // TODO
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

		let string = 'video/MP2T';

		const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
		if (uniqueCodecStrings.length > 0) {
			string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
		}

		return string;
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
			body: readBytes(slice, TS_PACKET_SIZE - 4),
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

	if (ptsDtsFlags !== 0b10 && ptsDtsFlags !== 0b11) {
		return null; // Support only timestamped packets
	}

	let pts = 0;
	if (ptsDtsFlags === 0b10 || ptsDtsFlags === 0b11) {
		bitstream.skipBits(4);
		pts += bitstream.readBits(3) * (1 << 30);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15) * (1 << 15);
		bitstream.skipBits(1);
		pts += bitstream.readBits(15);
	} else {
		return null; // Support only timestamped packets
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
	readingContexts = new WeakMap<EncodedPacket, PacketReadingContext>();

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

	maybeInsertReferencePacket(pesPacketHeader: PesPacketHeader, force: boolean) {
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
		await this.markNextPacket(context);

		return context.toEncodedPacket(options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const context = this.readingContexts.get(packet);
		if (!context) {
			throw new Error('Packet was not created from this track.');
		}

		const clone = context.clone();
		await this.markNextPacket(clone);

		return clone.toEncodedPacket(options);
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

	abstract getPacketLookaround(): number;

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

		if (this.referencePesPackets.length === 0) {
			// We've never read a packet, let's read the first one
			const firstPacket = await this.getFirstPacket({});
			if (!firstPacket) {
				return null;
			}

			// @ts-expect-error Faulty inference
			assert(this.referencePesPackets.length === 1);
		}

		let currentIndex = binarySearchLessOrEqual(this.referencePesPackets, searchPts, x => x.pts);
		if (currentIndex === -1) {
			return null; // We're before the first packet
		}

		// If we're at the end of the reference array, we must make sure we also know about the last packet of the
		// track. Without it, we can't perform binary search. This optimization is only possible when we know the file
		// size, otherwise the linear refinement will naturally discover the end.
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

			this.maybeInsertReferencePacket(pesPacketHeader, true);
			this.endReferencePesPacketAdded = true;
		}

		// Find the reference point closest to the search timestamp
		currentIndex = binarySearchLessOrEqual(this.referencePesPackets, searchPts, x => x.pts);
		assert(currentIndex !== -1);

		// Perform binary search based on the reference PES packets, narrowing in to the timestamp we're interested in
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

			const addedPoint = this.maybeInsertReferencePacket(pesPacketHeader, false);
			if (!addedPoint) {
				break; // Should rarely kick
			}

			if (pesPacketHeader.pts <= searchPts) {
				// The midpoint packet is to the left of our search timestamp, so continue with the right half now
				currentIndex++;
			}
		}

		let currentPesPacketHeader = this.referencePesPackets[currentIndex]!;
		assert(currentPesPacketHeader.pts <= searchPts);

		/** Stores the best PES packet we've found so far (that meets all required criteria). */
		let bestPesPacketHeader: PesPacketHeader | null = null;

		const pesPacketHasKeyframe = async (sectionStartPos: number) => {
			const section = await demuxer.readSection(sectionStartPos, true);
			assert(section);
			assert(section.pid === this.elementaryStream.pid);

			const fullPesPacket = readPesPacket(section);
			assert(fullPesPacket);

			const context = new PacketReadingContext(this, fullPesPacket, false);
			await this.markNextPacket(context);

			if (!context.suppliedPacket) {
				return false;
			}

			return this.getPacketType(context.suppliedPacket.data);
		};

		if (!keyframesOnly || await pesPacketHasKeyframe(currentPesPacketHeader.sectionStartPos)) {
			bestPesPacketHeader = currentPesPacketHeader;
		}

		// "advanced" as in "moved past"
		const advancedPesPacketHeaders = [bestPesPacketHeader];

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

			// Collect matching packets we find along the way
			if (
				(bestPesPacketHeader === null || bestPesPacketHeader.pts < nextPesPacketHeader.pts)
				&& nextPesPacketHeader.pts <= searchPts
				&& (!keyframesOnly || await pesPacketHasKeyframe(currentPos))
			) {
				bestPesPacketHeader = nextPesPacketHeader;
			}

			currentPesPacketHeader = nextPesPacketHeader;
			advancedPesPacketHeaders.push(nextPesPacketHeader);

			if (reader.fileSize === null) {
				// If the file size is undefined, that means that the binary search step is skipped, meaning no
				// reference packets are inserted. So, let's instead insert reference packets in the linear search step.
				this.maybeInsertReferencePacket(nextPesPacketHeader, false);
			}
		}

		// Lookaround is needed in the first place because packets don't need to appear in PTS order, they only appear
		// in decode order. When B-frames are present, finding the packet that's actually closest to the search
		// timestamp requires searching a small local window.
		const lookaround = this.getPacketLookaround();

		// Depending on how long the previous scan went, we might not need to do the full lookbehind, or even none at
		// all if we're lucky
		const lookbehindNeeded = Math.max(lookaround - advancedPesPacketHeaders.length + 1, 0);
		let minPos = advancedPesPacketHeaders[0]!.sectionStartPos;

		/** Scans `n` contiguous PES packets in succession. */
		const doLinearScan = async (startPos: number, n: number) => {
			let currentPos = startPos;

			outer:
			for (let i = 0; i < n; i++) {
				while (true) {
					const packetHeader = await demuxer.readPacketHeader(currentPos);
					if (!packetHeader) {
						break outer; // End of file
					}

					if (
						packetHeader.pid === this.elementaryStream.pid
						&& packetHeader.payloadUnitStartIndicator === 1
					) {
						break;
					}

					currentPos += demuxer.packetStride;
				}

				const section = await demuxer.readSection(currentPos, false);
				assert(section);
				assert(section.pid === this.elementaryStream.pid);

				const pesPacketHeader = readPesPacketHeader(section);
				if (!pesPacketHeader) {
					throw new Error(MISSING_PES_PACKET_ERROR);
				}

				if (
					(bestPesPacketHeader === null || bestPesPacketHeader.pts < pesPacketHeader.pts)
					&& pesPacketHeader.pts <= searchPts
					&& (!keyframesOnly || await pesPacketHasKeyframe(currentPos))
				) {
					bestPesPacketHeader = pesPacketHeader;
				}

				currentPos += demuxer.packetStride;
			}
		};

		// Lookbehind
		if (lookbehindNeeded > 0) {
			outer:
			for (let i = 0; i < lookbehindNeeded; i++) {
				let currentPos = minPos;

				while (true) {
					currentPos -= demuxer.packetStride;

					const packetHeader = await demuxer.readPacketHeader(currentPos);
					if (!packetHeader) {
						break outer;
					}

					if (
						packetHeader.pid === this.elementaryStream.pid
						&& packetHeader.payloadUnitStartIndicator === 1
					) {
						break;
					}
				}

				minPos = currentPos;
			}

			await doLinearScan(minPos, lookbehindNeeded);
		}

		// Lookahead
		await doLinearScan(currentPesPacketHeader.sectionStartPos + demuxer.packetStride, lookaround);

		// If we're looking specifically for a keyframe but haven't found one yet, that means we'll need to go left
		// until we find one.
		if (!bestPesPacketHeader && keyframesOnly) {
			let currentPos = minPos;

			while (true) {
				currentPos -= demuxer.packetStride;

				const packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					break;
				}

				if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(currentPos, false);
					assert(section);

					const pesPacketHeader = readPesPacketHeader(section);
					if (!pesPacketHeader) {
						throw new Error(MISSING_PES_PACKET_ERROR);
					}

					if (pesPacketHeader.pts <= searchPts && (await pesPacketHasKeyframe(currentPos))) {
						bestPesPacketHeader = pesPacketHeader;
						break;
					}
				}
			}
		}

		if (!bestPesPacketHeader) {
			// Nothing was found
			return null;
		}

		const bestSection = await demuxer.readSection(bestPesPacketHeader.sectionStartPos, true); // Read it in full
		let bestPesPacket = readPesPacket(bestSection!);
		assert(bestPesPacket);

		// Final stage: we found the best PES packet, but that PES packet might contain multiple individual encoded
		// packets. Or, it might not be the start of an encoded packet, and simply a continuation of a previous one.
		// So, we have one last search to do.
		const searchTimestamp = searchPts / TIMESCALE; // We use this instead of 'timestamp' due to the rounding
		while (true) {
			const context = new PacketReadingContext(this, bestPesPacket, false); // Capped context

			let bestPacket: EncodedPacket | null = null;

			while (true) {
				context.suppliedPacket = null;
				await this.markNextPacket(context);
				const packet = context.toEncodedPacket(options);
				if (!packet) {
					break;
				}

				const eligible = packet.timestamp <= searchTimestamp && (!keyframesOnly || packet.type === 'key');
				if (!eligible) {
					continue;
				}

				if (!bestPacket || bestPacket.timestamp < packet.timestamp) {
					bestPacket = packet;
				}
			}

			if (bestPacket) {
				return bestPacket;
			}

			// We didn't find an encoded packet! Let's go to the previous PES packet until we find one.

			let currentPos = bestPesPacket.sectionStartPos;

			while (true) {
				currentPos -= demuxer.packetStride;

				const packetHeader = await demuxer.readPacketHeader(currentPos);
				if (!packetHeader) {
					// Past start of file
					return null;
				}

				if (packetHeader.pid === this.elementaryStream.pid && packetHeader.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(currentPos, true);
					assert(section);

					const pesPacket = readPesPacket(section);
					if (!pesPacket) {
						throw new Error(MISSING_PES_PACKET_ERROR);
					}

					if (pesPacket.pts <= searchPts) {
						bestPesPacket = pesPacket;
						break;
					}
				}
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
				hevcCodecInfo: null,
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

	override getPacketLookaround(): number {
		// Due to B-frames. A lookaround of +-5 packets will pretty much guarantee we find the correct packet for a
		// given timestamp, although of course, this could technically still fail.
		// todo, use max_num_reorder_frames here?
		return 5;
	}

	override async markNextPacket(context: PacketReadingContext): Promise<void> {
		const CHUNK_SIZE = 128;

		let packetStartPos: number | null = null;

		while (true) {
			let remaining = context.ensureBuffered(CHUNK_SIZE);
			if (remaining instanceof Promise) remaining = await remaining;

			// Search for start codes in the current chunk
			for (let i = 0; i < remaining; i++) {
				const byte = context.readU8();

				// Look for 0x00 as potential start of a start code
				if (byte !== 0x00) {
					continue;
				}

				// Check if we have enough bytes to identify a start code
				const posBeforeZero = context.currentPos - 1;

				let remaining = context.ensureBuffered(4);
				if (remaining instanceof Promise) remaining = await remaining;

				if (remaining < 4) {
					// Not enough data left
					if (packetStartPos !== null) {
						// Return what we have
						const packetLength = context.endPos - packetStartPos;
						context.seekTo(packetStartPos);
						return context.supplyPacket(packetLength, 0);
					}
					return;
				}

				// Read potential start code bytes
				const b1 = context.readU8();
				const b2 = context.readU8();
				const b3 = context.readU8();

				let startCodeLength = 0;
				let nalUnitTypeByte: number | null = null;

				// Check for 4-byte start code (0x00000001)
				if (b1 === 0x00 && b2 === 0x00 && b3 === 0x01) {
					startCodeLength = 4;
					nalUnitTypeByte = context.readU8();
					// context.skip(-1);
				} else if (b1 === 0x00 && b2 === 0x01) {
					// 3-byte start code (0x000001)
					startCodeLength = 3;
					nalUnitTypeByte = b3;
					// context.skip(-1); // Back up since b3 is the NAL unit type byte
				}

				if (startCodeLength === 0) {
					// Not a start code, rewind and continue
					context.seekTo(posBeforeZero + 1);
					continue;
				}

				const startCodePos = posBeforeZero;

				if (packetStartPos === null) {
					// This is our first start code, mark packet start
					packetStartPos = startCodePos;
					continue;
				}

				// We have a second start code. Check if it's an AUD.
				if (nalUnitTypeByte !== null) {
					const nalUnitType = extractNalUnitTypeForAvc(new Uint8Array([nalUnitTypeByte]));

					if (nalUnitType === AvcNalUnitType.AUD) {
						// End the packet at this start code (before the AUD)
						const packetLength = startCodePos - packetStartPos;
						context.seekTo(packetStartPos);
						return context.supplyPacket(packetLength, 0);
					}
				}

				// Not an AUD, continue searching
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

	override getPacketLookaround(): number {
		return 0;
	}

	override async markNextPacket(context: PacketReadingContext): Promise<void> {
		const CHUNK_SIZE = 128;

		while (true) {
			let remaining = context.ensureBuffered(CHUNK_SIZE);
			if (remaining instanceof Promise) remaining = await remaining;

			for (let i = 0; i < remaining; i++) {
				const byte = context.readU8();
				if (byte !== 0xff) {
					continue;
				}

				context.skip(-1);
				const startPos = context.currentPos;

				let remaining = context.ensureBuffered(MAX_FRAME_HEADER_SIZE);
				if (remaining instanceof Promise) remaining = await remaining;

				if (remaining < MAX_FRAME_HEADER_SIZE) {
					return;
				}

				const headerBytes = context.readBytes(MAX_FRAME_HEADER_SIZE);
				const header = readAdtsFrameHeader(FileSlice.tempFromBytes(headerBytes));

				if (header) {
					context.seekTo(startPos);

					let remaining = context.ensureBuffered(header.frameLength);
					if (remaining instanceof Promise) remaining = await remaining;

					return context.supplyPacket(
						remaining,
						Math.round(SAMPLES_PER_AAC_FRAME * TIMESCALE / this.elementaryStream.info.sampleRate),
					);
				}
			}

			if (remaining < CHUNK_SIZE) {
				break;
			}
		}
	}
}

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

	suppliedPacket: {
		pts: number;
		intrinsicDuration: number;
		data: Uint8Array;
		sequenceNumber: number;
	} | null = null;

	constructor(backing: MpegTsTrackBacking, startingPesPacket: PesPacket, uncapped: boolean) {
		this.backing = backing;
		this.pid = backing.elementaryStream.pid;
		this.demuxer = backing.elementaryStream.demuxer;
		this.startingPesPacket = startingPesPacket;
		this.uncapped = uncapped;
	}

	clone() {
		const clone = new PacketReadingContext(this.backing, this.startingPesPacket, this.uncapped);
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
			const relativeStartOffset = 0;
			const relativeEndOffset = length - offset;

			if (relativeEndOffset <= currentPesPacket.data.byteLength) {
				result.set(currentPesPacket.data.subarray(relativeStartOffset, relativeEndOffset), offset);
				break;
			}

			result.set(currentPesPacket.data.subarray(relativeStartOffset), offset);
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

		this.backing.maybeInsertReferencePacket(currentPesPacket, false);

		const pts = this.nextPts;
		this.nextPts += intrinsicDuration;

		// The sequence number is the starting position of the section the PES packet is in, PLUS the offset within the
		// PES packet where the packet starts.
		const sequenceNumber = currentPesPacket.sectionStartPos + (this.currentPos - this.currentPesPacketPos);

		this.suppliedPacket = {
			pts,
			intrinsicDuration,
			data: this.readBytes(packetLength),
			sequenceNumber,
		};

		this.pesPackets.splice(0, this.currentPesPacketIndex);
		this.currentPesPacketIndex = 0;
	}

	toEncodedPacket(options: PacketRetrievalOptions) {
		if (!this.suppliedPacket) {
			return null;
		}

		const packet = new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : this.suppliedPacket.data,
			this.backing.getPacketType(this.suppliedPacket.data),
			this.suppliedPacket.pts / TIMESCALE,
			this.suppliedPacket.intrinsicDuration / TIMESCALE,
			this.suppliedPacket.sequenceNumber,
			this.suppliedPacket.data.byteLength,
		);
		this.backing.readingContexts.set(packet, this);

		return packet;
	}
}
