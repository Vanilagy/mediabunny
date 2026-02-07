/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from './input';
import { InputFormat, VirtualInputFormat } from './input-format';
import { ManifestInputFormat } from './manifest-input-format';
import { ManifestParser } from './manifest-parser';
import { arrayArgmin, assert, MaybePromise, polyfillSymbolDispose } from './misc';
import { Reader } from './reader';
import { NullSource, Source } from './source';
import { ManifestInputVariant } from './manifest-input-variant';
import { InputAggregateDemuxer } from './aggregate-demuxer';

polyfillSymbolDispose();

export type ManifestInputOptions = {
	entryPath: string;
	getSource: (path: string) => MaybePromise<Source>;
	manifestFormats: ManifestInputFormat[];
	mediaFormats: InputFormat[];
};

export class ManifestInput implements Disposable {
	_entryPath: string;
	_getSourceUncached: (path: string) => MaybePromise<Source>;
	_manifestFormats: ManifestInputFormat[];
	_mediaFormats: InputFormat[];
	_parserPromise: Promise<ManifestParser> | null = null;
	_format: ManifestInputFormat | null = null;
	_entryReader!: Reader;
	_disposed = false;
	_encryptionKeyReaders = new Map<string, Promise<Reader>>();
	_nextSourceCacheAge = 0;
	_sourceCache: {
		path: string;
		sourcePromise: Promise<Source>;
		age: number;
	}[] = [];

	get disposed() {
		return this._disposed;
	}

	constructor(options: ManifestInputOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (typeof options.entryPath !== 'string') {
			throw new TypeError('options.entryPath must be a string.');
		}
		if (typeof options.getSource !== 'function') {
			throw new TypeError('options.getSource must be a function.');
		}
		if (
			!Array.isArray(options.manifestFormats)
			|| options.manifestFormats.some(x => !(x instanceof ManifestInputFormat))
		) {
			throw new TypeError('options.manifestFormats must be an array of ManifestInputFormat.');
		}
		if (
			!Array.isArray(options.mediaFormats)
			|| options.mediaFormats.some(x => !(x instanceof InputFormat))
		) {
			throw new TypeError('options.mediaFormats must be an array of InputFormat.');
		}

		this._entryPath = options.entryPath;
		this._manifestFormats = options.manifestFormats;
		this._mediaFormats = options.mediaFormats;

		this._getSourceUncached = async (path) => {
			const source = await options.getSource(path);
			if (!(source instanceof Source)) {
				throw new TypeError('The getSource function must return a Source.');
			}
			if (source._disposed) {
				throw new TypeError('The Source returned by getSource must not be disposed.');
			}

			return source;
		};
	}

	_getParser() {
		return this._parserPromise ??= (async () => {
			const entrySource = await this._getSourceUncached(this._entryPath);
			this._entryReader = await Reader.fromSource(entrySource);

			for (const format of this._manifestFormats) {
				const canRead = await format._canReadManifestInput(this);
				if (canRead) {
					this._format = format;
					return format._createParser(this);
				}
			}

			throw new Error('Manifest input has an unsupported or unrecognizable format.');
		})();
	}

	async getFormat() {
		await this._getParser();
		assert(this._format!);
		return this._format;
	}

	async getVariants(): Promise<ManifestInputVariant[]> {
		const parser = await this._getParser();
		const variants = await parser.getVariants();

		const sorted = [...variants]
			.sort((a, b) => {
				// Variants with unknown bitrate come last
				return (b.metadata.bitrate ?? b.metadata.averageBitrate ?? -Infinity)
					- (a.metadata.bitrate ?? a.metadata.averageBitrate ?? -Infinity);
			});

		return sorted;
	}

	async getPrimaryVariant() {
		const variants = await this.getVariants();
		return variants[0] ?? null;
	}

	async toInput() {
		// Create one "mega input" that contains all tracks from all variants
		const variants = await this.getVariants();
		const subInputs = variants.map(v => v.toInput());

		return new Input({
			source: new NullSource(),
			formats: [new VirtualInputFormat(input => new InputAggregateDemuxer(input, subInputs))],
		});
	}

	_getSourceCached(path: string) {
		const cachedEntry = this._sourceCache.find(x => x.path === path);
		if (cachedEntry) {
			cachedEntry.age++;
			return cachedEntry.sourcePromise;
		}

		const sourcePromise = Promise.resolve(this._getSourceUncached(path));
		this._sourceCache.push({
			path,
			sourcePromise,
			age: this._nextSourceCacheAge++,
		});

		const MAX_SOURCE_CACHE_SIZE = 4;
		if (this._sourceCache.length > MAX_SOURCE_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this._sourceCache, x => x.age);
			this._sourceCache.splice(minAgeIndex, 1);
		}

		return sourcePromise;
	}

	_getEncryptionKeyReader(path: string) {
		let cachedEntry = this._encryptionKeyReaders.get(path);
		if (cachedEntry) {
			return cachedEntry;
		}

		cachedEntry = Promise.resolve(this._getSourceUncached(path))
			.then(keySource => Reader.fromSource(keySource));
		this._encryptionKeyReaders.set(path, cachedEntry);

		return cachedEntry;
	}

	dispose() {
		if (this._disposed) {
			return;
		}

		this._disposed = true;
	}

	[Symbol.dispose]() {
		this.dispose();
	}
}
