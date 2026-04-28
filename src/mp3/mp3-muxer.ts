/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { toDataView } from '../misc';
import { metadataTagsAreEmpty } from '../metadata';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { Mp3OutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import { getXingOffset, INFO, readMp3FrameHeader, XING } from '../../shared/mp3-misc';
import { Mp3Writer, XingFrameData } from './mp3-writer';
import { Id3V2Writer } from '../id3';

export class Mp3Muxer extends Muxer {
	private format: Mp3OutputFormat;
	private writer!: Writer;
	private mp3Writer!: Mp3Writer;
	private xingFrameData: XingFrameData | null = null;
	private frameCount = 0;
	private framePositions: number[] = [];
	private xingFramePos: number | null = null;

	constructor(output: Output, format: Mp3OutputFormat) {
		super(output);

		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		this.writer = await this.output._getRootWriter(this.format._options.xingHeader === false);
		this.mp3Writer = new Mp3Writer(this.writer);

		if (!metadataTagsAreEmpty(this.output._metadataTags)) {
			const id3Writer = new Id3V2Writer(this.writer);
			id3Writer.writeId3V2Tag(this.output._metadataTags);
		}

		release();
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
				const header = readMp3FrameHeader(word, null).header;
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
					sampleRate: header.sampleRate,
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

			if (writeXingHeader) {
				this.framePositions.push(this.writer.getPos());
			}

			this.writer.write(packet.data);
			this.frameCount++;

			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addSubtitleCue() {
		throw new Error('MP3 does not support subtitles.');
	}

	async finalize() {
		if (!this.xingFrameData || this.xingFramePos === null) {
			return;
		}

		const release = await this.mutex.acquire();

		const endPos = this.writer.getPos();
		const audioDataEndPos = endPos - this.xingFramePos;

		this.writer.seek(this.xingFramePos);

		const toc = new Uint8Array(100);
		for (let i = 0; i < 100; i++) {
			const index = Math.floor(this.framePositions.length * (i / 100));

			const byteOffset = this.framePositions[index]! - this.xingFramePos;
			toc[i] = 256 * (byteOffset / audioDataEndPos);
		}

		this.xingFrameData.frameCount = this.frameCount;
		this.xingFrameData.fileSize = audioDataEndPos;
		this.xingFrameData.toc = toc;

		if (this.format._options.onXingFrame) {
			this.writer.startTrackingWrites();
		}

		this.mp3Writer.writeXingFrame(this.xingFrameData);

		if (this.format._options.onXingFrame) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onXingFrame(data, start);
		}

		release();
	}
}
