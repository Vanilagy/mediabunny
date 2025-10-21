/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getXvidModule, type ExtendedEmscriptenModule } from './xvid-loader';

type EncoderState = number;

let module: ExtendedEmscriptenModule;
let encoderState: EncoderState;
let width: number;
let height: number;

let initEncoder: (width: number, height: number, bitrate: number, fpsNum: number, fpsDen: number) => EncoderState;
let encodeFrame: (
	state: EncoderState,
	yuvPtr: number,
	outputPtr: number,
	outputSize: number,
	forceKeyframe: number
) => number;
let closeEncoder: (state: EncoderState) => void;

let inputSlice: Slice | null = null;
let outputSlice: Slice | null = null;

const init = async (w: number, h: number, bitrate: number, fpsNum: number, fpsDen: number) => {
	width = w;
	height = h;

	module = await getXvidModule();

	initEncoder = module.cwrap('init_encoder', 'number', ['number', 'number', 'number', 'number', 'number']);
	encodeFrame = module.cwrap('encode_frame', 'number', ['number', 'number', 'number', 'number', 'number']);
	closeEncoder = module.cwrap('close_encoder', null, ['number']);

	encoderState = initEncoder(width, height, bitrate, fpsNum, fpsDen);
	if (!encoderState) {
		throw new Error('Failed to initialize Xvid encoder');
	}
};

const encode = (yuvData: ArrayBuffer, forceKeyframe: boolean) => {
	const yuvBytes = new Uint8Array(yuvData);

	inputSlice = maybeGrowSlice(inputSlice, yuvBytes.length);
	module.HEAPU8.set(yuvBytes, inputSlice.ptr);

	const maxOutputSize = width * height * 2;
	outputSlice = maybeGrowSlice(outputSlice, maxOutputSize);

	const encodedSize = encodeFrame(
		encoderState,
		inputSlice.ptr,
		outputSlice.ptr,
		maxOutputSize,
		forceKeyframe ? 1 : 0,
	);

	if (encodedSize < 0) {
		throw new Error(`Xvid encode error: ${encodedSize}`);
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

type WorkerCommand =
	| { type: 'init'; data: { width: number; height: number; bitrate: number; fpsNum: number; fpsDen: number } }
	| { type: 'encode'; data: { yuvData: ArrayBuffer; forceKeyframe: boolean } }
	| { type: 'close' };

type WorkerResponseData =
	| { encodedData: ArrayBuffer }
	| { closed: true }
	| null;

type WorkerResponse = {
	id: number;
	success: boolean;
	data: WorkerResponseData;
	error?: Error;
};

const onMessage = async (data: { id: number; command: WorkerCommand }) => {
	let responseData: WorkerResponseData;
	let success = true;
	let error: Error | undefined;

	try {
		const { command } = data;

		if (command.type === 'init') {
			await init(command.data.width, command.data.height, command.data.bitrate, command.data.fpsNum, command.data.fpsDen);
			responseData = null;
		} else if (command.type === 'encode') {
			responseData = encode(command.data.yuvData, command.data.forceKeyframe);
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
