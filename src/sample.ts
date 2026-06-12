/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	assert,
	clamp,
	COLOR_PRIMARIES_MAP,
	isAllowSharedBufferSource,
	MATRIX_COEFFICIENTS_MAP,
	Rotation,
	SECOND_TO_MICROSECOND_FACTOR,
	toDataView,
	toUint8Array,
	SetRequired,
	TRANSFER_CHARACTERISTICS_MAP,
	isFirefox,
	polyfillSymbolDispose,
	assertNever,
	isWebKit,
	Rational,
	simplifyRational,
	Rectangle,
	validateRectangle,
	normalizeRotation,
	roundToMultiple,
	arrayArgmin,
	MaybePromise,
	DeepReadonly,
} from './misc';

polyfillSymbolDispose();

type FinalizationRegistryValue = {
	type: 'video';
	data: VideoFrame | OffscreenCanvas | Uint8Array | VideoSampleResource;
} | {
	type: 'audio';
	data: AudioData | Uint8Array | AudioSampleResource;
};

// Let's manually handle logging the garbage collection errors that are typically logged by the browser. This way, they
// also kick for audio samples (which is normally not the case), making sure any incorrect code is quickly caught.
let lastVideoGcErrorLog = -Infinity;
let lastAudioGcErrorLog = -Infinity;
let finalizationRegistry: FinalizationRegistry<FinalizationRegistryValue> | null = null;
if (typeof FinalizationRegistry !== 'undefined') {
	finalizationRegistry = new FinalizationRegistry<FinalizationRegistryValue>((value) => {
		const now = performance.now();

		if (value.type === 'video') {
			if (now - lastVideoGcErrorLog >= 1000) {
				// This error is annoying but oh so important
				console.error(
					`A VideoSample was garbage collected without first being closed. For proper resource management,`
					+ ` make sure to call close() on all your VideoSamples as soon as you're done using them.`,
				);

				lastVideoGcErrorLog = now;
			}

			if (typeof VideoFrame !== 'undefined' && value.data instanceof VideoFrame) {
				value.data.close(); // Prevent the browser error since we're logging our own
			}
		} else {
			if (now - lastAudioGcErrorLog >= 1000) {
				console.error(
					`An AudioSample was garbage collected without first being closed. For proper resource management,`
					+ ` make sure to call close() on all your AudioSamples as soon as you're done using them.`,
				);

				lastAudioGcErrorLog = now;
			}

			if (typeof AudioData !== 'undefined' && value.data instanceof AudioData) {
				value.data.close();
			}
		}
	});
}

/**
 * Abstract base class for custom video sample resources. Implement this class to provide custom backing
 * for VideoSample instances.
 * @group Samples
 * @public
 */
export abstract class VideoSampleResource {
	/** @internal */
	_referenceCount: number = 0;
	/** @internal */
	_lastAllocationBuffer: ArrayBuffer | null = null;

	/**
	 * Returns the internal pixel format in which the frame is stored.
	 * [See pixel formats](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/format)
	 */
	abstract getFormat(): VideoSamplePixelFormat | null;

	/** Returns the width of the frame in pixels. */
	abstract getCodedWidth(): number;

	/** Returns the height of the frame in pixels. */
	abstract getCodedHeight(): number;

	/** Returns the width of the frame in square pixels, respecting pixel aspect ratio. */
	abstract getSquarePixelWidth(): number;

	/** Returns the height of the frame in square pixels, respecting pixel aspect ratio. */
	abstract getSquarePixelHeight(): number;

	/** Returns the color space of the frame. */
	abstract getColorSpace(): VideoSampleColorSpace;

	/**
	 * Closes this resource, releasing held resources. Called automatically when the last {@link VideoSample} using this
	 * resource is closed.
	 */
	abstract close(): void;

	/**
	 * Returns the data planes that hold the video data for this sample. The returned planes and data must be in the
	 * format returned by `getFormat()`.
	 */
	abstract getDataPlanes(): MaybePromise<VideoDataPlane[]>;

	/**
	 * Returns a new RGB {@link VideoSample} that contains the same content as this sample. The provided `init` object
	 * must be used to set the metadata of this new video sample. When converting from a non-RGB format to RGB, the
	 * conversion must respect `colorSpace`.
	 */
	abstract toRgbSample(
		init: SetRequired<VideoSampleInit, 'timestamp'>,
		colorSpace: PredefinedColorSpace,
	): MaybePromise<VideoSample>;
}

/**
 * Describes a single data plane of a video frame.
 * @group Samples
 * @public
 */
export type VideoDataPlane = {
	/** The data of the plane. */
	data: Uint8Array;
	/** The stride of the plane, in bytes. This is the distance in bytes between the start of each row of pixels. */
	stride: number;
};

/**
 * The list of {@link VideoSample} pixel formats.
 * @group Samples
 * @public
 */
export const VIDEO_SAMPLE_PIXEL_FORMATS = [
	// 4:2:0 Y, U, V
	'I420',
	'I420P10',
	'I420P12',
	// 4:2:0 Y, U, V, A
	'I420A',
	'I420AP10',
	'I420AP12',
	// 4:2:2 Y, U, V
	'I422',
	'I422P10',
	'I422P12',
	// 4:2:2 Y, U, V, A
	'I422A',
	'I422AP10',
	'I422AP12',
	// 4:4:4 Y, U, V
	'I444',
	'I444P10',
	'I444P12',
	// 4:4:4 Y, U, V, A
	'I444A',
	'I444AP10',
	'I444AP12',
	// 4:2:0 Y, UV
	'NV12',
	// 4:4:4 RGBA
	'RGBA',
	// 4:4:4 RGBX (opaque)
	'RGBX',
	// 4:4:4 BGRA
	'BGRA',
	// 4:4:4 BGRX (opaque)
	'BGRX',
] as const;
const VIDEO_SAMPLE_PIXEL_FORMATS_SET = new Set(VIDEO_SAMPLE_PIXEL_FORMATS);

/**
 * The internal pixel format with which a {@link VideoSample} is stored.
 * [See pixel formats](https://www.w3.org/TR/webcodecs/#pixel-format) for more.
 * @group Samples
 * @public
 */
export type VideoSamplePixelFormat = typeof VIDEO_SAMPLE_PIXEL_FORMATS[number];

/**
 * Metadata used for VideoSample initialization.
 * @group Samples
 * @public
 */
export type VideoSampleInit = {
	/**
	 * The internal pixel format in which the frame is stored.
	 * [See pixel formats](https://www.w3.org/TR/webcodecs/#pixel-format)
	 */
	format?: VideoSamplePixelFormat;
	/** The width of the frame in pixels. */
	codedWidth?: number;
	/** The height of the frame in pixels. */
	codedHeight?: number;
	/** The rotation of the frame in degrees, clockwise. */
	rotation?: Rotation;
	/** The presentation timestamp of the frame in seconds. */
	timestamp?: number;
	/** The duration of the frame in seconds. */
	duration?: number;
	/** The color space of the frame. */
	colorSpace?: VideoColorSpaceInit;
	/** The byte layout of the planes of the frame. */
	layout?: PlaneLayout[];
	/** Visible region in the coded frame. When omitted, the rect defaults to `(0, 0, codedWidth, codedHeight)`. */
	visibleRect?: Rectangle | undefined;
	/** Width of the frame in pixels after applying aspect ratio adjustments and rotation. */
	displayWidth?: number | undefined;
	/** Height of the frame in pixels after applying aspect ratio adjustments and rotation. */
	displayHeight?: number | undefined;
	/** The encode options to use when this sample is passed to an encoder. */
	encodeOptions?: DeepReadonly<VideoEncoderEncodeOptions>;

	/** @internal */
	_doNotCopy?: boolean;
};

/**
 * Represents a raw, unencoded video sample (frame). Mainly used as an expressive wrapper around WebCodecs API's
 * [`VideoFrame`](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame), but can also be used standalone.
 * @group Samples
 * @public
 */
export class VideoSample implements Disposable {
	/** @internal */
	_data!: VideoFrame | OffscreenCanvas | Uint8Array | VideoSampleResource | null;
	/**
	 * Used for the ArrayBuffer-backed case.
	 * @internal
	 */
	_layout!: PlaneLayout[] | null;
	/** @internal */
	_closed: boolean = false;

	/**
	 * The internal pixel format in which the frame is stored. Will be `null` if it's using an arbitrary internal
	 * format not representable by `VideoSamplePixelFormat`.
	 * [See pixel formats](https://www.w3.org/TR/webcodecs/#pixel-format)
	 */
	readonly format!: VideoSamplePixelFormat | null;
	/** The visible region of the frame in the coded pixel grid. */
	readonly visibleRect!: Rectangle;
	/** The width of the frame in square pixels (respecting pixel aspect ratio), before rotation is applied. */
	readonly squarePixelWidth!: number;
	/** The height of the frame in square pixels (respecting pixel aspect ratio), before rotation is applied. */
	readonly squarePixelHeight!: number;
	/** The rotation of the frame in degrees, clockwise. */
	readonly rotation!: Rotation;
	/**
	 * The pixel aspect ratio of the frame, as a rational number in its reduced form. Most videos use
	 * square pixels (1:1).
	 */
	readonly pixelAspectRatio!: Rational;
	/**
	 * The presentation timestamp of the frame in seconds. May be negative. Frames with negative end timestamps should
	 * not be presented.
	 */
	readonly timestamp!: number;
	/** The duration of the frame in seconds. */
	readonly duration!: number;
	/** The color space of the frame. */
	readonly colorSpace!: VideoSampleColorSpace;
	/** The encode options to use when this sample is passed to an encoder. */
	readonly encodeOptions!: DeepReadonly<VideoEncoderEncodeOptions>;

	/** The width of the frame in pixels. */
	get codedWidth() {
		// This is wrong, but the fix is a v2 thing
		return this.visibleRect.width;
	}

	/** The height of the frame in pixels. */
	get codedHeight() {
		// Same here
		return this.visibleRect.height;
	}

	/** The display width of the frame in pixels, after aspect ratio adjustment and rotation. */
	get displayWidth() {
		return this.rotation % 180 === 0 ? this.squarePixelWidth : this.squarePixelHeight;
	}

	/** The display height of the frame in pixels, after aspect ratio adjustment and rotation. */
	get displayHeight() {
		return this.rotation % 180 === 0 ? this.squarePixelHeight : this.squarePixelWidth;
	}

	/** The presentation timestamp of the frame in microseconds. */
	get microsecondTimestamp() {
		return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.timestamp);
	}

	/** The duration of the frame in microseconds. */
	get microsecondDuration() {
		return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.duration);
	}

	/**
	 * Whether this sample uses a pixel format that can hold transparency data. Note that this doesn't necessarily mean
	 * that the sample is transparent.
	 */
	get hasAlpha() {
		return this.format && this.format.includes('A');
	}

	/**
	 * Creates a new {@link VideoSample} from a
	 * [`VideoFrame`](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame). This is essentially a near zero-cost
	 * wrapper around `VideoFrame`. The sample's metadata is optionally refined using the data specified in `init`.
	*/
	constructor(data: VideoFrame, init?: VideoSampleInit);
	/**
	 * Creates a new {@link VideoSample} from a
	 * [`CanvasImageSource`](https://udn.realityripple.com/docs/Web/API/CanvasImageSource), similar to the
	 * [`VideoFrame`](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame) constructor. When `VideoFrame` is
	 * available, this is simply a wrapper around its constructor. If not, it will copy the source's image data to an
	 * internal canvas for later use.
	 */
	constructor(data: CanvasImageSource, init: SetRequired<VideoSampleInit, 'timestamp'>);
	/**
	 * Creates a new {@link VideoSample} from raw pixel data specified in `data`. Additional metadata must be provided
	 * in `init`.
	 */
	constructor(
		data: AllowSharedBufferSource,
		init: SetRequired<VideoSampleInit, 'format' | 'codedWidth' | 'codedHeight' | 'timestamp'>
	);
	/**
	 * Creates a new {@link VideoSample} backed by a custom {@link VideoSampleResource}.
	 */
	constructor(resource: VideoSampleResource, init: SetRequired<VideoSampleInit, 'timestamp'>);
	constructor(
		data: VideoFrame | CanvasImageSource | AllowSharedBufferSource | VideoSampleResource,
		init?: VideoSampleInit,
	) {
		if (
			data instanceof ArrayBuffer
			|| (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)
			|| ArrayBuffer.isView(data)
		) {
			if (!init || typeof init !== 'object') {
				throw new TypeError('init must be an object.');
			}
			if (init.format === undefined || !VIDEO_SAMPLE_PIXEL_FORMATS_SET.has(init.format)) {
				throw new TypeError('init.format must be one of: ' + VIDEO_SAMPLE_PIXEL_FORMATS.join(', '));
			}
			if (!Number.isInteger(init.codedWidth) || init.codedWidth! <= 0) {
				throw new TypeError('init.codedWidth must be a positive integer.');
			}
			if (!Number.isInteger(init.codedHeight) || init.codedHeight! <= 0) {
				throw new TypeError('init.codedHeight must be a positive integer.');
			}
			if (init.rotation !== undefined && ![0, 90, 180, 270].includes(init.rotation)) {
				throw new TypeError('init.rotation, when provided, must be 0, 90, 180, or 270.');
			}
			if (!Number.isFinite(init.timestamp)) {
				throw new TypeError('init.timestamp must be a number.');
			}
			if (init.duration !== undefined && (!Number.isFinite(init.duration) || init.duration < 0)) {
				throw new TypeError('init.duration, when provided, must be a non-negative number.');
			}
			if (init.layout !== undefined) {
				if (!Array.isArray(init.layout)) {
					throw new TypeError('init.layout, when provided, must be an array.');
				}

				for (const plane of init.layout) {
					if (!plane || typeof plane !== 'object' || Array.isArray(plane)) {
						throw new TypeError('Each entry in init.layout must be an object.');
					}
					if (!Number.isInteger(plane.offset) || plane.offset < 0) {
						throw new TypeError('plane.offset must be a non-negative integer.');
					}
					if (!Number.isInteger(plane.stride) || plane.stride < 0) {
						throw new TypeError('plane.stride must be a non-negative integer.');
					}
				}
			}
			if (init.visibleRect !== undefined) {
				validateRectangle(init.visibleRect, 'init.visibleRect');
			}
			if (
				init.displayWidth !== undefined
				&& (!Number.isInteger(init.displayWidth) || init.displayWidth <= 0)
			) {
				throw new TypeError('init.displayWidth, when provided, must be a positive integer.');
			}
			if (
				init.displayHeight !== undefined
				&& (!Number.isInteger(init.displayHeight) || init.displayHeight <= 0)
			) {
				throw new TypeError('init.displayHeight, when provided, must be a positive integer.');
			}
			if ((init.displayWidth !== undefined) !== (init.displayHeight !== undefined)) {
				throw new TypeError(
					'init.displayWidth and init.displayHeight must be either both provided or both omitted.',
				);
			}

			this._data = init._doNotCopy
				? toUint8Array(data)
				: toUint8Array(data).slice(); // Copy it
			this._layout = init.layout ?? createDefaultPlaneLayout(init.format, init.codedWidth!, init.codedHeight!);

			this.format = init.format;
			this.rotation = init.rotation ?? 0;
			this.timestamp = init.timestamp!;
			this.duration = init.duration ?? 0;

			let colorSpaceInit = init.colorSpace ?? null;
			if (colorSpaceInit === null) {
				if (
					this.format === 'RGBA' || this.format === 'RGBX'
					|| this.format === 'BGRA' || this.format === 'BGRX'
				) {
					// sRGB Color Space
					colorSpaceInit = {
						primaries: 'bt709',
						transfer: 'iec61966-2-1',
						matrix: 'rgb',
						fullRange: true,
					};
				} else {
					// REC709 Color Space
					colorSpaceInit = {
						primaries: 'bt709',
						transfer: 'bt709',
						matrix: 'bt709',
						fullRange: false,
					};
				}
			}

			this.colorSpace = new VideoSampleColorSpace(colorSpaceInit);

			this.visibleRect = {
				left: init.visibleRect?.left ?? 0,
				top: init.visibleRect?.top ?? 0,
				width: init.visibleRect?.width ?? init.codedWidth!,
				height: init.visibleRect?.height ?? init.codedHeight!,
			};

			if (init.displayWidth !== undefined) {
				this.squarePixelWidth = this.rotation % 180 === 0 ? init.displayWidth : init.displayHeight!;
				this.squarePixelHeight = this.rotation % 180 === 0 ? init.displayHeight! : init.displayWidth;
			} else {
				this.squarePixelWidth = this.visibleRect.width;
				this.squarePixelHeight = this.visibleRect.height;
			}
		} else if (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) {
			if (init?.rotation !== undefined && ![0, 90, 180, 270].includes(init.rotation)) {
				throw new TypeError('init.rotation, when provided, must be 0, 90, 180, or 270.');
			}
			if (init?.timestamp !== undefined && !Number.isFinite(init?.timestamp)) {
				throw new TypeError('init.timestamp, when provided, must be a number.');
			}
			if (init?.duration !== undefined && (!Number.isFinite(init.duration) || init.duration < 0)) {
				throw new TypeError('init.duration, when provided, must be a non-negative number.');
			}
			if (init?.visibleRect !== undefined) {
				validateRectangle(init.visibleRect, 'init.visibleRect');
			}

			this._data = data;
			this._layout = null;

			this.format = data.format;
			this.visibleRect = {
				left: data.visibleRect?.x ?? 0,
				top: data.visibleRect?.y ?? 0,
				width: data.visibleRect?.width ?? data.codedWidth,
				height: data.visibleRect?.height ?? data.codedHeight,
			};
			// The VideoFrame's rotation is ignored here. It's still a new field, and I'm not sure of any application
			// where the browser makes use of it. If a case gets found, I'll add it.
			this.rotation = init?.rotation ?? 0;

			// Assuming no innate VideoFrame rotation here
			this.squarePixelWidth = data.displayWidth;
			this.squarePixelHeight = data.displayHeight;

			this.timestamp = init?.timestamp ?? data.timestamp / 1e6;
			this.duration = init?.duration ?? (data.duration ?? 0) / 1e6;
			this.colorSpace = new VideoSampleColorSpace(data.colorSpace);
		} else if (
			(typeof HTMLImageElement !== 'undefined' && data instanceof HTMLImageElement)
			|| (typeof SVGImageElement !== 'undefined' && data instanceof SVGImageElement)
			|| (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap)
			|| (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement)
			|| (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement)
			|| (typeof OffscreenCanvas !== 'undefined' && data instanceof OffscreenCanvas)
		) {
			if (!init || typeof init !== 'object') {
				throw new TypeError('init must be an object.');
			}
			if (init.rotation !== undefined && ![0, 90, 180, 270].includes(init.rotation)) {
				throw new TypeError('init.rotation, when provided, must be 0, 90, 180, or 270.');
			}
			if (!Number.isFinite(init.timestamp)) {
				throw new TypeError('init.timestamp must be a number.');
			}
			if (init.duration !== undefined && (!Number.isFinite(init.duration) || init.duration < 0)) {
				throw new TypeError('init.duration, when provided, must be a non-negative number.');
			}

			if (typeof VideoFrame !== 'undefined') {
				return new VideoSample(
					new VideoFrame(data, {
						timestamp: Math.trunc(init.timestamp! * SECOND_TO_MICROSECOND_FACTOR),
						// Drag 0 to undefined
						duration: Math.trunc((init.duration ?? 0) * SECOND_TO_MICROSECOND_FACTOR) || undefined,
					}),
					init,
				);
			}

			let width = 0;
			let height = 0;

			// Determine the dimensions of the thing
			if ('naturalWidth' in data) {
				width = data.naturalWidth;
				height = data.naturalHeight;
			} else if ('videoWidth' in data) {
				width = data.videoWidth;
				height = data.videoHeight;
			} else if ('width' in data) {
				width = Number(data.width);
				height = Number(data.height);
			}

			if (!width || !height) {
				throw new TypeError('Could not determine dimensions.');
			}

			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext('2d', {
				alpha: isFirefox(), // Firefox has VideoFrame glitches with opaque canvases
				willReadFrequently: true,
			});
			if (!context) {
				throw new Error(
					'OffscreenCanvas must have support for the \'2d\' context in order to create a VideoSample from'
					+ ' this data.',
				);
			}

			// Draw it to a canvas
			context.drawImage(data, 0, 0);
			this._data = canvas;
			this._layout = null;

			this.format = 'RGBX';
			this.visibleRect = { left: 0, top: 0, width, height };
			this.squarePixelWidth = width;
			this.squarePixelHeight = height;
			this.rotation = init.rotation ?? 0;
			this.timestamp = init.timestamp!;
			this.duration = init.duration ?? 0;
			this.colorSpace = new VideoSampleColorSpace({
				matrix: 'rgb',
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				fullRange: true,
			});
		} else if (data instanceof VideoSampleResource) {
			if (!init || typeof init !== 'object') {
				throw new TypeError('init must be an object.');
			}
			if (init.rotation !== undefined && ![0, 90, 180, 270].includes(init.rotation)) {
				throw new TypeError('init.rotation, when provided, must be 0, 90, 180, or 270.');
			}
			if (!Number.isFinite(init.timestamp)) {
				throw new TypeError('init.timestamp must be a number.');
			}
			if (init.duration !== undefined && (!Number.isFinite(init.duration) || init.duration < 0)) {
				throw new TypeError('init.duration, when provided, must be a non-negative number.');
			}

			this._data = data;
			data._referenceCount++;

			this.format = data.getFormat();
			if (this.format !== null && !VIDEO_SAMPLE_PIXEL_FORMATS.includes(this.format)) {
				throw new TypeError('getFormat() must return a VideoSamplePixelFormat or null.');
			}

			this.visibleRect = {
				left: 0,
				top: 0,
				width: data.getCodedWidth(),
				height: data.getCodedHeight(),
			};
			if (!Number.isInteger(this.visibleRect.width) || this.visibleRect.width <= 0) {
				throw new TypeError('getCodedWidth() must return a positive integer.');
			}
			if (!Number.isInteger(this.visibleRect.height) || this.visibleRect.height <= 0) {
				throw new TypeError('getCodedHeight() must return a positive integer.');
			}

			this.squarePixelWidth = data.getSquarePixelWidth();
			if (!Number.isInteger(this.squarePixelWidth) || this.squarePixelWidth <= 0) {
				throw new TypeError('getSquarePixelWidth() must return a positive integer.');
			}

			this.squarePixelHeight = data.getSquarePixelHeight();
			if (!Number.isInteger(this.squarePixelHeight) || this.squarePixelHeight <= 0) {
				throw new TypeError('getSquarePixelHeight() must return a positive integer.');
			}

			this.rotation = init.rotation ?? 0;
			this.timestamp = init.timestamp!;
			this.duration = init.duration ?? 0;
			this.colorSpace = data.getColorSpace();
		} else {
			throw new TypeError(
				'Invalid data type: Must be a BufferSource, CanvasImageSource, or VideoSampleResource.',
			);
		}

		this.encodeOptions = init?.encodeOptions ?? {};

		this.pixelAspectRatio = simplifyRational({
			num: this.squarePixelWidth * this.codedHeight,
			den: this.squarePixelHeight * this.codedWidth,
		});
		finalizationRegistry?.register(this, { type: 'video', data: this._data }, this);
	}

	/** Clones this video sample. */
	clone() {
		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		assert(this._data !== null);

		if (this._data instanceof VideoSampleResource) {
			return new VideoSample(this._data, {
				timestamp: this.timestamp,
				duration: this.duration,
				rotation: this.rotation,
				encodeOptions: this.encodeOptions,
			});
		} else if (isVideoFrame(this._data)) {
			return new VideoSample(this._data.clone(), {
				timestamp: this.timestamp,
				duration: this.duration,
				rotation: this.rotation,
				encodeOptions: this.encodeOptions,
			});
		} else if (this._data instanceof Uint8Array) {
			assert(this._layout);

			return new VideoSample(this._data, {
				format: this.format!,
				layout: this._layout,
				codedWidth: this.codedWidth,
				codedHeight: this.codedHeight,
				timestamp: this.timestamp,
				duration: this.duration,
				colorSpace: this.colorSpace,
				rotation: this.rotation,
				visibleRect: this.visibleRect,
				displayWidth: this.displayWidth,
				displayHeight: this.displayHeight,
				encodeOptions: this.encodeOptions,

				// It's already been copied, if we copy it again we make the clone unnecessarily expensive
				_doNotCopy: true,
			});
		} else {
			return new VideoSample(this._data, {
				format: this.format!,
				codedWidth: this.codedWidth,
				codedHeight: this.codedHeight,
				timestamp: this.timestamp,
				duration: this.duration,
				colorSpace: this.colorSpace,
				rotation: this.rotation,
				visibleRect: this.visibleRect,
				displayWidth: this.displayWidth,
				displayHeight: this.displayHeight,
				encodeOptions: this.encodeOptions,
			});
		}
	}

	/**
	 * Closes this video sample, releasing held resources. Video samples should be closed as soon as they are not
	 * needed anymore.
	 */
	close() {
		if (this._closed) {
			return;
		}

		finalizationRegistry?.unregister(this);

		if (this._data instanceof VideoSampleResource) {
			this._data._referenceCount--;
			if (this._data._referenceCount === 0) {
				this._data.close();
			}
		} else if (isVideoFrame(this._data)) {
			this._data.close();
		} else {
			this._data = null; // GC that shit
		}

		this._closed = true;
	}

	/**
	 * Returns the number of bytes required to hold this video sample's pixel data.
	 */
	allocationSize(options: VideoFrameCopyToOptions = {}): number {
		validateVideoFrameCopyToOptions(options);

		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		if ((options.format ?? this.format) == null) {
			// https://github.com/Vanilagy/mediabunny/issues/267
			// https://github.com/w3c/webcodecs/issues/920
			throw new Error('Cannot get allocation size when format is null.');
		}

		if (isVideoFrame(this._data)) {
			// Call the native method purely for performance
			return this._data.allocationSize(options);
		}

		const combinedLayout = ParseVideoFrameCopyToOptions(this, options);
		return combinedLayout.allocationSize;
	}

	/**
	 * Copies this video sample's pixel data to an ArrayBuffer or ArrayBufferView.
	 * @returns The byte layout of the planes of the copied data.
	 */
	async copyTo(destination: AllowSharedBufferSource, options: VideoFrameCopyToOptions = {}): Promise<PlaneLayout[]> {
		if (!isAllowSharedBufferSource(destination)) {
			throw new TypeError('destination must be an ArrayBuffer or an ArrayBuffer view.');
		}
		validateVideoFrameCopyToOptions(options);

		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}
		if ((options.format ?? this.format) == null) {
			throw new Error('Cannot copy video sample data when format is null.');
		}

		assert(this._data !== null);

		if (isVideoFrame(this._data)) {
			return this._data.copyTo(destination, options);
		}

		// Detect non-RGB to RGB conversion
		if (
			options.format
			&& !['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(this.format!)
			&& ['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(options.format)
		) {
			// RGB conversion for custom VideoSampleResource
			if (this._data instanceof VideoSampleResource) {
				using rgbSample = await this._data.toRgbSample(
					{
						timestamp: this.timestamp,
						duration: this.duration,
						rotation: this.rotation,
					},
					options.colorSpace ?? 'srgb',
				);
				if (!(rgbSample instanceof VideoSample)) {
					throw new TypeError('toRgbSample() must return a VideoSample.');
				}
				if (!['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(rgbSample.format!)) {
					throw new Error(
						`Sample returned by toRgbSample was expected to have an RGB format, got`
						+ ` '${rgbSample.format}' instead.`,
					);
				}
				// Note that we DON'T force the RGB format to be exactly what was requested; any RGB format will do

				return await rgbSample.copyTo(destination, options); // 'await' is intentional here cuz of using
			} else {
				if (typeof VideoFrame === 'undefined') {
					throw new Error(
						'For this sample, converting from a non-RGB to an RGB format requires VideoFrame to'
						+ ' be defined.',
					);
				}

				const tempFrame = this.toVideoFrame();
				const result = await tempFrame.copyTo(destination, options);
				tempFrame.close();

				return result;
			}
		}

		const combinedLayout = ParseVideoFrameCopyToOptions(this, options);
		assert(this.format);

		// 4. If destination.byteLength is less than combinedLayout’s allocationSize, return a promise rejected with
		const destBytes = toUint8Array(destination);
		if (destBytes.byteLength < combinedLayout.allocationSize) {
			throw new TypeError(
				`Destination buffer too small. Required: ${combinedLayout.allocationSize},`
				+ ` Available: ${destBytes.byteLength}`,
			);
		}

		const planeConfigs = getPlaneConfigs(this.format);
		let dataPlanes: VideoDataPlane[];

		if (this._data instanceof VideoSampleResource) {
			let result = this._data.getDataPlanes();
			if (result instanceof Promise) result = await result;

			if (
				!Array.isArray(result)
				|| result.some(x => !(x.data instanceof Uint8Array) || !Number.isInteger(x.stride) || x.stride < 0)
			) {
				throw new TypeError(
					'getDataPlanes() must return an array of objects with a Uint8Array "data" property and a'
					+ ' non-negative integer "stride" property.',
				);
			}

			dataPlanes = result;
		} else if (this._data instanceof Uint8Array) {
			assert(this._layout);
			assert(this._layout.length === planeConfigs.length);

			dataPlanes = this._layout.map((planeLayout, i) => {
				const height = Math.ceil(this.codedHeight / planeConfigs[i]!.heightDivisor);

				return {
					data: (this._data as Uint8Array).subarray(
						planeLayout.offset,
						planeLayout.offset + planeLayout.stride * height,
					),
					stride: planeLayout.stride,
				};
			});
		} else {
			const canvas = this._data;
			const context = canvas.getContext('2d');
			assert(context); // We already got it earlier so it's definitely available

			const imageData = context.getImageData(0, 0, this.codedWidth, this.codedHeight);

			dataPlanes = [{
				data: toUint8Array(imageData.data),
				stride: 4 * this.codedWidth,
			}];
		}

		// Algo taken from WebCodecs spec:

		// 6. Let p be a new Promise. (Implicit)
		// 7. Let copyStepsQueue be the result of starting a new parallel queue. (Implicit)
		// 8. Let planeLayouts be a new list.
		const planeLayouts: PlaneLayout[] = [];

		// Enqueue the following steps to copyStepsQueue: (fuck the queuing part)

		// Let resource be the media resource referenced by [[resource reference]].
		// (this.data)

		// Let numPlanes be the number of planes as defined by [[format]].
		const numPlanes = planeConfigs.length;

		// Let planeIndex be 0.
		// While planeIndex is less than combinedLayout’s numPlanes:
		for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
			const computedLayout = combinedLayout.computedLayouts[planeIndex]!;

			// Let sourceStride be the stride of the plane in resource as identified by planeIndex.
			const sourceStride = dataPlanes[planeIndex]!.stride;
			const sourceData = dataPlanes[planeIndex]!.data;

			// Let sourceOffset be the product of multiplying computedLayout’s sourceTop by sourceStride
			let sourceOffset = computedLayout.sourceTop * sourceStride;

			// Add computedLayout’s sourceLeftBytes to sourceOffset.
			sourceOffset += computedLayout.sourceLeftBytes;

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
					throw new Error(`Source buffer OOB read.`);
				}
				if (destinationOffset + rowBytes > destBytes.byteLength) {
					throw new Error(`Destination buffer OOB write.`);
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

		// Now, handle converting between different RGB formats
		if (options.format !== undefined) {
			const needsRgbConversion = this.format.startsWith('RGB') !== options.format.startsWith('RGB');

			// Going X->A requires setting the alpha to 255, going the other way doesn't since the value of X is w/e
			const needsAlphaConversion = this.format.includes('X') && options.format.includes('A');

			if (needsRgbConversion || needsAlphaConversion) {
				// Loop over the destination bytes
				for (let i = 0; i < combinedLayout.allocationSize; i += 4) {
					if (needsRgbConversion) {
						// Swap R with B
						const r = destBytes[i]!;
						const b = destBytes[i + 2]!;
						destBytes[i] = b;
						destBytes[i + 2] = r;
					}

					if (needsAlphaConversion) {
						destBytes[i + 3] = 255;
					}
				}
			}
		}

		// Queue a task to resolve p with planeLayouts.
		return planeLayouts;
	}

	/**
	 * Converts this video sample to a VideoFrame for use with the WebCodecs API. The VideoFrame returned by this
	 * method *must* be closed separately from this video sample.
	 */
	toVideoFrame(): VideoFrame {
		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		assert(this._data !== null);

		if (this._data instanceof VideoSampleResource) {
			if (this.format === null) {
				throw new Error(
					'Cannot convert a VideoSampleResource-backed VideoSample to VideoFrame if format is null.',
				);
			}

			const planes = this._data.getDataPlanes();
			if (planes instanceof Promise) {
				throw new Error(
					'Cannot convert a VideoSampleResource-backed VideoSample to VideoFrame if getDataPlanes() returns'
					+ ' a promise.',
				);
			}

			// We can't use allocationSize since that method assumes a tight packing
			const size = planes.reduce((a, b) => a + b.data.byteLength, 0);
			const buffer = new Uint8Array(size);

			let offset = 0;
			const offsets: number[] = [];

			for (const plane of planes) {
				buffer.set(plane.data, offset);
				offsets.push(offset);

				offset += plane.data.byteLength;
			}

			return new VideoFrame(buffer, {
				format: this.format as VideoPixelFormat,
				layout: planes.map((x, i) => ({
					offset: offsets[i]!,
					stride: x.stride,
				})),
				codedWidth: this.codedWidth,
				codedHeight: this.codedHeight,
				timestamp: this.microsecondTimestamp,
				duration: this.microsecondDuration,
				colorSpace: this.colorSpace,
				displayWidth: this.squarePixelWidth, // Not display* since we're not passing rotation
				displayHeight: this.squarePixelHeight,
			});
		} else if (isVideoFrame(this._data)) {
			return new VideoFrame(this._data, {
				timestamp: this.microsecondTimestamp,
				duration: this.microsecondDuration || undefined, // Drag 0 duration to undefined, glitches some codecs
			});
		} else if (this._data instanceof Uint8Array) {
			return new VideoFrame(this._data, {
				format: this.format! as VideoPixelFormat,
				codedWidth: this.codedWidth,
				codedHeight: this.codedHeight,
				timestamp: this.microsecondTimestamp,
				duration: this.microsecondDuration || undefined,
				colorSpace: this.colorSpace,
				displayWidth: this.squarePixelWidth, // Not display* since we're not passing rotation
				displayHeight: this.squarePixelHeight,
			});
		} else {
			return new VideoFrame(this._data, {
				timestamp: this.microsecondTimestamp,
				duration: this.microsecondDuration || undefined,
			});
		}
	}

	/**
	 * Draws the video sample to a 2D canvas context. Rotation metadata will be taken into account.
	 *
	 * @param dx - The x-coordinate in the destination canvas at which to place the top-left corner of the source image.
	 * @param dy - The y-coordinate in the destination canvas at which to place the top-left corner of the source image.
	 * @param dWidth - The width in pixels with which to draw the image in the destination canvas.
	 * @param dHeight - The height in pixels with which to draw the image in the destination canvas.
	 */
	draw(
		context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		dx: number,
		dy: number,
		dWidth?: number,
		dHeight?: number,
	): void;
	/**
	 * Draws the video sample to a 2D canvas context. Rotation metadata will be taken into account.
	 *
	 * @param sx - The x-coordinate of the top left corner of the sub-rectangle of the source image to draw into the
	 * destination context.
	 * @param sy - The y-coordinate of the top left corner of the sub-rectangle of the source image to draw into the
	 * destination context.
	 * @param sWidth - The width of the sub-rectangle of the source image to draw into the destination context.
	 * @param sHeight - The height of the sub-rectangle of the source image to draw into the destination context.
	 * @param dx - The x-coordinate in the destination canvas at which to place the top-left corner of the source image.
	 * @param dy - The y-coordinate in the destination canvas at which to place the top-left corner of the source image.
	 * @param dWidth - The width in pixels with which to draw the image in the destination canvas.
	 * @param dHeight - The height in pixels with which to draw the image in the destination canvas.
	 */
	draw(
		context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		sx: number,
		sy: number,
		sWidth: number,
		sHeight: number,
		dx: number,
		dy: number,
		dWidth?: number,
		dHeight?: number,
	): void;
	draw(
		context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		arg1: number,
		arg2: number,
		arg3?: number,
		arg4?: number,
		arg5?: number,
		arg6?: number,
		arg7?: number,
		arg8?: number,
	) {
		let sx = 0;
		let sy = 0;
		let sWidth = this.displayWidth;
		let sHeight = this.displayHeight;
		let dx = 0;
		let dy = 0;
		let dWidth = this.displayWidth;
		let dHeight = this.displayHeight;

		if (arg5 !== undefined) {
			sx = arg1!;
			sy = arg2!;
			sWidth = arg3!;
			sHeight = arg4!;
			dx = arg5;
			dy = arg6!;

			if (arg7 !== undefined) {
				dWidth = arg7;
				dHeight = arg8!;
			} else {
				dWidth = sWidth;
				dHeight = sHeight;
			}
		} else {
			dx = arg1;
			dy = arg2;

			if (arg3 !== undefined) {
				dWidth = arg3;
				dHeight = arg4!;
			}
		}

		if (!(
			(typeof CanvasRenderingContext2D !== 'undefined' && context instanceof CanvasRenderingContext2D)
			|| (
				typeof OffscreenCanvasRenderingContext2D !== 'undefined'
				&& context instanceof OffscreenCanvasRenderingContext2D
			)
		)) {
			throw new TypeError('context must be a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D.');
		}
		if (!Number.isFinite(sx)) {
			throw new TypeError('sx must be a number.');
		}
		if (!Number.isFinite(sy)) {
			throw new TypeError('sy must be a number.');
		}
		if (!Number.isFinite(sWidth) || sWidth < 0) {
			throw new TypeError('sWidth must be a non-negative number.');
		}
		if (!Number.isFinite(sHeight) || sHeight < 0) {
			throw new TypeError('sHeight must be a non-negative number.');
		}
		if (!Number.isFinite(dx)) {
			throw new TypeError('dx must be a number.');
		}
		if (!Number.isFinite(dy)) {
			throw new TypeError('dy must be a number.');
		}
		if (!Number.isFinite(dWidth) || dWidth < 0) {
			throw new TypeError('dWidth must be a non-negative number.');
		}
		if (!Number.isFinite(dHeight) || dHeight < 0) {
			throw new TypeError('dHeight must be a non-negative number.');
		}

		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		({ sx, sy, sWidth, sHeight } = this._rotateSourceRegion(sx, sy, sWidth, sHeight, this.rotation));

		const source = this.toCanvasImageSource();

		context.save();

		const centerX = dx + dWidth / 2;
		const centerY = dy + dHeight / 2;

		context.translate(centerX, centerY);
		context.rotate(this.rotation * Math.PI / 180);

		const aspectRatioChange = this.rotation % 180 === 0 ? 1 : dWidth / dHeight;

		// Scale to compensate for aspect ratio changes when rotated
		context.scale(1 / aspectRatioChange, aspectRatioChange);

		context.drawImage(
			source,
			sx,
			sy,
			sWidth,
			sHeight,
			-dWidth / 2,
			-dHeight / 2,
			dWidth,
			dHeight,
		);

		context.restore();
	}

	/**
	 * Draws the sample in the middle of the canvas corresponding to the context with the specified fit behavior.
	 */
	drawWithFit(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, options: {
		/**
		 * Controls the fitting algorithm.
		 *
		 * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
		 * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
		 * letterboxing.
		 * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
		 */
		fit: 'fill' | 'contain' | 'cover';
		/** A way to override rotation. Defaults to the rotation of the sample. */
		rotation?: Rotation;
		/**
		 * Specifies the rectangular region of the video sample to crop to. The crop region will automatically be
		 * clamped to the dimensions of the video sample. Cropping is performed after rotation but before resizing.
		 * The crop region is in the _display pixel space_ of the underlying video data.
		 */
		crop?: CropRectangle;
	}) {
		if (!(
			(typeof CanvasRenderingContext2D !== 'undefined' && context instanceof CanvasRenderingContext2D)
			|| (
				typeof OffscreenCanvasRenderingContext2D !== 'undefined'
				&& context instanceof OffscreenCanvasRenderingContext2D
			)
		)) {
			throw new TypeError('context must be a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!['fill', 'contain', 'cover'].includes(options.fit)) {
			throw new TypeError('options.fit must be \'fill\', \'contain\', or \'cover\'.');
		}
		if (options.rotation !== undefined && ![0, 90, 180, 270].includes(options.rotation)) {
			throw new TypeError('options.rotation, when provided, must be 0, 90, 180, or 270.');
		}
		if (options.crop !== undefined) {
			validateCropRectangle(options.crop, 'options.');
		}

		const canvasWidth = context.canvas.width;
		const canvasHeight = context.canvas.height;
		const rotation = options.rotation ?? this.rotation;

		const [rotatedWidth, rotatedHeight] = rotation % 180 === 0
			? [this.squarePixelWidth, this.squarePixelHeight]
			: [this.squarePixelHeight, this.squarePixelWidth];

		let finalCrop = options.crop;
		if (finalCrop) {
			finalCrop = clampCropRectangle(finalCrop, rotatedWidth, rotatedHeight);
		}

		// These variables specify where the final sample will be drawn on the canvas
		let dx: number;
		let dy: number;
		let newWidth: number;
		let newHeight: number;

		const { sx, sy, sWidth, sHeight } = this._rotateSourceRegion(
			options.crop?.left ?? 0,
			options.crop?.top ?? 0,
			options.crop?.width ?? rotatedWidth,
			options.crop?.height ?? rotatedHeight,
			rotation,
		);

		if (options.fit === 'fill') {
			dx = 0;
			dy = 0;
			newWidth = canvasWidth;
			newHeight = canvasHeight;
		} else {
			const [sampleWidth, sampleHeight] = options.crop
				? [options.crop.width, options.crop.height]
				: [rotatedWidth, rotatedHeight];

			const scale = options.fit === 'contain'
				? Math.min(canvasWidth / sampleWidth, canvasHeight / sampleHeight)
				: Math.max(canvasWidth / sampleWidth, canvasHeight / sampleHeight);
			newWidth = sampleWidth * scale;
			newHeight = sampleHeight * scale;
			dx = (canvasWidth - newWidth) / 2;
			dy = (canvasHeight - newHeight) / 2;
		}

		context.save();

		const aspectRatioChange = rotation % 180 === 0 ? 1 : newWidth / newHeight;
		context.translate(canvasWidth / 2, canvasHeight / 2);
		context.rotate(rotation * Math.PI / 180);
		// This aspect ratio compensation is done so that we can draw the sample with the intended dimensions and
		// don't need to think about how those dimensions change after the rotation
		context.scale(1 / aspectRatioChange, aspectRatioChange);
		context.translate(-canvasWidth / 2, -canvasHeight / 2);

		// Important that we don't use .draw() here since that would take rotation into account, but we wanna handle it
		// ourselves here
		context.drawImage(this.toCanvasImageSource(), sx, sy, sWidth, sHeight, dx, dy, newWidth, newHeight);

		context.restore();
	}

	/** @internal */
	_rotateSourceRegion(sx: number, sy: number, sWidth: number, sHeight: number, rotation: number) {
		// The provided sx,sy,sWidth,sHeight refer to the final rotated image, but that's not actually how the image is
		// stored. Therefore, we must map these back onto the original, pre-rotation image.
		if (rotation === 90) {
			[sx, sy, sWidth, sHeight] = [
				sy,
				this.squarePixelHeight - sx - sWidth,
				sHeight,
				sWidth,
			];
		} else if (rotation === 180) {
			[sx, sy] = [
				this.squarePixelWidth - sx - sWidth,
				this.squarePixelHeight - sy - sHeight,
			];
		} else if (rotation === 270) {
			[sx, sy, sWidth, sHeight] = [
				this.squarePixelWidth - sy - sHeight,
				sx,
				sHeight,
				sWidth,
			];
		}

		return { sx, sy, sWidth, sHeight };
	}

	/**
	 * Converts this video sample to a
	 * [`CanvasImageSource`](https://udn.realityripple.com/docs/Web/API/CanvasImageSource) for drawing to a canvas.
	 *
	 * You must use the value returned by this method immediately, as any VideoFrame created internally may
	 * automatically be closed in the next microtask.
	 */
	toCanvasImageSource() {
		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		assert(this._data !== null);

		if (this._data instanceof VideoSampleResource || this._data instanceof Uint8Array) {
			// Requires VideoFrame to be defined
			const videoFrame = this.toVideoFrame();
			queueMicrotask(() => videoFrame.close()); // Let's automatically close the frame in the next microtask

			return videoFrame;
		} else {
			return this._data;
		}
	}

	/**
	 * Transform this video sample to a new video sample given the options. Can be used to resize, rotate, and crop
	 * the sample.
	 *
	 * In non-browser environments, this method will not work by default. To make it work, register a custom
	 * transformer function via {@link registerVideoSampleTransformer}.
	 */
	async transform(options: VideoSampleTransformOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.width !== undefined && (!Number.isInteger(options.width) || options.width <= 0)) {
			throw new TypeError('options.width, when provided, must be a positive integer.');
		}
		if (options.height !== undefined && (!Number.isInteger(options.height) || options.height <= 0)) {
			throw new TypeError('options.height, when provided, must be a positive integer.');
		}
		if (
			options.roundDimensionsTo !== undefined
			&& (!Number.isInteger(options.roundDimensionsTo) || options.roundDimensionsTo <= 0)
		) {
			throw new TypeError('options.roundDimensionsTo, when provided, must be a positive integer.');
		}
		if (options.fit !== undefined && !['fill', 'contain', 'cover'].includes(options.fit)) {
			throw new TypeError('options.fit, when provided, must be one of "fill", "contain", or "cover".');
		}
		if (
			options.width !== undefined
			&& options.height !== undefined
			&& options.fit === undefined
		) {
			throw new TypeError(
				'When both options.width and options.height are provided, options.fit must also be provided.',
			);
		}
		if (options.rotate !== undefined && ![0, 90, 180, 270].includes(options.rotate)) {
			throw new TypeError('options.rotate, when provided, must be 0, 90, 180 or 270.');
		}
		if (options.crop !== undefined) {
			validateCropRectangle(options.crop, 'options.');
		}
		if (options.alpha !== undefined && !['keep', 'discard'].includes(options.alpha)) {
			throw new TypeError('options.alpha, when provided, must be \'keep\' or \'discard\'.');
		}

		const rotation = normalizeRotation(this.rotation + (options.rotate ?? 0));
		const [rotatedWidth, rotatedHeight] = rotation % 180 === 0
			? [this.squarePixelWidth, this.squarePixelHeight]
			: [this.squarePixelHeight, this.squarePixelWidth];

		// Clamp crop rectangle to the rotated video dimensions
		let finalCrop = options.crop;
		if (finalCrop) {
			finalCrop = clampCropRectangle(finalCrop, rotatedWidth, rotatedHeight);
		}

		const cropWidth = finalCrop ? finalCrop.width : rotatedWidth;
		const cropHeight = finalCrop ? finalCrop.height : rotatedHeight;
		const originalAspectRatio = cropWidth / cropHeight;

		let targetWidth: number;
		let targetHeight: number;

		if (options.width !== undefined && options.height === undefined) {
			targetWidth = options.width;
			targetHeight = targetWidth / originalAspectRatio;
		} else if (options.width === undefined && options.height !== undefined) {
			targetHeight = options.height;
			targetWidth = targetHeight * originalAspectRatio;
		} else if (options.width !== undefined && options.height !== undefined) {
			targetWidth = options.width;
			targetHeight = options.height;
		} else {
			targetWidth = cropWidth;
			targetHeight = cropHeight;
		}

		targetWidth = roundToMultiple(targetWidth, options.roundDimensionsTo ?? 1);
		targetHeight = roundToMultiple(targetHeight, options.roundDimensionsTo ?? 1);

		const description: VideoSampleTransformationDescription = {
			width: targetWidth,
			height: targetHeight,
			fit: options.fit ?? 'fill',
			rotation,
			crop: finalCrop ?? {
				left: 0,
				top: 0,
				width: rotatedWidth,
				height: rotatedHeight,
			},
			alpha: options.alpha ?? 'keep',
		};

		// Description's finalized; let's see if a registered transformer wants to handle it
		for (const transformer of registeredVideoSampleTransformers) {
			let result = transformer(this, description);
			if (result instanceof Promise) result = await result;

			if (result !== null) {
				return result;
			}
		}

		// We need to handle it ourselves, and we use canvases to do it

		let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
		let canvasIsNew = false;

		for (const entry of transformationCanvasCache) {
			if (entry.canvas.width === description.width && entry.canvas.height === description.height) {
				canvas = entry.canvas;
				entry.age = transformationCanvasCacheNextAge++;

				break;
			}
		}

		if (canvas === null) {
			if (typeof OffscreenCanvas !== 'undefined') {
				canvas = new OffscreenCanvas(description.width, description.height);
			} else {
				if (typeof window === 'undefined' || typeof document === 'undefined') {
					throw new Error(
						'Cannot transform VideoSamples in this environment. Either run in an environment with'
						+ ' OffscreenCanvas or HTMLCanvasElement, or supply a custom VideoSample transformer using'
						+ ' registerVideoSampleTransformer().',
					);
				}

				canvas = document.createElement('canvas');
				canvas.width = description.width;
				canvas.height = description.height;
			}

			canvasIsNew = true;

			if (transformationCanvasCache.length >= TRANSFORMATION_CANVAS_CACHE_MAX_SIZE) {
				transformationCanvasCache.splice(arrayArgmin(transformationCanvasCache, x => x.age), 1);
			}

			transformationCanvasCache.push({
				canvas,
				age: transformationCanvasCacheNextAge++,
			});
		}

		const context = canvas.getContext('2d', {
			alpha: true,
		}) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
		if (!context) {
			throw new Error(
				'The \'2d\' canvas context is required to transform VideoSamples. Register a custom transformer using'
				+ ' registerVideoSampleTransformer to work around this limitation.',
			);
		}

		if (description.alpha === 'discard') {
			context.fillStyle = 'black';
			context.fillRect(0, 0, description.width, description.height);
		} else if (!canvasIsNew) {
			// Cached canvases carry stale pixels from a prior draw
			context.clearRect(0, 0, description.width, description.height);
		}

		this.drawWithFit(context, {
			fit: description.fit,
			rotation: description.rotation,
			crop: description.crop,
		});

		return new VideoSample(canvas, {
			timestamp: this.timestamp,
			duration: this.duration,
			rotation: 0, // Any previous rotation is now baked in
		});
	}

	/** Sets the rotation metadata of this video sample. */
	setRotation(newRotation: Rotation) {
		if (![0, 90, 180, 270].includes(newRotation)) {
			throw new TypeError('newRotation must be 0, 90, 180, or 270.');
		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		(this.rotation as Rotation) = newRotation;
	}

	/** Sets the presentation timestamp of this video sample, in seconds. */
	setTimestamp(newTimestamp: number) {
		if (!Number.isFinite(newTimestamp)) {
			throw new TypeError('newTimestamp must be a number.');
		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		(this.timestamp as number) = newTimestamp;
	}

	/** Sets the duration of this video sample, in seconds. */
	setDuration(newDuration: number) {
		if (!Number.isFinite(newDuration) || newDuration < 0) {
			throw new TypeError('newDuration must be a non-negative number.');
		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		(this.duration as number) = newDuration;
	}

	/** Sets the encode options used when this sample is passed to an encoder. */
	setEncodeOptions(newEncodeOptions: VideoEncoderEncodeOptions) {
		if (!newEncodeOptions || typeof newEncodeOptions !== 'object') {
			throw new TypeError('newEncodeOptions must be an object.');
		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		(this.encodeOptions as DeepReadonly<VideoEncoderEncodeOptions>) = newEncodeOptions;
	}

	/** Calls `.close()`. */
	[Symbol.dispose]() {
		this.close();
	}
}

/**
 * Options for transforming a {@link VideoSample}. The order of operations are:
 *
 * 1. Pixel aspect ratio normalization (always applied)
 * 2. Rotation
 * 3. Crop
 * 4. Resize using fit
 * @group Samples
 * @public
 */
export type VideoSampleTransformOptions = {
	/**
	 * The width in pixels to resize the frames to. If height is not set, it will be deduced
	 * automatically based on aspect ratio.
	 */
	width?: number;
	/**
	 * The height in pixels to resize the frames to. If width is not set, it will be deduced
	 * automatically based on aspect ratio.
	 */
	height?: number;
	/**
	 * A positive integer. When provided, both the width and height will be rounded to the nearest multiple of
	 * this number.
	 */
	roundDimensionsTo?: number;
	/**
	 * The fitting algorithm in case both width and height are set.
	 *
	 * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
	 * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
	 * letterboxing.
	 * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
	 */
	fit?: 'fill' | 'contain' | 'cover';
	/**
	 * The clockwise rotation by which to rotate the frames. Rotation is applied before resizing.
	 */
	rotate?: Rotation;
	/**
	 * Specifies the rectangular region of the frames to crop to. The crop region will automatically be
	 * clamped to the dimensions of the frame. Cropping is performed after rotation but before resizing.
	 */
	crop?: CropRectangle;
	/**
	 * Whether to discard or keep the transparency information of the video sample. The default is `'keep'`.
	 */
	alpha?: 'keep' | 'discard';
};

/**
 * A fully-resolved description of a video sample transformation, with all defaults and constraints baked in.
 *
 * The order of operations must be:
 * 1. Pixel aspect ratio normalization (always applied)
 * 2. Rotation
 * 3. Crop
 * 4. Resize using fit
 * @group Samples
 * @public
 */
export type VideoSampleTransformationDescription = {
	/** The width in pixels to resize the frames to. */
	width: number;
	/** The height in pixels to resize the frames to. */
	height: number;
	/**
	 * The fitting algorithm.
	 *
	 * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
	 * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
	 * letterboxing.
	 * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
	 */
	fit: 'fill' | 'contain' | 'cover';
	/** The clockwise rotation by which to rotate the frames. Rotation is applied before resizing. */
	rotation: Rotation;
	/**
	 * The rectangular region of the frames to crop to, clamped to the dimensions of the frame. Cropping is
	 * performed after rotation but before resizing.
	 */
	crop: CropRectangle;
	/** Whether to discard or keep the transparency information of the video sample. */
	alpha: 'keep' | 'discard';
};

const registeredVideoSampleTransformers: ((
	sample: VideoSample,
	description: VideoSampleTransformationDescription,
) => MaybePromise<VideoSample | null>)[] = [];

/**
 * Registers a callback to handle the transformation of {@link VideoSample} instances. The callback can either return
 * the transformed sample, or `null` to indicate that it doesn't want to handle the given transformation task.
 * @group Samples
 * @public
 */
export const registerVideoSampleTransformer = (
	transformer: (
		sample: VideoSample,
		description: VideoSampleTransformationDescription,
	) => MaybePromise<VideoSample | null>,
) => {
	if (registeredVideoSampleTransformers.includes(transformer)) {
		return; // Already in there
	}

	registeredVideoSampleTransformers.push(transformer);
};

const TRANSFORMATION_CANVAS_CACHE_MAX_SIZE = 3;
const transformationCanvasCache: {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	age: number;
}[] = [];
let transformationCanvasCacheNextAge = 0;

/**
 * Describes the color space of a {@link VideoSample}. Corresponds to the WebCodecs API's VideoColorSpace.
 * @group Samples
 * @public
 */
export class VideoSampleColorSpace {
	/** The color primaries standard used. */
	readonly primaries: VideoColorPrimaries | null;
	/** The transfer characteristics used. */
	readonly transfer: VideoTransferCharacteristics | null;
	/** The color matrix coefficients used. */
	readonly matrix: VideoMatrixCoefficients | null;
	/** Whether the color values use the full range or limited range. */
	readonly fullRange: boolean | null;

	/** Creates a new VideoSampleColorSpace. */
	constructor(init?: VideoColorSpaceInit) {
		if (init !== undefined) {
			if (!init || typeof init !== 'object') {
				throw new TypeError('init.colorSpace, when provided, must be an object.');
			}

			const primariesValues = Object.keys(COLOR_PRIMARIES_MAP);
			if (init.primaries != null && !primariesValues.includes(init.primaries)) {
				throw new TypeError(
					`init.colorSpace.primaries, when provided, must be one of ${primariesValues.join(', ')}.`,
				);
			}

			const transferValues = Object.keys(TRANSFER_CHARACTERISTICS_MAP);
			if (init.transfer != null && !transferValues.includes(init.transfer)) {
				throw new TypeError(
					`init.colorSpace.transfer, when provided, must be one of ${transferValues.join(', ')}.`,
				);
			}

			const matrixValues = Object.keys(MATRIX_COEFFICIENTS_MAP);
			if (init.matrix != null && !matrixValues.includes(init.matrix)) {
				throw new TypeError(
					`init.colorSpace.matrix, when provided, must be one of ${matrixValues.join(', ')}.`,
				);
			}

			if (init.fullRange != null && typeof init.fullRange !== 'boolean') {
				throw new TypeError('init.colorSpace.fullRange, when provided, must be a boolean.');
			}
		}

		this.primaries = init?.primaries ?? null;
		this.transfer = init?.transfer ?? null;
		this.matrix = init?.matrix ?? null;
		this.fullRange = init?.fullRange ?? null;
	}

	/** Serializes the color space to a JSON object. */
	toJSON(): VideoColorSpaceInit {
		return {
			primaries: this.primaries,
			transfer: this.transfer,
			matrix: this.matrix,
			fullRange: this.fullRange,
		};
	}
}

const isVideoFrame = (x: unknown): x is VideoFrame => {
	return typeof VideoFrame !== 'undefined' && x instanceof VideoFrame;
};

/**
 * Specifies the rectangular cropping region.
 * @group Miscellaneous
 * @public
 */
export type CropRectangle = {
	/** The distance in pixels from the left edge of the source frame to the left edge of the crop rectangle. */
	left: number;
	/** The distance in pixels from the top edge of the source frame to the top edge of the crop rectangle. */
	top: number;
	/** The width in pixels of the crop rectangle. */
	width: number;
	/** The height in pixels of the crop rectangle. */
	height: number;
};

export const clampCropRectangle = (crop: CropRectangle, outerWidth: number, outerHeight: number): CropRectangle => {
	const left = Math.min(crop.left, outerWidth);
	const top = Math.min(crop.top, outerHeight);
	const width = Math.min(crop.width, outerWidth - left);
	const height = Math.min(crop.height, outerHeight - top);

	assert(width >= 0);
	assert(height >= 0);

	return { left, top, width, height };
};

export const validateCropRectangle = (crop: CropRectangle, prefix: string) => {
	if (!crop || typeof crop !== 'object') {
		throw new TypeError(prefix + 'crop, when provided, must be an object.');
	}
	if (!Number.isInteger(crop.left) || crop.left < 0) {
		throw new TypeError(prefix + 'crop.left must be a non-negative integer.');
	}
	if (!Number.isInteger(crop.top) || crop.top < 0) {
		throw new TypeError(prefix + 'crop.top must be a non-negative integer.');
	}
	if (!Number.isInteger(crop.width) || crop.width < 0) {
		throw new TypeError(prefix + 'crop.width must be a non-negative integer.');
	}
	if (!Number.isInteger(crop.height) || crop.height < 0) {
		throw new TypeError(prefix + 'crop.height must be a non-negative integer.');
	}
};

const validateVideoFrameCopyToOptions = (options: VideoFrameCopyToOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.colorSpace !== undefined && !['display-p3', 'srgb'].includes(options.colorSpace)) {
		throw new TypeError('options.colorSpace, when provided, must be \'display-p3\' or \'srgb\'.');
	}
	if (options.format !== undefined && typeof options.format !== 'string') {
		throw new TypeError('options.format, when provided, must be a string.');
	}
	if (options.layout !== undefined) {
		if (!Array.isArray(options.layout)) {
			throw new TypeError('options.layout, when provided, must be an array.');
		}

		for (const plane of options.layout) {
			if (!plane || typeof plane !== 'object') {
				throw new TypeError('Each entry in options.layout must be an object.');
			}
			if (!Number.isInteger(plane.offset) || plane.offset < 0) {
				throw new TypeError('plane.offset must be a non-negative integer.');
			}
			if (!Number.isInteger(plane.stride) || plane.stride < 0) {
				throw new TypeError('plane.stride must be a non-negative integer.');
			}
		}
	}
	if (options.rect !== undefined) {
		if (!options.rect || typeof options.rect !== 'object') {
			throw new TypeError('options.rect, when provided, must be an object.');
		}
		if (options.rect.x !== undefined && (!Number.isInteger(options.rect.x) || options.rect.x < 0)) {
			throw new TypeError('options.rect.x, when provided, must be a non-negative integer.');
		}
		if (options.rect.y !== undefined && (!Number.isInteger(options.rect.y) || options.rect.y < 0)) {
			throw new TypeError('options.rect.y, when provided, must be a non-negative integer.');
		}
		if (options.rect.width !== undefined && (!Number.isInteger(options.rect.width) || options.rect.width < 0)) {
			throw new TypeError('options.rect.width, when provided, must be a non-negative integer.');
		}
		if (options.rect.height !== undefined && (!Number.isInteger(options.rect.height) || options.rect.height < 0)) {
			throw new TypeError('options.rect.height, when provided, must be a non-negative integer.');
		}
	}
};

/** Implements logic from WebCodecs § 9.4.6 "Compute Layout and Allocation Size" */
const createDefaultPlaneLayout = (
	format: VideoSamplePixelFormat,
	codedWidth: number,
	codedHeight: number,
): PlaneLayout[] => {
	const planes = getPlaneConfigs(format);
	const layouts: PlaneLayout[] = [];
	let currentOffset = 0;

	for (const plane of planes) {
		// Per § 9.8, dimensions are usually "rounded up to the nearest integer".
		const planeWidth = Math.ceil(codedWidth / plane.widthDivisor);
		const planeHeight = Math.ceil(codedHeight / plane.heightDivisor);

		const stride = planeWidth * plane.sampleBytes;

		// Tight packing
		const planeSize = stride * planeHeight;

		layouts.push({
			offset: currentOffset,
			stride: stride,
		});

		currentOffset += planeSize;
	}

	return layouts;
};

type PlaneConfig = {
	sampleBytes: number;
	widthDivisor: number; // Horizontal sub-sampling factor
	heightDivisor: number; // Vertical sub-sampling factor
};

/** Helper to retrieve plane configurations based on WebCodecs § 9.8 Pixel Format definitions. */
export const getPlaneConfigs = (format: VideoSamplePixelFormat): PlaneConfig[] => {
	// Helper for standard YUV planes
	const yuv = (
		yBytes: number,
		uvBytes: number,
		subX: number,
		subY: number,
		hasAlpha: boolean,
	): PlaneConfig[] => {
		const configs: PlaneConfig[] = [
			{ sampleBytes: yBytes, widthDivisor: 1, heightDivisor: 1 },
			{ sampleBytes: uvBytes, widthDivisor: subX, heightDivisor: subY },
			{ sampleBytes: uvBytes, widthDivisor: subX, heightDivisor: subY },
		];

		if (hasAlpha) {
			// Match luma dimensions
			configs.push({ sampleBytes: yBytes, widthDivisor: 1, heightDivisor: 1 });
		}

		return configs;
	};

	switch (format) {
		case 'I420':
			return yuv(1, 1, 2, 2, false);
		case 'I420P10':
		case 'I420P12':
			return yuv(2, 2, 2, 2, false);
		case 'I420A':
			return yuv(1, 1, 2, 2, true);
		case 'I420AP10':
		case 'I420AP12':
			return yuv(2, 2, 2, 2, true);

		case 'I422':
			return yuv(1, 1, 2, 1, false);
		case 'I422P10':
		case 'I422P12':
			return yuv(2, 2, 2, 1, false);
		case 'I422A':
			return yuv(1, 1, 2, 1, true);
		case 'I422AP10':
		case 'I422AP12':
			return yuv(2, 2, 2, 1, true);

		case 'I444':
			return yuv(1, 1, 1, 1, false);
		case 'I444P10':
		case 'I444P12':
			return yuv(2, 2, 1, 1, false);
		case 'I444A':
			return yuv(1, 1, 1, 1, true);
		case 'I444AP10':
		case 'I444AP12':
			return yuv(2, 2, 1, 1, true);

		case 'NV12':
			return [
				{ sampleBytes: 1, widthDivisor: 1, heightDivisor: 1 },
				{ sampleBytes: 2, widthDivisor: 2, heightDivisor: 2 }, // Interleaved U and V
			];

		case 'RGBA':
		case 'RGBX':
		case 'BGRA':
		case 'BGRX':
			return [
				{ sampleBytes: 4, widthDivisor: 1, heightDivisor: 1 },
			];

		default:
			assertNever(format);
			assert(false);
	}
};

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

/** Taken from the WebCodecs spec. */
const ParseVideoFrameCopyToOptions = (
	sample: VideoSample,
	options: VideoFrameCopyToOptions,
): CombinedBufferLayout => {
	// 1. Let defaultRect be the result of performing the getter steps for visibleRect.
	const defaultRect: Rectangle = {
		left: 0,
		top: 0,
		width: sample.codedWidth,
		height: sample.codedHeight,
	};

	// 2. Let overrideRect be undefined.
	// 3. If options.rect exists, assign the value of options.rect to overrideRect.
	const overrideRect = options.rect;

	// 4. Let parsedRect be the result of running the Parse Visible Rect algorithm...
	const parsedRect = ParseVisibleRect(
		defaultRect,
		overrideRect,
		sample.codedWidth,
		sample.codedHeight,
		sample.format,
	);

	// 5. If parsedRect is an exception, return parsedRect. (Handled by throw)

	// 6. Let optLayout be undefined.
	// 7. If options.layout exists, assign its value to optLayout.
	const optLayout = options.layout;

	// 8. Let format be undefined.
	let format: VideoSamplePixelFormat | undefined;

	// 9. If options.format does not exist, assign [[format]] to format.
	if (!options.format || options.format === sample.format) {
		format = sample.format!;
	} else if (['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(options.format)) {
		// 10. Otherwise, if options.format is equal to one of RGBA, RGBX, BGRA, BGRX, then assign options.format
		//  to format...
		format = options.format;
	} else {
		throw new Error('NotSupportedError: Invalid destination format.');
	}

	// 11. Let combinedLayout be the result of running the Compute Layout and Allocation Size algorithm...
	return ComputeLayoutAndAllocationSize(parsedRect, format, optLayout);
};

/** Taken from the WebCodecs spec. */
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
			throw new TypeError('visibleRect dimensions cannot be zero.');
		}
		// If the sum of overrideRect.x and overrideRect.width is greater than codedWidth, return a TypeError.
		if ((overrideRect.x || 0) + (overrideRect.width || 0) > codedWidth) {
			throw new TypeError('visibleRect exceeds codedWidth.');
		}
		// If the sum of overrideRect.y and overrideRect.height is greater than codedHeight, return a TypeError.
		if ((overrideRect.y || 0) + (overrideRect.height || 0) > codedHeight) {
			throw new TypeError('visibleRect exceeds codedHeight.');
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
		throw new TypeError('visibleRect alignment is invalid for the format.');
	}

	// 5. Return sourceRect.
	return sourceRect;
};

/** Taken from the WebCodecs spec. */
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

/** Taken from the WebCodecs spec. */
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
		throw new TypeError(`Layout must have ${numPlanes} planes.`);
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
				throw new TypeError(`Stride for plane ${planeIndex} is too small.`);
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
		if (planeEnd > 4294967295) {
			throw new TypeError('Allocation size exceeds limit.');
		}

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

			throw new TypeError('Planes overlap.');
		}

		computedLayouts.push(computedLayout);
	}

	// 12. Return combinedLayout.
	return {
		allocationSize: minAllocationSize,
		computedLayouts: computedLayouts,
	};
};

const AUDIO_SAMPLE_FORMATS = new Set<AudioSampleFormat>(
	['f32', 'f32-planar', 's16', 's16-planar', 's32', 's32-planar', 'u8', 'u8-planar'],
);

/**
 * Abstract base class for custom audio sample resources. Implement this class to provide custom backing
 * for AudioSample instances.
 * @group Samples
 * @public
 */
export abstract class AudioSampleResource {
	/** @internal */
	_referenceCount: number = 0;

	/**
	 * Returns the audio sample format.
	 * [See sample formats](https://developer.mozilla.org/en-US/docs/Web/API/AudioData/format)
	 */
	abstract getFormat(): AudioSampleFormat;

	/** Returns the audio sample rate in hertz. */
	abstract getSampleRate(): number;

	/** Returns the number of audio frames in the sample, per channel. */
	abstract getNumberOfFrames(): number;

	/** Returns the number of audio channels. */
	abstract getNumberOfChannels(): number;

	/** Returns the presentation timestamp of the sample in seconds. */
	abstract getTimestamp(): number;

	/**
	 * Closes this resource, releasing held resources. Called automatically when the last {@link AudioSample} using this
	 * resource is closed.
	 */
	abstract close(): void;

	/**
	 * Returns the audio sample data for the plane given by `planeIndex`. The audio data must be in the format returned
	 * by `getFormat()`. For interleaved formats, there is only one plane.
	 */
	abstract getDataPlane(planeIndex: number): Uint8Array;
}

/**
 * Metadata used for AudioSample initialization.
 * @group Samples
 * @public
 */
export type AudioSampleInit = {
	/** The audio data for this sample. */
	data: AllowSharedBufferSource;
	/**
	 * The audio sample format. [See sample formats](https://developer.mozilla.org/en-US/docs/Web/API/AudioData/format)
	 */
	format: AudioSampleFormat;
	/** The number of audio channels. */
	numberOfChannels: number;
	/** The audio sample rate in hertz. */
	sampleRate: number;
	/** The presentation timestamp of the sample in seconds. */
	timestamp: number;
};

/**
 * Options used for copying audio sample data.
 * @group Samples
 * @public
 */
export type AudioSampleCopyToOptions = {
	/**
	 * The index identifying the plane to copy from. This must be 0 if using a non-planar (interleaved) output format.
	 */
	planeIndex: number;
	/**
	 * The output format for the destination data. Defaults to the AudioSample's format.
	 * [See sample formats](https://developer.mozilla.org/en-US/docs/Web/API/AudioData/format)
	 */
	format?: AudioSampleFormat;
	/** An offset into the source plane data indicating which frame to begin copying from. Defaults to 0. */
	frameOffset?: number;
	/**
	 * The number of frames to copy. If not provided, the copy will include all frames in the plane beginning
	 * with frameOffset.
	 */
	frameCount?: number;
};

/**
 * Represents a raw, unencoded audio sample. Mainly used as an expressive wrapper around WebCodecs API's
 * [`AudioData`](https://developer.mozilla.org/en-US/docs/Web/API/AudioData), but can also be used standalone.
 * @group Samples
 * @public
 */
export class AudioSample implements Disposable {
	/** @internal */
	_data: AudioData | Uint8Array | AudioSampleResource;
	/** @internal */
	_closed: boolean = false;

	/**
	 * The audio sample format.
	 * [See sample formats](https://developer.mozilla.org/en-US/docs/Web/API/AudioData/format)
	 */
	readonly format: AudioSampleFormat;
	/** The audio sample rate in hertz. */
	readonly sampleRate: number;
	/**
	 * The number of audio frames in the sample, per channel. In other words, the length of this audio sample in frames.
	 */
	readonly numberOfFrames: number;
	/** The number of audio channels. */
	readonly numberOfChannels: number;
	/** The duration of the sample in seconds. */
	readonly duration: number;
	/**
	 * The presentation timestamp of the sample in seconds. May be negative. Samples with negative end timestamps should
	 * not be presented.
	 */
	readonly timestamp: number;

	/** The presentation timestamp of the sample in microseconds. */
	get microsecondTimestamp() {
		return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.timestamp);
	}

	/** The duration of the sample in microseconds. */
	get microsecondDuration() {
		return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.duration);
	}

	/**
	 * Creates a new {@link AudioSample}, either from an existing
	 * [`AudioData`](https://developer.mozilla.org/en-US/docs/Web/API/AudioData) or from raw bytes specified in
	 * {@link AudioSampleInit}.
	 */
	constructor(init: AudioData | AudioSampleInit | AudioSampleResource);
	constructor(init: AudioData | AudioSampleInit | AudioSampleResource) {
		if (isAudioData(init)) {
			if (init.format === null) {
				throw new TypeError('AudioData with null format is not supported.');
			}

			this._data = init;

			this.format = init.format;
			this.sampleRate = init.sampleRate;
			this.numberOfFrames = init.numberOfFrames;
			this.numberOfChannels = init.numberOfChannels;
			this.timestamp = init.timestamp / 1e6;
			this.duration = init.numberOfFrames / init.sampleRate;
		} else if (init instanceof AudioSampleResource) {
			this._data = init;
			init._referenceCount++;

			this.format = init.getFormat();
			if (!AUDIO_SAMPLE_FORMATS.has(this.format)) {
				throw new TypeError('getFormat() must return an AudioSampleFormat.');
			}

			this.sampleRate = init.getSampleRate();
			if (!Number.isInteger(this.sampleRate) || this.sampleRate <= 0) {
				throw new TypeError('getSampleRate() must return a positive integer.');
			}

			this.numberOfFrames = init.getNumberOfFrames();
			if (!Number.isInteger(this.numberOfFrames) || this.numberOfFrames < 0) {
				throw new TypeError('getNumberOfFrames() must return a non-negative integer.');
			}

			this.numberOfChannels = init.getNumberOfChannels();
			if (!Number.isInteger(this.numberOfChannels) || this.numberOfChannels <= 0) {
				throw new TypeError('getNumberOfChannels() must return a positive integer.');
			}

			this.timestamp = init.getTimestamp();
			if (!Number.isFinite(this.timestamp)) {
				throw new TypeError('getTimestamp() must return a finite number.');
			}

			this.duration = this.numberOfFrames / this.sampleRate;
		} else {
			if (!init || typeof init !== 'object') {
				throw new TypeError('Invalid AudioDataInit: must be an object.');
			}

			if (!AUDIO_SAMPLE_FORMATS.has(init.format)) {
				throw new TypeError('Invalid AudioDataInit: invalid format.');
			}
			if (!Number.isFinite(init.sampleRate) || init.sampleRate <= 0) {
				throw new TypeError('Invalid AudioDataInit: sampleRate must be > 0.');
			}
			if (!Number.isInteger(init.numberOfChannels) || init.numberOfChannels === 0) {
				throw new TypeError('Invalid AudioDataInit: numberOfChannels must be an integer > 0.');
			}
			if (!Number.isFinite(init?.timestamp)) {
				throw new TypeError('init.timestamp must be a number.');
			}

			const numberOfFrames
				= init.data.byteLength / (getBytesPerSample(init.format) * init.numberOfChannels);
			if (!Number.isInteger(numberOfFrames)) {
				throw new TypeError('Invalid AudioDataInit: data size is not a multiple of frame size.');
			}

			this.format = init.format;
			this.sampleRate = init.sampleRate;
			this.numberOfFrames = numberOfFrames;
			this.numberOfChannels = init.numberOfChannels;
			this.timestamp = init.timestamp;
			this.duration = numberOfFrames / init.sampleRate;

			let dataBuffer: Uint8Array;
			if (init.data instanceof ArrayBuffer) {
				dataBuffer = new Uint8Array(init.data);
			} else if (ArrayBuffer.isView(init.data)) {
				dataBuffer = new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength);
			} else {
				throw new TypeError('Invalid AudioDataInit: data is not a BufferSource.');
			}

			const expectedSize
                = this.numberOfFrames * this.numberOfChannels * getBytesPerSample(this.format);
			if (dataBuffer.byteLength < expectedSize) {
				throw new TypeError('Invalid AudioDataInit: insufficient data size.');
			}

			this._data = dataBuffer;
		}

		finalizationRegistry?.register(this, { type: 'audio', data: this._data }, this);
	}

	/** Returns the number of bytes required to hold the audio sample's data as specified by the given options. */
	allocationSize(options: AudioSampleCopyToOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Number.isInteger(options.planeIndex) || options.planeIndex < 0) {
			throw new TypeError('planeIndex must be a non-negative integer.');
		}

		if (options.format !== undefined && !AUDIO_SAMPLE_FORMATS.has(options.format)) {
			throw new TypeError('Invalid format.');
		}
		if (options.frameOffset !== undefined && (!Number.isInteger(options.frameOffset) || options.frameOffset < 0)) {
			throw new TypeError('frameOffset must be a non-negative integer.');
		}
		if (options.frameCount !== undefined && (!Number.isInteger(options.frameCount) || options.frameCount < 0)) {
			throw new TypeError('frameCount must be a non-negative integer.');
		}

		if (this._closed) {
			throw new Error('AudioSample is closed.');
		}

		const destFormat = options.format ?? this.format;

		const frameOffset = options.frameOffset ?? 0;
		if (frameOffset >= this.numberOfFrames) {
			throw new RangeError('frameOffset out of range');
		}

		const copyFrameCount
            = options.frameCount !== undefined ? options.frameCount : (this.numberOfFrames - frameOffset);
		if (copyFrameCount > (this.numberOfFrames - frameOffset)) {
			throw new RangeError('frameCount out of range');
		}

		const bytesPerSample = getBytesPerSample(destFormat);
		const isPlanar = formatIsPlanar(destFormat);
		if (isPlanar && options.planeIndex >= this.numberOfChannels) {
			throw new RangeError('planeIndex out of range');
		}
		if (!isPlanar && options.planeIndex !== 0) {
			throw new RangeError('planeIndex out of range');
		}

		const elementCount = isPlanar ? copyFrameCount : copyFrameCount * this.numberOfChannels;
		return elementCount * bytesPerSample;
	}

	/** Copies the audio sample's data to an ArrayBuffer or ArrayBufferView as specified by the given options. */
	copyTo(destination: AllowSharedBufferSource, options: AudioSampleCopyToOptions) {
		if (!isAllowSharedBufferSource(destination)) {
			throw new TypeError('destination must be an ArrayBuffer or an ArrayBuffer view.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Number.isInteger(options.planeIndex) || options.planeIndex < 0) {
			throw new TypeError('planeIndex must be a non-negative integer.');
		}

		if (options.format !== undefined && !AUDIO_SAMPLE_FORMATS.has(options.format)) {
			throw new TypeError('Invalid format.');
		}
		if (options.frameOffset !== undefined && (!Number.isInteger(options.frameOffset) || options.frameOffset < 0)) {
			throw new TypeError('frameOffset must be a non-negative integer.');
		}
		if (options.frameCount !== undefined && (!Number.isInteger(options.frameCount) || options.frameCount < 0)) {
			throw new TypeError('frameCount must be a non-negative integer.');
		}

		if (this._closed) {
			throw new Error('AudioSample is closed.');
		}

		const { format, frameCount: optFrameCount, frameOffset: optFrameOffset } = options;
		let { planeIndex } = options;

		const srcFormat = this.format;
		const destFormat = format ?? this.format;
		if (!destFormat) throw new Error('Destination format not determined');

		const numFrames = this.numberOfFrames;
		const numChannels = this.numberOfChannels;
		const frameOffset = optFrameOffset ?? 0;
		if (frameOffset >= numFrames) {
			throw new RangeError('frameOffset out of range');
		}

		const copyFrameCount = optFrameCount !== undefined ? optFrameCount : (numFrames - frameOffset);
		if (copyFrameCount > (numFrames - frameOffset)) {
			throw new RangeError('frameCount out of range');
		}

		const destBytesPerSample = getBytesPerSample(destFormat);
		const destIsPlanar = formatIsPlanar(destFormat);
		if (destIsPlanar && planeIndex >= numChannels) {
			throw new RangeError('planeIndex out of range');
		}
		if (!destIsPlanar && planeIndex !== 0) {
			throw new RangeError('planeIndex out of range');
		}

		const destElementCount = destIsPlanar ? copyFrameCount : copyFrameCount * numChannels;
		const requiredSize = destElementCount * destBytesPerSample;
		if (destination.byteLength < requiredSize) {
			throw new RangeError('Destination buffer is too small');
		}

		const destView = toDataView(destination);
		const writeFn = getWriteFunction(destFormat);

		if (isAudioData(this._data)) {
			if (isWebKit() && numChannels > 2 && destFormat !== srcFormat) {
				// WebKit bug workaround
				doAudioDataCopyToWebKitWorkaround(
					this._data,
					destView,
					srcFormat,
					destFormat,
					numChannels,
					planeIndex,
					frameOffset,
					copyFrameCount,
				);
			} else {
				// Per spec, only f32-planar conversion must be supported, but in practice, all browsers support all
				// destination formats, so let's just delegate here:
				this._data.copyTo(destination, {
					planeIndex,
					frameOffset,
					frameCount: copyFrameCount,
					format: destFormat,
				});
			}
		} else {
			const readFn = getReadFunction(srcFormat);
			const srcBytesPerSample = getBytesPerSample(srcFormat);
			const srcIsPlanar = formatIsPlanar(srcFormat);

			let uint8Data: Uint8Array;
			if (this._data instanceof AudioSampleResource) {
				const getDataPlaneValidated = (index: number) => {
					const result = (this._data as AudioSampleResource).getDataPlane(index);
					if (!(result instanceof Uint8Array)) {
						throw new TypeError('getDataPlane() must return a Uint8Array.');
					}

					const expectedSize = numFrames * srcBytesPerSample * (srcIsPlanar ? 1 : numChannels);
					if (result.byteLength !== expectedSize) {
						throw new TypeError(
							`Data plane ${index} has invalid size. Expected exactly ${expectedSize} bytes, got`
							+ ` ${result.byteLength} bytes.`,
						);
					}

					return result;
				};

				if (srcIsPlanar) {
					if (destIsPlanar) {
						// Only one source plane will be extracted, so let's fetch only that one
						uint8Data = getDataPlaneValidated(planeIndex);
						planeIndex = 0; // To fix the subsequent access
					} else {
						// Pack all planes tightly together
						uint8Data = new Uint8Array(numFrames * srcBytesPerSample * numChannels);
						for (let ch = 0; ch < numChannels; ch++) {
							const planeData = getDataPlaneValidated(ch);
							uint8Data.set(planeData, ch * numFrames * srcBytesPerSample);
						}
					}
				} else {
					uint8Data = getDataPlaneValidated(0); // That's the only plane there is
				}
			} else {
				uint8Data = this._data;
			}

			const srcView = toDataView(uint8Data);

			for (let i = 0; i < copyFrameCount; i++) {
				if (destIsPlanar) {
					const destOffset = i * destBytesPerSample;
					let srcOffset: number;
					if (srcIsPlanar) {
						srcOffset = (planeIndex * numFrames + (i + frameOffset)) * srcBytesPerSample;
					} else {
						srcOffset = (((i + frameOffset) * numChannels) + planeIndex) * srcBytesPerSample;
					}

					const normalized = readFn(srcView, srcOffset);
					writeFn(destView, destOffset, normalized);
				} else {
					for (let ch = 0; ch < numChannels; ch++) {
						const destIndex = i * numChannels + ch;
						const destOffset = destIndex * destBytesPerSample;
						let srcOffset: number;
						if (srcIsPlanar) {
							srcOffset = (ch * numFrames + (i + frameOffset)) * srcBytesPerSample;
						} else {
							srcOffset = (((i + frameOffset) * numChannels) + ch) * srcBytesPerSample;
						}

						const normalized = readFn(srcView, srcOffset);
						writeFn(destView, destOffset, normalized);
					}
				}
			}
		}
	}

	/** Clones this audio sample. */
	clone(): AudioSample {
		if (this._closed) {
			throw new Error('AudioSample is closed.');
		}

		if (this._data instanceof AudioSampleResource) {
			const sample = new AudioSample(this._data);
			sample.setTimestamp(this.timestamp); // Make sure the timestamp is correct

			return sample;
		} else if (isAudioData(this._data)) {
			const sample = new AudioSample(this._data.clone());
			sample.setTimestamp(this.timestamp);

			return sample;
		} else {
			return new AudioSample({
				format: this.format,
				sampleRate: this.sampleRate,
				numberOfFrames: this.numberOfFrames,
				numberOfChannels: this.numberOfChannels,
				timestamp: this.timestamp,
				data: this._data,
			});
		}
	}

	/**
	 * Closes this audio sample, releasing held resources. Audio samples should be closed as soon as they are not
	 * needed anymore.
	 */
	close(): void {
		if (this._closed) {
			return;
		}

		finalizationRegistry?.unregister(this);

		if (this._data instanceof AudioSampleResource) {
			this._data._referenceCount--;
			if (this._data._referenceCount === 0) {
				this._data.close();
			}
		} else if (isAudioData(this._data)) {
			this._data.close();
		} else {
			this._data = new Uint8Array(0);
		}

		this._closed = true;
	}

	/**
	 * Converts this audio sample to an AudioData for use with the WebCodecs API. The AudioData returned by this
	 * method *must* be closed separately from this audio sample.
	 */
	toAudioData() {
		if (this._closed) {
			throw new Error('AudioSample is closed.');
		}

		if (this._data instanceof AudioSampleResource) {
			return this._createAudioDataFromData();
		} else if (isAudioData(this._data)) {
			if (this._data.timestamp === this.microsecondTimestamp) {
				// Timestamp matches, let's just return the data (but cloned)
				return this._data.clone();
			} else {
				// It's impossible to simply change an AudioData's timestamp, so we'll need to create a new one
				return this._createAudioDataFromData();
			}
		} else {
			return new AudioData({
				format: this.format,
				sampleRate: this.sampleRate,
				numberOfFrames: this.numberOfFrames,
				numberOfChannels: this.numberOfChannels,
				timestamp: this.microsecondTimestamp,
				data: this._data.buffer instanceof ArrayBuffer
					? this._data.buffer
					: this._data.slice(), // In the case of SharedArrayBuffer, convert to ArrayBuffer
			});
		}
	}

	/** @internal */
	_createAudioDataFromData() {
		if (formatIsPlanar(this.format)) {
			const size = this.allocationSize({ planeIndex: 0, format: this.format });
			const data = new ArrayBuffer(size * this.numberOfChannels);

			// We gotta read out each plane individually
			for (let i = 0; i < this.numberOfChannels; i++) {
				this.copyTo(new Uint8Array(data, i * size, size), { planeIndex: i, format: this.format });
			}

			return new AudioData({
				format: this.format,
				sampleRate: this.sampleRate,
				numberOfFrames: this.numberOfFrames,
				numberOfChannels: this.numberOfChannels,
				timestamp: this.microsecondTimestamp,
				data,
			});
		} else {
			const data = new ArrayBuffer(this.allocationSize({ planeIndex: 0, format: this.format }));
			this.copyTo(data, { planeIndex: 0, format: this.format });

			return new AudioData({
				format: this.format,
				sampleRate: this.sampleRate,
				numberOfFrames: this.numberOfFrames,
				numberOfChannels: this.numberOfChannels,
				timestamp: this.microsecondTimestamp,
				data,
			});
		}
	}

	/** Convert this audio sample to an AudioBuffer for use with the Web Audio API. */
	toAudioBuffer() {
		if (this._closed) {
			throw new Error('AudioSample is closed.');
		}

		const audioBuffer = new AudioBuffer({
			numberOfChannels: this.numberOfChannels,
			length: this.numberOfFrames,
			sampleRate: this.sampleRate,
		});

		const dataBytes = new Float32Array(this.allocationSize({ planeIndex: 0, format: 'f32-planar' }) / 4);

		for (let i = 0; i < this.numberOfChannels; i++) {
			this.copyTo(dataBytes, { planeIndex: i, format: 'f32-planar' });
			audioBuffer.copyToChannel(dataBytes, i);
		}

		return audioBuffer;
	}

	/** Sets the presentation timestamp of this audio sample, in seconds. */
	setTimestamp(newTimestamp: number) {
		if (!Number.isFinite(newTimestamp)) {
			throw new TypeError('newTimestamp must be a number.');
		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		(this.timestamp as number) = newTimestamp;
	}

	/** Calls `.close()`. */
	[Symbol.dispose]() {
		this.close();
	}

	/** @internal */
	static* _fromAudioBuffer(audioBuffer: AudioBuffer, timestamp: number) {
		if (!(audioBuffer instanceof AudioBuffer)) {
			throw new TypeError('audioBuffer must be an AudioBuffer.');
		}

		const MAX_FLOAT_COUNT = 48000 * 5; // 5 seconds of mono 48 kHz audio per sample

		const numberOfChannels = audioBuffer.numberOfChannels;
		const sampleRate = audioBuffer.sampleRate;
		const totalFrames = audioBuffer.length;
		const maxFramesPerChunk = Math.floor(MAX_FLOAT_COUNT / numberOfChannels);

		let currentRelativeFrame = 0;
		let remainingFrames = totalFrames;

		// Create AudioSamples in a chunked fashion so we don't create huge Float32Arrays
		while (remainingFrames > 0) {
			const framesToCopy = Math.min(maxFramesPerChunk, remainingFrames);
			const chunkData = new Float32Array(numberOfChannels * framesToCopy);

			for (let channel = 0; channel < numberOfChannels; channel++) {
				audioBuffer.copyFromChannel(
					chunkData.subarray(channel * framesToCopy, (channel + 1) * framesToCopy),
					channel,
					currentRelativeFrame,
				);
			}

			yield new AudioSample({
				format: 'f32-planar',
				sampleRate,
				numberOfFrames: framesToCopy,
				numberOfChannels,
				timestamp: timestamp + currentRelativeFrame / sampleRate,
				data: chunkData,
			});

			currentRelativeFrame += framesToCopy;
			remainingFrames -= framesToCopy;
		}
	}

	/**
	 * Creates AudioSamples from an AudioBuffer, starting at the given timestamp in seconds. Typically creates exactly
	 * one sample, but may create multiple if the AudioBuffer is exceedingly large.
	 */
	static fromAudioBuffer(audioBuffer: AudioBuffer, timestamp: number) {
		if (!(audioBuffer instanceof AudioBuffer)) {
			throw new TypeError('audioBuffer must be an AudioBuffer.');
		}

		const MAX_FLOAT_COUNT = 48000 * 5; // 5 seconds of mono 48 kHz audio per sample

		const numberOfChannels = audioBuffer.numberOfChannels;
		const sampleRate = audioBuffer.sampleRate;
		const totalFrames = audioBuffer.length;
		const maxFramesPerChunk = Math.floor(MAX_FLOAT_COUNT / numberOfChannels);

		let currentRelativeFrame = 0;
		let remainingFrames = totalFrames;

		const result: AudioSample[] = [];

		// Create AudioSamples in a chunked fashion so we don't create huge Float32Arrays
		while (remainingFrames > 0) {
			const framesToCopy = Math.min(maxFramesPerChunk, remainingFrames);
			const chunkData = new Float32Array(numberOfChannels * framesToCopy);

			for (let channel = 0; channel < numberOfChannels; channel++) {
				audioBuffer.copyFromChannel(
					chunkData.subarray(channel * framesToCopy, (channel + 1) * framesToCopy),
					channel,
					currentRelativeFrame,
				);
			}

			const audioSample = new AudioSample({
				format: 'f32-planar',
				sampleRate,
				numberOfFrames: framesToCopy,
				numberOfChannels,
				timestamp: timestamp + currentRelativeFrame / sampleRate,
				data: chunkData,
			});

			result.push(audioSample);

			currentRelativeFrame += framesToCopy;
			remainingFrames -= framesToCopy;
		}

		return result;
	}
}

const getBytesPerSample = (format: AudioSampleFormat): number => {
	switch (format) {
		case 'u8':
		case 'u8-planar':
			return 1;
		case 's16':
		case 's16-planar':
			return 2;
		case 's32':
		case 's32-planar':
			return 4;
		case 'f32':
		case 'f32-planar':
			return 4;
		default:
			throw new Error('Unknown AudioSampleFormat');
	}
};

const formatIsPlanar = (format: AudioSampleFormat): boolean => {
	switch (format) {
		case 'u8-planar':
		case 's16-planar':
		case 's32-planar':
		case 'f32-planar':
			return true;
		default:
			return false;
	}
};

const getReadFunction = (format: AudioSampleFormat): (view: DataView, offset: number) => number => {
	switch (format) {
		case 'u8':
		case 'u8-planar':
			return (view, offset) => (view.getUint8(offset) - 128) / 128;
		case 's16':
		case 's16-planar':
			return (view, offset) => view.getInt16(offset, true) / 32768;
		case 's32':
		case 's32-planar':
			return (view, offset) => view.getInt32(offset, true) / 2147483648;
		case 'f32':
		case 'f32-planar':
			return (view, offset) => view.getFloat32(offset, true);
	}
};

const getWriteFunction = (format: AudioSampleFormat): (view: DataView, offset: number, value: number) => void => {
	switch (format) {
		case 'u8':
		case 'u8-planar':
			return (view, offset, value) =>
				view.setUint8(offset, clamp((value + 1) * 127.5, 0, 255));
		case 's16':
		case 's16-planar':
			return (view, offset, value) =>
				view.setInt16(offset, clamp(Math.round(value * 32767), -32768, 32767), true);
		case 's32':
		case 's32-planar':
			return (view, offset, value) =>
				view.setInt32(offset, clamp(Math.round(value * 2147483647), -2147483648, 2147483647), true);
		case 'f32':
		case 'f32-planar':
			return (view, offset, value) => view.setFloat32(offset, value, true);
	}
};

const isAudioData = (x: unknown): x is AudioData => {
	return typeof AudioData !== 'undefined' && x instanceof AudioData;
};

export const toInterleavedAudioFormat = (format: AudioSampleFormat): 'u8' | 's16' | 's32' | 'f32' => {
	switch (format) {
		case 'u8-planar':
			return 'u8';
		case 's16-planar':
			return 's16';
		case 's32-planar':
			return 's32';
		case 'f32-planar':
			return 'f32';
		default:
			return format;
	}
};

/**
 * WebKit has a bug where calling AudioData.copyTo with a format different from the source format
 * crashes the tab when there are more than 2 channels. This function works around that by always
 * copying with the source format and then manually converting to the destination format.
 *
 * See https://bugs.webkit.org/show_bug.cgi?id=302521.
 */
const doAudioDataCopyToWebKitWorkaround = (
	audioData: AudioData,
	destView: DataView,
	srcFormat: AudioSampleFormat,
	destFormat: AudioSampleFormat,
	numChannels: number,
	planeIndex: number,
	frameOffset: number,
	copyFrameCount: number,
) => {
	const readFn = getReadFunction(srcFormat);
	const writeFn = getWriteFunction(destFormat);
	const srcBytesPerSample = getBytesPerSample(srcFormat);
	const destBytesPerSample = getBytesPerSample(destFormat);
	const srcIsPlanar = formatIsPlanar(srcFormat);
	const destIsPlanar = formatIsPlanar(destFormat);

	if (destIsPlanar) {
		if (srcIsPlanar) {
			// src planar -> dest planar: copy single plane and convert
			const data = new ArrayBuffer(copyFrameCount * srcBytesPerSample);
			const dataView = toDataView(data);

			audioData.copyTo(data, {
				planeIndex,
				frameOffset,
				frameCount: copyFrameCount,
				format: srcFormat,
			});

			for (let i = 0; i < copyFrameCount; i++) {
				const srcOffset = i * srcBytesPerSample;
				const destOffset = i * destBytesPerSample;
				const sample = readFn(dataView, srcOffset);
				writeFn(destView, destOffset, sample);
			}
		} else {
			// src interleaved -> dest planar: copy all interleaved data, extract one channel
			const data = new ArrayBuffer(copyFrameCount * numChannels * srcBytesPerSample);
			const dataView = toDataView(data);

			audioData.copyTo(data, {
				planeIndex: 0,
				frameOffset,
				frameCount: copyFrameCount,
				format: srcFormat,
			});

			for (let i = 0; i < copyFrameCount; i++) {
				const srcOffset = (i * numChannels + planeIndex) * srcBytesPerSample;
				const destOffset = i * destBytesPerSample;
				const sample = readFn(dataView, srcOffset);
				writeFn(destView, destOffset, sample);
			}
		}
	} else {
		if (srcIsPlanar) {
			// src planar -> dest interleaved: copy each plane and interleave
			const planeSize = copyFrameCount * srcBytesPerSample;
			const data = new ArrayBuffer(planeSize);
			const dataView = toDataView(data);

			for (let ch = 0; ch < numChannels; ch++) {
				audioData.copyTo(data, {
					planeIndex: ch,
					frameOffset,
					frameCount: copyFrameCount,
					format: srcFormat,
				});

				for (let i = 0; i < copyFrameCount; i++) {
					const srcOffset = i * srcBytesPerSample;
					const destOffset = (i * numChannels + ch) * destBytesPerSample;
					const sample = readFn(dataView, srcOffset);
					writeFn(destView, destOffset, sample);
				}
			}
		} else {
			// src interleaved -> dest interleaved: copy all and convert
			const data = new ArrayBuffer(copyFrameCount * numChannels * srcBytesPerSample);
			const dataView = toDataView(data);

			audioData.copyTo(data, {
				planeIndex: 0,
				frameOffset,
				frameCount: copyFrameCount,
				format: srcFormat,
			});

			for (let i = 0; i < copyFrameCount; i++) {
				for (let ch = 0; ch < numChannels; ch++) {
					const idx = i * numChannels + ch;
					const srcOffset = idx * srcBytesPerSample;
					const destOffset = idx * destBytesPerSample;
					const sample = readFn(dataView, srcOffset);
					writeFn(destView, destOffset, sample);
				}
			}
		}
	}
};

export const audioSampleToInterleavedFormat = (sample: AudioSample, format: 'u8' | 's16' | 's32' | 'f32') => {
	const size = sample.allocationSize({ format, planeIndex: 0 });
	const buffer = new ArrayBuffer(size);
	sample.copyTo(buffer, { format, planeIndex: 0 });

	return new AudioSample({
		data: buffer,
		format,
		numberOfChannels: sample.numberOfChannels,
		sampleRate: sample.sampleRate,
		timestamp: sample.timestamp,
		duration: sample.duration,
	});
};
