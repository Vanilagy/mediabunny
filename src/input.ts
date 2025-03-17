import { Demuxer } from './demuxer';
import { InputFormat } from './input-format';
import { assert } from './misc';
import { Reader } from './reader';
import { Source } from './source';

/**
 * The options for creating an Input object.
 * @public
 */
export type InputOptions = {
	/** A list of supported formats. If the source file is not of one of these formats, then it cannot be read. */
	formats: InputFormat[];
	/** The source from which data will be read. */
	source: Source;
};

/**
 * Represents an input media file. This is the root object from which all media read operations start.
 * @public
 */
export class Input {
	/** @internal */
	_source: Source;
	/** @internal */
	_formats: InputFormat[];
	/** @internal */
	_mainReader: Reader;
	/** @internal */
	_demuxerPromise: Promise<Demuxer> | null = null;
	/** @internal */
	_format: InputFormat | null = null;

	constructor(options: InputOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!Array.isArray(options.formats) || options.formats.some(x => !(x instanceof InputFormat))) {
			throw new TypeError('options.formats must be an array of InputFormat.');
		}
		if (!(options.source instanceof Source)) {
			throw new TypeError('options.source must be a Source.');
		}

		this._formats = options.formats;
		this._source = options.source;
		this._mainReader = new Reader(options.source);
	}

	/** @internal */
	_getDemuxer() {
		return this._demuxerPromise ??= (async () => {
			await this._mainReader.loadRange(0, 4096); // Load the first 4 kiB so we can determine the format

			for (const format of this._formats) {
				const canRead = await format._canReadInput(this);
				if (canRead) {
					this._format = format;
					return format._createDemuxer(this);
				}
			}

			throw new Error('Input has an unsupported or unrecognizable format.');
		})();
	}

	/**
	 * Returns the format of the input file. You can compare this result directly to the InputFormat singletons or use
	 * `instanceof` checks for subset-aware logic (for example, `format instanceof MatroskaInputFormat` is true for
	 * both MKV and WebM).
	 */
	async getFormat() {
		await this._getDemuxer();
		assert(this._format!);
		return this._format;
	}

	/**
	 * Computes the duration of the longest track in this input file, in seconds. More precisely, returns the largest
	 * end timestamp among all tracks.
	 */
	async computeDuration() {
		const demuxer = await this._getDemuxer();
		return demuxer.computeDuration();
	}

	/** Returns the list of all tracks of this input file. */
	async getTracks() {
		const demuxer = await this._getDemuxer();
		return demuxer.getTracks();
	}

	/** Returns the list of all video tracks of this input file. */
	async getVideoTracks() {
		const tracks = await this.getTracks();
		return tracks.filter(x => x.isVideoTrack());
	}

	/** Returns the primary video track of this input file, or null if there are no video tracks. */
	async getPrimaryVideoTrack() {
		const tracks = await this.getTracks();
		return tracks.find(x => x.isVideoTrack()) ?? null;
	}

	/** Returns the list of all audio tracks of this input file. */
	async getAudioTracks() {
		const tracks = await this.getTracks();
		return tracks.filter(x => x.isAudioTrack());
	}

	/** Returns the primary audio track of this input file, or null if there are no audio tracks. */
	async getPrimaryAudioTrack() {
		const tracks = await this.getTracks();
		return tracks.find(x => x.isAudioTrack()) ?? null;
	}

	/** Returns the full MIME type of this input file, including track codecs. */
	async getMimeType() {
		const demuxer = await this._getDemuxer();
		return demuxer.getMimeType();
	}

	/** Returns the size of the input file, in bytes. */
	async getSize() {
		return await this._source._getSize();
	}
}
