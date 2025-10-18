/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getXvidModule, type ExtendedEmscriptenModule } from './xvid-loader';
import type { WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';

type DecoderState = number;

let module: ExtendedEmscriptenModule;
let decoderState: DecoderState;
let width: number;
let height: number;

let initDecoder: (width: number, height: number) => DecoderState;
let decodeFrame: (
	state: DecoderState,
	inputPtr: number,
	inputSize: number,
	outputPtr: number,
	outTypePtr: number,
	outWidthPtr: number,
	outHeightPtr: number
) => number;
let closeDecoder: (state: DecoderState) => void;

let inputSlice: Slice | null = null;
let outputSlice: Slice | null = null;

const init = async (w: number, h: number) => {
	width = w;
	height = h;

	module = await getXvidModule();

	initDecoder = module.cwrap('init_decoder', 'number', ['number', 'number']);
	decodeFrame = module.cwrap('decode_frame', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
	closeDecoder = module.cwrap('close_decoder', null, ['number']);

	decoderState = initDecoder(width, height);
	if (!decoderState) {
		throw new Error('Failed to initialize Xvid decoder');
	}
};

const decode = (frameData: ArrayBuffer) => {
	const frameBytes = new Uint8Array(frameData);

	inputSlice = maybeGrowSlice(inputSlice, frameBytes.length);
	module.HEAPU8.set(frameBytes, inputSlice.ptr);

	let bytesConsumed = 0;
	let lastValidFrame: { yuvData: ArrayBuffer; width: number; height: number } | null = null;

	while (bytesConsumed < frameBytes.length) {
		const typePtr = module._malloc(4);
		const widthPtr = module._malloc(4);
		const heightPtr = module._malloc(4);

		const yuvSize = Math.max(width * height * 3 / 2, 1024);
		outputSlice = maybeGrowSlice(outputSlice, yuvSize);

		const ret = decodeFrame(
			decoderState,
			inputSlice.ptr + bytesConsumed,
			frameBytes.length - bytesConsumed,
			outputSlice.ptr,
			typePtr,
			widthPtr,
			heightPtr,
		);

		const frameType = new DataView(module.HEAPU8.buffer, typePtr, 4).getInt32(0, true);
		const decodedWidth = new DataView(module.HEAPU8.buffer, widthPtr, 4).getInt32(0, true);
		const decodedHeight = new DataView(module.HEAPU8.buffer, heightPtr, 4).getInt32(0, true);

		module._free(typePtr);
		module._free(widthPtr);
		module._free(heightPtr);

		if (decodedWidth > 0 && decodedHeight > 0) {
			width = decodedWidth;
			height = decodedHeight;
		}

		if (ret <= 0) break;

		bytesConsumed += ret;

		if (frameType > 0) {
			const finalYuvSize = width * height * 3 / 2;
			const yuvData = module.HEAPU8.slice(outputSlice.ptr, outputSlice.ptr + finalYuvSize).buffer;
			lastValidFrame = { yuvData, width, height };
		}
	}

	return lastValidFrame;
};

const flush = () => {
	return { flushed: true };
};

const close = () => {
	if (decoderState) {
		closeDecoder(decoderState);
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

const onMessage = async (data: { id: number; command: WorkerCommand }) => {
	let responseData: WorkerResponseData;
	let success = true;
	let error: Error | undefined;

	try {
		const { command } = data;

		if (command.type === 'init') {
			await init(command.data.width, command.data.height);
			responseData = null;
		} else if (command.type === 'decode') {
			responseData = decode(command.data.frameData);
		} else if (command.type === 'flush') {
			flush();
			responseData = { flushed: true as const };
		} else if (command.type === 'close') {
			close();
			responseData = { closed: true as const };
		} else {
			throw new Error('Unknown command type.');
		}
	} catch (e) {
		success = false;
		error = e as Error;
		responseData = { flushed: true };
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
