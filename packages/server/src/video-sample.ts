/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	type MaybePromise,
	VideoSamplePixelFormat,
	VideoSampleResource,
	VideoSampleColorSpace,
	SetRequired,
	VideoSampleInit,
	VideoSample,
	VideoDataPlane,
	VideoSampleTransformationDescription,
} from 'mediabunny';
import * as NodeAv from 'node-av';
import { assert, toUint8Array } from '../../../src/misc';
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

/**
 * A custom `VideoSampleResource` backed by NodeAV's
 * [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html), which in turn is backed by FFmpeg's
 * [`AVFrame`](https://ffmpeg.org/doxygen/2.7/structAVFrame.html). You can use this resource to create `VideoSample`
 * instances that are directly backed by FFmpeg's `AVFrame` without data having to be copied. Since `AVFrame`s can
 * themselves be backed by data on the GPU, this enables zero-copy hardware-accelerated decode and encode paths.
 *
 * When using Electron, you can directly create `Frame` instances without the data having to leave the GPU. For more,
 * see [NodeAV's docs](https://seydx.github.io/node-av/api/lib/classes/Frame.html).
 *
 * When passed, the `Frame` is now owned by resource, meaning it takes care of closing the frame later. If you want to
 * keep a copy for your own use, clone the frame first.
 *
 * @group \@mediabunny/server
 * @public
 */
export class AvFrameVideoSampleResource extends VideoSampleResource {
	/** @internal */
	_frame: NodeAv.Frame | null;

	/**
	 * The NodeAV [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html) instance backing this resource.
	 * Access throws if the resource has already been closed.
	 */
	get frame() {
		if (!this._frame) {
			throw new Error('AvFrameVideoSampleResource has been closed.');
		}

		return this._frame;
	}

	constructor(frame: NodeAv.Frame) {
		super();

		if (!(frame instanceof NodeAv.Frame)) {
			throw new TypeError('frame must be a NodeAv.Frame.');
		}
		if (frame.getMediaType() !== NodeAv.AVMEDIA_TYPE_VIDEO) {
			throw new Error('AvFrameVideoSampleResource must be initialized with a video frame.');
		}

		this._frame = frame;
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
		this._frame = null;
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

		return new VideoSample(new AvFrameVideoSampleResource(dstFrame), init);
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

export const transformVideoSample = async (
	sample: VideoSample,
	description: VideoSampleTransformationDescription,
): Promise<VideoSample | null> => {
	let srcFrame: NodeAv.Frame;
	let srcFrameOwned = false;

	if (sample._data instanceof AvFrameVideoSampleResource) {
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

		return new VideoSample(new AvFrameVideoSampleResource(dstFrame), {
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
