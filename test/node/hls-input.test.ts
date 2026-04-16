/* eslint-disable @stylistic/max-len */
import { ALL_FORMATS, BufferSource, createInputFrom, EncodedPacketSink, Input, InputAudioTrack, InputVideoTrack, PathedSource } from 'mediabunny';
import { expect, test } from 'vitest';
import { HLS, HLS_FORMATS, HlsInputFormat } from '../../src/input-format.js';
import { assert, rejectAfter } from '../../src/misc.js';

// A lot of test cases taken from:
// https://github.com/video-dev/hls.js/blob/master/tests/test-streams.js

test.concurrent('Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', ALL_FORMATS);

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

	expect(Math.min(await videoTracks[0]!.getFirstTimestamp(), await audioTracks[0]!.getFirstTimestamp())).toBe(0);

	const sink = new EncodedPacketSink(videoTracks[0]!);
	const lastPacket = await sink.getPacket(Infinity);
	expect(lastPacket!.timestamp).toBeCloseTo(634.5899);

	expect(sourceCount).toBe(1 + 5 + 5 + 1);

	const middlePacket = await sink.getPacket(300);
	expect(middlePacket!.timestamp).toBeCloseTo(299.9899);

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
	using input = createInputFrom('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', ALL_FORMATS);

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	expect(sourceCount).toBe(1);

	const approxDuration = await track.getDurationFromMetadata();
	expect(approxDuration).toBe(634.567);

	expect(sourceCount).toBe(2); // We needed to read the playlist, but not any segment
});

test.concurrent('Single-variant Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://test-streams.mux.dev/test_001/stream.m3u8', ALL_FORMATS);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(12);

	const codecs = new Set(await Promise.all(tracks.map(x => x.getCodec())));
	expect(codecs.size).toBe(2);
	expect(codecs.has('avc')).toBe(true);
	expect(codecs.has('aac')).toBe(true);
});

test.concurrent('AES and discontinuities', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8', ALL_FORMATS);

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
	expect(lastPacket.timestamp).toBeCloseTo(47.26133333333333);

	expect(sourceCount).toBe(2);
});

test.concurrent('Custom IV', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/customIV/prog_index.m3u8', ALL_FORMATS);

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key
});

test.concurrent('Out-of-band audio track via ADTS', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8', ALL_FORMATS);

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

	// This way we test that the two are synced up
	expect(await videoTrack.getFirstTimestamp()).toBe(await audioTrack.getFirstTimestamp());
	expect(await videoTrack.computeDuration()).toBeCloseTo(await audioTrack.computeDuration(), 1);
});

test.concurrent('MP3 audio only', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8', ALL_FORMATS);

	const audioTrack = (await input.getAudioTracks())[0];
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('mp3');
});

test.concurrent('fMP4', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8', ALL_FORMATS);

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

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
	expect(await audioTrack.computeDuration()).toBeCloseTo(60.021333);

	expect(sourceCount).toBe(1 + 2 * (1 + 1 + 1 + 1));
});

test.concurrent('Track disposition & metadata', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s-fmp4/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8', ALL_FORMATS, {
		requestInit: {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				'Accept': '*/*',
				'Accept-Language': 'en-US,en;q=0.9',
				'Origin': 'https://bitmovin.com',
				'Referer': 'https://bitmovin.com/',
			},
		},
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

	const videoTrack = (await input.getVideoTracks())[0];
	assert(videoTrack);

	expect(await videoTrack.getFirstTimestamp()).toBe(4);
	expect(await videoTrack.computeDuration()).toBe(214.28);

	expect(sourceCount).toBe(5);
});

test.concurrent('Single-value PDT', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/aviion/manifest.m3u8', ALL_FORMATS);

	const tracks = await input.getTracks();
	expect((await Promise.all(tracks.map(x => x.isRelativeToUnixEpoch()))).every(x => x)).toBe(true);

	const track = tracks[0]!;
	const firstTimestamp = await track.getFirstTimestamp();
	expect(firstTimestamp).toBe(Date.parse('2013-05-08T17:40:50Z') / 1000);

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
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/artbeats/manifest.m3u8', ALL_FORMATS);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(Date.parse('2013-06-17T18:32:00Z') / 1000);

	// Ensure the timestamps are monotonically increasing
	const sink = new EncodedPacketSink(audioTrack);
	let lastTimestamp = -Infinity;
	for await (const packet of sink.packets()) {
		expect(packet.timestamp).toBeGreaterThan(lastTimestamp);
		lastTimestamp = packet.timestamp;
	}
});

test.concurrent('PDT with large gaps', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/boxee/playlist.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/progdatime/playlist2.m3u8', ALL_FORMATS);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.isRelativeToUnixEpoch()).toBe(false);
});

test.concurrent('Alternative audio only', { timeout: 15_000 }, async () => {
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/alt-audio-no-video/sintel/playlist.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8', ALL_FORMATS);

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
	using input = createInputFrom('https://stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8', ALL_FORMATS);

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
});

test.concurrent('#EXT-X-I-FRAME-STREAM-INF tags are parsed properly', async () => {
	const text = `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=256000,CODECS="avc1.4D401E",RESOLUTION=480x270,URI="7f2459cb12854fdbbc7ec1e7279da179/f74fb10563564130a4702743d64112a3/index_11.m3u8"
`;

	const input = new Input({
		formats: ALL_FORMATS,
		source: new PathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
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
		source: new PathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
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
		source: new PathedSource('master.m3u8', () => new BufferSource(new TextEncoder().encode(text))),
	});

	await expect(input.getTracks()).rejects.toThrow('BANDWIDTH');
});

test.concurrent('Missing media tag codec', async () => {
	using input = createInputFrom('https://playertest.longtailvideo.com/adaptive/elephants_dream_v4/index.m3u8', ALL_FORMATS);

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(7);

	expect(tracks.filter(x => x.type === 'video')).toHaveLength(4);
	expect(tracks.filter(x => x.type === 'audio')).toHaveLength(3);

	expect([...new Set(await Promise.all(tracks.map(x => x.getCodec())))]).toEqual(['aac', 'avc']);
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
		source: new PathedSource(
			'root.m3u8',
			({ path }) => {
				console.log(1, path);
				assert(path === 'root.m3u8');
				return new BufferSource(new TextEncoder().encode(text));
			},
		),
		formats: HLS_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow('unsupported');
});
