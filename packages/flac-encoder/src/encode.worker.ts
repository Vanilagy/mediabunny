/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import createModule from '../build/flac';
import type { PacketInfo, WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';

type ExtendedEmscriptenModule = EmscriptenModule & {
	cwrap: typeof cwrap;
};

let module: ExtendedEmscriptenModule;
let modulePromise: Promise<ExtendedEmscriptenModule> | null = null;

let initEncoderFn: (channels: number, sampleRate: number) => number;
let getEncodeInputPtr: (ctx: number, size: number) => number;
let sendSamplesFn: (ctx: number, numSamples: number) => number;
let getOutputData: (ctx: number) => number;
let getFrameCount: (ctx: number) => number;
let getFrameSize: (ctx: number, index: number) => number;
let getFrameSamples: (ctx: number, index: number) => number;
let getHeaderData: (ctx: number) => number;
let getHeaderSize: (ctx: number) => number;
let finishEncoderFn: (ctx: number) => number;

const ensureModule = async () => {
	if (!module) {
		if (modulePromise) {
			return modulePromise;
		}

		modulePromise = createModule() as Promise<ExtendedEmscriptenModule>;
		module = await modulePromise;
		modulePromise = null;

		initEncoderFn = module.cwrap('init_encoder', 'number', ['number', 'number']);
		getEncodeInputPtr = module.cwrap('get_encode_input_ptr', 'number', ['number', 'number']);
		sendSamplesFn = module.cwrap('send_samples', 'number', ['number', 'number']);
		getOutputData = module.cwrap('get_output_data', 'number', ['number']);
		getFrameCount = module.cwrap('get_frame_count', 'number', ['number']);
		getFrameSize = module.cwrap('get_frame_size', 'number', ['number', 'number']);
		getFrameSamples = module.cwrap('get_frame_samples', 'number', ['number', 'number']);
		getHeaderData = module.cwrap('get_header_data', 'number', ['number']);
		getHeaderSize = module.cwrap('get_header_size', 'number', ['number']);
		finishEncoderFn = module.cwrap('finish_encoder', 'number', ['number']);
	}
};

const initEncoder = async (numberOfChannels: number, sampleRate: number) => {
	await ensureModule();

	const ctx = initEncoderFn(numberOfChannels, sampleRate);
	if (ctx === 0) {
		throw new Error('Failed to initialize FLAC encoder.');
	}

	const headerPtr = getHeaderData(ctx);
	const headerSize = getHeaderSize(ctx);
	const header = module.HEAPU8.slice(headerPtr, headerPtr + headerSize).buffer;

	return { ctx, header };
};

const readPackets = (ctx: number) => {
	const packets: PacketInfo[] = [];
	const frameCount = getFrameCount(ctx);
	const outputPtr = getOutputData(ctx);

	let offset = 0;
	for (let i = 0; i < frameCount; i++) {
		const size = getFrameSize(ctx, i);
		const samples = getFrameSamples(ctx, i);
		const encodedData = module.HEAPU8.slice(outputPtr + offset, outputPtr + offset + size).buffer;
		packets.push({ encodedData, samples });
		offset += size;
	}

	return packets;
};

const encode = (ctx: number, audioData: ArrayBuffer, numSamples: number) => {
	const audioBytes = new Uint8Array(audioData);

	const inputPtr = getEncodeInputPtr(ctx, audioBytes.length);
	if (inputPtr === 0) {
		throw new Error('Failed to allocate encoder input buffer.');
	}
	module.HEAPU8.set(audioBytes, inputPtr);

	const ret = sendSamplesFn(ctx, numSamples);
	if (ret < 0) {
		throw new Error(`Encode failed with error code ${ret}.`);
	}

	return readPackets(ctx);
};

const flush = (ctx: number) => {
	const ret = finishEncoderFn(ctx);
	if (ret < 0) {
		throw new Error('Flush failed.');
	}

	return readPackets(ctx);
};

const onMessage = (data: { id: number; command: WorkerCommand }) => {
	const { id, command } = data;

	const handleCommand = async (): Promise<void> => {
		try {
			let result: WorkerResponseData;
			const transferables: Transferable[] = [];

			switch (command.type) {
				case 'init': {
					const { ctx, header } = await initEncoder(
						command.data.numberOfChannels,
						command.data.sampleRate,
					);
					result = { type: command.type, ctx, header };
					transferables.push(header);
				}; break;

				case 'encode': {
					const packets = encode(
						command.data.ctx,
						command.data.audioData,
						command.data.numSamples,
					);
					for (const p of packets) {
						transferables.push(p.encodedData);
					}
					result = { type: command.type, packets };
				}; break;

				case 'flush': {
					const packets = flush(command.data.ctx);
					for (const p of packets) {
						transferables.push(p.encodedData);
					}
					result = { type: command.type, packets };
				}; break;
			}

			const response: WorkerResponse = {
				id,
				success: true,
				data: result,
			};
			sendMessage(response, transferables);
		} catch (error: unknown) {
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
	const workerModule = 'worker_threads';
	// eslint-disable-next-line @stylistic/max-len
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
	parentPort = require(workerModule).parentPort;
}

if (parentPort) {
	parentPort.on('message', onMessage);
} else {
	self.addEventListener('message', event => onMessage(event.data as { id: number; command: WorkerCommand }));
}
