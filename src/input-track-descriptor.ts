/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, MediaCodec, VideoCodec } from './codec';
import { Input } from './input';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from './input-track';
import { TrackDisposition } from './metadata';
import { MaybePromise } from './misc';
import { TrackType } from './output';

/**
 * A lightweight descriptor for an {@link InputTrack}. Contains a subset of the track's properties, and can be
 * converted/upgraded to the full track via the {@link InputTrackDescriptor.getTrack} method.
 *
 * For some formats, such as HLS with master playlists, obtaining track descriptors is much cheaper than obtaining the
 * input track. These descriptors therefore can be used for efficient track selection and filtering without having to
 * expensively hydrate all input tracks.
 *
 * @group Input files & tracks
 * @public
 */
export abstract class InputTrackDescriptor {
	/** The input file this descriptor belongs to. */
	readonly input: Input;
	/** @internal */
	_backing: InputTrackBacking;

	/** @internal */
	constructor(input: Input, backing: InputTrackBacking) {
		this.input = input;
		this._backing = backing;
	}

	/** The unique ID of this track in the input file. */
	get id() {
		return this._backing.getId();
	}

	/** The 1-based index of this track among all tracks of the same type in the input file. */
	get number() {
		return this._backing.getNumber();
	}

	/** The type of the track. */
	abstract get type(): TrackType;

	/** Returns true if and only if this is a video track descriptor. */
	isVideoTrackDescriptor(): this is InputVideoTrackDescriptor {
		return this instanceof InputVideoTrackDescriptor;
	}

	/** Returns true if and only if this is an audio track descriptor. */
	isAudioTrackDescriptor(): this is InputAudioTrackDescriptor {
		return this instanceof InputAudioTrackDescriptor;
	}

	/** The codec of the track's packets, `undefined` if not yet known. */
	abstract get codec(): MediaCodec | null | undefined;

	/**
	 * The full codec parameter string (e.g. `'avc1.64001f'`), `undefined` if not yet known.
	 * This is typically available from HLS master playlists.
	 */
	get codecParameterString(): string | null | undefined {
		return this._backing.getCodecParameterString?.();
	}

	/** The ISO 639-2/T language code for this track, `undefined` if not yet known. */
	get languageCode(): string | undefined {
		return this._backing.getLanguageCode();
	}

	/** A user-defined name for this track, `undefined` if not yet known. */
	get name(): string | null | undefined {
		return this._backing.getName();
	}

	/** The track's disposition, i.e. information about its intended usage, `undefined` if not yet known. */
	get disposition(): TrackDisposition | undefined {
		return this._backing.getDisposition();
	}

	/**
	 * The peak bitrate of the track as specified in the track's metadata. This might not match the actual
	 * media data's bitrate.
	 */
	get bitrate(): number | null | undefined {
		return this._backing.getBitrate();
	}

	/**
	 * The average bitrate of the track as specified in the track's metadata. This might not match the actual
	 * media data's bitrate.
	 */
	get averageBitrate(): number | null | undefined {
		return this._backing.getAverageBitrate();
	}

	/** Whether the track metadata says that this track only contains key packets, `undefined` if not yet known. */
	abstract get hasOnlyKeyPackets(): boolean | undefined;

	/**
	 * Returns `true` if this descriptor can be paired with the given track or descriptor. Two tracks being pairable
	 * means they can be presented (displayed) together.
	 *
	 * Returns `false` if `other` equals `this`.
	 */
	canBePairedWith(other: InputTrackDescriptor | InputTrack) {
		if (!(other instanceof InputTrack || other instanceof InputTrackDescriptor)) {
			throw new TypeError('other must be an InputTrack or InputTrackDescriptor.');
		}

		if (this.input !== other.input || this === other) {
			return false;
		}

		return (this._backing.getPairingMask() & other._backing.getPairingMask()) !== 0n;
	}

	/**
	 * Gets the list of other descriptors that can be paired with this descriptor. An optional query can be provided
	 * to narrow down the results.
	 */
	async getPairableDescriptors(query?: InputTrackDescriptorQuery<InputTrackDescriptor>) {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptors = await this.input.getTrackDescriptors();
		return queryTrackDescriptors(
			descriptors.filter(x => this.canBePairedWith(x)),
			query,
		);
	}

	/**
	 * Gets the list of other video track descriptors that can be paired with this descriptor. An optional query can
	 * be provided to narrow down the results.
	 */
	async getPairableVideoTrackDescriptors(query?: InputTrackDescriptorQuery<InputVideoTrackDescriptor>) {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptors = await this.getPairableDescriptors();
		return queryTrackDescriptors(
			descriptors.filter((x): x is InputVideoTrackDescriptor => x.isVideoTrackDescriptor()),
			query,
		);
	}

	/**
	 * Gets the list of other audio track descriptors that can be paired with this descriptor. An optional query can
	 * be provided to narrow down the results.
	 */
	async getPairableAudioTrackDescriptors(query?: InputTrackDescriptorQuery<InputAudioTrackDescriptor>) {
		query &&= toValidatedTrackDescriptorQuery(query);

		const descriptors = await this.getPairableDescriptors();
		return queryTrackDescriptors(
			descriptors.filter((x): x is InputAudioTrackDescriptor => x.isAudioTrackDescriptor()),
			query,
		);
	}

	/** Returns `true` if there is another descriptor that can be paired with this descriptor. */
	hasPairableDescriptor(predicate?: (descriptor: InputTrackDescriptor) => boolean) {
		const descriptors = [...this.input._backingToDescriptor.values()];
		return descriptors.some(x => this.canBePairedWith(x) && (!predicate || predicate(x)));
	}

	/** Returns `true` if there is a video track that can be paired with this descriptor. */
	hasPairableVideoTrack(predicate?: (descriptor: InputVideoTrackDescriptor) => boolean) {
		return this.hasPairableDescriptor(x =>
			x.isVideoTrackDescriptor() && (!predicate || predicate(x)),
		);
	}

	/** Returns `true` if there is an audio track that can be paired with this descriptor. */
	hasPairableAudioTrack(predicate?: (descriptor: InputAudioTrackDescriptor) => boolean) {
		return this.hasPairableDescriptor(x =>
			x.isAudioTrackDescriptor() && (!predicate || predicate(x)),
		);
	}

	/**
	 * Loads the full media data for this track and returns a fully-loaded {@link InputTrack}. Calling this
	 * multiple times returns the same instance.
	 */
	async getTrack(): Promise<InputTrack> {
		return this.input._getTrackForBacking(this._backing);
	}
}

/**
 * A lightweight descriptor for an {@link InputVideoTrack}. See {@link InputTrackDescriptor} for details.
 *
 * @group Input files & tracks
 * @public
 */
export class InputVideoTrackDescriptor extends InputTrackDescriptor {
	/** @internal */
	override _backing: InputVideoTrackBacking;

	/** @internal */
	constructor(input: Input, backing: InputVideoTrackBacking) {
		super(input, backing);
		this._backing = backing;
	}

	get type(): TrackType {
		return 'video';
	}

	get hasOnlyKeyPackets(): boolean | undefined {
		return this._backing.getHasOnlyKeyPackets?.() ?? false;
	}

	get codec(): VideoCodec | null | undefined {
		return this._backing.getCodec();
	}

	/** The display width in pixels from metadata, `undefined` if not yet known. */
	get displayWidth(): number | undefined {
		const metadataWidth = this._backing.getMetadataDisplayWidth?.() ?? null;
		if (metadataWidth !== null) {
			return metadataWidth;
		}

		const rotation = this._backing.getRotation();
		const squarePixelWidth = this._backing.getSquarePixelWidth();
		const squarePixelHeight = this._backing.getSquarePixelHeight();

		if (rotation === undefined || squarePixelWidth === undefined || squarePixelHeight === undefined) {
			return undefined;
		}

		return rotation % 180 === 0 ? squarePixelWidth : squarePixelHeight;
	}

	/** The display height in pixels from metadata, `undefined` if not yet known. */
	get displayHeight(): number | undefined {
		const metadataHeight = this._backing.getMetadataDisplayHeight?.() ?? null;
		if (metadataHeight !== null) {
			return metadataHeight;
		}

		const rotation = this._backing.getRotation();
		const squarePixelWidth = this._backing.getSquarePixelWidth();
		const squarePixelHeight = this._backing.getSquarePixelHeight();

		if (rotation === undefined || squarePixelWidth === undefined || squarePixelHeight === undefined) {
			return undefined;
		}

		return rotation % 180 === 0 ? squarePixelHeight : squarePixelWidth;
	}

	override async getTrack(): Promise<InputVideoTrack> {
		return super.getTrack() as Promise<InputVideoTrack>;
	}
}

/**
 * A lightweight descriptor for an {@link InputAudioTrack}. See {@link InputTrackDescriptor} for details.
 *
 * @group Input files & tracks
 * @public
 */
export class InputAudioTrackDescriptor extends InputTrackDescriptor {
	/** @internal */
	override _backing: InputAudioTrackBacking;

	/** @internal */
	constructor(input: Input, backing: InputAudioTrackBacking) {
		super(input, backing);
		this._backing = backing;
	}

	get hasOnlyKeyPackets(): boolean | undefined {
		return this._backing.getHasOnlyKeyPackets?.() ?? true;
	}

	get type(): TrackType {
		return 'audio';
	}

	get codec(): AudioCodec | null | undefined {
		return this._backing.getCodec();
	}

	/** The number of audio channels, `undefined` if not yet known. */
	get numberOfChannels(): number | undefined {
		return this._backing.getNumberOfChannels();
	}

	/** The audio sample rate in hertz, `undefined` if not yet known. */
	get sampleRate(): number | undefined {
		return this._backing.getSampleRate();
	}

	override async getTrack(): Promise<InputAudioTrack> {
		return super.getTrack() as Promise<InputAudioTrack>;
	}
}

/**
 * Defines a query for track descriptors and, by extension, for tracks. Can be used to query tracks tersely and
 * expressively, which is especially useful for media inputs with many tracks, such as HLS manifests.
 *
 * @group Input files & tracks
 * @public
 */
export type InputTrackDescriptorQuery<T extends InputTrackDescriptor> = {
	/**
	 * A filter predicate function called for every track descriptor. Returning or resolving to `false` excludes the
	 * track from the result.
	 */
	filter?: (descriptor: T) => MaybePromise<boolean>;
	/**
	 * A function called for every track descriptor, used to define a track ordering. Tracks are ordered in ascending
	 * order using the value returned by this function. When the function returns an array of numbers `arr`, tracks will
	 * be sorted by `arr[0]` unless they have the same value, in which case they will be sorted by `arr[1]`, and so on.
	 * This allows you to construct a list of ordering criteria, sorted by importance.
	 *
	 * To help construct complex ordering criteria, the {@link asc}, {@link desc}, and {@link prefer} helper functions
	 * can be used.
	 */
	sortBy?: (descriptor: T) => MaybePromise<number | number[]>;
};

/**
 * Helper function for use in {@link InputTrackDescriptorQuery.sortBy}, used to describe sorting tracks by a numeric
 * property in ascending order. `null` and `undefined` are accepted too and are last in the order (sorted to the end).
 *
 * @group Input files & tracks
 * @public
 */
export const asc = (value: number | null | undefined) => {
	return value ?? Infinity; // nulls and undefined last
};

/**
 * Helper function for use in {@link InputTrackDescriptorQuery.sortBy}, used to describe sorting tracks by a numeric
 * property in descending order. `null` and `undefined` are accepted too and are last in the order (sorted to the end).
 *
 * @group Input files & tracks
 * @public
 */
export const desc = (value: number | null | undefined) => {
	return -(value ?? -Infinity); // nulls and undefined last
};

/**
 * Helper function for use in {@link InputTrackDescriptorQuery.sortBy}, used to sort tracks by boolean properties.
 * `true` is sorted to the start, `false` to the end. Useful for expressing soft preferences (e.g., "I'd prefer 1080p,
 * but other resolutions are fine too") as opposed to {@link InputTrackDescriptorQuery.filter} which expresses hard
 * requirements for tracks.
 *
 * @group Input files & tracks
 * @public
 */
export const prefer = (value: boolean) => {
	return -value;
};

export const toValidatedTrackDescriptorQuery = <T extends InputTrackDescriptor>(
	query: InputTrackDescriptorQuery<T>,
): InputTrackDescriptorQuery<T> => {
	if (typeof query !== 'object' || !query) {
		throw new TypeError('query must be an object.');
	}
	if (query.filter !== undefined && typeof query.filter !== 'function') {
		throw new TypeError('query.filter, when provided, must be a function.');
	}
	if (query.sortBy !== undefined && typeof query.sortBy !== 'function') {
		throw new TypeError('query.sortBy, when provided, must be a function.');
	}

	// Instead of validating the return types of the functions everywhere the query is used, simply return a new query
	// which wraps the old one while validating it.
	return {
		filter: query.filter
			? (desc) => {
					const handle = (bool: boolean) => {
						if (typeof bool !== 'boolean') {
							throw new TypeError('query.filter must return or resolve to a boolean.');
						}

						return bool;
					};

					const result = query.filter!(desc);
					if (result instanceof Promise) {
						return result.then(handle);
					} else {
						return handle(result);
					}
				}
			: undefined,
		sortBy: query.sortBy
			? (desc) => {
					const handle = (value: number | number[]) => {
						if (
							typeof value !== 'number'
							&& (!Array.isArray(value) || !value.every(x => typeof x === 'number'))
						) {
							throw new TypeError(
								'query.sortBy must return or resolve to a number or an array of numbers.',
							);
						}

						return value;
					};

					const result = query.sortBy!(desc);
					if (result instanceof Promise) {
						return result.then(handle);
					} else {
						return handle(result);
					}
				}
			: undefined,
	};
};

export const mergeTrackDescriptorQueries = <T extends InputTrackDescriptor>(
	queryA: InputTrackDescriptorQuery<T> | undefined,
	queryB: InputTrackDescriptorQuery<T> | undefined,
): InputTrackDescriptorQuery<T> => {
	return {
		filter: queryA?.filter || queryB?.filter
			? (descriptor) => {
					const resultA = queryA?.filter?.(descriptor) ?? true;
					const handleResultA = (resultA: boolean) => {
						if (resultA === false) {
							return false;
						}

						return queryB?.filter?.(descriptor) ?? true;
					};

					if (resultA instanceof Promise) {
						return resultA.then(handleResultA);
					} else {
						return handleResultA(resultA);
					}
				}
			: undefined,
		sortBy: queryA?.sortBy || queryB?.sortBy
			? (descriptor) => {
					const resultA = queryA?.sortBy?.(descriptor) ?? [];
					const resultB = queryB?.sortBy?.(descriptor) ?? [];

					type Result = Awaited<typeof resultA>;
					const join = (resultA: Result, resultB: Result) => {
						return [
							...(Array.isArray(resultA) ? resultA : [resultA]),
							...(Array.isArray(resultB) ? resultB : [resultB]),
						];
					};

					if (resultA instanceof Promise || resultB instanceof Promise) {
						return Promise.all([resultA, resultB]).then(([resultA, resultB]) => {
							return join(resultA, resultB);
						});
					} else {
						return join(resultA, resultB);
					}
				}
			: undefined,
	};
};

export const queryTrackDescriptors = async <T extends InputTrackDescriptor>(
	descriptors: T[],
	query?: InputTrackDescriptorQuery<T>,
): Promise<T[]> => {
	let matched = descriptors;
	if (query?.filter) {
		const filterMatches = descriptors.map(d => query.filter!(d));
		const hasAsyncFilter = filterMatches.some(x => x instanceof Promise);
		if (hasAsyncFilter) {
			// eslint-disable-next-line @typescript-eslint/await-thenable
			const resolvedFilterMatches = await Promise.all(filterMatches);
			matched = descriptors.filter((_, i) => resolvedFilterMatches[i]);
		} else {
			matched = descriptors.filter((_, i) => filterMatches[i] as boolean);
		}
	}

	if (!query?.sortBy) {
		return matched;
	}

	const sortValues = matched.map(d => query.sortBy!(d));
	const hasAsyncSort = sortValues.some(x => x instanceof Promise);
	const resolvedSortValues = hasAsyncSort
		// eslint-disable-next-line @typescript-eslint/await-thenable
		? await Promise.all(sortValues)
		: sortValues as (number | number[])[];

	return matched
		.map((descriptor, i) => ({ descriptor, sortValue: resolvedSortValues[i] }))
		.sort((a, b) => {
			const aValues = Array.isArray(a.sortValue) ? a.sortValue : [a.sortValue];
			const bValues = Array.isArray(b.sortValue) ? b.sortValue : [b.sortValue];
			const maxLength = Math.max(aValues.length, bValues.length);

			for (let i = 0; i < maxLength; i++) {
				const aValue = aValues[i] ?? 0;
				const bValue = bValues[i] ?? 0;
				if (aValue === bValue) {
					continue;
				}
				return aValue - bValue;
			}

			return 0;
		})
		.map(x => x.descriptor);
};
