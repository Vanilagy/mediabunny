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
	isAllowSharedBufferSource,
	Rotation,
	SECOND_TO_MICROSECOND_FACTOR,
	toDataView,
	toUint8Array,
	SetRequired,
	isFirefox,
	polyfillSymbolDispose,
	assertNever,
	isWebKit,
} from './misc';

polyfillSymbolDispose();

type FinalizationRegistryValue = {
	type: 'video';
	data: VideoFrame | OffscreenCanvas | Uint8Array;
} | {
	type: 'audio';
	data: AudioData | Uint8Array;
};

// Let's manually handle logging the garbage collection errors that are typically logged by the browser. This way, they
// also kick for audio samples (which is normally not the case), making sure any incorrect code is quickly caught.
let lastVideoGcErrorLog = -Infinity;
let lastAudioGcErrorLog = -Infinity;
let finalizationRegistry: FinalizationRegistry<FinalizationRegistryValue> | null = null;
if (typeof FinalizationRegistry !== 'undefined') {
	finalizationRegistry = new FinalizationRegistry<FinalizationRegistryValue>((value) => {
		const now = Date.now();

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
};

/**
 * Represents a raw, unencoded video sample (frame). Mainly used as an expressive wrapper around WebCodecs API's
 * [`VideoFrame`](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame), but can also be used standalone.
 * @group Samples
 * @public
 */
export class VideoSample implements Disposable {
	/** @internal */
	_data!: VideoFrame | OffscreenCanvas | Uint8Array | null;
	/**
	 * Used for the ArrayBuffer-backed case.
	 * @internal
	 */
	_layout!: PlaneLayout[] | null;
	/** @internal */
	_closed: boolean = false;

	/**
	 * The internal pixel format in which the frame is stored. Will be `null` if it's using an arbitrary internal
	 * format not representable by `VideoPixelFormat`.
	 * [See pixel formats](https://www.w3.org/TR/webcodecs/#pixel-format)
	 */
	readonly format!: VideoSamplePixelFormat | null;
	/** The width of the frame in pixels. */
	readonly codedWidth!: number;
	/** The height of the frame in pixels. */
	readonly codedHeight!: number;
	/** The rotation of the frame in degrees, clockwise. */
	readonly rotation!: Rotation;
	/**
	 * The presentation timestamp of the frame in seconds. May be negative. Frames with negative end timestamps should
	 * not be presented.
	 */
	readonly timestamp!: number;
	/** The duration of the frame in seconds. */
	readonly duration!: number;
	/** The color space of the frame. */
	readonly colorSpace!: VideoSampleColorSpace;

	/** The width of the frame in pixels after rotation. */
	get displayWidth() {
		return this.rotation % 180 === 0 ? this.codedWidth : this.codedHeight;
	}

	/** The height of the frame in pixels after rotation. */
	get displayHeight() {
		return this.rotation % 180 === 0 ? this.codedHeight : this.codedWidth;
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
	constructor(
		data: VideoFrame | CanvasImageSource | AllowSharedBufferSource,
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

			this._data = toUint8Array(data).slice(); // Copy it
			this._layout = init.layout ?? createDefaultPlaneLayout(init.format, init.codedWidth!, init.codedHeight!);

			this.format = init.format;
			this.codedWidth = init.codedWidth!;
			this.codedHeight = init.codedHeight!;
			this.rotation = init.rotation ?? 0;
			this.timestamp = init.timestamp!;
			this.duration = init.duration ?? 0;
			this.colorSpace = new VideoSampleColorSpace(init.colorSpace);
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

			this._data = data;
			this._layout = null;

			this.format = data.format;
			// Copying the display dimensions here, assuming no innate VideoFrame rotation
			this.codedWidth = data.displayWidth;
			this.codedHeight = data.displayHeight;
			// The VideoFrame's rotation is ignored here. It's still a new field, and I'm not sure of any application
			// where the browser makes use of it. If a case gets found, I'll add it.
			this.rotation = init?.rotation ?? 0;
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
			assert(context);

			// Draw it to a canvas
			context.drawImage(data, 0, 0);
			this._data = canvas;
			this._layout = null;

			this.format = 'RGBX';
			this.codedWidth = width;
			this.codedHeight = height;
			this.rotation = init.rotation ?? 0;
			this.timestamp = init.timestamp!;
			this.duration = init.duration ?? 0;
			this.colorSpace = new VideoSampleColorSpace({
				matrix: 'rgb',
				primaries: 'bt709',
				transfer: 'iec61966-2-1',
				fullRange: true,
			});
		} else {
			throw new TypeError('Invalid data type: Must be a BufferSource or CanvasImageSource.');
		}

		finalizationRegistry?.register(this, { type: 'video', data: this._data }, this);
	}

	/** Clones this video sample. */
	clone() {
		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		assert(this._data !== null);

		if (isVideoFrame(this._data)) {
			return new VideoSample(this._data.clone(), {
				timestamp: this.timestamp,
				duration: this.duration,
				rotation: this.rotation,
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

		if (isVideoFrame(this._data)) {
			this._data.close();
		} else {
			this._data = null; // GC that shit
		}

		this._closed = true;
	}

	/**
	 * Returns the number of bytes required to hold this video sample's pixel data. Throws if `format` is `null`.
	 */
	allocationSize(options: VideoFrameCopyToOptions = {}): number {
		validateVideoFrameCopyToOptions(options);

		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}
		if (this.format === null) {
			// https://github.com/Vanilagy/mediabunny/issues/267
			// https://github.com/w3c/webcodecs/issues/920
			throw new Error('Cannot get allocation size when format is null. Sorry!');
		}

		assert(this._data !== null);

		if (!isVideoFrame(this._data)) {
			if (
				options.colorSpace
				|| (options.format && options.format !== this.format)
				|| options.layout
				|| options.rect
			) {
				// Temporarily convert to VideoFrame to get it done
				// TODO: Compute this directly without needing to go through VideoFrame
				const videoFrame = this.toVideoFrame();
				const size = videoFrame.allocationSize(options);
				videoFrame.close();

				return size;
			}
		}

		if (isVideoFrame(this._data)) {
			return this._data.allocationSize(options);
		} else if (this._data instanceof Uint8Array) {
			return this._data.byteLength;
		} else {
			return this.codedWidth * this.codedHeight * 4; // RGBX
		}
	}

	/**
	 * Copies this video sample's pixel data to an ArrayBuffer or ArrayBufferView. Throws if `format` is `null`.
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
		if (this.format === null) {
			throw new Error('Cannot copy video sample data when format is null. Sorry!');
		}

		assert(this._data !== null);

		if (!isVideoFrame(this._data)) {
			if (
				options.colorSpace
				|| (options.format && options.format !== this.format)
				|| options.layout
				|| options.rect
			) {
				// Temporarily convert to VideoFrame to get it done
				// TODO: Do this directly without needing to go through VideoFrame
				const videoFrame = this.toVideoFrame();
				const layout = await videoFrame.copyTo(destination, options);
				videoFrame.close();

				return layout;
			}
		}

		if (isVideoFrame(this._data)) {
			return this._data.copyTo(destination, options);
		} else if (this._data instanceof Uint8Array) {
			assert(this._layout);

			const dest = toUint8Array(destination);
			dest.set(this._data);

			return this._layout;
		} else {
			const canvas = this._data;
			const context = canvas.getContext('2d');
			assert(context);

			const imageData = context.getImageData(0, 0, this.codedWidth, this.codedHeight);
			const dest = toUint8Array(destination);
			dest.set(imageData.data);

			return [{
				offset: 0,
				stride: 4 * this.codedWidth,
			}];
		}
	}

	/**
	 * Converts this video sample to a VideoFrame for use with the WebCodecs API. The VideoFrame returned by this
	 * method *must* be closed separately from this video sample.
	 */
	toVideoFrame() {
		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		assert(this._data !== null);

		if (isVideoFrame(this._data)) {
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
			? [this.codedWidth, this.codedHeight]
			: [this.codedHeight, this.codedWidth];

		if (options.crop) {
			clampCropRectangle(options.crop, rotatedWidth, rotatedHeight);
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
				this.codedHeight - sx - sWidth,
				sHeight,
				sWidth,
			];
		} else if (rotation === 180) {
			[sx, sy] = [
				this.codedWidth - sx - sWidth,
				this.codedHeight - sy - sHeight,
			];
		} else if (rotation === 270) {
			[sx, sy, sWidth, sHeight] = [
				this.codedWidth - sy - sHeight,
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
	 * You must use the value returned by this method immediately, as any VideoFrame created internally will
	 * automatically be closed in the next microtask.
	 */
	toCanvasImageSource() {
		if (this._closed) {
			throw new Error('VideoSample is closed.');
		}

		assert(this._data !== null);

		if (this._data instanceof Uint8Array) {
			// Requires VideoFrame to be defined
			const videoFrame = this.toVideoFrame();
			queueMicrotask(() => videoFrame.close()); // Let's automatically close the frame in the next microtask

			return videoFrame;
		} else {
			return this._data;
		}
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

	/** Calls `.close()`. */
	[Symbol.dispose]() {
		this.close();
	}
}

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

export const clampCropRectangle = (crop: CropRectangle, outerWidth: number, outerHeight: number) => {
	crop.left = Math.min(crop.left, outerWidth);
	crop.top = Math.min(crop.top, outerHeight);
	crop.width = Math.min(crop.width, outerWidth - crop.left);
	crop.height = Math.min(crop.height, outerHeight - crop.top);

	assert(crop.width >= 0);
	assert(crop.height >= 0);
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
const getPlaneConfigs = (format: VideoSamplePixelFormat): PlaneConfig[] => {
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

const AUDIO_SAMPLE_FORMATS = new Set<AudioSampleFormat>(
	['f32', 'f32-planar', 's16', 's16-planar', 's32', 's32-planar', 'u8', 'u8-planar'],
);

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
	_data: AudioData | Uint8Array;
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
	constructor(init: AudioData | AudioSampleInit) {
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

		const { planeIndex, format, frameCount: optFrameCount, frameOffset: optFrameOffset } = options;

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
			const uint8Data = this._data;
			const srcView = toDataView(uint8Data);
			const readFn = getReadFunction(srcFormat);
			const srcBytesPerSample = getBytesPerSample(srcFormat);
			const srcIsPlanar = formatIsPlanar(srcFormat);

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

		if (isAudioData(this._data)) {
			const sample = new AudioSample(this._data.clone());
			sample.setTimestamp(this.timestamp); // Make sure the timestamp is precise (beyond microsecond accuracy)

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

		if (isAudioData(this._data)) {
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

		if (isAudioData(this._data)) {
			if (this._data.timestamp === this.microsecondTimestamp) {
				// Timestamp matches, let's just return the data (but cloned)
				return this._data.clone();
			} else {
				// It's impossible to simply change an AudioData's timestamp, so we'll need to create a new one
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
