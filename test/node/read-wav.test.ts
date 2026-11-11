import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AppendOnlyStreamTarget,
	AudioSample,
	AudioSampleSource,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	Input,
	FilePathSource,
	Output,
	ReadableStreamSource,
	Source,
	StreamTarget,
	StreamTargetChunk,
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

	// The all-ones size is only a placeholder, so there's nothing to tell until the end of the data is known
	expect(await track.getDurationFromMetadata()).toBe(null);
	expect(await track.computeDuration()).toBe(5000 / 8000);
	expect(await track.getDurationFromMetadata()).toBe(5000 / 8000);
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

test('Unfinalized file with zero sizes', async () => {
	for (const large of [false, true]) {
		const chunks: StreamTargetChunk[] = [];
		const output = new Output({
			format: new WavOutputFormat({ large }),
			target: new StreamTarget(new WritableStream({
				write: (chunk) => {
					chunks.push({
						...chunk,
						data: chunk.data.slice(),
					});
				},
			})),
		});
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();

		await source.add(new EncodedPacket(new Uint8Array(2000), 'key', 0, 1000 / 8000), {
			decoderConfig: {
				codec: 'pcm-s16',
				numberOfChannels: 1,
				sampleRate: 8000,
			},
		});

		// What has been written so far
		const file = new Uint8Array(Math.max(...chunks.map(x => x.position + x.data.length)));
		for (const chunk of chunks) {
			file.set(chunk.data, chunk.position);
		}

		for (const source of [new BufferSource(file), streamedSource(file)]) {
			using input = new Input({
				source,
				formats: ALL_FORMATS,
			});
			expect(await input.computeDuration()).toBe(1000 / 8000);
		}

		await output.cancel();
	}
});

test('Append-only', async () => {
	const file = await testAppendOnly(false);
	const view = new DataView(file.buffer);

	expect(view.getUint32(4, true)).toBe(0xffffffff); // RIFF size
	expect(view.getUint32(file.length - 1001 - 4, true)).toBe(0xffffffff); // Data size
});

test('Append-only, large', async () => {
	const file = await testAppendOnly(true);
	const view = new DataView(file.buffer);

	// The ds64 sizes, as the largest signed values
	for (const offset of [20, 28]) {
		expect(view.getUint32(offset, true)).toBe(0xffffffff);
		expect(view.getUint32(offset + 4, true)).toBe(0x7fffffff);
	}
});

const testAppendOnly = async (large: boolean) => {
	const chunks: Uint8Array[] = [];
	const output = new Output({
		format: new WavOutputFormat({
			appendOnly: true,
			large,
		}),
		target: new AppendOnlyStreamTarget(new WritableStream({
			write: (chunk) => {
				chunks.push(chunk.slice());
			},
		})),
	});
	output.setMetadataTags({ title: 'Title' });

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

	// The odd-sized data isn't padded, since readers would take the padding for audio
	const file = concat(...chunks);
	expect(file.subarray(-1001)).toEqual(new Uint8Array(1001).fill(file.at(-1)!));

	for (const source of [new BufferSource(file), streamedSource(file)]) {
		using input = new Input({
			source,
			formats: ALL_FORMATS,
		});

		expect((await input.getMetadataTags()).title).toBe('Title');
		expect(await input.computeDuration()).toBe(1001 / 8000);
	}

	return file;
};

// The file size stays unknown until the stream ends
const streamedSource = (file: Uint8Array): Source => new ReadableStreamSource(new ReadableStream<Uint8Array>({
	start(controller) {
		controller.enqueue(file);
		controller.close();
	},
}));

// What FFmpeg writes when piping, since it can't seek back to fill in the sizes
const pipedWav = (frameCount: number) => {
	const file = wav([fmtChunk(1, 1, 8000, 16), riffChunk('data', new Uint8Array(2 * frameCount), 0xffffffff)]);
	file.set(u32(0xffffffff), 4);

	return file;
};

test('RF64 with metadata after the data chunk', async () => {
	// What libsndfile writes when tagging an existing RF64 file
	const ds64 = riffChunk('ds64', new Uint8Array(28));
	const data = riffChunk('data', new Uint8Array(2 * 80), 0xffffffff);
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

const wav = (chunks: Uint8Array[], riffType = 'RIFF') => {
	const body = concat(ascii('WAVE'), ...chunks);
	return concat(ascii(riffType), u32(body.length), body);
};

const fmtChunk = (formatTag: number, channels: number, sampleRate: number, bitsPerSample: number) => {
	const blockAlign = channels * bitsPerSample / 8;

	return riffChunk('fmt ', concat(
		u16(formatTag),
		u16(channels),
		u32(sampleRate),
		u32(sampleRate * blockAlign),
		u16(blockAlign),
		u16(bitsPerSample),
	));
};

const riffChunk = (id: string, body: Uint8Array, size = body.length) => {
	return concat(ascii(id), u32(size), body, new Uint8Array(body.length % 2));
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

const u32 = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, true);
	return bytes;
};

const u16 = (value: number) => {
	const bytes = new Uint8Array(2);
	new DataView(bytes.buffer).setUint16(0, value, true);
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

	// The data chunk must be padded to an even size, with the RIFF size accounting for it. The header has a fact chunk,
	// since mu-law isn't integer PCM.
	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	expect(file.length).toBe(56 + 1001 + 1);
	expect(view.getUint32(4, true)).toBe(file.length - 8);
	expect(String.fromCharCode(...file.subarray(36, 40))).toBe('fact');
	expect(view.getUint32(44, true)).toBe(1001); // Sample count
	expect(view.getUint32(52, true)).toBe(1001); // Data size
	expect(file.at(-1)).toBe(0);
});

test('Write WAVE_FORMAT_EXTENSIBLE', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioSampleSource({ codec: 'pcm-s24' });
	output.addAudioTrack(source);
	await output.start();

	using sample = new AudioSample({
		data: new Float32Array(6 * 100),
		format: 'f32',
		numberOfChannels: 6,
		sampleRate: 48000,
		timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();

	// More than two channels and more than 16 bits both call for the extensible format
	const file = new Uint8Array(output.target.buffer!);
	const view = new DataView(file.buffer);
	expect(view.getUint32(16, true)).toBe(40); // fmt chunk size
	expect(view.getUint16(20, true)).toBe(0xfffe);
	expect(view.getUint16(38, true)).toBe(24); // Valid bits per sample
	expect(view.getUint32(40, true)).toBe(0x3f); // 5.1(back)
	expect(view.getUint16(44, true)).toBe(1); // PCM subformat

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	expect(await track.getCodec()).toBe('pcm-s24');
	expect(await track.getNumberOfChannels()).toBe(6);
	expect(await track.computeDuration()).toBe(100 / 48000);
});
