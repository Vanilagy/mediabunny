/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from './input';
import { InputTrackBacking } from './input-track';
import { MetadataTags } from './metadata';

/**
 * Options for retrieving media duration from metadata.
 * @group Input files & tracks
 * @public
 */
export type DurationMetadataRequestOptions = {
	/**
	 * When the underlying media is live, querying the duration will, by default, wait until the live stream has ended.
	 * Setting this field to `true` skips that wait and returns the current duration of the stream. When the media isn't
	 * live, this field has no effect.
	 *
	 * See also {@link PacketRetrievalOptions.skipLiveWait}.
	 */
	skipLiveWait?: boolean;
};

export abstract class Demuxer {
	input: Input;

	constructor(input: Input) {
		this.input = input;
	}

	abstract getTrackBackings(): Promise<InputTrackBacking[]>;
	abstract getMimeType(): Promise<string>;
	abstract getMetadataTags(): Promise<MetadataTags>;

	dispose() {
		// Can be overridden
	}
}
