import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedVideoPacketSource,
	Input,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	OutputFormat,
	Rotation,
	TransformationMatrix,
	VideoTrackMetadata,
} from '../../src/index.js';

const WIDTH = 1280;
const HEIGHT = 720;

test('MP4, no metadata', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 0, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('MP4, rotation', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 90, false, [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1]);
});

test('MP4, flip', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 0, true, [-1, 0, 0, 0, 1, 0, WIDTH, 0, 1]);
});

test('MP4, rotation with flip', async () => {
	await expectRoundTrip(new Mp4OutputFormat(), 270, true, [0, -1, 0, -1, 0, 0, HEIGHT, WIDTH, 1]);
});

test('Matroska, no metadata', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 0, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('Matroska, rotation', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 90, false, [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1]);
});

test('Matroska, flip', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 0, true, [-1, 0, 0, 0, 1, 0, WIDTH, 0, 1]);
});

test('Matroska, rotation with flip', async () => {
	await expectRoundTrip(new MkvOutputFormat(), 270, true, [0, -1, 0, -1, 0, 0, HEIGHT, WIDTH, 1]);
});

test('MP4, explicit matrix', async () => {
	await expectMatrixRoundTrip(new Mp4OutputFormat(), [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1], 90, false);
});

test('MP4, explicit matrix with flip', async () => {
	await expectMatrixRoundTrip(new Mp4OutputFormat(), [0, 1, 0, 1, 0, 0, 0, 0, 1], 90, true);
});

test('MP4, degenerate matrix', async () => {
	await expectMatrixRoundTrip(new Mp4OutputFormat(), [0, 0, 0, 0, 1, 0, 0, 0, 1], 0, false);
});

test('Matroska, explicit matrix', async () => {
	await expectMatrixRoundTrip(new MkvOutputFormat(), [0, 1, 0, -1, 0, 0, HEIGHT, 0, 1], 90, false);
});

test('Matroska, explicit matrix with flip', async () => {
	await expectMatrixRoundTrip(new MkvOutputFormat(), [0, 1, 0, 1, 0, 0, 0, 0, 1], 90, true);
});

test('Matroska, degenerate matrix', async () => {
	await expectMatrixRoundTrip(new MkvOutputFormat(), [0, 0, 0, 0, 1, 0, 0, 0, 1], 0, false);
});

const expectRoundTrip = async (
	format: OutputFormat,
	rotation: Rotation,
	flip: boolean,
	expectedMatrix: TransformationMatrix,
) => {
	const track = await roundTrip(format, {
		rotation,
		flip,
	});

	expect(await track.getRotation()).toBe(rotation);
	expect(await track.getFlip()).toBe(flip);
	expect(await track.getTransformationMatrix()).toEqual(expectedMatrix);

	const [expectedWidth, expectedHeight] = rotation % 180 === 0 ? [WIDTH, HEIGHT] : [HEIGHT, WIDTH];
	expect(await track.getDisplayWidth()).toBe(expectedWidth);
	expect(await track.getDisplayHeight()).toBe(expectedHeight);
};

const expectMatrixRoundTrip = async (
	format: OutputFormat,
	matrix: TransformationMatrix,
	expectedRotation: Rotation,
	expectedFlip: boolean,
) => {
	// Conflicting rotation and flip to prove the matrix takes precedence
	const track = await roundTrip(format, {
		rotation: 180,
		flip: !expectedFlip,
		transformationMatrix: matrix,
	});

	expect(await track.getRotation()).toBe(expectedRotation);
	expect(await track.getFlip()).toBe(expectedFlip);
	expect(await track.getTransformationMatrix()).toEqual(matrix);
};

const roundTrip = async (format: OutputFormat, metadata: VideoTrackMetadata) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, metadata);

	await output.start();
	for (let i = 0; i < 3; i++) {
		await source.add(
			new EncodedPacket(new Uint8Array(1024), i === 0 ? 'key' : 'delta', i * 0.1, 0.1),
			{
				decoderConfig: {
					codec: 'vp8',
					codedWidth: WIDTH,
					codedHeight: HEIGHT,
				},
			},
		);
	}
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	return track;
};
