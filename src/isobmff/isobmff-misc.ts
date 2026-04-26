/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { bytesToHexString, toDataView, uint8ArraysAreEqual } from '../misc';

export const buildIsobmffMimeType = (info: {
	isQuickTime: boolean;
	hasVideo: boolean;
	hasAudio: boolean;
	codecStrings: string[];
}) => {
	const base = info.hasVideo
		? 'video/'
		: info.hasAudio
			? 'audio/'
			: 'application/';

	let string = base + (info.isQuickTime ? 'quicktime' : 'mp4');

	if (info.codecStrings.length > 0) {
		const uniqueCodecMimeTypes = [...new Set(info.codecStrings)];
		string += `; codecs="${uniqueCodecMimeTypes.join(', ')}"`;
	}

	return string;
};

/**
 * Represents a Protection System Specific Header box as used by ISOBMFF Common Encryption. Contains
 * DRM system-specific data that can be used to obtain a decryption key.
 *
 * @group Miscellaneous
 * @public
 */
export type PsshBox = {
	/** The system ID as a 32-bit lowercase hex string. */
	systemId: string;
	/**
	 * The list of key IDs (32-bit lowercase hex strings) this box applies to, or `null` if it applies to all key IDs.
	 */
	keyIds: string[] | null;
	/** The content protection system-specific data. */
	data: Uint8Array;
};

export const parsePsshBoxContents = (contents: Uint8Array): PsshBox => {
	const view = toDataView(contents);
	let pos = 0;

	const version = view.getUint8(pos);
	pos += 1;

	pos += 3; // Flags

	const systemId = bytesToHexString(contents.subarray(pos, pos + 16));
	pos += 16;

	let keyIds: string[] | null = null;
	if (version > 0) {
		const kidCount = view.getUint32(pos);
		pos += 4;

		if (kidCount > 0) {
			keyIds = [];
			for (let i = 0; i < kidCount; i++) {
				keyIds.push(bytesToHexString(contents.subarray(pos, pos + 16)));
				pos += 16;
			}
		}
	}

	const dataSize = view.getUint32(pos);
	pos += 4;

	return {
		systemId,
		keyIds,
		data: contents.slice(pos, pos + dataSize),
	};
};

export const psshBoxesAreEqual = (a: PsshBox, b: PsshBox) => (
	a.systemId === b.systemId
	&& uint8ArraysAreEqual(a.data, b.data)
);

/**
 * One subsegment reference within a {@link SidxBox}.
 *
 * @group Miscellaneous
 * @public
 */
export type SidxReference = {
	/** `0` for a media subsegment, `1` for a nested `sidx`. */
	referenceType: 0 | 1;
	/** Size of the referenced subsegment in bytes. */
	referencedSize: number;
	/** Duration of the referenced subsegment, in the parent sidx's timescale. */
	subsegmentDuration: number;
	/** `1` if the subsegment starts with a Stream Access Point. */
	startsWithSAP: 0 | 1;
	/** SAP type (0-7) when `startsWithSAP` is `1`. */
	sapType: number;
	/** Offset from the subsegment start to the SAP, in the parent sidx's timescale. */
	sapDeltaTime: number;
};

/**
 * Represents a Segment Index box (`sidx`) in a fragmented MP4. Provides per-subsegment byte
 * offsets, durations and SAP markers — the data needed to address subsegments by byte range.
 *
 * @group Miscellaneous
 * @public
 */
export type SidxBox = {
	/** The track ID this index applies to. */
	referenceID: number;
	/** Timescale of durations and timestamps in this index. */
	timescale: number;
	/** Earliest presentation time of the first subsegment, in this index's timescale. */
	earliestPresentationTime: number;
	/** Byte offset from after this `sidx` box to the first referenced subsegment. Usually `0`. */
	firstOffset: number;
	/** One entry per referenced subsegment, in order. */
	references: SidxReference[];
	/** Absolute byte offset of this `sidx` box in the file. */
	boxStart: number;
	/** Total size of this `sidx` box in bytes. */
	boxSize: number;
};

export const parseSidxBoxContents = (
	contents: Uint8Array,
	boxStart: number,
	boxSize: number,
): SidxBox => {
	const view = toDataView(contents);
	let pos = 0;

	const version = view.getUint8(pos);
	pos += 1;
	pos += 3; // Flags

	const referenceID = view.getUint32(pos);
	pos += 4;
	const timescale = view.getUint32(pos);
	pos += 4;

	let earliestPresentationTime: number;
	let firstOffset: number;
	if (version === 0) {
		earliestPresentationTime = view.getUint32(pos);
		pos += 4;
		firstOffset = view.getUint32(pos);
		pos += 4;
	} else {
		const eptHi = view.getUint32(pos);
		const eptLo = view.getUint32(pos + 4);
		earliestPresentationTime = eptHi * 2 ** 32 + eptLo;
		pos += 8;
		const foHi = view.getUint32(pos);
		const foLo = view.getUint32(pos + 4);
		firstOffset = foHi * 2 ** 32 + foLo;
		pos += 8;
	}

	pos += 2; // Reserved
	const referenceCount = view.getUint16(pos);
	pos += 2;

	const references: SidxReference[] = [];
	for (let i = 0; i < referenceCount; i++) {
		const sizeWord = view.getUint32(pos);
		pos += 4;
		const subsegmentDuration = view.getUint32(pos);
		pos += 4;
		const sapWord = view.getUint32(pos);
		pos += 4;

		references.push({
			referenceType: ((sizeWord >>> 31) & 0x1) as 0 | 1,
			referencedSize: sizeWord & 0x7fffffff,
			subsegmentDuration,
			startsWithSAP: ((sapWord >>> 31) & 0x1) as 0 | 1,
			sapType: (sapWord >>> 28) & 0x7,
			sapDeltaTime: sapWord & 0x0fffffff,
		});
	}

	return {
		referenceID,
		timescale,
		earliestPresentationTime,
		firstOffset,
		references,
		boxStart,
		boxSize,
	};
};
