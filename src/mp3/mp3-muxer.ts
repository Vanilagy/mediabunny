/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, toDataView } from '../misc';
import { mediaMetadataIsEmpty, MediaMetadata } from '../metadata';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { Mp3OutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import { getXingOffset, INFO, readFrameHeader, XING } from '../../shared/mp3-misc';
import { Mp3Writer, XingFrameData } from './mp3-writer';

export class Mp3Muxer extends Muxer {
	private format: Mp3OutputFormat;
	private writer: Writer;
	private mp3Writer: Mp3Writer;
	private xingFrameData: XingFrameData | null = null;
	private frameCount = 0;
	private framePositions: number[] = [];
	private xingFramePos: number | null = null;

	constructor(output: Output, format: Mp3OutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;
		this.mp3Writer = new Mp3Writer(output._writer);
	}

	async start() {
		if (!mediaMetadataIsEmpty(this.output._metadata)) {
			this.writeId3v2Tag(this.output._metadata);
		}
	}

	async getMimeType() {
		return 'audio/mpeg';
	}

	async addEncodedVideoPacket() {
		throw new Error('MP3 does not support video.');
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
	) {
		const release = await this.mutex.acquire();

		try {
			const writeXingHeader = this.format._options.xingHeader !== false;

			if (!this.xingFrameData && writeXingHeader) {
				const view = toDataView(packet.data);
				if (view.byteLength < 4) {
					throw new Error('Invalid MP3 header in sample.');
				}

				const word = view.getUint32(0, false);
				const header = readFrameHeader(word, { pos: 0, fileSize: null });
				if (!header) {
					throw new Error('Invalid MP3 header in sample.');
				}

				const xingOffset = getXingOffset(header.mpegVersionId, header.channel);
				if (view.byteLength >= xingOffset + 4) {
					const word = view.getUint32(xingOffset, false);
					const isXing = word === XING || word === INFO;

					if (isXing) {
						// This is not a data frame, so let's completely ignore this sample
						return;
					}
				}

				this.xingFrameData = {
					mpegVersionId: header.mpegVersionId,
					layer: header.layer,
					frequencyIndex: header.frequencyIndex,
					channel: header.channel,
					modeExtension: header.modeExtension,
					copyright: header.copyright,
					original: header.original,
					emphasis: header.emphasis,

					frameCount: null,
					fileSize: null,
					toc: null,
				};

				// Write a Xing frame because this muxer doesn't make any bitrate constraints, meaning we don't know if
				// this will be a constant or variable bitrate file. Therefore, always write the Xing frame.
				this.xingFramePos = this.writer.getPos();
				this.mp3Writer.writeXingFrame(this.xingFrameData);

				this.frameCount++;
			}

			this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === 'key');

			this.writer.write(packet.data);
			this.frameCount++;

			await this.writer.flush();

			if (writeXingHeader) {
				this.framePositions.push(this.writer.getPos());
			}
		} finally {
			release();
		}
	}

	async addSubtitleCue() {
		throw new Error('MP3 does not support subtitles.');
	}

	writeId3v2Tag(metadata: MediaMetadata) {
		this.mp3Writer.writeAscii('ID3');
		this.mp3Writer.writeU8(0x04); // Version 2.4
		this.mp3Writer.writeU8(0x00); // Revision 0
		this.mp3Writer.writeU8(0x00); // Flags
		this.mp3Writer.writeSynchsafeU32(0); // Size placeholder

		const startPos = this.writer.getPos();

		if (metadata.title) {
			this.mp3Writer.writeId3V2TextFrame('TIT2', metadata.title);
		}
		if (metadata.artist) {
			this.mp3Writer.writeId3V2TextFrame('TPE1', metadata.artist);
		}
		if (metadata.album) {
			this.mp3Writer.writeId3V2TextFrame('TALB', metadata.album);
		}
		if (metadata.albumArtist) {
			this.mp3Writer.writeId3V2TextFrame('TPE2', metadata.albumArtist);
		}
		if (metadata.trackNumber) {
			this.mp3Writer.writeId3V2TextFrame('TRCK', metadata.trackNumber.toString());
		}
		if (metadata.discNumber) {
			this.mp3Writer.writeId3V2TextFrame('TPOS', metadata.discNumber.toString());
		}
		if (metadata.genre) {
			this.mp3Writer.writeId3V2TextFrame('TCON', metadata.genre);
		}
		if (metadata.releasedAt) {
			this.mp3Writer.writeId3V2TextFrame('TDRC', metadata.releasedAt.toISOString().split('.')[0]!);
		}
		if (metadata.comment) {
			this.mp3Writer.writeId3V2CommentFrame(metadata.comment);
		}
		if (metadata.images) {
			const pictureTypeMap = { coverFront: 0x03, coverBack: 0x04, unknown: 0x00 };
			for (const image of metadata.images) {
				const pictureType = pictureTypeMap[image.kind];
				const description = image.description || '';
				this.mp3Writer.writeId3V2ApicFrame(image.mimeType, pictureType, description, image.data);
			}
		}

		const endPos = this.writer.getPos();
		const framesSize = endPos - startPos;

		this.writer.seek(6);
		this.mp3Writer.writeSynchsafeU32(framesSize);
		this.writer.seek(endPos);
	}

	async finalize() {
		if (!this.xingFrameData || this.xingFramePos === null) {
			return;
		}

		const release = await this.mutex.acquire();

		const endPos = this.writer.getPos();

		this.writer.seek(this.xingFramePos);

		const toc = new Uint8Array(100);
		for (let i = 0; i < 100; i++) {
			const index = Math.floor(this.framePositions.length * (i / 100));
			assert(index !== -1 && index < this.framePositions.length);

			const byteOffset = this.framePositions[index]!;
			toc[i] = 256 * (byteOffset / endPos);
		}

		this.xingFrameData.frameCount = this.frameCount;
		this.xingFrameData.fileSize = endPos;
		this.xingFrameData.toc = toc;

		if (this.format._options.onXingFrame) {
			this.writer.startTrackingWrites();
		}

		this.mp3Writer.writeXingFrame(this.xingFrameData);

		if (this.format._options.onXingFrame) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onXingFrame(data, start);
		}

		this.writer.seek(endPos);

		release();
	}
}
