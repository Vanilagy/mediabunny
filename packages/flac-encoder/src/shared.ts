/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type PacketInfo = {
	encodedData: ArrayBuffer;
	samples: number;
};

export type WorkerCommand = {
	type: 'init';
	data: {
		numberOfChannels: number;
		sampleRate: number;
	};
} | {
	type: 'encode';
	data: {
		ctx: number;
		audioData: ArrayBuffer;
		numSamples: number;
	};
} | {
	type: 'flush';
	data: {
		ctx: number;
	};
};

export type WorkerResponseData = {
	type: 'init';
	ctx: number;
	header: ArrayBuffer;
} | {
	type: 'encode';
	packets: PacketInfo[];
} | {
	type: 'flush';
	packets: PacketInfo[];
};

export type WorkerResponse = {
	id: number;
} & ({
	success: true;
	data: WorkerResponseData;
} | {
	success: false;
	error: unknown;
});
