/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AsyncMutex } from './misc';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import { EncodedPacket, PacketType } from './packet';
import { SubtitleCue, SubtitleMetadata } from './subtitles';

export abstract class Muxer {
	output: Output;
	mutex = new AsyncMutex();

	constructor(output: Output) {
		this.output = output;
	}

	abstract start(): Promise<void>;
	abstract getMimeType(): Promise<string>;
	abstract addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata
	): Promise<void>;
	abstract addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata
	): Promise<void>;
	abstract addSubtitleCue(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata): Promise<void>;
	abstract finalize(): Promise<void>;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	onTrackClose(track: OutputTrack) {}

	private trackPacketOrderValidators = new WeakMap<OutputTrack, PacketOrderValidator>();

	protected validateTimestamp(track: OutputTrack, timestampInSeconds: number, isKeyPacket: boolean) {
		let validator = this.trackPacketOrderValidators.get(track);
		if (!validator) {
			validator = new PacketOrderValidator();
			this.trackPacketOrderValidators.set(track, validator);
		}

		const type = isKeyPacket ? 'key' : 'delta';
		if (validator.digest(timestampInSeconds, type)) {
			return;
		}

		if (validator.maxTimestamp === null) {
			throw new Error('First packet must be a key packet.');
		}

		const largestTimestamp = type === 'key'
			? validator.maxTimestamp
			: validator.maxTimestampBeforeLastKeyPacket;
		throw new Error(
			`Timestamps cannot be smaller than the largest timestamp of the previous GOP (a GOP begins with a`
			+ ` key packet and ends right before the next key packet). Got ${timestampInSeconds}s, but largest`
			+ ` timestamp is ${largestTimestamp}s.`,
		);
	}
}

export class PacketOrderValidator {
	maxTimestamp: number | null = null;
	maxTimestampBeforeLastKeyPacket: number | null = null;

	check(timestamp: number, type: PacketType) {
		if (this.maxTimestamp === null) {
			return type === 'key';
		}

		// A key packet starts a new GOP, making the current one the previous one
		const maxTimestampOfPreviousGop = type === 'key' ? this.maxTimestamp : this.maxTimestampBeforeLastKeyPacket;
		return maxTimestampOfPreviousGop === null || timestamp >= maxTimestampOfPreviousGop;
	}

	digest(timestamp: number, type: PacketType) {
		if (!this.check(timestamp, type)) {
			return false;
		}

		if (type === 'key') {
			this.maxTimestampBeforeLastKeyPacket = this.maxTimestamp;
		}
		this.maxTimestamp = Math.max(this.maxTimestamp ?? -Infinity, timestamp);

		return true;
	}
}
