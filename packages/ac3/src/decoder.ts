/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	CustomAudioDecoder,
	AudioCodec,
	AudioSample,
	EncodedPacket,
	registerDecoder,
} from 'mediabunny';
import { sendCommand, refWorker, unrefWorker } from './worker-client';
import { assert, type DecodedChunk } from './shared';

class Ac3Decoder extends CustomAudioDecoder {
	private ctx = 0;
	private nextTimestamp: number | null = null;
	private inFlightDecode: Promise<void> | null = null;

	static override supports(codec: AudioCodec): boolean {
		return codec === 'ac3' || codec === 'eac3';
	}

	async init() {
		await refWorker();

		const result = await sendCommand({
			type: 'init-decoder',
			data: { codec: this.codec },
		});
		this.ctx = result.ctx;
	}

	async decode(packet: EncodedPacket) {
		const encodedData = packet.data.slice().buffer;
		const timestamp = Math.round(packet.timestamp * this.config.sampleRate);

		const decode = sendCommand({
			type: 'decode',
			data: { ctx: this.ctx, encodedData, timestamp },
		}, [encodedData]).then(result => this.emitSamples(result.chunks));
		decode.catch(() => {}); // Surfaces through whoever awaits it next

		// Keep one packet in flight, so the worker already has the next one by the time it's done with the current one
		const previousDecode = this.inFlightDecode;
		this.inFlightDecode = decode;
		await previousDecode;
	}

	async flush() {
		await this.inFlightDecode;
		this.inFlightDecode = null;

		const result = await sendCommand({ type: 'flush-decoder', data: { ctx: this.ctx } });
		this.emitSamples(result.chunks);
	}

	async close() {
		// Close shouldn't throw
		sendCommand({ type: 'close-decoder', data: { ctx: this.ctx } }).catch(() => {});
		await unrefWorker();
	}

	private emitSamples(chunks: DecodedChunk[]) {
		for (const chunk of chunks) {
			let timestamp: number;
			if (chunk.pts !== null) {
				timestamp = chunk.pts / this.config.sampleRate;
			} else {
				assert(this.nextTimestamp !== null);
				timestamp = this.nextTimestamp;
			}

			const sample = new AudioSample({
				data: chunk.pcmData,
				format: chunk.format,
				numberOfChannels: chunk.channels,
				sampleRate: chunk.sampleRate,
				timestamp,
			});
			this.nextTimestamp = timestamp + sample.duration;
			this.onSample(sample);
		}
	}
}

let registered = false;

/**
 * Registers AC-3 and E-AC-3 decoders, which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any decoding task.
 *
 * @group \@mediabunny/ac3
 * @public
 */
export const registerAc3Decoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerDecoder(Ac3Decoder);
};
