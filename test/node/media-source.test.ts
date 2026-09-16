import { afterEach, expect, test } from 'vitest';
import {
	CustomAudioEncoder, CustomVideoEncoder, customAudioEncoders, customVideoEncoders,
} from '../../src/custom-coder.js';
import { VideoCodec } from '../../src/codec.js';
import { Quality, VideoEncodingConfig } from '../../src/encode.js';
import { AudioSampleSource, VideoSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { BufferTarget } from '../../src/target.js';

// Exercise the real source -> encoder configuration -> MP4 path without requiring browser encoders.
class PacketVideoEncoder extends CustomVideoEncoder {
	static acceptQuantizer = true;

	static override supports(_codec: VideoCodec, config: VideoEncoderConfig) {
		return this.acceptQuantizer || config.bitrateMode !== 'quantizer';
	}

	init() {}
	encode(sample: VideoSample) {
		this.onPacket(new EncodedPacket(new Uint8Array(100), 'key', sample.timestamp, sample.duration), {
			decoderConfig: { codec: this.config.codec, codedWidth: this.config.width, codedHeight: this.config.height },
		});
	}

	flush() {}
	close() {}
}

class PacketAudioEncoder extends CustomAudioEncoder {
	static override supports() { return true; }
	init() {}
	encode(sample: AudioSample) {
		this.onPacket(new EncodedPacket(new Uint8Array(20), 'key', sample.timestamp, sample.duration), {
			decoderConfig: {
				codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44100,
				description: new Uint8Array([0x12, 0x10]),
			},
		});
	}

	flush() {}
	close() {}
}

const originalVideoEncoders = [...customVideoEncoders];
const originalAudioEncoders = [...customAudioEncoders];
afterEach(() => {
	customVideoEncoders.splice(0, customVideoEncoders.length, ...originalVideoEncoders);
	customAudioEncoders.splice(0, customAudioEncoders.length, ...originalAudioEncoders);
	PacketVideoEncoder.acceptQuantizer = true;
});

const encodeVideo = async (config: Partial<VideoEncodingConfig>, fragmented = true) => {
	customVideoEncoders.unshift(PacketVideoEncoder);
	const source = new VideoSampleSource({ codec: 'vp9', quality: new Quality({ bitrate: 1_000_000 }), ...config });
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : 'in-memory' }),
		target: new BufferTarget(),
	});
	output.addVideoTrack(source);
	await output.start();
	using sample = new VideoSample(new Uint8Array(16 * 16 * 4), {
		format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp: 0, duration: 1,
	});
	await source.add(sample);
	await output.finalize();
	return Buffer.from(output.target.buffer!);
};

const readVideoBitrates = (bytes: Buffer) => {
	const offset = bytes.indexOf('btrt');
	return offset < 0 ? null : [bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12)];
};

test('Fragmented MP4 takes nominal video bitrate from the selected config after onEncoderConfig', async () => {
	const bytes = await encodeVideo({
		onEncoderConfig: (config) => {
			config.bitrate = 2_000_000;
		},
	});
	expect(readVideoBitrates(bytes)).toEqual([2_000_000, 2_000_000]);
});

test('Fragmented MP4 uses the selected bitrate fallback when quantizer encoding is unsupported', async () => {
	PacketVideoEncoder.acceptQuantizer = false;
	const bytes = await encodeVideo({ quality: new Quality({ quantizer: 25, bitrate: 3_000_000 }) });
	expect(readVideoBitrates(bytes)).toEqual([3_000_000, 3_000_000]);
});

test('Fragmented MP4 does not advertise the unused bitrate fallback when quantizer encoding is selected', async () => {
	const bytes = await encodeVideo({ quality: new Quality({ quantizer: 25, bitrate: 3_000_000 }) });
	expect(readVideoBitrates(bytes)).toBeNull();
});

test('Regular MP4 measures encoded data instead of copying the nominal video bitrate', async () => {
	const bytes = await encodeVideo({}, false);
	expect(readVideoBitrates(bytes)).toEqual([800, 800]);
});

test('Regular MP4 measures bitrate even when quantizer encoding is selected', async () => {
	const bytes = await encodeVideo({ quality: new Quality({ quantizer: 25, bitrate: 3_000_000 }) }, false);
	expect(readVideoBitrates(bytes)).toEqual([800, 800]);
});

test('Fragmented MP4 takes nominal audio bitrate from the config after onEncoderConfig', async () => {
	customAudioEncoders.unshift(PacketAudioEncoder);
	const source = new AudioSampleSource({
		codec: 'aac', quality: new Quality({ bitrate: 128_000 }),
		onEncoderConfig: (config) => {
			config.bitrate = 192_000;
		},
	});
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new BufferTarget() });
	output.addAudioTrack(source);
	await output.start();
	using sample = new AudioSample({
		data: new Float32Array(2048), format: 'f32-planar', numberOfChannels: 2, sampleRate: 44100, timestamp: 0,
	});
	await source.add(sample);
	await output.finalize();
	const bytes = Buffer.from(output.target.buffer!);
	const offset = bytes.indexOf(new Uint8Array([0x40, 0x15, 0, 0, 0]));
	expect(offset).toBeGreaterThanOrEqual(0);
	expect([bytes.readUInt32BE(offset + 5), bytes.readUInt32BE(offset + 9)]).toEqual([192_000, 192_000]);
});
