import { CustomVideoDecoder, VideoCodec, EncodedPacket, VideoSample, MaybePromise, Rational } from 'mediabunny';
import * as NodeAv from 'node-av';
import { CODEC_TO_CODEC_ID, getHardwareDecoderCodec } from './misc';
import { assert, binarySearchLessOrEqual, simplifyRational, toUint8Array } from '../../../src/misc';
import { NodeAvFrameVideoSampleResource } from './video-sample';

export class NodeAvVideoDecoder extends CustomVideoDecoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	codecContext!: NodeAv.CodecContext;
	pixelAspectRatio!: Rational;

	// Bookkeeping to restore the original timing information
	preciseTimings: {
		microsecondTimestamp: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
		return codec === 'avc' || codec === 'hevc' || codec === 'vp8' || codec === 'vp9' || codec === 'av1';
	}

	async init() {
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.packet = new NodeAv.Packet();
		this.packet.alloc();

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		let codec: NodeAv.Codec | null;
		if (this.config.hardwareAcceleration !== 'prefer-hardware' || this.codec === 'av1') {
			// https://github.com/opencv/opencv/issues/24430
			codec = NodeAv.Codec.findDecoder(codecId);
		} else {
			codec = getHardwareDecoderCodec(codecId) ?? NodeAv.Codec.findDecoder(codecId);
		}

		if (!codec) {
			throw new Error(`Unable to obtain libav codec for '${this.codec}'.`);
		}

		const codecContext = new NodeAv.CodecContext();
		codecContext.allocContext3(codec);

		this.pixelAspectRatio = simplifyRational({
			num: (this.config.displayAspectWidth ?? this.config.codedWidth ?? 0) * (this.config.codedHeight ?? 0),
			den: (this.config.displayAspectHeight ?? this.config.codedHeight ?? 0) * (this.config.codedWidth ?? 0) || 1,
		});

		codecContext.width = this.config.codedWidth ?? 0; // Fucky that the dimensions can be optional, but oh well
		codecContext.height = this.config.codedHeight ?? 0;
		codecContext.codecType = NodeAv.AVMEDIA_TYPE_VIDEO;
		codecContext.codecId = codecId;
		codecContext.extraData = this.config.description
			? Buffer.from(toUint8Array(this.config.description))
			: null;
		codecContext.sampleAspectRatio = new NodeAv.Rational(this.pixelAspectRatio.num, this.pixelAspectRatio.den);

		const ret = await codecContext.open2();
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.codecContext = codecContext;
	}

	async decode(packet: EncodedPacket) {
		this.packet.isKeyframe = packet.type === 'key';
		this.packet.data = Buffer.from(packet.data);
		this.packet.timeBase = { num: 1, den: 1e6 };
		this.packet.pts = BigInt(packet.microsecondTimestamp);
		this.packet.dts = NodeAv.AV_NOPTS_VALUE;
		this.packet.duration = BigInt(packet.microsecondDuration);

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			packet.microsecondTimestamp,
			x => x.microsecondTimestamp,
		);
		const existingEntry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;
		if (existingEntry && existingEntry.microsecondTimestamp === packet.microsecondTimestamp) {
			if (existingEntry.timestamp !== packet.timestamp) {
				// Mapping isn't unique, can't use the timestamp
				existingEntry.timestampIsValid = false;
			}
			if (existingEntry.duration !== packet.duration) {
				// Mapping isn't unique, can't use the duration
				existingEntry.durationIsValid = false;
			}
		} else {
			this.preciseTimings.splice(preciseTimingIndex + 1, 0, {
				microsecondTimestamp: packet.microsecondTimestamp,
				timestamp: packet.timestamp,
				duration: packet.duration,
				timestampIsValid: true,
				durationIsValid: true,
			});

			// Make sure it doesn't grow indefinitely
			if (this.preciseTimings.length > 128) {
				this.preciseTimings.shift();
			}
		}

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

		this.frame.sampleAspectRatio = new NodeAv.Rational(this.pixelAspectRatio.num, this.pixelAspectRatio.den);

		let timestamp = Number(this.frame.pts) / 1e6;
		let duration = Number(this.frame.duration) / 1e6;

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			Number(this.frame.pts),
			x => x.microsecondTimestamp,
		);
		const entry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;

		// If there's a relevant timing entry, refine the frame's timing data to get better accuracy than
		// microseconds
		if (entry && entry.microsecondTimestamp === Number(this.frame.pts)) {
			if (entry.timestampIsValid) {
				timestamp = entry.timestamp;
			}
			if (entry.durationIsValid) {
				duration = entry.duration;
			}
		}

		const clone = this.frame.clone();
		if (!clone) {
			throw new Error('Frame clone allocation failed.');
		}

		this.onSample(new VideoSample(new NodeAvFrameVideoSampleResource(clone), {
			timestamp,
			duration,
		}));
	}

	async flush() {
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
