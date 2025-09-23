import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink, VideoSampleSink } from '../../src/media-sink.js';

test('Can decode transparent video', async () => {
	using input = new Input({
		source: new UrlSource('/transparency.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new VideoSampleSink(videoTrack);
	const sample = (await sink.getSample(0.5))!;

	expect(sample.format).toContain('A'); // Probably RGBA

	const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
	const context = canvas.getContext('2d')!;

	sample.draw(context, 0, 0);

	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	expect(imageData.data[3]).toBeLessThan(255); // Check that there's actually transparent pixels
});

test('Can decode faulty transparent video and behaves gracefully', async () => {
	using input = new Input({
		source: new UrlSource('/transparency-faulty.webm'),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const packetSink = new EncodedPacketSink(videoTrack);
	const secondKeyPacket = (await packetSink.getNextKeyPacket((await packetSink.getFirstPacket())!))!;

	const sink = new VideoSampleSink(videoTrack);

	const startSample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;
	expect(startSample.format).toContain('A');

	const secondSample = (await sink.getSample(secondKeyPacket.timestamp))!;
	expect(secondSample.format).not.toContain('A'); // There was no alpha key frame for this one
});
