import assert from 'assert';
import { Rectangle, VideoSamplePixelFormat } from 'mediabunny';
import { VideoSampleColorSpace } from 'mediabunny';
import { VideoSampleResource } from 'mediabunny';
import * as NodeAv from 'node-av';
import { toUint8Array } from '../../../src/misc';
import { getPlaneConfigs } from '../../../src/sample';
import {
	toPixelFormat,
	unmapColorPrimaries,
	unmapTransferCharacteristics,
	unmapMatrixCoefficients,
	fromPixelFormat,
	mapColorPrimaries,
	mapTransferCharacteristics,
	mapMatrixCoefficients,
} from './misc';

export class NodeAvFrameVideoSampleResource extends VideoSampleResource {
	frame: NodeAv.Frame;

	constructor(frame: NodeAv.Frame) {
		super();

		const clone = frame.clone();
		if (!clone) {
			throw new Error('Allocation failure during frame clone.');
		}

		this.frame = clone;
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
			fullRange: this.frame.colorRange === NodeAv.AVCOL_RANGE_JPEG,
		});
	}

	close(): void {
		this.frame.free();
	}

	allocationSize(options: VideoFrameCopyToOptions): number {
		// 3. Let combinedLayout be the result of running the Parse VideoFrameCopyToOptions algorithm with options.
		// 4. If combinedLayout is an exception, throw combinedLayout.
		const combinedLayout = ParseVideoFrameCopyToOptions(this, options);

		// 5. Return combinedLayout's allocationSize.
		return combinedLayout.allocationSize;
	}

	async copyTo(
		destination: AllowSharedBufferSource,
		options: VideoFrameCopyToOptions,
	): Promise<PlaneLayout[]> {
		const format = this.getFormat();
		assert(format !== null);

		// 3. Let combinedLayout be the result of running the Parse VideoFrameCopyToOptions algorithm with options.
		const combinedLayout = ParseVideoFrameCopyToOptions(this, options);

		// 4. If destination.byteLength is less than combinedLayout’s allocationSize, return a promise rejected with
		// // eslint-disable-next-line @stylistic/max-len
		const destBytes = toUint8Array(destination);
		if (destBytes.byteLength < combinedLayout.allocationSize) {
			throw new TypeError(
				`Destination buffer too small. Required: ${combinedLayout.allocationSize},`
				+ ` Available: ${destBytes.byteLength}`,
			);
		}

		// 5. If options.format is equal to one of RGBA, RGBX, BGRA, BGRX then:
		if (options.format && ['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(options.format) && options.format !== format) {
			// Let newOptions be the result of running the Clone Configuration algorithm with options.
			// Assign undefined to newOptions.format.
			const newOptions = { ...options };
			delete newOptions.format;

			// Let rgbFrame be the result of running the Convert to RGB frame algorithm with this, options.format,
			// and options.colorSpace.
			const rgbFrame = await ConvertToRGBFrame(this, options.format, options.colorSpace);

			// Return the result of calling copyTo() on rgbFrame with destination and newOptions.
			try {
				const result = await rgbFrame.copyTo(destination, newOptions);
				rgbFrame.close();
				return result;
			} catch (e) {
				rgbFrame.close();
				throw e;
			}
		}

		// 6. Let p be a new Promise. (Implicit)
		// 7. Let copyStepsQueue be the result of starting a new parallel queue. (Implicit)
		// 8. Let planeLayouts be a new list.
		const planeLayouts: PlaneLayout[] = [];

		// Enqueue the following steps to copyStepsQueue: (fuck the queuing part)

		// Let resource be the media resource referenced by [[resource reference]].
		// (this.data)

		// Let numPlanes be the number of planes as defined by [[format]].
		const planes = getPlaneConfigs(format);
		const numPlanes = planes.length;

		// Let planeIndex be 0.
		// While planeIndex is less than combinedLayout’s numPlanes:
		for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
			const computedLayout = combinedLayout.computedLayouts[planeIndex]!;

			// Let sourceStride be the stride of the plane in resource as identified by planeIndex.
			let sourceStride = 0;
			let sourceStartOffset = 0;

			sourceStride = this.frame.linesize[planeIndex]!;
			const planeBuffer = this.frame.data![planeIndex]!;
			if (!planeBuffer) {
				throw new Error(`Missing data for plane ${planeIndex}`);
			}
			const sourceData = new Uint8Array(planeBuffer.buffer, planeBuffer.byteOffset, planeBuffer.byteLength);
			sourceStartOffset = 0;

			// Let sourceOffset be the product of multiplying computedLayout’s sourceTop by sourceStride
			let sourceOffset = computedLayout.sourceTop * sourceStride;

			// Add computedLayout’s sourceLeftBytes to sourceOffset.
			sourceOffset += computedLayout.sourceLeftBytes;

			// Adjust for the base offset of the plane in the source buffer
			sourceOffset += sourceStartOffset;

			// Let destinationOffset be computedLayout’s destinationOffset.
			let destinationOffset = computedLayout.destinationOffset;

			// Let rowBytes be computedLayout’s sourceWidthBytes.
			const rowBytes = computedLayout.sourceWidthBytes;

			// Let layout be a new PlaneLayout, with offset set to destinationOffset and stride set to rowBytes.
			// This is a spec error actually (https://github.com/w3c/webcodecs/issues/918)
			const layout: PlaneLayout = {
				offset: destinationOffset,
				stride: computedLayout.destinationStride,
			};

			// Let row be 0.
			// While row is less than computedLayout’s sourceHeight:
			for (let row = 0; row < computedLayout.sourceHeight; row++) {
				// Copy rowBytes bytes from resource starting at sourceOffset to destination starting
				// at destinationOffset.
				if (sourceOffset + rowBytes > sourceData.byteLength) {
					throw new Error(`Source buffer OOB read`);
				}
				if (destinationOffset + rowBytes > destBytes.byteLength) {
					throw new Error(`Destination buffer OOB write`);
				}

				const srcSub = sourceData.subarray(sourceOffset, sourceOffset + rowBytes);
				destBytes.set(srcSub, destinationOffset);

				// Increment sourceOffset by sourceStride.
				sourceOffset += sourceStride;

				// Increment destinationOffset by computedLayout’s destinationStride.
				destinationOffset += computedLayout.destinationStride;
			}

			// Append layout to planeLayouts.
			planeLayouts.push(layout);
		}

		// Queue a task to resolve p with planeLayouts.
		return planeLayouts;
	}
}

type CombinedBufferLayout = {
	allocationSize: number;
	computedLayouts: ComputedPlaneLayout[];
};

type ComputedPlaneLayout = {
	destinationOffset: number;
	destinationStride: number;
	sourceTop: number;
	sourceHeight: number;
	sourceLeftBytes: number;
	sourceWidthBytes: number;
};

// Taken from the WebCodecs spec
const ParseVideoFrameCopyToOptions = (
	frame: VideoSampleResource,
	options: VideoFrameCopyToOptions,
): CombinedBufferLayout => {
	// 1. Let defaultRect be the result of performing the getter steps for visibleRect.
	const defaultRect: Rectangle = {
		left: 0,
		top: 0,
		width: frame.getCodedWidth(),
		height: frame.getCodedHeight(),
	};

	// 2. Let overrideRect be undefined.
	// 3. If options.rect exists, assign the value of options.rect to overrideRect.
	const overrideRect = options.rect;

	// 4. Let parsedRect be the result of running the Parse Visible Rect algorithm...
	const parsedRect = ParseVisibleRect(
		defaultRect,
		overrideRect,
		frame.getCodedWidth(),
		frame.getCodedHeight(),
		frame.getFormat(),
	);

	// 5. If parsedRect is an exception, return parsedRect. (Handled by throw)

	// 6. Let optLayout be undefined.
	// 7. If options.layout exists, assign its value to optLayout.
	const optLayout = options.layout;

	// 8. Let format be undefined.
	let format: VideoSamplePixelFormat | undefined;

	// 9. If options.format does not exist, assign [[format]] to format.
	if (!options.format || options.format === frame.getFormat()) {
		format = frame.getFormat()!;
	} else if (['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(options.format)) {
		// 10. Otherwise, if options.format is equal to one of RGBA, RGBX, BGRA, BGRX, then assign options.format
		//  to format...
		format = options.format;
	} else {
		throw new Error('NotSupportedError: Invalid destination format');
	}

	// 11. Let combinedLayout be the result of running the Compute Layout and Allocation Size algorithm...
	return ComputeLayoutAndAllocationSize(parsedRect, format, optLayout);
};

// Taken from the WebCodecs spec
const ParseVisibleRect = (
	defaultRect: DOMRectInit,
	overrideRect: DOMRectInit | undefined,
	codedWidth: number,
	codedHeight: number,
	format: VideoSamplePixelFormat | null,
): DOMRectInit => {
	// 1. Let sourceRect be defaultRect
	const sourceRect = { ...defaultRect };

	// 2. If overrideRect is not undefined:
	if (overrideRect !== undefined) {
		// If either of overrideRect.width or height is 0, return a TypeError.
		if (overrideRect.width === 0 || overrideRect.height === 0) {
			throw new TypeError('visibleRect dimensions cannot be zero');
		}
		// If the sum of overrideRect.x and overrideRect.width is greater than codedWidth, return a TypeError.
		if ((overrideRect.x || 0) + (overrideRect.width || 0) > codedWidth) {
			throw new TypeError('visibleRect exceeds codedWidth');
		}
		// If the sum of overrideRect.y and overrideRect.height is greater than codedHeight, return a TypeError.
		if ((overrideRect.y || 0) + (overrideRect.height || 0) > codedHeight) {
			throw new TypeError('visibleRect exceeds codedHeight');
		}
		// Assign overrideRect to sourceRect.
		sourceRect.x = overrideRect.x || 0;
		sourceRect.y = overrideRect.y || 0;
		sourceRect.width = overrideRect.width || 0;
		sourceRect.height = overrideRect.height || 0;
	}

	// 3. Let validAlignment be the result of running the Verify Rect Offset Alignment algorithm.
	const validAlignment = VerifyRectOffsetAlignment(format, sourceRect);

	// 4. If validAlignment is false, throw a TypeError.
	if (!validAlignment) {
		throw new TypeError('visibleRect alignment is invalid for the format');
	}

	// 5. Return sourceRect.
	return sourceRect;
};

// Taken from the WebCodecs spec
const VerifyRectOffsetAlignment = (format: VideoSamplePixelFormat | null, rect: DOMRectInit): boolean => {
	// 1. If format is null, return true.
	if (format === null) return true;

	const planes = getPlaneConfigs(format);

	// 2. Let planeIndex be 0.
	// 3. Let numPlanes be the number of planes as defined by format.
	// 4. While planeIndex is less than numPlanes:
	for (let planeIndex = 0; planeIndex < planes.length; planeIndex++) {
		const plane = planes[planeIndex]!;
		const sampleWidth = plane.widthDivisor;
		const sampleHeight = plane.heightDivisor;

		// If rect.x is not a multiple of sampleWidth, return false.
		if ((rect.x || 0) % sampleWidth !== 0) return false;
		// If rect.y is not a multiple of sampleHeight, return false.
		if ((rect.y || 0) % sampleHeight !== 0) return false;
	}

	return true;
};

// Taken from the WebCodecs spec
const ComputeLayoutAndAllocationSize = (
	parsedRect: DOMRectInit,
	format: VideoSamplePixelFormat,
	layout?: PlaneLayout[],
): CombinedBufferLayout => {
	const planes = getPlaneConfigs(format);

	// 1. Let numPlanes be the number of planes as defined by format.
	const numPlanes = planes.length;

	// 2. If layout is not undefined and its length does not equal numPlanes, throw a TypeError.
	if (layout !== undefined && layout.length !== numPlanes) {
		throw new TypeError(`Layout must have ${numPlanes} planes`);
	}

	// 3. Let minAllocationSize be 0.
	let minAllocationSize = 0;

	// 4. Let computedLayouts be a new list.
	const computedLayouts: ComputedPlaneLayout[] = [];

	// 5. Let endOffsets be a new list.
	const endOffsets: number[] = [];

	// 6. Let planeIndex be 0.
	// 7. While planeIndex < numPlanes:
	for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
		const plane = planes[planeIndex]!;
		const sampleBytes = plane.sampleBytes;
		const sampleWidth = plane.widthDivisor;
		const sampleHeight = plane.heightDivisor;

		// Let computedLayout be a new computed plane layout.
		const computedLayout: ComputedPlaneLayout = {
			destinationOffset: 0,
			destinationStride: 0,
			sourceTop: 0,
			sourceHeight: 0,
			sourceLeftBytes: 0,
			sourceWidthBytes: 0,
		};

		// Set computedLayout’s sourceTop...
		computedLayout.sourceTop = Math.ceil(Math.trunc(parsedRect.y || 0) / sampleHeight);
		// Set computedLayout’s sourceHeight...
		computedLayout.sourceHeight = Math.ceil(Math.trunc(parsedRect.height || 0) / sampleHeight);
		// Set computedLayout’s sourceLeftBytes...
		computedLayout.sourceLeftBytes = Math.floor(Math.trunc(parsedRect.x || 0) / sampleWidth) * sampleBytes;
		// Set computedLayout’s sourceWidthBytes...
		computedLayout.sourceWidthBytes = Math.floor(Math.trunc(parsedRect.width || 0) / sampleWidth) * sampleBytes;

		// If layout is not undefined:
		if (layout !== undefined) {
			const planeLayout = layout[planeIndex]!;
			// If planeLayout.stride is less than computedLayout’s sourceWidthBytes, return a TypeError.
			if (planeLayout.stride < computedLayout.sourceWidthBytes) {
				throw new TypeError(`Stride for plane ${planeIndex} is too small`);
			}
			// Assign planeLayout.offset to computedLayout’s destinationOffset.
			computedLayout.destinationOffset = planeLayout.offset;
			// Assign planeLayout.stride to computedLayout’s destinationStride.
			computedLayout.destinationStride = planeLayout.stride;
		} else {
			// Otherwise:
			// Assign minAllocationSize to computedLayout’s destinationOffset.
			computedLayout.destinationOffset = minAllocationSize;
			// Assign computedLayout’s sourceWidthBytes to computedLayout’s destinationStride.
			computedLayout.destinationStride = computedLayout.sourceWidthBytes;
		}

		// Let planeSize be the product of multiplying computedLayout’s destinationStride and sourceHeight.
		const planeSize = computedLayout.destinationStride * computedLayout.sourceHeight;

		// Let planeEnd be the sum of planeSize and computedLayout’s destinationOffset.
		const planeEnd = planeSize + computedLayout.destinationOffset;

		// If planeSize or planeEnd is greater than maximum range of unsigned long, return a TypeError.
		if (planeEnd > 4294967295) throw new TypeError('Allocation size exceeds limit');

		// Append planeEnd to endOffsets.
		endOffsets.push(planeEnd);

		// Assign the maximum of minAllocationSize and planeEnd to minAllocationSize.
		minAllocationSize = Math.max(minAllocationSize, planeEnd);

		// Check for overlap
		for (let earlierPlaneIndex = 0; earlierPlaneIndex < planeIndex; earlierPlaneIndex++) {
			const earlierLayout = computedLayouts[earlierPlaneIndex]!;
			// If plane A ends before plane B starts, they do not overlap.
			if (
				endOffsets[planeIndex]! <= earlierLayout.destinationOffset
				|| endOffsets[earlierPlaneIndex]! <= computedLayout.destinationOffset
			) {
				continue;
			}
			throw new TypeError('Planes overlap');
		}

		computedLayouts.push(computedLayout);
	}

	// 12. Return combinedLayout.
	return {
		allocationSize: minAllocationSize,
		computedLayouts: computedLayouts,
	};
};

// Taken from the WebCodecs spec
const ConvertToRGBFrame = async (
	frame: NodeAvFrameVideoSampleResource,
	format: VideoPixelFormat,
	colorSpace?: PredefinedColorSpace,
): Promise<NodeAvFrameVideoSampleResource> => {
	// 1. Let convertedFrame be a new VideoFrame...
	// (We construct it at the end, but we prepare the resource here)

	const width = frame.getCodedWidth();
	const height = frame.getCodedHeight();

	const scaler = new NodeAv.SoftwareScaleContext();
	const srcFmt = fromPixelFormat(frame.getFormat()!);
	const dstFmt = fromPixelFormat(format);

	// Configure scaling: Source -> Destination (Visible Size)
	scaler.getContext(
		width, height, srcFmt,
		width, height, dstFmt,
		NodeAv.SWS_BILINEAR,
	);

	// Allocate destination frame
	const dstFrame = new NodeAv.Frame();
	dstFrame.width = width;
	dstFrame.height = height;
	dstFrame.format = dstFmt;
	dstFrame.alloc();
	dstFrame.allocBuffer();

	// Apply destination color space settings to dstFrame
	// If colorSpace is not provided, srgb is used
	const targetColorSpace = colorSpace || 'srgb';
	if (targetColorSpace === 'srgb') {
		dstFrame.colorPrimaries = NodeAv.AVCOL_PRI_BT709;
		dstFrame.colorTrc = NodeAv.AVCOL_TRC_IEC61966_2_1;
		dstFrame.colorSpace = NodeAv.AVCOL_SPC_RGB;
		dstFrame.colorRange = NodeAv.AVCOL_RANGE_JPEG;
	} else if (targetColorSpace === 'display-p3') {
		dstFrame.colorPrimaries = NodeAv.AVCOL_PRI_SMPTE432;
		dstFrame.colorTrc = NodeAv.AVCOL_TRC_IEC61966_2_1;
		dstFrame.colorSpace = NodeAv.AVCOL_SPC_RGB;
		dstFrame.colorRange = NodeAv.AVCOL_RANGE_JPEG;
	}

	const srcFrame = frame.frame;

	// Apply source color space settings to srcFrame (if known)
	// This ensures the scaler knows the input color space for correct conversion
	const frameColorSpace = frame.getColorSpace();
	if (colorSpace) {
		srcFrame.colorPrimaries = mapColorPrimaries(frameColorSpace.primaries ?? 'unknown')
			?? NodeAv.AVCOL_PRI_UNSPECIFIED;
		srcFrame.colorTrc = mapTransferCharacteristics(frameColorSpace.transfer ?? 'unknown')
			?? NodeAv.AVCOL_TRC_UNSPECIFIED;
		srcFrame.colorSpace = mapMatrixCoefficients(frameColorSpace.matrix ?? 'unknown')
			?? NodeAv.AVCOL_SPC_UNSPECIFIED;
		srcFrame.colorRange = frameColorSpace.fullRange
			? NodeAv.AVCOL_RANGE_JPEG
			: NodeAv.AVCOL_RANGE_MPEG;
	}

	try {
		await scaler.scaleFrame(dstFrame, srcFrame);
	} finally {
		scaler.freeContext();
	}

	return new NodeAvFrameVideoSampleResource(dstFrame);
};
