/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Bitstream } from './bitstream';

export type AacAudioSpecificConfig = {
	objectType: number;
	frequencyIndex: number;
	sampleRate: number | null;
	channelConfiguration: number;
	numberOfChannels: number | null;
};

export const aacFrequencyTable = [
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export const aacChannelMap = [-1, 1, 2, 3, 4, 5, 6, 8];

export const parseAacAudioSpecificConfig = (bytes: Uint8Array | null): AacAudioSpecificConfig => {
	if (!bytes || bytes.byteLength < 2) {
		throw new TypeError('AAC description must be at least 2 bytes long.');
	}

	const bitstream = new Bitstream(bytes);

	let objectType = bitstream.readBits(5);
	if (objectType === 31) {
		objectType = 32 + bitstream.readBits(6);
	}

	const frequencyIndex = bitstream.readBits(4);
	let sampleRate: number | null = null;
	if (frequencyIndex === 15) {
		sampleRate = bitstream.readBits(24);
	} else {
		if (frequencyIndex < aacFrequencyTable.length) {
			sampleRate = aacFrequencyTable[frequencyIndex]!;
		}
	}

	const channelConfiguration = bitstream.readBits(4);
	let numberOfChannels: number | null = null;
	if (channelConfiguration >= 1 && channelConfiguration <= 7) {
		numberOfChannels = aacChannelMap[channelConfiguration]!;
	}

	return {
		objectType,
		frequencyIndex,
		sampleRate,
		channelConfiguration,
		numberOfChannels,
	};
};

export const buildAacAudioSpecificConfig = (config: {
	objectType: number;
	sampleRate: number;
	numberOfChannels: number;
}) => {
	let frequencyIndex = aacFrequencyTable.indexOf(config.sampleRate);
	let customSampleRate: number | null = null;

	if (frequencyIndex === -1) {
		frequencyIndex = 15;
		customSampleRate = config.sampleRate;
	}

	const channelConfiguration = aacChannelMap.indexOf(config.numberOfChannels);
	if (channelConfiguration === -1) {
		throw new TypeError(`Unsupported number of channels: ${config.numberOfChannels}`);
	}

	let bitCount = 5 + 4 + 4;
	if (config.objectType >= 32) {
		bitCount += 6;
	}
	if (frequencyIndex === 15) {
		bitCount += 24;
	}

	const byteCount = Math.ceil(bitCount / 8);
	const bytes = new Uint8Array(byteCount);
	const bitstream = new Bitstream(bytes);

	if (config.objectType < 32) {
		bitstream.writeBits(5, config.objectType);
	} else {
		bitstream.writeBits(5, 31);
		bitstream.writeBits(6, config.objectType - 32);
	}

	bitstream.writeBits(4, frequencyIndex);

	if (frequencyIndex === 15) {
		bitstream.writeBits(24, customSampleRate!);
	}

	bitstream.writeBits(4, channelConfiguration);

	return bytes;
};

export type AdtsHeaderTemplate = {
	header: Uint8Array;
	bitstream: Bitstream;
};

export const buildAdtsHeaderTemplate = (config: AacAudioSpecificConfig): AdtsHeaderTemplate => {
	const header = new Uint8Array(7);
	const bitstream = new Bitstream(header);

	const { objectType, frequencyIndex, channelConfiguration } = config;
	const profile = objectType - 1;

	bitstream.writeBits(12, 0b1111_11111111); // Syncword
	bitstream.writeBits(1, 0); // MPEG Version
	bitstream.writeBits(2, 0); // Layer
	bitstream.writeBits(1, 1); // Protection absence
	bitstream.writeBits(2, profile); // Profile
	bitstream.writeBits(4, frequencyIndex); // MPEG-4 Sampling Frequency Index
	bitstream.writeBits(1, 0); // Private bit
	bitstream.writeBits(3, channelConfiguration); // MPEG-4 Channel Configuration
	bitstream.writeBits(1, 0); // Originality
	bitstream.writeBits(1, 0); // Home
	bitstream.writeBits(1, 0); // Copyright ID bit
	bitstream.writeBits(1, 0); // Copyright ID start
	bitstream.skipBits(13); // Frame length (to be filled per packet)
	bitstream.writeBits(11, 0x7ff); // Buffer fullness
	bitstream.writeBits(2, 0); // Number of AAC frames minus 1
	// Omit CRC check

	return { header, bitstream };
};

export const writeAdtsFrameLength = (bitstream: Bitstream, frameLength: number) => {
	bitstream.pos = 30;
	bitstream.writeBits(13, frameLength);
};
