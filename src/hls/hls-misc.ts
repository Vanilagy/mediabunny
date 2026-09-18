/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Logging } from '../logging';

export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export const TAG_STREAM_INF = '#EXT-X-STREAM-INF:';
export const TAG_I_FRAME_STREAM_INF = '#EXT-X-I-FRAME-STREAM-INF:';
export const TAG_MEDIA = '#EXT-X-MEDIA:';
export const TAG_DEFINE = '#EXT-X-DEFINE:';
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

// variable name `token_1` is referenced as `{$token_1}`
const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const VARIABLE_REFERENCE_PATTERN = /\{\$([A-Za-z0-9_-]+)\}/g;

export class HlsPlaylistVariables {
	_variables = new Map<string, string>();

	constructor(
		readonly playlistPath: string,
		readonly importedVariables: HlsPlaylistVariables | null,
	) {}

	define(str: string) {
		const attributes = new AttributeList(str, this);
		const name = attributes.get('name');
		const importedName = attributes.get('import');
		const queryParameterName = attributes.get('queryparam');
		const declarationCount = [name, importedName, queryParameterName]
			.filter(value => value !== null)
			.length;

		if (declarationCount !== 1) {
			throw new Error(
				'Invalid #EXT-X-DEFINE tag; exactly one of NAME, IMPORT, or QUERYPARAM must be present.',
			);
		}

		if (name !== null) {
			const value = attributes.get('value');
			if (value === null) {
				throw new Error('Invalid #EXT-X-DEFINE tag; NAME requires VALUE.');
			}

			this.set(name, value);
		} else if (importedName !== null) {
			const value = this.importedVariables?.get(importedName);
			if (value === undefined) {
				throw new Error(`Invalid #EXT-X-DEFINE tag; cannot import undefined variable "${importedName}".`);
			}

			this.set(importedName, value);
		} else if (queryParameterName !== null) {
			const value = getQueryParameter(this.playlistPath, queryParameterName);
			if (value === null) {
				throw new Error(`Invalid #EXT-X-DEFINE tag; query parameter "${queryParameterName}" is missing.`);
			}

			this.set(queryParameterName, value);
		}
	}

	substitute(value: string) {
		return value.replaceAll(VARIABLE_REFERENCE_PATTERN, (_reference, name: string) => {
			const replacement = this._variables.get(name);
			if (replacement === undefined) {
				throw new Error(`Invalid M3U8 file; variable "${name}" is referenced before being defined.`);
			}

			return replacement;
		});
	}

	get(name: string) {
		return this._variables.get(name);
	}

	set(name: string, value: string) {
		if (!VARIABLE_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid #EXT-X-DEFINE tag; invalid variable name "${name}".`);
		}
		if (this._variables.has(name)) {
			// "Parsers that encounter duplicate Variable Name declarations MUST fail to parse the Playlist."
			throw new Error(`Invalid #EXT-X-DEFINE tag; variable "${name}" is already defined.`);
		}

		this._variables.set(name, value);
	}
}

// eg. path `/media.m3u8?token=abc%20123` and name `token` resolve to `abc 123`
const getQueryParameter = (path: string, name: string) => {
	const queryIndex = path.indexOf('?');
	if (queryIndex === -1) {
		return null;
	}

	const fragmentIndex = path.indexOf('#', queryIndex);
	const query = path.slice(queryIndex + 1, fragmentIndex === -1 ? undefined : fragmentIndex);

	for (const parameter of query.split('&')) {
		const equalsIndex = parameter.indexOf('=');
		const encodedName = equalsIndex === -1 ? parameter : parameter.slice(0, equalsIndex);
		if (decodeURIComponent(encodedName) !== name) {
			continue;
		}

		const encodedValue = equalsIndex === -1 ? '' : parameter.slice(equalsIndex + 1);
		return decodeURIComponent(encodedValue);
	}

	return null;
};

export class AttributeList {
	_attributes: Record<string, string> = {};

	constructor(str: string, variables?: HlsPlaylistVariables) {
		let key = '';
		let value = '';
		let inValue = false;
		let inQuotes = false;
		let quotedValue = false;

		const flushAttribute = () => {
			if (!key) {
				return;
			}

			const attributeName = key.trim().toLowerCase();
			if (Object.prototype.hasOwnProperty.call(this._attributes, attributeName)) {
				// "AttributeName MUST NOT appear more than once in a given attribute-list.
				// Clients SHOULD refuse to parse such Playlists."
				Logging._warn(`Duplicate AttributeName "${attributeName}"; using last value`);
			}

			// quoted-string and hexadecimal-sequence AttributeValues are subject to variable substitution
			const shouldSubstitute = quotedValue || value.startsWith('0x') || value.startsWith('0X');
			this._attributes[attributeName] = shouldSubstitute && variables
				? variables.substitute(value)
				: value;

			key = '';
			value = '';
			inValue = false;
			quotedValue = false;
		};

		for (let i = 0; i < str.length; i++) {
			const char = str[i]!;

			if (char === '"') {
				if (inValue && !inQuotes && value.length === 0) {
					quotedValue = true;
				}
				inQuotes = !inQuotes;
			} else if (char === '=' && !inValue && !inQuotes) {
				inValue = true;
			} else if (char === ',' && !inQuotes) {
				flushAttribute();
			} else if (inValue) {
				value += char;
			} else {
				key += char;
			}
		}

		if (inQuotes) {
			throw new Error('Invalid M3U8 file; unterminated quoted-string AttributeValue.');
		}

		flushAttribute();
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
