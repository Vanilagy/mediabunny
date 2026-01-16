/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FileHandle } from 'node:fs/promises';
import { BufferTargetWriter, NullTargetWriter, StreamTargetWriter, Writer } from './writer';
import { Output } from './output';
import * as nodeAlias from './node';
import { assert } from './misc';

const node = typeof nodeAlias !== 'undefined'
	? nodeAlias // Aliasing it prevents some bundler warnings
	: undefined!;

/**
 * Base class for targets, specifying where output files are written.
 * @group Output targets
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
 * @group Output targets
 * @public
 */
export class BufferTarget extends Target {
	/** Stores the final output buffer. Until the output is finalized, this will be `null`. */
	buffer: ArrayBuffer | null = null;

	/** @internal */
	_createWriter() {
		return new BufferTargetWriter(this);
	}
}

/**
 * A data chunk for {@link StreamTarget}.
 * @group Output targets
 * @public
 */
export type StreamTargetChunk = {
	/** The operation type. */
	type: 'write'; // This ensures automatic compatibility with FileSystemWritableFileStream
	/** The data to write. */
	data: Uint8Array<ArrayBuffer>;
	/** The byte offset in the output file at which to write the data. */
	position: number;
};

/**
 * Options for {@link StreamTarget}.
 * @group Output targets
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
 * This target writes data to a [`WritableStream`](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream),
 * making it a general-purpose target for writing data anywhere. It is also compatible with
 * [`FileSystemWritableFileStream`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream) for
 * use with the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). The
 * `WritableStream` can also apply backpressure, which will propagate to the output and throttle the encoders.
 * @group Output targets
 * @public
 */
export class StreamTarget extends Target {
	/** @internal */
	_writable: WritableStream<StreamTargetChunk>;
	/** @internal */
	_options: StreamTargetOptions;

	/** Creates a new {@link StreamTarget} which writes to the specified `writable`. */
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
 * Options for {@link FilePathTarget}.
 * @group Output targets
 * @public
 */
export type FilePathTargetOptions = StreamTargetOptions;

/**
 * A target that writes to a file at the specified path. Intended for server-side usage in Node, Bun, or Deno.
 *
 * Writing is chunked by default. The internally held file handle will be closed when `.finalize()` or `.cancel()` are
 * called on the corresponding {@link Output}.
 * @group Output targets
 * @public
 */
export class FilePathTarget extends Target {
	/** @internal */
	_streamTarget: StreamTarget;
	/** @internal */
	_fileHandle: FileHandle | null = null;

	/** Creates a new {@link FilePathTarget} that writes to the file at the specified file path. */
	constructor(filePath: string, options: FilePathTargetOptions = {}) {
		if (typeof filePath !== 'string') {
			throw new TypeError('filePath must be a string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}

		super();

		// Let's back this target with a StreamTarget, makes the implementation very simple
		const writable = new WritableStream<StreamTargetChunk>({
			start: async () => {
				this._fileHandle = await node.fs.open(filePath, 'w');
			},
			write: async (chunk) => {
				assert(this._fileHandle);
				await this._fileHandle.write(chunk.data, 0, chunk.data.byteLength, chunk.position);
			},
			close: async () => {
				if (this._fileHandle) {
					await this._fileHandle.close();
					this._fileHandle = null;
				}
			},
		});

		this._streamTarget = new StreamTarget(writable, {
			chunked: true,
			...options,
		});
		this._streamTarget._output = this._output;
	}

	/** @internal */
	_createWriter(): Writer {
		return this._streamTarget._createWriter();
	}
}

/**
 * This target just discards all incoming data. It is useful for when you need an {@link Output} but extract data from
 * it differently, for example through format-specific callbacks (`onMoof`, `onMdat`, ...) or encoder events.
 * @group Output targets
 * @public
 */
export class NullTarget extends Target {
	/** @internal */
	_createWriter() {
		return new NullTargetWriter(this);
	}
}
