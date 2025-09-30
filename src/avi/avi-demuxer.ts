/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { EncodedPacket } from '../packet';
import { Input } from '../input';
import {
	InputAudioTrack,
	InputVideoTrack,
	InputTrack,
	InputVideoTrackBacking,
	InputAudioTrackBacking,
	InputTrackBacking,
} from '../input-track';
import { MetadataTags } from '../tags';
import { PacketRetrievalOptions } from '../media-sink';
import { VideoCodec, AudioCodec, MediaCodec } from '../codec';
import { Reader, readBytes, readU32Le } from '../reader';
import { textDecoder, Rotation, binarySearchLessOrEqual, binarySearchExact } from '../misc';
import {
	AVIMainHeader, AVIStreamHeader, AVIBitmapInfoHeader, AVIWaveFormatEx, AVIIndexEntry,
	parseMainHeader, parseStreamHeader, parseBitmapInfoHeader, parseWaveFormatEx, parseIndexEntry,
	aviVideoFourccToCodec, aviAudioFormatTagToCodec, parseStreamChunkId, AVIIF_KEYFRAME,
} from './avi-misc';

interface StreamInfo {
	header: AVIStreamHeader;
	format: AVIBitmapInfoHeader | AVIWaveFormatEx;
	track?: AviVideoTrackBacking | AviAudioTrackBacking;
	packets: PacketInfo[];
	presentationTimestamps: {
		timestamp: number;
		packetIndex: number;
	}[];
	keyPacketIndices: number[];
	index: number;
}

interface PacketInfo {
	entry: AVIIndexEntry;
	timestamp: number;
	duration: number;
}

interface ChunkInfo {
	fourcc: string;
	size: number;
	position: number;
}

// Base class following Matroska pattern
abstract class AviTrackBacking implements InputTrackBacking {
	packetToIndex = new WeakMap<EncodedPacket, number>();

	constructor(
		protected demuxer: AVIDemuxer,
		protected streamInfo: StreamInfo,
	) {}

	getId(): number {
		return this.streamInfo.index;
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId(): string | null {
		if (this.streamInfo.header.fccType === 'vids') {
			const format = this.streamInfo.format as AVIBitmapInfoHeader;
			return format.compression;
		} else if (this.streamInfo.header.fccType === 'auds') {
			const format = this.streamInfo.format as AVIWaveFormatEx;
			return format.formatTag.toString();
		}
		return null;
	}

	getName(): string | null {
		return null;
	}

	getLanguageCode(): string {
		return 'eng';
	}

	getTimeResolution(): number {
		if (this.streamInfo.header.rate > 0) {
			return this.streamInfo.header.rate / this.streamInfo.header.scale;
		}
		return 1000000;
	}

	async getFirstTimestamp(): Promise<number> {
		if (this.streamInfo.packets.length === 0) return 0;

		// Return first keyframe timestamp plus one frame duration
		// This ensures proper decoding from the keyframe
		if (this.streamInfo.keyPacketIndices.length > 0) {
			const firstKeyIndex = this.streamInfo.keyPacketIndices[0]!;
			const firstKeyPacket = this.streamInfo.packets[firstKeyIndex]!;
			return firstKeyPacket.timestamp + firstKeyPacket.duration;
		}

		// Fallback to first packet if no keyframes (shouldn't happen in valid video)
		return this.streamInfo.packets[0]!.timestamp;
	}

	async computeDuration(): Promise<number> {
		const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		// Return the first keyframe to ensure decodable start
		if (this.streamInfo.keyPacketIndices.length === 0) return null;

		const firstKeyIndex = this.streamInfo.keyPacketIndices[0]!;
		const packetInfo = this.streamInfo.packets[firstKeyIndex]!;

		if (options.metadataOnly) {
			const packet = new EncodedPacket(
				new Uint8Array(),
				'key',
				packetInfo.timestamp,
				packetInfo.duration,
				firstKeyIndex,
				packetInfo.entry.size,
			);
			this.packetToIndex.set(packet, firstKeyIndex);
			return packet;
		}

		const packet = await this.demuxer.readPacket(packetInfo.entry, packetInfo.timestamp, packetInfo.duration, firstKeyIndex);
		if (packet) {
			this.packetToIndex.set(packet, firstKeyIndex);
		}
		return packet;
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (this.streamInfo.presentationTimestamps.length === 0) {
			return null;
		}

		// Binary search for the closest packet
		const index = binarySearchLessOrEqual(
			this.streamInfo.presentationTimestamps,
			timestamp,
			x => x.timestamp,
		);

		if (index === -1) {
			// All timestamps are greater than requested, return the first packet
			const entry = this.streamInfo.presentationTimestamps[0]!;
			const packetIndex = entry.packetIndex;
			const packetInfo = this.streamInfo.packets[packetIndex]!;

			if (options.metadataOnly) {
				const packet = new EncodedPacket(
					new Uint8Array(),
					(packetInfo.entry.flags & AVIIF_KEYFRAME) ? 'key' : 'delta',
					packetInfo.timestamp,
					packetInfo.duration,
					packetIndex,
					packetInfo.entry.size,
				);
				this.packetToIndex.set(packet, packetIndex);
				return packet;
			}

			const packet = await this.demuxer.readPacket(packetInfo.entry, packetInfo.timestamp, packetInfo.duration, packetIndex);
			if (packet) {
				this.packetToIndex.set(packet, packetIndex);
			}
			return packet;
		}

		const entry = this.streamInfo.presentationTimestamps[index]!;
		let packetIndex = entry.packetIndex;
		let packetInfo = this.streamInfo.packets[packetIndex]!;

		// Adjust to next packet if timestamp is past halfway through current packet
		if (timestamp > packetInfo.timestamp && index + 1 < this.streamInfo.presentationTimestamps.length) {
			const nextEntry = this.streamInfo.presentationTimestamps[index + 1]!;
			const nextPacketInfo = this.streamInfo.packets[nextEntry.packetIndex]!;

			if (timestamp > packetInfo.timestamp + packetInfo.duration * 0.5) {
				packetIndex = nextEntry.packetIndex;
				packetInfo = nextPacketInfo;
			}
		}

		if (options.metadataOnly) {
			const packet = new EncodedPacket(
				new Uint8Array(),
				(packetInfo.entry.flags & AVIIF_KEYFRAME) ? 'key' : 'delta',
				packetInfo.timestamp,
				packetInfo.duration,
				packetIndex,
				packetInfo.entry.size,
			);
			this.packetToIndex.set(packet, packetIndex);
			return packet;
		}

		const packet = await this.demuxer.readPacket(packetInfo.entry, packetInfo.timestamp, packetInfo.duration, packetIndex);
		if (packet) {
			this.packetToIndex.set(packet, packetIndex);
		}
		return packet;
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const index = this.packetToIndex.get(packet);
		if (index === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		const nextIndex = index + 1;
		if (nextIndex >= this.streamInfo.packets.length) return null;

		const packetInfo = this.streamInfo.packets[nextIndex]!;
		if (options.metadataOnly) {
			const newPacket = new EncodedPacket(
				new Uint8Array(),
				(packetInfo.entry.flags & AVIIF_KEYFRAME) ? 'key' : 'delta',
				packetInfo.timestamp,
				packetInfo.duration,
				nextIndex,
				packetInfo.entry.size,
			);
			this.packetToIndex.set(newPacket, nextIndex);
			return newPacket;
		}

		const newPacket = await this.demuxer.readPacket(packetInfo.entry, packetInfo.timestamp, packetInfo.duration, nextIndex);
		if (newPacket) {
			this.packetToIndex.set(newPacket, nextIndex);
		}
		return newPacket;
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (this.streamInfo.keyPacketIndices.length === 0) return null;

		let bestKeyIndex = -1;

		// Use binary search on keyPacketIndices
		let left = 0;
		let right = this.streamInfo.keyPacketIndices.length - 1;

		while (left <= right) {
			const mid = Math.floor((left + right) / 2);
			const packetIndex = this.streamInfo.keyPacketIndices[mid]!;
			const packetInfo = this.streamInfo.packets[packetIndex]!;

			if (packetInfo.timestamp <= timestamp) {
				bestKeyIndex = packetIndex;
				left = mid + 1; // Look for a closer keyframe
			} else {
				right = mid - 1;
			}
		}

		// If no keyframe before timestamp, use the first keyframe
		if (bestKeyIndex === -1 && this.streamInfo.keyPacketIndices.length > 0) {
			bestKeyIndex = this.streamInfo.keyPacketIndices[0]!;
		}

		if (bestKeyIndex === -1) return null;

		const packetInfo = this.streamInfo.packets[bestKeyIndex]!;

		if (options.metadataOnly) {
			const packet = new EncodedPacket(
				new Uint8Array(),
				'key',
				packetInfo.timestamp,
				packetInfo.duration,
				bestKeyIndex,
				packetInfo.entry.size,
			);
			this.packetToIndex.set(packet, bestKeyIndex);
			return packet;
		}

		const packet = await this.demuxer.readPacket(packetInfo.entry, packetInfo.timestamp, packetInfo.duration, bestKeyIndex);
		if (packet) {
			this.packetToIndex.set(packet, bestKeyIndex);
		}
		return packet;
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const index = this.packetToIndex.get(packet);
		if (index === undefined) {
			throw new Error('Packet was not created from this track.');
		}

		// Binary search for the next keyframe after current index
		const keyIndex = binarySearchExact(
			this.streamInfo.keyPacketIndices,
			index,
			x => x,
		);

		let nextKeyIndex = -1;
		if (keyIndex !== -1) {
			// Found the current packet in keyframes, get the next one
			if (keyIndex + 1 < this.streamInfo.keyPacketIndices.length) {
				nextKeyIndex = this.streamInfo.keyPacketIndices[keyIndex + 1]!;
			}
		} else {
			// Current packet is not a keyframe, find the first keyframe after it
			for (let i = 0; i < this.streamInfo.keyPacketIndices.length; i++) {
				const keyPacketIndex = this.streamInfo.keyPacketIndices[i]!;
				if (keyPacketIndex > index) {
					nextKeyIndex = keyPacketIndex;
					break;
				}
			}
		}

		if (nextKeyIndex === -1) return null;

		const packetInfo = this.streamInfo.packets[nextKeyIndex]!;
		if (options.metadataOnly) {
			const newPacket = new EncodedPacket(
				new Uint8Array(),
				'key',
				packetInfo.timestamp,
				packetInfo.duration,
				nextKeyIndex,
				packetInfo.entry.size,
			);
			this.packetToIndex.set(newPacket, nextKeyIndex);
			return newPacket;
		}

		const newPacket = await this.demuxer.readPacket(packetInfo.entry, packetInfo.timestamp, packetInfo.duration, nextKeyIndex);
		if (newPacket) {
			this.packetToIndex.set(newPacket, nextKeyIndex);
		}
		return newPacket;
	}
}

class AviVideoTrackBacking extends AviTrackBacking implements InputVideoTrackBacking {
	decoderConfigPromise: Promise<VideoDecoderConfig> | null = null;

	override getCodec(): VideoCodec | null {
		const format = this.streamInfo.format as AVIBitmapInfoHeader;
		let codec = aviVideoFourccToCodec(format.compression);
		if (!codec || format.compression.trim() === '') {
			codec = aviVideoFourccToCodec(this.streamInfo.header.fccHandler);
		}
		return codec;
	}

	getCodedWidth(): number {
		const format = this.streamInfo.format as AVIBitmapInfoHeader;
		return Math.abs(format.width);
	}

	getCodedHeight(): number {
		const format = this.streamInfo.format as AVIBitmapInfoHeader;
		return Math.abs(format.height);
	}

	getRotation(): Rotation {
		return 0;
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return {};
	}

	async canBeTransparent(): Promise<boolean> {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		const codec = this.getCodec();
		if (!codec) return null;

		return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
			return {
				codec: codec,
				codedWidth: this.getCodedWidth(),
				codedHeight: this.getCodedHeight(),
			};
		})();
	}
}

class AviAudioTrackBacking extends AviTrackBacking implements InputAudioTrackBacking {
	decoderConfig: AudioDecoderConfig | null = null;

	override getCodec(): AudioCodec | null {
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return aviAudioFormatTagToCodec(format.formatTag);
	}

	getNumberOfChannels(): number {
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return format.channels;
	}

	getSampleRate(): number {
		const format = this.streamInfo.format as AVIWaveFormatEx;
		return format.samplesPerSec;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		const codec = this.getCodec();
		if (!codec) return null;

		return this.decoderConfig ??= {
			codec: codec,
			numberOfChannels: this.getNumberOfChannels(),
			sampleRate: this.getSampleRate(),
		};
	}
}

export class AVIDemuxer extends Demuxer {
	private reader: Reader;
	private mainHeader: AVIMainHeader | null = null;
	private streams: StreamInfo[] = [];
	private index: AVIIndexEntry[] = [];
	private moviStart = 0;
	private moviSize = 0;
	private isRIFX = false;
	private inputTracks: InputTrack[] = [];
	private metadataPromise: Promise<void> | null = null;

	constructor(input: Input) {
		super(input);
		this.reader = input._reader;
	}

	static async _canReadInput(input: Input): Promise<boolean> {
		const reader = input._reader;
		const slice = await reader.requestSlice(0, 12);
		if (!slice || slice.remainingLength < 12) return false;

		const riffBytes = readBytes(slice, 4);
		if (!riffBytes) return false;
		const riffType = AVIDemuxer.fourcc(riffBytes);

		if (riffType !== 'RIFF' && riffType !== 'RIFX' && riffType !== 'RF64') {
			return false;
		}

		slice.skip(4); // Skip file size
		const typeBytes = readBytes(slice, 4);
		if (!typeBytes) return false;
		const fileType = AVIDemuxer.fourcc(typeBytes);

		return fileType === 'AVI ';
	}

	private static fourcc(bytes: Uint8Array | null): string {
		if (!bytes || bytes.length !== 4) return '    ';
		return textDecoder.decode(bytes);
	}

	async computeDuration(): Promise<number> {
		await this.ensureMetadata();
		if (this.mainHeader && this.mainHeader.microSecPerFrame > 0 && this.mainHeader.totalFrames > 0) {
			return (this.mainHeader.totalFrames * this.mainHeader.microSecPerFrame) / 1_000_000;
		}
		let maxDuration = 0;
		for (const track of this.inputTracks) {
			const duration = await track.computeDuration();
			if (duration > maxDuration) {
				maxDuration = duration;
			}
		}
		return maxDuration;
	}

	async getTracks(): Promise<InputTrack[]> {
		await this.ensureMetadata();
		return this.inputTracks;
	}

	async getMimeType(): Promise<string> {
		return 'video/x-msvideo';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	private async ensureMetadata(): Promise<void> {
		if (!this.metadataPromise) {
			this.metadataPromise = this.readMetadata();
		}
		await this.metadataPromise;
	}

	private async readMetadata(): Promise<void> {
		const slice = await this.reader.requestSlice(0, 12);
		if (!slice || slice.remainingLength < 12) {
			throw new Error('Invalid AVI file: insufficient header');
		}

		const magic = AVIDemuxer.fourcc(readBytes(slice, 4));
		const fileSize = readU32Le(slice);
		const fileType = AVIDemuxer.fourcc(readBytes(slice, 4));

		if (fileType !== 'AVI ') {
			throw new Error('Invalid AVI file type');
		}

		this.isRIFX = magic === 'RIFX';

		// Parse chunks
		await this.parseChunks();

		// Process index and create packet info
		this.processIndex();

		// Create tracks
		this.createTracks();
	}

	private async parseChunks(): Promise<void> {
		let position = 12;

		while (true) {
			const chunk = await this.readChunkHeader(position);
			if (!chunk) break;

			if (chunk.fourcc === 'LIST') {
				const listTypeSlice = await this.reader.requestSlice(position + 8, 4);
				if (!listTypeSlice) break;
				const listType = AVIDemuxer.fourcc(readBytes(listTypeSlice, 4));

				if (listType === 'hdrl') {
					await this.parseHeaderList(position + 12, chunk.size - 4);
				} else if (listType === 'movi') {
					this.moviStart = position + 8;
					this.moviSize = chunk.size - 4;
				}
				position += 8 + chunk.size;
			} else if (chunk.fourcc === 'idx1') {
				await this.parseIndex(position + 8, chunk.size);
				position += 8 + chunk.size;
			} else {
				position += 8 + chunk.size;
			}

			// Align to word boundary
			if (chunk.size % 2 !== 0) {
				position++;
			}
		}
	}

	private async readChunkHeader(position: number): Promise<ChunkInfo | null> {
		const slice = await this.reader.requestSlice(position, 8);
		if (!slice || slice.remainingLength < 8) return null;

		const chunkFourcc = AVIDemuxer.fourcc(readBytes(slice, 4));
		const chunkSize = this.isRIFX ? readU32Le(slice) : readU32Le(slice);

		return {
			fourcc: chunkFourcc,
			size: chunkSize,
			position: position + 8,
		};
	}

	private async parseHeaderList(position: number, size: number): Promise<void> {
		const endPos = position + size;
		let currentPos = position;

		while (currentPos < endPos) {
			const chunk = await this.readChunkHeader(currentPos);
			if (!chunk) break;

			if (chunk.fourcc === 'avih') {
				const slice = await this.reader.requestSlice(chunk.position, chunk.size);
				if (slice) {
					this.mainHeader = parseMainHeader(new DataView(slice.bytes.buffer, slice.bytes.byteOffset + slice.bufferPos, chunk.size));
				}
				currentPos = chunk.position + chunk.size;
			} else if (chunk.fourcc === 'LIST') {
				const listTypeSlice = await this.reader.requestSlice(chunk.position, 4);
				if (listTypeSlice) {
					const listType = AVIDemuxer.fourcc(readBytes(listTypeSlice, 4));
					if (listType === 'strl') {
						await this.parseStreamList(chunk.position + 4, chunk.size - 4);
					}
				}
				currentPos = chunk.position + chunk.size;
			} else {
				currentPos = chunk.position + chunk.size;
			}

			// Align to word boundary
			if (chunk.size % 2 !== 0) {
				currentPos++;
			}
		}
	}

	private async parseStreamList(position: number, size: number): Promise<void> {
		const endPos = position + size;
		let currentPos = position;
		const streamInfo: Partial<StreamInfo> & { packets: PacketInfo[]; presentationTimestamps: any[]; keyPacketIndices: number[]; index: number } = {
			packets: [],
			presentationTimestamps: [],
			keyPacketIndices: [],
			index: this.streams.length,
		};

		while (currentPos < endPos) {
			const chunk = await this.readChunkHeader(currentPos);
			if (!chunk) break;

			if (chunk.fourcc === 'strh') {
				const slice = await this.reader.requestSlice(chunk.position, chunk.size);
				if (slice) {
					streamInfo.header = parseStreamHeader(new DataView(slice.bytes.buffer, slice.bytes.byteOffset + slice.bufferPos, chunk.size));
				}
				currentPos = chunk.position + chunk.size;
			} else if (chunk.fourcc === 'strf') {
				const slice = await this.reader.requestSlice(chunk.position, chunk.size);
				if (slice && streamInfo.header) {
					const dataView = new DataView(slice.bytes.buffer, slice.bytes.byteOffset + slice.bufferPos, chunk.size);
					if (streamInfo.header.fccType === 'vids') {
						streamInfo.format = parseBitmapInfoHeader(dataView);
					} else if (streamInfo.header.fccType === 'auds') {
						streamInfo.format = parseWaveFormatEx(dataView);
					}
				}
				currentPos = chunk.position + chunk.size;
			} else {
				currentPos = chunk.position + chunk.size;
			}

			// Align to word boundary
			if (chunk.size % 2 !== 0) {
				currentPos++;
			}
		}

		if (streamInfo.header && streamInfo.format) {
			const completeStream: StreamInfo = {
				header: streamInfo.header,
				format: streamInfo.format,
				packets: streamInfo.packets,
				presentationTimestamps: streamInfo.presentationTimestamps,
				keyPacketIndices: streamInfo.keyPacketIndices,
				index: streamInfo.index,
			};
			this.streams.push(completeStream);
		}
	}

	private async parseIndex(position: number, size: number): Promise<void> {
		const slice = await this.reader.requestSlice(position, size);
		if (!slice) return;

		const dataView = new DataView(slice.bytes.buffer, slice.bytes.byteOffset + slice.bufferPos, size);
		const numEntries = Math.floor(size / 16);
		for (let i = 0; i < numEntries; i++) {
			const entry = parseIndexEntry(dataView, i * 16);
			this.index.push(entry);
		}
	}

	private processIndex(): void {
		// Group index entries by stream and calculate timestamps
		for (const entry of this.index) {
			const parsed = parseStreamChunkId(entry.ckid);
			if (!parsed) continue;

			const streamIndex = parsed.streamNumber;
			if (streamIndex >= this.streams.length) continue;

			const stream = this.streams[streamIndex]!;
			const packetIndex = stream.packets.length;
			const timestamp = this.calculateTimestamp(stream, packetIndex);

			const duration = this.calculatePacketDuration(stream, packetIndex);
			stream.packets.push({
				entry,
				timestamp,
				duration,
			});

			// Add to presentation timestamps array
			stream.presentationTimestamps.push({
				timestamp,
				packetIndex,
			});

			// Track keyframes
			if (entry.flags & AVIIF_KEYFRAME) {
				stream.keyPacketIndices.push(packetIndex);
			}
		}

		// Sort presentation timestamps by timestamp
		for (const stream of this.streams) {
			stream.presentationTimestamps.sort((a, b) => a.timestamp - b.timestamp);
		}
	}

	private createTracks(): void {
		for (const stream of this.streams) {
			const { header, format } = stream;

			if (header.fccType === 'vids' && 'compression' in format) {
				const bmpInfo = format;
				let codec = aviVideoFourccToCodec(bmpInfo.compression);
				if (!codec || bmpInfo.compression.trim() === '') {
					codec = aviVideoFourccToCodec(header.fccHandler);
				}

				if (codec) {
					const backing = new AviVideoTrackBacking(this, stream);
					stream.track = backing;
					const track = new InputVideoTrack(this.input, backing);
					this.inputTracks.push(track);
				}
			} else if (header.fccType === 'auds' && 'formatTag' in format) {
				const waveFormat = format;
				const codec = aviAudioFormatTagToCodec(waveFormat.formatTag);

				if (codec) {
					const backing = new AviAudioTrackBacking(this, stream);
					stream.track = backing;
					const track = new InputAudioTrack(this.input, backing);
					this.inputTracks.push(track);
				}
			}
		}
	}

	async readPacket(entry: AVIIndexEntry, timestamp: number, duration: number = 0, sequenceNumber: number = -1): Promise<EncodedPacket | null> {
		const packetPos = this.moviStart + entry.offset + 8;
		const slice = await this.reader.requestSlice(packetPos, entry.size);
		if (!slice) return null;

		const data = readBytes(slice, entry.size);
		if (!data) return null;

		return new EncodedPacket(
			data,
			(entry.flags & AVIIF_KEYFRAME) ? 'key' : 'delta',
			timestamp,
			duration,
			sequenceNumber,
			data.byteLength,
		);
	}

	private calculateTimestamp(stream: StreamInfo, packetIndex: number): number {
		if (stream.header.fccType === 'vids' && stream.header.rate > 0 && stream.header.scale > 0) {
			return (packetIndex * stream.header.scale) / stream.header.rate;
		} else if (stream.header.fccType === 'auds') {
			const format = stream.format as AVIWaveFormatEx;
			if (stream.header.sampleSize === 0 || stream.header.sampleSize === 1) {
				const samplesPerFrame = 1152;
				return (packetIndex * samplesPerFrame) / format.samplesPerSec;
			}
			if (stream.header.rate > 0 && stream.header.scale > 0) {
				return (packetIndex * stream.header.scale) / stream.header.rate;
			}
		}
		return 0;
	}

	private calculatePacketDuration(stream: StreamInfo, packetIndex: number): number {
		if (stream.header.fccType === 'vids' && stream.header.rate > 0 && stream.header.scale > 0) {
			// Video frame duration
			return stream.header.scale / stream.header.rate;
		} else if (stream.header.fccType === 'auds') {
			const format = stream.format as AVIWaveFormatEx;
			if (stream.header.sampleSize === 0 || stream.header.sampleSize === 1) {
				// Compressed audio (e.g., MP3)
				const samplesPerFrame = 1152;
				return samplesPerFrame / format.samplesPerSec;
			}
			if (stream.header.rate > 0 && stream.header.scale > 0) {
				// Uncompressed audio
				return stream.header.scale / stream.header.rate;
			}
		}
		return 0;
	}
}
