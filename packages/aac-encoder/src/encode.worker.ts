/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import createModule from '../build/aac';
import type { PacketInfo, WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';

type ExtendedEmscriptenModule = EmscriptenModule & {
	cwrap: typeof cwrap;
};

let module: ExtendedEmscriptenModule;
let modulePromise: Promise<ExtendedEmscriptenModule> | null = null;

let initEncoderFn: (channels: number, sampleRate: number, bitrate: number) => number;
let getEncoderFrameSize: (ctx: number) => number;
let getEncoderExtradata: (ctx: number) => number;
let getEncoderExtradataSize: (ctx: number) => number;
let getEncodeInputPtr: (ctx: number, size: number) => number;
let sendFrameFn: (ctx: number, pts: bigint) => number;
let receivePacketFn: (ctx: number) => number;
let flushEncoderStartFn: (ctx: number) => void;
let resetEncoderFn: (ctx: number) => void;
let getEncodedData: (ctx: number) => number;
let getEncodedPts: (ctx: number) => bigint;
let getEncodedDuration: (ctx: number) => number;
const ensureModule = async () => {
	if (!module) {
		if (modulePromise) {
			return modulePromise;
		}

		modulePromise = createModule() as Promise<ExtendedEmscriptenModule>;
		module = await modulePromise;
		modulePromise = null;

		initEncoderFn = module.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
		getEncoderFrameSize = module.cwrap('get_encoder_frame_size', 'number', ['number']);
		getEncoderExtradata = module.cwrap('get_encoder_extradata', 'number', ['number']);
		getEncoderExtradataSize = module.cwrap('get_encoder_extradata_size', 'number', ['number']);
		getEncodeInputPtr = module.cwrap('get_encode_input_ptr', 'number', ['number', 'number']);
		sendFrameFn = module.cwrap('send_frame', 'number', ['number', 'number']) as unknown as typeof sendFrameFn;
		receivePacketFn = module.cwrap('receive_packet', 'number', ['number']);
		flushEncoderStartFn = module.cwrap('flush_encoder_start', null, ['number']);
		resetEncoderFn = module.cwrap('reset_encoder', null, ['number']);
		getEncodedData = module.cwrap('get_encoded_data', 'number', ['number']);
		getEncodedPts = module.cwrap('get_encoded_pts', 'number', ['number']) as unknown as typeof getEncodedPts;
		getEncodedDuration = module.cwrap('get_encoded_duration', 'number', ['number']);
	}
};

const initEncoder = async (
	numberOfChannels: number,
	sampleRate: number,
	bitrate: number,
) => {
	await ensureModule();

	const ctx = initEncoderFn(numberOfChannels, sampleRate, bitrate);
	if (ctx === 0) {
		throw new Error('Failed to initialize AAC encoder.');
	}

	const frameSize = getEncoderFrameSize(ctx);

	const extradataPtr = getEncoderExtradata(ctx);
	const extradataSize = getEncoderExtradataSize(ctx);
	const extradata = module.HEAPU8.slice(extradataPtr, extradataPtr + extradataSize).buffer;

	return { ctx, frameSize, extradata };
};

const drainPackets = (ctx: number) => {
	const packets: PacketInfo[] = [];

	let size: number;
	while ((size = receivePacketFn(ctx)) > 0) {
		const ptr = getEncodedData(ctx);
		const encodedData = module.HEAPU8.slice(ptr, ptr + size).buffer;
		const pts = Number(getEncodedPts(ctx));
		const duration = getEncodedDuration(ctx);
		packets.push({ encodedData, pts, duration });
	}

	return packets;
};

const encode = (ctx: number, audioData: ArrayBuffer, timestamp: number) => {
	const audioBytes = new Uint8Array(audioData);

	const inputPtr = getEncodeInputPtr(ctx, audioBytes.length);
	if (inputPtr === 0) {
		throw new Error('Failed to allocate encoder input buffer.');
	}
	module.HEAPU8.set(audioBytes, inputPtr);

	const ret = sendFrameFn(ctx, BigInt(timestamp));
	if (ret < 0) {
		throw new Error(`Encode failed with error code ${ret}.`);
	}

	return drainPackets(ctx);
};

const onMessage = (data: { id: number; command: WorkerCommand }) => {
	const { id, command } = data;

	const handleCommand = async (): Promise<void> => {
		try {
			let result: WorkerResponseData;
			const transferables: Transferable[] = [];

			switch (command.type) {
				case 'init': {
					const { ctx, frameSize, extradata } = await initEncoder(
						command.data.numberOfChannels,
						command.data.sampleRate,
						command.data.bitrate,
					);
					result = { type: command.type, ctx, frameSize, extradata };
					transferables.push(extradata);
				}; break;

				case 'encode': {
					const packets = encode(
						command.data.ctx,
						command.data.audioData,
						command.data.timestamp,
					);
					for (const p of packets) {
						transferables.push(p.encodedData);
					}
					result = { type: command.type, packets };
				}; break;

				case 'flush': {
					flushEncoderStartFn(command.data.ctx);
					const packets = drainPackets(command.data.ctx);
					for (const p of packets) {
						transferables.push(p.encodedData);
					}
					resetEncoderFn(command.data.ctx);
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
