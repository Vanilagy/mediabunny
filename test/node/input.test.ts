import { expect, test } from 'vitest';
import { Input, InputDisposedError, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS, MP4, QTFF } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource } from '../../src/source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { assert } from '../../src/misc.js';

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

test('Disposed input', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array(1024)),
		formats: ALL_FORMATS,
	});
	input.dispose();

	await expect(input.getFormat()).rejects.toThrow(InputDisposedError);
	await expect(input.canRead()).rejects.toThrow(InputDisposedError);
	await expect(input.getTracks()).rejects.toThrow(InputDisposedError);
});

test('Source request after disposal', async () => {
	const input = new Input({
		source: new CustomPathedSource('root.m3u8', () => new BufferSource(new Uint8Array(4))),
		formats: ALL_FORMATS,
	});
	const request = {
		path: 'segment.ts',
		isRoot: false,
	};
	(await input._getSourceCached(request)).free();
	input.dispose();

	await expect(input._getSourceCached(request)).rejects.toThrow(InputDisposedError);
});

test('Failed source request retry', async () => {
	let requestCount = 0;
	using input = new Input({
		source: new CustomPathedSource('root.m3u8', () => {
			if (requestCount++ === 0) {
				throw new Error('Transient failure');
			}

			return new BufferSource(new Uint8Array(4));
		}),
		formats: ALL_FORMATS,
	});
	const request = {
		path: 'segment.ts',
		isRoot: false,
	};

	await expect(input._getSourceCached(request)).rejects.toThrow('Transient failure');
	using ref = await input._getSourceCached(request);
	expect(ref.source).toBeInstanceOf(BufferSource);
});

test('QuickTime file with a 64-bit ftyp box size', async () => {
	const bytes = new Uint8Array(28);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 1);
	bytes.set(ascii('ftyp'), 4);
	view.setUint32(12, bytes.length); // Lower half of the 64-bit size
	bytes.set(ascii('qt  '), 16);
	bytes.set(ascii('qt  '), 24);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(QTFF);
});

test('ISOBMFF without ftyp box', async () => {
	// Sample offsets are absolute, so instead of removing the ftyp box, we turn it into padding
	const moovLast = await createMp4File(false); // ftyp mdat moov
	const freeFirst = moovLast.slice();
	freeFirst.set(ascii('free'), 4);

	const moovFirst = await createMp4File('in-memory'); // ftyp moov mdat
	const ftypSize = readU32(moovFirst, 0);
	const moovSize = readU32(moovFirst, ftypSize);
	const padding = moovFirst.slice(0, ftypSize);
	padding.set(ascii('free'), 4);
	moovFirst.copyWithin(0, ftypSize, ftypSize + moovSize);
	moovFirst.set(padding, moovSize);

	for (const file of [freeFirst, moovFirst]) {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		expect(await input.getFormat()).toBe(MP4);

		const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);
		let packetCount = 0;
		for await (const packet of sink.packets()) {
			expect(packet.data).toEqual(new Uint8Array(100).fill(packetCount));
			packetCount++;
		}
		expect(packetCount).toBe(5);
	}
});

const createMp4File = async (fastStart: false | 'in-memory') => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 5; i++) {
		await source.add(new EncodedPacket(new Uint8Array(100).fill(i), i === 0 ? 'key' : 'delta', i / 10, 1 / 10), {
			decoderConfig: {
				codec: 'vp09.00.10.08',
				codedWidth: 64,
				codedHeight: 64,
			},
		});
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const readU32 = (bytes: Uint8Array, pos: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(pos);

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

test('Source cache eviction order', async () => {
	const requestedPaths: string[] = [];
	using input = new Input({
		source: new CustomPathedSource('root.m3u8', ({ path }) => {
			requestedPaths.push(path);
			return new BufferSource(new Uint8Array(4));
		}),
		formats: ALL_FORMATS,
	});

	// The cache holds four sources, and using 'a' again makes 'b' the one to go once 'e' comes in
	for (const path of ['a', 'b', 'c', 'd', 'a', 'e', 'a']) {
		(await input._getSourceCached({
			path,
			isRoot: false,
		})).free();
	}
	expect(requestedPaths).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('Disposal while waiting for a live HLS stream', async () => {
	const files = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			files.set(request.path, target);
			return target;
		}),
	});
	const videoSource = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(videoSource);
	await output.start();
	await videoSource.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1), {
		decoderConfig: {
			codec: 'vp09.00.10.08',
			codedWidth: 64,
			codedHeight: 64,
		},
	});
	await output.finalize();

	// No #EXT-X-ENDLIST, so the stream is live
	const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init-1.m4s"\n#EXTINF:1,\nsegment-1-1.m4s\n';
	const input = new Input({
		source: new CustomPathedSource('live.m3u8', ({ path }) => new BufferSource(
			path === 'live.m3u8' ? new TextEncoder().encode(playlist) : files.get(path)!.buffer!,
		)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const durationPromise = track.computeDuration();
	await new Promise(resolve => setTimeout(resolve, 100));
	input.dispose();

	await expect(durationPromise).rejects.toThrow(InputDisposedError);
});
