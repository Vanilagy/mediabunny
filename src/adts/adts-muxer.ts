/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseAacAudioSpecificConfig, validateAudioChunkMetadata } from '../codec';
import { Id3V2Writer } from '../id3';
import { metadataTagsAreEmpty } from '../metadata';
import { assert, Bitstream, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { AdtsOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import { buildAdtsHeaderTemplate, writeAdtsFrameLength } from './adts-misc';

export class AdtsMuxer extends Muxer {
	private format: AdtsOutputFormat;
	private writer: Writer;
	private header: Uint8Array | null = null;
	private headerBitstream: Bitstream | null = null;
	private inputIsAdts: boolean | null = null;

	constructor(output: Output, format: AdtsOutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;
	}

	async start() {
		if (!metadataTagsAreEmpty(this.output._metadataTags)) {
			const id3Writer = new Id3V2Writer(this.writer);
			id3Writer.writeId3V2Tag(this.output._metadataTags);
		}
	}

	async getMimeType() {
		return 'audio/aac';
	}

	async addEncodedVideoPacket() {
		throw new Error('ADTS does not support video.');
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === 'key');

			// First packet - determine input format from metadata
			if (this.inputIsAdts === null) {
				validateAudioChunkMetadata(meta);

				const description = meta?.decoderConfig?.description;

				// Follows from the Mediabunny Codec Registry:
				this.inputIsAdts = !description;

				if (!this.inputIsAdts) {
					const config = parseAacAudioSpecificConfig(toUint8Array(description!));
					const template = buildAdtsHeaderTemplate(config);
					this.header = template.header;
					this.headerBitstream = template.bitstream;
				}
			}

			if (this.inputIsAdts) {
				// Packets are already ADTS frames, write them directly
				const startPos = this.writer.getPos();
				this.writer.write(packet.data);

				if (this.format._options.onFrame) {
					this.format._options.onFrame(packet.data, startPos);
				}
			} else {
				assert(this.header);

				// Packets are raw AAC, we gotta turn it into ADTS
				const frameLength = packet.data.byteLength + this.header.byteLength;
				writeAdtsFrameLength(this.headerBitstream!, frameLength);

				const startPos = this.writer.getPos();
				this.writer.write(this.header);
				this.writer.write(packet.data);

				if (this.format._options.onFrame) {
					const frameBytes = new Uint8Array(frameLength);
					frameBytes.set(this.header, 0);
					frameBytes.set(packet.data, this.header.byteLength);

					this.format._options.onFrame(frameBytes, startPos);
				}
			}

			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addSubtitleCue() {
		throw new Error('ADTS does not support subtitles.');
	}

	async finalize() {}
}
