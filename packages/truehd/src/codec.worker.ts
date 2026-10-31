/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import createModule from '../build/truehd';
import type { DecodedChunk, EncodedChunk, WorkerCommand, WorkerResponse, WorkerResponseData } from './shared';

type ExtendedEmscriptenModule = EmscriptenModule & {
	cwrap: typeof cwrap;
};

let module: ExtendedEmscriptenModule;
let modulePromise: Promise<ExtendedEmscriptenModule> | null = null;

let initDecoderFn: () => number;
let configureDecodePacket: (ctx: number, size: number) => number;
let sendDecodePacket: (ctx: number, pts: bigint) => number;
let receiveDecodedFrame: (ctx: number) => number;
let getDecodedFormat: (ctx: number) => number;
let getDecodedPlanePtr: (ctx: number, plane: number) => number;
let getDecodedChannels: (ctx: number) => number;
let getDecodedSampleRate: (ctx: number) => number;
let getDecodedSampleCount: (ctx: number) => number;
let getDecodedPts: (ctx: number) => bigint;
let flushDecoderFn: (ctx: number) => void;
let closeDecoderFn: (ctx: number) => void;

let initEncoderFn: (channels: number, sampleRate: number) => number;
let getEncoderFrameSize: (ctx: number) => number;
let getEncodeInputPtr: (ctx: number, size: number) => number;
let sendEncodeFrame: (ctx: number, offset: number, sampleCount: number, pts: bigint) => number;
let sendEncodeFlush: (ctx: number) => number;
let receiveEncodedPacket: (ctx: number) => number;
let getEncodedData: (ctx: number) => number;
let getEncodedPts: (ctx: number) => bigint;
let getEncodedDuration: (ctx: number) => number;
let closeEncoderFn: (ctx: number) => void;

const ensureModule = async () => {
	if (!module) {
		if (modulePromise) {
			// If we don't do this we can have a race condition
			return modulePromise;
		}

		modulePromise = createModule() as Promise<ExtendedEmscriptenModule>;
		module = await modulePromise;
		modulePromise = null;

		initDecoderFn = module.cwrap('init_decoder', 'number', []);
		configureDecodePacket = module.cwrap('configure_decode_packet', 'number', ['number', 'number']);
		sendDecodePacket = module.cwrap(
			'send_decode_packet',
			'number',
			['number', 'number'],
		) as unknown as typeof sendDecodePacket;
		receiveDecodedFrame = module.cwrap('receive_decoded_frame', 'number', ['number']);
		getDecodedFormat = module.cwrap('get_decoded_format', 'number', ['number']);
		getDecodedPlanePtr = module.cwrap('get_decoded_plane_ptr', 'number', ['number', 'number']);
		getDecodedChannels = module.cwrap('get_decoded_channels', 'number', ['number']);
		getDecodedSampleRate = module.cwrap('get_decoded_sample_rate', 'number', ['number']);
		getDecodedSampleCount = module.cwrap('get_decoded_sample_count', 'number', ['number']);
		getDecodedPts = module.cwrap('get_decoded_pts', 'number', ['number']) as unknown as typeof getDecodedPts;
		flushDecoderFn = module.cwrap('flush_decoder', null, ['number']);
		closeDecoderFn = module.cwrap('close_decoder', null, ['number']);

		initEncoderFn = module.cwrap('init_encoder', 'number', ['number', 'number']);
		getEncoderFrameSize = module.cwrap('get_encoder_frame_size', 'number', ['number']);
		getEncodeInputPtr = module.cwrap('get_encode_input_ptr', 'number', ['number', 'number']);
		sendEncodeFrame = module.cwrap(
			'send_encode_frame',
			'number',
			['number', 'number', 'number', 'number'],
		) as unknown as typeof sendEncodeFrame;
		sendEncodeFlush = module.cwrap('send_encode_flush', 'number', ['number']);
		receiveEncodedPacket = module.cwrap('receive_encoded_packet', 'number', ['number']);
		getEncodedData = module.cwrap('get_encoded_data', 'number', ['number']);
		getEncodedPts = module.cwrap('get_encoded_pts', 'number', ['number']) as unknown as typeof getEncodedPts;
		getEncodedDuration = module.cwrap('get_encoded_duration', 'number', ['number']);
		closeEncoderFn = module.cwrap('close_encoder', null, ['number']);
	}
};

const initDecoder = async () => {
	await ensureModule();

	const ctx = initDecoderFn();
	if (ctx === 0) {
		throw new Error('Failed to initialize TrueHD decoder.');
	}

	return { ctx };
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

const decode = (ctx: number, packets: { encodedData: ArrayBuffer; timestamp: number }[]) => {
	const chunks: DecodedChunk[] = [];

	for (const packet of packets) {
		const bytes = new Uint8Array(packet.encodedData);

		const dataPtr = configureDecodePacket(ctx, bytes.length);
		if (dataPtr === 0) {
			throw new Error('Failed to configure decode packet.');
		}

		module.HEAPU8.set(bytes, dataPtr);

		const sendRet = sendDecodePacket(ctx, BigInt(packet.timestamp));
		if (sendRet < 0) {
			throw new Error(`Decode failed with error code ${sendRet}.`);
		}

		while (true) {
			const receiveRet = receiveDecodedFrame(ctx);
			if (receiveRet < 0) {
				throw new Error(`Decode failed with error code ${receiveRet}.`);
			}
			if (receiveRet === 0) {
				break;
			}

			const avFormat = getDecodedFormat(ctx);
			const info = AV_FORMAT_MAP[avFormat];
			if (!info) {
				throw new Error(`Unsupported AVSampleFormat: ${avFormat}`);
			}

			const channels = getDecodedChannels(ctx);
			const sampleRate = getDecodedSampleRate(ctx);
			const sampleCount = getDecodedSampleCount(ctx);
			const pts = Number(getDecodedPts(ctx));

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

			chunks.push({
				pcmData,
				format: info.format,
				channels,
				sampleRate,
				sampleCount,
				pts,
			});
		}
	}

	return chunks;
};

const initEncoder = async (
	numberOfChannels: number,
	sampleRate: number,
) => {
	await ensureModule();

	const ctx = initEncoderFn(numberOfChannels, sampleRate);
	if (ctx === 0) {
		throw new Error('Failed to initialize TrueHD encoder.');
	}

	return { ctx, frameSize: getEncoderFrameSize(ctx) };
};

const encode = (ctx: number, audioData: ArrayBuffer, sampleCount: number, timestamp: number) => {
	const audioBytes = new Uint8Array(audioData);

	const inputPtr = getEncodeInputPtr(ctx, audioBytes.length);
	if (inputPtr === 0) {
		throw new Error('Failed to allocate encoder input buffer.');
	}
	module.HEAPU8.set(audioBytes, inputPtr);

	const frameSize = getEncoderFrameSize(ctx);
	const packets: EncodedChunk[] = [];

	for (let offset = 0; offset < sampleCount; offset += frameSize) {
		const frameSampleCount = Math.min(frameSize, sampleCount - offset);

		const ret = sendEncodeFrame(ctx, offset, frameSampleCount, BigInt(timestamp + offset));
		if (ret < 0) {
			throw new Error(`Encode failed with error code ${ret}.`);
		}

		receiveEncodedPackets(ctx, packets);
	}

	return packets;
};

const flushEncoder = (ctx: number) => {
	const ret = sendEncodeFlush(ctx);
	if (ret < 0) {
		throw new Error(`Encoder flush failed with error code ${ret}.`);
	}

	// Unlike most encoders, this one holds back whole major frames, so draining it yields actual packets
	const packets: EncodedChunk[] = [];
	receiveEncodedPackets(ctx, packets);

	return packets;
};

const receiveEncodedPackets = (ctx: number, packets: EncodedChunk[]) => {
	while (true) {
		const size = receiveEncodedPacket(ctx);
		if (size < 0) {
			throw new Error(`Encode failed with error code ${size}.`);
		}
		if (size === 0) {
			break;
		}

		const ptr = getEncodedData(ctx);
		packets.push({
			encodedData: module.HEAPU8.slice(ptr, ptr + size).buffer,
			pts: Number(getEncodedPts(ctx)),
			duration: getEncodedDuration(ctx),
		});
	}
};

const onMessage = (data: { id: number; command: WorkerCommand }) => {
	const { id, command } = data;

	const handleCommand = async (): Promise<void> => {
		try {
			let result: WorkerResponseData;
			const transferables: Transferable[] = [];

			switch (command.type) {
				case 'init-decoder': {
					const { ctx } = await initDecoder();
					result = { type: command.type, ctx };
				}; break;

				case 'decode': {
					const chunks = decode(command.data.ctx, command.data.packets);
					result = { type: command.type, chunks };
					transferables.push(...chunks.map(x => x.pcmData));
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
						command.data.numberOfChannels,
						command.data.sampleRate,
					);
					result = { type: command.type, ctx, frameSize };
				}; break;

				case 'encode': {
					const packets = encode(
						command.data.ctx,
						command.data.audioData,
						command.data.sampleCount,
						command.data.timestamp,
					);
					result = { type: command.type, packets };
					transferables.push(...packets.map(x => x.encodedData));
				}; break;

				case 'flush-encoder': {
					const packets = flushEncoder(command.data.ctx);
					result = { type: command.type, packets };
					transferables.push(...packets.map(x => x.encodedData));
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

try {
	// We're in Node.js (or a runtime that mimics it)
	const workerModule = 'worker_threads';
	// eslint-disable-next-line @stylistic/max-len
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
	parentPort = require(workerModule).parentPort;
} catch {
	// Web worker (browser, Deno), no require available
}

if (parentPort) {
	parentPort.on('message', onMessage);
} else {
	self.addEventListener('message', event => onMessage(event.data as { id: number; command: WorkerCommand }));
}

// Prevents the worker for being randomly closed by Firefox
// https://github.com/Vanilagy/mediabunny/issues/435
setInterval(() => {}, 1000);
