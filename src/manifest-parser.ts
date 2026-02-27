/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ManifestInput } from './manifest-input';
import { ManifestInputTrack } from './manifest-input-track';

export abstract class ManifestParser {
	_input: ManifestInput;

	constructor(input: ManifestInput) {
		this._input = input;
	}

	abstract getTracks(): Promise<ManifestInputTrack[]>;
}
