import { expect, test } from 'vitest';
import {
	VideoSampleResource,
	VideoSampleColorSpace,
	VideoSample,
	AudioSampleResource,
	AudioSample,
	VideoDataPlane,
	VideoSampleInit,
} from '../../src/sample.js';
import { MaybePromise, SetRequired, toUint8Array } from '../../src/misc.js';

class ImageVideoSampleResource extends VideoSampleResource {
	constructor(public image: HTMLImageElement | null) {
		super();
	}

	getFormat(): VideoPixelFormat {
		return 'RGBA';
	}

	getCodedWidth() {
		return this.image!.width;
	}

	getCodedHeight() {
		return this.image!.height;
	}

	getSquarePixelWidth() {
		return this.image!.width;
	}

	getSquarePixelHeight() {
		return this.image!.height;
	}

	getColorSpace() {
		return new VideoSampleColorSpace({
			matrix: 'rgb',
			primaries: 'bt709',
			transfer: 'iec61966-2-1',
			fullRange: true,
		});
	}

	getDataPlanes(): MaybePromise<VideoDataPlane[]> {
		const canvas = new OffscreenCanvas(this.image!.width, this.image!.height);
		const ctx = canvas.getContext('2d')!;

		ctx.drawImage(this.image!, 0, 0);

		const imageData = ctx.getImageData(0, 0, this.image!.width, this.image!.height);

		return [{
			data: toUint8Array(imageData.data),
			stride: this.image!.width * 4,
		}];
	}

	toRgbSample(
		init: SetRequired<VideoSampleInit, 'timestamp'>,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		format: 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX',
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		colorSpace: PredefinedColorSpace,
	): MaybePromise<VideoSample> {
		return new VideoSample(this, init);
	}

	close() {
		this.image = null;
	}
}

test('Custom VideoSample resource usage', async () => {
	const image = new Image();
	image.src = '/red-image.png';
	await image.decode();

	const resource = new ImageVideoSampleResource(image);
	const sample = new VideoSample(resource, { timestamp: 0 });
	expect(sample.format).toBe('RGBA');
	expect(sample.codedWidth).toBe(2048);
	expect(sample.codedHeight).toBe(2048);
	expect(sample.colorSpace).toEqual({
		matrix: 'rgb',
		primaries: 'bt709',
		transfer: 'iec61966-2-1',
		fullRange: true,
	});

	const videoFrame = sample.toVideoFrame();
	const canvas = new OffscreenCanvas(1024, 1024);
	const context = canvas.getContext('2d')!;
	context.drawImage(videoFrame, 0, 0);
	const imageData = context.getImageData(0, 0, 1024, 1024);
	expect([...imageData.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);

	videoFrame.close();

	const size = sample.allocationSize();
	expect(size).toBe(2048 * 2048 * 4);

	const buf = new ArrayBuffer(size);
	await sample.copyTo(buf);
	await sample.copyTo(buf, { format: 'RGBX' });
	await sample.copyTo(buf, { format: 'BGRA' });
	await sample.copyTo(buf, { format: 'BGRX' });

	const clone = sample.clone();
	sample.close();
	expect(resource.image).not.toBe(null);

	clone.close();
	expect(resource.image).toBe(null);
});

test('Custom VideoSample resource, invalid construction', async () => {
	const image = new Image();
	image.src = '/red-image.png';
	await image.decode();

	const resource = new ImageVideoSampleResource(image);
	// @ts-expect-error Wrong
	expect(() => new VideoSample(resource)).toThrow(TypeError);
	// @ts-expect-error Wrong
	expect(() => new VideoSample(resource, { duration: 0 })).toThrow(TypeError);
});

class AudioBufferAudioSampleResource extends AudioSampleResource {
	constructor(
		public audioBuffer: AudioBuffer | null,
		public timestamp: number,
	) {
		super();
	}

	getFormat(): AudioSampleFormat {
		return 'f32-planar';
	}

	getSampleRate() {
		return this.audioBuffer!.sampleRate;
	}

	getNumberOfFrames() {
		return this.audioBuffer!.length;
	}

	getNumberOfChannels() {
		return this.audioBuffer!.numberOfChannels;
	}

	getTimestamp() {
		return this.timestamp;
	}

	getDataPlane(planeIndex: number): Uint8Array {
		const data = this.audioBuffer!.getChannelData(planeIndex);
		return toUint8Array(data);
	}

	close() {
		this.audioBuffer = null;
	}
}

test('Custom AudioSample resource usage', async () => {
	const audioContext = new AudioContext();
	const audioBuffer = audioContext.createBuffer(2, 48000, 48000);

	const leftChannel = audioBuffer.getChannelData(0);
	const rightChannel = audioBuffer.getChannelData(1);
	for (let i = 0; i < 48000; i++) {
		const t = i / 48000;
		leftChannel[i] = Math.sin(2 * Math.PI * 440 * t);
		rightChannel[i] = Math.cos(2 * Math.PI * 440 * t);
	}

	const resource = new AudioBufferAudioSampleResource(audioBuffer, 0);
	const sample = new AudioSample(resource);

	expect(sample.format).toBe('f32-planar');
	expect(sample.sampleRate).toBe(48000);
	expect(sample.numberOfFrames).toBe(48000);
	expect(sample.numberOfChannels).toBe(2);
	expect(sample.timestamp).toBe(0);
	expect(sample.duration).toBeCloseTo(1);

	const size1 = sample.allocationSize({ planeIndex: 0 });
	const size2 = sample.allocationSize({ planeIndex: 1 });
	expect(size1).toBe(48000 * 4);
	expect(size2).toBe(48000 * 4);

	const buffer = new ArrayBuffer(48000 * 4);
	sample.copyTo(buffer, { planeIndex: 0 });

	const view = new Float32Array(buffer);
	expect(view[0]).toBeCloseTo(0, 4);
	expect(view[13]).toBeCloseTo(Math.sin(2 * Math.PI * 440 * (13 / 48000)));

	const clone = sample.clone();
	sample.close();
	expect(resource.audioBuffer).not.toBe(null);

	clone.close();
	expect(resource.audioBuffer).toBe(null);
});
