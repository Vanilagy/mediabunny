import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { HlsOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { CanvasSource } from '../../src/media-source.js';
import { QUALITY_HIGH } from '../../src/encode.js';

test('HLS output, key frames aligning with segment boundaries by default', async () => {
	let playlistText: string | null = null;

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { playlistText = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const canvas = new OffscreenCanvas(640, 480);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff0000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const videoSource = new CanvasSource(canvas, {
		codec: 'avc',
		bitrate: QUALITY_HIGH,
	});
	output.addVideoTrack(videoSource);

	await output.start();

	const fps = 2;
	const frameDuration = 1 / fps;
	const totalFrames = 10 * fps;
	for (let i = 0; i < totalFrames; i++) {
		await videoSource.add(i * frameDuration, frameDuration);
	}

	await output.finalize();

	expect(playlistText).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts
#EXTINF:2,
segment-1-5.ts

#EXT-X-ENDLIST
`);
});
