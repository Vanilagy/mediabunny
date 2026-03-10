/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from './demuxer';
import { InputFormat } from './input-format';
import {
	InputAudioTrack,
	InputTrack,
	InputVideoTrack,
	mergeTrackQueries,
	queryTracks,
	TrackQuery,
} from './input-track';
import { arrayArgmin, arrayCount, assert, desc, MaybePromise, polyfillSymbolDispose, prefer } from './misc';
import { Reader } from './reader';
import { Source } from './source';

polyfillSymbolDispose();

export const DEFAULT_SOURCE_CACHE_GROUP = 1;
export const ENCRYPTION_KEY_CACHE_GROUP = 2;

export type SourceRequest = {
	path: string;
};

const sourceRequestsAreEqual = (a: SourceRequest, b: SourceRequest) => {
	return a.path === b.path;
};

/**
 * The options for creating an Input object.
 * @group Input files & tracks
 * @public
 */
export type InputOptions<S extends Source = Source> = {
	/** A list of supported formats. If the source file is not of one of these formats, then it cannot be read. */
	formats: InputFormat[];
	/** The source from which data will be read. */
	source: S | ((request: SourceRequest) => MaybePromise<S>);
	entryPath?: string;
	initInput?: Input;
};

/**
 * Represents an input media file. This is the root object from which all media read operations start.
 * @group Input files & tracks
 * @public
 */
export class Input<S extends Source = Source> implements Disposable {
	/** @internal */
	_source: InputOptions<S>['source'];
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
	_tracksCache: InputTrack[] | null = null;
	/** @internal */
	_disposed = false;
	/** @internal */
	_nextSourceCacheAge = 0;
	/** @internal */
	_sourceCache: {
		request: SourceRequest;
		sourcePromise: Promise<S>;
		age: number;
		cacheGroup: number;
	}[] = [];

	/**
	 * Called whenever a source is resolved for internal operations.
	 */
	onSource?: (source: Source, request: SourceRequest | null) => unknown;

	/** True if the input has been disposed. */
	get disposed() {
		return this._disposed;
	}

	/**
	 * Creates a new input file from the specified options. No reading operations will be performed until methods are
	 * called on this instance.
	 */
	constructor(options: InputOptions<S>) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Array.isArray(options.formats) || options.formats.some(x => !(x instanceof InputFormat))) {
			throw new TypeError('options.formats must be an array of InputFormat.');
		}
		if (!(options.source instanceof Source) && typeof options.source !== 'function') {
			throw new TypeError('options.source must be a Source or a function that returns a Source.');
		}
		if (options.source instanceof Source && options.source._disposed) {
			throw new TypeError('options.source must not be disposed.');
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
		this._source = options.source;
		this._initInput = options.initInput ?? null;
		this._entryPath = options.entryPath ?? null;
	}

	async _getSourceUncached(request: SourceRequest) {
		assert(typeof this._source === 'function');

		const source = await this._source(request);
		if (!(source instanceof Source)) {
			throw new TypeError('The source function must return a Source.');
		}
		if (source._disposed) {
			throw new TypeError('The returned Source must not be disposed.');
		}

		this.onSource?.(source, request);

		return source;
	}

	_getSourceCached(request: SourceRequest, cacheGroup = DEFAULT_SOURCE_CACHE_GROUP) {
		const cachedEntry = this._sourceCache.find(x =>
			x.cacheGroup === cacheGroup && sourceRequestsAreEqual(x.request, request),
		);
		if (cachedEntry) {
			cachedEntry.age++;
			return cachedEntry.sourcePromise;
		}

		const sourcePromise = this._getSourceUncached(request);
		this._sourceCache.push({
			request,
			sourcePromise,
			age: this._nextSourceCacheAge++,
			cacheGroup,
		});

		const MAX_SOURCE_CACHE_SIZE = 4;
		const count = arrayCount(this._sourceCache, x => x.cacheGroup === cacheGroup);

		if (count > MAX_SOURCE_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this._sourceCache, x => x.cacheGroup === cacheGroup ? x.age : Infinity);
			const entry = this._sourceCache[minAgeIndex]!;
			this._sourceCache.splice(minAgeIndex, 1);

			/*
			void entry.sourcePromise
				.then(source => source._dispose());
			*/
		}

		return sourcePromise;
	}

	/** @internal */
	_getDemuxer() {
		return this._demuxerPromise ??= (async () => {
			let source: Source;
			if (this._source instanceof Source) {
				source = this._source;
				this.onSource?.(source, null);
			} else {
				assert(this._entryPath !== null);
				source = await this._getSourceUncached({ path: this._entryPath });
			}

			this._reader = new Reader(source);

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
	 * Returns a source for the given request.
	 *
	 * If this input was created with a direct {@link Source}, that source is always returned. If this input was created
	 * with a source function, this method resolves it using the provided request or the entry path.
	 */
	getSource(request?: SourceRequest): MaybePromise<S> {
		if (this._source instanceof Source) {
			return this._source;
		}

		assert(this._entryPath !== null);
		return this._getSourceCached(request ?? { path: this._entryPath });
	}

	/**
	 * @deprecated Use {@link getSource} instead.
	 *
	 * Returns the source from which this input file reads data for the entry path. Throws if the source-resolving
	 * function returns a Promise.
	 */
	get source() {
		if (this._source instanceof Source) {
			return this._source;
		}

		assert(this._entryPath !== null);

		const source = this._source({ path: this._entryPath });
		if (source instanceof Promise) {
			throw new TypeError(
				'Input.source cannot be used when the source function resolves asynchronously.'
				+ ' Use getSource() instead.',
			);
		}

		return source;
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

	async isSupported(): Promise<boolean> {
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
	 */
	async computeDuration() {
		const tracks = await this.getTracks();
		if (tracks.length === 0) {
			return 0;
		}

		const tracksDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(...tracksDurations);
	}

	/**
	 * Returns the timestamp at which the input file starts. More precisely, returns the smallest starting timestamp
	 * among all tracks.
	 */
	async getFirstTimestamp() {
		const tracks = await this.getTracks();
		if (tracks.length === 0) {
			return 0;
		}

		const firstTimestamps = await Promise.all(tracks.map(x => x.getFirstTimestamp()));
		return Math.min(...firstTimestamps);
	}

	/** Returns the list of all tracks of this input file in the order in which they appear in the file. */
	async getTracks(query?: TrackQuery<InputTrack>) {
		const demuxer = await this._getDemuxer();
		const tracks = this._tracksCache ??= await demuxer.getTracks();
		return queryTracks(tracks, query);
	}

	async pluckTrack(query?: TrackQuery<InputTrack>) {
		return (await this.getTracks(query))[0];
	}

	/** Returns the list of all video tracks of this input file. */
	async getVideoTracks(query?: TrackQuery<InputVideoTrack>) {
		const tracks = await this.getTracks();
		return queryTracks(tracks.filter(x => x.isVideoTrack()) as InputVideoTrack[], query);
	}

	async pluckVideoTrack(query?: TrackQuery<InputVideoTrack>) {
		return (await this.getVideoTracks(query))[0] ?? null;
	}

	/** Returns the list of all audio tracks of this input file. */
	async getAudioTracks(query?: TrackQuery<InputAudioTrack>) {
		const tracks = await this.getTracks();
		return queryTracks(tracks.filter(x => x.isAudioTrack()) as InputAudioTrack[], query);
	}

	async pluckAudioTrack(query?: TrackQuery<InputAudioTrack>) {
		return (await this.getAudioTracks(query))[0] ?? null;
	}

	/** Returns the primary video track of this input file, or null if there are no video tracks. */
	getPrimaryVideoTrack(query?: TrackQuery<InputVideoTrack>) {
		return this.pluckVideoTrack(mergeTrackQueries(query, {
			sortBy: track => [
				prefer(track.disposition.default),
				prefer(track.hasPairableAudioTrack()),
				prefer(!track.hasOnlyKeyPackets),
				desc(track.bitrate),
			],
		}));
	}

	/** Returns the primary audio track of this input file, or null if there are no audio tracks. */
	async getPrimaryAudioTrack(query?: TrackQuery<InputAudioTrack>) {
		const videoTrack = await this.getPrimaryVideoTrack();

		return this.pluckAudioTrack(mergeTrackQueries(query, {
			sortBy: track => [
				prefer(track.canBePairedWith(videoTrack)),
				prefer(track.disposition.default),
				desc(track.bitrate),
			],
		}));
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

	async allTracksAreHydrated() {
		const tracks = await this.getTracks();
		return tracks.every(x => x.isHydrated);
	}

	async hydrateAllTracks() {
		const tracks = await this.getTracks();
		await Promise.all(tracks.map(x => x.hydrate()));
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

		if (this._source instanceof Source) {
			this._source._disposed = true;
			this._source._dispose();
		} else {
			// TODO
			// TODO
			// throw new Error('TODO');
		}
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
