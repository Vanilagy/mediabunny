// Two parallelism modes: Cancel and queue (right?)
// Useful in packet context? Or only for sample?

import { PCM_AUDIO_CODECS } from './codec';
import { InputDisposedError } from './input';
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

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

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

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

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

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

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

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

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

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

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
	current: EncodedPacket | null = null;

	private _options: PacketRetrievalOptions;
	private _nextIsFirst = true;
	private _callSerializer = new CallSerializer2();

	constructor(reader: PacketReader, options: PacketRetrievalOptions = {}) {
		if (!(reader instanceof PacketReader)) {
			throw new TypeError('reader must be a PacketReader.');
		}
		validatePacketRetrievalOptions(options);

		this.reader = reader;
		this._options = options;
	}

	private _seekToFirstDirect(): MaybePromise<EncodedPacket | null> {
		const result = this.reader.readFirst(this._options);

		const onPacket = (packet: EncodedPacket | null) => {
			this._nextIsFirst = false;
			return this.current = packet;
		};

		if (result instanceof Promise) {
			return result.then(onPacket);
		} else {
			return onPacket(result);
		}
	}

	seekToFirst(): MaybePromise<EncodedPacket | null> {
		return this._callSerializer.call(() => this._seekToFirstDirect());
	}

	seekTo(timestamp: number): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);

		return this._callSerializer.call(() => {
			const result = this.reader.readAt(timestamp, this._options);

			const onPacket = (packet: EncodedPacket | null) => {
				this._nextIsFirst = !packet;
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
		validateTimestamp(timestamp);

		return this._callSerializer.call(() => {
			const result = this.reader.readKeyAt(timestamp, this._options);

			const onPacket = (packet: EncodedPacket | null) => {
				this._nextIsFirst = !packet;
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
		return this._callSerializer.call(() => {
			if (this._nextIsFirst) {
				return this._seekToFirstDirect();
			}

			if (!this.current) {
				return null;
			}

			const result = this.reader.readNext(this.current, this._options);

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
		return this._callSerializer.call(() => {
			if (this._nextIsFirst) {
				return this._seekToFirstDirect();
			}

			if (!this.current) {
				return null;
			}

			const result = this.reader.readNextKey(this.current, this._options);

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
		if (typeof callback !== 'function') {
			throw new TypeError('callback must be a function.');
		}

		let stopped = false;
		const stop = () => stopped = true;

		const donePromise = this._callSerializer.done();
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
		const donePromise = this._callSerializer.done();
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
		return this._callSerializer.done();
	}
}

type PendingRequest<T> = {
	timestamp: number;
	promise: Promise<T | null>;
	resolve: (sample: T | null) => void;
	reject: (error: unknown) => void;
	successor: PendingRequest<T> | null;
};

type SampleTransformer<Sample, TransformedSample> = (sample: Sample) => TransformedSample;

type SampleCursorOptions<Sample, TransformedSample> = {
	autoClose?: boolean;
	transform?: SampleTransformer<Sample, TransformedSample>;
};

const validateSampleCursorOptions = <Sample, TransformedSample>(
	options: SampleCursorOptions<Sample, TransformedSample>,
) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must an object.');
	}
	if (options.autoClose !== undefined && typeof options.autoClose !== 'boolean') {
		throw new TypeError('options.autoClose, when provided, must be a boolean.');
	}
	if (options.transform !== undefined && typeof options.transform !== 'function') {
		throw new TypeError('options.transform, when provided, must be a function.');
	}
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
	decoder: DecoderWrapper<Sample> | null = null;
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

	pumpTarget: EncodedPacket | null = null;
	lastTarget: EncodedPacket | null = null;
	pumpMutex = new AsyncMutex4();
	_closed = false;
	queuedResets = 0;

	error: unknown = null;
	errorSet = false;

	debugInfo = {
		enabled: false,
		pumpsStarted: 0,
		seekPackets: [] as (EncodedPacket | null)[],
		decodedPackets: [] as EncodedPacket[],
		throwInDecoderInit: false,
		throwInPump: false,
		throwDecoderError: false,
	};

	get closed(): boolean {
		return this._closed;
	}

	abstract initDecoder(): Promise<DecoderWrapper<Sample>>;

	protected constructor(
		reader: PacketReader,
		options: SampleCursorOptions<Sample, TransformedSample>,
	) {
		this.packetReader = reader;
		this.packetCursor = new PacketCursor(reader);
		this.options = options;
		this.autoClose = options.autoClose ?? true;
		this.transform = options.transform ?? (sample => sample as unknown as TransformedSample);

		reader.track.input._openSampleCursors.add(this);

		const lock = this.pumpMutex.lock();
		assert(!lock.pending);

		void this.initDecoder()
			.then(decoder => this.decoder = decoder)
			.catch(error => this.closeWithError(error, false))
			.finally(() => lock.release());
	}

	transformSample() {
		assert(this.currentRaw && !this.currentRaw.closed);

		if (this.autoClose) {
			return this.current ??= this.transform(this.currentRaw);
		} else {
			const clone = this.currentRaw.clone();
			const transformed = this.transform(clone as Sample);

			return this.current = transformed;
		}
	}

	onDecoderSample(sample: Sample): void {
		try {
			if (this.debugInfo.enabled && this.debugInfo.throwDecoderError) {
				sample.close();

				if (!this._closed) {
					return this.onDecoderError(new Error('Fake decoder error!'));
				} else {
					return;
				}
			}

			if (this.pendingRequests.length === 0) {
				if (this.pumpStopQueued) {
					sample.close();
				} else {
					this.sampleQueue.push(sample);
				}
			} else {
				let given = false;

				for (let i = 0; i < this.pendingRequests.length; i++) {
					const request = this.pendingRequests[i]!;
					if (request.timestamp > sample.timestamp) {
						break;
					}

					this.setCurrentRaw(sample);
					request.resolve(this.transformSample());

					this.pendingRequests.splice(i--, 1);
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
			void this.closeWithError(error);
		}
	}

	onDecoderError(error: unknown): void {
		void this.closeWithError(error);
	}

	onDecoderDequeue() {
		this.queueDequeue.resolve();
		this.queueDequeue = promiseWithResolvers();
	}

	setCurrentRaw(newCurrentRaw: Sample | null) {
		if (this.currentRaw === newCurrentRaw) {
			return;
		}

		this.currentRaw?.close();
		this.currentRaw = newCurrentRaw;
		this.current = null;
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

	_ensureWillBeOpen() {
		if (this.queuedResets > 0) {
			return;
		}

		this._ensureNotClosed();
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

		using deferred = defer(() => {
			lock?.release();
			this.predictedRequests--;
		});

		this._ensureNotClosed();

		const targetPacket = targetPacketPromise instanceof Promise
			? await targetPacketPromise
			: targetPacketPromise;

		if (this.debugInfo.enabled) {
			this.debugInfo.seekPackets.push(targetPacket);
		}

		this.nextIsFirst = !targetPacket;

		if (!targetPacket) {
			this.lastTarget = null;
			this.setCurrentRaw(null);
			return res.set(null);
		}

		if (this.currentRaw?.timestamp === targetPacket.timestamp && !this.currentRaw.closed) {
			return res.set(this.transformSample());
		}

		let setNewPump = true;

		if (this.lastTarget && this.lastTarget.timestamp <= targetPacket.timestamp) {
			while (this.sampleQueue.length > 0) {
				const nextSample = this.sampleQueue.shift()!;
				this.queueDequeue.resolve();
				this.queueDequeue = promiseWithResolvers();

				if (targetPacket.timestamp <= nextSample.timestamp) {
					this.setCurrentRaw(nextSample);
					return res.set(this.transformSample());
				} else {
					nextSample.close();
				}
			}

			if (targetPacket.timestamp - this.lastTarget.timestamp < 0.1) {
				setNewPump = false;
			} else {
				let key = this.packetReader.readNextKey(this.lastTarget, { verifyKeyPackets: true });
				if (key instanceof Promise) key = await key;

				if (
					!key
					|| targetPacket.sequenceNumber < key.sequenceNumber
				) {
					setNewPump = false;
				}
			}
		}

		if (setNewPump && this.pumpRunning) {
			await this.stopPump();
		}

		this.lastTarget = targetPacket;

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
		this._ensureWillBeOpen();

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
		validateTimestamp(timestamp);
		this._ensureWillBeOpen();

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
		validateTimestamp(timestamp);
		this._ensureWillBeOpen();

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
			// await is important so that the lock doesn't release too early
			return await this._seekToPacket(res, this.packetReader.readFirst(), lock);
		}

		if (this.sampleQueue.length > 0) {
			const nextSample = this.sampleQueue.shift()!;
			this.queueDequeue.resolve();
			this.queueDequeue = promiseWithResolvers();

			this.setCurrentRaw(nextSample);
			return res.set(this.transformSample());
		}

		if (!this.pumpRunning) {
			this.setCurrentRaw(null);
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

		lock.release(); // Waiting for the return would be too long

		return res.set(await request.promise);
	}

	next(): MaybePromise<TransformedSample | null> {
		this._ensureWillBeOpen();

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

	async _nextKeyInternal(res: ResultValue<TransformedSample | null>): Promise<Yo> {
		using lock = this.pumpMutex.lock();
		if (lock.pending) await lock.ready;

		this._ensureNotClosed();

		if (this.nextIsFirst) {
			// await is important so that the lock doesn't release too early
			return await this._seekToPacket(res, this.packetReader.readFirst(), lock);
		}

		let timestampToCheck: number;

		const lastPendingRequest = last(this.pendingRequests);
		if (lastPendingRequest && !lastPendingRequest.successor) {
			timestampToCheck = lastPendingRequest.timestamp;
		} else {
			if (lastPendingRequest?.successor) {
				let last = lastPendingRequest.successor;
				while (last.successor) {
					last = last.successor;
				}

				await last.promise
					.then(() => {})
					.catch(() => {});

				this._ensureNotClosed();
			}

			if (this.currentRaw) {
				timestampToCheck = this.currentRaw.timestamp;
			} else {
				// We're at the end
				return res.set(null);
			}
		}

		// The reason we don't just call readNextKey directly is as follows: readNextKey retrieves the next key in
		// *decode* order, however we want the next key in *presentation* order. We know that at least the key frames
		// are ascending in timestamp, so we first get the current key (based on a presentation-order search), then
		// get the next key after that, which will be the answer we're looking for.

		let key = this.packetReader.readKeyAt(timestampToCheck, { verifyKeyPackets: true });
		if (key instanceof Promise) key = await key;
		assert(key); // Must be

		let nextKey = this.packetReader.readNextKey(key, { verifyKeyPackets: true });
		if (nextKey instanceof Promise) nextKey = await nextKey;

		if (!nextKey) {
			this.setCurrentRaw(null);
			return res.set(null);
		}

		return await this._seekToPacket(res, nextKey, lock);
	}

	nextKey(): MaybePromise<TransformedSample | null> {
		this._ensureWillBeOpen();

		try {
			const result = new ResultValue<TransformedSample | null>();
			const promise = this._nextKeyInternal(result);

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
		if (typeof callback !== 'function') {
			throw new TypeError('callback must be a function.');
		}

		this._ensureWillBeOpen();

		let stopped = false;
		const stop = () => stopped = true;

		const waitPromise = this.waitUntilIdle();
		if (waitPromise) await waitPromise;

		this._ensureNotClosed();

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
		this._ensureWillBeOpen();

		const waitPromise = this.waitUntilIdle();
		if (waitPromise) await waitPromise;

		this._ensureNotClosed();

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

	waitUntilIdle(): Promise<void> | null {
		const lock = this.pumpMutex.lock();
		if (!lock.pending && this.pendingRequests.length === 0) {
			lock.release();
			return null;
		}

		const getLastPendingPromise = () => {
			lock.release();

			if (this.pendingRequests.length === 0) {
				return;
			}

			let lastRequest = last(this.pendingRequests)!;
			while (lastRequest.successor) {
				lastRequest = lastRequest.successor;
			}

			return lastRequest.promise
				.catch(() => {})
				.then(() => {});
		};

		if (lock.pending) {
			assert(lock.ready);
			return lock.ready.then(getLastPendingPromise);
		} else {
			return getLastPendingPromise() ?? null;
		}
	}

	closePromise: Promise<void> | null = null;

	close() {
		return this.closePromise ??= this._closed
			? Promise.resolve()
			: this.closeInternal();
	}

	async closeInternal(doLock = true) {
		// Almost correct, but not quite
		this.predictedRequests++;
		this.packetReader.track.input._openSampleCursors.delete(this);

		let lock: AsyncMutexLock | null = null;
		if (doLock) {
			lock = this.pumpMutex.lock();
			if (lock.pending) await lock.ready;
		}
		using _ = defer(() => lock?.release());

		this._closed = true;

		if (this.pumpRunning) {
			await this.stopPump();
		}

		this.setCurrentRaw(null);
		this.decoder?.close();
		this.decoder = null;
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
		assert(this.packetCursor.current);
		assert(this.pumpTarget);
		assert(this.decoder);

		try {
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

				this.decoder.decode(this.packetCursor.current);

				if (this.debugInfo.enabled) {
					this.debugInfo.decodedPackets.push(this.packetCursor.current);
				}

				const maybePromise = this.packetCursor.next();
				if (maybePromise instanceof Promise) await maybePromise;
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

			this.setCurrentRaw(null);
			this.pendingRequests.forEach(uh);
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
			this.pumpTarget = null;
			this.pumpStopQueued = false;
			this.lastTarget = null;
		}
	}

	closeWithError(error: unknown, doLock?: boolean) {
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

		return this.closeInternal(doLock);
	}

	closeWithErrorAndThrow(error: unknown, doLock?: boolean): never {
		void this.closeWithError(error, doLock);
		throw error;
	}

	async reset() {
		this.predictedRequests++;

		this.queuedResets++;
		using _ = defer(() => this.queuedResets--);

		using lock = this.pumpMutex.lock();
		if (lock.pending) await lock.ready;

		if (!this._closed) {
			await this.closeInternal(false);
		}

		assert(!this.pumpRunning);
		assert(!this.pumpStopQueued);
		assert(!this.currentRaw);
		assert(!this.current);
		assert(this.sampleQueue.length === 0);
		assert(this.pendingRequests.length === 0);
		assert(this.lastPendingRequest === null);
		assert(this.pumpTarget === null);
		assert(!this.decoder || this.decoder.closed);

		this._closed = false;
		this.closePromise = null;
		this.error = null;
		this.errorSet = false;
		this.nextIsFirst = true;
		this.predictedRequests = 0;

		this.packetReader.track.input._openSampleCursors.add(this);

		try {
			const newDecoder = await this.initDecoder();
			this.decoder = newDecoder;
		} catch (error) {
			this.closeWithErrorAndThrow(error);
		}
	}
}

export class VideoSampleCursor<TransformedSample = VideoSample> extends SampleCursor<VideoSample, TransformedSample> {
	override packetReader!: PacketReader<InputVideoTrack>;

	constructor(
		reader: PacketReader<InputVideoTrack>,
		options: SampleCursorOptions<VideoSample, TransformedSample> = {},
	) {
		if (!(reader instanceof PacketReader) || !(reader.track instanceof InputVideoTrack)) {
			throw new TypeError('reader must be a PacketReader for an InputVideoTrack.');
		}
		validateSampleCursorOptions(options);

		super(reader, options);
	}

	override async initDecoder(): Promise<DecoderWrapper<VideoSample>> {
		const track = this.packetReader.track;

		if (!(await track.canDecode())) {
			throw new Error(
				'This video track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		if (this.debugInfo.enabled && this.debugInfo.throwInDecoderInit) {
			throw new Error('Fake decoder init error!');
		}

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		assert(track.codec);

		const decoder = new VideoDecoderWrapper(
			sample => this.onDecoderSample(sample),
			error => this.onDecoderError(error),
			track.codec,
			decoderConfig,
			track.rotation,
			track.timeResolution,
		);

		decoder.onDequeue = () => this.onDecoderDequeue();

		return decoder;
	}
}

export class AudioSampleCursor<TransformedSample = AudioSample> extends SampleCursor<AudioSample, TransformedSample> {
	override packetReader!: PacketReader<InputAudioTrack>;

	constructor(
		reader: PacketReader<InputAudioTrack>,
		options: SampleCursorOptions<AudioSample, TransformedSample> = {},
	) {
		if (!(reader instanceof PacketReader) || !(reader.track instanceof InputAudioTrack)) {
			throw new TypeError('reader must be a PacketReader for an InputAudioTrack.');
		}
		validateSampleCursorOptions(options);

		super(reader, options);
	}

	override async initDecoder(): Promise<DecoderWrapper<AudioSample>> {
		const track = this.packetReader.track;

		if (!(await track.canDecode())) {
			throw new Error(
				'This audio track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		if (this.debugInfo.enabled && this.debugInfo.throwInDecoderInit) {
			throw new Error('Fake decoder init error!');
		}

		const codec = track.codec;
		const decoderConfig = await track.getDecoderConfig();
		assert(codec && decoderConfig);

		let decoder: AudioDecoderWrapper | PcmAudioDecoderWrapper;
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(decoderConfig.codec)) {
			decoder = new PcmAudioDecoderWrapper(
				sample => this.onDecoderSample(sample),
				error => this.onDecoderError(error),
				decoderConfig,
			);
		} else {
			decoder = new AudioDecoderWrapper(
				sample => this.onDecoderSample(sample),
				error => this.onDecoderError(error),
				codec,
				decoderConfig,
			);
		}

		decoder.onDequeue = () => this.onDecoderDequeue();

		return decoder;
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
