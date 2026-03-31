/* eslint-disable @stylistic/max-len */
import { ALL_FORMATS, EncodedPacketSink, Input, InputAudioTrack, InputVideoTrack, UrlSource } from 'mediabunny';
import { expect, test } from 'vitest';
import { HLS, HlsInputFormat } from '../../src/input-format.js';
import { assert, rejectAfter } from '../../src/misc.js';

// A lot of test cases taken from:
// https://github.com/video-dev/hls.js/blob/master/tests/test-streams.js

test.concurrent('Big Buck Bunny', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	let sourceCount = 0;
	input.on('source', () => sourceCount++);

	expect(await input.getFormat()).toBeInstanceOf(HlsInputFormat);
	expect(await input.getFormat()).toBe(HLS);
	expect(await input.getDurationFromMetadata()).toBe(null); // Since it's a master playlist!

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
	expect(videoTracks[0]!.isHydrated).toBe(false);
	expect(videoTracks[0]!.id).toBe(2);
	expect(() => videoTracks[0]?.codedWidth).toThrow();

	expect(videoTracks[1]!.codec).toBe('avc');
	expect(await videoTracks[1]!.getCodecParameterString()).toBe('avc1.42000d');
	expect(videoTracks[1]!.displayWidth).toBe(320);
	expect(videoTracks[1]!.displayHeight).toBe(184);
	expect(videoTracks[1]!.bitrate).toBe(246440);
	expect(videoTracks[1]!.name).toBe('240');
	expect(videoTracks[1]!.isHydrated).toBe(false);
	expect(videoTracks[1]!.id).toBe(4);

	expect(videoTracks[2]!.codec).toBe('avc');
	expect(await videoTracks[2]!.getCodecParameterString()).toBe('avc1.420016');
	expect(videoTracks[2]!.displayWidth).toBe(512);
	expect(videoTracks[2]!.displayHeight).toBe(288);
	expect(videoTracks[2]!.bitrate).toBe(460560);
	expect(videoTracks[2]!.name).toBe('380');
	expect(videoTracks[2]!.isHydrated).toBe(false);
	expect(videoTracks[2]!.id).toBe(6);

	expect(videoTracks[3]!.codec).toBe('avc');
	expect(await videoTracks[3]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(videoTracks[3]!.displayWidth).toBe(848);
	expect(videoTracks[3]!.displayHeight).toBe(480);
	expect(videoTracks[3]!.bitrate).toBe(836280);
	expect(videoTracks[3]!.name).toBe('480');
	expect(videoTracks[3]!.isHydrated).toBe(false);
	expect(videoTracks[3]!.id).toBe(8);

	expect(videoTracks[4]!.codec).toBe('avc');
	expect(await videoTracks[4]!.getCodecParameterString()).toBe('avc1.640028');
	expect(videoTracks[4]!.displayWidth).toBe(1920);
	expect(videoTracks[4]!.displayHeight).toBe(1080);
	expect(videoTracks[4]!.bitrate).toBe(6221600);
	expect(videoTracks[4]!.name).toBe('1080');
	expect(videoTracks[4]!.isHydrated).toBe(false);
	expect(videoTracks[4]!.id).toBe(10);

	expect(audioTracks[0]!.codec).toBe('aac');
	expect(await audioTracks[0]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(audioTracks[0]!.bitrate).toBe(2149280);
	expect(audioTracks[0]!.name).toBe('720');
	expect(audioTracks[0]!.isHydrated).toBe(false);
	expect(audioTracks[0]!.id).toBe(1);
	expect(() => audioTracks[0]?.numberOfChannels).toThrow();
	expect(() => audioTracks[0]?.sampleRate).toThrow();

	expect(audioTracks[1]!.codec).toBe('aac');
	expect(await audioTracks[1]!.getCodecParameterString()).toBe('mp4a.40.5');
	expect(audioTracks[1]!.bitrate).toBe(246440);
	expect(audioTracks[1]!.name).toBe('240');
	expect(audioTracks[1]!.isHydrated).toBe(false);
	expect(audioTracks[1]!.id).toBe(3);

	expect(audioTracks[2]!.codec).toBe('aac');
	expect(await audioTracks[2]!.getCodecParameterString()).toBe('mp4a.40.5');
	expect(audioTracks[2]!.bitrate).toBe(460560);
	expect(audioTracks[2]!.name).toBe('380');
	expect(audioTracks[2]!.isHydrated).toBe(false);
	expect(audioTracks[2]!.id).toBe(5);

	expect(audioTracks[3]!.codec).toBe('aac');
	expect(await audioTracks[3]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(audioTracks[3]!.bitrate).toBe(836280);
	expect(audioTracks[3]!.name).toBe('480');
	expect(audioTracks[3]!.isHydrated).toBe(false);
	expect(audioTracks[3]!.id).toBe(7);

	expect(audioTracks[4]!.codec).toBe('aac');
	expect(await audioTracks[4]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(audioTracks[4]!.bitrate).toBe(6221600);
	expect(audioTracks[4]!.name).toBe('1080');
	expect(audioTracks[4]!.isHydrated).toBe(false);
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

	for (const track of tracks) {
		expect(await track.isLive()).toBe(false);
	}

	expect(await videoTracks[0]!.getDurationFromMetadata()).toBe(634.584);
	expect(await audioTracks[0]!.getDurationFromMetadata()).toBe(634.584);

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
	input.on('source', () => sourceCount++);

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
	input.on('source', () => sourceCount++);

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
	input.on('source', () => sourceCount++);

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
	input.on('source', () => sourceCount++);

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

test.concurrent('Track disposition & metadata', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const audioTracks = await input.getAudioTracks();

	expect(audioTracks).toHaveLength(6);

	expect(audioTracks[0]!.languageCode).toBe('en');
	expect(audioTracks[1]!.languageCode).toBe('de');
	expect(audioTracks[2]!.languageCode).toBe('it');
	expect(audioTracks[3]!.languageCode).toBe('fr');
	expect(audioTracks[4]!.languageCode).toBe('es');
	expect(audioTracks[5]!.languageCode).toBe('en');

	expect(audioTracks[0]!.disposition.primary).toBe(true);
	expect(audioTracks[1]!.disposition.primary).toBe(false);
	expect(audioTracks[2]!.disposition.primary).toBe(false);
	expect(audioTracks[3]!.disposition.primary).toBe(false);
	expect(audioTracks[4]!.disposition.primary).toBe(false);
	expect(audioTracks[5]!.disposition.primary).toBe(false);

	expect(audioTracks[0]!.disposition.default).toBe(true);
	expect(audioTracks[1]!.disposition.default).toBe(true);
	expect(audioTracks[2]!.disposition.default).toBe(true);
	expect(audioTracks[3]!.disposition.default).toBe(true);
	expect(audioTracks[4]!.disposition.default).toBe(true);
	expect(audioTracks[5]!.disposition.default).toBe(false);

	expect(audioTracks[0]!.name).toBe('stream_5');
	expect(audioTracks[1]!.name).toBe('stream_4');
	expect(audioTracks[2]!.name).toBe('stream_8');
	expect(audioTracks[3]!.name).toBe('stream_7');
	expect(audioTracks[4]!.name).toBe('stream_9');
	expect(audioTracks[5]!.name).toBe('stream_6');
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
	input.on('source', () => sourceCount++);

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

	expect(await videoTrack.getFirstTimestamp()).toBe(4);
	expect(await videoTrack.computeDuration()).toBe(214.28);

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

test.concurrent('Duplicate PDT', { timeout: 30_000 }, async () => {
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
	expect(videoTracks).toHaveLength(28);

	expect(audioTracks[0]).toMatchObject({ codec: 'aac', name: 'English', languageCode: 'en' });
	expect(audioTracks[1]).toMatchObject({ codec: 'ac3', name: 'English', languageCode: 'en' });
	expect(audioTracks[2]).toMatchObject({ codec: 'eac3', name: 'English', languageCode: 'en' });

	expect(await audioTracks[0]!.getCodecParameterString()).toBe('mp4a.40.2');
	expect(await audioTracks[1]!.getCodecParameterString()).toBe('ac-3');
	expect(await audioTracks[2]!.getCodecParameterString()).toBe('ec-3');

	expect(await audioTracks[0]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[1]!.getPairableVideoTracks()).toHaveLength(18);
	expect(await audioTracks[2]!.getPairableVideoTracks()).toHaveLength(18);

	// I-FRAME AVC

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

	for (let i = 0; i <= 4; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.some(x => x.canBePairedWith(videoTrack))).toBe(false);
	}

	// AVC

	expect(videoTracks[5]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2746096, hasOnlyKeyPackets: false });
	expect(videoTracks[6]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 10095767, hasOnlyKeyPackets: false });
	expect(videoTracks[7]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7540836, hasOnlyKeyPackets: false });
	expect(videoTracks[8]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5644219, hasOnlyKeyPackets: false });
	expect(videoTracks[9]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3833756, hasOnlyKeyPackets: false });
	expect(videoTracks[10]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1698402, hasOnlyKeyPackets: false });
	expect(videoTracks[11]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1240204, hasOnlyKeyPackets: false });
	expect(videoTracks[12]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 805319, hasOnlyKeyPackets: false });
	expect(videoTracks[13]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 561903, hasOnlyKeyPackets: false });

	expect(await videoTracks[5]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[6]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[7]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[8]!.getCodecParameterString()).toBe('avc1.64002a');
	expect(await videoTracks[9]!.getCodecParameterString()).toBe('avc1.640020');
	expect(await videoTracks[10]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[11]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[12]!.getCodecParameterString()).toBe('avc1.64001f');
	expect(await videoTracks[13]!.getCodecParameterString()).toBe('avc1.64001f');

	for (let i = 5; i <= 13; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.every(x => x.canBePairedWith(videoTrack))).toBe(true);
	}

	// I-FRAME HEVC

	expect(videoTracks[14]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 328352, hasOnlyKeyPackets: true });
	expect(videoTracks[15]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 226274, hasOnlyKeyPackets: true });
	expect(videoTracks[16]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 159037, hasOnlyKeyPackets: true });
	expect(videoTracks[17]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 92800, hasOnlyKeyPackets: true });
	expect(videoTracks[18]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 51760, hasOnlyKeyPackets: true });

	expect(await videoTracks[14]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[15]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[16]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[17]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[18]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');

	for (let i = 14; i <= 18; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.some(x => x.canBePairedWith(videoTrack))).toBe(false);
	}

	// HEVC

	expect(videoTracks[19]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2386827, hasOnlyKeyPackets: false });
	expect(videoTracks[20]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6886727, hasOnlyKeyPackets: false });
	expect(videoTracks[21]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5650398, hasOnlyKeyPackets: false });
	expect(videoTracks[22]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4302269, hasOnlyKeyPackets: false });
	expect(videoTracks[23]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2987200, hasOnlyKeyPackets: false });
	expect(videoTracks[24]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1448754, hasOnlyKeyPackets: false });
	expect(videoTracks[25]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 1124269, hasOnlyKeyPackets: false });
	expect(videoTracks[26]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 771426, hasOnlyKeyPackets: false });
	expect(videoTracks[27]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 563212, hasOnlyKeyPackets: false });

	expect(await videoTracks[19]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[20]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[21]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[22]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[23]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[24]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[25]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[26]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');
	expect(await videoTracks[27]!.getCodecParameterString()).toBe('hvc1.2.4.L123.B0');

	for (let i = 19; i <= 27; i++) {
		const videoTrack = videoTracks[i]!;
		expect(audioTracks.every(x => x.canBePairedWith(videoTrack))).toBe(true);
	}
});

test.concurrent('Live HLS', { timeout: 30_000 }, async () => {
	using input = new Input({
		entryPath: 'https://stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	await expect(videoTrack.isLive()).rejects.toThrow();
	await expect(audioTrack.isLive()).rejects.toThrow();

	await videoTrack.hydrate();
	await audioTrack.hydrate();

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
