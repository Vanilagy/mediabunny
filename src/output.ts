/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, AsyncMutex, EventEmitter, isIso639Dash2LanguageCode, MaybePromise, Rotation, toArray } from './misc';
import { MetadataTags, TrackDisposition, validateMetadataTags, validateTrackDisposition } from './metadata';
import { Muxer } from './muxer';
import { OutputFormat } from './output-format';
import { AudioSource, MediaSource, SubtitleSource, VideoSource } from './media-source';
import { PathedTarget, Target, TargetRequest } from './target';
import { Writer } from './writer';

/**
 * List of all track types.
 * @group Miscellaneous
 * @public
 */
export const ALL_TRACK_TYPES = ['video', 'audio', 'subtitle'] as const;
/**
 * Union type of all track types.
 * @group Miscellaneous
 * @public
 */
export type TrackType = typeof ALL_TRACK_TYPES[number];

/**
 * Represents a track added to an {@link Output}.
 * @group Output files
 * @public
 */
export abstract class OutputTrack {
	/** @internal */
	readonly id: number;
	/** The {@link Output} this track belongs to. */
	readonly output: Output;
	/** The type of this track. */
	readonly type: TrackType;
	/** The media source providing data for this track. */
	readonly source: MediaSource;
	/** The metadata associated with this track. */
	readonly metadata: BaseTrackMetadata;

	/** @internal */
	protected constructor(
		id: number,
		output: Output,
		type: TrackType,
		source: MediaSource,
		metadata: BaseTrackMetadata,
	) {
		this.id = id;
		this.output = output;
		this.type = type;
		this.source = source;
		this.metadata = metadata;
	}

	/** Returns true if and only if this track is a video track. */
	isVideoTrack(): this is OutputVideoTrack {
		return this.type === 'video';
	}

	/** Returns true if and only if this track is an audio track. */
	isAudioTrack(): this is OutputAudioTrack {
		return this.type === 'audio';
	}

	/** Returns true if and only if this track is a subtitle track. */
	isSubtitleTrack(): this is OutputSubtitleTrack {
		return this.type === 'subtitle';
	}

	/**
	 * Returns true if and only if this track can be paired with the given other track. Pairability can be set using
	 * the {@link BaseTrackMetadata.group} option.
	 */
	canBePairedWith(other: OutputTrack) {
		if (!(other instanceof OutputTrack)) {
			throw new TypeError('other must be an OutputTrack.');
		}

		if (this === other) {
			return false;
		}

		const thisGroups = toArray(this.metadata.group!);
		const otherGroups = toArray(other.metadata.group!);

		for (const aGroup of thisGroups) {
			const pairableInSameGroup = this.type !== other.type && otherGroups.some(bGroup => aGroup === bGroup);
			if (pairableInSameGroup) {
				return true;
			}

			const pairableAcrossGroups = otherGroups.some(
				bGroup => aGroup._pairedGroups.has(bGroup),
			);
			if (pairableAcrossGroups) {
				return true;
			}
		}

		return false;
	}
}

/**
 * An {@link OutputTrack} providing video data, created using {@link Output.addVideoTrack}.
 * @group Output files
 * @public
 */
export class OutputVideoTrack extends OutputTrack {
	declare readonly type: 'video';
	declare readonly source: VideoSource;
	declare readonly metadata: VideoTrackMetadata;

	/** @internal */
	constructor(id: number, output: Output, source: VideoSource, metadata: VideoTrackMetadata) {
		super(id, output, 'video', source, metadata);
	}
}

/**
 * An {@link OutputTrack} providing audio data, created using {@link Output.addAudioTrack}.
 * @group Output files
 * @public
 */
export class OutputAudioTrack extends OutputTrack {
	declare readonly type: 'audio';
	declare readonly source: AudioSource;
	declare readonly metadata: AudioTrackMetadata;

	/** @internal */
	constructor(id: number, output: Output, source: AudioSource, metadata: AudioTrackMetadata) {
		super(id, output, 'audio', source, metadata);
	}
}

/**
 * An {@link OutputTrack} providing subtitle data, created using {@link Output.addSubtitleTrack}.
 * @group Output files
 * @public
 */
export class OutputSubtitleTrack extends OutputTrack {
	declare readonly type: 'subtitle';
	declare readonly source: SubtitleSource;
	declare readonly metadata: SubtitleTrackMetadata;

	/** @internal */
	constructor(id: number, output: Output, source: SubtitleSource, metadata: SubtitleTrackMetadata) {
		super(id, output, 'subtitle', source, metadata);
	}
}

/**
 * Used to define pairability between {@link OutputTrack} instances. First create the group, then assign tracks to it
 * via {@link BaseTrackMetadata.group}.
 *
 * Two tracks are considered _pairable_ if they are in the same group but have a different {@link TrackType}, or if they
 * are in different groups that are paired with each other. Groups can be paired with each other using the
 * {@link OutputTrackGroup.pairWith} method.
 *
 * @group Output files
 * @public
 */
export class OutputTrackGroup {
	/** @internal */
	_pairedGroups = new Set<OutputTrackGroup>();

	/** Creates a new {@link OutputTrackGroup}. */
	constructor() {
		// The object's identity is the state
	}

	/**
	 * Marks this group as being pairable with another group, symmetrically. Output tracks where each track is assigned
	 * to one half of a group pairing are then considered pairable.
	 *
	 * You cannot pair a group with itself.
	 */
	pairWith(other: OutputTrackGroup) {
		if (!(other instanceof OutputTrackGroup)) {
			throw new TypeError('other must be an OutputTrackGroup.');
		}
		if (this === other) {
			throw new TypeError('Cannot pair a group with itself.');
		}

		this._pairedGroups.add(other);
		other._pairedGroups.add(this);
	}
}

/**
 * Base track metadata, applicable to all tracks.
 * @group Output files
 * @public
 */
export type BaseTrackMetadata = {
	/** The three-letter, ISO 639-2/T language code specifying the language of this track. */
	languageCode?: string;
	/** A user-defined name for this track, like "English" or "Director Commentary". */
	name?: string;
	/** The track's disposition, i.e. information about its intended usage. */
	disposition?: Partial<TrackDisposition>;
	/**
	 * The maximum amount of encoded packets that will be added to this track. Setting this field provides the muxer
	 * with an additional signal that it can use to preallocate space in the file.
	 *
	 * When this field is set, it is an error to provide more packets than whatever this field specifies.
	 *
	 * Predicting the maximum packet count requires considering both the maximum duration as well as the codec.
	 * - For video codecs, you can assume one packet per frame.
	 * - For audio codecs, there is one packet for each "audio chunk", the duration of which depends on the codec. For
	 * simplicity, you can assume each packet is roughly 10 ms or 512 samples long, whichever is shorter.
	 * - For subtitles, assume each cue and each gap in the subtitles adds a packet.
	 *
	 * If you're not fully sure, make sure to add a buffer of around 33% to make sure you stay below the maximum.
	 */
	maximumPacketCount?: number;
	/**
	 * Whether the timestamps of this track are relative to the Unix epoch (January 1, 1970, 00:00:00 UTC). When `true`,
	 * each timestamp maps to a definitive point in time.
	 */
	isRelativeToUnixEpoch?: boolean;
	/**
	 * Defines the group(s) this track is a part of. Group assignment determines track pairability, determining which
	 * tracks can be presented together with other tracks. This is needed for configuring things like HLS master
	 * playlists.
	 *
	 * Two groups are considered pairable if they are in the same group but are of different {@link TrackType}, or if
	 * they are in two separate groups that have been paired with each other.
	 *
	 * If left blank, a track is automatically assigned to {@link Output.defaultTrackGroup}.
	 */
	group?: OutputTrackGroup | OutputTrackGroup[];
};

/**
 * Additional metadata for video tracks.
 * @group Output files
 * @public
 */
export type VideoTrackMetadata = BaseTrackMetadata & {
	/** The angle in degrees by which the track's frames should be rotated (clockwise). */
	rotation?: Rotation;
	/**
	 * The expected video frame rate in hertz. If set, all timestamps and durations of this track will be snapped to
	 * this frame rate. You should avoid adding more frames than the rate allows, as this will lead to multiple frames
	 * with the same timestamp.
	 */
	frameRate?: number;
	/**
	 * When true, this track is marked as being made only out of key frames (I-frames). It is an error to add a non-key
	 * frame to this track.
	 */
	hasOnlyKeyPackets?: boolean;
};
/**
 * Additional metadata for audio tracks.
 * @group Output files
 * @public
 */
export type AudioTrackMetadata = BaseTrackMetadata & {};
/**
 * Additional metadata for subtitle tracks.
 * @group Output files
 * @public
 */
export type SubtitleTrackMetadata = BaseTrackMetadata & {};

const validateBaseTrackMetadata = (metadata: BaseTrackMetadata) => {
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError('metadata must be an object.');
	}
	if (metadata.languageCode !== undefined && !isIso639Dash2LanguageCode(metadata.languageCode)) {
		throw new TypeError('metadata.languageCode, when provided, must be a three-letter, ISO 639-2/T language code.');
	}
	if (metadata.name !== undefined && typeof metadata.name !== 'string') {
		throw new TypeError('metadata.name, when provided, must be a string.');
	}
	if (metadata.disposition !== undefined) {
		validateTrackDisposition(metadata.disposition);
	}
	if (
		metadata.maximumPacketCount !== undefined
		&& (!Number.isInteger(metadata.maximumPacketCount) || metadata.maximumPacketCount < 0)
	) {
		throw new TypeError('metadata.maximumPacketCount, when provided, must be a non-negative integer.');
	}
	if (
		metadata.group !== undefined
		&& !(metadata.group instanceof OutputTrackGroup)
		&& (!Array.isArray(metadata.group) || metadata.group.some(group => !(group instanceof OutputTrackGroup)))
	) {
		throw new TypeError(
			'metadata.group, when provided, must be an OutputTrackGroup instance or an array of'
			+ ' OutputTrackGroup instances.',
		);
	}
};

/**
 * The options for creating an Output object.
 * @group Output files
 * @public
 */
export type OutputOptions<
	F extends OutputFormat = OutputFormat,
	T extends Target = Target,
> = {
	/** The format of the output file. */
	format: F;
	/** The target to which the file will be written. */
	target: T | PathedTarget<T>;
	/**
	 * Optional; the target to which the track initialization data will be written. Most formats do not make use of
	 * this, but some do, such as {@link CmafOutputFormat}.
	 *
	 * When this is a function, it will only be called if an init target is needed.
	 */
	initTarget?: T | (() => MaybePromise<T>);
	/**
	 * Optional; a callback to be called at the end of {@link Output.finalize}. Can be used to run logic once the
	 * output has completed. If a promise is returned, it will be awaited internally by {@link Output.finalize}.
	 */
	onFinalize?: () => MaybePromise<unknown>;
};

/**
 * Describes the events that an {@link Output} emits, with each key being an event name and its value being the
 * event data.
 *
 * @group Output files
 * @public
 */
export type OutputEvents = {
	/** Emitted whenever a {@link Target} is obtained by the output. Useful to track writes. */
	target: {
		/** The target that was obtained. */
		target: Target;
		/** The request that led to the target being obtained, or `null` if the output is not pathed. */
		request: TargetRequest | null;
		/** Whether the target is the root file of the media. */
		isRoot: boolean;
	};
};

/**
 * Main class orchestrating the creation of new media files.
 * @group Output files
 * @public
 */
export class Output<
	F extends OutputFormat = OutputFormat,
	T extends Target = Target,
> extends EventEmitter<OutputEvents> {
	/** The format of the output file. */
	readonly format: F;
	/** @internal */
	_target: T | PathedTarget<T>;
	/** The current state of the output. */
	state: 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized' = 'pending';
	/**
	 * The {@link OutputTrackGroup} that all tracks are assigned to by default unless otherwise specified by
	 * {@link BaseTrackMetadata.group}.
	 */
	readonly defaultTrackGroup = new OutputTrackGroup();

	/** @internal */
	private _initTarget: T | (() => MaybePromise<T>) | null;
	/** @internal */
	_onFinalize: (() => MaybePromise<unknown>) | null = null;
	/** @internal */
	_muxer: Muxer;
	/** @internal */
	_unfinalizedTargets = new Set<Target>();
	/** @internal */
	_rootWriterPromise: Promise<Writer> | null = null;
	/** @internal */
	_tracks: OutputTrack[] = [];
	/** @internal */
	_startPromise: Promise<void> | null = null;
	/** @internal */
	_cancelPromise: Promise<void> | null = null;
	/** @internal */
	_finalizePromise: Promise<void> | null = null;
	/** @internal */
	_mutex = new AsyncMutex();
	/** @internal */
	_metadataTags: MetadataTags = {};
	/** @internal */
	_rootTarget: T | null = null;
	/** @internal */
	_rootTargetPromise: Promise<T> | null = null;
	/**
	 * This field is used to synchronize multiple MediaStreamTracks. They use the same time coordinate system across
	 * tracks, and to ensure correct audio-video sync, we must use the same offset for all of them. The reason an offset
	 * is needed at all is because the timestamps typically don't start at zero.
	 * @internal
	 */
	_firstMediaStreamTimestamp: number | null = null;

	/**
	 * The target to which the root file will be written. Throws when using {@link PathedTarget} with an async callback;
	 * prefer the `'target'` event for those cases.
	 */
	get target(): T {
		const errorMessage = 'Output.target cannot be used when using PathedTarget with an async callback.'
			+ ' Use the \'target\' event instead.';

		// We use this field to make sure we can reliably throw in the `target` getter whenever retrieving the target
		// requires awaiting a promise. We do this so there is no different behavior based on order: if the target has
		// already been retrieved via the normal internal operations, and then somebody calls the `target` getter, even
		// if the target is now available, the getter should still throw to be consistent in behavior and in definition.
		if (this._rootTargetPromise) {
			throw new TypeError(errorMessage);
		}

		const rootTargetResult = this._getRootTarget();
		if (rootTargetResult instanceof Promise) {
			throw new TypeError(errorMessage);
		}

		return rootTargetResult;
	}

	/**
	 * Creates a new instance of {@link Output} which can then be used to create a new media file according to the
	 * specified {@link OutputOptions}.
	 */
	constructor(options: OutputOptions<F, T>) {
		super();

		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!(options.format instanceof OutputFormat)) {
			throw new TypeError('options.format must be an OutputFormat.');
		}
		if (!(options.target instanceof Target || options.target instanceof PathedTarget)) {
			throw new TypeError('options.target must be a Target or a PathedTarget.');
		}
		if (options.target instanceof Target) {
			this._rememberTarget(options.target);
		}
		if (
			options.initTarget !== undefined
			&& !(options.initTarget instanceof Target)
			&& typeof options.initTarget !== 'function'
		) {
			throw new Error(
				'options.initTarget, when provided, must be a Target or a function that returns or resolves to'
				+ ' a Target.',
			);
		}
		if (options.onFinalize !== undefined && typeof options.onFinalize !== 'function') {
			throw new TypeError('options.onFinalize, when provided, must be a function.');
		}

		this.format = options.format;
		this._target = options.target;
		this._onFinalize = options.onFinalize ?? null;

		this._initTarget = options.initTarget ?? null;
		if (this._initTarget instanceof Target) {
			this._rememberTarget(this._initTarget);
		}

		this._muxer = options.format._createMuxer(this);
	}

	/** @internal */
	_getTargetValidated(request: TargetRequest): MaybePromise<T> {
		assert(this._target instanceof PathedTarget);

		const result = this._target.getTarget(request);
		const handleResult = (result: T) => {
			if (!(result instanceof Target)) {
				throw new TypeError('getTarget must return a Target.');
			}

			return result;
		};

		if (result instanceof Promise) {
			return result.then(handleResult);
		} else {
			return handleResult(result);
		}
	}

	/** @internal */
	async _getTarget(request: TargetRequest) {
		assert(this._target instanceof PathedTarget);

		const target = await this._getTargetValidated(request);
		this._emit('target', { target, request, isRoot: request.isRoot });

		if (this.state === 'canceled') {
			await target._close();
		} else {
			this._rememberTarget(target);
		}

		return target;
	}

	/** @internal */
	_rememberTarget(target: Target) {
		this._unfinalizedTargets.add(target);
		target.on('finalized', () => this._unfinalizedTargets.delete(target), { once: true });
	}

	/** @internal */
	async _getInitTarget(): Promise<T> {
		assert(this._initTarget !== null);

		if (this._initTarget instanceof Target) {
			return this._initTarget;
		}

		const target = await this._initTarget();

		if (this.state === 'canceled') {
			await target._close();
		} else {
			this._rememberTarget(target);
		}

		return target;
	}

	/** @internal */
	_hasInitTarget() {
		return this._initTarget !== null;
	}

	/** @internal */
	_getRootTarget(): MaybePromise<T> {
		if (this._rootTarget) {
			return this._rootTarget;
		}
		if (this._rootTargetPromise) {
			return this._rootTargetPromise;
		}

		if (this._target instanceof Target) {
			this._emit('target', { target: this._target, request: null, isRoot: true });
			this._rootTarget = this._target;
			return this._target;
		}

		const request: TargetRequest = {
			path: this._target.rootPath,
			isRoot: true,
			mimeType: this.format.mimeType,
		};
		const result = this._getTargetValidated(request);

		const handleResult = (target: T) => {
			if (this.state === 'canceled') {
				// Promise thrown away here, but no way to surface it to the user really
				void target._close();
			} else {
				this._rememberTarget(target);
			}

			this._emit('target', { target, request, isRoot: true });
			this._rootTarget = target;
			return target;
		};

		if (result instanceof Promise) {
			return this._rootTargetPromise = result.then(handleResult);
		} else {
			return handleResult(result);
		}
	}

	/** @internal */
	_getRootWriter(isMonotonic: boolean | ((target: Target) => boolean)) {
		return this._rootWriterPromise ??= (async () => {
			const target = await this._getRootTarget();

			const writer = new Writer(target, typeof isMonotonic === 'boolean' ? isMonotonic : isMonotonic(target));
			writer.start();
			return writer;
		})();
	}

	/** Adds a video track to the output with the given source. Can only be called before the output is started. */
	addVideoTrack(source: VideoSource, metadata: VideoTrackMetadata = {}) {
		if (!(source instanceof VideoSource)) {
			throw new TypeError('source must be a VideoSource.');
		}
		validateBaseTrackMetadata(metadata);
		if (metadata.rotation !== undefined && ![0, 90, 180, 270].includes(metadata.rotation)) {
			throw new TypeError(`Invalid video rotation: ${metadata.rotation}. Has to be 0, 90, 180 or 270.`);
		}
		if (!this.format.supportsVideoRotationMetadata && metadata.rotation) {
			throw new Error(`${this.format._name} does not support video rotation metadata.`);
		}
		if (
			metadata.frameRate !== undefined
			&& (!Number.isFinite(metadata.frameRate) || metadata.frameRate <= 0)
		) {
			throw new TypeError(
				`Invalid video frame rate: ${metadata.frameRate}. Must be a positive number.`,
			);
		}

		const metadataCopy = { ...metadata };
		metadataCopy.group ??= this.defaultTrackGroup;

		return this._addTrack(new OutputVideoTrack(
			this._tracks.length + 1, this, source, metadataCopy,
		));
	}

	/** Adds an audio track to the output with the given source. Can only be called before the output is started. */
	addAudioTrack(source: AudioSource, metadata: AudioTrackMetadata = {}) {
		if (!(source instanceof AudioSource)) {
			throw new TypeError('source must be an AudioSource.');
		}
		validateBaseTrackMetadata(metadata);

		const metadataCopy = { ...metadata };
		metadataCopy.group ??= this.defaultTrackGroup;

		return this._addTrack(new OutputAudioTrack(
			this._tracks.length + 1, this, source, metadataCopy,
		));
	}

	/** Adds a subtitle track to the output with the given source. Can only be called before the output is started. */
	addSubtitleTrack(source: SubtitleSource, metadata: SubtitleTrackMetadata = {}) {
		if (!(source instanceof SubtitleSource)) {
			throw new TypeError('source must be a SubtitleSource.');
		}
		validateBaseTrackMetadata(metadata);

		const metadataCopy = { ...metadata };
		metadataCopy.group ??= this.defaultTrackGroup;

		return this._addTrack(new OutputSubtitleTrack(
			this._tracks.length + 1, this, source, metadataCopy,
		));
	}

	/**
	 * Sets descriptive metadata tags about the media file, such as title, author, date, or cover art. When called
	 * multiple times, only the metadata from the last call will be used.
	 *
	 * Can only be called before the output is started.
	 */
	setMetadataTags(tags: MetadataTags) {
		validateMetadataTags(tags);

		if (this.state !== 'pending') {
			throw new Error('Cannot set metadata tags after output has been started or canceled.');
		}

		this._metadataTags = tags;
	}

	/** @internal */
	private _addTrack<T extends OutputTrack>(track: T) {
		if (this.state !== 'pending') {
			throw new Error('Cannot add track after output has been started or canceled.');
		}
		if (track.source._connectedTrack) {
			throw new Error('Source is already used for a track.');
		}

		// Verify maximum track count constraints
		const supportedTrackCounts = this.format.getSupportedTrackCounts();
		const presentTracksOfThisType = this._tracks.reduce(
			(count, t) => count + (t.type === track.type ? 1 : 0),
			0,
		);
		const maxCount = supportedTrackCounts[track.type].max;
		if (presentTracksOfThisType === maxCount) {
			throw new Error(
				maxCount === 0
					? `${this.format._name} does not support ${track.type} tracks.`
					: (`${this.format._name} does not support more than ${maxCount} ${track.type} track`
						+ `${maxCount === 1 ? '' : 's'}.`),
			);
		}
		const maxTotalCount = supportedTrackCounts.total.max;
		if (this._tracks.length === maxTotalCount) {
			throw new Error(
				`${this.format._name} does not support more than ${maxTotalCount} tracks`
				+ `${maxTotalCount === 1 ? '' : 's'} in total.`,
			);
		}

		if (track.isVideoTrack()) {
			const supportedVideoCodecs = this.format.getSupportedVideoCodecs();

			if (supportedVideoCodecs.length === 0) {
				throw new Error(
					`${this.format._name} does not support video tracks.`
					+ this.format._codecUnsupportedHint(track.source._codec),
				);
			} else if (!supportedVideoCodecs.includes(track.source._codec)) {
				throw new Error(
					`Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported`
					+ ` video codecs are: ${supportedVideoCodecs.map(codec => `'${codec}'`).join(', ')}.`
					+ this.format._codecUnsupportedHint(track.source._codec),
				);
			}
		} else if (track.isAudioTrack()) {
			const supportedAudioCodecs = this.format.getSupportedAudioCodecs();

			if (supportedAudioCodecs.length === 0) {
				throw new Error(
					`${this.format._name} does not support audio tracks.`
					+ this.format._codecUnsupportedHint(track.source._codec),
				);
			} else if (!supportedAudioCodecs.includes(track.source._codec)) {
				throw new Error(
					`Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported`
					+ ` audio codecs are: ${supportedAudioCodecs.map(codec => `'${codec}'`).join(', ')}.`
					+ this.format._codecUnsupportedHint(track.source._codec),
				);
			}
		} else if (track.isSubtitleTrack()) {
			const supportedSubtitleCodecs = this.format.getSupportedSubtitleCodecs();

			if (supportedSubtitleCodecs.length === 0) {
				throw new Error(
					`${this.format._name} does not support subtitle tracks.`
					+ this.format._codecUnsupportedHint(track.source._codec),
				);
			} else if (!supportedSubtitleCodecs.includes(track.source._codec)) {
				throw new Error(
					`Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported`
					+ ` subtitle codecs are: ${supportedSubtitleCodecs.map(codec => `'${codec}'`).join(', ')}.`
					+ this.format._codecUnsupportedHint(track.source._codec),
				);
			}
		}

		this._tracks.push(track);
		track.source._connectedTrack = track;

		return track;
	}

	/**
	 * Starts the creation of the output file. This method should be called after all tracks have been added. Only after
	 * the output has started can media samples be added to the tracks.
	 *
	 * @returns A promise that resolves when the output has successfully started and is ready to receive media samples.
	 */
	async start() {
		// Verify minimum track count constraints
		const supportedTrackCounts = this.format.getSupportedTrackCounts();
		for (const trackType of ALL_TRACK_TYPES) {
			const presentTracksOfThisType = this._tracks.reduce(
				(count, track) => count + (track.type === trackType ? 1 : 0),
				0,
			);
			const minCount = supportedTrackCounts[trackType].min;
			if (presentTracksOfThisType < minCount) {
				throw new Error(
					minCount === supportedTrackCounts[trackType].max
						? (`${this.format._name} requires exactly ${minCount} ${trackType}`
							+ ` track${minCount === 1 ? '' : 's'}.`)
						: (`${this.format._name} requires at least ${minCount} ${trackType}`
							+ ` track${minCount === 1 ? '' : 's'}.`),
				);
			}
		}
		const totalMinCount = supportedTrackCounts.total.min;
		if (this._tracks.length < totalMinCount) {
			throw new Error(
				totalMinCount === supportedTrackCounts.total.max
					? (`${this.format._name} requires exactly ${totalMinCount} track`
						+ `${totalMinCount === 1 ? '' : 's'}.`)
					: (`${this.format._name} requires at least ${totalMinCount} track`
						+ `${totalMinCount === 1 ? '' : 's'}.`),
			);
		}

		if (this.state === 'canceled') {
			throw new Error('Output has been canceled.');
		}

		if (this._startPromise) {
			console.warn('Output has already been started.');
			return this._startPromise;
		}

		return this._startPromise = (async () => {
			this.state = 'started';

			const release = await this._mutex.acquire();

			try {
				await this._muxer.start();

				const promises = this._tracks.map(track => track.source._start());
				await Promise.all(promises);
			} finally {
				release();
			}
		})();
	}

	/**
	 * Resolves with the full MIME type of the output file, including track codecs.
	 *
	 * The returned promise will resolve only once the precise codec strings of all tracks are known.
	 */
	getMimeType() {
		return this._muxer.getMimeType();
	}

	/**
	 * Cancels the creation of the output file, releasing internal resources like encoders and preventing further
	 * samples from being added.
	 *
	 * @returns A promise that resolves once all internal resources have been released.
	 */
	async cancel() {
		if (this._cancelPromise) {
			console.warn('Output has already been canceled.');
			return this._cancelPromise;
		} else if (this.state === 'finalizing' || this.state === 'finalized') {
			// Don't wanna warn when finalizing since that shows a warning when finalization fails and then cancel
			// is called
			if (this.state === 'finalized') {
				console.warn('Output has already been finalized.');
			}

			return;
		}

		return this._cancelPromise = (async () => {
			this.state = 'canceled';

			const release = await this._mutex.acquire();

			try {
				const promises = this._tracks.map(x => x.source._flushOrWaitForOngoingClose(true)); // Force close
				await Promise.all(promises);

				await Promise.all([...this._unfinalizedTargets].map(target => target._close()));
				this._unfinalizedTargets.clear();
			} finally {
				release();
			}
		})();
	}

	/**
	 * Finalizes the output file. This method must be called after all media samples across all tracks have been added.
	 * Once the Promise returned by this method completes, the output file is ready.
	 */
	async finalize() {
		if (this.state === 'pending') {
			throw new Error('Cannot finalize before starting.');
		}
		if (this.state === 'canceled') {
			throw new Error('Cannot finalize after canceling.');
		}
		if (this._finalizePromise) {
			console.warn('Output has already been finalized.');
			return this._finalizePromise;
		}

		return this._finalizePromise = (async () => {
			this.state = 'finalizing';

			const release = await this._mutex.acquire();

			try {
				const promises = this._tracks.map(x => x.source._flushOrWaitForOngoingClose(false));
				await Promise.all(promises);

				await this._muxer.finalize();

				if (this._rootWriterPromise) {
					const rootWriter = await this._rootWriterPromise;
					if (!rootWriter.finalized) {
						await rootWriter.flush();
						await rootWriter.finalize();
					}
				}

				if (this._onFinalize) {
					await this._onFinalize();
				}

				this.state = 'finalized';
			} finally {
				release();
			}
		})();
	}
}
