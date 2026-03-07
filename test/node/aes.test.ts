import { expect, test } from 'vitest';
import { Reader } from '../../src/reader.js';
import { BufferSource } from '../../src/source.js';
import { createAesDecryptStream } from '../../src/aes.js';

// getRandomValues is length-limited, so let's just do this
export const fillRandom = <T extends Uint8Array>(buffer: T) => {
	for (let i = 0; i < buffer.length; i++) {
		buffer[i] = Math.floor(Math.random() * 256);
	}

	return buffer;
};

test('createAesDecryptStream', async () => {
	// Test for all paddings
	for (let i = 0; i < 16; i++) {
		const plaintextLength = Math.floor(Math.random() * 2 ** 18) + i;

		const plaintext = fillRandom(new Uint8Array(plaintextLength));
		const key = fillRandom(new Uint8Array(16));
		const iv = fillRandom(new Uint8Array(16));

		const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
		const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, plaintext));

		const source = new BufferSource(ciphertext);
		const reader = new Reader(source);

		const stream = createAesDecryptStream(reader, () => ({ key, iv }));
		const streamReader = stream.getReader();

		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await streamReader.read();
			if (done) {
				break;
			}

			chunks.push(value);
		}

		// Concatenate chunks
		const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const decrypted = new Uint8Array(totalLength);

		let offset = 0;
		for (const chunk of chunks) {
			decrypted.set(chunk, offset);
			offset += chunk.length;
		}

		expect(decrypted.length).toBe(plaintext.length);

		// .toEqual is slow, so we do this instead
		for (let j = 0; j < plaintext.length; j++) {
			if (decrypted[j] !== plaintext[j]) {
				throw new Error(`Mismatch at byte ${j} for padding ${16 - (i % 16)}`);
			}
		}
	}
});
