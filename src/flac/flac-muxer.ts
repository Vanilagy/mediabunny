/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, Bitstream, toDataView, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { FlacOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { FileSlice, readBytes } from '../reader';
import { MetadataTags, metadataTagsAreEmpty } from '../tags';
import { Writer } from '../writer';
import {
	readBlockSize,
	getBlockSizeOrUncommon,
	readCodedNumber,
	toU32Le,
} from './flac-misc';

const FLAC_HEADER = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const STREAMINFO_SIZE = 38;
const STREAMINFO_BLOCK_SIZE = 34;

export class FlacMuxer extends Muxer {
	private writer: Writer;
	private metadataWritten = false;

	private blockSizes: number[] = [];
	private frameSizes: number[] = [];

	private sampleRate: number | null = null;
	private channels: number | null = null;
	private bitsPerSample: number | null = null;

	private format: FlacOutputFormat;

	constructor(output: Output, format: FlacOutputFormat) {
		super(output);

		this.writer = output._writer;
		this.format = format;
	}

	async start() {
		this.writer.write(FLAC_HEADER);
	}

	async writeHeader(
		minimumBlockSize: number,
		maximumBlockSize: number,
		minimumFrameSize: number,
		maximumFrameSize: number,
		sampleRate: number,
		channels: number,
		bitsPerSample: number,
		totalSamples: number,
	) {
		this.writer.seek(FLAC_HEADER.byteLength);
		const hasMetadata = !metadataTagsAreEmpty(this.output._metadataTags);
		const headerBitstream = new Bitstream(new Uint8Array(4));
		headerBitstream.writeBits(1, Number(!hasMetadata)); // isLastMetadata
		headerBitstream.writeBits(7, 0); // metaBlockType = streaminfo
		headerBitstream.writeBits(24, STREAMINFO_BLOCK_SIZE); // size
		this.writer.write(headerBitstream.bytes);
		const contentBitstream = new Bitstream(new Uint8Array(18));

		contentBitstream.writeBits(16, minimumBlockSize);
		contentBitstream.writeBits(16, maximumBlockSize);
		contentBitstream.writeBits(24, minimumFrameSize);
		contentBitstream.writeBits(24, maximumFrameSize);
		contentBitstream.writeBits(20, sampleRate);
		contentBitstream.writeBits(3, channels - 1);
		contentBitstream.writeBits(5, bitsPerSample - 1);
		// Bitstream operations are only safe until 32bit, breaks when using 36 bits
		// Splitting up into writing 4 0 bits and then 32 bits is safe
		// This is safe for audio up to (2 ** 32 / 44100 / 3600) -> 27 hours
		// Not implementing support for more than 32 bits now
		contentBitstream.writeBits(4, 0);
		contentBitstream.writeBits(32, totalSamples);
		this.writer.write(contentBitstream.bytes);
		// The MD5 hash is calculated from decoded audio data, but we do not have access
		// to it here. We are allowed to set 0:
		// "A value of 0 signifies that the value is not known."
		// https://www.rfc-editor.org/rfc/rfc9639.html#name-streaminfo
		this.writer.write(
			new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		);
	}

	async writeVorbisCommentBlock() {
		this.writer.seek(STREAMINFO_SIZE + FLAC_HEADER.byteLength);
		if (metadataTagsAreEmpty(this.output._metadataTags)) {
			this.metadataWritten = true;
			return;
		}

		const vendorString = 'Mediabunny';
		const vendorStringLength = vendorString.length;
		const vendorStringLengthBuffer = toU32Le(vendorStringLength);
		const vendorStringBuffer = new TextEncoder().encode(vendorString);

		const metadataTags: Uint8Array[] = [];

		let entries = 0;

		const keys = new Set<string>();
		for (const key of Object.keys(this.output._metadataTags)) {
			if (key === 'raw') {
				continue;
			}

			keys.add(key);
		}
		for (const key of Object.keys(this.output._metadataTags.raw ?? {})) {
			keys.add(key);
		}

		for (const key of keys) {
			const value = this.output._metadataTags[key as keyof MetadataTags];
			if (key === 'raw') {
				continue;
			}

			const preferRaw = this.output._metadataTags.raw?.[key] ?? value;
			const stringifiedValue = preferRaw instanceof Date ? preferRaw.toISOString().slice(0, 10) : preferRaw;
			if (typeof stringifiedValue !== 'string' && typeof stringifiedValue !== 'number') {
				continue;
			}

			const text = `${key.toUpperCase()}=${stringifiedValue}`;
			const encoded = new TextEncoder().encode(text);
			metadataTags.push(toU32Le(encoded.length));
			metadataTags.push(encoded);
			entries++;
		}

		const listLengthBuffer = toU32Le(entries);

		const content: Uint8Array[] = [
			vendorStringLengthBuffer,
			vendorStringBuffer,
			listLengthBuffer,
			...metadataTags,
		];

		let length = 0;
		for (const item of content) {
			length += item.length;
		}
		const headerBitstream = new Bitstream(new Uint8Array(4));
		headerBitstream.writeBits(1, 1); // Last metadata block -> true
		headerBitstream.writeBits(7, 4); // Type -> Vorbis comment
		headerBitstream.writeBits(24, length);
		this.writer.write(headerBitstream.bytes);
		for (const item of content) {
			this.writer.write(item);
		}

		this.metadataWritten = true;
	}

	async getMimeType() {
		return 'audio/flac';
	}

	async addEncodedVideoPacket() {
		throw new Error('FLAC does not support video.');
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Promise<void> {
		const release = await this.mutex.acquire();

		try {
			assert(meta);
			assert(meta.decoderConfig);
			assert(meta.decoderConfig.description);

			if (!this.sampleRate) {
				this.sampleRate = meta.decoderConfig.sampleRate;
			}

			if (!this.channels) {
				this.channels = meta.decoderConfig.numberOfChannels;
			}

			if (!this.bitsPerSample) {
				const descriptionBitstream = new Bitstream(toUint8Array(meta.decoderConfig.description));
				descriptionBitstream.skipBits(103);
				const bitsPerSample = descriptionBitstream.readBits(5) + 1;
				this.bitsPerSample = bitsPerSample;
			}

			if (!this.metadataWritten) {
				await this.writeVorbisCommentBlock();
			}

			const slice = new FileSlice(
				packet.data,
				toDataView(packet.data),
				0,
				0,
				packet.data.byteLength,
			);
			readBytes(slice, 2);
			const bytes = readBytes(slice, 2);
			const bitstream = new Bitstream(bytes);
			const blockSizeOrUncommon = getBlockSizeOrUncommon(bitstream.readBits(4));
			readCodedNumber(slice); // num
			const blockSize = readBlockSize(slice, blockSizeOrUncommon);

			this.blockSizes.push(blockSize);
			this.frameSizes.push(packet.data.length);

			this.writer.write(packet.data);
		} finally {
			release();
		}
	}

	override addSubtitleCue(): Promise<void> {
		throw new Error('FLAC does not support subtitles.');
	}

	async finalize(): Promise<void> {
		const release = await this.mutex.acquire();

		let minimumBlockSize = Infinity;
		let maximumBlockSize = 0;
		let minimumFrameSize = Infinity;
		let maximumFrameSize = 0;
		let totalSamples = 0;
		for (let i = 0; i < this.blockSizes.length; i++) {
			minimumFrameSize = Math.min(minimumFrameSize, this.frameSizes[i]!);
			maximumFrameSize = Math.max(maximumFrameSize, this.frameSizes[i]!);
			maximumBlockSize = Math.max(maximumBlockSize, this.blockSizes[i]!);
			totalSamples += this.blockSizes[i]!;

			// Excluding the last frame from block size calculation
			// https://www.rfc-editor.org/rfc/rfc9639.html#name-streaminfo
			// "The minimum block size (in samples) used in the stream, excluding the last block."
			const isLastFrame = i === this.blockSizes.length - 1;
			if (isLastFrame) {
				continue;
			}
			minimumBlockSize = Math.min(minimumBlockSize, this.blockSizes[i]!);
		}

		assert(this.sampleRate);
		assert(this.channels);
		assert(this.bitsPerSample);

		await this.writeHeader(
			minimumBlockSize,
			maximumBlockSize,
			minimumFrameSize,
			maximumFrameSize,
			this.sampleRate,
			this.channels,
			this.bitsPerSample,
			totalSamples,
		);

		release();
	}
}
