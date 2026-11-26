/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioPacketDecoder, PacketDecoder, VideoPacketDecoder } from './decode';
import { InputDisposedError } from './input';
import { InputAudioTrack, InputTrack, InputVideoTrack } from './input-track';
import {
	AnyIterable,
	assert,
	isFirefox,
	isNumber,
	isThenable,
	last,
	mapAsyncGenerator,
	MaybePromise,
	missingWebCodecsClassMessage,
	promiseWithResolvers,
	Rotation,
	toAsyncIterator,
	validateAnyIterable,
} from './misc';
import { EncodedPacket } from './packet';
import {
	AudioSample,
	clampCropRectangle,
	CropRectangle,
	validateCropRectangle,
	VideoSample,
} from './sample';

/**
 * Additional options for controlling packet retrieval.
 * @group Media sinks
 * @public
 */
export type PacketRetrievalOptions = {
	/**
	 * When set to `true`, only packet metadata (like timestamp) will be retrieved - the actual packet data will not
	 * be loaded.
	 */
	metadataOnly?: boolean;

	/**
	 * When set to `true`, key packets will be verified upon retrieval by looking into the packet's bitstream.
	 * If not enabled, the packet types will be determined solely by what's stored in the containing file and may be
	 * incorrect, potentially leading to decoder errors. Since determining a packet's actual type requires looking into
	 * its data, this option cannot be enabled together with `metadataOnly`.
	 */
	verifyKeyPackets?: boolean;

	/**
	 * When querying packets in live media that are in the future relative to the current live edge, Mediabunny will,
	 * by default, wait for the stream to advance until the query can be satisfied. In a sense, Mediabunny simply treats
	 * live streams as media files that are still being written, and any read that depends on future information will
	 * wait until it can be fulfilled.
	 *
	 * If you want to query packets based only on the currently known information, set this field to `true` - this way,
	 * Mediabunny will never wait for the live stream to catch up.
	 *
	 * For non-live media, this field has no effect.
	 */
	skipLiveWait?: boolean;
};

const validatePacketRetrievalOptions = (options: PacketRetrievalOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.metadataOnly !== undefined && typeof options.metadataOnly !== 'boolean') {
		throw new TypeError('options.metadataOnly, when defined, must be a boolean.');
	}
	if (options.verifyKeyPackets !== undefined && typeof options.verifyKeyPackets !== 'boolean') {
		throw new TypeError('options.verifyKeyPackets, when defined, must be a boolean.');
	}
	if (options.verifyKeyPackets && options.metadataOnly) {
		throw new TypeError('options.verifyKeyPackets and options.metadataOnly cannot be enabled together.');
	}
	if (options.skipLiveWait !== undefined && typeof options.skipLiveWait !== 'boolean') {
		throw new TypeError('options.skipLiveWait, when defined, must be a boolean.');
	}
};

const validateTimestamp = (timestamp: number) => {
	if (!isNumber(timestamp)) {
		throw new TypeError('timestamp must be a number.'); // It can be non-finite, that's fine
	}
};

const maybeFixPacketType = (
	track: InputTrack,
	promise: Promise<EncodedPacket | null>,
	options: PacketRetrievalOptions,
) => {
	if (options.verifyKeyPackets) {
		return promise.then(async (packet) => {
			if (!packet || packet.type === 'delta') {
				return packet;
			}

			const determinedType = await track.determinePacketType(packet);
			if (determinedType) {
				// @ts-expect-error Technically readonly
				packet.type = determinedType;
			}

			return packet;
		});
	} else {
		return promise;
	}
};

/**
 * Sink for retrieving encoded packets from an input track.
 * @group Media sinks
 * @public
 */
export class EncodedPacketSink {
	/** @internal */
	_track: InputTrack;

	/** Creates a new {@link EncodedPacketSink} for the given {@link InputTrack}. */
	constructor(track: InputTrack) {
		if (!(track instanceof InputTrack)) {
			throw new TypeError('track must be an InputTrack.');
		}

		this._track = track;
	}

	/**
	 * Retrieves the track's first packet (in decode order), or null if it has no packets. The first packet is very
	 * likely to be a key packet, but it doesn't have to be.
	 */
	async getFirstPacket(options: PacketRetrievalOptions = {}) {
		validatePacketRetrievalOptions(options);

		if (this._track.input._disposed) {
			throw new InputDisposedError();
		}

		return maybeFixPacketType(this._track, this._track._backing.getFirstPacket(options), options);
	}

	/** Retrieves the track's first key packet (in decode order), or null if it has no key packets. */
	async getFirstKeyPacket(options: PacketRetrievalOptions = {}) {
		validatePacketRetrievalOptions(options);

		const firstPacket = await this.getFirstPacket(options);
		if (!firstPacket) {
			return null;
		}

		if (firstPacket.type === 'key') {
			// Great
			return firstPacket;
		}

		return this.getNextKeyPacket(firstPacket, options);
	}

	/**
	 * Retrieves the packet corresponding to the given timestamp, in seconds. More specifically, returns the last packet
	 * (in presentation order) with a start timestamp less than or equal to the given timestamp. This method can be
	 * used to retrieve a track's last packet using `getPacket(Infinity)`. The method returns null if the timestamp
	 * is before the first packet in the track.
	 *
	 * @param timestamp - The timestamp used for retrieval, in seconds.
	 */
	async getPacket(timestamp: number, options: PacketRetrievalOptions = {}) {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (this._track.input._disposed) {
			throw new InputDisposedError();
		}

		return maybeFixPacketType(this._track, this._track._backing.getPacket(timestamp, options), options);
	}

	/**
	 * Retrieves the packet following the given packet (in decode order), or null if the given packet is the
	 * last packet.
	 */
	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions = {}) {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (this._track.input._disposed) {
			throw new InputDisposedError();
		}

		return maybeFixPacketType(this._track, this._track._backing.getNextPacket(packet, options), options);
	}

	/**
	 * Retrieves the key packet corresponding to the given timestamp, in seconds. More specifically, returns the last
	 * key packet (in presentation order) with a start timestamp less than or equal to the given timestamp. A key packet
	 * is a packet that doesn't require previous packets to be decoded. This method can be used to retrieve a track's
	 * last key packet using `getKeyPacket(Infinity)`. The method returns null if the timestamp is before the first
	 * key packet in the track.
	 *
	 * To ensure that the returned packet is guaranteed to be a real key frame, enable `options.verifyKeyPackets`.
	 *
	 * @param timestamp - The timestamp used for retrieval, in seconds.
	 */
	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions = {}): Promise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (this._track.input._disposed) {
			throw new InputDisposedError();
		}

		if (!options.verifyKeyPackets) {
			return this._track._backing.getKeyPacket(timestamp, options);
		}

		let packet = await this._track._backing.getKeyPacket(timestamp, options);
		while (packet) {
			assert(packet.type === 'key');

			const determinedType = await this._track.determinePacketType(packet);
			if (determinedType !== 'delta') {
				return packet;
			}

			// Try the previous key packet instead (in hopes that it's actually a key packet)
			let step = 1 / await this._track.getTimeResolution();
			let previousPacket: EncodedPacket | null;
			while (true) {
				previousPacket = await this._track._backing.getKeyPacket(packet.timestamp - step, options);
				if (!previousPacket || previousPacket.timestamp < packet.timestamp) {
					break;
				}

				// Huge timestamps, the step wasn't enough to move us, try again
				step *= 2;
			}

			packet = previousPacket;
		}

		return null;
	}

	/**
	 * Retrieves the key packet following the given packet (in decode order), or null if the given packet is the last
	 * key packet.
	 *
	 * To ensure that the returned packet is guaranteed to be a real key frame, enable `options.verifyKeyPackets`.
	 */
	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions = {}): Promise<EncodedPacket | null> {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (this._track.input._disposed) {
			throw new InputDisposedError();
		}

		if (!options.verifyKeyPackets) {
			return this._track._backing.getNextKeyPacket(packet, options);
		}

		let nextPacket = await this._track._backing.getNextKeyPacket(packet, options);
		while (nextPacket) {
			assert(nextPacket.type === 'key');

			const determinedType = await this._track.determinePacketType(nextPacket);
			if (determinedType !== 'delta') {
				return nextPacket;
			}

			// Try the next key packet instead (in hopes that it's actually a key packet)
			nextPacket = await this._track._backing.getNextKeyPacket(nextPacket, options);
		}

		return null;
	}

	/**
	 * Creates an async iterator that yields the packets in this track in decode order. To enable fast iteration, this
	 * method will intelligently preload packets based on the speed of the consumer.
	 *
	 * @param startPacket - (optional) The packet from which iteration should begin. This packet will also be yielded.
	 * @param endPacket - (optional) The packet at which iteration should end. This packet will _not_ be yielded.
	 */
	packets(
		startPacket?: EncodedPacket,
		endPacket?: EncodedPacket,
		options: PacketRetrievalOptions = {},
	): AsyncGenerator<EncodedPacket, void, unknown> {
		if (startPacket !== undefined && !(startPacket instanceof EncodedPacket)) {
			throw new TypeError('startPacket must be an EncodedPacket.');
		}
		if (startPacket !== undefined && startPacket.isMetadataOnly && !options?.metadataOnly) {
			throw new TypeError('startPacket can only be metadata-only if options.metadataOnly is enabled.');
		}
		if (endPacket !== undefined && !(endPacket instanceof EncodedPacket)) {
			throw new TypeError('endPacket must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (this._track.input._disposed) {
			throw new InputDisposedError();
		}

		const packetQueue: EncodedPacket[] = [];

		let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
		let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
		let ended = false;
		let terminated = false;

		// This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
		// method but instead in a different context. This error should not go unnoticed and must be bubbled up to
		// the consumer.
		let outOfBandError = null as unknown;
		let hasOutOfBandError = false;

		// Read ahead by about 1 second of media time which smooths over high-latency sources like networks
		const isQueueFull = () => {
			if (packetQueue.length >= 128) {
				return true;
			} else if (packetQueue.length < 8) {
				return false;
			}

			let minTimestamp = Infinity;
			let maxTimestamp = -Infinity;
			for (const packet of packetQueue) {
				minTimestamp = Math.min(minTimestamp, packet.timestamp);
				maxTimestamp = Math.max(maxTimestamp, packet.timestamp);
			}

			return maxTimestamp - minTimestamp >= 1;
		};

		// The following is the "pump" process that keeps pumping packets into the queue
		(async () => {
			let packet = startPacket ?? await this.getFirstPacket(options);

			while (packet && !terminated && !this._track.input._disposed) {
				if (endPacket && packet.sequenceNumber >= endPacket?.sequenceNumber) {
					break;
				}

				if (isQueueFull()) {
					({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
					await queueDequeue;
					continue;
				}

				packetQueue.push(packet);

				onQueueNotEmpty();
				({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());

				packet = await this.getNextPacket(packet, options);
			}

			ended = true;
			onQueueNotEmpty();
		})().catch((error) => {
			if (!hasOutOfBandError) {
				outOfBandError = error;
				hasOutOfBandError = true;
				onQueueNotEmpty();
			}
		});

		const track = this._track;

		return {
			async next() {
				while (true) {
					if (track.input._disposed) {
						throw new InputDisposedError();
					} else if (terminated) {
						return { value: undefined, done: true };
					} else if (hasOutOfBandError) {
						throw outOfBandError;
					} else if (packetQueue.length > 0) {
						const value = packetQueue.shift()!;
						onQueueDequeue();

						return { value, done: false };
					} else if (ended) {
						return { value: undefined, done: true };
					} else {
						await queueNotEmpty;
					}
				}
			},
			async return() {
				terminated = true;
				onQueueDequeue();
				onQueueNotEmpty();

				return { value: undefined, done: true };
			},
			async throw(error) {
				throw error;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}
}

/**
 * Base class for decoded media sample sinks.
 * @group Media sinks
 * @public
 */
export abstract class BaseMediaSampleSink<
	MediaSample extends VideoSample | AudioSample,
> {
	/** @internal */
	abstract _track: InputTrack;

	/** @internal */
	abstract _createDecoder(): Promise<PacketDecoder<MediaSample>>;
	/** @internal */
	abstract _createPacketSink(): EncodedPacketSink;
	/** @internal */
	abstract _getPreRollDuration(): Promise<number>;

	/** @internal */
	protected mediaSamplesInRange(
		startTimestamp = -Infinity,
		endTimestamp = Infinity,
		options: PacketRetrievalOptions,
	): AsyncGenerator<MediaSample, void, unknown> {
		validateTimestamp(startTimestamp);
		validateTimestamp(endTimestamp);

		const outputQueue: MediaSample[] = [];
		let firstSampleQueued = false;
		let lastSample: MediaSample | null = null;
		let decoder: PacketDecoder<MediaSample> | null = null;
		const { promise: decoderCreated, resolve: onDecoderCreated } = promiseWithResolvers();
		let stopped = false;
		let ended = false;
		let terminated = false;

		// This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
		// method but instead in a different context. This error should not go unnoticed and must be bubbled up to
		// the consumer.
		let outOfBandError = null as unknown;
		let hasOutOfBandError = false;

		const packetRetrievalOptions: PacketRetrievalOptions = {
			...options,
			verifyKeyPackets: true,
			metadataOnly: false,
		};

		const track = this._track;
		const closeSamples = () => {
			lastSample?.close();
			lastSample = null;
			for (const sample of outputQueue) {
				sample.close();
			}
			outputQueue.length = 0;
		};
		const stop = () => {
			stopped = true;
			decoder?.close();
		};
		const terminate = () => {
			terminated = true;
			stop();
		};
		const end = () => {
			if (!firstSampleQueued && lastSample) {
				outputQueue.push(lastSample);
				lastSample = null;
			}

			ended = true;
		};

		// Disposal must wake an idle pump even if the consumer never advances the iterator again.
		if (!track.input._disposed) {
			track.input._disposeCallbacks.add(terminate);
		}

		// The following is the "pump" process that keeps pumping packets into the decoder
		(async () => {
			decoder = await this._createDecoder();
			onDecoderCreated();

			const packetSink = this._createPacketSink();
			const preRollDuration = await this._getPreRollDuration();

			const startPacket = await packetSink.getPacket(startTimestamp, packetRetrievalOptions);
			const keyPacket = await packetSink.getKeyPacket(
				(startPacket?.timestamp ?? startTimestamp) - preRollDuration,
				packetRetrievalOptions,
			) ?? await packetSink.getFirstKeyPacket(packetRetrievalOptions);

			let currentPacket: EncodedPacket | null = keyPacket;

			// B-frames make it exceedingly difficult to properly define an upper bound for packet iteration if an end
			// timestamp is set, so we just don't do it. The case that makes it especially tricky is when the frames
			// following a key frame have a lower timestamp than the keyframe; something that quite frequently happens
			// in HEVC streams. The price to pay for not upper-bounding the packet iterator is a slight increase in
			// decoder work at the end of the range, but the added correctness and reliability makes this tradeoff worth
			// it.
			const endPacket = undefined;

			const packets = packetSink.packets(keyPacket ?? undefined, endPacket, packetRetrievalOptions);
			await packets.next(); // Skip the start packet as we already have it

			while (currentPacket && !stopped && !this._track.input._disposed) {
				const backpressure = decoder.push(currentPacket);
				if (backpressure) await backpressure;

				const packetResult = await packets.next();
				if (packetResult.done) {
					break;
				}

				currentPacket = packetResult.value;
			}

			await packets.return();

			if (stopped) {
				decoder.close();
			} else {
				void decoder.end();
			}
		})().catch((error) => {
			if (!stopped && !hasOutOfBandError) {
				outOfBandError = error;
				hasOutOfBandError = true;
			}

			stop();
			onDecoderCreated();
		}).finally(() => {
			track.input._disposeCallbacks.delete(terminate);
			if (track.input._disposed) {
				closeSamples();
			}
		});

		return {
			async next() {
				while (true) {
					if (track.input._disposed) {
						// Once next() throws, the consumer will never call return(), so terminate the
						// iteration here - otherwise, the pump keeps queueing decoded samples that
						// nothing can ever close.
						terminate();
						closeSamples();
						throw new InputDisposedError();
					} else if (terminated) {
						return { value: undefined, done: true };
					} else if (hasOutOfBandError) {
						terminate();
						closeSamples();
						throw outOfBandError;
					} else if (outputQueue.length > 0) {
						return { value: outputQueue.shift()!, done: false };
					} else if (ended) {
						return { value: undefined, done: true };
					} else if (!decoder) {
						await decoderCreated;
						continue;
					}

					let sample: MaybePromise<MediaSample | null>;
					try {
						sample = decoder.pull();
						if (isThenable(sample)) sample = await sample;
					} catch (error) {
						if (!stopped && !hasOutOfBandError) {
							outOfBandError = error;
							hasOutOfBandError = true;
						}

						continue;
					}

					if (!sample) {
						end();
						continue;
					}

					if (sample.timestamp >= endTimestamp) {
						sample.close();
						stop();
						end();
						continue;
					}

					if (lastSample) {
						if (sample.timestamp > startTimestamp) {
							// We don't know ahead of time what the first sample is. This is because the first sample
							// is the last sample whose timestamp is less than or equal to the start timestamp.
							// Therefore we need to wait for the first sample after the start timestamp, and then we'll
							// know that the previous sample was the first sample.
							outputQueue.push(lastSample);
							firstSampleQueued = true;
						} else {
							lastSample.close();
						}
					}

					if (sample.timestamp >= startTimestamp) {
						outputQueue.push(sample);
						firstSampleQueued = true;
					}

					lastSample = firstSampleQueued ? null : sample;
				}
			},
			async return() {
				terminate();
				closeSamples();

				return { value: undefined, done: true };
			},
			async throw(error) {
				await this.return(); // Like a generator function, a throw() ends the iteration
				throw error;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	/** @internal */
	protected mediaSamplesAtTimestamps(
		timestamps: AnyIterable<number>,
		options: PacketRetrievalOptions,
	): AsyncGenerator<MediaSample | null, void, unknown> {
		validateAnyIterable(timestamps);
		const timestampIterator = toAsyncIterator(timestamps);

		// The query timestamps, grouped by the batch of packets that answers them. The decoder marks the end of each
		// batch with a null.
		const batches: number[][] = [];

		const outputQueue: (MediaSample | null)[] = [];
		let decoder: PacketDecoder<MediaSample> | null = null;
		const { promise: decoderCreated, resolve: onDecoderCreated } = promiseWithResolvers();
		let stopped = false;
		const { promise: stoppedPromise, resolve: onStopped } = promiseWithResolvers();
		let ended = false;
		let terminated = false;

		// This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
		// method but instead in a different context. This error should not go unnoticed and must be bubbled up to
		// the consumer.
		let outOfBandError = null as unknown;
		let hasOutOfBandError = false;

		// The answer to a query timestamp is the last sample starting at or before it, but we only know a sample is the
		// last one once the next one comes in (or the batch ends). So, we hold on to the most recent one until then.
		let heldSample: MediaSample | null = null;

		const emitHeldSample = (count: number) => {
			for (let i = 0; i < count; i++) {
				// Clone the sample if we need to emit it multiple times
				outputQueue.push(heldSample && (i < count - 1 ? heldSample.clone() : heldSample) as MediaSample);
			}

			if (count === 0) {
				heldSample?.close();
			}
			heldSample = null;
		};

		const retrievalOptions: PacketRetrievalOptions = {
			...options,
			verifyKeyPackets: true,
			metadataOnly: false,
		};

		const track = this._track;
		const closeSamples = () => {
			heldSample?.close();
			heldSample = null;
			for (const sample of outputQueue) {
				sample?.close();
			}
			outputQueue.length = 0;
		};
		const stop = () => {
			stopped = true;
			onStopped();
			decoder?.close();
		};
		const terminate = () => {
			terminated = true;
			stop();
		};

		// Disposal must wake an idle pump even if the consumer never advances the iterator again.
		if (!track.input._disposed) {
			track.input._disposeCallbacks.add(terminate);
		}

		// The following is the "pump" process that keeps pumping packets into the decoder
		(async () => {
			decoder = await this._createDecoder();
			onDecoderCreated();

			const packetSink = this._createPacketSink();
			const preRollDuration = await this._getPreRollDuration();
			let lastPacket: EncodedPacket | null = null;
			let lastTimestamp = -Infinity;
			let lastKeyPacket: EncodedPacket | null = null;
			let lastDecodedPacket: EncodedPacket | null = null;

			// The end sequence number (inclusive) of the current batch of packets. The batch starts at the last key
			// frame and goes until this sequence number.
			let maxSequenceNumber = -1;

			const decodePackets = async () => {
				assert(lastKeyPacket);
				assert(decoder);

				// Continue where we left off, or start at the current key packet
				let currentPacket = lastDecodedPacket;
				if (!currentPacket) {
					currentPacket = lastKeyPacket;
					const backpressure = decoder.push(currentPacket);
					if (backpressure) await backpressure;
				}

				while (currentPacket.sequenceNumber < maxSequenceNumber) {
					const nextPacket = await packetSink.getNextPacket(currentPacket, retrievalOptions);
					if (!nextPacket) {
						throw new Error('Internal error: couldn\'t get next packet when one was expected.');
					}

					if (stopped) {
						break;
					}

					const backpressure = decoder.push(nextPacket);
					if (backpressure) await backpressure;
					currentPacket = nextPacket;
				}

				lastDecodedPacket = currentPacket;
			};

			try {
				while (true) {
					// The timestamps may take arbitrarily long to come in, so stop waiting on them once stopped
					const nextTimestamp = timestampIterator.next();
					nextTimestamp.catch(() => {}); // It may lose the race and reject later on
					const result = await Promise.race([nextTimestamp, stoppedPromise]);
					if (!result || result.done) {
						break;
					}

					const timestamp = result.value;
					validateTimestamp(timestamp);

					const targetPacket = await packetSink.getPacket(timestamp, retrievalOptions);
					let keyPacket = targetPacket && await packetSink.getKeyPacket(
						targetPacket.timestamp - preRollDuration,
						retrievalOptions,
					);
					if (targetPacket && !keyPacket) {
						// The track doesn't reach back far enough for the full pre-roll, so this is the best we can do
						const firstKeyPacket = await packetSink.getFirstKeyPacket(retrievalOptions);
						if (firstKeyPacket && firstKeyPacket.timestamp <= targetPacket.timestamp) {
							keyPacket = firstKeyPacket;
						}
					}

					if (stopped || this._track.input._disposed) {
						break;
					}

					if (!targetPacket || !keyPacket) {
						if (lastPacket) {
							void decoder.push(null);
						}

						// Nothing to decode, so this timestamp gets a batch of its own that ends right away and is thus
						// answered with null
						batches.push([timestamp]);
						void decoder.push(null);
						lastPacket = null;
						continue;
					}

					// Keep extending the current batch as long as it reaches the key packet anyway (always the case for
					// an unchanged key packet), so that consecutive timestamps don't redo their pre-roll. Otherwise, or
					// if we're going back in time, start a new batch at the key packet. The query timestamps within a
					// batch must not decrease, since the sample matching relies on that.
					if (
						!lastPacket
						|| keyPacket.sequenceNumber > maxSequenceNumber + 1
						|| timestamp < lastTimestamp
					) {
						if (lastPacket) {
							void decoder.push(null); // Always flush here, improves decoder compatibility
						}

						batches.push([]);
						lastKeyPacket = keyPacket;
						lastDecodedPacket = null;
						maxSequenceNumber = -1;
					}

					const batch = last(batches);
					assert(batch);
					batch.push(timestamp);
					maxSequenceNumber = Math.max(targetPacket.sequenceNumber, maxSequenceNumber);

					lastPacket = targetPacket;
					lastTimestamp = timestamp;

					// Decode right away so that samples come out while the timestamps are still coming in
					await decodePackets();
				}
			} finally {
				timestampIterator.return().catch(() => {});
			}

			if (stopped) {
				decoder.close();
			} else {
				void decoder.end();
			}
		})().catch((error) => {
			if (!stopped && !hasOutOfBandError) {
				outOfBandError = error;
				hasOutOfBandError = true;
			}

			stop();
			onDecoderCreated();
		}).finally(() => {
			track.input._disposeCallbacks.delete(terminate);
			if (track.input._disposed) {
				closeSamples();
			}
		});

		return {
			async next() {
				while (true) {
					if (track.input._disposed) {
						// Once next() throws, the consumer will never call return(), so terminate the
						// iteration here - otherwise, the pump keeps queueing decoded samples that
						// nothing can ever close.
						terminate();
						closeSamples();
						throw new InputDisposedError();
					} else if (terminated) {
						return { value: undefined, done: true };
					} else if (hasOutOfBandError) {
						terminate();
						closeSamples();
						throw outOfBandError;
					} else if (outputQueue.length > 0) {
						const value = outputQueue.shift();
						assert(value !== undefined);
						return { value, done: false };
					} else if (ended) {
						return { value: undefined, done: true };
					} else if (!decoder) {
						await decoderCreated;
						continue;
					}

					let sample: MaybePromise<MediaSample | null>;
					try {
						sample = decoder.pull();
						if (isThenable(sample)) sample = await sample;
					} catch (error) {
						if (!stopped && !hasOutOfBandError) {
							outOfBandError = error;
							hasOutOfBandError = true;
						}

						continue;
					}

					if (!sample) {
						const batch = batches.shift();
						if (batch) {
							// No sample starts after the batch's remaining query timestamps, so the last one answers
							// all of them
							emitHeldSample(batch.length);
						}

						if (decoder.done) {
							ended = true;
						}

						continue;
					}

					const batch = batches[0];
					assert(batch);

					// Every query timestamp this sample starts after is answered by the sample before it
					let heldSampleUses = 0;
					while (
						batch.length > 0
						&& sample.timestamp - batch[0]! > 1e-10 // Give it a little epsilon
					) {
						heldSampleUses++;
						batch.shift();
					}

					emitHeldSample(heldSampleUses);
					heldSample = sample;
				}
			},
			async return() {
				terminate();
				closeSamples();

				return { value: undefined, done: true };
			},
			async throw(error) {
				await this.return();
				throw error;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}
}

/**
 * Describes additional decoder preferences for video sinks.
 * @group Media sinks
 * @public
 */
export type VideoSinkDecoderOptions = {
	/**
	 * A hint that configures the hardware acceleration method of the decoder. This is best left on `'no-preference'`,
	 * the default.
	 */
	hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
	/**
	 * Hint that the selected decoder should be configured to minimize the number of packets that have to be decoded
	 * before video frames are output.
	 */
	optimizeForLatency?: boolean;
};

const validateVideoSinkDecoderOptions = (decoderOptions: VideoSinkDecoderOptions) => {
	if (!decoderOptions || typeof decoderOptions !== 'object') {
		throw new TypeError('decoderOptions must be an object.');
	}
	if (
		decoderOptions.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(decoderOptions.hardwareAcceleration)
	) {
		throw new TypeError(
			'decoderOptions.hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
			+ ' \'prefer-software\'.',
		);
	}
	if (decoderOptions.optimizeForLatency !== undefined && typeof decoderOptions.optimizeForLatency !== 'boolean') {
		throw new TypeError('decoderOptions.optimizeForLatency, when provided, must be a boolean.');
	}
};

/**
 * A sink that retrieves decoded video samples (video frames) from a video track.
 * @group Media sinks
 * @public
 */
export class VideoSampleSink extends BaseMediaSampleSink<VideoSample> {
	/** @internal */
	_track: InputVideoTrack;
	/** @internal */
	_decoderOptions: VideoSinkDecoderOptions;

	/** Creates a new {@link VideoSampleSink} for the given {@link InputVideoTrack}. */
	constructor(videoTrack: InputVideoTrack, decoderOptions: VideoSinkDecoderOptions = {}) {
		if (!(videoTrack instanceof InputVideoTrack)) {
			throw new TypeError('videoTrack must be an InputVideoTrack.');
		}
		validateVideoSinkDecoderOptions(decoderOptions);

		super();

		this._track = videoTrack;
		this._decoderOptions = decoderOptions;
	}

	/** @internal */
	async _createDecoder() {
		if (!(await this._track.canDecode())) {
			if (typeof VideoDecoder === 'undefined') {
				throw new Error(missingWebCodecsClassMessage('VideoDecoder'));
			}

			throw new Error(
				'This video track cannot be decoded in this environment. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		const decoderConfig = await this._track.getDecoderConfig();
		assert(decoderConfig);

		return new VideoPacketDecoder({
			...decoderConfig,
			hardwareAcceleration: this._decoderOptions.hardwareAcceleration,
			optimizeForLatency: this._decoderOptions.optimizeForLatency,
		});
	}

	/** @internal */
	_createPacketSink() {
		return new EncodedPacketSink(this._track);
	}

	/** @internal */
	async _getPreRollDuration() {
		return 0;
	}

	/**
	 * Retrieves the video sample (frame) corresponding to the given timestamp, in seconds. More specifically, returns
	 * the last video sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
	 * Returns null if the timestamp is before the track's first timestamp.
	 *
	 * @param timestamp - The timestamp used for retrieval, in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	async getSample(timestamp: number, options: PacketRetrievalOptions = {}) {
		validateTimestamp(timestamp);

		for await (const sample of this.mediaSamplesAtTimestamps([timestamp], options)) {
			return sample;
		}
		throw new Error('Internal error: Iterator returned nothing.');
	}

	/**
	 * Creates an async iterator that yields the video samples (frames) of this track in presentation order. This method
	 * will intelligently pre-decode a few frames ahead to enable fast iteration.
	 *
	 * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
	 * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
	 * @param options - Options used for the underlying packet retrieval.
	 */
	samples(startTimestamp?: number, endTimestamp?: number, options: PacketRetrievalOptions = {}) {
		return this.mediaSamplesInRange(startTimestamp, endTimestamp, options);
	}

	/**
	 * Creates an async iterator that yields a video sample (frame) for each timestamp in the argument. This method
	 * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
	 * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
	 * yield null if no frame is available for a given timestamp.
	 *
	 * This method is good for sparse access of media data. If you want primarily sequential media access, prefer
	 * {@link VideoSampleSink.samples} instead.
	 *
	 * @param timestamps - An iterable or async iterable of timestamps in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	samplesAtTimestamps(timestamps: AnyIterable<number>, options: PacketRetrievalOptions = {}) {
		return this.mediaSamplesAtTimestamps(timestamps, options);
	}
}

/**
 * A canvas with additional timing information (timestamp & duration).
 * @group Media sinks
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
 * Options for constructing a CanvasSink.
 * @group Media sinks
 * @public
 */
export type CanvasSinkOptions = {
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
	 * Rotation is applied before flipping.
	 */
	rotation?: Rotation;
	/**
	 * Whether to flip the raw video frame horizontally (about the vertical axis). Defaults to the flip set in the file
	 * metadata. The flip is applied after rotation but before cropping and resizing.
	 */
	flip?: boolean;
	/**
	 * Specifies the rectangular region of the input video to crop to. The crop region will automatically be clamped to
	 * the dimensions of the input video track. Cropping is performed after rotation and flip but before resizing. The
	 * crop region is in the _display pixel space_ of the underlying video data.
	 */
	crop?: CropRectangle;
	/**
	 * When set, specifies the number of canvases in the pool. These canvases will be reused in a ring buffer /
	 * round-robin type fashion. This keeps the amount of allocated VRAM constant and relieves the browser from
	 * constantly allocating/deallocating canvases. A pool size of 0 or `undefined` disables the pool and means a new
	 * canvas is created each time.
	 */
	poolSize?: number;
	/** Additional preferences for the underlying video decoder. */
	decoderOptions?: VideoSinkDecoderOptions;
};

/**
 * A sink that renders video samples (frames) of the given video track to canvases. This is often more useful than
 * directly retrieving frames, as it comes with common preprocessing steps such as resizing or applying rotation and
 * flip metadata.
 *
 * This sink will yield `HTMLCanvasElement`s when in a DOM context, and `OffscreenCanvas`es otherwise.
 *
 * @group Media sinks
 * @public
 */
export class CanvasSink {
	/** @internal */
	_videoTrack: InputVideoTrack;
	/** @internal */
	_alpha: boolean;
	/** @internal */
	_width!: number;
	/** @internal */
	_height!: number;
	/** @internal */
	_options: CanvasSinkOptions;
	/** @internal */
	_fit: 'fill' | 'contain' | 'cover';
	/** @internal */
	_rotation: Rotation = 0;
	/** @internal */
	_flip = false;
	/** @internal */
	_crop?: { left: number; top: number; width: number; height: number };
	/** @internal */
	_initPromise: Promise<void> | null = null;
	/** @internal */
	_videoSampleSink: VideoSampleSink;
	/** @internal */
	_canvasPool: (HTMLCanvasElement | OffscreenCanvas | null)[];
	/** @internal */
	_nextCanvasIndex = 0;

	/** Creates a new {@link CanvasSink} for the given {@link InputVideoTrack}. */
	constructor(videoTrack: InputVideoTrack, options: CanvasSinkOptions = {}) {
		if (!(videoTrack instanceof InputVideoTrack)) {
			throw new TypeError('videoTrack must be an InputVideoTrack.');
		}
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
		if (options.flip !== undefined && typeof options.flip !== 'boolean') {
			throw new TypeError('options.flip, when provided, must be a boolean.');
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
		if (options.decoderOptions !== undefined) {
			validateVideoSinkDecoderOptions(options.decoderOptions);
		}

		this._videoTrack = videoTrack;
		this._alpha = options.alpha ?? false;
		this._options = options;
		this._fit = options.fit ?? 'fill';
		this._videoSampleSink = new VideoSampleSink(videoTrack, options.decoderOptions);
		this._canvasPool = Array.from({ length: options.poolSize ?? 0 }, () => null);
	}

	/** @internal */
	_ensureInit() {
		return this._initPromise ??= (async () => {
			const options = this._options;
			const videoTrack = this._videoTrack;

			const rotation = options.rotation ?? await videoTrack.getRotation();
			const flip = options.flip ?? await videoTrack.getFlip();
			const squarePixelWidth = await videoTrack.getSquarePixelWidth();
			const squarePixelHeight = await videoTrack.getSquarePixelHeight();

			const [rotatedWidth, rotatedHeight] = rotation % 180 === 0
				? [squarePixelWidth, squarePixelHeight]
				: [squarePixelHeight, squarePixelWidth];

			let crop = options.crop;
			if (crop) {
				crop = clampCropRectangle(crop, rotatedWidth, rotatedHeight);
			}

			let [width, height] = crop
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

			this._width = width;
			this._height = height;
			this._rotation = rotation;
			this._flip = flip;
			this._crop = crop;
		})();
	}

	/** @internal */
	_videoSampleToWrappedCanvas(sample: VideoSample): WrappedCanvas {
		const width = this._width;
		const height = this._height;
		let canvas = this._canvasPool[this._nextCanvasIndex];
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

			if (this._canvasPool.length > 0) {
				this._canvasPool[this._nextCanvasIndex] = canvas;
			}

			canvasIsNew = true;
		}

		if (this._canvasPool.length > 0) {
			this._nextCanvasIndex = (this._nextCanvasIndex + 1) % this._canvasPool.length;
		}

		const context = canvas.getContext('2d', {
			alpha: this._alpha || isFirefox(), // Firefox has VideoFrame glitches with opaque canvases
		}) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
		assert(context);

		try {
			sample._drawWithFitAndMipmapping(canvas, context, {
				fit: this._fit,
				rotation: this._rotation,
				flip: this._flip,
				crop: this._crop,
				targetIsFresh: canvasIsNew,
				fillBlack: !this._alpha && isFirefox(),
			});

			return {
				canvas,
				timestamp: sample.timestamp,
				duration: sample.duration,
			};
		} finally {
			sample.close();
		}
	}

	/**
	 * Retrieves a canvas with the video frame corresponding to the given timestamp, in seconds. More specifically,
	 * returns the last video frame (in presentation order) with a start timestamp less than or equal to the given
	 * timestamp. Returns null if the timestamp is before the track's first timestamp.
	 *
	 * @param timestamp - The timestamp used for retrieval, in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	async getCanvas(timestamp: number, options?: PacketRetrievalOptions) {
		validateTimestamp(timestamp);
		await this._ensureInit();

		const sample = await this._videoSampleSink.getSample(timestamp, options);
		return sample && this._videoSampleToWrappedCanvas(sample);
	}

	/**
	 * Creates an async iterator that yields canvases with the video frames of this track in presentation order. This
	 * method will intelligently pre-decode a few frames ahead to enable fast iteration.
	 *
	 * @param startTimestamp - The timestamp in seconds at which to start yielding canvases (inclusive).
	 * @param endTimestamp - The timestamp in seconds at which to stop yielding canvases (exclusive).
	 * @param options - Options used for the underlying packet retrieval.
	 */
	async* canvases(startTimestamp?: number, endTimestamp?: number, options?: PacketRetrievalOptions) {
		await this._ensureInit();
		yield* mapAsyncGenerator(
			this._videoSampleSink.samples(startTimestamp, endTimestamp, options),
			sample => this._videoSampleToWrappedCanvas(sample),
		);
	}

	/**
	 * Creates an async iterator that yields a canvas for each timestamp in the argument. This method uses an optimized
	 * decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most once, and is
	 * therefore more efficient than manually getting the canvas for every timestamp. The iterator may yield null if
	 * no frame is available for a given timestamp.
	 *
	 * This method is good for sparse access of media data. If you want primarily sequential media access, prefer
	 * {@link CanvasSink.canvases} instead.
	 *
	 * @param timestamps - An iterable or async iterable of timestamps in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	async* canvasesAtTimestamps(timestamps: AnyIterable<number>, options?: PacketRetrievalOptions) {
		await this._ensureInit();
		yield* mapAsyncGenerator(
			this._videoSampleSink.samplesAtTimestamps(timestamps, options),
			sample => sample && this._videoSampleToWrappedCanvas(sample),
		);
	}
}

/**
 * Sink for retrieving decoded audio samples from an audio track.
 * @group Media sinks
 * @public
 */
export class AudioSampleSink extends BaseMediaSampleSink<AudioSample> {
	/** @internal */
	_track: InputAudioTrack;

	/** Creates a new {@link AudioSampleSink} for the given {@link InputAudioTrack}. */
	constructor(audioTrack: InputAudioTrack) {
		if (!(audioTrack instanceof InputAudioTrack)) {
			throw new TypeError('audioTrack must be an InputAudioTrack.');
		}

		super();

		this._track = audioTrack;
	}

	/** @internal */
	async _createDecoder() {
		if (!(await this._track.canDecode())) {
			if (typeof AudioDecoder === 'undefined') {
				throw new Error(missingWebCodecsClassMessage('AudioDecoder'));
			}

			throw new Error(
				'This audio track cannot be decoded in this environment. Make sure to check decodability before using'
				+ ' a track.',
			);
		}

		const decoderConfig = await this._track.getDecoderConfig();
		assert(decoderConfig);

		return new AudioPacketDecoder(decoderConfig);
	}

	/** @internal */
	_createPacketSink() {
		return new EncodedPacketSink(this._track);
	}

	/** @internal */
	async _getPreRollDuration() {
		const preRollDuration = await this._track.getPreRollDuration();
		assert(preRollDuration !== null); // The decoder was created, so the codec is known

		return preRollDuration;
	}

	/**
	 * Retrieves the audio sample corresponding to the given timestamp, in seconds. More specifically, returns
	 * the last audio sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
	 * Returns null if the timestamp is before the track's first timestamp.
	 *
	 * @param timestamp - The timestamp used for retrieval, in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	async getSample(timestamp: number, options: PacketRetrievalOptions = {}) {
		validateTimestamp(timestamp);

		for await (const sample of this.mediaSamplesAtTimestamps([timestamp], options)) {
			return sample;
		}
		throw new Error('Internal error: Iterator returned nothing.');
	}

	/**
	 * Creates an async iterator that yields the audio samples of this track in presentation order. This method
	 * will intelligently pre-decode a few samples ahead to enable fast iteration.
	 *
	 * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
	 * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
	 * @param options - Options used for the underlying packet retrieval.
	 */
	samples(startTimestamp?: number, endTimestamp?: number, options: PacketRetrievalOptions = {}) {
		return this.mediaSamplesInRange(startTimestamp, endTimestamp, options);
	}

	/**
	 * Creates an async iterator that yields an audio sample for each timestamp in the argument. This method
	 * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
	 * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
	 * yield null if no sample is available for a given timestamp.
	 *
	 * This method is good for sparse access of media data. If you want primarily sequential media access, prefer
	 * {@link AudioSampleSink.samples} instead.
	 *
	 * @param timestamps - An iterable or async iterable of timestamps in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	samplesAtTimestamps(timestamps: AnyIterable<number>, options: PacketRetrievalOptions = {}) {
		return this.mediaSamplesAtTimestamps(timestamps, options);
	}
}

/**
 * An AudioBuffer with additional timing information (timestamp & duration).
 * @group Media sinks
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

/**
 * A sink that retrieves decoded audio samples from an audio track and converts them to `AudioBuffer` instances. This is
 * often more useful than directly retrieving audio samples, as audio buffers can be directly used with the
 * Web Audio API.
 * @group Media sinks
 * @public
 */
export class AudioBufferSink {
	/** @internal */
	_audioSampleSink: AudioSampleSink;

	/** Creates a new {@link AudioBufferSink} for the given {@link InputAudioTrack}. */
	constructor(audioTrack: InputAudioTrack) {
		if (!(audioTrack instanceof InputAudioTrack)) {
			throw new TypeError('audioTrack must be an InputAudioTrack.');
		}

		this._audioSampleSink = new AudioSampleSink(audioTrack);
	}

	/** @internal */
	_audioSampleToWrappedArrayBuffer(sample: AudioSample): WrappedAudioBuffer {
		try {
			return {
				buffer: sample.toAudioBuffer(),
				timestamp: sample.timestamp,
				duration: sample.duration,
			};
		} finally {
			sample.close();
		}
	}

	/**
	 * Retrieves the audio buffer corresponding to the given timestamp, in seconds. More specifically, returns
	 * the last audio buffer (in presentation order) with a start timestamp less than or equal to the given timestamp.
	 * Returns null if the timestamp is before the track's first timestamp.
	 *
	 * @param timestamp - The timestamp used for retrieval, in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	async getBuffer(timestamp: number, options?: PacketRetrievalOptions) {
		validateTimestamp(timestamp);

		const data = await this._audioSampleSink.getSample(timestamp, options);
		return data && this._audioSampleToWrappedArrayBuffer(data);
	}

	/**
	 * Creates an async iterator that yields audio buffers of this track in presentation order. This method
	 * will intelligently pre-decode a few buffers ahead to enable fast iteration.
	 *
	 * @param startTimestamp - The timestamp in seconds at which to start yielding buffers (inclusive).
	 * @param endTimestamp - The timestamp in seconds at which to stop yielding buffers (exclusive).
	 * @param options - Options used for the underlying packet retrieval.
	 */
	buffers(startTimestamp?: number, endTimestamp?: number, options?: PacketRetrievalOptions) {
		return mapAsyncGenerator(
			this._audioSampleSink.samples(startTimestamp, endTimestamp, options),
			data => this._audioSampleToWrappedArrayBuffer(data),
		);
	}

	/**
	 * Creates an async iterator that yields an audio buffer for each timestamp in the argument. This method
	 * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
	 * once, and is therefore more efficient than manually getting the buffer for every timestamp. The iterator may
	 * yield null if no buffer is available for a given timestamp.
	 *
	 * @param timestamps - An iterable or async iterable of timestamps in seconds.
	 * @param options - Options used for the underlying packet retrieval.
	 */
	buffersAtTimestamps(timestamps: AnyIterable<number>, options?: PacketRetrievalOptions) {
		return mapAsyncGenerator(
			this._audioSampleSink.samplesAtTimestamps(timestamps, options),
			data => data && this._audioSampleToWrappedArrayBuffer(data),
		);
	}
}
