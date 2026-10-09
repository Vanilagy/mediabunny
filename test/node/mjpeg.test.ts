import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS, MATROSKA } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import path from 'path';

const movFilePath = path.join(__dirname, '..', 'public/mjpeg.mov');

// Generated with FFmpeg: -i mjpeg.mov -map 0:v:0 -frames:v 2 -c:v copy mjpeg.mp4
test.concurrent('reading FFmpeg MJPEG in an mp4v sample entry', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/mjpeg.mp4')),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	expect(await track.getInternalCodecId()).toBe('mp4v');
	expect(await track.getCodec()).toBe('mjpeg');
	expect(await track.getCodedWidth()).toBe(640);
	expect(await track.getCodedHeight()).toBe(360);
	expect((await track.getDecoderConfig())!.codec).toBe('jpeg');
	expect((await track.getDecoderConfig())!.description).toBeUndefined();
	expect((await track.computePacketStats()).packetCount).toBe(2);
});

test.concurrent.each(['in-memory', 'fragmented'] as const)(
	'MJPEG MP4 %s round trip',
	async (fastStart) => {
		using input = new Input({
			source: new FilePathSource(movFilePath),
			formats: ALL_FORMATS,
		});
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart }),
			target: new BufferTarget(),
		});
		const conversion = await Conversion.init({ input, output });
		await conversion.execute();
		using result = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const track = (await result.getPrimaryVideoTrack())!;
		expect(await track.getCodec()).toBe('mjpeg');
		expect((await track.computePacketStats()).packetCount).toBe(125);
	},
);

test.concurrent('mjpeg reading', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(movFilePath),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('mjpeg');
	expect(await videoTrack.getCodedWidth()).toBe(640);
	expect(await videoTrack.getCodedHeight()).toBe(360);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('jpeg');
	expect(decoderConfig.description).toBeUndefined();
});

test.concurrent('transcoding to mjpeg', { timeout: 20_000 }, async () => {
	using input = new Input({
		source: new FilePathSource(movFilePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			codec: 'mjpeg',
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await newInput.getPrimaryVideoTrack())!;
	expect(await videoTrack.getCodec()).toBe('mjpeg');
	expect((await videoTrack.computePacketStats()).packetCount).toBe(125);

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('jpeg');
	expect(decoderConfig.description).toBeUndefined();
});

// From test/public: ffmpeg -i demo.mp4 -map 0:v:0 -c:v mjpeg -q:v 3 -pix_fmt yuvj420p mjpeg.mkv
test.concurrent('reads MJPEG frames from an FFmpeg MKV', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/mjpeg.mkv')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MATROSKA);
	expect(await input.computeDuration()).toBeCloseTo(5, 5);
	expect(await input.getAudioTracks()).toHaveLength(0);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getCodec()).toBe('mjpeg');
	expect(await track.getCodedWidth()).toBe(640);
	expect(await track.getCodedHeight()).toBe(360);
	expect((await track.getDecoderConfig())!.codec).toBe('jpeg');

	let count = 0;
	for await (const packet of new EncodedPacketSink(track).packets()) {
		expect(packet.type).toBe('key');
		expect(packet.timestamp).toBeCloseTo(count / 25, 5);
		expect(packet.duration).toBeCloseTo(1 / 25, 5);
		expect(Array.from(packet.data.subarray(0, 2))).toEqual([0xff, 0xd8]);
		expect(Array.from(packet.data.subarray(-2))).toEqual([0xff, 0xd9]);
		count++;
	}
	expect(count).toBe(125);
});
