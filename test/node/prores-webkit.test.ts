import { expect, test, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProresDecoder } from '@mediabunny/prores';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoSampleSink } from '../../src/media-sink.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// The decoder caches its WebKit check the first time it decodes a frame whose height isn't a multiple of 16, so this
// must be the only test in this file that does so
test('Alpha in height-trimmed WebKit frames', async () => {
	registerProresDecoder();

	vi.stubGlobal('navigator', {
		userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
			+ ' Version/17.0 Safari/605.1.15',
	});

	try {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public/prores-alpha.mov')),
			formats: ALL_FORMATS,
		});

		const videoTrack = (await input.getPrimaryVideoTrack())!;
		const sink = new VideoSampleSink(videoTrack);
		using sample = (await sink.getSample(0))!;

		// 24 rows don't fill the 32 coded rows, so the frame data gets compacted for WebKit
		expect(sample.format).toBe('I444AP12');
		expect(sample.visibleRect.height).toBe(24);

		const data = new Uint8Array(sample.allocationSize());
		const alphaPlane = (await sample.copyTo(data))[3]!;
		const view = new DataView(data.buffer);

		const alphaRows = Array.from({ length: 24 }, (_, y) => Array.from(
			{ length: 32 },
			(_, x) => view.getUint16(alphaPlane.offset + y * alphaPlane.stride + 2 * x, true),
		));
		const expectedRows = Array.from({ length: 24 }, (_, y) => {
			// The alpha channel is a vertical gradient of 40 * y at 10 bits, bit-replicated up to 12 bits
			const alpha = 40 * y;
			return Array<number>(32).fill((alpha << 2) | (alpha >> 8));
		});
		expect(alphaRows).toEqual(expectedRows);
	} finally {
		vi.unstubAllGlobals();
	}
});
