/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FileHandle } from 'node:fs/promises';
import * as nodeAlias from './node';
import { assert, EventEmitter, FilePath, MaybePromise } from './misc';

const node = typeof nodeAlias !== 'undefined'
	? nodeAlias // Aliasing it prevents some bundler warnings
	: undefined!;

/**
 * The events emitted by a {@link Target}.
 * @group Output targets
 * @public
 */
export type TargetEvents = {
	/** Emitted each time data is written to the target. */
	write: {
		/** The start of the written range, inclusive. */
		start: number;
		/** The end of the written range, exclusive. */
		end: number;
	};
	/** Emitted when the target is finalized. */
	finalized: void;
};

/**
 * Base class for targets, specifying where output files are written.
 * @group Output targets
 * @public
 */
export abstract class Target extends EventEmitter<TargetEvents> {
	/** @internal */
	_writerAcquired = false;

	/** @internal */
	_monotonicity: boolean | null = null; // null = unknown

	/** @internal */
	abstract _start(): void;
	/** @internal */
	abstract _write(data: Uint8Array, pos: number): void;
	/** @internal */
	abstract _flush(): Promise<void>;
	/** @internal */
	abstract _finalize(): Promise<void>;
	/** @internal */
	abstract _close(): Promise<void>;

	/**
	 * Called each time data is written to the target. Will be called with the byte range into which data was written.
	 *
	 * Use this callback to track the size of the output file as it grows. But be warned, this function is chatty and
	 * gets called *extremely* often.
	 *
	 * @deprecated Use `target.on('write', ({ start, end }) => ...)` instead.
	 */
	onwrite: ((start: number, end: number) => unknown) | null = null;

	/** @internal */
	_setMonotonicity(monotonicity: boolean) {
		if (this._monotonicity !== false) {
			this._monotonicity = monotonicity;
		} else {
			// Once false, it's locked
		}
	}

	/** @internal */
	_dispatchWrite(start: number, end: number) {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		this.onwrite?.(start, end);
		this._emit('write', { start, end });
	}

	/**
	 * Returns a new {@link RangedTarget} that writes data to this target using the given offset.
	 *
	 * Useful for writing a file into a section of a larger file.
	 */
	slice(offset: number) {
		if (!Number.isInteger(offset) || offset < 0) {
			throw new TypeError('offset must be a non-negative integer.');
		}

		return new RangedTarget(this, offset);
	}
}

const ARRAY_BUFFER_INITIAL_SIZE = 2 ** 16;
const ARRAY_BUFFER_MAX_SIZE = 2 ** 32;

/**
 * Options for {@link BufferTarget}.
 * @group Output targets
 * @public
 */
export type BufferTargetOptions = {
	/**
	 * Called once the target has been finalized, with the complete output buffer. If you return a promise, it will be
	 * used to apply backpressure internally.
	 *
	 * One use for this callback is for uploading to a server where the full buffer must be known before
	 * sending (e.g. S3 PutObject) and stream-uploading is not an option.
	 */
	onFinalize?: (buffer: ArrayBuffer) => MaybePromise<unknown>;
};

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
	_buffer: ArrayBuffer;
	/** @internal */
	_bytes: Uint8Array;
	/** @internal */
	_maxPos = 0;
	/** @internal */
	_supportsResize: boolean;
	/** @internal */
	_options: BufferTargetOptions;

	/** Creates a new {@link BufferTarget}. The buffer holding the data will be created and managed internally. */
	constructor(options: BufferTargetOptions = {}) {
		super();

		if (!options || typeof options !== 'object') {
			throw new TypeError('BufferTarget options, when provided, must be an object.');
		}
		if (options.onFinalize !== undefined && typeof options.onFinalize !== 'function') {
			throw new TypeError('options.onFinalize, when provided, must be a function.');
		}

		this._options = options;

		this._supportsResize = 'resize' in new ArrayBuffer(0);
		if (this._supportsResize) {
			try {
				// @ts-expect-error Don't want to bump "lib" in tsconfig
				this._buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE, { maxByteLength: ARRAY_BUFFER_MAX_SIZE });
			} catch {
				this._buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE);
				this._supportsResize = false;
			}
		} else {
			this._buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE);
		}

		this._bytes = new Uint8Array(this._buffer);
	}

	/** @internal */
	_ensureSize(size: number) {
		let newLength = this._buffer.byteLength;
		while (newLength < size) newLength *= 2;

		if (newLength === this._buffer.byteLength) return;

		if (newLength > ARRAY_BUFFER_MAX_SIZE) {
			throw new Error(
				`ArrayBuffer exceeded maximum size of ${ARRAY_BUFFER_MAX_SIZE} bytes. Please consider using another`
				+ ` target.`,
			);
		}

		if (this._supportsResize) {
			// Use resize if it exists
			// @ts-expect-error Don't want to bump "lib" in tsconfig
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			this._buffer.resize(newLength);
			// The Uint8Array scales automatically
		} else {
			const newBuffer = new ArrayBuffer(newLength);
			const newBytes = new Uint8Array(newBuffer);
			newBytes.set(this._bytes, 0);

			this._buffer = newBuffer;
			this._bytes = newBytes;
		}
	}

	/** @internal */
	_start() {}

	/** @internal */
	_write(data: Uint8Array, pos: number) {
		this._ensureSize(pos + data.byteLength);

		this._bytes.set(data, pos);

		this._maxPos = Math.max(this._maxPos, pos + data.byteLength);

		this._dispatchWrite(pos, pos + data.byteLength);
	}

	/** @internal */
	async _flush() {}

	/** @internal */
	async _finalize() {
		this.buffer = this._buffer.slice(0, this._maxPos);

		if (this._options.onFinalize) {
			await this._options.onFinalize(this.buffer);
		}

		this._emit('finalized');
	}

	/** @internal */
	async _close() {}

	/** @internal */
	_getSlice(start: number, end: number) {
		return this._bytes.slice(start, end);
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

const DEFAULT_CHUNK_SIZE = 2 ** 24;
const MAX_CHUNKS_AT_ONCE = 2;

type Chunk = {
	start: number;
	written: ChunkSection[];
	data: Uint8Array<ArrayBuffer>;
	shouldFlush: boolean;
};

type ChunkSection = {
	start: number;
	end: number;
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

	/** @internal */
	_sections: {
		data: Uint8Array;
		start: number;
	}[] = [];

	/** @internal */
	_lastWriteEnd = 0;
	/** @internal */
	_lastFlushEnd = 0;
	/** @internal */
	_streamWriter: WritableStreamDefaultWriter<StreamTargetChunk> | null = null;
	/** @internal */
	_writeError: unknown = null;

	// These variables regard chunked mode:
	/** @internal */
	_chunked: boolean;
	/** @internal */
	_chunkSize: number;
	/**
	 * The data is divided up into fixed-size chunks, whose contents are first filled in RAM and then flushed out.
	 * A chunk is flushed if all of its contents have been written.
	 */
	/** @internal */
	_chunks: Chunk[] = [];

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

		this._chunked = options.chunked ?? false;
		this._chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
	}

	/** @internal */
	_start() {
		this._streamWriter = this._writable.getWriter();
	}

	/** @internal */
	_write(data: Uint8Array, pos: number) {
		if (pos > this._lastWriteEnd) {
			const paddingBytesNeeded = pos - this._lastWriteEnd;
			this._write(new Uint8Array(paddingBytesNeeded), this._lastWriteEnd);
		}

		this._sections.push({
			data: data.slice(),
			start: pos,
		});

		this._lastWriteEnd = Math.max(this._lastWriteEnd, pos + data.byteLength);

		this._dispatchWrite(pos, pos + data.byteLength);
	}

	/** @internal */
	async _flush() {
		if (this._writeError !== null) {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw this._writeError;
		}

		assert(this._streamWriter);

		if (this._sections.length === 0) {
			return;
		}

		const chunks: {
			start: number;
			size: number;
			data?: Uint8Array<ArrayBuffer>;
		}[] = [];
		const sorted = [...this._sections].sort((a, b) => a.start - b.start);

		chunks.push({
			start: sorted[0]!.start,
			size: sorted[0]!.data.byteLength,
		});

		// Figure out how many contiguous chunks we have
		for (let i = 1; i < sorted.length; i++) {
			const lastChunk = chunks[chunks.length - 1]!;
			const section = sorted[i]!;

			if (section.start <= lastChunk.start + lastChunk.size) {
				lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
			} else {
				chunks.push({
					start: section.start,
					size: section.data.byteLength,
				});
			}
		}

		for (const chunk of chunks) {
			chunk.data = new Uint8Array(chunk.size);

			// Make sure to write the data in the correct order for correct overwriting
			for (const section of this._sections) {
				// Check if the section is in the chunk
				if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
					chunk.data.set(section.data, section.start - chunk.start);
				}
			}

			if (this._streamWriter.desiredSize !== null && this._streamWriter.desiredSize <= 0) {
				await this._streamWriter.ready; // Allow the writer to apply backpressure
			}

			if (this._chunked) {
				// Let's first gather the data into bigger chunks before writing it
				this._writeDataIntoChunks(chunk.data, chunk.start);
				this._tryToFlushChunks();
			} else {
				if (this._monotonicity === true && chunk.start !== this._lastFlushEnd) {
					throw new Error('Internal error: Monotonicity violation.');
				}

				void this._streamWriter.write({
					type: 'write',
					data: chunk.data,
					position: chunk.start,
				}).catch((error) => {
					this._writeError ??= error;
				});

				this._lastFlushEnd = chunk.start + chunk.data.byteLength;
			}
		}

		this._sections.length = 0;
	}

	/** @internal */
	_writeDataIntoChunks(data: Uint8Array, position: number) {
		// First, find the chunk to write the data into, or create one if none exists
		let chunkIndex = this._chunks.findIndex(x => x.start <= position && position < x.start + this._chunkSize);
		if (chunkIndex === -1) chunkIndex = this._createChunk(position);
		const chunk = this._chunks[chunkIndex]!;

		// Figure out how much to write to the chunk, and then write to the chunk
		const relativePosition = position - chunk.start;
		const toWrite = data.subarray(0, Math.min(this._chunkSize - relativePosition, data.byteLength));
		chunk.data.set(toWrite, relativePosition);

		// Create a section describing the region of data that was just written to
		const section: ChunkSection = {
			start: relativePosition,
			end: relativePosition + toWrite.byteLength,
		};
		this._insertSectionIntoChunk(chunk, section);

		// Queue chunk for flushing to target if it has been fully written to
		if (chunk.written[0]!.start === 0 && chunk.written[0]!.end === this._chunkSize) {
			chunk.shouldFlush = true;
		}

		// Make sure we don't hold too many chunks in memory at once to keep memory usage down
		if (this._chunks.length > MAX_CHUNKS_AT_ONCE) {
			// Flush all but the last chunk
			for (let i = 0; i < this._chunks.length - 1; i++) {
				this._chunks[i]!.shouldFlush = true;
			}
			this._tryToFlushChunks();
		}

		// If the data didn't fit in one chunk, recurse with the remaining data
		if (toWrite.byteLength < data.byteLength) {
			this._writeDataIntoChunks(data.subarray(toWrite.byteLength), position + toWrite.byteLength);
		}
	}

	/** @internal */
	_insertSectionIntoChunk(chunk: Chunk, section: ChunkSection) {
		let low = 0;
		let high = chunk.written.length - 1;
		let index = -1;

		// Do a binary search to find the last section with a start not larger than `section`'s start
		while (low <= high) {
			const mid = Math.floor(low + (high - low + 1) / 2);

			if (chunk.written[mid]!.start <= section.start) {
				low = mid + 1;
				index = mid;
			} else {
				high = mid - 1;
			}
		}

		// Insert the new section
		chunk.written.splice(index + 1, 0, section);
		if (index === -1 || chunk.written[index]!.end < section.start) index++;

		// Merge overlapping sections
		while (index < chunk.written.length - 1 && chunk.written[index]!.end >= chunk.written[index + 1]!.start) {
			chunk.written[index]!.end = Math.max(chunk.written[index]!.end, chunk.written[index + 1]!.end);
			chunk.written.splice(index + 1, 1);
		}
	}

	/** @internal */
	_createChunk(includesPosition: number) {
		const start = Math.floor(includesPosition / this._chunkSize) * this._chunkSize;
		const chunk: Chunk = {
			start,
			data: new Uint8Array(this._chunkSize),
			written: [],
			shouldFlush: false,
		};
		this._chunks.push(chunk);
		this._chunks.sort((a, b) => a.start - b.start);

		return this._chunks.indexOf(chunk);
	}

	/** @internal */
	_tryToFlushChunks(force = false) {
		assert(this._streamWriter);

		for (let i = 0; i < this._chunks.length; i++) {
			const chunk = this._chunks[i]!;
			if (!chunk.shouldFlush && !force) continue;

			for (const section of chunk.written) {
				const position = chunk.start + section.start;
				if (this._monotonicity === true && position !== this._lastFlushEnd) {
					throw new Error('Internal error: Monotonicity violation.');
				}

				void this._streamWriter.write({
					type: 'write',
					data: chunk.data.subarray(section.start, section.end),
					position,
				}).catch((error) => {
					this._writeError ??= error;
				});

				this._lastFlushEnd = chunk.start + section.end;
			}

			this._chunks.splice(i--, 1);
		}
	}

	/** @internal */
	async _finalize() {
		if (this._chunked) {
			this._tryToFlushChunks(true);
		}

		if (this._writeError !== null) {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw this._writeError;
		}

		assert(this._streamWriter);
		await this._streamWriter.ready;
		await this._streamWriter.close();

		this._emit('finalized');
	}

	/** @internal */
	async _close() {
		return this._streamWriter?.close();
	}
}

/**
 * This target writes to a `WritableStream<Uint8Array>`, meaning all writes are necessarily append-only and involve no
 * seeking. Great for streaming data to a source that can only accept sequential data, like an HTTP server processing
 * an incoming upload.
 *
 * Note that using this target *requires* that the underlying format write data sequentially. Not all formats do this,
 * and this target will throw for the formats that don't. Check the guide for more.
 *
 * @group Output targets
 * @public
 */
export class AppendOnlyStreamTarget extends Target {
	/** @internal */
	_writable: WritableStream<Uint8Array>;
	/** @internal */
	_streamTarget: StreamTarget;
	/** @internal */
	_writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	/** @internal */
	_nextWritePos = 0;

	constructor(writable: WritableStream<Uint8Array>) {
		super();

		this._writable = writable;
		this._streamTarget = new StreamTarget(new WritableStream({
			start: () => {
				this._writer = this._writable.getWriter();
			},
			write: (chunk) => {
				if (this._monotonicity !== true) {
					throw new Error(
						'AppendOnlyStreamTarget requires that data be written monotonically (always appended to the'
						+ ' end). You must use a format that guarantees this behavior.',
					);
				}

				assert(chunk.position === this._nextWritePos);
				this._nextWritePos += chunk.data.byteLength;

				assert(this._writer);
				return this._writer.write(chunk.data);
			},
			close: () => {
				return this._writer?.close();
			},
		}));
	}

	/** @internal */
	_start(): void {
		this._streamTarget._start();
	}

	/** @internal */
	_write(data: Uint8Array, pos: number): void {
		this._streamTarget._write(data, pos);
	}

	/** @internal */
	_flush(): Promise<void> {
		return this._streamTarget._flush();
	}

	/** @internal */
	_finalize(): Promise<void> {
		return this._streamTarget._finalize();
	}

	/** @internal */
	_close(): Promise<void> {
		return this._streamTarget._close();
	}

	/** @internal */
	override _setMonotonicity(monotonicity: boolean): void {
		super._setMonotonicity(monotonicity);
		this._streamTarget._setMonotonicity(monotonicity);
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

		if (!node.fs) {
			throw new Error(
				'FilePathTarget is only available in server-side environments (Node.js, Bun, Deno).',
			);
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
	}

	/** @internal */
	_start() {
		this._streamTarget._start();
	}

	/** @internal */
	_write(data: Uint8Array, pos: number) {
		this._streamTarget._write(data, pos);
		this._dispatchWrite(pos, pos + data.byteLength);
	}

	/** @internal */
	async _flush() {
		return this._streamTarget._flush();
	}

	/** @internal */
	async _finalize() {
		await this._streamTarget._finalize();
		this._emit('finalized');
	}

	/** @internal */
	async _close() {
		return this._streamTarget._close();
	}

	/** @internal */
	override _setMonotonicity(monotonicity: boolean): void {
		super._setMonotonicity(monotonicity);
		this._streamTarget._setMonotonicity(monotonicity);
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
	_start() {}

	/** @internal */

	_write(data: Uint8Array, pos: number) {
		this._dispatchWrite(pos, pos + data.byteLength);
	}

	/** @internal */
	async _flush() {}

	/** @internal */
	async _finalize() {
		this._emit('finalized');
	}

	/** @internal */
	async _close() {}
}

/**
 * A target that writes to a subrange (defined by an offset) of another, underlying target. Useful for writing a file
 * into a section of a larger file.
 * @group Output targets
 * @public
 */
export class RangedTarget extends Target {
	/** @internal */
	_baseTarget: Target;
	/** @internal */
	_offset: number;

	/** @internal */
	constructor(baseTarget: Target, offset: number) {
		super();

		this._baseTarget = baseTarget;
		this._offset = offset;
	}

	/** @internal */
	_start() {}

	/** @internal */
	_write(data: Uint8Array, pos: number): void {
		this._baseTarget._write(data, this._offset + pos);
		this._dispatchWrite(pos, pos + data.byteLength);
	}

	/** @internal */
	_flush() {
		return this._baseTarget._flush();
	}

	/** @internal */
	async _finalize() {
		this._emit('finalized');
	}

	/** @internal */
	async _close() {}

	/** @internal */
	override _setMonotonicity(monotonicity: boolean): void {
		super._setMonotonicity(monotonicity);
		this._baseTarget._setMonotonicity(monotonicity);
	}
}

/**
 * A special target for writing multi-file media where each file is uniquely identified by a path.
 * @group Output targets
 * @public
 */
export class PathedTarget<T extends Target> {
	/** Creates a new {@link PathedTarget} from a root path and a callback. */
	constructor(
		/** The path that points to the root file; the entry file of the media. */
		public readonly rootPath: FilePath,
		/** The callback that is called for each file that needs to be written; must return a {@link Target}. */
		public readonly getTarget: (request: TargetRequest) => MaybePromise<T>,
	) {
		if (typeof rootPath !== 'string') {
			throw new TypeError('rootPath must be a string.');
		}
		if (typeof getTarget !== 'function') {
			throw new TypeError('getTarget must be a function.');
		}
	}
}

/**
 * A request for a {@link Target} at the given path.
 * @group Output targets
 * @public
 */
export type TargetRequest = {
	/** The requested file path. */
	path: FilePath;
	/** Whether the to-be-written file will be the root file. */
	isRoot: boolean;
	/** The MIME type of the to-be-written file. */
	mimeType: string;
};
