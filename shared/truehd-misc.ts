/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const TRUEHD_MAJOR_SYNC_WORD = 0xf8726fba;
export const TRUEHD_SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000]; // Accepted by FFmpeg's encoder
export const TRUEHD_CHANNEL_COUNTS = [1, 2, 3, 4, 5, 6]; // FFmpeg's encoder has a layout for these
