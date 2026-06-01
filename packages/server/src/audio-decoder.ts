/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, AudioSample, CustomAudioDecoder, EncodedPacket, type MaybePromise } from 'mediabunny';
import * as NodeAv from 'node-av';
import { CODEC_TO_CODEC_ID, getChannelLayout } from './misc';
import { assert, toUint8Array } from '../../../src/misc';
import { AvFrameAudioSampleResource } from './audio-sample';

type NodeAvState = {
	frame: NodeAv.Frame;
	packet: NodeAv.Packet;
	codecContext: NodeAv.CodecContext | null;
};

const freeState = (state: NodeAvState) => {
	state.codecContext?.freeContext();
	state.frame.free();
	state.packet.free();
};

// Needed for proper freeing if close isn't called
let finalizationRegistry: FinalizationRegistry<NodeAvState> | null = null;
if (typeof FinalizationRegistry !== 'undefined') {
	finalizationRegistry = new FinalizationRegistry<NodeAvState>((state) => {
		freeState(state);
	});
}

export class NodeAvAudioDecoder extends CustomAudioDecoder {
	state!: NodeAvState;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: AudioCodec, config: AudioDecoderConfig): boolean {
		return codec === 'aac'
			|| codec === 'opus'
			|| codec === 'mp3'
			|| codec === 'vorbis'
			|| codec === 'flac'
			|| codec === 'ac3'
			|| codec === 'eac3';
	}

	async init(): Promise<void> {
		const frame = new NodeAv.Frame();
		frame.alloc();
		const packet = new NodeAv.Packet();
		packet.alloc();
		this.state = { frame, packet, codecContext: null };

		finalizationRegistry?.register(this, this.state, this);

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		const codec = NodeAv.Codec.findDecoder(codecId);
		if (codec === null) {
			throw new Error(`Unable to obtain libav codec for '${this.codec}'.`);
		}

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(codec);

		codecContext.sampleRate = this.config.sampleRate;
		codecContext.channelLayout = getChannelLayout(this.config.numberOfChannels);
		codecContext.timeBase = new NodeAv.Rational(1, this.config.sampleRate);
		codecContext.codecType = NodeAv.AVMEDIA_TYPE_AUDIO;
		codecContext.codecId = codecId;
		codecContext.extraData = this.config.description
			? Buffer.from(toUint8Array(this.config.description))
			: null;

		const ret = await codecContext.open2();
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.state.codecContext = codecContext;
	}

	async decode(packet: EncodedPacket): Promise<void> {
		assert(this.state.codecContext);

		this.state.packet.isKeyframe = packet.type === 'key';
		this.state.packet.data = Buffer.from(packet.data);
		this.state.packet.timeBase = { num: 1, den: this.config.sampleRate };
		this.state.packet.pts = BigInt(Math.round(packet.timestamp * this.config.sampleRate));
		this.state.packet.dts = NodeAv.AV_NOPTS_VALUE;
		this.state.packet.duration = BigInt(Math.round(packet.duration * this.config.sampleRate));

		const ret = await this.state.codecContext.sendPacket(this.state.packet);
		NodeAv.FFmpegError.throwIfError(ret, 'Send packet');

		this.state.packet.unref(); // Don't need the data again, so just unref it

		while (true) {
			const receiveRet = await this.state.codecContext.receiveFrame(this.state.frame);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receiveFrame(receiveRet);
		}
	}

	receiveFrame(ret: number) {
		NodeAv.FFmpegError.throwIfError(ret, 'Receive frame');

		const clone = this.state.frame.clone();
		if (!clone) {
			throw new Error('Allocation failure during frame clone.');
		}

		clone.timeBase = new NodeAv.Rational(1, this.config.sampleRate);
		this.onSample(new AudioSample(new AvFrameAudioSampleResource(clone)));
	}

	async flush(): Promise<void> {
		assert(this.state.codecContext);

		// Send null packet to signal flush
		const ret = await this.state.codecContext.sendPacket(null);
		NodeAv.FFmpegError.throwIfError(ret, 'Flush decoder');

		// Keep receiving frames until no more are available
		while (true) {
			const receiveRet = await this.state.codecContext.receiveFrame(this.state.frame);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				// No more frames available
				break;
			}

			this.receiveFrame(receiveRet);
		}

		this.state.codecContext.flushBuffers();
	}

	close(): MaybePromise<void> {
		finalizationRegistry?.unregister(this);
		freeState(this.state);
	}
}
