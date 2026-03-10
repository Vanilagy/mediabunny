/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, MediaCodec, VideoCodec } from './codec';
import { determineVideoPacketType } from './codec-data';
import { customAudioDecoders, customVideoDecoders } from './custom-coder';
import { Input } from './input';
import { EncodedPacketSink, PacketRetrievalOptions } from './media-sink';
import { assert, MaybePromise, NonFunctionKeys, Rational, Rotation, simplifyRational } from './misc';
import { TrackType } from './output';
import { EncodedPacket, PacketType } from './packet';
import { TrackDisposition } from './metadata';

/**
 * Contains aggregate statistics about the encoded packets of a track.
 * @group Input files & tracks
 * @public
 */
export type PacketStats = {
	/** The total number of packets. */
	packetCount: number;
	/** The average number of packets per second. For video tracks, this will equal the average frame rate (FPS). */
	averagePacketRate: number;
	/** The average number of bits per second. */
	averageBitrate: number;
};

export interface InputTrackBacking {
	getId(): number;
	getNumber(): number;
	getCodec(): MediaCodec | null;
	getInternalCodecId(): string | number | Uint8Array | null;
	getName(): string | null;
	getLanguageCode(): string;
	getTimeResolution(): number;
	getTimestampsAreRelativeToUnixEpoch(): boolean;
	getDisposition(): TrackDisposition;
	getGroupId(): number;
	getPairingMask(): bigint;
	getBitrate(): number | null;
	getAverageBitrate(): number | null;
	getHasOnlyKeyPackets?(): boolean | null;

	getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;

	isHydrated?(): boolean;
	hydrate?(): Promise<void>;
}

/**
 * Represents a media track in an input file.
 * @group Input files & tracks
 * @public
 */
export abstract class InputTrack {
	/** The input file this track belongs to. */
	readonly input: Input;
	/** @internal */
	_backing: InputTrackBacking;
	/** @internal */
	_hydrationPromise: Promise<void> | null = null;

	/** @internal */
	constructor(input: Input, backing: InputTrackBacking) {
		this.input = input;
		this._backing = backing;
	}

	/** The type of the track. */
	abstract get type(): TrackType;
	/** The codec of the track's packets. */
	abstract get codec(): MediaCodec | null;
	/** Returns the full codec parameter string for this track. */
	abstract getCodecParameterString(): Promise<string | null>;
	/** Checks if this track's packets can be decoded by the browser. */
	abstract canDecode(): Promise<boolean>;
	/**
	 * For a given packet of this track, this method determines the actual type of this packet (key/delta) by looking
	 * into its bitstream. Returns null if the type couldn't be determined.
	 */
	abstract determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
	/** Whether the track metadata says that this track only contains key packets. The actual packets may differ. */
	abstract get hasOnlyKeyPackets(): boolean;

	/** Returns true if and only if this track is a video track. */
	isVideoTrack(): this is InputVideoTrack {
		return this instanceof InputVideoTrack;
	}

	/** Returns true if and only if this track is an audio track. */
	isAudioTrack(): this is InputAudioTrack {
		return this instanceof InputAudioTrack;
	}

	/** The unique ID of this track in the input file. */
	get id() {
		return this._backing.getId();
	}

	/**
	 * The 1-based index of this track among all tracks of the same type in the input file. For example, the first
	 * video track has number 1, the second video track has number 2, and so on. The index refers to the order in
	 * which the tracks are returned by {@link Input.getTracks}.
	 */
	get number() {
		return this._backing.getNumber();
	}

	get groupId() {
		return this._backing.getGroupId();
	}

	get pairingMask() {
		return this._backing.getPairingMask();
	}

	/**
	 * The identifier of the codec used internally by the container. It is not homogenized by Mediabunny
	 * and depends entirely on the container format.
	 *
	 * This field can be used to determine the codec of a track in case Mediabunny doesn't know that codec.
	 *
	 * - For ISOBMFF files, this field returns the name of the Sample Description Box (e.g. `'avc1'`).
	 * - For Matroska files, this field returns the value of the `CodecID` element.
	 * - For WAVE files, this field returns the value of the format tag in the `'fmt '` chunk.
	 * - For ADTS files, this field contains the `MPEG-4 Audio Object Type`.
	 * - For MPEG-TS files, this field contains the `streamType` value from the Program Map Table.
	 * - In all other cases, this field is `null`.
	 */
	get internalCodecId() {
		return this._backing.getInternalCodecId();
	}

	/**
	 * The ISO 639-2/T language code for this track. If the language is unknown, this field is `'und'` (undetermined).
	 */
	get languageCode() {
		return this._backing.getLanguageCode();
	}

	/** A user-defined name for this track. */
	get name() {
		return this._backing.getName();
	}

	/**
	 * A positive number x such that all timestamps and durations of all packets of this track are
	 * integer multiples of 1/x.
	 */
	get timeResolution() {
		return this._backing.getTimeResolution();
	}

	/**
	 * Whether the timestamps of this track are relative to the Unix epoch (January 1, 1970 00:00:00 UTC). When `true`,
	 * each timestamp maps to a definitive point in time.
	 */
	get timestampsAreRelativeToUnixEpoch() {
		return this._backing.getTimestampsAreRelativeToUnixEpoch();
	}

	/** The track's disposition, i.e. information about its intended usage. */
	get disposition() {
		return this._backing.getDisposition();
	}

	get bitrate() {
		return this._backing.getBitrate();
	}

	get averageBitrate() {
		return this._backing.getAverageBitrate();
	}

	/**
	 * Returns the start timestamp of the first packet of this track, in seconds. While often near zero, this value
	 * may be positive or even negative. A negative starting timestamp means the track's timing has been offset. Samples
	 * with a negative timestamp should not be presented.
	 */
	async getFirstTimestamp() {
		if (!this.isHydrated) {
			await this.hydrate();
		}

		const firstPacket = await this._backing.getFirstPacket({ metadataOnly: true });
		return firstPacket?.timestamp ?? 0;
	}

	/** Returns the end timestamp of the last packet of this track, in seconds. */
	async computeDuration() {
		if (!this.isHydrated) {
			await this.hydrate();
		}

		const lastPacket = await this._backing.getPacket(Infinity, { metadataOnly: true });
		return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
	}

	/**
	 * Computes aggregate packet statistics for this track, such as average packet rate or bitrate.
	 *
	 * @param targetPacketCount - This optional parameter sets a target for how many packets this method must have
	 * looked at before it can return early; this means, you can use it to aggregate only a subset (prefix) of all
	 * packets. This is very useful for getting a great estimate of video frame rate without having to scan through the
	 * entire file.
	 */
	async computePacketStats(targetPacketCount = Infinity): Promise<PacketStats> {
		const sink = new EncodedPacketSink(this);

		let startTimestamp = Infinity;
		let endTimestamp = -Infinity;
		let packetCount = 0;
		let totalPacketBytes = 0;

		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
			if (
				packetCount >= targetPacketCount
				// This additional condition is needed to produce correct results with out-of-presentation-order packets
				&& packet.timestamp >= endTimestamp
			) {
				break;
			}

			startTimestamp = Math.min(startTimestamp, packet.timestamp);
			endTimestamp = Math.max(endTimestamp, packet.timestamp + packet.duration);

			packetCount++;
			totalPacketBytes += packet.byteLength;
		}

		return {
			packetCount,
			averagePacketRate: packetCount
				? Number((packetCount / (endTimestamp - startTimestamp)).toPrecision(16))
				: 0,
			averageBitrate: packetCount
				? Number((8 * totalPacketBytes / (endTimestamp - startTimestamp)).toPrecision(16))
				: 0,
		};
	}

	get isHydrated() {
		return this._backing.isHydrated?.() ?? true;
	}

	hydrate(): Promise<void> {
		if (this.isHydrated || !this._backing.hydrate) {
			return Promise.resolve();
		}

		return this._hydrationPromise ??= this._backing.hydrate();
	}

	canBePairedWith(otherTrack: InputTrack | null) {
		if (!otherTrack) {
			return true;
		}

		return this.input === otherTrack.input
			&& this.groupId !== otherTrack.groupId // This also prevents the track from being paired with itself
			&& (this.pairingMask & otherTrack.pairingMask) !== 0n;
	}

	async getPairableTracks(query?: TrackQuery<InputTrack>) {
		const tracks = await this.input.getTracks();
		return queryTracks(tracks.filter(x => this.canBePairedWith(x)), query);
	}

	async pluckPairableTrack(query?: TrackQuery<InputTrack>) {
		return (await this.getPairableTracks(query))[0];
	}

	async getPairableVideoTracks(query?: TrackQuery<InputVideoTrack>) {
		const tracks = await this.getPairableTracks({
			filter: track => track.isVideoTrack(),
		});
		return queryTracks(tracks as InputVideoTrack[], query);
	}

	async pluckPairableVideoTrack(query?: TrackQuery<InputVideoTrack>) {
		return (await this.getPairableVideoTracks(query))[0] ?? null;
	}

	async getPairableAudioTracks(query?: TrackQuery<InputAudioTrack>) {
		const tracks = await this.getPairableTracks({
			filter: track => track.isAudioTrack(),
		});
		return queryTracks(tracks as InputAudioTrack[], query);
	}

	async pluckPairableAudioTrack(query?: TrackQuery<InputAudioTrack>) {
		return (await this.getPairableAudioTracks(query))[0] ?? null;
	}

	async getPrimaryPairableVideoTrack(query?: TrackQuery<InputVideoTrack>) {
		return this.input.getPrimaryVideoTrack(mergeTrackQueries({
			filter: track => track.canBePairedWith(this),
		}, query));
	}

	async getPrimaryPairableAudioTrack(query?: TrackQuery<InputAudioTrack>) {
		return this.input.getPrimaryAudioTrack(mergeTrackQueries({
			filter: track => track.canBePairedWith(this),
		}, query));
	}

	hasPairableTrack(predicate?: (track: InputTrack) => boolean) {
		assert(this.input._tracksCache);
		return this.input._tracksCache.some(x => this.canBePairedWith(x) && (!predicate || predicate(x)));
	}

	hasPairableVideoTrack(predictate?: (track: InputVideoTrack) => boolean): boolean {
		return this.hasPairableTrack(x =>
			x.isVideoTrack() && (!predictate || predictate(x)),
		);
	}

	hasPairableAudioTrack(predictate?: (track: InputAudioTrack) => boolean): boolean {
		return this.hasPairableTrack(x =>
			x.isAudioTrack() && (!predictate || predictate(x)),
		);
	}

	get<K extends NonFunctionKeys<this>>(key: K): this[K] | null {
		try {
			return this[key];
		} catch (error) {
			if (error instanceof TrackNotHydratedError) {
				return null;
			}

			throw error;
		}
	}

	async resolve<K extends NonFunctionKeys<this>>(key: K): Promise<this[K]> {
		try {
			return this[key];
		} catch (error) {
			if (error instanceof TrackNotHydratedError) {
				await this.hydrate();
				return this[key];
			}

			throw error;
		}
	}
}

export interface InputVideoTrackBacking extends InputTrackBacking {
	getCodec(): VideoCodec | null;
	getCodedWidth(): number;
	getCodedHeight(): number;
	getSquarePixelWidth(): number;
	getSquarePixelHeight(): number;
	getDisplayWidth?(): number | null;
	getDisplayHeight?(): number | null;
	getRotation(): Rotation;
	getColorSpace(): Promise<VideoColorSpaceInit>;
	canBeTransparent(): Promise<boolean>;
	getDecoderConfig(): Promise<VideoDecoderConfig | null>;
	getCodecParameterString?(): Promise<string | null>;
}

/**
 * Represents a video track in an input file.
 * @group Input files & tracks
 * @public
 */
export class InputVideoTrack extends InputTrack {
	/** @internal */
	override _backing: InputVideoTrackBacking;
	/** @internal */
	_pixelAspectRatioCache: Rational | null = null;

	/** @internal */
	constructor(input: Input, backing: InputVideoTrackBacking) {
		super(input, backing);

		this._backing = backing;
	}

	get type(): TrackType {
		return 'video';
	}

	get codec(): VideoCodec | null {
		return this._backing.getCodec();
	}

	get hasOnlyKeyPackets() {
		return this._backing.getHasOnlyKeyPackets?.() ?? false;
	}

	/** The width in pixels of the track's coded samples, before any transformations or rotations. */
	get codedWidth() {
		return this._backing.getCodedWidth();
	}

	/** The height in pixels of the track's coded samples, before any transformations or rotations. */
	get codedHeight() {
		return this._backing.getCodedHeight();
	}

	/** The angle in degrees by which the track's frames should be rotated (clockwise). */
	get rotation() {
		return this._backing.getRotation();
	}

	/** The width of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation. */
	get squarePixelWidth() {
		return this._backing.getSquarePixelWidth();
	}

	/** The height of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation. */
	get squarePixelHeight() {
		return this._backing.getSquarePixelHeight();
	}

	/**
	 * The pixel aspect ratio of the track's frames, as a rational number in its reduced form. Most videos use
	 * square pixels (1:1).
	 */
	get pixelAspectRatio() {
		return this._pixelAspectRatioCache ??= simplifyRational({
			num: this._backing.getSquarePixelWidth() * this._backing.getCodedHeight(),
			den: this._backing.getSquarePixelHeight() * this._backing.getCodedWidth(),
		});
	}

	/** The display width of the track's frames in pixels, after aspect ratio adjustment and rotation. */
	get displayWidth() {
		const customValue = this._backing.getDisplayWidth?.() ?? null;
		if (customValue !== null) {
			return customValue;
		}

		const rotation = this._backing.getRotation();
		return rotation % 180 === 0 ? this.squarePixelWidth : this.squarePixelHeight;
	}

	/** The display height of the track's frames in pixels, after aspect ratio adjustment and rotation. */
	get displayHeight() {
		const customValue = this._backing.getDisplayHeight?.() ?? null;
		if (customValue !== null) {
			return customValue;
		}

		const rotation = this._backing.getRotation();
		return rotation % 180 === 0 ? this.squarePixelHeight : this.squarePixelWidth;
	}

	/** Returns the color space of the track's samples. */
	async getColorSpace() {
		if (!this.isHydrated) {
			await this.hydrate();
		}

		return this._backing.getColorSpace();
	}

	/** If this method returns true, the track's samples use a high dynamic range (HDR). */
	async hasHighDynamicRange() {
		const colorSpace = await this._backing.getColorSpace();

		return (colorSpace.primaries as string) === 'bt2020' || (colorSpace.primaries as string) === 'smpte432'
			|| (colorSpace.transfer as string) === 'pg' || (colorSpace.transfer as string) === 'hlg'
			|| (colorSpace.matrix as string) === 'bt2020-ncl';
	}

	/** Checks if this track may contain transparent samples with alpha data. */
	async canBeTransparent() {
		if (!this.isHydrated) {
			await this.hydrate();
		}

		return this._backing.canBeTransparent();
	}

	/**
	 * Returns the [decoder configuration](https://www.w3.org/TR/webcodecs/#video-decoder-config) for decoding the
	 * track's packets using a [`VideoDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder). Returns
	 * null if the track's codec is unknown.
	 */
	async getDecoderConfig() {
		if (!this.isHydrated) {
			await this.hydrate();
		}

		return this._backing.getDecoderConfig();
	}

	async getCodecParameterString() {
		if (this._backing.getCodecParameterString) {
			return this._backing.getCodecParameterString();
		}

		if (!this.isHydrated) {
			await this.hydrate();
		}

		const decoderConfig = await this._backing.getDecoderConfig();
		return decoderConfig?.codec ?? null;
	}

	async canDecode() {
		try {
			if (!this.isHydrated) {
				await this.hydrate();
			}

			const decoderConfig = await this._backing.getDecoderConfig();
			if (!decoderConfig) {
				return false;
			}

			const codec = this._backing.getCodec();
			assert(codec !== null);

			if (customVideoDecoders.some(x => x.supports(codec, decoderConfig))) {
				return true;
			}

			if (typeof VideoDecoder === 'undefined') {
				return false;
			}

			const support = await VideoDecoder.isConfigSupported(decoderConfig);
			return support.supported === true;
		} catch (error) {
			console.error('Error during decodability check:', error);
			return false;
		}
	}

	async determinePacketType(packet: EncodedPacket): Promise<PacketType | null> {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		if (packet.isMetadataOnly) {
			throw new TypeError('packet must not be metadata-only to determine its type.');
		}

		if (this.codec === null) {
			return null;
		}

		const decoderConfig = await this.getDecoderConfig();
		assert(decoderConfig);

		return determineVideoPacketType(this.codec, decoderConfig, packet.data);
	}
}

export interface InputAudioTrackBacking extends InputTrackBacking {
	getCodec(): AudioCodec | null;
	getNumberOfChannels(): number;
	getSampleRate(): number;
	getDecoderConfig(): Promise<AudioDecoderConfig | null>;
	getCodecParameterString?(): Promise<string | null>;
}

/**
 * Represents an audio track in an input file.
 * @group Input files & tracks
 * @public
 */
export class InputAudioTrack extends InputTrack {
	/** @internal */
	override _backing: InputAudioTrackBacking;

	/** @internal */
	constructor(input: Input, backing: InputAudioTrackBacking) {
		super(input, backing);

		this._backing = backing;
	}

	get type(): TrackType {
		return 'audio';
	}

	get codec(): AudioCodec | null {
		return this._backing.getCodec();
	}

	get hasOnlyKeyPackets() {
		return this._backing.getHasOnlyKeyPackets?.() ?? true;
	}

	/** The number of audio channels in the track. */
	get numberOfChannels() {
		return this._backing.getNumberOfChannels();
	}

	/** The track's audio sample rate in hertz. */
	get sampleRate() {
		return this._backing.getSampleRate();
	}

	/**
	 * Returns the [decoder configuration](https://www.w3.org/TR/webcodecs/#audio-decoder-config) for decoding the
	 * track's packets using an [`AudioDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder). Returns
	 * null if the track's codec is unknown.
	 */
	async getDecoderConfig() {
		if (!this.isHydrated) {
			await this.hydrate();
		}

		return this._backing.getDecoderConfig();
	}

	async getCodecParameterString() {
		if (this._backing.getCodecParameterString) {
			return this._backing.getCodecParameterString();
		}

		if (!this.isHydrated) {
			await this.hydrate();
		}

		const decoderConfig = await this._backing.getDecoderConfig();
		return decoderConfig?.codec ?? null;
	}

	async canDecode() {
		try {
			if (!this.isHydrated) {
				await this.hydrate();
			}

			const decoderConfig = await this._backing.getDecoderConfig();
			if (!decoderConfig) {
				return false;
			}

			const codec = this._backing.getCodec();
			assert(codec !== null);

			if (customAudioDecoders.some(x => x.supports(codec, decoderConfig))) {
				return true;
			}

			if (decoderConfig.codec.startsWith('pcm-')) {
				return true; // Since we decode it ourselves
			} else {
				if (typeof AudioDecoder === 'undefined') {
					return false;
				}

				const support = await AudioDecoder.isConfigSupported(decoderConfig);
				return support.supported === true;
			}
		} catch (error) {
			console.error('Error during decodability check:', error);
			return false;
		}
	}

	async determinePacketType(packet: EncodedPacket): Promise<PacketType | null> {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}

		if (this.codec === null) {
			return null;
		}

		return 'key'; // No audio codec with delta packets
	}
}

export class TrackNotHydratedError extends Error {
	/** Creates a new {@link InputDisposedError}. */
	constructor(
		message = 'InputTrack is not hydrated; please call hydrate() first, or use the resolve() or get() methods.',
	) {
		super(message);
		this.name = 'TrackNotHydratedError';
	}
}

export type TrackQuery<T extends InputTrack> = {
	filter?: (track: T) => MaybePromise<boolean>;
	sortBy?: (track: T) => MaybePromise<number | number[]>;
};

export const mergeTrackQueries = <T extends InputTrack>(
	queryA: TrackQuery<T> | undefined,
	queryB: TrackQuery<T> | undefined,
): TrackQuery<T> => {
	return {
		filter: queryA?.filter || queryB?.filter
			? (track) => {
					const resultA = queryA?.filter?.(track) ?? true;
					const handleResultA = (resultA: boolean) => {
						if (resultA === false) {
							return false;
						}

						return queryB?.filter?.(track) ?? true;
					};

					if (resultA instanceof Promise) {
						return resultA.then(handleResultA);
					} else {
						return handleResultA(resultA);
					}
				}
			: undefined,
		sortBy: queryA?.sortBy || queryB?.sortBy
			? (track) => {
					const resultA = queryA?.sortBy?.(track) ?? [];
					const resultB = queryB?.sortBy?.(track) ?? [];

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

export const queryTracks = async <T extends InputTrack>(tracks: T[], query?: TrackQuery<T>): Promise<T[]> => {
	let matchedTracks = tracks;
	if (query?.filter) {
		const filterMatches = tracks.map(track => query.filter!(track));
		const hasAsyncFilter = filterMatches.some(x => x instanceof Promise);
		if (hasAsyncFilter) {
			// eslint-disable-next-line @typescript-eslint/await-thenable
			const resolvedFilterMatches = await Promise.all(filterMatches);
			matchedTracks = tracks.filter((_, i) => resolvedFilterMatches[i]);
		} else {
			matchedTracks = tracks.filter((_, i) => filterMatches[i] as boolean);
		}
	}

	if (!query?.sortBy) {
		return matchedTracks;
	}

	const sortValues = matchedTracks.map(track => query.sortBy!(track));
	const hasAsyncSort = sortValues.some(x => x instanceof Promise);
	const resolvedSortValues = hasAsyncSort
		// eslint-disable-next-line @typescript-eslint/await-thenable
		? await Promise.all(sortValues)
		: sortValues as (number | number[])[];

	return matchedTracks
		.map((track, i) => ({ track, sortValue: resolvedSortValues[i] }))
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
		.map(x => x.track);
};
