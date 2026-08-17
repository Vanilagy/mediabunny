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
 * The DTS encoder needs each frame to be big enough to hold the per-channel side info and rejects the whole
 * configuration when it isn't, so this mirrors the check from FFmpeg's dcaenc.c.
 */
export const dtsBitrateFits = (bitrate: number, sampleRate: number, numberOfChannels: number) => {
	if (bitrate < 32000 || bitrate > 3840000) {
		return false;
	}

	const hasLfe = numberOfChannels === 6;
	const fullbandChannels = numberOfChannels - (hasLfe ? 1 : 0);

	const frameBits = 32 * Math.ceil(Math.ceil(bitrate * 512 / sampleRate) / 32);
	const minFrameBits = 132 + (493 + 28 * 32) * fullbandChannels + (hasLfe ? 72 : 0);

	return frameBits >= minFrameBits && frameBits <= 8 * DTS_MAX_FRAME_SIZE;
};
