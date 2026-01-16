/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AsyncMutex } from './misc';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import { EncodedPacket } from './packet';
import { SubtitleCue, SubtitleMetadata } from './subtitles';

export abstract class Muxer {
	output: Output;
	mutex = new AsyncMutex();

	/**
	 * This field is used to synchronize multiple MediaStreamTracks. They use the same time coordinate system across
	 * tracks, and to ensure correct audio-video sync, we must use the same offset for all of them. The reason an offset
	 * is needed at all is because the timestamps typically don't start at zero.
	 */
	firstMediaStreamTimestamp: number | null = null;

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

	private trackTimestampInfo = new WeakMap<OutputTrack, {
		maxTimestamp: number;
		maxTimestampBeforeLastKeyPacket: number;
	}>();

	protected validateAndNormalizeTimestamp(track: OutputTrack, timestampInSeconds: number, isKeyPacket: boolean) {
		timestampInSeconds += track.source._timestampOffset;

		let timestampInfo = this.trackTimestampInfo.get(track);
		if (!timestampInfo) {
			if (!isKeyPacket) {
				throw new Error('First packet must be a key packet.');
			}

			timestampInfo = {
				maxTimestamp: timestampInSeconds,
				maxTimestampBeforeLastKeyPacket: timestampInSeconds,
			};
			this.trackTimestampInfo.set(track, timestampInfo);
		}

		if (timestampInSeconds < 0) {
			throw new Error(`Timestamps must be non-negative (got ${timestampInSeconds}s).`);
		}

		if (isKeyPacket) {
			timestampInfo.maxTimestampBeforeLastKeyPacket = timestampInfo.maxTimestamp;
		}

		if (timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyPacket) {
			throw new Error(
				`Timestamps cannot be smaller than the largest timestamp of the previous GOP (a GOP begins with a key`
				+ ` packet and ends right before the next key packet). Got ${timestampInSeconds}s, but largest`
				+ ` timestamp is ${timestampInfo.maxTimestampBeforeLastKeyPacket}s.`,
			);
		}

		timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);

		return timestampInSeconds;
	}
}
