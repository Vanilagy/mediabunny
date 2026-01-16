/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { validateAudioChunkMetadata } from '../codec';
import { createVorbisComments, FlacBlockType } from '../codec-data';
import {
	assert,
	Bitstream,
	textEncoder,
	toDataView,
	toUint8Array,
} from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { FlacOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { FileSlice, readBytes } from '../reader';
import { AttachedImage, metadataTagsAreEmpty } from '../metadata';
import { Writer } from '../writer';
import {
	readBlockSize,
	getBlockSizeOrUncommon,
	readCodedNumber,
} from './flac-misc';

const FLAC_HEADER = /* #__PURE__ */ new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // 'fLaC'
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

	writeHeader({
		bitsPerSample,
		minimumBlockSize,
		maximumBlockSize,
		minimumFrameSize,
		maximumFrameSize,
		sampleRate,
		channels,
		totalSamples,
	}: {
		minimumBlockSize: number;
		maximumBlockSize: number;
		minimumFrameSize: number;
		maximumFrameSize: number;
		sampleRate: number;
		channels: number;
		bitsPerSample: number;
		totalSamples: number;
	}) {
		assert(this.writer.getPos() === 4);

		const hasMetadata = !metadataTagsAreEmpty(this.output._metadataTags);
		const headerBitstream = new Bitstream(new Uint8Array(4));
		headerBitstream.writeBits(1, Number(!hasMetadata)); // isLastMetadata
		headerBitstream.writeBits(7, FlacBlockType.STREAMINFO); // metaBlockType = streaminfo
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
		if (totalSamples >= 2 ** 32) {
			throw new Error('This muxer only supports writing up to 2 ** 32 samples');
		}

		contentBitstream.writeBits(4, 0);
		contentBitstream.writeBits(32, totalSamples);
		this.writer.write(contentBitstream.bytes);
		// The MD5 hash is calculated from decoded audio data, but we do not have access
		// to it here. We are allowed to set 0:
		// "A value of 0 signifies that the value is not known."
		// https://www.rfc-editor.org/rfc/rfc9639.html#name-streaminfo
		this.writer.write(new Uint8Array(16));
	}

	writePictureBlock(picture: AttachedImage) {
		// Header size:
		// 4 bytes: picture type
		// 4 bytes: media type length
		// x bytes: media type
		// 4 bytes: description length
		// y bytes: description
		// 1 bytes: width
		// 1 bytes: height
		// 1 bytes: color depth
		// 1 bytes: number of indexed colors
		// 4 bytes: picture data length
		// z bytes: picture data
		// Total: 20 + x + y + z
		const headerSize
			= 32
				+ picture.mimeType.length
				+ (picture.description?.length ?? 0)
				+ picture.data.length;

		const header = new Uint8Array(headerSize);

		let offset = 0;
		const dataView = toDataView(header);
		dataView.setUint32(
			offset,
			picture.kind === 'coverFront' ? 3 : picture.kind === 'coverBack' ? 4 : 0,
		);
		offset += 4;
		dataView.setUint32(offset, picture.mimeType.length);
		offset += 4;
		header.set(textEncoder.encode(picture.mimeType), 8);
		offset += picture.mimeType.length;
		dataView.setUint32(offset, picture.description?.length ?? 0);
		offset += 4;
		header.set(textEncoder.encode(picture.description ?? ''), offset);
		offset += picture.description?.length ?? 0;
		offset += 4 + 4 + 4 + 4; // setting width, height, color depth, number of indexed colors to 0
		dataView.setUint32(offset, picture.data.length);
		offset += 4;
		header.set(picture.data, offset);
		offset += picture.data.length;
		assert(offset === headerSize);

		const headerBitstream = new Bitstream(new Uint8Array(4));
		headerBitstream.writeBits(1, 0); // Last metadata block -> false, will be continued by vorbis comment
		headerBitstream.writeBits(7, FlacBlockType.PICTURE); // Type -> Picture
		headerBitstream.writeBits(24, headerSize);
		this.writer.write(headerBitstream.bytes);
		this.writer.write(header);
	}

	writeVorbisCommentAndPictureBlock() {
		this.writer.seek(STREAMINFO_SIZE + FLAC_HEADER.byteLength);
		if (metadataTagsAreEmpty(this.output._metadataTags)) {
			this.metadataWritten = true;
			return;
		}

		const pictures = this.output._metadataTags.images ?? [];
		for (const picture of pictures) {
			this.writePictureBlock(picture);
		}

		const vorbisComment = createVorbisComments(
			new Uint8Array(0),
			this.output._metadataTags,
			false,
		);

		const headerBitstream = new Bitstream(new Uint8Array(4));
		headerBitstream.writeBits(1, 1); // Last metadata block -> true
		headerBitstream.writeBits(7, FlacBlockType.VORBIS_COMMENT); // Type -> Vorbis comment
		headerBitstream.writeBits(24, vorbisComment.length);
		this.writer.write(headerBitstream.bytes);
		this.writer.write(vorbisComment);

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

		validateAudioChunkMetadata(meta);

		assert(meta);
		assert(meta.decoderConfig);
		assert(meta.decoderConfig.description);

		try {
			this.validateAndNormalizeTimestamp(
				track,
				packet.timestamp,
				packet.type === 'key',
			);

			if (this.sampleRate === null) {
				this.sampleRate = meta.decoderConfig.sampleRate;
			}

			if (this.channels === null) {
				this.channels = meta.decoderConfig.numberOfChannels;
			}

			if (this.bitsPerSample === null) {
				const descriptionBitstream = new Bitstream(
					toUint8Array(meta.decoderConfig.description),
				);
				// skip 'fLaC' + block size + frame size + sample rate + number of channels
				// See demuxer for the exact structure
				descriptionBitstream.skipBits(103 + 64);
				const bitsPerSample = descriptionBitstream.readBits(5) + 1;
				this.bitsPerSample = bitsPerSample;
			}

			if (!this.metadataWritten) {
				this.writeVorbisCommentAndPictureBlock();
			}

			const slice = FileSlice.tempFromBytes(packet.data);
			readBytes(slice, 2);
			const bytes = readBytes(slice, 2);
			const bitstream = new Bitstream(bytes);
			const blockSizeOrUncommon = getBlockSizeOrUncommon(bitstream.readBits(4));
			if (blockSizeOrUncommon === null) {
				throw new Error('Invalid FLAC frame: Invalid block size.');
			}

			readCodedNumber(slice); // num
			const blockSize = readBlockSize(slice, blockSizeOrUncommon);

			this.blockSizes.push(blockSize);
			this.frameSizes.push(packet.data.length);

			const startPos = this.writer.getPos();
			this.writer.write(packet.data);

			if (this.format._options.onFrame) {
				this.format._options.onFrame(packet.data, startPos);
			}

			await this.writer.flush();
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

		assert(this.sampleRate !== null);
		assert(this.channels !== null);
		assert(this.bitsPerSample !== null);

		this.writer.seek(4);
		this.writeHeader({
			minimumBlockSize,
			maximumBlockSize,
			minimumFrameSize,
			maximumFrameSize,
			sampleRate: this.sampleRate,
			channels: this.channels,
			bitsPerSample: this.bitsPerSample,
			totalSamples,
		});

		release();
	}
}
