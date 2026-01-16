/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { BufferTarget, NullTarget, StreamTarget, StreamTargetChunk } from './target';
import { assert } from './misc';

export abstract class Writer {
	/** Setting this to true will cause the writer to ensure data is written in a strictly monotonic, streamable way. */
	ensureMonotonicity = false;

	start() {}

	/** Writes the given data to the target, at the current position. */
	abstract write(data: Uint8Array): void;
	/** Sets the current position for future writes to a new one. */
	abstract seek(newPos: number): void;
	/** Returns the current position. */
	abstract getPos(): number;
	/** Signals to the writer that it may be time to flush. */
	abstract flush(): Promise<void>;
	/** Called after muxing has finished. */
	abstract finalize(): Promise<void>;
	/** Closes the writer. */
	abstract close(): Promise<void>;

	private trackedWrites: Uint8Array | null = null;
	private trackedStart = -1;
	private trackedEnd = -1;

	protected maybeTrackWrites(data: Uint8Array) {
		if (!this.trackedWrites) {
			return;
		}

		// Handle negative relative write positions
		let pos = this.getPos();
		if (pos < this.trackedStart) {
			if (pos + data.byteLength <= this.trackedStart) {
				return;
			}

			data = data.subarray(this.trackedStart - pos);
			pos = 0;
		}

		const neededSize = pos + data.byteLength - this.trackedStart;
		let newLength = this.trackedWrites.byteLength;
		while (newLength < neededSize) {
			newLength *= 2;
		}

		// Check if we need to resize the buffer
		if (newLength !== this.trackedWrites.byteLength) {
			const copy = new Uint8Array(newLength);
			copy.set(this.trackedWrites, 0);
			this.trackedWrites = copy;
		}

		this.trackedWrites.set(data, pos - this.trackedStart);
		this.trackedEnd = Math.max(this.trackedEnd, pos + data.byteLength);
	}

	startTrackingWrites() {
		this.trackedWrites = new Uint8Array(2 ** 10);
		this.trackedStart = this.getPos();
		this.trackedEnd = this.trackedStart;
	}

	stopTrackingWrites() {
		if (!this.trackedWrites) {
			throw new Error('Internal error: Can\'t get tracked writes since nothing was tracked.');
		}

		const slice = this.trackedWrites.subarray(0, this.trackedEnd - this.trackedStart);
		const result = {
			data: slice,
			start: this.trackedStart,
			end: this.trackedEnd,
		};

		this.trackedWrites = null;

		return result;
	}
}

const ARRAY_BUFFER_INITIAL_SIZE = 2 ** 16;
const ARRAY_BUFFER_MAX_SIZE = 2 ** 32;

export class BufferTargetWriter extends Writer {
	private pos = 0;
	private target: BufferTarget;
	private buffer: ArrayBuffer;
	private bytes: Uint8Array;
	private maxPos = 0;
	private supportsResize: boolean;

	constructor(target: BufferTarget) {
		super();

		this.target = target;

		this.supportsResize = 'resize' in new ArrayBuffer(0);
		if (this.supportsResize) {
			try {
				// @ts-expect-error Don't want to bump "lib" in tsconfig
				this.buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE, { maxByteLength: ARRAY_BUFFER_MAX_SIZE });
			} catch {
				this.buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE);
				this.supportsResize = false;
			}
		} else {
			this.buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE);
		}

		this.bytes = new Uint8Array(this.buffer);
	}

	private ensureSize(size: number) {
		let newLength = this.buffer.byteLength;
		while (newLength < size) newLength *= 2;

		if (newLength === this.buffer.byteLength) return;

		if (newLength > ARRAY_BUFFER_MAX_SIZE) {
			throw new Error(
				`ArrayBuffer exceeded maximum size of ${ARRAY_BUFFER_MAX_SIZE} bytes. Please consider using another`
				+ ` target.`,
			);
		}

		if (this.supportsResize) {
			// Use resize if it exists
			// @ts-expect-error Don't want to bump "lib" in tsconfig
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			this.buffer.resize(newLength);
			// The Uint8Array scales automatically
		} else {
			const newBuffer = new ArrayBuffer(newLength);
			const newBytes = new Uint8Array(newBuffer);
			newBytes.set(this.bytes, 0);

			this.buffer = newBuffer;
			this.bytes = newBytes;
		}
	}

	write(data: Uint8Array) {
		this.maybeTrackWrites(data);

		this.ensureSize(this.pos + data.byteLength);

		this.bytes.set(data, this.pos);
		this.target.onwrite?.(this.pos, this.pos + data.byteLength);

		this.pos += data.byteLength;
		this.maxPos = Math.max(this.maxPos, this.pos);
	}

	seek(newPos: number) {
		this.pos = newPos;
	}

	getPos() {
		return this.pos;
	}

	async flush() {}

	async finalize() {
		this.ensureSize(this.pos);
		this.target.buffer = this.buffer.slice(0, Math.max(this.maxPos, this.pos));
	}

	async close() {}

	getSlice(start: number, end: number) {
		return this.bytes.slice(start, end);
	}
}

const DEFAULT_CHUNK_SIZE = 2 ** 24;
const MAX_CHUNKS_AT_ONCE = 2;

interface Chunk {
	start: number;
	written: ChunkSection[];
	data: Uint8Array<ArrayBuffer>;
	shouldFlush: boolean;
}

interface ChunkSection {
	start: number;
	end: number;
}

/**
 * Writes to a StreamTarget every time it is flushed, sending out all of the new data written since the
 * last flush. This is useful for streaming applications, like piping the output to disk. When using the chunked mode,
 * data will first be accumulated in larger chunks, and then the entire chunk will be flushed out at once when ready.
 */
export class StreamTargetWriter extends Writer {
	private pos = 0;
	private target: StreamTarget;
	private sections: {
		data: Uint8Array;
		start: number;
	}[] = [];

	private lastWriteEnd = 0;
	private lastFlushEnd = 0;
	private writer: WritableStreamDefaultWriter<StreamTargetChunk> | null = null;

	// These variables regard chunked mode:
	private chunked: boolean;
	private chunkSize: number;
	/**
	 * The data is divided up into fixed-size chunks, whose contents are first filled in RAM and then flushed out.
	 * A chunk is flushed if all of its contents have been written.
	 */
	private chunks: Chunk[] = [];

	constructor(target: StreamTarget) {
		super();

		this.target = target;

		this.chunked = target._options.chunked ?? false;
		this.chunkSize = target._options.chunkSize ?? DEFAULT_CHUNK_SIZE;
	}

	override start() {
		this.writer = this.target._writable.getWriter();
	}

	write(data: Uint8Array) {
		if (this.pos > this.lastWriteEnd) {
			const paddingBytesNeeded = this.pos - this.lastWriteEnd;
			this.pos = this.lastWriteEnd;
			this.write(new Uint8Array(paddingBytesNeeded));
		}

		this.maybeTrackWrites(data);

		this.sections.push({
			data: data.slice(),
			start: this.pos,
		});
		this.target.onwrite?.(this.pos, this.pos + data.byteLength);

		this.pos += data.byteLength;

		this.lastWriteEnd = Math.max(this.lastWriteEnd, this.pos);
	}

	seek(newPos: number) {
		this.pos = newPos;
	}

	getPos() {
		return this.pos;
	}

	async flush() {
		if (this.pos > this.lastWriteEnd) {
			// There's a "void" between the last written byte and the next byte we're about to write. Let's pad that
			// void with zeroes explicitly.
			const paddingBytesNeeded = this.pos - this.lastWriteEnd;
			this.pos = this.lastWriteEnd;
			this.write(new Uint8Array(paddingBytesNeeded));
		}

		assert(this.writer);
		if (this.sections.length === 0) return;

		const chunks: {
			start: number;
			size: number;
			data?: Uint8Array<ArrayBuffer>;
		}[] = [];
		const sorted = [...this.sections].sort((a, b) => a.start - b.start);

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
			for (const section of this.sections) {
				// Check if the section is in the chunk
				if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
					chunk.data.set(section.data, section.start - chunk.start);
				}
			}

			if (this.writer.desiredSize !== null && this.writer.desiredSize <= 0) {
				await this.writer.ready; // Allow the writer to apply backpressure
			}

			if (this.chunked) {
				// Let's first gather the data into bigger chunks before writing it
				this.writeDataIntoChunks(chunk.data, chunk.start);
				this.tryToFlushChunks();
			} else {
				if (this.ensureMonotonicity && chunk.start !== this.lastFlushEnd) {
					throw new Error('Internal error: Monotonicity violation.');
				}

				// Write out the data immediately
				void this.writer.write({
					type: 'write',
					data: chunk.data,
					position: chunk.start,
				});

				this.lastFlushEnd = chunk.start + chunk.data.byteLength;
			}
		}

		this.sections.length = 0;
	}

	private writeDataIntoChunks(data: Uint8Array, position: number) {
		// First, find the chunk to write the data into, or create one if none exists
		let chunkIndex = this.chunks.findIndex(x => x.start <= position && position < x.start + this.chunkSize);
		if (chunkIndex === -1) chunkIndex = this.createChunk(position);
		const chunk = this.chunks[chunkIndex]!;

		// Figure out how much to write to the chunk, and then write to the chunk
		const relativePosition = position - chunk.start;
		const toWrite = data.subarray(0, Math.min(this.chunkSize - relativePosition, data.byteLength));
		chunk.data.set(toWrite, relativePosition);

		// Create a section describing the region of data that was just written to
		const section: ChunkSection = {
			start: relativePosition,
			end: relativePosition + toWrite.byteLength,
		};
		this.insertSectionIntoChunk(chunk, section);

		// Queue chunk for flushing to target if it has been fully written to
		if (chunk.written[0]!.start === 0 && chunk.written[0]!.end === this.chunkSize) {
			chunk.shouldFlush = true;
		}

		// Make sure we don't hold too many chunks in memory at once to keep memory usage down
		if (this.chunks.length > MAX_CHUNKS_AT_ONCE) {
			// Flush all but the last chunk
			for (let i = 0; i < this.chunks.length - 1; i++) {
				this.chunks[i]!.shouldFlush = true;
			}
			this.tryToFlushChunks();
		}

		// If the data didn't fit in one chunk, recurse with the remaining data
		if (toWrite.byteLength < data.byteLength) {
			this.writeDataIntoChunks(data.subarray(toWrite.byteLength), position + toWrite.byteLength);
		}
	}

	private insertSectionIntoChunk(chunk: Chunk, section: ChunkSection) {
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

	private createChunk(includesPosition: number) {
		const start = Math.floor(includesPosition / this.chunkSize) * this.chunkSize;
		const chunk: Chunk = {
			start,
			data: new Uint8Array(this.chunkSize),
			written: [],
			shouldFlush: false,
		};
		this.chunks.push(chunk);
		this.chunks.sort((a, b) => a.start - b.start);

		return this.chunks.indexOf(chunk);
	}

	private tryToFlushChunks(force = false) {
		assert(this.writer);

		for (let i = 0; i < this.chunks.length; i++) {
			const chunk = this.chunks[i]!;
			if (!chunk.shouldFlush && !force) continue;

			for (const section of chunk.written) {
				const position = chunk.start + section.start;
				if (this.ensureMonotonicity && position !== this.lastFlushEnd) {
					throw new Error('Internal error: Monotonicity violation.');
				}

				void this.writer.write({
					type: 'write',
					data: chunk.data.subarray(section.start, section.end),
					position,
				});

				this.lastFlushEnd = chunk.start + section.end;
			}

			this.chunks.splice(i--, 1);
		}
	}

	finalize() {
		if (this.chunked) {
			this.tryToFlushChunks(true);
		}

		assert(this.writer);
		return this.writer.close();
	}

	async close() {
		return this.writer?.close();
	}
}

export class NullTargetWriter extends Writer {
	private pos = 0;

	constructor(private target: NullTarget) {
		super();
	}

	write(data: Uint8Array) {
		this.maybeTrackWrites(data);
		this.target.onwrite?.(this.pos, this.pos + data.byteLength);
		this.pos += data.byteLength;
	}

	getPos() {
		return this.pos;
	}

	seek(newPos: number) {
		this.pos = newPos;
	}

	async flush() {}
	async finalize() {}
	async close() {}
}
