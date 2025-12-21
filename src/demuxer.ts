/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
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

	abstract getTracks(): Promise<InputTrack[]>;
	abstract getMimeType(): Promise<string>;
	abstract getMetadataTags(): Promise<MetadataTags>;

	async computeDuration(): Promise<number> {
		const tracks = await this.getTracks();
		if (tracks.length === 0) {
			return 0;
		}

		// eslint-disable-next-line @typescript-eslint/await-thenable
		const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(...trackDurations);
	}
}
