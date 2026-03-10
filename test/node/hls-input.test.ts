/* eslint-disable @stylistic/max-len */
import { ALL_FORMATS, EncodedPacketSink, Input, InputAudioTrack, InputVideoTrack, UrlSource } from 'mediabunny';
import { expect, test } from 'vitest';
import { HLS, HlsInputFormat } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';

// A lot of test cases taken from:
// https://github.com/video-dev/hls.js/blob/master/tests/test-streams.js

test.concurrent('Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.onSource = () => sourceCount++;

	expect(await input.getFormat()).toBeInstanceOf(HlsInputFormat);
	expect(await input.getFormat()).toBe(HLS);

	expect(sourceCount).toBe(1);

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter(x => x.isVideoTrack());
	const audioTracks = tracks.filter(x => x.isAudioTrack());

	expect(videoTracks).toHaveLength(5);
	expect(audioTracks).toHaveLength(5);

	expect(videoTracks[0]!.codec).toBe('avc');
	expect(await videoTracks[0]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(videoTracks[0]!.displayWidth).toBe(1280);
	expect(videoTracks[0]!.displayHeight).toBe(720);
	expect(videoTracks[0]!.bitrate).toBe(2149280);
	expect(videoTracks[0]!.name).toBe('720');
	expect(videoTracks[0]!.groupId).toBe(1);
	expect(videoTracks[0]!.pairingMask).toBe(1n << 0n);
	expect(videoTracks[0]!.isHydrated).toBe(false);
	expect(videoTracks[0]!.id).toBe(2);
	expect(() => videoTracks[0]?.codedWidth).toThrow();

	expect(videoTracks[1]!.codec).toBe('avc');
	expect(await videoTracks[1]!.getCodecParameterString()).toBe('avc1.42000d');
	expect(videoTracks[1]!.displayWidth).toBe(320);
	expect(videoTracks[1]!.displayHeight).toBe(184);
	expect(videoTracks[1]!.bitrate).toBe(246440);
	expect(videoTracks[1]!.name).toBe('240');
	expect(videoTracks[1]!.groupId).toBe(1);
	expect(videoTracks[1]!.pairingMask).toBe(1n << 1n);
	expect(videoTracks[1]!.isHydrated).toBe(false);
	expect(videoTracks[1]!.id).toBe(4);

	expect(videoTracks[2]!.codec).toBe('avc');
	expect(await videoTracks[2]!.getCodecParameterString()).toBe('avc1.420016');
	expect(videoTracks[2]!.displayWidth).toBe(512);
	expect(videoTracks[2]!.displayHeight).toBe(288);
	expect(videoTracks[2]!.bitrate).toBe(460560);
	expect(videoTracks[2]!.name).toBe('380');
	expect(videoTracks[2]!.groupId).toBe(1);
	expect(videoTracks[2]!.pairingMask).toBe(1n << 2n);
	expect(videoTracks[2]!.isHydrated).toBe(false);
	expect(videoTracks[2]!.id).toBe(6);

	expect(videoTracks[3]!.codec).toBe('avc');
	expect(await videoTracks[3]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(videoTracks[3]!.displayWidth).toBe(848);
	expect(videoTracks[3]!.displayHeight).toBe(480);
	expect(videoTracks[3]!.bitrate).toBe(836280);
	expect(videoTracks[3]!.name).toBe('480');
	expect(videoTracks[3]!.groupId).toBe(1);
	expect(videoTracks[3]!.pairingMask).toBe(1n << 3n);
	expect(videoTracks[3]!.isHydrated).toBe(false);
	expect(videoTracks[3]!.id).toBe(8);

	expect(videoTracks[4]!.codec).toBe('avc');
	expect(await videoTracks[4]!.getCodecParameterString()).toBe('avc1.640028');
	expect(videoTracks[4]!.displayWidth).toBe(1920);
	expect(videoTracks[4]!.displayHeight).toBe(1080);
	expect(videoTracks[4]!.bitrate).toBe(6221600);
	expect(videoTracks[4]!.name).toBe('1080');
	expect(videoTracks[4]!.groupId).toBe(1);
	expect(videoTracks[4]!.pairingMask).toBe(1n << 4n);
	expect(videoTracks[4]!.isHydrated).toBe(false);
	expect(videoTracks[4]!.id).toBe(10);

	expect(audioTracks[0]!.codec).toBe('aac');
	expect(await audioTracks[0]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(audioTracks[0]!.bitrate).toBe(2149280);
	expect(audioTracks[0]!.name).toBe('720');
	expect(audioTracks[0]!.groupId).toBe(2);
	expect(audioTracks[0]!.pairingMask).toBe(1n << 0n);
	expect(audioTracks[0]!.isHydrated).toBe(false);
	expect(audioTracks[0]!.id).toBe(1);
	expect(() => audioTracks[0]?.numberOfChannels).toThrow();
	expect(() => audioTracks[0]?.sampleRate).toThrow();

	expect(audioTracks[1]!.codec).toBe('aac');
	expect(await audioTracks[1]!.getCodecParameterString()).toBe('mp4a.40.5');
	expect(audioTracks[1]!.bitrate).toBe(246440);
	expect(audioTracks[1]!.name).toBe('240');
	expect(audioTracks[1]!.groupId).toBe(2);
	expect(audioTracks[1]!.pairingMask).toBe(1n << 1n);
	expect(audioTracks[1]!.isHydrated).toBe(false);
	expect(audioTracks[1]!.id).toBe(3);

	expect(audioTracks[2]!.codec).toBe('aac');
	expect(await audioTracks[2]!.getCodecParameterString()).toBe('mp4a.40.5');
	expect(audioTracks[2]!.bitrate).toBe(460560);
	expect(audioTracks[2]!.name).toBe('380');
	expect(audioTracks[2]!.groupId).toBe(2);
	expect(audioTracks[2]!.pairingMask).toBe(1n << 2n);
	expect(audioTracks[2]!.isHydrated).toBe(false);
	expect(audioTracks[2]!.id).toBe(5);

	expect(audioTracks[3]!.codec).toBe('aac');
	expect(await audioTracks[3]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(audioTracks[3]!.bitrate).toBe(836280);
	expect(audioTracks[3]!.name).toBe('480');
	expect(audioTracks[3]!.groupId).toBe(2);
	expect(audioTracks[3]!.pairingMask).toBe(1n << 3n);
	expect(audioTracks[3]!.isHydrated).toBe(false);
	expect(audioTracks[3]!.id).toBe(7);

	expect(audioTracks[4]!.codec).toBe('aac');
	expect(await audioTracks[4]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(audioTracks[4]!.bitrate).toBe(6221600);
	expect(audioTracks[4]!.name).toBe('1080');
	expect(audioTracks[4]!.groupId).toBe(2);
	expect(audioTracks[4]!.pairingMask).toBe(1n << 4n);
	expect(audioTracks[4]!.isHydrated).toBe(false);
	expect(audioTracks[4]!.id).toBe(9);

	expect(videoTracks[0]!.canBePairedWith(videoTracks[1]!)).toBe(false);
	expect(videoTracks[0]!.canBePairedWith(audioTracks[0]!)).toBe(true);
	expect(videoTracks[0]!.canBePairedWith(audioTracks[1]!)).toBe(false);

	const primaryVideoTrack = await input.getPrimaryVideoTrack();
	const primaryAudioTrack = await input.getPrimaryAudioTrack();

	// Since they're the highest-bitrate option
	expect(primaryVideoTrack).toBe(videoTracks[4]);
	expect(primaryAudioTrack).toBe(audioTracks[4]);

	expect(sourceCount).toBe(1);
	await input.hydrateAllTracks();
	expect(sourceCount).toBe(1 + 5 + 5);

	expect(tracks.every(x => x.isHydrated)).toBe(true);
	expect(tracks.every(x => !x.timestampsAreRelativeToUnixEpoch)).toBe(true);

	expect(videoTracks[0]!.codedWidth).toBe(1280);
	expect(videoTracks[0]!.codedHeight).toBe(720);
	expect(videoTracks[1]!.codedWidth).toBe(320);
	expect(videoTracks[1]!.codedHeight).toBe(184);
	expect(videoTracks[2]!.codedWidth).toBe(512);
	expect(videoTracks[2]!.codedHeight).toBe(288);
	expect(videoTracks[3]!.codedWidth).toBe(848);
	expect(videoTracks[3]!.codedHeight).toBe(480);
	expect(videoTracks[4]!.codedWidth).toBe(1920);
	expect(videoTracks[4]!.codedHeight).toBe(1080);

	expect(await videoTracks[0]!.getCodecParameterString()).toEqual('avc1.64001f');
	expect(await videoTracks[1]!.getCodecParameterString()).toEqual('avc1.42c00d'); // Slightly altered
	expect(await videoTracks[2]!.getCodecParameterString()).toEqual('avc1.42c016'); // Slightly altered
	expect(await videoTracks[3]!.getCodecParameterString()).toEqual('avc1.64001f');
	expect(await videoTracks[4]!.getCodecParameterString()).toEqual('avc1.640028');

	expect(audioTracks[0]!.numberOfChannels).toBe(2);
	expect(audioTracks[0]!.sampleRate).toBe(44100);
	expect(audioTracks[1]!.numberOfChannels).toBe(2);
	expect(audioTracks[1]!.sampleRate).toBe(22050);
	expect(audioTracks[2]!.numberOfChannels).toBe(2);
	expect(audioTracks[2]!.sampleRate).toBe(22050);
	expect(audioTracks[3]!.numberOfChannels).toBe(2);
	expect(audioTracks[3]!.sampleRate).toBe(44100);
	expect(audioTracks[4]!.numberOfChannels).toBe(2);
	expect(audioTracks[4]!.sampleRate).toBe(44100);

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
});

test.concurrent('Single-variant Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const audioTrack = tracks[0]! as InputAudioTrack;
	expect(audioTrack.isHydrated).toBe(true);
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(audioTrack.codec).toBe('aac');

	const videoTrack = tracks[1] as InputVideoTrack;
	expect(videoTrack.isHydrated).toBe(true);
	expect(videoTrack.isVideoTrack()).toBe(true);
	expect(videoTrack.codec).toBe('avc');
});

test.concurrent('Codec-less (underspecified) master playlist', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://test-streams.mux.dev/test_001/stream.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(12);

	const codecs = new Set(tracks.map(x => x.codec));
	expect(codecs.size).toBe(2);
	expect(codecs.has('avc')).toBe(true);
	expect(codecs.has('aac')).toBe(true);
});

test.concurrent('AES and discontinuities', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.onSource = () => sourceCount++;

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(videoTrack.isHydrated).toBe(true);

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
		entryPath: 'https://playertest.longtailvideo.com/adaptive/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.onSource = () => sourceCount++;

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);
	expect(tracks.every(x => x.isHydrated)).toBe(true);

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
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/customIV/prog_index.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.onSource = () => sourceCount++;

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);
	expect(tracks.every(x => x.isHydrated)).toBe(true);

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key
});

test.concurrent('Out-of-band audio track via ADTS', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.some(x => x.isVideoTrack() && x.hasOnlyKeyPackets)).toBe(true);

	const audioTrack = tracks.find(x => x.isAudioTrack());
	assert(audioTrack);
	expect(audioTrack.hasOnlyKeyPackets).toBe(true);

	expect(await audioTrack.getPairableVideoTracks()).toHaveLength(1); // Since the I-frame one isn't pairable
	const videoTrack = await audioTrack.pluckPairableVideoTrack();
	assert(videoTrack);
	expect(videoTrack.hasOnlyKeyPackets).toBe(false);

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
	using input = new Input({
		entryPath: 'https://pl.streamingvideoprovider.com/mp3-playlist/playlist.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(audioTrack.isHydrated).toBe(false);
	expect(audioTrack.codec).toBe('mp3');
});

test.concurrent('fMP4', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.onSource = () => sourceCount++;

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();

	assert(videoTrack);
	assert(audioTrack);

	await videoTrack.hydrate();
	await audioTrack.hydrate();

	expect(videoTrack.codedWidth).toBe(768);
	expect(videoTrack.codedHeight).toBe(576);
	expect(audioTrack.numberOfChannels).toBe(2);
	expect(audioTrack.sampleRate).toBe(48000);

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await videoTrack.computeDuration()).toBe(60);

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
	expect(await audioTrack.computeDuration()).toBeCloseTo(60.021333);

	expect(sourceCount).toBe(1 + 2 * (1 + 1 + 1 + 1));
});

test.concurrent('fMP4 Bitmovin', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s-fmp4/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8',
		source: ({ path }) => new UrlSource(path, {
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
	input.onSource = () => sourceCount++;

	const tracks = await input.getTracks();
	expect(tracks.filter(x => x.isVideoTrack())).toHaveLength(6);
	expect(tracks.filter(x => x.isAudioTrack())).toHaveLength(1);

	expect(tracks.some(x => x.isVideoTrack() && x.displayWidth === 320 && x.displayHeight === 180)).toBe(true);
	expect(tracks.some(x => x.isVideoTrack() && x.displayWidth === 480 && x.displayHeight === 270)).toBe(true);
	expect(tracks.some(x => x.isVideoTrack() && x.displayWidth === 640 && x.displayHeight === 360)).toBe(true);
	expect(tracks.some(x => x.isVideoTrack() && x.displayWidth === 960 && x.displayHeight === 540)).toBe(true);
	expect(tracks.some(x => x.isVideoTrack() && x.displayWidth === 1280 && x.displayHeight === 720)).toBe(true);
	expect(tracks.some(x => x.isVideoTrack() && x.displayWidth === 1920 && x.displayHeight === 1080)).toBe(true);

	const videoTrack = await input.pluckVideoTrack();
	assert(videoTrack);

	expect(await videoTrack.getFirstTimestamp()).toBe(0);
	expect(await videoTrack.computeDuration()).toBe(210.28);

	expect(sourceCount).toBe(5);
});

test.concurrent('Single-value PDT', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/aviion/manifest.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks.every(x => x.isHydrated && x.timestampsAreRelativeToUnixEpoch)).toBe(true);

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

test.concurrent('Duplicate PDT', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/artbeats/manifest.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

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
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/boxee/playlist.m3u8',
		source: ({ path }) => new UrlSource(path),
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
		entryPath: 'https://playertest.longtailvideo.com/adaptive/progdatime/playlist2.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	await audioTrack.hydrate();

	expect(audioTrack.timestampsAreRelativeToUnixEpoch).toBe(false);
});

test.concurrent('Alternative audio only', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/alt-audio-no-video/sintel/playlist.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	expect(tracks[0]).toMatchObject({ type: 'audio', languageCode: 'en', name: 'English' });
	expect(tracks[1]).toMatchObject({ type: 'audio', languageCode: 'dubbing', name: 'Dubbing' });
});

test.concurrent('Advanced Apple HLS', { timeout: 30_000 }, async () => {
	using input = new Input({
		entryPath: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getTracks();
	const videoTracks = tracks.filter(x => x.isVideoTrack());
	const audioTracks = tracks.filter(x => x.isAudioTrack());

	expect(audioTracks).toHaveLength(3);
	expect(videoTracks).toHaveLength(64);

	expect(audioTracks[0]).toMatchObject({ codec: 'aac', name: 'English', languageCode: 'en' });
	expect(audioTracks[1]).toMatchObject({ codec: 'ac3', name: 'English', languageCode: 'en' });
	expect(audioTracks[2]).toMatchObject({ codec: 'eac3', name: 'English', languageCode: 'en' });

	expect(await audioTracks[0]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(await audioTracks[1]!.getCodecParameterString()).toBe('ac-3');
	expect(await audioTracks[2]!.getCodecParameterString()).toBe('ec-3');

	expect(await audioTracks[0]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[1]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[2]!.getPairableVideoTracks()).toHaveLength(18);

	// I-FRAME AVC (5 tracks)

	expect(videoTracks[0]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 1015727, hasOnlyKeyPackets: true });
	expect(videoTracks[1]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 760174, hasOnlyKeyPackets: true });
	expect(videoTracks[2]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 520162, hasOnlyKeyPackets: true });
	expect(videoTracks[3]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 186651, hasOnlyKeyPackets: true });
	expect(videoTracks[4]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 95410, hasOnlyKeyPackets: true });

	expect(await videoTracks[0]!.getCodecParameterString()).toBe('avc1.640028');
	expect(await videoTracks[1]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[2]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[3]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[4]!.getCodecParameterString()).toBe('avc1.64001f');

	// AVC + audio group a1 (9 tracks)

	expect(videoTracks[5]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2523597, hasOnlyKeyPackets: false });
	expect(videoTracks[6]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 9873268, hasOnlyKeyPackets: false });
	expect(videoTracks[7]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7318337, hasOnlyKeyPackets: false });
	expect(videoTracks[8]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5421720, hasOnlyKeyPackets: false });
	expect(videoTracks[9]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3611257, hasOnlyKeyPackets: false });
	expect(videoTracks[10]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1475903, hasOnlyKeyPackets: false });
	expect(videoTracks[11]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1017705, hasOnlyKeyPackets: false });
	expect(videoTracks[12]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 582820, hasOnlyKeyPackets: false });
	expect(videoTracks[13]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 339404, hasOnlyKeyPackets: false });

	expect(await videoTracks[5]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[6]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[7]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[8]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[9]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[10]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[11]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[12]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[13]!.getCodecParameterString()).toBe('avc1.64001f');

	// AVC + audio group a2 (9 tracks)

	expect(videoTracks[14]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2746096, hasOnlyKeyPackets: false });
	expect(videoTracks[15]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 10095767, hasOnlyKeyPackets: false });
	expect(videoTracks[16]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7540836, hasOnlyKeyPackets: false });
	expect(videoTracks[17]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5644219, hasOnlyKeyPackets: false });
	expect(videoTracks[18]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3833756, hasOnlyKeyPackets: false });
	expect(videoTracks[19]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1698402, hasOnlyKeyPackets: false });
	expect(videoTracks[20]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1240204, hasOnlyKeyPackets: false });
	expect(videoTracks[21]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 805319, hasOnlyKeyPackets: false });
	expect(videoTracks[22]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 561903, hasOnlyKeyPackets: false });

	expect(await videoTracks[14]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[15]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[16]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[17]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[18]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[19]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[20]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[21]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[22]!.getCodecParameterString()).toBe('avc1.64001f');

	// AVC + audio group a3 (9 tracks)

	expect(videoTracks[23]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2554096, hasOnlyKeyPackets: false });
	expect(videoTracks[24]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 9903767, hasOnlyKeyPackets: false });
	expect(videoTracks[25]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7348836, hasOnlyKeyPackets: false });
	expect(videoTracks[26]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5452219, hasOnlyKeyPackets: false });
	expect(videoTracks[27]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3641756, hasOnlyKeyPackets: false });
	expect(videoTracks[28]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1506402, hasOnlyKeyPackets: false });
	expect(videoTracks[29]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1048204, hasOnlyKeyPackets: false });
	expect(videoTracks[30]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 613319, hasOnlyKeyPackets: false });
	expect(videoTracks[31]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 369903, hasOnlyKeyPackets: false });

	expect(await videoTracks[23]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[24]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[25]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[26]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[27]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[28]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[29]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[30]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[31]!.getCodecParameterString()).toBe('avc1.64001f');

	// I-FRAME HEVC (5 tracks)

	expect(videoTracks[32]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 328352, hasOnlyKeyPackets: true });
	expect(videoTracks[33]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 226274, hasOnlyKeyPackets: true });
	expect(videoTracks[34]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 159037, hasOnlyKeyPackets: true });
	expect(videoTracks[35]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 92800, hasOnlyKeyPackets: true });
	expect(videoTracks[36]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 51760, hasOnlyKeyPackets: true });

	expect(await videoTracks[32]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[33]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[34]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[35]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[36]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');

	// HEVC + audio group a1 (9 tracks)

	expect(videoTracks[37]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2164328, hasOnlyKeyPackets: false });
	expect(videoTracks[38]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6664228, hasOnlyKeyPackets: false });
	expect(videoTracks[39]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5427899, hasOnlyKeyPackets: false });
	expect(videoTracks[40]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4079770, hasOnlyKeyPackets: false });
	expect(videoTracks[41]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2764701, hasOnlyKeyPackets: false });
	expect(videoTracks[42]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1226255, hasOnlyKeyPackets: false });
	expect(videoTracks[43]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 901770, hasOnlyKeyPackets: false });
	expect(videoTracks[44]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 548927, hasOnlyKeyPackets: false });
	expect(videoTracks[45]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 340713, hasOnlyKeyPackets: false });

	expect(await videoTracks[37]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[38]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[39]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[40]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[41]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[42]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[43]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[44]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[45]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');

	// HEVC + audio group a2 (9 tracks)

	expect(videoTracks[46]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2386827, hasOnlyKeyPackets: false });
	expect(videoTracks[47]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6886727, hasOnlyKeyPackets: false });
	expect(videoTracks[48]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5650398, hasOnlyKeyPackets: false });
	expect(videoTracks[49]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4302269, hasOnlyKeyPackets: false });
	expect(videoTracks[50]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2987200, hasOnlyKeyPackets: false });
	expect(videoTracks[51]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1448754, hasOnlyKeyPackets: false });
	expect(videoTracks[52]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 1124269, hasOnlyKeyPackets: false });
	expect(videoTracks[53]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 771426, hasOnlyKeyPackets: false });
	expect(videoTracks[54]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 563212, hasOnlyKeyPackets: false });

	expect(await videoTracks[46]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[47]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[48]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[49]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[50]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[51]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[52]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[53]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[54]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');

	// HEVC + audio group a3 (9 tracks)

	expect(videoTracks[55]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2194827, hasOnlyKeyPackets: false });
	expect(videoTracks[56]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6694727, hasOnlyKeyPackets: false });
	expect(videoTracks[57]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5458398, hasOnlyKeyPackets: false });
	expect(videoTracks[58]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4110269, hasOnlyKeyPackets: false });
	expect(videoTracks[59]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2795200, hasOnlyKeyPackets: false });
	expect(videoTracks[60]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1256754, hasOnlyKeyPackets: false });
	expect(videoTracks[61]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 932269, hasOnlyKeyPackets: false });
	expect(videoTracks[62]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 579426, hasOnlyKeyPackets: false });
	expect(videoTracks[63]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 371212, hasOnlyKeyPackets: false });

	expect(await videoTracks[55]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[56]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[57]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[58]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[59]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[60]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[61]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[62]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[63]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
});
