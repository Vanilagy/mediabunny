/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FileHandle } from 'node:fs/promises';
import {
	assert,
	binarySearchLessOrEqual,
	closedIntervalsOverlap,
	isNumber,
	isWebKit,
	MaybePromise,
	mergeRequestInit,
	promiseWithResolvers,
	retriedFetch,
	toDataView,
	toUint8Array,
} from './misc';
import * as nodeAlias from './node';
import { InputDisposedError } from './input';

const node = typeof nodeAlias !== 'undefined'
	? nodeAlias // Aliasing it prevents some bundler warnings
	: undefined!;

export type ReadResult = {
	bytes: Uint8Array;
	view: DataView;
	/** The offset of the bytes in the file. */
	offset: number;
};

/**
 * The source base class, representing a resource from which bytes can be read.
 * @group Input sources
 * @public
 */
export abstract class Source {
	/** @internal */
	abstract _retrieveSize(): MaybePromise<number | null>;
	/** @internal */
	abstract _read(start: number, end: number): MaybePromise<ReadResult | null>;
	/** @internal */
	abstract _dispose(): void;
	/** @internal */
	_disposed = false;

	/** @internal */
	private _sizePromise: Promise<number | null> | null = null;

	/**
	 * Resolves with the total size of the file in bytes. This function is memoized, meaning only the first call
	 * will retrieve the size.
	 *
	 * Returns null if the source is unsized.
	 */
	async getSizeOrNull() {
		if (this._disposed) {
			throw new InputDisposedError();
		}

		return this._sizePromise ??= Promise.resolve(this._retrieveSize());
	}

	/**
	 * Resolves with the total size of the file in bytes. This function is memoized, meaning only the first call
	 * will retrieve the size.
	 *
	 * Throws an error if the source is unsized.
	 */
	async getSize() {
		if (this._disposed) {
			throw new InputDisposedError();
		}

		const result = await this.getSizeOrNull();
		if (result === null) {
			throw new Error('Cannot determine the size of an unsized source.');
		}

		return result;
	}

	/** Called each time data is retrieved from the source. Will be called with the retrieved range (end exclusive). */
	onread: ((start: number, end: number) => unknown) | null = null;
}

/**
 * A source backed by an ArrayBuffer or ArrayBufferView, with the entire file held in memory.
 * @group Input sources
 * @public
 */
export class BufferSource extends Source {
	/** @internal */
	_bytes: Uint8Array;
	/** @internal */
	_view: DataView;
	/** @internal */
	_onreadCalled = false;

	/**
	 * Creates a new {@link BufferSource} backed by the specified `ArrayBuffer`, `SharedArrayBuffer`,
	 * or `ArrayBufferView`.
	 */
	constructor(buffer: AllowSharedBufferSource) {
		if (
			!(buffer instanceof ArrayBuffer)
			&& !(typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer)
			&& !ArrayBuffer.isView(buffer)
		) {
			throw new TypeError('buffer must be an ArrayBuffer, SharedArrayBuffer, or ArrayBufferView.');
		}

		super();

		this._bytes = toUint8Array(buffer);
		this._view = toDataView(buffer);
	}

	/** @internal */
	_retrieveSize(): number {
		return this._bytes.byteLength;
	}

	/** @internal */
	_read(): ReadResult {
		if (!this._onreadCalled) {
			// We just say the first read retrives all bytes from the source (which, I mean, it does)
			this.onread?.(0, this._bytes.byteLength);
			this._onreadCalled = true;
		}

		return {
			bytes: this._bytes,
			view: this._view,
			offset: 0,
		};
	}

	/** @internal */
	_dispose() {}
}

/**
 * Options for {@link BlobSource}.
 * @group Input sources
 * @public
 */
export type BlobSourceOptions = {
	/** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
	maxCacheSize?: number;
};

/**
 * A source backed by a [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob). Since a
 * [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) is also a `Blob`, this is the source to use when
 * reading files off the disk.
 * @group Input sources
 * @public
 */
export class BlobSource extends Source {
	/** @internal */
	_blob: Blob;
	/** @internal */
	_orchestrator: ReadOrchestrator;

	/**
	 * Creates a new {@link BlobSource} backed by the specified
	 * [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob).
	 */
	constructor(blob: Blob, options: BlobSourceOptions = {}) {
		if (!(blob instanceof Blob)) {
			throw new TypeError('blob must be a Blob.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.maxCacheSize !== undefined
			&& (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)
		) {
			throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
		}

		super();

		this._blob = blob;
		this._orchestrator = new ReadOrchestrator({
			maxCacheSize: options.maxCacheSize ?? (8 * 2 ** 20 /* 8 MiB */),
			maxWorkerCount: 4,
			runWorker: this._runWorker.bind(this),
			prefetchProfile: PREFETCH_PROFILES.fileSystem,
		});
	}

	/** @internal */
	_retrieveSize(): number {
		const size = this._blob.size;
		this._orchestrator.fileSize = size;

		return size;
	}

	/** @internal */
	_read(start: number, end: number): MaybePromise<ReadResult> {
		return this._orchestrator.read(start, end);
	}

	/** @internal */
	_readers = new WeakMap<ReadWorker, ReadableStreamDefaultReader<Uint8Array> | null>();

	/** @internal */
	private async _runWorker(worker: ReadWorker) {
		let reader = this._readers.get(worker);
		if (reader === undefined) {
			// https://github.com/Vanilagy/mediabunny/issues/184
			// WebKit has critical bugs with blob.stream():
			// - WebKitBlobResource error 1 when streaming large files
			// - Memory buildup and reload loops on iOS (network process crashes)
			// - ReadableStream stalls under backpressure (especially video)
			// Affects Safari and all iOS browsers (Chrome, Firefox, etc.).
			// Use arrayBuffer() fallback for WebKit browsers.
			if ('stream' in this._blob && !isWebKit()) {
				// Get a reader of the blob starting at the required offset, and then keep it around
				const slice = this._blob.slice(worker.currentPos);
				reader = slice.stream().getReader();
			} else {
				// We'll need to use more primitive ways
				reader = null;
			}

			this._readers.set(worker, reader);
		}

		while (worker.currentPos < worker.targetPos && !worker.aborted) {
			if (reader) {
				const { done, value } = await reader.read();
				if (done) {
					this._orchestrator.forgetWorker(worker);
					throw new Error('Blob reader stopped unexpectedly before all requested data was read.');
				}

				if (worker.aborted) {
					break;
				}

				this.onread?.(worker.currentPos, worker.currentPos + value.length);
				this._orchestrator.supplyWorkerData(worker, value);
			} else {
				const data = await this._blob.slice(worker.currentPos, worker.targetPos).arrayBuffer();

				if (worker.aborted) {
					break;
				}

				this.onread?.(worker.currentPos, worker.currentPos + data.byteLength);
				this._orchestrator.supplyWorkerData(worker, new Uint8Array(data));
			}
		}

		worker.running = false;

		if (worker.aborted) {
			// MDN: "Calling this method signals a loss of interest in the stream by a consumer."
			await reader?.cancel();
		}
	}

	/** @internal */
	_dispose() {
		this._orchestrator.dispose();
	}
}

const URL_SOURCE_MIN_LOAD_AMOUNT = 0.5 * 2 ** 20; // 0.5 MiB
const DEFAULT_RETRY_DELAY
	= ((previousAttempts, error, src) => {
		// Check if this could be a CORS error. If so, we cannot recover from it and
		// should not attempt to retry.
		// CORS errors are intentionally not opaque, so we need to rely on heuristics.
		const couldBeCorsError = error instanceof Error && (
			error.message.includes('Failed to fetch') // Chrome
			|| error.message.includes('Load failed') // Safari
			|| error.message.includes('NetworkError when attempting to fetch resource') // Firefox
		);

		if (couldBeCorsError) {
			let originOfSrc: string | null = null;
			// Checking if the origin is different, because only then a CORS error could originate
			try {
				if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
					originOfSrc = new URL(src instanceof Request ? src.url : src, window.location.href).origin;
				}
			} catch {
				// URL parse failed
			}

			// If user is offline, it is probably not a CORS error.
			const isOnline
			= typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;

			if (isOnline && originOfSrc !== null && originOfSrc !== window.location.origin) {
				console.warn(
					`Request will not be retried because a CORS error was suspected due to different origins. You can`
					+ ` modify this behavior by providing your own function for the 'getRetryDelay' option.`,
				);
				return null;
			}
		}

		return Math.min(2 ** (previousAttempts - 2), 16);
	}) satisfies UrlSourceOptions['getRetryDelay'];

/**
 * Options for {@link UrlSource}.
 * @group Input sources
 * @public
 */
export type UrlSourceOptions = {
	/**
	 * The [`RequestInit`](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit) used by the Fetch API. Can be
	 * used to further control the requests, such as setting custom headers.
	 *
	 * All fields will work except for `signal` and `headers.Range`; these will be overridden by Mediabunny. If you want
	 * to cancel ongoing requests, use {@link Input.dispose}.
	 */
	requestInit?: RequestInit;

	/**
	 * A function that returns the delay (in seconds) before retrying a failed request. The function is called
	 * with the number of previous, unsuccessful attempts, as well as with the error with which the previous request
	 * failed. If the function returns `null`, no more retries will be made.
	 *
	 * By default, it uses an exponential backoff algorithm that never gives up unless
	 * a CORS error is suspected (`fetch()` did reject, `navigator.onLine` is true and origin is different)
	 */
	getRetryDelay?: (previousAttempts: number, error: unknown, url: string | URL | Request) => number | null;

	/** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 64 MiB. */
	maxCacheSize?: number;

	/** The maximum number of parallel requests to use for fetching. Defaults to 2. */
	parallelism?: number;

	/**
	 * A WHATWG-compatible fetch function. You can use this field to polyfill the `fetch` function, add missing
	 * features, or use a custom implementation.
	 */
	fetchFn?: typeof fetch;
};

/**
 * A source backed by a URL. This is useful for reading data from the network. Requests will be made using an optimized
 * reading and prefetching pattern to minimize request count and latency.
 * @group Input sources
 * @public
 */
export class UrlSource extends Source {
	/** @internal */
	_url: string | URL | Request;
	/** @internal */
	_getRetryDelay: (previousAttempts: number, error: unknown, url: string | URL | Request) => number | null;
	/** @internal */
	_options: UrlSourceOptions;
	/** @internal */
	_orchestrator: ReadOrchestrator;
	/** @internal */
	_existingResponses = new WeakMap<ReadWorker, {
		response: Response;
		abortController: AbortController;
	}>();

	/**
	 * Creates a new {@link UrlSource} backed by the resource at the specified URL.
	 *
	 * When passing a `Request` instance, note that the `signal` and `headers.Range` options will be overridden by
	 * Mediabunny. If you want to cancel ongoing requests, use {@link Input.dispose}.
	 */
	constructor(
		url: string | URL | Request,
		options: UrlSourceOptions = {},
	) {
		if (
			typeof url !== 'string'
			&& !(url instanceof URL)
			&& !(typeof Request !== 'undefined' && url instanceof Request)
		) {
			throw new TypeError('url must be a string, URL or Request.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.requestInit !== undefined && (!options.requestInit || typeof options.requestInit !== 'object')) {
			throw new TypeError('options.requestInit, when provided, must be an object.');
		}
		if (options.getRetryDelay !== undefined && typeof options.getRetryDelay !== 'function') {
			throw new TypeError('options.getRetryDelay, when provided, must be a function.');
		}
		if (
			options.maxCacheSize !== undefined
			&& (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)
		) {
			throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
		}
		if (options.parallelism !== undefined && (!Number.isInteger(options.parallelism) || options.parallelism < 1)) {
			throw new TypeError('options.parallelism, when provided, must be a positive number.');
		}
		if (options.fetchFn !== undefined && typeof options.fetchFn !== 'function') {
			throw new TypeError('options.fetchFn, when provided, must be a function.');
			// Won't bother validating this function beyond this
		}

		super();

		this._url = url;
		this._options = options;
		this._getRetryDelay = options.getRetryDelay ?? DEFAULT_RETRY_DELAY;

		// Most files in the real-world have a single sequential access pattern, but having two in parallel can
		// also happen
		const DEFAULT_PARALLELISM = 2;

		this._orchestrator = new ReadOrchestrator({
			maxCacheSize: options.maxCacheSize ?? (64 * 2 ** 20 /* 64 MiB */),
			maxWorkerCount: options.parallelism ?? DEFAULT_PARALLELISM,
			runWorker: this._runWorker.bind(this),
			prefetchProfile: PREFETCH_PROFILES.network,
		});
	}

	/** @internal */
	async _retrieveSize(): Promise<number> {
		// Retrieving the resource size for UrlSource is optimized: Almost always (= always), the first bytes we have to
		// read are the start of the file. This means it's smart to combine size fetching with fetching the start of the
		// file. We additionally use this step to probe if the server supports range requests, killing three birds with
		// one stone.

		const abortController = new AbortController();
		const response = await retriedFetch(
			this._options.fetchFn ?? fetch,
			this._url,
			mergeRequestInit(this._options.requestInit ?? {}, {
				headers: {
					// We could also send a non-range request to request the same bytes (all of them), but doing it like
					// this is an easy way to check if the server supports range requests in the first place
					Range: 'bytes=0-',
				},
				signal: abortController.signal,
			}),
			this._getRetryDelay,
			() => this._disposed,
		);

		if (!response.ok) {
			// eslint-disable-next-line @typescript-eslint/no-base-to-string
			throw new Error(`Error fetching ${String(this._url)}: ${response.status} ${response.statusText}`);
		}

		let worker: ReadWorker;
		let fileSize: number;

		if (response.status === 206) {
			fileSize = this._getTotalLengthFromRangeResponse(response);
			worker = this._orchestrator.createWorker(0, Math.min(fileSize, URL_SOURCE_MIN_LOAD_AMOUNT));
		} else {
			// Server probably returned a 200.

			const contentLength = response.headers.get('Content-Length');
			if (contentLength) {
				fileSize = Number(contentLength);
				worker = this._orchestrator.createWorker(0, fileSize);
				this._orchestrator.options.maxCacheSize = Infinity; // 🤷

				console.warn(
					'HTTP server did not respond with 206 Partial Content, meaning the entire remote resource now has'
					+ ' to be downloaded. For efficient media file streaming across a network, please make sure your'
					+ ' server supports range requests.',
				);
			} else {
				throw new Error(`HTTP response (status ${response.status}) must surface Content-Length header.`);
			}
		}

		this._orchestrator.fileSize = fileSize;

		this._existingResponses.set(worker, { response, abortController });
		this._orchestrator.runWorker(worker);

		return fileSize;
	}

	/** @internal */
	_read(start: number, end: number): MaybePromise<ReadResult> {
		return this._orchestrator.read(start, end);
	}

	/** @internal */
	private async _runWorker(worker: ReadWorker) {
		// The outer loop is for resuming a request if it dies mid-response
		while (true) {
			const existing = this._existingResponses.get(worker);
			this._existingResponses.delete(worker);

			let abortController = existing?.abortController;
			let response = existing?.response;

			if (!abortController) {
				abortController = new AbortController();
				response = await retriedFetch(
					this._options.fetchFn ?? fetch,
					this._url,
					mergeRequestInit(this._options.requestInit ?? {}, {
						headers: {
							Range: `bytes=${worker.currentPos}-`,
						},
						signal: abortController.signal,
					}),
					this._getRetryDelay,
					() => this._disposed,
				);
			}

			assert(response);

			if (!response.ok) {
				// eslint-disable-next-line @typescript-eslint/no-base-to-string
				throw new Error(`Error fetching ${String(this._url)}: ${response.status} ${response.statusText}`);
			}

			if (worker.currentPos > 0 && response.status !== 206) {
				throw new Error(
					'HTTP server did not respond with 206 Partial Content to a range request. To enable efficient media'
					+ ' file streaming across a network, please make sure your server supports range requests.',
				);
			}

			if (!response.body) {
				throw new Error(
					'Missing HTTP response body stream. The used fetch function must provide the response body as a'
					+ ' ReadableStream.',
				);
			}

			const reader = response.body.getReader();

			while (true) {
				if (worker.currentPos >= worker.targetPos || worker.aborted) {
					abortController.abort();
					worker.running = false;

					return;
				}

				let readResult: ReadableStreamReadResult<Uint8Array>;

				try {
					readResult = await reader.read();
				} catch (error) {
					if (this._disposed) {
						// No need to try to retry
						throw error;
					}

					const retryDelayInSeconds = this._getRetryDelay(1, error, this._url);
					if (retryDelayInSeconds !== null) {
						console.error('Error while reading response stream. Attempting to resume.', error);
						await new Promise(resolve => setTimeout(resolve, 1000 * retryDelayInSeconds));

						break;
					} else {
						throw error;
					}
				}

				if (worker.aborted) {
					continue; // Cleanup happens in next iteration
				}

				const { done, value } = readResult;

				if (done) {
					if (worker.currentPos >= worker.targetPos) {
						// All data was delivered, we're good
						this._orchestrator.forgetWorker(worker);
						worker.running = false;
						return;
					}

					// The response stopped early, before the target. This can happen if server decides to cap range
					// requests arbitrarily, even if the request had an uncapped end. In this case, let's fetch the rest
					// of the data using a new request.
					break;
				}

				this.onread?.(worker.currentPos, worker.currentPos + value.length);
				this._orchestrator.supplyWorkerData(worker, value);
			}
		}

		// The previous UrlSource had logic for circumventing https://issues.chromium.org/issues/436025873; I haven't
		// been able to observe this bug with the new UrlSource (maybe because we're using response streaming), so the
		// logic for that has vanished for now. Leaving a comment here if this becomes relevant again.
	}

	/** @internal */
	private _getTotalLengthFromRangeResponse(response: Response) {
		const contentRange = response.headers.get('Content-Range');
		if (contentRange) {
			const match = /\/(\d+)/.exec(contentRange);
			if (match) {
				return Number(match[1]);
			}
		}

		const contentLength = response.headers.get('Content-Length');
		if (contentLength) {
			return Number(contentLength);
		} else {
			throw new Error(
				'Partial HTTP response (status 206) must surface either Content-Range or'
				+ ' Content-Length header.',
			);
		}
	}

	/** @internal */
	_dispose() {
		this._orchestrator.dispose();
	}
}

/**
 * Options for {@link FilePathSource}.
 * @group Input sources
 * @public
 */
export type FilePathSourceOptions = {
	/** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
	maxCacheSize?: number;
};

/**
 * A source backed by a path to a file. Intended for server-side usage in Node, Bun, or Deno.
 *
 * Make sure to call `.dispose()` on the corresponding {@link Input} when done to explicitly free the internal file
 * handle acquired by this source.
 * @group Input sources
 * @public
 */
export class FilePathSource extends Source {
	/** @internal */
	_streamSource: StreamSource;
	/** @internal */
	_fileHandle: FileHandle | null = null;

	/** Creates a new {@link FilePathSource} backed by the file at the specified file path. */
	constructor(filePath: string, options: FilePathSourceOptions = {}) {
		if (typeof filePath !== 'string') {
			throw new TypeError('filePath must be a string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.maxCacheSize !== undefined
			&& (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)
		) {
			throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
		}

		super();

		// Let's back this source with a StreamSource, makes the implementation very simple
		this._streamSource = new StreamSource({
			getSize: async () => {
				this._fileHandle = await node.fs.open(filePath, 'r');

				const stats = await this._fileHandle.stat();
				return stats.size;
			},
			read: async (start, end) => {
				assert(this._fileHandle);

				const buffer = new Uint8Array(end - start);
				await this._fileHandle.read(buffer, 0, end - start, start);

				return buffer;
			},
			maxCacheSize: options.maxCacheSize,
			prefetchProfile: 'fileSystem',
		});
	}

	/** @internal */
	_read(start: number, end: number): MaybePromise<ReadResult> {
		return this._streamSource._read(start, end);
	}

	/** @internal */
	_retrieveSize(): MaybePromise<number> {
		return this._streamSource._retrieveSize();
	}

	/** @internal */
	_dispose() {
		this._streamSource._dispose();
		void this._fileHandle?.close();
		this._fileHandle = null;
	}
}

/**
 * Options for defining a {@link StreamSource}.
 * @group Input sources
 * @public
 */
export type StreamSourceOptions = {
	/**
	 * Called when the size of the entire file is requested. Must return or resolve to the size in bytes. This function
	 * is guaranteed to be called before `read`.
	 */
	getSize: () => MaybePromise<number>;

	/**
	 * Called when data is requested. Must return or resolve to the bytes from the specified byte range, or a stream
	 * that yields these bytes.
	 */
	read: (start: number, end: number) => MaybePromise<Uint8Array | ReadableStream<Uint8Array>>;

	/**
	 * Called when the {@link Input} driven by this source is disposed.
	 */
	dispose?: () => unknown;

	/** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
	maxCacheSize?: number;

	/**
	 * Specifies the prefetch profile that the reader should use with this source. A prefetch profile specifies the
	 * pattern with which bytes outside of the requested range are preloaded to reduce latency for future reads.
	 *
	 * - `'none'` (default): No prefetching; only the data needed in the moment is requested.
	 * - `'fileSystem'`: File system-optimized prefetching: a small amount of data is prefetched bidirectionally,
	 * aligned with page boundaries.
	 * - `'network'`: Network-optimized prefetching, or more generally, prefetching optimized for any high-latency
	 * environment: tries to minimize the amount of read calls and aggressively prefetches data when sequential access
	 * patterns are detected.
	 */
	prefetchProfile?: 'none' | 'fileSystem' | 'network';
};

/**
 * A general-purpose, callback-driven source that can get its data from anywhere.
 * @group Input sources
 * @public
 */
export class StreamSource extends Source {
	/** @internal */
	_options: StreamSourceOptions;
	/** @internal */
	_orchestrator: ReadOrchestrator;

	/** Creates a new {@link StreamSource} whose behavior is specified by `options`.  */
	constructor(options: StreamSourceOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (typeof options.getSize !== 'function') {
			throw new TypeError('options.getSize must be a function.');
		}
		if (typeof options.read !== 'function') {
			throw new TypeError('options.read must be a function.');
		}
		if (options.dispose !== undefined && typeof options.dispose !== 'function') {
			throw new TypeError('options.dispose, when provided, must be a function.');
		}
		if (
			options.maxCacheSize !== undefined
			&& (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)
		) {
			throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
		}
		if (options.prefetchProfile && !['none', 'fileSystem', 'network'].includes(options.prefetchProfile)) {
			throw new TypeError(
				'options.prefetchProfile, when provided, must be one of \'none\', \'fileSystem\' or \'network\'.',
			);
		}

		super();

		this._options = options;

		this._orchestrator = new ReadOrchestrator({
			maxCacheSize: options.maxCacheSize ?? (8 * 2 ** 20 /* 8 MiB */),
			maxWorkerCount: 2, // Fixed for now, *should* be fine
			prefetchProfile: PREFETCH_PROFILES[options.prefetchProfile ?? 'none'],
			runWorker: this._runWorker.bind(this),
		});
	}

	/** @internal */
	_retrieveSize(): MaybePromise<number> {
		const result = this._options.getSize();

		if (result instanceof Promise) {
			return result.then((size) => {
				if (!Number.isInteger(size) || size < 0) {
					throw new TypeError('options.getSize must return or resolve to a non-negative integer.');
				}

				this._orchestrator.fileSize = size;
				return size;
			});
		} else {
			if (!Number.isInteger(result) || result < 0) {
				throw new TypeError('options.getSize must return or resolve to a non-negative integer.');
			}

			this._orchestrator.fileSize = result;
			return result;
		}
	}

	/** @internal */
	_read(start: number, end: number): MaybePromise<ReadResult> {
		return this._orchestrator.read(start, end);
	}

	/** @internal */
	private async _runWorker(worker: ReadWorker) {
		while (worker.currentPos < worker.targetPos && !worker.aborted) {
			const originalCurrentPos = worker.currentPos;
			const originalTargetPos = worker.targetPos;

			let data = this._options.read(worker.currentPos, originalTargetPos);
			if (data instanceof Promise) data = await data;

			if (worker.aborted) {
				break;
			}

			if (data instanceof Uint8Array) {
				data = toUint8Array(data); // Normalize things like Node.js Buffer to Uint8Array

				if (data.length !== originalTargetPos - worker.currentPos) {
					// Yes, we're that strict
					throw new Error(
						`options.read returned a Uint8Array with unexpected length: Requested ${
							originalTargetPos - worker.currentPos
						} bytes, but got ${data.length}.`,
					);
				}

				this.onread?.(worker.currentPos, worker.currentPos + data.length);
				this._orchestrator.supplyWorkerData(worker, data);
			} else if (data instanceof ReadableStream) {
				const reader = data.getReader();

				while (worker.currentPos < originalTargetPos && !worker.aborted) {
					const { done, value } = await reader.read();
					if (done) {
						if (worker.currentPos < originalTargetPos) {
							// Yes, we're *that* strict
							throw new Error(
								`ReadableStream returned by options.read ended before supplying enough data.`
								+ ` Requested ${originalTargetPos - originalCurrentPos} bytes, but got ${
									worker.currentPos - originalCurrentPos
								}`,
							);
						}

						break;
					}

					if (!(value instanceof Uint8Array)) {
						throw new TypeError('ReadableStream returned by options.read must yield Uint8Array chunks.');
					}

					if (worker.aborted) {
						break;
					}

					const data = toUint8Array(value); // Normalize things like Node.js Buffer to Uint8Array

					this.onread?.(worker.currentPos, worker.currentPos + data.length);
					this._orchestrator.supplyWorkerData(worker, data);
				}
			} else {
				throw new TypeError('options.read must return or resolve to a Uint8Array or a ReadableStream.');
			}
		}

		worker.running = false;
	}

	/** @internal */
	_dispose() {
		this._orchestrator.dispose();
		this._options.dispose?.();
	}
}

type ReadableStreamSourcePendingSlice = {
	start: number;
	end: number;
	bytes: Uint8Array;
	resolve: (bytes: ReadResult | null) => void;
	reject: (error: unknown) => void;
};

/**
 * Options for {@link ReadableStreamSource}.
 * @group Input sources
 * @public
 */
export type ReadableStreamSourceOptions = {
	/** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 16 MiB. */
	maxCacheSize?: number;
};

/**
 * A source backed by a [`ReadableStream`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream) of
 * `Uint8Array`, representing an append-only byte stream of unknown length. This is the source to use for incrementally
 * streaming in input files that are still being constructed and whose size we don't yet know, like for example the
 * output chunks of [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder).
 *
 * This source is *unsized*, meaning calls to `.getSize()` will throw and readers are more limited due to the
 * lack of random file access. You should only use this source with sequential access patterns, such as reading all
 * packets from start to end. This source does not work well with random access patterns unless you increase its
 * max cache size.
 *
 * @group Input sources
 * @public
 */
export class ReadableStreamSource extends Source {
	/** @internal */
	_stream: ReadableStream<Uint8Array>;
	/** @internal */
	_reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	/** @internal */
	_cache: CacheEntry[] = [];
	/** @internal */
	_maxCacheSize: number;
	/** @internal */
	_pendingSlices: ReadableStreamSourcePendingSlice[] = [];
	/** @internal */
	_currentIndex = 0;
	/** @internal */
	_targetIndex = 0;
	/** @internal */
	_maxRequestedIndex = 0;
	/** @internal */
	_endIndex: number | null = null;
	/** @internal */
	_pulling = false;

	/** Creates a new {@link ReadableStreamSource} backed by the specified `ReadableStream<Uint8Array>`. */
	constructor(stream: ReadableStream<Uint8Array>, options: ReadableStreamSourceOptions = {}) {
		if (!(stream instanceof ReadableStream)) {
			throw new TypeError('stream must be a ReadableStream.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.maxCacheSize !== undefined
			&& (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)
		) {
			throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
		}

		super();

		this._stream = stream;
		this._maxCacheSize = options.maxCacheSize ?? (16 * 2 ** 20 /* 16 MiB */);
	}

	/** @internal */
	_retrieveSize() {
		return this._endIndex; // Starts out as null, meaning this source is unsized
	}

	/** @internal */
	_read(start: number, end: number): MaybePromise<ReadResult | null> {
		if (this._endIndex !== null && end > this._endIndex) {
			return null;
		}

		this._maxRequestedIndex = Math.max(this._maxRequestedIndex, end);

		const cacheStartIndex = binarySearchLessOrEqual(this._cache, start, x => x.start);
		const cacheStartEntry = cacheStartIndex !== -1 ? this._cache[cacheStartIndex]! : null;

		if (cacheStartEntry && cacheStartEntry.start <= start && end <= cacheStartEntry.end) {
			// The request can be satisfied with a single cache entry
			return {
				bytes: cacheStartEntry.bytes,
				view: cacheStartEntry.view,
				offset: cacheStartEntry.start,
			};
		}

		let lastEnd = start;
		const bytes = new Uint8Array(end - start);

		if (cacheStartIndex !== -1) {
			// Walk over the cache to see if we can satisfy the request using multiple cache entries
			for (let i = cacheStartIndex; i < this._cache.length; i++) {
				const cacheEntry = this._cache[i]!;
				if (cacheEntry.start >= end) {
					break;
				}

				const cappedStart = Math.max(start, cacheEntry.start);
				if (cappedStart > lastEnd) {
					// We're too far behind
					this._throwDueToCacheMiss();
				}

				const cappedEnd = Math.min(end, cacheEntry.end);

				if (cappedStart < cappedEnd) {
					bytes.set(
						cacheEntry.bytes.subarray(cappedStart - cacheEntry.start, cappedEnd - cacheEntry.start),
						cappedStart - start,
					);

					lastEnd = cappedEnd;
				}
			}
		}

		if (lastEnd === end) {
			return {
				bytes,
				view: toDataView(bytes),
				offset: start,
			};
		}

		// We need to pull more data

		if (this._currentIndex > lastEnd) {
			// We're too far behind
			this._throwDueToCacheMiss();
		}

		const { promise, resolve, reject } = promiseWithResolvers<ReadResult | null>();

		this._pendingSlices.push({
			start,
			end,
			bytes,
			resolve,
			reject,
		});

		this._targetIndex = Math.max(this._targetIndex, end);

		// Start pulling from the stream if we're not already doing it
		if (!this._pulling) {
			this._pulling = true;
			void this._pull()
				.catch((error) => {
					this._pulling = false;

					if (this._pendingSlices.length > 0) {
						this._pendingSlices.forEach(x => x.reject(error)); // Make sure to propagate any errors
						this._pendingSlices.length = 0;
					} else {
						throw error; // So it doesn't get swallowed
					}
				});
		}

		return promise;
	}

	/** @internal */
	_throwDueToCacheMiss() {
		throw new Error(
			'Read is before the cached region. With ReadableStreamSource, you must access the data more'
			+ ' sequentially or increase the size of its cache.',
		);
	}

	/** @internal */
	async _pull() {
		this._reader ??= this._stream.getReader();

		// This is the loop that keeps pulling data from the stream until a target index is reached, filling requests
		// in the process
		while (this._currentIndex < this._targetIndex && !this._disposed) {
			const { done, value } = await this._reader.read();
			if (done) {
				for (const pendingSlice of this._pendingSlices) {
					pendingSlice.resolve(null);
				}
				this._pendingSlices.length = 0;
				this._endIndex = this._currentIndex; // We know how long the file is now!

				break;
			}

			const startIndex = this._currentIndex;
			const endIndex = this._currentIndex + value.byteLength;

			// Fill the pending slices with the data
			for (let i = 0; i < this._pendingSlices.length; i++) {
				const pendingSlice = this._pendingSlices[i]!;

				const cappedStart = Math.max(startIndex, pendingSlice.start);
				const cappedEnd = Math.min(endIndex, pendingSlice.end);

				if (cappedStart < cappedEnd) {
					pendingSlice.bytes.set(
						value.subarray(cappedStart - startIndex, cappedEnd - startIndex),
						cappedStart - pendingSlice.start,
					);
					if (cappedEnd === pendingSlice.end) {
						// Pending slice fully filled
						pendingSlice.resolve({
							bytes: pendingSlice.bytes,
							view: toDataView(pendingSlice.bytes),
							offset: pendingSlice.start,
						});
						this._pendingSlices.splice(i, 1);
						i--;
					}
				}
			}

			this._cache.push({
				start: startIndex,
				end: endIndex,
				bytes: value,
				view: toDataView(value),
				age: 0, // Unused
			});

			// Do cache eviction, based on the distance from the last-requested index. It's important that we do it like
			// this and not based on where the reader is at, because if the reader is fast, we'll unnecessarily evict
			// data that we still might need.
			while (this._cache.length > 0) {
				const firstEntry = this._cache[0]!;
				const distance = this._maxRequestedIndex - firstEntry.end;

				if (distance <= this._maxCacheSize) {
					break;
				}

				this._cache.shift();
			}

			this._currentIndex += value.byteLength;
		}

		this._pulling = false;
	}

	/** @internal */
	_dispose() {
		this._pendingSlices.length = 0;
		this._cache.length = 0;
	}
}

type PrefetchProfile = (start: number, end: number, workers: ReadWorker[]) => {
	start: number;
	end: number;
};

const PREFETCH_PROFILES = {
	none: (start, end) => ({ start, end }),
	fileSystem: (start, end) => {
		const padding = 2 ** 16;

		start = Math.floor((start - padding) / padding) * padding;
		end = Math.ceil((end + padding) / padding) * padding;

		return { start, end };
	},
	network: (start, end, workers) => {
		// Add a slight bit of start padding because backwards reading is painful
		const paddingStart = 2 ** 16;
		start = Math.max(0, Math.floor((start - paddingStart) / paddingStart) * paddingStart);

		// Remote resources have extreme latency (relatively speaking), so the benefit from intelligent
		// prefetching is great. The network prefetch strategy is as follows: When we notice
		// successive reads to a worker's read region, we prefetch more data at the end of that region,
		// growing exponentially (up to a cap). This performs well for real-world use cases: Either we read a
		// small part of the file once and then never need it again, in which case the requested about of data
		// is small. Or, we're repeatedly doing a sequential access pattern (common in media files), in which
		// case we can become more and more confident to prefetch more and more data.
		for (const worker of workers) {
			const maxExtensionAmount = 8 * 2 ** 20; // 8 MiB

			// When the read region cross the threshold point, we trigger a prefetch. This point is typically
			// in the middle of the worker's read region, or a fixed offset from the end if the region has grown
			// really large.
			const thresholdPoint = Math.max(
				(worker.startPos + worker.targetPos) / 2,
				worker.targetPos - maxExtensionAmount,
			);

			if (closedIntervalsOverlap(
				start, end,
				thresholdPoint, worker.targetPos,
			)) {
				const size = worker.targetPos - worker.startPos;

				// If we extend by maxExtensionAmount
				const a = Math.ceil((size + 1) / maxExtensionAmount) * maxExtensionAmount;
				// If we extend to the next power of 2
				const b = 2 ** Math.ceil(Math.log2(size + 1));

				const extent = Math.min(b, a);
				end = Math.max(end, worker.startPos + extent);
			}
		}

		end = Math.max(end, start + URL_SOURCE_MIN_LOAD_AMOUNT);

		return {
			start,
			end,
		};
	},
} satisfies Record<string, PrefetchProfile>;

type PendingSlice = {
	start: number;
	bytes: Uint8Array;
	holes: {
		start: number;
		end: number;
	}[];
	resolve: (bytes: Uint8Array) => void;
	reject: (error: unknown) => void;
};

type CacheEntry = {
	start: number;
	end: number;
	bytes: Uint8Array;
	view: DataView;
	age: number;
};

type ReadWorker = {
	startPos: number;
	currentPos: number;
	targetPos: number;
	running: boolean;
	aborted: boolean;
	pendingSlices: PendingSlice[];
	age: number;
};

/**
 * Godclass for orchestrating complex, cached read operations. The reading model is as follows: Any reading task is
 * delegated to a *worker*, which is a sequential reader positioned somewhere along the file. All workers run in
 * parallel and can be stopped and resumed in their forward movement. When read requests come in, this orchestrator will
 * first try to satisfy the request with only the cached data. If this isn't possible, workers are spun up for all
 * missing parts (or existing workers are repurposed), and these workers will then fill the holes in the data as they
 * march along the file.
 */
class ReadOrchestrator {
	fileSize: number | null = null;
	nextAge = 0; // Used for LRU eviction of both cache entries and workers
	workers: ReadWorker[] = [];
	cache: CacheEntry[] = [];
	currentCacheSize = 0;
	disposed = false;

	constructor(public options: {
		maxCacheSize: number;
		runWorker: (worker: ReadWorker) => Promise<void>;
		prefetchProfile: PrefetchProfile;
		maxWorkerCount: number;
	}) {}

	read(innerStart: number, innerEnd: number): MaybePromise<ReadResult> {
		assert(this.fileSize !== null);

		const prefetchRange = this.options.prefetchProfile(innerStart, innerEnd, this.workers);
		const outerStart = Math.max(prefetchRange.start, 0);
		const outerEnd = Math.min(prefetchRange.end, this.fileSize);
		assert(outerStart <= innerStart && innerEnd <= outerEnd);

		let result: MaybePromise<{
			bytes: Uint8Array;
			view: DataView;
			offset: number;
		}> | null = null;

		const innerCacheStartIndex = binarySearchLessOrEqual(this.cache, innerStart, x => x.start);
		const innerStartEntry = innerCacheStartIndex !== -1 ? this.cache[innerCacheStartIndex] : null;

		// See if the read request can be satisfied by a single cache entry
		if (innerStartEntry && innerStartEntry.start <= innerStart && innerEnd <= innerStartEntry.end) {
			innerStartEntry.age = this.nextAge++;

			result = {
				bytes: innerStartEntry.bytes,
				view: innerStartEntry.view,
				offset: innerStartEntry.start,
			};
			// Can't return yet though, still need to check if the prefetch range might lie outside the cached area
		}

		const outerCacheStartIndex = binarySearchLessOrEqual(this.cache, outerStart, x => x.start);

		const bytes = result ? null : new Uint8Array(innerEnd - innerStart);
		let contiguousBytesWriteEnd = 0; // Used to track if the cache is able to completely cover the bytes

		let lastEnd = outerStart;
		// The "holes" in the cache (the parts we need to load)
		const outerHoles: {
			start: number;
			end: number;
		}[] = [];

		// Loop over the cache and build up the list of holes
		if (outerCacheStartIndex !== -1) {
			for (let i = outerCacheStartIndex; i < this.cache.length; i++) {
				const entry = this.cache[i]!;
				if (entry.start >= outerEnd) {
					break;
				}
				if (entry.end <= outerStart) {
					continue;
				}

				const cappedOuterStart = Math.max(outerStart, entry.start);
				const cappedOuterEnd = Math.min(outerEnd, entry.end);
				assert(cappedOuterStart <= cappedOuterEnd);

				if (lastEnd < cappedOuterStart) {
					outerHoles.push({ start: lastEnd, end: cappedOuterStart });
				}
				lastEnd = cappedOuterEnd;

				if (bytes) {
					const cappedInnerStart = Math.max(innerStart, entry.start);
					const cappedInnerEnd = Math.min(innerEnd, entry.end);

					if (cappedInnerStart < cappedInnerEnd) {
						const relativeOffset = cappedInnerStart - innerStart;

						// Fill the relevant section of the bytes with the cached data
						bytes.set(
							entry.bytes.subarray(cappedInnerStart - entry.start, cappedInnerEnd - entry.start),
							relativeOffset,
						);

						if (relativeOffset === contiguousBytesWriteEnd) {
							contiguousBytesWriteEnd = cappedInnerEnd - innerStart;
						}
					}
				}
				entry.age = this.nextAge++;
			}

			if (lastEnd < outerEnd) {
				outerHoles.push({ start: lastEnd, end: outerEnd });
			}
		} else {
			outerHoles.push({ start: outerStart, end: outerEnd });
		}

		if (bytes && contiguousBytesWriteEnd >= bytes.length) {
			// Multiple cache entries were able to completely cover the requested bytes!
			result = {
				bytes,
				view: toDataView(bytes),
				offset: innerStart,
			};
		}

		if (outerHoles.length === 0) {
			assert(result);
			return result;
		}

		// We need to read more data, so now we're in async land
		const { promise, resolve, reject } = promiseWithResolvers<Uint8Array>();

		const innerHoles: typeof outerHoles = [];
		for (const outerHole of outerHoles) {
			const cappedStart = Math.max(innerStart, outerHole.start);
			const cappedEnd = Math.min(innerEnd, outerHole.end);

			if (cappedStart === outerHole.start && cappedEnd === outerHole.end) {
				innerHoles.push(outerHole); // Can reuse without allocating a new object
			} else if (cappedStart < cappedEnd) {
				innerHoles.push({ start: cappedStart, end: cappedEnd });
			}
		}

		// Fire off workers to take care of patching the holes
		for (const outerHole of outerHoles) {
			const pendingSlice: PendingSlice | null = bytes && {
				start: innerStart,
				bytes,
				holes: innerHoles,
				resolve,
				reject,
			};

			let workerFound = false;
			for (const worker of this.workers) {
				// A small tolerance in the case that the requested region is *just* after the target position of an
				// existing worker. In that case, it's probably more efficient to repurpose that worker than to spawn
				// another one so close to it
				const gapTolerance = 2 ** 17;

				// This check also implies worker.currentPos <= outerHole.start, a critical condition
				if (closedIntervalsOverlap(
					outerHole.start - gapTolerance, outerHole.start,
					worker.currentPos, worker.targetPos,
				)) {
					worker.targetPos = Math.max(worker.targetPos, outerHole.end); // Update the worker's target position
					workerFound = true;

					if (pendingSlice && !worker.pendingSlices.includes(pendingSlice)) {
						worker.pendingSlices.push(pendingSlice);
					}

					if (!worker.running) {
						// Kick it off if it's idle
						this.runWorker(worker);
					}

					break;
				}
			}

			if (!workerFound) {
				// We need to spawn a new worker
				const newWorker = this.createWorker(outerHole.start, outerHole.end);
				if (pendingSlice) {
					newWorker.pendingSlices = [pendingSlice];
				}

				this.runWorker(newWorker);
			}
		}

		if (!result) {
			assert(bytes);
			result = promise.then(bytes => ({
				bytes,
				view: toDataView(bytes),
				offset: innerStart,
			}));
		} else {
			// The requested region was satisfied by the cache, but the entire prefetch region was not
		}

		return result;
	}

	createWorker(startPos: number, targetPos: number) {
		const worker: ReadWorker = {
			startPos,
			currentPos: startPos,
			targetPos,
			running: false,
			// Due to async shenanigans, it can happen that workers are started after disposal. In this case, instead of
			// simply not creating the worker, we allow it to run but immediately label it as aborted, so it can then
			// shut itself down.
			aborted: this.disposed,
			pendingSlices: [],
			age: this.nextAge++,
		};
		this.workers.push(worker);

		// LRU eviction of the other workers
		while (this.workers.length > this.options.maxWorkerCount) {
			let oldestIndex = 0;
			let oldestWorker = this.workers[0]!;

			for (let i = 1; i < this.workers.length; i++) {
				const worker = this.workers[i]!;

				if (worker.age < oldestWorker.age) {
					oldestIndex = i;
					oldestWorker = worker;
				}
			}

			if (oldestWorker.running && oldestWorker.pendingSlices.length > 0) {
				break;
			}

			oldestWorker.aborted = true;
			this.workers.splice(oldestIndex, 1);
		}

		return worker;
	}

	runWorker(worker: ReadWorker) {
		assert(!worker.running);
		assert(worker.currentPos < worker.targetPos);

		worker.running = true;
		worker.age = this.nextAge++;

		void this.options.runWorker(worker)
			.catch((error) => {
				worker.running = false;

				if (worker.pendingSlices.length > 0) {
					worker.pendingSlices.forEach(x => x.reject(error)); // Make sure to propagate any errors
					worker.pendingSlices.length = 0;
				} else {
					throw error; // So it doesn't get swallowed
				}
			});
	}

	/** Called by a worker when it has read some data. */
	supplyWorkerData(worker: ReadWorker, bytes: Uint8Array) {
		assert(!worker.aborted);

		const start = worker.currentPos;
		const end = start + bytes.length;

		this.insertIntoCache({
			start,
			end,
			bytes,
			view: toDataView(bytes),
			age: this.nextAge++,
		});
		worker.currentPos += bytes.length;
		worker.targetPos = Math.max(worker.targetPos, worker.currentPos); // In case it overshoots

		// Now, let's see if we can use the read bytes to fill any pending slice
		for (let i = 0; i < worker.pendingSlices.length; i++) {
			const pendingSlice = worker.pendingSlices[i]!;

			const clampedStart = Math.max(start, pendingSlice.start);
			const clampedEnd = Math.min(end, pendingSlice.start + pendingSlice.bytes.length);

			if (clampedStart < clampedEnd) {
				pendingSlice.bytes.set(
					bytes.subarray(clampedStart - start, clampedEnd - start),
					clampedStart - pendingSlice.start,
				);
			}

			for (let j = 0; j < pendingSlice.holes.length; j++) {
				// The hole is intentionally not modified here if the read section starts somewhere in the middle of
				// the hole. We don't need to do "hole splitting", since the workers are spawned *by* the holes,
				// meaning there's always a worker which will consume the hole left to right.
				const hole = pendingSlice.holes[j]!;
				if (start <= hole.start && end > hole.start) {
					hole.start = end;
				}

				if (hole.end <= hole.start) {
					pendingSlice.holes.splice(j, 1);
					j--;
				}
			}

			if (pendingSlice.holes.length === 0) {
				// The slice has been fulfilled, everything has been read. Let's resolve the promise
				pendingSlice.resolve(pendingSlice.bytes);
				worker.pendingSlices.splice(i, 1);
				i--;
			}
		}

		// Remove other idle workers if we "ate" into their territory
		for (let i = 0; i < this.workers.length; i++) {
			const otherWorker = this.workers[i]!;
			if (worker === otherWorker || otherWorker.running) {
				continue;
			}

			if (closedIntervalsOverlap(
				start, end,
				otherWorker.currentPos, otherWorker.targetPos, // These should typically be equal when the worker's idle
			)) {
				this.workers.splice(i, 1);
				i--;
			}
		}
	}

	forgetWorker(worker: ReadWorker) {
		const index = this.workers.indexOf(worker);
		assert(index !== -1);

		this.workers.splice(index, 1);
	}

	insertIntoCache(entry: CacheEntry) {
		if (this.options.maxCacheSize === 0) {
			return; // No caching
		}

		let insertionIndex = binarySearchLessOrEqual(this.cache, entry.start, x => x.start) + 1;

		if (insertionIndex > 0) {
			const previous = this.cache[insertionIndex - 1]!;
			if (previous.end >= entry.end) {
				// Previous entry swallows the one to be inserted; we don't need to do anything
				return;
			}

			if (previous.end > entry.start) {
				// Partial overlap with the previous entry, let's join
				const joined = new Uint8Array(entry.end - previous.start);
				joined.set(previous.bytes, 0);
				joined.set(entry.bytes, entry.start - previous.start);

				this.currentCacheSize += entry.end - previous.end;

				previous.bytes = joined;
				previous.view = toDataView(joined);
				previous.end = entry.end;

				// Do the rest of the logic with the previous entry instead
				insertionIndex--;
				entry = previous;
			} else {
				this.cache.splice(insertionIndex, 0, entry);
				this.currentCacheSize += entry.bytes.length;
			}
		} else {
			this.cache.splice(insertionIndex, 0, entry);
			this.currentCacheSize += entry.bytes.length;
		}

		for (let i = insertionIndex + 1; i < this.cache.length; i++) {
			const next = this.cache[i]!;
			if (entry.end <= next.start) {
				// Even if they touch, we don't wanna merge them, no need
				break;
			}

			if (entry.end >= next.end) {
				// The inserted entry completely swallows the next entry
				this.cache.splice(i, 1);
				this.currentCacheSize -= next.bytes.length;
				i--;
				continue;
			}

			// Partial overlap, let's join
			const joined = new Uint8Array(next.end - entry.start);
			joined.set(entry.bytes, 0);
			joined.set(next.bytes, next.start - entry.start);

			this.currentCacheSize -= entry.end - next.start; // Subtract the overlap

			entry.bytes = joined;
			entry.view = toDataView(joined);
			entry.end = next.end;
			this.cache.splice(i, 1);

			break; // After the join case, we're done: the next entry cannot possibly overlap with the inserted one.
		}

		// LRU eviction of cache entries
		while (this.currentCacheSize > this.options.maxCacheSize) {
			let oldestIndex = 0;
			let oldestEntry = this.cache[0]!;

			for (let i = 1; i < this.cache.length; i++) {
				const entry = this.cache[i]!;

				if (entry.age < oldestEntry.age) {
					oldestIndex = i;
					oldestEntry = entry;
				}
			}

			if (this.currentCacheSize - oldestEntry.bytes.length <= this.options.maxCacheSize) {
				// Don't evict if it would shrink the cache below the max size
				break;
			}

			this.cache.splice(oldestIndex, 1);
			this.currentCacheSize -= oldestEntry.bytes.length;
		}
	}

	dispose() {
		for (const worker of this.workers) {
			worker.aborted = true;
		}

		this.workers.length = 0;
		this.cache.length = 0;
		this.disposed = true;
	}
}
