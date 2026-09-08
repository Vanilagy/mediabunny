import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { UrlSource } from '../../src/source.js';
import { Reader, readBytes } from '../../src/reader.js';
import { promiseWithResolvers } from '../../src/misc.js';

describe.each([
	{ description: 'one response chunk', start: 0, length: 8 },
	{ description: 'two response chunks', start: 8, length: 24 },
])('given cached bytes spanning $description', ({ start, length }) => {
	describe('when a presigned URL rejects a speculative read', () => {
		it('should preserve cached reads and reject required reads without unhandled rejections', async () => {
			const data = Uint8Array.from({ length: 64 }, (_, index) => index);
			const prefetchStarted = promiseWithResolvers<void>();
			const expire = promiseWithResolvers<void>();
			const rejectedRanges: number[] = [];
			const source = new UrlSource('https://example.com/media?signature=old', {
				fetchFn: async (_, init) => {
					const range = new Headers(init?.headers).get('range');
					const offset = Number(range?.match(/^bytes=(\d+)-/)?.[1] ?? 0);
					if (offset === 0) {
						return new Response(new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(data.slice(0, 16));
								controller.enqueue(data.slice(16, 32));
								controller.close();
							},
						}), {
							status: 206,
							headers: { 'Content-Range': 'bytes 0-31/64' },
						});
					}

					prefetchStarted.resolve();
					await expire.promise;
					rejectedRanges.push(offset);
					return new Response(null, { status: 403, statusText: 'Forbidden' });
				},
			});
			using sourceRef = source.ref();
			const reader = new Reader(sourceRef.source);
			const unhandledRejections: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
			process.on('unhandledRejection', onUnhandledRejection);

			try {
				await reader.requestSlice(0, 1);
				await prefetchStarted.promise;

				// These bytes are cached; only the prefetch beyond byte 32 needs the network.
				const cached = await reader.requestSlice(start, length);
				expect(cached).not.toBeNull();
				expect(readBytes(cached!, length)).toEqual(data.slice(start, start + length));
				expire.resolve();
				await setImmediate();

				expect(rejectedRanges).toContain(32);
				expect(unhandledRejections).toEqual([]);

				const stillCached = await reader.requestSlice(start, length);
				expect(stillCached).not.toBeNull();
				expect(readBytes(stillCached!, length)).toEqual(data.slice(start, start + length));
				await setImmediate();
				expect(unhandledRejections).toEqual([]);

				// An application must still be able to catch a failure when it needs missing data.
				await expect(reader.requestSlice(32, 1)).rejects.toThrow('403 Forbidden');

				// Renewing access uses a fresh source, which can read the same position.
				const renewed = new UrlSource('https://example.com/media?signature=new', {
					fetchFn: async () => new Response(data.slice(32), {
						status: 206,
						headers: { 'Content-Range': 'bytes 32-63/64' },
					}),
				});
				using renewedRef = renewed.ref();
				const recovered = await new Reader(renewedRef.source).requestSlice(32, 1);
				expect(recovered).not.toBeNull();
				expect(readBytes(recovered!, 1)).toEqual(data.slice(32, 33));
				await setImmediate();
				expect(unhandledRejections).toEqual([]);
			} finally {
				expire.resolve();
				process.off('unhandledRejection', onUnhandledRejection);
			}
		});
	});
});
