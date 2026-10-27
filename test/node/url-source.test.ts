import { expect, test, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { assert, wait } from '../../src/misc.js';
import { Reader, readBytes } from '../../src/reader.js';
import {
	ALL_FORMATS,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	Input,
	InputDisposedError,
	Logging,
	LogLevel,
	UrlSource,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const videoFilePath = path.join(__dirname, '..', 'public/video.mp4');

test('UrlSource works against a server without range request support', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			source: new UrlSource(server.url),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		// The default cache size exceeds the file size, so random access back to the start of the file still works
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource throws when reading from an evicted region in sequential mode', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// Much smaller than the file, so the start of the file will get evicted during full iteration
			source: new UrlSource(server.url, { maxCacheSize: 2 ** 20 /* 1 MiB */ }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		await expect(sink.getFirstPacket()).rejects.toThrow(/already-evicted part of the cache/);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource resumes with correct data when the connection dies in sequential mode', async () => {
	// The server kills the connection partway through the first two responses. Since it doesn't support range
	// requests, each resume response starts back at byte 0 and the already-delivered prefix must be skipped over
	// exactly; any off-by-one would corrupt the packet data.
	const server = await startRangelessServer({ responseByteLimits: [700_000, 1_500_000] });
	const logs = captureLogs();

	try {
		using referenceInput = new Input({
			source: new FilePathSource(videoFilePath),
			formats: ALL_FORMATS,
		});

		const referenceTrack = await referenceInput.getPrimaryVideoTrack();
		if (!referenceTrack) throw new Error('No video track found');

		const referencePackets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(referenceTrack).packets()) {
			referencePackets.push(packet);
		}

		using input = new Input({
			source: new UrlSource(server.url, { getRetryDelay: () => 0 }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		let packetIndex = 0;
		for await (const packet of new EncodedPacketSink(track).packets()) {
			const referencePacket = referencePackets[packetIndex]!;

			expect(packet.timestamp).toBe(referencePacket.timestamp);
			expect(Buffer.from(packet.data).equals(Buffer.from(referencePacket.data))).toBe(true);

			packetIndex++;
		}

		expect(packetIndex).toBe(referencePackets.length);

		// Initial request plus one resume per killed response
		expect(server.requestCount()).toBe(3);
		expect(logs.errors.filter(x => x.includes('Attempting to resume'))).toHaveLength(2);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource with maxCacheSize: Infinity allows random access against a rangeless server', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		using input = new Input({
			// This is the escape hatch recommended by the eviction error message: with an infinite cache, nothing
			// is ever evicted and random access keeps working
			source: new UrlSource(server.url, { maxCacheSize: Infinity }),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		const sink = new EncodedPacketSink(track);

		const timestamps: number[] = [];
		for await (const packet of sink.packets()) {
			timestamps.push(packet.timestamp);
		}

		expect(timestamps).toHaveLength(125);

		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		expect(logs.warnings.filter(
			x => x.includes('did not respond to a range request with 206 Partial Content'),
		)).toHaveLength(1);
	} finally {
		logs.stop();
		server.close();
	}
});

test('UrlSource in sequential mode downloads lazily and aborts the response on dispose', async () => {
	// The resource is padded to a size far beyond what kernel socket buffers can swallow. This matters: the server
	// can only observe the client's laziness through backpressure, and on some systems (like Linux with its TCP
	// buffer autotuning), the kernel happily buffers multiple megabytes of sent data that the client never read.
	const paddingSize = 2 ** 26; // 64 MiB
	const totalSize = fs.statSync(videoFilePath).size + paddingSize;

	const server = await startRangelessServer({ trailingPaddingSize: paddingSize });
	const logs = captureLogs();

	const input = new Input({
		source: new UrlSource(server.url),
		formats: ALL_FORMATS,
	});

	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track found');

		// If the client were downloading eagerly, the entire resource would easily arrive during this window.
		// Instead, the server is expected to stall, since data is only pulled down when reads demand it.
		await new Promise(resolve => setTimeout(resolve, 3000));

		expect(server.bytesSent()).toBeLessThan(totalSize / 2);

		// The response is merely suspended, not dead: reading still works
		const sink = new EncodedPacketSink(track);
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket) throw new Error('No first packet found');

		expect(firstPacket.timestamp).toBe(0);
		expect(firstPacket.data.byteLength).toBeGreaterThan(0);

		input.dispose();

		// Give the abort a moment to propagate to the server
		await new Promise(resolve => setTimeout(resolve, 250));

		// Disposal terminated the response early, long before the entire resource was sent
		expect(server.abortedResponses()).toBe(1);
		expect(server.bytesSent()).toBeLessThan(totalSize / 2);
	} finally {
		input.dispose();
		logs.stop();
		server.close();
	}
}, 10_000);

test('UrlSource reads the full decoded body of a compressed response', async () => {
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Length': compressed.byteLength,
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test('UrlSource reads the full decoded body of a compressed 206 response', async () => {
	// A 206 carrying Content-Encoding states its Content-Range in compressed bytes, so trusting that
	// total truncates the decoded document.
	const text = 'Some playlist text\n'.repeat(256);
	const content = Buffer.from(text);
	const compressed = brotliCompressSync(content);
	const server = http.createServer((req, res) => {
		res.writeHead(206, {
			'Content-Type': 'text/plain',
			'Content-Encoding': 'br',
			'Content-Range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
			'Content-Length': compressed.byteLength,
			'Accept-Ranges': 'bytes',
		});
		res.end(compressed);
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	try {
		const address = server.address();
		assert(address && typeof address !== 'string');
		const source = new UrlSource(`http://localhost:${address.port}/playlist.m3u8`);
		using ref = source.ref();
		const reader = new Reader(ref.source);

		const slice = await reader.requestEntireFile();
		expect(slice).not.toBeNull();
		expect(compressed.byteLength).toBeLessThan(content.byteLength);
		expect(slice!.length).toBe(content.byteLength);
		expect(Buffer.from(readBytes(slice!, slice!.length)).toString()).toBe(text);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test.each([0, 3])('UrlSource honors disabled retries after %i bytes before an empty response', async (prefixLength) => {
	vi.useFakeTimers();
	const logs = captureLogs();
	try {
		const data = Uint8Array.from({ length: 12 }, (_, i) => i);
		const starts: number[] = [];
		const getRetryDelay = vi.fn(() => null);
		const source = new UrlSource('https://example.invalid/data', {
			getRetryDelay,
			fetchFn: async (_, init) => {
				const start = Number(/bytes=(\d+)/.exec(new Headers(init?.headers).get('Range')!)![1]);
				starts.push(start);
				await wait(1);
				return new Response(start === 0 ? data.subarray(0, prefixLength) : new Uint8Array(), {
					status: 206,
					headers: { 'Content-Range': `bytes ${start}-11/12` },
				});
			},
		});
		using ref = source.ref();
		const result = Promise.resolve(new Reader(ref.source).requestSlice(0, 12)).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(20);
		expect(starts).toEqual(prefixLength ? [0, prefixLength] : [0]);
		expect(getRetryDelay).toHaveBeenCalledExactlyOnceWith(1, expect.any(Error), 'https://example.invalid/data');
		expect(await result).toBeInstanceOf(Error);
		expect(((await result) as Error).message).toContain('without delivering any bytes');
	} finally {
		logs.stop();
		vi.useRealTimers();
	}
});

test('UrlSource backs off empty responses and resets attempts only after byte progress', async () => {
	vi.useFakeTimers();
	const logs = captureLogs();
	try {
		const data = Uint8Array.from({ length: 12 }, (_, i) => i);
		const starts: number[] = [];
		const getRetryDelay = vi.fn((attempts: number) => attempts * 0.01);
		const source = new UrlSource('https://example.invalid/data', {
			getRetryDelay,
			fetchFn: async (_, init) => {
				const start = Number(/bytes=(\d+)/.exec(new Headers(init?.headers).get('Range')!)![1]);
				starts.push(start);
				const request = starts.length;
				await wait(1);
				// Two empty responses, three bytes of progress, two more empties, then the remainder.
				const body = request === 3 || request === 6
					? data.subarray(start, request === 3 ? 3 : data.length)
					: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array()); // A zero-length chunk is not progress.
							controller.close();
						},
					});
				return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-11/12` } });
			},
		});
		using ref = source.ref();
		const result = Promise.resolve(new Reader(ref.source).requestSlice(0, 12));
		void result.catch(() => {}); // Also handle disposal if an assertion fails before awaiting the read.
		await vi.advanceTimersByTimeAsync(1);
		expect(getRetryDelay).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(9);
		expect(starts).toEqual([0]); // No second fetch before the requested delay.
		await vi.advanceTimersByTimeAsync(90);
		const slice = await result;
		expect(slice).not.toBeNull();
		expect([...readBytes(slice!, 12)]).toEqual([...data]);
		expect(starts).toEqual([0, 0, 0, 3, 3, 3]);
		expect(getRetryDelay.mock.calls.map(([attempts]) => attempts)).toEqual([1, 2, 1, 2]);
	} finally {
		logs.stop();
		vi.useRealTimers();
	}
});

test('UrlSource continues capped range responses without treating byte progress as a failed request', async () => {
	const data = Uint8Array.from({ length: 12 }, (_, i) => i);
	const starts: number[] = [];
	const getRetryDelay = vi.fn(() => null);
	const source = new UrlSource('https://example.invalid/data', {
		getRetryDelay,
		fetchFn: async (_, init) => {
			const start = Number(/bytes=(\d+)/.exec(new Headers(init?.headers).get('Range')!)![1]);
			starts.push(start);
			return new Response(data.subarray(start, start + 3), {
				status: 206,
				headers: { 'Content-Range': `bytes ${start}-${start + 2}/12`, 'Content-Length': '3' },
			});
		},
	});
	using ref = source.ref();
	const slice = await new Reader(ref.source).requestSlice(0, 12);
	expect(slice).not.toBeNull();
	expect([...readBytes(slice!, 12)]).toEqual([...data]);
	expect(starts).toEqual([0, 3, 6, 9]);
	expect(getRetryDelay).not.toHaveBeenCalled();
});

test('UrlSource uses its default backoff for an empty ranged response', async () => {
	vi.useFakeTimers();
	const logs = captureLogs();
	try {
		const fetchFn = vi.fn(async () => {
			await wait(1);
			return new Response(new Uint8Array(), { status: 206, headers: { 'Content-Range': 'bytes 0-11/12' } });
		});
		const source = new UrlSource('https://example.invalid/data', { fetchFn });
		using ref = source.ref();
		const result = Promise.resolve(new Reader(ref.source).requestSlice(0, 12)).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(500);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		ref.free();
		expect(await result).toBeInstanceOf(InputDisposedError);
		await vi.runAllTimersAsync();
	} finally {
		logs.stop();
		vi.useRealTimers();
	}
});

test('UrlSource does not fetch again when disposed during a no-progress retry delay', async () => {
	vi.useFakeTimers();
	const logs = captureLogs();
	try {
		const getRetryDelay = vi.fn(() => 10);
		const fetchFn = vi.fn(async () => {
			await wait(1);
			return new Response(new Uint8Array(), { status: 206, headers: { 'Content-Range': 'bytes 0-11/12' } });
		});
		const source = new UrlSource('https://example.invalid/data', { getRetryDelay, fetchFn });
		using ref = source.ref();
		const result = Promise.resolve(new Reader(ref.source).requestSlice(0, 12)).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(1);
		expect(getRetryDelay).toHaveBeenCalledOnce();
		ref.free();
		expect(await result).toBeInstanceOf(InputDisposedError);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	} finally {
		logs.stop();
		vi.useRealTimers();
	}
});

test.each([-1, Infinity, NaN])('UrlSource rejects invalid no-progress retry delay %s', async (retryDelay) => {
	const source = new UrlSource('https://example.invalid/data', {
		getRetryDelay: () => retryDelay,
		fetchFn: async () => new Response(new Uint8Array(), {
			status: 206,
			headers: { 'Content-Range': 'bytes 0-11/12' },
		}),
	});
	using ref = source.ref();
	await expect(new Reader(ref.source).requestSlice(0, 12)).rejects
		.toThrow('Retry delay must be a non-negative finite number.');
});

test.each<ResponseInit>([
	{ status: 206, headers: {} },
	{ status: 206, headers: { 'Content-Encoding': 'br', 'Content-Range': 'bytes 0-11/12' } },
	{ status: 200, headers: { 'Content-Length': '0' } },
])('UrlSource preserves empty EOF without a strict target ($status, $headers)', async (responseInit) => {
	const getRetryDelay = vi.fn(() => null);
	const fetchFn = vi.fn(async () => new Response(new Uint8Array(), responseInit));
	const source = new UrlSource('https://example.invalid/empty.m3u8', { getRetryDelay, fetchFn });
	using ref = source.ref();
	expect(await new Reader(ref.source).requestSlice(0, 12)).toBeNull();
	expect(fetchFn).toHaveBeenCalledOnce();
	expect(getRetryDelay).not.toHaveBeenCalled();
});

const startRangelessServer = async (
	options: { responseByteLimits?: number[]; trailingPaddingSize?: number } = {},
) => {
	const fileSize = fs.statSync(videoFilePath).size;
	const paddingSize = options.trailingPaddingSize ?? 0;
	let requestCount = 0;
	let bytesSent = 0;
	let abortedResponses = 0;

	const server = http.createServer((req, res) => {
		const byteLimit = options.responseByteLimits?.[requestCount] ?? Infinity;
		requestCount++;

		res.on('error', () => {}); // The client may abort the connection at any time
		res.on('close', () => {
			if (!res.writableFinished) {
				abortedResponses++;
			}
		});
		res.writeHead(200, {
			'Content-Type': 'video/mp4',
			'Content-Length': fileSize + paddingSize,
		});

		// Stream the file with backpressure and a small chunk size, so that the amount of sent bytes closely
		// tracks how much the client actually consumes
		const stream = fs.createReadStream(videoFilePath, { highWaterMark: 2 ** 14 });
		let bytesSentThisResponse = 0;

		stream.on('data', (chunk) => {
			const canContinue = res.write(chunk);
			bytesSent += chunk.length;
			bytesSentThisResponse += chunk.length;

			if (bytesSentThisResponse >= byteLimit) {
				stream.destroy();
				res.destroy(); // Kill the connection mid-response

				return;
			}

			if (!canContinue) {
				stream.pause();
				res.once('drain', () => stream.resume());
			}
		});
		stream.on('end', () => {
			if (paddingSize === 0) {
				res.end();
				return;
			}

			// Append a giant 'free' box: valid ISOBMFF, but never read by the demuxer
			const header = Buffer.alloc(8);
			header.writeUInt32BE(paddingSize, 0);
			header.write('free', 4, 'latin1');

			const zeroes = Buffer.alloc(2 ** 14);
			let paddingSent = 0;

			const writeMore = () => {
				while (paddingSent < paddingSize) {
					const chunk = paddingSent === 0
						? header
						: zeroes.subarray(0, Math.min(paddingSize - paddingSent, zeroes.length));

					paddingSent += chunk.length;
					bytesSent += chunk.length;

					if (!res.write(chunk)) {
						res.once('drain', writeMore);
						return;
					}
				}

				res.end();
			};
			writeMore();
		});
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unexpected server address');

	return {
		url: `http://localhost:${address.port}/video.mp4`,
		requestCount: () => requestCount,
		bytesSent: () => bytesSent,
		abortedResponses: () => abortedResponses,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

/** Collects logged warnings and errors, keeping the console clean while doing so. */
const captureLogs = () => {
	const warnings: string[] = [];
	const errors: string[] = [];
	const unsubscribeWarn = Logging.on('warn', args => warnings.push(args.map(String).join(' ')));
	const unsubscribeError = Logging.on('error', args => errors.push(args.map(String).join(' ')));

	const previousLogLevel = Logging.level;
	Logging.level = LogLevel.Silent;

	return {
		warnings,
		errors,
		stop: () => {
			unsubscribeWarn();
			unsubscribeError();
			Logging.level = previousLogLevel;
		},
	};
};
