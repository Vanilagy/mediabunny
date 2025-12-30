/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { InputDisposedError } from './input';
import { InputTrack } from './input-track';
import { isNumber, MaybePromise, ResultValue, SECOND_TO_MICROSECOND_FACTOR } from './misc';

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
		/** The encoded data of this packet. */
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
			throw new Error('Your browser does not support EncodedVideoChunk.');
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
			throw new Error('Your browser does not support EncodedVideoChunk.');
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
			throw new Error('Your browser does not support EncodedAudioChunk.');
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

	/** Clones this packet while optionally updating timing information. */
	clone(options?: {
		/** The timestamp of the cloned packet in seconds. */
		timestamp?: number;
		/** The duration of the cloned packet in seconds. */
		duration?: number;
	}): EncodedPacket {
		if (options !== undefined && (typeof options !== 'object' || options === null)) {
			throw new TypeError('options, when provided, must be an object.');
		}
		if (options?.timestamp !== undefined && !Number.isFinite(options.timestamp)) {
			throw new TypeError('options.timestamp, when provided, must be a number.');
		}
		if (options?.duration !== undefined && !Number.isFinite(options.duration)) {
			throw new TypeError('options.duration, when provided, must be a number.');
		}

		return new EncodedPacket(
			this.data,
			this.type,
			options?.timestamp ?? this.timestamp,
			options?.duration ?? this.duration,
			this.sequenceNumber,
			this.byteLength,
		);
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
};

export const validatePacketRetrievalOptions = (options: PacketRetrievalOptions) => {
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
};

export const validateTimestamp = (timestamp: number) => {
	if (!isNumber(timestamp)) {
		throw new TypeError('timestamp must be a number.'); // It can be non-finite, that's fine
	}
};

export class PacketReader<T extends InputTrack = InputTrack> {
	track: T;

	constructor(track: T) {
		if (!(track instanceof InputTrack)) {
			throw new TypeError('track must be an InputTrack.');
		}
		this.track = track;
	}

	private _maybeVerifyPacketType(
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

	getFirst(options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getFirstPacket(result, options);

		if (result.pending) {
			return promise.then(() => this._maybeVerifyPacketType(result.value, options));
		} else {
			return this._maybeVerifyPacketType(result.value, options);
		}
	}

	getAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getPacket(result, timestamp, options);

		if (result.pending) {
			return promise.then(() => this._maybeVerifyPacketType(result.value, options));
		} else {
			return this._maybeVerifyPacketType(result.value, options);
		}
	}

	getKeyAt(timestamp: number, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		validateTimestamp(timestamp);
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		if (options.verifyKeyPackets) {
			return this._readKeyAtVerified(timestamp, options);
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getKeyPacket(result, timestamp, options);

		if (result.pending) {
			return promise.then(() => result.value);
		} else {
			return result.value;
		}
	}

	private async _readKeyAtVerified(
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
			return this._readKeyAtVerified(packet.timestamp - 1 / this.track.timeResolution, options);
		}

		return packet;
	}

	getNext(from: EncodedPacket, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
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
			return promise.then(() => this._maybeVerifyPacketType(result.value, options));
		} else {
			return this._maybeVerifyPacketType(result.value, options);
		}
	}

	getNextKey(from: EncodedPacket, options: PacketRetrievalOptions = {}): MaybePromise<EncodedPacket | null> {
		if (!(from instanceof EncodedPacket)) {
			throw new TypeError('from must be an EncodedPacket.');
		}
		validatePacketRetrievalOptions(options);

		if (this.track.input._disposed) {
			throw new InputDisposedError();
		}

		if (options.verifyKeyPackets) {
			return this._getNextKeyVerified(from, options);
		}

		const result = new ResultValue<EncodedPacket | null>();
		const promise = this.track._backing.getNextKeyPacket(result, from, options);

		if (result.pending) {
			return promise.then(() => result.value);
		} else {
			return result.value;
		}
	}

	private async _getNextKeyVerified(
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
			return this._getNextKeyVerified(nextPacket, options);
		}

		return nextPacket;
	}
}
