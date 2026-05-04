/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const FLAC_ENCODER_LOADED_SYMBOL = Symbol.for('@mediabunny/flac-encoder loaded');
if ((globalThis as Record<symbol, unknown>)[FLAC_ENCODER_LOADED_SYMBOL]) {
	console.error(
		'[WARNING]\n@mediabunny/flac-encoder was loaded twice.'
		+ ' This will likely cause the encoder not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of @mediabunny/flac-encoder,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[FLAC_ENCODER_LOADED_SYMBOL] = true;

export { registerFlacEncoder } from './encoder';
