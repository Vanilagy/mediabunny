/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, toDataView } from '../misc';
import { metadataTagsAreEmpty } from '../metadata';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { Mp3OutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import { getXingOffset, INFO, readMp3FrameHeader, SAMPLING_RATES, XING } from '../../shared/mp3-misc';
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

			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');

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
		const release = await this.mutex.acquire();

		if (!this.xingFrameData && this.format._options.xingHeader === false) {
			// MP3 has no container-level header, so the Xing frame is the only thing we could have synthesized
			throw new Error(
				'Cannot finalize an empty MP3 file: not a single packet was added and the Xing header is disabled, so'
				+ ' there\'s no frame we could write.',
			);
		}

		if (!this.xingFrameData) {
			// Not a single packet came in, so let's write a lone Xing frame; that way, the file is still a valid
			// (if empty) MP3. We derive its header from whatever the track told us up front.
			const track = this.output.tracks[0];
			assert(track?.isAudioTrack());

			const primingPacket = track.metadata.primingPacket;
			if (primingPacket) {
				// The best case: an actual frame tells us exactly what the header should look like
				const view = toDataView(primingPacket.data);
				if (view.byteLength < 4) {
					throw new Error('Invalid MP3 header in priming packet.');
				}

				const word = view.getUint32(0, false);
				const header = readMp3FrameHeader(word, null).header;
				if (!header) {
					throw new Error('Invalid MP3 header in priming packet.');
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
			} else if (track.metadata.decoderConfig) {
				// All we know is the sample rate and channel count, so let's derive the rest
				const { sampleRate, numberOfChannels } = track.metadata.decoderConfig;

				// MPEG Version 1 uses the sampling rates directly, Version 2 halves them, and Version 2.5 quarters them
				const mpegVersionIds = [3, 2, 0];
				let mpegVersionId: number | null = null;
				let frequencyIndex = -1;

				for (let i = 0; i < mpegVersionIds.length; i++) {
					frequencyIndex = SAMPLING_RATES.indexOf(sampleRate << i);
					if (frequencyIndex !== -1) {
						mpegVersionId = mpegVersionIds[i]!;
						break;
					}
				}

				if (mpegVersionId === null) {
					throw new Error(`${sampleRate} Hz is not a valid MP3 sample rate.`);
				}

				this.xingFrameData = {
					mpegVersionId,
					layer: 1, // Layer III
					frequencyIndex,
					sampleRate,
					channel: numberOfChannels === 1 ? 3 : 0, // 3 = single channel, 0 = stereo
					modeExtension: 0,
					copyright: 0,
					original: 0,
					emphasis: 0,

					frameCount: null,
					fileSize: null,
					toc: null,
				};
			} else {
				throw new Error(
					'Cannot finalize an empty MP3 file: no packets were added and the track specified neither a'
					+ ' decoderConfig nor a primingPacket in its metadata, so there\'s no telling what the file'
					+ ' should look like.',
				);
			}

			this.xingFramePos = this.writer.getPos();
			this.mp3Writer.writeXingFrame(this.xingFrameData);

			this.frameCount++;
		}

		assert(this.xingFramePos !== null);

		const endPos = this.writer.getPos();
		const audioDataEndPos = endPos - this.xingFramePos;

		this.writer.seek(this.xingFramePos);

		if (this.framePositions.length > 0) {
			const toc = new Uint8Array(100);
			for (let i = 0; i < 100; i++) {
				const index = Math.floor(this.framePositions.length * (i / 100));

				const byteOffset = this.framePositions[index]! - this.xingFramePos;
				toc[i] = 256 * (byteOffset / audioDataEndPos);
			}

			this.xingFrameData.toc = toc;
		}

		this.xingFrameData.frameCount = this.frameCount;
		this.xingFrameData.fileSize = audioDataEndPos;

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
