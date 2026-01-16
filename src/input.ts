/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from './demuxer';
import { InputFormat } from './input-format';
import { assert, polyfillSymbolDispose } from './misc';
import { Reader } from './reader';
import { Source } from './source';

polyfillSymbolDispose();

/**
 * The options for creating an Input object.
 * @group Input files & tracks
 * @public
 */
export type InputOptions<S extends Source = Source> = {
	/** A list of supported formats. If the source file is not of one of these formats, then it cannot be read. */
	formats: InputFormat[];
	/** The source from which data will be read. */
	source: S;
};

/**
 * Represents an input media file. This is the root object from which all media read operations start.
 * @group Input files & tracks
 * @public
 */
export class Input<S extends Source = Source> implements Disposable {
	/** @internal */
	_source: S;
	/** @internal */
	_formats: InputFormat[];
	/** @internal */
	_demuxerPromise: Promise<Demuxer> | null = null;
	/** @internal */
	_format: InputFormat | null = null;
	/** @internal */
	_reader: Reader;
	/** @internal */
	_disposed = false;

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
		if (!(options.source instanceof Source)) {
			throw new TypeError('options.source must be a Source.');
		}
		if (options.source._disposed) {
			throw new Error('options.source must not be disposed.');
		}

		this._formats = options.formats;
		this._source = options.source;
		this._reader = new Reader(options.source);
	}

	/** @internal */
	_getDemuxer() {
		return this._demuxerPromise ??= (async () => {
			this._reader.fileSize = await this._source.getSizeOrNull();

			for (const format of this._formats) {
				const canRead = await format._canReadInput(this);
				if (canRead) {
					this._format = format;
					return format._createDemuxer(this);
				}
			}

			throw new Error('Input has an unsupported or unrecognizable format.');
		})();
	}

	/**
	 * Returns the source from which this input file reads its data. This is the same source that was passed to the
	 * constructor.
	 */
	get source() {
		return this._source;
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

	/**
	 * Computes the duration of the input file, in seconds. More precisely, returns the largest end timestamp among
	 * all tracks.
	 */
	async computeDuration() {
		const demuxer = await this._getDemuxer();
		return demuxer.computeDuration();
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

	/** Returns the list of all tracks of this input file. */
	async getTracks() {
		const demuxer = await this._getDemuxer();
		return demuxer.getTracks();
	}

	/** Returns the list of all video tracks of this input file. */
	async getVideoTracks() {
		const tracks = await this.getTracks();
		return tracks.filter(x => x.isVideoTrack());
	}

	/** Returns the list of all audio tracks of this input file. */
	async getAudioTracks() {
		const tracks = await this.getTracks();
		return tracks.filter(x => x.isAudioTrack());
	}

	/** Returns the primary video track of this input file, or null if there are no video tracks. */
	async getPrimaryVideoTrack() {
		const tracks = await this.getTracks();
		return tracks.find(x => x.isVideoTrack()) ?? null;
	}

	/** Returns the primary audio track of this input file, or null if there are no audio tracks. */
	async getPrimaryAudioTrack() {
		const tracks = await this.getTracks();
		return tracks.find(x => x.isAudioTrack()) ?? null;
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

		this._source._disposed = true;
		this._source._dispose();
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
