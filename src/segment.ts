import { AES_128_BLOCK_SIZE, createAesDecryptStream } from './aes';
import { ENCRYPTION_KEY_CACHE_GROUP, Input } from './input';
import { SegmentedInput } from './segmented-input';
import { arrayArgmin, assert } from './misc';
import { readBytes, Reader } from './reader';
import { ReadableStreamSource, Source } from './source';

export type SegmentEncryptionInfo = {
	method: 'AES-128';
	keyUri: string;
	iv: Uint8Array | null;
	keyFormat: string;
};

export type SegmentLocation = {
	path: string;
	offset: number;
	length: number | null;
};

export class Segment {
	input: SegmentedInput;
	location: SegmentLocation;
	timestamp: number;
	relativeToUnixEpoch: boolean;
	duration: number;
	encryption: SegmentEncryptionInfo | null;
	firstSegment: Segment | null;
	initSegment: Segment | null;

	constructor(
		input: SegmentedInput,
		location: SegmentLocation,
		timestamp: number,
		relativeToUnixEpoch: boolean,
		duration: number,
		encryption: SegmentEncryptionInfo | null,
		firstSegment: Segment | null,
		initSegment: Segment | null,
	) {
		this.input = input;
		this.location = location;
		this.timestamp = timestamp;
		this.relativeToUnixEpoch = relativeToUnixEpoch;
		this.duration = duration;
		this.encryption = encryption;
		this.firstSegment = firstSegment;
		this.initSegment = initSegment;
	}

	toInput(): Input {
		const cacheEntry = this.input.inputCache.find(x => x.segment === this);
		if (cacheEntry) {
			cacheEntry.age = this.input.nextInputCacheAge++;
			return cacheEntry.input;
		}

		let initInput: Input | null = null;
		if (this.initSegment || this.firstSegment) {
			initInput = (this.initSegment ?? this.firstSegment)!.toInput();
		}

		const input = new Input({
			entryPath: this.location.path,
			source: async (request) => {
				if (request.path !== this.location.path) {
					// This code technically allows for recursive .m3u8 files for example. Uncached because the added
					// input adds its own layer of caching, so here we just do a passthrough.
					return this.input.input._getSourceUncached(request);
				}

				let source: Source;
				const needsSlice = this.location.offset > 0 || this.location.length !== null;

				if (!this.encryption) {
					source = await this.input.input._getSourceCached(request);
					if (needsSlice) {
						source = source.slice(this.location.offset, this.location.length ?? undefined);
					}
				} else {
					assert(this.encryption.iv);

					let ciphertextSource = await this.input.input._getSourceCached(request);
					if (needsSlice) {
						// Slice before decrypting
						ciphertextSource = ciphertextSource.slice(
							this.location.offset,
							this.location.length ?? undefined,
						);
					}

					const ciphertextReader = new Reader(ciphertextSource);

					const stream = createAesDecryptStream(ciphertextReader, async () => {
						const keySource = await this.input.input._getSourceCached(
							{ path: this.encryption!.keyUri },
							ENCRYPTION_KEY_CACHE_GROUP,
						);
						const keyReader = new Reader(keySource);
						const keySlice = await keyReader.requestSlice(0, AES_128_BLOCK_SIZE);
						if (!keySlice) {
							throw new Error('Invalid AES-128 key; expected at least 16 bytes of data.');
						}
						const key = readBytes(keySlice, AES_128_BLOCK_SIZE);

						return { key, iv: this.encryption!.iv! };
					});

					source = new ReadableStreamSource(stream);
				}

				return source;
			},
			formats: this.input.input._formats,
			initInput: initInput ?? undefined,
		});

		this.input.inputCache.push({
			segment: this,
			input,
			age: this.input.nextInputCacheAge++,
		});

		const MAX_INPUT_CACHE_SIZE = 4;
		if (this.input.inputCache.length > MAX_INPUT_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this.input.inputCache, x => x.age);
			this.input.inputCache.splice(minAgeIndex, 1);
		}

		return input;
	}
}
