/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getEac3Module, type ExtendedEmscriptenModule } from './eac3-loader';
import type { EncoderCommand, EncoderResponseData, WorkerResponse } from './shared';

type EncoderState = number;

const AV_CODEC_ID_AC3 = 0x15003;
const AV_CODEC_ID_EAC3 = 0x15028;

let module: ExtendedEmscriptenModule;
let encoderState: EncoderState;
let width: number;
let height: number;

let initEncoder: (codecId: number, sampleRate: number, channels: number, bitrate: number) => EncoderState;
let encodeSamples: (
	state: EncoderState,
	inputPtr: number,
	numFrames: number,
	outputPtr: number,
	outputSize: number
) => number;
let closeEncoder: (state: EncoderState) => void;

let inputSlice: Slice | null = null;
let outputSlice: Slice | null = null;

const init = async (sampleRate: number, channels: number, bitrate: number, codec: 'eac3' | 'ac3') => {
	module = await getEac3Module();

	initEncoder = module.cwrap('init_encoder', 'number', ['number', 'number', 'number', 'number']);
	encodeSamples = module.cwrap('encode_samples', 'number', ['number', 'number', 'number', 'number', 'number']);
	closeEncoder = module.cwrap('close_encoder', null, ['number']);

	const codecId = codec === 'eac3' ? AV_CODEC_ID_EAC3 : AV_CODEC_ID_AC3;
	encoderState = initEncoder(codecId, sampleRate, channels, bitrate);

	if (!encoderState) {
		throw new Error('Failed to initialize E-AC-3/AC-3 encoder');
	}
};

const encode = (pcmData: ArrayBuffer, numberOfFrames: number) => {
	const pcmBytes = new Float32Array(pcmData);

	inputSlice = maybeGrowSlice(inputSlice, pcmBytes.byteLength);
	module.HEAPF32.set(pcmBytes, inputSlice.ptr / 4);

	const maxOutputSize = numberOfFrames * 10;
	outputSlice = maybeGrowSlice(outputSlice, maxOutputSize);

	const encodedSize = encodeSamples(
		encoderState,
		inputSlice.ptr,
		numberOfFrames,
		outputSlice.ptr,
		maxOutputSize,
	);

	if (encodedSize < 0) {
		throw new Error(`E-AC-3 encode error: ${encodedSize}`);
	}

	const encodedData = module.HEAPU8.slice(outputSlice.ptr, outputSlice.ptr + encodedSize).buffer;

	return { encodedData };
};

const close = () => {
	if (encoderState) {
		closeEncoder(encoderState);
	}
	return { closed: true };
};

type Slice = { ptr: number; size: number };

const maybeGrowSlice = (slice: Slice | null, requiredSize: number) => {
	if (!slice || slice.size < requiredSize) {
		if (slice) {
			module._free(slice.ptr);
		}

		const newSize = 1 << Math.ceil(Math.log2(requiredSize));
		return {
			ptr: module._malloc(newSize),
			size: newSize,
		};
	}

	return slice;
};

const onMessage = async (data: { id: number; command: EncoderCommand }) => {
	let responseData: EncoderResponseData;
	let success = true;
	let error: Error | undefined;

	try {
		const { command } = data;

		if (command.type === 'init') {
			await init(command.data.sampleRate, command.data.channels, command.data.bitrate, command.data.codec);
			responseData = null;
		} else if (command.type === 'encode') {
			responseData = encode(command.data.pcmData, command.data.numberOfFrames);
		} else if (command.type === 'close') {
			close();
			responseData = { closed: true as const };
		} else {
			throw new Error('Unknown command type.');
		}
	} catch (e) {
		success = false;
		error = e as Error;
		responseData = { closed: true };
	}

	const response: WorkerResponse = {
		id: data.id,
		success,
		data: responseData,
		error,
	};

	if (parentPort) {
		parentPort.postMessage(response);
	} else {
		self.postMessage(response);
	}
};

let parentPort: {
	postMessage: (data: unknown, transferables?: Transferable[]) => void;
	on: (event: string, listener: (data: never) => void) => void;
} | null = null;

if (typeof self === 'undefined') {
	const workerModule = 'worker_threads';
	// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
	parentPort = require(workerModule).parentPort;
}

if (parentPort) {
	parentPort.on('message', onMessage);
} else {
	self.addEventListener('message', event => void onMessage(event.data as never));
}
