/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AdtsMuxer } from './adts/adts-muxer';
import {
	AUDIO_CODECS,
	AudioCodec,
	MediaCodec,
	NON_PCM_AUDIO_CODECS,
	PCM_AUDIO_CODECS,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { FlacMuxer } from './flac/flac-muxer';
import { IsobmffMuxer } from './isobmff/isobmff-muxer';
import { MatroskaMuxer } from './matroska/matroska-muxer';
import { MediaSource } from './media-source';
import { Mp3Muxer } from './mp3/mp3-muxer';
import { Muxer } from './muxer';
import { OggMuxer } from './ogg/ogg-muxer';
import { Output, TrackType } from './output';
import { MpegTsMuxer } from './mpeg-ts/mpeg-ts-muxer';
import { WaveMuxer } from './wave/wave-muxer';

/**
 * Specifies an inclusive range of integers.
 * @group Miscellaneous
 * @public
 */
export type InclusiveIntegerRange = {
	/** The integer cannot be less than this. */
	min: number;
	/** The integer cannot be greater than this. */
	max: number;
};

/**
 * Specifies the number of tracks (for each track type and in total) that an output format supports.
 * @group Output formats
 * @public
 */
export type TrackCountLimits = {
	[K in TrackType]: InclusiveIntegerRange;
} & {
	/** Specifies the overall allowed range of track counts for the output format. */
	total: InclusiveIntegerRange;
};

/**
 * Base class representing an output media file format.
 * @group Output formats
 * @public
 */
export abstract class OutputFormat {
	/** @internal */
	abstract _createMuxer(output: Output): Muxer;
	/** @internal */
	abstract get _name(): string;

	/** The file extension used by this output format, beginning with a dot. */
	abstract get fileExtension(): string;
	/** The base MIME type of the output format. */
	abstract get mimeType(): string;
	/** Returns a list of media codecs that this output format can contain. */
	abstract getSupportedCodecs(): MediaCodec[];
	/** Returns the number of tracks that this output format supports. */
	abstract getSupportedTrackCounts(): TrackCountLimits;
	/** Whether this output format supports video rotation metadata. */
	abstract get supportsVideoRotationMetadata(): boolean;
	/**
	 * Whether this output format's tracks store timestamped media data. When `true`, the timestamps of added packets
	 * will be respected, allowing things like gaps in media data or non-zero start times. When `false`, the format's
	 * media data implicitly starts at zero and follows an implicit sequential timing from there, using the intrinsic
	 * durations of the media data.
	 */
	abstract get supportsTimestampedMediaData(): boolean;

	/** Returns a list of video codecs that this output format can contain. */
	getSupportedVideoCodecs() {
		return this.getSupportedCodecs()
			.filter(codec => (VIDEO_CODECS as readonly string[]).includes(codec)) as VideoCodec[];
	}

	/** Returns a list of audio codecs that this output format can contain. */
	getSupportedAudioCodecs() {
		return this.getSupportedCodecs()
			.filter(codec => (AUDIO_CODECS as readonly string[]).includes(codec)) as AudioCodec[];
	}

	/** Returns a list of subtitle codecs that this output format can contain. */
	getSupportedSubtitleCodecs() {
		return this.getSupportedCodecs()
			.filter(codec => (SUBTITLE_CODECS as readonly string[]).includes(codec)) as SubtitleCodec[];
	}

	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_codecUnsupportedHint(codec: MediaCodec) {
		return '';
	}
}

/**
 * ISOBMFF-specific output options.
 * @group Output formats
 * @public
 */
export type IsobmffOutputFormatOptions = {
	/**
	 * Controls the placement of metadata in the file. Placing metadata at the start of the file is known as "Fast
	 * Start", which results in better playback at the cost of more required processing or memory.
	 *
	 * Use `false` to disable Fast Start, placing the metadata at the end of the file. Fastest and uses the least
	 * memory.
	 *
	 * Use `'in-memory'` to produce a file with Fast Start by keeping all media chunks in memory until the file is
	 * finalized. This produces a high-quality and compact output at the cost of a more expensive finalization step and
	 * higher memory requirements. Data will be written monotonically (in order) when this option is set.
	 *
	 * Use `'reserve'` to reserve space at the start of the file into which the metadata will be written later.	This
	 * produces a file with Fast Start but requires knowledge about the expected length of the file beforehand. When
	 * using this option, you must set the {@link BaseTrackMetadata.maximumPacketCount} field in the track metadata
	 * for all tracks.
	 *
	 * Use `'fragmented'` to place metadata at the start of the file by creating a fragmented file (fMP4). In a
	 * fragmented file, chunks of media and their metadata are written to the file in "fragments", eliminating the need
	 * to put all metadata in one place. Fragmented files are useful for streaming contexts, as each fragment can be
	 * played individually without requiring knowledge of the other fragments. Furthermore, they remain lightweight to
	 * create even for very large files, as they don't require all media to be kept in memory. However, fragmented files
	 * are not as widely and wholly supported as regular MP4/MOV files. Data will be written monotonically (in order)
	 * when this option is set.
	 *
	 * When this field is not defined, either `false` or `'in-memory'` will be used, automatically determined based on
	 * the type of output target used.
	 */
	fastStart?: false | 'in-memory' | 'reserve' | 'fragmented';

	/**
	 * When using `fastStart: 'fragmented'`, this field controls the minimum duration of each fragment, in seconds.
	 * New fragments will only be created when the current fragment is longer than this value. Defaults to 1 second.
	 */
	minimumFragmentDuration?: number;

	/**
	 * The metadata format to use for writing metadata tags.
	 *
	 * - `'auto'` (default): Behaves like `'mdir'` for MP4 and like `'udta'` for QuickTime, matching FFmpeg's default
	 * behavior.
	 * - `'mdir'`: Write tags into `moov/udta/meta` using the 'mdir' handler format.
	 * - `'mdta'`: Write tags into `moov/udta/meta` using the 'mdta' handler format, equivalent to FFmpeg's
	 * `use_metadata_tags` flag. This allows for custom keys of arbitrary length.
	 * - `'udta'`: Write tags directly into `moov/udta`.
	 */
	metadataFormat?: 'auto' | 'mdir' | 'mdta' | 'udta';

	/**
	 * Will be called once the ftyp (File Type) box of the output file has been written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onFtyp?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called once the moov (Movie) box of the output file has been written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onMoov?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called for each finalized mdat (Media Data) box of the output file. Usage of this callback is not
	 * recommended when not using `fastStart: 'fragmented'`, as there will be one monolithic mdat box which might
	 * require large amounts of memory.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onMdat?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called for each finalized moof (Movie Fragment) box of the output file.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 * @param timestamp - The start timestamp of the fragment in seconds.
	 */
	onMoof?: (data: Uint8Array, position: number, timestamp: number) => unknown;
};

/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @group Output formats
 * @public
 */
export abstract class IsobmffOutputFormat extends OutputFormat {
	/** @internal */
	_options: IsobmffOutputFormatOptions;

	/** Internal constructor. */
	constructor(options: IsobmffOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.fastStart !== undefined
			&& ![false, 'in-memory', 'reserve', 'fragmented'].includes(options.fastStart)
		) {
			throw new TypeError(
				'options.fastStart, when provided, must be false, \'in-memory\', \'reserve\', or \'fragmented\'.',
			);
		}
		if (
			options.minimumFragmentDuration !== undefined
			&& (!Number.isFinite(options.minimumFragmentDuration) || options.minimumFragmentDuration < 0)
		) {
			throw new TypeError('options.minimumFragmentDuration, when provided, must be a non-negative number.');
		}
		if (options.onFtyp !== undefined && typeof options.onFtyp !== 'function') {
			throw new TypeError('options.onFtyp, when provided, must be a function.');
		}
		if (options.onMoov !== undefined && typeof options.onMoov !== 'function') {
			throw new TypeError('options.onMoov, when provided, must be a function.');
		}
		if (options.onMdat !== undefined && typeof options.onMdat !== 'function') {
			throw new TypeError('options.onMdat, when provided, must be a function.');
		}
		if (options.onMoof !== undefined && typeof options.onMoof !== 'function') {
			throw new TypeError('options.onMoof, when provided, must be a function.');
		}
		if (
			options.metadataFormat !== undefined
			&& !['mdir', 'mdta', 'udta', 'auto'].includes(options.metadataFormat)
		) {
			throw new TypeError(
				'options.metadataFormat, when provided, must be either \'auto\', \'mdir\', \'mdta\', or \'udta\'.',
			);
		}

		super();

		this._options = options;
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const max = 2 ** 32 - 1; // Have fun reaching this one

		return {
			video: { min: 0, max },
			audio: { min: 0, max },
			subtitle: { min: 0, max },
			total: { min: 1, max },
		};
	}

	get supportsVideoRotationMetadata() {
		return true;
	}

	get supportsTimestampedMediaData() {
		return true;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new IsobmffMuxer(output, this);
	}
}

/**
 * MPEG-4 Part 14 (MP4) file format. Supports most codecs.
 * @group Output formats
 * @public
 */
export class Mp4OutputFormat extends IsobmffOutputFormat {
	/** Creates a new {@link Mp4OutputFormat} configured with the specified `options`. */
	constructor(options?: IsobmffOutputFormatOptions) {
		super(options);
	}

	/** @internal */
	get _name() {
		return 'MP4';
	}

	get fileExtension() {
		return '.mp4';
	}

	get mimeType() {
		return 'video/mp4';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...NON_PCM_AUDIO_CODECS,

			// These are supported via ISO/IEC 23003-5:
			'pcm-s16',
			'pcm-s16be',
			'pcm-s24',
			'pcm-s24be',
			'pcm-s32',
			'pcm-s32be',
			'pcm-f32',
			'pcm-f32be',
			'pcm-f64',
			'pcm-f64be',

			...SUBTITLE_CODECS,
		];
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (new MovOutputFormat().getSupportedCodecs().includes(codec)) {
			return ' Switching to MOV will grant support for this codec.';
		}

		return '';
	}
}

/**
 * QuickTime File Format (QTFF), often called MOV. Supports all video and audio codecs, but not subtitle codecs.
 * @group Output formats
 * @public
 */
export class MovOutputFormat extends IsobmffOutputFormat {
	/** Creates a new {@link MovOutputFormat} configured with the specified `options`. */
	constructor(options?: IsobmffOutputFormatOptions) {
		super(options);
	}

	/** @internal */
	get _name() {
		return 'MOV';
	}

	get fileExtension() {
		return '.mov';
	}

	get mimeType() {
		return 'video/quicktime';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...AUDIO_CODECS,
		];
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (new Mp4OutputFormat().getSupportedCodecs().includes(codec)) {
			return ' Switching to MP4 will grant support for this codec.';
		}

		return '';
	}
}

/**
 * Matroska-specific output options.
 * @group Output formats
 * @public
 */
export type MkvOutputFormatOptions = {
	/**
	 * Configures the output to only append new data at the end, useful for live-streaming the file as it's being
	 * created. When enabled, some features such as storing duration and seeking will be disabled or impacted, so don't
	 * use this option when you want to write out a clean file for later use.
	 */
	appendOnly?: boolean;

	/**
	 * This field controls the minimum duration of each Matroska cluster, in seconds. New clusters will only be created
	 * when the current cluster is longer than this value. Defaults to 1 second.
	 */
	minimumClusterDuration?: number;

	/**
	 * Will be called once the EBML header of the output file has been written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onEbmlHeader?: (data: Uint8Array, position: number) => void;

	/**
	 * Will be called once the header part of the Matroska Segment element has been written. The header data includes
	 * the Segment element and everything inside it, up to (but excluding) the first Matroska Cluster.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onSegmentHeader?: (data: Uint8Array, position: number) => unknown;

	/**
	 * Will be called for each finalized Matroska Cluster of the output file.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 * @param timestamp - The start timestamp of the cluster in seconds.
	 */
	onCluster?: (data: Uint8Array, position: number, timestamp: number) => unknown;
};

/**
 * Matroska file format.
 *
 * Supports writing transparent video. For a video track to be marked as transparent, the first packet added must
 * contain alpha side data.
 *
 * @group Output formats
 * @public
 */
export class MkvOutputFormat extends OutputFormat {
	/** @internal */
	_options: MkvOutputFormatOptions;

	/** Creates a new {@link MkvOutputFormat} configured with the specified `options`. */
	constructor(options: MkvOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.appendOnly !== undefined && typeof options.appendOnly !== 'boolean') {
			throw new TypeError('options.appendOnly, when provided, must be a boolean.');
		}
		if (
			options.minimumClusterDuration !== undefined
			&& (!Number.isFinite(options.minimumClusterDuration) || options.minimumClusterDuration < 0)
		) {
			throw new TypeError('options.minimumClusterDuration, when provided, must be a non-negative number.');
		}
		if (options.onEbmlHeader !== undefined && typeof options.onEbmlHeader !== 'function') {
			throw new TypeError('options.onEbmlHeader, when provided, must be a function.');
		}
		if (options.onSegmentHeader !== undefined && typeof options.onSegmentHeader !== 'function') {
			throw new TypeError('options.onHeader, when provided, must be a function.');
		}
		if (options.onCluster !== undefined && typeof options.onCluster !== 'function') {
			throw new TypeError('options.onCluster, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new MatroskaMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'Matroska';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const max = 127;

		return {
			video: { min: 0, max },
			audio: { min: 0, max },
			subtitle: { min: 0, max },
			total: { min: 1, max },
		};
	}

	get fileExtension() {
		return '.mkv';
	}

	get mimeType() {
		return 'video/x-matroska';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS,
			...NON_PCM_AUDIO_CODECS,
			...PCM_AUDIO_CODECS.filter(codec => !['pcm-s8', 'pcm-f32be', 'pcm-f64be', 'ulaw', 'alaw'].includes(codec)),
			...SUBTITLE_CODECS,
		];
	}

	get supportsVideoRotationMetadata() {
		// While it technically does support it with ProjectionPoseRoll, many players appear to ignore this value
		return false;
	}

	get supportsTimestampedMediaData() {
		return true;
	}
}

/**
 * WebM-specific output options.
 * @group Output formats
 * @public
 */
export type WebMOutputFormatOptions = MkvOutputFormatOptions;

/**
 * WebM file format, based on Matroska.
 *
 * Supports writing transparent video. For a video track to be marked as transparent, the first packet added must
 * contain alpha side data.
 *
 * @group Output formats
 * @public
 */
export class WebMOutputFormat extends MkvOutputFormat {
	/** Creates a new {@link WebMOutputFormat} configured with the specified `options`. */
	constructor(options?: MkvOutputFormatOptions) {
		super(options);
	}

	override getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS.filter(codec => ['vp8', 'vp9', 'av1'].includes(codec)),
			...AUDIO_CODECS.filter(codec => ['opus', 'vorbis'].includes(codec)),
			...SUBTITLE_CODECS,
		];
	}

	/** @internal */
	override get _name() {
		return 'WebM';
	}

	override get fileExtension() {
		return '.webm';
	}

	override get mimeType() {
		return 'video/webm';
	}

	/** @internal */
	override _codecUnsupportedHint(codec: MediaCodec) {
		if (new MkvOutputFormat().getSupportedCodecs().includes(codec)) {
			return ' Switching to MKV will grant support for this codec.';
		}

		return '';
	}
}

/**
 * MP3-specific output options.
 * @group Output formats
 * @public
 */
export type Mp3OutputFormatOptions = {
	/**
	 * Controls whether the Xing header, which contains additional metadata as well as an index, is written to the start
	 * of the MP3 file. When disabled, the writing process becomes append-only. Defaults to `true`.
	 */
	xingHeader?: boolean;

	/**
	 * Will be called once the Xing metadata frame is finalized.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onXingFrame?: (data: Uint8Array, position: number) => unknown;
};

/**
 * MP3 file format.
 * @group Output formats
 * @public
 */
export class Mp3OutputFormat extends OutputFormat {
	/** @internal */
	_options: Mp3OutputFormatOptions;

	/** Creates a new {@link Mp3OutputFormat} configured with the specified `options`. */
	constructor(options: Mp3OutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.xingHeader !== undefined && typeof options.xingHeader !== 'boolean') {
			throw new TypeError('options.xingHeader, when provided, must be a boolean.');
		}
		if (options.onXingFrame !== undefined && typeof options.onXingFrame !== 'function') {
			throw new TypeError('options.onXingFrame, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new Mp3Muxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'MP3';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.mp3';
	}

	get mimeType() {
		return 'audio/mpeg';
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['mp3'];
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * WAVE-specific output options.
 * @group Output formats
 * @public
 */
export type WavOutputFormatOptions = {
	/**
	 * When enabled, an RF64 file will be written, allowing for file sizes to exceed 4 GiB, which is otherwise not
	 * possible for regular WAVE files.
	 */
	large?: boolean;

	/**
	 * The metadata format to use for writing metadata tags.
	 *
	 * - `'info'` (default): Writes metadata into a RIFF INFO LIST chunk, the default way to contain metadata tags
	 * within WAVE. Only allows for a limited subset of tags to be written.
	 * - `'id3'`: Writes metadata into an ID3 chunk. Non-default, but used by many taggers in practice. Allows for a
	 * much larger and richer set of tags to be written.
	 */
	metadataFormat?: 'info' | 'id3';

	/**
	 * Will be called once the file header is written. The header consists of the RIFF header, the format chunk,
	 * metadata chunks, and the start of the data chunk (with a placeholder size of 0).
	 */
	onHeader?: (data: Uint8Array, position: number) => unknown;
};

/**
 * WAVE file format, based on RIFF.
 * @group Output formats
 * @public
 */
export class WavOutputFormat extends OutputFormat {
	/** @internal */
	_options: WavOutputFormatOptions;

	/** Creates a new {@link WavOutputFormat} configured with the specified `options`. */
	constructor(options: WavOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.large !== undefined && typeof options.large !== 'boolean') {
			throw new TypeError('options.large, when provided, must be a boolean.');
		}
		if (options.metadataFormat !== undefined && !['info', 'id3'].includes(options.metadataFormat)) {
			throw new TypeError('options.metadataFormat, when provided, must be either \'info\' or \'id3\'.');
		}
		if (options.onHeader !== undefined && typeof options.onHeader !== 'function') {
			throw new TypeError('options.onHeader, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new WaveMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'WAVE';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.wav';
	}

	get mimeType() {
		return 'audio/wav';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...PCM_AUDIO_CODECS.filter(codec =>
				['pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32', 'pcm-u8', 'ulaw', 'alaw'].includes(codec),
			),
		];
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * Ogg-specific output options.
 * @group Output formats
 * @public
 */
export type OggOutputFormatOptions = {
	/**
	 * The maximum duration of each Ogg page, in seconds. This is useful for streaming contexts where more frequent page
	 * output is desired. By default, pages are only flushed when they exceed a certain size.
	 */
	maximumPageDuration?: number;

	/**
	 * Will be called for each Ogg page that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 * @param source - The {@link MediaSource} backing the page's logical bitstream (track).
	 */
	onPage?: (data: Uint8Array, position: number, source: MediaSource) => unknown;
};

/**
 * Ogg file format.
 * @group Output formats
 * @public
 */
export class OggOutputFormat extends OutputFormat {
	/** @internal */
	_options: OggOutputFormatOptions;

	/** Creates a new {@link OggOutputFormat} configured with the specified `options`. */
	constructor(options: OggOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.maximumPageDuration !== undefined
			&& (!Number.isFinite(options.maximumPageDuration) || options.maximumPageDuration <= 0)
		) {
			throw new TypeError('options.maximumPageDuration, when provided, must be a positive number.');
		}
		if (options.onPage !== undefined && typeof options.onPage !== 'function') {
			throw new TypeError('options.onPage, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new OggMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'Ogg';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const max = 2 ** 32; // Have fun reaching this one

		return {
			video: { min: 0, max: 0 },
			audio: { min: 0, max },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max },
		};
	}

	get fileExtension() {
		return '.ogg';
	}

	get mimeType() {
		return 'application/ogg';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...AUDIO_CODECS.filter(codec => ['vorbis', 'opus'].includes(codec)),
		];
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * ADTS-specific output options.
 * @group Output formats
 * @public
 */
export type AdtsOutputFormatOptions = {
	/**
	 * Will be called for each ADTS frame that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onFrame?: (data: Uint8Array, position: number) => unknown;
};

/**
 * ADTS file format.
 * @group Output formats
 * @public
 */
export class AdtsOutputFormat extends OutputFormat {
	/** @internal */
	_options: AdtsOutputFormatOptions;

	/** Creates a new {@link AdtsOutputFormat} configured with the specified `options`. */
	constructor(options: AdtsOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.onFrame !== undefined && typeof options.onFrame !== 'function') {
			throw new TypeError('options.onFrame, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new AdtsMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'ADTS';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.aac';
	}

	get mimeType() {
		return 'audio/aac';
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['aac'];
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * FLAC-specific output options.
 * @group Output formats
 * @public
 */
export type FlacOutputFormatOptions = {
	/**
	 * Will be called for each FLAC frame that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onFrame?: (data: Uint8Array, position: number) => unknown;
};

/**
 * FLAC file format.
 * @group Output formats
 * @public
 */
export class FlacOutputFormat extends OutputFormat {
	/** @internal */
	_options: FlacOutputFormatOptions;

	/** Creates a new {@link FlacOutputFormat} configured with the specified `options`. */
	constructor(options: FlacOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new FlacMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'FLAC';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	get fileExtension() {
		return '.flac';
	}

	get mimeType() {
		return 'audio/flac';
	}

	getSupportedCodecs(): MediaCodec[] {
		return ['flac'];
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false;
	}
}

/**
 * MPEG-TS-specific output options.
 * @group Output formats
 * @public
 */
export type MpegTsOutputFormatOptions = {
	/**
	 * Will be called for each 188-byte Transport Stream packet that is written.
	 *
	 * @param data - The raw bytes.
	 * @param position - The byte offset of the data in the file.
	 */
	onPacket?: (data: Uint8Array, position: number) => unknown;
};

/**
 * MPEG Transport Stream file format.
 * @group Output formats
 * @public
 */
export class MpegTsOutputFormat extends OutputFormat {
	/** @internal */
	_options: MpegTsOutputFormatOptions;

	/** Creates a new {@link MpegTsOutputFormat} configured with the specified `options`. */
	constructor(options: MpegTsOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.onPacket !== undefined && typeof options.onPacket !== 'function') {
			throw new TypeError('options.onPacket, when provided, must be a function.');
		}

		super();

		this._options = options;
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new MpegTsMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'MPEG-TS';
	}

	getSupportedTrackCounts(): TrackCountLimits {
		const maxVideo = 16; // Stream IDs 0xE0-0xEF
		const maxAudio = 32;
		const maxTotal = maxVideo + maxAudio;

		return {
			video: { min: 0, max: maxVideo },
			audio: { min: 0, max: maxAudio },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: maxTotal },
		};
	}

	get fileExtension() {
		return '.ts';
	}

	get mimeType() {
		return 'video/MP2T';
	}

	getSupportedCodecs(): MediaCodec[] {
		return [
			...VIDEO_CODECS.filter(codec => ['avc', 'hevc'].includes(codec)),
			...AUDIO_CODECS.filter(codec => ['aac', 'mp3', 'ac3', 'eac3'].includes(codec)),
		];
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return true;
	}
}
