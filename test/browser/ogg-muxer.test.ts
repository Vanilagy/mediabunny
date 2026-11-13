import { expect, test, vi } from 'vitest';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { BufferTarget, NullTarget, StreamTarget } from '../../src/target.js';
import { AudioBufferSource, EncodedAudioPacketSource, MediaSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Quality } from '../../src/encode.js';
import { assert, toDataView, toUint8Array } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS, OggInputFormat } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { MetadataTags } from '../../src/metadata.js';
import { InputAudioTrack } from '../../src/input-track.js';
import { OggMuxer } from '../../src/ogg/ogg-muxer.js';

test('maximumPageDuration option', async () => {
	const sampleRate = 48000;
	const durationSeconds = 2;
	const audioBuffer = new AudioBuffer({ numberOfChannels: 1, length: sampleRate * durationSeconds, sampleRate });

	// First, create an Ogg file without the maximumPageDuration option
	let pageCountWithoutOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				onPage: () => {
					pageCountWithoutOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64000 }) });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	// Then, create an Ogg file with maximumPageDuration set to 0.1 seconds
	let pageCountWithOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				maximumPageDuration: 0.1,
				onPage: () => {
					pageCountWithOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64000 }) });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	expect(pageCountWithoutOption).toBe(3);
	expect(pageCountWithOption).toBe(23); // It created more pages
});

test('Multi-frame Opus packets', async () => {
	const SAMPLE_RATE = 48000;
	const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

	const createOpusHead = () => {
		const bytes = new Uint8Array(19);
		const view = new DataView(bytes.buffer);

		bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
		bytes[8] = 1; // Version
		bytes[9] = 1; // Channel count
		view.setUint16(10, 312, true); // Pre-skip
		view.setUint32(12, SAMPLE_RATE, true); // Input sample rate
		view.setInt16(16, 0, true); // Output gain
		bytes[18] = 0; // Channel mapping family

		return bytes;
	};

	const createOpusPacket = (frameCount: number) => {
		const data = new Uint8Array(2 + 3 * frameCount);

		data[0] = (31 << 3) | 0b11; // TOC byte: config 31 (CELT fullband, 20 ms), code 3
		data[1] = frameCount; // CBR, no padding, `frameCount` frames

		return data;
	};

	const framesPerPacket = 3;
	const packetCount = 10;
	const packetDuration = (framesPerPacket * SAMPLES_PER_FRAME) / SAMPLE_RATE;

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);

	await output.start();

	for (let i = 0; i < packetCount; i++) {
		await audioSource.add(
			new EncodedPacket(
				createOpusPacket(framesPerPacket),
				'key',
				i * packetDuration,
				packetDuration,
			),
			{
				decoderConfig: {
					codec: 'opus',
					numberOfChannels: 1,
					sampleRate: SAMPLE_RATE,
					description: createOpusHead(),
				},
			},
		);
	}

	audioSource.close();
	await output.finalize();

	assert(output.target.buffer);

	const input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBeInstanceOf(OggInputFormat);

	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	// The first packet is shortened by the pre-skip, so check the second one
	const packet = await sink.getNextPacket(firstPacket);

	expect(packet?.duration).toBe(packetDuration);
});

test('Opus start offset survives a demux-mux roundtrip', async () => {
	const SAMPLE_RATE = 48000;
	const PRE_SKIP = 312;
	const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

	const opusHead = new Uint8Array(19);
	const opusHeadView = new DataView(opusHead.buffer);
	opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
	opusHead[8] = 1; // Version
	opusHead[9] = 1; // Channel count
	opusHeadView.setUint16(10, PRE_SKIP, true);
	opusHeadView.setUint32(12, SAMPLE_RATE, true);

	const decoderConfig: AudioDecoderConfig = {
		codec: 'opus',
		numberOfChannels: 1,
		sampleRate: SAMPLE_RATE,
		description: opusHead,
	};

	const mux = async (packets: EncodedPacket[]) => {
		const output = new Output({
			format: new OggOutputFormat(),
			target: new BufferTarget(),
		});

		const audioSource = new EncodedAudioPacketSource('opus');
		output.addAudioTrack(audioSource);
		await output.start();

		for (const packet of packets) {
			await audioSource.add(packet, { decoderConfig });
		}

		audioSource.close();
		await output.finalize();

		assert(output.target.buffer);
		return output.target.buffer;
	};

	const demux = async (buffer: ArrayBuffer) => {
		const input = new Input({
			source: new BufferSource(buffer),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig?.description);

		return {
			packets,
			duration: await track.computeDuration(),
			preSkip: toDataView(decoderConfig.description).getUint16(10, true),
		};
	};

	// A stream whose audible part starts at 1 second
	const startInSamples = SAMPLE_RATE - PRE_SKIP;
	const packetCount = 50;

	const packets: EncodedPacket[] = [];
	for (let i = 0; i < packetCount; i++) {
		packets.push(new EncodedPacket(
			new Uint8Array([31 << 3, 0]), // TOC byte: config 31 (CELT fullband, 20 ms), code 0
			'key',
			(startInSamples + i * SAMPLES_PER_FRAME) / SAMPLE_RATE,
			SAMPLES_PER_FRAME / SAMPLE_RATE,
		));
	}

	const first = await demux(await mux(packets));

	expect(first.packets[0]!.timestamp).toBe(startInSamples / SAMPLE_RATE);
	expect(first.duration).toBe((startInSamples + packetCount * SAMPLES_PER_FRAME) / SAMPLE_RATE);

	const second = await demux(await mux(first.packets));

	const toTiming = (packet: EncodedPacket) => [packet.timestamp, packet.duration];
	expect(second.packets.map(toTiming)).toEqual(first.packets.map(toTiming));
	expect(second.duration).toBe(first.duration);

	// A standard stream starts at -preSkip, such that the audible part begins at zero
	const standard = await demux(await mux(packets.map((packet, i) => new EncodedPacket(
		packet.data,
		'key',
		(i * SAMPLES_PER_FRAME - PRE_SKIP) / SAMPLE_RATE,
		SAMPLES_PER_FRAME / SAMPLE_RATE,
	))));

	expect(standard.packets[0]!.timestamp).toBe(-PRE_SKIP / SAMPLE_RATE);
	expect(standard.packets[0]!.duration).toBe(SAMPLES_PER_FRAME / SAMPLE_RATE);
	expect(standard.duration).toBe((packetCount * SAMPLES_PER_FRAME - PRE_SKIP) / SAMPLE_RATE);
	expect(standard.preSkip).toBe(PRE_SKIP);

	// An earlier start goes into a larger pre-skip
	const early = await demux(await mux(packets.map((packet, i) => new EncodedPacket(
		packet.data,
		'key',
		(i * SAMPLES_PER_FRAME - PRE_SKIP - 2000) / SAMPLE_RATE,
		SAMPLES_PER_FRAME / SAMPLE_RATE,
	))));

	expect(early.preSkip).toBe(PRE_SKIP + 2000);
	expect(early.packets).toHaveLength(packetCount);
	expect(early.packets[0]!.timestamp).toBe((-PRE_SKIP - 2000) / SAMPLE_RATE);
	expect(early.duration).toBe((packetCount * SAMPLES_PER_FRAME - PRE_SKIP - 2000) / SAMPLE_RATE);

	// The pre-skip can't go beyond 65535, so the packets starting before that are dropped
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const tooEarly = await demux(await mux(packets.map((packet, i) => new EncodedPacket(
		packet.data,
		'key',
		(i * SAMPLES_PER_FRAME - 100000) / SAMPLE_RATE,
		SAMPLES_PER_FRAME / SAMPLE_RATE,
	))));
	const firstKeptIndex = Math.ceil((100000 - 65535) / SAMPLES_PER_FRAME);

	expect(tooEarly.preSkip).toBe(65535);
	expect(tooEarly.packets.map(packet => packet.timestamp)).toEqual(
		Array.from(
			{ length: packetCount - firstKeptIndex },
			(_, i) => ((firstKeptIndex + i) * SAMPLES_PER_FRAME - 100000) / SAMPLE_RATE,
		),
	);
	expect(warnSpy).toHaveBeenCalledWith(
		'Packets had to be discarded because their timestamp is too negative to represent in Ogg.',
	);
});

test('Granule positions of full pages', async () => {
	const SAMPLE_RATE = 48000;
	const SAMPLES_PER_FRAME = 120; // 2.5 ms at 48 kHz

	const opusHead = new Uint8Array(19);
	const opusHeadView = new DataView(opusHead.buffer);
	opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
	opusHead[8] = 1; // Version
	opusHead[9] = 1; // Channel count
	opusHeadView.setUint16(10, 312, true); // Pre-skip
	opusHeadView.setUint32(12, SAMPLE_RATE, true);

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);
	await output.start();

	// Packets this small fill up all 255 segments of a page before the page reaches its target size
	const packetDuration = SAMPLES_PER_FRAME / SAMPLE_RATE;
	for (let i = 0; i < 1000; i++) {
		const data = new Uint8Array(10);
		data[0] = 16 << 3;

		await audioSource.add(new EncodedPacket(data, 'key', i * packetDuration, packetDuration), {
			decoderConfig: {
				codec: 'opus',
				numberOfChannels: 1,
				sampleRate: SAMPLE_RATE,
				description: opusHead,
			},
		});
	}

	audioSource.close();
	await output.finalize();

	assert(output.target.buffer);

	const input = new Input({
		source: new BufferSource(output.target.buffer),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	for (const timestamp of timestamps) {
		const packet = await sink.getPacket(timestamp);
		expect(packet?.timestamp).toBe(timestamp);
	}
});

test('Vorbis comment header framing bit', async () => {
	await testVorbisCommentHeader({});
});

test('Vorbis comment header framing bit with metadata tags', async () => {
	await testVorbisCommentHeader({
		title: 'Title',
		artist: 'Artist',
	});
});

const testVorbisCommentHeader = async (tags: MetadataTags) => {
	const vorbis = await readVorbisFixture();

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(source);
	output.setMetadataTags(tags);
	await output.start();

	for (const packet of vorbis.packets) {
		await source.add(packet, { decoderConfig: vorbis.decoderConfig });
	}

	source.close();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig?.description);

	const commentHeader = getXiphLacedPackets(toUint8Array(decoderConfig.description))[1]!;
	const view = toDataView(commentHeader);

	// Walk the comment list so we know where it ends, then expect exactly the framing bit after it, which libvorbis
	// insists on
	let pos = 7;
	pos += 4 + view.getUint32(pos, true);
	const commentCount = view.getUint32(pos, true);
	pos += 4;
	for (let i = 0; i < commentCount; i++) {
		pos += 4 + view.getUint32(pos, true);
	}

	expect(commentCount).toBe(Object.keys(tags).length);
	expect(commentHeader.length).toBe(pos + 1);
	expect(commentHeader[pos]).toBe(1);

	expect(await input.getMetadataTags()).toMatchObject(tags);
};

const getXiphLacedPackets = (bytes: Uint8Array) => {
	const packetCount = bytes[0]! + 1;
	let pos = 1;

	const sizes: number[] = [];
	for (let i = 0; i < packetCount - 1; i++) {
		let size = 0;
		while (true) {
			const value = bytes[pos++]!;
			size += value;
			if (value < 255) {
				break;
			}
		}
		sizes.push(size);
	}

	const packets: Uint8Array[] = [];
	for (const size of sizes) {
		packets.push(bytes.subarray(pos, pos + size));
		pos += size;
	}
	packets.push(bytes.subarray(pos));

	return packets;
};

type RecordedPage = {
	source: MediaSource;
	headerType: number;
	granulePosition: number;
};

const OPUS_PRE_SKIP = 312;
const OPUS_DECODER_CONFIG: AudioDecoderConfig = {
	codec: 'opus',
	numberOfChannels: 1,
	sampleRate: 48000,
	description: new Uint8Array([
		0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // 'OpusHead'
		1, // Version
		1, // Channel count
		OPUS_PRE_SKIP & 0xff, OPUS_PRE_SKIP >> 8, // Pre-skip
		0x80, 0xbb, 0x00, 0x00, // Input sample rate (48000)
		0x00, 0x00, // Output gain
		0, // Channel mapping family
	]),
};

test('Interleaving across sample rates', async () => {
	const vorbis = await readVorbisFixture();
	expect(vorbis.decoderConfig.sampleRate).toBe(44100);

	const pages: RecordedPage[] = [];
	const output = new Output({
		format: new OggOutputFormat({
			maximumPageDuration: 0.1,
			onPage: recordPage(pages),
		}),
		target: new NullTarget(),
	});

	const opusSource = new EncodedAudioPacketSource('opus');
	const vorbisSource = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(opusSource);
	output.addAudioTrack(vorbisSource);
	await output.start();

	// Add the packets of both tracks in timestamp order
	let opusPacketCount = 0;
	for (const packet of vorbis.packets) {
		while (createOpusPacket(opusPacketCount).timestamp < packet.timestamp) {
			await opusSource.add(createOpusPacket(opusPacketCount++), { decoderConfig: OPUS_DECODER_CONFIG });
		}

		await vorbisSource.add(packet, { decoderConfig: vorbis.decoderConfig });
	}

	opusSource.close();
	vorbisSource.close();
	await output.finalize();

	expectTimeOrdered(pages.map(page => page.source === opusSource
		? (page.granulePosition - OPUS_PRE_SKIP) / 48000
		: page.granulePosition / 44100,
	));
});

test('Vorbis start trimming', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const { inputTimestamps, outputTimestamps } = await testVorbisStartOffset(-4410);

	expect(outputTimestamps).toEqual(inputTimestamps);
	expect(warnSpy).not.toHaveBeenCalled();
});

test('Vorbis start trimming beyond the first page', async () => {
	// A page can't hold all the packets before zero, so the earliest ones are dropped
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const { inputTimestamps, outputTimestamps } = await testVorbisStartOffset(-3 * 44100);

	expect(outputTimestamps.length).toBeLessThan(inputTimestamps.length);
	expect(outputTimestamps[0]).toBeLessThan(0);
	// The first packet's duration depends on the dropped one before it, so only check from the second one on
	expect(outputTimestamps.slice(1)).toEqual(inputTimestamps.slice(-(outputTimestamps.length - 1)));
	expect(warnSpy).toHaveBeenCalledWith(
		'Packets had to be discarded because their timestamp is too negative to represent in Ogg.',
	);
});

test('Vorbis start offset', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const { inputTimestamps, outputTimestamps } = await testVorbisStartOffset(44100);

	expect(outputTimestamps[0]).toBeGreaterThan(0);
	expect(outputTimestamps).toEqual(inputTimestamps);
	expect(warnSpy).not.toHaveBeenCalled();
});

// Returns the timestamps in samples
const testVorbisStartOffset = async (offsetInSamples: number) => {
	const vorbis = await readVorbisFixture();

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('vorbis');
	output.addAudioTrack(source);
	await output.start();

	const inputTimestamps: number[] = [];
	for (const packet of vorbis.packets) {
		const timestampInSamples = Math.round(44100 * packet.timestamp) + offsetInSamples;
		inputTimestamps.push(timestampInSamples);
		await source.add(
			packet.clone({ timestamp: timestampInSamples / 44100 }),
			{ decoderConfig: vorbis.decoderConfig },
		);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const outputTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		outputTimestamps.push(Math.round(44100 * packet.timestamp));
	}

	return {
		inputTimestamps,
		outputTimestamps,
	};
};

const readVorbisFixture = async () => {
	using input = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const decoderConfig = await track.getDecoderConfig();
	assert(decoderConfig);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		packets.push(packet);
	}

	return { decoderConfig, packets };
};

test('EOS page of a track ending early', async () => {
	const pages: RecordedPage[] = [];
	const output = new Output({
		format: new OggOutputFormat({ onPage: recordPage(pages) }),
		target: new NullTarget(),
	});

	const shortSource = new EncodedAudioPacketSource('opus');
	const longSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(shortSource);
	output.addAudioTrack(longSource);
	await output.start();

	for (let i = 0; i < 250; i++) {
		if (i < 50) {
			await shortSource.add(createOpusPacket(i), { decoderConfig: OPUS_DECODER_CONFIG });
		} else if (i === 50) {
			shortSource.close();
		}

		await longSource.add(createOpusPacket(i), { decoderConfig: OPUS_DECODER_CONFIG });
	}

	longSource.close();
	await output.finalize();

	expect(pages.filter(page => page.source === shortSource).at(-1)!.headerType & 4).toBe(4);
	expectTimeOrdered(pages.map(page => (page.granulePosition - OPUS_PRE_SKIP) / 48000));
});

test('Closing a track whose first add is still pending', async () => {
	const pages: RecordedPage[] = [];
	const output = new Output({
		format: new OggOutputFormat({ onPage: recordPage(pages) }),
		target: new NullTarget(),
	});

	const sourceA = new EncodedAudioPacketSource('opus');
	const sourceB = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(sourceA);
	output.addAudioTrack(sourceB);
	await output.start();

	// Holding the muxer lets everything queue up behind it, with A closing before its first add ran
	const release = await output._muxer.mutex.acquire();
	const addPromises = [
		sourceB.add(createOpusPacket(0), { decoderConfig: OPUS_DECODER_CONFIG }),
		sourceA.add(createOpusPacket(0), { decoderConfig: OPUS_DECODER_CONFIG }),
	];
	sourceA.close();
	await new Promise(resolve => setTimeout(resolve));
	release();

	await Promise.all(addPromises);
	sourceB.close();
	await output.finalize();

	// All BOS pages must come before any other page
	const bosFlags = pages.map(page => page.headerType & 2);
	expect(bosFlags.filter(x => x)).toHaveLength(2);
	expect(bosFlags.lastIndexOf(2)).toBeLessThan(bosFlags.indexOf(0));
});

const recordPage = (pages: RecordedPage[]) => (data: Uint8Array, position: number, source: MediaSource) => {
	pages.push({
		source,
		headerType: data[5]!,
		granulePosition: Number(toDataView(data).getBigInt64(6, true)),
	});
};

const expectTimeOrdered = (pageEndTimes: number[]) => {
	let maxPageEndTime = -Infinity;
	for (const pageEndTime of pageEndTimes) {
		// Pages can't be interleaved any finer than packets, so allow for that much
		expect(pageEndTime).toBeGreaterThan(maxPageEndTime - 0.05);
		maxPageEndTime = Math.max(maxPageEndTime, pageEndTime);
	}
};

test('Finalization after a write error on track close', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new StreamTarget(new WritableStream({
			write: () => {
				throw new Error('Write failed');
			},
		})),
	});

	const source = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(source);
	await output.start();

	// Nothing observes the track close, so let's keep its error from going unhandled
	const muxer = output._muxer as OggMuxer;
	const onTrackClose = muxer.onTrackClose.bind(muxer);
	muxer.onTrackClose = track => onTrackClose(track).catch(() => {});

	await source.add(createOpusPacket(0), { decoderConfig: OPUS_DECODER_CONFIG });
	await new Promise(resolve => setTimeout(resolve)); // Gives the write time to fail

	source.close();
	await new Promise(resolve => setTimeout(resolve)); // The track close now runs into the write error

	await expect(output.finalize()).rejects.toThrow('Write failed');
});

const createOpusPacket = (index: number) => {
	const data = new Uint8Array(100);
	data[0] = 31 << 3; // TOC byte: config 31 (CELT fullband, 20 ms), code 0

	return new EncodedPacket(data, 'key', (960 * index - OPUS_PRE_SKIP) / 48000, 960 / 48000);
};

test('Multiplexed header pages', async () => {
	using vorbisInput = new Input({
		source: new UrlSource('/vorbis-eos.ogg'),
		formats: ALL_FORMATS,
	});
	using opusInput = new Input({
		source: new UrlSource('/preroll-test.opus'),
		formats: ALL_FORMATS,
	});
	const vorbisTrack = (await vorbisInput.getPrimaryAudioTrack())!;
	const opusTrack = (await opusInput.getPrimaryAudioTrack())!;

	const pageKinds: ('header' | 'data')[] = [];
	const output = new Output({
		format: new OggOutputFormat({
			// Every new data packet flushes the page before it
			maximumPageDuration: 0.001,
			onPage: (data) => {
				const payload = data.subarray(27 + data[26]!);
				const magic = String.fromCharCode(...payload.subarray(0, 8));
				pageKinds.push(magic.startsWith('Opus') || magic.slice(1, 7) === 'vorbis' ? 'header' : 'data');
			},
		}),
		target: new BufferTarget(),
	});
	const vorbisSource = new EncodedAudioPacketSource('vorbis');
	const opusSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(vorbisSource);
	output.addAudioTrack(opusSource);
	await output.start();

	// As is standard, let the Vorbis priming packet end at zero, where the audible packets and the headers meet
	const firstVorbisPacket = (await new EncodedPacketSink(vorbisTrack).getFirstPacket())!;
	await addFirstPackets(vorbisSource, vorbisTrack, -(firstVorbisPacket.timestamp + firstVorbisPacket.duration));
	await addFirstPackets(opusSource, opusTrack, 0);
	await output.finalize();

	// No data page of either stream may come before all streams' header pages
	expect(pageKinds.filter(x => x === 'header')).toHaveLength(4);
	expect(pageKinds.lastIndexOf('header')).toBeLessThan(pageKinds.indexOf('data'));
});

const addFirstPackets = async (source: EncodedAudioPacketSource, track: InputAudioTrack, timestampOffset: number) => {
	const decoderConfig = (await track.getDecoderConfig())!;
	let packetCount = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		await source.add(packet.clone({ timestamp: packet.timestamp + timestampOffset }), { decoderConfig });
		if (++packetCount === 10) {
			break;
		}
	}
};

test('Opus start before the pre-skip with the header already written', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});
	const firstSource = new EncodedAudioPacketSource('opus');
	const secondSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(firstSource, { decoderConfig: OPUS_DECODER_CONFIG });
	output.addAudioTrack(secondSource, { decoderConfig: OPUS_DECODER_CONFIG });
	await output.start();

	// The first track's first packet gets the header pages of both tracks written, so the second track's pre-skip
	// can't grow anymore and its packets starting before it have to be dropped
	const timestamps = Array.from({ length: 10 }, (_, i) => 960 * (i - 2) - OPUS_PRE_SKIP);
	for (const timestamp of timestamps) {
		const packet = new EncodedPacket(new Uint8Array([31 << 3, 0]), 'key', timestamp / 48000, 960 / 48000);
		await firstSource.add(packet.clone({ timestamp: (timestamp + 1920) / 48000 }));
		await secondSource.add(packet);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const secondTrack = (await input.getAudioTracks())[1];
	assert(secondTrack);

	const readTimestamps: number[] = [];
	for await (const packet of new EncodedPacketSink(secondTrack).packets()) {
		readTimestamps.push(Math.round(48000 * packet.timestamp));
	}

	expect(readTimestamps).toEqual(timestamps.slice(2));
	expect(warnSpy).toHaveBeenCalledWith(
		'Packets had to be discarded because their timestamp is too negative to represent in Ogg.',
	);
});
