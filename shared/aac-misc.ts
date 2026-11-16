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
	programConfigElement: AacProgramConfigElement | null;
};

export type AacProgramConfigElement = {
	elementInstanceTag: number;
	objectType: number;
	samplingFrequencyIndex: number;
	frontElements: AacPceChannelElement[];
	sideElements: AacPceChannelElement[];
	backElements: AacPceChannelElement[];
	lfeElementTags: number[];
	assocDataElementTags: number[];
	ccElements: {
		isIndependentlySwitched: boolean;
		tagSelect: number;
	}[];
	monoMixdownElementNumber: number | null;
	stereoMixdownElementNumber: number | null;
	matrixMixdown: {
		index: number;
		pseudoSurroundEnabled: boolean;
	} | null;
	comment: Uint8Array;
};

type AacPceChannelElement = {
	isCpe: boolean;
	tagSelect: number;
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
	let programConfigElement: AacProgramConfigElement | null = null;
	if (generalAudioObjectTypes.includes(coreObjectType)) {
		frameLength = bitstream.readBits(1) ? 960 : 1024; // frameLengthFlag

		if (channelConfiguration === 0) {
			if (bitstream.readBits(1)) { // dependsOnCoreCoder
				bitstream.skipBits(14); // coreCoderDelay
			}
			bitstream.skipBits(1); // extensionFlag

			programConfigElement = readAacProgramConfigElement(bitstream);
			numberOfChannels = getAacProgramConfigElementChannelCount(programConfigElement);
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

export const buildAacAudioSpecificConfig = (config: {
	objectType: number;
	outputSampleRate: number;
	outputNumberOfChannels: number;
	programConfigElement: AacProgramConfigElement | null;
}) => {
	const usesSbr = config.objectType === 5 || config.objectType === 29;
	const usesPs = config.objectType === 29;

	// SBR runs the core coder at half the output rate, and PS upmixes a mono core to stereo
	const coreSampleRate = usesSbr ? config.outputSampleRate / 2 : config.outputSampleRate;
	const coreNumberOfChannels = usesPs ? 1 : config.outputNumberOfChannels;

	const channelConfiguration = config.programConfigElement ? 0 : aacChannelMap.indexOf(coreNumberOfChannels);
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

	const byteCount = Math.ceil(bitCount / 8)
		+ (config.programConfigElement ? getMaxPceByteLength(config.programConfigElement) : 0);
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

	if (config.programConfigElement) {
		writeAacProgramConfigElement(bitstream, config.programConfigElement);
	}

	return bytes.subarray(0, Math.ceil(bitstream.pos / 8));
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
	const { coreObjectType, frequencyIndex, frameLength } = config;
	let { channelConfiguration, programConfigElement } = config;

	if (coreObjectType < 1 || coreObjectType > 4) {
		throw new Error(`AAC object type ${coreObjectType} can't be stored in ADTS.`);
	}
	if (frequencyIndex >= aacFrequencyTable.length) {
		// The explicit rate that index 15 escapes to has no room in the header, and 13 and 14 are reserved
		throw new Error(`AAC sampling frequency index ${frequencyIndex} can't be stored in ADTS.`);
	}

	if (channelConfiguration === 11 || channelConfiguration === 12) {
		// ADTS has no room for these configurations, but a PCE listing the same elements describes the same layout:
		// 6.1 with back surround and a back center (11), or 7.1 with side and back surround (12)
		const surroundPair = {
			isCpe: true,
			tagSelect: 1,
		};
		programConfigElement = {
			elementInstanceTag: 0,
			objectType: coreObjectType - 1,
			samplingFrequencyIndex: frequencyIndex,
			frontElements: [
				{
					isCpe: false,
					tagSelect: 0,
				},
				{
					isCpe: true,
					tagSelect: 0,
				},
			],
			sideElements: channelConfiguration === 12 ? [surroundPair] : [],
			backElements: channelConfiguration === 11
				? [
						surroundPair,
						{
							isCpe: false,
							tagSelect: 1,
						},
					]
				: [{
						isCpe: true,
						tagSelect: 2,
					}],
			lfeElementTags: [0],
			assocDataElementTags: [],
			ccElements: [],
			monoMixdownElementNumber: null,
			stereoMixdownElementNumber: null,
			matrixMixdown: null,
			comment: new Uint8Array(0),
		};
		channelConfiguration = 0;
	}

	if (channelConfiguration > 7) {
		throw new Error(`AAC channel configuration ${channelConfiguration} can't be stored in ADTS.`);
	}
	if (frameLength !== 1024) {
		throw new Error(`AAC frame length ${frameLength} can't be stored in ADTS.`);
	}

	// With ADTS, a channel layout described by a PCE has to be inside the frames, so we stick it at the end
	// of the header
	let header = new Uint8Array(7 + (programConfigElement ? getMaxPceByteLength(programConfigElement) : 0));
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
		// The raw data block begins on a byte boundary
		bitstream.pos = 8 * 7;
		bitstream.writeBits(3, 5); // ID_PCE
		writeAacProgramConfigElement(bitstream, programConfigElement);
		header = header.subarray(0, bitstream.pos / 8);
	}

	return { header, bitstream };
};

const getMaxPceByteLength = (programConfigElement: AacProgramConfigElement) => {
	return 64 + programConfigElement.comment.byteLength; // Generous
};

const writeAacProgramConfigElement = (bitstream: Bitstream, pce: AacProgramConfigElement) => {
	bitstream.writeBits(4, pce.elementInstanceTag);
	bitstream.writeBits(2, pce.objectType);
	bitstream.writeBits(4, pce.samplingFrequencyIndex);
	bitstream.writeBits(4, pce.frontElements.length);
	bitstream.writeBits(4, pce.sideElements.length);
	bitstream.writeBits(4, pce.backElements.length);
	bitstream.writeBits(2, pce.lfeElementTags.length);
	bitstream.writeBits(3, pce.assocDataElementTags.length);
	bitstream.writeBits(4, pce.ccElements.length);

	bitstream.writeBits(1, +(pce.monoMixdownElementNumber !== null));
	if (pce.monoMixdownElementNumber !== null) {
		bitstream.writeBits(4, pce.monoMixdownElementNumber);
	}
	bitstream.writeBits(1, +(pce.stereoMixdownElementNumber !== null));
	if (pce.stereoMixdownElementNumber !== null) {
		bitstream.writeBits(4, pce.stereoMixdownElementNumber);
	}
	bitstream.writeBits(1, +(pce.matrixMixdown !== null));
	if (pce.matrixMixdown) {
		bitstream.writeBits(2, pce.matrixMixdown.index);
		bitstream.writeBits(1, +pce.matrixMixdown.pseudoSurroundEnabled);
	}

	for (const element of [...pce.frontElements, ...pce.sideElements, ...pce.backElements]) {
		bitstream.writeBits(1, +element.isCpe);
		bitstream.writeBits(4, element.tagSelect);
	}
	for (const tag of [...pce.lfeElementTags, ...pce.assocDataElementTags]) {
		bitstream.writeBits(4, tag);
	}
	for (const element of pce.ccElements) {
		bitstream.writeBits(1, +element.isIndependentlySwitched);
		bitstream.writeBits(4, element.tagSelect);
	}

	bitstream.pos = 8 * Math.ceil(bitstream.pos / 8); // byte_alignment()
	bitstream.writeBits(8, pce.comment.byteLength);
	bitstream.bytes.set(pce.comment, bitstream.pos / 8);
	bitstream.pos += 8 * pce.comment.byteLength;
};

export const writeAdtsFrameLength = (bitstream: Bitstream, frameLength: number) => {
	if (frameLength >= 2 ** 13) {
		throw new Error(`AAC frame too large for ADTS (${frameLength} bytes, at most ${2 ** 13 - 1} allowed).`);
	}

	bitstream.pos = 30;
	bitstream.writeBits(13, frameLength);
};

// ADTS frames with channel configuration 0 describe their channel layout with a PCE in front of the raw data block
export const readAdtsProgramConfigElement = (rawDataBlock: Uint8Array) => {
	const bitstream = new Bitstream(rawDataBlock);
	if (bitstream.readBits(3) !== 5) { // ID_PCE
		return null;
	}

	const programConfigElement = readAacProgramConfigElement(bitstream);

	const size = bitstream.pos / 8;
	if (size > rawDataBlock.byteLength) {
		throw new Error('Invalid ADTS frame: its program config element extends past the end of the frame.');
	}

	return {
		programConfigElement,
		size, // In bytes, within the raw data block
	};
};

const readAacProgramConfigElement = (bitstream: Bitstream): AacProgramConfigElement => {
	const elementInstanceTag = bitstream.readBits(4);
	const objectType = bitstream.readBits(2);
	const samplingFrequencyIndex = bitstream.readBits(4);
	const frontElementCount = bitstream.readBits(4);
	const sideElementCount = bitstream.readBits(4);
	const backElementCount = bitstream.readBits(4);
	const lfeElementCount = bitstream.readBits(2);
	const assocDataElementCount = bitstream.readBits(3);
	const ccElementCount = bitstream.readBits(4);

	const monoMixdownElementNumber = bitstream.readBits(1) ? bitstream.readBits(4) : null;
	const stereoMixdownElementNumber = bitstream.readBits(1) ? bitstream.readBits(4) : null;
	const matrixMixdown = bitstream.readBits(1)
		? {
				index: bitstream.readBits(2),
				pseudoSurroundEnabled: !!bitstream.readBits(1),
			}
		: null;

	const readChannelElements = (count: number) => Array.from({ length: count }, () => ({
		isCpe: !!bitstream.readBits(1),
		tagSelect: bitstream.readBits(4),
	}));
	const frontElements = readChannelElements(frontElementCount);
	const sideElements = readChannelElements(sideElementCount);
	const backElements = readChannelElements(backElementCount);
	const lfeElementTags = Array.from({ length: lfeElementCount }, () => bitstream.readBits(4));
	const assocDataElementTags = Array.from({ length: assocDataElementCount }, () => bitstream.readBits(4));
	const ccElements = Array.from({ length: ccElementCount }, () => ({
		isIndependentlySwitched: !!bitstream.readBits(1),
		tagSelect: bitstream.readBits(4),
	}));

	bitstream.pos = 8 * Math.ceil(bitstream.pos / 8); // byte_alignment()
	const commentLength = bitstream.readBits(8);
	const comment = bitstream.bytes.slice(bitstream.pos / 8, bitstream.pos / 8 + commentLength);
	bitstream.pos += 8 * commentLength;

	return {
		elementInstanceTag,
		objectType,
		samplingFrequencyIndex,
		frontElements,
		sideElements,
		backElements,
		lfeElementTags,
		assocDataElementTags,
		ccElements,
		monoMixdownElementNumber,
		stereoMixdownElementNumber,
		matrixMixdown,
		comment,
	};
};

export const getAacProgramConfigElementChannelCount = (pce: AacProgramConfigElement) => {
	const elements = [...pce.frontElements, ...pce.sideElements, ...pce.backElements];
	return elements.reduce((count, element) => count + (element.isCpe ? 2 : 1), pce.lfeElementTags.length);
};
