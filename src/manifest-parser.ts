/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ManifestInput } from './manifest-input';
import { ManifestInputVariant } from './manifest-input-variant';

export class ManifestParser {
	_input: ManifestInput;

	constructor(input: ManifestInput) {
		this._input = input;
	}

	getVariants(): Promise<ManifestInputVariant[]> {
		throw new Error('Not implemented.');
	}
}
