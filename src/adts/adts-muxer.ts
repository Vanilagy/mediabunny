/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AacAudioSpecificConfig, parseAacAudioSpecificConfig, validateAudioChunkMetadata } from '../codec';
import { assert, Bitstream, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { AdtsOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';

export class AdtsMuxer extends Muxer {
	private format: AdtsOutputFormat;
	private writer: Writer;
	private header = new Uint8Array(7);
	private headerBitstream = new Bitstream(this.header);
	private audioSpecificConfig: AacAudioSpecificConfig | null = null;

	constructor(output: Output, format: AdtsOutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;
	}

	async start() {
		// Nothing needed here
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
		// https://wiki.multimedia.cx/index.php/ADTS (last visited: 2025/08/17)

		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === 'key');

		if (!this.audioSpecificConfig) {
			validateAudioChunkMetadata(meta);

			const description = meta?.decoderConfig?.description;
			assert(description);

			this.audioSpecificConfig = parseAacAudioSpecificConfig(toUint8Array(description));

			const { objectType, frequencyIndex, channelConfiguration } = this.audioSpecificConfig;
			const profile = objectType - 1;

			this.headerBitstream.writeBits(12, 0b1111_11111111); // Syncword
			this.headerBitstream.writeBits(1, 0); // MPEG Version
			this.headerBitstream.writeBits(2, 0); // Layer
			this.headerBitstream.writeBits(1, 1); // Protection absence
			this.headerBitstream.writeBits(2, profile); // Profile
			this.headerBitstream.writeBits(4, frequencyIndex); // MPEG-4 Sampling Frequency Index
			this.headerBitstream.writeBits(1, 0); // Private bit
			this.headerBitstream.writeBits(3, channelConfiguration); // MPEG-4 Channel Configuration
			this.headerBitstream.writeBits(1, 0); // Originality
			this.headerBitstream.writeBits(1, 0); // Home
			this.headerBitstream.writeBits(1, 0); // Copyright ID bit
			this.headerBitstream.writeBits(1, 0); // Copyright ID start
			this.headerBitstream.skipBits(13); // Frame length
			this.headerBitstream.writeBits(11, 0x7ff); // Buffer fullness
			this.headerBitstream.writeBits(2, 0); // Number of AAC frames minus 1
			// Omit CRC check
		}

		const frameLength = packet.data.byteLength + this.header.byteLength;
		this.headerBitstream.pos = 30;
		this.headerBitstream.writeBits(13, frameLength);

		const startPos = this.writer.getPos();
		this.writer.write(this.header);
		this.writer.write(packet.data);

		if (this.format._options.onFrame) {
			const frameBytes = new Uint8Array(frameLength);
			frameBytes.set(this.header, 0);
			frameBytes.set(packet.data, this.header.byteLength);

			this.format._options.onFrame(frameBytes, startPos);
		}

		await this.writer.flush();
	}

	async addSubtitleCue() {
		throw new Error('ADTS does not support subtitles.');
	}

	async finalize() {}
}
