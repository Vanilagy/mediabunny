/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AudioCodec,
	AudioSample,
	CustomAudioDecoder,
	EncodedPacket,
	registerDecoder,
} from 'mediabunny';
import { refWorker, sendCommand, unrefWorker } from './worker-client';

class DtsDecoder extends CustomAudioDecoder {
	private ctx = 0;

	static override supports(codec: AudioCodec): boolean {
		return codec === 'dts';
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

		const result = await sendCommand({
			type: 'decode',
			data: { ctx: this.ctx, encodedData, timestamp },
		}, [encodedData]);

		const sample = new AudioSample({
			data: result.pcmData,
			format: result.format,
			numberOfChannels: result.channels,
			sampleRate: result.sampleRate,
			timestamp: result.pts / result.sampleRate,
		});
		this.onSample(sample);
	}

	async flush() {
		await sendCommand({ type: 'flush-decoder', data: { ctx: this.ctx } });
	}

	async close() {
		void sendCommand({ type: 'close-decoder', data: { ctx: this.ctx } });
		await unrefWorker();
	}
}

let registered = false;

/**
 * Registers a DTS decoder, which Mediabunny will then use automatically when applicable. Make sure to call this
 * function before starting any DTS decoding task.
 *
 * @group \@mediabunny/dts-decoder
 * @public
 */
export const registerDtsDecoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerDecoder(DtsDecoder);
};
