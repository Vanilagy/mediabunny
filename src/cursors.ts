import { PCM_AUDIO_CODECS } from './codec';
import { InputDisposedError } from './input';
import { InputAudioTrack, InputTrack, InputVideoTrack } from './input-track';
import {
	AudioDecoderWrapper,
	DecoderWrapper,
	PacketRetrievalOptions,
	PcmAudioDecoderWrapper,
	validatePacketRetrievalOptions,
	validateTimestamp,
	VideoDecoderWrapper,
} from './media-sink';
import {
	assert,
	AsyncMutex4,
	AsyncMutexLock,
	CallSerializer2,
	defer,
	isFirefox,
	last,
	MaybePromise,
	polyfillSymbolDispose,
	promiseWithResolvers,
	ResultValue,
	Rotation,
	AsyncGate,
	Yo,
} from './misc';
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
	reader: PacketReader;
	current: TransformedSample | null = null;

	private _transform: SampleTransformer<Sample, TransformedSample>;
	private _autoClose: boolean;

	private _mutex = new AsyncMutex4();

	private _packetCursor: PacketCursor;
	/** @internal */
	_decoder: DecoderWrapper<Sample> | null = null;
	private _currentSample: Sample | null = null;
	/** The queue of samples that have been decoded and are now waiting. */
	private _sampleQueue: Sample[] = [];
	/** Used to pause and resume the pump. */
	private _pumpGate = new AsyncGate();
	private _pendingRequests: PendingRequest<TransformedSample>[] = [];
	private _lastPendingRequest: PendingRequest<TransformedSample> | null = null;
	/**
	 * When this value is above 0, the pump is instructed to be lazy: that is, only decode packets until the target and
	 * not further to increase decoder efficiency.
	 */
	private _lazyPump = 0;
	/** Whether the next sample is the first sample. */
	private _nextIsFirst = true;
	private _queuedResets = 0;

	/** @internal */
	_pumpRunning = false;
	private _pumpStopQueued = false;
	private _pumpStopped = new AsyncGate();
	/** The minimum target packet until which the pump should decode. */
	private _pumpTarget: EncodedPacket | null = null;
	private _lastTarget: EncodedPacket | null = null;

	private _closed = false;
	private _closePromise: Promise<void> | null = null;
	private _error: unknown = null;
	private _errorSet = false;

	/** @internal */
	_debug = {
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

	get errored(): boolean {
		return this._errorSet;
	}

	protected constructor(
		reader: PacketReader,
		options: SampleCursorOptions<Sample, TransformedSample>,
	) {
		this.reader = reader;
		this._packetCursor = new PacketCursor(reader);
		this._autoClose = options.autoClose ?? true;
		this._transform = options.transform ?? (sample => sample as unknown as TransformedSample);

		reader.track.input._openSampleCursors.add(this);

		const lock = this._mutex.lock();
		assert(!lock.pending);

		void this._initDecoder()
			.then(decoder => this._decoder = decoder)
			.catch(error => this._closeWithError(error, false))
			.finally(() => lock.release());
	}

	seekToFirst(): MaybePromise<TransformedSample | null> {
		return this._getSample(result => this._seekToPacket(result, this.reader.readFirst()));
	}

	seekTo(timestamp: number): MaybePromise<TransformedSample | null> {
		validateTimestamp(timestamp);
		return this._getSample(result => this._seekToPacket(result, this.reader.readAt(timestamp)));
	}

	seekToKey(timestamp: number): MaybePromise<TransformedSample | null> {
		validateTimestamp(timestamp);
		return this._getSample(result => this._seekToPacket(result, this.reader.readKeyAt(timestamp)));
	}

	next(): MaybePromise<TransformedSample | null> {
		return this._getSample(result => this._nextInternal(result));
	}

	nextKey(): MaybePromise<TransformedSample | null> {
		return this._getSample(result => this._nextKeyInternal(result));
	}

	private _getSample(
		callback: (result: ResultValue<TransformedSample | null>) => Promise<Yo>,
	): MaybePromise<TransformedSample | null> {
		this._ensureWillBeOpen();

		try {
			const result = new ResultValue<TransformedSample | null>();
			const promise = callback(result);

			if (result.pending) {
				return promise
					.then(() => result.value)
					.catch(this._closeWithErrorAndThrow.bind(this));
			} else {
				return result.value;
			}
		} catch (error) {
			this._closeWithErrorAndThrow(error);
		}
	}

	async iterate(
		callback: (sample: TransformedSample, stop: () => void) => MaybePromise<unknown>,
	) {
		if (typeof callback !== 'function') {
			throw new TypeError('callback must be a function.');
		}

		this._ensureWillBeOpen();

		const waitPromise = this.waitUntilIdle();
		if (waitPromise) await waitPromise;

		this._ensureNotClosed();

		let stopped = false;
		const stop = () => stopped = true;

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

	close() {
		return this._closePromise ??= this._closed
			? Promise.resolve()
			: this._closeInternal();
	}

	[Symbol.asyncDispose]() {
		return this.close();
	}

	async reset() {
		this._lazyPump++;

		this._queuedResets++;
		using _ = defer(() => this._queuedResets--);

		using lock = this._mutex.lock();
		if (lock.pending) await lock.ready;

		if (!this._closed) {
			await this._closeInternal(false);
		}

		// All of this should automatically be true after a close
		assert(!this._pumpRunning);
		assert(!this._pumpStopQueued);
		assert(!this._currentSample);
		assert(!this.current);
		assert(this._sampleQueue.length === 0);
		assert(this._pendingRequests.length === 0);
		assert(this._lastPendingRequest === null);
		assert(this._pumpTarget === null);
		assert(!this._decoder || this._decoder.closed);

		this._closed = false;
		this._closePromise = null;
		this._error = null;
		this._errorSet = false;
		this._nextIsFirst = true;
		this._lazyPump = 0;

		this.reader.track.input._openSampleCursors.add(this);

		try {
			const newDecoder = await this._initDecoder();
			this._decoder = newDecoder;
		} catch (error) {
			this._closeWithErrorAndThrow(error, false);
		}
	}

	/**
	 * Returns a Promise that resolves when currently pending operations (at the time of calling this method)
	 * are settled, or `null` if there are none.
	 */
	waitUntilIdle(): Promise<void> | null {
		const lock = this._mutex.lock();
		if (!lock.pending && this._pendingRequests.length === 0) {
			lock.release();
			return null;
		}

		const getLastPendingPromise = () => {
			lock.release();

			if (this._pendingRequests.length === 0) {
				return;
			}

			let lastRequest = last(this._pendingRequests)!;
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

	/** @internal */
	abstract _initDecoder(): Promise<DecoderWrapper<Sample>>;

	protected _onDecoderSample(sample: Sample): void {
		try {
			if (this._debug.enabled && this._debug.throwDecoderError) {
				sample.close();

				if (!this._closed) {
					// Let's fake a decoder error this way
					return this._onDecoderError(new Error('Fake decoder error!'));
				} else {
					return;
				}
			}

			if (this._pendingRequests.length === 0) {
				if (this._pumpStopQueued || !this._pumpRunning) {
					// Don't care about it anymore
					sample.close();
				} else {
					// Let's save it for later
					this._sampleQueue.push(sample);
				}
			} else {
				let given = false;
				let nextInsertionIndex = 0;

				// Let's hand the sample to all matching requests
				for (let i = 0; i < this._pendingRequests.length; i++) {
					const request = this._pendingRequests[i]!;
					if (request.timestamp > sample.timestamp) {
						break;
					}

					this._setCurrentRaw(sample);
					request.resolve(this._transformSample());

					this._pendingRequests.splice(i--, 1);
					given = true;

					if (request.successor) {
						// If the request has a successor request, "unlock" that successor and add it to the
						// start of the queue
						this._pendingRequests.splice(nextInsertionIndex, 0, request.successor);
						i++;
						nextInsertionIndex++;
					}
				}

				if (!given) {
					sample.close();
				}
			}

			this._pumpGate.open();
		} catch (error) {
			void this._closeWithError(error);
		}
	}

	protected _onDecoderError(error: unknown): void {
		void this._closeWithError(error);
	}

	protected _onDecoderDequeue() {
		this._pumpGate.open();
	}

	private _setCurrentRaw(newCurrentRaw: Sample | null) {
		if (this._currentSample === newCurrentRaw) {
			return;
		}

		this._currentSample?.close();
		this._currentSample = newCurrentRaw;
		this.current = null;
	}

	private _transformSample() {
		assert(this._currentSample && !this._currentSample.closed);

		if (this._autoClose) {
			// Here, the transformation is memoized: repeated calls will not transform the same sample twice.
			return this.current ??= this._transform(this._currentSample);
		} else {
			// Here, the transformation happens every time since the sample is also cloned every time
			const clone = this._currentSample.clone();
			const transformed = this._transform(clone as Sample);

			return this.current = transformed;
		}
	}

	private async _seekToPacket(
		res: ResultValue<TransformedSample | null>,
		targetPacketPromise: MaybePromise<EncodedPacket | null>,
		lock?: AsyncMutexLock,
	): Promise<Yo> {
		this._lazyPump++;

		if (!lock) {
			lock = this._mutex.lock();
			if (lock.pending) await lock.ready;
		}

		using deferred = defer(() => {
			lock?.release();
			this._lazyPump--;
		});

		this._ensureNotClosed();

		// First, let's wait for the packet to be retrieved
		const targetPacket = targetPacketPromise instanceof Promise
			? await targetPacketPromise
			: targetPacketPromise;

		if (this._debug.enabled) {
			this._debug.seekPackets.push(targetPacket);
		}

		// A null packet means we're before the first packet
		this._nextIsFirst = !targetPacket;

		if (!targetPacket) {
			this._lastTarget = null;
			this._setCurrentRaw(null);
			return res.set(null);
		}

		if (this._currentSample?.timestamp === targetPacket.timestamp && !this._currentSample.closed) {
			// We can reuse the current sample, the timestamp is the same
			return res.set(this._transformSample());
		}

		let needsNewPump: boolean;

		let lastRequest = last(this._pendingRequests) ?? null;
		while (lastRequest?.successor) {
			lastRequest = lastRequest.successor;
		}

		if (lastRequest?.timestamp === -Infinity) {
			// next() requests are queued, so in order to know if we need to start a new pump or not, we'll need to wait
			await lastRequest.promise
				.then(() => {})
				.catch(() => {});

			this._ensureNotClosed();
		}

		const lastTimestamp = Math.max(
			this._lastTarget?.timestamp ?? -Infinity,
			this._currentSample?.timestamp ?? -Infinity, // This one's revelant if we had next() requests
		);

		if (lastTimestamp !== -Infinity && lastTimestamp <= targetPacket.timestamp) {
			// First, let's see if an already-decoded sample can satisfy the request
			while (this._sampleQueue.length > 0) {
				const nextSample = this._sampleQueue.shift()!;
				this._pumpGate.open();

				if (targetPacket.timestamp <= nextSample.timestamp) {
					this._setCurrentRaw(nextSample);
					return res.set(this._transformSample());
				} else {
					nextSample.close();
				}
			}

			if (targetPacket.timestamp - lastTimestamp < 0.1) {
				// The difference is too small for it to be worth to set up a new pump (especially relevant for
				// audio tracks)
				needsNewPump = false;
			} else {
				if (this._packetCursor.current) {
					// We need to see if the target packet is ahead of the decoder, GOP-wise
					let nextKey = this.reader.readNextKey(this._packetCursor.current, { verifyKeyPackets: true });
					if (nextKey instanceof Promise) nextKey = await nextKey;

					needsNewPump = !!nextKey && targetPacket.sequenceNumber >= nextKey.sequenceNumber;
				} else {
					needsNewPump = true;
				}
			}
		} else {
			// This is the first packet or we went backwards, create a new pump
			needsNewPump = true;
		}

		if (needsNewPump && this._pumpRunning) {
			await this._stopPump();
		}

		if (!this._pumpTarget || targetPacket.sequenceNumber > this._pumpTarget.sequenceNumber) {
			this._pumpTarget = targetPacket;
		}
		this._lastTarget = targetPacket;

		if (needsNewPump) {
			// Set the cursor to the right spot
			const result = this._packetCursor.seekToKey(targetPacket.timestamp);
			if (result instanceof Promise) await result;

			// Start the new pump
			void this._runPump();
		}

		this._ensureNotClosed();

		// Add the request to the queue
		const request = promiseWithResolvers<TransformedSample | null>();
		const pendingRequest: PendingRequest<TransformedSample> = {
			timestamp: targetPacket.timestamp,
			promise: request.promise,
			resolve: request.resolve,
			reject: request.reject,
			successor: null,
		};
		this._pendingRequests.push(pendingRequest);
		this._lastPendingRequest = pendingRequest;

		this._pumpGate.open();

		deferred.execute(); // Waiting for the return would be too long

		return res.set(await request.promise);
	}

	private async _nextInternal(res: ResultValue<TransformedSample | null>): Promise<Yo> {
		using lock = this._mutex.lock();
		if (lock.pending) await lock.ready;

		this._ensureNotClosed();

		if (this._nextIsFirst) {
			// Easy, just seek to the first sample
			// await is important so that the lock doesn't release too early
			return await this._seekToPacket(res, this.reader.readFirst(), lock);
		}

		// See if the request can be satisfied using already-decoded samples
		if (this._sampleQueue.length > 0) {
			const nextSample = this._sampleQueue.shift()!;
			this._pumpGate.open();

			this._setCurrentRaw(nextSample);
			return res.set(this._transformSample());
		}

		if (!this._pumpRunning) {
			// No pump is running (but the cursor isn't closed), the pump must've reached the end
			this._setCurrentRaw(null);
			return res.set(null);
		}

		assert(this._lastPendingRequest);

		this._ensureNotClosed();

		// Instead of figuring out what the next presentation timestamp is (no easy way to do that), we simply add a
		// new request that can be fulfilled by *any* timestamp. This way, whatever the decoder produces next (and the
		// decoder is required to output samples in presentation order) is what we'll return.
		const request = promiseWithResolvers<TransformedSample | null>();
		const pendingRequest: PendingRequest<TransformedSample> = {
			timestamp: -Infinity,
			promise: request.promise,
			resolve: request.resolve,
			reject: request.reject,
			successor: null,
		};

		if (this._pendingRequests.length === 0) {
			this._pendingRequests.push(pendingRequest);
		} else {
			// The request will only get "unlocked" when the previous request is fulfilled
			this._lastPendingRequest.successor = pendingRequest;
		}
		this._lastPendingRequest = pendingRequest;

		lock.release(); // Waiting for the return would be too long

		return res.set(await request.promise);
	}

	private async _nextKeyInternal(res: ResultValue<TransformedSample | null>): Promise<Yo> {
		using lock = this._mutex.lock();
		if (lock.pending) await lock.ready;

		this._ensureNotClosed();

		if (this._nextIsFirst) {
			// await is important so that the lock doesn't release too early
			return await this._seekToPacket(res, this.reader.readFirst(), lock);
		}

		let timestampToCheck: number;

		const lastPendingRequest = last(this._pendingRequests);
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

			if (this._currentSample) {
				timestampToCheck = this._currentSample.timestamp;
			} else {
				// We're at the end
				return res.set(null);
			}
		}

		// The reason we don't just call readNextKey directly is as follows: readNextKey retrieves the next key in
		// *decode* order, however we want the next key in *presentation* order. We know that at least the key frames
		// are ascending in timestamp, so we first get the current key (based on a presentation-order search), then
		// get the next key after that, which will be the answer we're looking for.

		let key = this.reader.readKeyAt(timestampToCheck, { verifyKeyPackets: true });
		if (key instanceof Promise) key = await key;
		assert(key); // Must be

		let nextKey = this.reader.readNextKey(key, { verifyKeyPackets: true });
		if (nextKey instanceof Promise) nextKey = await nextKey;

		if (!nextKey) {
			this._setCurrentRaw(null);
			return res.set(null);
		}

		return await this._seekToPacket(res, nextKey, lock);
	}

	/**
	 * Starts the "pump process", which handles pushing packets into the decoder. It throttles itself if it is far
	 * enough ahead and must be woken up again by the outside. It also stops itself when the outside tells it to.
	 */
	private async _runPump() {
		assert(this._packetCursor.current);
		assert(this._pumpTarget);
		assert(this._decoder);

		try {
			this._pumpRunning = true;

			if (this._debug.enabled) {
				this._debug.pumpsStarted++;
			}

			// Main loop
			while (this._packetCursor.current) {
				if (this._debug.enabled && this._debug.throwInPump) {
					throw new Error('Fake pump error!');
				}

				const isAheadOfTarget = this._packetCursor.current.sequenceNumber > this._pumpTarget.sequenceNumber;
				const nextRequestExists = this._pendingRequests.some(x => x.successor || x.timestamp === -Infinity);
				if (isAheadOfTarget && !nextRequestExists) {
					if (this._pumpStopQueued) {
						break;
					}

					if (this._lazyPump > 0) {
						await this._pumpGate.wait();
						continue;
					} else {
						// We're eager! That means even if we're past the target, we'll keep decoding samples to
						// prefill the sample queue to have samples ready. This is the common case when not batching
						// commands.
					}
				}

				const decodeQueueSize = this._decoder.getDecodeQueueSize();
				if (this._sampleQueue.length + decodeQueueSize >= 4 && !this._pumpStopQueued) {
					await this._pumpGate.wait();
					continue;
				}

				// Send the packet to the decoder
				this._decoder.decode(this._packetCursor.current);

				if (this._debug.enabled) {
					this._debug.decodedPackets.push(this._packetCursor.current);
				}

				// Advance the cursor
				const maybePromise = this._packetCursor.next();
				if (maybePromise instanceof Promise) await maybePromise;
			}

			if (this._pendingRequests.length > 0 || !this._closed) {
				await this._decoder.flush();
			}

			const resolveWithNull = (request: PendingRequest<TransformedSample>) => {
				request.resolve(null);
				if (request.successor) {
					resolveWithNull(request.successor);
				}
			};

			// Resolve whatever requests remain with null
			this._setCurrentRaw(null);
			this._pendingRequests.forEach(resolveWithNull);
		} catch (error) {
			if (!this._decoder.closed && this._pendingRequests.length > 0) {
				// The pump errored but the decoder is still fine, let's first flush the decoder before continuing
				await this._decoder.flush();
			}

			this._pumpRunning = false; // So that close() doesn't attempt to stop the pump
			void this._closeWithError(error);
		} finally {
			for (const sample of this._sampleQueue) {
				sample.close();
			}
			this._sampleQueue.length = 0;

			this._pendingRequests.length = 0;
			this._lastPendingRequest = null;
			this._pumpRunning = false;
			this._pumpTarget = null;
			this._pumpStopQueued = false;
			this._lastTarget = null;

			this._pumpStopped.open();
		}
	}

	private async _stopPump() {
		assert(this._pumpRunning);

		this._pumpStopQueued = true;
		this._pumpGate.open();
		await this._pumpStopped.wait();
	}

	private async _closeInternal(doLock = true) {
		this._lazyPump++;
		this.reader.track.input._openSampleCursors.delete(this);

		let lock: AsyncMutexLock | null = null;
		if (doLock) {
			lock = this._mutex.lock();
			if (lock.pending) await lock.ready;
		}
		using _ = defer(() => lock?.release());

		this._closed = true;

		if (this._pumpRunning) {
			await this._stopPump();
		}

		this._setCurrentRaw(null);
		this._decoder?.close();
		this._decoder = null;
	}

	private _closeWithError(error: unknown, doLock?: boolean) {
		if (this._closed) {
			return;
		}

		this._closed = true;
		this._error = error;
		this._errorSet = true;

		const rejectWithError = (request: PendingRequest<TransformedSample>) => {
			request.reject(error);
			if (request.successor) {
				rejectWithError(request.successor);
			}
		};
		this._pendingRequests.forEach(rejectWithError);

		return this._closeInternal(doLock);
	}

	private _closeWithErrorAndThrow(error: unknown, doLock?: boolean): never {
		void this._closeWithError(error, doLock);
		throw error;
	}

	/** Ensures that the cursor is not currently closed. */
	private _ensureNotClosed() {
		if (this.closed) {
			if (this._errorSet) {
				throw this._error;
			} else {
				throw new Error('This cursor has been closed and can no longer be used.');
			}
		}
	}

	/** Ensures that the cursor is either open or will be open again at some point, even if it currently closed. */
	private _ensureWillBeOpen() {
		if (this._queuedResets > 0) {
			return;
		}

		this._ensureNotClosed();
	}
}

export class VideoSampleCursor<TransformedSample = VideoSample> extends SampleCursor<VideoSample, TransformedSample> {
	override reader!: PacketReader<InputVideoTrack>;

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

	/** @internal */
	override async _initDecoder(): Promise<DecoderWrapper<VideoSample>> {
		const track = this.reader.track;

		if (!(await track.canDecode())) {
			throw new Error(
				'This video track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		if (this._debug.enabled && this._debug.throwInDecoderInit) {
			throw new Error('Fake decoder init error!');
		}

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		assert(track.codec);

		const decoder = new VideoDecoderWrapper(
			sample => this._onDecoderSample(sample),
			error => this._onDecoderError(error),
			track.codec,
			decoderConfig,
			track.rotation,
			track.timeResolution,
		);

		decoder.onDequeue = () => this._onDecoderDequeue();

		return decoder;
	}
}

export class AudioSampleCursor<TransformedSample = AudioSample> extends SampleCursor<AudioSample, TransformedSample> {
	override reader!: PacketReader<InputAudioTrack>;

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

	/** @internal */
	override async _initDecoder(): Promise<DecoderWrapper<AudioSample>> {
		const track = this.reader.track;

		if (!(await track.canDecode())) {
			throw new Error(
				'This audio track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		if (this._debug.enabled && this._debug.throwInDecoderInit) {
			throw new Error('Fake decoder init error!');
		}

		const codec = track.codec;
		const decoderConfig = await track.getDecoderConfig();
		assert(codec && decoderConfig);

		let decoder: AudioDecoderWrapper | PcmAudioDecoderWrapper;
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(decoderConfig.codec)) {
			decoder = new PcmAudioDecoderWrapper(
				sample => this._onDecoderSample(sample),
				error => this._onDecoderError(error),
				decoderConfig,
			);
		} else {
			decoder = new AudioDecoderWrapper(
				sample => this._onDecoderSample(sample),
				error => this._onDecoderError(error),
				codec,
				decoderConfig,
			);
		}

		decoder.onDequeue = () => this._onDecoderDequeue();

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
 * Options for constructing a canvas transformer to be used with {@link VideoSampleCursor}.
 * @public
 */
export type CanvasTransformerOptions = {
	/**
	 * Whether the output canvases should have transparency instead of a black background. Defaults to `false`. Set
	 * this to `true` when reading transparent videos.
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
