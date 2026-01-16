/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseOpusTocByte } from '../codec-data';
import { assert, ilog, toDataView } from '../misc';

export const OGGS = 0x5367674f; // 'OggS'

const OGG_CRC_POLYNOMIAL = 0x04c11db7;
const OGG_CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let crc = n << 24;

	for (let k = 0; k < 8; k++) {
		crc = (crc & 0x80000000)
			? ((crc << 1) ^ OGG_CRC_POLYNOMIAL)
			: (crc << 1);
	}

	OGG_CRC_TABLE[n] = (crc >>> 0) & 0xffffffff;
}

export const computeOggPageCrc = (bytes: Uint8Array) => {
	const view = toDataView(bytes);

	const originalChecksum = view.getUint32(22, true);
	view.setUint32(22, 0, true); // Zero out checksum field

	let crc = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		crc = ((crc << 8) ^ OGG_CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}

	view.setUint32(22, originalChecksum, true); // Restore checksum field

	return crc;
};

export type OggCodecInfo = {
	codec: 'vorbis' | 'opus' | null;
	vorbisInfo: {
		blocksizes: number[];
		modeBlockflags: number[];
	} | null;
	opusInfo: {
		preSkip: number;
	} | null;
};

export const extractSampleMetadata = (
	data: Uint8Array,
	codecInfo: OggCodecInfo,
	vorbisLastBlocksize: number | null,
) => {
	let durationInSamples = 0;
	let currentBlocksize: number | null = null;

	if (data.length > 0) {
		// To know sample duration, we'll need to peak inside the packet
		if (codecInfo.codec === 'vorbis') {
			assert(codecInfo.vorbisInfo);

			const vorbisModeCount = codecInfo.vorbisInfo.modeBlockflags.length;
			const bitCount = ilog(vorbisModeCount - 1);
			const modeMask = ((1 << bitCount) - 1) << 1;
			const modeNumber = (data[0]! & modeMask) >> 1;

			if (modeNumber >= codecInfo.vorbisInfo.modeBlockflags.length) {
				throw new Error('Invalid mode number.');
			}

			// In Vorbis, packet duration also depends on the blocksize of the previous packet
			let prevBlocksize = vorbisLastBlocksize;

			const blockflag = codecInfo.vorbisInfo.modeBlockflags[modeNumber]!;
			currentBlocksize = codecInfo.vorbisInfo.blocksizes[blockflag]!;

			if (blockflag === 1) {
				const prevMask = (modeMask | 0x1) + 1;
				const flag = data[0]! & prevMask ? 1 : 0;
				prevBlocksize = codecInfo.vorbisInfo.blocksizes[flag]!;
			}

			durationInSamples = prevBlocksize !== null
				? (prevBlocksize + currentBlocksize) >> 2
				: 0; // The first sample outputs no audio data and therefore has a duration of 0
		} else if (codecInfo.codec === 'opus') {
			const toc = parseOpusTocByte(data);
			durationInSamples = toc.durationInSamples;
		}
	}

	return {
		durationInSamples,
		vorbisBlockSize: currentBlocksize,
	};
};

export const buildOggMimeType = (info: {
	codecStrings: string[];
}) => {
	let string = 'audio/ogg';

	if (info.codecStrings) {
		const uniqueCodecMimeTypes = [...new Set(info.codecStrings)];
		string += `; codecs="${uniqueCodecMimeTypes.join(', ')}"`;
	}

	return string;
};
