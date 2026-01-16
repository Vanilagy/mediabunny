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
import { WaveFormat } from './wave-demuxer';
import { RiffWriter } from './riff-writer';
import { Writer } from '../writer';
import { EncodedPacket } from '../packet';
import { WavOutputFormat } from '../output-format';
import { assert, assertNever, isIso88591Compatible, keyValueIterator } from '../misc';
import { MetadataTags, metadataTagsAreEmpty } from '../metadata';
import { Id3V2Writer } from '../id3';

export class WaveMuxer extends Muxer {
	private format: WavOutputFormat;
	private isRf64: boolean;
	private writer: Writer;
	private riffWriter: RiffWriter;
	private headerWritten = false;
	private dataSize = 0;
	private sampleRate: number | null = null;
	private sampleCount = 0;

	private riffSizePos: number | null = null;
	private dataSizePos: number | null = null;
	private ds64RiffSizePos: number | null = null;
	private ds64DataSizePos: number | null = null;
	private ds64SampleCountPos: number | null = null;

	constructor(output: Output, format: WavOutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;
		this.riffWriter = new RiffWriter(output._writer);
		this.isRf64 = !!format._options.large;
	}

	async start() {
		// Nothing needed here - we'll write the header with the first sample
	}

	async getMimeType() {
		return 'audio/wav';
	}

	async addEncodedVideoPacket() {
		throw new Error('WAVE does not support video.');
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
				this.sampleRate = meta.decoderConfig.sampleRate;
				this.headerWritten = true;
			}

			this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === 'key');

			if (!this.isRf64 && this.writer.getPos() + packet.data.byteLength >= 2 ** 32) {
				throw new Error(
					'Adding more audio data would exceed the maximum RIFF size of 4 GiB. To write larger files, use'
					+ ' RF64 by setting `large: true` in the WavOutputFormatOptions.',
				);
			}

			this.writer.write(packet.data);
			this.dataSize += packet.data.byteLength;
			this.sampleCount += Math.round(packet.duration * this.sampleRate!);

			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addSubtitleCue() {
		throw new Error('WAVE does not support subtitles.');
	}

	private writeHeader(track: OutputAudioTrack, config: AudioDecoderConfig) {
		if (this.format._options.onHeader) {
			this.writer.startTrackingWrites();
		}

		let format: WaveFormat;

		const codec = track.source._codec;
		const pcmInfo = parsePcmCodec(codec as PcmAudioCodec);

		if (pcmInfo.dataType === 'ulaw') {
			format = WaveFormat.MULAW;
		} else if (pcmInfo.dataType === 'alaw') {
			format = WaveFormat.ALAW;
		} else if (pcmInfo.dataType === 'float') {
			format = WaveFormat.IEEE_FLOAT;
		} else {
			format = WaveFormat.PCM;
		}

		const channels = config.numberOfChannels;
		const sampleRate = config.sampleRate;
		const blockSize = pcmInfo.sampleSize * channels;

		// RIFF header
		this.riffWriter.writeAscii(this.isRf64 ? 'RF64' : 'RIFF');

		if (this.isRf64) {
			this.riffWriter.writeU32(0xffffffff); // Not used in RF64
		} else {
			this.riffSizePos = this.writer.getPos();
			this.riffWriter.writeU32(0); // File size placeholder
		}

		this.riffWriter.writeAscii('WAVE');

		if (this.isRf64) {
			this.riffWriter.writeAscii('ds64');
			this.riffWriter.writeU32(28); // Chunk size

			this.ds64RiffSizePos = this.writer.getPos();
			this.riffWriter.writeU64(0); // RIFF size placeholder

			this.ds64DataSizePos = this.writer.getPos();
			this.riffWriter.writeU64(0); // Data size placeholder

			this.ds64SampleCountPos = this.writer.getPos();
			this.riffWriter.writeU64(0); // Sample count placeholder

			this.riffWriter.writeU32(0); // Table length
			// Empty table
		}

		// fmt chunk
		this.riffWriter.writeAscii('fmt ');
		this.riffWriter.writeU32(16); // Chunk size
		this.riffWriter.writeU16(format);
		this.riffWriter.writeU16(channels);
		this.riffWriter.writeU32(sampleRate);
		this.riffWriter.writeU32(sampleRate * blockSize); // Bytes per second
		this.riffWriter.writeU16(blockSize);
		this.riffWriter.writeU16(8 * pcmInfo.sampleSize);

		// Metadata tags
		if (!metadataTagsAreEmpty(this.output._metadataTags)) {
			const metadataFormat = this.format._options.metadataFormat ?? 'info';

			if (metadataFormat === 'info') {
				this.writeInfoChunk(this.output._metadataTags);
			} else if (metadataFormat === 'id3') {
				this.writeId3Chunk(this.output._metadataTags);
			} else {
				assertNever(metadataFormat);
			}
		}

		// data chunk
		this.riffWriter.writeAscii('data');

		if (this.isRf64) {
			this.riffWriter.writeU32(0xffffffff); // Not used in RF64
		} else {
			this.dataSizePos = this.writer.getPos();
			this.riffWriter.writeU32(0); // Data size placeholder
		}

		if (this.format._options.onHeader) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onHeader(data, start);
		}
	}

	private writeInfoChunk(metadata: MetadataTags) {
		const startPos = this.writer.getPos();

		this.riffWriter.writeAscii('LIST');
		this.riffWriter.writeU32(0); // Size placeholder
		this.riffWriter.writeAscii('INFO');

		const writtenTags = new Set<string>();

		const writeInfoTag = (tag: string, value: string) => {
			if (!isIso88591Compatible(value)) {
				// No Unicode supported here
				console.warn(`Didn't write tag '${tag}' because '${value}' is not ISO 8859-1-compatible.`);
				return;
			}

			const size = value.length + 1; // +1 for null terminator
			const bytes = new Uint8Array(size);

			for (let i = 0; i < value.length; i++) {
				bytes[i] = value.charCodeAt(i);
			}

			this.riffWriter.writeAscii(tag);
			this.riffWriter.writeU32(size);
			this.writer.write(bytes);

			// Add padding byte if size is odd
			if (size & 1) {
				this.writer.write(new Uint8Array(1));
			}

			writtenTags.add(tag);
		};

		for (const { key, value } of keyValueIterator(metadata)) {
			switch (key) {
				case 'title': {
					writeInfoTag('INAM', value);
					writtenTags.add('INAM');
				}; break;

				case 'artist': {
					writeInfoTag('IART', value);
					writtenTags.add('IART');
				}; break;

				case 'album': {
					writeInfoTag('IPRD', value);
					writtenTags.add('IPRD');
				}; break;

				case 'trackNumber': {
					const string = metadata.tracksTotal !== undefined
						? `${value}/${metadata.tracksTotal}`
						: value.toString();

					writeInfoTag('ITRK', string);
					writtenTags.add('ITRK');
				}; break;

				case 'genre': {
					writeInfoTag('IGNR', value);
					writtenTags.add('IGNR');
				}; break;

				case 'date': {
					writeInfoTag('ICRD', value.toISOString().slice(0, 10));
					writtenTags.add('ICRD');
				}; break;

				case 'comment': {
					writeInfoTag('ICMT', value);
					writtenTags.add('ICMT');
				}; break;

				case 'albumArtist':
				case 'discNumber':
				case 'tracksTotal':
				case 'discsTotal':
				case 'description':
				case 'lyrics':
				case 'images': {
					// Not supported in RIFF INFO
				}; break;

				case 'raw': {
					// Handled later
				}; break;

				default: assertNever(key);
			}
		}

		if (metadata.raw) {
			for (const key in metadata.raw) {
				const value = metadata.raw[key];
				if (value == null || key.length !== 4 || writtenTags.has(key)) {
					continue;
				}

				if (typeof value === 'string') {
					writeInfoTag(key, value);
				}
			}
		}

		const endPos = this.writer.getPos();
		const chunkSize = endPos - startPos - 8;

		this.writer.seek(startPos + 4);
		this.riffWriter.writeU32(chunkSize);
		this.writer.seek(endPos);

		// Add padding byte if chunk size is odd
		if (chunkSize & 1) {
			this.writer.write(new Uint8Array(1));
		}
	}

	private writeId3Chunk(metadata: MetadataTags) {
		const startPos = this.writer.getPos();

		// Write RIFF chunk header
		this.riffWriter.writeAscii('ID3 ');
		this.riffWriter.writeU32(0); // Size placeholder

		const id3Writer = new Id3V2Writer(this.writer);
		const id3TagSize = id3Writer.writeId3V2Tag(metadata);

		const endPos = this.writer.getPos();

		// Update RIFF chunk size
		this.writer.seek(startPos + 4);
		this.riffWriter.writeU32(id3TagSize);
		this.writer.seek(endPos);

		// Add padding byte if chunk size is odd
		if (id3TagSize & 1) {
			this.writer.write(new Uint8Array(1));
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		const endPos = this.writer.getPos();

		if (this.isRf64) {
			// Write riff size
			assert(this.ds64RiffSizePos !== null);
			this.writer.seek(this.ds64RiffSizePos);
			this.riffWriter.writeU64(endPos - 8);

			// Write data size
			assert(this.ds64DataSizePos !== null);
			this.writer.seek(this.ds64DataSizePos);
			this.riffWriter.writeU64(this.dataSize);

			// Write sample count
			assert(this.ds64SampleCountPos !== null);
			this.writer.seek(this.ds64SampleCountPos);
			this.riffWriter.writeU64(this.sampleCount);
		} else {
			// Write file size
			assert(this.riffSizePos !== null);
			this.writer.seek(this.riffSizePos);
			this.riffWriter.writeU32(endPos - 8);

			// Write data chunk size
			assert(this.dataSizePos !== null);
			this.writer.seek(this.dataSizePos);
			this.riffWriter.writeU32(this.dataSize);
		}

		this.writer.seek(endPos);

		release();
	}
}
