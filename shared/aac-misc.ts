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
	coreObjectType: number;
	frequencyIndex: number;
	channelConfiguration: number;
	coreSampleRate: number | null;
	outputSampleRate: number | null;
	outputNumberOfChannels: number | null;
	frameLength: number; // In samples at the core sample rate
	programConfigElement: Uint8Array | null; // As a raw data block element
};

export const aacFrequencyTable = [
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export const aacChannelMap = [-1, 1, 2, 3, 4, 5, 6, 8];

// The object types whose config is a GASpecificConfig, except for AAC-LD, for which frameLengthFlag means 480 vs. 512
const generalAudioObjectTypes = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22];

export const parseAacAudioSpecificConfig = (bytes: Uint8Array | null): AacAudioSpecificConfig => {
	if (!bytes || bytes.byteLength < 2) {
		throw new TypeError('AAC description must be at least 2 bytes long.');
	}

	const bitstream = new Bitstream(bytes);

	const objectType = readAacObjectType(bitstream);
	const { frequencyIndex, sampleRate } = readAacSamplingFrequency(bitstream);

	const channelConfiguration = bitstream.readBits(4);
	let numberOfChannels: number | null = null;
	if (channelConfiguration >= 1 && channelConfiguration <= 7) {
		numberOfChannels = aacChannelMap[channelConfiguration]!;
	}

	let coreObjectType = objectType;
	let psPresent = false;
	let outputSampleRate = sampleRate;

	if (objectType === 5 || objectType === 29) {
		// Explicit hierarchical signaling: everything read so far describes the core coder, and the rate the
		// decoder actually outputs follows right here
		psPresent = objectType === 29;

		outputSampleRate = readAacSamplingFrequency(bitstream).sampleRate;
		coreObjectType = readAacObjectType(bitstream);

		if (coreObjectType === 22) {
			bitstream.skipBits(4); // extensionChannelConfiguration
		}
	}

	let frameLength = 1024;
	let programConfigElement: Uint8Array | null = null;
	if (generalAudioObjectTypes.includes(coreObjectType)) {
		frameLength = bitstream.readBits(1) ? 960 : 1024; // frameLengthFlag

		if (channelConfiguration === 0) {
			if (bitstream.readBits(1)) { // dependsOnCoreCoder
				bitstream.skipBits(14); // coreCoderDelay
			}
			bitstream.skipBits(1); // extensionFlag

			programConfigElement = readProgramConfigElement(bitstream);
		}
	}

	if (objectType !== 5 && objectType !== 29) {
		// There may be SBR/PS flags sitting behind a sync word after the config of the core coder. We find them by
		// scanning for the sync word, just like FFmpeg does.
		while (bitstream.getBitsLeft() > 15) {
			const searchStart = bitstream.pos;

			if (bitstream.readBits(11) !== 0x2b7) {
				bitstream.pos = searchStart + 1;
				continue;
			}

			if (readAacObjectType(bitstream) === 5 && bitstream.readBits(1)) {
				outputSampleRate = readAacSamplingFrequency(bitstream).sampleRate;

				if (bitstream.getBitsLeft() > 11 && bitstream.readBits(11) === 0x548) {
					psPresent = !!bitstream.readBits(1);
				}
			}

			break;
		}
	}

	if (numberOfChannels !== null && numberOfChannels > 1) {
		// PS only ever upmixes a mono core. A stereo signal means whatever we read was bogus
		psPresent = false;
	}

	return {
		objectType,
		coreObjectType,
		frequencyIndex,
		channelConfiguration,
		coreSampleRate: sampleRate,
		outputSampleRate,
		outputNumberOfChannels: psPresent && numberOfChannels === 1
			? 2
			: numberOfChannels,
		frameLength,
		programConfigElement,
	};
};

const readAacObjectType = (bitstream: Bitstream) => {
	const objectType = bitstream.readBits(5);
	return objectType === 31 ? 32 + bitstream.readBits(6) : objectType;
};

const readAacSamplingFrequency = (bitstream: Bitstream) => {
	const frequencyIndex = bitstream.readBits(4);

	if (frequencyIndex === 15) {
		return {
			frequencyIndex,
			sampleRate: bitstream.readBits(24),
		};
	}

	return {
		frequencyIndex,
		sampleRate: frequencyIndex < aacFrequencyTable.length
			? aacFrequencyTable[frequencyIndex]!
			: null,
	};
};

const readProgramConfigElement = (bitstream: Bitstream) => {
	const bytes = new Uint8Array(bitstream.bytes.byteLength + 2);
	const element = new Bitstream(bytes);
	const copyField = (n: number) => {
		const value = bitstream.readBits(n);
		element.writeBits(n, value);
		return value;
	};

	element.writeBits(3, 5); // ID_PCE
	copyField(10); // element_instance_tag, object_type, sampling_frequency_index
	const frontElementCount = copyField(4);
	const sideElementCount = copyField(4);
	const backElementCount = copyField(4);
	const lfeElementCount = copyField(2);
	const assocDataElementCount = copyField(3);
	const ccElementCount = copyField(4);

	for (const mixdownBitCount of [4, 4, 3]) { // Mono, stereo and matrix mixdown
		if (copyField(1)) {
			copyField(mixdownBitCount);
		}
	}

	element.copyBits(
		5 * (frontElementCount + sideElementCount + backElementCount + ccElementCount)
		+ 4 * (lfeElementCount + assocDataElementCount),
		bitstream,
	);

	// byte_alignment() is relative to the start of the raw data block now. The comment field stays empty; it would
	// only bloat every frame.
	element.pos = 8 * Math.ceil(element.pos / 8) + 8;

	return bytes.subarray(0, element.pos / 8);
};

export const buildAacAudioSpecificConfig = (config: {
	objectType: number;
	outputSampleRate: number;
	outputNumberOfChannels: number;
}) => {
	const usesSbr = config.objectType === 5 || config.objectType === 29;
	const usesPs = config.objectType === 29;

	// SBR runs the core coder at half the output rate, and PS upmixes a mono core to stereo
	const coreSampleRate = usesSbr ? config.outputSampleRate / 2 : config.outputSampleRate;
	const coreNumberOfChannels = usesPs ? 1 : config.outputNumberOfChannels;

	const channelConfiguration = aacChannelMap.indexOf(coreNumberOfChannels);
	if (channelConfiguration === -1) {
		throw new TypeError(`Unsupported number of channels: ${config.outputNumberOfChannels}`);
	}

	// Object type, sampling frequency, channel configuration, then a bare GASpecificConfig
	let bitCount = 5 + 4 + 4 + 3;
	if (config.objectType >= 32) {
		bitCount += 6;
	}
	if (findAacFrequencyIndex(coreSampleRate) === 15) {
		bitCount += 24;
	}
	if (usesSbr) {
		bitCount += 4 + 5; // Extension sampling frequency and the object type of the core coder
		if (findAacFrequencyIndex(config.outputSampleRate) === 15) {
			bitCount += 24;
		}
	}

	const byteCount = Math.ceil(bitCount / 8);
	const bytes = new Uint8Array(byteCount);
	const bitstream = new Bitstream(bytes);

	writeAacObjectType(bitstream, config.objectType);
	writeAacSamplingFrequency(bitstream, coreSampleRate);
	bitstream.writeBits(4, channelConfiguration);

	if (usesSbr) {
		writeAacSamplingFrequency(bitstream, config.outputSampleRate);
		writeAacObjectType(bitstream, 2); // AAC-LC underneath
	}

	bitstream.writeBits(3, 0); // frameLengthFlag, dependsOnCoreCoder, extensionFlag

	return bytes;
};

const writeAacObjectType = (bitstream: Bitstream, objectType: number) => {
	if (objectType < 32) {
		bitstream.writeBits(5, objectType);
	} else {
		bitstream.writeBits(5, 31);
		bitstream.writeBits(6, objectType - 32);
	}
};

const writeAacSamplingFrequency = (bitstream: Bitstream, sampleRate: number) => {
	const frequencyIndex = findAacFrequencyIndex(sampleRate);
	bitstream.writeBits(4, frequencyIndex);

	if (frequencyIndex === 15) {
		bitstream.writeBits(24, sampleRate);
	}
};

const findAacFrequencyIndex = (sampleRate: number) => {
	const index = aacFrequencyTable.indexOf(sampleRate);
	return index === -1 ? 15 : index;
};

export type AdtsHeaderTemplate = {
	header: Uint8Array;
	bitstream: Bitstream;
};

export const buildAdtsHeaderTemplate = (config: AacAudioSpecificConfig): AdtsHeaderTemplate => {
	const { coreObjectType, frequencyIndex, channelConfiguration, frameLength, programConfigElement } = config;

	if (coreObjectType < 1 || coreObjectType > 4) {
		throw new Error(`AAC object type ${coreObjectType} can't be stored in ADTS.`);
	}
	if (frequencyIndex >= aacFrequencyTable.length) {
		// The explicit rate that index 15 escapes to has no room in the header, and 13 and 14 are reserved
		throw new Error(`AAC sampling frequency index ${frequencyIndex} can't be stored in ADTS.`);
	}
	if (channelConfiguration > 7) {
		throw new Error(`AAC channel configuration ${channelConfiguration} can't be stored in ADTS.`);
	}
	if (frameLength !== 1024) {
		throw new Error(`AAC frame length ${frameLength} can't be stored in ADTS.`);
	}

	// With ADTS, a channel layout described by a PCE has to travel inside the frames. It goes into every one of them
	// so that decoding can start anywhere.
	const header = new Uint8Array(7 + (programConfigElement?.byteLength ?? 0));
	const bitstream = new Bitstream(header);

	const profile = coreObjectType - 1;

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

	if (programConfigElement) {
		header.set(programConfigElement, 7);
	}

	return { header, bitstream };
};

export const writeAdtsFrameLength = (bitstream: Bitstream, frameLength: number) => {
	bitstream.pos = 30;
	bitstream.writeBits(13, frameLength);
};

// ADTS frames with channel configuration 0 describe their channel layout with a PCE leading the raw data block. This
// reads it and converts it into the form an AudioSpecificConfig holds it in.
export const readAdtsProgramConfigElement = (rawDataBlock: Uint8Array) => {
	const bitstream = new Bitstream(rawDataBlock);
	if (bitstream.readBits(3) !== 5) { // ID_PCE
		return null;
	}

	const bytes = new Uint8Array(rawDataBlock.byteLength + 1);
	const element = new Bitstream(bytes);
	const copyField = (n: number) => {
		const value = bitstream.readBits(n);
		element.writeBits(n, value);
		return value;
	};

	copyField(10); // element_instance_tag, object_type, sampling_frequency_index
	const frontElementCount = copyField(4);
	const sideElementCount = copyField(4);
	const backElementCount = copyField(4);
	const lfeElementCount = copyField(2);
	const assocDataElementCount = copyField(3);
	const ccElementCount = copyField(4);

	for (const mixdownBitCount of [4, 4, 3]) { // Mono, stereo and matrix mixdown
		if (copyField(1)) {
			copyField(mixdownBitCount);
		}
	}

	let numberOfChannels = lfeElementCount;
	for (let i = 0; i < frontElementCount + sideElementCount + backElementCount; i++) {
		numberOfChannels += copyField(1) ? 2 : 1; // is_cpe
		copyField(4); // element_tag_select
	}

	element.copyBits(4 * (lfeElementCount + assocDataElementCount) + 5 * ccElementCount, bitstream);

	// byte_alignment() is relative to the start of the raw data block here, and to the start of the AudioSpecificConfig
	// there, in which the PCE begins on a byte boundary. The comment field stays empty.
	bitstream.pos = 8 * Math.ceil(bitstream.pos / 8);
	const commentLength = bitstream.readBits(8);
	element.pos = 8 * Math.ceil(element.pos / 8) + 8;

	const size = bitstream.pos / 8 + commentLength;
	if (size > rawDataBlock.byteLength) {
		throw new Error('Invalid ADTS frame: its program config element extends past the end of the frame.');
	}

	return {
		numberOfChannels,
		size, // In bytes, within the raw data block
		data: bytes.subarray(0, element.pos / 8),
	};
};

// Just like FFmpeg's aac_adtstoasc
export const buildAacAudioSpecificConfigFromAdts = (
	header: {
		objectType: number;
		samplingFrequencyIndex: number;
		channelConfiguration: number;
	},
	programConfigElement: Uint8Array | null,
) => {
	const bytes = new Uint8Array(2 + (programConfigElement?.byteLength ?? 0));
	const bitstream = new Bitstream(bytes);

	bitstream.writeBits(5, header.objectType);
	bitstream.writeBits(4, header.samplingFrequencyIndex);
	bitstream.writeBits(4, header.channelConfiguration);
	bitstream.writeBits(3, 0); // frameLengthFlag, dependsOnCoreCoder, extensionFlag

	if (programConfigElement) {
		bytes.set(programConfigElement, 2);
	}

	return bytes;
};
