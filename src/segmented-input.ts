/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrackType } from './output';
import { MediaCodec } from './codec';
import { Demuxer, DurationMetadataRequestOptions } from './demuxer';
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
import { PacketRetrievalOptions } from './media-sink';
import { MetadataTags } from './metadata';
import { arrayCount, assert, roundToDivisor } from './misc';
import { EncodedPacket } from './packet';
import { NullSource } from './source';

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
	relativeToUnixEpoch: boolean;
	firstSegment: Segment | null;
};

export type SegmentRetrievalOptions = {
	skipLiveWait?: boolean;
};

export abstract class SegmentedInput {
	input: Input;
	path: string;

	virtualInput: Input | null = null;
	nextInputCacheAge = 0;
	inputCache: {
		segment: Segment;
		input: Input;
		age: number;
	}[] = [];

	constructor(input: Input, path: string) {
		this.input = input;
		this.path = path;
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

	toInput() {
		return this.virtualInput ??= new Input({
			source: new NullSource(),
			formats: [new VirtualInputFormat(() => new SegmentedInputDemuxer(this.input, this))],
		});
	}

	dispose() {
		for (const entry of this.inputCache) {
			entry.input.dispose();
		}
		this.inputCache.length = 0;

		this.virtualInput?.dispose();
	}
}

class SegmentedInputDemuxer extends Demuxer {
	segmentedInput: SegmentedInput;
	trackBackingsPromise: Promise<InputTrackBacking[]> | null = null;
	firstSegment: Segment | null = null;
	firstSegmentFirstTimestamps = new WeakMap<Segment, number>();

	constructor(input: Input, segmentedInput: SegmentedInput) {
		super(input);

		this.segmentedInput = segmentedInput;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		throw new Error('Unreachable');
	}

	async getMimeType(): Promise<string> {
		throw new Error('Unreachable');
	}

	async getTrackBackings(): Promise<InputTrackBacking[]> {
		return this.trackBackingsPromise ??= (async () => {
			this.firstSegment = await this.segmentedInput.getFirstSegment({});
			if (!this.firstSegment) {
				return [];
			}

			const input = this.segmentedInput.getInputForSegment(this.firstSegment);
			const inputTracks = await input.getTracks();

			const backings: InputTrackBacking[] = [];
			for (const track of inputTracks) {
				if (track.type === 'video') {
					const number = arrayCount(backings, x => x.getType() === 'video') + 1;

					backings.push(
						new SegmentedInputInputVideoTrackBacking(track, this, number),
					);
				} else if (track.type === 'audio') {
					const number = arrayCount(backings, x => x.getType() === 'audio') + 1;

					backings.push(
						new SegmentedInputInputAudioTrackBacking(track, this, number),
					);
				}
			}

			return backings;
		})();
	}

	async getMediaOffset(segment: Segment, input: Input) {
		const firstSegment = segment.firstSegment ?? segment;

		let firstSegmentFirstTimestamp: number;
		if (this.firstSegmentFirstTimestamps.has(firstSegment)) {
			firstSegmentFirstTimestamp = this.firstSegmentFirstTimestamps.get(firstSegment)!;
		} else {
			const firstInput = this.segmentedInput.getInputForSegment(firstSegment);
			firstSegmentFirstTimestamp = await firstInput.getFirstTimestamp();
			this.firstSegmentFirstTimestamps.set(firstSegment, firstSegmentFirstTimestamp);
		}

		if (firstSegment === segment) {
			return firstSegment.timestamp - firstSegmentFirstTimestamp;
		}

		const segmentFirstTimestamp = await input.getFirstTimestamp();
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
}

type PacketInfo = {
	segment: Segment;
	track: InputTrack;
	sourcePacket: EncodedPacket;
};

class SegmentedInputInputTrackBacking implements InputTrackBacking {
	firstInputTrack: InputTrack;
	demuxer: SegmentedInputDemuxer;
	packetInfos = new WeakMap<EncodedPacket, PacketInfo>();
	number: number;

	constructor(firstInputTrack: InputTrack, demuxer: SegmentedInputDemuxer, number: number) {
		this.firstInputTrack = firstInputTrack;
		this.demuxer = demuxer;
		this.number = number;
	}

	getType(): TrackType {
		return this.firstInputTrack._backing.getType();
	}

	getDecoderConfig() {
		return this.firstInputTrack._backing.getDecoderConfig();
	}

	getHasOnlyKeyPackets() {
		return this.firstInputTrack.getHasOnlyKeyPackets();
	}

	getId(): number {
		return this.firstInputTrack._backing.getId();
	}

	getPairingMask() {
		return this.firstInputTrack._backing.getPairingMask();
	}

	getNumber(): number {
		return this.number;
	}

	getCodec() {
		return this.firstInputTrack._backing.getCodec();
	}

	getInternalCodecId() {
		return this.firstInputTrack._backing.getInternalCodecId();
	}

	getDisposition() {
		return this.firstInputTrack._backing.getDisposition();
	}

	getLanguageCode() {
		return this.firstInputTrack._backing.getLanguageCode();
	}

	getName() {
		return this.firstInputTrack._backing.getName();
	}

	getTimeResolution() {
		return this.firstInputTrack._backing.getTimeResolution();
	}

	isRelativeToUnixEpoch() {
		assert(this.demuxer.firstSegment);
		return this.demuxer.firstSegment.relativeToUnixEpoch;
	}

	getBitrate() {
		return this.firstInputTrack._backing.getBitrate();
	}

	getAverageBitrate() {
		return this.firstInputTrack._backing.getAverageBitrate();
	}

	getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		return this.demuxer.segmentedInput.getDurationFromMetadata(options);
	}

	getLiveRefreshInterval(): Promise<number | null> {
		return this.demuxer.segmentedInput.getLiveRefreshInterval();
	}

	async createAdjustedPacket(packet: EncodedPacket, segment: Segment, track: InputTrack) {
		assert(packet.sequenceNumber >= 0);
		assert(this.demuxer.firstSegment);

		const mediaOffset = await this.demuxer.getMediaOffset(segment, track.input);
		// If we didn't do this then sequence numbers would exceed Number.MAX_SAFE_INTEGER for Unix-timestamped segments
		const segmentTimestampRelativeToFirst = segment.timestamp - this.demuxer.firstSegment.timestamp;

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

		const nextPacket = keyframesOnly
			? await info.track._backing.getNextKeyPacket(info.sourcePacket, options)
			: await info.track._backing.getNextPacket(info.sourcePacket, options);
		if (nextPacket) {
			return this.createAdjustedPacket(nextPacket, info.segment, info.track);
		}

		let currentSegment: Segment | null = info.segment;
		while (true) {
			const nextSegment = await this.demuxer.segmentedInput.getNextSegment(currentSegment, {
				skipLiveWait: options.skipLiveWait,
			});
			if (!nextSegment) {
				return null;
			}

			const nextInput = this.demuxer.segmentedInput.getInputForSegment(nextSegment);
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
		let currentSegment = await this.demuxer.segmentedInput.getSegmentAt(timestamp, {
			skipLiveWait: options.skipLiveWait,
		});
		if (!currentSegment) {
			return null;
		}

		while (currentSegment) {
			const input = this.demuxer.segmentedInput.getInputForSegment(currentSegment);
			const tracks = await input.getTracks();
			const track = tracks.find(t => (
				t.type === this.firstInputTrack.type && t.number === this.firstInputTrack.number
			));

			if (!track) {
				// Search the previous segment
				currentSegment = await this.demuxer.segmentedInput.getPreviousSegment(currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				continue;
			}

			const mediaOffset = await this.demuxer.getMediaOffset(currentSegment, input);

			const offsetTimestamp = timestamp - mediaOffset;
			const packet = keyframesOnly
				? await track._backing.getKeyPacket(offsetTimestamp, options)
				: await track._backing.getPacket(offsetTimestamp, options);

			if (!packet) {
				// Search the previous segment
				currentSegment = await this.demuxer.segmentedInput.getPreviousSegment(currentSegment, {
					skipLiveWait: options.skipLiveWait,
				});
				continue;
			}

			return this.createAdjustedPacket(packet, currentSegment, track);
		}

		return null;
	}
}

class SegmentedInputInputVideoTrackBacking
	extends SegmentedInputInputTrackBacking
	implements InputVideoTrackBacking {
	override firstInputTrack!: InputVideoTrack;

	override getType() {
		return 'video' as const;
	}

	override getCodec() {
		return this.firstInputTrack._backing.getCodec();
	}

	getCodedWidth() {
		return this.firstInputTrack._backing.getCodedWidth();
	}

	getCodedHeight() {
		return this.firstInputTrack._backing.getCodedHeight();
	}

	getSquarePixelWidth() {
		return this.firstInputTrack._backing.getSquarePixelWidth();
	}

	getSquarePixelHeight() {
		return this.firstInputTrack._backing.getSquarePixelHeight();
	}

	getRotation() {
		return this.firstInputTrack._backing.getRotation();
	}

	getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.firstInputTrack._backing.getColorSpace();
	}

	canBeTransparent(): Promise<boolean> {
		return this.firstInputTrack._backing.canBeTransparent();
	}

	override getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.firstInputTrack._backing.getDecoderConfig();
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
		return this.firstInputTrack._backing.getCodec();
	}

	getNumberOfChannels() {
		return this.firstInputTrack._backing.getNumberOfChannels();
	}

	getSampleRate() {
		return this.firstInputTrack._backing.getSampleRate();
	}

	override getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return this.firstInputTrack._backing.getDecoderConfig();
	}
}
