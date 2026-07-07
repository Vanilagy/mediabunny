/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from './output';
import { MediaCodec } from './codec';
import { DurationMetadataRequestOptions } from './demuxer';
import { Input } from './input';
import {
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
} from './input-track';
import { arrayCount, assert, MaybePromise, MaybeRelevantPromise, ResultValue, roundToDivisor } from './misc';
import { EncodedPacket, PacketRetrievalOptions } from './packet';

export type SegmentedInputMetadata = {
	name: string | null;
	bitrate: number | null; // doc block: this refers to the _peak_ bitrate
	averageBitrate: number | null;
	codecs: MediaCodec[];
	codecStrings: string[];
	resolution: { width: number; height: number } | null;
	frameRate: number | null;
	isKeyFrameOnly: boolean;
};

export type AssociatedGroup = {
	id: string;
	type: 'video' | 'audio' | 'subtitles' | 'closed-captions';
};

export type Segment = {
	timestamp: number;
	duration: number;
	/**
	 * The Unix time (in seconds) corresponding to this segment's start timestamp, or null if unknown. This is computed
	 * whenever the source provides wall-clock information (e.g. HLS program date time), even if the segment timestamps
	 * themselves are not shifted into Unix time space.
	 */
	unixEpochTimestamp: number | null;
	firstSegment: Segment | null;
};

export type SegmentRetrievalOptions = {
	skipLiveWait?: boolean;
};

export type SegmentedInputTrackDeclaration = {
	id: number;
	type: TrackType;
};

export abstract class SegmentedInput {
	input: Input;
	path: string;
	trackDeclarations: SegmentedInputTrackDeclaration[] | null;

	nextInputCacheAge = 0;
	inputCache: {
		segment: Segment;
		input: Input;
		age: number;
	}[] = [];

	trackBackingsPromise: Promise<InputTrackBacking[]> | null = null;
	firstSegment: Segment | null = null;
	firstSegmentFirstTimestamps = new WeakMap<Segment, number>();

	firstTimestampCache = new WeakMap<Input, number>();

	constructor(input: Input, path: string, trackDeclarations: SegmentedInputTrackDeclaration[] | null) {
		this.input = input;
		this.path = path;
		this.trackDeclarations = trackDeclarations;
	}

	abstract getFirstSegment(options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getSegmentAt(timestamp: number, options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getNextSegment(segment: Segment, options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getPreviousSegment(segment: Segment, options: SegmentRetrievalOptions): Promise<Segment | null>;
	abstract getInputForSegment(segment: Segment): Input;

	abstract getLiveRefreshInterval(): Promise<number | null>;

	async getDurationFromMetadata(options: DurationMetadataRequestOptions) {
		const lastSegment = await this.getSegmentAt(Infinity, {
			skipLiveWait: options.skipLiveWait,
		});
		if (!lastSegment) {
			return null;
		}

		return lastSegment.timestamp + lastSegment.duration;
	}

	async getUnixTimeForTimestamp(timestamp: number): Promise<number | null> {
		let segment = await this.getSegmentAt(timestamp, {});
		segment ??= await this.getFirstSegment({});

		if (!segment || segment.unixEpochTimestamp === null) {
			return null;
		}

		const elapsed = timestamp - segment.timestamp;
		return segment.unixEpochTimestamp + elapsed;
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		return this.trackBackingsPromise ??= (async () => {
			const backings: InputTrackBacking[] = [];

			if (this.trackDeclarations) {
				for (const decl of this.trackDeclarations) {
					if (decl.type === 'video') {
						const number = arrayCount(backings, x => x.getType() === 'video') + 1;

						backings.push(
							new SegmentedInputInputVideoTrackBacking(this, decl, number),
						);
					} else if (decl.type === 'audio') {
						const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

						backings.push(
							new SegmentedInputInputAudioTrackBacking(this, decl, number),
						);
					}
				}
			} else {
				// There are no declarations, we must determine the tracks from the first segment
				this.firstSegment = await this.getFirstSegment({});
				if (!this.firstSegment) {
					return [];
				}

				const input = this.getInputForSegment(this.firstSegment);
				const inputTracks = await input.getTracks();

				for (const track of inputTracks) {
					if (track.type === 'video') {
						const number = arrayCount(backings, x => x.getType() === 'video') + 1;

						backings.push(
							new SegmentedInputInputVideoTrackBacking(this, {
								id: backings.length + 1,
								type: 'video',
							}, number),
						);
					} else if (track.type === 'audio') {
						const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

						backings.push(
							new SegmentedInputInputAudioTrackBacking(this, {
								id: backings.length + 1,
								type: 'audio',
							}, number),
						);
					}
				}
			}

			return backings;
		})();
	}

	// This operation is done a lot and can be semi-expensive, so it's good to have a cache for it
	async getFirstTimestampForInput(input: Input) {
		const existing = this.firstTimestampCache.get(input);
		if (existing !== undefined) {
			return existing;
		}

		const firstTimestamp = await input.getFirstTimestamp();
		this.firstTimestampCache.set(input, firstTimestamp);

		return firstTimestamp;
	}

	async getMediaOffset(segment: Segment, input: Input) {
		const firstSegment = segment.firstSegment ?? segment;

		let firstSegmentFirstTimestamp: number;
		if (this.firstSegmentFirstTimestamps.has(firstSegment)) {
			firstSegmentFirstTimestamp = this.firstSegmentFirstTimestamps.get(firstSegment)!;
		} else {
			const firstInput = this.getInputForSegment(firstSegment);
			firstSegmentFirstTimestamp = await this.getFirstTimestampForInput(firstInput);
			this.firstSegmentFirstTimestamps.set(firstSegment, firstSegmentFirstTimestamp);
		}

		if (firstSegment === segment) {
			return firstSegment.timestamp - firstSegmentFirstTimestamp;
		}

		const segmentFirstTimestamp = await this.getFirstTimestampForInput(input);
		const segmentElapsed = segment.timestamp - firstSegment.timestamp;
		const inputElapsed = segmentFirstTimestamp - firstSegmentFirstTimestamp;
		const difference = inputElapsed - segmentElapsed;

		if (Math.abs(difference) <= Math.min(0.25, segmentElapsed)) { // Heuristic
			// We're close enough
			return firstSegment.timestamp - firstSegmentFirstTimestamp;
		} else {
			// Ideally, each segment has absolute timestamps that are relative to some outside clock which is
			// consistent across segments. This is often the case, but not always. Either the container format used is
			// not timestamped at all (like ADTS), or the segments are just fucky. In this case, use the segment's
			// relative timestamp to determine where we are, and completely offset out the segment's input start
			// timestamp.
			return segment.timestamp - segmentFirstTimestamp;
		}
	}

	dispose() {
		for (const entry of this.inputCache) {
			entry.input.dispose();
		}
		this.inputCache.length = 0;
	}
}

type PacketInfo = {
	segment: Segment;
	track: InputTrack;
	sourcePacket: EncodedPacket;
};

class SegmentedInputInputTrackBacking implements InputTrackBacking {
	segmentedInput: SegmentedInput;
	decl: SegmentedInputTrackDeclaration;
	number: number;
	packetInfos = new WeakMap<EncodedPacket, PacketInfo>();

	hydrationPromise: Promise<void> | null = null;
	firstInputTrack: InputTrack | null = null;

	constructor(segmentedInput: SegmentedInput, decl: SegmentedInputTrackDeclaration, number: number) {
		this.segmentedInput = segmentedInput;
		this.decl = decl;
		this.number = number;
	}

	hydrate() {
		return this.hydrationPromise ??= (async () => {
			this.segmentedInput.firstSegment ??= await this.segmentedInput.getFirstSegment({});
			if (!this.segmentedInput.firstSegment) {
				throw new Error('Missing first segment, can\'t retrieve track.');
			}

			const input = this.segmentedInput.getInputForSegment(this.segmentedInput.firstSegment);
			const inputTracks = await input.getTracks();

			const track = inputTracks.find(x => x.type === this.decl.type && x.number === this.number);
			if (!track) {
				throw new Error('No matching track found in underlying media data.');
			}

			this.firstInputTrack = track;
		})();
	}

	getId(): number {
		return this.decl.id;
	}

	getType(): TrackType {
		return this.decl.type;
	}

	getNumber(): number {
		return this.number;
	}

	/** If the backing track is already present, delegate synchronously; otherwise, hydrate first. */
	delegate<T>(fn: () => MaybePromise<T>): MaybePromise<T> {
		if (this.firstInputTrack) {
			return fn();
		}

		return this.hydrate().then(fn);
	}

	async getDecoderConfig() {
		return this.delegate(() => this.firstInputTrack!._backing.getDecoderConfig());
	}

	getHasOnlyKeyPackets() {
		return this.delegate(() => this.firstInputTrack!._backing.getHasOnlyKeyPackets?.() ?? null);
	}

	getPairingMask() {
		return 1n;
	}

	getCodec() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodec());
	}

	getInternalCodecId() {
		return this.delegate(() => this.firstInputTrack!._backing.getInternalCodecId());
	}

	getDisposition() {
		return this.delegate(() => this.firstInputTrack!._backing.getDisposition());
	}

	getLanguageCode() {
		return this.delegate(() => this.firstInputTrack!._backing.getLanguageCode());
	}

	getName() {
		return this.delegate(() => this.firstInputTrack!._backing.getName());
	}

	getTimeResolution() {
		return this.delegate(() => this.firstInputTrack!._backing.getTimeResolution());
	}

	async isRelativeToUnixEpoch() {
		await this.hydrate();

		assert(this.segmentedInput.firstSegment);
		return this.segmentedInput.firstSegment.unixEpochTimestamp === this.segmentedInput.firstSegment.timestamp;
	}

	getUnixTimeForTimestamp(timestamp: number) {
		return this.segmentedInput.getUnixTimeForTimestamp(timestamp);
	}

	getBitrate() {
		return this.delegate(() => this.firstInputTrack!._backing.getBitrate());
	}

	getAverageBitrate() {
		return this.delegate(() => this.firstInputTrack!._backing.getAverageBitrate());
	}

	getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		return this.segmentedInput.getDurationFromMetadata(options);
	}

	getLiveRefreshInterval(): Promise<number | null> {
		return this.segmentedInput.getLiveRefreshInterval();
	}

	async createAdjustedPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		segment: Segment,
		track: InputTrack,
	): MaybeRelevantPromise {
		assert(packet.sequenceNumber >= 0);
		assert(this.segmentedInput.firstSegment);

		const mediaOffset = await this.segmentedInput.getMediaOffset(segment, track.input);
		// If we didn't do this then sequence numbers would exceed Number.MAX_SAFE_INTEGER for Unix-timestamped segments
		const segmentTimestampRelativeToFirst = segment.timestamp - this.segmentedInput.firstSegment.timestamp;

		const modified = packet.clone({
			timestamp: roundToDivisor(
				packet.timestamp + mediaOffset,
				await track.getTimeResolution(),
			),
			// The 1e8 assumes a max of 100 MB per second, highly unlikely to be hit, so this should guarantee
			// monotonically increasing sequence numbers across segments.
			sequenceNumber: Math.floor(1e8 * segmentTimestampRelativeToFirst) + packet.sequenceNumber,
		});

		this.packetInfos.set(modified, {
			segment,
			track,
			sourcePacket: packet,
		});

		return res.set(modified);
	}

	async getFirstPacket(
		res: ResultValue<EncodedPacket | null>,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		await this.hydrate();

		assert(this.segmentedInput.firstSegment);
		assert(this.firstInputTrack);

		const firstPacketResult = new ResultValue<EncodedPacket | null>();

		const promise = this.firstInputTrack._backing.getFirstPacket(firstPacketResult, options);
		if (firstPacketResult.pending) await promise;
		const packet = firstPacketResult.value;

		if (!packet) {
			return res.set(null);
		}

		return this.createAdjustedPacket(res, packet, this.segmentedInput.firstSegment, this.firstInputTrack);
	}

	getNextPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getNextInternal(res, packet, options, false);
	}

	getNextKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getNextInternal(res, packet, options, true);
	}

	async _getNextInternal(
		res: ResultValue<EncodedPacket | null>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): MaybeRelevantPromise {
		const info = this.packetInfos.get(packet);
		if (!info) {
			throw new Error('Packet was not created from this track.');
		}

		const packetResult = new ResultValue<EncodedPacket | null>();

		const promise = keyframesOnly
			? info.track._backing.getNextKeyPacket(packetResult, info.sourcePacket, options)
			: info.track._backing.getNextPacket(packetResult, info.sourcePacket, options);
		if (packetResult.pending) await promise;
		const nextPacket = packetResult.value;

		if (nextPacket) {
			return this.createAdjustedPacket(res, nextPacket, info.segment, info.track);
		}

		let currentSegment: Segment | null = info.segment;
		while (true) {
			const nextSegment = await this.segmentedInput.getNextSegment(currentSegment, {
				skipLiveWait: options.skipLiveWait,
			});
			if (!nextSegment) {
				return res.set(null);
			}

			const nextInput = this.segmentedInput.getInputForSegment(nextSegment);
			const nextTracks = await nextInput.getTracks();
			const nextTrack = nextTracks.find(t => t.type === info.track.type && t.number === info.track.number);

			if (!nextTrack) {
				currentSegment = nextSegment;
				continue;
			}

			packetResult.reset();
			const promise = nextTrack._backing.getFirstPacket(packetResult, options);
			if (packetResult.pending) await promise;
			const firstPacket = packetResult.value;

			if (!firstPacket) {
				return res.set(null);
			}

			return this.createAdjustedPacket(res, firstPacket, nextSegment, nextTrack);
		}
	}

	getPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getPacketInternal(res, timestamp, options, false);
	}

	getKeyPacket(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this._getPacketInternal(res, timestamp, options, true);
	}

	async _getPacketInternal(
		res: ResultValue<EncodedPacket | null>,
		timestamp: number,
		options: PacketRetrievalOptions,
		keyframesOnly: boolean,
	): MaybeRelevantPromise {
		let currentSegment = await this.segmentedInput.getSegmentAt(timestamp, {
			skipLiveWait: options.skipLiveWait,
		});
		if (!currentSegment) {
			return res.set(null);
		}

		await this.hydrate();

		const packetResult = new ResultValue<EncodedPacket | null>();

		while (currentSegment) {
			const input = this.segmentedInput.getInputForSegment(currentSegment);
			const tracks = await input.getTracks();
			const track = tracks.find(t => (
				t.type === this.firstInputTrack!.type && t.number === this.firstInputTrack!.number
			));

			if (!track) {
				// Search the previous segment
				currentSegment = await this.segmentedInput.getPreviousSegment(currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				continue;
			}

			const mediaOffset = await this.segmentedInput.getMediaOffset(currentSegment, input);
			const offsetTimestamp = timestamp - mediaOffset;

			packetResult.reset();
			const promise = keyframesOnly
				? track._backing.getKeyPacket(packetResult, offsetTimestamp, options)
				: track._backing.getPacket(packetResult, offsetTimestamp, options);
			if (packetResult.pending) await promise;
			const packet = packetResult.value;

			if (!packet) {
				// Search the previous segment
				currentSegment = await this.segmentedInput.getPreviousSegment(currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				continue;
			}

			return this.createAdjustedPacket(res, packet, currentSegment, track);
		}

		return res.set(null);
	}
}

class SegmentedInputInputVideoTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputVideoTrackBacking {
	override firstInputTrack!: InputVideoTrack | null;

	override getType() {
		return 'video' as const;
	}

	override getCodec() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodec());
	}

	getCodedWidth() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodedWidth());
	}

	getCodedHeight() {
		return this.delegate(() => this.firstInputTrack!._backing.getCodedHeight());
	}

	getSquarePixelWidth() {
		return this.delegate(() => this.firstInputTrack!._backing.getSquarePixelWidth());
	}

	getSquarePixelHeight() {
		return this.delegate(() => this.firstInputTrack!._backing.getSquarePixelHeight());
	}

	getRotation() {
		return this.delegate(() => this.firstInputTrack!._backing.getRotation());
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.delegate(() => this.firstInputTrack!._backing.getColorSpace());
	}

	async canBeTransparent(): Promise<boolean> {
		return this.delegate(() => this.firstInputTrack!._backing.canBeTransparent());
	}

	override async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.delegate(() => this.firstInputTrack!._backing.getDecoderConfig());
	}
}

class SegmentedInputInputAudioTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputAudioTrackBacking {
	override firstInputTrack!: InputAudioTrack;

	override getType() {
		return 'audio' as const;
	}

	override getCodec() {
		return this.delegate(() => this.firstInputTrack._backing.getCodec());
	}

	getNumberOfChannels() {
		return this.delegate(() => this.firstInputTrack._backing.getNumberOfChannels());
	}

	getSampleRate() {
		return this.delegate(() => this.firstInputTrack._backing.getSampleRate());
	}

	override async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return this.delegate(() => this.firstInputTrack._backing.getDecoderConfig());
	}
}
