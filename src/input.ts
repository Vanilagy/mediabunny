/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer, DurationMetadataRequestOptions } from './demuxer';
import { InputFormat, InputFormatOptions, validateInputFormatOptions } from './input-format';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
	InputTrackQuery,
	mergeInputTrackQueries,
	queryInputTracks,
	toValidatedInputTrackQuery,
	prefer,
	desc,
} from './input-track';
import { PacketRetrievalOptions } from './media-sink';
import {
	arrayArgmin,
	arrayCount,
	assert,
	EventEmitter,
	polyfillSymbolDispose,
	removeItem,
} from './misc';
import { Reader } from './reader';
import {
	PathedSource,
	Source,
	SourceRef,
	SourceRequest,
	sourceRequestsAreEqual,
} from './source';

polyfillSymbolDispose();

export const DEFAULT_SOURCE_CACHE_GROUP = 1;
export const ENCRYPTION_KEY_CACHE_GROUP = 2;

let inputFinalizationRegistry: FinalizationRegistry<SourceRef[]> | null = null;
if (typeof FinalizationRegistry !== 'undefined') {
	inputFinalizationRegistry = new FinalizationRegistry((refs) => {
		for (const ref of refs) {
			if (!ref.freed) {
				ref.free();
			}
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
	source: S | SourceRef<S>;
	/**
	 * An optional, second {@link Input} instance that contains the necessary metadata to initialize the tracks of
	 * this input. This is necessary in cases where track initialization info and media data are carried in separate
	 * files, like is the case with segmented MP4 (CMAF) files.
	 *
	 * The use of this field depends on the input format.
	 */
	initInput?: Input;

	/** Can be used to specify additional per-format configuration. */
	formatOptions?: InputFormatOptions;
};

type SourceCacheEntry = {
	request: SourceRequest;
	sourceRef: SourceRef;
	age: number;
	cacheGroup: number;
};

/**
 * Describes the events that an {@link Input} emits, with each key being an event name and its value being the
 * event data.
 *
 * @group Input files & tracks
 * @public
 */
export type InputEvents = {
	/** Emitted whenever a {@link Source} is loaded by the input. Useful to track reads. */
	source: {
		/** The loaded source. */
		source: Source;
		/** The request that led to loading this source, or `null` if the input is not pathed. */
		request: SourceRequest | null;
		/** Whether the source is the root file of the media. */
		isRoot: boolean;
	};
};

/**
 * Represents input media, backed by a single file or multiple files depending on the format.
 *
 * This is the root object from which all media read operations start.
 * @group Input files & tracks
 * @public
 */
export class Input<S extends Source = Source> extends EventEmitter<InputEvents> implements Disposable {
	/** @internal */
	_rootRef: SourceRef<S>;
	/** @internal */
	_formats: InputFormat[];
	/** @internal */
	_initInput: Input | null;
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
	_disposed = false;
	/** @internal */
	_nextSourceCacheAge = 0;
	/** @internal */
	_sourceRefs: SourceRef[] = [];
	/** @internal */
	_sourceCache: SourceCacheEntry[] = [];
	/** @internal */
	_sourceCachePromises: {
		request: SourceRequest;
		cacheGroup: number;
		promise: Promise<SourceCacheEntry>;
	}[] = [];

	/** @internal */
	_formatOptions: InputFormatOptions;
	/** @internal */
	_onFormatDetermined: ((format: InputFormat) => void) | null = null;

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
		if (!(options.source instanceof Source || options.source instanceof SourceRef)) {
			throw new TypeError('options.source must be a Source or SourceRef.');
		}
		if (options.source instanceof Source && options.source._disposed) {
			throw new TypeError('options.source must not be a disposed Source.');
		}
		if (options.initInput !== undefined && !(options.initInput instanceof Input)) {
			throw new TypeError('options.initInput, when provided, must be an Input.');
		}
		if (options.formatOptions !== undefined) {
			validateInputFormatOptions(options.formatOptions, 'formatOptions');
		}

		this._formats = options.formats;
		this._initInput = options.initInput ?? null;
		this._formatOptions = options.formatOptions ?? {};

		if (options.source instanceof Source) {
			this._rootRef = options.source.ref();
		} else {
			this._rootRef = options.source;
		}

		this._sourceRefs.push(this._rootRef);
		inputFinalizationRegistry?.register(this, this._sourceRefs, this);
	}

	/** @internal */
	get _rootSource() {
		return this._rootRef.source;
	}

	/** @internal */
	async _getSourceUncached(request: SourceRequest) {
		assert(this._rootSource instanceof PathedSource);

		const ref = await this._rootSource._resolveRequest(request);

		this._emit('source', { source: ref.source, request, isRoot: request.isRoot });
		return ref;
	}

	/** @internal */
	_getSourceCached(request: SourceRequest, cacheGroup = DEFAULT_SOURCE_CACHE_GROUP): Promise<SourceRef> {
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

			const MAX_SOURCE_CACHE_SIZE = 4;
			const count = arrayCount(
				this._sourceCache,
				x => x.cacheGroup === cacheGroup && x.sourceRef.source._refCount === 1,
			);

			if (count >= MAX_SOURCE_CACHE_SIZE) {
				const minAgeIndex = arrayArgmin(
					this._sourceCache,
					x => x.cacheGroup === cacheGroup && x.sourceRef.source._refCount === 1 ? x.age : Infinity,
				);
				assert(minAgeIndex !== -1);
				const entry = this._sourceCache[minAgeIndex]!;
				this._sourceCache.splice(minAgeIndex, 1);

				entry.sourceRef.free();
				removeItem(this._sourceRefs, entry.sourceRef);
			}

			this._sourceRefs.push(sourceRef);

			const promiseIndex = this._sourceCachePromises.findIndex(x => x.request === request);
			assert(promiseIndex !== -1);
			this._sourceCachePromises.splice(promiseIndex, 1);

			const cacheEntry: SourceCacheEntry = {
				request,
				sourceRef,
				age: this._nextSourceCacheAge++,
				cacheGroup,
			};
			return cacheEntry;
		})();

		this._sourceCachePromises.push({
			request,
			cacheGroup,
			promise,
		});

		return promise.then((entry) => {
			const ref = entry.sourceRef.source.ref();

			// We need to add it to the cache this late to avoid the ref being freed prematurely due to race conditions
			this._sourceCache.push(entry);

			return ref;
		});
	}

	/** @internal */
	_getDemuxer() {
		return this._demuxerPromise ??= (async () => {
			this._reader = new Reader(this._rootSource);
			this._emit('source', { source: this._rootSource, request: null, isRoot: true });

			for (const format of this._formats) {
				const canRead = await format._canReadInput(this);
				if (canRead) {
					this._format = format;
					this._onFormatDetermined?.(format);

					return format._createDemuxer(this);
				}
			}

			throw new UnsupportedInputFormatError();
		})();
	}

	/**
	 * Returns the source from which this input file reads data for the root path.
	 */
	get source(): S {
		return this._rootSource;
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

	/** Returns `true` if the format of the input file is known and the file can be read, `false` otherwise. */
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
	 * Returns the timestamp at which the input file starts. More precisely, returns the smallest starting timestamp
	 * among all tracks.
	 *
	 * Optionally, you can pass in the list of tracks for which you want to compute the starting timestamp.
	 *
	 * Note that this method is potentially expensive for inputs with many tracks (such as HLS manifests), since it
	 * probes every track.
	 */
	async getFirstTimestamp(tracks?: InputTrack[]) {
		tracks ??= await this.getTracks();

		const filtered = tracks.filter(x => x !== null);
		if (filtered.length === 0) {
			return 0;
		}

		const firstTimestamps = await Promise.all(filtered.map(x => x.getFirstTimestamp()));
		return Math.min(...firstTimestamps);
	}

	/**
	 * Computes the duration of the input file, in seconds. More precisely, returns the largest end timestamp among
	 * all tracks.
	 *
	 * Optionally, you can pass in the list of tracks for which you want to compute the duration.
	 *
	 * This method can be potentially expensive depending on the underlying file format, because it returns the most
	 * accurate duration possible and must check all tracks. Use {@link Input.getDurationFromMetadata} for a faster but
	 * less accurate estimate of duration.
	 *
	 * By default, when any track in the underlying media is live, this method will only resolve once the live stream
	 * ends. If you want to query the current duration of the media, set {@link PacketRetrievalOptions.skipLiveWait}
	 * to `true` in the options.
	 */
	async computeDuration(tracks?: InputTrack[], options?: PacketRetrievalOptions) {
		tracks ??= await this.getTracks();

		const filtered = tracks.filter(x => x !== null);
		if (filtered.length === 0) {
			return 0;
		}

		const tracksDurations = await Promise.all(filtered.map(x => x.computeDuration(options)));
		return Math.max(...tracksDurations);
	}

	/**
	 * Gets the duration (end timestamp) in seconds of the input file from metadata stored in the file. This value may
	 * be approximate or diverge from the actual, precise duration returned by `.computeDuration()`, but compared to
	 * that method, this method is cheaper. When the duration cannot be determined from the file metadata, `null`
	 * is returned.
	 *
	 * Optionally, you can pass in the list of tracks for which you want to get the duration from metadata.
	 *
	 * By default, when the underlying media is live, this method will only resolve once the live stream
	 * ends. If you want to query the current duration of the media, set
	 * {@link DurationMetadataRequestOptions.skipLiveWait} to `true` in the options.
	 */
	async getDurationFromMetadata(tracks?: InputTrack[], options?: DurationMetadataRequestOptions) {
		tracks ??= await this.getTracks();

		const filtered = tracks.filter(x => x !== null);
		const tracksDurations = await Promise.all(filtered.map(x => x.getDurationFromMetadata(options)));
		const nonNullDurations = tracksDurations.filter(x => x !== null);
		if (nonNullDurations.length === 0) {
			return null;
		}

		return Math.max(...nonNullDurations);
	}

	/**
	 * Returns the list of all tracks of this input file in the order in which they appear in the file. An optional
	 * query can be provided.
	 */
	async getTracks(query?: InputTrackQuery<InputTrack>): Promise<InputTrack[]> {
		query &&= toValidatedInputTrackQuery(query);

		const backings = await this._getTrackBackings();
		const tracks = backings.map(backing => this._wrapBackingAsTrack(backing));
		return queryInputTracks(tracks, query);
	}

	/** Returns the list of all video tracks of this input file. An optional query can be provided. */
	async getVideoTracks(query?: InputTrackQuery<InputVideoTrack>): Promise<InputVideoTrack[]> {
		query &&= toValidatedInputTrackQuery(query);

		const tracks = await this.getTracks();
		const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
		return queryInputTracks(videoTracks, query);
	}

	/** Returns the list of all audio tracks of this input file. An optional query can be provided. */
	async getAudioTracks(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack[]> {
		query &&= toValidatedInputTrackQuery(query);

		const tracks = await this.getTracks();
		const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());
		return queryInputTracks(audioTracks, query);
	}

	/**
	 * Returns the primary video track of this input file, or null if there are no video tracks.
	 *
	 * Multiple factors determine which track is considered primary, including its position in the file, disposition,
	 * bitrate (higher bitrate is preferred), and if it can be paired with an audio track.
	 */
	async getPrimaryVideoTrack(
		query?: InputTrackQuery<InputVideoTrack>,
	): Promise<InputVideoTrack | null> {
		query &&= toValidatedInputTrackQuery(query);

		const merged = mergeInputTrackQueries(query, {
			sortBy: async t => [
				prefer((await t.getDisposition()).default),
				prefer(await t.hasPairableAudioTrack()),
				prefer(!(await t.hasOnlyKeyPackets())),
				desc(await t.getBitrate()),
			],
		});

		const sorted = await this.getVideoTracks(merged);
		return sorted[0] ?? null;
	}

	/**
	 * Returns the primary audio track of this input file, or null if there are no audio tracks.
	 *
	 * Multiple factors determine which track is considered primary, including its position in the file, disposition,
	 * bitrate (higher bitrate is preferred), and if it can be paired with the primary video track.
	 */
	async getPrimaryAudioTrack(
		query?: InputTrackQuery<InputAudioTrack>,
	): Promise<InputAudioTrack | null> {
		query &&= toValidatedInputTrackQuery(query);

		const primaryVideoTrack = await this.getPrimaryVideoTrack();

		const merged = mergeInputTrackQueries(query, {
			sortBy: async t => [
				prefer(!primaryVideoTrack || t.canBePairedWith(primaryVideoTrack)),
				prefer((await t.getDisposition()).default),
				desc(await t.getBitrate()),
			],
		});

		const sorted = await this.getAudioTracks(merged);
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
