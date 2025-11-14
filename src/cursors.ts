// Two parallelism modes: Cancel and queue (right?)
// Useful in packet context? Or only for sample?

import { InputTrack, InputVideoTrack } from './input-track';
import { PacketRetrievalOptions, VideoDecoderWrapper } from './media-sink';
import { assert, assertNever, AsyncMutex, AsyncMutex2, insertSorted, last, MaybePromise, promiseWithResolvers, ResultValue, Yo } from './misc';
import { EncodedPacket } from './packet';
import { VideoSample } from './sample';

export class PacketCursor {
	track: InputTrack;
	_options: PacketRetrievalOptions;
	current: EncodedPacket | null = null;
	initialized = false;

	constructor(track: InputTrack, options: PacketRetrievalOptions = {}) {
		this.track = track;
		this._options = options;
	}

	peekAtStart(): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getFirstPacket(result, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekToStart(): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getFirstPacket(result, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => {
				this.initialized = true;
				return this.current = result.value;
			});
		} else {
			this.initialized = true;
			return this.current = result.value;
		}
	}

	peekAt(timestamp: number): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getPacket(result, timestamp, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekTo(timestamp: number): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getPacket(result, timestamp, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => {
				this.initialized = true;
				return this.current = result.value;
			});
		} else {
			this.initialized = true;
			return this.current = result.value;
		}
	}

	peekKeyAt(timestamp: number): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getKeyPacket(result, timestamp, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	seekToKey(timestamp: number): MaybePromise<EncodedPacket | null> {
		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getKeyPacket(result, timestamp, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => {
				this.initialized = true;
				return this.current = result.value;
			});
		} else {
			this.initialized = true;
			return this.current = result.value;
		}
	}

	_ensureInitialized() {
		if (!this.initialized) {
			throw new Error('You must first initialize the cursor to a position by calling any of the seek methods.');
		}
	}

	next(): MaybePromise<EncodedPacket | null> {
		this._ensureInitialized();

		if (!this.current) {
			return null;
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextPacket(result, this.current, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => {
				return this.current = result.value;
			});
		} else {
			return this.current = result.value;
		}
	}

	peekNextKey(): MaybePromise<EncodedPacket | null> {
		this._ensureInitialized();

		if (!this.current) {
			return null;
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextKeyPacket(result, this.current, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => result.value);
		} else {
			return result.value;
		}
	}

	nextKey(): MaybePromise<EncodedPacket | null> {
		this._ensureInitialized();

		if (!this.current) {
			return null;
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextKeyPacket(result, this.current, this._options);

		if (result.pending) {
			return (promise as Promise<Yo>).then(() => {
				return this.current = result.value;
			});
		} else {
			return this.current = result.value;
		}
	}

	async iterate(callback: (packet: EncodedPacket, stop: () => void) => MaybePromise<void>) {
		this._ensureInitialized();

		let stopped = false;
		const stop = () => stopped = true;

		while (this.current) {
			const result = callback(this.current, stop);
			if (result instanceof Promise) await result;

			if (stopped) {
				break;
			}

			let next = this.next();
			if (next instanceof Promise) next = await next;

			this.current = next;
		}
	}

	// eslint-disable-next-line @stylistic/generator-star-spacing
	async *[Symbol.asyncIterator]() {
		this._ensureInitialized();

		while (this.current) {
			yield this.current;

			let next = this.next();
			if (next instanceof Promise) next = await next;

			this.current = next;
		}
	}
}

export class VideoSampleCursor2 {
	track: InputVideoTrack;
	initialized = false;
	packetCursor: PacketCursor;
	pumpRunning = false;
	decoder: VideoDecoderWrapper;
	// current: VideoSample | null = null;
	sampleQueue: VideoSample[] = [];
	queueDequeue = promiseWithResolvers();
	pendingRequests: {
		timestamp: number;
		resolve: (sample: VideoSample | null) => void;
	}[] = [];

	stopPump = false;
	pumpStopped = promiseWithResolvers();

	decodedTimestamps: number[] = [];
	maxDecodedSequenceNumber = -1;
	pumpMutex = new AsyncMutex2();

	private constructor(track: InputVideoTrack, decoder: VideoDecoderWrapper) {
		this.track = track;
		this.decoder = decoder;
		this.packetCursor = new PacketCursor(track);
	}

	static async init(track: InputVideoTrack) {
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

				if (cursor.stopPump) {
					sample.close();
					return;
				}

				console.log('revc', sample.timestamp);

				if (cursor.pendingRequests.length === 0) {
					cursor.sampleQueue.push(sample);
				} else {
					for (let i = 0; i < cursor.pendingRequests.length; i++) {
						const request = cursor.pendingRequests[i]!;
						if (request.timestamp <= sample.timestamp) {
							request.resolve(sample.clone());
							cursor.pendingRequests.splice(i--, 1);
						}
					}
				}

				// cursor.current?.close();
				// cursor.current = sample;

				cursor.queueDequeue.resolve();
				cursor.queueDequeue = promiseWithResolvers();
			},
			(error) => {
				console.error(error);
			},
			track.codec,
			decoderConfig,
			track.rotation,
			track.timeResolution,
		);

		const cursor = new VideoSampleCursor2(track, decoder);
		return cursor;
	}

	getNextExpectedTimestamp() {
		if (this.sampleQueue.length > 0) {
			return this.sampleQueue[0]!.timestamp;
		}
	}

	async seekTo(timestamp: number): Promise<VideoSample | null> {
		this.initialized = true; // too late?

		console.log('a');
		while (this.pumpMutex.locked) {
			console.log('waiting...');
			await this.pumpMutex.promise;
		}

		console.log('GOIN IN');

		using _ = this.pumpMutex.lock();

		const targetPacket = await this.packetCursor.peekAt(timestamp);
		if (!targetPacket) {
			return null;
		}

		let setNewPump = true;

		if (this.sampleQueue.length > 0 && targetPacket.timestamp <= this.sampleQueue[0]!.timestamp) {
			console.log('This bitch case kicked');
		} else {
			while (this.sampleQueue.length > 0) {
				const nextSample = this.sampleQueue[0]!;
				if (targetPacket.timestamp <= nextSample.timestamp) {
					console.log('used this path');
					return nextSample;
				}

				this.sampleQueue.shift();
				this.queueDequeue.resolve();
				this.queueDequeue = promiseWithResolvers();
			}

			if (this.maxDecodedSequenceNumber !== -1) {
				// This means a packet was queued for decode and the cursor is initialized

				if (targetPacket.sequenceNumber <= this.maxDecodedSequenceNumber) {
					const nextExpectedTimestamp = this.decodedTimestamps[0];
					if (!nextExpectedTimestamp || nextExpectedTimestamp > timestamp) {
						// yeah
					} else {
						setNewPump = false;
					}
				} else {
					const key = await this.packetCursor.peekNextKey();
					if (!key || targetPacket.sequenceNumber < key.sequenceNumber) {
						setNewPump = false;
					}
				}
			}
		}

		if (setNewPump) {
			console.log('setting up a new PUMP');

			if (this.pumpRunning) {
				this.stopPump = true;
				this.queueDequeue.resolve();
				this.queueDequeue = promiseWithResolvers();
				await this.pumpStopped.promise;

				for (const sample of this.sampleQueue) {
					sample.close();
				}
				this.sampleQueue.length = 0;
				this.maxDecodedSequenceNumber = -1;
				this.decodedTimestamps.length = 0;
				this.stopPump = false;
			}

			await this.packetCursor.seekToKey(timestamp);
			void this.runPump();
			await Promise.resolve(); // lol
		}

		const request = promiseWithResolvers<VideoSample | null>();
		this.pendingRequests.push({
			timestamp: targetPacket.timestamp,
			resolve: request.resolve,
		});

		return request.promise;
	}

	async next() {
		while (this.pumpMutex.locked) {
			console.log('waiting next...');
			await this.pumpMutex.promise;
		}

		if (!this.initialized) {
			throw new Error('This shud be the indicator the next not being available I think');
		}

		if (this.sampleQueue.length > 0) {
			const nextSample = this.sampleQueue.shift()!;
			this.queueDequeue.resolve();
			this.queueDequeue = promiseWithResolvers();

			return nextSample;
		}

		if (!this.pumpRunning) {
			return null; // None more after this, boy
		}

		const request = promiseWithResolvers<VideoSample | null>();
		this.pendingRequests.push({
			timestamp: -Infinity, // Matches any sample timestamp, so any next one will match
			resolve: request.resolve,
		});

		return request.promise;
	}

	async runPump() {
		assert(this.packetCursor.current);

		this.pumpRunning = true;

		while (this.packetCursor.current && !this.stopPump) {
			const maxQueueSize = 8 ?? computeMaxQueueSize(this.sampleQueue.length); // temp
			if (this.sampleQueue.length + this.decoder.getDecodeQueueSize() > maxQueueSize) {
				await this.queueDequeue.promise;
				continue;
			}

			insertSorted(this.decodedTimestamps, this.packetCursor.current.timestamp, x => x);
			this.maxDecodedSequenceNumber = this.packetCursor.current.sequenceNumber;
			this.decoder.decode(this.packetCursor.current);
			await this.packetCursor.next();
		}

		console.log('stopping current pump...');
		await this.decoder.flush();

		this.pumpStopped.resolve();
		this.pumpStopped = promiseWithResolvers();

		this.pumpRunning = false;

		this.pendingRequests.forEach(x => x.resolve(null));
		this.pendingRequests.length = 0;
	}
}

async function weJustTesting() {
	const cursor = new VideoSampleCursor2();

	// Spins up decoder and resolves to the sample
	await cursor.seekTo(2);

	// This can do multiple things:
	// - It pops its internal sample queue until it finds a matching frame; in this case, it returns instantly (no promise)
	// - If that wasn't possible, but the packet that corresponds to the requested sample was already queued for encoding,
	//   it will wait for the decoder to spit it out and then returns it. I guess this requires a "pending requests" ahh
	//   structure somewhere.
	// - If that's also not the case, but the seeked packet is in the current GOP, then it just keeps pumping packets into
	//   the decoder.
	// - If the requested packet is outside of the current GOP or "backwards" from the current stream, it resets the
	//   internal decoder
	// In any case, there's always a "pump" running that supplies the decoder with new packets to decode. This pump is
	// halted if the internal queue is sufficiently large, and is resumed when samples are consumed.
	// This pump is reset if necessary.
	await cursor.seekTo(2.1);
}

export class VideoSampleCursor {
	track: InputVideoTrack;
	current: EncodedPacket | null = null;
	initialized = false;
	packetCursor: PacketCursor;
	packetCursor2: PacketCursor;

	decoder!: VideoDecoderWrapper;

	constructor(track: InputVideoTrack) {
		this.track = track;
		this.packetCursor = new PacketCursor(track, { verifyKeyPackets: true });
		this.packetCursor2 = new PacketCursor(track, { verifyKeyPackets: true }); // not good
	}

	async init() {
		if (!(await this.track.canDecode())) {
			throw new Error(
				'This video track cannot be decoded by this browser. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		const decoderConfig = await this.track.getDecoderConfig();

		this.decoder = new VideoDecoderWrapper(
			(sample) => {
				this.sampleQueue.push(sample);
			},
			(error) => {
				// Un que?
			},
			this.track.codec!,
			decoderConfig!,
			this.track.rotation,
			this.track.timeResolution,
		);
	}

	pumpFinished = promiseWithResolvers();
	queueDequeue = promiseWithResolvers();
	terminatePump = false;
	pumpRunning = false;
	sampleQueue: VideoSample[] = [];

	async runPump() {
		this.pumpRunning = true;

		while (this.packetCursor.current && !this.terminatePump) {
			const maxQueueSize = computeMaxQueueSize(0);
			if (0 + this.decoder.getDecodeQueueSize() > maxQueueSize) {
				this.queueDequeue = promiseWithResolvers();
				await this.queueDequeue.promise;
				continue;
			}

			this.decoder.decode(this.packetCursor.current);

			const result = this.packetCursor.next();
			if (result instanceof Promise) await result;
		}

		await this.decoder.flush();
		this.pumpFinished.resolve();
		this.pumpRunning = false;
	}

	async beginNewRun() {
		if (this.pumpRunning) {
			this.terminatePump = true;
			await this.pumpFinished.promise;

			for (const sample of this.sampleQueue) {
				sample.close();
			}
			this.sampleQueue.length = 0;
		}

		// todo errors
		void this.runPump();
	}

	async _seekToCurrentPacket(res: ResultValue<VideoSample | null>): Promise<Yo> {
		const targetPacket = this.packetCursor.current;
		assert(targetPacket);

		if (targetPacket.type !== 'key') {
			await this.packetCursor.seekToKey(targetPacket.timestamp);
		}
	}

	/*
	seekToStart(): MaybePromise<VideoSample | null> {
		const onPacket = (packet: EncodedPacket | null) => {
			if (!packet) {
				return null;
			}

			const result = new ResultValue<VideoSample | null>();
			const promise = this._seekToPacket(result, packet);

			if (result.pending) {
				return promise.then(() => result.value);
			} else {
				return result.value;
			}
		};

		const packet = this.packetCursor.seekToStart();
		if (packet instanceof Promise) {
			return packet.then(onPacket);
		} else {
			return onPacket(packet);
		}
	}
	*/

	async seekTo(timestamp: number): Promise<VideoSample | null> {
		const packet = await this.packetCursor2.seekTo(timestamp);
		if (!packet) {
			return null; // I guess?
		}

		if (this.packetCursor.current) {
			// if (packet.sequenceNumber)
		}

		/*
		const onPacket = (packet: EncodedPacket | null) => {
			if (!packet) {
				return null;
			}

			const result = new ResultValue<VideoSample | null>();
			const promise = this._seekToPacket(result, packet);

			if (result.pending) {
				return promise.then(() => result.value);
			} else {
				return result.value;
			}
		};

		const packet = this.packetCursor.seekTo(timestamp);
		if (packet instanceof Promise) {
			return packet.then(onPacket);
		} else {
			return onPacket(packet);
		}
		*/
	}
}

const computeMaxQueueSize = (decodedSampleQueueSize: number) => {
	// If we have decoded samples lying around, limit the total queue size to a small value (decoded samples can use up
	// a lot of memory). If not, we're fine with a much bigger queue of encoded packets waiting to be decoded. In fact,
	// some decoders only start flushing out decoded chunks when the packet queue is large enough.
	return decodedSampleQueueSize === 0 ? 40 : 8;
};
