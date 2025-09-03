/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { BufferTargetWriter, NullTargetWriter, StreamTargetWriter, Writer } from './writer';
import { Output } from './output';

/**
 * Base class for targets, specifying where output files are written.
 * @public
 */
export abstract class Target {
	/** @internal */
	_output: Output | null = null;

	/** @internal */
	abstract _createWriter(): Writer;

	/**
	 * Called each time data is written to the target. Will be called with the byte range into which data was written.
	 *
	 * Use this callback to track the size of the output file as it grows. But be warned, this function is chatty and
	 * gets called *extremely* often.
	 */
	onwrite: ((start: number, end: number) => unknown) | null = null;
}

/**
 * A target that writes data directly into an ArrayBuffer in memory. Great for performance, but not suitable for very
 * large files. The buffer will be available once the output has been finalized.
 * @public
 */
export class BufferTarget extends Target {
	/** Stores the final output buffer. Until the output is finalized, this will be null. */
	buffer: ArrayBuffer | null = null;

	/** @internal */
	_createWriter() {
		return new BufferTargetWriter(this);
	}
}

/**
 * A data chunk for StreamTarget.
 * @public
 */
export type StreamTargetChunk = {
	/** The operation type. */
	type: 'write'; // This ensures automatic compatibility with FileSystemWritableFileStream
	/** The data to write. */
	data: Uint8Array;
	/** The byte offset in the output file at which to write the data. */
	position: number;
};

/**
 * Options for StreamTarget.
 * @public
 */
export type StreamTargetOptions = {
	/**
	 * When setting this to true, data created by the output will first be accumulated and only written out
	 * once it has reached sufficient size, using a default chunk size of 16 MiB. This is useful for reducing the total
	 * amount of writes, at the cost of latency.
	 */
	chunked?: boolean;
	/** When using `chunked: true`, this specifies the maximum size of each chunk. Defaults to 16 MiB. */
	chunkSize?: number;
};

/**
 * This target writes data to a WritableStream, making it a general-purpose target for writing data anywhere. It is
 * also compatible with FileSystemWritableFileStream for use with the File System Access API. The WritableStream can
 * also apply backpressure, which will propagate to the output and throttle the encoders.
 * @public
 */
export class StreamTarget extends Target {
	/** @internal */
	_writable: WritableStream<StreamTargetChunk>;
	/** @internal */
	_options: StreamTargetOptions;

	constructor(
		writable: WritableStream<StreamTargetChunk>,
		options: StreamTargetOptions = {},
	) {
		super();

		if (!(writable instanceof WritableStream)) {
			throw new TypeError('StreamTarget requires a WritableStream instance.');
		}
		if (options != null && typeof options !== 'object') {
			throw new TypeError('StreamTarget options, when provided, must be an object.');
		}
		if (options.chunked !== undefined && typeof options.chunked !== 'boolean') {
			throw new TypeError('options.chunked, when provided, must be a boolean.');
		}
		if (options.chunkSize !== undefined && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
			throw new TypeError('options.chunkSize, when provided, must be an integer and not smaller than 1024.');
		}

		this._writable = writable;
		this._options = options;
	}

	/** @internal */
	_createWriter() {
		return new StreamTargetWriter(this);
	}
}

/**
 * This target just discards all incoming data. It is useful for when you need an `Output` but extract data from it
 * differently, for example through format-specific callbacks (`onMoof`, `onMdat`, ...) or encoder events.
 * @public
 */
export class NullTarget extends Target {
	/** @internal */
	_createWriter() {
		return new NullTargetWriter(this);
	}
}
