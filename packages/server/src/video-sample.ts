import assert from 'assert';
import {
	VideoSamplePixelFormat,
	VideoSampleResource,
	VideoSampleColorSpace,
	SetRequired,
	VideoSampleInit,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import { MaybePromise, toUint8Array } from '../../../src/misc';
import { VideoSampleTransformationDescription, VideoDataPlane, VideoSample } from '../../../src/sample';
import {
	toPixelFormat,
	unmapColorPrimaries,
	unmapTransferCharacteristics,
	unmapMatrixCoefficients,
	fromPixelFormat,
	mapColorPrimaries,
	mapMatrixCoefficients,
	mapTransferCharacteristics,
} from './misc';

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
		// Will respect it when somebody complains
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		colorSpace: PredefinedColorSpace,
	): Promise<VideoSample> {
		const width = this.frame.width;
		const height = this.frame.height;

		const scaler = new NodeAv.SoftwareScaleContext();
		const srcFmt = this.frame.format as NodeAv.AVPixelFormat;
		const dstFmt = fromPixelFormat('RGBA');

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

		dstFrame.sampleAspectRatio = srcFrame.sampleAspectRatio;

		return new VideoSample(new NodeAvFrameVideoSampleResource(dstFrame), init);
	}
}

export const copyVideoSampleToAvFrame = async (sample: VideoSample, frame: NodeAv.Frame, lastBuffer: Buffer | null) => {
	assert(sample.format !== null);

	frame.format = fromPixelFormat(sample.format);
	frame.width = sample.codedWidth;
	frame.height = sample.codedHeight;
	frame.sampleAspectRatio = new NodeAv.Rational(
		sample.pixelAspectRatio.num,
		sample.pixelAspectRatio.den,
	);
	frame.colorPrimaries = mapColorPrimaries(sample.colorSpace.primaries ?? 'unknown')
		?? NodeAv.AVCOL_PRI_UNSPECIFIED;
	frame.colorSpace = mapMatrixCoefficients(sample.colorSpace.matrix ?? 'unknown')
		?? NodeAv.AVCOL_SPC_UNSPECIFIED;
	frame.colorTrc = mapTransferCharacteristics(sample.colorSpace.transfer ?? 'unknown')
		?? NodeAv.AVCOL_TRC_UNSPECIFIED;
	frame.colorRange = sample.colorSpace.fullRange === false
		? NodeAv.AVCOL_RANGE_MPEG
		: sample.colorSpace.fullRange === true
			? NodeAv.AVCOL_RANGE_JPEG
			: NodeAv.AVCOL_RANGE_UNSPECIFIED;

	const size = sample.allocationSize();
	if (!lastBuffer || lastBuffer.byteLength !== size) {
		lastBuffer = Buffer.from({ length: size });
	}

	await sample.copyTo(lastBuffer);
	frame.fromBuffer(lastBuffer);

	return lastBuffer;
};

export const transformSample = async (
	sample: VideoSample,
	description: VideoSampleTransformationDescription,
): Promise<VideoSample | null> => {
	let srcFrame: NodeAv.Frame;
	let srcFrameOwned = false;

	if (sample._data instanceof NodeAvFrameVideoSampleResource) {
		srcFrame = sample._data.frame;
	} else {
		if (sample.format === null) {
			return null;
		}

		srcFrame = new NodeAv.Frame();
		srcFrame.alloc();
		srcFrameOwned = true;

		await copyVideoSampleToAvFrame(sample, srcFrame, null);
	}

	// Build the filter chain. Order: square-pixel normalize -> rotate -> crop -> resize-with-fit.
	const chain: string[] = [];

	if (sample.squarePixelWidth !== sample.codedWidth || sample.squarePixelHeight !== sample.codedHeight) {
		chain.push(`scale=${sample.squarePixelWidth}:${sample.squarePixelHeight}`);
		chain.push('setsar=1');
	}

	if (description.rotation === 90) {
		chain.push('transpose=1');
	} else if (description.rotation === 180) {
		chain.push('transpose=1,transpose=1');
	} else if (description.rotation === 270) {
		chain.push('transpose=2');
	}

	chain.push(`crop=${Math.round(description.crop.width)}:${Math.round(description.crop.height)}`
		+ `:${Math.round(description.crop.left)}:${Math.round(description.crop.top)}`);

	if (description.fit === 'fill') {
		chain.push(`scale=${description.width}:${description.height}`);
	} else if (description.fit === 'contain') {
		chain.push(`scale=${description.width}:${description.height}:force_original_aspect_ratio=decrease`);
		chain.push(`pad=${description.width}:${description.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
	} else if (description.fit === 'cover') {
		chain.push(`scale=${description.width}:${description.height}:force_original_aspect_ratio=increase`);
		chain.push(`crop=${description.width}:${description.height}`);
	}

	chain.push('setsar=1');

	const graph = new NodeAv.FilterGraph();
	graph.alloc();

	try {
		const srcArgs = `video_size=${srcFrame.width}x${srcFrame.height}`
			+ `:pix_fmt=${srcFrame.format}`
			+ `:time_base=1/1000000`
			+ `:pixel_aspect=${sample.pixelAspectRatio.num}/${sample.pixelAspectRatio.den}`;

		const bufferSrc = graph.createFilter(NodeAv.Filter.getByName('buffer')!, 'src', srcArgs);
		const bufferSink = graph.createFilter(NodeAv.Filter.getByName('buffersink')!, 'sink');
		assert(bufferSrc && bufferSink);

		// The naming here looks inverted but matches FFmpeg's parse semantics: from the parsed chain's
		// perspective, its inputs are fed by the graph's existing outputs (the buffer src), and its outputs
		// feed the graph's existing inputs (the buffer sink).
		const outputs = NodeAv.FilterInOut.createList([{ name: 'in', filterCtx: bufferSrc, padIdx: 0 }]);
		const inputs = NodeAv.FilterInOut.createList([{ name: 'out', filterCtx: bufferSink, padIdx: 0 }]);

		const parseRet = graph.parsePtr(`[in]${chain.join(',')}[out]`, inputs, outputs);
		NodeAv.FFmpegError.throwIfError(parseRet, 'FilterGraph.parsePtr');

		const configRet = await graph.config();
		NodeAv.FFmpegError.throwIfError(configRet, 'FilterGraph.config');

		const addRet = await bufferSrc.buffersrcAddFrame(srcFrame);
		NodeAv.FFmpegError.throwIfError(addRet, 'buffersrcAddFrame');

		// Flush - we only ever push a single frame through this graph.
		await bufferSrc.buffersrcAddFrame(null);

		const dstFrame = new NodeAv.Frame();
		dstFrame.alloc();

		const getRet = await bufferSink.buffersinkGetFrame(dstFrame);
		NodeAv.FFmpegError.throwIfError(getRet, 'buffersinkGetFrame');

		return new VideoSample(new NodeAvFrameVideoSampleResource(dstFrame), {
			timestamp: sample.timestamp,
			duration: sample.duration,
			rotation: 0, // baked in by the filter graph
		});
	} finally {
		graph.free();

		if (srcFrameOwned) {
			srcFrame.free();
		}
	}
};
