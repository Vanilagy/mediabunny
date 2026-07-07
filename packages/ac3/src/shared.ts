/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type WorkerCommand = {
	type: 'init-decoder';
	data: {
		codec: string;
	};
} | {
	type: 'decode';
	data: {
		ctx: number;
		encodedData: ArrayBuffer;
		timestamp: number;
	};
} | {
	type: 'flush-decoder';
	data: {
		ctx: number;
	};
} | {
	type: 'close-decoder';
	data: {
		ctx: number;
	};
} | {
	type: 'init-encoder';
	data: {
		codec: string;
		numberOfChannels: number;
		sampleRate: number;
		bitrate: number;
	};
} | {
	type: 'encode';
	data: {
		ctx: number;
		audioData: ArrayBuffer;
		timestamp: number;
	};
} | {
	type: 'flush-encoder';
	data: {
		ctx: number;
	};
} | {
	type: 'close-encoder';
	data: {
		ctx: number;
	};
};

export type WorkerResponseData = {
	type: 'init-decoder';
	ctx: number;
	frameSize: number;
} | {
	type: 'decode';
	pcmData: ArrayBuffer;
	format: AudioSampleFormat;
	channels: number;
	sampleRate: number;
	sampleCount: number;
	pts: number;
} | {
	type: 'flush-decoder';
} | {
	type: 'close-decoder';
} | {
	type: 'init-encoder';
	ctx: number;
	frameSize: number;
} | {
	type: 'encode';
	encodedData: ArrayBuffer;
	pts: number;
	duration: number;
} | {
	type: 'flush-encoder';
} | {
	type: 'close-encoder';
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

export function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}
