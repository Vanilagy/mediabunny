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

const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const VARIABLE_REFERENCE_PATTERN = /\{\$([A-Za-z0-9_-]+)\}/g;

export class HlsPlaylistVariables {
	_variables = new Map<string, string>();

	constructor(
		readonly playlistPath: string,
		readonly importedVariables: ReadonlyMap<string, string> | null,
	) {}

	define(str: string) {
		const attributes = parseAttributeList(str);
		const name = attributes.get('name');
		const importedName = attributes.get('import');
		const queryParameterName = attributes.get('queryparam');
		const declarationCount = [name, importedName, queryParameterName]
			.filter(value => value !== undefined)
			.length;

		if (declarationCount !== 1) {
			throw new Error('EXT-X-DEFINE must declare exactly one of NAME, IMPORT, or QUERYPARAM.');
		}

		if (name !== undefined) {
			const value = attributes.get('value');
			if (value === undefined) {
				throw new Error('EXT-X-DEFINE with NAME must also declare VALUE.');
			}

			this.set(name, value);
		} else if (importedName !== undefined) {
			const value = this.importedVariables?.get(importedName);
			if (value === undefined) {
				throw new Error(`Cannot import undefined HLS variable '${importedName}'.`);
			}

			this.set(importedName, value);
		} else if (queryParameterName !== undefined) {
			const value = getQueryParameter(this.playlistPath, queryParameterName);
			if (value === null) {
				throw new Error(
					`Cannot define HLS variable '${queryParameterName}' from a missing playlist query parameter.`,
				);
			}

			this.set(queryParameterName, value);
		}
	}

	substitute(value: string) {
		return value.replaceAll(VARIABLE_REFERENCE_PATTERN, (_reference, name: string) => {
			const replacement = this._variables.get(name);
			if (replacement === undefined) {
				throw new Error(`HLS variable '${name}' is not defined before use.`);
			}

			return replacement;
		});
	}

	getAll() {
		return this._variables as ReadonlyMap<string, string>;
	}

	set(name: string, value: string) {
		if (!VARIABLE_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid HLS variable name '${name}'.`);
		}
		if (this._variables.has(name)) {
			throw new Error(`HLS variable '${name}' has already been defined.`);
		}

		this._variables.set(name, value);
	}
}

const parseAttributeList = (str: string) => {
	const attributes = new Map<string, string>();
	let position = 0;

	while (position < str.length) {
		while (str[position] === ',' || str[position] === ' ') {
			position++;
		}
		if (position >= str.length) {
			break;
		}

		const equalsPosition = str.indexOf('=', position);
		if (equalsPosition === -1) {
			throw new Error('Invalid EXT-X-DEFINE attribute list.');
		}

		const name = str.slice(position, equalsPosition).trim().toLowerCase();
		position = equalsPosition + 1;

		let value: string;
		if (str[position] === '"') {
			const closingQuotePosition = str.indexOf('"', position + 1);
			if (closingQuotePosition === -1) {
				throw new Error('Unterminated quoted EXT-X-DEFINE attribute.');
			}

			value = str.slice(position + 1, closingQuotePosition);
			position = closingQuotePosition + 1;
		} else {
			const commaPosition = str.indexOf(',', position);
			const endPosition = commaPosition === -1 ? str.length : commaPosition;
			value = str.slice(position, endPosition).trim();
			position = endPosition;
		}

		if (attributes.has(name)) {
			throw new Error(`Duplicate EXT-X-DEFINE attribute '${name}'.`);
		}

		attributes.set(name, value);
	}

	return attributes;
};

const getQueryParameter = (path: string, name: string) => {
	const questionMarkIndex = path.indexOf('?');
	if (questionMarkIndex === -1) {
		return null;
	}

	const fragmentIndex = path.indexOf('#', questionMarkIndex);
	const query = path.slice(questionMarkIndex + 1, fragmentIndex === -1 ? undefined : fragmentIndex);

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

		const commit = () => {
			if (!key) {
				return;
			}

			const shouldSubstitute = quotedValue || value.startsWith('0x') || value.startsWith('0X');
			this._attributes[key.trim().toLowerCase()] = shouldSubstitute && variables
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
				commit();
			} else if (inValue) {
				value += char;
			} else {
				key += char;
			}
		}

		commit();
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
