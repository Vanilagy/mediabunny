/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { parsePcmCodec, PcmAudioCodec, validateAudioChunkMetadata } from '../codec';
import { AiffWriter } from './aiff-writer';
import { Writer } from '../writer';
import { EncodedPacket } from '../packet';
import { AiffOutputFormat } from '../output-format';
import { assert } from '../misc';

// The AIFF-C version timestamp written into the FVER chunk (the standard, fixed "AIFF-C version 1" value).
const AIFC_VERSION_1 = 0xa2805140;

/** Maps a PCM codec to its AIFF-C compression type + name. Returns null for plain (uncompressed) AIFF. */
const getAifcCompression = (codec: PcmAudioCodec): { type: string; name: string } | null => {
	switch (codec) {
		case 'pcm-f32be': {
			return { type: 'fl32', name: 'Float 32' };
		}
		case 'pcm-f64be': {
			return { type: 'fl64', name: 'Float 64' };
		}
		case 'ulaw': {
			return { type: 'ulaw', name: 'µLaw 2:1' };
		}
		case 'alaw': {
			return { type: 'alaw', name: 'ALaw 2:1' };
		}
		default: {
			// Uncompressed big-endian signed PCM is plain AIFF.
			return null;
		}
	}
};

export class AiffMuxer extends Muxer {
	private format: AiffOutputFormat;
	private writer!: Writer;
	private aiffWriter!: AiffWriter;
	private headerWritten = false;
	private dataSize = 0;
	private blockAlign = 1;

	private formSizePos: number | null = null;
	private commFramesPos: number | null = null;
	private ssndSizePos: number | null = null;

	constructor(output: Output, format: AiffOutputFormat) {
		super(output);
		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();

		this.writer = await this.output._getRootWriter(false);
		this.aiffWriter = new AiffWriter(this.writer);

		// The header is written together with the first sample, once the decoder config is known.

		release();
	}

	async getMimeType() {
		return 'audio/aiff';
	}

	async addEncodedVideoPacket() {
		throw new Error('AIFF does not support video.');
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			if (!this.headerWritten) {
				validateAudioChunkMetadata(meta);

				assert(meta);
				assert(meta.decoderConfig);

				this.writeHeader(track, meta.decoderConfig);
				this.headerWritten = true;
			}

			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');

			if (this.writer.getPos() + packet.data.byteLength >= 2 ** 32) {
				throw new Error('Adding more audio data would exceed the maximum AIFF size of 4 GiB.');
			}

			this.writer.write(packet.data);
			this.dataSize += packet.data.byteLength;

			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addSubtitleCue() {
		throw new Error('AIFF does not support subtitles.');
	}

	private writeHeader(track: OutputAudioTrack, config: AudioDecoderConfig) {
		if (this.format._options.onHeader) {
			this.writer.startTrackingWrites();
		}

		const codec = track.source._codec as PcmAudioCodec;
		const pcmInfo = parsePcmCodec(codec);
		const compression = getAifcCompression(codec);
		const isAifc = compression !== null;

		const channels = config.numberOfChannels;
		const sampleRate = config.sampleRate;
		this.blockAlign = pcmInfo.sampleSize * channels;

		// COMM chunk: numChannels (2) + numSampleFrames (4) + sampleSize (2) + sampleRate (10), plus the compression
		// type (4) and a padded pascal-string name for AIFF-C.
		let commSize = 18;
		let compressionNameBytes: Uint8Array | null = null;
		if (compression) {
			const raw = new TextEncoder().encode(compression.name);
			// Pascal string: 1 length byte + characters, padded to an even total length.
			const padded = (1 + raw.length) % 2 === 0 ? 1 + raw.length : 1 + raw.length + 1;
			compressionNameBytes = new Uint8Array(padded);
			compressionNameBytes[0] = raw.length;
			compressionNameBytes.set(raw, 1);
			commSize += 4 + padded;
		}

		// FORM header
		this.aiffWriter.writeAscii('FORM');
		this.formSizePos = this.writer.getPos();
		this.aiffWriter.writeU32(0); // File size placeholder
		this.aiffWriter.writeAscii(isAifc ? 'AIFC' : 'AIFF');

		// FVER chunk (required by AIFF-C)
		if (isAifc) {
			this.aiffWriter.writeAscii('FVER');
			this.aiffWriter.writeU32(4);
			this.aiffWriter.writeU32(AIFC_VERSION_1);
		}

		// COMM chunk
		this.aiffWriter.writeAscii('COMM');
		this.aiffWriter.writeU32(commSize);
		this.aiffWriter.writeU16(channels);
		this.commFramesPos = this.writer.getPos();
		this.aiffWriter.writeU32(0); // numSampleFrames placeholder
		this.aiffWriter.writeU16(8 * pcmInfo.sampleSize);
		this.aiffWriter.writeExtendedFloat80(sampleRate);
		if (compression && compressionNameBytes) {
			this.aiffWriter.writeAscii(compression.type);
			this.writer.write(compressionNameBytes);
		}

		// SSND chunk header (sample data is appended after this)
		this.aiffWriter.writeAscii('SSND');
		this.ssndSizePos = this.writer.getPos();
		this.aiffWriter.writeU32(0); // Chunk size placeholder
		this.aiffWriter.writeU32(0); // offset
		this.aiffWriter.writeU32(0); // blockSize

		if (this.format._options.onHeader) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onHeader(data, start);
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		const endPos = this.writer.getPos();

		// Backfill FORM size (everything after the 8-byte FORM + size header).
		assert(this.formSizePos !== null);
		this.writer.seek(this.formSizePos);
		this.aiffWriter.writeU32(endPos - 8);

		// Backfill the SSND chunk size: 8 bytes (offset + blockSize) plus the sample data.
		assert(this.ssndSizePos !== null);
		this.writer.seek(this.ssndSizePos);
		this.aiffWriter.writeU32(8 + this.dataSize);

		// Backfill numSampleFrames in the COMM chunk.
		assert(this.commFramesPos !== null);
		this.writer.seek(this.commFramesPos);
		this.aiffWriter.writeU32(Math.floor(this.dataSize / this.blockAlign));

		this.writer.seek(endPos);

		release();
	}
}
