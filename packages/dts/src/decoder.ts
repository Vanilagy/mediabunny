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
import { assert } from './shared';

class DtsDecoder extends CustomAudioDecoder {
	private ctx: number | null = null;
	private inFlightDecode: Promise<void> | null = null;

	static override supports(codec: AudioCodec): boolean {
		return codec === 'dts';
	}

	async init() {
		await refWorker();

		const result = await sendCommand({
			type: 'init-decoder',
			data: {},
		});
		this.ctx = result.ctx;
	}

	async decode(packet: EncodedPacket) {
		assert(this.ctx !== null);

		const encodedData = packet.data.slice().buffer;
		const timestamp = Math.round(packet.timestamp * this.config.sampleRate);

		const decode = sendCommand({
			type: 'decode',
			data: { ctx: this.ctx, encodedData, timestamp },
		}, [encodedData]).then((result) => {
			const sample = new AudioSample({
				data: result.pcmData,
				format: result.format,
				numberOfChannels: result.channels,
				sampleRate: result.sampleRate,
				timestamp: result.pts / this.config.sampleRate,
			});
			this.onSample(sample);
		});
		decode.catch(() => {}); // Surfaces through whoever awaits it next

		// Keep one packet in flight, so the worker already has the next one by the time it's done with the current one
		const previousDecode = this.inFlightDecode;
		this.inFlightDecode = decode;
		await previousDecode;
	}

	async flush() {
		assert(this.ctx !== null);

		await this.inFlightDecode;
		this.inFlightDecode = null;

		await sendCommand({ type: 'flush-decoder', data: { ctx: this.ctx } });
	}

	async close() {
		// Close shouldn't throw
		if (this.ctx !== null) {
			sendCommand({ type: 'close-decoder', data: { ctx: this.ctx } }).catch(() => {});
		}

		await unrefWorker();
	}
}

let registered = false;

/**
 * Registers a DTS audio decoder, which Mediabunny will then use automatically when applicable. Make sure to call this
 * function before starting any decoding task.
 *
 * @group \@mediabunny/dts
 * @public
 */
export const registerDtsDecoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerDecoder(DtsDecoder);
};
