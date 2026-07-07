/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export const TAG_STREAM_INF = '#EXT-X-STREAM-INF:';
export const TAG_I_FRAME_STREAM_INF = '#EXT-X-I-FRAME-STREAM-INF:';
export const TAG_MEDIA = '#EXT-X-MEDIA:';
export const TAG_EXTINF = '#EXTINF:';
export const TAG_MAP = '#EXT-X-MAP:';
export const TAG_KEY = '#EXT-X-KEY:';
export const TAG_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE:';
export const TAG_BYTERANGE = '#EXT-X-BYTERANGE:';
export const TAG_PROGRAM_DATE_TIME = '#EXT-X-PROGRAM-DATE-TIME:';
export const TAG_DISCONTINUITY = '#EXT-X-DISCONTINUITY';
export const TAG_TARGETDURATION = '#EXT-X-TARGETDURATION:';
export const TAG_ENDLIST = '#EXT-X-ENDLIST';
export const TAG_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE:';
export const TAG_I_FRAMES_ONLY = '#EXT-X-I-FRAMES-ONLY';

export const canIgnoreLine = (line: string) => line.length === 0 || (line.startsWith('#') && !line.startsWith('#EXT'));

export class AttributeList {
	_attributes: Record<string, string> = {};

	constructor(str: string) {
		let key = '';
		let value = '';
		let inValue = false;
		let inQuotes = false;

		for (let i = 0; i < str.length; i++) {
			const char = str[i]!;

			if (char === '"') {
				inQuotes = !inQuotes;
			} else if (char === '=' && !inValue && !inQuotes) {
				inValue = true;
			} else if (char === ',' && !inQuotes) {
				if (key) {
					this._attributes[key.trim().toLowerCase()] = value;
				}

				key = '';
				value = '';
				inValue = false;
			} else if (inValue) {
				value += char;
			} else {
				key += char;
			}
		}

		if (key) {
			this._attributes[key.trim().toLowerCase()] = value;
		}
	}

	get(name: string) {
		return this._attributes[name.toLowerCase()] ?? null;
	}

	getAsNumber(name: string) {
		const value = this.get(name);
		if (value === null) {
			return null;
		}

		const num = Number(value);
		return Number.isFinite(num) ? num : null;
	}

	merge(other: AttributeList) {
		Object.assign(this._attributes, other._attributes);
	}
}
