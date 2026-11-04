import { expect, test, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { assert, promiseWithResolvers, rejectAfter } from '../../src/misc.js';
import { FileSlice, Reader, readBytes } from '../../src/reader.js';
import {
	ALL_FORMATS,
	EncodedPacket,
	EncodedPacketSink,
	FilePathSource,
	Input,
	Logging,
	LogLevel,
	MP4,
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

test('UrlSource relative URL outside a window against a rangeless server', async () => {
	const server = await startRangelessServer();
	const logs = captureLogs();

	try {
		// No window means no base URL to resolve against, just like in a worker
		const fetchFn: typeof fetch = (url, init) => fetch(new URL(url as string, server.url), init);
		using input = new Input({
			source: new UrlSource('/video.mp4', { fetchFn }),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(MP4);
		expect(logs.warnings.some(x => x.includes('did not respond to a range request'))).toBe(true);
	} finally {
		logs.stop();
		server.close();
	}
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

test('UrlSource read events with a Range header', async () => {
	const bytes = makeRamp(256);
	const logs = captureLogs();

	try {
		for (const supportsRanges of [true, false]) {
			const server = await startServer((req, res) => {
				if (!supportsRanges) {
					res.writeHead(200, { 'Content-Length': bytes.length });
					res.end(bytes);
					return;
				}

				const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range!)![1]);
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
					'Content-Length': bytes.length - start,
				});
				res.end(bytes.subarray(start));
			});

			try {
				const source = new UrlSource(server.url, { requestInit: { headers: { Range: 'bytes=100-199' } } });
				const reads: { start: number; end: number }[] = [];
				source.on('read', read => reads.push(read));
				using ref = source.ref();

				const slice = await new Reader(ref.source).requestSlice(0, 4);
				expect([...readBytes(slice!, 4)]).toEqual([100, 101, 102, 103]);
				expect(reads).toEqual([{ start: 0, end: 100 }]);
			} finally {
				server.close();
			}
		}
	} finally {
		logs.stop();
	}
});

test('UrlSource releases the connection of a failed response', async () => {
	const responseClosed = promiseWithResolvers();
	const server = await startServer((req, res) => {
		res.on('close', responseClosed.resolve);
		res.writeHead(404);
		res.write('Not found'); // And the body never ends
	});

	try {
		using ref = new UrlSource(server.url).ref();

		await expect(new Reader(ref.source).requestSlice(0, 4)).rejects.toThrow('404');
		await Promise.race([responseClosed.promise, rejectAfter(1000)]);
	} finally {
		server.close();
	}
});

test('UrlSource on an empty resource', async () => {
	const server = await startServer((req, res) => {
		res.writeHead(416, { 'Content-Range': 'bytes */0' });
		res.end();
	});

	try {
		using input = new Input({
			source: new UrlSource(server.url),
			formats: ALL_FORMATS,
		});
		expect(await input.source.getSize()).toBe(0);
		expect(await input.canRead()).toBe(false);
	} finally {
		server.close();
	}
});

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

test('UrlSource error message with a Request', async () => {
	const server = await startServer((req, res) => {
		res.writeHead(404);
		res.end();
	});

	try {
		const source = new UrlSource(new Request(server.url));
		using ref = source.ref();

		await expect(new Reader(ref.source).requestSlice(0, 4)).rejects.toThrow(`Error fetching ${server.url}: 404`);
	} finally {
		server.close();
	}
});

test('UrlSource Request with custom headers', async () => {
	const bytes = makeRamp(256);
	const server = await startServer((req, res) => {
		if (req.headers['x-token'] !== 'secret') {
			res.writeHead(403);
			res.end();
			return;
		}

		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range!)![1]);
		res.writeHead(206, {
			'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
			'Content-Length': bytes.length - start,
		});
		res.end(bytes.subarray(start));
	});

	try {
		const source = new UrlSource(new Request(server.url, { headers: { 'X-Token': 'secret' } }));
		using ref = source.ref();

		const slice = await new Reader(ref.source).requestSlice(10, 4);
		expect([...readBytes(slice!, 4)]).toEqual([10, 11, 12, 13]);
	} finally {
		server.close();
	}
});

const startServer = async (handler: http.RequestListener) => {
	const server = http.createServer(handler);
	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Unexpected server address');
	}

	return {
		url: `http://localhost:${address.port}/video.mp4`,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

const makeRamp = (length: number) => {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		bytes[i] = i;
	}

	return bytes;
};

test('UrlSource queued read straddling the end', async () => {
	const data = createTestData(4 * 2 ** 20);
	const source = new UrlSource('https://example.com/file.bin', {
		parallelism: 1,
		fetchFn: createRangeFetchFn(data, { exposeSize: () => true }),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// The read at the end gets queued behind the first one, whose response then reveals the size
	const first = reader.requestSlice(0, 8);
	const last = reader.requestSlice(data.length - 4, 8);

	expect(await first).not.toBeNull();
	expect(await last).toBeNull();
});

test('UrlSource queued prefetch beyond the end', async () => {
	const data = createTestData(22 * 2 ** 16);
	const gate = promiseWithResolvers();
	const source = new UrlSource('https://example.com/file.bin', {
		parallelism: 1,
		fetchFn: createRangeFetchFn(data, {
			exposeSize: start => start === 2 ** 19,
			beforeResponse: start => start === 2 ** 19 ? gate.promise : null,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// Caches [0, 512 KiB) and [896 KiB, end) without learning the size
	expect(await reader.requestSlice(0, 524_288)).not.toBeNull();
	expect(await reader.requestSlice(1_000_000, 441_792)).not.toBeNull();

	// The hole at 512 KiB takes the only worker, so the prefetch past the end gets queued. Then, the gated
	// response reveals the size.
	const slice = reader.requestSlice(600_000, 600_000);
	gate.resolve();

	expectBytes(await slice, data.subarray(600_000, 1_200_000));
});

test('UrlSource queued read with capped responses', async () => {
	const data = createTestData(4 * 2 ** 20);
	const source = new UrlSource('https://example.com/file.bin', {
		parallelism: 1,
		fetchFn: createRangeFetchFn(data, {
			exposeSize: () => true,
			maxResponseLength: 2 ** 15,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// The second read gets queued before the size is known
	const first = reader.requestSlice(0, 8);
	const second = reader.requestSlice(2 ** 21 + 2 ** 17, 8);

	expectBytes(await first, data.subarray(0, 8));
	expectBytes(await second, data.subarray(2 ** 21 + 2 ** 17, 2 ** 21 + 2 ** 17 + 8));
});

test('UrlSource read spanning a worker that hits the end', async () => {
	const data = createTestData(1_600_000);
	const gate = promiseWithResolvers();
	const source = new UrlSource('https://example.com/file.bin', {
		fetchFn: createRangeFetchFn(data, {
			exposeSize: () => false,
			beforeResponse: start => start === 2 ** 19 ? gate.promise : null,
		}),
	});
	using ref = source.ref();
	const reader = new Reader(ref.source);

	// Caches [0, 512 KiB) and [896 KiB, 1408 KiB) without learning the size
	expect(await reader.requestSlice(0, 524_288)).not.toBeNull();
	expect(await reader.requestSlice(1_000_000, 441_792)).not.toBeNull();

	// Both holes of this read get a worker; the one for the second hole hits the end first
	const slice = reader.requestSlice(600_000, 900_000);
	await vi.waitFor(() => expect(source._orchestrator.fileSize).toBe(data.length));
	gate.resolve();

	expectBytes(await slice, data.subarray(600_000, 1_500_000));
});

const createTestData = (length: number) => {
	const data = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		data[i] = (7 * i + (i >> 8)) & 0xff;
	}

	return data;
};

const createRangeFetchFn = (data: Uint8Array, options: {
	exposeSize: (start: number) => boolean;
	beforeResponse?: (start: number) => Promise<void> | null;
	maxResponseLength?: number;
}) => {
	return async (url: string | URL | Request, init?: RequestInit) => {
		const range = new Headers(init?.headers).get('Range');
		const start = Number(/^bytes=(\d+)-$/.exec(range!)![1]);
		const end = Math.min(data.length, start + (options.maxResponseLength ?? Infinity));

		await options.beforeResponse?.(start);

		let pos = start;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pos === end) {
					controller.close();
					return;
				}

				const chunkEnd = Math.min(end, pos + 2 ** 16);
				controller.enqueue(data.slice(pos, chunkEnd));
				pos = chunkEnd;
			},
		});

		return new Response(body, {
			status: 206,
			headers: {
				'Content-Range': `bytes ${start}-${end - 1}/${options.exposeSize(start) ? data.length : '*'}`,
			},
		});
	};
};

const expectBytes = (slice: FileSlice | null, expected: Uint8Array) => {
	expect(slice).not.toBeNull();
	expect(Buffer.from(readBytes(slice!, slice!.length)).equals(Buffer.from(expected))).toBe(true);
};
