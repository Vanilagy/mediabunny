/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const HLS_CODEC_ALIASES = new Map([
	['aac', 'mp4a.40.2'],
	['mp3', 'mp4a.40.34'],
	['mp4a.69', 'mp4a.40.34'],
	['mp4a.6B', 'mp4a.40.34'],
	['mp4a.6b', 'mp4a.40.34'],
	['ac3', 'ac-3'],
	['eac3', 'ec-3'],
	['flac', 'fLaC'],
	['webvtt', 'wvtt'],
]);

const NEEDS_FULL_CODEC_STRING = new Set([
	'avc',
	'hevc',
	'vp9',
	'av1',
]);

/** @internal */
export const toHlsCodecString = (codecString: string) => {
	const alias = HLS_CODEC_ALIASES.get(codecString);
	if (alias) {
		return alias;
	}

	if (NEEDS_FULL_CODEC_STRING.has(codecString)) {
		return null;
	}

	return codecString;
};
