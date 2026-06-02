import { expect, test } from 'vitest';
import { VideoSample } from '../../src/sample.js';
import { VideoSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { QUALITY_MEDIUM } from '../../src/encode.js';
import { PacketType } from '../../src/packet.js';

test('allocationSize', async () => {
	{
		const canvas = new OffscreenCanvas(1280, 720);
		canvas.getContext('2d');

		using sample = new VideoSample(canvas, { timestamp: 0 });

		const size1 = sample.allocationSize();
		expect(size1).toBe(1280 * 720 * 4);

		const size2 = sample.allocationSize({
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		expect(size2).toBe(1300 * 720 * 4);
	}

	{
		const data = new Uint8Array(1280 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
		});

		const size1 = sample.allocationSize();
		expect(size1).toBe(1280 * 720 * 4);

		const size2 = sample.allocationSize({
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		expect(size2).toBe(1300 * 720 * 4);
	}

	{
		const data = new Uint8Array(1280 * 720 * 1.5);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'I420',
		});

		const size1 = sample.allocationSize();
		expect(size1).toBe(1280 * 720 * 1.5);

		const size2 = sample.allocationSize({ format: 'RGBA' });
		expect(size2).toBe(1280 * 720 * 4);

		const size3 = sample.allocationSize({
			format: 'RGBA',
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		expect(size3).toBe(1300 * 720 * 4);
	}
});

test('copyTo and plane layouts', async () => {
	const buffer = new ArrayBuffer(1e7);

	{
		const canvas = new OffscreenCanvas(1280, 720);
		canvas.getContext('2d');

		using sample = new VideoSample(canvas, { timestamp: 0 });
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);
	}

	{
		const canvas = new OffscreenCanvas(1280, 720);
		canvas.getContext('2d');

		using sample = new VideoSample(canvas, { timestamp: 0 });
		const layout = await sample.copyTo(buffer, {
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});

		expect(layout).toEqual([{
			offset: 0,
			stride: 1300 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1280 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
		});
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1280 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
		});
		const layout = await sample.copyTo(buffer, {
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});

		expect(layout).toEqual([{
			offset: 0,
			stride: 1300 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1300 * 720 * 4);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'RGBA',
			layout: [{
				offset: 0,
				stride: 1300 * 4,
			}],
		});
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);

		using clone = sample.clone();
		const clonedLayout = await clone.copyTo(buffer);

		expect(clonedLayout).toEqual([{
			offset: 0,
			stride: 1280 * 4,
		}]);
	}

	{
		const data = new Uint8Array(1280 * 720 * 1.5);
		using sample = new VideoSample(data, {
			timestamp: 0,
			codedWidth: 1280,
			codedHeight: 720,
			format: 'I420',
		});
		const layout = await sample.copyTo(buffer);

		expect(layout).toEqual([{
			offset: 0,
			stride: 1280,
		}, {
			offset: 1280 * 720,
			stride: 1280 / 2,
		}, {
			offset: 1280 * 720 + (1280 / 2) * (720 / 2),
			stride: 1280 / 2,
		}]);

		const rgbLayout = await sample.copyTo(buffer, { format: 'RGBA' });

		expect(rgbLayout).toEqual([{
			offset: 0,
			stride: 4 * 1280,
		}]);
	}
});

test('RGB conversion for ArrayBuffer-backed data', async () => {
	// 2x2 RGBA image with distinct, easily-verifiable pixels
	const src = new Uint8Array([
		10, 20, 30, 255, 40, 50, 60, 255,
		70, 80, 90, 255, 100, 110, 120, 255,
	]);

	{
		// RGBA -> BGRA: R and B should swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		const layout = await sample.copyTo(dest, { format: 'BGRA' });

		expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}

	{
		// RGBA -> RGBA: no swap, bytes copied through unchanged
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'RGBA' });

		expect(Array.from(dest)).toEqual(Array.from(src));
	}

	{
		// RGBA -> BGRX: R and B should swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'BGRX' });

		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}

	{
		// BGRA -> RGBA: R and B should swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'BGRA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'RGBA' });

		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}

	{
		// BGRA -> BGRA: no swap
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'BGRA',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'BGRA' });

		expect(Array.from(dest)).toEqual(Array.from(src));
	}

	{
		// RGBX -> RGBA: X (whatever it is) becomes 255 to mean A
		const xSrc = new Uint8Array([
			10, 20, 30, 0, 40, 50, 60, 77,
			70, 80, 90, 128, 100, 110, 120, 200,
		]);

		using sample = new VideoSample(xSrc.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBX',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'RGBA' });

		expect(Array.from(dest)).toEqual([
			10, 20, 30, 255, 40, 50, 60, 255,
			70, 80, 90, 255, 100, 110, 120, 255,
		]);
	}

	{
		// RGBX -> BGRA: R and B swap, X becomes 255 to mean A
		const xSrc = new Uint8Array([
			10, 20, 30, 0, 40, 50, 60, 77,
			70, 80, 90, 128, 100, 110, 120, 200,
		]);

		using sample = new VideoSample(xSrc.slice(), {
			timestamp: 0,
			codedWidth: 2,
			codedHeight: 2,
			format: 'RGBX',
		});

		const dest = new Uint8Array(2 * 2 * 4);
		await sample.copyTo(dest, { format: 'BGRA' });

		expect(Array.from(dest)).toEqual([
			30, 20, 10, 255, 60, 50, 40, 255,
			90, 80, 70, 255, 120, 110, 100, 255,
		]);
	}
});

test('crop (rect option) for ArrayBuffer-backed data', async () => {
	// 4x4 RGBA image where each pixel's R/G channels encode (x, y)
	const width = 4;
	const height = 4;
	const src = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			src[i] = x;
			src[i + 1] = y;
			src[i + 2] = 0;
			src[i + 3] = 255;
		}
	}

	{
		// Crop a 2x2 region at (1, 1)
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: width,
			codedHeight: height,
			format: 'RGBA',
		});

		const size = sample.allocationSize({ rect: { x: 1, y: 1, width: 2, height: 2 } });
		expect(size).toBe(2 * 2 * 4);

		const dest = new Uint8Array(size);
		const layout = await sample.copyTo(dest, { rect: { x: 1, y: 1, width: 2, height: 2 } });

		expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
		expect(Array.from(dest)).toEqual([
			1, 1, 0, 255, 2, 1, 0, 255,
			1, 2, 0, 255, 2, 2, 0, 255,
		]);
	}

	{
		// Crop an offset rect at the top-right corner
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: width,
			codedHeight: height,
			format: 'RGBA',
		});

		const dest = new Uint8Array(2 * 1 * 4);
		const layout = await sample.copyTo(dest, { rect: { x: 2, y: 0, width: 2, height: 1 } });

		expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
		expect(Array.from(dest)).toEqual([
			2, 0, 0, 255, 3, 0, 0, 255,
		]);
	}

	{
		// Crop combined with a custom destination stride (padding between rows)
		using sample = new VideoSample(src.slice(), {
			timestamp: 0,
			codedWidth: width,
			codedHeight: height,
			format: 'RGBA',
		});

		const stride = 3 * 4; // wider than the crop, leaving trailing padding
		const dest = new Uint8Array(stride * 2);
		const layout = await sample.copyTo(dest, {
			rect: { x: 0, y: 2, width: 2, height: 2 },
			layout: [{ offset: 0, stride }],
		});

		expect(layout).toEqual([{ offset: 0, stride }]);
		// Row 0 of crop (y=2): pixels (0,2) and (1,2), then 4 bytes of untouched padding
		expect(Array.from(dest.subarray(0, 8))).toEqual([0, 2, 0, 255, 1, 2, 0, 255]);
		expect(Array.from(dest.subarray(stride, stride + 8))).toEqual([0, 3, 0, 255, 1, 3, 0, 255]);
	}
});

test('null format', async () => {
	const canvas = new OffscreenCanvas(1280, 720);
	canvas.getContext('2d');

	const frame = new VideoFrame(canvas, { timestamp: 0 });
	using sample = new VideoSample(frame);
	// @ts-expect-error Sybau
	sample.format = null;

	expect(() => sample.allocationSize()).toThrow('when format is null');
	await expect(async () => sample.copyTo(new ArrayBuffer())).rejects.toThrow('when format is null');

	// BUT: See https://github.com/Vanilagy/mediabunny/issues/267
	const size = sample.allocationSize({ format: 'RGBA' });
	expect(size).toBe(1280 * 720 * 4);
	const buffer = new ArrayBuffer(size);
	const layout = await sample.copyTo(buffer, { format: 'RGBA' });

	expect(layout).toEqual([{
		offset: 0,
		stride: 1280 * 4,
	}]);

	sample.allocationSize({ format: 'RGBX' });
	sample.allocationSize({ format: 'BGRA' });
	sample.allocationSize({ format: 'BGRX' });
	await sample.copyTo(buffer, { format: 'RGBX' });
	await sample.copyTo(buffer, { format: 'BGRA' });
	await sample.copyTo(buffer, { format: 'BGRX' });
});

test('encodeOptions', () => {
	const canvas = new OffscreenCanvas(100, 100);
	canvas.getContext('2d');

	// The default is an empty object
	using a = new VideoSample(canvas, { timestamp: 0 });
	expect(a.encodeOptions).toEqual({});

	// It can be overridden via the setter
	a.setEncodeOptions({ keyFrame: true });
	expect(a.encodeOptions).toEqual({ keyFrame: true });

	// Cloning carries the encode options over
	using aClone = a.clone();
	expect(aClone.encodeOptions).toEqual({ keyFrame: true });

	// It can be set via the constructor
	using b = new VideoSample(canvas, { timestamp: 0, encodeOptions: { keyFrame: true } });
	expect(b.encodeOptions).toEqual({ keyFrame: true });
});

test('encodeOptions, key frame forcing', async () => {
	const samples = Array.from({ length: 5 }, (_, i) => makeRedSample(i / 30, { keyFrame: true }));

	await encodeAndAssertPacketTypes(
		samples,
		['key', 'key', 'key', 'key', 'key'],
	);
});

test('encodeOptions add() override', async () => {
	const samples = Array.from({ length: 5 }, (_, i) => makeRedSample(i / 30, { keyFrame: true }));

	await encodeAndAssertPacketTypes(
		samples,
		['key', 'delta', 'delta', 'delta', 'delta'],
		samples.map(() => ({ keyFrame: false })),
	);
});

const makeRedSample = (timestamp: number, encodeOptions?: VideoEncoderEncodeOptions) => {
	const canvas = new OffscreenCanvas(100, 100);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 100, 100);

	return new VideoSample(canvas, {
		timestamp,
		duration: 1 / 30,
		encodeOptions,
	});
};

const encodeAndAssertPacketTypes = async (
	samples: VideoSample[],
	expectedPacketTypes: PacketType[],
	addOptions?: (VideoEncoderEncodeOptions | undefined)[],
) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	let i = 0;
	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		bitrate: QUALITY_MEDIUM,
		onEncodedPacket: packet => expect(packet.type).toBe(expectedPacketTypes[i++]),
	});
	output.addVideoTrack(videoSource);
	await output.start();

	for (let i = 0; i < samples.length; i++) {
		await videoSource.add(samples[i]!, addOptions?.[i]);
		samples[i]!.close();
	}

	await output.finalize();
};
