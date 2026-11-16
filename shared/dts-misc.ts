/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Sample rates the core can be encoded at (Table 5-5) */
export const DTS_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** Channel counts DTS has a speaker layout for; 3 and 7 have no mapping */
export const DTS_CHANNEL_COUNTS = [1, 2, 4, 5, 6];

const DTS_MAX_FRAME_SIZE = 16384;

/**
 * The DTS encoder rejects bitrates whose frames can't hold the per-channel side info, or that exceed its limits (see
 * FFmpeg's dcaenc.c), so this moves a bitrate into the range it accepts.
 */
export const clampDtsBitrate = (bitrate: number, sampleRate: number, numberOfChannels: number) => {
	const hasLfe = numberOfChannels === 6;
	const fullbandChannels = numberOfChannels - (hasLfe ? 1 : 0);
	const minFrameBits = 132 + (493 + 28 * 32) * fullbandChannels + (hasLfe ? 72 : 0);

	// Frames are a whole number of 32-bit words of 512 samples each
	const minBitrate = Math.max(
		32000,
		Math.floor(32 * (Math.ceil(minFrameBits / 32) - 1) * sampleRate / 512) + 1,
	);
	const maxBitrate = Math.min(3840000, Math.floor(8 * DTS_MAX_FRAME_SIZE * sampleRate / 512));

	return Math.min(Math.max(bitrate, minBitrate), maxBitrate);
};
