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
	CustomAudioEncoder,
	type MaybePromise,
	QUALITY_MEDIUM,
	EncodedPacket,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import { CODEC_TO_CODEC_ID, getChannelLayout } from './misc';
import { assert, toUint8Array } from '../../../src/misc';
import { copyAudioSampleToAvFrame, AvFrameAudioSampleResource } from './audio-sample';
import {
	AdtsHeaderTemplate,
	buildAdtsHeaderTemplate,
	parseAacAudioSpecificConfig,
} from '../../../shared/aac-misc';

const AAC_SAMPLE_RATES
	= [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const OPUS_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const AC3_SAMPLE_RATES = [32000, 44100, 48000];

const FRAME_SIZE_FALLBACK = 1024; // Just 'cause

type NodeAvState = {
	frame: NodeAv.Frame;
	packet: NodeAv.Packet;
	codecContext: NodeAv.CodecContext | null;
	resampler: NodeAv.SoftwareResampleContext | null;
	dstFrame: NodeAv.Frame | null;
};

const freeState = (state: NodeAvState) => {
	state.codecContext?.freeContext();
	state.frame.free();
	state.packet.free();
	state.dstFrame?.free();
	state.resampler?.free();
};

// Needed for proper freeing if close isn't called
let finalizationRegistry: FinalizationRegistry<NodeAvState> | null = null;
if (typeof FinalizationRegistry !== 'undefined') {
	finalizationRegistry = new FinalizationRegistry<NodeAvState>((state) => {
		freeState(state);
	});
}

export class NodeAvAudioEncoder extends CustomAudioEncoder {
	state!: NodeAvState;
	avCodec!: NodeAv.Codec;
	firstExpectedTimestamp: number | null = null;
	outputTimestampOffset = 0;

	inputParametersKey: string | null = null;
	resamplerInputSampleRate: number | null = null;
	nextResamplerPts: bigint | null = null;
	packetEmitted = false;
	adtsHeaderTemplate: AdtsHeaderTemplate | null = null;

	static override supports(codec: AudioCodec, config: AudioEncoderConfig): boolean {
		const { numberOfChannels, sampleRate } = config;

		return (
			codec === 'aac' && numberOfChannels >= 1 && numberOfChannels <= 48
			&& AAC_SAMPLE_RATES.includes(sampleRate)
		) || (
			codec === 'opus' && numberOfChannels >= 1 && numberOfChannels <= 255
			&& OPUS_SAMPLE_RATES.includes(sampleRate)
		) || (
			codec === 'mp3' && numberOfChannels >= 1 && numberOfChannels <= 2
			&& MP3_SAMPLE_RATES.includes(sampleRate)
		) || (
			codec === 'vorbis' && numberOfChannels >= 1 && numberOfChannels <= 255
			&& sampleRate <= 200000
		) || (
			codec === 'flac' && numberOfChannels >= 1 && numberOfChannels <= 8
			&& sampleRate <= 655350
		) || (
			codec === 'ac3' && numberOfChannels >= 1 && numberOfChannels <= 6
			&& AC3_SAMPLE_RATES.includes(sampleRate)
		) || (
			codec === 'eac3' && numberOfChannels >= 1 && numberOfChannels <= 16
			&& AC3_SAMPLE_RATES.includes(sampleRate)
		);
	}

	async init(): Promise<void> {
		const frame = new NodeAv.Frame();
		frame.alloc();
		const packet = new NodeAv.Packet();
		packet.alloc();
		this.state = { frame, packet, codecContext: null, resampler: null, dstFrame: null };

		finalizationRegistry?.register(this, this.state, this);

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		const codec = NodeAv.Codec.findEncoder(codecId);
		if (!codec) {
			throw new Error(`Unable to obtain libav codec for '${this.codec}'.`);
		}

		this.avCodec = codec;

		await this.createCodecContext();
	}

	async createCodecContext() {
		assert(this.state.codecContext === null);

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(this.avCodec);

		let sampleFormat = NodeAv.AV_SAMPLE_FMT_FLTP;
		if (this.avCodec.sampleFormats && !this.avCodec.sampleFormats.includes(NodeAv.AV_SAMPLE_FMT_FLTP)) {
			// Use a format that's supported
			sampleFormat = this.avCodec.sampleFormats[0]!;
		}

		codecContext.sampleRate = this.config.sampleRate;
		codecContext.channelLayout = getChannelLayout(this.config.numberOfChannels);
		codecContext.codecType = NodeAv.AVMEDIA_TYPE_AUDIO;
		codecContext.codecId = CODEC_TO_CODEC_ID[this.codec]!;
		codecContext.sampleFormat = sampleFormat;
		codecContext.timeBase = new NodeAv.Rational(1, this.config.sampleRate);
		codecContext.bitRate = BigInt(this.config.bitrate ?? QUALITY_MEDIUM._toAudioBitrate(this.codec) ?? 0);

		if (this.config.bitrateMode === 'constant') {
			codecContext.rcMinRate = codecContext.bitRate;
			codecContext.rcMaxRate = codecContext.bitRate;
		}

		const ret = await codecContext.open2();
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.state.codecContext = codecContext;
	}

	async encode(audioSample: AudioSample): Promise<void> {
		if (this.state.codecContext === null) {
			await this.createCodecContext();
			assert(this.state.codecContext);
		}

		this.firstExpectedTimestamp ??= audioSample.timestamp;

		if (audioSample._data instanceof AvFrameAudioSampleResource) {
			// Release any buffers still referenced from the previous encode before reffing the new frame, otherwise
			// av_frame_ref leaks them
			// https://github.com/Vanilagy/mediabunny/issues/392
			this.state.frame.unref();
			this.state.frame.ref(audioSample._data.frame);
		} else {
			copyAudioSampleToAvFrame(audioSample, this.state.frame);
		}

		this.state.frame.pts = BigInt(Math.round(audioSample.timestamp * this.config.sampleRate));
		this.state.frame.duration = BigInt(Math.round(audioSample.duration * this.config.sampleRate));
		this.state.frame.timeBase = new NodeAv.Rational(1, this.config.sampleRate);

		const key = `${this.state.frame.sampleRate}:${this.state.frame.channels}:${this.state.frame.format}`;
		if (this.inputParametersKey !== null && this.inputParametersKey !== key) {
			throw new Error(
				'Input audio parameters changed. For this audio encoder, you cannot change the input audio'
				+ ' parameters over time.',
			);
		}
		this.inputParametersKey = key;

		// We need the resampler when:
		// 1. Format conversion is needed (sample format, sample rate, or channel count differs)
		// 2. The codec requires fixed frame sizes
		const requiresResampler
			= this.state.codecContext.frameSize > 0
				|| this.state.codecContext.sampleFormat !== this.state.frame.format
				|| this.state.codecContext.sampleRate !== this.state.frame.sampleRate
				|| this.state.codecContext.channels !== this.state.frame.channels;

		if (requiresResampler) {
			if (!this.state.resampler) {
				this.state.resampler = new NodeAv.SoftwareResampleContext();
				this.resamplerInputSampleRate = this.state.frame.sampleRate;

				const outLayout = getChannelLayout(this.state.codecContext.channels);
				const inLayout = getChannelLayout(this.state.frame.channels);

				const ret = this.state.resampler.allocSetOpts2(
					outLayout, this.state.codecContext.sampleFormat, this.state.codecContext.sampleRate,
					inLayout, this.state.frame.format as NodeAv.AVSampleFormat, this.state.frame.sampleRate,
				);
				NodeAv.FFmpegError.throwIfError(ret, 'allocSetOpts2');

				const ret2 = this.state.resampler.init();
				NodeAv.FFmpegError.throwIfError(ret2, 'init');

				this.state.dstFrame = new NodeAv.Frame();
				this.state.dstFrame.alloc();
				this.state.dstFrame.channelLayout = outLayout;
				this.state.dstFrame.sampleRate = this.state.codecContext.sampleRate;
				this.state.dstFrame.format = this.state.codecContext.sampleFormat;
				this.state.dstFrame.nbSamples = this.state.codecContext.frameSize || FRAME_SIZE_FALLBACK;
				this.state.dstFrame.duration = BigInt(this.state.dstFrame.nbSamples);
				this.state.dstFrame.allocBuffer();

				this.nextResamplerPts = this.state.frame.pts;
			}

			const inputBuffers = this.state.frame.data;
			if (!inputBuffers) {
				throw new DOMException('Frame has no data', 'EncodingError');
			}
			await this.state.resampler.convert(null, 0, inputBuffers, this.state.frame.nbSamples);

			await this.pullResampledFrames();
		} else {
			await this.sendFrameAndReceivePackets(this.state.frame);
		}
	}

	async pullResampledFrames() {
		assert(this.state.codecContext);
		assert(this.state.resampler);
		assert(this.state.dstFrame);
		assert(this.nextResamplerPts !== null);

		const frameSize = this.state.codecContext.frameSize || FRAME_SIZE_FALLBACK;

		while (true) {
			const available = this.state.resampler.getOutSamples(0);
			if (available < frameSize) {
				break;
			}

			await this.state.resampler.convert(this.state.dstFrame.data, frameSize, null, 0);

			this.state.dstFrame.pts = this.nextResamplerPts;

			await this.sendFrameAndReceivePackets(this.state.dstFrame);
			this.nextResamplerPts += BigInt(frameSize);
		}
	}

	async sendFrameAndReceivePackets(frame: NodeAv.Frame | null) {
		assert(this.state.codecContext);

		const ret = await this.state.codecContext.sendFrame(frame);
		NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

		while (true) {
			const receiveRet = await this.state.codecContext.receivePacket(this.state.packet);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receivePacket(receiveRet);
		}
	}

	receivePacket(ret: number) {
		assert(this.state.codecContext);
		assert(this.firstExpectedTimestamp !== null);
		NodeAv.FFmpegError.throwIfError(ret, 'Receive packet');

		if (!this.state.packet.data) {
			return;
		}

		let timestamp = Number(this.state.packet.pts) / this.state.codecContext.sampleRate;
		const duration = Number(this.state.packet.duration) / this.state.codecContext.sampleRate;

		let data: Uint8Array = this.state.packet.data;

		let metadata: EncodedAudioChunkMetadata | undefined;
		if (this.packetEmitted) {
			metadata = {};
		} else {
			// To compensate for any negative timestamp things that FFmpeg might do. It does these for a reason, to
			// indicate encoder delay, but the notion of this is not yet supported in Mediabunny. Yes, this technically
			// introduces audio sync drift.
			this.outputTimestampOffset = Math.max(this.firstExpectedTimestamp - timestamp, 0);

			const codecString = this.config.codec;
			let description = this.state.codecContext.extraData
				? toUint8Array(this.state.codecContext.extraData)
				: undefined;

			if (this.codec === 'aac') {
				if (!description) {
					throw new Error('Extradata expected for AAC.');
				}

				// eslint-disable-next-line @stylistic/max-len
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				const isAdts = (this.config as any).aac?.format === 'adts';

				if (isAdts) {
					const parsedConfig = parseAacAudioSpecificConfig(description);
					this.adtsHeaderTemplate = buildAdtsHeaderTemplate(parsedConfig);
					description = undefined; // Not used with 'adts' format
				}
			} else if (this.codec === 'opus') {
				if (!description) {
					// Technically not required by the WebCodecs/Mediabunny Codec Registry, but we strive to be better
					throw new Error('Extradata expected for Opus.');
				}
			} else if (this.codec === 'vorbis') {
				if (!description) {
					throw new Error('Extradata expected for Vorbis.');
				}
			} else if (this.codec === 'flac') {
				if (!description) {
					throw new Error('Extradata expected for FLAC.');
				}

				// FFmpeg uses the STREAMINFO block as the extradata, but WebCodecs wants a different format:
				// 1. The bytes 0x66 0x4C 0x61 0x43 ("fLaC" in ASCII)
				// 2. A metadata block (called the STREAMINFO block) as described in section 7 of [FLAC]
				// 3. Other optional metadata blocks (not included here, because, well, they're optional)
				description = new Uint8Array([
					0x66, 0x4c, 0x61, 0x43, // 'fLaC'
					128, 0, 0, description.byteLength,
					...description,
				]);
			}

			metadata = {
				decoderConfig: {
					codec: codecString,
					sampleRate: this.state.codecContext.sampleRate,
					numberOfChannels: this.state.codecContext.channels,
					description,
				},
			};
		}

		if (this.adtsHeaderTemplate) {
			const frameLength = data.byteLength + this.adtsHeaderTemplate.header.byteLength;
			this.adtsHeaderTemplate.bitstream.pos = 30;
			this.adtsHeaderTemplate.bitstream.writeBits(13, frameLength);

			const final = new Uint8Array(this.adtsHeaderTemplate.header.byteLength + data.byteLength);
			final.set(this.adtsHeaderTemplate.header, 0);
			final.set(data, this.adtsHeaderTemplate.header.byteLength);

			data = final;
		}

		timestamp += this.outputTimestampOffset;

		const packet = new EncodedPacket(
			data,
			'key',
			timestamp,
			duration,
		);

		this.packetEmitted = true;
		this.onPacket(packet, metadata);
	}

	async flush(): Promise<void> {
		if (!this.state.codecContext) {
			return;
		}

		outer:
		if (this.state.resampler) {
			assert(this.resamplerInputSampleRate !== null);

			const currentOutSamples = this.state.resampler.getOutSamples(0);
			if (currentOutSamples === 0) {
				break outer; // Clean cut-off point
			}

			const frameSize = this.state.codecContext.frameSize || FRAME_SIZE_FALLBACK;
			assert(currentOutSamples < frameSize); // Because if it's more, it would've already been retrieved

			const inputSamplesNeeded = Math.ceil(
				((frameSize - currentOutSamples) / this.state.codecContext.sampleRate) * this.resamplerInputSampleRate,
			);
			this.state.resampler.injectSilence(inputSamplesNeeded);

			await this.pullResampledFrames();
		}

		await this.sendFrameAndReceivePackets(null);

		this.state.codecContext.freeContext();
		this.state.codecContext = null;
		this.packetEmitted = false;
		this.firstExpectedTimestamp = null;
		this.outputTimestampOffset = 0;
		this.adtsHeaderTemplate = null;

		this.state.resampler?.free();
		this.state.resampler = null;
		this.inputParametersKey = null;
		this.resamplerInputSampleRate = null;
		this.nextResamplerPts = null;
		this.state.dstFrame?.free();
		this.state.dstFrame = null;
	}

	close(): MaybePromise<void> {
		finalizationRegistry?.unregister(this);
		freeState(this.state);
	}
}
