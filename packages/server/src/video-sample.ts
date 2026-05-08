import assert from 'assert';
import { VideoSamplePixelFormat } from 'mediabunny';
import { VideoSampleColorSpace } from 'mediabunny';
import { VideoSampleResource } from 'mediabunny';
import * as NodeAv from 'node-av';
import { MaybePromise, toUint8Array } from '../../../src/misc';
import { VideoDataPlane, VideoSample } from '../../../src/sample';
import {
	toPixelFormat,
	unmapColorPrimaries,
	unmapTransferCharacteristics,
	unmapMatrixCoefficients,
	fromPixelFormat,
} from './misc';
import { SetRequired } from 'mediabunny';
import { VideoSampleInit } from 'mediabunny';

const JPEG_RANGE_PIX_FORMATS = new Set([
	NodeAv.AV_PIX_FMT_YUVJ411P,
	NodeAv.AV_PIX_FMT_YUVJ420P,
	NodeAv.AV_PIX_FMT_YUVJ422P,
	NodeAv.AV_PIX_FMT_YUVJ440P,
	NodeAv.AV_PIX_FMT_YUVJ444P,
]);

export class NodeAvFrameVideoSampleResource extends VideoSampleResource {
	frame: NodeAv.Frame;

	constructor(frame: NodeAv.Frame) {
		super();

		this.frame = frame;
	}

	getFormat(): VideoSamplePixelFormat | null {
		return toPixelFormat(this.frame.format as NodeAv.AVPixelFormat);
	}

	getCodedWidth(): number {
		return this.frame.width;
	}

	getCodedHeight(): number {
		return this.frame.height;
	}

	getSquarePixelWidth(): number {
		if (this.frame.sampleAspectRatio.num > this.frame.sampleAspectRatio.den) {
			return Math.round(this.frame.width * this.frame.sampleAspectRatio.num / this.frame.sampleAspectRatio.den);
		} else {
			return this.frame.width;
		}
	}

	getSquarePixelHeight(): number {
		if (this.frame.sampleAspectRatio.num > this.frame.sampleAspectRatio.den) {
			return this.frame.height;
		} else {
			return Math.round(this.frame.height * this.frame.sampleAspectRatio.den / this.frame.sampleAspectRatio.num);
		}
	}

	getColorSpace(): VideoSampleColorSpace {
		return new VideoSampleColorSpace({
			primaries: unmapColorPrimaries(this.frame.colorPrimaries) as VideoColorPrimaries | null,
			transfer: unmapTransferCharacteristics(this.frame.colorTrc) as VideoTransferCharacteristics | null,
			matrix: unmapMatrixCoefficients(this.frame.colorSpace) as VideoMatrixCoefficients | null,
			fullRange: this.frame.colorRange === NodeAv.AVCOL_RANGE_JPEG
				|| JPEG_RANGE_PIX_FORMATS.has(this.frame.format as NodeAv.AVPixelFormat)
				? true
				: this.frame.colorRange === NodeAv.AVCOL_RANGE_MPEG
					? false
					: null,
		});
	}

	close(): void {
		this.frame.free();
	}

	getDataPlanes(): MaybePromise<VideoDataPlane[]> {
		assert(this.frame.data);

		return this.frame.data.map((data, i) => ({
			data: toUint8Array(data),
			stride: this.frame.linesize[i]!,
		}));
	}

	async toRgbSample(
		init: SetRequired<VideoSampleInit, 'timestamp'>,
		format: 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX',
		// Will respect it when somebody complains
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		colorSpace: PredefinedColorSpace,
	): Promise<VideoSample> {
		const width = this.frame.width;
		const height = this.frame.height;

		const scaler = new NodeAv.SoftwareScaleContext();
		const srcFmt = this.frame.format as NodeAv.AVPixelFormat;
		const dstFmt = fromPixelFormat(format);

		scaler.getContext(
			width, height, srcFmt,
			width, height, dstFmt,
			NodeAv.SWS_BILINEAR,
		);

		const dstFrame = new NodeAv.Frame();
		dstFrame.width = width;
		dstFrame.height = height;
		dstFrame.format = dstFmt;
		dstFrame.alloc();
		dstFrame.allocBuffer();

		const srcFrame = this.frame;

		try {
			await scaler.scaleFrame(dstFrame, srcFrame);
		} finally {
			scaler.freeContext();
		}

		dstFrame.format = dstFmt; // FFmpeg messes up RGBA and RGBX
		dstFrame.sampleAspectRatio = srcFrame.sampleAspectRatio;

		return new VideoSample(new NodeAvFrameVideoSampleResource(dstFrame), init);
	}
}
