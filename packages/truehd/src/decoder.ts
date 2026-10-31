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
import { BATCH_SAMPLE_COUNT } from './shared';

class TrueHdDecoder extends CustomAudioDecoder {
	private ctx = 0;
	private samplesPerAccessUnit = 0;
	private queuedPackets: EncodedPacket[] = [];

	static override supports(codec: AudioCodec): boolean {
		return codec === 'truehd';
	}

	async init() {
		await refWorker();

		const baseSampleRate = this.config.sampleRate % 44100 === 0 ? 44100 : 48000;
		this.samplesPerAccessUnit = 40 * this.config.sampleRate / baseSampleRate;

		const result = await sendCommand({
			type: 'init-decoder',
			data: {},
		});
		this.ctx = result.ctx;
	}

	async decode(packet: EncodedPacket) {
		this.queuedPackets.push(packet);

		if (this.samplesPerAccessUnit * this.queuedPackets.length >= BATCH_SAMPLE_COUNT) {
			await this.decodeQueuedPackets();
		}
	}

	async flush() {
		if (this.queuedPackets.length > 0) {
			await this.decodeQueuedPackets();
		}

		await sendCommand({ type: 'flush-decoder', data: { ctx: this.ctx } });
	}

	async close() {
		// Close shouldn't throw
		sendCommand({ type: 'close-decoder', data: { ctx: this.ctx } }).catch(() => {});
		await unrefWorker();
	}

	private async decodeQueuedPackets() {
		const packets = this.queuedPackets.map(packet => ({
			encodedData: packet.data.slice().buffer,
			timestamp: Math.round(packet.timestamp * this.config.sampleRate),
		}));
		this.queuedPackets = [];

		const result = await sendCommand({
			type: 'decode',
			data: { ctx: this.ctx, packets },
		}, packets.map(x => x.encodedData));

		for (const chunk of result.chunks) {
			const sample = new AudioSample({
				data: chunk.pcmData,
				format: chunk.format,
				numberOfChannels: chunk.channels,
				sampleRate: chunk.sampleRate,
				timestamp: chunk.pts / chunk.sampleRate,
			});
			this.onSample(sample);
		}
	}
}

let registered = false;

/**
 * Registers a TrueHD audio decoder, which Mediabunny will then use automatically when applicable. Make sure to call
 * this function before starting any decoding task.
 *
 * @group \@mediabunny/truehd
 * @public
 */
export const registerTrueHdDecoder = () => {
	if (registered) {
		return;
	}
	registered = true;

	registerDecoder(TrueHdDecoder);
};
