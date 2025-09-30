/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type WorkerCommand =
	| { type: 'init'; data: { width: number; height: number } }
	| { type: 'decode'; data: { frameData: ArrayBuffer } }
	| { type: 'flush' }
	| { type: 'close' };

export type WorkerResponseData =
	| { yuvData: ArrayBuffer; width: number; height: number }
	| { flushed: true }
	| { closed: true }
	| null;

export type WorkerResponse = {
	id: number;
	success: boolean;
	data: WorkerResponseData;
	error?: Error;
};
