import { expect, test } from 'vitest';
import { VideoSample } from '../../src/sample.js';

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
			stride: 1300 * 4,
		}]);

		using clone = sample.clone();
		const clonedLayout = await clone.copyTo(buffer);

		expect(clonedLayout).toEqual([{
			offset: 0,
			stride: 1300 * 4,
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
