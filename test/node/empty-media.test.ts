import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { AudioTrackMetadata, Output } from '../../src/output.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	FlacOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { EncodedPacket } from '../../src/packet.js';
import { Bitstream } from '../../shared/bitstream.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';

type EmptyMediaVariant =
	| { type: 'mp4'; fastStart: false | 'in-memory' | 'reserve' | 'fragmented' }
	| { type: 'cmaf' }
	| { type: 'matroska' };

test('No tracks, MP4, fastStart: false', async () => {
	await testNoTracks({ type: 'mp4', fastStart: false });
});

test('No tracks, MP4, fastStart: in-memory', async () => {
	await testNoTracks({ type: 'mp4', fastStart: 'in-memory' });
});

test('No tracks, MP4, fastStart: reserve', async () => {
	await testNoTracks({ type: 'mp4', fastStart: 'reserve' });
});

test('No tracks, MP4, fastStart: fragmented', async () => {
	await testNoTracks({ type: 'mp4', fastStart: 'fragmented' });
});

test('No tracks, CMAF', async () => {
	await testNoTracks({ type: 'cmaf' });
});

test('No tracks, Matroska', async () => {
	await testNoTracks({ type: 'matroska' });
});

// These formats are inherently multi-track, so holding zero tracks is perfectly fine
const testNoTracks = async (variant: EmptyMediaVariant) => {
	const initTarget = new BufferTarget();

	const output = new Output({
		format: createFormat(variant),
		target: new BufferTarget(),
		initTarget: variant.type === 'cmaf' ? initTarget : undefined,
	});

	await output.start();
	await output.finalize();

	using initInput = variant.type === 'cmaf'
		? new Input({ source: new BufferSource(initTarget.buffer!), formats: ALL_FORMATS })
		: undefined;

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
		initInput,
	});

	expect(await input.getTracks()).toHaveLength(0);
};

test('No tracks, MPEG-TS', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(0);
});

test('No tracks, Ogg', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	await output.start();
	await output.finalize();

	// An Ogg file is nothing but its logical bitstreams, so zero tracks means zero bytes
	expect(output.target.buffer!.byteLength).toBe(0);
});

test('No tracks, HLS', async () => {
	const files = new Map<string, Uint8Array>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	await output.start();
	await output.finalize();

	// Without tracks there are no playlists either, so all we get is the master playlist (the root target)
	expect([...files.keys()]).toEqual(['']);
});

test('No tracks, MP3', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	await expect(output.start()).rejects.toThrow('MP3 requires exactly 1 audio track');
});

test('No tracks, WAVE', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	await expect(output.start()).rejects.toThrow('WAVE requires exactly 1 audio track');
});

test('No tracks, ADTS', async () => {
	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	await expect(output.start()).rejects.toThrow('ADTS requires exactly 1 audio track');
});

test('No tracks, FLAC', async () => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	await expect(output.start()).rejects.toThrow('FLAC requires exactly 1 audio track');
});

test('Empty MP4, fastStart: false', async () => {
	await testEmptyMedia({ type: 'mp4', fastStart: false });
});

test('Empty MP4, fastStart: in-memory', async () => {
	await testEmptyMedia({ type: 'mp4', fastStart: 'in-memory' });
});

test('Empty MP4, fastStart: reserve', async () => {
	await testEmptyMedia({ type: 'mp4', fastStart: 'reserve' });
});

test('Empty MP4, fastStart: fragmented', async () => {
	await testEmptyMedia({ type: 'mp4', fastStart: 'fragmented' });
});

test('Empty CMAF', async () => {
	await testEmptyMedia({ type: 'cmaf' });
});

test('Empty Matroska', async () => {
	await testEmptyMedia({ type: 'matroska' });
});

const testEmptyMedia = async (variant: EmptyMediaVariant) => {
	const initTarget = new BufferTarget();

	const output = new Output({
		format: createFormat(variant),
		target: new BufferTarget(),
		initTarget: variant.type === 'cmaf' ? initTarget : undefined,
	});

	output.addVideoTrack(new EncodedVideoPacketSource('avc'), { maximumPacketCount: 100 });
	output.addAudioTrack(new EncodedAudioPacketSource('opus'), { maximumPacketCount: 100 });

	await output.start();
	await output.finalize();

	using initInput = variant.type === 'cmaf'
		? new Input({ source: new BufferSource(initTarget.buffer!), formats: ALL_FORMATS })
		: undefined;

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
		initInput,
	});

	expect(await input.getTracks()).toHaveLength(0);
};

test('Empty MP4 with declared decoder config, fastStart: false', async () => {
	await testEmptyMediaWithDecoderConfig({ type: 'mp4', fastStart: false });
});

test('Empty MP4 with declared decoder config, fastStart: in-memory', async () => {
	await testEmptyMediaWithDecoderConfig({ type: 'mp4', fastStart: 'in-memory' });
});

test('Empty MP4 with declared decoder config, fastStart: reserve', async () => {
	await testEmptyMediaWithDecoderConfig({ type: 'mp4', fastStart: 'reserve' });
});

test('Empty MP4 with declared decoder config, fastStart: fragmented', async () => {
	await testEmptyMediaWithDecoderConfig({ type: 'mp4', fastStart: 'fragmented' });
});

test('Empty CMAF with declared decoder config', async () => {
	await testEmptyMediaWithDecoderConfig({ type: 'cmaf' });
});

test('Empty Matroska with declared decoder config', async () => {
	await testEmptyMediaWithDecoderConfig({ type: 'matroska' });
});

// VP9 and Opus need no description, so the decoder config alone is enough to fully define the tracks
const testEmptyMediaWithDecoderConfig = async (variant: EmptyMediaVariant) => {
	const initTarget = new BufferTarget();

	const output = new Output({
		format: createFormat(variant),
		target: new BufferTarget(),
		initTarget: variant.type === 'cmaf' ? initTarget : undefined,
	});

	output.addVideoTrack(new EncodedVideoPacketSource('vp9'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'vp09.00.10.08',
			codedWidth: 1280,
			codedHeight: 720,
		},
	});
	output.addAudioTrack(new EncodedAudioPacketSource('opus'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'opus',
			sampleRate: 48000,
			numberOfChannels: 2,
		},
	});

	await output.start();
	await output.finalize();

	using initInput = variant.type === 'cmaf'
		? new Input({ source: new BufferSource(initTarget.buffer!), formats: ALL_FORMATS })
		: undefined;

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
		initInput,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = tracks[0] as InputVideoTrack;
	expect(videoTrack.isVideoTrack()).toBe(true);
	expect(await videoTrack.getCodec()).toBe('vp9');
	expect(await videoTrack.getCodedWidth()).toBe(1280);
	expect(await videoTrack.getCodedHeight()).toBe(720);
	expect((await videoTrack.computePacketStats()).packetCount).toBe(0);

	const audioTrack = tracks[1] as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('opus');
	expect(await audioTrack.getSampleRate()).toBe(48000);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect((await audioTrack.computePacketStats()).packetCount).toBe(0);
};

test('Empty Ogg', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	// Ogg is audio-only, so let's go for two audio tracks here
	output.addAudioTrack(new EncodedAudioPacketSource('opus'), { maximumPacketCount: 100 });
	output.addAudioTrack(new EncodedAudioPacketSource('opus'), { maximumPacketCount: 100 });

	await output.start();
	await output.finalize();

	// Ogg has no container-level header, so without any packets, nothing at all gets written
	expect(output.target.buffer!.byteLength).toBe(0);
});

test('Empty Ogg with declared decoder config', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	// An OpusHead packet as specified in RFC 7845
	const description = new Uint8Array(19);
	const view = new DataView(description.buffer);
	description.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // 'OpusHead'
	view.setUint8(8, 1); // Version
	view.setUint8(9, 2); // Channel count
	view.setUint16(10, 312, true); // Pre-skip
	view.setUint32(12, 48000, true); // Sample rate
	view.setInt16(16, 0, true); // Output gain
	view.setUint8(18, 0); // Channel mapping family

	const metadata: AudioTrackMetadata = {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'opus',
			sampleRate: 48000,
			numberOfChannels: 2,
			description,
		},
	};

	output.addAudioTrack(new EncodedAudioPacketSource('opus'), metadata);
	output.addAudioTrack(new EncodedAudioPacketSource('opus'), metadata);

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	for (const track of tracks) {
		const audioTrack = track as InputAudioTrack;
		expect(audioTrack.isAudioTrack()).toBe(true);
		expect(await audioTrack.getCodec()).toBe('opus');
		expect(await audioTrack.getSampleRate()).toBe(48000);
		expect(await audioTrack.getNumberOfChannels()).toBe(2);
		expect((await audioTrack.computePacketStats()).packetCount).toBe(0);
	}
});

test('Empty WAVE', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	// WAVE holds a single audio track
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'), { maximumPacketCount: 100 });

	await output.start();

	// There's no information to go on, so the muxer can't make anything up
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty WAVE file');
});

test('Empty WAVE with declared decoder config', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	// Deliberately not the fallback values, so we can tell the declared config was actually used
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'pcm-s16',
			sampleRate: 44100,
			numberOfChannels: 1,
		},
	});

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);

	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	expect(await audioTrack.getSampleRate()).toBe(44100);
	expect(await audioTrack.getNumberOfChannels()).toBe(1);
	expect((await audioTrack.computePacketStats()).packetCount).toBe(0);
});

test('Empty MP3', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	output.addAudioTrack(new EncodedAudioPacketSource('mp3'), { maximumPacketCount: 100 });

	await output.start();

	// There's no information to go on, so the muxer can't make anything up
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty MP3 file');
});

test('Empty MP3 with declared decoder config', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	// Deliberately not the fallback values, so we can tell the declared config was actually used
	output.addAudioTrack(new EncodedAudioPacketSource('mp3'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'mp3',
			sampleRate: 44100,
			numberOfChannels: 1,
		},
	});

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);

	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('mp3');
	expect(await audioTrack.getSampleRate()).toBe(44100);
	expect(await audioTrack.getNumberOfChannels()).toBe(1);
	expect((await audioTrack.computePacketStats()).packetCount).toBe(0);
});

test('Empty MP3 with priming packet', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	// An MPEG Version 1 Layer III frame header, 128 kbps, 32 kHz, single channel
	const frameHeader = new Uint8Array([0xff, 0xfb, 0x98, 0xc0]);

	// The priming packet takes precedence over the declared config, so we can tell which one was used
	output.addAudioTrack(new EncodedAudioPacketSource('mp3'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'mp3',
			sampleRate: 44100,
			numberOfChannels: 2,
		},
		primingPacket: new EncodedPacket(frameHeader, 'key', 0, 0),
	});

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);

	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('mp3');
	expect(await audioTrack.getSampleRate()).toBe(32000);
	expect(await audioTrack.getNumberOfChannels()).toBe(1);
	expect((await audioTrack.computePacketStats()).packetCount).toBe(0);
});

test('Empty MP3 without a Xing header', async () => {
	const output = new Output({
		format: new Mp3OutputFormat({ xingHeader: false }),
		target: new BufferTarget(),
	});

	output.addAudioTrack(new EncodedAudioPacketSource('mp3'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'mp3',
			sampleRate: 44100,
			numberOfChannels: 1,
		},
	});

	await output.start();

	// The Xing frame is the only frame we could have synthesized, so there'd be nothing to write at all
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty MP3 file');
});

test('Empty ADTS', async () => {
	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	output.addAudioTrack(new EncodedAudioPacketSource('aac'), { maximumPacketCount: 100 });

	await output.start();

	// ADTS is a bare sequence of frames, each carrying its own header, so there'd be nothing to write
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty ADTS file');
});

test('Empty ADTS with declared decoder config', async () => {
	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	output.addAudioTrack(new EncodedAudioPacketSource('aac'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'mp4a.40.2',
			sampleRate: 44100,
			numberOfChannels: 2,
			description: new Uint8Array([0x12, 0x10]), // AudioSpecificConfig: AAC-LC, 44100 Hz, stereo
		},
	});

	await output.start();

	// The declared config doesn't help; ADTS has no place to put it
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty ADTS file');
});

test('Empty FLAC', async () => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	output.addAudioTrack(new EncodedAudioPacketSource('flac'), { maximumPacketCount: 100 });

	await output.start();

	// There's no information to go on, so the muxer can't make anything up
	await expect(output.finalize()).rejects.toThrow('Cannot finalize an empty FLAC file');
});

test('Empty FLAC with declared decoder config', async () => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	// A STREAMINFO metadata block for a 44100 Hz mono, 16-bit stream
	const description = new Uint8Array(4 + 4 + 34);
	description.set([0x66, 0x4c, 0x61, 0x43]); // 'fLaC'
	description[4] = 0x80; // Last metadata block, type STREAMINFO
	description[7] = 34; // Block size
	const streamInfo = new Bitstream(description.subarray(8));
	streamInfo.writeBits(16, 4096); // Minimum block size
	streamInfo.writeBits(16, 4096); // Maximum block size
	streamInfo.writeBits(24, 0); // Minimum frame size
	streamInfo.writeBits(24, 0); // Maximum frame size
	streamInfo.writeBits(20, 44100); // Sample rate
	streamInfo.writeBits(3, 0); // Channels - 1
	streamInfo.writeBits(5, 15); // Bits per sample - 1

	output.addAudioTrack(new EncodedAudioPacketSource('flac'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'flac',
			sampleRate: 44100,
			numberOfChannels: 1,
			description,
		},
	});

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);

	const audioTrack = tracks[0] as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('flac');
	expect(await audioTrack.getSampleRate()).toBe(44100);
	expect(await audioTrack.getNumberOfChannels()).toBe(1);
	expect((await audioTrack.computePacketStats()).packetCount).toBe(0);
});

test('Empty MPEG-TS', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	output.addVideoTrack(new EncodedVideoPacketSource('avc'), { maximumPacketCount: 100 });
	output.addAudioTrack(new EncodedAudioPacketSource('aac'), { maximumPacketCount: 100 });

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(0);
});

test('Empty MPEG-TS with declared decoder config', async () => {
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	// An MPEG-TS stream cannot be described without a packet - it's the first packet that defines the stream - so
	// declaring the config up front changes nothing
	output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'avc1.42001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]),
		},
	});

	await output.start();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(0);
});

test('Empty HLS', async () => {
	const files = new Map<string, Uint8Array>();

	const output = new Output({
		format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat() }),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => files.set(request.path, new Uint8Array(target.buffer!)));
			return target;
		}),
	});

	output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
		maximumPacketCount: 100,
		decoderConfig: {
			codec: 'avc1.42001f',
			codedWidth: 1280,
			codedHeight: 720,
			description: new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]),
		},
	});

	await output.start();
	await output.finalize();

	// HLS only ever writes segments for packets it has actually seen, so all we get is the master playlist (which is
	// the root target) and one empty media playlist
	expect([...files.keys()].sort()).toEqual(['', 'playlist-1.m3u8']);
});

const createFormat = (variant: EmptyMediaVariant) => {
	if (variant.type === 'mp4') {
		return new Mp4OutputFormat({ fastStart: variant.fastStart });
	} else if (variant.type === 'cmaf') {
		return new CmafOutputFormat();
	} else {
		return new MkvOutputFormat();
	}
};
