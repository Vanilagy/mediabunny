/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

type RawAudioEncoderMetrics = Readonly<{
	frameCount: number;
	sampleRate: number;
}>;

const rawAudioEncoderMetrics = new WeakMap<object, {
	frameCount: number;
	sampleRate: number;
}>();

export const recordRawAudioEncoderFrames = (source: object, frameCount: number, sampleRate: number) => {
	let metrics = rawAudioEncoderMetrics.get(source);
	if (!metrics) {
		metrics = { frameCount: 0, sampleRate };
		rawAudioEncoderMetrics.set(source, metrics);
	} else if (sampleRate !== metrics.sampleRate) {
		// The encoder was configured for the first sample's rate, so a later rate is an error, not a conversion
		throw new Error(
			`Audio sample rate must remain constant after processing. Expected ${metrics.sampleRate} Hz, got`
			+ ` ${sampleRate} Hz.`,
		);
	}

	metrics.frameCount += frameCount;
};

export const getRawAudioEncoderMetrics = (source: object): RawAudioEncoderMetrics | null => {
	return rawAudioEncoderMetrics.get(source) ?? null;
};
