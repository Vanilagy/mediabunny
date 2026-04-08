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

	// Test descriptors (unhydrated metadata from master playlist)
	const descriptors = await input.getTrackDescriptors();
	const videoDescriptors = descriptors.filter(x => x.isVideoTrackDescriptor());
	const audioDescriptors = descriptors.filter(x => x.isAudioTrackDescriptor());

	expect(videoDescriptors).toHaveLength(5);
	expect(audioDescriptors).toHaveLength(5);

	expect(videoDescriptors[0]!.codec).toBe('avc');
	expect(videoDescriptors[0]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[0]!.displayWidth).toBe(1280);
	expect(videoDescriptors[0]!.displayHeight).toBe(720);
	expect(videoDescriptors[0]!.bitrate).toBe(2149280);
	expect(videoDescriptors[0]!.name).toBe('720');
	expect(videoDescriptors[0]!.id).toBe(2);

	expect(videoDescriptors[1]!.codec).toBe('avc');
	expect(videoDescriptors[1]!.codecParameterString).toBe('avc1.42000d');
	expect(videoDescriptors[1]!.displayWidth).toBe(320);
	expect(videoDescriptors[1]!.displayHeight).toBe(184);
	expect(videoDescriptors[1]!.bitrate).toBe(246440);
	expect(videoDescriptors[1]!.name).toBe('240');
	expect(videoDescriptors[1]!.id).toBe(4);

	expect(videoDescriptors[2]!.codec).toBe('avc');
	expect(videoDescriptors[2]!.codecParameterString).toBe('avc1.420016');
	expect(videoDescriptors[2]!.displayWidth).toBe(512);
	expect(videoDescriptors[2]!.displayHeight).toBe(288);
	expect(videoDescriptors[2]!.bitrate).toBe(460560);
	expect(videoDescriptors[2]!.name).toBe('380');
	expect(videoDescriptors[2]!.id).toBe(6);

	expect(videoDescriptors[3]!.codec).toBe('avc');
	expect(videoDescriptors[3]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[3]!.displayWidth).toBe(848);
	expect(videoDescriptors[3]!.displayHeight).toBe(480);
	expect(videoDescriptors[3]!.bitrate).toBe(836280);
	expect(videoDescriptors[3]!.name).toBe('480');
	expect(videoDescriptors[3]!.id).toBe(8);

	expect(videoDescriptors[4]!.codec).toBe('avc');
	expect(videoDescriptors[4]!.codecParameterString).toBe('avc1.640028');
	expect(videoDescriptors[4]!.displayWidth).toBe(1920);
	expect(videoDescriptors[4]!.displayHeight).toBe(1080);
	expect(videoDescriptors[4]!.bitrate).toBe(6221600);
	expect(videoDescriptors[4]!.name).toBe('1080');
	expect(videoDescriptors[4]!.id).toBe(10);

	expect(audioDescriptors[0]!.codec).toBe('aac');
	expect(audioDescriptors[0]!.codecParameterString).toBe('mp4a.40.2');
	expect(audioDescriptors[0]!.bitrate).toBe(2149280);
	expect(audioDescriptors[0]!.name).toBe('720');
	expect(audioDescriptors[0]!.id).toBe(1);
	expect(audioDescriptors[0]!.numberOfChannels).toBeUndefined();
	expect(audioDescriptors[0]!.sampleRate).toBeUndefined();

	expect(audioDescriptors[1]!.codec).toBe('aac');
	expect(audioDescriptors[1]!.codecParameterString).toBe('mp4a.40.5');
	expect(audioDescriptors[1]!.bitrate).toBe(246440);
	expect(audioDescriptors[1]!.name).toBe('240');
	expect(audioDescriptors[1]!.id).toBe(3);

	expect(audioDescriptors[2]!.codec).toBe('aac');
	expect(audioDescriptors[2]!.codecParameterString).toBe('mp4a.40.5');
	expect(audioDescriptors[2]!.bitrate).toBe(460560);
	expect(audioDescriptors[2]!.name).toBe('380');
	expect(audioDescriptors[2]!.id).toBe(5);

	expect(audioDescriptors[3]!.codec).toBe('aac');
	expect(audioDescriptors[3]!.codecParameterString).toBe('mp4a.40.2');
	expect(audioDescriptors[3]!.bitrate).toBe(836280);
	expect(audioDescriptors[3]!.name).toBe('480');
	expect(audioDescriptors[3]!.id).toBe(7);

	expect(audioDescriptors[4]!.codec).toBe('aac');
	expect(audioDescriptors[4]!.codecParameterString).toBe('mp4a.40.2');
	expect(audioDescriptors[4]!.bitrate).toBe(6221600);
	expect(audioDescriptors[4]!.name).toBe('1080');
	expect(audioDescriptors[4]!.id).toBe(9);

	for (let i = 0; i < videoDescriptors.length - 1; i++) {
		for (let j = i + 1; j < videoDescriptors.length; j++) {
			expect(videoDescriptors[i]!.canBePairedWith(videoDescriptors[j]!)).toBe(false);
		}
	}

	for (let i = 0; i < videoDescriptors.length; i++) {
		for (let j = 0; j < audioDescriptors.length; j++) {
			expect(videoDescriptors[i]!.canBePairedWith(audioDescriptors[j]!)).toBe(i === j);
		}
	}

	expect(sourceCount).toBe(1);

	// Hydrate all tracks
	const tracks = await input.getTracks();
	const videoTracks = tracks.filter(x => x.isVideoTrack());
	const audioTracks = tracks.filter(x => x.isAudioTrack());

	expect(sourceCount).toBe(1 + 5 + 5);

	expect(tracks.every(x => !x.isRelativeToUnixEpoch)).toBe(true);

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

	// Ensure that these are still avaiable even after track backing hydration
	expect(videoDescriptors[0]!.displayWidth).toBe(1280);
	expect(videoDescriptors[0]!.displayHeight).toBe(720);
	expect(videoDescriptors[1]!.displayWidth).toBe(320);
	expect(videoDescriptors[1]!.displayHeight).toBe(184);
	expect(videoDescriptors[2]!.displayWidth).toBe(512);
	expect(videoDescriptors[2]!.displayHeight).toBe(288);
	expect(videoDescriptors[3]!.displayWidth).toBe(848);
	expect(videoDescriptors[3]!.displayHeight).toBe(480);
	expect(videoDescriptors[4]!.displayWidth).toBe(1920);
	expect(videoDescriptors[4]!.displayHeight).toBe(1080);

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

	const primaryVideoTrack = await input.getPrimaryVideoTrack();
	const primaryAudioTrack = await input.getPrimaryAudioTrack();

	assert(primaryVideoTrack);
	assert(primaryAudioTrack);

	// Since they're the highest-bitrate option
	expect(primaryVideoTrack).toBe(videoTracks[4]);
	expect(primaryAudioTrack).toBe(audioTracks[4]);
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
	expect(audioTrack.isAudioTrack()).toBe(true);
	expect(audioTrack.codec).toBe('aac');

	const videoTrack = tracks[1] as InputVideoTrack;
	expect(videoTrack.isVideoTrack()).toBe(true);
	expect(videoTrack.codec).toBe('avc');
});

test.concurrent('Codec-less (underspecified) master playlist', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://test-streams.mux.dev/test_001/stream.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const descriptors = await input.getTrackDescriptors();
	expect(descriptors).toHaveLength(12);

	const codecs = new Set(descriptors.map(x => x.codec));
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

	expect(sourceCount).toBe(3); // Entry, first segment, and encryption key
});

test.concurrent('Out-of-band audio track via ADTS', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const descriptors = await input.getTrackDescriptors();
	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.hasOnlyKeyPackets)).toBe(true);

	const audioDescriptor = descriptors.find(x => x.isAudioTrackDescriptor());
	assert(audioDescriptor);
	expect(audioDescriptor.hasOnlyKeyPackets).toBe(true);

	expect(await audioDescriptor.getPairableVideoTrackDescriptors()).toHaveLength(1); // Since the I-frame one isn't pairable
	const videoTrack = await (await audioDescriptor.getPairableVideoTrackDescriptors())[0]!.getTrack();
	assert(videoTrack);
	expect(videoTrack.hasOnlyKeyPackets).toBe(false);

	const audioTrack = await audioDescriptor.getTrack();
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

	const audioDescriptor = (await input.getAudioTrackDescriptors())[0];
	assert(audioDescriptor);
	expect(audioDescriptor.codec).toBe('mp3');
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

	const audioDescriptors = await input.getAudioTrackDescriptors();

	expect(audioDescriptors).toHaveLength(6);

	expect(audioDescriptors[0]!.languageCode).toBe('en');
	expect(audioDescriptors[1]!.languageCode).toBe('de');
	expect(audioDescriptors[2]!.languageCode).toBe('it');
	expect(audioDescriptors[3]!.languageCode).toBe('fr');
	expect(audioDescriptors[4]!.languageCode).toBe('es');
	expect(audioDescriptors[5]!.languageCode).toBe('en');

	expect(audioDescriptors[0]!.disposition!.primary).toBe(true);
	expect(audioDescriptors[1]!.disposition!.primary).toBe(false);
	expect(audioDescriptors[2]!.disposition!.primary).toBe(false);
	expect(audioDescriptors[3]!.disposition!.primary).toBe(false);
	expect(audioDescriptors[4]!.disposition!.primary).toBe(false);
	expect(audioDescriptors[5]!.disposition!.primary).toBe(false);

	expect(audioDescriptors[0]!.disposition!.default).toBe(true);
	expect(audioDescriptors[1]!.disposition!.default).toBe(true);
	expect(audioDescriptors[2]!.disposition!.default).toBe(true);
	expect(audioDescriptors[3]!.disposition!.default).toBe(true);
	expect(audioDescriptors[4]!.disposition!.default).toBe(true);
	expect(audioDescriptors[5]!.disposition!.default).toBe(false);

	expect(audioDescriptors[0]!.name).toBe('stream_5');
	expect(audioDescriptors[1]!.name).toBe('stream_4');
	expect(audioDescriptors[2]!.name).toBe('stream_8');
	expect(audioDescriptors[3]!.name).toBe('stream_7');
	expect(audioDescriptors[4]!.name).toBe('stream_9');
	expect(audioDescriptors[5]!.name).toBe('stream_6');
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

	const descriptors = await input.getTrackDescriptors();
	expect(descriptors.filter(x => x.isVideoTrackDescriptor())).toHaveLength(6);
	expect(descriptors.filter(x => x.isAudioTrackDescriptor())).toHaveLength(1);

	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.displayWidth === 320 && x.displayHeight === 180)).toBe(true);
	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.displayWidth === 480 && x.displayHeight === 270)).toBe(true);
	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.displayWidth === 640 && x.displayHeight === 360)).toBe(true);
	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.displayWidth === 960 && x.displayHeight === 540)).toBe(true);
	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.displayWidth === 1280 && x.displayHeight === 720)).toBe(true);
	expect(descriptors.some(x => x.isVideoTrackDescriptor() && x.displayWidth === 1920 && x.displayHeight === 1080)).toBe(true);

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
	expect(tracks.every(x => x.isRelativeToUnixEpoch)).toBe(true);

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

	expect(audioTrack.isRelativeToUnixEpoch).toBe(false);
});

test.concurrent('Alternative audio only', { timeout: 15_000 }, async () => {
	using input = new Input({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/alt-audio-no-video/sintel/playlist.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const descriptors = await input.getTrackDescriptors();
	expect(descriptors).toHaveLength(2);

	expect(descriptors[0]).toMatchObject({ type: 'audio', languageCode: 'en', name: 'English' });
	expect(descriptors[1]).toMatchObject({ type: 'audio', languageCode: 'dubbing', name: 'Dubbing' });
});

test.concurrent('Advanced Apple HLS', { timeout: 30_000 }, async () => {
	using input = new Input({
		entryPath: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8',
		source: ({ path }) => new UrlSource(path),
		formats: ALL_FORMATS,
	});

	const descriptors = await input.getTrackDescriptors();
	const videoDescriptors = descriptors.filter(x => x.isVideoTrackDescriptor());
	const audioDescriptors = descriptors.filter(x => x.isAudioTrackDescriptor());

	expect(audioDescriptors).toHaveLength(3);
	expect(videoDescriptors).toHaveLength(28);

	expect(audioDescriptors[0]).toMatchObject({ codec: 'aac', name: 'English', languageCode: 'en' });
	expect(audioDescriptors[1]).toMatchObject({ codec: 'ac3', name: 'English', languageCode: 'en' });
	expect(audioDescriptors[2]).toMatchObject({ codec: 'eac3', name: 'English', languageCode: 'en' });

	expect(audioDescriptors[0]!.codecParameterString).toBe('mp4a.40.2');
	expect(audioDescriptors[1]!.codecParameterString).toBe('ac-3');
	expect(audioDescriptors[2]!.codecParameterString).toBe('ec-3');

	expect(await audioDescriptors[0]!.getPairableVideoTrackDescriptors()).toHaveLength(18);
	expect(await audioDescriptors[1]!.getPairableVideoTrackDescriptors()).toHaveLength(18);
	expect(await audioDescriptors[2]!.getPairableVideoTrackDescriptors()).toHaveLength(18);

	// I-FRAME AVC

	expect(videoDescriptors[0]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 1015727, hasOnlyKeyPackets: true });
	expect(videoDescriptors[1]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 760174, hasOnlyKeyPackets: true });
	expect(videoDescriptors[2]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 520162, hasOnlyKeyPackets: true });
	expect(videoDescriptors[3]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 186651, hasOnlyKeyPackets: true });
	expect(videoDescriptors[4]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 95410, hasOnlyKeyPackets: true });

	expect(videoDescriptors[0]!.codecParameterString).toBe('avc1.640028');
	expect(videoDescriptors[1]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[2]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[3]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[4]!.codecParameterString).toBe('avc1.64001f');

	for (let i = 0; i <= 4; i++) {
		const videoDescriptor = videoDescriptors[i]!;
		expect(audioDescriptors.some(x => x.canBePairedWith(videoDescriptor))).toBe(false);
	}

	// AVC

	expect(videoDescriptors[5]).toMatchObject({ codec: 'avc', displayWidth: 960, displayHeight: 540, bitrate: 2746096, hasOnlyKeyPackets: false });
	expect(videoDescriptors[6]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 10095767, hasOnlyKeyPackets: false });
	expect(videoDescriptors[7]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 7540836, hasOnlyKeyPackets: false });
	expect(videoDescriptors[8]).toMatchObject({ codec: 'avc', displayWidth: 1920, displayHeight: 1080, bitrate: 5644219, hasOnlyKeyPackets: false });
	expect(videoDescriptors[9]).toMatchObject({ codec: 'avc', displayWidth: 1280, displayHeight: 720, bitrate: 3833756, hasOnlyKeyPackets: false });
	expect(videoDescriptors[10]).toMatchObject({ codec: 'avc', displayWidth: 768, displayHeight: 432, bitrate: 1698402, hasOnlyKeyPackets: false });
	expect(videoDescriptors[11]).toMatchObject({ codec: 'avc', displayWidth: 640, displayHeight: 360, bitrate: 1240204, hasOnlyKeyPackets: false });
	expect(videoDescriptors[12]).toMatchObject({ codec: 'avc', displayWidth: 480, displayHeight: 270, bitrate: 805319, hasOnlyKeyPackets: false });
	expect(videoDescriptors[13]).toMatchObject({ codec: 'avc', displayWidth: 416, displayHeight: 234, bitrate: 561903, hasOnlyKeyPackets: false });

	expect(videoDescriptors[5]!.codecParameterString).toBe('avc1.640020');
	expect(videoDescriptors[6]!.codecParameterString).toBe('avc1.64002a');
	expect(videoDescriptors[7]!.codecParameterString).toBe('avc1.64002a');
	expect(videoDescriptors[8]!.codecParameterString).toBe('avc1.64002a');
	expect(videoDescriptors[9]!.codecParameterString).toBe('avc1.640020');
	expect(videoDescriptors[10]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[11]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[12]!.codecParameterString).toBe('avc1.64001f');
	expect(videoDescriptors[13]!.codecParameterString).toBe('avc1.64001f');

	for (let i = 5; i <= 13; i++) {
		const videoDescriptor = videoDescriptors[i]!;
		expect(audioDescriptors.every(x => x.canBePairedWith(videoDescriptor))).toBe(true);
	}

	// I-FRAME HEVC

	expect(videoDescriptors[14]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 328352, hasOnlyKeyPackets: true });
	expect(videoDescriptors[15]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 226274, hasOnlyKeyPackets: true });
	expect(videoDescriptors[16]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 159037, hasOnlyKeyPackets: true });
	expect(videoDescriptors[17]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 92800, hasOnlyKeyPackets: true });
	expect(videoDescriptors[18]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 51760, hasOnlyKeyPackets: true });

	expect(videoDescriptors[14]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[15]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[16]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[17]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[18]!.codecParameterString).toBe('hvc1.2.4.L123.B0');

	for (let i = 14; i <= 18; i++) {
		const videoDescriptor = videoDescriptors[i]!;
		expect(audioDescriptors.some(x => x.canBePairedWith(videoDescriptor))).toBe(false);
	}

	// HEVC

	expect(videoDescriptors[19]).toMatchObject({ codec: 'hevc', displayWidth: 960, displayHeight: 540, bitrate: 2386827, hasOnlyKeyPackets: false });
	expect(videoDescriptors[20]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 6886727, hasOnlyKeyPackets: false });
	expect(videoDescriptors[21]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 5650398, hasOnlyKeyPackets: false });
	expect(videoDescriptors[22]).toMatchObject({ codec: 'hevc', displayWidth: 1920, displayHeight: 1080, bitrate: 4302269, hasOnlyKeyPackets: false });
	expect(videoDescriptors[23]).toMatchObject({ codec: 'hevc', displayWidth: 1280, displayHeight: 720, bitrate: 2987200, hasOnlyKeyPackets: false });
	expect(videoDescriptors[24]).toMatchObject({ codec: 'hevc', displayWidth: 768, displayHeight: 432, bitrate: 1448754, hasOnlyKeyPackets: false });
	expect(videoDescriptors[25]).toMatchObject({ codec: 'hevc', displayWidth: 640, displayHeight: 360, bitrate: 1124269, hasOnlyKeyPackets: false });
	expect(videoDescriptors[26]).toMatchObject({ codec: 'hevc', displayWidth: 480, displayHeight: 270, bitrate: 771426, hasOnlyKeyPackets: false });
	expect(videoDescriptors[27]).toMatchObject({ codec: 'hevc', displayWidth: 416, displayHeight: 234, bitrate: 563212, hasOnlyKeyPackets: false });

	expect(videoDescriptors[19]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[20]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[21]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[22]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[23]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[24]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[25]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[26]!.codecParameterString).toBe('hvc1.2.4.L123.B0');
	expect(videoDescriptors[27]!.codecParameterString).toBe('hvc1.2.4.L123.B0');

	for (let i = 19; i <= 27; i++) {
		const videoDescriptor = videoDescriptors[i]!;
		expect(audioDescriptors.every(x => x.canBePairedWith(videoDescriptor))).toBe(true);
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
