import { expect, test } from 'vitest';
import { VideoSample } from '../../src/sample.js';

const createCanvas = () => {
	const canvas = document.createElement('canvas');
	canvas.width = 300;
	canvas.height = 150;

	const ctx = canvas.getContext('2d')!;

	ctx.fillStyle = '#0000ff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	ctx.fillStyle = '#ff0000';
	ctx.fillRect(0, 0, 100, 50);

	return canvas;
};

type Color = {
	r: number;
	g: number;
	b: number;
};

const colorDistance = (c1: Color, c2: Color) => {
	return Math.hypot(c1.r - c2.r, c1.g - c2.g, c1.b - c2.b);
};

const sampleCanvasColor = (ctx: CanvasRenderingContext2D, x: number, y: number): Color => {
	const pixel = ctx.getImageData(x, y, 1, 1).data;

	return {
		r: pixel[0]!,
		g: pixel[1]!,
		b: pixel[2]!,
	};
};

test('Can create VideoSample from VideoFrame and modify rotation', () => {
	const frame = new VideoFrame(createCanvas(), { timestamp: 0 });
	using sample = new VideoSample(frame);

	expect(frame.rotation).toBe(0);
	expect(sample.rotation).toBe(0);

	const canvas = document.createElement('canvas');
	canvas.width = 300;
	canvas.height = 150;
	const ctx = canvas.getContext('2d')!;

	sample.draw(ctx, 0, 0);

	expect(colorDistance(sampleCanvasColor(ctx, 5, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 5, 55), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 110, 5), { r: 0, g: 0, b: 255 })).toBeLessThan(10);

	using rotated = sample.clone({ rotation: 90 });
	expect(rotated.rotation).toBe(90);

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	rotated.draw(ctx, 0, 0);

	expect(colorDistance(sampleCanvasColor(ctx, 145, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 95, 5), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 145, 110), { r: 0, g: 0, b: 255 })).toBeLessThan(10);

	const extracted = rotated.toVideoFrame();
	expect(extracted.rotation).toBe(90); // It was changed

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	rotated.drawWithFit(ctx, { fit: 'fill' });

	expect(colorDistance(sampleCanvasColor(ctx, 295, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 295, 55), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
});

test('Can create VideoSample from rotated VideoFrame', () => {
	const frame = new VideoFrame(createCanvas(), { timestamp: 0, rotation: 90 });
	using sample = new VideoSample(frame);

	expect(frame.rotation).toBe(90);
	expect(sample.rotation).toBe(90);

	const canvas = document.createElement('canvas');
	canvas.width = 300;
	canvas.height = 150;
	const ctx = canvas.getContext('2d')!;

	sample.draw(ctx, 0, 0);

	expect(colorDistance(sampleCanvasColor(ctx, 145, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 95, 5), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 145, 110), { r: 0, g: 0, b: 255 })).toBeLessThan(10);

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	sample.drawWithFit(ctx, { fit: 'fill' });

	expect(colorDistance(sampleCanvasColor(ctx, 295, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 295, 55), { r: 0, g: 0, b: 255 })).toBeLessThan(10);

	using unrotated = sample.clone({ rotation: 0 });
	expect(unrotated.rotation).toBe(0);

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	unrotated.draw(ctx, 0, 0);

	expect(colorDistance(sampleCanvasColor(ctx, 5, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 5, 55), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 110, 5), { r: 0, g: 0, b: 255 })).toBeLessThan(10);

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	unrotated.drawWithFit(ctx, { fit: 'fill' });

	expect(colorDistance(sampleCanvasColor(ctx, 5, 5), { r: 255, g: 0, b: 0 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 5, 55), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
	expect(colorDistance(sampleCanvasColor(ctx, 110, 5), { r: 0, g: 0, b: 255 })).toBeLessThan(10);
});
