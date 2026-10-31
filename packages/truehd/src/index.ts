/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Logging } from 'mediabunny';

const TRUEHD_LOADED_SYMBOL = Symbol.for('@mediabunny/truehd loaded');
if ((globalThis as Record<symbol, unknown>)[TRUEHD_LOADED_SYMBOL]) {
	Logging._error(
		'[WARNING]\n@mediabunny/truehd was loaded twice.'
		+ ' This will likely cause the encoder/decoder not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of @mediabunny/truehd,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[TRUEHD_LOADED_SYMBOL] = true;

export { registerTrueHdDecoder } from './decoder';
export { registerTrueHdEncoder } from './encoder';
