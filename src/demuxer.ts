/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from './input';
import { InputTrack } from './input-track';
import { MetadataTags } from './metadata';

export abstract class Demuxer {
	input: Input;

	constructor(input: Input) {
		this.input = input;
	}

	abstract computeDuration(): Promise<number>;
	abstract getTracks(): Promise<InputTrack[]>;
	abstract getMimeType(): Promise<string>;
	abstract getMetadataTags(): Promise<MetadataTags>;
}
