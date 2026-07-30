import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { canEncodeVideo, Quality, QualityLevel } from '../../src/encode.js';
import { VideoCodec } from '../../src/codec.js';

const QUALITY_LEVELS: QualityLevel[] = ['very-low', 'low', 'medium', 'high', 'very-high'];

for (const level of QUALITY_LEVELS) {
	test(`AVC, qualitative quality '${level}'`, { timeout: 10_000 }, async () => {
		await convertVideo(new Quality(level), 'avc');
	});
}

test('AVC, custom qualitative quality', { timeout: 10_000 }, async () => {
	await convertVideo(new Quality(0.85), 'avc');
});

test('AVC, qualitative quality with preferBitrate', { timeout: 10_000 }, async () => {
	await convertVideo(new Quality({ quality: 0.5, preferBitrate: true }), 'avc');
});

test('AVC, explicit bitrate', { timeout: 10_000 }, async () => {
	await convertVideo(new Quality({ bitrate: 1_000_000 }), 'avc');
});

test('AVC, explicit bitrate with constant bitrate mode', { timeout: 10_000 }, async () => {
	await convertVideo(new Quality({ bitrate: 1_000_000, bitrateMode: 'constant' }), 'avc');
});

test('AVC, explicit quantizer', { timeout: 10_000 }, async () => {
	// No bitrate fallback here, so environments without quantizer support are expected to reject the track
	await convertVideo(new Quality({ quantizer: 30 }), 'avc', true);
});

test('AVC, explicit quantizer with bitrate fallback', { timeout: 10_000 }, async () => {
	await convertVideo(new Quality({ quantizer: 30, bitrate: 1_000_000 }), 'avc');
});

// Medium quality prefers quantizer-based encoding, so this hits the quantizer path for every codec that supports it
const TESTED_VIDEO_CODECS: VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1', 'vp8'];

for (const codec of TESTED_VIDEO_CODECS) {
	test(`Medium quality with codec '${codec}'`, { timeout: 10_000 }, async () => {
		const quality = new Quality('medium');
		if (!await canEncodeVideo(codec, { quality })) {
			// The environment can't encode this codec at all; nothing to test
			return;
		}

		await convertVideo(quality, codec);
	});
}

/** Converts the first two seconds of the test video using the given quality and codec. */
const convertVideo = async (quality: Quality, codec: VideoCodec, allowMissingQuantizerSupport = false) => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		// Matroska supports all video codecs we test here
		format: codec === 'avc' ? new Mp4OutputFormat() : new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		trim: { start: 0, end: 2 },
		video: { codec, quality },
		audio: { discard: true },
	});

	if (allowMissingQuantizerSupport && !conversion.isValid) {
		// The environment can't do quantizer-based encoding; a correctly-explained rejection also satisfies the test
		await expect(conversion.execute()).rejects.toThrow(
			`not able to encode '${codec}' with the provided parameters`,
		);
		return;
	}

	await conversion.execute();

	expect(conversion.utilizedTracks.some(x => x.isVideoTrack())).toBe(true);
};
