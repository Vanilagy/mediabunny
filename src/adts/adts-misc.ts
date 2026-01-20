/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AacAudioSpecificConfig } from '../codec';
import { Bitstream } from '../misc';

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
