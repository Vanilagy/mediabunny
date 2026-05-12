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
import { NodeAvFrameAudioSampleResource } from './audio-sample';

export class NodeAvAudioDecoder extends CustomAudioDecoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	codecContext!: NodeAv.CodecContext;

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
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.packet = new NodeAv.Packet();
		this.packet.alloc();

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

		this.codecContext = codecContext;
	}

	async decode(packet: EncodedPacket): Promise<void> {
		this.packet.isKeyframe = packet.type === 'key';
		this.packet.data = Buffer.from(packet.data);
		this.packet.timeBase = { num: 1, den: this.config.sampleRate };
		this.packet.pts = BigInt(Math.round(packet.timestamp * this.config.sampleRate));
		this.packet.dts = NodeAv.AV_NOPTS_VALUE;
		this.packet.duration = BigInt(Math.round(packet.duration * this.config.sampleRate));

		const ret = await this.codecContext.sendPacket(this.packet);
		NodeAv.FFmpegError.throwIfError(ret, 'Send packet');

		while (true) {
			const receiveRet = await this.codecContext.receiveFrame(this.frame);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receiveFrame(receiveRet);
		}
	}

	receiveFrame(ret: number) {
		NodeAv.FFmpegError.throwIfError(ret, 'Receive frame');

		const clone = this.frame.clone();
		if (!clone) {
			throw new Error('Allocation failure during frame clone.');
		}

		clone.timeBase = new NodeAv.Rational(1, this.config.sampleRate);
		this.onSample(new AudioSample(new NodeAvFrameAudioSampleResource(clone)));
	}

	async flush(): Promise<void> {
		// Send null packet to signal flush
		const ret = await this.codecContext.sendPacket(null);
		NodeAv.FFmpegError.throwIfError(ret, 'Flush decoder');

		// Keep receiving frames until no more are available
		while (true) {
			const receiveRet = await this.codecContext.receiveFrame(this.frame);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				// No more frames available
				break;
			}

			this.receiveFrame(receiveRet);
		}

		this.codecContext.flushBuffers();
	}

	close(): MaybePromise<void> {
		this.codecContext.freeContext();
		this.frame.free();
		this.packet.free();
	}
}
