import { expect, test } from 'vitest';
import { Conversion } from '../../src/conversion.js';
import { ALL_FORMATS, MATROSKA, MP4, MPEG_TS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { VideoSampleSink } from '../../src/media-sink.js';
import { assert, Rational } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { MkvOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

const SOURCE_PATH = '/sar_2x1.mp4';

test('Pixel aspect ratio reading', async () => {
	using input = new Input({
		source: new UrlSource(SOURCE_PATH),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(await videoTrack.getRotation()).toBe(0);
	expectPar2x1Geometry(await snapshotTrack(videoTrack));

	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.displayAspectWidth).toBe(await videoTrack.getSquarePixelWidth());
	expect(decoderConfig.displayAspectHeight).toBe(await videoTrack.getSquarePixelHeight());

	const sink = new VideoSampleSink(videoTrack);
	using sample = (await sink.getSample(await videoTrack.getFirstTimestamp()))!;

	expect(sample.rotation).toBe(0);
	expect(sample.visibleRect.width).toBe(sample.codedWidth);
	expect(sample.visibleRect.height).toBe(sample.codedHeight);
	expect(sample.codedWidth).toBe(await videoTrack.getCodedWidth());
	expect(sample.codedHeight).toBe(await videoTrack.getCodedHeight());
	expectPar2x1Geometry(sample);
	expect(sample.squarePixelWidth).toBe(await videoTrack.getSquarePixelWidth());
	expect(sample.squarePixelHeight).toBe(await videoTrack.getSquarePixelHeight());
});

test('Pixel aspect ratio copy conversion', async () => {
	using input = new Input({
		source: new UrlSource(SOURCE_PATH),
		formats: ALL_FORMATS,
	});

	const sourceTrack = await input.getPrimaryVideoTrack();
	assert(sourceTrack);
	const expected = await snapshotTrack(sourceTrack);
	expectPar2x1Geometry(expected);

	const mkv = await convertAndReadVideoTrack(new MkvOutputFormat());
	expect(mkv.format).toBe(MATROSKA);
	expectPar2x1Geometry(mkv.snapshot);
	expect(mkv.snapshot).toEqual(expected);

	const ts = await convertAndReadVideoTrack(new MpegTsOutputFormat());
	expect(ts.format).toBe(MPEG_TS);
	expectPar2x1Geometry(ts.snapshot);
	expect(ts.snapshot).toEqual(expected);
});

test('Pixel aspect ratio transcode conversion', async () => {
	using input = new Input({
		source: new UrlSource(SOURCE_PATH),
		formats: ALL_FORMATS,
	});

	const sourceTrack = await input.getPrimaryVideoTrack();
	assert(sourceTrack);
	const source = await snapshotTrack(sourceTrack);
	expectPar2x1Geometry(source);

	const mp4 = await convertAndReadVideoTrack(
		new Mp4OutputFormat(),
		true,
	);

	expect(mp4.format).toBe(MP4);
	expect(mp4.snapshot.pixelAspectRatio).toEqual({ num: 1, den: 1 });
	expect(mp4.snapshot.squarePixelWidth).toBe(mp4.snapshot.codedWidth);
	expect(mp4.snapshot.squarePixelHeight).toBe(mp4.snapshot.codedHeight);
	expect(mp4.snapshot.displayWidth).toBe(mp4.snapshot.codedWidth);
	expect(mp4.snapshot.displayHeight).toBe(mp4.snapshot.codedHeight);
	expect(mp4.snapshot.decoderDisplayAspectWidth).toBeUndefined();
	expect(mp4.snapshot.decoderDisplayAspectHeight).toBeUndefined();

	expect(mp4.snapshot.codedWidth).toBe(source.squarePixelWidth);
	expect(mp4.snapshot.codedHeight).toBe(source.squarePixelHeight);
	expect(mp4.snapshot.displayWidth).toBe(source.displayWidth);
	expect(mp4.snapshot.displayHeight).toBe(source.displayHeight);
});

const expectPar2x1Geometry = (value: {
	codedWidth: number;
	codedHeight: number;
	squarePixelWidth: number;
	squarePixelHeight: number;
	displayWidth: number;
	displayHeight: number;
	pixelAspectRatio: Rational;
}) => {
	expect(value.pixelAspectRatio).toEqual({ num: 2, den: 1 });
	expect(value.squarePixelWidth).toBe(value.codedWidth * 2);
	expect(value.squarePixelHeight).toBe(value.codedHeight);
	expect(value.displayWidth).toBe(value.squarePixelWidth);
	expect(value.displayHeight).toBe(value.squarePixelHeight);
};

const snapshotTrack = async (track: {
	getCodedWidth(): Promise<number>;
	getCodedHeight(): Promise<number>;
	getSquarePixelWidth(): Promise<number>;
	getSquarePixelHeight(): Promise<number>;
	getDisplayWidth(): Promise<number>;
	getDisplayHeight(): Promise<number>;
	getRotation(): Promise<number>;
	getPixelAspectRatio(): Promise<Rational>;
	getDecoderConfig(): Promise<VideoDecoderConfig | null>;
}) => {
	const [
		decoderConfig,
		pixelAspectRatio,
		codedWidth,
		codedHeight,
		squarePixelWidth,
		squarePixelHeight,
		displayWidth,
		displayHeight,
		rotation,
	] = await Promise.all([
		track.getDecoderConfig(),
		track.getPixelAspectRatio(),
		track.getCodedWidth(),
		track.getCodedHeight(),
		track.getSquarePixelWidth(),
		track.getSquarePixelHeight(),
		track.getDisplayWidth(),
		track.getDisplayHeight(),
		track.getRotation(),
	]);
	assert(decoderConfig);

	return {
		codedWidth,
		codedHeight,
		squarePixelWidth,
		squarePixelHeight,
		displayWidth,
		displayHeight,
		rotation,
		pixelAspectRatio,
		decoderDisplayAspectWidth: decoderConfig.displayAspectWidth,
		decoderDisplayAspectHeight: decoderConfig.displayAspectHeight,
	};
};

const convertAndReadVideoTrack = async (
	format: MkvOutputFormat | MpegTsOutputFormat | Mp4OutputFormat,
	forceTranscode = false,
) => {
	using input = new Input({
		source: new UrlSource(SOURCE_PATH),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			forceTranscode,
		},
		trim: {
			end: 1,
		},
	});
	expect(conversion.isValid).toBe(true);
	await conversion.execute();

	const buffer = output.target.buffer;
	assert(buffer);

	using outputInput = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = await outputInput.getPrimaryVideoTrack();
	assert(track);

	return {
		format: await outputInput.getFormat(),
		snapshot: await snapshotTrack(track),
	};
};
