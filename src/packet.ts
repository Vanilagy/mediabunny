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

	/**
	 * The unique ID of the track this packet was retrieved from.
	 * @internal
	 */
	_ownerId: number | null = null;

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

		return new EncodedPacket(
			options?.data ?? this.data,
			options?.type ?? this.type,
			options?.timestamp ?? this.timestamp,
			options?.duration ?? this.duration,
			options?.sequenceNumber ?? this.sequenceNumber,
			this.byteLength,
			options?.sideData ?? this.sideData,
		);
	}

	/** @internal */
	_cloneInternal(options?: Parameters<EncodedPacket['clone']>[0]) {
		const packet = this.clone(options);
		packet._internal = this._internal;
		packet._ownerId = this._ownerId;

		return packet;
	}

	/** @internal */
	_toMetadataOnly() {
		if (this.isMetadataOnly) {
			return this;
		}

		return this._cloneInternal({
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

			if (packet) {
				packet._ownerId = this.track._uniqueId;
			}

			if (!options.verifyKeyPackets || !packet || packet.type === 'delta') {
				cache?._insertFirst(cacheTrackInfo!, packet, undefined);
				return packet;
			}

			return this.track.determinePacketType(packet).then((determinedType) => {
				cache?._insertFirst(cacheTrackInfo!, packet, determinedType);

				if (determinedType === 'delta') {
					return packet._cloneInternal({ type: 'delta' });
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

			if (packet) {
				packet._ownerId = this.track._uniqueId;
			}

			if (!options.verifyKeyPackets || !packet || packet.type === 'delta') {
				cache?._insertAt(cacheTrackInfo!, timestamp, packet, undefined);
				return packet;
			}

			return this.track.determinePacketType(packet).then((determinedType) => {
				cache?._insertAt(cacheTrackInfo!, timestamp, packet, determinedType);

				if (determinedType === 'delta') {
					return packet._cloneInternal({ type: 'delta' });
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

			if (packet) {
				packet._ownerId = this.track._uniqueId;
			}

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
		if (packet._ownerId !== this.track._uniqueId) {
			throw new Error('Packet was not created from this track.');
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

			if (nextPacket) {
				nextPacket._ownerId = this.track._uniqueId;
			}

			if (!options.verifyKeyPackets || !nextPacket || nextPacket.type === 'delta') {
				cache?._insertNext(cacheTrackInfo!, packet, nextPacket, undefined);
				return nextPacket;
			}

			return this.track.determinePacketType(nextPacket).then((determinedType) => {
				cache?._insertNext(cacheTrackInfo!, packet, nextPacket, determinedType);

				if (determinedType === 'delta') {
					return nextPacket._cloneInternal({ type: 'delta' });
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
		if (packet._ownerId !== this.track._uniqueId) {
			throw new Error('Packet was not created from this track.');
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

			if (nextKeyPacket) {
				nextKeyPacket._ownerId = this.track._uniqueId;
			}

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
	// Contains exactly the cached packets, keyed by sequence number
	entries: Map<number, CacheEntry>;
	sortedEntries: CacheEntry[]; // Sorted by timestamp, then by sequence number
	first: CacheEntry | null | undefined;
	minTimestamp: number;
	minKeyTimestamp: number;

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

// Everything the cache knows about a cached packet
type CacheEntry = {
	trackInfo: PacketCacheTrackInfo;
	// Set to null once evicted, so that lingering references to the entry don't keep the packet alive
	packet: EncodedPacket | null;
	// Copied from the packet since it's still needed after eviction
	timestamp: number;

	// For the links, undefined means unknown and null means there is none
	next: CacheEntry | null | undefined;
	prev: CacheEntry | null | undefined;
	nextKey: CacheEntry | null | undefined;
	// The inclusive timestamp up to which getAt() queries landing on this packet are valid
	seekValidityEndpoint: number | null;
	// The inclusive timestamp up to which getKeyAt() queries landing on this (key) packet are valid
	keySeekValidityEndpoint: number | null;
	// For key packets, the minimum timestamp of all packets within their GOP, if known
	gopMinTimestamp: number | null;
	// The key packet that starts this packet's GOP, if known
	gopKey: CacheEntry | null;
	determinedType: PacketType | null | undefined;

	size: number;
	lruPrev: CacheEntry | null; // More recently used
	lruNext: CacheEntry | null; // Less recently used
};

const DEFAULT_MAX_CACHE_SIZE = 64 * 1024 * 1024;

// To make eviction batched, which improves performance:
const EVICTION_HIGH_WATERMARK = 1.1;
const EVICTION_LOW_WATERMARK = 0.9;

/** Rough estimate of the memory a cached packet takes up besides its data. */
export const PACKET_SIZE_OVERHEAD = 200;

export type PacketCacheOptions = {
	maxCacheSize?: number;
	autoEvict?: boolean;
};

export class PacketCache {
	/** @internal */
	_trackInfos = new Map<InputTrack, PacketCacheTrackInfo>();
	/** @internal */
	_maxCacheSize: number;
	/** @internal */
	_autoEvict: boolean;
	/** @internal */
	_evictionEnabled: boolean;
	/** @internal */
	_cacheSize = 0;
	/** @internal */
	_lruHead: CacheEntry | null = null;
	/** @internal */
	_lruTail: CacheEntry | null = null;

	constructor(options: PacketCacheOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (options.maxCacheSize !== undefined && (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)) {
			throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
		}
		if (options.autoEvict !== undefined && typeof options.autoEvict !== 'boolean') {
			throw new TypeError('options.autoEvict, when provided, must be a boolean.');
		}

		this._maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
		this._autoEvict = options.autoEvict ?? true;
		this._evictionEnabled = this._maxCacheSize !== Infinity;
	}

	clear() {
		// Emptied in place since in-flight requests may still be holding on to them
		for (const trackInfo of this._trackInfos.values()) {
			for (const entry of trackInfo.sortedEntries) {
				entry.packet = null; // Marks the entry as evicted for anyone still holding on to it
			}

			trackInfo.entries.clear();
			trackInfo.sortedEntries.length = 0;
			trackInfo.first = undefined;
			trackInfo.minTimestamp = -Infinity;
			trackInfo.minKeyTimestamp = -Infinity;
		}

		this._lruHead = null;
		this._lruTail = null;
		this._cacheSize = 0;
	}

	evict() {
		if (this._cacheSize <= EVICTION_HIGH_WATERMARK * this._maxCacheSize) {
			return;
		}

		const targetSize = EVICTION_LOW_WATERMARK * this._maxCacheSize;
		const affectedTrackInfos = new Set<PacketCacheTrackInfo>();

		while (this._cacheSize > targetSize) {
			const entry = this._lruTail!;
			this._unlinkLruEntry(entry);
			this._cacheSize -= entry.size;
			affectedTrackInfos.add(entry.trackInfo);
			this._removeEntry(entry);
		}

		// Now, remove the evicted entries from the sorted lists in a single pass each
		for (const trackInfo of affectedTrackInfos) {
			const sortedEntries = trackInfo.sortedEntries;
			let writeIndex = 0;
			let previousWasKept = false;

			for (let i = 0; i < sortedEntries.length; i++) {
				const entry = sortedEntries[i]!;
				if (entry.packet !== null) {
					sortedEntries[writeIndex++] = entry;
					previousWasKept = true;
					continue;
				}

				if (previousWasKept) {
					// Lookups that used to land on this run of evicted packets now land on the kept packet before it,
					// which therefore mustn't claim validity up to the run anymore
					const predecessor = sortedEntries[writeIndex - 1]!;
					if (predecessor.seekValidityEndpoint !== null) {
						predecessor.seekValidityEndpoint = Math.min(
							predecessor.seekValidityEndpoint,
							nextDown(entry.timestamp),
						);
					}
				}

				previousWasKept = false;
			}

			sortedEntries.length = writeIndex;
		}
	}

	/** @internal */
	_getTrackInfo(track: InputTrack) {
		let info = this._trackInfos.get(track);
		if (!info) {
			info = {
				track,
				entries: new Map(),
				sortedEntries: [],
				first: undefined,
				minTimestamp: -Infinity,
				minKeyTimestamp: -Infinity,

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

		const entry = this._insertPacket(trackInfo, packet);
		trackInfo.first = entry;
		entry.prev = null;

		if (entry.packet!.type === 'key') {
			// Under the GOP rule, no later key packet can have a smaller timestamp than the first one
			trackInfo.minKeyTimestamp = Math.max(trackInfo.minKeyTimestamp, nextDown(entry.timestamp));
		}

		// Knowing that nothing comes before this packet may be what completes the first GOP
		this._finalizeGop(entry);

		if (determinedType !== undefined) {
			entry.determinedType = determinedType;
		}

		if (this._autoEvict) {
			this.evict();
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

		const entry = this._insertPacket(trackInfo, packet);

		entry.seekValidityEndpoint = Math.max(timestamp, entry.seekValidityEndpoint ?? -Infinity);

		if (entry.gopKey && !entry.gopKey.packet) {
			entry.gopKey = null; // The GOP's key packet has been evicted
		}

		const gopKey = entry.packet!.type === 'key' ? entry : entry.gopKey;
		if (gopKey) {
			// There's no packet at all between this one and the timestamp, so certainly no key packet either. And since
			// any key packet after this one can't have a smaller timestamp, the key packet of this packet's GOP is
			// valid up to the timestamp too.
			gopKey.keySeekValidityEndpoint = Math.max(timestamp, gopKey.keySeekValidityEndpoint ?? -Infinity);
		}

		if (determinedType !== undefined) {
			entry.determinedType = determinedType;
		}

		if (this._autoEvict) {
			this.evict();
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

		const entry = this._insertPacket(trackInfo, packet);

		entry.keySeekValidityEndpoint = Math.max(timestamp, entry.keySeekValidityEndpoint ?? -Infinity);

		if (determinedType !== undefined) {
			entry.determinedType = determinedType;
		}

		if (this._autoEvict) {
			this.evict();
		}
	}

	/** @internal */
	_insertNext(
		trackInfo: PacketCacheTrackInfo,
		packet: EncodedPacket,
		next: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		const nextEntry = next ? this._insertPacket(trackInfo, next) : null;
		if (nextEntry && determinedType !== undefined) {
			nextEntry.determinedType = determinedType;
		}

		// Links only ever connect two packets in the cache
		const entry = trackInfo.entries.get(packet.sequenceNumber);
		if (!entry) {
			if (this._autoEvict) {
				this.evict();
			}

			return;
		}

		entry.next = nextEntry;
		if (nextEntry) {
			nextEntry.prev = entry;
		}

		// Only these links can complete a GOP: either they close it off, or they join onto an existing chain that
		// leads to its end. Trying to finalize on every link would be quadratic in the GOP size.
		if (!nextEntry || nextEntry.packet!.type === 'key' || nextEntry.next !== undefined) {
			this._finalizeGop(entry);
		}

		// Under the GOP rule, a future key packet can't have a smaller timestamp than any packet before it. So, as the
		// chain following a key packet grows, so does the range in which no other key packet can lie.
		if (entry.gopKey && !entry.gopKey.packet) {
			entry.gopKey = null; // The GOP's key packet has been evicted
		}
		const gopKey = entry.packet!.type === 'key' ? entry : entry.gopKey;
		if (gopKey) {
			let keyEndpoint = gopKey.keySeekValidityEndpoint ?? -Infinity;

			let currentEntry = entry;
			while (true) {
				const followingEntry = currentEntry.next;
				if (followingEntry === undefined) {
					break;
				}
				if (followingEntry === null) {
					keyEndpoint = Infinity;
					break;
				}
				if (followingEntry.packet!.type === 'key') {
					// Exclusive, so that this stays true even once the next key packet is no longer cached
					keyEndpoint = Math.max(keyEndpoint, nextDown(followingEntry.timestamp));
					break;
				}
				if (followingEntry.gopKey === gopKey) {
					break; // We've already been here
				}

				followingEntry.gopKey = gopKey;
				// A future key packet may share this packet's timestamp, so we can only go right up to it
				keyEndpoint = Math.max(keyEndpoint, nextDown(followingEntry.timestamp));

				// The packet may have learned about its next key packet before joining the GOP. Its timestamp stays
				// true even if it has been evicted since.
				if (followingEntry.nextKey !== undefined) {
					keyEndpoint = Math.max(
						keyEndpoint,
						followingEntry.nextKey ? nextDown(followingEntry.nextKey.timestamp) : Infinity,
					);
				}

				currentEntry = followingEntry;
			}

			gopKey.keySeekValidityEndpoint = keyEndpoint;
		}

		if (this._autoEvict) {
			this.evict();
		}
	}

	/** @internal */
	_insertNextKey(
		trackInfo: PacketCacheTrackInfo,
		packet: EncodedPacket,
		nextKey: EncodedPacket | null,
		determinedType: PacketType | null | undefined,
	) {
		const nextKeyEntry = nextKey ? this._insertPacket(trackInfo, nextKey) : null;
		if (nextKeyEntry && determinedType !== undefined) {
			nextKeyEntry.determinedType = determinedType;
		}

		// Like with next(), only remember the link if the packet we came from is also cached
		const entry = trackInfo.entries.get(packet.sequenceNumber);
		if (entry) {
			entry.nextKey = nextKeyEntry;

			// If we know the key packet starting this packet's GOP, then we now also know the key packet following it
			if (entry.gopKey && !entry.gopKey.packet) {
				entry.gopKey = null; // The GOP's key packet has been evicted
			}

			const gopKey = entry.packet!.type === 'key' ? entry : entry.gopKey;
			if (gopKey) {
				const newEndpoint = nextKeyEntry ? nextDown(nextKeyEntry.timestamp) : Infinity;
				gopKey.keySeekValidityEndpoint = Math.max(newEndpoint, gopKey.keySeekValidityEndpoint ?? -Infinity);
			}
		}

		if (this._autoEvict) {
			this.evict();
		}
	}

	/** @internal */
	_finalizeGop(entry: CacheEntry) {
		// When we know an entire GOP, we can conclude a bunch of additional information about it and make the packets
		// eligible for being returned by the .getAt method. This is because we make the assumption that the "GOP rule"
		// holds for the streams we read. This rule says that when a key frame occurs, no timestamp after it can be
		// less than any timestamp before it. This rule still allows for open GOPs but it puts a reasonable clamp on
		// timestamp monotonicity.

		// Walk forward to the last packet of the GOP; what follows it is either the next GOP's key packet or the end
		let lastGopEntry = entry;
		let gopEnd: CacheEntry | null;
		while (true) {
			const nextEntry = lastGopEntry.next;
			if (nextEntry === undefined) {
				return; // Incomplete
			}
			if (nextEntry === null || nextEntry.packet!.type === 'key') {
				gopEnd = nextEntry;
				break;
			}

			lastGopEntry = nextEntry;
		}

		// Walk backward to the start of the GOP
		let minTimestamp = Infinity;
		let endpoint = -Infinity;
		let gopStart = lastGopEntry;
		while (true) {
			minTimestamp = Math.min(minTimestamp, gopStart.timestamp);
			endpoint = Math.max(endpoint, gopStart.timestamp, gopStart.seekValidityEndpoint ?? -Infinity);
			if (gopStart.packet!.type === 'key') {
				break;
			}

			const prevEntry = gopStart.prev;
			if (prevEntry === undefined) {
				return; // Incomplete
			}
			if (prevEntry === null) {
				break; // The first packet always starts a GOP
			}

			gopStart = prevEntry;
		}

		if (gopEnd) {
			// If we already know the next GOP's minimum timestamp, nothing can lie between this GOP and it. Exclusive,
			// since the packet at that timestamp may no longer be cached.
			if (gopEnd.gopMinTimestamp !== null) {
				endpoint = Math.max(endpoint, nextDown(gopEnd.gopMinTimestamp));
			}
		} else {
			endpoint = Infinity;
		}

		let currentEntry = gopStart;
		while (true) {
			currentEntry.seekValidityEndpoint = endpoint;
			if (currentEntry === lastGopEntry) {
				break;
			}

			currentEntry = currentEntry.next!;
		}

		gopStart.gopMinTimestamp = minTimestamp;

		if (gopStart.prev === null) {
			// Nothing after the first GOP can go below anything in it, so this is the smallest timestamp of the track
			const trackInfo = gopStart.trackInfo;
			trackInfo.minTimestamp = Math.max(trackInfo.minTimestamp, nextDown(minTimestamp));

			if (gopStart.packet!.type !== 'key') {
				// The track starts with a delta packet, so the first key packet is the one ending this GOP
				const firstKeyEndpoint = gopEnd ? nextDown(gopEnd.timestamp) : Infinity;
				trackInfo.minKeyTimestamp = Math.max(trackInfo.minKeyTimestamp, firstKeyEndpoint);
			}
		}

		// Same thing the other way around: if the previous GOP is complete, it now extends up to our minimum timestamp
		let previousGopStart = gopStart;
		while (true) {
			const prevEntry = previousGopStart.prev;
			if (prevEntry === undefined) {
				return; // Incomplete
			}
			if (prevEntry === null) {
				break; // We've reached the first packet
			}

			previousGopStart = prevEntry;
			if (prevEntry.packet!.type === 'key') {
				break;
			}
		}

		currentEntry = previousGopStart;
		while (currentEntry !== gopStart) {
			currentEntry.seekValidityEndpoint = Math.max(minTimestamp, currentEntry.seekValidityEndpoint ?? -Infinity);
			currentEntry = currentEntry.next!;
		}
	}

	/** @internal */
	_insertPacket(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket) {
		const existingEntry = trackInfo.entries.get(packet.sequenceNumber);
		if (existingEntry) {
			const existingPacket = existingEntry.packet!;
			if (existingPacket.isMetadataOnly && !packet.isMetadataOnly) {
				// Upgrade in place so that everything referencing the packet gets the data too
				// @ts-expect-error Technically readonly
				existingPacket.data = packet.data;
				// @ts-expect-error Technically readonly
				existingPacket.sideData = packet.sideData;

				if (this._evictionEnabled) {
					const size = getCachedPacketSize(existingPacket);
					this._cacheSize += size - existingEntry.size;
					existingEntry.size = size;
				}
			}

			if (this._evictionEnabled) {
				this._unlinkLruEntry(existingEntry);
				this._linkLruEntryAtHead(existingEntry);
			}

			return existingEntry;
		}

		const sortedEntries = trackInfo.sortedEntries;
		let index = binarySearchLessOrEqual(sortedEntries, packet.timestamp, x => x.timestamp);

		// Packets with equal timestamps are ordered by sequence number
		while (
			index !== -1
			&& sortedEntries[index]!.timestamp === packet.timestamp
			&& sortedEntries[index]!.packet!.sequenceNumber > packet.sequenceNumber
		) {
			index--;
		}

		// Metadata-only packets may get upgraded in place later, which must not affect the instance we were handed
		const storedPacket = packet.isMetadataOnly ? packet._cloneInternal() : packet;

		const entry: CacheEntry = {
			trackInfo,
			packet: storedPacket,
			timestamp: storedPacket.timestamp,
			next: undefined,
			prev: undefined,
			nextKey: undefined,
			seekValidityEndpoint: null,
			keySeekValidityEndpoint: null,
			gopMinTimestamp: null,
			gopKey: null,
			determinedType: undefined,
			size: 0,
			lruPrev: null,
			lruNext: null,
		};
		sortedEntries.splice(index + 1, 0, entry);
		trackInfo.entries.set(storedPacket.sequenceNumber, entry);

		if (this._evictionEnabled) {
			entry.size = getCachedPacketSize(storedPacket);
			this._cacheSize += entry.size;
			this._linkLruEntryAtHead(entry);
		}

		return entry;
	}

	/** @internal */
	_removeEntry(entry: CacheEntry) {
		const trackInfo = entry.trackInfo;

		if (entry.prev) {
			entry.prev.next = undefined;
		}
		if (entry.next) {
			entry.next.prev = undefined;
		}
		if (trackInfo.first === entry) {
			trackInfo.first = undefined;
		}

		trackInfo.entries.delete(entry.packet!.sequenceNumber);

		// Other entries may still reference this one, so mark it as evicted and make sure it doesn't keep
		// anything alive
		entry.packet = null;
		entry.next = undefined;
		entry.prev = undefined;
		entry.nextKey = undefined;
		entry.gopKey = null;
	}

	/** @internal */
	_getFirst(trackInfo: PacketCacheTrackInfo, options: PacketRetrievalOptions) {
		if (trackInfo.first === undefined || trackInfo.first === null) {
			return trackInfo.first;
		}

		return this._checkAgainstRetrievalOptions(trackInfo.first, options);
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

		const index = binarySearchLessOrEqual(trackInfo.sortedEntries, timestamp, x => x.timestamp);

		if (index === -1) {
			return undefined;
		}

		const entry = trackInfo.sortedEntries[index]!;
		if (entry.seekValidityEndpoint === null || timestamp > entry.seekValidityEndpoint) {
			return undefined;
		}

		return this._checkAgainstRetrievalOptions(entry, options);
	}

	/** @internal */
	_getKeyAt(trackInfo: PacketCacheTrackInfo, timestamp: number, options: PacketRetrievalOptions) {
		if (timestamp <= trackInfo.minTimestamp || timestamp <= trackInfo.minKeyTimestamp) {
			return null; // Nothing here
		}

		// Walk back to the latest key packet we know of
		const sortedEntries = trackInfo.sortedEntries;
		let index = binarySearchLessOrEqual(sortedEntries, timestamp, x => x.timestamp);
		while (index !== -1 && sortedEntries[index]!.packet!.type !== 'key') {
			index--;
		}

		if (index === -1) {
			return undefined;
		}

		const entry = sortedEntries[index]!;
		if (entry.keySeekValidityEndpoint === null || timestamp > entry.keySeekValidityEndpoint) {
			return undefined;
		}

		return this._checkAgainstRetrievalOptions(entry, options);
	}

	/** @internal */
	_getNext(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket, options: PacketRetrievalOptions) {
		const nextEntry = trackInfo.entries.get(packet.sequenceNumber)?.next;
		if (nextEntry === undefined) {
			return undefined;
		}

		if (nextEntry === null) {
			return null;
		}

		return this._checkAgainstRetrievalOptions(nextEntry, options);
	}

	/** @internal */
	_getNextKey(trackInfo: PacketCacheTrackInfo, packet: EncodedPacket, options: PacketRetrievalOptions) {
		const entry = trackInfo.entries.get(packet.sequenceNumber);
		if (!entry) {
			return undefined;
		}

		// Delta packets share the next key packet of the packet before them, so walk back through the GOP until some
		// packet knows it
		let currentEntry = entry;
		while (true) {
			// The next key packet itself may have been evicted in the meantime
			if (currentEntry.nextKey && !currentEntry.nextKey.packet) {
				currentEntry.nextKey = undefined;
			}
			if (currentEntry.nextKey === undefined && currentEntry.keySeekValidityEndpoint === Infinity) {
				currentEntry.nextKey = null; // It's the last key packet
			}
			if (currentEntry.nextKey !== undefined) {
				entry.nextKey = currentEntry.nextKey; // Remember it so the next lookup doesn't need to walk again
				if (entry.nextKey === null) {
					return null;
				}

				return this._checkAgainstRetrievalOptions(entry.nextKey, options);
			}
			if (currentEntry.packet!.type === 'key' || !currentEntry.prev) {
				break;
			}

			currentEntry = currentEntry.prev;
		}

		// No direct information, but maybe we can find it by following the chain
		currentEntry = entry;
		while (true) {
			const nextEntry = currentEntry.next;
			if (nextEntry === undefined) {
				return undefined;
			}
			if (nextEntry === null) {
				return null;
			}
			if (nextEntry.packet!.type === 'key') {
				return this._checkAgainstRetrievalOptions(nextEntry, options);
			}

			currentEntry = nextEntry;
		}
	}

	/** @internal */
	_checkAgainstRetrievalOptions(entry: CacheEntry, options: PacketRetrievalOptions) {
		const packet = entry.packet!;
		if (packet.isMetadataOnly && !options.metadataOnly) {
			return undefined;
		}

		if (this._evictionEnabled) {
			// The packet gets returned, so it's now the most recently used one
			this._unlinkLruEntry(entry);
			this._linkLruEntryAtHead(entry);
		}

		if (!packet.isMetadataOnly && options.metadataOnly) {
			return packet._toMetadataOnly();
		}

		if (options.verifyKeyPackets && packet.type === 'key') {
			assert(!packet.isMetadataOnly); // Can't be

			if (entry.determinedType !== undefined) {
				if (entry.determinedType === 'delta') {
					return packet._cloneInternal({ type: 'delta' });
				} else {
					return packet._cloneInternal();
				}
			}

			return entry.trackInfo.track.determinePacketType(packet).then((determinedType) => {
				// The packet may have been evicted while we were waiting
				if (entry.packet) {
					entry.determinedType = determinedType;
				}

				if (determinedType === 'delta') {
					return packet._cloneInternal({ type: 'delta' });
				} else {
					return packet._cloneInternal();
				}
			});
		}

		return packet._cloneInternal();
	}

	/** @internal */
	_unlinkLruEntry(entry: CacheEntry) {
		if (entry.lruPrev) {
			entry.lruPrev.lruNext = entry.lruNext;
		} else {
			this._lruHead = entry.lruNext;
		}

		if (entry.lruNext) {
			entry.lruNext.lruPrev = entry.lruPrev;
		} else {
			this._lruTail = entry.lruPrev;
		}

		entry.lruPrev = null;
		entry.lruNext = null;
	}

	/** @internal */
	_linkLruEntryAtHead(entry: CacheEntry) {
		entry.lruNext = this._lruHead;

		if (this._lruHead) {
			this._lruHead.lruPrev = entry;
		} else {
			this._lruTail = entry;
		}

		this._lruHead = entry;
	}
}

const getCachedPacketSize = (packet: EncodedPacket) => {
	return PACKET_SIZE_OVERHEAD + packet.data.byteLength + (packet.sideData.alpha?.byteLength ?? 0);
};
