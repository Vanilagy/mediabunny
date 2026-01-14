import { SAMPLES_PER_AAC_FRAME } from '../adts/adts-demuxer';
import { MAX_FRAME_HEADER_SIZE, MIN_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import { aacChannelMap, AacCodecInfo, aacFrequencyTable, AudioCodec, extractAudioCodecString, extractVideoCodecString, MediaCodec, VideoCodec } from '../codec';
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
import { InputAudioTrack, InputAudioTrackBacking, InputTrack, InputTrackBacking, InputVideoTrack, InputVideoTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { assert, binarySearchLessOrEqual, Bitstream, COLOR_PRIMARIES_MAP_INVERSE, last, MATRIX_COEFFICIENTS_MAP_INVERSE, removeItem, Rotation, roundIfAlmostInteger, roundToMultiple, TRANSFER_CHARACTERISTICS_MAP_INVERSE, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { FileSlice, readBytes, Reader, readU16Be, readU8 } from '../reader';

const TIMESCALE = 90_000; // MPEG-TS timestamps run on a 90 kHz clock

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

type PacketHeader = {
	payloadUnitStartIndicator: number;
	pid: number;
	adaptationFieldControl: number;
	body: Uint8Array<ArrayBufferLike>;
};

type Section = {
	startPos: number;
	endPos: number;
	pid: number;
	payload: Uint8Array<ArrayBufferLike>;
};

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: ElementaryStream[] = [];
	tracks: InputTrack[] = [];

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let currentPos = 0;

			let programMapPid: number | null = null;
			let hasProgramMap = false;

			while (true) {
				const section = await this.readSection(currentPos);
				if (!section) {
					break;
				}

				const BYTES_BEFORE_SECTION_LENGTH = 3;
				const BITS_IN_CRC_32 = 32;

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
									throw new Error('TODO message');
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
									throw new Error('TODO message');
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
		return 'video/MP2T'; // TODO TODO
	}

	async readSection(startPos: number): Promise<Section | null> {
		let endPos = startPos;
		let currentPos = startPos;
		const chunks: Uint8Array[] = [];

		let firstPacket: PacketHeader | null = null;

		while (true) {
			const packet = await this.readPacket(currentPos);
			currentPos += 188;

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
				} else {
					chunks.push(packet.body.subarray(adaptationFieldLength));
				}
			}

			endPos = currentPos;
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
			endPos,
			pid: firstPacket.pid,
			payload: merged,
		};
	}

	async readPacket(pos: number): Promise<PacketHeader | null> {
		let slice = this.reader.requestSlice(pos, 188);
		if (slice instanceof Promise) slice = await slice;

		if (!slice) {
			return null;
		}

		const syncByte = readU8(slice);
		if (syncByte !== 0x47) {
			throw new Error('Invalid sync byte.');
		}

		const nextTwoBytes = readU16Be(slice);
		const transportErrorIndicator = nextTwoBytes >> 15;
		const payloadUnitStartIndicator = (nextTwoBytes >> 14) & 0x1;
		const transportPriority = (nextTwoBytes >> 13) & 0x1;
		const pid = nextTwoBytes & 0x1FFF;

		const nextByte = readU8(slice);
		const transportScramblingControl = nextByte >> 6;
		const adaptationFieldControl = (nextByte >> 4) & 0x3;
		const continuityCounter = nextByte & 0xF;

		return {
			payloadUnitStartIndicator,
			pid,
			adaptationFieldControl,
			body: readBytes(slice, 184),
		};
	}
}

type PesPacket = {
	sectionStartPos: number;
	sectionEndPos: number;
	pts: number;
	data: Uint8Array<ArrayBufferLike>;
};

const readPesPacket = (section: Section): PesPacket | null => {
	const bitstream = new Bitstream(section.payload);

	const startCodePrefix = bitstream.readBits(24);
	if (startCodePrefix !== 0x000001) {
		return null;
	}

	const streamId = bitstream.readBits(8);

	const pesPacketLength = bitstream.readBits(16);

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

	bitstream.skipBits(6);
	const pesHeaderDataLength = bitstream.readBits(8);
	const pesHeaderEndPos = bitstream.pos + 8 * pesHeaderDataLength;

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

	bitstream.pos = pesHeaderEndPos;

	const bytePos = pesHeaderEndPos / 8;
	assert(Number.isInteger(bytePos));

	const data = section.payload.subarray(bytePos);

	return {
		sectionStartPos: section.startPos,
		sectionEndPos: section.endPos,
		pts,
		data,
	};
};

abstract class MpegTsTrackBacking implements InputTrackBacking {
	/**
	 * Reference PES packets, spread throughout the file, to be used to speed up random access and perform
	 * binary search for packets.
	 */
	referencePesPackets: PesPacket[] = [];
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

	maybeInsertReferencePacket(pesPacket: PesPacket, force: boolean) {
		const index = binarySearchLessOrEqual(this.referencePesPackets, pesPacket.pts, x => x.pts);
		if (index >= 0) {
			// Since pts and file position don't necessarily have a monotonic relationship (since pts can go crazy),
			// let's see if inserting at the given index would violate the file position order. If so, return.
			const entry = this.referencePesPackets[index]!;
			if (pesPacket.sectionStartPos <= entry.sectionStartPos) {
				return false;
			}

			// Too close temporally
			if (!force && pesPacket.pts - entry.pts < TIMESCALE / 2) {
				return false;
			}

			if (index < this.referencePesPackets.length - 1) {
				const nextEntry = this.referencePesPackets[index + 1]!;
				if (nextEntry.sectionStartPos < pesPacket.sectionStartPos) {
					return false;
				}

				// Too close temporally
				if (!force && nextEntry.pts - pesPacket.pts < TIMESCALE / 2) {
					return false;
				}
			}
		}

		this.referencePesPackets.splice(index + 1, 0, pesPacket);
		return true;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const section = this.elementaryStream.firstSection;
		assert(section);

		const pesPacket = readPesPacket(section);
		if (!pesPacket) {
			throw new Error('TODO message');
		}

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

		if (reader.fileSize === null) {
			throw new Error('TODO TODO TODO');
		}

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
		// track. Without it, we can't perform binary search.
		const needsToLookForLastPacket
			= currentIndex === this.referencePesPackets.length - 1 && !this.endReferencePesPacketAdded;
		if (needsToLookForLastPacket) {
			// Todo, better sync logic here?
			let currentPos = reader.fileSize - 188;
			let packet = await demuxer.readPacket(currentPos);
			if (!packet) {
				return null;
			}

			while (packet.pid !== this.elementaryStream.pid || packet.payloadUnitStartIndicator === 0) {
				currentPos -= 188;
				const previousPacket = await demuxer.readPacket(currentPos);
				if (!previousPacket) {
					return null;
				}

				packet = previousPacket;
			}

			const section = await demuxer.readSection(currentPos);
			assert(section);

			const pesPacket = readPesPacket(section);
			if (!pesPacket) {
				throw new Error('TODO message');
			}

			this.maybeInsertReferencePacket(pesPacket, true);
			this.endReferencePesPacketAdded = true;
		}

		// Find the reference point closest to the search timestamp
		currentIndex = binarySearchLessOrEqual(this.referencePesPackets, searchPts, x => x.pts);
		assert(currentIndex !== -1);

		while (true) {
			const currentEntry = this.referencePesPackets[currentIndex]!;
			const nextEntry = this.referencePesPackets[currentIndex + 1];

			if (searchPts - currentEntry.pts < TIMESCALE || !nextEntry) {
				// We're at the end or close enough to the entry to the left, stop
				break;
			}

			// Jump in between the two entries, and then find a fitting packet there
			const midpoint = roundToMultiple((currentEntry.sectionStartPos + nextEntry.sectionStartPos) / 2, 188);
			let currentPos = midpoint;
			let packet = await demuxer.readPacket(currentPos);
			assert(packet);

			while (
				currentPos < nextEntry.sectionStartPos
				&& (packet.pid !== this.elementaryStream.pid || packet.payloadUnitStartIndicator === 0)
			) {
				currentPos += 188;
				const previousPacket = await demuxer.readPacket(currentPos);
				if (!previousPacket) {
					return null;
				}

				packet = previousPacket;
			}

			if (currentPos >= nextEntry.sectionStartPos) {
				// We couldn't find a packet in the middle
				break;
			}

			const section = await demuxer.readSection(currentPos);
			assert(section);

			const pesPacket = readPesPacket(section);
			if (!pesPacket) {
				throw new Error('TODO message');
			}

			const addedPoint = this.maybeInsertReferencePacket(pesPacket, false);
			if (!addedPoint) {
				break; // Should rarely kick
			}

			if (pesPacket.pts <= searchPts) {
				// The midpoint packet is to the left of our search timestamp, so continue with the right half now
				currentIndex++;
			}
		}

		let currentPesPacket = this.referencePesPackets[currentIndex]!;
		assert(currentPesPacket.pts <= searchPts);

		/** Stores the best PES packet we've found so far (that meets all required criteria). */
		let bestPesPacket: PesPacket | null = null;

		const pesPacketHasKeyframe = async (pesPacket: PesPacket) => {
			const context = new PacketReadingContext(this, pesPacket, false);
			await this.markNextPacket(context);

			if (!context.suppliedPacket) {
				return false;
			}

			return this.getPacketType(context.suppliedPacket.data);
		};

		if (!keyframesOnly || await pesPacketHasKeyframe(currentPesPacket)) {
			bestPesPacket = currentPesPacket;
		}

		const advancedPesPackets = [bestPesPacket];

		// Starting from the binary search guess, let's now find the moment where the packet timestamps cross the
		// search timestamp. This point will then be used as the center around which we search.
		outer:
		while (true) {
			let currentPos = currentPesPacket.sectionEndPos;

			while (true) {
				const packet = await demuxer.readPacket(currentPos);
				if (!packet) {
					break outer; // End of file
				}

				if (packet.pid === this.elementaryStream.pid) {
					break;
				}

				currentPos += 188;
			}

			const nextSection = await demuxer.readSection(currentPos);
			if (!nextSection) {
				break;
			}

			const nextPesPacket = readPesPacket(nextSection);
			if (!nextPesPacket) {
				throw new Error('TODO message');
			}

			if (nextPesPacket.pts > searchPts) {
				// The timestamps cross the search timestamp, stop
				break;
			}

			// Collect matching packets we find along the way
			if (
				(bestPesPacket === null || bestPesPacket.pts < nextPesPacket.pts)
				&& nextPesPacket.pts <= searchPts
				&& (!keyframesOnly || await pesPacketHasKeyframe(nextPesPacket))
			) {
				bestPesPacket = nextPesPacket;
			}

			currentPesPacket = nextPesPacket;
			advancedPesPackets.push(nextPesPacket);
		}

		// Lookaround is needed in the first place because packets don't need to appear in PTS order, they only appear
		// in decode order. When B-frames are present, finding the packet that's actually closest to the search
		// timestamp requires searching a small local window.
		const lookaround = this.getPacketLookaround();

		// Depending on how long the previous scan went, we might not need to do the full lookbehind, or even none at
		// all if we're lucky
		const lookbehindNeeded = Math.max(lookaround - advancedPesPackets.length + 1, 0);
		let minPos = advancedPesPackets[0]!.sectionStartPos;

		/** Scans `n` contiguous PES packets in succession. */
		const doLinearScan = async (startPos: number, n: number) => {
			let currentPos = startPos;

			outer:
			for (let i = 0; i < n; i++) {
				while (true) {
					const packet = await demuxer.readPacket(currentPos);
					if (!packet) {
						break outer; // End of file
					}

					if (packet.pid === this.elementaryStream.pid) {
						break;
					}

					currentPos += 188;
				}

				const section = await demuxer.readSection(currentPos);
				assert(section);
				assert(section.pid === this.elementaryStream.pid);

				const pesPacket = readPesPacket(section);
				if (!pesPacket) {
					throw new Error('TODO message');
				}

				if (
					(bestPesPacket === null || bestPesPacket.pts < pesPacket.pts)
					&& pesPacket.pts <= searchPts
					&& (!keyframesOnly || await pesPacketHasKeyframe(pesPacket))
				) {
					bestPesPacket = pesPacket;
				}

				currentPos = section.endPos;
			}
		};

		// Lookbehind
		if (lookbehindNeeded > 0) {
			outer:
			for (let i = 0; i < lookbehindNeeded; i++) {
				let currentPos = minPos;

				while (true) {
					currentPos -= 188;

					const packet = await demuxer.readPacket(currentPos);
					if (!packet) {
						break outer;
					}

					if (packet.pid === this.elementaryStream.pid && packet.payloadUnitStartIndicator === 1) {
						break;
					}
				}

				minPos = currentPos;
			}

			await doLinearScan(minPos, lookbehindNeeded);
		}

		// Lookahead
		await doLinearScan(currentPesPacket.sectionEndPos, lookaround);

		// If we're looking specifically for a keyframe but haven't found one yet, that means we'll need to go left
		// until we find one.
		if (!bestPesPacket && keyframesOnly) {
			let currentPos = minPos;

			while (true) {
				currentPos -= 188;

				const packet = await demuxer.readPacket(currentPos);
				if (!packet) {
					break;
				}

				if (packet.pid === this.elementaryStream.pid && packet.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(currentPos);
					assert(section);

					const pesPacket = readPesPacket(section);
					if (!pesPacket) {
						throw new Error('TODO message');
					}

					if (pesPacket.pts <= searchPts && (await pesPacketHasKeyframe(pesPacket))) {
						bestPesPacket = pesPacket;
						break;
					}
				}
			}
		}

		if (!bestPesPacket) {
			// Nothing was found
			return null;
		}

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
				currentPos -= 188;

				const packet = await demuxer.readPacket(currentPos);
				if (!packet) {
					// Past start of file
					return null;
				}

				if (packet.pid === this.elementaryStream.pid && packet.payloadUnitStartIndicator === 1) {
					const section = await demuxer.readSection(currentPos);
					assert(section);

					const pesPacket = readPesPacket(section);
					if (!pesPacket) {
						throw new Error('TODO message');
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

				while (true) {
					const packet = await this.demuxer.readPacket(currentPos);
					if (!packet) {
						return;
					}

					if (packet.pid === this.pid) {
						break;
					}

					currentPos += 188;
				}

				const nextSection = await this.demuxer.readSection(currentPos);
				if (!nextSection) {
					return;
				}

				const maybePesPacket = readPesPacket(nextSection);
				if (!maybePesPacket) {
					throw new Error('TODO message');
				}

				pesPacket = maybePesPacket;
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
