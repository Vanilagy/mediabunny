/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type WorkerCommand = {
	type: 'init';
	data: {
		numberOfChannels: number;
		sampleRate: number;
		bitrate: number;
	};
} | {
	type: 'encode';
	data: {
		audioData: ArrayBuffer;
		numberOfFrames: number;
	};
} | {
	type: 'flush';
};

export type WorkerResponseData = {
	success: boolean;
} | {
	encodedData: ArrayBuffer;
} | {
	flushedData: ArrayBuffer;
};

export type WorkerResponse = {
	id: number;
} & ({
	success: true;
	data: WorkerResponseData;
} | {
	success: false;
	error: unknown;
});
