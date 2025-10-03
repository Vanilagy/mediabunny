/*!
 * Copyright (c) 2025-present, Vanilagy and contributors (Wiedy Mi)
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getEac3Module, type ExtendedEmscriptenModule } from './eac3-loader';
import type { DecoderCommand, DecoderResponseData, WorkerResponse } from './shared';

type DecoderState = number;

const AV_CODEC_ID_AC3 = 0x15003;
const AV_CODEC_ID_EAC3 = 0x15028;

let module: ExtendedEmscriptenModule;
let decoderState: DecoderState;
let sampleRate: number;
let channels: number;

let initDecoder: (codecId: number, sampleRate: number, channels: number) => DecoderState;
let decodePacket: (
	state: DecoderState,
	inputPtr: number,
	inputSize: number,
	outputPtr: number,
	outFramesPtr: number,
	outSampleRatePtr: number,
	outChannelsPtr: number
) => number;
let flushDecoder: (state: DecoderState) => void;
let closeDecoder: (state: DecoderState) => void;

let inputSlice: Slice | null = null;
let outputSlice: Slice | null = null;

const init = async (sr: number, ch: number, codec: 'eac3' | 'ac3') => {
	sampleRate = sr;
	channels = ch;

	module = await getEac3Module();

	initDecoder = module.cwrap('init_decoder', 'number', ['number', 'number', 'number']);
	decodePacket = module.cwrap('decode_packet', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
	flushDecoder = module.cwrap('flush_decoder', null, ['number']);
	closeDecoder = module.cwrap('close_decoder', null, ['number']);

	const codecId = codec === 'eac3' ? AV_CODEC_ID_EAC3 : AV_CODEC_ID_AC3;
	decoderState = initDecoder(codecId, sampleRate, channels);

	if (!decoderState) {
		throw new Error('Failed to initialize E-AC-3/AC-3 decoder');
	}
};

const decode = (packetData: ArrayBuffer) => {
	const packetBytes = new Uint8Array(packetData);

	inputSlice = maybeGrowSlice(inputSlice, packetBytes.length);
	module.HEAPU8.set(packetBytes, inputSlice.ptr);

	const maxSamples = 6144 * channels;
	outputSlice = maybeGrowSlice(outputSlice, maxSamples * 4);

	const framesPtr = module._malloc(4);
	const srPtr = module._malloc(4);
	const chPtr = module._malloc(4);

	const ret = decodePacket(
		decoderState,
		inputSlice.ptr,
		packetBytes.length,
		outputSlice.ptr,
		framesPtr,
		srPtr,
		chPtr,
	);

	const numberOfFrames = new DataView(module.HEAPU8.buffer, framesPtr, 4).getInt32(0, true);
	const outSampleRate = new DataView(module.HEAPU8.buffer, srPtr, 4).getInt32(0, true);
	const outChannels = new DataView(module.HEAPU8.buffer, chPtr, 4).getInt32(0, true);

	module._free(framesPtr);
	module._free(srPtr);
	module._free(chPtr);

	if (ret < 0) {
		return null;
	}

	if (numberOfFrames <= 0) {
		return null;
	}

	// Validate the output parameters
	if (outSampleRate <= 0 || outChannels <= 0) {
		return null;
	}

	const pcmSize = numberOfFrames * outChannels * 4;
	const pcmData = module.HEAPF32.slice(outputSlice.ptr / 4, outputSlice.ptr / 4 + numberOfFrames * outChannels).buffer;

	return { pcmData, numberOfFrames, sampleRate: outSampleRate, channels: outChannels };
};

const flush = () => {
	if (decoderState) {
		flushDecoder(decoderState);
	}
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

const onMessage = async (data: { id: number; command: DecoderCommand }) => {
	let responseData: DecoderResponseData;
	let success = true;
	let error: Error | undefined;

	try {
		const { command } = data;

		if (command.type === 'init') {
			await init(command.data.sampleRate, command.data.channels, command.data.codec);
			responseData = null;
		} else if (command.type === 'decode') {
			responseData = decode(command.data.packetData);
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
