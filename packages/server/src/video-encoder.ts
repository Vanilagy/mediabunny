import { CustomVideoEncoder, MaybePromise, QUALITY_MEDIUM, VideoCodec, VideoSample, EncodedPacket } from 'mediabunny';
import * as NodeAv from 'node-av';
import {
	CODEC_TO_CODEC_ID,
	fromPixelFormat,
	getHardwareEncoderCodec,
	mapColorPrimaries,
	mapMatrixCoefficients,
	mapTransferCharacteristics,
	unmapColorPrimaries,
	unmapMatrixCoefficients,
	unmapTransferCharacteristics,
} from './misc';
import { NodeAvFrameVideoSampleResource } from './video-sample';
import {
	AvcNalUnitType,
	extractAv1CodecInfoFromPacket,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	extractVp9CodecInfoFromPacket,
	HevcNalUnitType,
	iterateNalUnitsInAnnexB,
	NalUnitLocation,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../../../src/codec-data';
import { extractVideoCodecString } from '../../../src/codec';
import { assert, binarySearchLessOrEqual, simplifyRational, toUint8Array } from '../../../src/misc';

export class NodeAvVideoEncoder extends CustomVideoEncoder {
	frame!: NodeAv.Frame;
	packet!: NodeAv.Packet;
	avCodec!: NodeAv.Codec;
	codecContext: NodeAv.CodecContext | null = null;
	lastBuffer: Buffer | null = null;
	packetEmitted = false;

	scaler: NodeAv.SoftwareScaleContext | null = null;
	lastScalerKey: string | null = null;
	dstFrame: NodeAv.Frame | null = null;

	// Bookkeeping to restore the original timing information
	preciseTimings: {
		microsecondTimestamp: number;
		timestamp: number;
		duration: number;
		timestampIsValid: boolean;
		durationIsValid: boolean;
	}[] = [];

	static override supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
		return (codec === 'avc' || codec === 'hevc' || codec === 'vp8' || codec === 'vp9' || codec === 'av1')
			&& !(config.alpha === 'keep' || config.bitrateMode === 'quantizer');
	}

	async init(): Promise<void> {
		this.frame = new NodeAv.Frame();
		this.frame.alloc();
		this.frame.timeBase = new NodeAv.Rational(1, 1e6);

		this.packet = new NodeAv.Packet();
		this.packet.alloc();

		const codecId = CODEC_TO_CODEC_ID[this.codec];
		assert(codecId !== undefined);

		let codec: NodeAv.Codec | null = null;
		if (this.config.hardwareAcceleration === 'prefer-software') {
			codec = NodeAv.Codec.findEncoder(codecId);
		} else {
			codec = getHardwareEncoderCodec(codecId) ?? NodeAv.Codec.findEncoder(codecId);
		}

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

		let pixelFormat = NodeAv.AV_PIX_FMT_YUV420P;
		if (this.avCodec.pixelFormats && !this.avCodec.pixelFormats.includes(NodeAv.AV_PIX_FMT_YUV420P)) {
			pixelFormat = this.avCodec.pixelFormats[0]!;
		}

		const pixelAspectRatio = simplifyRational({
			num: (this.config.displayWidth ?? this.config.width) * this.config.height,
			den: (this.config.displayHeight ?? this.config.height) * this.config.width,
		});

		codecContext.width = this.config.width;
		codecContext.height = this.config.height;
		codecContext.pixelFormat = pixelFormat;
		codecContext.timeBase = new NodeAv.Rational(1, 1e6);
		codecContext.gopSize = 60;
		codecContext.framerate = new NodeAv.Rational(Math.round(this.config.framerate ?? 0) || 30, 1);
		codecContext.bitRate = BigInt(
			this.config.bitrate ?? QUALITY_MEDIUM._toVideoBitrate(this.codec, this.config.width, this.config.height),
		);
		codecContext.sampleAspectRatio = new NodeAv.Rational(pixelAspectRatio.num, pixelAspectRatio.den);

		if (this.config.bitrateMode === 'constant') {
			codecContext.rcMinRate = codecContext.bitRate;
			codecContext.rcMaxRate = codecContext.bitRate;
		}

		const isRealtime = this.config.latencyMode === 'realtime';

		if (this.avCodec.name === 'libx264') {
			if (isRealtime) {
				codecContext.setOption('tune', 'zerolatency');
				codecContext.setOption('preset', 'ultrafast');
			}
		} else if (this.avCodec.name === 'libx265') {
			codecContext.setOption('x265-params', 'log-level=error');

			if (isRealtime) {
				codecContext.setOption('tune', 'zerolatency');
				codecContext.setOption('preset', 'ultrafast');
			}
		} else if (this.avCodec.name === 'libvpx') {
			if (isRealtime) {
				codecContext.setOption('deadline', 'realtime');
				codecContext.setOption('cpu-used', '8');
			} else {
				codecContext.setOption('cpu-used', '8');
			}
		} else if (this.avCodec.name === 'libvpx-vp9') {
			codecContext.setOption('deadline', 'realtime');

			if (isRealtime) {
				codecContext.setOption('cpu-used', '8');
			} else {
				codecContext.setOption('cpu-used', '5');
			}
		} else if (this.avCodec.name === 'libsvtav1') {
			// SVTAV1 can be silenced by setting an environment variable:
			// https://superuser.com/questions/1775236/how-to-remove-svt-av1-information-from-ffmpeg-output
			process.env['SVT_LOG'] = '1';

			if (isRealtime) {
				codecContext.setOption('preset', '12');
			}
		}

		const ret = await codecContext.open2();
		NodeAv.FFmpegError.throwIfError(ret, 'Open codec context');

		this.codecContext = codecContext;
	}

	async encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions): Promise<void> {
		if (this.codecContext === null) {
			await this.createCodecContext();
			assert(this.codecContext);
		}

		if (videoSample._data instanceof NodeAvFrameVideoSampleResource) {
			this.frame.ref(videoSample._data.frame);
		} else {
			if (videoSample.format === null) {
				throw new Error('Cannot encode foreign VideoSample with unknown (null) format.');
			}

			// Copy frame data from VideoSample to FFmpeg Frame
			this.frame.format = fromPixelFormat(videoSample.format);
			this.frame.width = videoSample.codedWidth;
			this.frame.height = videoSample.codedHeight;
			this.frame.pts = BigInt(videoSample.microsecondTimestamp);
			this.frame.duration = BigInt(videoSample.microsecondDuration);
			this.frame.colorPrimaries = mapColorPrimaries(videoSample.colorSpace.primaries ?? 'unknown')
				?? NodeAv.AVCOL_PRI_UNSPECIFIED;
			this.frame.colorSpace = mapMatrixCoefficients(videoSample.colorSpace.matrix ?? 'unknown')
				?? NodeAv.AVCOL_SPC_UNSPECIFIED;
			this.frame.colorTrc = mapTransferCharacteristics(videoSample.colorSpace.transfer ?? 'unknown')
				?? NodeAv.AVCOL_TRC_UNSPECIFIED;
			this.frame.colorRange = videoSample.colorSpace.fullRange === false
				? NodeAv.AVCOL_RANGE_MPEG
				: videoSample.colorSpace.fullRange === true
					? NodeAv.AVCOL_RANGE_JPEG
					: NodeAv.AVCOL_RANGE_UNSPECIFIED;

			this.frame.keyFrame = options?.keyFrame ? 1 : 0;

			const size = videoSample.allocationSize();
			if (!this.lastBuffer || this.lastBuffer.byteLength !== size) {
				this.lastBuffer = Buffer.from({ length: size });
			}

			await videoSample.copyTo(this.lastBuffer);
			this.frame.fromBuffer(this.lastBuffer);
		}

		let frameToEncode = this.frame;

		const requiresScaler
			= this.codecContext.pixelFormat !== this.frame.format
				|| this.codecContext.width !== this.frame.width
				|| this.codecContext.height !== this.frame.height;

		if (requiresScaler) {
			if (!this.scaler) {
				this.scaler = new NodeAv.SoftwareScaleContext();
			}

			const key = `${this.frame.width}x${this.frame.height}:${this.frame.format}`;
			const needsConfigure = key !== this.lastScalerKey;

			if (needsConfigure) {
				this.scaler.getContext(
					this.frame.width, this.frame.height, this.frame.format as NodeAv.AVPixelFormat,
					this.codecContext.width, this.codecContext.height, this.codecContext.pixelFormat,
					NodeAv.SWS_FAST_BILINEAR,
				);

				this.lastScalerKey = key;

				const ret = this.scaler.initContext();
				NodeAv.FFmpegError.throwIfError(ret, 'initContext');
			}

			if (!this.dstFrame) {
				this.dstFrame = new NodeAv.Frame();
				this.dstFrame.alloc();
				this.dstFrame.width = this.codecContext.width;
				this.dstFrame.height = this.codecContext.height;
				this.dstFrame.format = this.codecContext.pixelFormat;
				this.dstFrame.allocBuffer();
			}

			await this.scaler.scaleFrame(this.dstFrame, this.frame);
			this.dstFrame.copyProps(this.frame);
			frameToEncode = this.dstFrame;
		}

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			videoSample.microsecondTimestamp,
			x => x.microsecondTimestamp,
		);
		const existingEntry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;
		if (existingEntry && existingEntry.microsecondTimestamp === videoSample.microsecondTimestamp) {
			if (existingEntry.timestamp !== videoSample.timestamp) {
				// Mapping isn't unique, can't use the timestamp
				existingEntry.timestampIsValid = false;
			}
			if (existingEntry.duration !== videoSample.duration) {
				// Mapping isn't unique, can't use the duration
				existingEntry.durationIsValid = false;
			}
		} else {
			this.preciseTimings.splice(preciseTimingIndex + 1, 0, {
				microsecondTimestamp: videoSample.microsecondTimestamp,
				timestamp: videoSample.timestamp,
				duration: videoSample.duration,
				timestampIsValid: true,
				durationIsValid: true,
			});

			// Make sure it doesn't grow indefinitely
			if (this.preciseTimings.length > 128) {
				this.preciseTimings.shift();
			}
		}

		const ret = await this.codecContext.sendFrame(frameToEncode);
		NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

		// Keep receiving packets until no more are available for this frame
		while (true) {
			const receiveRet = await this.codecContext.receivePacket(this.packet);
			if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
				break;
			}

			this.receivePacket(ret);
		}
	}

	receivePacket(ret: number) {
		assert(this.codecContext);
		NodeAv.FFmpegError.throwIfError(ret, 'Receive packet');

		if (!this.packet.data) {
			return;
		}
		let packetData = toUint8Array(this.packet.data);

		let timestamp = Number(this.packet.pts) / 1e6;
		let duration = Number(this.packet.duration) / 1e6;

		const preciseTimingIndex = binarySearchLessOrEqual(
			this.preciseTimings,
			Number(this.packet.pts),
			x => x.microsecondTimestamp,
		);
		const entry = preciseTimingIndex !== -1
			? this.preciseTimings[preciseTimingIndex]
			: null;

		// If there's a relevant timing entry, refine the packet's timing data to get better accuracy than
		// microseconds
		if (entry && entry.microsecondTimestamp === Number(this.packet.pts)) {
			if (entry.timestampIsValid) {
				timestamp = entry.timestamp;
			}
			if (entry.durationIsValid) {
				duration = entry.duration;
			}
		}

		const metadata: EncodedVideoChunkMetadata = {};
		let decoderConfigCodecString: string | null = null;
		let decoderConfigDescription: Uint8Array | null = null;

		if (this.codec === 'avc' || this.codec === 'hevc') {
			let expectsAnnexB = false;
			if (this.codec === 'avc') {
				expectsAnnexB = this.config.avc?.format === 'annexb';
			} else {
				// eslint-disable-next-line @stylistic/max-len
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				expectsAnnexB = (this.config as any).hevc?.format === 'annexb';
			}

			if (!this.packetEmitted) {
				let serializedRecord: Uint8Array;

				if (this.codec === 'avc') {
					const record = extractAvcDecoderConfigurationRecord(this.packet.data);
					if (!record) {
						throw new Error('Invalid AVC data, could not extract decoder configuration record.');
					}

					serializedRecord = serializeAvcDecoderConfigurationRecord(record);
				} else {
					const record = extractHevcDecoderConfigurationRecord(this.packet.data);
					if (!record) {
						throw new Error('Invalid HEVC data, could not extract decoder configuration record.');
					}

					serializedRecord = serializeHevcDecoderConfigurationRecord(record);
				}

				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: this.codec,
					codecDescription: serializedRecord,
					colorSpace: null,
					avcType: 1,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo: null,
				});

				if (!expectsAnnexB) {
					decoderConfigDescription = serializedRecord;
				}
			}

			if (!expectsAnnexB) {
				const NAL_UNIT_LENGTH_SIZE = 4;

				const nalUnits: NalUnitLocation[] = [];
				for (const loc of iterateNalUnitsInAnnexB(packetData)) {
					if (this.codec === 'avc') {
						const naluType = extractNalUnitTypeForAvc(packetData[loc.offset]!);

						// Certain NALUs get stripped
						if (
							naluType !== AvcNalUnitType.SPS
							&& naluType !== AvcNalUnitType.PPS
							&& naluType !== AvcNalUnitType.SPS_EXT
						) {
							nalUnits.push(loc);
						}
					} else {
						const naluType = extractNalUnitTypeForHevc(packetData[loc.offset]!);

						// Certain NALUs get stripped
						if (
							naluType !== HevcNalUnitType.SPS_NUT
							&& naluType !== HevcNalUnitType.PPS_NUT
							&& naluType !== HevcNalUnitType.VPS_NUT
						) {
							nalUnits.push(loc);
						}
					}
				}

				let totalSize = 0;
				for (const nalUnit of nalUnits) {
					totalSize += NAL_UNIT_LENGTH_SIZE + nalUnit.length;
				}

				const lengthPrefixedData = new Uint8Array(totalSize);
				const dataView = new DataView(lengthPrefixedData.buffer);
				let offset = 0;

				// Write each NAL unit with its length prefix
				for (const nalUnit of nalUnits) {
					const length = nalUnit.length;

					dataView.setUint32(offset, length, false);
					offset += 4;

					lengthPrefixedData.set(
						packetData.subarray(nalUnit.offset, nalUnit.offset + nalUnit.length),
						offset,
					);
					offset += nalUnit.length;
				}

				packetData = lengthPrefixedData;
			}
		} else if (this.codec === 'vp8') {
			if (!this.packetEmitted) {
				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'vp8',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo: null,
				});
			}
		} else if (this.codec === 'vp9') {
			if (!this.packetEmitted) {
				const vp9CodecInfo = extractVp9CodecInfoFromPacket(packetData);

				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'vp9',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo,
					av1CodecInfo: null,
				});
			}
		} else if (this.codec === 'av1') {
			if (!this.packetEmitted) {
				const av1CodecInfo = extractAv1CodecInfoFromPacket(packetData);

				decoderConfigCodecString = extractVideoCodecString({
					width: this.config.width,
					height: this.config.height,
					codec: 'av1',
					codecDescription: null,
					colorSpace: null,
					avcType: null,
					avcCodecInfo: null,
					hevcCodecInfo: null,
					vp9CodecInfo: null,
					av1CodecInfo,
				});
			}
		} else {
			throw new Error('Unreachable.');
		}

		const packet = new EncodedPacket(
			packetData,
			this.packet.isKeyframe ? 'key' : 'delta',
			timestamp,
			duration,
		);

		if (decoderConfigCodecString !== null) {
			// Create the decoder config
			metadata.decoderConfig = {
				codec: decoderConfigCodecString,
				codedWidth: this.codecContext.width,
				codedHeight: this.codecContext.height,
				displayAspectWidth: this.config.displayWidth ?? this.codecContext.width,
				displayAspectHeight: this.config.displayHeight ?? this.codecContext.height,
				description: decoderConfigDescription ?? undefined,
				colorSpace: {
					primaries:
							unmapColorPrimaries(this.codecContext.colorPrimaries) as VideoColorPrimaries,
					matrix:
							unmapMatrixCoefficients(this.codecContext.colorSpace) as VideoMatrixCoefficients,
					transfer:
							unmapTransferCharacteristics(this.codecContext.colorTrc) as VideoTransferCharacteristics,
					fullRange: this.codecContext.colorRange === NodeAv.AVCOL_RANGE_JPEG
						? true
						: this.codecContext.colorRange === NodeAv.AVCOL_RANGE_MPEG
							? false
							: undefined,
				},
			};
		}

		this.onPacket(packet, metadata);
		this.packetEmitted = true;
	}

	async flush(): Promise<void> {
		if (this.codecContext) {
			// Send null frame to signal flush
			const ret = await this.codecContext.sendFrame(null);
			NodeAv.FFmpegError.throwIfError(ret, 'Send frame');

			// Keep receiving packets until no more are available
			while (true) {
				const receiveRet = await this.codecContext.receivePacket(this.packet);
				if (receiveRet === NodeAv.AVERROR_EAGAIN || receiveRet === NodeAv.AVERROR_EOF) {
					break;
				}

				this.receivePacket(receiveRet);
			}

			this.codecContext.freeContext();
			this.codecContext = null;
			// The codec is done now and can't be reused. Any subsequence encode call will first need to recreate a
			// codec context.
		}

		this.packetEmitted = false;
	}

	close(): MaybePromise<void> {
		this.codecContext?.freeContext();
		this.frame.free();
		this.packet.free();
		this.scaler?.freeContext();
		this.dstFrame?.free();
	}
}
