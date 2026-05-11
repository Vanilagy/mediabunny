import { AudioCodec, AudioSample, CustomAudioEncoder, MaybePromise, QUALITY_MEDIUM } from 'mediabunny';
import * as NodeAv from 'node-av';
import { CODEC_TO_CODEC_ID, fromAudioSampleFormat, getChannelLayout } from './misc';
import { assert, toUint8Array } from '../../../src/misc';
import { NodeAvFrameAudioSampleResource } from './audio-sample';
import { AdtsHeaderTemplate, buildAdtsHeaderTemplate, parseAacAudioSpecificConfig } from '../../../shared/aac-misc';
import { EncodedPacket } from 'mediabunny';

const AAC_SAMPLE_RATES
	= [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const OPUS_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const AC3_SAMPLE_RATES = [32000, 44100, 48000];

const FRAME_SIZE_FALLBACK = 1024; // Just 'cause

export class NodeAvAudioEncoder extends CustomAudioEncoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	avCodec!: NodeAv.Codec;
	codecContext: NodeAv.CodecContext | null = null;
	firstExpectedTimestamp: number | null = null;
	outputTimestampOffset = 0;

	resampler: NodeAv.SoftwareResampleContext | null = null;
	inputParametersKey: string | null = null;
	resamplerInputSampleRate: number | null = null;
	nextResamplerPts: bigint | null = null;
	dstFrame: NodeAv.Frame | null = null;
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
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.packet = new NodeAv.Packet();
		this.packet.alloc();

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
		assert(this.codecContext === null);

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

		this.codecContext = codecContext;
	}

	async encode(audioSample: AudioSample): Promise<void> {
		if (this.codecContext === null) {
			await this.createCodecContext();
			assert(this.codecContext);
		}

		this.firstExpectedTimestamp ??= audioSample.timestamp;

		if (audioSample._data instanceof NodeAvFrameAudioSampleResource) {
			this.frame.ref(audioSample._data.frame);
		} else {
			// Copy audio data from AudioData to FFmpeg Frame
			const format = fromAudioSampleFormat(audioSample.format);
			this.frame.format = format;
			this.frame.nbSamples = audioSample.numberOfFrames;
			this.frame.sampleRate = audioSample.sampleRate;
			this.frame.channelLayout = getChannelLayout(audioSample.numberOfChannels);
			this.frame.duration = BigInt(Math.round(audioSample.duration * this.config.sampleRate));

			this.frame.allocBuffer();
			assert(this.frame.data);

			for (let i = 0; i < this.frame.data.length; i++) {
				audioSample.copyTo(this.frame.data[i]!, { planeIndex: i });
			}
		}

		this.frame.pts = BigInt(Math.round(audioSample.timestamp * this.config.sampleRate));
		this.frame.timeBase = new NodeAv.Rational(1, this.config.sampleRate);

		const key = `${this.frame.sampleRate}:${this.frame.channels}:${this.frame.format}`;
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
			= this.codecContext.frameSize > 0
				|| this.codecContext.sampleFormat !== this.frame.format
				|| this.codecContext.sampleRate !== this.frame.sampleRate
				|| this.codecContext.channels !== this.frame.channels;

		if (requiresResampler) {
			if (!this.resampler) {
				this.resampler = new NodeAv.SoftwareResampleContext();
				this.resamplerInputSampleRate = this.frame.sampleRate;

				const outLayout = getChannelLayout(this.codecContext.channels);
				const inLayout = getChannelLayout(this.frame.channels);

				const ret = this.resampler.allocSetOpts2(
					outLayout, this.codecContext.sampleFormat, this.codecContext.sampleRate,
					inLayout, this.frame.format as NodeAv.AVSampleFormat, this.frame.sampleRate,
				);
				NodeAv.FFmpegError.throwIfError(ret, 'allocSetOpts2');

				const ret2 = this.resampler.init();
				NodeAv.FFmpegError.throwIfError(ret2, 'init');

				this.dstFrame = new NodeAv.Frame();
				this.dstFrame.alloc();
				this.dstFrame.channelLayout = outLayout;
				this.dstFrame.sampleRate = this.codecContext.sampleRate;
				this.dstFrame.format = this.codecContext.sampleFormat;
				this.dstFrame.nbSamples = this.codecContext.frameSize || FRAME_SIZE_FALLBACK;
				this.dstFrame.duration = BigInt(this.dstFrame.nbSamples);
				this.dstFrame.allocBuffer();

				this.nextResamplerPts = this.frame.pts;
			}

			const inputBuffers = this.frame.data;
			if (!inputBuffers) {
				throw new DOMException('Frame has no data', 'EncodingError');
			}
			await this.resampler.convert(null, 0, inputBuffers, this.frame.nbSamples);

			await this.pullResampledFrames();
		} else {
			await this.sendFrameAndReceivePackets(this.frame);
		}
	}

	async pullResampledFrames() {
		assert(this.codecContext);
		assert(this.resampler);
		assert(this.dstFrame);
		assert(this.nextResamplerPts !== null);

		const frameSize = this.codecContext.frameSize || FRAME_SIZE_FALLBACK;

		while (true) {
			const available = this.resampler.getOutSamples(0);
			if (available < frameSize) {
				break;
			}

			await this.resampler.convert(this.dstFrame.data, frameSize, null, 0);

			this.dstFrame.pts = this.nextResamplerPts;

			await this.sendFrameAndReceivePackets(this.dstFrame);
			this.nextResamplerPts += BigInt(frameSize);
		}
	}

	async sendFrameAndReceivePackets(frame: NodeAv.Frame | null) {
		assert(this.codecContext);

		const ret = await this.codecContext.sendFrame(frame);
		NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

		while (true) {
			const receiveRet = await this.codecContext.receivePacket(this.packet);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receivePacket(receiveRet);
		}
	}

	receivePacket(ret: number) {
		assert(this.codecContext);
		assert(this.firstExpectedTimestamp !== null);
		NodeAv.FFmpegError.throwIfError(ret, 'Receive packet');

		if (!this.packet.data) {
			return;
		}

		let timestamp = Number(this.packet.pts) / this.codecContext.sampleRate;
		const duration = Number(this.packet.duration) / this.codecContext.sampleRate;

		let data: Uint8Array = this.packet.data;

		let metadata: EncodedAudioChunkMetadata | undefined;
		if (this.packetEmitted) {
			metadata = {};
		} else {
			// To compensate for any negative timestamp things that FFmpeg might do. It does these for a reason, to
			// indicate encoder delay, but the notion of this is not yet supported in Mediabunny.
			this.outputTimestampOffset = this.firstExpectedTimestamp - timestamp;

			const codecString = this.config.codec;
			let description = this.codecContext.extraData
				? toUint8Array(this.codecContext.extraData)
				: undefined;

			if (
				description
				// eslint-disable-next-line @stylistic/max-len
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				&& this.codec === 'aac' && (this.config as any).aac?.format === 'adts'
			) {
				const config = parseAacAudioSpecificConfig(description);
				this.adtsHeaderTemplate = buildAdtsHeaderTemplate(config);
				description = undefined; // Not used with 'adts' format
			}

			if (description && this.codec === 'flac') {
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
					sampleRate: this.codecContext.sampleRate,
					numberOfChannels: this.codecContext.channels,
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
		if (!this.codecContext) {
			return;
		}

		outer:
		if (this.resampler) {
			assert(this.resamplerInputSampleRate !== null);

			const currentOutSamples = this.resampler.getOutSamples(0);
			if (currentOutSamples === 0) {
				break outer; // Clean cut-off point
			}

			const frameSize = this.codecContext.frameSize || FRAME_SIZE_FALLBACK;
			assert(currentOutSamples < frameSize); // Because if it's more, it would've already been retrieved

			const inputSamplesNeeded = Math.ceil(
				((frameSize - currentOutSamples) / this.codecContext.sampleRate) * this.resamplerInputSampleRate,
			);
			this.resampler.injectSilence(inputSamplesNeeded);

			await this.pullResampledFrames();
		}

		await this.sendFrameAndReceivePackets(null);

		this.codecContext.freeContext();
		this.codecContext = null;
		this.packetEmitted = false;
		this.firstExpectedTimestamp = null;
		this.outputTimestampOffset = 0;
		this.adtsHeaderTemplate = null;

		this.resampler?.free();
		this.resampler = null;
		this.inputParametersKey = null;
		this.resamplerInputSampleRate = null;
		this.nextResamplerPts = null;
		this.dstFrame?.free();
		this.dstFrame = null;
	}

	close(): MaybePromise<void> {
		this.codecContext?.freeContext();
		this.frame.free();
		this.packet.free();
		this.dstFrame?.free();
		this.resampler?.free();
	}
}
