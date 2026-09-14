import { expect, test } from 'vitest';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS, HLS } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert } from '../../src/misc.js';
import { Logging, LogLevel } from '../../src/logging.js';

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

const makeBox = (name: string, data: Uint8Array) => {
	const bytes = new Uint8Array(8 + data.length);
	new DataView(bytes.buffer).setUint32(0, bytes.length);
	bytes.set(new TextEncoder().encode(name), 4);
	bytes.set(data, 8);
	return bytes;
};

type Edit = { mediaTime: number; rate: number };

const makeEditList = (edits: Edit[], version: number) => {
	const data = new Uint8Array(8 + edits.length * (version === 1 ? 20 : 12));
	const view = new DataView(data.buffer);
	view.setUint8(0, version);
	view.setUint32(4, edits.length);
	let offset = 8;
	for (const edit of edits) {
		if (version === 1) {
			view.setBigUint64(offset, 1000n);
			view.setBigInt64(offset + 8, BigInt(edit.mediaTime));
			offset += 16;
		} else {
			view.setUint32(offset, 1000);
			view.setInt32(offset + 4, edit.mediaTime);
			offset += 8;
		}
		view.setInt32(offset, edit.rate * 65536);
		offset += 4;
	}
	return makeBox('edts', makeBox('elst', data));
};

const createEditFixture = async (trackEdits: Edit[][], version = 0) => {
	using source = new Input({
		source: new FilePathSource(new URL('../public/frames.webm', import.meta.url).pathname),
		formats: ALL_FORMATS,
	});
	const track = await source.getPrimaryVideoTrack();
	assert(track);
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	assert(packet);
	const config = await track.getDecoderConfig();
	assert(config);
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
	const codec = await track.getCodec();
	assert(codec);
	const sources = trackEdits.map(() => {
		const video = new EncodedVideoPacketSource(codec);
		output.addVideoTrack(video);
		return video;
	});
	await output.start();
	for (const video of sources) {
		await video.add(new EncodedPacket(packet.data, 'key', 0, 1), { decoderConfig: config });
	}
	await output.finalize();

	// The moov box follows mdat, so adding edit lists leaves all packet byte offsets intact.
	let trackIndex = 0;
	const insertEdits = (bytes: Uint8Array): Uint8Array => {
		const boxes: Uint8Array[] = [];
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let pos = 0; pos < bytes.length;) {
			const size = view.getUint32(pos);
			assert(size >= 8 && pos + size <= bytes.length);
			const name = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8));
			const contents = bytes.subarray(pos + 8, pos + size);
			if (name === 'moov') {
				boxes.push(makeBox(name, insertEdits(contents)));
			} else if (name === 'trak') {
				const edits = makeEditList(trackEdits[trackIndex++]!, version);
				boxes.push(makeBox(name, new Uint8Array([...contents, ...edits])));
			} else {
				boxes.push(bytes.subarray(pos, pos + size));
			}
			pos += size;
		}
		return new Uint8Array(boxes.flatMap(box => [...box]));
	};
	return insertEdits(new Uint8Array(output.target.buffer!));
};

test.each([0, 1])('Edit-list diagnostics are local to each track (version %i)', async (version) => {
	const bytes = await createEditFixture([
		[{ mediaTime: 0, rate: 1 }, { mediaTime: 0, rate: 1 }],
		[{ mediaTime: 0, rate: 0.5 }],
		[{ mediaTime: -1, rate: 1 }, { mediaTime: 0, rate: 1 }],
	], version);
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getVideoTracks();
	expect(await Promise.all(tracks.map(track => track.getUnsupportedFeatures()))).toEqual([
		['multiple_edits'], ['non_unit_playback_rate'], [],
	]);
	const features = await tracks[0]!.getUnsupportedFeatures();
	features.length = 0;
	expect(await tracks[0]!.getUnsupportedFeatures()).toEqual(['multiple_edits']);
	// Warnings still allow the original packet to be read with the existing timestamp and duration.
	for (const track of tracks.slice(0, 2)) {
		const packet = await new EncodedPacketSink(track).getFirstPacket();
		expect(packet?.timestamp).toBe(0);
		expect(packet?.duration).toBe(1);
		expect(packet?.data.length).toBeGreaterThan(0);
	}
});

test('Unsupported rates are reported independently across concurrent inputs with logging disabled', async () => {
	const fixtures = await Promise.all([0, -1, 2].map(rate => createEditFixture([[{ mediaTime: 0, rate }]])));
	const previousLevel = Logging.level;
	Logging.level = LogLevel.Silent;
	try {
		await Promise.all(fixtures.map(async (bytes) => {
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const track = await input.getPrimaryVideoTrack();
			expect(await track!.getUnsupportedFeatures()).toEqual(['non_unit_playback_rate']);
		}));
	} finally {
		Logging.level = previousLevel;
	}
});

test('Segment inputs inherit edit-list diagnostics from their initialization input', async () => {
	const bytes = await createEditFixture([[{ mediaTime: 0, rate: 2 }]]);
	using initInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const segment = makeBox('styp', new Uint8Array([105, 115, 111, 109, 0, 0, 0, 0]));
	using input = new Input({ source: new BufferSource(segment), formats: ALL_FORMATS, initInput });
	const track = await input.getPrimaryVideoTrack();
	expect(await track!.getUnsupportedFeatures()).toEqual(['non_unit_playback_rate']);
});

test('Tracks without detected unsupported features return an empty array', async () => {
	for (const file of ['frames.webm', 'rotate-buck-bunny.mp4']) {
		using input = new Input({
			source: new FilePathSource(new URL(`../public/${file}`, import.meta.url).pathname),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		expect(await track!.getUnsupportedFeatures()).toEqual([]);
	}
});

test('HLS forwards diagnostics from its backing track', async () => {
	const bytes = await createEditFixture([[{ mediaTime: 0, rate: 2 }]]);
	const playlist = new TextEncoder().encode([
		'#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXTINF:1,', 'segment.mp4', '#EXT-X-ENDLIST',
	].join('\n'));
	using input = new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ isRoot }) => new BufferSource(
			isRoot ? playlist : bytes,
		)),
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(HLS);
	const track = await input.getPrimaryVideoTrack();
	expect(await track!.getUnsupportedFeatures()).toEqual(['non_unit_playback_rate']);
});
