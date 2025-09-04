/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { assert, Bitstream, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket } from '../packet';
import { readBytes, Reader, readU24Be, readU8 } from '../reader';

type FlacAudioInfo = {
	numberOfChannels: number;
	sampleRate: number;
	totalSamples: number;
	bitsPerSample: number;
	minimumBlockSize: number;
	maximumBlockSize: number;
	minimumFrameSize: number;
	maximumFrameSize: number;
	description: Uint8Array;
};

class FlacAudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: FlacDemuxer) {}

	getId() {
		return 1;
	}

	getCodec() {
		return 'flac' as const;
	}

	getInternalCodecId(): string | number | Uint8Array | null {
		return null;
	}

	getNumberOfChannels() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.numberOfChannels;
	}

	computeDuration() {
		assert(this.demuxer.audioInfo);
		return Promise.resolve(this.demuxer.audioInfo.totalSamples / this.demuxer.audioInfo.sampleRate);
	}

	getSampleRate() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	getName(): string | null {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	async getFirstTimestamp() {
		return 0;
	}

	getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		assert(this.demuxer.audioInfo);

		return Promise.resolve({
			codec: 'flac' as const,
			numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
			sampleRate: this.demuxer.audioInfo.sampleRate,
			description: this.demuxer.audioInfo.description,
		});
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		throw new Error('getPacket() not implemented');
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		throw new Error('getNextPacket() not implemented');
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		throw new Error('getKeyPacket() not implemented');
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		throw new Error('getNextKeyPacket() not implemented');
	}

	getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		throw new Error('getFirstPacket() not implemented');
	}
}

export class FlacDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	tracks: InputAudioTrack[] = [];

	audioInfo: FlacAudioInfo | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async computeDuration(): Promise<number> {
		const tracks = await this.getTracks();
		const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(0, ...trackDurations);
	}

	async readMetadata() {
		let currentPos = 4;

		return this.metadataPromise ??= (async () => {
			// Parse streaminfo block
			// https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2
			let sizeSlice = this.reader.requestSlice(currentPos, currentPos + 4);
			if (sizeSlice instanceof Promise) sizeSlice = await sizeSlice;
			if (!sizeSlice) return;
			readU8(sizeSlice); // first bit: isLastMetadata, remaining 7 bits: metaBlockType
			const size = readU24Be(sizeSlice);
			currentPos += 4;

			let streamInfoBlock = this.reader.requestSlice(currentPos, currentPos + size);
			if (streamInfoBlock instanceof Promise) streamInfoBlock = await streamInfoBlock;
			if (!streamInfoBlock) return;
			currentPos += size;

			const streamInfoDescription = readBytes(streamInfoBlock, 34);
			const bitstream = new Bitstream(streamInfoDescription);

			const minimumBlockSize = bitstream.readBits(16);
			const maximumBlockSize = bitstream.readBits(16);
			const minimumFrameSize = bitstream.readBits(24);
			const maximumFrameSize = bitstream.readBits(24);

			const sampleRate = bitstream.readBits(20);
			const channels = bitstream.readBits(3) + 1;
			const bitsPerSample = bitstream.readBits(5);
			const totalSamples = bitstream.readBits(36);

			// https://www.w3.org/TR/webcodecs-flac-codec-registration/#audiodecoderconfig-description
			// description is required, and has to be the following:
			// - The bytes 0x66 0x4C 0x61 0x43 ("fLaC" in ASCII)
			// - A metadata block (called the STREAMINFO block) as described in section 7 of [FLAC]
			// - Optionaly (sic) other metadata blocks, that are not used by the specification
			const description = new Uint8Array([
				0x66, 0x4c, 0x61, 0x43,
				...streamInfoDescription,
			]);

			bitstream.skipBits(16 * 8); // md5 hash

			this.audioInfo = {
				numberOfChannels: channels,
				sampleRate,
				totalSamples,
				bitsPerSample,
				minimumBlockSize,
				maximumBlockSize,
				minimumFrameSize,
				maximumFrameSize,
				description,
			};

			this.tracks.push(new InputAudioTrack(new FlacAudioTrackBacking(this)));
		})();
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
	}

	override getMimeType(): Promise<string> {
		return Promise.resolve('audio/flac');
	}
}
