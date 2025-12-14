// Two parallelism modes: Cancel and queue (right?)
// Useful in packet context? Or only for sample?

import { PCM_AUDIO_CODECS } from './codec';
import { InputAudioTrack, InputTrack, InputVideoTrack } from './input-track';
import { AudioDecoderWrapper, DecoderWrapper, PacketRetrievalOptions, PcmAudioDecoderWrapper, validatePacketRetrievalOptions, validateTimestamp, VideoDecoderWrapper } from './media-sink';
import { assert, AsyncMutex4, AsyncMutexLock, CallSerializer2, defer, insertSorted, isFirefox, last, MaybePromise, polyfillSymbolDispose, promiseWithResolvers, ResultValue, Rotation, Yo } from './misc';
import { EncodedPacket } from './packet';
import { AudioSample, clampCropRectangle, CropRectangle, validateCropRectangle, VideoSample } from './sample';

polyfillSymbolDispose();

export class PacketReader<T extends InputTrack = InputTrack> {
	track: T;

	constructor(track: T) {
		if (!(track instanceof InputTrack)) {
			throw new TypeError('track must be an InputTrack.');
		}
		this.track = track;
	}

	private maybeVerifyPacketType(
		packet: EncodedPacket | null,
		options: PacketRetrievalOptions,
	): MaybePromise<EncodedPacket | null> {
		if (!options.verifyKeyPackets || !packet || packet.type === 'delta') {
			return packet;
		}

		return this.track.determinePacketType(packet).then((determinedType) => {
			if (determinedType) {
				// @ts-expect-error Technically readonly
				packet.type = determinedType;
			}

			return packet;
		});
	}

	readFirst(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validatePacketRetrievalOptions(options);

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getFirstPacket(result, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => this.maybeVerifyPacketType(result.value, options));
		} else {
			return this.maybeVerifyPacketType(result.value, options);
		}
	}

	readAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getPacket(result, timestamp, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => this.maybeVerifyPacketType(result.value, options));
		} else {
			return this.maybeVerifyPacketType(result.value, options);
		}
	}

	readKeyAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (options.verifyKeyPackets) {
			return this.readKeyAtVerified(timestamp, options);
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getKeyPacket(result, timestamp, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	private async readKeyAtVerified(
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getKeyPacket(result, timestamp, options);
		if (result.pending) await promise;

		const packet = result.value;
		if (!packet) {
			return null;
		}

		const determinedType = await this.track.determinePacketType(packet);
		if (determinedType === 'delta') {
			// Try returning the previous key packet (in hopes that it's actually a key packet)
			return this.readKeyAtVerified(packet.timestamp - 1 / this.track.timeResolution, options);
		}

		return packet;
	}

	readNext(from: EncodedPacket, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (!(from instanceof EncodedPacket)) {
			throw new TypeError('from must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextPacket(result, from, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => this.maybeVerifyPacketType(result.value, options));
		} else {
			return this.maybeVerifyPacketType(result.value, options);
		}
	}

	readNextKey(from: EncodedPacket, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (!(from instanceof EncodedPacket)) {
			throw new TypeError('from must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (options.verifyKeyPackets) {
			return this.readNextKeyVerified(from, options);
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextKeyPacket(result, from, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	private async readNextKeyVerified(
		from: EncodedPacket,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextKeyPacket(result, from, options);
		if (result.pending) await promise;

		const nextPacket = result.value;
		if (!nextPacket) {
			return null;
		}

		const determinedType = await this.track.determinePacketType(nextPacket);
		if (determinedType === 'delta') {
			// Try returning the next key packet (in hopes that it's actually a key packet)
			return this.readNextKeyVerified(nextPacket, options);
		}

		return nextPacket;
	}
}

export class PacketCursor {
	reader: PacketReader;
	options: PacketRetrievalOptions;

	current: EncodedPacket | null = null;
	nextIsFirst = true;
	callSerializer = new CallSerializer2();

	constructor(reader: PacketReader, options: PacketRetrievalOptions = {}) {
		if (!(reader instanceof PacketReader)) {
			throw new TypeError('reader must be a PacketReader.');
		}
		validatePacketRetrievalOptions(options);

		this.reader = reader;
		this.options = options;
	}

	private seekToFirstDirect(): MaybePromise<EncodedPacket | null> {
		const result = this.reader.readFirst(this.options);

		const onPacket = (packet: EncodedPacket | null) => {
			this.nextIsFirst = false;
			return this.current = packet;
		};

		if (result instanceof Promise) {
			return result.then(onPacket);
		} else {
			return onPacket(result);
		}
	}

	seekToFirst(): MaybePromise<EncodedPacket | null> {
		return this.callSerializer.call(() => this.seekToFirstDirect());
	}

	seekTo(timestamp: number): MaybePromise<EncodedPacket | null> {
		return this.callSerializer.call(() => {
			const result = this.reader.readAt(timestamp, this.options);

			const onPacket = (packet: EncodedPacket | null) => {
				this.nextIsFirst = !packet;
				return this.current = packet;
			};

			if (result instanceof Promise) {
				return result.then(onPacket);
			} else {
				return onPacket(result);
			}
		});
	}

	seekToKey(timestamp: number): MaybePromise<EncodedPacket | null> {
		return this.callSerializer.call(() => {
			const result = this.reader.readKeyAt(timestamp, this.options);

			const onPacket = (packet: EncodedPacket | null) => {
				this.nextIsFirst = !packet;
				return this.current = packet;
			};

			if (result instanceof Promise) {
				return result.then(onPacket);
			} else {
				return onPacket(result);
			}
		});
	}

	next(): MaybePromise<EncodedPacket | null> {
		return this.callSerializer.call(() => {
			if (this.nextIsFirst) {
				return this.seekToFirstDirect();
			}

			if (!this.current) {
				return null;
			}

			const result = this.reader.readNext(this.current, this.options);

			const onPacket = (packet: EncodedPacket | null) => {
				return this.current = packet;
			};

			if (result instanceof Promise) {
				return result.then(onPacket);
			} else {
				return onPacket(result);
			}
		});
	}

	nextKey(): MaybePromise<EncodedPacket | null> {
		return this.callSerializer.call(() => {
			if (this.nextIsFirst) {
				return this.seekToFirstDirect();
			}

			if (!this.current) {
				return null;
			}

			const result = this.reader.readNextKey(this.current, this.options);

			const onPacket = (packet: EncodedPacket | null) => {
				return this.current = packet;
			};

			if (result instanceof Promise) {
				return result.then(onPacket);
			} else {
				return onPacket(result);
			}
		});
	}

	async iterate(
		callback: (packet: EncodedPacket, stop: () => void) => MaybePromise<unknown>,
	) {
		let stopped = false;
		const stop = () => stopped = true;

		const donePromise = this.callSerializer.done();
		if (donePromise) await donePromise;

		while (true) {
			if (this.current) {
				const result = callback(this.current, stop);
				if (result instanceof Promise) await result;
			}

			if (stopped) {
				break;
			}

			const result = this.next();
			if (result instanceof Promise) await result;

			if (!this.current) {
				break;
			}
		}
	}

	// eslint-disable-next-line @stylistic/generator-star-spacing
	async *[Symbol.asyncIterator]() {
		const donePromise = this.callSerializer.done();
		if (donePromise) await donePromise;

		while (true) {
			if (this.current) {
				yield this.current;
			}

			const result = this.next();
			if (result instanceof Promise) await result;

			if (!this.current) {
				break;
			}
		}
	}

	waitUntilIdle() {
		return this.callSerializer.done();
	}
}

type PendingRequest<T> = {
	timestamp: number;
	promise: Promise<T | null>;
	resolve: (sample: T | null) => void;
	reject: (error: unknown) => void;
	successor: PendingRequest<T> | null;
};

type SampleTransformer<Sample, TransformedSample> = (sample: Sample) => MaybePromise<TransformedSample>;

type SampleCursorOptions<Sample, TransformedSample> = {
	autoClose?: boolean;
	transform?: SampleTransformer<Sample, TransformedSample>;
};

export abstract class SampleCursor<
	Sample extends VideoSample | AudioSample,
	TransformedSample = Sample,
> implements AsyncDisposable {
	packetReader: PacketReader;
	packetCursor: PacketCursor;
	options: SampleCursorOptions<Sample, TransformedSample>;
	transform: SampleTransformer<Sample, TransformedSample>;
	autoClose: boolean;
	pumpRunning = false;
	decoder: DecoderWrapper<Sample>;
	currentRaw: Sample | null = null;
	current: TransformedSample | null = null;
	sampleQueue: Sample[] = [];
	queueDequeue = promiseWithResolvers();
	pendingRequests: PendingRequest<TransformedSample>[] = [];
	lastPendingRequest: PendingRequest<TransformedSample> | null = null;

	predictedRequests = 0;
	nextIsFirst = true;

	pumpStopQueued = false;
	pumpStopped = promiseWithResolvers();

	decodedTimestamps: number[] = [];
	maxDecodedSequenceNumber = -1;
	pumpTarget: EncodedPacket | null = null;
	pumpMutex = new AsyncMutex4();
	_closed = false;
	otherMutex = new AsyncMutex4();

	error: unknown = null;
	errorSet = false;

	debugInfo = {
		enabled: false,
		pumpsStarted: 0,
		seekPackets: [] as (EncodedPacket | null)[],
		decodedPackets: [] as EncodedPacket[],
		throwInPump: false,
		throwDecoderError: false,
	};

	get closed(): boolean {
		return this._closed;
	}

	protected constructor(
		reader: PacketReader,
		decoder: DecoderWrapper<Sample>,
		options: SampleCursorOptions<Sample, TransformedSample>,
	) {
		this.packetReader = reader;
		this.decoder = decoder;
		this.packetCursor = new PacketCursor(reader);
		this.options = options;
		this.autoClose = options.autoClose ?? true;
		this.transform = options.transform ?? (sample => sample as unknown as TransformedSample);

		reader.track.input._openSampleCursors.add(this);
	}

	async onDecoderSample(sample: Sample) {
		try {
			if (this.debugInfo.enabled && this.debugInfo.throwDecoderError) {
				sample.close();
				return this.onDecoderError(new Error('Fake decoder error!'));
			}

			using lock = this.otherMutex.lock();
			if (lock.pending) await lock.ready;

			while (this.decodedTimestamps.length > 0 && this.decodedTimestamps[0]! <= sample.timestamp) {
				this.decodedTimestamps.shift();
			}

			if (this.pendingRequests.length === 0) {
				if (this.pumpStopQueued) {
					sample.close();
				} else {
					this.sampleQueue.push(sample);
				}
			} else {
				let given = false;
				let transformed: TransformedSample | null = null;

				for (let i = 0; i < this.pendingRequests.length; i++) {
					const request = this.pendingRequests[i]!;
					if (request.timestamp > sample.timestamp) {
						break;
					}

					if (!transformed) {
						let result = this.transform(sample);
						if (result instanceof Promise) result = await result;

						transformed = result;
					}

					request.resolve(transformed);
					this.pendingRequests.splice(i--, 1);
					this.setCurrent(sample, transformed);
					given = true;

					if (request.successor) {
						this.pendingRequests.unshift(request.successor);
						i++;
					}
				}

				if (!given) {
					sample.close();
				}
			}

			this.queueDequeue.resolve();
			this.queueDequeue = promiseWithResolvers();
		} catch (error) {
			await this.closeWithError(error);
		}
	}

	async onDecoderError(error: unknown) {
		using lock = this.otherMutex.lock();
		if (lock.pending) await lock.ready;

		await this.closeWithError(error);
	}

	onDecoderDequeue() {
		this.queueDequeue.resolve();
		this.queueDequeue = promiseWithResolvers();
	}

	setCurrent(newCurrentRaw: Sample | null, newCurrent: TransformedSample | null) {
		if (this.autoClose && this.currentRaw && this.currentRaw !== newCurrentRaw) {
			this.currentRaw.close();
		}

		this.currentRaw = newCurrentRaw;
		this.current = newCurrent;
	}

	getNextExpectedTimestamp() {
		if (this.sampleQueue.length > 0) {
			return this.sampleQueue[0]!.timestamp;
		}
	}

	_ensureNotClosed() {
		if (this.closed) {
			if (this.errorSet) {
				throw this.error;
			} else {
				throw new Error('This cursor has been closed and can no longer be used.');
			}
		}
	}

	async _seekToPacket(
		res: ResultValue<TransformedSample | null>,
		targetPacketPromise: MaybePromise<EncodedPacket | null>,
		lock?: AsyncMutexLock,
	): Promise<Yo> {
		this.predictedRequests++;

		if (!lock) {
			lock = this.pumpMutex.lock();
			if (lock.pending) await lock.ready;
		}

		this._ensureNotClosed();

		using deferred = defer(() => {
			lock?.release();
			this.predictedRequests--;
		});

		const targetPacket = targetPacketPromise instanceof Promise
			? await targetPacketPromise
			: targetPacketPromise;

		if (this.debugInfo.enabled) {
			this.debugInfo.seekPackets.push(targetPacket);
		}

		this.nextIsFirst = !targetPacket;

		if (!targetPacket) {
			this.setCurrent(null, null);
			return res.set(null);
		}

		if (this.currentRaw?.timestamp === targetPacket.timestamp) {
			return res.set(this.current);
		}

		let setNewPump = true;

		if (this.sampleQueue.length > 0 && targetPacket.timestamp < this.sampleQueue[0]!.timestamp) {

		} else {
			while (this.sampleQueue.length > 0) {
				const nextSample = this.sampleQueue.shift()!;
				this.queueDequeue.resolve();
				this.queueDequeue = promiseWithResolvers();

				if (targetPacket.timestamp <= nextSample.timestamp) {
					let transformed = this.transform(nextSample);
					if (transformed instanceof Promise) transformed = await transformed;

					this.setCurrent(nextSample, transformed);
					return res.set(transformed);
				} else {
					nextSample.close();
				}
			}

			if (this.pumpTarget) {
				const max = Math.max(this.pumpTarget.sequenceNumber, this.maxDecodedSequenceNumber);

				if (targetPacket.sequenceNumber <= max) {
					const nextExpectedTimestamp = this.decodedTimestamps[0] ?? this.packetCursor.current?.timestamp;
					if (nextExpectedTimestamp === undefined || nextExpectedTimestamp > targetPacket.timestamp) {
						// yeah
						// formulate the "no nextExpectedTimestamp" case
					} else {
						setNewPump = false;
					}
				} else {
					if (targetPacket.timestamp - this.pumpTarget.timestamp < 0.1) {
						setNewPump = false;
					} else {
						let key = this.packetReader.readNextKey(this.pumpTarget, { verifyKeyPackets: true });
						if (key instanceof Promise) key = await key;

						if (
							!key
							|| targetPacket.sequenceNumber < key.sequenceNumber
						) {
							setNewPump = false;
						}
					}
				}
			}
		}

		if (setNewPump && this.pumpRunning) {
			await this.stopPump();
		}

		if (!this.pumpTarget || targetPacket.sequenceNumber > this.pumpTarget.sequenceNumber) {
			this.pumpTarget = targetPacket;
		}

		if (setNewPump) {
			const result = this.packetCursor.seekToKey(targetPacket.timestamp);
			if (result instanceof Promise) await result;

			void this.runPump();
		}

		this._ensureNotClosed();

		const request = promiseWithResolvers<TransformedSample | null>();
		const pendingRequest: PendingRequest<TransformedSample> = {
			timestamp: targetPacket.timestamp,
			promise: request.promise,
			resolve: request.resolve,
			reject: request.reject,
			successor: null,
		};
		this.pendingRequests.push(pendingRequest);
		this.pendingRequests.sort((a, b) => a.timestamp - b.timestamp);
		this.lastPendingRequest = pendingRequest;

		this.queueDequeue.resolve();
		this.queueDequeue = promiseWithResolvers();

		deferred.execute(); // Waiting for the return would be too long

		return res.set(await request.promise);
	}

	seekToFirst(): MaybePromise<TransformedSample | null> {
		this._ensureNotClosed();

		try {
			const result = new ResultValue<TransformedSample | null>();
			const promise = this._seekToPacket(result, this.packetReader.readFirst());

			if (result.pending) {
				return promise
					.then(() => result.value)
					.catch(this.closeWithErrorAndThrow.bind(this));
			} else {
				return result.value;
			}
		} catch (error) {
			this.closeWithErrorAndThrow(error);
		}
	}

	seekTo(timestamp: number): MaybePromise<TransformedSample | null> {
		this._ensureNotClosed();

		try {
			const result = new ResultValue<TransformedSample | null>();
			const promise = this._seekToPacket(result, this.packetReader.readAt(timestamp));

			if (result.pending) {
				return promise
					.then(() => result.value)
					.catch(this.closeWithErrorAndThrow.bind(this));
			} else {
				return result.value;
			}
		} catch (error) {
			this.closeWithErrorAndThrow(error);
		}
	}

	seekToKey(timestamp: number): MaybePromise<TransformedSample | null> {
		this._ensureNotClosed();

		try {
			const result = new ResultValue<TransformedSample | null>();
			const promise = this._seekToPacket(
				result,
				this.packetReader.readKeyAt(timestamp, { verifyKeyPackets: true }),
			);

			if (result.pending) {
				return promise
					.then(() => result.value)
					.catch(this.closeWithErrorAndThrow.bind(this));
			} else {
				return result.value;
			}
		} catch (error) {
			this.closeWithErrorAndThrow(error);
		}
	}

	async _nextInternal(res: ResultValue<TransformedSample | null>): Promise<Yo> {
		using lock = this.pumpMutex.lock();
		if (lock.pending) await lock.ready;

		this._ensureNotClosed();

		if (this.nextIsFirst) {
			return await this._seekToPacket(res, this.packetReader.readFirst(), lock);
		}

		if (this.sampleQueue.length > 0) {
			const nextSample = this.sampleQueue.shift()!;
			this.queueDequeue.resolve();
			this.queueDequeue = promiseWithResolvers();

			let transformed = this.transform(nextSample);
			if (transformed instanceof Promise) transformed = await transformed;

			this.setCurrent(nextSample, transformed);
			return res.set(transformed);
		}

		if (!this.pumpRunning) {
			this.setCurrent(null, null);
			return res.set(null); // None more after this, boy
		}

		assert(this.lastPendingRequest);

		this._ensureNotClosed();

		const request = promiseWithResolvers<TransformedSample | null>();
		const pendingRequest: PendingRequest<TransformedSample> = {
			timestamp: -Infinity,
			promise: request.promise,
			resolve: request.resolve,
			reject: request.reject,
			successor: null,
		};

		if (this.pendingRequests.length === 0) {
			this.pendingRequests.push(pendingRequest);
		} else {
			this.lastPendingRequest.successor = pendingRequest;
		}
		this.lastPendingRequest = pendingRequest;

		// Note that the next packet we get here is not necessarily the packet belonging to the next sample, since we
		// can have out of order timestamps when B-frames are at play. However, if next() is called a sufficiently
		// large amount of times, then the pump target will stay roughly in sync with the desired next sample.
		const next = this.pumpTarget && await this.packetReader.readNext(this.pumpTarget, { metadataOnly: true });
		if (next) {
			this.pumpTarget = next;
		}

		lock.release(); // Waiting for the return would be too long

		return res.set(await request.promise);
	}

	next(): MaybePromise<TransformedSample | null> {
		this._ensureNotClosed();

		try {
			const result = new ResultValue<TransformedSample | null>();
			const promise = this._nextInternal(result);

			if (result.pending) {
				return promise
					.then(() => result.value)
					.catch(this.closeWithErrorAndThrow.bind(this));
			} else {
				return result.value;
			}
		} catch (error) {
			this.closeWithErrorAndThrow(error);
		}
	}

	async iterate(
		callback: (sample: TransformedSample, stop: () => void) => MaybePromise<unknown>,
	) {
		this._ensureNotClosed();

		let stopped = false;
		const stop = () => stopped = true;

		const waitPromise = this.waitUntilIdle();
		if (waitPromise) await waitPromise;

		while (true) {
			if (this.current) {
				const result = callback(this.current, stop);
				if (result instanceof Promise) await result;
			}

			if (stopped) {
				break;
			}

			const result = this.next();
			if (result instanceof Promise) await result;

			if (!this.current) {
				break;
			}
		}
	}

	// eslint-disable-next-line @stylistic/generator-star-spacing
	async *[Symbol.asyncIterator]() {
		this._ensureNotClosed();

		const waitPromise = this.waitUntilIdle();
		if (waitPromise) await waitPromise;

		while (true) {
			if (this.current) {
				yield this.current;
			}

			const result = this.next();
			if (result instanceof Promise) await result;

			if (!this.current) {
				break;
			}
		}
	}

	waitUntilIdle() {
		if (this.pendingRequests.length === 0) {
			return null;
		}

		let lastRequest = last(this.pendingRequests)!;
		while (lastRequest.successor) {
			lastRequest = lastRequest.successor;
		}

		return lastRequest.promise
			.catch(() => {})
			.then(() => {});
	}

	closePromise: Promise<void> | null = null;

	close() {
		return this.closePromise ??= (async () => {
			this.predictedRequests++;
			this.packetReader.track.input._openSampleCursors.delete(this);

			using lock = this.pumpMutex.lock();
			if (lock.pending) await lock.ready;

			this._closed = true;

			if (this.pumpRunning) {
				await this.stopPump();
			}

			this.setCurrent(null, null);
			this.decoder.close();
		})();
	}

	[Symbol.asyncDispose]() {
		return this.close();
	}

	async stopPump() {
		assert(this.pumpRunning);

		this.pumpStopQueued = true;
		this.queueDequeue.resolve();
		this.queueDequeue = promiseWithResolvers();
		await this.pumpStopped.promise;
	}

	async runPump() {
		try {
			assert(this.packetCursor.current);
			assert(this.pumpTarget);

			this.pumpRunning = true;

			if (this.debugInfo.enabled) {
				this.debugInfo.pumpsStarted++;
			}

			while (
				this.packetCursor.current
				&& (
					!this.pumpStopQueued
					|| this.packetCursor.current.sequenceNumber <= this.pumpTarget.sequenceNumber
					|| this.pendingRequests.some(x => x.successor || x.timestamp === -Infinity)
				)
			) {
				if (this.debugInfo.enabled && this.debugInfo.throwInPump) {
					throw new Error('Fake pump error!');
				}

				if (
					this.packetCursor.current.sequenceNumber > this.pumpTarget.sequenceNumber
					&& this.predictedRequests > 0
					&& !this.pendingRequests.some(x => x.successor || x.timestamp === -Infinity)
				) {
					await this.queueDequeue.promise;
					continue;
				}

				const decodeQueueSize = this.decoder.getDecodeQueueSize();
				if (this.sampleQueue.length + decodeQueueSize >= 4) {
					await this.queueDequeue.promise;
					continue;
				}

				insertSorted(this.decodedTimestamps, this.packetCursor.current.timestamp, x => x);
				this.maxDecodedSequenceNumber = this.packetCursor.current.sequenceNumber;
				this.decoder.decode(this.packetCursor.current);

				if (this.debugInfo.enabled) {
					this.debugInfo.decodedPackets.push(this.packetCursor.current);
				}

				await this.packetCursor.next();
			}

			if (this.pendingRequests.length > 0 || !this._closed) {
				await this.decoder.flush();
			}

			const uh = (request: PendingRequest<TransformedSample>) => {
				request.resolve(null);
				if (request.successor) {
					uh(request.successor);
				}
			};

			this.pendingRequests.forEach(uh);
			this.setCurrent(null, null);
		} catch (error) {
			if (!this.decoder.closed && this.pendingRequests.length > 0) {
				await this.decoder.flush();
			}

			this.pumpRunning = false; // So that close() doesn't attempt to stop the pump
			void this.closeWithError(error);
		} finally {
			for (const sample of this.sampleQueue) {
				sample.close();
			}
			this.sampleQueue.length = 0;

			this.pendingRequests.length = 0;
			this.lastPendingRequest = null;
			this.pumpStopped.resolve();
			this.pumpStopped = promiseWithResolvers();
			this.pumpRunning = false;
			this.maxDecodedSequenceNumber = -1;
			this.decodedTimestamps.length = 0;
			this.pumpTarget = null;
			this.pumpStopQueued = false;
		}
	}

	closeWithError(error: unknown) {
		if (this._closed) {
			return;
		}

		this._closed = true;
		this.error = error;
		this.errorSet = true;

		const uh = (request: PendingRequest<TransformedSample>) => {
			request.reject(error);
			if (request.successor) {
				uh(request.successor);
			}
		};
		this.pendingRequests.forEach(uh);

		return this.close();
	}

	closeWithErrorAndThrow(error: unknown): never {
		void this.closeWithError(error);
		throw error;
	}
}

export class VideoSampleCursor<TransformedSample = VideoSample> extends SampleCursor<VideoSample, TransformedSample> {
	static async init<T = VideoSample>(
		reader: PacketReader<InputVideoTrack>,
		options: SampleCursorOptions<VideoSample, T> = {},
	) {
		if (!(reader instanceof PacketReader) || !(reader.track instanceof InputVideoTrack)) {
			throw new TypeError('reader must be a PacketReader for an InputVideoTrack.');
		}

		const track = reader.track;

		if (!(await track.canDecode())) {
			throw new Error(
				'This video track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		assert(track.codec);

		const decoder = new VideoDecoderWrapper(
			sample => cursor.onDecoderSample(sample),
			error => cursor.onDecoderError(error),
			track.codec,
			decoderConfig,
			track.rotation,
			track.timeResolution,
		);

		decoder.onDequeue = () => cursor.onDecoderDequeue();

		const cursor: VideoSampleCursor<T> = new VideoSampleCursor(reader, decoder, options);
		return cursor;
	}
}

export class AudioSampleCursor<TransformedSample = AudioSample> extends SampleCursor<AudioSample, TransformedSample> {
	static async init<T = AudioSample>(
		reader: PacketReader<InputAudioTrack>,
		options: SampleCursorOptions<AudioSample, T> = {},
	) {
		if (!(reader instanceof PacketReader) || !(reader.track instanceof InputAudioTrack)) {
			throw new TypeError('reader must be a PacketReader for an InputAudioTrack.');
		}

		const track = reader.track;

		if (!(await track.canDecode())) {
			throw new Error(
				'This audio track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		const codec = track.codec;
		const decoderConfig = await track.getDecoderConfig();
		assert(codec && decoderConfig);

		let decoder: AudioDecoderWrapper | PcmAudioDecoderWrapper;
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(decoderConfig.codec)) {
			decoder = new PcmAudioDecoderWrapper(
				sample => cursor.onDecoderSample(sample),
				error => cursor.onDecoderError(error),
				decoderConfig,
			);
		} else {
			decoder = new AudioDecoderWrapper(
				sample => cursor.onDecoderSample(sample),
				error => cursor.onDecoderError(error),
				codec,
				decoderConfig,
			);
		}

		decoder.onDequeue = () => cursor.onDecoderDequeue();

		const cursor: AudioSampleCursor<T> = new AudioSampleCursor(reader, decoder, options);
		return cursor;
	}
}

/**
 * A canvas with additional timing information (timestamp & duration).
 * @public
 */
export type WrappedCanvas = {
	/** A canvas element or offscreen canvas. */
	canvas: HTMLCanvasElement | OffscreenCanvas;
	/** The timestamp of the corresponding video sample, in seconds. */
	timestamp: number;
	/** The duration of the corresponding video sample, in seconds. */
	duration: number;
};

/**
 * Options for constructing a canvas transformer.
 * @public
 */
export type CanvasTransformerOptions = {
	/**
	 * Whether the output canvases should have transparency instead of a black background. Defaults to `false`. Set
	 * this to `true` when using this sink to read transparent videos.
	 */
	alpha?: boolean;
	/**
	 * The width of the output canvas in pixels, defaulting to the display width of the video track. If height is not
	 * set, it will be deduced automatically based on aspect ratio.
	 */
	width?: number;
	/**
	 * The height of the output canvas in pixels, defaulting to the display height of the video track. If width is not
	 * set, it will be deduced automatically based on aspect ratio.
	 */
	height?: number;
	/**
	 * The fitting algorithm in case both width and height are set.
	 *
	 * - `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
	 * - `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to
	 * letterboxing.
	 * - `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
	 */
	fit?: 'fill' | 'contain' | 'cover';
	/**
	 * The clockwise rotation by which to rotate the raw video frame. Defaults to the rotation set in the file metadata.
	 * Rotation is applied before resizing.
	 */
	rotation?: Rotation;
	/**
	 * Specifies the rectangular region of the input video to crop to. The crop region will automatically be clamped to
	 * the dimensions of the input video track. Cropping is performed after rotation but before resizing.
	 */
	crop?: CropRectangle;
	/**
	 * When set, specifies the number of canvases in the pool. These canvases will be reused in a ring buffer /
	 * round-robin type fashion. This keeps the amount of allocated VRAM constant and relieves the browser from
	 * constantly allocating/deallocating canvases. A pool size of 0 or `undefined` disables the pool and means a new
	 * canvas is created each time.
	 */
	poolSize?: number;
};

export const canvasTransformer = (
	options: CanvasTransformerOptions = {},
): SampleTransformer<VideoSample, WrappedCanvas> => {
	if (options && typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.alpha !== undefined && typeof options.alpha !== 'boolean') {
		throw new TypeError('options.alpha, when provided, must be a boolean.');
	}
	if (options.width !== undefined && (!Number.isInteger(options.width) || options.width <= 0)) {
		throw new TypeError('options.width, when defined, must be a positive integer.');
	}
	if (options.height !== undefined && (!Number.isInteger(options.height) || options.height <= 0)) {
		throw new TypeError('options.height, when defined, must be a positive integer.');
	}
	if (options.fit !== undefined && !['fill', 'contain', 'cover'].includes(options.fit)) {
		throw new TypeError('options.fit, when provided, must be one of "fill", "contain", or "cover".');
	}
	if (
		options.width !== undefined
		&& options.height !== undefined
		&& options.fit === undefined
	) {
		throw new TypeError(
			'When both options.width and options.height are provided, options.fit must also be provided.',
		);
	}
	if (options.rotation !== undefined && ![0, 90, 180, 270].includes(options.rotation)) {
		throw new TypeError('options.rotation, when provided, must be 0, 90, 180 or 270.');
	}
	if (options.crop !== undefined) {
		validateCropRectangle(options.crop, 'options.');
	}
	if (
		options.poolSize !== undefined
		&& (typeof options.poolSize !== 'number' || !Number.isInteger(options.poolSize) || options.poolSize < 0)
	) {
		throw new TypeError('poolSize must be a non-negative integer.');
	}

	let needsSetup = true;
	let alpha: boolean;
	let width: number;
	let height: number;
	let fit: 'fill' | 'contain' | 'cover';
	let rotation: Rotation;
	let crop: { left: number; top: number; width: number; height: number } | undefined;
	let canvasPool: (HTMLCanvasElement | OffscreenCanvas | null)[];
	let nextCanvasIndex = 0;

	return (sample) => {
		if (needsSetup) {
			rotation = options.rotation ?? sample.rotation;

			const [rotatedWidth, rotatedHeight] = rotation % 180 === 0
				? [sample.codedWidth, sample.codedHeight]
				: [sample.codedHeight, sample.codedWidth];

			crop = options.crop;
			if (crop) {
				clampCropRectangle(crop, rotatedWidth, rotatedHeight);
			}

			[width, height] = crop
				? [crop.width, crop.height]
				: [rotatedWidth, rotatedHeight];
			const originalAspectRatio = width / height;

			// If width and height aren't defined together, deduce the missing value using the aspect ratio
			if (options.width !== undefined && options.height === undefined) {
				width = options.width;
				height = Math.round(width / originalAspectRatio);
			} else if (options.width === undefined && options.height !== undefined) {
				height = options.height;
				width = Math.round(height * originalAspectRatio);
			} else if (options.width !== undefined && options.height !== undefined) {
				width = options.width;
				height = options.height;
			}

			alpha = options.alpha ?? false;
			fit = options.fit ?? 'fill';
			canvasPool = Array.from({ length: options.poolSize ?? 0 }, () => null);
			needsSetup = false;
		}

		let canvas = canvasPool[nextCanvasIndex];
		let canvasIsNew = false;

		if (!canvas) {
			if (typeof document !== 'undefined') {
				// Prefer an HTMLCanvasElement
				canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
			} else {
				canvas = new OffscreenCanvas(width, height);
			}

			if (canvasPool.length > 0) {
				canvasPool[nextCanvasIndex] = canvas;
			}

			canvasIsNew = true;
		}

		if (canvasPool.length > 0) {
			nextCanvasIndex = (nextCanvasIndex + 1) % canvasPool.length;
		}

		const context = canvas.getContext('2d', {
			alpha: alpha || isFirefox(), // Firefox has VideoFrame glitches with opaque canvases
		}) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
		assert(context);

		context.resetTransform();

		if (!canvasIsNew) {
			if (!alpha && isFirefox()) {
				context.fillStyle = 'black';
				context.fillRect(0, 0, width, height);
			} else {
				context.clearRect(0, 0, width, height);
			}
		}

		sample.drawWithFit(context, { fit, rotation, crop });

		const result = {
			canvas,
			timestamp: sample.timestamp,
			duration: sample.duration,
		};

		sample.close();
		return result;
	};
};

/**
 * An AudioBuffer with additional timing information (timestamp & duration).
 * @public
 */
export type WrappedAudioBuffer = {
	/** An AudioBuffer. */
	buffer: AudioBuffer;
	/** The timestamp of the corresponding audio sample, in seconds. */
	timestamp: number;
	/** The duration of the corresponding audio sample, in seconds. */
	duration: number;
};

export const audioBufferTransformer = (): SampleTransformer<AudioSample, WrappedAudioBuffer> => {
	return (sample) => {
		const result: WrappedAudioBuffer = {
			buffer: sample.toAudioBuffer(),
			timestamp: sample.timestamp,
			duration: sample.duration,
		};

		sample.close();
		return result;
	};
};
