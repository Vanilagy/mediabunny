// Two parallelism modes: Cancel and queue (right?)
// Useful in packet context? Or only for sample?

import { InputTrack, InputVideoTrack } from './input-track';
import { PacketRetrievalOptions, validatePacketRetrievalOptions, validateTimestamp, VideoDecoderWrapper } from './media-sink';
import { assert, assertNever, AsyncMutex, AsyncMutex2, AsyncMutex3, AsyncMutexLock, CallSerializer2, defer, insertSorted, last, MaybePromise, promiseWithResolvers, ResultValue, Yo } from './misc';
import { EncodedPacket } from './packet';
import { VideoSample } from './sample';

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

/*
export class PacketCursor {
	track: InputTrack;
	current: EncodedPacket | null = null;
	nextIsFirst = true;
	callSerializer = new CallSerializer2();

	constructor(track: InputTrack) {
		if (!(track instanceof InputTrack)) {
			throw new TypeError('track must be an InputTrack.');
		}

		this.track = track;
	}

	peekAtStart(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validatePacketRetrievalOptions(options);

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getFirstPacket(result, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekToStartDirect(options: PacketRetrievalOptions): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getFirstPacket(result, options);

		const onPacket = () => {
			this.nextIsFirst = false;
			return this.current = result.value;
		};

		if (result.pending) {
			return (promise as Promise<Yo>).then(onPacket);
		} else {
			return onPacket();
		}
	}

	seekToStart(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validatePacketRetrievalOptions(options);

		return this.callSerializer.call(() => this.seekToStartDirect(options));
	}

	peekAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getPacket(result, timestamp, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekTo(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		return this.callSerializer.call(() => {
			const result = new ResultValue<EncodedPacket | null>();
			const promise = this.track._backing.getPacket(result, timestamp, options);

			const onPacket = () => {
				this.nextIsFirst = !result.value;
				return this.current = result.value;
			};

			if (result.pending) {
				return (promise as Promise<Yo>).then(onPacket);
			} else {
				return onPacket();
			}
		});
	}

	peekKeyAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getKeyPacket(result, timestamp, options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekToKey(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		return this.callSerializer.call(() => {
			const result = new ResultValue<EncodedPacket | null>();
			const promise = this.track._backing.getKeyPacket(result, timestamp, options);

			const onPacket = () => {
				this.nextIsFirst = !result.value;
				return this.current = result.value;
			};

			if (result.pending) {
				return (promise as Promise<Yo>).then(onPacket);
			} else {
				return onPacket();
			}
		});
	}

	peekNext(from?: EncodedPacket | null, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (from != null && !(from instanceof EncodedPacket)) {
			throw new TypeError('from, when provided, must be an EncodedPacket or null.');
		}
		validatePacketRetrievalOptions(options);

		const run = () => {
			if (from === null) {
				if (this.nextIsFirst) {
					return this.peekAtStart();
				} else {
					return null;
				}
			}

			assert(from);

			const result = new ResultValue<EncodedPacket | null>();
			const promise = this.track._backing.getNextPacket(result, from, options);

			if (result.pending) {
				return (promise as Promise<Yo>).then(() => result.value);
			} else {
				return result.value;
			}
		};

		if (from === undefined) {
			return this.callSerializer.call(() => {
				from = this.current;
				return run();
			});
		} else {
			return run();
		}
	}

	next(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validatePacketRetrievalOptions(options);

		return this.callSerializer.call(() => {
			if (this.nextIsFirst) {
				return this.seekToStartDirect(options);
			}

			if (!this.current) {
				return null;
			}

			const result = new ResultValue<EncodedPacket | null>();
			const promise = this.track._backing.getNextPacket(result, this.current, options);

			const onPacket = () => {
				return this.current = result.value;
			};

			if (result.pending) {
				return (promise as Promise<Yo>).then(onPacket);
			} else {
				return onPacket();
			}
		});
	}

	peekNextKey(from?: EncodedPacket | null, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (from != null && !(from instanceof EncodedPacket)) {
			throw new TypeError('from, when provided, must be an EncodedPacket or null.');
		}
		validatePacketRetrievalOptions(options);

		const run = () => {
			if (from === null) {
				if (this.nextIsFirst) {
					return this.peekAtStart();
				} else {
					return null;
				}
			}

			assert(from);

			const result = new ResultValue<EncodedPacket | null>();
			const promise = this.track._backing.getNextKeyPacket(result, from, options);

			if (result.pending) {
				return (promise as Promise<Yo>).then(() => result.value);
			} else {
				return result.value;
			}
		};

		if (from === undefined) {
			return this.callSerializer.call(() => {
				from = this.current;
				return run();
			});
		} else {
			return run();
		}
	}

	nextKey(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		return this.callSerializer.call(() => {
			if (this.nextIsFirst) {
				return this.seekToStartDirect(options);
			}

			if (!this.current) {
				return null;
			}

			const result = new ResultValue<EncodedPacket | null>();
			const promise = this.track._backing.getNextKeyPacket(result, this.current, options);

			if (result.pending) {
				return (promise as Promise<Yo>).then(() => {
					return this.current = result.value;
				});
			} else {
				return this.current = result.value;
			}
		});
	}

	async iterate(
		callback: (packet: EncodedPacket, stop: () => void) => MaybePromise<unknown>,
		options: PacketRetrievalOptions = {},
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
*/

/*
for (const timestamp of timestamps) {
	const thumbnail = await cursor.seekTo(timestamp);
	console.log(thumbnail);
}
*/

type PendingRequest = {
	timestamp: number;
	promise: Promise<VideoSample | null>;
	resolve: (sample: VideoSample | null) => void;
	reject: (error: unknown) => void;
	successor: PendingRequest | null;
};

type VideoSampleCursorOptions = {
	autoClose?: boolean;
};

export class VideoSampleCursor {
	packetReader: PacketReader<InputVideoTrack>;
	packetCursor: PacketCursor;
	options: VideoSampleCursorOptions;
	autoClose: boolean;
	pumpRunning = false;
	decoder: VideoDecoderWrapper;
	current: VideoSample | null = null;
	sampleQueue: VideoSample[] = [];
	queueDequeue = promiseWithResolvers();
	pendingRequests: PendingRequest[] = [];
	lastPendingRequest: PendingRequest | null = null;

	predictedRequests = 0;
	nextIsFirst = true;

	pumpStopQueued = false;
	pumpStopped = promiseWithResolvers();

	decodedTimestamps: number[] = [];
	maxDecodedSequenceNumber = -1;
	pumpTarget: EncodedPacket | null = null;
	pumpMutex = new AsyncMutex3();
	closed = false;

	debugInfo = {
		enabled: false,
		pumpsStarted: 0,
		seekPackets: [] as (EncodedPacket | null)[],
		decodedPackets: [] as EncodedPacket[],
		throwInPump: false,
	};

	private constructor(
		reader: PacketReader<InputVideoTrack>,
		decoder: VideoDecoderWrapper,
		options: VideoSampleCursorOptions,
	) {
		this.packetReader = reader;
		this.decoder = decoder;
		this.packetCursor = new PacketCursor(reader);
		this.options = options;
		this.autoClose = options.autoClose ?? true;
	}

	static async init(reader: PacketReader<InputVideoTrack>, options: VideoSampleCursorOptions = {}) {
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
			(sample) => {
				while (cursor.decodedTimestamps.length > 0 && cursor.decodedTimestamps[0]! <= sample.timestamp) {
					cursor.decodedTimestamps.shift();
				}

				if (cursor.pendingRequests.length === 0) {
					if (cursor.pumpStopQueued) {
						sample.close();
					} else {
						cursor.sampleQueue.push(sample);
					}
				} else {
					let given = false;

					for (let i = 0; i < cursor.pendingRequests.length; i++) {
						const request = cursor.pendingRequests[i]!;
						if (request.timestamp > sample.timestamp) {
							break;
						}

						request.resolve(sample);
						cursor.pendingRequests.splice(i--, 1);
						cursor.setCurrent(sample);
						given = true;

						if (request.successor) {
							cursor.pendingRequests.unshift(request.successor);
							i++;
						}
					}

					if (!given) {
						sample.close();
					}
				}

				cursor.queueDequeue.resolve();
				cursor.queueDequeue = promiseWithResolvers();
			},
			(error) => {
				// TODO THIS TODO THIS TODO THIS TODO THIS
				console.error(error);
			},
			track.codec,
			decoderConfig,
			track.rotation,
			track.timeResolution,
		);

		decoder.onDequeue = () => {
			cursor.queueDequeue.resolve();
			cursor.queueDequeue = promiseWithResolvers();
		};

		const cursor = new VideoSampleCursor(reader, decoder, options);
		return cursor;
	}

	setCurrent(newCurrent: VideoSample | null) {
		if (this.autoClose && this.current && this.current !== newCurrent) {
			this.current.close();
		}

		this.current = newCurrent;
	}

	getNextExpectedTimestamp() {
		if (this.sampleQueue.length > 0) {
			return this.sampleQueue[0]!.timestamp;
		}
	}

	_ensureNotClosed() {
		if (this.closed) {
			throw new Error('This cursor has been closed and can no longer be used.');
		}
	}

	async _seekToPacket(
		res: ResultValue<VideoSample | null>,
		targetPacketPromise: MaybePromise<EncodedPacket | null>,
		lock?: AsyncMutexLock,
	): Promise<Yo> {
		this.predictedRequests++;

		if (!lock) {
			const mutexPromise = this.pumpMutex.request();
			if (mutexPromise) {
				await mutexPromise;
			}
			lock = this.pumpMutex.lock();
		}

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
			this.setCurrent(null);
			return res.set(null);
		}

		if (this.current?.timestamp === targetPacket.timestamp) {
			return res.set(this.current);
		}

		let setNewPump = true;

		if (this.sampleQueue.length > 0 && targetPacket.timestamp < this.sampleQueue[0]!.timestamp) {

		} else {
			while (this.sampleQueue.length > 0) {
				const nextSample = this.sampleQueue[0]!;
				if (targetPacket.timestamp <= nextSample.timestamp) {
					this.setCurrent(nextSample);
					return res.set(nextSample);
				}

				this.sampleQueue.shift();
				this.queueDequeue.resolve();
				this.queueDequeue = promiseWithResolvers();
				nextSample.close();
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

		const request = promiseWithResolvers<VideoSample | null>();
		const pendingRequest: PendingRequest = {
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

	seekToFirst(): MaybePromise<VideoSample | null> {
		this._ensureNotClosed();

		const result = new ResultValue<VideoSample | null>();
		const promise = this._seekToPacket(result, this.packetReader.readFirst());

		if (result.pending) {
			return promise.then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekTo(timestamp: number): MaybePromise<VideoSample | null> {
		this._ensureNotClosed();

		const result = new ResultValue<VideoSample | null>();
		const promise = this._seekToPacket(result, this.packetReader.readAt(timestamp));

		if (result.pending) {
			return promise.then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekToKey(timestamp: number): MaybePromise<VideoSample | null> {
		this._ensureNotClosed();

		const result = new ResultValue<VideoSample | null>();
		const promise = this._seekToPacket(result, this.packetReader.readKeyAt(timestamp, { verifyKeyPackets: true }));

		if (result.pending) {
			return promise.then(() => result.value);
		} else {
			return result.value;
		}
	}

	async _nextInternal(res: ResultValue<VideoSample | null>): Promise<Yo> {
		const mutexPromise = this.pumpMutex.request();
		if (mutexPromise) await mutexPromise;
		using lock = this.pumpMutex.lock();

		if (this.nextIsFirst) {
			return await this._seekToPacket(res, this.packetReader.readFirst(), lock);
		}

		if (this.sampleQueue.length > 0) {
			const nextSample = this.sampleQueue.shift()!;
			this.queueDequeue.resolve();
			this.queueDequeue = promiseWithResolvers();

			this.setCurrent(nextSample);
			return res.set(nextSample);
		}

		if (!this.pumpRunning) {
			this.setCurrent(null);
			return res.set(null); // None more after this, boy
		}

		assert(this.lastPendingRequest);

		const request = promiseWithResolvers<VideoSample | null>();
		const pendingRequest: PendingRequest = {
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

	next(): MaybePromise<VideoSample | null> {
		this._ensureNotClosed();

		const result = new ResultValue<VideoSample | null>();
		const promise = this._nextInternal(result);

		if (result.pending) {
			return promise.then(() => result.value);
		} else {
			return result.value;
		}
	}

	async iterate(
		callback: (packet: VideoSample, stop: () => void) => MaybePromise<unknown>,
	) {
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

			const mutexPromise = this.pumpMutex.request();
			if (mutexPromise) await mutexPromise;

			this.closed = true;

			if (this.pumpRunning) {
				await this.stopPump();
			}

			this.setCurrent(null);
			this.decoder.close();
		})();
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
					throw new Error('Throwing artificially.');
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

			if (this.pendingRequests.length > 0 || !this.closed) {
				await this.decoder.flush();
			}

			const uh = (request: PendingRequest) => {
				request.resolve(null);
				if (request.successor) {
					uh(request.successor);
				}
			};

			this.pendingRequests.forEach(uh);
			this.setCurrent(null);
		} catch (error) {
			if (!this.decoder.closed) {
				if (this.pendingRequests.length > 0 || !this.closed) {
					await this.decoder.flush();
				}
			}

			const uh = (request: PendingRequest) => {
				request.reject(error);
				if (request.successor) {
					uh(request.successor);
				}
			};

			if (this.pendingRequests.length > 0) {
				this.pendingRequests.forEach(uh);
				this.setCurrent(null);
			} else {
				throw error; // To make sure it isn't lost
			}
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
}
