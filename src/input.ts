/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer, DurationMetadataRequestOptions } from './demuxer';
import { InputFormat } from './input-format';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from './input-track';
import {
	InputAudioTrackDescriptor,
	InputTrackDescriptor,
	InputVideoTrackDescriptor,
	mergeTrackDescriptorQueries,
	queryTrackDescriptors,
	toValidatedTrackDescriptorQuery,
	TrackDescriptorQuery,
} from './input-track-descriptor';
import { PacketRetrievalOptions } from './media-sink';
import {
	arrayArgmin,
	arrayCount,
	assert,
	desc,
	EventEmitter,
	MaybePromise,
	polyfillSymbolDispose,
	prefer,
	removeItem,
} from './misc';
import { Reader } from './reader';
import {
	BlobSource,
	BlobSourceOptions,
	BufferSource,
	FilePathSource,
	FilePathSourceOptions,
	ReadableStreamSource,
	ReadableStreamSourceOptions,
	Source,
	SourceRef,
	UrlSource,
	UrlSourceOptions,
} from './source';

polyfillSymbolDispose();

export const DEFAULT_SOURCE_CACHE_GROUP = 1;
export const ENCRYPTION_KEY_CACHE_GROUP = 2;

export type SourceRequest = {
	path: string;
	isRoot: boolean;
};

const sourceRequestsAreEqual = (a: SourceRequest, b: SourceRequest) => {
	return a.path === b.path;
};

let inputFinalizationRegistry: FinalizationRegistry<SourceRef[]> | null = null;
if (typeof FinalizationRegistry !== 'undefined') {
	inputFinalizationRegistry = new FinalizationRegistry((refs) => {
		for (const ref of refs) {
			ref.free();
		}
	});
}

/**
 * The options for creating an Input object.
 * @group Input files & tracks
 * @public
 */
export type InputOptions<S extends Source = Source> = {
	/** A list of supported formats. If the source file is not of one of these formats, then it cannot be read. */
	formats: InputFormat[];
	/** The source from which data will be read. */
	source: S | SourceRef<S> | ((request: SourceRequest) => MaybePromise<S | SourceRef<S>>);
	entryPath?: string;
	initInput?: Input;
};

type SourceCacheEntry<S extends Source> = {
	request: SourceRequest;
	sourceRef: SourceRef<S>;
	age: number;
	cacheGroup: number;
};

/**
 * Represents an input media file. This is the root object from which all media read operations start.
 * @group Input files & tracks
 * @public
 */
export type InputEvents = {
	source: { source: Source; request: SourceRequest | null };
};

export class Input<S extends Source = Source> extends EventEmitter<InputEvents> implements Disposable {
	/** @internal */
	_source: SourceRef<S> | ((request: SourceRequest) => MaybePromise<S | SourceRef<S>>);
	/** @internal */
	_formats: InputFormat[];
	/** @internal */
	_initInput: Input | null;
	/** @internal */
	_entryPath: string | null;
	/** @internal */
	_demuxerPromise: Promise<Demuxer> | null = null;
	/** @internal */
	_format: InputFormat | null = null;
	/** @internal */
	_reader!: Reader;
	/** @internal */
	_trackBackingsCache: InputTrackBacking[] | null = null;
	/** @internal */
	_backingToTrack = new Map<InputTrackBacking, InputTrack>();
	/** @internal */
	_backingToDescriptor = new Map<InputTrackBacking, InputTrackDescriptor>();
	/** @internal */
	_hydrationPromises = new Map<InputTrackBacking, Promise<void>>();
	/** @internal */
	_disposed = false;
	/** @internal */
	_nextSourceCacheAge = 0;
	/** @internal */
	_sourceRefs: SourceRef[] = [];
	/** @internal */
	_sourceCache: SourceCacheEntry<S>[] = [];
	/** @internal */
	_sourceCachePromises: {
		request: SourceRequest;
		cacheGroup: number;
		promise: Promise<SourceCacheEntry<S>>;
	}[] = [];

	/** True if the input has been disposed. */
	get disposed() {
		return this._disposed;
	}

	/**
	 * Creates a new input file from the specified options. No reading operations will be performed until methods are
	 * called on this instance.
	 */
	constructor(options: InputOptions<S>) {
		super();

		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Array.isArray(options.formats) || options.formats.some(x => !(x instanceof InputFormat))) {
			throw new TypeError('options.formats must be an array of InputFormat.');
		}
		if (!(options.source instanceof Source) && typeof options.source !== 'function') {
			throw new TypeError('options.source must be a Source or a function that returns a Source.');
		}
		if (typeof options.source === 'function' && options.entryPath === undefined) {
			throw new TypeError('options.entryPath must be provided when options.source is a function.');
		}
		if (options.initInput !== undefined && !(options.initInput instanceof Input)) {
			throw new TypeError('options.initInput, when provided, must be an Input.');
		}
		if (options.entryPath !== undefined && typeof options.entryPath !== 'string') {
			throw new TypeError('options.entryPath, when provided, must be a string.');
		}

		this._formats = options.formats;
		this._initInput = options.initInput ?? null;
		this._entryPath = options.entryPath ?? null;

		if (options.source instanceof Source) {
			this._source = options.source.ref();
		} else {
			this._source = options.source;
		}

		if (this._source instanceof SourceRef) {
			this._sourceRefs.push(this._source);
		}

		inputFinalizationRegistry?.register(this, this._sourceRefs, this);
	}

	async _getSourceUncached(request: SourceRequest) {
		assert(typeof this._source === 'function');

		const source = await this._source(request);
		if (!(source instanceof Source || source instanceof SourceRef)) {
			throw new TypeError('The source function must return a Source or a SourceRef.');
		}
		if (source instanceof Source && source._disposed) {
			throw new TypeError('The returned Source must not be disposed.');
		}

		let ref: SourceRef<S>;
		if (source instanceof Source) {
			ref = source.ref();
		} else {
			ref = source;
		}

		this.emit('source', { source: ref.source, request });
		return ref;
	}

	_getSourceCached(request: SourceRequest, cacheGroup = DEFAULT_SOURCE_CACHE_GROUP): Promise<SourceRef<S>> {
		const cachedEntry = this._sourceCache.find(x =>
			x.cacheGroup === cacheGroup && sourceRequestsAreEqual(x.request, request),
		);
		if (cachedEntry) {
			cachedEntry.age++;
			return Promise.resolve(cachedEntry.sourceRef.source.ref());
		}

		const cachedPromiseEntry = this._sourceCachePromises.find(x =>
			x.cacheGroup === cacheGroup && sourceRequestsAreEqual(x.request, request),
		);
		if (cachedPromiseEntry) {
			return cachedPromiseEntry.promise.then(x => x.sourceRef.source.ref());
		}

		const promise = (async () => {
			const sourceRef = await this._getSourceUncached(request);

			const cacheEntry: SourceCacheEntry<S> = {
				request,
				sourceRef,
				age: this._nextSourceCacheAge++,
				cacheGroup,
			};

			this._sourceCache.push(cacheEntry);

			const MAX_SOURCE_CACHE_SIZE = 4;
			const count = arrayCount(
				this._sourceCache,
				x => x.cacheGroup === cacheGroup && x.sourceRef.source._refCount === 1,
			);

			if (count > MAX_SOURCE_CACHE_SIZE) {
				const minAgeIndex = arrayArgmin(
					this._sourceCache,
					x => x.cacheGroup === cacheGroup && x.sourceRef.source._refCount === 1 ? x.age : Infinity,
				);
				assert(minAgeIndex !== -1);
				const entry = this._sourceCache[minAgeIndex]!;
				this._sourceCache.splice(minAgeIndex, 1);

				entry.sourceRef.free();
				removeItem(this._sourceRefs, sourceRef);
			}

			this._sourceRefs.push(sourceRef);

			const promiseIndex = this._sourceCachePromises.findIndex(x => x.request === request);
			assert(promiseIndex !== -1);
			this._sourceCachePromises.splice(promiseIndex, 1);

			return cacheEntry;
		})();

		this._sourceCachePromises.push({
			request,
			cacheGroup,
			promise,
		});

		return promise.then(x => x.sourceRef.source.ref());
	}

	/** @internal */
	_getDemuxer() {
		return this._demuxerPromise ??= (async () => {
			let ref: SourceRef;
			if (this._source instanceof SourceRef) {
				ref = this._source;
				this.emit('source', { source: ref.source, request: null });
			} else {
				assert(this._entryPath !== null);
				ref = await this._getSourceUncached({ path: this._entryPath, isRoot: true });
				this._sourceRefs.push(ref);
			}

			this._reader = new Reader(ref.source);

			for (const format of this._formats) {
				const canRead = await format._canReadInput(this);
				if (canRead) {
					this._format = format;
					return format._createDemuxer(this);
				}
			}

			throw new UnsupportedInputFormatError();
		})();
	}

	/**
	 * Returns the source from which this input file reads data for the entry path. Throws if the source-resolving
	 * function returns a promise; prefer the `'source'` event for those cases.
	 */
	get source(): S {
		if (this._source instanceof SourceRef) {
			return this._source.source;
		}

		assert(this._entryPath !== null);

		const source = this._source({ path: this._entryPath, isRoot: true });
		if (source instanceof Promise) {
			throw new TypeError(
				'Input.source cannot be used when the source function resolves asynchronously.'
				+ ' Use the \'source\' event instead.',
			);
		}

		if (source instanceof Source) {
			return source;
		} else {
			return source.source;
		}
	}

	/**
	 * Returns the format of the input file. You can compare this result directly to the {@link InputFormat} singletons
	 * or use `instanceof` checks for subset-aware logic (for example, `format instanceof MatroskaInputFormat` is true
	 * for both MKV and WebM).
	 */
	async getFormat() {
		await this._getDemuxer();
		assert(this._format!);
		return this._format;
	}

	async canRead(): Promise<boolean> {
		try {
			await this._getDemuxer();
			return true;
		} catch (error) {
			if (error instanceof UnsupportedInputFormatError) {
				return false;
			}

			throw error;
		}
	}

	/**
	 * Computes the duration of the input file, in seconds. More precisely, returns the largest end timestamp among
	 * all tracks.
	 *
	 * By default, when any track in the underlying media is live, this method will only resolve once the live stream
	 * ends. If you want to query the current duration of the media, set {@link PacketRetrievalOptions.skipLiveWait}
	 * to `true` in the options.
	 */
	async computeDuration(options?: PacketRetrievalOptions) {
		const tracks = await this.getTracks();
		if (tracks.length === 0) {
			return 0;
		}

		const tracksDurations = await Promise.all(tracks.map(x => x.computeDuration(options)));
		return Math.max(...tracksDurations);
	}

	/**
	 * Returns the timestamp at which the input file starts. More precisely, returns the smallest starting timestamp
	 * among all tracks.
	 *
	 * Note that this method is potentially expensive for inputs with many tracks (such as HLS manifests), since it
	 * probes every track.
	 */
	async getFirstTimestamp() {
		const tracks = await this.getTracks();
		if (tracks.length === 0) {
			return 0;
		}

		const firstTimestamps = await Promise.all(tracks.map(x => x.getFirstTimestamp()));
		return Math.min(...firstTimestamps);
	}

	/**
	 * Gets the duration (end timestamp) of the input file from metadata stored in the file. This value may be
	 * approximate or diverge from the actual, precise duration returned by `.computeDuration()`, but compared to that
	 * method, this method is very cheap. When the duration cannot be determined from the file metadata, `null`
	 * is returned.
	 *
	 * By default, when the underlying media is live, this method will only resolve once the live stream
	 * ends. If you want to query the current duration of the media, set
	 * {@link DurationMetadataRequestOptions.skipLiveWait} to `true` in the options.
	 */
	async getDurationFromMetadata(options: DurationMetadataRequestOptions = {}) {
		const demuxer = await this._getDemuxer();
		return demuxer.getDurationFromMetadata(options);
	}

	/**
	 * Returns the list of all tracks of this input file in the order in which they appear in the file.
	 * A query can be provided to filter/sort tracks; the query operates on lightweight descriptors and only
	 * the matching tracks are fully loaded.
	 */
	async getTracks(query?: TrackDescriptorQuery<InputTrackDescriptor>): Promise<InputTrack[]> {
		const descriptors = await this.getTrackDescriptors(query);
		return Promise.all(descriptors.map(x => x.getTrack()));
	}

	async pluckTrack(query?: TrackDescriptorQuery<InputTrackDescriptor>): Promise<InputTrack | null> {
		const descriptors = await this.getTrackDescriptors(query);
		return descriptors[0]?.getTrack() ?? null;
	}

	/** Returns the list of all video tracks of this input file. */
	async getVideoTracks(query?: TrackDescriptorQuery<InputVideoTrackDescriptor>): Promise<InputVideoTrack[]> {
		const descriptors = await this.getVideoTrackDescriptors(query);
		return Promise.all(descriptors.map(x => x.getTrack()));
	}

	async pluckVideoTrack(query?: TrackDescriptorQuery<InputVideoTrackDescriptor>): Promise<InputVideoTrack | null> {
		const descriptors = await this.getVideoTrackDescriptors(query);
		return descriptors[0]?.getTrack() ?? null;
	}

	/** Returns the list of all audio tracks of this input file. */
	async getAudioTracks(query?: TrackDescriptorQuery<InputAudioTrackDescriptor>): Promise<InputAudioTrack[]> {
		const descriptors = await this.getAudioTrackDescriptors(query);
		return Promise.all(descriptors.map(x => x.getTrack()));
	}

	async pluckAudioTrack(query?: TrackDescriptorQuery<InputAudioTrackDescriptor>): Promise<InputAudioTrack | null> {
		const descriptors = await this.getAudioTrackDescriptors(query);
		return descriptors[0]?.getTrack() ?? null;
	}

	/** Returns the primary video track of this input file, or null if there are no video tracks. */
	async getPrimaryVideoTrack(
		query?: TrackDescriptorQuery<InputVideoTrackDescriptor>,
	): Promise<InputVideoTrack | null> {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptor = await this.getPrimaryVideoDescriptor(query);
		return descriptor?.getTrack() ?? null;
	}

	/** Returns the primary audio track of this input file, or null if there are no audio tracks. */
	async getPrimaryAudioTrack(
		query?: TrackDescriptorQuery<InputAudioTrackDescriptor>,
	): Promise<InputAudioTrack | null> {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptor = await this.getPrimaryAudioDescriptor(query);
		return descriptor?.getTrack() ?? null;
	}

	/**
	 * Returns lightweight track descriptors without loading full media data. Useful for querying and filtering
	 * tracks (e.g. from an HLS master playlist) before committing to loading any specific track.
	 */
	async getTrackDescriptors(query?: TrackDescriptorQuery<InputTrackDescriptor>) {
		query &&= toValidatedTrackDescriptorQuery(query);

		const backings = await this._getTrackBackings();
		const descriptors = backings.map(backing => this._wrapBackingAsDescriptor(backing));
		return queryTrackDescriptors(descriptors, query);
	}

	async getVideoTrackDescriptors(
		query?: TrackDescriptorQuery<InputVideoTrackDescriptor>,
	): Promise<InputVideoTrackDescriptor[]> {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptors = await this.getTrackDescriptors();
		const videoDescriptors = descriptors.filter(
			(x): x is InputVideoTrackDescriptor => x.isVideoTrackDescriptor(),
		);
		return queryTrackDescriptors(videoDescriptors, query);
	}

	async getAudioTrackDescriptors(
		query?: TrackDescriptorQuery<InputAudioTrackDescriptor>,
	): Promise<InputAudioTrackDescriptor[]> {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptors = await this.getTrackDescriptors();
		const audioDescriptors = descriptors.filter(
			(x): x is InputAudioTrackDescriptor => x.isAudioTrackDescriptor(),
		);
		return queryTrackDescriptors(audioDescriptors, query);
	}

	async getPrimaryVideoDescriptor(
		query?: TrackDescriptorQuery<InputVideoTrackDescriptor>,
	): Promise<InputVideoTrackDescriptor | null> {
		query &&= toValidatedTrackDescriptorQuery(query);

		const merged = mergeTrackDescriptorQueries(query, {
			sortBy: d => [
				prefer(d.disposition?.default ?? false),
				prefer(d.hasPairableAudioTrack()),
				prefer(!d.hasOnlyKeyPackets),
				desc(d.bitrate ?? null),
			],
		});

		const sorted = await this.getVideoTrackDescriptors(merged);
		return sorted[0] ?? null;
	}

	async getPrimaryAudioDescriptor(
		query?: TrackDescriptorQuery<InputAudioTrackDescriptor>,
	): Promise<InputAudioTrackDescriptor | null> {
		query &&= toValidatedTrackDescriptorQuery(query);

		const primaryVideoDescriptor = await this.getPrimaryVideoDescriptor();

		const merged = mergeTrackDescriptorQueries(query, {
			sortBy: d => [
				prefer(d.canBePairedWith(primaryVideoDescriptor)),
				prefer(d.disposition?.default ?? false),
				desc(d.bitrate ?? null),
			],
		});

		const sorted = await this.getAudioTrackDescriptors(merged);
		return sorted[0] ?? null;
	}

	/** @internal */
	async _getTrackBackings() {
		const demuxer = await this._getDemuxer();
		return this._trackBackingsCache ??= await demuxer.getTrackBackings();
	}

	/** @internal */
	_wrapBackingAsTrack(backing: InputTrackBacking): InputTrack {
		const existing = this._backingToTrack.get(backing);
		if (existing) {
			return existing;
		}

		const type = backing.getType();
		const track = type === 'video'
			? new InputVideoTrack(this, backing as InputVideoTrackBacking)
			: new InputAudioTrack(this, backing as InputAudioTrackBacking);

		this._backingToTrack.set(backing, track);
		return track;
	}

	/** @internal */
	_wrapBackingAsDescriptor(backing: InputTrackBacking): InputTrackDescriptor {
		const existing = this._backingToDescriptor.get(backing);
		if (existing) {
			return existing;
		}

		const type = backing.getType();
		const descriptor = type === 'video'
			? new InputVideoTrackDescriptor(this, backing as InputVideoTrackBacking)
			: new InputAudioTrackDescriptor(this, backing as InputAudioTrackBacking);

		this._backingToDescriptor.set(backing, descriptor);
		return descriptor;
	}

	/** @internal */
	_hydrateBacking(backing: InputTrackBacking): Promise<void> {
		if (!backing.hydrate || (backing.isHydrated?.() ?? true)) {
			return Promise.resolve();
		}

		let promise = this._hydrationPromises.get(backing);
		if (!promise) {
			promise = backing.hydrate();
			this._hydrationPromises.set(backing, promise);
		}

		return promise;
	}

	/** @internal */
	async _getTrackForBacking(backing: InputTrackBacking): Promise<InputTrack> {
		await this._hydrateBacking(backing);
		return this._wrapBackingAsTrack(backing);
	}

	/** Returns the full MIME type of this input file, including track codecs. */
	async getMimeType() {
		const demuxer = await this._getDemuxer();
		return demuxer.getMimeType();
	}

	/**
	 * Returns descriptive metadata tags about the media file, such as title, author, date, cover art, or other
	 * attached files.
	 */
	async getMetadataTags() {
		const demuxer = await this._getDemuxer();
		return demuxer.getMetadataTags();
	}

	/**
	 * Disposes this input and frees connected resources. When an input is disposed, ongoing read operations will be
	 * canceled, all future read operations will fail, any open decoders will be closed, and all ongoing media sink
	 * operations will be canceled. Disallowed and canceled operations will throw an {@link InputDisposedError}.
	 *
	 * You are expected not to use an input after disposing it. While some operations may still work, it is not
	 * specified and may change in any future update.
	 */
	dispose() {
		if (this._disposed) {
			return;
		}

		this._disposed = true;

		for (const ref of this._sourceRefs) {
			ref.free();
		}
		this._sourceRefs.length = 0;

		inputFinalizationRegistry?.unregister(this);

		void this._demuxerPromise
			?.then(demuxer => demuxer.dispose());
	}

	/**
	 * Calls `.dispose()` on the input, implementing the `Disposable` interface for use with
	 * JavaScript Explicit Resource Management features.
	 */
	[Symbol.dispose]() {
		this.dispose();
	}
}

/**
 * Thrown when trying to operate on an input that has an unsupported or unrecognizable format.
 * @group Input files & tracks
 * @public
 */
export class UnsupportedInputFormatError extends Error {
	/** Creates a new {@link UnsupportedInputFormatError}. */
	constructor(message = 'Input has an unsupported or unrecognizable format.') {
		super(message);
		this.name = 'UnsupportedInputFormatError';
	}
}

/**
 * Thrown when an operation was prevented because the corresponding {@link Input} has been disposed.
 * @group Input files & tracks
 * @public
 */
export class InputDisposedError extends Error {
	/** Creates a new {@link InputDisposedError}. */
	constructor(message = 'Input has been disposed.') {
		super(message);
		this.name = 'InputDisposedError';
	}
}

/**
 * Options for {@link Input.from}. Combines the options of all source types, plus `initInput`.
 * @group Input files & tracks
 * @public
 */
export type InputFromOptions =
	& Partial<UrlSourceOptions>
	& Partial<BlobSourceOptions>
	& Partial<FilePathSourceOptions>
	& Partial<ReadableStreamSourceOptions>
	& {
		initInput?: Input;
	};

/**
 * Creates an {@link Input} backed by the passed-in data. An alternative to {@link Input}'s constructor, this helper
 * function automatically chooses the correct underlying {@link Source} based on the type of the data passed in.
 *
 * Legal data types are `ArrayBuffer`, `SharedArrayBuffer`, `ArrayBufferView`, `Blob` (and, by extension, `File`),
 * `ReadableStream<Uint8Array`, `string` (representing either a URL or a local file path), `URL`, and `Request`.
 *
 * The available options are the union of the options for each {@link Source}. Check the sources to see which field
 * applies to which source.
 */
export const createInputFrom = (
	data: AllowSharedBufferSource | Blob | ReadableStream<Uint8Array> | string | URL | Request,
	formats: InputFormat[],
	options: InputFromOptions = {},
): Input => {
	if (!Array.isArray(formats) || !formats.every(x => x instanceof InputFormat)) {
		throw new TypeError('formats must be an array of InputFormat.');
	}
	if (typeof options !== 'object' || !options) {
		throw new TypeError('options must be an object.');
	}

	const { initInput, ...sourceOptions } = options;

	if (
		data instanceof ArrayBuffer
		|| (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)
		|| ArrayBuffer.isView(data)
	) {
		return new Input({
			formats,
			source: new BufferSource(data),
			initInput,
		});
	}

	if (typeof Blob !== 'undefined' && data instanceof Blob) {
		return new Input({
			formats,
			source: new BlobSource(data, sourceOptions),
			initInput,
		});
	}

	if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream) {
		return new Input({
			formats,
			source: new ReadableStreamSource(data, sourceOptions),
			initInput,
		});
	}

	if (typeof URL !== 'undefined' && data instanceof URL) {
		const url = data.href;

		return new Input({
			formats,
			source: (request: SourceRequest) => new UrlSource(request.path, sourceOptions),
			entryPath: url,
			initInput,
		});
	}

	if (typeof Request !== 'undefined' && data instanceof Request) {
		const url = data.url;

		return new Input({
			formats,
			source: (request: SourceRequest) => {
				const reqInit = (sourceOptions as UrlSourceOptions).requestInit;
				return new UrlSource(
					new Request(request.path, { ...reqInit, method: data.method, headers: data.headers }),
					sourceOptions,
				);
			},
			entryPath: url,
			initInput,
		});
	}

	if (typeof data === 'string') {
		const isUrl = data.includes('://');

		if (isUrl) {
			return new Input({
				formats,
				source: (request: SourceRequest) => new UrlSource(request.path, sourceOptions),
				entryPath: data,
				initInput,
			});
		}

		// File path, throws automatically if this isn't server-side
		return new Input({
			formats,
			source: (request: SourceRequest) => new FilePathSource(request.path, sourceOptions),
			entryPath: data,
			initInput,
		});
	}

	throw new TypeError(
		'Input.from: first argument must be an ArrayBuffer, SharedArrayBuffer, ArrayBufferView, Blob,'
		+ ' ReadableStream, string, URL, or Request.',
	);
};
