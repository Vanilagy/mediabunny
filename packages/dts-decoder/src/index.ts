/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const DTS_DECODER_LOADED_SYMBOL = Symbol.for('@mediabunny/dts-decoder loaded');
if ((globalThis as Record<symbol, unknown>)[DTS_DECODER_LOADED_SYMBOL]) {
	console.error(
		'[WARNING]\n@mediabunny/dts-decoder was loaded twice.'
		+ ' This will likely cause the decoder not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of @mediabunny/dts-decoder,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[DTS_DECODER_LOADED_SYMBOL] = true;

export { registerDtsDecoder } from './decoder';
