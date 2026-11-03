import { expect, test, vi } from 'vitest';
import { Reader } from '../../src/reader.js';
import { BufferSource } from '../../src/source.js';
import { Aes128CbcContext, createAes128CbcDecryptStream } from '../../src/aes.js';

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

		const close = vi.fn();
		const stream = createAes128CbcDecryptStream(reader, () => ({ key, iv }), close);
		const streamReader = stream.getReader();

		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await streamReader.read();
			if (done) {
				break;
			}

			chunks.push(value);
		}

		await streamReader.cancel();
		expect(close).toHaveBeenCalledTimes(1);

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

// HLS releases its ciphertext SourceRef from the close callback.
test('cancelling with the final decrypted chunk queued releases the source once', async () => {
	const key = new Uint8Array(16);
	const iv = new Uint8Array(16);
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, new Uint8Array(100));
	const source = new BufferSource(ciphertext);
	const ref = source.ref();
	let onClose!: () => void;
	const closed = new Promise<void>((resolve) => {
		onClose = resolve;
	});
	const close = vi.fn(() => {
		ref.free();
		onClose();
	});
	const stream = createAes128CbcDecryptStream(new Reader(source), () => ({ key, iv }), close);

	await closed; // Leave the final chunk in the queue, as partial HLS reads can do.
	await expect(stream.cancel()).resolves.toBeUndefined();
	expect(close).toHaveBeenCalledTimes(1);
});

test.each(['initialization', 'ciphertext read'])(
	'cancelling during pending %s stops the pull before using the released source',
	async (stage) => {
		const key = new Uint8Array(16);
		const iv = new Uint8Array(16);
		const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
		const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, new Uint8Array(100));
		const source = new BufferSource(ciphertext);
		const ref = source.ref();
		const reader = new Reader(source);
		const slice = reader.requestSliceRange(0, 0, 65552);
		let resume!: () => void;
		const pending = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const read = vi.spyOn(reader, 'requestSliceRange').mockImplementation(async () => {
			await pending;
			return slice;
		});
		const decrypt = vi.spyOn(Aes128CbcContext.prototype, 'decrypt');
		const close = vi.fn(() => ref.free());
		const stream = createAes128CbcDecryptStream(reader, async () => {
			if (stage === 'initialization') {
				await pending;
			}
			return { key, iv };
		}, close);

		try {
			if (stage === 'ciphertext read') {
				await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
			} else {
				await Promise.resolve(); // Let pull start and wait for initialization.
			}
			await expect(stream.cancel()).resolves.toBeUndefined();
			resume();
			await new Promise(resolve => setTimeout(resolve, 0)); // Let the suspended pull finish.
			expect(read).toHaveBeenCalledTimes(stage === 'initialization' ? 0 : 1);
			expect(decrypt).not.toHaveBeenCalled();
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			resume();
			decrypt.mockRestore();
		}
	},
);
