/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type DecoderCommand =
	| { type: 'init'; data: { sampleRate: number; channels: number; codec: 'eac3' | 'ac3' } }
	| { type: 'decode'; data: { packetData: ArrayBuffer } }
	| { type: 'flush' }
	| { type: 'close' };

export type EncoderCommand =
	| { type: 'init'; data: { sampleRate: number; channels: number; bitrate: number; codec: 'eac3' | 'ac3' } }
	| { type: 'encode'; data: { pcmData: ArrayBuffer; numberOfFrames: number } }
	| { type: 'flush' }
	| { type: 'close' };

export type DecoderResponseData =
	| { pcmData: ArrayBuffer; numberOfFrames: number; sampleRate: number; channels: number }
	| { flushed: true }
	| { closed: true }
	| null;

export type EncoderResponseData =
	| { encodedData: ArrayBuffer }
	| { flushed: true }
	| { closed: true }
	| null;

export type WorkerResponse = {
	id: number;
	success: boolean;
	data: DecoderResponseData | EncoderResponseData;
	error?: Error;
};
