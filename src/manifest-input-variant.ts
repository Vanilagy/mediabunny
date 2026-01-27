/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, MediaCodec, VideoCodec } from './codec';
import { Demuxer } from './demuxer';
import { Input } from './input';
import { VirtualInputFormat } from './input-format';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from './input-track';
import { ManifestInput } from './manifest-input';
import { ManifestInputSegment } from './manifest-input-segment';
import { PacketRetrievalOptions } from './media-sink';
import { MetadataTags, TrackDisposition } from './metadata';
import { arrayArgmin, arrayCount, assert, Rotation } from './misc';
import { EncodedPacket } from './packet';
import { NullSource } from './source';

export type ManifestInputVariantMetadata = {
	name: string | null;
	bitrate: number | null; // doc block: this refers to the _peak_ bitrate
	averageBitrate: number | null;
	codecs: MediaCodec[];
	codecStrings: string[];
	resolution: { width: number; height: number } | null;
	frameRate: number | null;
	isKeyFrameOnly: boolean;
};

export abstract class ManifestInputVariant {
	readonly input: ManifestInput;
	readonly path: string;

	/** @internal */
	constructor(input: ManifestInput, path: string) {
		this.input = input;
		this.path = path;
	}

	abstract get metadata(): ManifestInputVariantMetadata;
	abstract get groupId(): string | null;
	abstract get associatedGroupId(): string | null;

	abstract getFirstSegment(): Promise<ManifestInputSegment | null>;
	abstract getSegmentAt(timestamp: number): Promise<ManifestInputSegment | null>;
	abstract getNextSegment(segment: ManifestInputSegment): Promise<ManifestInputSegment | null>;
	abstract getPreviousSegment(segment: ManifestInputSegment): Promise<ManifestInputSegment | null>;

	async* segments(startTimestamp?: number) {
		let currentSegment: ManifestInputSegment | null;

		if (startTimestamp !== undefined) {
			currentSegment = await this.getSegmentAt(startTimestamp);
		} else {
			currentSegment = await this.getFirstSegment();
		}

		while (currentSegment !== null) {
			yield currentSegment;
			currentSegment = await this.getNextSegment(currentSegment);
		}
	}

	toInput() {
		return new Input({
			source: new NullSource(),
			formats: [new VirtualInputFormat(input => new ManifestInputVariantDemuxer(input, this))],
		});
	}
}

class ManifestInputVariantDemuxer extends Demuxer {
	variant: ManifestInputVariant;
	tracksPromise: Promise<InputTrack[]> | null = null;
	firstSegment: ManifestInputSegment | null = null;

	nextInputCacheAge = 0;
	inputCache: {
		segment: ManifestInputSegment;
		inputPromise: Promise<Input>; // We store the promise so it's immediately available in the cache
		age: number;
	}[] = [];

	initSegmentFirstTimestamps = new WeakMap<ManifestInputSegment, number>();

	constructor(input: Input, variant: ManifestInputVariant) {
		super(input);

		this.variant = variant;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {}; // todo?
	}

	async getMimeType(): Promise<string> {
		return ''; // todo?
	}

	async getTracks(): Promise<InputTrack[]> {
		return this.tracksPromise ??= (async () => {
			this.firstSegment = await this.variant.getFirstSegment();
			if (!this.firstSegment) {
				return [];
			}

			const input = await this.retrieveInputForSegment(this.firstSegment);
			const inputTracks = await input.getTracks();

			const tracks: InputTrack[] = [];
			for (const track of inputTracks) {
				if (track.type === 'video') {
					const number = arrayCount(tracks, x => x.type === 'video') + 1;

					tracks.push(new InputVideoTrack(
						this.input,
						new ManifestInputVariantInputVideoTrackBacking(track, this, number),
					));
				} else if (track.type === 'audio') {
					const number = arrayCount(tracks, x => x.type === 'audio') + 1;

					tracks.push(new InputAudioTrack(
						this.input,
						new ManifestInputVariantInputAudioTrackBacking(track, this, number),
					));
				}
			}

			return tracks;
		})();
	}

	retrieveInputForSegment(segment: ManifestInputSegment) {
		const cacheEntry = this.inputCache.find(x => x.segment === segment);
		if (cacheEntry) {
			cacheEntry.age = this.nextInputCacheAge++;
			return cacheEntry.inputPromise;
		}

		const promise = segment.toInput();
		this.inputCache.push({
			segment,
			inputPromise: promise,
			age: this.nextInputCacheAge++,
		});

		const MAX_INPUT_CACHE_SIZE = 4;
		if (this.inputCache.length > MAX_INPUT_CACHE_SIZE) {
			const minAgeIndex = arrayArgmin(this.inputCache, x => x.age);
			this.inputCache.splice(minAgeIndex, 1);
		}

		return promise;
	}

	async getMediaOffset(segment: ManifestInputSegment, input: Input) {
		const initSegment = segment.initSegment ?? segment;

		let initSegmentFirstTimestamp: number;
		if (this.initSegmentFirstTimestamps.has(initSegment)) {
			initSegmentFirstTimestamp = this.initSegmentFirstTimestamps.get(initSegment)!;
		} else {
			const initInput = await this.retrieveInputForSegment(initSegment);
			initSegmentFirstTimestamp = await initInput.getFirstTimestamp();
			this.initSegmentFirstTimestamps.set(initSegment, initSegmentFirstTimestamp);
		}

		let mediaOffset = 0;
		mediaOffset -= initSegmentFirstTimestamp; // Make the timestamps relative to the init segment first timestamp
		mediaOffset += initSegment.relativeTimestamp; // And then offset them by init segment's relative timestamp

		if (segment !== initSegment) {
			const segmentFirstTimestamp = await input.getFirstTimestamp();
			if (segmentFirstTimestamp === initSegmentFirstTimestamp) {
				// Normally, we expect segments (belonging to the same init segment / discontinuity) to have the same
				// timestamp "base", meaning timestamps tick up across segments and don't reset. However, some
				// containers don't have absolute timestamps and always start at 0 (like ADTS or MP3) or those that do
				// always start at the same timestamp, we still want to produce sensible results. So, we detect that by
				// checking if the internal timestamp hasn't risen faster than the segment durations would dictate. And
				// if so, we offset.
				const timeSinceInitSegment = segment.relativeTimestamp - initSegment.relativeTimestamp;
				mediaOffset += timeSinceInitSegment;
			}
		}

		return mediaOffset;
	}
}

type PacketInfo = {
	segment: ManifestInputSegment;
	track: InputTrack;
	sourcePacket: EncodedPacket;
};

class ManifestInputVariantInputTrackBacking implements InputTrackBacking {
	firstInputTrack: InputTrack;
	demuxer: ManifestInputVariantDemuxer;
	packetInfos = new WeakMap<EncodedPacket, PacketInfo>();
	number: number;

	constructor(firstInputTrack: InputTrack, demuxer: ManifestInputVariantDemuxer, number: number) {
		this.firstInputTrack = firstInputTrack;
		this.demuxer = demuxer;
		this.number = number;
	}

	getId(): number {
		return this.firstInputTrack._backing.getId();
	}

	getNumber(): number {
		return this.number;
	}

	getCodec(): MediaCodec | null {
		return this.firstInputTrack._backing.getCodec();
	}

	getInternalCodecId(): string | number | Uint8Array | null {
		return this.firstInputTrack._backing.getInternalCodecId();
	}

	getDisposition(): TrackDisposition {
		return this.firstInputTrack._backing.getDisposition();
	}

	getLanguageCode(): string {
		return this.firstInputTrack._backing.getLanguageCode();
	}

	getName(): string | null {
		return this.firstInputTrack._backing.getName();
	}

	getTimeResolution(): number {
		return this.firstInputTrack._backing.getTimeResolution();
	}

	getVariant(): ManifestInputVariant | null {
		return this.demuxer.variant;
	}

	async createAdjustedPacket(packet: EncodedPacket, segment: ManifestInputSegment, track: InputTrack) {
		const mediaOffset = await this.demuxer.getMediaOffset(segment, track.input);

		const modified = packet.clone({
			timestamp: packet.timestamp + mediaOffset,
			// The 1e8 assumes a max of 100 MB per second, highly unlikely to be hit, so this should guarantee
			// monotonically increasing sequence numbers across segments.
			sequenceNumber: Math.floor(1e8 * segment.relativeTimestamp) + packet.sequenceNumber,
		});

		this.packetInfos.set(modified, {
			segment,
			track,
			sourcePacket: packet,
		});

		return modified;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		assert(this.demuxer.firstSegment);

		const packet = await this.firstInputTrack._backing.getFirstPacket(options);
		if (!packet) {
			return null;
		}

		return this.createAdjustedPacket(packet, this.demuxer.firstSegment, this.firstInputTrack);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getNextInternal(packet, options, false);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getNextInternal(packet, options, true);
	}

	async _getNextInternal(
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): Promise<EncodedPacket | null> {
		const info = this.packetInfos.get(packet);
		if (!info) {
			throw new Error('Packet was not created from this track.');
		}

		// console.log(info.segment.path);

		const nextPacket = keyframesOnly
			? await info.track._backing.getNextKeyPacket(info.sourcePacket, options)
			: await info.track._backing.getNextPacket(info.sourcePacket, options);
		if (nextPacket) {
			return this.createAdjustedPacket(nextPacket, info.segment, info.track);
		}

		let currentSegment: ManifestInputSegment | null = info.segment;
		while (true) {
			const nextSegment = await this.demuxer.variant.getNextSegment(currentSegment);
			if (!nextSegment) {
				return null;
			}

			const nextInput = await this.demuxer.retrieveInputForSegment(nextSegment);
			const nextTracks = await nextInput.getTracks();
			const nextTrack = nextTracks.find(t => t.type === info.track.type && t.number === info.track.number);

			if (!nextTrack) {
				currentSegment = nextSegment;
				continue;
			}

			const firstPacket = await nextTrack._backing.getFirstPacket(options);
			if (!firstPacket) {
				return null;
			}

			return this.createAdjustedPacket(firstPacket, nextSegment, nextTrack);
		}
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getPacketInternal(timestamp, options, false);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this._getPacketInternal(timestamp, options, true);
	}

	async _getPacketInternal(
		timestamp: number,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): Promise<EncodedPacket | null> {
		let currentSegment = await this.demuxer.variant.getSegmentAt(timestamp);
		if (!currentSegment) {
			return null;
		}

		while (currentSegment) {
			const input = await this.demuxer.retrieveInputForSegment(currentSegment);
			const tracks = await input.getTracks();
			const track = tracks.find(t => (
				t.type === this.firstInputTrack.type && t.number === this.firstInputTrack.number
			));

			if (!track) {
				// Search the previous segment
				currentSegment = await this.demuxer.variant.getPreviousSegment(currentSegment);
				continue;
			}

			const mediaOffset = await this.demuxer.getMediaOffset(currentSegment, input);

			const offsetTimestamp = timestamp - mediaOffset;
			const packet = keyframesOnly
				? await track._backing.getKeyPacket(offsetTimestamp, options)
				: await track._backing.getPacket(offsetTimestamp, options);

			if (!packet) {
				// Search the previous segment
				currentSegment = await this.demuxer.variant.getPreviousSegment(currentSegment);
				continue;
			}

			return this.createAdjustedPacket(packet, currentSegment, track);
		}

		return null;
	}
}

class ManifestInputVariantInputVideoTrackBacking
	extends ManifestInputVariantInputTrackBacking
	implements InputVideoTrackBacking {
	override firstInputTrack!: InputVideoTrack;

	override getCodec(): VideoCodec | null {
		return this.firstInputTrack._backing.getCodec();
	}

	getCodedWidth(): number {
		return this.firstInputTrack._backing.getCodedWidth();
	}

	getCodedHeight(): number {
		return this.firstInputTrack._backing.getCodedHeight();
	}

	getRotation(): Rotation {
		return this.firstInputTrack._backing.getRotation();
	}

	getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.firstInputTrack._backing.getColorSpace();
	}

	canBeTransparent(): Promise<boolean> {
		return this.firstInputTrack._backing.canBeTransparent();
	}

	getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.firstInputTrack._backing.getDecoderConfig();
	}
}

class ManifestInputVariantInputAudioTrackBacking
	extends ManifestInputVariantInputTrackBacking
	implements InputAudioTrackBacking {
	override firstInputTrack!: InputAudioTrack;

	override getCodec(): AudioCodec | null {
		return this.firstInputTrack._backing.getCodec();
	}

	getNumberOfChannels(): number {
		return this.firstInputTrack._backing.getNumberOfChannels();
	}

	getSampleRate(): number {
		return this.firstInputTrack._backing.getSampleRate();
	}

	getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return this.firstInputTrack._backing.getDecoderConfig();
	}
}
