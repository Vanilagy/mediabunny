/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AsyncMutex, isIso639Dash2LanguageCode, Rotation } from './misc';
import { Muxer } from './muxer';
import { OutputFormat } from './output-format';
import { AudioSource, MediaSource, SubtitleSource, VideoSource } from './media-source';
import { Target } from './target';
import { Writer } from './writer';

/**
 * The options for creating an Output object.
 * @public
 */
export type OutputOptions<
	F extends OutputFormat = OutputFormat,
	T extends Target = Target,
> = {
	/** The format of the output file. */
	format: F;
	/** The target to which the file will be written. */
	target: T;
};

/**
 * List of all track types.
 * @public
 */
export const ALL_TRACK_TYPES = ['video', 'audio', 'subtitle'] as const;
/**
 * Union type of all track types.
 * @public
 */
export type TrackType = typeof ALL_TRACK_TYPES[number];

export type OutputTrack = {
	id: number;
	output: Output;
	type: TrackType;
} & ({
	type: 'video';
	source: VideoSource;
	metadata: VideoTrackMetadata;
} | {
	type: 'audio';
	source: AudioSource;
	metadata: AudioTrackMetadata;
} | {
	type: 'subtitle';
	source: SubtitleSource;
	metadata: SubtitleTrackMetadata;
});

export type OutputVideoTrack = OutputTrack & { type: 'video' };
export type OutputAudioTrack = OutputTrack & { type: 'audio' };
export type OutputSubtitleTrack = OutputTrack & { type: 'subtitle' };

/**
 * Base track metadata, applicable to all tracks.
 * @public
 */
export type BaseTrackMetadata = {
	/** The three-letter, ISO 639-2/T language code specifying the language of this track. */
	languageCode?: string;
};

/**
 * Additional metadata for video tracks.
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
};
/**
 * Additional metadata for audio tracks.
 * @public
 */
export type AudioTrackMetadata = BaseTrackMetadata & {};
/**
 * Additional metadata for subtitle tracks.
 * @public
 */
export type SubtitleTrackMetadata = BaseTrackMetadata & {};

const validateBaseTrackMetadata = (metadata: BaseTrackMetadata) => {
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError('metadata must be an object.');
	}
	if (metadata.languageCode !== undefined && !isIso639Dash2LanguageCode(metadata.languageCode)) {
		throw new TypeError('metadata.languageCode must be a three-letter, ISO 639-2/T language code.');
	}
};

/**
 * Main class orchestrating the creation of a new media file.
 * @public
 */
export class Output<
	F extends OutputFormat = OutputFormat,
	T extends Target = Target,
> {
	/** The format of the output file. */
	format: F;
	/** The target to which the file will be written. */
	target: T;
	/** The current state of the output. */
	state: 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized' = 'pending';

	/** @internal */
	_muxer: Muxer;
	/** @internal */
	_writer: Writer;
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

	constructor(options: OutputOptions<F, T>) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!(options.format instanceof OutputFormat)) {
			throw new TypeError('options.format must be an OutputFormat.');
		}
		if (!(options.target instanceof Target)) {
			throw new TypeError('options.target must be a Target.');
		}

		if (options.target._output) {
			throw new Error('Target is already used for another output.');
		}
		options.target._output = this;

		this.format = options.format;
		this.target = options.target;

		this._writer = options.target._createWriter();
		this._muxer = options.format._createMuxer(this);
	}

	/** Adds a video track to the output with the given source. Must be called before output is started. */
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

		this._addTrack('video', source, metadata);
	}

	/** Adds an audio track to the output with the given source. Must be called before output is started. */
	addAudioTrack(source: AudioSource, metadata: AudioTrackMetadata = {}) {
		if (!(source instanceof AudioSource)) {
			throw new TypeError('source must be an AudioSource.');
		}
		validateBaseTrackMetadata(metadata);

		this._addTrack('audio', source, metadata);
	}

	/** Adds a subtitle track to the output with the given source. Must be called before output is started. */
	addSubtitleTrack(source: SubtitleSource, metadata: SubtitleTrackMetadata = {}) {
		if (!(source instanceof SubtitleSource)) {
			throw new TypeError('source must be a SubtitleSource.');
		}
		validateBaseTrackMetadata(metadata);

		this._addTrack('subtitle', source, metadata);
	}

	/** @internal */
	private _addTrack(type: OutputTrack['type'], source: MediaSource, metadata: object) {
		if (this.state !== 'pending') {
			throw new Error('Cannot add track after output has been started or canceled.');
		}
		if (source._connectedTrack) {
			throw new Error('Source is already used for a track.');
		}

		// Verify maximum track count constraints
		const supportedTrackCounts = this.format.getSupportedTrackCounts();
		const presentTracksOfThisType = this._tracks.reduce(
			(count, track) => count + (track.type === type ? 1 : 0),
			0,
		);
		const maxCount = supportedTrackCounts[type].max;
		if (presentTracksOfThisType === maxCount) {
			throw new Error(
				maxCount === 0
					? `${this.format._name} does not support ${type} tracks.`
					: (`${this.format._name} does not support more than ${maxCount} ${type} track`
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

		const track = {
			id: this._tracks.length + 1,
			output: this,
			type,
			source: source as unknown,
			metadata,
		} as OutputTrack;

		if (track.type === 'video') {
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
		} else if (track.type === 'audio') {
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
		} else if (track.type === 'subtitle') {
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
		source._connectedTrack = track;
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
			this._writer.start();

			const release = await this._mutex.acquire();

			await this._muxer.start();

			for (const track of this._tracks) {
				track.source._start();
			}

			release();
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
			console.warn('Output has already been finalized.');
			return;
		}

		return this._cancelPromise = (async () => {
			this.state = 'canceled';

			const release = await this._mutex.acquire();

			const promises = this._tracks.map(x => x.source._flushOrWaitForClose());
			await Promise.all(promises);

			await this._writer.close();

			release();
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

			const promises = this._tracks.map(x => x.source._flushOrWaitForClose());
			await Promise.all(promises);

			await this._muxer.finalize();

			await this._writer.flush();
			await this._writer.finalize();

			this.state = 'finalized';

			release();
		})();
	}
}
