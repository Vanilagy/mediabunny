/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const AC3_LOADED_SYMBOL = Symbol.for('@mediabunny/ac3 loaded');
if ((globalThis as Record<symbol, unknown>)[AC3_LOADED_SYMBOL]) {
	console.error(
		'[WARNING]\n@mediabunny/ac3 was loaded twice.'
		+ ' This will likely cause the encoder/decoder not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of @mediabunny/ac3,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[AC3_LOADED_SYMBOL] = true;

export { registerAc3Decoder } from './decoder';
export { registerAc3Encoder } from './encoder';
