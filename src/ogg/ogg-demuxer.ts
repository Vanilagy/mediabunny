/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OPUS_SAMPLE_RATE } from '../codec';
import { parseModesFromVorbisSetupPacket, parseOpusIdentificationHeader, readVorbisComments } from '../codec-data';
import { PacketRetrievalOptions } from '../cursors';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import {
	assert,
	AsyncMutex4,
	binarySearchLessOrEqual,
	findLast,
	last,
	ResultValue,
	roundIfAlmostInteger,
	toDataView,
	UNDETERMINED_LANGUAGE,
	Yo,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { readBytes, Reader } from '../reader';
import { buildOggMimeType, computeOggPageCrc, extractSampleMetadata, OggCodecInfo } from './ogg-misc';
import {
	findNextPageHeader,
	MAX_PAGE_HEADER_SIZE,
	MAX_PAGE_SIZE,
	MIN_PAGE_HEADER_SIZE,
	Page,
	readPageHeader,
} from './ogg-reader';

type LogicalBitstream = {
	serialNumber: number;
	bosPage: Page;
	description: Uint8Array | null;
	numberOfChannels: number;
	sampleRate: number;
	codecInfo: OggCodecInfo;

	lastMetadataPacket: Packet | null;
};

type Packet = {
	data: Uint8Array;
	endPage: Page;
	endSegmentIndex: number;
};

type PacketStart = {
	startPage: Page;
	startSegmentIndex: number;
};

export class OggDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	bitstreams: LogicalBitstream[] = [];
	tracks: InputAudioTrack[] = [];
	metadataTags: MetadataTags = {};

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let currentPos = 0;

			while (true) {
				let slice = this.reader.requestSliceRange(currentPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
				if (slice instanceof Promise) slice = await slice;
				if (!slice) break;

				const page = readPageHeader(slice);
				if (!page) {
					break;
				}

				const isBos = !!(page.headerType & 0x02);
				if (!isBos) {
					// All bos pages for all bitstreams are required to be at the start, so if the page is not bos then
					// we know we've seen all bitstreams (minus chaining)
					break;
				}

				this.bitstreams.push({
					serialNumber: page.serialNumber,
					bosPage: page,
					description: null,
					numberOfChannels: -1,
					sampleRate: -1,
					codecInfo: {
						codec: null,
						vorbisInfo: null,
						opusInfo: null,
					},
					lastMetadataPacket: null,
				});

				currentPos = page.headerStartPos + page.totalSize;
			}

			for (const bitstream of this.bitstreams) {
				const packetResult = new ResultValue<Packet | null>();
				await this.readPacket(packetResult, bitstream.bosPage, 0);

				const firstPacket = packetResult.value;
				if (!firstPacket) {
					continue;
				}

				if (
					// Check for Vorbis
					firstPacket.data.byteLength >= 7
					&& firstPacket.data[0] === 0x01 // Packet type 1 = identification header
					&& firstPacket.data[1] === 0x76 // 'v'
					&& firstPacket.data[2] === 0x6f // 'o'
					&& firstPacket.data[3] === 0x72 // 'r'
					&& firstPacket.data[4] === 0x62 // 'b'
					&& firstPacket.data[5] === 0x69 // 'i'
					&& firstPacket.data[6] === 0x73 // 's'
				) {
					await this.readVorbisMetadata(firstPacket, bitstream);
				} else if (
					// Check for Opus
					firstPacket.data.byteLength >= 8
					&& firstPacket.data[0] === 0x4f // 'O'
					&& firstPacket.data[1] === 0x70 // 'p'
					&& firstPacket.data[2] === 0x75 // 'u'
					&& firstPacket.data[3] === 0x73 // 's'
					&& firstPacket.data[4] === 0x48 // 'H'
					&& firstPacket.data[5] === 0x65 // 'e'
					&& firstPacket.data[6] === 0x61 // 'a'
					&& firstPacket.data[7] === 0x64 // 'd'
				) {
					await this.readOpusMetadata(firstPacket, bitstream);
				}

				if (bitstream.codecInfo.codec !== null) {
					this.tracks.push(new InputAudioTrack(this.input, new OggAudioTrackBacking(bitstream, this)));
				}
			}
		})();
	}

	async readVorbisMetadata(firstPacket: Packet, bitstream: LogicalBitstream) {
		const positionResult = new ResultValue<PacketStart | null>();
		await this.findNextPacketStart(positionResult, firstPacket);

		let nextPacketPosition = positionResult.value;
		if (!nextPacketPosition) {
			return;
		}

		const packetResult = new ResultValue<Packet | null>();
		await this.readPacket(packetResult, nextPacketPosition.startPage, nextPacketPosition.startSegmentIndex);

		const secondPacket = packetResult.value;
		if (!secondPacket) {
			return;
		}

		await this.findNextPacketStart(positionResult, secondPacket);

		nextPacketPosition = positionResult.value;
		if (!nextPacketPosition) {
			return;
		}

		await this.readPacket(packetResult, nextPacketPosition.startPage, nextPacketPosition.startSegmentIndex);

		const thirdPacket = packetResult.value;
		if (!thirdPacket) {
			return;
		}

		if (secondPacket.data[0] !== 0x03 || thirdPacket.data[0] !== 0x05) {
			return;
		}

		const lacingValues: number[] = [];
		const addBytesToSegmentTable = (bytes: number) => {
			while (true) {
				lacingValues.push(Math.min(255, bytes));

				if (bytes < 255) {
					break;
				}

				bytes -= 255;
			}
		};

		addBytesToSegmentTable(firstPacket.data.length);
		addBytesToSegmentTable(secondPacket.data.length);
		// We don't add the last packet to the segment table, as it is assumed to be whatever bytes remain

		const description = new Uint8Array(
			1 + lacingValues.length
			+ firstPacket.data.length + secondPacket.data.length + thirdPacket.data.length,
		);
		description[0] = 2; // Num entries in the segment table
		description.set(
			lacingValues, 1,
		);
		description.set(
			firstPacket.data, 1 + lacingValues.length,
		);
		description.set(
			secondPacket.data, 1 + lacingValues.length + firstPacket.data.length,
		);
		description.set(
			thirdPacket.data, 1 + lacingValues.length + firstPacket.data.length + secondPacket.data.length,
		);

		bitstream.codecInfo.codec = 'vorbis';
		bitstream.description = description;
		bitstream.lastMetadataPacket = thirdPacket;

		const view = toDataView(firstPacket.data);
		bitstream.numberOfChannels = view.getUint8(11);
		bitstream.sampleRate = view.getUint32(12, true);

		const blockSizeByte = view.getUint8(28);
		bitstream.codecInfo.vorbisInfo = {
			blocksizes: [
				1 << (blockSizeByte & 0xf),
				1 << (blockSizeByte >> 4),
			],
			modeBlockflags: parseModesFromVorbisSetupPacket(thirdPacket.data).modeBlockflags,
		};

		readVorbisComments(secondPacket.data.subarray(7), this.metadataTags); // Skip header type and 'vorbis'
	}

	async readOpusMetadata(firstPacket: Packet, bitstream: LogicalBitstream) {
		// From https://datatracker.ietf.org/doc/html/rfc7845#section-5:
		// "An Ogg Opus logical stream contains exactly two mandatory header packets: an identification header and a
		// comment header."

		const positionResult = new ResultValue<PacketStart | null>();
		await this.findNextPacketStart(positionResult, firstPacket);

		const nextPacketPosition = positionResult.value;
		if (!nextPacketPosition) {
			return;
		}

		const packetResult = new ResultValue<Packet | null>();
		await this.readPacket(packetResult, nextPacketPosition.startPage, nextPacketPosition.startSegmentIndex);

		const secondPacket = packetResult.value;
		if (!secondPacket) {
			return;
		}

		bitstream.codecInfo.codec = 'opus';
		bitstream.description = firstPacket.data;
		bitstream.lastMetadataPacket = secondPacket;

		const header = parseOpusIdentificationHeader(firstPacket.data);
		bitstream.numberOfChannels = header.outputChannelCount;
		bitstream.sampleRate = OPUS_SAMPLE_RATE; // Always the same

		bitstream.codecInfo.opusInfo = {
			preSkip: header.preSkip,
		};

		readVorbisComments(secondPacket.data.subarray(8), this.metadataTags); // Skip 'OpusTags'
	}

	async readPacket(res: ResultValue<Packet | null>, startPage: Page, startSegmentIndex: number): Promise<Yo> {
		assert(startSegmentIndex < startPage.lacingValues.length);

		let startDataOffset = 0;
		for (let i = 0; i < startSegmentIndex; i++) {
			startDataOffset += startPage.lacingValues[i]!;
		}

		let currentPage: Page = startPage;
		let currentDataOffset = startDataOffset;
		let currentSegmentIndex = startSegmentIndex;

		const chunks: Uint8Array[] = [];

		outer:
		while (true) {
			// Load the entire page data
			let pageSlice = this.reader.requestSlice(currentPage.dataStartPos, currentPage.dataSize);
			if (pageSlice instanceof Promise) pageSlice = await pageSlice;
			assert(pageSlice);
			const pageData = readBytes(pageSlice, currentPage.dataSize);

			while (true) {
				if (currentSegmentIndex === currentPage.lacingValues.length) {
					chunks.push(pageData.subarray(startDataOffset, currentDataOffset));
					break;
				}

				const lacingValue = currentPage.lacingValues[currentSegmentIndex]!;
				currentDataOffset += lacingValue;

				if (lacingValue < 255) {
					chunks.push(pageData.subarray(startDataOffset, currentDataOffset));
					break outer;
				}

				currentSegmentIndex++;
			}

			// The packet extends to the next page; let's find it
			let currentPos = currentPage.headerStartPos + currentPage.totalSize;
			while (true) {
				let headerSlice = this.reader.requestSliceRange(currentPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
				if (headerSlice instanceof Promise) headerSlice = await headerSlice;
				if (!headerSlice) {
					return res.set(null);
				}

				const nextPage = readPageHeader(headerSlice);
				if (!nextPage) {
					return res.set(null);
				}

				currentPage = nextPage;
				if (currentPage.serialNumber === startPage.serialNumber) {
					break;
				}
				currentPos = currentPage.headerStartPos + currentPage.totalSize;
			}

			startDataOffset = 0;
			currentDataOffset = 0;
			currentSegmentIndex = 0;
		}

		let packetData: Uint8Array;

		if (chunks.length === 1) {
			// Fast path, no need for an allocation. Also typically the common path!
			packetData = chunks[0]!;
		} else {
			const totalPacketSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			packetData = new Uint8Array(totalPacketSize);

			let offset = 0;
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				packetData.set(chunk, offset);
				offset += chunk.length;
			}
		}

		return res.set({
			data: packetData,
			endPage: currentPage,
			endSegmentIndex: currentSegmentIndex,
		});
	}

	async findNextPacketStart(res: ResultValue<PacketStart | null>, lastPacket: Packet): Promise<Yo> {
		// If there's another segment in the same page, return it
		if (lastPacket.endSegmentIndex < lastPacket.endPage.lacingValues.length - 1) {
			return res.set({ startPage: lastPacket.endPage, startSegmentIndex: lastPacket.endSegmentIndex + 1 });
		}

		const isEos = !!(lastPacket.endPage.headerType & 0x04);
		if (isEos) {
			// The page is marked as the last page of the logical bitstream, so we won't find anything beyond it
			return res.set(null);
		}

		// Otherwise, search for the next page belonging to the same bitstream
		let currentPos = lastPacket.endPage.headerStartPos + lastPacket.endPage.totalSize;
		while (true) {
			let slice = this.reader.requestSliceRange(currentPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice) {
				return res.set(null);
			}

			const nextPage = readPageHeader(slice);
			if (!nextPage) {
				return res.set(null);
			}

			if (nextPage.serialNumber === lastPacket.endPage.serialNumber) {
				return res.set({ startPage: nextPage, startSegmentIndex: 0 });
			}

			currentPos = nextPage.headerStartPos + nextPage.totalSize;
		}
	}

	async getMimeType() {
		await this.readMetadata();

		const codecStrings = await Promise.all(this.tracks.map(x => x.getCodecParameterString()));

		return buildOggMimeType({
			codecStrings: codecStrings.filter(Boolean) as string[],
		});
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}
}

type EncodedPacketMetadata = {
	packet: Packet;
	timestampInSamples: number;
	durationInSamples: number;
	vorbisLastBlockSize: number | null;
	vorbisBlockSize: number | null;
};

class OggAudioTrackBacking implements InputAudioTrackBacking {
	internalSampleRate: number;
	sequentialScanCache: EncodedPacketMetadata[] = [];
	sequentialScanMutex = new AsyncMutex4();

	constructor(public bitstream: LogicalBitstream, public demuxer: OggDemuxer) {
		// Opus always uses a fixed sample rate for its internal calculations, even if the actual rate is different
		this.internalSampleRate = bitstream.codecInfo.codec === 'opus'
			? OPUS_SAMPLE_RATE
			: bitstream.sampleRate;
	}

	getId() {
		return this.bitstream.serialNumber;
	}

	getNumberOfChannels() {
		return this.bitstream.numberOfChannels;
	}

	getSampleRate() {
		return this.bitstream.sampleRate;
	}

	getTimeResolution() {
		return this.bitstream.sampleRate;
	}

	getCodec() {
		return this.bitstream.codecInfo.codec;
	}

	getInternalCodecId() {
		return null;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		assert(this.bitstream.codecInfo.codec);

		return {
			codec: this.bitstream.codecInfo.codec,
			numberOfChannels: this.bitstream.numberOfChannels,
			sampleRate: this.bitstream.sampleRate,
			description: this.bitstream.description ?? undefined,
		};
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition() {
		return {
			...DEFAULT_TRACK_DISPOSITION,
		};
	}

	granulePositionToTimestampInSamples(granulePosition: number) {
		if (this.bitstream.codecInfo.codec === 'opus') {
			assert(this.bitstream.codecInfo.opusInfo);
			return granulePosition - this.bitstream.codecInfo.opusInfo.preSkip;
		}

		return granulePosition;
	}

	createEncodedPacketFromOggPacket(
		packet: Packet | null,
		additional: {
			timestampInSamples: number;
			vorbisLastBlocksize: number | null;
		},
		options: PacketRetrievalOptions,
	) {
		if (!packet) {
			return null;
		}

		const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
			packet.data,
			this.bitstream.codecInfo,
			additional.vorbisLastBlocksize,
		);

		const encodedPacket = new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : packet.data,
			'key',
			Math.max(0, additional.timestampInSamples) / this.internalSampleRate,
			durationInSamples / this.internalSampleRate,
			packet.endPage.headerStartPos + packet.endSegmentIndex,
			packet.data.byteLength,
		);

		encodedPacket._internal = {
			packet,
			timestampInSamples: additional.timestampInSamples,
			durationInSamples,
			vorbisLastBlockSize: additional.vorbisLastBlocksize,
			vorbisBlockSize,
		} satisfies EncodedPacketMetadata;

		return encodedPacket;
	}

	async getFirstPacket(res: ResultValue<EncodedPacket | null>, options: PacketRetrievalOptions): Promise<Yo> {
		assert(this.bitstream.lastMetadataPacket);

		const positionResult = new ResultValue<PacketStart | null>();
		let promise = this.demuxer.findNextPacketStart(positionResult, this.bitstream.lastMetadataPacket);
		if (positionResult.pending) await promise;

		const packetPosition = positionResult.value;

		if (!packetPosition) {
			return res.set(null);
		}

		let timestampInSamples = 0;
		if (this.bitstream.codecInfo.codec === 'opus') {
			assert(this.bitstream.codecInfo.opusInfo);
			timestampInSamples -= this.bitstream.codecInfo.opusInfo.preSkip;
		}

		const packetResult = new ResultValue<Packet | null>();
		promise = this.demuxer.readPacket(packetResult, packetPosition.startPage, packetPosition.startSegmentIndex);
		if (packetResult.pending) await promise;

		return res.set(this.createEncodedPacketFromOggPacket(
			packetResult.value,
			{
				timestampInSamples,
				vorbisLastBlocksize: null,
			},
			options,
		));
	}

	async getNextPacket(
		res: ResultValue<EncodedPacket | null>,
		prevPacket: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		const prevMetadata = prevPacket._internal as EncodedPacketMetadata | undefined;
		if (!prevMetadata) {
			throw new Error('Packet was not created from this track.');
		}

		const positionResult = new ResultValue<PacketStart | null>();
		let promise = this.demuxer.findNextPacketStart(positionResult, prevMetadata.packet);
		if (positionResult.pending) await promise;

		const packetPosition = positionResult.value;
		if (!packetPosition) {
			return res.set(null);
		}

		const timestampInSamples = prevMetadata.timestampInSamples + prevMetadata.durationInSamples;

		const packetResult = new ResultValue<Packet | null>();
		promise = this.demuxer.readPacket(packetResult, packetPosition.startPage, packetPosition.startSegmentIndex);
		if (packetResult.pending) await promise;

		return res.set(this.createEncodedPacketFromOggPacket(
			packetResult.value,
			{
				timestampInSamples,
				vorbisLastBlocksize: prevMetadata.vorbisBlockSize,
			},
			options,
		));
	}

	async getPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		if (this.demuxer.reader.fileSize === null) {
			// No file size known, can't do binary search, but fall back to sequential algo instead
			return this.getPacketSequential(res, timestamp, options);
		}

		const timestampInSamples = roundIfAlmostInteger(timestamp * this.internalSampleRate);
		if (timestampInSamples === 0) {
			// Fast path for timestamp 0 - avoids binary search when playing back from the start
			return this.getFirstPacket(res, options);
		}
		if (timestampInSamples < 0) {
			// There's nothing here
			return res.set(null);
		}

		assert(this.bitstream.lastMetadataPacket);

		const positionResult = new ResultValue<PacketStart | null>();
		const promise = this.demuxer.findNextPacketStart(positionResult, this.bitstream.lastMetadataPacket);
		if (positionResult.pending) await promise;

		const startPosition = positionResult.value;
		if (!startPosition) {
			return res.set(null);
		}

		let lowPage = startPosition.startPage;
		let high = this.demuxer.reader.fileSize;

		const lowPages: Page[] = [lowPage];

		// First, let's perform a binary serach (bisection search) on the file to find the approximate page where
		// we'll find the packet. We want to find a page whose end packet position is less than or equal to the
		// packet position we're searching for.

		// Outer loop: Does the binary serach
		outer:
		while (lowPage.headerStartPos + lowPage.totalSize < high) {
			const low = lowPage.headerStartPos;
			const mid = Math.floor((low + high) / 2);

			let searchStartPos = mid;

			// Inner loop: Does a linear forward scan if the page cannot be found immediately
			while (true) {
				const until = Math.min(
					searchStartPos + MAX_PAGE_SIZE,
					high - MIN_PAGE_HEADER_SIZE,
				);

				let searchSlice = this.demuxer.reader.requestSlice(searchStartPos, until - searchStartPos);
				if (searchSlice instanceof Promise) searchSlice = await searchSlice;
				assert(searchSlice);

				const found = findNextPageHeader(searchSlice, until);
				if (!found) {
					high = mid + MIN_PAGE_HEADER_SIZE;
					continue outer;
				}

				let headerSlice = this.demuxer.reader.requestSliceRange(
					searchSlice.filePos,
					MIN_PAGE_HEADER_SIZE,
					MAX_PAGE_HEADER_SIZE,
				);
				if (headerSlice instanceof Promise) headerSlice = await headerSlice;
				assert(headerSlice);

				const page = readPageHeader(headerSlice);
				assert(page);

				let pageValid = false;
				if (page.serialNumber === this.bitstream.serialNumber) {
					// Serial numbers are basically random numbers, and the chance of finding a fake page with
					// matching serial number is astronomically low, so we can be pretty sure this page is legit.
					pageValid = true;
				} else {
					let pageSlice = this.demuxer.reader.requestSlice(page.headerStartPos, page.totalSize);
					if (pageSlice instanceof Promise) pageSlice = await pageSlice;
					assert(pageSlice);

					// Validate the page by checking checksum
					const bytes = readBytes(pageSlice, page.totalSize);
					const crc = computeOggPageCrc(bytes);

					pageValid = crc === page.checksum;
				}

				if (!pageValid) {
					// Keep searching for a valid page
					searchStartPos = page.headerStartPos + 4; // 'OggS' is 4 bytes
					continue;
				}

				if (pageValid && page.serialNumber !== this.bitstream.serialNumber) {
					// Page is valid but from a different bitstream, so keep searching forward until we find one
					// belonging to the our bitstream
					searchStartPos = page.headerStartPos + page.totalSize;
					continue;
				}

				const isContinuationPage = page.granulePosition === -1;
				if (isContinuationPage) {
					// No packet ends on this page - keep looking
					searchStartPos = page.headerStartPos + page.totalSize;
					continue;
				}

				// The page is valid and belongs to our bitstream; let's check its granule position to see where we
				// need to take the bisection search.
				if (this.granulePositionToTimestampInSamples(page.granulePosition) > timestampInSamples) {
					high = page.headerStartPos;
				} else {
					lowPage = page;
					lowPages.push(page);
				}

				continue outer;
			}
		}

		// Now we have the last page with a packet position <= the packet position we're looking for, but there
		// might be multiple pages with the packet position, in which case we actually need to find the first of
		// such pages. We'll do this in two steps: First, let's find the latest page we know with an earlier packet
		// position, and then linear scan ourselves forward until we find the correct page.

		let lowerPage = startPosition.startPage;
		for (const otherLowPage of lowPages) {
			if (otherLowPage.granulePosition === lowPage.granulePosition) {
				break;
			}

			if (!lowerPage || otherLowPage.headerStartPos > lowerPage.headerStartPos) {
				lowerPage = otherLowPage;
			}
		}

		let currentPage = lowerPage;
		// Keep track of the pages we traversed, we need these later for backwards seeking
		const previousPages: Page[] = [currentPage];

		while (true) {
			// This loop must terminate as we'll eventually reach lowPage
			if (
				currentPage.serialNumber === this.bitstream.serialNumber
				&& currentPage.granulePosition === lowPage.granulePosition
			) {
				break;
			}

			const nextPos = currentPage.headerStartPos + currentPage.totalSize;
			let slice = this.demuxer.reader.requestSliceRange(nextPos, MIN_PAGE_HEADER_SIZE, MAX_PAGE_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			assert(slice);

			const nextPage = readPageHeader(slice);
			assert(nextPage);

			currentPage = nextPage;

			if (currentPage.serialNumber === this.bitstream.serialNumber) {
				previousPages.push(currentPage);
			}
		}

		assert(currentPage.granulePosition !== -1);

		let currentSegmentIndex: number | null = null;
		let currentTimestampInSamples: number;
		let currentTimestampIsCorrect: boolean;

		// These indicate the end position of the packet that the granule position belongs to
		let endPage = currentPage;
		let endSegmentIndex = 0;

		if (currentPage.headerStartPos === startPosition.startPage.headerStartPos) {
			currentTimestampInSamples = this.granulePositionToTimestampInSamples(0);
			currentTimestampIsCorrect = true;
			currentSegmentIndex = 0;
		} else {
			currentTimestampInSamples = 0; // Placeholder value! We'll refine it once we can
			currentTimestampIsCorrect = false;

			// Find the segment index of the next packet
			for (let i = currentPage.lacingValues.length - 1; i >= 0; i--) {
				const value = currentPage.lacingValues[i]!;
				if (value < 255) {
					// We know the last packet ended at i, so the next one starts at i + 1
					currentSegmentIndex = i + 1;
					break;
				}
			}

			// This must hold: Since this page has a granule position set, that means there must be a packet that
			// ends in this page.
			if (currentSegmentIndex === null) {
				throw new Error('Invalid page with granule position: no packets end on this page.');
			}

			endSegmentIndex = currentSegmentIndex - 1;
			const pseudopacket: Packet = {
				data: PLACEHOLDER_DATA,
				endPage,
				endSegmentIndex,
			};

			positionResult.reset();
			const promise = this.demuxer.findNextPacketStart(positionResult, pseudopacket);
			if (positionResult.pending) await promise;

			const nextPosition = positionResult.value;

			if (nextPosition) {
				// Let's rewind a single step (packet) - this previous packet ensures that we'll correctly compute
				// the duration for the packet we're looking for.
				const endPosition = findPreviousPacketEndPosition(previousPages, currentPage, currentSegmentIndex);
				assert(endPosition);

				const startPosition = findPacketStartPosition(
					previousPages, endPosition.page, endPosition.segmentIndex,
				);
				if (startPosition) {
					currentPage = startPosition.page;
					currentSegmentIndex = startPosition.segmentIndex;
				}
			} else {
				// There is no next position, which means we're looking for the last packet in the bitstream. The
				// granule position on the last page tends to be fucky, so let's instead start the search on the
				// page before that. So let's loop until we find a packet that ends in a previous page.
				while (true) {
					const endPosition = findPreviousPacketEndPosition(
						previousPages, currentPage, currentSegmentIndex,
					);
					if (!endPosition) {
						break;
					}

					const startPosition = findPacketStartPosition(
						previousPages, endPosition.page, endPosition.segmentIndex,
					);
					if (!startPosition) {
						break;
					}

					currentPage = startPosition.page;
					currentSegmentIndex = startPosition.segmentIndex;

					if (endPosition.page.headerStartPos !== endPage.headerStartPos) {
						endPage = endPosition.page;
						endSegmentIndex = endPosition.segmentIndex;
						break;
					}
				}
			}
		}

		let lastEncodedPacket: EncodedPacket | null = null;
		let lastEncodedPacketMetadata: EncodedPacketMetadata | null = null;

		const packetResult = new ResultValue<Packet | null>();

		// Alright, now it's time for the final, granular seek: We keep iterating over packets until we've found the
		// one with the correct timestamp - i.e., the last one with a timestamp <= the timestamp we're looking for.
		while (currentPage !== null) {
			assert(currentSegmentIndex !== null);

			packetResult.reset();
			let promise = this.demuxer.readPacket(packetResult, currentPage, currentSegmentIndex);
			if (packetResult.pending) await promise;

			const packet = packetResult.value;
			if (!packet) {
				break;
			}

			// We might need to skip the packet if it's a metadata one
			const skipPacket = currentPage.headerStartPos === startPosition.startPage.headerStartPos
				&& currentSegmentIndex < startPosition.startSegmentIndex;

			if (!skipPacket) {
				let encodedPacket = this.createEncodedPacketFromOggPacket(
					packet,
					{
						timestampInSamples: currentTimestampInSamples,
						vorbisLastBlocksize: lastEncodedPacketMetadata?.vorbisBlockSize ?? null,
					},
					options,
				);
				assert(encodedPacket);

				let encodedPacketMetadata = encodedPacket._internal as EncodedPacketMetadata | undefined;
				assert(encodedPacketMetadata);

				if (
					!currentTimestampIsCorrect
					&& packet.endPage.headerStartPos === endPage.headerStartPos
					&& packet.endSegmentIndex === endSegmentIndex
				) {
					// We know this packet end timestamp can be derived from the page's granule position
					currentTimestampInSamples = this.granulePositionToTimestampInSamples(
						currentPage.granulePosition,
					);
					currentTimestampIsCorrect = true;

					// Let's backpatch the packet we just created with the correct timestamp
					encodedPacket = this.createEncodedPacketFromOggPacket(
						packet,
						{
							timestampInSamples: currentTimestampInSamples - encodedPacketMetadata.durationInSamples,
							vorbisLastBlocksize: lastEncodedPacketMetadata?.vorbisBlockSize ?? null,
						},
						options,
					);
					assert(encodedPacket);

					encodedPacketMetadata = encodedPacket._internal as EncodedPacketMetadata | undefined;
					assert(encodedPacketMetadata);
				} else {
					currentTimestampInSamples += encodedPacketMetadata.durationInSamples;
				}

				lastEncodedPacket = encodedPacket;
				lastEncodedPacketMetadata = encodedPacketMetadata;

				if (
					currentTimestampIsCorrect
					&& (
						// Next timestamp will be too late
						Math.max(currentTimestampInSamples, 0) > timestampInSamples
						// This timestamp already matches
						|| Math.max(encodedPacketMetadata.timestampInSamples, 0) === timestampInSamples
					)
				) {
					break;
				}
			}

			positionResult.reset();
			promise = this.demuxer.findNextPacketStart(positionResult, packet);
			if (positionResult.pending) await promise;

			const nextPosition = positionResult.value;
			if (!nextPosition) {
				break;
			}

			currentPage = nextPosition.startPage;
			currentSegmentIndex = nextPosition.startSegmentIndex;
		}

		return res.set(lastEncodedPacket);
	}

	// A slower but simpler and sequential algorithm for finding a packet in a file
	async getPacketSequential(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<Yo> {
		using lock = this.sequentialScanMutex.lock(); // Requires exclusivity because we write to a cache
		if (lock.pending) await lock.ready;

		const timestampInSamples = roundIfAlmostInteger(timestamp * this.internalSampleRate);
		timestamp = timestampInSamples / this.internalSampleRate;

		const index = binarySearchLessOrEqual(
			this.sequentialScanCache,
			timestampInSamples,
			x => x.timestampInSamples,
		);

		const result = new ResultValue<EncodedPacket | null>();
		let currentPacket: EncodedPacket | null;

		if (index !== -1) {
			// We don't need to start from the beginning, we can start at a previous scan point
			const cacheEntry = this.sequentialScanCache[index]!;
			currentPacket = this.createEncodedPacketFromOggPacket(
				cacheEntry.packet,
				{
					timestampInSamples: cacheEntry.timestampInSamples,
					vorbisLastBlocksize: cacheEntry.vorbisLastBlockSize,
				},
				options,
			);
		} else {
			const promise = this.getFirstPacket(result, options);
			if (result.pending) await promise;

			currentPacket = result.value;
		}

		let i = 0;

		while (currentPacket && currentPacket.timestamp < timestamp) {
			result.reset();
			const promise = this.getNextPacket(result, currentPacket, options);
			if (result.pending) await promise;

			const nextPacket = result.value;
			if (!nextPacket || nextPacket.timestamp > timestamp) {
				break;
			}

			currentPacket = nextPacket;
			i++;

			if (i === 100) {
				// Add "checkpoints" every once in a while to speed up subsequent random accesses
				i = 0;
				const metadata = currentPacket._internal as EncodedPacketMetadata | undefined;
				assert(metadata);

				if (this.sequentialScanCache.length > 0) {
					// If we reach this case, we must be at the end of the cache
					assert(last(this.sequentialScanCache)!.timestampInSamples <= metadata.timestampInSamples);
				}

				this.sequentialScanCache.push(metadata);
			}
		}

		return res.set(currentPacket);
	}

	getKeyPacket(res: ResultValue<EncodedPacket | null>, timestamp: number, options: PacketRetrievalOptions) {
		// Correct since only audio codecs are supported
		return this.getPacket(res, timestamp, options);
	}

	getNextKeyPacket(res: ResultValue<EncodedPacket | null>, packet: EncodedPacket, options: PacketRetrievalOptions) {
		// Correct since only audio codecs are supported
		return this.getNextPacket(res, packet, options);
	}
}

/** Finds the start position of a packet given its end position. */
const findPacketStartPosition = (pageList: Page[], endPage: Page, endSegmentIndex: number) => {
	let page = endPage;
	let segmentIndex = endSegmentIndex;

	outer:
	while (true) {
		segmentIndex--;

		for (segmentIndex; segmentIndex >= 0; segmentIndex--) {
			const lacingValue = page.lacingValues[segmentIndex]!;
			if (lacingValue < 255) {
				segmentIndex++; // We know the last packet starts here
				break outer;
			}
		}

		assert(segmentIndex === -1);

		const pageStartsWithFreshPacket = !(page.headerType & 0x01);
		if (pageStartsWithFreshPacket) {
			// Fast exit: We know we don't need to look in the previous page
			segmentIndex = 0;
			break;
		}

		const previousPage = findLast(
			pageList,
			x => x.headerStartPos < page.headerStartPos,
		);
		if (!previousPage) {
			return null;
		}

		page = previousPage;
		segmentIndex = page.lacingValues.length;
	}

	assert(segmentIndex !== -1);

	if (segmentIndex === page.lacingValues.length) {
		// Wrap back around to the first segment of the next page
		const nextPage = pageList[pageList.indexOf(page) + 1];
		assert(nextPage);

		page = nextPage;
		segmentIndex = 0;
	}

	return { page, segmentIndex };
};

/** Finds the end position of a packet given the start position of the following packet. */
const findPreviousPacketEndPosition = (pageList: Page[], startPage: Page, startSegmentIndex: number) => {
	if (startSegmentIndex > 0) {
		// Easy
		return { page: startPage, segmentIndex: startSegmentIndex - 1 };
	}

	const previousPage = findLast(
		pageList,
		x => x.headerStartPos < startPage.headerStartPos,
	);
	if (!previousPage) {
		return null;
	}

	return { page: previousPage, segmentIndex: previousPage.lacingValues.length - 1 };
};
