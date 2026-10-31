/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// TrueHD access units are tiny (40 samples at 48 kHz), so sending each one to the worker on its own would mean well
// over a thousand round trips per second. Instead, we make both sides batch until at least this many samples have
// been accumulated!
export const BATCH_SAMPLE_COUNT = 1024;

export type DecodedChunk = {
	pcmData: ArrayBuffer;
	format: AudioSampleFormat;
	channels: number;
	sampleRate: number;
	sampleCount: number;
	pts: number;
};

export type EncodedChunk = {
	encodedData: ArrayBuffer;
	pts: number;
	duration: number;
};

export type WorkerCommand = {
	type: 'init-decoder';
	data: Record<string, never>;
} | {
	type: 'decode';
	data: {
		ctx: number;
		packets: {
			encodedData: ArrayBuffer;
			timestamp: number;
		}[];
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
		numberOfChannels: number;
		sampleRate: number;
	};
} | {
	type: 'encode';
	data: {
		ctx: number;
		audioData: ArrayBuffer;
		sampleCount: number;
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
} | {
	type: 'decode';
	chunks: DecodedChunk[];
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
	packets: EncodedChunk[];
} | {
	type: 'flush-encoder';
	packets: EncodedChunk[];
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
