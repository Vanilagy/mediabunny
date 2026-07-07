import { expect, test } from 'vitest';
import path from 'node:path';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
	PacketCursor,
} from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const cursor = new PacketCursor(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of cursor) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});
