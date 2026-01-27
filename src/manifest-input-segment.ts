import { AES_128_BLOCK_SIZE, createAesDecryptStream } from './aes';
import { Input } from './input';
import { ManifestInputVariant } from './manifest-input-variant';
import { assert } from './misc';
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
	readonly initSegment: ManifestInputSegment | null;

	constructor(
		variant: ManifestInputVariant,
		location: ManifestInputSegmentLocation,
		relativeTimestamp: number,
		duration: number,
		title: string | null,
		encryption: SegmentEncryptionInfo | null,
		initSegment: ManifestInputSegment | null,
	) {
		this.variant = variant;
		this.location = location;
		this.relativeTimestamp = relativeTimestamp;
		this.duration = duration;
		this.title = title;
		this.encryption = encryption;
		this.initSegment = initSegment;
	}

	async toInput() {
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

			const ciphertextReader = await Reader.fromSource(ciphertextSource);

			const stream = createAesDecryptStream(ciphertextReader, async () => {
				const keyReader = await this.variant.input._getEncryptionKeyReader(this.encryption!.keyUri);
				const keySlice = await keyReader.requestSlice(0, AES_128_BLOCK_SIZE);
				if (!keySlice) {
					throw new Error('Invalid AES-128 key; expected at least 16 bytes of data.');
				}
				const key = readBytes(keySlice, AES_128_BLOCK_SIZE);

				return { key, iv: this.encryption!.iv! };
			});

			/*
			const chunks: Uint8Array[] = [];
			const streamReader = stream.getReader();
			while (true) {
				const { done, value } = await streamReader.read();
				if (done) {
					break;
				}

				chunks.push(value);
			}

			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const decryptedData = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				decryptedData.set(chunk, offset);
				offset += chunk.length;
			}

			await fs.writeFile('tempfile.ts', decryptedData);
			*/

			source = new ReadableStreamSource(stream);
		}

		return new Input({
			source,
			formats: this.variant.input._mediaFormats,
		});
	}
}
