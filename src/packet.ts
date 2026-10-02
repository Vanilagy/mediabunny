/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InputDisposedError } from './input';
import { InputTrack } from './input-track';
import {
	assert,
	binarySearchLessOrEqual,
	isNumber,
	isThenable,
	MaybePromise,
	MaybeRelevantPromise,
	nextDown,
	removeItem,
	ResultValue,
	SECOND_TO_MICROSECOND_FACTOR,
} from './misc';

export const PLACEHOLDER_DATA = /* #__PURE__ */ new Uint8Array(0);

/**
 * The type of a packet. Key packets can be decoded without previous packets, while delta packets depend on previous
 * packets.
 * @group Packets
 * @public
 */
export type PacketType = 'key' | 'delta';

/**
 * Holds additional data accompanying an {@link EncodedPacket}.
 * @group Packets
 * @public
 */
export type EncodedPacketSideData = {
	/**
	 * An encoded alpha frame, encoded with the same codec as the packet. Typically used for transparent videos, where
	 * the alpha information is stored separately from the color information.
	 */
	alpha?: Uint8Array;
	/**
	 * The actual byte length of the alpha data. This field is useful for metadata-only packets where the
	 * `alpha` field contains no bytes.
	 */
	alphaByteLength?: number;
};

/**
 * Represents an encoded chunk of media. Mainly used as an expressive wrapper around WebCodecs API's
 * [`EncodedVideoChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedVideoChunk) and
 * [`EncodedAudioChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedAudioChunk), but can also be used
 * standalone.
 * @group Packets
 * @public
 */
export class EncodedPacket {
	/**
	 * The actual byte length of the data in this packet. This field is useful for metadata-only packets where the
	 * `data` field contains no bytes.
	 */
	readonly byteLength: number;

	/** Additional data carried with this packet. */
	readonly sideData: EncodedPacketSideData;

	/**
	 * Data that demuxers can populate for whatever internal use they have.
	 * @internal
	 */
	_internal: unknown = undefined;

	/** Creates a new {@link EncodedPacket} from raw bytes and timing information. */
	constructor(
		/**
		 * The encoded data of this packet. For any given codec, this data must adhere to the format specified in the
		 * Mediabunny Codec Registry.
		 */
		public readonly data: Uint8Array,
		/** The type of this packet. */
		public readonly type: PacketType,
		/**
		 * The presentation timestamp of this packet in seconds. May be negative. Samples with negative end timestamps
		 * should not be presented.
		 */
		public readonly timestamp: number,
		/** The duration of this packet in seconds. */
		public readonly duration: number,
		/**
		 * The sequence number indicates the decode order of the packets. Packet A must be decoded before packet B if A
		 * has a lower sequence number than B. If two packets have the same sequence number, they are the same packet.
		 * Otherwise, sequence numbers are arbitrary and are not guaranteed to have any meaning besides their relative
		 * ordering. Negative sequence numbers mean the sequence number is undefined.
		 */
		public readonly sequenceNumber = -1,
		byteLength?: number,
		sideData?: EncodedPacketSideData,
	) {
		if (data === PLACEHOLDER_DATA && byteLength === undefined) {
			throw new Error(
				'Internal error: byteLength must be explicitly provided when constructing metadata-only packets.',
			);
		}

		if (byteLength === undefined) {
			byteLength = data.byteLength;
		}

		if (!(data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		if (type !== 'key' && type !== 'delta') {
			throw new TypeError('type must be either "key" or "delta".');
		}
		if (!Number.isFinite(timestamp)) {
			throw new TypeError('timestamp must be a number.');
		}
		if (!Number.isFinite(duration) || duration < 0) {
			throw new TypeError('duration must be a non-negative number.');
		}
		if (!Number.isFinite(sequenceNumber)) {
			throw new TypeError('sequenceNumber must be a number.');
		}
		if (!Number.isInteger(byteLength) || byteLength < 0) {
			throw new TypeError('byteLength must be a non-negative integer.');
		}
		if (sideData !== undefined && (typeof sideData !== 'object' || !sideData)) {
			throw new TypeError('sideData, when provided, must be an object.');
		}
		if (sideData?.alpha !== undefined && !(sideData.alpha instanceof Uint8Array)) {
			throw new TypeError('sideData.alpha, when provided, must be a Uint8Array.');
		}
		if (
			sideData?.alphaByteLength !== undefined
			&& (!Number.isInteger(sideData.alphaByteLength) || sideData.alphaByteLength < 0)
		) {
			throw new TypeError('sideData.alphaByteLength, when provided, must be a non-negative integer.');
		}

		this.byteLength = byteLength;
		this.sideData = sideData ?? {};

		if (this.sideData.alpha && this.sideData.alphaByteLength === undefined) {
			this.sideData.alphaByteLength = this.sideData.alpha.byteLength;
		}
	}

	/**
	 * If this packet is a metadata-only packet. Metadata-only packets don't contain their packet data. They are the
	 * result of retrieving packets with {@link PacketRetrievalOptions.metadataOnly} set to `true`.
	 */
	get isMetadataOnly() {
		return this.data === PLACEHOLDER_DATA;
	}

	/** The timestamp of this packet in microseconds. */
	get microsecondTimestamp() {
		return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.timestamp);
	}

	/** The duration of this packet in microseconds. */
	get microsecondDuration() {
		return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.duration);
	}

	/** Converts this packet to an
	 * [`EncodedVideoChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedVideoChunk) for use with the
	 * WebCodecs API. */
	toEncodedVideoChunk() {
		if (this.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be converted to a video chunk.');
		}
		if (typeof EncodedVideoChunk === 'undefined') {
			throw new Error('EncodedVideoChunk is not available in this environment.');
		}

		return new EncodedVideoChunk({
			data: this.data,
			type: this.type,
			timestamp: this.microsecondTimestamp,
			duration: this.microsecondDuration,
		});
	}

	/**
	 * Converts this packet to an
	 * [`EncodedVideoChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedVideoChunk) for use with the
	 * WebCodecs API, using the alpha side data instead of the color data. Throws if no alpha side data is defined.
	 */
	alphaToEncodedVideoChunk(type = this.type) {
		if (!this.sideData.alpha) {
			throw new TypeError('This packet does not contain alpha side data.');
		}
		if (this.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be converted to a video chunk.');
		}
		if (typeof EncodedVideoChunk === 'undefined') {
			throw new Error('EncodedVideoChunk is not available in this environment.');
		}

		return new EncodedVideoChunk({
			data: this.sideData.alpha,
			type,
			timestamp: this.microsecondTimestamp,
			duration: this.microsecondDuration,
		});
	}

	/** Converts this packet to an
	 * [`EncodedAudioChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedAudioChunk) for use with the
	 * WebCodecs API. */
	toEncodedAudioChunk() {
		if (this.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be converted to an audio chunk.');
		}
		if (typeof EncodedAudioChunk === 'undefined') {
			throw new Error('EncodedAudioChunk is not available in this environment.');
		}

		return new EncodedAudioChunk({
			data: this.data,
			type: this.type,
			timestamp: this.microsecondTimestamp,
			duration: this.microsecondDuration,
		});
	}

	/**
	 * Creates an {@link EncodedPacket} from an
	 * [`EncodedVideoChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedVideoChunk) or
	 * [`EncodedAudioChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedAudioChunk). This method is useful
	 * for converting chunks from the WebCodecs API to `EncodedPacket` instances.
	 */
	static fromEncodedChunk(
		chunk: EncodedVideoChunk | EncodedAudioChunk,
		sideData?: EncodedPacketSideData,
	): EncodedPacket {
		if (!(chunk instanceof EncodedVideoChunk || chunk instanceof EncodedAudioChunk)) {
			throw new TypeError('chunk must be an EncodedVideoChunk or EncodedAudioChunk.');
		}

		const data = new Uint8Array(chunk.byteLength);
		chunk.copyTo(data);

		return new EncodedPacket(
			data,
			chunk.type as PacketType,
			chunk.timestamp / 1e6,
			(chunk.duration ?? 0) / 1e6,
			undefined,
			undefined,
			sideData,
		);
	}

	/** Clones this packet while optionally modifying the new packet's data. */
	clone(options?: {
		/** The data of the cloned packet. */
		data?: Uint8Array;
		/** The type of the cloned packet. */
		type?: PacketType;
		/** The timestamp of the cloned packet in seconds. */
		timestamp?: number;
		/** The duration of the cloned packet in seconds. */
		duration?: number;
		/** The sequence number of the cloned packet. */
		sequenceNumber?: number;
		/** The side data of the cloned packet. */
		sideData?: EncodedPacketSideData;
	}): EncodedPacket {
		if (options !== undefined && (typeof options !== 'object' || options === null)) {
			throw new TypeError('options, when provided, must be an object.');
		}
		if (options?.data !== undefined && !(options.data instanceof Uint8Array)) {
			throw new TypeError('options.data, when provided, must be a Uint8Array.');
		}
		if (options?.type !== undefined && options.type !== 'key' && options.type !== 'delta') {
			throw new TypeError('options.type, when provided, must be either "key" or "delta".');
		}
		if (options?.timestamp !== undefined && !Number.isFinite(options.timestamp)) {
			throw new TypeError('options.timestamp, when provided, must be a number.');
		}
		if (options?.duration !== undefined && !Number.isFinite(options.duration)) {
			throw new TypeError('options.duration, when provided, must be a number.');
		}
		if (options?.sequenceNumber !== undefined && !Number.isFinite(options.sequenceNumber)) {
			throw new TypeError('options.sequenceNumber, when provided, must be a number.');
		}
		if (options?.sideData !== undefined && (typeof options.sideData !== 'object' || options.sideData === null)) {
			throw new TypeError('options.sideData, when provided, must be an object.');
		}

		const packet = new EncodedPacket(
			options?.data ?? this.data,
			options?.type ?? this.type,
			options?.timestamp ?? this.timestamp,
			options?.duration ?? this.duration,
			options?.sequenceNumber ?? this.sequenceNumber,
			this.byteLength,
			options?.sideData ?? this.sideData,
		);
		packet._internal = this._internal;

		return packet;
	}

	/** @internal */
	_toMetadataOnly() {
		if (this.isMetadataOnly) {
			return this;
		}

		return this.clone({
			data: PLACEHOLDER_DATA,
			sideData: {
				...this.sideData,
				alpha: this.sideData.alpha ? PLACEHOLDER_DATA : undefined,
			},
		});
	}
}

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
	 * When set to true, key packets will be verified upon retrieval by looking into the packet's bitstream.
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

const retrievalOptionsAreEqual = (a: PacketRetrievalOptions, b: PacketRetrievalOptions) => {
	return !!a.metadataOnly === !!b.metadataOnly
		&& !!a.verifyKeyPackets === !!b.verifyKeyPackets
		&& !!a.skipLiveWait === !!b.skipLiveWait;
};

export const validatePacketRetrievalOptions = (options: PacketRetrievalOptions, path = 'options') => {
	if (!options || typeof options !== 'object') {
		throw new TypeError(`${path} must be an object.`);
	}
	if (options.metadataOnly !== undefined && typeof options.metadataOnly !== 'boolean') {
		throw new TypeError(`${path}.metadataOnly, when defined, must be a boolean.`);
	}
	if (options.verifyKeyPackets !== undefined && typeof options.verifyKeyPackets !== 'boolean') {
		throw new TypeError(`${path}.verifyKeyPackets, when defined, must be a boolean.`);
	}
	if (options.verifyKeyPackets && options.metadataOnly) {
		throw new TypeError(`${path}.verifyKeyPackets and options.metadataOnly cannot be enabled together.`);
	}
	if (options.skipLiveWait !== undefined && typeof options.skipLiveWait !== 'boolean') {
		throw new TypeError(`${path}.skipLiveWait, when defined, must be a boolean.`);
	}
};

export const validateTimestamp = (timestamp: number) => {
	if (!isNumber(timestamp)) {
		throw new TypeError('timestamp must be a number.'); // It can be non-finite, that's fine
	}
};

export class PacketRetrievalResult {
	packet: EncodedPacket | null;
	provisional = false;

	constructor(packet: EncodedPacket | null) {
		this.packet = packet;
	}
}

export type PacketReaderOptions = {
	cache?: PacketCache;
};

export class PacketReader<T extends InputTrack = InputTrack> {
	track: T;
	cache: PacketCache | null = null;
	/** @internal */
	_timeResolution: number | null = null;

	constructor(track: T, options: PacketReaderOptions = {}) {
		if (!(track instanceof InputTrack)) {
			throw new TypeError('track must be an InputTrack.');
		}
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.cache !== undefined && !(options.cache instanceof PacketCache)) {
			throw new TypeError('options.cache, when provided, must be a PacketCache.');
		}

		this.track = track;
		this.cache = options.cache ?? null;
	}

	getFirst(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const cacheTrackInfo = this.cache?._getTrackInfo(this.track);

		if (cacheTrackInfo) {
			const cacheResult = this.cache!._getFirst(cacheTrackInfo, options);
			if (cacheResult !== undefined) {
				return cacheResult;
			}

			const pending = this.cache!._getPendingFirst(cacheTrackInfo, options);
			if (pending) {
				const retry = () => this.getFirst(options);
				return pending.then(retry, retry);
			}
		}

		const result = new ResultValue<PacketRetrievalResult>();
		const promise = this.track._backing.getFirstPacket(result, options);

		const run = () => {
			const packet = result.value.packet;
			const cache = result.value.provisional ? null : this.cache;

			if (!options.verifyKeyPackets || !packet || packet.type === 'delta') {
				cache?._insertFirst(cacheTrackInfo!, packet, undefined);
				return packet;
			}

			return this.track.determinePacketType(packet).then((determinedType) => {
				cache?._insertFirst(cacheTrackInfo!, packet, determinedType);

				if (determinedType === 'delta') {
					return packet.clone({ type: 'delta' });
				} else {
					return packet;
				}
			});
		};

		const finalResult = result.pending
			? promise.then(() => run())
			: run();

		if (cacheTrackInfo && isThenable(finalResult)) {
			this.cache!._addPendingFirst(cacheTrackInfo, options, finalResult);
		}

		return finalResult;
	}

	getFirstKey(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		const result = this.getFirst(options);

		const onPacket = (packet: EncodedPacket | null): MaybePromise<EncodedPacket | null> => {
			if (!packet || packet.type === 'key') {
				return packet;
			}

			return this.getNextKey(packet, options);
		};

		if (isThenable(result)) {
			return result.then(onPacket);
		} else {
			return onPacket(result);
		}
	}

	getAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const cacheTrackInfo = this.cache?._getTrackInfo(this.track);

		if (cacheTrackInfo) {
			const cacheResult = this.cache!._getAt(cacheTrackInfo, timestamp, options);
			if (cacheResult !== undefined) {
				return cacheResult;
			}

			const pending = this.cache!._getPending(cacheTrackInfo.pendingAtCalls, timestamp, options);
			if (pending) {
				const retry = () => this.getAt(timestamp, options);
				return pending.then(retry, retry);
			}
		}

		const result = new ResultValue<PacketRetrievalResult>();
		const promise = this.track._backing.getPacket(result, timestamp, options);

		const run = () => {
			const packet = result.value.packet;
			const cache = result.value.provisional ? null : this.cache;

			if (!options.verifyKeyPackets || !packet || packet.type === 'delta') {
				cache?._insertAt(cacheTrackInfo!, timestamp, packet, undefined);
				return packet;
			}

			return this.track.determinePacketType(packet).then((determinedType) => {
				cache?._insertAt(cacheTrackInfo!, timestamp, packet, determinedType);

				if (determinedType === 'delta') {
					return packet.clone({ type: 'delta' });
				} else {
					return packet;
				}
			});
		};

		const finalResult = result.pending
			? promise.then(() => run())
			: run();

		if (cacheTrackInfo && isThenable(finalResult)) {
			this.cache!._addPending(cacheTrackInfo.pendingAtCalls, timestamp, options, finalResult);
		}

		return finalResult;
	}

	getKeyAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const cacheTrackInfo = this.cache?._getTrackInfo(this.track);

		if (cacheTrackInfo) {
			const pending = this.cache!._getPending(cacheTrackInfo.pendingKeyAtCalls, timestamp, options);
			if (pending) {
				const retry = () => this.getKeyAt(timestamp, options);
				return pending.then(retry, retry);
			}
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this._getKeyAtInternal(result, cacheTrackInfo, timestamp, options);

		if (!result.pending) {
			return result.value;
		}

		const finalResult = promise.then(() => result.value);
		if (cacheTrackInfo) {
			this.cache!._addPending(cacheTrackInfo.pendingKeyAtCalls, timestamp, options, finalResult);
		}

		return finalResult;
	}

	/** @internal */
	async _getKeyAtInternal(
		res: ResultValue<EncodedPacket | null>,
		cacheTrackInfo: PacketCacheTrackInfo | undefined,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		while (true) {
			if (cacheTrackInfo) {
				let cacheResult = this.cache!._getKeyAt(cacheTrackInfo, timestamp, options);
				if (isThenable(cacheResult)) cacheResult = await cacheResult;

				if (cacheResult !== undefined) {
					if (cacheResult === null || cacheResult.type === 'key') {
						return res.set(cacheResult);
					}

					let timeResolution = this._getTimeResolution();
					if (isThenable(timeResolution)) timeResolution = await timeResolution;

					// Turned out to be a delta packet, so try the key packet before it
					timestamp = cacheResult.timestamp - 1 / timeResolution;
					continue;
				}
			}

			const result = new ResultValue<PacketRetrievalResult>();
			const promise = this.track._backing.getKeyPacket(result, timestamp, options);
			if (result.pending) await promise;

			const packet = result.value.packet;
			const cache = result.value.provisional ? null : this.cache;

			if (!options.verifyKeyPackets || !packet) {
				cache?._insertKeyAt(cacheTrackInfo!, timestamp, packet, undefined);
				return res.set(packet);
			}

			const determinedType = await this.track.determinePacketType(packet);
			cache?._insertKeyAt(cacheTrackInfo!, timestamp, packet, determinedType);

			if (determinedType !== 'delta') {
				return res.set(packet);
			}

			let timeResolution = this._getTimeResolution();
			if (isThenable(timeResolution)) timeResolution = await timeResolution;

			// Try the previous key packet instead (in hopes that it's actually a key packet)
			timestamp = packet.timestamp - 1 / timeResolution;
		}
	}

	/** @internal */
	_getTimeResolution(): MaybePromise<number> {
		if (this._timeResolution !== null) {
			return this._timeResolution;
		}

		const timeResolution = this.track._backing.getTimeResolution();
		if (isThenable(timeResolution)) {
			return timeResolution.then((value) => {
				this._timeResolution = value;
				return value;
			});
		}

		this._timeResolution = timeResolution;
		return timeResolution;
	}

	getNext(packet: EncodedPacket, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const cacheTrackInfo = this.cache?._getTrackInfo(this.track);

		if (cacheTrackInfo) {
			const cacheResult = this.cache!._getNext(cacheTrackInfo, packet, options);
			if (cacheResult !== undefined) {
				return cacheResult;
			}

			const pending = this.cache!._getPending(cacheTrackInfo.pendingNextCalls, packet.sequenceNumber, options);
			if (pending) {
				const retry = () => this.getNext(packet, options);
				return pending.then(retry, retry);
			}
		}

		const result = new ResultValue<PacketRetrievalResult>();
		const promise = this.track._backing.getNextPacket(result, packet, options);

		const run = () => {
			const nextPacket = result.value.packet;
			const cache = result.value.provisional ? null : this.cache;

			if (!options.verifyKeyPackets || !nextPacket || nextPacket.type === 'delta') {
				cache?._insertNext(cacheTrackInfo!, packet, nextPacket, undefined);
				return nextPacket;
			}

			return this.track.determinePacketType(nextPacket).then((determinedType) => {
				cache?._insertNext(cacheTrackInfo!, packet, nextPacket, determinedType);

				if (determinedType === 'delta') {
					return nextPacket.clone({ type: 'delta' });
				} else {
					return nextPacket;
				}
			});
		};

		const finalResult = result.pending
			? promise.then(() => run())
			: run();

		if (cacheTrackInfo && isThenable(finalResult)) {
			this.cache!._addPending(cacheTrackInfo.pendingNextCalls, packet.sequenceNumber, options, finalResult);
		}

		return finalResult;
	}

	getNextKey(packet: EncodedPacket, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const cacheTrackInfo = this.cache?._getTrackInfo(this.track);

		if (cacheTrackInfo) {
			const pending = this.cache!._getPending(cacheTrackInfo.pendingNextKeyCalls, packet.sequenceNumber, options);
			if (pending) {
				const retry = () => this.getNextKey(packet, options);
				return pending.then(retry, retry);
			}
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this._getNextKeyInternal(result, cacheTrackInfo, packet, options);

		if (!result.pending) {
			return result.value;
		}

		const finalResult = promise.then(() => result.value);
		if (cacheTrackInfo) {
			this.cache!._addPending(cacheTrackInfo.pendingNextKeyCalls, packet.sequenceNumber, options, finalResult);
		}

		return finalResult;
	}

	/** @internal */
	async _getNextKeyInternal(
		res: ResultValue<EncodedPacket | null>,
		cacheTrackInfo: PacketCacheTrackInfo | undefined,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		while (true) {
			if (cacheTrackInfo) {
				let cacheResult = this.cache!._getNextKey(cacheTrackInfo, packet, options);
				if (isThenable(cacheResult)) cacheResult = await cacheResult;

				if (cacheResult !== undefined) {
					if (cacheResult === null || cacheResult.type === 'key') {
						return res.set(cacheResult);
					}

					// Turned out to be a delta packet, so try the key packet after it
					packet = cacheResult;
					continue;
				}
			}

			const result = new ResultValue<PacketRetrievalResult>();
			const promise = this.track._backing.getNextKeyPacket(result, packet, options);
			if (result.pending) await promise;

			const nextKeyPacket = result.value.packet;
			const cache = result.value.provisional ? null : this.cache;

			if (!options.verifyKeyPackets || !nextKeyPacket) {
				cache?._insertNextKey(cacheTrackInfo!, packet, nextKeyPacket, undefined);
				return res.set(nextKeyPacket);
			}

			const determinedType = await this.track.determinePacketType(nextKeyPacket);
			cache?._insertNextKey(cacheTrackInfo!, packet, nextKeyPacket, determinedType);

			if (determinedType !== 'delta') {
				return res.set(nextKeyPacket);
			}

			// Try the next key packet instead (in hopes that it's actually a key packet)
			packet = nextKeyPacket;
		}
	}
}

type PacketCacheTrackInfo = {
	track: InputTrack;
	packets: EncodedPacket[]; // Sorted by timestamp
	next: Map<number, EncodedPacket | null>;
	prev: Map<number, EncodedPacket | null>;
	nextKey: Map<number, EncodedPacket | null>;
	// For each packet, stores the inclusive timestamp up to which getAt() queries are valid
	seekValidityEndpoint: Map<number, number>;
	// For each key packet, stores the inclusive timestamp up to which getKeyAt() queries are valid
	keySeekValidityEndpoint: Map<number, number>;
	// For each key packet, stores the minimum timestamp of all packets within its GOP, if known
	gopMinTimestamps: Map<number, number>;
	// Maps each packet to the key packet that starts its GOP
	gopKeys: Map<number, number>;
	first: EncodedPacket | null | undefined;
	minTimestamp: number;
	minKeyTimestamp: number;
	determinedTypes: Map<number, PacketType | null>;

	pendingFirstCalls: PendingCall[];
	pendingAtCalls: Map<number, PendingCall[]>;
	pendingKeyAtCalls: Map<number, PendingCall[]>;
	pendingNextCalls: Map<number, PendingCall[]>;
	pendingNextKeyCalls: Map<number, PendingCall[]>;
};

type PendingCall = {
	options: PacketRetrievalOptions;
	promise: Promise<unknown>;
};

export class PacketCache {
	/** @internal */
	_trackInfos = new Map<InputTrack, PacketCacheTrackInfo>();

	/** @internal */
	_getTrackInfo(track: InputTrack) {
		let info = this._trackInfos.get(track);
		if (!info) {
			info = {
				track,
				packets: [],
				next: new Map(),
				prev: new Map(),
				nextKey: new Map(),
				seekValidityEndpoint: new Map(),
				keySeekValidityEndpoint: new Map(),
				gopMinTimestamps: new Map(),
				gopKeys: new Map(),
				first: undefined,
				minTimestamp: -Infinity,
				minKeyTimestamp: -Infinity,
				determinedTypes: new Map(),

				pendingFirstCalls: [],
				pendingAtCalls: new Map(),
				pendingKeyAtCalls: new Map(),
				pendingNextCalls: new Map(),
				pendingNextKeyCalls: new Map(),
			};
			this._trackInfos.set(track, info);
		}

		return info;
	}

	/** @internal */
	_insertFirst(
		trackInfo: PacketCacheTrackInfo,
		packet: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		if (!packet) {
			trackInfo.first = null;
			return;
		}

		trackInfo.first = this._insertPacket(trackInfo, packet);
		trackInfo.prev.set(packet.sequenceNumber, null);

		// Knowing that nothing comes before this packet may be what completes the first GOP
		this._finalizeGop(trackInfo, packet);

		if (determinedType !== undefined) {
			trackInfo.determinedTypes.set(packet.sequenceNumber, determinedType);
		}
	}

	/** @internal */
	_insertAt(
		trackInfo: PacketCacheTrackInfo,
		timestamp: number,
		packet: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		if (!packet) {
			trackInfo.minTimestamp = Math.max(trackInfo.minTimestamp, timestamp);
			return;
		}

		this._insertPacket(trackInfo, packet);

		trackInfo.seekValidityEndpoint.set(
			packet.sequenceNumber,
			Math.max(timestamp, trackInfo.seekValidityEndpoint.get(packet.sequenceNumber) ?? -Infinity),
		);

		if (packet.type === 'key') {
			// There's no packet at all between this one and the timestamp, so certainly no key packet either
			trackInfo.keySeekValidityEndpoint.set(
				packet.sequenceNumber,
				Math.max(timestamp, trackInfo.keySeekValidityEndpoint.get(packet.sequenceNumber) ?? -Infinity),
			);
		}

		if (determinedType !== undefined) {
			trackInfo.determinedTypes.set(packet.sequenceNumber, determinedType);
		}
	}

	/** @internal */
	_insertKeyAt(
		trackInfo: PacketCacheTrackInfo,
		timestamp: number,
		packet: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		if (!packet) {
			trackInfo.minKeyTimestamp = Math.max(trackInfo.minKeyTimestamp, timestamp);
			return;
		}

		this._insertPacket(trackInfo, packet);

		trackInfo.keySeekValidityEndpoint.set(
			packet.sequenceNumber,
			Math.max(timestamp, trackInfo.keySeekValidityEndpoint.get(packet.sequenceNumber) ?? -Infinity),
		);

		if (determinedType !== undefined) {
			trackInfo.determinedTypes.set(packet.sequenceNumber, determinedType);
		}
	}

	/** @internal */
	_insertNext(
		trackInfo: PacketCacheTrackInfo,
		packet: EncodedPacket,
		next: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		if (next) {
			trackInfo.next.set(packet.sequenceNumber, this._insertPacket(trackInfo, next));
			trackInfo.prev.set(next.sequenceNumber, packet);

			if (determinedType !== undefined) {
				trackInfo.determinedTypes.set(next.sequenceNumber, determinedType);
			}
		} else {
			trackInfo.next.set(packet.sequenceNumber, null);
		}

		// Only these links can complete a GOP: either they close it off, or they join onto an existing chain that
		// leads to its end. Trying to finalize on every link would be quadratic in the GOP size.
		if (!next || next.type === 'key' || trackInfo.next.has(next.sequenceNumber)) {
			this._finalizeGop(trackInfo, packet);
		}

		// Under the GOP rule, a future key packet can't have a smaller timestamp than any packet before it. So, as the
		// chain following a key packet grows, so does the range in which no other key packet can lie.
		const gopKey = packet.type === 'key' ? packet.sequenceNumber : trackInfo.gopKeys.get(packet.sequenceNumber);
		if (gopKey !== undefined) {
			let keyEndpoint = trackInfo.keySeekValidityEndpoint.get(gopKey) ?? -Infinity;

			let currentPacket = packet;
			while (true) {
				const nextPacket = trackInfo.next.get(currentPacket.sequenceNumber);
				if (nextPacket === undefined) {
					break;
				}
				if (nextPacket === null) {
					keyEndpoint = Infinity;
					break;
				}
				if (nextPacket.type === 'key') {
					keyEndpoint = Math.max(keyEndpoint, nextPacket.timestamp);
					break;
				}
				if (trackInfo.gopKeys.has(nextPacket.sequenceNumber)) {
					break; // We've already been here
				}

				trackInfo.gopKeys.set(nextPacket.sequenceNumber, gopKey);
				// A future key packet may share this packet's timestamp, so we can only go right up to it
				keyEndpoint = Math.max(keyEndpoint, nextDown(nextPacket.timestamp));

				currentPacket = nextPacket;
			}

			trackInfo.keySeekValidityEndpoint.set(gopKey, keyEndpoint);
		}
	}

	/** @internal */
	_insertNextKey(
		trackInfo: PacketCacheTrackInfo,
		packet: EncodedPacket,
		nextKey: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		if (nextKey) {
			trackInfo.nextKey.set(packet.sequenceNumber, this._insertPacket(trackInfo, nextKey));

			if (determinedType !== undefined) {
				trackInfo.determinedTypes.set(nextKey.sequenceNumber, determinedType);
			}
		} else {
			trackInfo.nextKey.set(packet.sequenceNumber, null);
		}

		// If we know the key packet starting this packet's GOP, then we now also know the key packet following it
		const gopKey = packet.type === 'key' ? packet.sequenceNumber : trackInfo.gopKeys.get(packet.sequenceNumber);
		if (gopKey !== undefined) {
			const existingEndpoint = trackInfo.keySeekValidityEndpoint.get(gopKey) ?? -Infinity;
			trackInfo.keySeekValidityEndpoint.set(gopKey, Math.max(nextKey?.timestamp ?? Infinity, existingEndpoint));
		}
	}

	/** @internal */
	_finalizeGop(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket) {
		// When we know an entire GOP, we can conclude a bunch of additional information about it and make the packets
		// eligible for being returned by the .getAt method. This is because we make the assumption that the "GOP rule"
		// holds for the streams we read. This rule says that when a key frame occurs, no timestamp after it can be
		// less than any timestamp before it. This rule still allows for open GOPs but it puts a reasonable clamp on
		// timestamp monotonicity.

		// Walk forward to the last packet of the GOP; what follows it is either the next GOP's key packet or the end
		let lastGopPacket = packet;
		let gopEnd: EncodedPacket | null;
		while (true) {
			const nextPacket = trackInfo.next.get(lastGopPacket.sequenceNumber);
			if (nextPacket === undefined) {
				return; // Incomplete
			}
			if (nextPacket === null || nextPacket.type === 'key') {
				gopEnd = nextPacket;
				break;
			}

			lastGopPacket = nextPacket;
		}

		// Walk backward to the start of the GOP
		const gopPackets: EncodedPacket[] = [];
		let gopStart = lastGopPacket;
		while (true) {
			gopPackets.push(gopStart);
			if (gopStart.type === 'key') {
				break;
			}

			const prevPacket = trackInfo.prev.get(gopStart.sequenceNumber);
			if (prevPacket === undefined) {
				return; // Incomplete
			}
			if (prevPacket === null) {
				break; // The first packet always starts a GOP
			}

			gopStart = prevPacket;
		}

		let minTimestamp = Infinity;
		let endpoint = -Infinity;
		for (const gopPacket of gopPackets) {
			minTimestamp = Math.min(minTimestamp, gopPacket.timestamp);
			endpoint = Math.max(
				endpoint,
				gopPacket.timestamp,
				trackInfo.seekValidityEndpoint.get(gopPacket.sequenceNumber) ?? -Infinity,
			);
		}

		if (gopEnd) {
			// If we already know the next GOP's minimum timestamp, nothing can lie between this GOP and it
			endpoint = Math.max(endpoint, trackInfo.gopMinTimestamps.get(gopEnd.sequenceNumber) ?? -Infinity);
		} else {
			endpoint = Infinity;
		}

		for (const gopPacket of gopPackets) {
			trackInfo.seekValidityEndpoint.set(gopPacket.sequenceNumber, endpoint);
		}

		trackInfo.gopMinTimestamps.set(gopStart.sequenceNumber, minTimestamp);

		// Same thing the other way around: if the previous GOP is complete, it now extends up to our minimum timestamp
		const previousGopPackets: EncodedPacket[] = [];
		let currentPacket = gopStart;
		while (true) {
			const prevPacket = trackInfo.prev.get(currentPacket.sequenceNumber);
			if (prevPacket === undefined) {
				return; // Incomplete
			}
			if (prevPacket === null) {
				break; // We've reached the first packet
			}

			previousGopPackets.push(prevPacket);
			if (prevPacket.type === 'key') {
				break;
			}

			currentPacket = prevPacket;
		}

		for (const { sequenceNumber } of previousGopPackets) {
			const existingEndpoint = trackInfo.seekValidityEndpoint.get(sequenceNumber) ?? -Infinity;
			trackInfo.seekValidityEndpoint.set(sequenceNumber, Math.max(minTimestamp, existingEndpoint));
		}
	}

	/** @internal */
	_insertPacket(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket) {
		let index = binarySearchLessOrEqual(trackInfo.packets, packet.timestamp, x => x.timestamp);

		// Packets with equal timestamps are ordered by sequence number
		while (
			index !== -1
			&& trackInfo.packets[index]!.timestamp === packet.timestamp
			&& trackInfo.packets[index]!.sequenceNumber > packet.sequenceNumber
		) {
			index--;
		}

		if (index !== -1 && trackInfo.packets[index]!.sequenceNumber === packet.sequenceNumber) {
			const existingPacket = trackInfo.packets[index]!;
			if (existingPacket.isMetadataOnly && !packet.isMetadataOnly) {
				// Upgrade in place so that everything referencing the packet gets the data too
				// @ts-expect-error Technically readonly
				existingPacket.data = packet.data;
				// @ts-expect-error Technically readonly
				existingPacket.sideData = packet.sideData;
			}

			return existingPacket;
		}

		// Metadata-only packets may get upgraded in place later, which must not affect the instance we were handed
		const storedPacket = packet.isMetadataOnly ? packet.clone() : packet;
		trackInfo.packets.splice(index + 1, 0, storedPacket);

		return storedPacket;
	}

	/** @internal */
	_getFirst(trackInfo: PacketCacheTrackInfo, options: PacketRetrievalOptions) {
		if (trackInfo.first === undefined || trackInfo.first === null) {
			return trackInfo.first;
		}

		return this._checkAgainstRetrievalOptions(trackInfo, trackInfo.first, options);
	}

	/** @internal */
	_getPendingFirst(trackInfo: PacketCacheTrackInfo, options: PacketRetrievalOptions) {
		const pendingCall = trackInfo.pendingFirstCalls.find(x => retrievalOptionsAreEqual(x.options, options));
		return pendingCall?.promise ?? null;
	}

	/** @internal */
	_addPendingFirst(trackInfo: PacketCacheTrackInfo, options: PacketRetrievalOptions, promise: Promise<unknown>) {
		const pendingCall = {
			options,
			promise,
		};
		trackInfo.pendingFirstCalls.push(pendingCall);

		const remove = () => {
			removeItem(trackInfo.pendingFirstCalls, pendingCall);
		};
		void promise.then(remove, remove);
	}

	/** @internal */
	_getPending(pendingCalls: Map<number, PendingCall[]>, key: number, options: PacketRetrievalOptions) {
		const pendingCall = pendingCalls.get(key)?.find(x => retrievalOptionsAreEqual(x.options, options));
		return pendingCall?.promise ?? null;
	}

	/** @internal */
	_addPending(
		pendingCalls: Map<number, PendingCall[]>,
		key: number,
		options: PacketRetrievalOptions,
		promise: Promise<unknown>,
	) {
		const calls = pendingCalls.get(key) ?? [];
		pendingCalls.set(key, calls);

		const pendingCall = {
			options,
			promise,
		};
		calls.push(pendingCall);

		const remove = () => {
			removeItem(calls, pendingCall);
			if (calls.length === 0) {
				pendingCalls.delete(key);
			}
		};
		void promise.then(remove, remove);
	}

	/** @internal */
	_getAt(trackInfo: PacketCacheTrackInfo, timestamp: number, options: PacketRetrievalOptions) {
		if (timestamp <= trackInfo.minTimestamp) {
			return null; // Nothing here
		}

		const index = binarySearchLessOrEqual(trackInfo.packets, timestamp, x => x.timestamp);

		if (index === -1) {
			return undefined;
		}

		const packet = trackInfo.packets[index]!;
		const endpoint = trackInfo.seekValidityEndpoint.get(packet.sequenceNumber);
		if (endpoint === undefined || timestamp > endpoint) {
			return undefined;
		}

		return this._checkAgainstRetrievalOptions(trackInfo, packet, options);
	}

	/** @internal */
	_getKeyAt(trackInfo: PacketCacheTrackInfo, timestamp: number, options: PacketRetrievalOptions) {
		if (timestamp <= trackInfo.minTimestamp || timestamp <= trackInfo.minKeyTimestamp) {
			return null; // Nothing here
		}

		// Walk back to the latest key packet we know of
		let index = binarySearchLessOrEqual(trackInfo.packets, timestamp, x => x.timestamp);
		while (index !== -1 && trackInfo.packets[index]!.type !== 'key') {
			index--;
		}

		if (index === -1) {
			return undefined;
		}

		const packet = trackInfo.packets[index]!;
		const endpoint = trackInfo.keySeekValidityEndpoint.get(packet.sequenceNumber);
		if (endpoint === undefined || timestamp > endpoint) {
			return undefined;
		}

		return this._checkAgainstRetrievalOptions(trackInfo, packet, options);
	}

	/** @internal */
	_getNext(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket, options: PacketRetrievalOptions) {
		const nextPacket = trackInfo.next.get(packet.sequenceNumber);
		if (nextPacket === undefined) {
			return undefined;
		}

		if (nextPacket === null) {
			return null;
		}

		return this._checkAgainstRetrievalOptions(trackInfo, nextPacket, options);
	}

	/** @internal */
	_getNextKey(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket, options: PacketRetrievalOptions) {
		const nextKeyPacket = trackInfo.nextKey.get(packet.sequenceNumber);
		if (nextKeyPacket === null) {
			return null;
		}
		if (nextKeyPacket !== undefined) {
			return this._checkAgainstRetrievalOptions(trackInfo, nextKeyPacket, options);
		}

		// No direct information, but maybe we can find it by following the chain
		let currentPacket = packet;
		while (true) {
			const nextPacket = trackInfo.next.get(currentPacket.sequenceNumber);
			if (nextPacket === undefined) {
				return undefined;
			}
			if (nextPacket === null) {
				return null;
			}
			if (nextPacket.type === 'key') {
				return this._checkAgainstRetrievalOptions(trackInfo, nextPacket, options);
			}

			currentPacket = nextPacket;
		}
	}

	/** @internal */
	_checkAgainstRetrievalOptions(
		trackInfo: PacketCacheTrackInfo,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	) {
		if (packet.isMetadataOnly && !options.metadataOnly) {
			return undefined;
		}
		if (!packet.isMetadataOnly && options.metadataOnly) {
			return packet._toMetadataOnly();
		}

		if (options.verifyKeyPackets && packet.type === 'key') {
			assert(!packet.isMetadataOnly); // Can't be

			const determinedType = trackInfo.determinedTypes.get(packet.sequenceNumber);
			if (determinedType !== undefined) {
				if (determinedType === 'delta') {
					return packet.clone({ type: 'delta' });
				} else {
					return packet.clone();
				}
			}

			return trackInfo.track.determinePacketType(packet).then((determinedType) => {
				trackInfo.determinedTypes.set(packet.sequenceNumber, determinedType);

				if (determinedType === 'delta') {
					return packet.clone({ type: 'delta' });
				} else {
					return packet.clone();
				}
			});
		}

		// Never hand out our own instances, just like demuxers always return fresh ones
		return packet.clone();
	}
}
