import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	EncodedPacketSink,
	Input,
	FilePathSource,
	Output,
	ReadableStreamSource,
	Source,
	WavOutputFormat,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});

test('RIFX s16', async () => {
	await testRifx(1, 16);
});

test('RIFX s24', async () => {
	await testRifx(1, 24);
});

test('RIFX s32', async () => {
	await testRifx(1, 32);
});

test('RIFX f32', async () => {
	await testRifx(3, 32);
});

test('RIFX f64', async () => {
	await testRifx(3, 64);
});

const testRifx = async (formatTag: number, bitsPerSample: number) => {
	// RIFX is RIFF with everything big-endian, so it must decode to the same thing as the byte-swapped RIFF file. The
	// bytes are arbitrary, but kept below 0x7f so that no float sample comes out as NaN.
	const sampleSize = bitsPerSample / 8;
	const riffData = Uint8Array.from({ length: 1000 * sampleSize }, (_, i) => (37 * i) % 127);
	const rifxData = riffData.slice();
	for (let i = 0; i < rifxData.length; i += sampleSize) {
		rifxData.subarray(i, i + sampleSize).reverse();
	}

	const riff = wav([fmtChunk(formatTag, 1, 8000, bitsPerSample), riffChunk('data', riffData)]);
	const rifx = wav(
		[fmtChunk(formatTag, 1, 8000, bitsPerSample, false), riffChunk('data', rifxData, false)],
		'RIFX',
		false,
	);

	expect(await decodeToF32(rifx)).toEqual(await decodeToF32(riff));
};

const decodeToF32 = async (file: Uint8Array) => {
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	const decoded: number[] = [];
	for await (using sample of new AudioSampleSink(track).samples()) {
		const chunk = new Float32Array(sample.numberOfFrames);
		sample.copyTo(chunk, {
			format: 'f32',
			planeIndex: 0,
		});
		decoded.push(...chunk);
	}

	return decoded;
};

test('getPacket at exact packet timestamps', async () => {
	const file = wav([fmtChunk(1, 1, 44100, 16), riffChunk('data', new Uint8Array(2 * 20 * 2048))]);
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

	for await (const packet of sink.packets()) {
		const retrieved = await sink.getPacket(packet.timestamp);
		expect(retrieved!.sequenceNumber).toBe(packet.sequenceNumber);
	}
});

test('Unsized source with overstated data size, packets', async () => {
	using input = new Input({
		source: streamedSource(pipedWav(5000)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	let frameCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		frameCount += packet.data.byteLength / 2;
	}
	expect(frameCount).toBe(5000);
});

test('Unsized source with overstated data size, duration', async () => {
	using input = new Input({
		source: streamedSource(pipedWav(5000)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	expect(await track.computeDuration()).toBe(5000 / 8000);
});

test('Unsized source with overstated data size, lookups once the size is known', async () => {
	using input = new Input({
		source: streamedSource(pipedWav(5000)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const sink = new EncodedPacketSink(track);

	// Reading up to the end lets the source know its size
	for await (const packet of sink.packets()) {
		void packet;
	}

	expect(await track.computeDuration()).toBe(5000 / 8000);
	expect((await sink.getPacket(1000))!.data.byteLength).toBe(2 * (5000 - 2 * 2048));
});

// The file size stays unknown until the stream ends
const streamedSource = (file: Uint8Array): Source => new ReadableStreamSource(new ReadableStream<Uint8Array>({
	start(controller) {
		controller.enqueue(file);
		controller.close();
	},
}));

// What FFmpeg writes when piping, since it can't seek back to fill in the sizes
const pipedWav = (frameCount: number) => {
	const file = wav([fmtChunk(1, 1, 8000, 16), riffChunk('data', new Uint8Array(2 * frameCount), true, 0xffffffff)]);
	file.set(u32(0xffffffff, true), 4);

	return file;
};

test('RF64 with metadata after the data chunk', async () => {
	// What libsndfile writes when tagging an existing RF64 file
	const ds64 = riffChunk('ds64', new Uint8Array(28));
	const data = riffChunk('data', new Uint8Array(2 * 80), true, 0xffffffff);
	const list = riffChunk('LIST', concat(ascii('INFO'), riffChunk('INAM', ascii('Title\0'))));
	const file = wav([ds64, fmtChunk(1, 1, 8000, 16), data, list], 'RF64');

	const view = new DataView(file.buffer);
	view.setUint32(4, 0xffffffff, true);
	view.setUint32(20, file.length - 8, true); // RIFF size
	view.setUint32(28, 2 * 80, true); // Data size

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	expect((await input.getMetadataTags()).title).toBe('Title');
	expect(await input.computeDuration()).toBe(80 / 8000);
});

const wav = (chunks: Uint8Array[], riffType = 'RIFF', littleEndian = true) => {
	const body = concat(ascii('WAVE'), ...chunks);
	return concat(ascii(riffType), u32(body.length, littleEndian), body);
};

const fmtChunk = (
	formatTag: number,
	channels: number,
	sampleRate: number,
	bitsPerSample: number,
	littleEndian = true,
) => {
	const blockAlign = channels * bitsPerSample / 8;

	return riffChunk('fmt ', concat(
		u16(formatTag, littleEndian),
		u16(channels, littleEndian),
		u32(sampleRate, littleEndian),
		u32(sampleRate * blockAlign, littleEndian),
		u16(blockAlign, littleEndian),
		u16(bitsPerSample, littleEndian),
	), littleEndian);
};

const riffChunk = (id: string, body: Uint8Array, littleEndian = true, size = body.length) => {
	return concat(ascii(id), u32(size, littleEndian), body, new Uint8Array(body.length % 2));
};

const concat = (...parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

const u32 = (value: number, littleEndian: boolean) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, littleEndian);
	return bytes;
};

const u16 = (value: number, littleEndian: boolean) => {
	const bytes = new Uint8Array(2);
	new DataView(bytes.buffer).setUint16(0, value, littleEndian);
	return bytes;
};

const ascii = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0));

test('Write odd-sized data chunk', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({ codec: 'ulaw' });
	output.addAudioTrack(source);
	await output.start();

	using sample = new AudioSample({
		data: new Int16Array(1001),
		format: 's16',
		numberOfChannels: 1,
		sampleRate: 8000,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();

	// The data chunk must be padded to an even size, with the RIFF size accounting for it
	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	expect(file.length).toBe(44 + 1001 + 1);
	expect(view.getUint32(4, true)).toBe(file.length - 8);
	expect(view.getUint32(40, true)).toBe(1001);
	expect(file.at(-1)).toBe(0);
});
