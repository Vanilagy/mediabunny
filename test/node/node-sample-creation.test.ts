import { expect, test } from 'vitest';
import {
	AudioSample,
	AudioSampleResource,
	VideoSample,
	VideoSampleColorSpace,
	VideoSampleInit,
	VideoSampleResource,
} from '../../src/sample.js';
import { SetRequired } from '../../src/misc.js';

test('VideoSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new VideoSample(bytes, {
		codedWidth: 1280,
		codedHeight: 720,
		format: 'RGBA',
		timestamp: 0,
	});

	sample.close();
});

test('AudioSample creation from bytes', async () => {
	const bytes = new Uint8Array(1024);
	const sample = new AudioSample({
		data: bytes,
		numberOfChannels: 2,
		format: 's16',
		sampleRate: 48000,
		timestamp: 0,
	});

	// The data is copied, so later changes to the bytes don't affect the sample
	bytes.fill(1);
	const out = new Uint8Array(1024);
	sample.copyTo(out, { planeIndex: 0 });
	expect(out.every(x => x === 0)).toBe(true);

	sample.close();
});

test('copyTo RGB conversion with custom destination layout', async () => {
	using sample = new VideoSample(new Uint8Array([
		1, 2, 3, 4, 5, 6, 7, 8,
		9, 10, 11, 12, 13, 14, 15, 16,
	]), {
		format: 'RGBX',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
	});

	// Offset and row padding of 2 bytes each, so the pixels don't line up with 4-byte boundaries
	const dest = new Uint8Array(2 + 2 * 10).fill(200);
	const layout = await sample.copyTo(dest, {
		format: 'BGRA',
		layout: [{ offset: 2, stride: 10 }],
	});

	expect(layout).toEqual([{ offset: 2, stride: 10 }]);
	expect([...dest]).toEqual([
		200, 200,
		3, 2, 1, 255, 7, 6, 5, 255, 200, 200,
		11, 10, 9, 255, 15, 14, 13, 255, 200, 200,
	]);
});

test('copyTo with visibleRect offset', async () => {
	using sample = makeCoordinateSample({ left: 1, top: 2, width: 2, height: 2 });

	const dest = new Uint8Array(sample.allocationSize());
	const layout = await sample.copyTo(dest);

	expect(layout).toEqual([{ offset: 0, stride: 2 * 4 }]);
	expect([...dest]).toEqual([
		1, 2, 0, 255, 2, 2, 0, 255,
		1, 3, 0, 255, 2, 3, 0, 255,
	]);

	// The rect lives in the coded pixel grid, just like the visible rect
	const pixel = new Uint8Array(4);
	await sample.copyTo(pixel, { rect: { x: 2, y: 3, width: 1, height: 1 } });
	expect([...pixel]).toEqual([2, 3, 0, 255]);
});

test('copyTo with visibleRect offset, I420', async () => {
	// 4x4 frame, chroma planes are 2x2
	const data = new Uint8Array([
		...Array.from({ length: 16 }, (_, i) => i),
		100, 101, 102, 103,
		200, 201, 202, 203,
	]);

	using sample = new VideoSample(data, {
		format: 'I420',
		codedWidth: 4,
		codedHeight: 4,
		visibleRect: { left: 2, top: 2, width: 2, height: 2 },
		timestamp: 0,
	});

	const dest = new Uint8Array(sample.allocationSize());
	const layout = await sample.copyTo(dest);

	expect(layout).toEqual([
		{ offset: 0, stride: 2 },
		{ offset: 4, stride: 1 },
		{ offset: 5, stride: 1 },
	]);
	expect([...dest]).toEqual([10, 11, 14, 15, 103, 203]);
});

const makeCoordinateSample = (visibleRect: { left: number; top: number; width: number; height: number }) => {
	// Each pixel's R/G channels encode its (x, y) position
	const data = new Uint8Array(4 * 4 * 4);
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			const i = 4 * (4 * y + x);
			data[i] = x;
			data[i + 1] = y;
			data[i + 3] = 255;
		}
	}

	return new VideoSample(data, {
		format: 'RGBA',
		codedWidth: 4,
		codedHeight: 4,
		visibleRect,
		timestamp: 0,
	});
};

test('resource closing after failed construction', () => {
	const resource = new TestVideoSampleResource();

	resource.squarePixelWidth = 0;
	expect(() => new VideoSample(resource, { timestamp: 0 })).toThrow(TypeError);

	resource.squarePixelWidth = 2;
	const sample = new VideoSample(resource, { timestamp: 0 });
	sample.close();

	expect(resource.closed).toBe(true);
});

class TestVideoSampleResource extends VideoSampleResource {
	squarePixelWidth = 2;
	closed = false;

	getFormat() {
		return 'RGBA' as const;
	}

	getCodedWidth() {
		return 2;
	}

	getCodedHeight() {
		return 2;
	}

	getSquarePixelWidth() {
		return this.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return 2;
	}

	getColorSpace() {
		return new VideoSampleColorSpace();
	}

	getDataPlanes() {
		return [{ data: new Uint8Array(2 * 2 * 4), stride: 2 * 4 }];
	}

	toRgbSample(init: SetRequired<VideoSampleInit, 'timestamp'>) {
		return new VideoSample(this, init);
	}

	close() {
		this.closed = true;
	}
}

test('AudioSample from a bare SharedArrayBuffer', () => {
	const buffer = new SharedArrayBuffer(8);
	new Int16Array(buffer).set([1, 2, 3, 4]);

	using sample = new AudioSample({
		data: buffer,
		format: 's16',
		numberOfChannels: 2,
		sampleRate: 48000,
		timestamp: 0,
	});
	expect(sample.numberOfFrames).toBe(2);

	const out = new Int16Array(4);
	sample.copyTo(out, { planeIndex: 0 });
	expect([...out]).toEqual([1, 2, 3, 4]);
});

test('AudioSample with a negative channel count', () => {
	expect(() => new AudioSample({
		data: new Uint8Array(8),
		format: 's16',
		numberOfChannels: -2,
		sampleRate: 48000,
		timestamp: 0,
	})).toThrow(TypeError);
});

test('AudioSample from a resource with an invalid sample rate', () => {
	let sampleRate = 0;
	let closeCount = 0;

	class Resource extends AudioSampleResource {
		getFormat() {
			return 'f32' as const;
		}

		getSampleRate() {
			return sampleRate;
		}

		getNumberOfFrames() {
			return 1024;
		}

		getNumberOfChannels() {
			return 1;
		}

		getTimestamp() {
			return 0;
		}

		close() {
			closeCount++;
		}

		getDataPlane() {
			return new Uint8Array(4 * 1024);
		}
	}

	const resource = new Resource();
	expect(() => new AudioSample(resource)).toThrow('getSampleRate()');

	// The failed construction mustn't hold on to the resource
	sampleRate = 48000;
	new AudioSample(resource).close();
	expect(closeCount).toBe(1);
});

test('VideoSample copy with an odd width and subsampled chroma', async () => {
	// 3x3 I420: a 3x3 luma plane followed by two 2x2 chroma planes
	const data = new Uint8Array(9 + 4 + 4);
	for (let i = 0; i < data.length; i++) {
		data[i] = i + 1;
	}

	using sample = new VideoSample(data, {
		format: 'I420',
		codedWidth: 3,
		codedHeight: 3,
		timestamp: 0,
	});
	expect(sample.allocationSize()).toBe(data.byteLength);

	const out = new Uint8Array(data.byteLength);
	const layout = await sample.copyTo(out);
	expect(layout).toEqual([
		{ offset: 0, stride: 3 },
		{ offset: 9, stride: 2 },
		{ offset: 13, stride: 2 },
	]);
	expect(out).toEqual(data);

	// A one pixel wide column still covers one chroma sample per row
	const rect = { x: 2, y: 0, width: 1, height: 1 };
	expect(sample.allocationSize({ rect })).toBe(3);

	const rectOut = new Uint8Array(3);
	await sample.copyTo(rectOut, { rect });
	expect([...rectOut]).toEqual([3, 11, 15]);
});

test('Copying an empty AudioSample', () => {
	using sample = new AudioSample({
		data: new Float32Array(0),
		format: 'f32',
		numberOfChannels: 2,
		sampleRate: 48000,
		timestamp: 0,
	});

	expect(sample.allocationSize({ planeIndex: 0 })).toBe(0);
	sample.copyTo(new Uint8Array(0), { planeIndex: 0 });

	expect(sample.allocationSize({ planeIndex: 1, format: 's16-planar' })).toBe(0);
	sample.copyTo(new Uint8Array(0), { planeIndex: 1, format: 's16-planar' });
});

test('VideoSample with a layout of the wrong plane count', () => {
	expect(() => new VideoSample(new Uint8Array(24), {
		format: 'I420',
		codedWidth: 4,
		codedHeight: 4,
		timestamp: 0,
		layout: [{ offset: 0, stride: 4 }],
	})).toThrow(TypeError);
});

test('VideoSample with an empty visibleRect', () => {
	for (const visibleRect of [
		{ left: 0, top: 0, width: 0, height: 2 },
		{ left: 0, top: 0, width: 2, height: 0 },
	]) {
		expect(() => new VideoSample(new Uint8Array(16), {
			format: 'RGBA',
			codedWidth: 2,
			codedHeight: 2,
			timestamp: 0,
			visibleRect,
		})).toThrow(TypeError);
	}
});

test('copyTo with a rect lacking a size', async () => {
	using sample = new VideoSample(new Uint8Array(16), {
		format: 'RGBA',
		codedWidth: 2,
		codedHeight: 2,
		timestamp: 0,
	});

	await expect(sample.copyTo(new Uint8Array(16), { rect: { x: 0, y: 0 } })).rejects.toThrow(TypeError);
	expect(() => sample.allocationSize({ rect: { x: 0, y: 0, width: 2 } })).toThrow(TypeError);
});
