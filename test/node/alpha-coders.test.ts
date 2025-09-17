import { vi, describe, test, assert, beforeEach } from 'vitest';
import { AlphaVideoDecoderWrapper } from '../../src/media-sink.js';
import { AlphaVideoEncoderWrapper } from '../../src/media-source.js';

let copyToDelay = () => 0;
const delay = (delay = 0) => new Promise(resolve => setTimeout(resolve, delay));
const VideoFrameMock = vi.fn((_data: unknown, init: VideoFrameInit) => ({
	_data,
	format: 'I420',
	...init,
	allocationSize: () => 0,
	copyTo: () => delay(copyToDelay()),
	close: () => {},
	clone: function () {
		return new VideoFrameMock(this._data, this);
	},
}));
const EncodedVideoChunkMock = vi.fn((init: EncodedVideoChunkInit) => {
	return {
		...init,
		copyTo: () => {},
	};
});
const VideoEncoderMock = vi.fn((init: VideoEncoderInit) => {
	return {
		...init,
		encode: () => {},
		flush: () => delay(0),
		state: 'configured',
		close: function () { this.state = 'closed'; },
	};
});
const VideoDecoderMock = vi.fn((init: VideoDecoderInit) => {
	return {
		...init,
		decode: () => {},
		flush: () => delay(0),
		state: 'configured',
		close: function () { this.state = 'closed'; },
	};
});

declare module 'vitest' {
	export interface TestContext {
		evcOutputs: Parameters<EncodedVideoChunkOutputCallback>[];
		eWrapper: AlphaVideoEncoderWrapper;
		eMain: ReturnType<typeof VideoEncoderMock>;
		eAlpha: ReturnType<typeof VideoEncoderMock>;
		vfOutputs: VideoFrame[];
		dWrapper: AlphaVideoDecoderWrapper;
		dMain: ReturnType<typeof VideoDecoderMock>;
		dAlpha: ReturnType<typeof VideoDecoderMock>;
	}
}

vi.stubGlobal('VideoFrame', VideoFrameMock);
vi.stubGlobal('EncodedVideoChunk', EncodedVideoChunkMock);
vi.stubGlobal('VideoEncoder', VideoEncoderMock);
vi.stubGlobal('VideoDecoder', VideoDecoderMock);

describe('Synthetic alpha encoding iterators tests', () => {
	beforeEach((t) => {
		t.evcOutputs = [];
		t.eWrapper = new AlphaVideoEncoderWrapper({
			// @ts-expect-error Parameters<T> with overload limitation
			output: (...args) => t.evcOutputs.push(args),
			error: console.error,
		});
		t.eMain = t.eWrapper.main as unknown as ReturnType<typeof VideoEncoderMock>;
		t.eAlpha = t.eWrapper.alpha as unknown as ReturnType<typeof VideoEncoderMock>;
	});

	test('Should output with alphaSideData, non-zero start', async (t) => {
		const testCount = 10;
		const startOffset = 3.14;

		for (let i = 0; i < testCount; i++) {
			const timestamp = startOffset + i;
			const keyFrame = timestamp === startOffset;

			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp, format: 'I420A' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame },
			);
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: keyFrame ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
				(i === 0 ? { decoderConfig: {} } : {}) as EncodedVideoChunkMetadata,
			);
			t.eAlpha.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: keyFrame ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
			);
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert(t.evcOutputs[0]?.[1].decoderConfig);
		assert(t.evcOutputs.every(v => 'alphaSideData' in v[1]));
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output in order for randomized timings', async (t) => {
		const testCount = 10;
		const startOffset = 3.14;

		copyToDelay = () => Math.round(Math.random() * 5);

		for (let i = 0; i < testCount; i++) {
			const timestamp = startOffset + i;
			const keyFrame = timestamp === startOffset;

			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp, format: 'I420A' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame },
			);
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: keyFrame ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
				(i === 0 ? { decoderConfig: {} } : {}) as EncodedVideoChunkMetadata,
			);
			t.eAlpha.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: keyFrame ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
			);
		}

		let lastOutputTimestamp = -1;

		copyToDelay = () => 0;
		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert(t.evcOutputs[0]?.[1].decoderConfig);
		assert(t.evcOutputs.every((v) => {
			const increasingOrderAndHasAlpha = v[0].timestamp > lastOutputTimestamp && 'alphaSideData' in v[1];

			lastOutputTimestamp = v[0].timestamp;
			return increasingOrderAndHasAlpha;
		}));
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output no alphaSideData if format has no alpha.', async (t) => {
		const testCount = 10;

		t.eWrapper.encode(
			new VideoFrameMock(
				undefined,
				{ timestamp: 0, format: 'BGRX' } as unknown as VideoFrameInit,
			) as unknown as VideoFrame,
			{ keyFrame: true },
		);

		for (let i = 0; i < testCount; i++) {
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp: i, type: 'key' },
				) as unknown as EncodedVideoChunk,
			);
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert(t.evcOutputs.every(v => !(v[1] && 'alphaSideData' in v[1])));
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output with alphaSideData if format with alpha comes in the middle.', async (t) => {
		const testCount = 10;
		const startOffset = 3.14;
		const firstAlphaAt = 4;

		for (let i = 0; i < firstAlphaAt; i++) {
			const keyFrame = i === 0;

			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp: 0, format: 'I420' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame },
			);
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp: i, type: keyFrame ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
			);
		}

		for (let i = firstAlphaAt; i < testCount; i++) {
			const key = i === firstAlphaAt;
			const timestamp = i + startOffset;

			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp, format: 'I420A' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame: key },
			);
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: key ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
				key ? { decoderConfig: {} } as EncodedAudioChunkMetadata : undefined,
			);
			t.eAlpha.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: key ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
				key ? { decoderConfig: {} } as EncodedAudioChunkMetadata : undefined,
			);
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert(t.evcOutputs[4]?.[1]?.decoderConfig && 'alphaSideData' in t.evcOutputs[4][1]);
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output with alphaSideData if there are some gap / dropped frames in alpha.', async (t) => {
		const testCount = 20;
		const firstAlphaAt = 4;
		const gapEvery = 3;

		for (let i = 0; i < firstAlphaAt; i++) {
			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp: 0, format: 'I420' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame: true },
			);
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp: i, type: i === 0 ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
			);
		}

		t.eWrapper.encode(
			new VideoFrameMock(
				undefined,
				{ timestamp: firstAlphaAt, format: 'I420A' } as unknown as VideoFrameInit,
			) as unknown as VideoFrame,
			{ keyFrame: true },
		);

		// Can only emit alpha output after split alpha done for encode
		await delay(0);

		for (let i = firstAlphaAt; i < testCount; i++) {
			const key = i === firstAlphaAt;

			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp: firstAlphaAt, format: 'I420A' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{},
			);
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp: i, type: key ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
			);
			if (i % gapEvery !== 0) {
				t.eAlpha.output(
					new EncodedVideoChunkMock(
						{ data: new ArrayBuffer(0), timestamp: i, type: key ? 'key' : 'delta' },
					) as unknown as EncodedVideoChunk,
				);
			}
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should wait for next keyframe to output with alphaSideData when main has dropped frames.', async (t) => {
		const testCount = 32;
		const keyFrameInterval = 10;
		const dropFrameInterval = 7;
		const noAlphaAt = new Set<number>();
		let droppedCount = 0;
		let noAlphaExpected = false;

		for (let i = 0; i < testCount; i++) {
			const keyFrame = i % keyFrameInterval === 0;

			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp: 0, format: 'I420A' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame },
			);
			if (i % dropFrameInterval !== 0 || keyFrame) {
				if (keyFrame) noAlphaExpected = false;
				t.eMain.output(
					new EncodedVideoChunkMock(
						{ data: new ArrayBuffer(0), timestamp: i, type: keyFrame ? 'key' : 'delta' },
					) as unknown as EncodedVideoChunk,
				);
			} else {
				droppedCount++;
				noAlphaExpected = true;
			}
			if (noAlphaExpected) noAlphaAt.add(i);
			t.eAlpha.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp: i, type: keyFrame ? 'key' : 'delta' },
				) as unknown as EncodedVideoChunk,
			);
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount - droppedCount);
		assert(t.evcOutputs.every((v) => {
			const hasAlpha = v[1] && 'alphaSideData' in v[1];

			return noAlphaAt.has(v[0].timestamp) ? !hasAlpha : hasAlpha;
		}));
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output with alphaSideData, with b-frames, no frame drop expected.', async (t) => {
		const testCount = 20;
		const order = [2, 3, -2, 1];

		for (let i = 0; i < testCount; i++) {
			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp: 0, format: 'I420A' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame: i === 0 },
			);
		}

		let timestamp = 0;

		for (let i = 0; i < testCount; i++) {
			timestamp += i === 0 ? 0 : order[i % 4]!;
			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: 'delta' },
				) as unknown as EncodedVideoChunk,
				(i === 0 ? { decoderConfig: {} } : {}) as EncodedVideoChunkMetadata,
			);
			t.eAlpha.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp, type: 'delta' },
				) as unknown as EncodedVideoChunk,
			);
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert(t.evcOutputs[0]?.[1].decoderConfig);
		assert(t.evcOutputs.every(v => 'alphaSideData' in v[1]));
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output no alphaSideData if alpha encoder failed.', async (t) => {
		const testCount = 10;
		const errorAt = 4;

		for (let i = 0; i < testCount; i++) {
			t.eWrapper.encode(
				new VideoFrameMock(
					undefined,
					{ timestamp: 0, format: 'BGRA' } as unknown as VideoFrameInit,
				) as unknown as VideoFrame,
				{ keyFrame: true },
			);

			t.eMain.output(
				new EncodedVideoChunkMock(
					{ data: new ArrayBuffer(0), timestamp: i, type: 'delta' },
				) as unknown as EncodedVideoChunk,
			);

			if (i < errorAt) {
				t.eAlpha.output(
					new EncodedVideoChunkMock(
						{ data: new ArrayBuffer(0), timestamp: i, type: 'delta' },
					) as unknown as EncodedVideoChunk,
				);
			} else if (i === errorAt) {
				t.eAlpha.close(); // Error will close it
				t.eAlpha.error(new DOMException('Testing failure'));
			}
		}

		await t.eWrapper.flush();
		t.eWrapper.close();
		assert(t.evcOutputs.length === testCount);
		assert(t.evcOutputs.every((v, i) => {
			const hasAlpha = v[1] && 'alphaSideData' in v[1];

			return i < errorAt ? hasAlpha : !hasAlpha;
		}));
		assert((await Promise.all([
			t.eWrapper.main.iterator.next(),
			t.eWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});
});

describe('Synthetic alpha decoding iterators tests', () => {
	beforeEach((t) => {
		t.vfOutputs = [];
		t.dWrapper = new AlphaVideoDecoderWrapper({
			output: frame => t.vfOutputs.push(frame),
			error: console.error,
		});
		t.dMain = t.dWrapper.main as unknown as ReturnType<typeof VideoDecoderMock>;
		t.dAlpha = t.dWrapper.alpha as unknown as ReturnType<typeof VideoDecoderMock>;
	});

	test('Should output with alpha when alphaSideData added. Non zero start', async (t) => {
		const testCount = 10;
		const startOffset = 3.14;

		for (let i = 0; i < testCount; i++) {
			const timestamp = i + startOffset;

			t.dWrapper.decode(
				{ timestamp, type: 'key' } as EncodedVideoChunk,
				{ alphaSideData: new Uint8Array(0) },
			);
			t.dAlpha.output(new VideoFrameMock(undefined, { timestamp }) as unknown as VideoFrame);
			t.dMain.output(new VideoFrameMock(undefined, { timestamp }) as unknown as VideoFrame);
		}

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every(v => 'transfer' in v));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output with alpha if it comes in the middle.', async (t) => {
		const testCount = 10;
		const firstAlphaAt = 4;

		for (let i = 0; i < testCount; i++) {
			t.dWrapper.decode(
				{ timestamp: i, type: 'key' } as EncodedVideoChunk,
				i >= firstAlphaAt ? { alphaSideData: new Uint8Array(0) } : undefined,
			);
			t.dMain.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
		}

		for (let i = firstAlphaAt; i < testCount; i++) {
			t.dAlpha.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
		}

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every((v, i) => {
			const isCombined = 'transfer' in v;

			return i >= firstAlphaAt ? isCombined : !isCombined;
		}));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output no alpha if no alphaSideData added.', async (t) => {
		const testCount = 10;

		for (let i = 0; i < testCount; i++) {
			t.dWrapper.decode({ timestamp: i, type: 'key' } as EncodedVideoChunk);
			t.dMain.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
		}

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every(v => !('transfer' in v)));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output with alpha if it starts later, but output first.', async (t) => {
		const testCount = 10;
		const firstAlphaAt = 4;

		for (let i = firstAlphaAt; i < testCount; i++) {
			t.dWrapper.decode(
				{ timestamp: i, type: 'key' } as EncodedVideoChunk,
				{ alphaSideData: new Uint8Array(0) },
			);
			t.dAlpha.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
		}

		for (let i = 0; i < testCount; i++) {
			t.dMain.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
		}

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every((v, i) => {
			const isCombined = 'transfer' in v;

			return i >= firstAlphaAt ? isCombined : !isCombined;
		}));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output with alpha at correct index if alpha output has gaps.', async (t) => {
		const testCount = 20;
		const gapEvery = 3;
		const hasAlphaAt = (i: number) => i % gapEvery !== 0;

		for (let i = 0; i < testCount; i++) {
			const hasAlpha = hasAlphaAt(i);

			t.dWrapper.decode(
				{ timestamp: i, type: 'key' } as EncodedVideoChunk,
				hasAlpha ? { alphaSideData: new Uint8Array(0) } : undefined,
			);
			t.dMain.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
			if (hasAlpha) {
				t.dAlpha.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
			}
		}

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every((v, i) => {
			const isCombined = 'transfer' in v;

			return hasAlphaAt(i) ? isCombined : !isCombined;
		}));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output no alpha if no alpha decoder failed.', async (t) => {
		const testCount = 10;
		const errorAt = 4;

		for (let i = 0; i < testCount; i++) {
			t.dWrapper.decode({ timestamp: i, type: 'key' } as EncodedVideoChunk, { alphaSideData: new Uint8Array() });
			t.dMain.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);

			if (i < errorAt) {
				t.dAlpha.output(new VideoFrameMock(undefined, { timestamp: i }) as unknown as VideoFrame);
			} else if (i === errorAt) {
				t.dAlpha.close();
				t.dAlpha.error(new DOMException('Testing failure'));
			}
		}

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every((v, i) => {
			const isCombined = 'transfer' in v;

			return i < errorAt ? isCombined : !isCombined;
		}));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
	});

	test('Should output in order for randomized timings', async (t) => {
		const testCount = 10;
		const startOffset = 3.14;

		copyToDelay = () => Math.round(Math.random() * 5);

		for (let i = 0; i < testCount; i++) {
			const timestamp = i + startOffset;

			t.dWrapper.decode(
				{ timestamp, type: 'key' } as EncodedVideoChunk,
				{ alphaSideData: new Uint8Array(0) },
			);
			t.dAlpha.output(new VideoFrameMock(undefined, { timestamp }) as unknown as VideoFrame);
			t.dMain.output(new VideoFrameMock(undefined, { timestamp }) as unknown as VideoFrame);
		}

		let lastOutputTimestamp = -1;

		await t.dWrapper.flush();
		t.dWrapper.close();
		assert(t.vfOutputs.length === testCount);
		assert(t.vfOutputs.every((v) => {
			const increasingOrderAndHasAlpha = v.timestamp > lastOutputTimestamp && 'transfer' in v;

			lastOutputTimestamp = v.timestamp;
			return increasingOrderAndHasAlpha;
		}));
		assert((await Promise.all([
			t.dWrapper.main.iterator.next(),
			t.dWrapper.alpha.iterator.next(),
		])).every(({ done }) => done));
		copyToDelay = () => 0; // After flush this time
	});
});
