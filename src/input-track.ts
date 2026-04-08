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
import { assert, Rational, Rotation, roundToDivisor, simplifyRational } from './misc';
import { TrackType } from './output';
import { EncodedPacket, PacketType } from './packet';
import { TrackDisposition } from './metadata';
import { DurationMetadataRequestOptions } from './demuxer';
import {
	InputTrackDescriptor,
	mergeTrackDescriptorQueries,
	type InputVideoTrackDescriptor,
	type InputAudioTrackDescriptor,
	type TrackDescriptorQuery,
} from './input-track-descriptor';

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
	getCodec(): MediaCodec | null;
	getInternalCodecId(): string | number | Uint8Array | null;
	getName(): string | null;
	getLanguageCode(): string;
	getTimeResolution(): number | undefined;
	isRelativeToUnixEpoch(): boolean | undefined;
	getDisposition(): TrackDisposition;
	getPairingMask(): bigint;
	getBitrate(): number | null;
	getAverageBitrate(): number | null;
	getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null>;
	getLiveRefreshInterval(): Promise<number | null>;
	getHasOnlyKeyPackets?(): boolean | null;
	getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	getCodecParameterString?(): string | null;

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
		const value = this._backing.getTimeResolution();
		assert(value !== undefined);
		return value;
	}

	/**
	 * Whether the timestamps of this track are relative to the Unix epoch (January 1, 1970 00:00:00 UTC). When `true`,
	 * each timestamp maps to a definitive point in time.
	 */
	get isRelativeToUnixEpoch() {
		const value = this._backing.isRelativeToUnixEpoch();
		assert(value !== undefined);
		return value;
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

		return roundToDivisor(result, this.timeResolution);
	}

	/**
	 * Gets the duration (end timestamp) of this track from metadata stored in the file. This value may be
	 * approximate or diverge from the actual, precise duration returned by `.computeDuration()`, but compared to that
	 * method, this method is very cheap. When the duration cannot be determined from the file metadata, `null`
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

	async isLive() {
		return (await this._backing.getLiveRefreshInterval()) !== null;
	}

	async getLiveRefreshInterval() {
		return this._backing.getLiveRefreshInterval();
	}

	canBePairedWith(other: InputTrack | InputTrackDescriptor | null) {
		if (!(other instanceof InputTrack || other instanceof InputTrackDescriptor || other === null)) {
			throw new TypeError('other must be an InputTrack, InputTrackDescriptor, or null.');
		}

		if (!other) {
			return true;
		}

		if (this.input !== other.input || this === other) {
			return false;
		}

		return (this._backing.getPairingMask() & other._backing.getPairingMask()) !== 0n;
	}

	async getPairableTracks(query?: TrackDescriptorQuery<InputTrackDescriptor>) {
		const descriptors = await this.input.getTrackDescriptors(mergeTrackDescriptorQueries({
			filter: d => d.canBePairedWith(this),
		}, query));

		return Promise.all(descriptors.map(d => d.getTrack()));
	}

	async pluckPairableTrack(query?: TrackDescriptorQuery<InputTrackDescriptor>) {
		return (await this.getPairableTracks(query))[0] ?? null;
	}

	async getPairableVideoTracks(query?: TrackDescriptorQuery<InputVideoTrackDescriptor>) {
		const descriptors = await this.input.getVideoTrackDescriptors(mergeTrackDescriptorQueries({
			filter: d => d.canBePairedWith(this),
		}, query));

		return Promise.all(descriptors.map(d => d.getTrack()));
	}

	async pluckPairableVideoTrack(query?: TrackDescriptorQuery<InputVideoTrackDescriptor>) {
		return (await this.getPairableVideoTracks(query))[0] ?? null;
	}

	async getPairableAudioTracks(query?: TrackDescriptorQuery<InputAudioTrackDescriptor>) {
		const descriptors = await this.input.getAudioTrackDescriptors(mergeTrackDescriptorQueries({
			filter: d => d.canBePairedWith(this),
		}, query));

		return Promise.all(descriptors.map(d => d.getTrack()));
	}

	async pluckPairableAudioTrack(query?: TrackDescriptorQuery<InputAudioTrackDescriptor>) {
		return (await this.getPairableAudioTracks(query))[0] ?? null;
	}

	async getPrimaryPairableVideoTrack(query?: TrackDescriptorQuery<InputVideoTrackDescriptor>) {
		return this.input.getPrimaryVideoTrack(mergeTrackDescriptorQueries({
			filter: d => d.canBePairedWith(this),
		}, query));
	}

	async getPrimaryPairableAudioTrack(query?: TrackDescriptorQuery<InputAudioTrackDescriptor>) {
		return this.input.getPrimaryAudioTrack(mergeTrackDescriptorQueries({
			filter: d => d.canBePairedWith(this),
		}, query));
	}

	hasPairableTrack(predicate?: (descriptor: InputTrackDescriptor) => boolean) {
		predicate &&= toValidatedPredicate(predicate);

		const descriptors = [...this.input._backingToDescriptor.values()];
		return descriptors.some(x =>
			this.canBePairedWith(x) && (!predicate || predicate(x)),
		);
	}

	hasPairableVideoTrack(predicate?: (descriptor: InputVideoTrackDescriptor) => boolean) {
		predicate &&= toValidatedPredicate(predicate);

		return this.hasPairableTrack(x =>
			x.isVideoTrackDescriptor() && (!predicate || predicate(x)),
		);
	}

	hasPairableAudioTrack(predicate?: (descriptor: InputAudioTrackDescriptor) => boolean) {
		predicate &&= toValidatedPredicate(predicate);

		return this.hasPairableTrack(x =>
			x.isAudioTrackDescriptor() && (!predicate || predicate(x)),
		);
	}
}

const toValidatedPredicate = <T extends InputTrackDescriptor>(predicate?: (descriptor: T) => boolean) => {
	if (predicate !== undefined && typeof predicate !== 'function') {
		throw new TypeError('predicate, when provided, must be a function.');
	}

	return predicate
		? (desc: T) => {
				const result = predicate(desc);
				if (typeof result !== 'boolean') {
					throw new TypeError('predicate must return a boolean value.');
				}

				return result;
			}
		: undefined;
};

export interface InputVideoTrackBacking extends InputTrackBacking {
	getType(): 'video';
	getCodec(): VideoCodec | null;
	getCodedWidth(): number | undefined;
	getCodedHeight(): number | undefined;
	getSquarePixelWidth(): number | undefined;
	getSquarePixelHeight(): number | undefined;
	getMetadataDisplayWidth?(): number | null;
	getMetadataDisplayHeight?(): number | null;
	getRotation(): Rotation | undefined;
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

	get codec(): VideoCodec | null {
		return this._backing.getCodec();
	}

	get hasOnlyKeyPackets() {
		return this._backing.getHasOnlyKeyPackets?.() ?? false;
	}

	/** The width in pixels of the track's coded samples, before any transformations or rotations. */
	get codedWidth() {
		const value = this._backing.getCodedWidth();
		assert(value !== undefined);
		return value;
	}

	/** The height in pixels of the track's coded samples, before any transformations or rotations. */
	get codedHeight() {
		const value = this._backing.getCodedHeight();
		assert(value !== undefined);
		return value;
	}

	/** The angle in degrees by which the track's frames should be rotated (clockwise). */
	get rotation() {
		const value = this._backing.getRotation();
		assert(value !== undefined);
		return value;
	}

	/** The width of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation. */
	get squarePixelWidth() {
		const value = this._backing.getSquarePixelWidth();
		assert(value !== undefined);
		return value;
	}

	/** The height of the track's frames in square pixels, adjusted for pixel aspect ratio but before rotation. */
	get squarePixelHeight() {
		const value = this._backing.getSquarePixelHeight();
		assert(value !== undefined);
		return value;
	}

	/**
	 * The pixel aspect ratio of the track's frames, as a rational number in its reduced form. Most videos use
	 * square pixels (1:1).
	 */
	get pixelAspectRatio() {
		return this._pixelAspectRatioCache ??= simplifyRational({
			num: this.squarePixelWidth * this.codedHeight,
			den: this.squarePixelHeight * this.codedWidth,
		});
	}

	/** The display width of the track's frames in pixels, after aspect ratio adjustment and rotation. */
	get displayWidth() {
		return this.rotation % 180 === 0 ? this.squarePixelWidth : this.squarePixelHeight;
	}

	/** The display height of the track's frames in pixels, after aspect ratio adjustment and rotation. */
	get displayHeight() {
		return this.rotation % 180 === 0 ? this.squarePixelHeight : this.squarePixelWidth;
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
		const decoderConfig = await this._backing.getDecoderConfig();
		return decoderConfig?.codec ?? null;
	}

	async canDecode() {
		try {
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
	getType(): 'audio';
	getCodec(): AudioCodec | null;
	getNumberOfChannels(): number | undefined;
	getSampleRate(): number | undefined;
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

	get codec(): AudioCodec | null {
		return this._backing.getCodec();
	}

	get hasOnlyKeyPackets() {
		return this._backing.getHasOnlyKeyPackets?.() ?? true;
	}

	/** The number of audio channels in the track. */
	get numberOfChannels() {
		const value = this._backing.getNumberOfChannels();
		assert(value !== undefined);
		return value;
	}

	/** The track's audio sample rate in hertz. */
	get sampleRate() {
		const value = this._backing.getSampleRate();
		assert(value !== undefined);
		return value;
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
		const decoderConfig = await this._backing.getDecoderConfig();
		return decoderConfig?.codec ?? null;
	}

	async canDecode() {
		try {
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
