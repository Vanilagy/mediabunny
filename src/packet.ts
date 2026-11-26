/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	ExtendedAudioDecoderConfig,
	ExtendedVideoDecoderConfig,
	validateExtendedAudioDecoderConfig,
	validateExtendedVideoDecoderConfig,
} from './decode';
import { DeepReadonly, SECOND_TO_MICROSECOND_FACTOR } from './misc';

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
 * The fields used to create an {@link EncodedPacket}.
 * @group Packets
 * @public
 */
export type EncodedPacketInit = {
	/**
	 * The encoded data of the packet. For any given codec, this data must adhere to the format specified in the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview).
	 */
	data: Uint8Array;
	/** The type of the packet. */
	type: PacketType;
	/**
	 * The presentation timestamp of the packet in seconds. May be negative. Samples with negative end timestamps
	 * should not be presented.
	 */
	timestamp: number;
	/** The duration of the packet in seconds. */
	duration: number;
	/** The sequence number of the packet. Defaults to -1, meaning undefined. */
	sequenceNumber?: number;
	/** The actual byte length of the packet's data. Defaults to the byte length of `data`. */
	byteLength?: number;
	/** Additional data carried with the packet. */
	sideData?: EncodedPacketSideData;
	/** The configuration needed to decode the packet. */
	decoderConfig?: DeepReadonly<ExtendedVideoDecoderConfig | ExtendedAudioDecoderConfig>;
};

// Packets of a track typically share one config object, so each config only needs to be validated once
const validatedDecoderConfigs = new WeakSet<object>();

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
	 * The encoded data of this packet. For any given codec, this data must adhere to the format specified in the
	 * [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview).
	 */
	readonly data: Uint8Array;
	/** The type of this packet. */
	readonly type: PacketType;
	/**
	 * The presentation timestamp of this packet in seconds. May be negative. Samples with negative end timestamps
	 * should not be presented.
	 */
	readonly timestamp: number;
	/** The duration of this packet in seconds. */
	readonly duration: number;
	/**
	 * The sequence number indicates the decode order of the packets. Packet A  must be decoded before packet B if A
	 * has a lower sequence number than B. If two packets have the same sequence number, they are the same packet.
	 * Otherwise, sequence numbers are arbitrary and are not guaranteed to have any meaning besides their relative
	 * ordering. Negative sequence numbers mean the sequence number is undefined.
	 */
	readonly sequenceNumber: number;
	/**
	 * The actual byte length of the data in this packet. This field is useful for metadata-only packets where the
	 * `data` field contains no bytes.
	 */
	readonly byteLength: number;
	/** Additional data carried with this packet. */
	readonly sideData: EncodedPacketSideData;
	/**
	 * The configuration needed to decode this packet. `null` means the packet carries no information on how to decode
	 * it, in which case the configuration of the packets before it applies.
	 */
	readonly decoderConfig: DeepReadonly<ExtendedVideoDecoderConfig | ExtendedAudioDecoderConfig> | null;

	/** Creates a new {@link EncodedPacket} from an {@link EncodedPacketInit}. */
	constructor(init: EncodedPacketInit);
	/**
	 * Creates a new {@link EncodedPacket} from raw bytes and timing information.
	 * @deprecated Use the constructor taking an {@link EncodedPacketInit} instead.
	 */
	constructor(
		data: Uint8Array,
		type: PacketType,
		timestamp: number,
		duration: number,
		sequenceNumber?: number,
		byteLength?: number,
		sideData?: EncodedPacketSideData,
	);
	constructor(
		dataOrInit: Uint8Array | EncodedPacketInit,
		type?: PacketType,
		timestamp?: number,
		duration?: number,
		sequenceNumber?: number,
		byteLength?: number,
		sideData?: EncodedPacketSideData,
	) {
		let init: EncodedPacketInit;
		if (dataOrInit instanceof Uint8Array) {
			init = {
				data: dataOrInit,
				type: type!,
				timestamp: timestamp!,
				duration: duration!,
				sequenceNumber,
				byteLength,
				sideData,
			};
		} else {
			if (!dataOrInit || typeof dataOrInit !== 'object') {
				throw new TypeError('init must be an object.');
			}

			init = dataOrInit;
		}

		if (init.data === PLACEHOLDER_DATA && init.byteLength === undefined) {
			throw new Error(
				'Internal error: byteLength must be explicitly provided when constructing metadata-only packets.',
			);
		}

		if (!(init.data instanceof Uint8Array)) {
			throw new TypeError('data must be a Uint8Array.');
		}
		if (init.type !== 'key' && init.type !== 'delta') {
			throw new TypeError('type must be either "key" or "delta".');
		}
		if (!Number.isFinite(init.timestamp)) {
			throw new TypeError('timestamp must be a number.');
		}
		if (!Number.isFinite(init.duration) || init.duration < 0) {
			throw new TypeError('duration must be a non-negative number.');
		}
		if (init.sequenceNumber !== undefined && !Number.isFinite(init.sequenceNumber)) {
			throw new TypeError('sequenceNumber must be a number.');
		}
		if (init.byteLength !== undefined && (!Number.isInteger(init.byteLength) || init.byteLength < 0)) {
			throw new TypeError('byteLength must be a non-negative integer.');
		}
		if (init.sideData !== undefined && (typeof init.sideData !== 'object' || !init.sideData)) {
			throw new TypeError('sideData, when provided, must be an object.');
		}
		if (init.sideData?.alpha !== undefined && !(init.sideData.alpha instanceof Uint8Array)) {
			throw new TypeError('sideData.alpha, when provided, must be a Uint8Array.');
		}
		if (
			init.sideData?.alphaByteLength !== undefined
			&& (!Number.isInteger(init.sideData.alphaByteLength) || init.sideData.alphaByteLength < 0)
		) {
			throw new TypeError('sideData.alphaByteLength, when provided, must be a non-negative integer.');
		}

		const decoderConfig = init.decoderConfig ?? null;
		if (decoderConfig !== null && !validatedDecoderConfigs.has(decoderConfig)) {
			if (typeof decoderConfig !== 'object') {
				throw new TypeError('decoderConfig, when provided, must be an object.');
			}

			if (decoderConfig.type === 'video') {
				validateExtendedVideoDecoderConfig(decoderConfig, 'decoderConfig');
			} else if (decoderConfig.type === 'audio') {
				validateExtendedAudioDecoderConfig(decoderConfig, 'decoderConfig');
			} else {
				throw new TypeError('decoderConfig.type must be \'video\' or \'audio\'.');
			}

			validatedDecoderConfigs.add(decoderConfig);
		}

		this.data = init.data;
		this.type = init.type;
		this.timestamp = init.timestamp;
		this.duration = init.duration;
		this.sequenceNumber = init.sequenceNumber ?? -1;
		this.byteLength = init.byteLength ?? init.data.byteLength;
		this.sideData = init.sideData ?? {};
		this.decoderConfig = decoderConfig;

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
	 * for converting chunks from the WebCodecs API to `EncodedPacket` instances. The decoder config contained in
	 * `meta`, if any, becomes the packet's decoder config.
	 */
	static fromEncodedChunk(
		chunk: EncodedVideoChunk | EncodedAudioChunk,
		sideData?: EncodedPacketSideData,
		meta?: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata,
	): EncodedPacket {
		if (!(chunk instanceof EncodedVideoChunk || chunk instanceof EncodedAudioChunk)) {
			throw new TypeError('chunk must be an EncodedVideoChunk or EncodedAudioChunk.');
		}
		if (meta !== undefined && (!meta || typeof meta !== 'object')) {
			throw new TypeError('meta, when provided, must be an object.');
		}

		let decoderConfig: ExtendedVideoDecoderConfig | ExtendedAudioDecoderConfig | undefined;
		if (meta?.decoderConfig) {
			if (chunk instanceof EncodedVideoChunk) {
				decoderConfig = {
					...meta.decoderConfig as VideoDecoderConfig,
					type: 'video',
				};
			} else {
				decoderConfig = {
					...meta.decoderConfig as AudioDecoderConfig,
					type: 'audio',
				};
			}
		}

		const data = new Uint8Array(chunk.byteLength);
		chunk.copyTo(data);

		return new EncodedPacket({
			data,
			type: chunk.type as PacketType,
			timestamp: chunk.timestamp / 1e6,
			duration: (chunk.duration ?? 0) / 1e6,
			sideData,
			decoderConfig,
		});
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
		/** The decoder config of the cloned packet. */
		decoderConfig?: DeepReadonly<ExtendedVideoDecoderConfig | ExtendedAudioDecoderConfig> | null;
	}): EncodedPacket {
		if (options !== undefined && (typeof options !== 'object' || options === null)) {
			throw new TypeError('options, when provided, must be an object.');
		}

		return new EncodedPacket({
			data: options?.data ?? this.data,
			type: options?.type ?? this.type,
			timestamp: options?.timestamp ?? this.timestamp,
			duration: options?.duration ?? this.duration,
			sequenceNumber: options?.sequenceNumber ?? this.sequenceNumber,
			byteLength: options?.data?.byteLength ?? this.byteLength,
			sideData: options?.sideData ?? this.sideData,
			decoderConfig: (options?.decoderConfig !== undefined ? options.decoderConfig : this.decoderConfig)
				?? undefined,
		});
	}
}
