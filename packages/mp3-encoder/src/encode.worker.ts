/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import createModule from '../build/lame';
import type { WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';

type ExtendedEmscriptenModule = EmscriptenModule & {
	cwrap: typeof cwrap;
};

let module: ExtendedEmscriptenModule;
let lamePtr: number;
let storedNumberOfChannels: number;
let storedSampleRate: number;
let storedBitrate: number;
let needsReset = false;

let initLame: (
	numberOfChannels: number,
	sampleRate: number,
	bitrate: number
) => number;
let encodeSamples: (
	lame: number,
	leftPtr: number,
	rightPtr: number,
	sampleCount: number,
	outputPtr: number,
	outputSize: number
) => number;
let flushLame: (lame: number, outputPtr: number, outputSize: number) => number;
let closeLame: (lame: number) => void;

let inputSlice: Slice | null = null;
let outputSlice: Slice | null = null;

const init = async (numberOfChannels: number, sampleRate: number, bitrate: number) => {
	storedNumberOfChannels = numberOfChannels;
	storedSampleRate = sampleRate;
	storedBitrate = bitrate;

	module = (await createModule()) as ExtendedEmscriptenModule;

	// Set up the functions
	initLame = module.cwrap('init_lame', 'number', ['number', 'number', 'number']);
	encodeSamples = module.cwrap(
		'encode_samples',
		'number',
		['number', 'number', 'number', 'number', 'number', 'number'],
	);
	flushLame = module.cwrap('flush_lame', 'number', ['number', 'number', 'number']);
	closeLame = module.cwrap('close_lame', null, ['number']);

	lamePtr = initLame(numberOfChannels, sampleRate, bitrate);
};

const reset = () => {
	closeLame(lamePtr);
	lamePtr = initLame(storedNumberOfChannels, storedSampleRate, storedBitrate);
};

const encode = (audioData: ArrayBuffer, numberOfFrames: number) => {
	if (needsReset) {
		reset();
		needsReset = false;
	}

	const audioBytes = new Uint8Array(audioData);
	const sizePerChannel = audioBytes.length / storedNumberOfChannels;

	inputSlice = maybeGrowSlice(inputSlice, audioBytes.length);
	module.HEAPU8.set(audioBytes, inputSlice.ptr);

	const requiredOutputSize = Math.ceil(1.25 * numberOfFrames + 7200);
	outputSlice = maybeGrowSlice(outputSlice, requiredOutputSize);

	const bytesWritten = encodeSamples(
		lamePtr,
		inputSlice.ptr,
		inputSlice.ptr + (storedNumberOfChannels - 1) * sizePerChannel,
		numberOfFrames,
		outputSlice.ptr,
		requiredOutputSize,
	);

	const result = module.HEAPU8.slice(outputSlice.ptr, outputSlice.ptr + bytesWritten);
	return result.buffer;
};

const flush = () => {
	if (needsReset) {
		reset();
		needsReset = false;
	}

	const requiredOutputSize = 7200;
	outputSlice = maybeGrowSlice(outputSlice, requiredOutputSize);

	const bytesWritten = flushLame(lamePtr, outputSlice.ptr, requiredOutputSize);

	const result = module.HEAPU8.slice(outputSlice.ptr, outputSlice.ptr + bytesWritten);
	needsReset = true; // After a flush, the encoder must be prepared to start a new encoding process

	return result.buffer;
};

/** A "fat pointer" type thing. */
type Slice = {
	ptr: number;
	size: number;
};

/** Either returns the existing slice, or allocates a new one if there's no existing slice or it was too small. */
const maybeGrowSlice = (slice: Slice | null, requiredSize: number) => {
	if (!slice || slice.size < requiredSize) {
		if (slice) {
			module._free(slice.ptr);
		}

		return {
			ptr: module._malloc(requiredSize),
			size: requiredSize,
		};
	}

	return slice;
};

const onMessage = (data: { id: number; command: WorkerCommand }) => {
	const { id, command } = data;

	const handleCommand = async (): Promise<void> => {
		try {
			let result: WorkerResponseData;
			const transferables: Transferable[] = [];

			switch (command.type) {
				case 'init': {
					await init(
						command.data.numberOfChannels,
						command.data.sampleRate,
						command.data.bitrate,
					);
					result = { success: true };
				}; break;

				case 'encode': {
					const encodedData = encode(
						command.data.audioData,
						command.data.numberOfFrames,
					);
					result = { encodedData };
					transferables.push(encodedData);
				}; break;

				case 'flush': {
					const flushedData = flush();
					result = { flushedData };
					transferables.push(flushedData);
				}; break;
			}

			const response: WorkerResponse = {
				id,
				success: true,
				data: result,
			};
			sendMessage(response, transferables);
		} catch (error) {
			const response: WorkerResponse = {
				id,
				success: false,
				error,
			};
			sendMessage(response);
		}
	};

	void handleCommand();
};

const sendMessage = (data: unknown, transferables?: Transferable[]) => {
	if (parentPort) {
		parentPort.postMessage(data, transferables ?? []);
	} else {
		self.postMessage(data, { transfer: transferables ?? [] });
	}
};

let parentPort: {
	postMessage: (data: unknown, transferables?: Transferable[]) => void;
	on: (event: string, listener: (data: never) => void) => void;
} | null = null;

if (typeof self === 'undefined') {
	// We're in Node.js (or a runtime that mimics it)
	const workerModule = 'worker_threads';
	// eslint-disable-next-line @stylistic/max-len
	// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
	parentPort = require(workerModule).parentPort;
}

if (parentPort) {
	parentPort.on('message', onMessage);
} else {
	self.addEventListener('message', event => onMessage(event.data as { id: number; command: WorkerCommand }));
}
