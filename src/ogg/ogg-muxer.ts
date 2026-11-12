/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OPUS_SAMPLE_RATE, validateAudioChunkMetadata } from '../codec';
import { createVorbisComments, parseModesFromVorbisSetupPacket, parseOpusIdentificationHeader } from '../codec-data';
import {
	assert,
	assertNever,
	clamp,
	promiseWithResolvers,
	setInt64,
	toDataView,
	toUint8Array,
} from '../misc';
import { Muxer } from '../muxer';
import { Logging } from '../logging';
import { Output,
	OutputAudioTrack,
	OutputTrack } from '../output';
import { OggOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildOggMimeType,
	computeOggPageCrc,
	extractSampleMetadata,
	OggCodecInfo,
	OGGS,
} from './ogg-misc';
import { MAX_PAGE_SIZE } from './ogg-reader';

const PAGE_SIZE_TARGET = 8192;

type OggTrackData = {
	track: OutputAudioTrack;
	serialNumber: number;
	internalSampleRate: number;
	codecInfo: OggCodecInfo & { codec: 'vorbis' | 'opus' };
	vorbisLastBlocksize: number | null;
	packetQueue: Packet[];
	leadingPackets: Packet[];
	startOffsetInSamples: number;
	currentTimestampInSamples: number | null;
	audioPacketCount: number;
	pagesWritten: number;

	currentGranulePosition: number;
	currentLacingValues: number[];
	currentPageData: Uint8Array[];
	currentPageSize: number;
	currentPageStartsWithFreshPacket: boolean;
	currentPageStartTimestampInSamples: number;
};

type Packet = {
	data: Uint8Array;
	timestampInSamples: number;
	durationInSamples: number;
	forcePageFlush: boolean;
	holdPage: boolean;
	isHeader: boolean;
};

export class OggMuxer extends Muxer {
	private format: OggOutputFormat;
	private writer!: Writer;

	private trackDatas: OggTrackData[] = [];
	private closedTracks = new Set<OutputTrack>();
	private bosPagesWritten = false;
	private allTracksKnown = promiseWithResolvers();
	private warnedAboutTooNegativeTimestamp = false;

	private pageBytes = new Uint8Array(MAX_PAGE_SIZE);
	private pageView = new DataView(this.pageBytes.buffer);

	constructor(output: Output, format: OggOutputFormat) {
		super(output);

		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		try {
			this.writer = await this.output._getRootWriter(true); // Ogg is always monotonically written!

			for (const track of this.output.tracks) {
				assert(track.isAudioTrack());
				if (track.metadata.decoderConfig) {
					this.getTrackData(track, { decoderConfig: track.metadata.decoderConfig });
				}
			}
		} finally {
			release();
		}
	}

	async getMimeType() {
		await this.allTracksKnown.promise;

		return buildOggMimeType({
			codecStrings: this.trackDatas.map(x => x.codecInfo.codec),
		});
	}

	addEncodedVideoPacket(): never {
		throw new Error('Video tracks are not supported.');
	}

	private getTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(td => td.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		// Give the track a unique random serial number
		let serialNumber: number;
		do {
			serialNumber = Math.floor(2 ** 32 * Math.random());
		} while (this.trackDatas.some(td => td.serialNumber === serialNumber));

		assert(track.source._codec === 'vorbis' || track.source._codec === 'opus');

		validateAudioChunkMetadata(meta, track.source._codec);

		assert(meta);
		assert(meta.decoderConfig);

		let internalSampleRate: number;
		if (track.source._codec === 'vorbis') {
			internalSampleRate = meta.decoderConfig.sampleRate;
		} else if (track.source._codec === 'opus') {
			internalSampleRate = OPUS_SAMPLE_RATE;
		} else {
			assertNever(track.source._codec);
			assert(false);
		}

		const newTrackData: OggTrackData = {
			track,
			serialNumber,
			internalSampleRate,
			codecInfo: {
				codec: track.source._codec,
				vorbisInfo: null,
				opusInfo: null,
			},
			vorbisLastBlocksize: null,
			packetQueue: [],
			leadingPackets: [],
			startOffsetInSamples: 0,
			currentTimestampInSamples: null,
			audioPacketCount: 0,
			pagesWritten: 0,

			currentGranulePosition: 0,
			currentLacingValues: [],
			currentPageData: [],
			currentPageSize: 27,
			currentPageStartsWithFreshPacket: true,
			currentPageStartTimestampInSamples: 0,
		};

		this.queueHeaderPackets(newTrackData, meta);

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private queueHeaderPackets(trackData: OggTrackData, meta: EncodedAudioChunkMetadata) {
		assert(meta.decoderConfig);

		if (trackData.codecInfo.codec === 'vorbis') {
			assert(meta.decoderConfig.description);

			const bytes = toUint8Array(meta.decoderConfig.description);
			if (bytes[0] !== 2) {
				throw new TypeError('First byte of Vorbis decoder description must be 2.');
			}

			let pos = 1;
			const readPacketLength = () => {
				let length = 0;

				while (true) {
					const value = bytes[pos++];
					if (value === undefined) {
						throw new TypeError('Vorbis decoder description is too short.');
					}

					length += value;

					if (value < 255) {
						return length;
					}
				}
			};

			const identificationHeaderLength = readPacketLength();
			const commentHeaderLength = readPacketLength();
			const setupHeaderLength = bytes.length - pos; // Setup header fills the remaining bytes

			if (setupHeaderLength <= 0) {
				throw new TypeError('Vorbis decoder description is too short.');
			}

			const identificationHeader = bytes.subarray(pos, pos += identificationHeaderLength);
			pos += commentHeaderLength; // Skip the comment header, we'll build our own
			const setupHeader = bytes.subarray(pos);

			const commentHeaderHeader = new Uint8Array(7);
			commentHeaderHeader[0] = 3; // Packet type
			commentHeaderHeader[1] = 0x76; // 'v'
			commentHeaderHeader[2] = 0x6f; // 'o'
			commentHeaderHeader[3] = 0x72; // 'r'
			commentHeaderHeader[4] = 0x62; // 'b'
			commentHeaderHeader[5] = 0x69; // 'i'
			commentHeaderHeader[6] = 0x73; // 's'

			const vorbisComments = createVorbisComments(commentHeaderHeader, this.output._metadataTags, true);

			// Unlike Opus, Vorbis requires the comment header to end with a set framing bit
			const commentHeader = new Uint8Array(vorbisComments.length + 1);
			commentHeader.set(vorbisComments);
			commentHeader[vorbisComments.length] = 1;

			trackData.packetQueue.push({
				data: identificationHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				forcePageFlush: true,
				holdPage: false,
				isHeader: true,
			}, {
				data: commentHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				forcePageFlush: false,
				holdPage: false,
				isHeader: true,
			}, {
				data: setupHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				forcePageFlush: true, // The last header packet must flush the page
				holdPage: false,
				isHeader: true,
			});

			const view = toDataView(identificationHeader);
			const blockSizeByte = view.getUint8(28);

			trackData.codecInfo.vorbisInfo = {
				blocksizes: [
					1 << (blockSizeByte & 0xf),
					1 << (blockSizeByte >> 4),
				],
				modeBlockflags: parseModesFromVorbisSetupPacket(setupHeader).modeBlockflags,
			};
		} else if (trackData.codecInfo.codec === 'opus') {
			if (!meta.decoderConfig.description) {
				throw new TypeError('For Ogg, Opus decoder description is required.');
			}

			const identificationHeader = toUint8Array(meta.decoderConfig.description);

			const commentHeaderHeader = new Uint8Array(8);
			const commentHeaderHeaderView = toDataView(commentHeaderHeader);
			commentHeaderHeaderView.setUint32(0, 0x4f707573, false); // 'Opus'
			commentHeaderHeaderView.setUint32(4, 0x54616773, false); // 'Tags'
			const commentHeader = createVorbisComments(commentHeaderHeader, this.output._metadataTags, true);

			trackData.packetQueue.push({
				data: identificationHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				forcePageFlush: true,
				holdPage: false,
				isHeader: true,
			}, {
				data: commentHeader,
				timestampInSamples: 0,
				durationInSamples: 0,
				forcePageFlush: true, // The last header packet must flush the page
				holdPage: false,
				isHeader: true,
			});

			trackData.codecInfo.opusInfo = {
				preSkip: parseOpusIdentificationHeader(identificationHeader).preSkip,
			};
		} else {
			assertNever(trackData.codecInfo.codec);
		}
	}

	async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getTrackData(track, meta);

			this.validateTimestamp(trackData.track, packet.timestamp, packet.type === 'key');

			const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
				packet.data,
				trackData.codecInfo,
				trackData.vorbisLastBlocksize,
			);
			trackData.vorbisLastBlocksize = vorbisBlockSize;

			if (trackData.currentTimestampInSamples === null) {
				// The first packet determines where the stream begins. Granule positions are offset by the Opus
				// pre-skip, so an earlier start than the encoder's own pre-skip goes into a larger one, as long as the
				// header holding it hasn't been written yet.
				const timestampInSamples = Math.round(packet.timestamp * trackData.internalSampleRate);

				if (trackData.codecInfo.codec === 'vorbis') {
					trackData.currentTimestampInSamples = timestampInSamples;
				} else if (trackData.codecInfo.codec === 'opus') {
					const opusInfo = trackData.codecInfo.opusInfo;
					assert(opusInfo);

					if (trackData.pagesWritten === 0) {
						const preSkip = clamp(-timestampInSamples, opusInfo.preSkip, 2 ** 16 - 1);
						const identificationHeader = trackData.packetQueue[0];
						assert(identificationHeader?.isHeader);

						identificationHeader.data = identificationHeader.data.slice();
						toDataView(identificationHeader.data).setUint16(10, preSkip, true);
						opusInfo.preSkip = preSkip;
					}

					trackData.currentTimestampInSamples = timestampInSamples + opusInfo.preSkip;
				} else {
					assertNever(trackData.codecInfo.codec);
					assert(false);
				}
			}

			const newPacket: Packet = {
				data: packet.data,
				timestampInSamples: trackData.currentTimestampInSamples,
				durationInSamples,
				forcePageFlush: false,
				holdPage: false,
				isHeader: false,
			};
			trackData.currentTimestampInSamples += durationInSamples;

			if (trackData.audioPacketCount === 0) {
				const packetEndTimestampInSamples = newPacket.timestampInSamples + durationInSamples;

				if (trackData.codecInfo.codec === 'opus') {
					if (newPacket.timestampInSamples < 0) {
						this.warnAboutDiscardedPackets();
						return;
					}

					trackData.startOffsetInSamples = newPacket.timestampInSamples;
				} else if (trackData.codecInfo.codec === 'vorbis') {
					if (packetEndTimestampInSamples < 0) {
						// Packets ending before zero can still be represented through start trimming, so let's hold
						// them back until we know the packet that makes the first granule position non-negative
						trackData.leadingPackets.push(newPacket);
						return;
					}

					// The start trimming is expressed by the first page's granule position being smaller than the
					// duration of its packets, so all leading packets must end on that page. Let's keep as many of the
					// latest ones as fit.
					let segmentCount = Math.floor(newPacket.data.length / 255) + 1;
					let firstKeptIndex = trackData.leadingPackets.length;
					while (firstKeptIndex > 0) {
						const leadingPacket = trackData.leadingPackets[firstKeptIndex - 1]!;
						const leadingSegmentCount = Math.floor(leadingPacket.data.length / 255) + 1;
						if (segmentCount + leadingSegmentCount > 255) {
							break;
						}

						segmentCount += leadingSegmentCount;
						firstKeptIndex--;
					}

					if (firstKeptIndex > 0) {
						this.warnAboutDiscardedPackets();
					}

					const keptPackets = trackData.leadingPackets.slice(firstKeptIndex);
					trackData.leadingPackets.length = 0;

					if (keptPackets.length > 0) {
						for (const keptPacket of keptPackets) {
							keptPacket.holdPage = true;
							trackData.packetQueue.push(keptPacket);
						}

						newPacket.holdPage = true;
						newPacket.forcePageFlush = true;
						trackData.audioPacketCount += keptPackets.length;
					} else {
						trackData.startOffsetInSamples = packetEndTimestampInSamples;
					}
				} else {
					assertNever(trackData.codecInfo.codec);
				}
			}

			// With a start offset, the second audio packet flushes the page. This keeps the offset from sharing a page
			// with end trimming, as both are signaled through the granule position and would be indistinguishable.
			// This mirrors a requirement of the Vorbis spec.
			if (trackData.startOffsetInSamples > 0 && trackData.audioPacketCount === 1) {
				newPacket.forcePageFlush = true;
			}
			trackData.audioPacketCount++;

			trackData.packetQueue.push(newPacket);

			await this.interleavePages();
		} finally {
			release();
		}
	}

	addSubtitleCue(): never {
		throw new Error('Subtitle tracks are not supported.');
	}

	allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!this.closedTracks.has(track) && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	async interleavePages(isFinalCall = false) {
		if (!this.bosPagesWritten) {
			if (!this.allTracksAreKnown() && !isFinalCall) {
				return; // We can't interleave yet as we don't yet know how many tracks we'll truly have
			}

			// Write the header page for all bitstreams
			for (const trackData of this.trackDatas) {
				while (trackData.packetQueue.length > 0) {
					const packet = trackData.packetQueue.shift()!;
					this.writePacket(trackData, packet, false);

					if (packet.forcePageFlush) {
						// We say the header page ends once the first packet is encountered that forces a page flush
						break;
					}
				}
			}

			this.bosPagesWritten = true;
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: OggTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length <= 1 // Limit is 1, not 0, for correct EOS flag logic
					&& !this.closedTracks.has(trackData.track)
				) {
					break outer;
				}

				if (trackData.packetQueue.length === 0) {
					continue;
				}

				const nextPacket = trackData.packetQueue[0]!;
				const timestamp = nextPacket.isHeader
					? -Infinity // Headers come before any data
					: nextPacket.timestampInSamples / trackData.internalSampleRate;

				if (timestamp < minTimestamp) {
					trackWithMinTimestamp = trackData;
					minTimestamp = timestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const packet = trackWithMinTimestamp.packetQueue.shift()!;
			const isFinalPacket = trackWithMinTimestamp.packetQueue.length === 0;

			this.writePacket(trackWithMinTimestamp, packet, isFinalPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	writePacket(trackData: OggTrackData, packet: Packet, isFinalPacket: boolean) {
		const packetEndTimestampInSamples = packet.timestampInSamples + packet.durationInSamples;

		if (trackData.currentLacingValues.length === 0) {
			trackData.currentPageStartTimestampInSamples = packet.timestampInSamples;
		}

		if (this.format._options.maximumPageDuration !== undefined && !packet.holdPage) {
			const maxDurationInSamples = this.format._options.maximumPageDuration * trackData.internalSampleRate;

			if (
				trackData.currentLacingValues.length > 0
				&& packetEndTimestampInSamples - trackData.currentPageStartTimestampInSamples > maxDurationInSamples
			) {
				// Flush the current page early to avoid exceeding the maximum page duration
				this.writePage(trackData, false);
			}
		}

		let remainingLength = packet.data.length;
		let dataStartOffset = 0;
		let dataOffset = 0;

		while (true) {
			if (trackData.currentLacingValues.length === 0 && dataStartOffset > 0) {
				// This is a packet spanning multiple pages
				trackData.currentPageStartsWithFreshPacket = false;
			}

			const segmentSize = Math.min(255, remainingLength);
			trackData.currentLacingValues.push(segmentSize);
			trackData.currentPageSize++;
			dataOffset += segmentSize;

			const segmentIsLastOfPacket = remainingLength < 255;

			if (trackData.currentLacingValues.length === 255) {
				// The page is full, we need to add part of the packet data and then flush the page
				const slice = packet.data.subarray(dataStartOffset, dataOffset);
				dataStartOffset = dataOffset;
				trackData.currentPageData.push(slice);
				trackData.currentPageSize += slice.length;

				if (segmentIsLastOfPacket) {
					// The packet ends on this page, so the page's granule position must include it
					trackData.currentGranulePosition = packetEndTimestampInSamples;
				}

				this.writePage(trackData, isFinalPacket && segmentIsLastOfPacket);

				if (segmentIsLastOfPacket) {
					return;
				}
			}

			if (segmentIsLastOfPacket) {
				break;
			}
			remainingLength -= 255;
		}

		const slice = packet.data.subarray(dataStartOffset);
		trackData.currentPageData.push(slice);
		trackData.currentPageSize += slice.length;
		trackData.currentGranulePosition = packetEndTimestampInSamples;

		if (
			(trackData.currentPageSize >= PAGE_SIZE_TARGET && !packet.holdPage)
			|| packet.forcePageFlush
			|| isFinalPacket
		) {
			this.writePage(trackData, isFinalPacket);
		}
	}

	writePage(trackData: OggTrackData, isEos: boolean) {
		this.pageView.setUint32(0, OGGS, true); // Capture pattern
		this.pageView.setUint8(4, 0); // Version

		let headerType = 0;
		if (!trackData.currentPageStartsWithFreshPacket) {
			headerType |= 1;
		}
		if (trackData.pagesWritten === 0) {
			headerType |= 2; // Beginning of stream
		}
		if (isEos) {
			headerType |= 4; // End of stream
		}
		this.pageView.setUint8(5, headerType); // Header type

		const granulePosition = trackData.currentLacingValues.every(x => x === 255)
			? -1 // No packets end on this page
			: trackData.currentGranulePosition;
		setInt64(this.pageView, 6, granulePosition, true); // Granule position

		this.pageView.setUint32(14, trackData.serialNumber, true); // Serial number
		this.pageView.setUint32(18, trackData.pagesWritten, true); // Page sequence number
		this.pageView.setUint32(22, 0, true); // Checksum placeholder

		this.pageView.setUint8(26, trackData.currentLacingValues.length); // Number of page segments
		this.pageBytes.set(trackData.currentLacingValues, 27);

		let pos = 27 + trackData.currentLacingValues.length;
		for (const data of trackData.currentPageData) {
			this.pageBytes.set(data, pos);
			pos += data.length;
		}

		const slice = this.pageBytes.subarray(0, pos);

		const crc = computeOggPageCrc(slice);
		this.pageView.setUint32(22, crc, true); // Checksum

		trackData.pagesWritten++;
		trackData.currentLacingValues.length = 0;
		trackData.currentPageData.length = 0;
		trackData.currentPageSize = 27;
		trackData.currentPageStartsWithFreshPacket = true;
		trackData.currentPageStartTimestampInSamples = trackData.currentGranulePosition;

		if (this.format._options.onPage) {
			this.writer.startTrackingWrites();
		}

		this.writer.write(slice);

		if (this.format._options.onPage) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onPage(data, start, trackData.track.source);
		}
	}

	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		try {
			this.closedTracks.add(track);

			const trackData = this.trackDatas.find(x => x.track === track);
			if (trackData) {
				if (trackData.leadingPackets.length > 0) {
					// No packet ever ended at or after zero, so none of them can be represented
					trackData.leadingPackets.length = 0;
					this.warnAboutDiscardedPackets();
				}
			}

			if (this.allTracksAreKnown()) {
				this.allTracksKnown.resolve();
			}

			// Since a track is now closed, we may be able to write out chunks that were previously waiting
			await this.interleavePages();
		} finally {
			release();
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		for (const trackData of this.trackDatas) {
			this.closedTracks.add(trackData.track);

			if (trackData.leadingPackets.length > 0) {
				// No packet ever ended at or after zero, so none of them can be represented
				trackData.leadingPackets.length = 0;
				this.warnAboutDiscardedPackets();
			}
		}

		await this.interleavePages(true);

		release();
	}

	private warnAboutDiscardedPackets() {
		if (!this.warnedAboutTooNegativeTimestamp) {
			Logging._warn('Packets had to be discarded because their timestamp is too negative to represent in Ogg.');
			this.warnedAboutTooNegativeTimestamp = true;
		}
	}
}
