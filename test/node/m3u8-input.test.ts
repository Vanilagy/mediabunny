import { test } from 'vitest';
import { ManifestInput } from '../../src/manifest-input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_MANIFEST_FORMATS } from '../../src/manifest-input-format.js';
import { ALL_FORMATS, MPEG_TS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';
import { Input } from '../../src/input.js';

test('yo', { timeout: 60_000 }, async () => {
	/*
	const yo = new Input({
		source: new UrlSource('https://test-streams.mux.dev/x36xhzz/url_0/url_462/193039199_mp4_h264_aac_hd_7.ts'),
		formats: ALL_FORMATS,
	});

	const videoTrack = await yo.getPrimaryVideoTrack();
	const sink1 = new EncodedPacketSink(videoTrack!);

	console.log(sink1.getFirstPacket());

	for await (const packet of sink1.packets()) {
		console.log(performance.now(), packet.timestamp);
	}

	console.log('Don');

	return;

	*/
	const manifest = new ManifestInput({
		entryPath: 'https://playertest.longtailvideo.com/adaptive/aes-with-tracks/master.m3u8'
			?? 'https://playertest.longtailvideo.com/adaptive/customIV/prog_index.m3u8'
			?? 'https://playertest.longtailvideo.com/adaptive/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8'
			?? 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8'
			?? 'https://test-streams.mux.dev/x36xhzz/url_0/193039199_mp4_h264_aac_hd_7.m3u8'
			?? 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8'
			?? 'https://cdn.jwplayer.com/manifests/pZxWPRg4.m3u8'
			?? 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
			?? 'https://test-streams.mux.dev/x36xhzz/url_0/193039199_mp4_h264_aac_hd_7.m3u8',
		getSource: path => new UrlSource(path),
		manifestFormats: ALL_MANIFEST_FORMATS,
		mediaFormats: [MPEG_TS],
	});

	const variants = await manifest.getVariants();
	const variant = variants[1]!;
	const segment = await variant.getFirstSegment();
	const thing = await segment!.toInput();
	console.log(await thing.getTracks());
	/*

	const primaryVariant = (await manifest.getPrimaryVariant())!;
	const segment = (await primaryVariant.getFirstSegment())!;
	const thing = await segment.toInput();
	console.log(await thing.getTracks());
	*/

	return;

	for await (const segment of primaryVariant.segments()) {
		console.log(segment.relativeTimestamp, segment.initSegment?.relativeTimestamp);
	}

	return;

	const input = await manifest.toInput();
	const track = await input.getPrimaryVideoTrack();
	const sink = new EncodedPacketSink(track!);

	for await (const packet of sink.packets()) {
		console.log(packet.timestamp);
	}

	return;

	// const primaryVariant = (await manifest.getPrimaryVariant())!;

	for await (const segment of primaryVariant.segments()) {
		console.log(segment.location);
	}

	/*
	for await (const segment of primaryVariant.segments()) {
		const input = await segment.toInput();
		console.log(segment.path, segment.discontinuity, await input.getFirstTimestamp());
		continue;

		if (segment.path.endsWith('u-6400-m-720x408-1628-a-96-1-1.ts')) {
			const input = await segment.toInput();
			const track = (await input.getPrimaryVideoTrack())!;
			const timestamp = await track.getFirstTimestamp();
			console.log(timestamp, await track.getDecoderConfig());

			break;
		}
	}
	*/

	/*
	const segment = await primaryVariant.getFirstSegment();

	// console.log(segment);

	const input = primaryVariant.toInput();
	// console.log(input);

	// const tracks = await input.getTracks();
	const track = await input.getPrimaryVideoTrack();

	const sink = new EncodedPacketSink(track!);
	let currentPacket = await sink.getFirstPacket();

	while (currentPacket) {
		console.log(currentPacket.timestamp);
		currentPacket = await sink.getNextPacket(currentPacket);
	}
	*/
});
