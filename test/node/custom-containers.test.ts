import { expect, test } from 'vitest';
import {
	type AudioCodec,
	AudioSample,
	AudioSampleCursor,
	BufferSource,
	BufferTarget,
	CmafOutputFormat,
	CustomAudioDecoder,
	type CustomAudioTrack,
	type CustomDemuxer,
	CustomInputFormat,
	type CustomMuxer,
	CustomOutputFormat,
	CustomVideoDecoder,
	type DemuxerContext,
	EncodedAudioPacketSource,
	EncodedPacket,
	Input,
	InputDisposedError,
	Logging,
	type MuxerContext,
	type MuxerWriter,
	Output,
	type OutputAudioTrack,
	PacketCursor,
	type PacketRetrievalOptions,
	PathedTarget,
	readAscii,
	readBytes,
	readU32Le,
	registerAudioCodec,
	registerDecoder,
	registerVideoCodec,
	type VideoCodec,
	VideoSample,
	VideoSampleCursor,
	WavOutputFormat,
} from '../../src/index.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { FileSlice } from '../../src/reader.js';

class TestInputFormat extends CustomInputFormat {
	async canReadInput(context: DemuxerContext) {
		let slice = context.reader.requestSlice(0, 4);
		if (slice instanceof Promise) slice = await slice;
		return !!slice && readAscii(slice, 4) === 'TEST';
	}

	createDemuxer(context: DemuxerContext): CustomDemuxer {
		return {
			async getTracks() {
				const header = await context.reader.requestSlice(4, 4);
				if (!header) {
					throw new Error('Missing header');
				}
				const count = readU32Le(header);
				const getPacket = async (index: number, options: PacketRetrievalOptions) => {
					if (index < 0 || index >= count) {
						return null;
					}
					if (options.metadataOnly) {
						return EncodedPacket.metadataOnly('key', index, 1, index, 2);
					}
					const slice = await context.reader.requestSlice(8 + 2 * index, 2);
					return slice ? new EncodedPacket(readBytes(slice, 2), 'key', index, 1, index) : null;
				};
				const track: CustomAudioTrack = {
					id: 1,
					type: 'audio',
					codec: 'pcm-s16',
					timeResolution: 1,
					numberOfChannels: 1,
					sampleRate: 1,
					getDecoderConfig: () => ({ codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 1 }),
					getFirstPacket: options => getPacket(0, options),
					getNextPacket: (packet, options) => getPacket(packet.sequenceNumber + 1, options),
					getPacket: (time, options) => getPacket(Math.min(Math.floor(time), count - 1), options),
					getKeyPacket: (time, options) => getPacket(Math.min(Math.floor(time), count - 1), options),
					getNextKeyPacket: (packet, options) => getPacket(packet.sequenceNumber + 1, options),
				};
				return [track];
			},
			getMimeType: () => 'audio/test',
		};
	}

	get name() { return 'Test'; }
	get mimeType() { return 'audio/test'; }
}

const u32Le = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, true);
	return bytes;
};

class TestOutputFormat extends CustomOutputFormat {
	constructor(private muxer?: (context: MuxerContext) => CustomMuxer, private trackCount = 1) {
		super();
	}

	createMuxer(context: MuxerContext): CustomMuxer {
		if (this.muxer) return this.muxer(context);

		let writer: MuxerWriter;
		let count = 0;
		return {
			async start() {
				expect(context.tracks).toHaveLength(1);
				writer = await context.getRootWriter();
				writer.write(new Uint8Array([84, 69, 83, 84])); // 'TEST'
				writer.write(u32Le(0));
			},
			getMimeType: () => 'audio/test',
			async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket) {
				expect(track.source.codec).toBe('pcm-s16');
				writer.write(packet.data);
				count += packet.data.byteLength / 2;
				await writer.flush();
			},
			finalize() {
				writer.seek(4);
				writer.write(u32Le(count));
			},
		};
	}

	get name() { return 'Test'; }
	get fileExtension() { return '.test'; }
	get mimeType() { return 'audio/test'; }
	getSupportedCodecs() { return ['pcm-s16' as const]; }
	getSupportedTrackCounts() {
		return {
			video: { min: 0, max: 0 },
			audio: { min: this.trackCount, max: this.trackCount },
			subtitle: { min: 0, max: 0 },
			total: { min: this.trackCount, max: this.trackCount },
		};
	}

	get supportsVideoRotationMetadata() { return false; }
	get supportsTimestampedMediaData() { return false; }
}

class FailingCloseSource extends EncodedAudioPacketSource {
	override async _flushAndClose() {
		throw new Error('Source failed');
	}
}

class WaitingFormat extends TestInputFormat {
	context!: DemuxerContext;
	finish!: () => void;

	override async canReadInput(context: DemuxerContext) {
		this.context = context;
		await new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		return true;
	}
}

class WaitingTrackFormat extends TestInputFormat {
	finish!: (packet: EncodedPacket | null) => void;
	disposed = 0;

	override createDemuxer(context: DemuxerContext) {
		const demuxer = super.createDemuxer(context);
		return {
			...demuxer,
			getTracks: async () => {
				const tracks = await demuxer.getTracks();
				tracks[0]!.getFirstPacket = () => new Promise((resolve) => {
					this.finish = resolve;
				});
				return tracks;
			},
			dispose: () => { this.disposed++; },
		};
	}
}

class RememberingFormat extends TestInputFormat {
	context!: DemuxerContext;

	override canReadInput(context: DemuxerContext) {
		this.context = context;
		return super.canReadInput(context);
	}
}

class TestTarget extends BufferTarget {
	started = false;
	closed = false;

	constructor(private failure?: string) {
		super();
	}

	override _start() { this.started = true; }
	override async _close() { this.closed = true; }

	override async _finalize() {
		if (this.failure === 'target') throw new Error('Target failed');
	}
}

class SlowCloseTarget extends TestTarget {
	closeStarted = promiseWithResolvers<void>();
	closing = promiseWithResolvers<void>();

	override async _close() {
		this.closeStarted.resolve();
		await this.closing.promise;
		this.closed = true;
	}
}

class WaitingSource extends EncodedAudioPacketSource {
	finish!: () => void;
	flushed = false;

	constructor(private onStart: () => void) {
		super('pcm-s16');
	}

	override async _flushAndClose() {
		this.onStart();
		await new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		this.flushed = true;
	}
}

test('Custom container roundtrip', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new TestOutputFormat() });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	await Promise.all([
		source.add(new EncodedPacket(new Uint8Array([1, 2]), 'key', 0, 1)),
		source.add(new EncodedPacket(new Uint8Array([3, 4]), 'key', 1, 1)),
	]);
	await output.finalize();

	expect(source.codec).toBe('pcm-s16');
	expect([...new Uint8Array(target.buffer!).subarray(4, 8)]).toEqual([2, 0, 0, 0]);
	using input = new Input({ source: new BufferSource(target.buffer!), formats: [new TestInputFormat()] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getCodec()).toBe('pcm-s16');
	expect(await track.getSampleRate()).toBe(1);
	expect(await track.computeDuration()).toBe(2);

	const a = new PacketCursor(track);
	const b = new PacketCursor(track, { metadataOnly: true });
	const first = await a.next();
	const last = await b.seekTo(1);
	expect(first?.data).toEqual(new Uint8Array([1, 2]));
	expect(last?.isMetadataOnly).toBe(true);
	expect(last?.byteLength).toBe(2);
	expect((await a.next())?.data).toEqual(new Uint8Array([3, 4]));
	expect(await b.next()).toBeNull();
	expect((await b.seekToFirst())?.sequenceNumber).toBe(0);
	expect(await a.next()).toBeNull();
});

test('Input disposal during reads', async () => {
	const format = new WaitingFormat();
	const input = new Input({ source: new BufferSource(new Uint8Array(8)), formats: [format] });
	const formatPromise = input.getFormat();
	input.dispose();
	format.finish();
	await expect(formatPromise).rejects.toThrow(InputDisposedError);
	expect(format.context.signal.aborted).toBe(true);

	const otherFormat = new WaitingTrackFormat();
	const bytes = new Uint8Array([84, 69, 83, 84, 1, 0, 0, 0, 1, 2]);
	const other = new Input({ source: new BufferSource(bytes), formats: [otherFormat] });
	const track = await other.getPrimaryAudioTrack();
	assert(track);
	const cursor = new PacketCursor(track);
	const packetPromise = cursor.next();
	other.dispose();
	otherFormat.finish(null);
	await expect(packetPromise).rejects.toThrow(InputDisposedError);
	expect(otherFormat.disposed).toBe(1);
});

test('Muxer callback failure', async () => {
	let calls = 0;
	let disposed = 0;
	let signal: AbortSignal | null = null;
	const failingFormat = new TestOutputFormat((context) => {
		signal = context.signal;
		return {
			start() {},
			getMimeType() { return 'audio/test'; },
			async addEncodedAudioPacket() {
				await Promise.resolve();
				if (++calls === 1) {
					throw new Error('Packet failed');
				}
			},
			finalize() {},
			dispose() { disposed++; },
		};
	});
	const output = new Output({ target: new BufferTarget(), format: failingFormat });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	await expect(source.add(new EncodedPacket(new Uint8Array(2), 'key', 0, 1))).rejects.toThrow('Packet failed');
	await source.add(new EncodedPacket(new Uint8Array(2), 'key', 1, 1));
	await output.cancel();
	expect(calls).toBe(2);
	expect(disposed).toBe(1);
	expect((signal as AbortSignal | null)?.aborted).toBe(true);
});

test('Cancellation during packet writes', async () => {
	const events: string[] = [];
	let release!: () => void;
	let begin!: () => void;
	const started = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let context!: MuxerContext;
	let writer!: MuxerWriter;
	const waitingOutputFormat = new TestOutputFormat((value) => {
		context = value;
		return {
			async start() { writer = await value.getRootWriter(); },
			getMimeType: () => 'audio/test',
			async addEncodedAudioPacket() {
				events.push('start');
				begin();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				events.push('end');
			},
			finalize() {},
			dispose() { events.push('dispose'); },
		};
	});
	const output = new Output({ target: new BufferTarget(), format: waitingOutputFormat });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	const first = source.add(new EncodedPacket(new Uint8Array(2), 'key', 0, 1));
	await started;
	const second = source.add(new EncodedPacket(new Uint8Array(2), 'key', 1, 1));
	const rejected = expect(second).rejects.toThrow('canceled');
	const canceled = output.cancel();
	await Promise.resolve();
	expect(events).toEqual(['start']);
	release();
	await first;
	await rejected;
	await canceled;
	expect(events).toEqual(['start', 'end', 'dispose']);
	await expect(context.getRootWriter()).rejects.toThrow('canceled');
	expect(() => writer.write(new Uint8Array(2))).toThrow('canceled');
});

test('Cancel after source close', async () => {
	for (const queued of [false, true]) {
		let release!: () => void;
		let begin!: () => void;
		const started = new Promise<void>((resolve) => {
			begin = resolve;
		});
		let closed = 0;
		let disposed = 0;
		const closingFormat = new TestOutputFormat(() => {
			return {
				start() {},
				getMimeType: () => 'audio/test',
				async addEncodedAudioPacket() {
					begin();
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				},
				onTrackClose() { closed++; },
				finalize() {},
				dispose() { disposed++; },
			};
		});
		const output = new Output({ target: new BufferTarget(), format: closingFormat });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		const packet = queued ? source.add(new EncodedPacket(new Uint8Array(2), 'key', 0, 1)) : null;
		if (queued) {
			await started;
		}
		source.close();
		if (queued) {
			await Promise.resolve();
		}
		const canceled = output.cancel();
		if (queued) {
			release();
			await packet;
		}
		await canceled;
		expect(output.state).toBe('canceled');
		expect(closed).toBe(0);
		expect(disposed).toBe(1);
	}
});

test('Shared source disposal', async () => {
	const format = new RememberingFormat();
	const source = new BufferSource(new Uint8Array([84, 69, 83, 84, 0, 0, 0, 0]));
	const a = new Input({ source, formats: [format] });
	using b = new Input({ source, formats: [new TestInputFormat()] });
	await a.getFormat();
	a.dispose();
	expect(() => format.context.reader.requestSlice(0, 1)).toThrow(InputDisposedError);
	expect((await b.getFormat()).name).toBe('Test');
});

test('Finalization error preservation', async () => {
	let disposed = 0;
	const failingFinalizeFormat = new TestOutputFormat((context) => {
		return {
			async start() { await context.getRootWriter(); },
			getMimeType: () => 'audio/test',
			finalize() { throw new Error('Finalize failed'); },
			dispose() {
				disposed++;
				throw new Error('Dispose failed');
			},
		};
	});
	const output = new Output({ target: new BufferTarget(), format: failingFinalizeFormat });
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	await output.start();
	await expect(output.finalize()).rejects.toThrow('Finalize failed');
	expect(disposed).toBe(1);
	expect(output.state).toBe('canceled');
});

test('Cancellation with delayed target', async () => {
	let resolveTarget!: (target: BufferTarget) => void;
	let requested!: () => void;
	const request = new Promise<void>((resolve) => {
		requested = resolve;
	});
	const target = new TestTarget();
	const output = new Output({
		format: new TestOutputFormat(),
		target: new PathedTarget('out.test', () => new Promise<BufferTarget>((resolve) => {
			resolveTarget = resolve;
			requested();
		})),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	const starting = expect(output.start()).rejects.toThrow('canceled');
	await request;
	const canceling = output.cancel();
	resolveTarget(target);
	await starting;
	await canceling;
	expect(target.closed).toBe(true);
	expect(target.started).toBe(false);
});

test('Cancellation waits for a late target to close', async () => {
	let resolveTarget!: (target: BufferTarget) => void;
	let requested!: () => void;
	const request = new Promise<void>((resolve) => {
		requested = resolve;
	});
	const target = new SlowCloseTarget();
	const output = new Output({
		format: new TestOutputFormat(),
		target: new PathedTarget('out.test', () => new Promise<BufferTarget>((resolve) => {
			resolveTarget = resolve;
			requested();
		})),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	const starting = expect(output.start()).rejects.toThrow('canceled');
	await request;
	let canceled = false;
	const canceling = output.cancel().then(() => {
		canceled = true;
	});
	resolveTarget(target);
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(canceled).toBe(false); // The target arrived after cancellation and is still closing
	target.closing.resolve();
	await starting;
	await canceling;
	expect(target.closed).toBe(true);
});

test('Cancellation from within a synchronous target callback', async () => {
	const target = new SlowCloseTarget();
	let canceling!: Promise<void>;
	const output = new Output({
		format: new TestOutputFormat(),
		target: new PathedTarget('out.test', () => {
			canceling = output.cancel();
			return target;
		}),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	await expect(output.start()).rejects.toThrow('canceled');
	let canceled = false;
	void canceling.then(() => {
		canceled = true;
	});
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(canceled).toBe(false); // Cancellation is still closing the target it was handed
	target.closing.resolve();
	await canceling;
	expect(target.closed).toBe(true);
});

test('Targets arriving during cancellation are closed with the rest', async () => {
	// The root target can be requested while cancellation is still closing earlier targets, here the init segment's
	const initTarget = new SlowCloseTarget();
	const rootTarget = new SlowCloseTarget();
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new PathedTarget('out.m4s', () => rootTarget),
		initTarget,
	});
	let canceled = false;
	const canceling = output.cancel().then(() => {
		canceled = true;
	});
	await initTarget.closeStarted.promise;
	expect(output.target).toBe(rootTarget);
	initTarget.closing.resolve();
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(canceled).toBe(false); // The root target arrived mid-cleanup and is still closing
	rootTarget.closing.resolve();
	await canceling;
	expect(rootTarget.closed).toBe(true);
});

test('Targets arriving after cancellation close before their request settles', async () => {
	// getMimeType() can request the root writer without holding the output's lock, so cancellation can finish first
	let resolveTarget!: (target: BufferTarget) => void;
	const target = new SlowCloseTarget();
	const format = new TestOutputFormat(context => ({
		start() {},
		getMimeType: async () => {
			await context.getRootWriter();
			return 'audio/test';
		},
		finalize() {},
	}));
	const output = new Output({
		format,
		target: new PathedTarget('out.test', () => new Promise<BufferTarget>((resolve) => {
			resolveTarget = resolve;
		})),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	await output.start();
	let settled = false;
	const mimeType = output.getMimeType().catch(() => {}).then(() => {
		settled = true;
	});
	await output.cancel();
	resolveTarget(target);
	await target.closeStarted.promise;
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(settled).toBe(false); // The late target is still closing
	target.closing.resolve();
	await mimeType;
	expect(target.closed).toBe(true);
});

test('Cancellation keeps closing targets after a close fails', async () => {
	const initTarget = new SlowCloseTarget();
	const rootTarget = new SlowCloseTarget();
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new PathedTarget('out.m4s', () => rootTarget),
		initTarget,
	});
	const canceling = output.cancel();
	await initTarget.closeStarted.promise;
	expect(output.target).toBe(rootTarget);
	initTarget.closing.reject(new Error('Init target failed'));
	await rootTarget.closeStarted.promise; // The failure doesn't stop the root target from being closed
	rootTarget.closing.resolve();
	await expect(canceling).rejects.toThrow('Init target failed');
	expect(rootTarget.closed).toBe(true);
});

test('Target and track cleanup', async () => {
	for (const failure of ['dispose', 'target', 'track']) {
		let disposed = 0;
		const target = new TestTarget(failure);
		const failingFormat = new TestOutputFormat((context) => {
			return {
				async start() { await context.getRootWriter(); },
				getMimeType: () => 'audio/test',
				onTrackClose() { throw new Error('Track failed'); },
				finalize() {},
				dispose() {
					disposed++;
					if (failure === 'dispose') {
						throw new Error('Dispose failed');
					}
				},
			};
		});
		const output = new Output({ format: failingFormat, target });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		if (failure === 'dispose') {
			await expect(output.cancel()).rejects.toThrow('Dispose failed');
		} else {
			if (failure === 'track') {
				source.close();
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			await expect(output.finalize()).rejects.toThrow(failure === 'track' ? 'Track failed' : 'Target failed');
		}
		expect(target.closed).toBe(true);
		expect(disposed).toBe(1);
		expect(output.state).toBe('canceled');
	}
});

test('Finalization waits for sources', async () => {
	let begin!: () => void;
	const started = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let disposed = false;
	const source = new WaitingSource(begin);
	const twoTrackFormat = new TestOutputFormat(() => {
		return {
			start() {},
			getMimeType: () => 'audio/test',
			finalize() {},
			dispose() {
				expect(source.flushed).toBe(true);
				disposed = true;
			},
		};
	}, 2);
	const output = new Output({ format: twoTrackFormat, target: new BufferTarget() });
	output.addAudioTrack(new FailingCloseSource('pcm-s16'));
	output.addAudioTrack(source);
	await output.start();
	const finalizing = expect(output.finalize()).rejects.toThrow('Source failed');
	await started;
	await Promise.resolve();
	expect(disposed).toBe(false);
	source.finish();
	await finalizing;
	expect(disposed).toBe(true);
});

test('Metadata-only packet sizes', () => {
	const packet = EncodedPacket.metadataOnly('key', 2, 0.04, 3, 123, { alphaByteLength: 45 });
	expect(packet.isMetadataOnly).toBe(true);
	expect(packet.sequenceNumber).toBe(3);
	expect(packet.byteLength).toBe(123);
	expect(packet.sideData.alphaByteLength).toBe(45);
	expect(() => EncodedPacket.metadataOnly('key', 0, 1, 0, -1)).toThrow('byteLength');
	expect(new EncodedPacket(new Uint8Array(0), 'key', 0, 1).isMetadataOnly).toBe(false);
});

test('Cancel after failed finalization', async () => {
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new FailingCloseSource('pcm-s16'));
	await output.start();
	await expect(output.finalize()).rejects.toThrow('Source failed');
	await expect(output.cancel()).resolves.toBeUndefined();
	await expect(output.cancel()).resolves.toBeUndefined();
	expect(output.state).toBe('canceled');
});

test('Tracked writes overlapping their start', async () => {
	let writer!: MuxerWriter;
	const format = new TestOutputFormat(context => ({
		async start() { writer = await context.getRootWriter(); },
		getMimeType: () => 'audio/test',
		finalize() {},
	}));
	const output = new Output({ target: new BufferTarget(), format });
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	await output.start();
	writer.write(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
	writer.startTrackingWrites();
	// A backpatch may start before the tracked region, and only its tail counts as tracked
	writer.seek(8);
	writer.write(new Uint8Array([10, 11, 12, 13]));
	const tracked = writer.stopTrackingWrites();
	expect(tracked.start).toBe(10);
	expect([...tracked.data]).toEqual([12, 13]);
	await output.cancel();
});

test('Custom container roundtrip, multi-sample packets', async () => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new TestOutputFormat() });
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();
	// One packet carrying two sample frames, which the header counts individually
	await source.add(new EncodedPacket(new Uint8Array([1, 2, 3, 4]), 'key', 0, 2));
	await output.finalize();

	using input = new Input({ source: new BufferSource(target.buffer!), formats: [new TestInputFormat()] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const cursor = new PacketCursor(track);
	expect((await cursor.next())?.data).toEqual(new Uint8Array([1, 2]));
	expect((await cursor.next())?.data).toEqual(new Uint8Array([3, 4]));
	expect(await cursor.next()).toBeNull();
});

test('Custom muxers validate timestamps', async () => {
	const cases = [
		[new EncodedPacket(new Uint8Array(2), 'delta', 0, 1), 'key packet'],
		[new EncodedPacket(new Uint8Array(2), 'key', -1, 1), 'non-negative'],
	] as const;
	for (const [packet, error] of cases) {
		const output = new Output({ target: new BufferTarget(), format: new TestOutputFormat() });
		const source = new EncodedAudioPacketSource('pcm-s16');
		output.addAudioTrack(source);
		await output.start();
		await expect(source.add(packet)).rejects.toThrow(error);
		await output.cancel();
	}
});

test('Read helpers reject lengths that are not integers', () => {
	const slice = FileSlice.tempFromBytes(new Uint8Array(4));
	expect(() => readBytes(slice, NaN)).toThrow('safe integer');
	expect(() => readBytes(slice, 1.5)).toThrow('safe integer');
	expect(() => readBytes(slice, -1)).toThrow('non-negative');
	expect(slice.filePos).toBe(0);
	expect(readBytes(slice, 2)).toEqual(new Uint8Array(2));
	expect(() => {
		slice.filePos = 1.5;
	}).toThrow('safe integer');
	expect(() => slice.skip(NaN)).toThrow('safe integer');
	expect(() => slice.slice(0.5)).toThrow('safe integer');
	expect(() => slice.slice(0, -1)).toThrow('non-negative');
	slice.skip(-2); // Negative skips rewind
	expect(slice.filePos).toBe(0);
});

class BrokenTrackFormat extends TestInputFormat {
	constructor(private mutate: (track: CustomAudioTrack) => void) {
		super();
	}

	override createDemuxer(context: DemuxerContext) {
		const demuxer = super.createDemuxer(context);
		return {
			...demuxer,
			getTracks: async () => {
				const tracks = await demuxer.getTracks();
				this.mutate(tracks[0] as CustomAudioTrack);
				return tracks;
			},
		};
	}
}

const ONE_PACKET = new Uint8Array([84, 69, 83, 84, 0, 0, 0, 0]);
const TWO_PACKETS = new Uint8Array([84, 69, 83, 84, 2, 0, 0, 0, 1, 2, 3, 4]);
const openBroken = (mutate: (track: CustomAudioTrack) => void, bytes = ONE_PACKET) => {
	return new Input({ source: new BufferSource(bytes), formats: [new BrokenTrackFormat(mutate)] });
};
const withCodecOnly = (codec: unknown) => (track: CustomAudioTrack) => Object.assign(track, { codec });
const withAudioConfig = (codec: string) => (track: CustomAudioTrack) => Object.assign(track, {
	codec, getDecoderConfig: () => ({ codec, numberOfChannels: 1, sampleRate: 1 }),
});
const withVideoConfig = (codec: string) => (track: CustomAudioTrack) => Object.assign(track, {
	type: 'video', codec, codedWidth: 16, codedHeight: 16,
	getDecoderConfig: () => ({ codec, codedWidth: 16, codedHeight: 16 }),
});
const s16Sample = (value: number, timestamp: number) => new AudioSample({
	data: new Int16Array([value]), format: 's16', numberOfChannels: 1, sampleRate: 1, timestamp,
});

const open = async (mutate: (track: CustomAudioTrack) => void) => {
	using input = openBroken(mutate);
	await input.getTracks();
};

test('Custom track validation', async () => {
	await open(() => {});
	await expect(open(track => Object.assign(track, { numberOfChannels: 0 }))).rejects.toThrow('numberOfChannels');
	await expect(open(track => Object.assign(track, { sampleRate: 1.5 }))).rejects.toThrow('sampleRate');
	const video = { type: 'video', codec: null, codedWidth: 16, codedHeight: 16 };
	await expect(open(track => Object.assign(track, video, { codedWidth: NaN }))).rejects.toThrow('codedWidth');
	await expect(open(track => Object.assign(track, video, { codedHeight: 0 }))).rejects.toThrow('codedHeight');
	await expect(open(track => Object.assign(track, video, { rotation: 45 }))).rejects.toThrow('rotation');
	const zeroSquare = { ...video, squarePixelWidth: 0 };
	await expect(open(track => Object.assign(track, zeroSquare))).rejects.toThrow('squarePixelWidth');
	await expect(open(track => Object.assign(track, video, { displayHeight: 1.5 }))).rejects.toThrow('displayHeight');
	await open(track => Object.assign(track, video, { squarePixelHeight: 9, displayWidth: 16 }));
	// Optional metadata is checked too, since the backings hand it out as-is
	await expect(open(track => Object.assign(track, { name: 42 }))).rejects.toThrow('track.name');
	await expect(open(track => Object.assign(track, { languageCode: 42 }))).rejects.toThrow('languageCode');
	const disposition = { default: 'yes' };
	await expect(open(track => Object.assign(track, { disposition }))).rejects.toThrow('disposition.default');
	await expect(open(track => Object.assign(track, { pairingMask: 1 }))).rejects.toThrow('pairingMask');
	await expect(open(track => Object.assign(track, { bitrate: -1 }))).rejects.toThrow('track.bitrate');
	await expect(open(track => Object.assign(track, { bitrate: Infinity }))).rejects.toThrow('track.bitrate');
	await expect(open(track => Object.assign(track, { averageBitrate: NaN }))).rejects.toThrow('averageBitrate');
	await expect(open(track => Object.assign(track, { averageBitrate: -1 }))).rejects.toThrow('averageBitrate');
	const keyPackets = { hasOnlyKeyPackets: 'yes' };
	await expect(open(track => Object.assign(track, keyPackets))).rejects.toThrow('hasOnlyKeyPackets');
	const epoch = { isRelativeToUnixEpoch: 1 };
	await expect(open(track => Object.assign(track, epoch))).rejects.toThrow('isRelativeToUnixEpoch');
	await expect(open(track => Object.assign(track, video, { colorSpace: null }))).rejects.toThrow('colorSpace');
	await expect(open(track => Object.assign(track, video, { colorSpace: 1 }))).rejects.toThrow('colorSpace');
	const transparent = { ...video, canBeTransparent: 'yes' };
	await expect(open(track => Object.assign(track, transparent))).rejects.toThrow('canBeTransparent');
	await open(track => Object.assign(track, {
		name: null, languageCode: 'en', disposition: { default: true }, pairingMask: 2n, bitrate: null,
		averageBitrate: 1000, hasOnlyKeyPackets: true, isRelativeToUnixEpoch: false,
	}));
	await open(track => Object.assign(track, video, { colorSpace: { primaries: 'bt709' }, canBeTransparent: true }));
	// And the list itself has to be an array
	{
		using input = new Input({ source: new BufferSource(ONE_PACKET), formats: [new (class extends TestInputFormat {
			override createDemuxer(context: DemuxerContext) {
				return { ...super.createDemuxer(context), getTracks: () => ({ map: () => [] }) as never };
			}
		})()] });
		await expect(input.getTracks()).rejects.toThrow('getTracks must return');
	}
});

// Native decoders that count and refuse any use, so a test can prove a codec name never reached them (a throw alone
// wouldn't do, since canDecode() swallows it), plus a log listener to prove nothing was swallowed either
const withNativeSpies = async (run: (native: { calls: number }) => Promise<void>) => {
	const native = { calls: 0 };
	const errors: unknown[][] = [];
	const stopListening = Logging.on('error', args => errors.push(args));
	const spy = class {
		static isConfigSupported() {
			native.calls++;
			throw new Error('Native decoder consulted.');
		}

		constructor() {
			native.calls++;
			throw new Error('Native decoder constructed.');
		}
	};
	const globals = globalThis as Record<string, unknown>;
	const previous = { VideoDecoder: globals['VideoDecoder'], AudioDecoder: globals['AudioDecoder'] };
	globals['VideoDecoder'] = spy;
	globals['AudioDecoder'] = spy;
	try {
		await run(native);
		expect(native.calls).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		stopListening();
		globals['VideoDecoder'] = previous.VideoDecoder;
		globals['AudioDecoder'] = previous.AudioDecoder;
	}
};

test('Custom track codec names', async () => {
	// Built-in names of the track's type and names nobody has registered yet are fine
	for (const codec of [null, 'pcm-s16', 'mp2', 'mpeg2', 'review-audio']) {
		await open(withCodecOnly(codec));
	}
	// Built-in names of the other type, built-in names that aren't codecs, and names that could never be registered
	for (const codec of ['avc', 'apch', 'webvtt', 'Mpeg4', 'avc1-custom', 'pcm-custom', 123]) {
		await expect(open(withCodecOnly(codec))).rejects.toThrow('track.codec');
	}
	// Whether someone registered a custom name, and for which kind, doesn't change what a demuxer may report
	const removeAudio = registerAudioCodec('review-audio');
	const removeVideo = registerVideoCodec('review-video');
	try {
		await open(withCodecOnly('review-audio'));
		await open(withCodecOnly('review-video'));
	} finally {
		removeAudio();
		removeVideo();
	}
	const video = { type: 'video', codedWidth: 16, codedHeight: 16 };
	await open(track => Object.assign(track, video, { codec: 'mpeg4' }));
	await open(track => Object.assign(track, video, { codec: 'avc' }));
	await expect(open(track => Object.assign(track, video, { codec: 'aac' }))).rejects.toThrow('track.codec');
});

test('Named tracks without a decoder', async () => {
	const decodable = async (mutate: (track: CustomAudioTrack) => void) => {
		using input = openBroken(mutate);
		const track = (await input.getTracks())[0];
		return track!.canDecode();
	};
	await withNativeSpies(async () => {
		// An identified codec nobody decodes
		expect(await decodable(withAudioConfig('mp2'))).toBe(false);
		// A custom name doesn't become decodable by borrowing a PCM codec string
		expect(await decodable(withCodecOnly('review-audio'))).toBe(false);
		// Built-in PCM is decoded by Mediabunny itself, µ-law included
		expect(await decodable(withAudioConfig('ulaw'))).toBe(true);
		// A registered decoder class makes the track decodable, registered name or not
		class Mp2Decoder extends CustomAudioDecoder {
			static override supports(codec: AudioCodec) { return codec === 'mp2'; }
			init() {}
			decode() {}
			flush() {}
			close() {}
		}
		registerDecoder(Mp2Decoder);
		expect(await decodable(withAudioConfig('mp2'))).toBe(true);
		// Configured tracks of either kind stay undecodable without a decoder, registered name or not
		expect(await decodable(withAudioConfig('review-audio'))).toBe(false);
		expect(await decodable(withVideoConfig('review-video'))).toBe(false);
		const removeAudio = registerAudioCodec('review-audio');
		const removeVideo = registerVideoCodec('review-video');
		try {
			expect(await decodable(withAudioConfig('review-audio'))).toBe(false);
			expect(await decodable(withVideoConfig('review-video'))).toBe(false);
		} finally {
			removeAudio();
			removeVideo();
		}
	});
});

test('Custom decoders through the sample cursors', async () => {
	await withNativeSpies(async () => {
		class CursorVideoDecoder extends CustomVideoDecoder {
			static override supports(codec: VideoCodec) { return codec === 'cursor-video'; }
			init() {}
			decode(packet: EncodedPacket) {
				this.onSample(new VideoSample(new Uint8Array(16 * 16 * 4), {
					format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp: packet.timestamp, duration: 1,
				}));
			}

			flush() {}
			close() {}
		}
		class CursorAudioDecoder extends CustomAudioDecoder {
			static override supports(codec: AudioCodec) { return codec === 'cursor-audio'; }
			init() {}
			decode(packet: EncodedPacket) {
				this.onSample(s16Sample(1234, packet.timestamp));
			}

			flush() {}
			close() {}
		}
		registerDecoder(CursorVideoDecoder);
		registerDecoder(CursorAudioDecoder);

		const open = (mutate: (track: CustomAudioTrack) => void) => openBroken(mutate, TWO_PACKETS);
		// A video track with a config nobody but the custom decoder understands
		{
			using input = open(withVideoConfig('cursor-video'));
			const track = await input.getPrimaryVideoTrack();
			expect(await track!.canDecode()).toBe(true);
			await using cursor = new VideoSampleCursor(track!);
			let count = 0;
			for await (const sample of cursor) {
				expect(sample.timestamp).toBe(count++);
				sample.close();
			}
			expect(count).toBe(2);
		}
		// An audio track whose config borrows a PCM codec string is still decoded by its own decoder
		{
			using input = open(withCodecOnly('cursor-audio'));
			const track = await input.getPrimaryAudioTrack();
			expect(await track!.canDecode()).toBe(true);
			await using cursor = new AudioSampleCursor(track!);
			const sample = await cursor.next();
			const decoded = new Int16Array(1);
			sample!.copyTo(decoded, { planeIndex: 0, format: 's16' });
			expect(decoded[0]).toBe(1234); // The PCM decoder would have read the packet's bytes, 0x0201
			sample!.close();
		}
		// Registering the names changes nothing about which decoder serves them
		const removeVideo = registerVideoCodec('cursor-video');
		const removeAudio = registerAudioCodec('cursor-audio');
		try {
			using videoInput = open(withVideoConfig('cursor-video'));
			expect(await (await videoInput.getPrimaryVideoTrack())!.canDecode()).toBe(true);
			using audioInput = open(withCodecOnly('cursor-audio'));
			expect(await (await audioInput.getPrimaryAudioTrack())!.canDecode()).toBe(true);
		} finally {
			removeVideo();
			removeAudio();
		}
	});
});

test('Decoder configs need an identity and PCM configs must name it', async () => {
	await withNativeSpies(async () => {
		// An unidentified track has no decoder config, whatever the demuxer returns
		{
			using input = openBroken(withCodecOnly(null));
			const track = await input.getPrimaryAudioTrack();
			expect(await track!.getDecoderConfig()).toBeNull();
			expect(await track!.canDecode()).toBe(false);
		}
		// A PCM track whose config borrows another codec string is rejected instead of being fed to the PCM decoder
		{
			using input = openBroken(track => Object.assign(track, {
				codec: 'pcm-s16', getDecoderConfig: () => ({ codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: 1 }),
			}));
			const track = await input.getPrimaryAudioTrack();
			await expect(track!.getDecoderConfig()).rejects.toThrow('must use');
		}
	});
});

test('Packet inspection without a decoder config', async () => {
	// A named video track without a decoder config still reads, and the demuxer's packet types stand
	const video = { type: 'video', codec: 'avc', codedWidth: 16, codedHeight: 16 };
	const noConfig = (track: CustomAudioTrack) => Object.assign(track, video, { getDecoderConfig: () => null });
	using input = openBroken(noConfig, TWO_PACKETS);
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.canDecode()).toBe(false);
	const cursor = new PacketCursor(track, { verifyKeyPackets: true });
	const packet = await cursor.seekToFirst();
	expect(packet?.type).toBe('key');
	expect(await track.determinePacketType(packet!)).toBe(null);
	expect((await cursor.seekToKey(1))?.sequenceNumber).toBe(1);
});

test('Cancellation from within the monotonic callback', async () => {
	// The callback runs after the target resolved but before the writer starts it, so a cancel there must win
	const target = new TestTarget();
	let canceling!: Promise<void>;
	const format = new TestOutputFormat(context => ({
		async start() {
			await context.getRootWriter(() => {
				canceling = output.cancel();
				return false;
			});
		},
		getMimeType: () => 'audio/test',
		finalize() {},
	}));
	const output = new Output({ format, target });
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	await expect(output.start()).rejects.toThrow('canceled');
	await canceling;
	expect(target.started).toBe(false);
	expect(target.closed).toBe(true);
});

test('Root target after cancel', async () => {
	// A synchronous callback keeps the target getter usable, even once the output is canceled
	const output = new Output({
		format: new TestOutputFormat(),
		target: new PathedTarget('out.test', () => new BufferTarget()),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));
	await output.cancel();
	expect(output.target).toBeInstanceOf(BufferTarget);
});
