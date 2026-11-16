import { expect, test } from 'vitest';
import { Conversion } from '../../src/conversion.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { AudioSampleSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { AudioSampleSink } from '../../src/media-sink.js';
import { MkvOutputFormat, MovOutputFormat } from '../../src/output-format.js';
import { Output } from '../../src/output.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample } from '../../src/sample.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

// Muxed HLS playback on a physical iPhone ended at the short audio track's end,
// although the same standalone MP4 played through. Padding must preserve separate tracks.
test.each([
	{ pad: false, trim: undefined, discardVideo: false, reserve: false, expected: 0.5 },
	{ pad: true, trim: undefined, discardVideo: false, reserve: false, expected: 2 },
	{ pad: true, trim: { start: 0.25, end: 1.5 }, discardVideo: false, reserve: false, expected: 1.25 },
	{ pad: true, trim: undefined, discardVideo: true, reserve: false, expected: 0.5 },
	{ pad: true, trim: undefined, discardVideo: false, reserve: true, expected: 2 },
])('Audio padding: %j', async ({ pad, trim, discardVideo, reserve, expected }) => {
	const fixture = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const video = new EncodedVideoPacketSource('vp8');
	fixture.addVideoTrack(video);
	const audios = [48000, 24000].map((sampleRate) => {
		const source = new AudioSampleSource({ codec: 'pcm-s16' });
		fixture.addAudioTrack(source);
		return { source, sampleRate };
	});
	await fixture.start();
	for (const { source, sampleRate } of audios) {
		using sample = new AudioSample({
			format: 'f32-planar', data: new Float32Array(sampleRate / 2).fill(0.25),
			sampleRate, numberOfChannels: 1, timestamp: 0,
		});
		await source.add(sample);
		source.close();
	}
	await video.add(new EncodedPacket(new Uint8Array([1, 2, 3]), 'key', 0, 2), {
		decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
	});
	await fixture.finalize();

	using input = new Input({ source: new BufferSource(fixture.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({
		format: reserve ? new MovOutputFormat({ fastStart: 'reserve' }) : new MkvOutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({
		input, output, trim,
		video: { discard: discardVideo },
		audio: { codec: 'pcm-s16', padToVideoEnd: pad },
	});
	expect(conversion.discardedTracks).toHaveLength(discardVideo ? 1 : 0);
	await conversion.execute();
	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await result.getAudioTracks();
	expect(tracks).toHaveLength(2);
	for (const track of tracks) {
		expect(await track.computeDuration()).toBeCloseTo(expected, 3);
		const sink = new AudioSampleSink(track);
		using first = await sink.getSample(0);
		expect(first).not.toBeNull();
		const firstData = new Float32Array(first!.numberOfFrames);
		first!.copyTo(firstData, { planeIndex: 0, format: 'f32-planar' });
		expect(firstData[0]).toBeCloseTo(0.25, 3);
		if (expected > 0.5) {
			using tail = await sink.getSample(expected - 0.1);
			expect(tail).not.toBeNull();
			const data = new Float32Array(tail!.numberOfFrames);
			tail!.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
			expect(data.every(value => value === 0)).toBe(true);
		}
	}
});
