/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AUDIO_CODECS, AudioCodec, PCM_AUDIO_CODECS, VIDEO_CODECS, VideoCodec } from './codec';
import { Demuxer, DurationMetadataRequestOptions } from './demuxer';
import { Input, InputDisposedError } from './input';
import { InputFormat } from './input-format';
import { InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking } from './input-track';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition, validateTrackDisposition } from './metadata';
import { MaybePromise, MaybeRelevantPromise, ResultValue, Rotation, UNDETERMINED_LANGUAGE } from './misc';
import { Muxer } from './muxer';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack, TrackType } from './output';
import { OutputFormat } from './output-format';
import { EncodedPacket, PacketRetrievalOptions } from './packet';
import { FileSlice } from './reader';
import { SubtitleCue, SubtitleMetadata } from './subtitles';
import { Target } from './target';
import { MuxerWriter } from './writer';

/**
 * Provides access to the bytes of an input file. Slices may share cached storage; their bytes must not be modified.
 * @group Custom containers
 * @public
 */
export type DemuxerReader = {
	/** The file size in bytes, or `null` if it isn't known yet. Reading may make the size available. */
	readonly fileSize: number | null;
	/** Requests exactly the given byte range, returning `null` if any of it lies outside the file. */
	requestSlice(start: number, length: number): MaybePromise<FileSlice | null>;
	/** Requests between `minLength` and `maxLength` bytes, returning `null` if `minLength` bytes aren't available. */
	requestSliceRange(start: number, minLength: number, maxLength: number): MaybePromise<FileSlice | null>;
};

/**
 * Information provided when probing an input file or creating a custom demuxer.
 * @group Custom containers
 * @public
 */
export type DemuxerContext = {
	/** The reader for this input file. */
	readonly reader: DemuxerReader;
	/** Aborted when the input is disposed. */
	readonly signal: AbortSignal;
};

/**
 * The common properties of a custom input track.
 *
 * Packet retrieval must support independent cursors: the packet passed to a method determines its position, and
 * calls for different positions may overlap.
 *
 * Returned packets must have stable, non-negative sequence numbers in decode order. For `metadataOnly` requests, use
 * {@link EncodedPacket.metadataOnly} with the same timing, sequence number and byte length, without reading payloads.
 *
 * @group Custom containers
 * @public
 */
export type BaseCustomTrack = {
	/** A unique ID within the input file. */
	id: number;
	/** The number of timestamp units per second. */
	timeResolution: number;
	/** The codec identifier stored in the container, if available. */
	internalCodecId?: string | number | Uint8Array | null;
	/** The track name, if available. */
	name?: string | null;
	/** The ISO 639-2/T language code. Defaults to `'und'`. */
	languageCode?: string;
	/** Track disposition flags. Unspecified flags default to `false`. */
	disposition?: Partial<TrackDisposition>;
	/** Tracks with overlapping masks are pairable. Defaults to `1n`, making all tracks pairable. */
	pairingMask?: bigint;
	/** The declared bitrate in bits per second, if available. */
	bitrate?: number | null;
	/** The average bitrate in bits per second, if available. */
	averageBitrate?: number | null;
	/** Whether every packet is a key packet, if known. */
	hasOnlyKeyPackets?: boolean;
	/** Whether timestamps are measured from the Unix epoch. Defaults to `false`. */
	isRelativeToUnixEpoch?: boolean;
	/** Returns the Unix time for a timestamp in seconds, or `null` if it isn't known. */
	getUnixTimeForTimestamp?(timestamp: number): MaybePromise<number | null>;
	/** Returns the duration in seconds stored in the container, or `null` if it isn't known. */
	getDurationFromMetadata?(options: DurationMetadataRequestOptions): MaybePromise<number | null>;
	/** Returns the refresh interval for a live track in seconds, or `null` for a non-live track. */
	getLiveRefreshInterval?(): MaybePromise<number | null>;
	/** Returns the codec parameter string stored in the container, if available. */
	getCodecParameterString?(): MaybePromise<string | null>;
	/** Returns the first packet in decode order, or `null` if the track is empty. */
	getFirstPacket(options: PacketRetrievalOptions): MaybePromise<EncodedPacket | null>;
	/** Returns the packet after the given packet in decode order, or `null` at the end of the track. */
	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): MaybePromise<EncodedPacket | null>;
	/**
	 * Returns the last packet at or before the timestamp in presentation order. `Infinity` requests the last packet.
	 */
	getPacket(timestamp: number, options: PacketRetrievalOptions): MaybePromise<EncodedPacket | null>;
	/** Returns the last key packet at or before the timestamp, or `null` if there is none. */
	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): MaybePromise<EncodedPacket | null>;
	/** Returns the next key packet in decode order, or `null` if there is none. */
	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): MaybePromise<EncodedPacket | null>;
};

/**
 * A video track provided by a custom demuxer.
 * @group Custom containers
 * @public
 */
export type CustomVideoTrack = BaseCustomTrack & {
	/** The track type. */
	type: 'video';
	/** The codec, or `null` if it couldn't be identified. */
	codec: VideoCodec | null;
	/** The coded width in pixels. */
	codedWidth: number;
	/** The coded height in pixels. */
	codedHeight: number;
	/** The width after adjusting for pixel aspect ratio. Defaults to `codedWidth`. */
	squarePixelWidth?: number;
	/** The height after adjusting for pixel aspect ratio. Defaults to `codedHeight`. */
	squarePixelHeight?: number;
	/** The display width stored in the container, if available. */
	displayWidth?: number;
	/** The display height stored in the container, if available. */
	displayHeight?: number;
	/** The clockwise rotation in degrees, defaulting to zero. */
	rotation?: Rotation;
	/** The color space stored in the container. */
	colorSpace?: VideoColorSpaceInit;
	/** Whether the video can contain transparency. Defaults to `false`. */
	canBeTransparent?: boolean;
	/** Returns the decoder configuration, or `null` if there is none. */
	getDecoderConfig(): MaybePromise<VideoDecoderConfig | null>;
};

/**
 * An audio track provided by a custom demuxer.
 * @group Custom containers
 * @public
 */
export type CustomAudioTrack = BaseCustomTrack & {
	/** The track type. */
	type: 'audio';
	/** The codec, or `null` if it couldn't be identified. */
	codec: AudioCodec | null;
	/** The number of audio channels. */
	numberOfChannels: number;
	/** The sample rate in hertz. */
	sampleRate: number;
	/** Returns the decoder configuration, or `null` if there is none. */
	getDecoderConfig(): MaybePromise<AudioDecoderConfig | null>;
};

/**
 * A track provided by a custom demuxer.
 * @group Custom containers
 * @public
 */
export type CustomTrack = CustomVideoTrack | CustomAudioTrack;

/**
 * Reads a custom container format. `getTracks` is called once; return tracks whose fields are already valid, since
 * later mutation is not rechecked.
 * @group Custom containers
 * @public
 */
export type CustomDemuxer = {
	/** Returns the tracks in file order. */
	getTracks(): MaybePromise<CustomTrack[]>;
	/** Returns the MIME type of the input file. */
	getMimeType(): MaybePromise<string>;
	/** Returns the descriptive metadata tags, if any. */
	getMetadataTags?(): MaybePromise<MetadataTags>;
	/** Releases resources when the input is disposed. Input disposal does not await this method. */
	dispose?(): void;
};

/**
 * To add your own input format, extend this class and include an instance in {@link InputOptions.formats}.
 * @group Custom containers
 * @public
 */
export abstract class CustomInputFormat extends InputFormat {
	/** Returns whether this format can read the given input. Probing must leave shared bytes unchanged. */
	abstract canReadInput(context: DemuxerContext): MaybePromise<boolean>;
	/** Creates a demuxer for the input. Each input receives a separate demuxer. */
	abstract createDemuxer(context: DemuxerContext): CustomDemuxer;

	/** @internal */
	async _canReadInput(input: Input) {
		const result = await this.canReadInput(createDemuxerContext(input));
		if (input.disposed) {
			throw new InputDisposedError();
		}
		return result;
	}

	/** @internal */
	_createDemuxer(input: Input) {
		return new CustomDemuxerAdapter(input, this.createDemuxer(createDemuxerContext(input)));
	}
}

/**
 * Information provided when creating a custom muxer.
 *
 * Tracks are added after construction and are available when {@link CustomMuxer.start} is called.
 *
 * @group Custom containers
 * @public
 */
export type MuxerContext = {
	/** The tracks added to the output. */
	readonly tracks: readonly OutputTrack[];
	/** The descriptive metadata tags set on the output. */
	readonly metadataTags: MetadataTags;
	/** Aborted when the output is canceled. */
	readonly signal: AbortSignal;
	/** Acquires the root writer. Repeated calls must use the same `monotonic` value or function. */
	getRootWriter(monotonic?: boolean | ((target: Target) => boolean)): Promise<MuxerWriter>;
};

/**
 * Writes a custom container format.
 *
 * Mutating callbacks are serialized across all tracks and must finish without waiting for a later callback.
 *
 * {@link CustomMuxer.getMimeType} may run while another callback is pending, so it can wait for codec metadata
 * supplied with a later packet.
 *
 * @group Custom containers
 * @public
 */
export type CustomMuxer = {
	/** Initializes the output before packets are added. */
	start(): MaybePromise<void>;
	/** Returns the full MIME type of the output file. */
	getMimeType(): MaybePromise<string>;
	/** Writes a video packet. Required for formats supporting video tracks. */
	addEncodedVideoPacket?(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): MaybePromise<void>;
	/** Writes an audio packet. Required for formats supporting audio tracks. */
	addEncodedAudioPacket?(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): MaybePromise<void>;
	/** Writes a subtitle cue. Required for formats supporting subtitle tracks. */
	addSubtitleCue?(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata): MaybePromise<void>;
	/** Called when a source closes before finalization. */
	onTrackClose?(track: OutputTrack): MaybePromise<void>;
	/**
	 * Writes any remaining container data. After this and {@link CustomMuxer.dispose} succeed, the output flushes and
	 * finalizes the writer.
	 */
	finalize(): MaybePromise<void>;
	/** Releases resources after {@link CustomMuxer.finalize} or cancellation. */
	dispose?(): MaybePromise<void>;
};

/**
 * To add your own single-file output format, extend this class and pass an instance to
 * {@link OutputOptions.format}. Separate initialization targets are not supported.
 * @group Custom containers
 * @public
 */
export abstract class CustomOutputFormat extends OutputFormat {
	/** The name of the output format. */
	abstract get name(): string;
	/** Creates a muxer for the output. Each output receives a separate muxer. */
	abstract createMuxer(context: MuxerContext): CustomMuxer;

	/** @internal */
	get _name() {
		return this.name;
	}

	/** @internal */
	_createMuxer(output: Output) {
		if (output._hasInitTarget()) {
			throw new Error('Custom output formats do not support a separate initialization target.');
		}
		return new CustomMuxerAdapter(output, this.createMuxer({
			get tracks() {
				return output._tracks;
			},
			get metadataTags() {
				return output._metadataTags;
			},
			signal: output._abortController.signal,
			getRootWriter: (monotonic = false) => getCustomWriter(output, monotonic),
		}));
	}
}

const validateReadRange = (start: number, minLength: number, maxLength: number) => {
	if (!Number.isSafeInteger(start) || start < 0) {
		throw new TypeError('start must be a non-negative safe integer.');
	}
	if (!Number.isSafeInteger(minLength) || minLength < 0) {
		throw new TypeError('minLength must be a non-negative safe integer.');
	}
	if (!Number.isSafeInteger(maxLength) || maxLength < minLength) {
		throw new TypeError('maxLength must be a safe integer not smaller than minLength.');
	}
	if (!Number.isSafeInteger(start + maxLength)) {
		throw new TypeError('start + maxLength must be a safe integer.');
	}
};

const createDemuxerContext = (input: Input): DemuxerContext => ({
	reader: {
		get fileSize() {
			return input._reader.fileSizeNonStrict;
		},
		requestSlice(start, length) {
			validateReadRange(start, length, length);
			return readCustomSlice(input, () => input._reader.requestSlice(start, length));
		},
		requestSliceRange(start, minLength, maxLength) {
			validateReadRange(start, minLength, maxLength);
			return readCustomSlice(input, () => input._reader.requestSliceRange(start, minLength, maxLength));
		},
	},
	signal: input._abortController.signal,
});

const readCustomSlice = (input: Input, read: () => MaybePromise<FileSlice | null>) => {
	if (input.disposed) {
		throw new InputDisposedError();
	}
	const result = read();
	if (result instanceof Promise) {
		return result.then((slice) => {
			if (input.disposed) {
				throw new InputDisposedError();
			}
			return slice;
		});
	}
	return result;
};

const validateCustomTrack = (track: CustomTrack, ids: Set<number>) => {
	if (track.type !== 'video' && track.type !== 'audio') {
		throw new TypeError('track.type must be \'video\' or \'audio\'.');
	}
	if (!Number.isSafeInteger(track.id) || ids.has(track.id)) {
		throw new TypeError('track.id must be a unique safe integer.');
	}
	if (!Number.isFinite(track.timeResolution) || track.timeResolution <= 0) {
		throw new TypeError('track.timeResolution must be a positive number.');
	}
	if (track.codec !== null) {
		const codecs: readonly string[] = track.type === 'video' ? VIDEO_CODECS : AUDIO_CODECS;
		if (!codecs.includes(track.codec)) {
			throw new TypeError('track.codec must be a codec of the track\'s type, or null.');
		}
	}
	if (track.name !== undefined && track.name !== null && typeof track.name !== 'string') {
		throw new TypeError('track.name, when provided, must be a string or null.');
	}
	if (track.languageCode !== undefined && typeof track.languageCode !== 'string') {
		throw new TypeError('track.languageCode, when provided, must be a string.');
	}
	if (track.disposition !== undefined) {
		validateTrackDisposition(track.disposition);
	}
	if (track.pairingMask !== undefined && typeof track.pairingMask !== 'bigint') {
		throw new TypeError('track.pairingMask, when provided, must be a bigint.');
	}
	if (
		track.bitrate !== undefined
		&& track.bitrate !== null
		&& (!Number.isFinite(track.bitrate) || track.bitrate < 0)
	) {
		throw new TypeError('track.bitrate, when provided, must be a non-negative number or null.');
	}
	if (
		track.averageBitrate !== undefined
		&& track.averageBitrate !== null
		&& (!Number.isFinite(track.averageBitrate) || track.averageBitrate < 0)
	) {
		throw new TypeError('track.averageBitrate, when provided, must be a non-negative number or null.');
	}
	if (track.hasOnlyKeyPackets !== undefined && typeof track.hasOnlyKeyPackets !== 'boolean') {
		throw new TypeError('track.hasOnlyKeyPackets, when provided, must be a boolean.');
	}
	if (track.isRelativeToUnixEpoch !== undefined && typeof track.isRelativeToUnixEpoch !== 'boolean') {
		throw new TypeError('track.isRelativeToUnixEpoch, when provided, must be a boolean.');
	}
	if (track.type === 'video') {
		if (!Number.isInteger(track.codedWidth) || track.codedWidth <= 0) {
			throw new TypeError('track.codedWidth must be a positive integer.');
		}
		if (!Number.isInteger(track.codedHeight) || track.codedHeight <= 0) {
			throw new TypeError('track.codedHeight must be a positive integer.');
		}
		if (track.rotation !== undefined && ![0, 90, 180, 270].includes(track.rotation)) {
			throw new TypeError('track.rotation, when provided, must be 0, 90, 180 or 270.');
		}
		if (
			track.squarePixelWidth !== undefined
			&& (!Number.isInteger(track.squarePixelWidth) || track.squarePixelWidth <= 0)
		) {
			throw new TypeError('track.squarePixelWidth, when provided, must be a positive integer.');
		}
		if (
			track.squarePixelHeight !== undefined
			&& (!Number.isInteger(track.squarePixelHeight) || track.squarePixelHeight <= 0)
		) {
			throw new TypeError('track.squarePixelHeight, when provided, must be a positive integer.');
		}
		if (
			track.displayWidth !== undefined
			&& (!Number.isInteger(track.displayWidth) || track.displayWidth <= 0)
		) {
			throw new TypeError('track.displayWidth, when provided, must be a positive integer.');
		}
		if (
			track.displayHeight !== undefined
			&& (!Number.isInteger(track.displayHeight) || track.displayHeight <= 0)
		) {
			throw new TypeError('track.displayHeight, when provided, must be a positive integer.');
		}
		if (track.colorSpace !== undefined && (!track.colorSpace || typeof track.colorSpace !== 'object')) {
			throw new TypeError('track.colorSpace, when provided, must be an object.');
		}
		if (track.canBeTransparent !== undefined && typeof track.canBeTransparent !== 'boolean') {
			throw new TypeError('track.canBeTransparent, when provided, must be a boolean.');
		}
	} else {
		if (!Number.isInteger(track.numberOfChannels) || track.numberOfChannels <= 0) {
			throw new TypeError('track.numberOfChannels must be a positive integer.');
		}
		if (!Number.isInteger(track.sampleRate) || track.sampleRate <= 0) {
			throw new TypeError('track.sampleRate must be a positive integer.');
		}
	}
};

class CustomDemuxerAdapter extends Demuxer {
	tracksPromise: Promise<InputTrackBacking[]> | null = null;

	constructor(input: Input, public demuxer: CustomDemuxer) {
		super(input);
	}

	async getTrackBackings() {
		return this.tracksPromise ??= (async () => {
			const tracks = await this.demuxer.getTracks();
			if (this.input.disposed) {
				throw new InputDisposedError();
			}
			if (!Array.isArray(tracks)) {
				throw new TypeError('getTracks must return or resolve to an array of tracks.');
			}

			const ids = new Set<number>();
			const numbers = { video: 0, audio: 0 };
			return tracks.map((track) => {
				validateCustomTrack(track, ids);
				ids.add(track.id);

				return track.type === 'video'
					? new CustomVideoTrackBacking(this.input, track, ++numbers.video)
					: new CustomAudioTrackBacking(this.input, track, ++numbers.audio);
			});
		})();
	}

	async getMimeType() {
		return this.demuxer.getMimeType();
	}

	async getMetadataTags() {
		return this.demuxer.getMetadataTags?.() ?? {};
	}

	override dispose() {
		this.demuxer.dispose?.();
	}
}

abstract class CustomTrackBacking implements InputTrackBacking {
	constructor(public input: Input, public track: CustomTrack, public number: number) {}

	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	abstract getType(): TrackType;

	getId() {
		return this.track.id;
	}

	getNumber() {
		return this.number;
	}

	getCodec(): VideoCodec | AudioCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getInternalCodecId() {
		return this.track.internalCodecId ?? null;
	}

	getName() {
		return this.track.name ?? null;
	}

	getLanguageCode() {
		return this.track.languageCode ?? UNDETERMINED_LANGUAGE;
	}

	getTimeResolution() {
		return this.track.timeResolution;
	}

	isRelativeToUnixEpoch() {
		return this.track.isRelativeToUnixEpoch ?? false;
	}

	getDisposition() {
		return { ...DEFAULT_TRACK_DISPOSITION, ...this.track.disposition };
	}

	getPairingMask() {
		return this.track.pairingMask ?? 1n;
	}

	getBitrate() {
		return this.track.bitrate ?? null;
	}

	getAverageBitrate() {
		return this.track.averageBitrate ?? null;
	}

	getHasOnlyKeyPackets() {
		return this.track.hasOnlyKeyPackets ?? null;
	}

	getUnixTimeForTimestamp(timestamp: number) {
		return this.track.getUnixTimeForTimestamp?.(timestamp) ?? null;
	}

	async getDurationFromMetadata(options: DurationMetadataRequestOptions) {
		return this.track.getDurationFromMetadata?.(options) ?? null;
	}

	async getLiveRefreshInterval() {
		return this.track.getLiveRefreshInterval?.() ?? null;
	}

	getMetadataCodecParameterString() {
		return this.track.getCodecParameterString?.() ?? null;
	}

	async getFirstPacket(
		res: ResultValue<EncodedPacket | null>,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		let packetResult = this.track.getFirstPacket(options);
		if (packetResult instanceof Promise) packetResult = await packetResult;
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		return res.set(packetResult);
	}

	async getNextPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		let packetResult = this.track.getNextPacket(packet, options);
		if (packetResult instanceof Promise) packetResult = await packetResult;
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		return res.set(packetResult);
	}

	async getPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		let packetResult = this.track.getPacket(timestamp, options);
		if (packetResult instanceof Promise) packetResult = await packetResult;
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		return res.set(packetResult);
	}

	async getKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		let packetResult = this.track.getKeyPacket(timestamp, options);
		if (packetResult instanceof Promise) packetResult = await packetResult;
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		return res.set(packetResult);
	}

	async getNextKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		let packetResult = this.track.getNextKeyPacket(packet, options);
		if (packetResult instanceof Promise) packetResult = await packetResult;
		if (this.input.disposed) {
			throw new InputDisposedError();
		}
		return res.set(packetResult);
	}
}

class CustomVideoTrackBacking extends CustomTrackBacking implements InputVideoTrackBacking {
	override track: CustomVideoTrack;

	constructor(input: Input, track: CustomVideoTrack, number: number) {
		super(input, track, number);
		this.track = track;
	}

	override getType() {
		return 'video' as const;
	}

	override getCodec() {
		return this.track.codec;
	}

	getCodedWidth() {
		return this.track.codedWidth;
	}

	getCodedHeight() {
		return this.track.codedHeight;
	}

	getSquarePixelWidth() {
		return this.track.squarePixelWidth ?? this.track.codedWidth;
	}

	getSquarePixelHeight() {
		return this.track.squarePixelHeight ?? this.track.codedHeight;
	}

	getMetadataDisplayWidth() {
		return this.track.displayWidth ?? null;
	}

	getMetadataDisplayHeight() {
		return this.track.displayHeight ?? null;
	}

	getRotation() {
		return this.track.rotation ?? 0;
	}

	async getColorSpace() {
		return this.track.colorSpace ?? {};
	}

	async canBeTransparent() {
		return this.track.canBeTransparent ?? false;
	}

	async getDecoderConfig() {
		if (this.track.codec === null) {
			return null;
		}

		return await this.track.getDecoderConfig();
	}
}

class CustomAudioTrackBacking extends CustomTrackBacking implements InputAudioTrackBacking {
	override track: CustomAudioTrack;

	constructor(input: Input, track: CustomAudioTrack, number: number) {
		super(input, track, number);
		this.track = track;
	}

	override getType() {
		return 'audio' as const;
	}

	override getCodec() {
		return this.track.codec;
	}

	getNumberOfChannels() {
		return this.track.numberOfChannels;
	}

	getSampleRate() {
		return this.track.sampleRate;
	}

	async getDecoderConfig() {
		const { codec } = this.track;
		if (codec === null) {
			return null;
		}

		const config = await this.track.getDecoderConfig();
		if (config && (PCM_AUDIO_CODECS as readonly string[]).includes(codec) && config.codec !== codec) {
			// We decode PCM ourselves, so this has to match
			throw new TypeError(`The decoder configuration of a ${codec} track must use '${codec}' as its codec.`);
		}

		return config;
	}
}

const getCustomWriter = async (
	output: Output,
	monotonic: boolean | ((target: Target) => boolean),
): Promise<MuxerWriter> => {
	output._ensureWritable();
	if (output._customWriterMonotonic !== null && output._customWriterMonotonic !== monotonic) {
		throw new Error('monotonic must match the first writer request.');
	}

	output._customWriterMonotonic = monotonic;

	const writer = await output._getRootWriter(monotonic);
	output._ensureWritable();

	return {
		getPos() {
			return writer.getPos();
		},
		write(data) {
			output._ensureWritable();
			if (!(data instanceof Uint8Array)) {
				throw new TypeError('data must be a Uint8Array.');
			}

			writer.write(data);
		},
		seek(position) {
			output._ensureWritable();
			if (!Number.isSafeInteger(position) || position < 0) {
				throw new TypeError('position must be a non-negative safe integer.');
			}

			writer.seek(position);
		},
		flush() {
			output._ensureWritable();
			return writer.flush();
		},
		startTrackingWrites() {
			output._ensureWritable();
			writer.startTrackingWrites();
		},
		stopTrackingWrites() {
			output._ensureWritable();
			return writer.stopTrackingWrites();
		},
	};
};

class CustomMuxerAdapter extends Muxer {
	disposePromise: Promise<void> | null = null;

	constructor(output: Output, public muxer: CustomMuxer) {
		super(output);
	}

	async start() {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		this.output._ensureWritable();
		await this.muxer.start();
	}

	async getMimeType() {
		return this.muxer.getMimeType();
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		this.output._ensureWritable();
		if (!this.muxer.addEncodedVideoPacket) {
			throw new Error('Custom muxer does not support this track type.');
		}
		this.validateTimestamp(track, packet.timestamp, packet.type === 'key');
		await this.muxer.addEncodedVideoPacket(track, packet, meta);
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		this.output._ensureWritable();
		if (!this.muxer.addEncodedAudioPacket) {
			throw new Error('Custom muxer does not support this track type.');
		}
		this.validateTimestamp(track, packet.timestamp, packet.type === 'key');
		await this.muxer.addEncodedAudioPacket(track, packet, meta);
	}

	async addSubtitleCue(
		track: OutputSubtitleTrack,
		cue: SubtitleCue,
		meta?: SubtitleMetadata,
	) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		this.output._ensureWritable();
		if (!this.muxer.addSubtitleCue) {
			throw new Error('Custom muxer does not support this track type.');
		}
		this.validateTimestamp(track, cue.timestamp, true);
		await this.muxer.addSubtitleCue(track, cue, meta);
	}

	override async onTrackClose(track: OutputTrack) {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		if (this.output.state === 'canceled') {
			// Cancellation closes sources too; there's no more container data to write
			return;
		}

		this.output._ensureWritable();
		await this.muxer.onTrackClose?.(track);
	}

	async finalize() {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		try {
			await this.muxer.finalize();
		} catch (error) {
			await this.disposeMuxer().catch(() => {});
			throw error;
		}
		await this.disposeMuxer();
	}

	override async dispose() {
		using lock = this.mutex.lock();
		if (lock.pending) await lock.ready;

		await this.disposeMuxer();
	}

	private async disposeMuxer() {
		// Finalization may fail after the muxer has already been disposed
		return this.disposePromise ??= (async () => {
			await this.muxer.dispose?.();
		})();
	}
}
