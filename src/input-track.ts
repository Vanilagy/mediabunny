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
import { assert, MaybePromise, Rational, Rotation, roundToDivisor, simplifyRational } from './misc';
import { TrackType } from './output';
import { EncodedPacket, PacketType } from './packet';
import { TrackDisposition } from './metadata';
import { DurationMetadataRequestOptions } from './demuxer';

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
	getType(): TrackType;
	getId(): number;
	getNumber(): number;

	getCodec(): MaybePromise<MediaCodec | null>;
	getInternalCodecId(): MaybePromise<string | number | Uint8Array | null>;
	getName(): MaybePromise<string | null>;
	getLanguageCode(): MaybePromise<string>;
	getTimeResolution(): MaybePromise<number>;
	isRelativeToUnixEpoch(): MaybePromise<boolean>;
	getDisposition(): MaybePromise<TrackDisposition>;
	getPairingMask(): bigint;
	getBitrate(): MaybePromise<number | null>;
	getAverageBitrate(): MaybePromise<number | null>;
	getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null>;
	getLiveRefreshInterval(): Promise<number | null>;
	getHasOnlyKeyPackets?(): MaybePromise<boolean | null>;
	getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	getMetadataCodecParameterString?(): MaybePromise<string | null>;

	getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
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
	constructor(input: Input, backing: InputTrackBacking) {
		this.input = input;
		this._backing = backing;
	}

	/** The type of the track. */
	abstract get type(): TrackType;
	/** Returns the codec of the track's packets. */
	abstract getCodec(): Promise<MediaCodec | null>;
	/**
	 * The codec of the track's packets.
	 * @deprecated Use {@link InputTrack.getCodec} instead.
	 */
	// eslint-disable-next-line @typescript-eslint/no-deprecated
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
	/**
	 * Returns whether the track metadata says that this track only contains key packets. The actual packets may
	 * differ.
	 */
	abstract hasOnlyKeyPackets(): Promise<boolean>;

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

	/**
	 * Returns the identifier of the codec used internally by the container. It is not homogenized by Mediabunny
	 * and depends entirely on the container format.
	 *
	 * This method can be used to determine the codec of a track in case Mediabunny doesn't know that codec.
	 *
	 * - For ISOBMFF files, this resolves to the name of the Sample Description Box (e.g. `'avc1'`).
	 * - For Matroska files, this resolves to the value of the `CodecID` element.
	 * - For WAVE files, this resolves to the value of the format tag in the `'fmt '` chunk.
	 * - For ADTS files, this resolves to the `MPEG-4 Audio Object Type`.
	 * - For MPEG-TS files, this resolves to the `streamType` value from the Program Map Table.
	 * - In all other cases, this resolves to `null`.
	 */
	async getInternalCodecId() {
		return this._backing.getInternalCodecId();
	}

	/**
	 * See {@link InputTrack.getInternalCodecId}.
	 * @deprecated Use {@link InputTrack.getInternalCodecId} instead.
	 */
	get internalCodecId() {
		return requireSync(this._backing.getInternalCodecId(), 'internalCodecId', 'getInternalCodecId');
	}

	/**
	 * Returns the ISO 639-2/T language code for this track. If the language is unknown, this resolves to `'und'`
	 * (undetermined).
	 */
	async getLanguageCode() {
		return this._backing.getLanguageCode();
	}

	/**
	 * The ISO 639-2/T language code for this track. If the language is unknown, this field is `'und'` (undetermined).
	 * @deprecated Use {@link InputTrack.getLanguageCode} instead.
	 */
	get languageCode() {
		return requireSync(this._backing.getLanguageCode(), 'languageCode', 'getLanguageCode');
	}

	/** Returns the user-defined name for this track. */
	async getName() {
		return this._backing.getName();
	}

	/**
	 * A user-defined name for this track.
	 * @deprecated Use {@link InputTrack.getName} instead.
	 */
	get name() {
		return requireSync(this._backing.getName(), 'name', 'getName');
	}

	/**
	 * Returns a positive number x such that all timestamps and durations of all packets of this track are
	 * integer multiples of 1/x.
	 */
	async getTimeResolution() {
		return this._backing.getTimeResolution();
	}

	/**
	 * A positive number x such that all timestamps and durations of all packets of this track are
	 * integer multiples of 1/x.
	 * @deprecated Use {@link InputTrack.getTimeResolution} instead.
	 */
	get timeResolution() {
		return requireSync(this._backing.getTimeResolution(), 'timeResolution', 'getTimeResolution');
	}

	/**
	 * Returns whether the timestamps of this track are relative to the Unix epoch (January 1, 1970 00:00:00 UTC).
	 * When `true`, each timestamp maps to a definitive point in time.
	 */
	async isRelativeToUnixEpoch() {
		return this._backing.isRelativeToUnixEpoch();
	}

	/** Returns the track's disposition, i.e. information about its intended usage. */
	async getDisposition() {
		return this._backing.getDisposition();
	}

	/**
	 * The track's disposition, i.e. information about its intended usage.
	 * @deprecated Use {@link InputTrack.getDisposition} instead.
	 */
	get disposition() {
		return requireSync(this._backing.getDisposition(), 'disposition', 'getDisposition');
	}

	/**
	 * Returns the peak bitrate of the track in bits per second, as specified in the track's metadata. This might not
	 * match the actual media data's bitrate.
	 */
	async getBitrate() {
		return this._backing.getBitrate();
	}

	/**
	 * Returns the average bitrate of the track in bits per second, as specified in the track's metadata. This might
	 * not match the actual media data's bitrate.
	 */
	async getAverageBitrate() {
		return this._backing.getAverageBitrate();
	}

	/**
	 * Returns the start timestamp of the first packet of this track, in seconds. While often near zero, this value
	 * may be positive or even negative. A negative starting timestamp means the track's timing has been offset. Samples
	 * with a negative timestamp should not be presented.
	 */
	async getFirstTimestamp() {
		const firstPacket = await this._backing.getFirstPacket({ metadataOnly: true });
		return firstPacket?.timestamp ?? 0;
	}

	/**
	 * Returns the end timestamp of the last packet of this track, in seconds.
	 *
	 * By default, when the underlying media is live, this method will only resolve once the live stream ends. If you
	 * want to query the current end timestamp of the stream, set {@link PacketRetrievalOptions.skipLiveWait} to `true`
	 * in the options.
	 */
	async computeDuration(options?: PacketRetrievalOptions) {
		const lastPacket = await this._backing.getPacket(Infinity, { metadataOnly: true, ...options });
		const result = (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);

		return roundToDivisor(result, await this.getTimeResolution());
	}

	/**
	 * Gets the duration (end timestamp) in seconds of this track from metadata stored in the file. This value may be
	 * approximate or diverge from the actual, precise duration returned by `.computeDuration()`, but compared to that
	 * method, this method is cheaper. When the duration cannot be determined from the file metadata, `null`
	 * is returned.
	 *
	 * By default, when the underlying media is live, this method will only resolve once the live stream
	 * ends. If you want to query the current duration of the media, set
	 * {@link DurationMetadataRequestOptions.skipLiveWait} to `true` in the options.
	 */
	async getDurationFromMetadata(options: DurationMetadataRequestOptions = {}) {
		return this._backing.getDurationFromMetadata(options);
	}

	/**
	 * Computes aggregate packet statistics for this track, such as average packet rate or bitrate.
	 *
	 * @param targetPacketCount - This optional parameter sets a target for how many packets this method must have
	 * looked at before it can return early; this means, you can use it to aggregate only a subset (prefix) of all
	 * packets. This is very useful for getting a great estimate of video frame rate without having to scan through the
	 * entire file.
	 *
	 * By default, when the underlying media is live and `targetPacketCount` is not set, this method will only resolve
	 * once the live stream ends. If you want to query the current packet statistics of the stream, set
	 * {@link PacketRetrievalOptions.skipLiveWait} to `true` in the options.
	 */
	async computePacketStats(targetPacketCount = Infinity, options?: PacketRetrievalOptions): Promise<PacketStats> {
		const sink = new EncodedPacketSink(this);

		let startTimestamp = Infinity;
		let endTimestamp = -Infinity;
		let packetCount = 0;
		let totalPacketBytes = 0;

		for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true, ...options })) {
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

	/**
	 * Whether or not this track is currently live, meaning the media's end is still unknown.
	 *
	 * The value returned by this method may change over time as the track stops being live. To keep track of the
	 * track's live status, poll this method at the track's refresh interval
	 * via {@link InputTrack.getLiveRefreshInterval}.
	 */
	async isLive() {
		return (await this._backing.getLiveRefreshInterval()) !== null;
	}

	/**
	 * Returns the track's live refresh interval in seconds, or `null` if the track is not live. This interval describes
	 * the time it takes, on average, for new live media data to become available.
	 */
	async getLiveRefreshInterval() {
		return this._backing.getLiveRefreshInterval();
	}

	/**
	 * Returns `true` if this track can be paired with the given track. Two tracks being pairable means they can be
	 * presented (displayed) together.
	 *
	 * Returns `false` if `other` equals `this`.
	 */
	canBePairedWith(other: InputTrack) {
		if (!(other instanceof InputTrack)) {
			throw new TypeError('other must be an InputTrack.');
		}

		if (this.input !== other.input || this === other) {
			return false;
		}

		return (this._backing.getPairingMask() & other._backing.getPairingMask()) !== 0n;
	}

	/**
	 * Gets the list of other tracks that can be paired with this track. An optional query can be provided to narrow
	 * down the results.
	 */
	async getPairableTracks(query?: InputTrackQuery<InputTrack>) {
		return this.input.getTracks(mergeInputTrackQueries({
			filter: t => t.canBePairedWith(this),
		}, query));
	}

	/**
	 * Gets the list of other video tracks that can be paired with this track. An optional query can be provided to
	 * narrow down the results.
	 */
	async getPairableVideoTracks(query?: InputTrackQuery<InputVideoTrack>) {
		return this.input.getVideoTracks(mergeInputTrackQueries({
			filter: t => t.canBePairedWith(this),
		}, query));
	}

	/**
	 * Gets the list of other audio tracks that can be paired with this track. An optional query can be provided to
	 * narrow down the results.
	 */
	async getPairableAudioTracks(query?: InputTrackQuery<InputAudioTrack>) {
		return this.input.getAudioTracks(mergeInputTrackQueries({
			filter: t => t.canBePairedWith(this),
		}, query));
	}

	/** Returns the primary track that can be paired with this track, optionally steered by the provided query. */
	async getPrimaryPairableVideoTrack(query?: InputTrackQuery<InputVideoTrack>) {
		return this.input.getPrimaryVideoTrack(mergeInputTrackQueries({
			filter: t => t.canBePairedWith(this),
		}, query));
	}

	/** Returns the primary track that can be paired with this track, optionally steered by the provided query. */
	async getPrimaryPairableAudioTrack(query?: InputTrackQuery<InputAudioTrack>) {
		return this.input.getPrimaryAudioTrack(mergeInputTrackQueries({
			filter: t => t.canBePairedWith(this),
		}, query));
	}

	/** Returns `true` if there is another track that can be paired with this track. */
	async hasPairableTrack(predicate?: (track: InputTrack) => MaybePromise<boolean>): Promise<boolean> {
		predicate &&= toValidatedPredicate(predicate);

		const tracks = await this.input.getTracks();
		for (const track of tracks) {
			if (!this.canBePairedWith(track)) {
				continue;
			}
			if (!predicate || await predicate(track)) {
				return true;
			}
		}

		return false;
	}

	/** Returns `true` if there is a video track that can be paired with this track. */
	hasPairableVideoTrack(predicate?: (track: InputVideoTrack) => MaybePromise<boolean>): Promise<boolean> {
		predicate &&= toValidatedPredicate(predicate);

		return this.hasPairableTrack(async x =>
			x.isVideoTrack() && (!predicate || await predicate(x)),
		);
	}

	/** Returns `true` if there is an audio track that can be paired with this track. */
	hasPairableAudioTrack(predicate?: (track: InputAudioTrack) => MaybePromise<boolean>): Promise<boolean> {
		predicate &&= toValidatedPredicate(predicate);

		return this.hasPairableTrack(async x =>
			x.isAudioTrack() && (!predicate || await predicate(x)),
		);
	}
}

const requireSync = <T>(value: MaybePromise<T>, getterName: string, asyncName: string): T => {
	if (value instanceof Promise) {
		throw new Error(
			`'${getterName}' is deprecated and not available synchronously for this track. Use the preferred`
			+ ` '${asyncName}()' instead.`,
		);
	}
	return value;
};

const toValidatedPredicate = <T extends InputTrack>(
	predicate?: (track: T) => MaybePromise<boolean>,
) => {
	if (predicate !== undefined && typeof predicate !== 'function') {
		throw new TypeError('predicate, when provided, must be a function.');
	}

	return predicate
		? (track: T) => {
				const handle = (result: boolean) => {
					if (typeof result !== 'boolean') {
						throw new TypeError('predicate must return or resolve to a boolean value.');
					}
					return result;
				};

				const result = predicate(track);
				if (result instanceof Promise) {
					return result.then(handle);
				}
				return handle(result);
			}
		: undefined;
};

export interface InputVideoTrackBacking extends InputTrackBacking {
	getType(): 'video';
	getCodec(): MaybePromise<VideoCodec | null>;
	getCodedWidth(): MaybePromise<number>;
	getCodedHeight(): MaybePromise<number>;
	getSquarePixelWidth(): MaybePromise<number>;
	getSquarePixelHeight(): MaybePromise<number>;
	getMetadataDisplayWidth?(): MaybePromise<number | null>;
	getMetadataDisplayHeight?(): MaybePromise<number | null>;
	getRotation(): MaybePromise<Rotation>;
	getColorSpace(): Promise<VideoColorSpaceInit>;
	canBeTransparent(): Promise<boolean>;
	getDecoderConfig(): Promise<VideoDecoderConfig | null>;
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

	/** The codec of the track's packets. */
	async getCodec(): Promise<VideoCodec | null> {
		return this._backing.getCodec();
	}

	/**
	 * The codec of the track's packets.
	 * @deprecated Use {@link InputVideoTrack.getCodec} instead.
	 */
	get codec(): VideoCodec | null {
		return requireSync(this._backing.getCodec(), 'codec', 'getCodec');
	}

	async hasOnlyKeyPackets() {
		return (await this._backing.getHasOnlyKeyPackets?.()) ?? false;
	}

	/** Returns the width in pixels of the track's coded samples, before any transformations or rotations. */
	async getCodedWidth() {
		return this._backing.getCodedWidth();
	}

	/**
	 * The width in pixels of the track's coded samples, before any transformations or rotations.
	 * @deprecated Use {@link InputVideoTrack.getCodedWidth} instead.
	 */
	get codedWidth() {
		return requireSync(this._backing.getCodedWidth(), 'codedWidth', 'getCodedWidth');
	}

	/** Returns the height in pixels of the track's coded samples, before any transformations or rotations. */
	async getCodedHeight() {
		return this._backing.getCodedHeight();
	}

	/**
	 * The height in pixels of the track's coded samples, before any transformations or rotations.
	 * @deprecated Use {@link InputVideoTrack.getCodedHeight} instead.
	 */
	get codedHeight() {
		return requireSync(this._backing.getCodedHeight(), 'codedHeight', 'getCodedHeight');
	}

	/** Returns the angle in degrees by which the track's frames should be rotated (clockwise). */
	async getRotation() {
		return this._backing.getRotation();
	}

	/**
	 * The angle in degrees by which the track's frames should be rotated (clockwise).
	 * @deprecated Use {@link InputVideoTrack.getRotation} instead.
	 */
	get rotation() {
		return requireSync(this._backing.getRotation(), 'rotation', 'getRotation');
	}

	/**
	 * Returns the width of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation.
	 */
	async getSquarePixelWidth() {
		return this._backing.getSquarePixelWidth();
	}

	/**
	 * The width of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation.
	 * @deprecated Use {@link InputVideoTrack.getSquarePixelWidth} instead.
	 */
	get squarePixelWidth() {
		return requireSync(this._backing.getSquarePixelWidth(), 'squarePixelWidth', 'getSquarePixelWidth');
	}

	/**
	 * Returns the height of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation.
	 */
	async getSquarePixelHeight() {
		return this._backing.getSquarePixelHeight();
	}

	/**
	 * The height of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation.
	 * @deprecated Use {@link InputVideoTrack.getSquarePixelHeight} instead.
	 */
	get squarePixelHeight() {
		return requireSync(this._backing.getSquarePixelHeight(), 'squarePixelHeight', 'getSquarePixelHeight');
	}

	/**
	 * Returns the pixel aspect ratio of the track's frames as a rational number in its reduced form. Most videos use
	 * square pixels (1:1).
	 */
	async getPixelAspectRatio() {
		// Potential minor async race condition here if called twice, but doesn't matter since the computation is
		// so cheap
		return this._pixelAspectRatioCache ??= simplifyRational({
			num: (await this.getSquarePixelWidth()) * (await this.getCodedHeight()),
			den: (await this.getSquarePixelHeight()) * (await this.getCodedWidth()),
		});
	}

	/**
	 * The pixel aspect ratio of the track's frames, as a rational number in its reduced form. Most videos use
	 * square pixels (1:1).
	 * @deprecated Use {@link InputVideoTrack.getPixelAspectRatio} instead.
	 */
	get pixelAspectRatio() {
		return this._pixelAspectRatioCache ??= simplifyRational({
			num: requireSync(this._backing.getSquarePixelWidth(), 'pixelAspectRatio', 'getPixelAspectRatio')
				* requireSync(this._backing.getCodedHeight(), 'pixelAspectRatio', 'getPixelAspectRatio'),
			den: requireSync(this._backing.getSquarePixelHeight(), 'pixelAspectRatio', 'getPixelAspectRatio')
				* requireSync(this._backing.getCodedWidth(), 'pixelAspectRatio', 'getPixelAspectRatio'),
		});
	}

	/** Returns the display width of the track's frames in pixels, after aspect ratio adjustment and rotation. */
	async getDisplayWidth() {
		const metadata = await this._backing.getMetadataDisplayWidth?.();
		if (metadata != null) {
			return metadata;
		}

		const rotation = await this.getRotation();
		return rotation % 180 === 0 ? this.getSquarePixelWidth() : this.getSquarePixelHeight();
	}

	/**
	 * The display width of the track's frames in pixels, after aspect ratio adjustment and rotation.
	 * @deprecated Use {@link InputVideoTrack.getDisplayWidth} instead.
	 */
	get displayWidth() {
		const metadataRaw = this._backing.getMetadataDisplayWidth?.();
		if (metadataRaw !== undefined) {
			const metadata = requireSync(metadataRaw, 'displayWidth', 'getDisplayWidth');
			if (metadata !== null) {
				return metadata;
			}
		}

		const rotation = requireSync(this._backing.getRotation(), 'displayWidth', 'getDisplayWidth');
		const value = rotation % 180 === 0
			? this._backing.getSquarePixelWidth()
			: this._backing.getSquarePixelHeight();
		return requireSync(value, 'displayWidth', 'getDisplayWidth');
	}

	/** Returns the display height of the track's frames in pixels, after aspect ratio adjustment and rotation. */
	async getDisplayHeight() {
		const metadata = await this._backing.getMetadataDisplayHeight?.();
		if (metadata != null) {
			return metadata;
		}

		const rotation = await this.getRotation();
		return rotation % 180 === 0 ? this.getSquarePixelHeight() : this.getSquarePixelWidth();
	}

	/**
	 * The display height of the track's frames in pixels, after aspect ratio adjustment and rotation.
	 * @deprecated Use {@link InputVideoTrack.getDisplayHeight} instead.
	 */
	get displayHeight() {
		const metadataRaw = this._backing.getMetadataDisplayHeight?.();
		if (metadataRaw !== undefined) {
			const metadata = requireSync(metadataRaw, 'displayHeight', 'getDisplayHeight');
			if (metadata !== null) {
				return metadata;
			}
		}

		const rotation = requireSync(this._backing.getRotation(), 'displayHeight', 'getDisplayHeight');
		const value = rotation % 180 === 0
			? this._backing.getSquarePixelHeight()
			: this._backing.getSquarePixelWidth();
		return requireSync(value, 'displayHeight', 'getDisplayHeight');
	}

	/** Returns the color space of the track's samples. */
	async getColorSpace() {
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
		return this._backing.canBeTransparent();
	}

	/**
	 * Returns the [decoder configuration](https://www.w3.org/TR/webcodecs/#video-decoder-config) for decoding the
	 * track's packets using a [`VideoDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder). Returns
	 * null if the track's codec is unknown.
	 */
	async getDecoderConfig() {
		return this._backing.getDecoderConfig();
	}

	async getCodecParameterString() {
		const fromMetadata = await this._backing.getMetadataCodecParameterString?.();
		if (fromMetadata != null) {
			return fromMetadata;
		}

		const decoderConfig = await this._backing.getDecoderConfig();
		return decoderConfig?.codec ?? null;
	}

	async canDecode() {
		try {
			const decoderConfig = await this._backing.getDecoderConfig();
			if (!decoderConfig) {
				return false;
			}

			const codec = await this._backing.getCodec();
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

		const codec = await this.getCodec();
		if (codec === null) {
			return null;
		}

		const decoderConfig = await this.getDecoderConfig();
		assert(decoderConfig);

		return determineVideoPacketType(codec, decoderConfig, packet.data);
	}
}

export interface InputAudioTrackBacking extends InputTrackBacking {
	getType(): 'audio';
	getCodec(): MaybePromise<AudioCodec | null>;
	getNumberOfChannels(): MaybePromise<number>;
	getSampleRate(): MaybePromise<number>;
	getDecoderConfig(): Promise<AudioDecoderConfig | null>;
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

	/** The codec of the track's packets. */
	async getCodec(): Promise<AudioCodec | null> {
		return this._backing.getCodec();
	}

	/**
	 * The codec of the track's packets.
	 * @deprecated Use {@link InputAudioTrack.getCodec} instead.
	 */
	get codec(): AudioCodec | null {
		return requireSync(this._backing.getCodec(), 'codec', 'getCodec');
	}

	async hasOnlyKeyPackets() {
		return (await this._backing.getHasOnlyKeyPackets?.()) ?? true;
	}

	/** Returns the number of audio channels in the track. */
	async getNumberOfChannels() {
		return this._backing.getNumberOfChannels();
	}

	/**
	 * The number of audio channels in the track.
	 * @deprecated Use {@link InputAudioTrack.getNumberOfChannels} instead.
	 */
	get numberOfChannels() {
		return requireSync(this._backing.getNumberOfChannels(), 'numberOfChannels', 'getNumberOfChannels');
	}

	/** Returns the track's audio sample rate in hertz. */
	async getSampleRate() {
		return this._backing.getSampleRate();
	}

	/**
	 * The track's audio sample rate in hertz.
	 * @deprecated Use {@link InputAudioTrack.getSampleRate} instead.
	 */
	get sampleRate() {
		return requireSync(this._backing.getSampleRate(), 'sampleRate', 'getSampleRate');
	}

	/**
	 * Returns the [decoder configuration](https://www.w3.org/TR/webcodecs/#audio-decoder-config) for decoding the
	 * track's packets using an [`AudioDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder). Returns
	 * null if the track's codec is unknown.
	 */
	async getDecoderConfig() {
		return this._backing.getDecoderConfig();
	}

	async getCodecParameterString() {
		const fromMetadata = await this._backing.getMetadataCodecParameterString?.();
		if (fromMetadata != null) {
			return fromMetadata;
		}

		const decoderConfig = await this._backing.getDecoderConfig();
		return decoderConfig?.codec ?? null;
	}

	async canDecode() {
		try {
			const decoderConfig = await this._backing.getDecoderConfig();
			if (!decoderConfig) {
				return false;
			}

			const codec = await this._backing.getCodec();
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

		if ((await this.getCodec()) === null) {
			return null;
		}

		return 'key'; // No audio codec with delta packets
	}
}

/**
 * Defines a query for input tracks. Can be used to query tracks tersely and expressively, which is especially useful
 * for media inputs with many tracks, such as HLS manifests.
 *
 * @group Input files & tracks
 * @public
 */
export type InputTrackQuery<T extends InputTrack> = {
	/**
	 * A filter predicate function called for every track. Returning or resolving to `false` excludes the track from
	 * the result.
	 */
	filter?: (track: T) => MaybePromise<boolean>;
	/**
	 * A function called for every track, used to define a track ordering. Tracks are ordered in ascending order using
	 * the value returned by this function. When the function returns an array of numbers `arr`, tracks will be sorted
	 * by `arr[0]` unless they have the same value, in which case they will be sorted by `arr[1]`, and so on. This
	 * allows you to construct a list of ordering criteria, sorted by importance.
	 *
	 * To help construct complex ordering criteria, the {@link asc}, {@link desc}, and {@link prefer} helper functions
	 * can be used.
	 */
	sortBy?: (track: T) => MaybePromise<number | number[]>;
};

/**
 * Helper function for use in {@link InputTrackQuery.sortBy}, used to describe sorting tracks by a numeric property in
 * ascending order. `null` and `undefined` are accepted too and are last in the order (sorted to the end).
 *
 * @group Input files & tracks
 * @public
 */
export const asc = (value: number | null | undefined) => {
	return value ?? Infinity; // nulls and undefined last
};

/**
 * Helper function for use in {@link InputTrackQuery.sortBy}, used to describe sorting tracks by a numeric property in
 * descending order. `null` and `undefined` are accepted too and are last in the order (sorted to the end).
 *
 * @group Input files & tracks
 * @public
 */
export const desc = (value: number | null | undefined) => {
	return -(value ?? -Infinity); // nulls and undefined last
};

/**
 * Helper function for use in {@link InputTrackQuery.sortBy}, used to sort tracks by boolean properties. `true` is
 * sorted to the start, `false` to the end. Useful for expressing soft preferences (e.g., "I'd prefer 1080p, but other
 * resolutions are fine too") as opposed to {@link InputTrackQuery.filter} which expresses hard requirements for
 * tracks.
 *
 * @group Input files & tracks
 * @public
 */
export const prefer = (value: boolean) => {
	return -value;
};

export const toValidatedInputTrackQuery = <T extends InputTrack>(
	query: InputTrackQuery<T>,
): InputTrackQuery<T> => {
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
			? (track) => {
					const handle = (bool: boolean) => {
						if (typeof bool !== 'boolean') {
							throw new TypeError('query.filter must return or resolve to a boolean.');
						}

						return bool;
					};

					const result = query.filter!(track);
					if (result instanceof Promise) {
						return result.then(handle);
					} else {
						return handle(result);
					}
				}
			: undefined,
		sortBy: query.sortBy
			? (track) => {
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

					const result = query.sortBy!(track);
					if (result instanceof Promise) {
						return result.then(handle);
					} else {
						return handle(result);
					}
				}
			: undefined,
	};
};

export const mergeInputTrackQueries = <T extends InputTrack>(
	queryA: InputTrackQuery<T> | undefined,
	queryB: InputTrackQuery<T> | undefined,
): InputTrackQuery<T> => {
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

export const queryInputTracks = async <T extends InputTrack>(
	tracks: T[],
	query?: InputTrackQuery<T>,
): Promise<T[]> => {
	let matched = tracks;
	if (query?.filter) {
		const filterMatches = tracks.map(t => query.filter!(t));
		const hasAsyncFilter = filterMatches.some(x => x instanceof Promise);
		if (hasAsyncFilter) {
			// eslint-disable-next-line @typescript-eslint/await-thenable
			const resolvedFilterMatches = await Promise.all(filterMatches);
			matched = tracks.filter((_, i) => resolvedFilterMatches[i]);
		} else {
			matched = tracks.filter((_, i) => filterMatches[i] as boolean);
		}
	}

	if (!query?.sortBy) {
		return matched;
	}

	const sortValues = matched.map(t => query.sortBy!(t));
	const hasAsyncSort = sortValues.some(x => x instanceof Promise);
	const resolvedSortValues = hasAsyncSort
		// eslint-disable-next-line @typescript-eslint/await-thenable
		? await Promise.all(sortValues)
		: sortValues as (number | number[])[];

	return matched
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
