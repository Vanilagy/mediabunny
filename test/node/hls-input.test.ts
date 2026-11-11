/* eslint-disable @stylistic/max-len */
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CmafOutputFormat,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	Input,
	InputAudioTrack,
	InputVideoTrack,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	Output,
	OutputTrackGroup,
	PathedTarget,
	UrlSource,
} from 'mediabunny';
import { expect, test, vi } from 'vitest';
import { HLS, HLS_FORMATS, HlsInputFormat, MP4 } from '../../src/input-format.js';
import { assert, hexStringToBytes, rejectAfter } from '../../src/misc.js';
import { CustomPathedSource, FilePathSource } from '../../src/source.js';
import { createAes128CbcDecryptStream } from '../../src/aes.js';
import { Reader } from '../../src/reader.js';

// A lot of test cases taken from:
// https://github.com/video-dev/hls.js/blob/master/tests/test-streams.js

test.concurrent('Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	let rootReadCount = 0;
	input.source.on('read', () => rootReadCount++);

	expect(await input.getFormat()).toBeInstanceOf(HlsInputFormat);
	expect(await input.getFormat()).toBe(HLS);

	expect(sourceCount).toBe(1);
	expect(rootReadCount).toBeGreaterThan(0);

	// Test tracks directly (metadata comes from the master playlist before segments are read)
	const tracks = await input.getTracks();
	const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
	const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());

	expect(videoTracks).toHaveLength(5);
	expect(audioTracks).toHaveLength(5);

	expect(await videoTracks[0]!.getCodec()).toBe('avc');
	expect(await videoTracks[0]!.getDisplayWidth()).toBe(1280);
	expect(await videoTracks[0]!.getDisplayHeight()).toBe(720);
	expect(await videoTracks[0]!.getBitrate()).toBe(2149280);
	expect(await videoTracks[0]!.getName()).toBe('720');
	expect(videoTracks[0]!.id).toBe(2);

	expect(await videoTracks[1]!.getCodec()).toBe('avc');
	expect(await videoTracks[1]!.getDisplayWidth()).toBe(320);
	expect(await videoTracks[1]!.getDisplayHeight()).toBe(184);
	expect(await videoTracks[1]!.getBitrate()).toBe(246440);
	expect(await videoTracks[1]!.getName()).toBe('240');
	expect(videoTracks[1]!.id).toBe(4);

	expect(await videoTracks[2]!.getCodec()).toBe('avc');
	expect(await videoTracks[2]!.getDisplayWidth()).toBe(512);
	expect(await videoTracks[2]!.getDisplayHeight()).toBe(288);
	expect(await videoTracks[2]!.getBitrate()).toBe(460560);
	expect(await videoTracks[2]!.getName()).toBe('380');
	expect(videoTracks[2]!.id).toBe(6);

	expect(await videoTracks[3]!.getCodec()).toBe('avc');
	expect(await videoTracks[3]!.getDisplayWidth()).toBe(848);
	expect(await videoTracks[3]!.getDisplayHeight()).toBe(480);
	expect(await videoTracks[3]!.getBitrate()).toBe(836280);
	expect(await videoTracks[3]!.getName()).toBe('480');
	expect(videoTracks[3]!.id).toBe(8);

	expect(await videoTracks[4]!.getCodec()).toBe('avc');
	expect(await videoTracks[4]!.getDisplayWidth()).toBe(1920);
	expect(await videoTracks[4]!.getDisplayHeight()).toBe(1080);
	expect(await videoTracks[4]!.getBitrate()).toBe(6221600);
	expect(await videoTracks[4]!.getName()).toBe('1080');
	expect(videoTracks[4]!.id).toBe(10);

	expect(await audioTracks[0]!.getCodec()).toBe('aac');
	expect(await audioTracks[0]!.getBitrate()).toBe(2149280);
	expect(await audioTracks[0]!.getName()).toBe('720');
	expect(audioTracks[0]!.id).toBe(1);

	expect(await audioTracks[1]!.getCodec()).toBe('aac');
	expect(await audioTracks[1]!.getBitrate()).toBe(246440);
	expect(await audioTracks[1]!.getName()).toBe('240');
	expect(audioTracks[1]!.id).toBe(3);

	expect(await audioTracks[2]!.getCodec()).toBe('aac');
	expect(await audioTracks[2]!.getBitrate()).toBe(460560);
	expect(await audioTracks[2]!.getName()).toBe('380');
	expect(audioTracks[2]!.id).toBe(5);

	expect(await audioTracks[3]!.getCodec()).toBe('aac');
	expect(await audioTracks[3]!.getBitrate()).toBe(836280);
	expect(await audioTracks[3]!.getName()).toBe('480');
	expect(audioTracks[3]!.id).toBe(7);

	expect(await audioTracks[4]!.getCodec()).toBe('aac');
	expect(await audioTracks[4]!.getBitrate()).toBe(6221600);
	expect(await audioTracks[4]!.getName()).toBe('1080');
	expect(audioTracks[4]!.id).toBe(9);

	for (let i = 0; i < videoTracks.length - 1; i++) {
		for (let j = i + 1; j < videoTracks.length; j++) {
			expect(videoTracks[i]!.canBePairedWith(videoTracks[j]!)).toBe(false);
		}
	}

	for (let i = 0; i < videoTracks.length; i++) {
		for (let j = 0; j < audioTracks.length; j++) {
			expect(videoTracks[i]!.canBePairedWith(audioTracks[j]!)).toBe(i === j);
		}
	}

	expect(sourceCount).toBe(1);

	// Force hydration of all tracks by loading actual media data
	for (const track of tracks) {
		expect(await track.isRelativeToUnixEpoch()).toBe(false);
	}

	expect(sourceCount).toBe(1 + 5 + 5);

	for (const track of tracks) {
		expect(await track.isLive()).toBe(false);
	}

	expect(await videoTracks[0]!.getDurationFromMetadata()).toBe(634.584);
	expect(await audioTracks[0]!.getDurationFromMetadata()).toBe(634.584);

	expect(await videoTracks[0]!.getCodedWidth()).toBe(1280);
	expect(await videoTracks[0]!.getCodedHeight()).toBe(720);
	expect(await videoTracks[1]!.getCodedWidth()).toBe(320);
	expect(await videoTracks[1]!.getCodedHeight()).toBe(184);
	expect(await videoTracks[2]!.getCodedWidth()).toBe(512);
	expect(await videoTracks[2]!.getCodedHeight()).toBe(288);
	expect(await videoTracks[3]!.getCodedWidth()).toBe(848);
	expect(await videoTracks[3]!.getCodedHeight()).toBe(480);
	expect(await videoTracks[4]!.getCodedWidth()).toBe(1920);
	expect(await videoTracks[4]!.getCodedHeight()).toBe(1080);

	// Ensure metadata display dimensions still match even after hydration (they come from the manifest hint)
	expect(await videoTracks[0]!.getDisplayWidth()).toBe(1280);
	expect(await videoTracks[0]!.getDisplayHeight()).toBe(720);
	expect(await videoTracks[1]!.getDisplayWidth()).toBe(320);
	expect(await videoTracks[1]!.getDisplayHeight()).toBe(184);
	expect(await videoTracks[2]!.getDisplayWidth()).toBe(512);
	expect(await videoTracks[2]!.getDisplayHeight()).toBe(288);
	expect(await videoTracks[3]!.getDisplayWidth()).toBe(848);
	expect(await videoTracks[3]!.getDisplayHeight()).toBe(480);
	expect(await videoTracks[4]!.getDisplayWidth()).toBe(1920);
	expect(await videoTracks[4]!.getDisplayHeight()).toBe(1080);

	expect(await videoTracks[0]!.getCodecParameterString()).toEqual('avc1.64001f');
	expect(await videoTracks[1]!.getCodecParameterString()).toEqual('avc1.42c00d'); // Slightly altered
	expect(await videoTracks[2]!.getCodecParameterString()).toEqual('avc1.42c016'); // Slightly altered
	expect(await videoTracks[3]!.getCodecParameterString()).toEqual('avc1.64001f');
	expect(await videoTracks[4]!.getCodecParameterString()).toEqual('avc1.640028');

	expect(await audioTracks[0]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[0]!.getSampleRate()).toBe(44100);
	expect(await audioTracks[1]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[1]!.getSampleRate()).toBe(22050);
	expect(await audioTracks[2]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[2]!.getSampleRate()).toBe(22050);
	expect(await audioTracks[3]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[3]!.getSampleRate()).toBe(44100);
	expect(await audioTracks[4]!.getNumberOfChannels()).toBe(2);
	expect(await audioTracks[4]!.getSampleRate()).toBe(44100);

	for (const audioTrack of audioTracks) {
		// Actual data always contains object type 2
		expect(await audioTrack.getCodecParameterString()).toEqual('mp4a.40.2');
	}

	expect(Math.min(await videoTracks[0]!.getFirstTimestamp(), await audioTracks[0]!.getFirstTimestamp())).toBe(0.0101);

	const sink = new EncodedPacketSink(videoTracks[0]!);
	const lastPacket = await sink.getPacket(Infinity);
	expect(lastPacket!.timestamp).toBeCloseTo(634.6);

	expect(sourceCount).toBe(1 + 5 + 5 + 1);

	const middlePacket = await sink.getPacket(300);
	expect(middlePacket!.timestamp).toBeCloseTo(300);

	expect(sourceCount).toBe(1 + 5 + 5 + 1 + 1);

	let lastSequenceNumber = -Infinity;
	let packetCount = 0;
	for await (const packet of sink.packets()) {
		expect(packet.sequenceNumber).toBeGreaterThan(lastSequenceNumber);

		lastSequenceNumber = packet.sequenceNumber;
		packetCount++;

		if (packet.timestamp > 18) {
			break;
		}
	}

	expect(packetCount).toBeCloseTo(18 * 60, -1); // Since 60 FPS

	const primaryVideoTrack = await input.getPrimaryVideoTrack();
	const primaryAudioTrack = await input.getPrimaryAudioTrack();

	assert(primaryVideoTrack);
	assert(primaryAudioTrack);

	// Since they're the highest-bitrate option
	expect(primaryVideoTrack).toBe(videoTracks[4]);
	expect(primaryAudioTrack).toBe(audioTracks[4]);

	expect(await input.getDurationFromMetadata()).not.toBe(null);
});

test.concurrent('Big Buck Bunny, codec parameter strings from master playlist', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(10);

	// Every CODECS attribute lives in the master playlist, so reading the codec parameter string should never force us
	// to fetch any segment source
	const codecParameterStrings = await Promise.all(tracks.map(t => t.getCodecParameterString()));
	expect(codecParameterStrings).toEqual(expect.arrayContaining([
		'mp4a.40.2',
		'mp4a.40.5',
		'avc1.64001f',
		'avc1.42000d',
		'avc1.420016',
		'avc1.640028',
	]));

	expect(sourceCount).toBe(1);
});

test.concurrent('Big Buck Bunny, determining duration from metadata', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	let m3u8Count = 0;
	input.on('source', ({ request, isRoot }) => {
		sourceCount++;
		if (isRoot || request?.path.endsWith('.m3u8')) {
			m3u8Count++;
		}
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(sourceCount).toBe(1);

	const approxDuration = await track.getDurationFromMetadata();
	expect(approxDuration).toBe(634.567);

	// master, playlist and reference playlist, no segments
	expect(sourceCount).toBe(3);
	expect(m3u8Count).toBe(sourceCount);
});

test.concurrent('Single-variant Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const audioTrack = tracks[0]! as InputAudioTrack;
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(await audioTrack.getCodec()).toBe('aac');

	const videoTrack = tracks[1] as InputVideoTrack;
	expect(videoTrack.isVideoTrack()).toBe(true);
	expect(await videoTrack.getCodec()).toBe('avc');
});

test.concurrent('Codec-less (underspecified) master playlist', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/test_001/stream.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(12);

	const codecs = new Set(await Promise.all(tracks.map(x => x.getCodec())));
	expect(codecs.size).toBe(2);
	expect(codecs.has('avc')).toBe(true);
	expect(codecs.has('aac')).toBe(true);
});

test.concurrent('AES and discontinuities', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key

	const sink = new EncodedPacketSink(videoTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);

	let packetCount = 0;

	// Loop over the discontunity boundary
	for await (const packet of sink.packets((await sink.getPacket(35))!)) {
		packetCount++;

		if (packet.timestamp >= 40) {
			break;
		}
	}

	expect(packetCount).toBe(125);
});

test.concurrent('Range requests', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBeCloseTo(0, 1);

	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp).toBeCloseTo(47.24);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBeCloseTo(-0.02133);

	expect(sourceCount).toBe(2);
});

test.concurrent('Custom IV', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/customIV/prog_index.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key
});

test.concurrent('Segments shorter than their EXTINF duration', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes-audio=65000-video=236000.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	// The playlist places this timestamp at the end of one segment, but the media puts it in the next one
	const sink = new EncodedPacketSink(videoTrack);
	expect((await sink.getPacket(24.9))!.timestamp).toBeCloseTo(24.89986666666667);
	expect((await sink.getKeyPacket(24.9))!.timestamp).toBeCloseTo(24.81645555555556);
});

test.concurrent('Out-of-band audio track via ADTS', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	const videoOnlyKeyPacketsFlags = await Promise.all(
		tracks.filter((x): x is InputVideoTrack => x.isVideoTrack()).map(x => x.hasOnlyKeyPackets()),
	);
	expect(videoOnlyKeyPacketsFlags.some(x => x)).toBe(true);

	const audioTrack = tracks.find((x): x is InputAudioTrack => x.isAudioTrack());
	assert(audioTrack);
	expect(await audioTrack.hasOnlyKeyPackets()).toBe(true);

	expect(await audioTrack.getPairableVideoTracks()).toHaveLength(1); // Since the I-frame one isn't pairable
	const videoTrack = (await audioTrack.getPairableVideoTracks())[0]!;
	assert(videoTrack);
	expect(await videoTrack.hasOnlyKeyPackets()).toBe(false);

	let lastTimestamp = -Infinity;
	const sink = new EncodedPacketSink(audioTrack);
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await audioTrack.getFirstTimestamp()).toBeCloseTo(-0.1111);

	expect(await videoTrack.computeDuration()).toBe(29.56);
	expect(await audioTrack.computeDuration()).toBe(29.456895833333334);
});

test.concurrent('MP3 audio only', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getAudioTracks())[0];
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('mp3');

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test.concurrent('Out-of-band audio track via ADTS, ID3 tags stripped', { timeout: 30_000 }, async () => {
	const rootPath = 'https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8';
	let strippedSegmentCount = 0;

	using input = new Input({
		source: new CustomPathedSource(rootPath, async ({ path }) => {
			if (path.endsWith('audio/aac/und/stream.m3u8')) {
				// We decrypt the audio segments ourselves so that we can strip their ID3 tags
				const playlist = new TextDecoder().decode(await fetchBytes(path));
				const withoutKey = playlist.split('\n').filter(x => !x.startsWith('#EXT-X-KEY')).join('\n');
				return new BufferSource(new TextEncoder().encode(withoutKey));
			}

			if (path.endsWith('.aac')) {
				const key = await fetchBytes(new URL('key.bin', path).href);
				const sequenceNumber = Number(path.match(/segment-(\d+)\.aac$/)![1]);

				// Without an IV attribute, the IV is the big-endian media sequence number
				const iv = new Uint8Array(16);
				new DataView(iv.buffer).setUint32(12, sequenceNumber);

				const ciphertextReader = new Reader(new BufferSource(await fetchBytes(path)));
				const stream = createAes128CbcDecryptStream(ciphertextReader, () => ({ key, iv }), () => {});
				const decrypted = new Uint8Array(await new Response(stream).arrayBuffer());

				strippedSegmentCount++;
				return new BufferSource(stripId3V2Tags(decrypted));
			}

			return new UrlSource(path);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	const videoTrack = (await audioTrack.getPairableVideoTracks())[0];
	assert(videoTrack);

	// Without the PRIV timestamps, each segment's media is placed at the segment's playlist timestamp
	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await audioTrack.getFirstTimestamp()).toBe(0);

	const sink = new EncodedPacketSink(audioTrack);
	expect((await sink.getPacket(6.016))!.timestamp).toBe(6.016);
	expect((await sink.getPacket(12.032))!.timestamp).toBe(12.032);
	expect((await sink.getPacket(20))!.timestamp).toBeCloseTo(19.989333, 5);

	let lastTimestamp = -Infinity;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}

	expect(strippedSegmentCount).toBeGreaterThan(0);
});

test.concurrent('MP3 audio only, ID3 tags stripped', { timeout: 30_000 }, async () => {
	const rootPath = 'https://pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8';
	let strippedSegmentCount = 0;

	using input = new Input({
		source: new CustomPathedSource(rootPath, async ({ path }) => {
			if (path.endsWith('.mp3')) {
				strippedSegmentCount++;
				return new BufferSource(stripId3V2Tags(await fetchBytes(path)));
			}

			return new UrlSource(path);
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = (await input.getAudioTracks())[0];
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('mp3');

	// Without the PRIV timestamps, each segment's media is placed at the segment's playlist timestamp
	expect(await audioTrack.getFirstTimestamp()).toBe(0);

	const sink = new EncodedPacketSink(audioTrack);
	expect((await sink.getPacket(10))!.timestamp).toBe(10);
	expect((await sink.getPacket(20))!.timestamp).toBe(20);

	let lastTimestamp = -Infinity;
	let packetCount = 0;
	for await (const packet of sink.packets(undefined, (await sink.getPacket(40))!)) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(1000);

	expect(strippedSegmentCount).toBeGreaterThan(0);
});

test.concurrent('fMP4', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8'),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();

	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getCodedWidth()).toBe(768);
	expect(await videoTrack.getCodedHeight()).toBe(576);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await videoTrack.computeDuration()).toBe(60);

	expect(await audioTrack.getFirstTimestamp()).toBe(-0.021333333333333333);
	expect(await audioTrack.computeDuration()).toBe(60);

	expect(sourceCount).toBe(
		1 // Master
		+ 2 * (1 + 1 + 1 + 1) // For each track: playlist, init, first segment, last segment
		+ (1 + 1 + 1), // Reference track: playlist, init, first segment
	);
});

test.concurrent('Track disposition & metadata', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTracks = await input.getAudioTracks();

	expect(audioTracks).toHaveLength(6);

	expect(await audioTracks[0]!.getLanguageCode()).toBe('en');
	expect(await audioTracks[1]!.getLanguageCode()).toBe('de');
	expect(await audioTracks[2]!.getLanguageCode()).toBe('it');
	expect(await audioTracks[3]!.getLanguageCode()).toBe('fr');
	expect(await audioTracks[4]!.getLanguageCode()).toBe('es');
	expect(await audioTracks[5]!.getLanguageCode()).toBe('en');

	expect((await audioTracks[0]!.getDisposition()).primary).toBe(true);
	expect((await audioTracks[1]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[2]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[3]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[4]!.getDisposition()).primary).toBe(false);
	expect((await audioTracks[5]!.getDisposition()).primary).toBe(false);

	expect((await audioTracks[0]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[1]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[2]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[3]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[4]!.getDisposition()).default).toBe(true);
	expect((await audioTracks[5]!.getDisposition()).default).toBe(false);

	expect(await audioTracks[0]!.getName()).toBe('stream_5');
	expect(await audioTracks[1]!.getName()).toBe('stream_4');
	expect(await audioTracks[2]!.getName()).toBe('stream_8');
	expect(await audioTracks[3]!.getName()).toBe('stream_7');
	expect(await audioTracks[4]!.getName()).toBe('stream_9');
	expect(await audioTracks[5]!.getName()).toBe('stream_6');
});

test.concurrent('fMP4 Bitmovin', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s-fmp4/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8', {
			requestInit: {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
					'Accept': '*/*',
					'Accept-Language': 'en-US,en;q=0.9',
					'Origin': 'https://bitmovin.com',
					'Referer': 'https://bitmovin.com/',
				},
			},
		}),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
	const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());
	expect(videoTracks).toHaveLength(6);
	expect(audioTracks).toHaveLength(1);

	const videoDisplayDims = await Promise.all(
		videoTracks.map(async t => ({ w: await t.getDisplayWidth(), h: await t.getDisplayHeight() })),
	);
	expect(videoDisplayDims.some(d => d.w === 320 && d.h === 180)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 480 && d.h === 270)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 640 && d.h === 360)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 960 && d.h === 540)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 1280 && d.h === 720)).toBe(true);
	expect(videoDisplayDims.some(d => d.w === 1920 && d.h === 1080)).toBe(true);

	const videoTrack = videoTracks[0];
	assert(videoTrack);

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await videoTrack.computeDuration()).toBe(210.28);

	const audioTrack = audioTracks[0];
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(-0.08);

	expect(sourceCount).toBe(5 + 3); // 3 for the reference track
});

test.concurrent('Single-value PDT', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/aviion/manifest.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect((await Promise.all(tracks.map(x => x.isRelativeToUnixEpoch()))).every(x => x)).toBe(true);
	expect((await Promise.all(tracks.map(x => x.hasUnixTimeMapping()))).every(x => x)).toBe(true);

	const track = tracks[0]!;
	const firstTimestamp = await track.getFirstTimestamp();
	expect(firstTimestamp).toBe(Date.parse('2013-05-08T17:40:50Z') / 1000);

	expect(await track.getUnixTimeForTimestamp(firstTimestamp)).toBe(firstTimestamp);

	const endTimestamp = await track.computeDuration();
	expect(endTimestamp).toBe(firstTimestamp + 50);

	const endDateTime = new Date(endTimestamp * 1000).toISOString();
	expect(endDateTime).toBe('2013-05-08T17:41:40.000Z');

	const sink = new EncodedPacketSink(track);
	const firstPacket = await sink.getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(firstTimestamp);
	expect(firstPacket.sequenceNumber).toBe(752); // Make sure it's not huge

	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp).toBeCloseTo(firstTimestamp + 50, 1);
	expect(lastPacket.sequenceNumber).toBeLessThan(1e8 * 60);
});

test.concurrent('Duplicate PDT', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/artbeats/manifest.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const offsetFromVideo = -0.033;
	expect(await videoTrack.getFirstTimestamp()).toBe(Date.parse('2013-06-17T18:32:00Z') / 1000);
	expect(await audioTrack.getFirstTimestamp()).toBe(Date.parse('2013-06-17T18:32:00Z') / 1000 + offsetFromVideo);

	// Ensure the timestamps are monotonically increasing
	const sink = new EncodedPacketSink(audioTrack);
	let lastTimestamp = -Infinity;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}
});

test.concurrent('PDT with large gaps', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/boxee/playlist.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const sink = new EncodedPacketSink(audioTrack);
	const packet = await sink.getPacket(Date.parse('2012-12-06T19:10:03+00:00') / 1000 + 6);
	assert(packet);

	const nextPacket = await sink.getNextPacket(packet);
	assert(nextPacket);

	expect(nextPacket.timestamp - packet.timestamp).toBeGreaterThan(59);
});

test.concurrent('PDT with bad values', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/progdatime/playlist2.m3u8'),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.isRelativeToUnixEpoch()).toBe(false);
});

test.concurrent('Single-value PDT with unix offsets disabled', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/aviion/manifest.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			hls: {
				offsetTimestampsByDateTime: false,
			},
		},
	});

	const tracks = await input.getTracks();
	expect((await Promise.all(tracks.map(x => x.isRelativeToUnixEpoch()))).every(x => x)).toBe(false);
	expect((await Promise.all(tracks.map(x => x.hasUnixTimeMapping()))).every(x => x)).toBe(true);

	const track = tracks[0]!;
	const firstTimestamp = await track.getFirstTimestamp();
	expect(firstTimestamp).toBe(0);

	const endTimestamp = await track.computeDuration();
	expect(endTimestamp).toBe(firstTimestamp + 50);

	const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
	assert(firstPacket);
	expect(firstPacket.timestamp).toBe(firstTimestamp); // Kinda obvious check tbh

	const unixStartTime = await track.getUnixTimeForTimestamp(firstTimestamp);
	expect(unixStartTime).toBe(Date.parse('2013-05-08T17:40:50Z') / 1000);

	const unixEndTime = await track.getUnixTimeForTimestamp(endTimestamp);
	expect(unixEndTime).toBe(Date.parse('2013-05-08T17:41:40Z') / 1000);

	const unixTimeBeforeStart = await track.getUnixTimeForTimestamp(firstTimestamp - 10);
	expect(unixTimeBeforeStart).toBe(Date.parse('2013-05-08T17:40:40Z') / 1000);

	const unixTimeAfterEnd = await track.getUnixTimeForTimestamp(endTimestamp + 10);
	expect(unixTimeAfterEnd).toBe(Date.parse('2013-05-08T17:41:50Z') / 1000);

	const timestampDt = 0.001;
	const unixTimeDt = (await track.getUnixTimeForTimestamp(firstTimestamp + 0.001))! - unixStartTime!;
	expect(unixTimeDt).toBeCloseTo(timestampDt);
});

test.concurrent('Alternative audio only', { timeout: 15_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/alt-audio-no-video/sintel/playlist.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	expect(tracks[0]!.type).toBe('audio');
	expect(await tracks[0]!.getLanguageCode()).toBe('en');
	expect(await tracks[0]!.getName()).toBe('English');

	expect(tracks[1]!.type).toBe('audio');
	expect(await tracks[1]!.getLanguageCode()).toBe('dubbing');
	expect(await tracks[1]!.getName()).toBe('Dubbing');
});

test.concurrent('Advanced Apple HLS', { timeout: 30_000 }, async () => {
	using input = new Input({
		source: new UrlSource('https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter((x): x is InputVideoTrack => x.isVideoTrack());
	const audioTracks = tracks.filter((x): x is InputAudioTrack => x.isAudioTrack());

	expect(audioTracks).toHaveLength(3);
	expect(videoTracks).toHaveLength(28);

	const snapshotVideoTrack = async (t: InputVideoTrack) => ({
		codec: await t.getCodec(),
		displayWidth: await t.getDisplayWidth(),
		displayHeight: await t.getDisplayHeight(),
		bitrate: await t.getBitrate(),
		hasOnlyKeyPackets: await t.hasOnlyKeyPackets(),
		codecParameterString: await t.getCodecParameterString(),
	});
	const snapshotAudioTrack = async (t: InputAudioTrack) => ({
		codec: await t.getCodec(),
		name: await t.getName(),
		languageCode: await t.getLanguageCode(),
		codecParameterString: await t.getCodecParameterString(),
	});

	const audioSnapshots = await Promise.all(audioTracks.map(snapshotAudioTrack));
	const videoSnapshots = await Promise.all(videoTracks.map(snapshotVideoTrack));

	expect(audioSnapshots[0]).toMatchObject({ codec: 'aac', name: 'English', languageCode: 'en', codecParameterString: 'mp4a.40.2' });
	expect(audioSnapshots[1]).toMatchObject({ codec: 'ac3', name: 'English', languageCode: 'en', codecParameterString: 'ac-3' });
	expect(audioSnapshots[2]).toMatchObject({ codec: 'eac3', name: 'English', languageCode: 'en', codecParameterString: 'ec-3' });

	expect(await audioTracks[0]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[1]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[2]!.getPairableVideoTracks()).toHaveLength(18);

	// I-FRAME AVC

	expect(videoSnapshots[0]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 1015727, hasOnlyKeyPackets: true, codecParameterString: 'avc1.640028' });
	expect(videoSnapshots[1]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 760174, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[2]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 520162, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[3]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 186651, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[4]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 95410, hasOnlyKeyPackets: true, codecParameterString: 'avc1.64001f' });

	for (let i = 0; i <= 4; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.some(x => x.canBePairedWith(videoTrack))).toBe(false);
	}

	// AVC

	expect(videoSnapshots[5]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2746096, hasOnlyKeyPackets: false, codecParameterString: 'avc1.640020' });
	expect(videoSnapshots[6]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 10095767, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64002a' });
	expect(videoSnapshots[7]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7540836, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64002a' });
	expect(videoSnapshots[8]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5644219, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64002a' });
	expect(videoSnapshots[9]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3833756, hasOnlyKeyPackets: false, codecParameterString: 'avc1.640020' });
	expect(videoSnapshots[10]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1698402, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[11]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1240204, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[12]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 805319, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });
	expect(videoSnapshots[13]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 561903, hasOnlyKeyPackets: false, codecParameterString: 'avc1.64001f' });

	for (let i = 5; i <= 13; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.every(x => x.canBePairedWith(videoTrack))).toBe(true);
	}

	// I-FRAME HEVC

	expect(videoSnapshots[14]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 328352, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[15]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 226274, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[16]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 159037, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[17]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 92800, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[18]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 51760, hasOnlyKeyPackets: true, codecParameterString: 'hvc1.2.4.L123.B0' });

	for (let i = 14; i <= 18; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.some(x => x.canBePairedWith(videoTrack))).toBe(false);
	}

	// HEVC

	expect(videoSnapshots[19]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2386827, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[20]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6886727, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[21]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5650398, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[22]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4302269, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[23]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2987200, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[24]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1448754, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[25]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 1124269, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[26]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 771426, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });
	expect(videoSnapshots[27]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 563212, hasOnlyKeyPackets: false, codecParameterString: 'hvc1.2.4.L123.B0' });

	for (let i = 19; i <= 27; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.every(x => x.canBePairedWith(videoTrack))).toBe(true);
	}
});

test.concurrent('Live HLS', { timeout: 30_000 }, async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	using input = new Input({
		source: new UrlSource('https://stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await videoTrack.isLive()).toBe(true);
	expect(await audioTrack.isLive()).toBe(true);

	const videoRefreshInterval = await videoTrack.getLiveRefreshInterval();
	const audioRefreshInterval = await audioTrack.getLiveRefreshInterval();
	expect(videoRefreshInterval).toBe(2);
	expect(audioRefreshInterval).toBe(2);

	const durationFailed = Promise.race([
		videoTrack.computeDuration(),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	await expect(durationFailed).rejects.toThrow('Baby you make me smile');

	const duration = await Promise.race([
		videoTrack.computeDuration({ skipLiveWait: true }),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	expect(duration).toBeGreaterThan((Date.now() / 1000) - 3600);

	const sink = new EncodedPacketSink(videoTrack);

	let currentLastPacket = await sink.getPacket(Infinity, { skipLiveWait: true });
	assert(currentLastPacket);

	// Actually find the last packet in decode order
	while (true) {
		const nextKnownPacket = await sink.getNextPacket(currentLastPacket, { skipLiveWait: true });
		if (!nextKnownPacket) {
			break;
		}

		currentLastPacket = nextKnownPacket;
	}

	// This tests waiting for the live stream to advance
	const nextPacket = await sink.getNextPacket(currentLastPacket);
	assert(nextPacket);
	expect(nextPacket.sequenceNumber).toBeGreaterThan(currentLastPacket.sequenceNumber);

	const metadataDurationFailed = Promise.race([
		videoTrack.getDurationFromMetadata(),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	await expect(metadataDurationFailed).rejects.toThrow('Baby you make me smile');

	const metadataDuration = await Promise.race([
		videoTrack.getDurationFromMetadata({ skipLiveWait: true }),
		rejectAfter(2000, 'Baby you make me smile'),
	]);
	expect(metadataDuration).toBeGreaterThan((Date.now() / 1000) - 3600);

	// The server doesn't answer with range requests but since it's HLS we suppress that warning
	expect(consoleSpy).not.toHaveBeenCalled();
});

test.concurrent('Mp4InputFormat recognises a CMAF segment that starts with sidx', async () => {
	const bytes = new Uint8Array(12);
	new DataView(bytes.buffer).setUint32(0, 60); // box size
	bytes.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	expect(await input.canRead()).toBe(true);
	expect(await input.getFormat()).toBe(MP4);
});

test.concurrent('#EXT-X-I-FRAME-STREAM-INF tags are parsed properly', async () => {
	const text = `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=256000,CODECS="avc1.4D401E",RESOLUTION=480x270,URI="7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	expect(await tracks[0]!.hasOnlyKeyPackets()).toBe(true);
});

test.concurrent('#EXT-X-I-FRAME-STREAM-INF tags without BANDWIDTH attribute are rejected', async () => {
	const text = `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:CODECS="avc1.4D401E",RESOLUTION=480x270,URI="7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	await expect(input.getTracks()).rejects.toThrow('BANDWIDTH');
});

test.concurrent('#EXT-X-STREAM-INF tags without BANDWIDTH attribute are rejected', async () => {
	const text = `#EXTM3U
#EXT-X-STREAM-INF:CODECS="avc1.4D401E",RESOLUTION=480x270
7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	await expect(input.getTracks()).rejects.toThrow('BANDWIDTH');
});

test.concurrent('URI-less video and audio renditions inherit variant bandwidth', async () => {
	const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="video",NAME="Source",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3214134,AVERAGE-BANDWIDTH=2800000,CODECS="avc1.64001F,mp4a.40.2",VIDEO="video",AUDIO="audio"
variant.m3u8
`;

	using input = new Input({
		formats: HLS_FORMATS,
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			assert(path === 'master.m3u8');
			return new BufferSource(new TextEncoder().encode(text));
		}),
	});

	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();
	expect(videoTracks).toHaveLength(1);
	expect(audioTracks).toHaveLength(1);

	for (const track of [...videoTracks, ...audioTracks]) {
		expect(await track.getBitrate()).toBe(3214134);
		expect(await track.getAverageBitrate()).toBe(2800000);
	}
});

test.concurrent('Missing media tag codec', async () => {
	using input = new Input({
		source: new UrlSource('https://playertest.longtailvideo.com/adaptive/elephants_dream_v4/index.m3u8'),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(7);

	expect(tracks.filter(x => x.type === 'video')).toHaveLength(4);
	expect(tracks.filter(x => x.type === 'audio')).toHaveLength(3);

	expect([...new Set(await Promise.all(tracks.map(x => x.getCodec())))]).toEqual(['aac', 'avc']);
});

test.concurrent('fLaC in the CODECS attribute of a variant', async () => {
	const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,fLaC"
variant.m3u8
`;

	using input = new Input({
		formats: HLS_FORMATS,
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			assert(path === 'master.m3u8');
			return new BufferSource(new TextEncoder().encode(text));
		}),
	});

	const audioTracks = await input.getAudioTracks();
	expect(audioTracks).toHaveLength(1);
	expect(await audioTracks[0]!.getCodec()).toBe('flac');
});

test.concurrent('Circular/recursive HLS is forbidden', async () => {
	const text = `#EXTM3U
#EXT-X-VERSION=3
#EXT-X-TARGETDURATION=10

#EXTINF:5,
root.m3u8

#EXT-X-ENDLIST
`;

	const input = new Input({
		source: new CustomPathedSource(
			'root.m3u8',
			({ path }) => {
				assert(path === 'root.m3u8');
				return new BufferSource(new TextEncoder().encode(text));
			},
		),
		formats: HLS_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow('unsupported');
});

test.concurrent('Widevine encryption (SAMPLE-AES-CTR) fails without keys', async () => {
	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	await expect(sink.getPacket(Infinity)).rejects.toThrow();
});

test.concurrent('Widevine encryption (SAMPLE-AES-CTR) succeeds with string keys', async () => {
	const keyMap = new Map([
		['4d97930a3d7b55fa81d0028653f5e499', '429ec76475e7a952d224d8ef867f12b6'],
		['d21373c0b8ab5ba9954742bcdfb5f48b', '150a6c7d7dee6a91b74dccfce5b31928'],
		['6f1729072b4a5cd288c916e11846b89e', 'a84b4bd66901874556093454c075e2c6'],
		['800aacaa522958ae888062b5695db6bf', '775dbf7289c4cc5847becd571f536ff2'],
		['67b30c86756f57c5a0a38a23ac8c9178', 'efa2878c2ccf6dd47ab349fcf90e6259'],
	]);

	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: ({ keyId, psshBoxes }) => {
					expect(psshBoxes).toHaveLength(1);
					expect(psshBoxes[0]!.systemId).toBe('edef8ba979d64acea3c827dcd51d21ed');
					expect(psshBoxes[0]!.keyIds).toBeNull();
					expect(psshBoxes[0]!.data).toEqual(new Uint8Array([
						34, 22, 115, 104, 97, 107, 97, 95,
						99, 101, 99, 50, 102, 54, 52, 97,
						97, 55, 56, 57, 48, 97, 49, 49,
						72, 227, 220, 149, 155, 6,
					]));

					const key = keyMap.get(keyId);
					assert(key);

					return key;
				},
			},
		},
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp + lastPacket.duration).toBe(60);
});

test.concurrent('Widevine encryption (SAMPLE-AES-CTR) succeeds with buffer keys', async () => {
	const keyMap = new Map([
		['4d97930a3d7b55fa81d0028653f5e499', hexStringToBytes('429ec76475e7a952d224d8ef867f12b6')],
		['d21373c0b8ab5ba9954742bcdfb5f48b', hexStringToBytes('150a6c7d7dee6a91b74dccfce5b31928')],
		['6f1729072b4a5cd288c916e11846b89e', hexStringToBytes('a84b4bd66901874556093454c075e2c6')],
		['800aacaa522958ae888062b5695db6bf', hexStringToBytes('775dbf7289c4cc5847becd571f536ff2')],
		['67b30c86756f57c5a0a38a23ac8c9178', hexStringToBytes('efa2878c2ccf6dd47ab349fcf90e6259')],
	]);

	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				resolveKeyId: ({ keyId }) => {
					const key = keyMap.get(keyId);
					assert(key);

					return key;
				},
			},
		},
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp + lastPacket.duration).toBe(60);
});

test.concurrent('Widevine HLS passes #EXT-X-KEY PSSH boxes to key resolver', async () => {
	const keyMap = new Map([
		['4d97930a3d7b55fa81d0028653f5e499', '429ec76475e7a952d224d8ef867f12b6'],
		['d21373c0b8ab5ba9954742bcdfb5f48b', '150a6c7d7dee6a91b74dccfce5b31928'],
		['6f1729072b4a5cd288c916e11846b89e', 'a84b4bd66901874556093454c075e2c6'],
		['800aacaa522958ae888062b5695db6bf', '775dbf7289c4cc5847becd571f536ff2'],
		['67b30c86756f57c5a0a38a23ac8c9178', 'efa2878c2ccf6dd47ab349fcf90e6259'],
	]);

	using input = new Input({
		source: new UrlSource('https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8'),
		formats: ALL_FORMATS,
		formatOptions: {
			isobmff: {
				_suppressPsshParsing: true,
				resolveKeyId: ({ keyId, psshBoxes }) => {
					expect(psshBoxes).toHaveLength(1);
					expect(psshBoxes[0]!.systemId).toBe('edef8ba979d64acea3c827dcd51d21ed');
					expect(psshBoxes[0]!.keyIds).toBeNull();
					expect(psshBoxes[0]!.data).toEqual(new Uint8Array([
						34, 22, 115, 104, 97, 107, 97, 95,
						99, 101, 99, 50, 102, 54, 52, 97,
						97, 55, 56, 57, 48, 97, 49, 49,
						72, 227, 220, 149, 155, 6,
					]));

					const key = keyMap.get(keyId);
					assert(key);

					return key;
				},
			},
		},
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);
	const lastPacket = await sink.getPacket(Infinity);
	assert(lastPacket);
	expect(lastPacket.timestamp + lastPacket.duration).toBe(60);
});

test.concurrent('SourceRequest.isRoot', async () => {
	using input = new Input({
		source: new CustomPathedSource(
			'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
			({ path, isRoot }) => {
				if (isRoot) {
					expect(path).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
				}

				return new UrlSource(path);
			},
		),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	await videoTrack.computeDuration();
});

test.concurrent('#EXT-X-DEFINE NAME and VALUE variables are applied', async () => {
	const text = `#EXTM3U
#EXT-X-DEFINE:NAME="prefix",VALUE="Main"
#EXT-X-DEFINE:NAME="trackName",VALUE="{$prefix} Track"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f",NAME="{$trackName}",URI="video.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(1);
	expect(await tracks[0]!.getName()).toBe('Main Track');
});

test.concurrent('#EXT-X-DEFINE QUERYPARAM variables can be IMPORTed into media playlists', async () => {
	const rootPath = 'https://example.com/master.m3u8'
		+ '?mediaPlaylistPath=variant%2Em3u8&segmentPath=0%2Ets';
	const expectedMediaPlaylistPath = 'https://example.com/variant.m3u8';
	const expectedSegmentPath = 'https://example.com/0.ts';
	const multivariantPlaylist = `#EXTM3U
#EXT-X-DEFINE:QUERYPARAM="mediaPlaylistPath"
#EXT-X-DEFINE:QUERYPARAM="segmentPath"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"
{$mediaPlaylistPath}
`;
	const mediaPlaylist = `#EXTM3U
#EXT-X-DEFINE:IMPORT="segmentPath"
#EXT-X-TARGETDURATION:10
#EXTINF:10,
{$segmentPath}
#EXT-X-ENDLIST
`;
	const requestedPaths: string[] = [];

	using input = new Input({
		source: new CustomPathedSource(
			rootPath,
			({ path }) => {
				requestedPaths.push(path);

				if (path === rootPath) {
					return new BufferSource(new TextEncoder().encode(multivariantPlaylist));
				}
				if (path === expectedMediaPlaylistPath) {
					return new BufferSource(new TextEncoder().encode(mediaPlaylist));
				}
				if (path === expectedSegmentPath) {
					return new FilePathSource('./test/public/0.ts');
				}

				throw new Error(`Unexpected source path "${path}".`);
			},
		),
		formats: HLS_FORMATS,
	});

	// Trigger media loading so the substituted playlist and segment paths are added to requestedPaths.
	await input.getFirstTimestamp();

	expect(requestedPaths).toContain(expectedMediaPlaylistPath);
	expect(requestedPaths).toContain(expectedSegmentPath);
});

test.concurrent('Invalid #EXT-X-DEFINE tags are rejected', async () => {
	const cases = [
		{
			tag: '#EXT-X-DEFINE:VALUE="value"',
			error: 'exactly one of NAME, IMPORT, or QUERYPARAM must be present',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="name",IMPORT="name",VALUE="value"',
			error: 'exactly one of NAME, IMPORT, or QUERYPARAM must be present',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="name"',
			error: 'NAME requires VALUE',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="invalid name",VALUE="value"',
			error: 'invalid variable name',
		},
		{
			tag: '#EXT-X-DEFINE:IMPORT="missing"',
			error: 'cannot import undefined variable',
		},
		{
			tag: '#EXT-X-DEFINE:QUERYPARAM="missing"',
			error: 'query parameter "missing" is missing',
		},
		{
			tag: '#EXT-X-DEFINE:NAME="name",VALUE="value"\n'
				+ '#EXT-X-DEFINE:NAME="name",VALUE="other"',
			error: 'variable "name" is already defined',
		},
		{
			tag: '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f",URI="{$missing}"',
			error: 'variable "missing" is referenced before being defined',
		},
	];

	for (const { tag, error } of cases) {
		using input = new Input({
			source: new CustomPathedSource(
				'https://example.com/master.m3u8',
				() => new BufferSource(new TextEncoder().encode(`#EXTM3U\n${tag}\n`)),
			),
			formats: HLS_FORMATS,
		});

		await expect(input.getTracks()).rejects.toThrow(error);
	}
});

test.concurrent('Key packets of segments starting with a delta frame', async () => {
	const text = `#EXTM3U
#EXT-X-TARGETDURATION:100
#EXTINF:100,
a.ts
#EXTINF:100,
b.ts
#EXT-X-ENDLIST
`;

	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			if (path === 'master.m3u8') {
				return new BufferSource(new TextEncoder().encode(text));
			}

			return new FilePathSource('./test/public/no-initial-keyframe.ts');
		}),
		formats: HLS_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const sink = new EncodedPacketSink(videoTrack);

	const types: string[] = [];
	let packet = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
	while (packet) {
		types.push(packet.type);
		packet = await sink.getNextKeyPacket(packet, { verifyKeyPackets: true });
	}

	expect(types.length).toBeGreaterThan(0);
	expect(types.every(type => type === 'key')).toBe(true);
});

const fetchBytes = async (url: string) => {
	const response = await fetch(url);
	return new Uint8Array(await response.arrayBuffer());
};

const stripId3V2Tags = (bytes: Uint8Array) => {
	// Make sure there's actually something to strip, otherwise the test wouldn't test anything
	expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ID3');

	while (new TextDecoder().decode(bytes.subarray(0, 3)) === 'ID3') {
		const flags = bytes[5]!;
		const size = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!; // Synchsafe
		const hasFooter = !!(flags & 0x10);

		bytes = bytes.subarray(10 + size + (hasFooter ? 10 : 0));
	}

	return bytes;
};

test.concurrent('Undefined media groups', async () => {
	using input = createHlsInput({
		'master.m3u8': `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",VIDEO="video",AUDIO="audio"
variant.m3u8
`,
		'variant.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5,
0.ts
#EXT-X-ENDLIST
`,
	});

	// The groups don't exist, so both tracks come from the variant stream itself
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(videoTrack.canBePairedWith(audioTrack)).toBe(true);
	expect(await videoTrack.getBitrate()).toBe(1000000);
	expect(await audioTrack.getBitrate()).toBe(1000000);
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await videoTrack.getCodedWidth()).toBeGreaterThan(0);
});

test.concurrent('Channel count of object-based audio', async () => {
	using input = createHlsInput({
		'master.m3u8': `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="atmos",NAME="English",DEFAULT=YES,CHANNELS="16/JOC",URI="atmos.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="ec-3",AUDIO="atmos"
atmos.m3u8
`,
		'atmos.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
eac3.ts
#EXT-X-ENDLIST
`,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	// "16/JOC" doesn't describe the channels the media decodes to
	expect(await audioTrack.getNumberOfChannels()).toBe(6);
	expect((await audioTrack.getDecoderConfig())!.numberOfChannels).toBe(6);
});

test.concurrent('Master playlist with only I-frame variants', async () => {
	using input = createHlsInput({
		'master.m3u8': `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,CODECS="hvc1.1.6.L93.B0",URI="media.m3u8"
`,
		'media.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-I-FRAMES-ONLY
#EXTINF:4,
entry24-segment3.ts
#EXT-X-ENDLIST
`,
	});
	const track = (await input.getPrimaryVideoTrack())!;
	expect(await track.hasOnlyKeyPackets()).toBe(true);

	// There's no regular variant to align the timestamps with, so the I-frame variant has to do
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect(packet!.timestamp).toBe(0);
});

test.concurrent('Playlists without segments', { timeout: 10_000 }, async () => {
	using input = createHlsInput({
		'master.m3u8': `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"
ended.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f"
live.m3u8
`,
		'ended.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-ENDLIST
`,
		'live.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:2
`,
	});
	const [endedTrack, liveTrack] = await input.getVideoTracks();
	assert(endedTrack);
	assert(liveTrack);

	// Neither an ended playlist nor skipLiveWait warrant waiting for the playlist to be reloaded
	const start = performance.now();
	expect(await endedTrack.getDurationFromMetadata()).toBe(null);
	expect(await endedTrack.getDurationFromMetadata()).toBe(null);
	expect(await endedTrack.getUnixTimeForTimestamp(0)).toBe(null);
	expect(await liveTrack.getDurationFromMetadata({ skipLiveWait: true })).toBe(null);
	expect(await liveTrack.getDurationFromMetadata({ skipLiveWait: true })).toBe(null);
	expect(performance.now() - start).toBeLessThan(1000);
});

test.concurrent('Renditions with different codecs in one group', async () => {
	using input = createHlsInput({
		'master.m3u8': `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="MP3",URI="mp3.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="AC-3",URI="ac3.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="ac-3,mp4a.40.34",AUDIO="audio"
mp3.m3u8
`,
		'mp3.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
mp3.ts
#EXT-X-ENDLIST
`,
		'ac3.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
ac3.ts
#EXT-X-ENDLIST
`,
	});

	const audioTracks = await input.getAudioTracks();
	expect(await Promise.all(audioTracks.map(x => x.getName()))).toEqual(['MP3', 'AC-3']);
	expect(await Promise.all(audioTracks.map(x => x.getCodec()))).toEqual(['mp3', 'ac3']);
});

test.concurrent('Renditions with different codec strings of the same codec in one group', async () => {
	using input = new Input({
		source: new CustomPathedSource('master.m3u8', ({ path }) => {
			// Only the master playlist may be read, since the codec is clear without looking at any media
			assert(path === 'master.m3u8');

			return new BufferSource(new TextEncoder().encode(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="es",NAME="Spanish",URI="es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2,mp4a.40.5",AUDIO="audio"
video.m3u8
`));
		}),
		formats: HLS_FORMATS,
	});

	const audioTracks = await input.getAudioTracks();
	expect(await Promise.all(audioTracks.map(x => x.getCodec()))).toEqual(['aac', 'aac']);
});

test.concurrent('Variant listing several video codecs without renditions', async () => {
	using input = createHlsInput({
		'master.m3u8': `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,hvc1.1.6.L93.B0"
media.m3u8
`,
		'media.m3u8': `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
hevc.ts
#EXT-X-ENDLIST
`,
	});

	const videoTracks = await input.getVideoTracks();
	expect(await Promise.all(videoTracks.map(x => x.getCodec()))).toEqual(['hevc']);
});

const createHlsInput = (playlists: Record<string, string>) => new Input({
	source: new CustomPathedSource('master.m3u8', ({ path }) => {
		const playlist = playlists[path];
		if (playlist !== undefined) {
			return new BufferSource(new TextEncoder().encode(playlist));
		}

		return new FilePathSource(`./test/public/${path}`);
	}),
	formats: HLS_FORMATS,
});

test.concurrent('Sparse muxed fMP4 segments with large timestamps', async () => {
	const files = await writeHls({
		segmentFormat: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		mediaTimestampBase: 50_000,
	}, async (addVideo, addAudio) => {
		// The last segment holds only audio
		for (let i = 0; i < 8; i++) {
			await addVideo(0.5 * i, i % 4 === 0);
		}
		for (let i = 0; i < 8; i++) {
			await addAudio(2 + 0.5 * i);
		}
	});

	using input = createInputFromFiles(files, 'master.m3u8');
	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await collectTimestamps(new EncodedPacketSink(videoTrack))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
	expect(await collectTimestamps(new EncodedPacketSink(audioTrack))).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
});

test.concurrent('Packet lookup before the first segment', async () => {
	const files = await writeHls({
		segmentFormat: new MpegTsOutputFormat(),
	}, async (addVideo, addAudio) => {
		// Video is the reference and lands at 0, so audio starts before the audio playlist's first segment
		for (let i = 0; i < 8; i++) {
			await addVideo(1 + 0.5 * i, i % 4 === 0);
			await addAudio(0.5 + 0.5 * i);
		}
	}, true);

	using input = createInputFromFiles(files, 'master.m3u8');
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getFirstTimestamp()).toBe(-0.5);

	const sink = new EncodedPacketSink(audioTrack);
	expect((await sink.getPacket(-0.25))?.timestamp).toBe(-0.5);
	expect((await sink.getKeyPacket(-0.25))?.timestamp).toBe(-0.5);
	expect(await sink.getPacket(-0.75)).toBe(null);
});

test.concurrent('EXTINF and EXT-X-BYTERANGE before EXT-X-MAP', async () => {
	const files = await writeHls({
		segmentFormat: new CmafOutputFormat(),
		singleFilePerPlaylist: true,
	}, async (addVideo, addAudio) => {
		for (let i = 0; i < 8; i++) {
			await addVideo(0.5 * i, i % 4 === 0);
			await addAudio(0.5 * i);
		}
	});

	const playlist = new TextDecoder().decode(files.get('playlist-1.m3u8'));
	const mapLine = playlist.split('\n').find(x => x.startsWith('#EXT-X-MAP:'));
	assert(mapLine);

	// Same playlist, but with the media segment tags of the first segment placed before the EXT-X-MAP tag
	files.set('reordered.m3u8', new TextEncoder().encode(
		playlist.replace(`${mapLine}\n`, '').replace(/(#EXT-X-BYTERANGE:.*\n)/, `$1${mapLine}\n`),
	));

	using input = createInputFromFiles(files, 'reordered.m3u8');
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(await collectTimestamps(new EncodedPacketSink(videoTrack))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
});

const createInputFromFiles = (files: Map<string, Uint8Array>, rootPath: string) => {
	return new Input({
		source: new CustomPathedSource(rootPath, ({ path }) => {
			const bytes = files.get(path);
			assert(bytes);

			return new BufferSource(bytes);
		}),
		formats: ALL_FORMATS,
	});
};

test.concurrent('Live playlist moving past all known segments', { timeout: 10_000 }, async () => {
	const files = await writeHls({
		segmentFormat: new MpegTsOutputFormat(),
		targetDuration: 1,
	}, async (addVideo) => {
		for (let i = 0; i < 24; i++) {
			await addVideo(0.5 * i, i % 2 === 0);
		}
	});

	// Segment n holds the media from n to n + 1. The playlist first lists segments 0 to 2, then gets reloaded only
	// after segments 3 to 7 have already dropped out of it again, and then stalls.
	let playlistRequestCount = 0;
	using input = new Input({
		source: new CustomPathedSource('live.m3u8', ({ path }) => {
			if (path !== 'live.m3u8') {
				const bytes = files.get(path);
				assert(bytes);

				return new BufferSource(bytes);
			}

			const firstSequenceNumber = playlistRequestCount++ === 0 ? 0 : 8;
			let playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${firstSequenceNumber}\n`;
			for (let i = firstSequenceNumber; i < firstSequenceNumber + 3; i++) {
				playlist += `#EXTINF:1,\nsegment-1-${i + 1}.ts\n`;
			}

			return new BufferSource(new TextEncoder().encode(playlist));
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	const sink = new EncodedPacketSink(videoTrack);

	const lastKnownPacket = await sink.getPacket(2.5);
	assert(lastKnownPacket);
	expect((await sink.getNextPacket(lastKnownPacket))?.timestamp).toBe(8);
	expect(playlistRequestCount).toBe(2);

	const packet = await Promise.race([sink.getPacket(9.25), rejectAfter(3000) as Promise<never>]);
	expect(packet?.timestamp).toBe(9);
});

test.concurrent('Live playlist reload with init data in the first segment', { timeout: 10_000 }, async () => {
	const files = await writeHls({
		segmentFormat: new CmafOutputFormat(),
		targetDuration: 1,
	}, async (addVideo) => {
		for (let i = 0; i < 6; i++) {
			await addVideo(0.5 * i, i % 2 === 0);
		}
	});

	// No EXT-X-MAP; the first segment carries the init data and later segments rely on it
	const initBytes = files.get('init-1.m4s');
	const firstSegmentBytes = files.get('segment-1-1.m4s');
	assert(initBytes);
	assert(firstSegmentBytes);
	files.set('first.m4s', new Uint8Array([...initBytes, ...firstSegmentBytes]));

	// The live playlist starts out with a single segment, the rest is only seen after a reload
	let playlistRequestCount = 0;
	using input = new Input({
		source: new CustomPathedSource('live.m3u8', ({ path }) => {
			if (path !== 'live.m3u8') {
				const bytes = files.get(path);
				assert(bytes);

				return new BufferSource(bytes);
			}

			let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.m4s\n';
			if (playlistRequestCount++ > 0) {
				playlist += '#EXTINF:1,\nsegment-1-2.m4s\n#EXTINF:1,\nsegment-1-3.m4s\n#EXT-X-ENDLIST\n';
			}

			return new BufferSource(new TextEncoder().encode(playlist));
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(await collectTimestamps(new EncodedPacketSink(videoTrack))).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
	expect(playlistRequestCount).toBe(2);
});

test.concurrent('Live playlist reload past a discontinuity that dropped out', { timeout: 10_000 }, async () => {
	const addPackets = async (
		addVideo: (timestamp: number, isKey: boolean) => Promise<void>,
		addAudio: (timestamp: number) => Promise<void>,
	) => {
		for (let i = 0; i < 4; i++) {
			await addVideo(0.5 * i, i % 2 === 0);
			await addAudio(0.5 * i);
		}
	};

	const files48k = await writeHls({
		segmentFormat: new MpegTsOutputFormat(),
		targetDuration: 1,
	}, addPackets);
	// Same streams, but the audio is now 24 kHz
	const files24k = await writeHls({
		segmentFormat: new MpegTsOutputFormat(),
		targetDuration: 1,
	}, addPackets, false, {
		sampleRate: 24000,
		description: new Uint8Array([0x13, 0x08]),
	});

	// The reload jumps past a discontinuity whose segments we never saw, after which the audio is 24 kHz
	let playlistRequestCount = 0;
	using input = new Input({
		source: new CustomPathedSource('live.m3u8', ({ path }) => {
			if (path !== 'live.m3u8') {
				const bytes = path.startsWith('b-') ? files24k.get(path.slice(2)) : files48k.get(path);
				assert(bytes);

				return new BufferSource(bytes);
			}

			const playlist = playlistRequestCount++ === 0
				? '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n'
				+ '#EXTINF:1,\nsegment-1-1.ts\n#EXTINF:1,\nsegment-1-2.ts\n'
				: '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-DISCONTINUITY-SEQUENCE:1\n'
					+ '#EXTINF:1,\nb-segment-1-1.ts\n#EXTINF:1,\nb-segment-1-2.ts\n#EXT-X-ENDLIST\n';

			return new BufferSource(new TextEncoder().encode(playlist));
		}),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	const durations: number[] = [];
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		durations.push(packet.duration);
	}

	// The last packet of each segment has no successor to derive its duration from, so it comes from the sample rate
	expect(playlistRequestCount).toBe(2);
	expect(durations).toEqual([0.5, 1024 / 48000, 0.5, 1024 / 48000, 0.5, 1024 / 24000, 0.5, 1024 / 24000]);
});

test.concurrent('Live playlist reload adding date-times', { timeout: 10_000 }, async () => {
	const files = await writeHls({
		segmentFormat: new MpegTsOutputFormat(),
		targetDuration: 1,
	}, async (addVideo) => {
		for (let i = 0; i < 8; i++) {
			await addVideo(0.5 * i, i % 2 === 0);
		}
	});

	// The first playlist has no date-times, and the reload adds one for the new segments
	let playlistRequestCount = 0;
	using input = new Input({
		source: new CustomPathedSource('live.m3u8', ({ path }) => {
			if (path !== 'live.m3u8') {
				const bytes = files.get(path);
				assert(bytes);

				return new BufferSource(bytes);
			}

			let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment-1-1.ts\n#EXTINF:1,\nsegment-1-2.ts\n';
			if (playlistRequestCount++ > 0) {
				playlist += '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z\n'
					+ '#EXTINF:1,\nsegment-1-3.ts\n#EXTINF:1,\nsegment-1-4.ts\n#EXT-X-ENDLIST\n';
			}

			return new BufferSource(new TextEncoder().encode(playlist));
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	// The segments already in use keep their timeline, which the date-time only maps to Unix time
	expect(await collectTimestamps(new EncodedPacketSink(videoTrack))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
	expect(playlistRequestCount).toBe(2);
	expect(await videoTrack.isRelativeToUnixEpoch()).toBe(false);
	expect(await videoTrack.getUnixTimeForTimestamp(2.5)).toBe(Date.UTC(2026, 0, 1) / 1000 + 0.5);
});

const writeHls = async (
	hlsOptions: HlsOutputFormatOptions,
	addPackets: (
		addVideo: (timestamp: number, isKey: boolean) => Promise<void>,
		addAudio: (timestamp: number) => Promise<void>,
	) => Promise<void>,
	separateGroups = false,
	audioDecoderConfigOverrides: Partial<AudioDecoderConfig> = {},
) => {
	using demo = new Input({
		source: new FilePathSource('./test/public/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const demoVideoTrack = await demo.getPrimaryVideoTrack();
	const demoAudioTrack = await demo.getPrimaryAudioTrack();
	assert(demoVideoTrack);
	assert(demoAudioTrack);

	const videoPacket = await new EncodedPacketSink(demoVideoTrack).getFirstPacket();
	const audioPacket = await new EncodedPacketSink(demoAudioTrack).getFirstPacket();
	assert(videoPacket);
	assert(audioPacket);
	const videoDecoderConfig = await demoVideoTrack.getDecoderConfig();
	const audioDecoderConfig = await demoAudioTrack.getDecoderConfig();
	assert(videoDecoderConfig);
	assert(audioDecoderConfig);

	const targets = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat(hlsOptions),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			return target;
		}),
	});

	const videoSource = new EncodedVideoPacketSource('avc');
	const audioSource = new EncodedAudioPacketSource('aac');
	output.addVideoTrack(videoSource, separateGroups ? { group: new OutputTrackGroup() } : {});
	output.addAudioTrack(audioSource, separateGroups ? { group: new OutputTrackGroup() } : {});

	await output.start();

	await addPackets(
		(timestamp, isKey) => videoSource.add(
			new EncodedPacket(videoPacket.data, isKey ? 'key' : 'delta', timestamp, 0.5),
			{ decoderConfig: videoDecoderConfig },
		),
		timestamp => audioSource.add(
			new EncodedPacket(audioPacket.data, 'key', timestamp, 0.5),
			{ decoderConfig: { ...audioDecoderConfig, ...audioDecoderConfigOverrides } },
		),
	);

	await output.finalize();

	const files = new Map<string, Uint8Array>();
	for (const [path, target] of targets) {
		files.set(path, new Uint8Array(target.buffer!));
	}

	return files;
};

const collectTimestamps = async (sink: EncodedPacketSink) => {
	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	return timestamps;
};
