/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import createModule from '../build/ac3';
import type { WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';

type ExtendedEmscriptenModule = EmscriptenModule & {
	cwrap: typeof cwrap;
};

let module: ExtendedEmscriptenModule;
let modulePromise: Promise<ExtendedEmscriptenModule> | null = null;

let initDecoderFn: (codecId: number) => number;
let configureDecodePacket: (ctx: number, size: number) => number;
let decodePacket: (ctx: number, pts: number) => number;
let getDecodedFormat: (ctx: number) => number;
let getDecodedPlanePtr: (ctx: number, plane: number) => number;
let getDecodedChannels: (ctx: number) => number;
let getDecodedSampleRate: (ctx: number) => number;
let getDecodedSampleCount: (ctx: number) => number;
let getDecodedPts: (ctx: number) => number;
let flushDecoderFn: (ctx: number) => void;
let closeDecoderFn: (ctx: number) => void;

let initEncoderFn: (codecId: number, channels: number, sampleRate: number, bitrate: number) => number;
let getEncoderFrameSize: (ctx: number) => number;
let getEncodeInputPtr: (ctx: number, size: number) => number;
let encodeFrameFn: (ctx: number, pts: number) => number;
let flushEncoderFn: (ctx: number) => void;
let getEncodedData: (ctx: number) => number;
let getEncodedPts: (ctx: number) => number;
let getEncodedDuration: (ctx: number) => number;
let closeEncoderFn: (ctx: number) => void;

const codecToId = (codec: string) => codec === 'ac3' ? 0 : 1;

const ensureModule = async () => {
	if (!module) {
		if (modulePromise) {
			// If we don't do this we can have a race condition
			return modulePromise;
		}

		modulePromise = createModule() as Promise<ExtendedEmscriptenModule>;
		module = await modulePromise;
		modulePromise = null;

		initDecoderFn = module.cwrap('init_decoder', 'number', ['number']);
		configureDecodePacket = module.cwrap('configure_decode_packet', 'number', ['number', 'number']);
		decodePacket = module.cwrap('decode_packet', 'number', ['number', 'number']);
		getDecodedFormat = module.cwrap('get_decoded_format', 'number', ['number']);
		getDecodedPlanePtr = module.cwrap('get_decoded_plane_ptr', 'number', ['number', 'number']);
		getDecodedChannels = module.cwrap('get_decoded_channels', 'number', ['number']);
		getDecodedSampleRate = module.cwrap('get_decoded_sample_rate', 'number', ['number']);
		getDecodedSampleCount = module.cwrap('get_decoded_sample_count', 'number', ['number']);
		getDecodedPts = module.cwrap('get_decoded_pts', 'number', ['number']);
		flushDecoderFn = module.cwrap('flush_decoder', null, ['number']);
		closeDecoderFn = module.cwrap('close_decoder', null, ['number']);

		initEncoderFn = module.cwrap('init_encoder', 'number', ['number', 'number', 'number', 'number']);
		getEncoderFrameSize = module.cwrap('get_encoder_frame_size', 'number', ['number']);
		getEncodeInputPtr = module.cwrap('get_encode_input_ptr', 'number', ['number', 'number']);
		encodeFrameFn = module.cwrap('encode_frame', 'number', ['number', 'number']);
		flushEncoderFn = module.cwrap('flush_encoder', null, ['number']);
		getEncodedData = module.cwrap('get_encoded_data', 'number', ['number']);
		getEncodedPts = module.cwrap('get_encoded_pts', 'number', ['number']);
		getEncodedDuration = module.cwrap('get_encoded_duration', 'number', ['number']);
		closeEncoderFn = module.cwrap('close_encoder', null, ['number']);
	}
};

const initDecoder = async (codec: string) => {
	await ensureModule();

	const ctx = initDecoderFn(codecToId(codec));
	if (ctx === 0) {
		throw new Error('Failed to initialize AC3 decoder.');
	}

	return { ctx, frameSize: 0 };
};

// Keys are AVSampleFormat enum values
const AV_FORMAT_MAP: Record<number, { format: AudioSampleFormat; bytesPerSample: number; planar: boolean }> = {
	0: { format: 'u8', bytesPerSample: 1, planar: false },
	1: { format: 's16', bytesPerSample: 2, planar: false },
	2: { format: 's32', bytesPerSample: 4, planar: false },
	3: { format: 'f32', bytesPerSample: 4, planar: false },
	5: { format: 'u8-planar', bytesPerSample: 1, planar: true },
	6: { format: 's16-planar', bytesPerSample: 2, planar: true },
	7: { format: 's32-planar', bytesPerSample: 4, planar: true },
	8: { format: 'f32-planar', bytesPerSample: 4, planar: true },
};

const decode = (ctx: number, encodedData: ArrayBuffer, timestamp: number) => {
	const bytes = new Uint8Array(encodedData);

	const dataPtr = configureDecodePacket(ctx, bytes.length);
	if (dataPtr === 0) {
		throw new Error('Failed to configure decode packet.');
	}

	module.HEAPU8.set(bytes, dataPtr);

	const ret = decodePacket(ctx, timestamp);
	if (ret < 0) {
		throw new Error(`Decode failed with error code ${ret}.`);
	}

	const avFormat = getDecodedFormat(ctx);
	const info = AV_FORMAT_MAP[avFormat];
	if (!info) {
		throw new Error(`Unsupported AVSampleFormat: ${avFormat}`);
	}

	const channels = getDecodedChannels(ctx);
	const sampleRate = getDecodedSampleRate(ctx);
	const sampleCount = getDecodedSampleCount(ctx);
	const pts = getDecodedPts(ctx);

	let pcmData: ArrayBuffer;
	if (info.planar) {
		const planeSize = sampleCount * info.bytesPerSample;
		const buffer = new Uint8Array(planeSize * channels);

		for (let ch = 0; ch < channels; ch++) {
			const ptr = getDecodedPlanePtr(ctx, ch);
			buffer.set(module.HEAPU8.subarray(ptr, ptr + planeSize), ch * planeSize);
		}

		pcmData = buffer.buffer;
	} else {
		const totalSize = sampleCount * channels * info.bytesPerSample;
		const ptr = getDecodedPlanePtr(ctx, 0);
		pcmData = module.HEAPU8.slice(ptr, ptr + totalSize).buffer;
	}

	return { pcmData, format: info.format, channels, sampleRate, sampleCount, pts };
};

const initEncoder = async (
	codec: string,
	numberOfChannels: number,
	sampleRate: number,
	bitrate: number,
) => {
	await ensureModule();

	const ctx = initEncoderFn(codecToId(codec), numberOfChannels, sampleRate, bitrate);
	if (ctx === 0) {
		throw new Error('Failed to initialize AC3 encoder.');
	}

	return { ctx, frameSize: getEncoderFrameSize(ctx) };
};

const encode = (ctx: number, audioData: ArrayBuffer, timestamp: number) => {
	const audioBytes = new Uint8Array(audioData);

	const inputPtr = getEncodeInputPtr(ctx, audioBytes.length);
	if (inputPtr === 0) {
		throw new Error('Failed to allocate encoder input buffer.');
	}
	module.HEAPU8.set(audioBytes, inputPtr);

	const bytesWritten = encodeFrameFn(ctx, timestamp);
	if (bytesWritten < 0) {
		throw new Error(`Encode failed with error code ${bytesWritten}.`);
	}

	const ptr = getEncodedData(ctx);
	const encodedData = module.HEAPU8.slice(ptr, ptr + bytesWritten).buffer;
	const pts = getEncodedPts(ctx);
	const duration = getEncodedDuration(ctx);

	return { encodedData, pts, duration };
};

const flushEncoder = (ctx: number) => {
	flushEncoderFn(ctx);
};

const onMessage = (data: { id: number; command: WorkerCommand }) => {
	const { id, command } = data;

	const handleCommand = async (): Promise<void> => {
		try {
			let result: WorkerResponseData;
			const transferables: Transferable[] = [];

			switch (command.type) {
				case 'init-decoder': {
					const { ctx, frameSize } = await initDecoder(command.data.codec);
					result = { type: command.type, ctx, frameSize };
				}; break;

				case 'decode': {
					const decoded = decode(command.data.ctx, command.data.encodedData, command.data.timestamp);
					result = {
						type: command.type,
						pcmData: decoded.pcmData,
						format: decoded.format,
						channels: decoded.channels,
						sampleRate: decoded.sampleRate,
						sampleCount: decoded.sampleCount,
						pts: decoded.pts,
					};
					transferables.push(decoded.pcmData);
				}; break;

				case 'flush-decoder': {
					flushDecoderFn(command.data.ctx);
					result = { type: command.type };
				}; break;

				case 'close-decoder': {
					closeDecoderFn(command.data.ctx);
					result = { type: command.type };
				}; break;

				case 'init-encoder': {
					const { ctx, frameSize } = await initEncoder(
						command.data.codec,
						command.data.numberOfChannels,
						command.data.sampleRate,
						command.data.bitrate,
					);
					result = { type: command.type, ctx, frameSize };
				}; break;

				case 'encode': {
					const encoded = encode(
						command.data.ctx,
						command.data.audioData,
						command.data.timestamp,
					);
					result = {
						type: command.type,
						encodedData: encoded.encodedData,
						pts: encoded.pts,
						duration: encoded.duration,
					};
					transferables.push(encoded.encodedData);
				}; break;

				case 'flush-encoder': {
					flushEncoder(command.data.ctx);
					result = { type: command.type };
				}; break;

				case 'close-encoder': {
					closeEncoderFn(command.data.ctx);
					result = { type: command.type };
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
