/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <emscripten.h>
#include "../lib/lame.h"

EMSCRIPTEN_KEEPALIVE
lame_global_flags *init_lame(int number_of_channels, int sample_rate, int bitrate) {
	lame_global_flags *gfp = lame_init();

	lame_set_num_channels(gfp, number_of_channels);
	lame_set_in_samplerate(gfp, sample_rate);
	lame_set_out_samplerate(gfp, sample_rate);
	lame_set_brate(gfp, bitrate / 1000); // MP3 wants "kilobitrate"
	lame_set_bWriteVbrTag(gfp, 0);

	int ret_code = lame_init_params(gfp);

	return gfp;
}

EMSCRIPTEN_KEEPALIVE
int encode_samples(lame_global_flags *gfp, short int left_buf[], short int right_buf[], int sample_count, unsigned char *dest_buf, int dest_buf_size) {
	return lame_encode_buffer(gfp, left_buf, right_buf, sample_count, dest_buf, dest_buf_size);
}

EMSCRIPTEN_KEEPALIVE
int flush_lame(lame_global_flags *gfp, unsigned char *dest_buf, int dest_buf_size) {
	return lame_encode_flush(gfp, dest_buf, dest_buf_size);
}

EMSCRIPTEN_KEEPALIVE
void close_lame(lame_global_flags *gfp) {
	lame_close(gfp);
}
