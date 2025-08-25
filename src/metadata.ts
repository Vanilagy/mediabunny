// TODO: Give this a different name. This clashes with a web concept. Question is, what?

export type MediaMetadata = {
	title?: string;
	artist?: string;
	album?: string;
	albumArtist?: string;
	trackNumber?: number;
	discNumber?: number;
	genre?: string;
	releasedAt?: Date;
	images?: {
		data: Uint8Array;
		mimeType: string;
		kind: 'coverFront' | 'coverBack' | 'unknown';
		name?: string;
		description?: string;
	}[];
	comment?: string;
};

export const validateMediaMetadata = (metadata: MediaMetadata) => {
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError('metadata must be an object.');
	}
	if (metadata.title !== undefined && typeof metadata.title !== 'string') {
		throw new TypeError('metadata.title, when provided, must be a string.');
	}
	if (metadata.artist !== undefined && typeof metadata.artist !== 'string') {
		throw new TypeError('metadata.artist, when provided, must be a string.');
	}
	if (metadata.album !== undefined && typeof metadata.album !== 'string') {
		throw new TypeError('metadata.album, when provided, must be a string.');
	}
	if (metadata.albumArtist !== undefined && typeof metadata.albumArtist !== 'string') {
		throw new TypeError('metadata.albumArtist, when provided, must be a string.');
	}
	if (metadata.trackNumber !== undefined && (!Number.isInteger(metadata.trackNumber) || metadata.trackNumber <= 0)) {
		throw new TypeError('metadata.trackNumber, when provided, must be a positive integer.');
	}
	if (metadata.discNumber !== undefined && (!Number.isInteger(metadata.discNumber) || metadata.discNumber <= 0)) {
		throw new TypeError('metadata.discNumber, when provided, must be a positive integer.');
	}
	if (metadata.genre !== undefined && typeof metadata.genre !== 'string') {
		throw new TypeError('metadata.genre, when provided, must be a string.');
	}
	if (metadata.releasedAt !== undefined && !(metadata.releasedAt instanceof Date)) {
		throw new TypeError('metadata.releasedAt, when provided, must be a Date.');
	}
	if (metadata.comment !== undefined && typeof metadata.comment !== 'string') {
		throw new TypeError('metadata.comment, when provided, must be a string.');
	}
	if (metadata.images !== undefined) {
		if (!Array.isArray(metadata.images)) {
			throw new TypeError('metadata.images, when provided, must be an array.');
		}
		for (const image of metadata.images) {
			if (!image || typeof image !== 'object') {
				throw new TypeError('Each image in metadata.images must be an object.');
			}
			if (!(image.data instanceof Uint8Array)) {
				throw new TypeError('Each image.data must be a Uint8Array.');
			}
			if (typeof image.mimeType !== 'string') {
				throw new TypeError('Each image.mimeType must be a string.');
			}
			if (!['coverFront', 'coverBack', 'other'].includes(image.kind)) {
				throw new TypeError('Each image.kind must be \'coverFront\', \'coverBack\', or \'other\'.');
			}
		}
	}
};

export const mediaMetadataIsEmpty = (metadata: MediaMetadata) => {
	return !metadata.title
		&& !metadata.artist
		&& !metadata.album
		&& !metadata.albumArtist
		&& !metadata.trackNumber
		&& !metadata.discNumber
		&& !metadata.genre
		&& !metadata.releasedAt
		&& !metadata.comment
		&& (!metadata.images || metadata.images.length === 0);
};
