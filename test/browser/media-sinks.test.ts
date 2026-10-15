import { expect, test, vi } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { VideoSample } from '../../src/sample.js';
import { Conversion } from '../../src/conversion.js';

// https://github.com/Vanilagy/mediabunny/issues/370
test('Negative audio timestamps are preserved', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getFirstTimestamp()).toBeLessThan(0);

	const sink = new AudioSampleSink(track);

	for await (using sample of sink.samples()) {
		expect(sample.timestamp).toBe(await track.getFirstTimestamp());
		break;
	}
});

test('No B-frames are skipped when software-decoding AVC', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBe(48);
});

test('No B-frames are skipped when software-decoding AVC, Annex B edition', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	// Force Annex B by converting to MPEG-TS
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (using sample of sink.samples()) {
		count++;
	}

	expect(count).toBe(48);
});

test('Fallback sample past the end survives iterator return', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const sink = new VideoSampleSink(track);
	const iterator = sink.samples(await track.computeDuration() + 0.5);

	const { value: sample } = await iterator.next();
	assert(sample);
	await iterator.return();

	expect(sample._closed).toBe(false);
	sample.close();
});

// https://github.com/Vanilagy/mediabunny/issues/570
test('Opt-in sample resizing preserves timing through range and repeated timestamp retrieval', async () => {
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const original = new VideoSampleSink(track);
	const resized = new VideoSampleSink(track, { maxSampleSize: { width: 64, height: 64 } });
	let count = 0;
	for await (using sample of resized.samples(0, 0.3)) {
		using reference = await original.getSample(sample.timestamp);
		assert(reference);
		expect(sample.displayWidth).toBeLessThanOrEqual(64);
		expect(sample.displayHeight).toBeLessThanOrEqual(64);
		expect(sample.allocationSize()).toBeLessThan(reference.allocationSize());
		expect(sample.timestamp).toBe(reference.timestamp);
		expect(sample.duration).toBe(reference.duration);
		count++;
	}
	expect(count).toBeGreaterThan(0);
	let repeated = 0;
	for await (using sample of resized.samplesAtTimestamps([0.1, 0.1, 0.2])) {
		assert(sample);
		expect(sample.displayWidth).toBeLessThanOrEqual(64);
		expect(sample.allocationSize()).toBeGreaterThan(0);
		repeated++;
	}
	expect(repeated).toBe(3);
});

test('Sample resize releases originals, preserves rotated pixels, and bypasses HDR', async () => {
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	class InspectableSink extends VideoSampleSink {
		transform(onError: (error: unknown) => void) {
			return this._createQueueTransform(onError);
		}
	}
	const sink = new InspectableSink(track, { maxSampleSize: { width: 16, height: 16 } });
	const errors = vi.fn();
	const transform = sink.transform(errors);
	const canvas = new OffscreenCanvas(64, 32);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'red';
	context.fillRect(0, 0, 32, 32);
	context.fillStyle = 'blue';
	context.fillRect(32, 0, 32, 32);
	const sample = new VideoSample(canvas, { timestamp: 2, duration: 0.1, rotation: 90, flip: true });
	const close = vi.spyOn(sample, 'close');
	const reference = new OffscreenCanvas(8, 16);
	sample.draw(reference.getContext('2d')!, 0, 0, 8, 16);
	using result = transform(sample);
	assert(result);
	expect(close).toHaveBeenCalledTimes(1);
	expect([result.displayWidth, result.displayHeight, result.timestamp, result.duration]).toEqual([8, 16, 2, 0.1]);
	const actual = new OffscreenCanvas(8, 16);
	result.draw(actual.getContext('2d')!, 0, 0, 8, 16);
	expect(actual.getContext('2d')!.getImageData(0, 0, 8, 16).data)
		.toEqual(reference.getContext('2d')!.getImageData(0, 0, 8, 16).data);
	using hdr = new VideoSample(new Uint8Array(64 * 32 * 4), {
		format: 'RGBA', codedWidth: 64, codedHeight: 32, timestamp: 0,
		// TypeScript's DOM definitions do not yet include Chromium's HDR color spaces.
		colorSpace: {
			primaries: 'bt2020', transfer: 'pq', matrix: 'rgb', fullRange: true,
		} as unknown as VideoColorSpaceInit,
	});
	expect(transform(hdr)).toBe(hdr);
	const failed = new VideoSample(canvas, { timestamp: 0 });
	const failedClose = vi.spyOn(failed, 'close');
	vi.spyOn(failed, 'draw').mockImplementation(() => {
		throw new Error('draw failed');
	});
	expect(transform(failed)).toBeNull();
	expect(failedClose).toHaveBeenCalledTimes(1);
	expect(errors).toHaveBeenCalledOnce();
});

test('Resize errors reach both iterator consumers and close the original sample', async () => {
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new VideoSampleSink(track, { maxSampleSize: { width: 16, height: 16 } });
	const closed = vi.spyOn(VideoSample.prototype, 'close');
	const draw = vi.spyOn(VideoSample.prototype, 'draw').mockImplementation(() => {
		throw new Error('resize failed');
	});
	try {
		for (const iterator of [sink.samples(), sink.samplesAtTimestamps([0, 0.1])]) {
			closed.mockClear();
			await expect(iterator.next()).rejects.toThrow('resize failed');
			expect(closed).toHaveBeenCalled();
			await iterator.return();
		}
	} finally {
		draw.mockRestore();
		closed.mockRestore();
	}
});

test('Returning a resized iterator releases its queued samples', async () => {
	using input = new Input({ source: new UrlSource('/video.mp4'), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const retained: VideoSample[] = [];
	class TrackedSink extends VideoSampleSink {
		protected override _createQueueTransform(onError: (error: unknown) => void) {
			const transform = super._createQueueTransform(onError);
			return (sample: VideoSample) => {
				const result = transform(sample);
				if (result) retained.push(result);
				return result;
			};
		}
	}
	const sink = new TrackedSink(track, { maxSampleSize: { width: 16, height: 16 } });
	for (const createIterator of [() => sink.samples(), () => sink.samplesAtTimestamps([0, 0.1, 0.2, 0.3])]) {
		retained.length = 0;
		const iterator = createIterator();
		const first = await iterator.next();
		assert(first.value);
		first.value.close();
		await vi.waitFor(() => expect(retained.length).toBeGreaterThan(1));
		await iterator.return();
		for (const sample of retained) {
			expect(() => sample.clone()).toThrow();
		}
	}
});
