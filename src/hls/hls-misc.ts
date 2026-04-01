/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

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
			this._attributes[key.toLowerCase()] = value;
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
