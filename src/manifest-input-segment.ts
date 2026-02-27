import { AES_128_BLOCK_SIZE, createAesDecryptStream } from './aes';
import { Input } from './input';
import { ManifestInputVariant } from './manifest-input-variant';
import { arrayArgmin, assert } from './misc';
import { fs } from './node';
import { readBytes, Reader } from './reader';
import { ReadableStreamSource, Source } from './source';

export type SegmentEncryptionInfo = {
	method: 'AES-128';
	keyUri: string;
	iv: Uint8Array | null;
	keyFormat: string;
};

export type ManifestInputSegmentLocation = {
	path: string;
	offset: number;
	length: number | null;
};

export class ManifestInputSegment {
	readonly variant: ManifestInputVariant;
	readonly location: ManifestInputSegmentLocation;
	readonly relativeTimestamp: number;
	readonly duration: number;
	readonly title: string | null;
	readonly encryption: SegmentEncryptionInfo | null;
	readonly firstSegment: ManifestInputSegment | null;
	readonly initSegment: ManifestInputSegment | null;

	constructor(
		variant: ManifestInputVariant,
		location: ManifestInputSegmentLocation,
		relativeTimestamp: number,
		duration: number,
		title: string | null,
		encryption: SegmentEncryptionInfo | null,
		firstSegment: ManifestInputSegment | null,
		initSegment: ManifestInputSegment | null,
	) {
		this.variant = variant;
		this.location = location;
		this.relativeTimestamp = relativeTimestamp;
		this.duration = duration;
		this.title = title;
		this.encryption = encryption;
		this.firstSegment = firstSegment;
		this.initSegment = initSegment;
	}

	toInput(): Promise<Input> {
		const cacheEntry = this.variant._inputCache.find(x => x.segment === this);
		if (cacheEntry) {
			cacheEntry.age = this.variant._nextInputCacheAge++;
			return cacheEntry.inputPromise;
		}

		const inputPromise = (async () => {
			let initInputPromise: Promise<Input> | null = null;
			if (this.initSegment || this.firstSegment) {
				initInputPromise = (this.initSegment ?? this.firstSegment)!.toInput();
			}

			let source: Source;

			const needsSlice = this.location.offset > 0 || this.location.length !== null;

			if (!this.encryption) {
				source = await this.variant.input._getSourceCached(this.location.path);
				if (needsSlice) {
					source = source.slice(this.location.offset, this.location.length ?? undefined);
				}
			} else {
				assert(this.encryption.iv);

				let ciphertextSource = await this.variant.input._getSourceCached(this.location.path);
				if (needsSlice) {
					// Slice before decrypting
					ciphertextSource = ciphertextSource.slice(this.location.offset, this.location.length ?? undefined);
				}

				const ciphertextReader = new Reader(ciphertextSource);

				const stream = createAesDecryptStream(ciphertextReader, async () => {
					const keyReader = await this.variant.input._getEncryptionKeyReader(this.encryption!.keyUri);
					const keySlice = await keyReader.requestSlice(0, AES_128_BLOCK_SIZE);
					if (!keySlice) {
						throw new Error('Invalid AES-128 key; expected at least 16 bytes of data.');
					}
					const key = readBytes(keySlice, AES_128_BLOCK_SIZE);

					return { key, iv: this.encryption!.iv! };
				});

				source = new ReadableStreamSource(stream);
			}

			const initInput = await initInputPromise;

			return new Input({
				source,
				formats: this.variant.input._mediaFormats,
				initInput: initInput ?? undefined,
			});
		})();

		this.variant._inputCache.push({
			segment: this,
			inputPromise,
			age: this.variant._nextInputCacheAge++,
		});

		const MAX_INPUT_CACHE_SIZE = 4;
		if (this.variant._inputCache.length > MAX_INPUT_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this.variant._inputCache, x => x.age);
			this.variant._inputCache.splice(minAgeIndex, 1);
		}

		return inputPromise;
	}
}
