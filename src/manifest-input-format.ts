/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { M3u8Parser } from './m3u8/m3u8-parser';
import { ManifestInput } from './manifest-input';
import { ManifestParser } from './manifest-parser';
import { readAscii } from './reader';

export abstract class ManifestInputFormat {
	abstract _canReadManifestInput(input: ManifestInput): Promise<boolean>;
	abstract _createParser(input: ManifestInput): ManifestParser;
}

export class M3u8ManifestInputFormat extends ManifestInputFormat {
	async _canReadManifestInput(input: ManifestInput) {
		let slice = input._entryReader.requestSlice(0, 7);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) return false;

		return readAscii(slice, 7) === '#EXTM3U';
	}

	_createParser(input: ManifestInput) {
		return new M3u8Parser(input);
	}
}

export const M3U8 = /* #__PURE__ */ new M3u8ManifestInputFormat();

export const ALL_MANIFEST_FORMATS = [M3U8];
