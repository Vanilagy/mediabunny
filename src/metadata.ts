/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Represents descriptive (non-technical) metadata about a media file, such as title, author, date, cover art, or other
 * attached files. Common tags are normalized by Mediabunny into a uniform format, while the `raw` field can be used to
 * directly read or write the underlying metadata tags (which differ by format).
 *
 * - For MP4/QuickTime files, the metadata refers to the data in `'moov'`-level `'udta'` and `'meta'` atoms.
 * - For WebM/Matroska files, the metadata refers to the Tags and Attachments elements whose target is 50 (MOVIE).
 * - For MP3 files, the metadata refers to the ID3v2 or ID3v1 tags.
 * - For Ogg files, there is no global metadata so instead, the metadata refers to the combined metadata of all tracks,
 * in Vorbis-style comment headers.
 * - For WAVE files, the metadata refers to the chunks within the RIFF INFO chunk.
 * - For ADTS files, the metadata refers to the ID3v2 tags.
 * - For FLAC files, the metadata lives in Vorbis style in the Vorbis comment block.
 * - For MPEG-TS files, metadata tags are currently not supported.
 *
 * @group Metadata tags
 * @public
 */
export type MetadataTags = {
	/** Title of the media (e.g. Gangnam Style, Titanic, etc.) */
	title?: string;
	/** Short description or subtitle of the media. */
	description?: string;
	/** Primary artist(s) or creator(s) of the work. */
	artist?: string;
	/** Album, collection, or compilation the media belongs to. */
	album?: string;
	/** Main credited artist for the album/collection as a whole. */
	albumArtist?: string;
	/** Position of this track within its album or collection (1-based). */
	trackNumber?: number;
	/** Total number of tracks in the album or collection. */
	tracksTotal?: number;
	/** Disc index if the release spans multiple discs (1-based). */
	discNumber?: number;
	/** Total number of discs in the release. */
	discsTotal?: number;
	/** Genre or category describing the media's style or content (e.g. Metal, Horror, etc.) */
	genre?: string;
	/** Release, recording or creation date of the media. */
	date?: Date;
	/** Full text lyrics or transcript associated with the media. */
	lyrics?: string;
	/** Freeform notes, remarks or commentary about the media. */
	comment?: string;
	/** Embedded images such as cover art, booklet scans, artwork or preview frames. */
	images?: AttachedImage[];
	/**
	 * The raw, underlying metadata tags.
	 *
	 * This field can be used for both reading and writing. When reading, it represents the original tags that were used
	 * to derive the normalized fields, and any additional metadata that Mediabunny doesn't understand. When writing, it
	 * can be used to set arbitrary metadata tags in the output file.
	 *
	 * The format of these tags differs per format:
	 * - MP4/QuickTime: By default, the keys refer to the names of the individual atoms in the `'ilst'` atom inside the
	 * `'meta'` atom, and the values are derived from the content of the `'data'` atom inside them. When a `'keys'` atom
	 * is also used, then the keys reflect the keys specified there (such as `'com.apple.quicktime.version'`).
	 * Additionally, any atoms within the `'udta'` atom are dumped into here, however with unknown internal format
	 * (`Uint8Array`).
	 * - WebM/Matroska: `SimpleTag` elements whose target is 50 (MOVIE), either containing string or `Uint8Array`
	 * values. Additionally, all attached files (such as font files) are included here, where the key corresponds to
	 * the FileUID and the value is an {@link AttachedFile}.
	 * - MP3: The ID3v2 tags, or a single `'TAG'` key with the contents of the ID3v1 tag.
	 * - ADTS: The ID3v2 tags.
	 * - Ogg: The key-value string pairs from the Vorbis-style comment header (see RFC 7845, Section 5.2).
	 * Additionally, the `'vendor'` key refers to the vendor string within this header.
	 * - WAVE: The individual metadata chunks within the RIFF INFO chunk. Values are always ISO 8859-1 strings.
	 * - FLAC: The key-value string pairs from the vorbis metadata block (see RFC 9639, Section D.2.3).
	 * Additionally, the `'vendor'` key refers to the vendor string within this header.
	 * - MPEG-TS: Not supported.
	*/
	raw?: Record<string, string | Uint8Array | RichImageData | AttachedFile | null>;
};

/**
 * An embedded image such as cover art, booklet scan, artwork or preview frame.
 *
 * @group Metadata tags
 * @public
 */
export type AttachedImage = {
	/** The raw image data. */
	data: Uint8Array;
	/** An RFC 6838 MIME type (e.g. image/jpeg, image/png, etc.) */
	mimeType: string;
	/** The kind or purpose of the image. */
	kind: 'coverFront' | 'coverBack' | 'unknown';
	/** The name of the image file. */
	name?: string;
	/** A description of the image. */
	description?: string;
};

/**
 * Image data with additional metadata.
 *
 * @group Metadata tags
 * @public
 */
export class RichImageData {
	/** Creates a new {@link RichImageData}. */
	constructor(
		/** The raw image data. */
		public data: Uint8Array,
		/** An RFC 6838 MIME type (e.g. image/jpeg, image/png, etc.) */
		public mimeType: string,
	) {
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		if (typeof mimeType !== 'string') {
			throw new TypeError('mimeType must be a string.');
		}
	}
}

/**
 * A file attached to a media file.
 *
 * @group Metadata tags
 * @public
 */
export class AttachedFile {
	/** Creates a new {@link AttachedFile}. */
	constructor(
		/** The raw file data. */
		public data: Uint8Array,
		/** An RFC 6838 MIME type (e.g. image/jpeg, image/png, font/ttf, etc.) */
		public mimeType?: string,
		/** The name of the file. */
		public name?: string,
		/** A description of the file. */
		public description?: string,
	) {
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		if (mimeType !== undefined && typeof mimeType !== 'string') {
			throw new TypeError('mimeType, when provided, must be a string.');
		}
		if (name !== undefined && typeof name !== 'string') {
			throw new TypeError('name, when provided, must be a string.');
		}
		if (description !== undefined && typeof description !== 'string') {
			throw new TypeError('description, when provided, must be a string.');
		}
	}
};

export const validateMetadataTags = (tags: MetadataTags) => {
	if (!tags || typeof tags !== 'object') {
		throw new TypeError('tags must be an object.');
	}
	if (tags.title !== undefined && typeof tags.title !== 'string') {
		throw new TypeError('tags.title, when provided, must be a string.');
	}
	if (tags.description !== undefined && typeof tags.description !== 'string') {
		throw new TypeError('tags.description, when provided, must be a string.');
	}
	if (tags.artist !== undefined && typeof tags.artist !== 'string') {
		throw new TypeError('tags.artist, when provided, must be a string.');
	}
	if (tags.album !== undefined && typeof tags.album !== 'string') {
		throw new TypeError('tags.album, when provided, must be a string.');
	}
	if (tags.albumArtist !== undefined && typeof tags.albumArtist !== 'string') {
		throw new TypeError('tags.albumArtist, when provided, must be a string.');
	}
	if (tags.trackNumber !== undefined && (!Number.isInteger(tags.trackNumber) || tags.trackNumber <= 0)) {
		throw new TypeError('tags.trackNumber, when provided, must be a positive integer.');
	}
	if (
		tags.tracksTotal !== undefined
		&& (!Number.isInteger(tags.tracksTotal) || tags.tracksTotal <= 0)
	) {
		throw new TypeError('tags.tracksTotal, when provided, must be a positive integer.');
	}
	if (tags.discNumber !== undefined && (!Number.isInteger(tags.discNumber) || tags.discNumber <= 0)) {
		throw new TypeError('tags.discNumber, when provided, must be a positive integer.');
	}
	if (
		tags.discsTotal !== undefined
		&& (!Number.isInteger(tags.discsTotal) || tags.discsTotal <= 0)
	) {
		throw new TypeError('tags.discsTotal, when provided, must be a positive integer.');
	}
	if (tags.genre !== undefined && typeof tags.genre !== 'string') {
		throw new TypeError('tags.genre, when provided, must be a string.');
	}
	if (tags.date !== undefined && (!(tags.date instanceof Date) || Number.isNaN(tags.date.getTime()))) {
		throw new TypeError('tags.date, when provided, must be a valid Date.');
	}
	if (tags.lyrics !== undefined && typeof tags.lyrics !== 'string') {
		throw new TypeError('tags.lyrics, when provided, must be a string.');
	}
	if (tags.images !== undefined) {
		if (!Array.isArray(tags.images)) {
			throw new TypeError('tags.images, when provided, must be an array.');
		}
		for (const image of tags.images) {
			if (!image || typeof image !== 'object') {
				throw new TypeError('Each image in tags.images must be an object.');
			}
			if (!(image.data instanceof Uint8Array)) {
				throw new TypeError('Each image.data must be a Uint8Array.');
			}
			if (typeof image.mimeType !== 'string') {
				throw new TypeError('Each image.mimeType must be a string.');
			}
			if (!['coverFront', 'coverBack', 'unknown'].includes(image.kind)) {
				throw new TypeError('Each image.kind must be \'coverFront\', \'coverBack\', or \'unknown\'.');
			}
		}
	}
	if (tags.comment !== undefined && typeof tags.comment !== 'string') {
		throw new TypeError('tags.comment, when provided, must be a string.');
	}
	if (tags.raw !== undefined) {
		if (!tags.raw || typeof tags.raw !== 'object') {
			throw new TypeError('tags.raw, when provided, must be an object.');
		}

		for (const value of Object.values(tags.raw)) {
			if (
				value !== null
				&& typeof value !== 'string'
				&& !(value instanceof Uint8Array)
				&& !(value instanceof RichImageData)
				&& !(value instanceof AttachedFile)
			) {
				throw new TypeError(
					'Each value in tags.raw must be a string, Uint8Array, RichImageData, AttachedFile, or null.',
				);
			}
		}
	}
};

export const metadataTagsAreEmpty = (tags: MetadataTags) => {
	return tags.title === undefined
		&& tags.description === undefined
		&& tags.artist === undefined
		&& tags.album === undefined
		&& tags.albumArtist === undefined
		&& tags.trackNumber === undefined
		&& tags.tracksTotal === undefined
		&& tags.discNumber === undefined
		&& tags.discsTotal === undefined
		&& tags.genre === undefined
		&& tags.date === undefined
		&& tags.lyrics === undefined
		&& (!tags.images || tags.images.length === 0)
		&& tags.comment === undefined
		&& (tags.raw === undefined || Object.keys(tags.raw).length === 0);
};

/**
 * Specifies a track's disposition, i.e. information about its intended usage.
 * @public
 * @group Miscellaneous
 */
export type TrackDisposition = {
	/**
	 * Indicates that this track is eligible for automatic selection by a player; that it is the main track among other,
	 * non-default tracks of the same type.
	 */
	default: boolean;
	/**
	 * Indicates that players should always display this track by default, even if it goes against the user's default
	 * preferences. For example, a subtitle track only containing translations of foreign-language audio.
	 */
	forced: boolean;
	/** Indicates that this track is in the content's original language. */
	original: boolean;
	/** Indicates that this track contains commentary. */
	commentary: boolean;
	/** Indicates that this track is intended for hearing-impaired users. */
	hearingImpaired: boolean;
	/** Indicates that this track is intended for visually-impaired users. */
	visuallyImpaired: boolean;
};

export const DEFAULT_TRACK_DISPOSITION: TrackDisposition = {
	default: true,
	forced: false,
	original: false,
	commentary: false,
	hearingImpaired: false,
	visuallyImpaired: false,
};

export const validateTrackDisposition = (disposition: Partial<TrackDisposition>) => {
	if (!disposition || typeof disposition !== 'object') {
		throw new TypeError('disposition must be an object.');
	}
	if (disposition.default !== undefined && typeof disposition.default !== 'boolean') {
		throw new TypeError('disposition.default must be a boolean.');
	}
	if (disposition.forced !== undefined && typeof disposition.forced !== 'boolean') {
		throw new TypeError('disposition.forced must be a boolean.');
	}
	if (disposition.original !== undefined && typeof disposition.original !== 'boolean') {
		throw new TypeError('disposition.original must be a boolean.');
	}
	if (disposition.commentary !== undefined && typeof disposition.commentary !== 'boolean') {
		throw new TypeError('disposition.commentary must be a boolean.');
	}
	if (disposition.hearingImpaired !== undefined && typeof disposition.hearingImpaired !== 'boolean') {
		throw new TypeError('disposition.hearingImpaired must be a boolean.');
	}
	if (disposition.visuallyImpaired !== undefined && typeof disposition.visuallyImpaired !== 'boolean') {
		throw new TypeError('disposition.visuallyImpaired must be a boolean.');
	}
};
