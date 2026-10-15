import { expect, test } from 'vitest';
import { Reader } from '../../src/reader.js';
import { Source } from '../../src/source.js';

/** Reports 16 bytes but only ever serves 4, the way a truncated response would. */
class ShortSizedSource extends Source {
	readonly buffer = new Uint8Array([1, 2, 3, 4]);

	_getFileSize() {
		return 16;
	}

	_read() {
		return { bytes: this.buffer, view: new DataView(this.buffer.buffer), offset: 0 };
	}

	_dispose() {}
}

test('requestEntireFile refuses a truncated whole-file read', async () => {
	const source = new ShortSizedSource();
	const ref = source.ref();

	await expect((async () => {
		await new Reader(source).requestEntireFile();
	})()).rejects.toThrow(/Short read/);

	ref.free();
});
