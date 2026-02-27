/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from './output';

export interface ManifestInputTrackBacking {
	getGroup(): number;
	getCompatMask(): number;
}

export abstract class ManifestInputTrack {
	_backing: ManifestInputTrackBacking;

	constructor(backing: ManifestInputTrackBacking) {
		this._backing = backing;
	}

	abstract get type(): TrackType;

	get group() {
		return this._backing.getGroup();
	}

	get compatMask() {
		return this._backing.getCompatMask();
	}
}

export interface ManifestInputVideoTrackBacking extends ManifestInputTrackBacking {
	getWidth(): number;
	getHeight(): number;
}

export class ManifestInputVideoTrack extends ManifestInputTrack {
	override _backing: ManifestInputVideoTrackBacking;

	constructor(backing: ManifestInputVideoTrackBacking) {
		super(backing);
		this._backing = backing;
	}

	get type(): TrackType {
		return 'video';
	}

	get width() {
		return this._backing.getWidth();
	}

	get height() {
		return this._backing.getHeight();
	}
}

export interface ManifestInputAudioTrackBacking extends ManifestInputTrackBacking {
	getNumberOfChannels(): number;
	getSampleRate(): number;
}

export class ManifestInputAudioTrack extends ManifestInputTrack {
	override _backing: ManifestInputAudioTrackBacking;

	constructor(backing: ManifestInputAudioTrackBacking) {
		super(backing);
		this._backing = backing;
	}

	get type(): TrackType {
		return 'audio';
	}

	get numberOfChannels() {
		return this._backing.getNumberOfChannels();
	}

	get sampleRate() {
		return this._backing.getSampleRate();
	}
}
