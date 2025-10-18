/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "../lib/xvid.h"

typedef struct {
	void *decoder_handle;
	int width;
	int height;
} decoder_state;

EMSCRIPTEN_KEEPALIVE
decoder_state* init_decoder(int width, int height) {
	xvid_gbl_init_t xvid_init;
	xvid_dec_create_t dec_create;

	xvid_init.version = XVID_VERSION;
	xvid_init.cpu_flags = 0;
	xvid_global(NULL, 0, &xvid_init, NULL);

	memset(&dec_create, 0, sizeof(xvid_dec_create_t));
	dec_create.version = XVID_VERSION;
	dec_create.width = 0;
	dec_create.height = 0;
	dec_create.handle = NULL;

	decoder_state *state = (decoder_state*)malloc(sizeof(decoder_state));

	int ret = xvid_decore(NULL, XVID_DEC_CREATE, &dec_create, NULL);
	if (ret != 0) {
		free(state);
		return NULL;
	}

	state->decoder_handle = dec_create.handle;
	state->width = width;
	state->height = height;

	return state;
}

EMSCRIPTEN_KEEPALIVE
int decode_frame(
	decoder_state *state,
	unsigned char *input_buf,
	int input_size,
	unsigned char *output_buf,
	int *out_type,
	int *out_width,
	int *out_height
) {
	xvid_dec_frame_t dec_frame;
	xvid_dec_stats_t dec_stats;

	memset(&dec_frame, 0, sizeof(xvid_dec_frame_t));
	memset(&dec_stats, 0, sizeof(xvid_dec_stats_t));

	dec_frame.version = XVID_VERSION;
	dec_frame.general = 0;
	dec_frame.bitstream = input_buf;
	dec_frame.length = input_size;

	dec_frame.output.plane[0] = output_buf;
	dec_frame.output.plane[1] = output_buf + (state->width * state->height);
	dec_frame.output.plane[2] = output_buf + (state->width * state->height * 5 / 4);
	dec_frame.output.stride[0] = state->width;
	dec_frame.output.stride[1] = state->width / 2;
	dec_frame.output.stride[2] = state->width / 2;
	dec_frame.output.csp = XVID_CSP_I420;

	dec_stats.version = XVID_VERSION;

	int ret = xvid_decore(state->decoder_handle, XVID_DEC_DECODE, &dec_frame, &dec_stats);

	if (dec_stats.type == -1) {
		state->width = dec_stats.data.vol.width;
		state->height = dec_stats.data.vol.height;
	}

	if (out_type) {
		*out_type = dec_stats.type;
	}
	if (out_width) {
		*out_width = state->width;
	}
	if (out_height) {
		*out_height = state->height;
	}

	return ret;
}

EMSCRIPTEN_KEEPALIVE
void close_decoder(decoder_state *state) {
	if (state) {
		if (state->decoder_handle) {
			xvid_decore(state->decoder_handle, XVID_DEC_DESTROY, NULL, NULL);
		}
		free(state);
	}
}

typedef struct {
	void *encoder_handle;
	int width;
	int height;
} encoder_state;

EMSCRIPTEN_KEEPALIVE
encoder_state* init_encoder(int width, int height, int bitrate, int fps_num, int fps_den) {
	xvid_gbl_init_t xvid_init;
	xvid_enc_create_t enc_create;

	xvid_init.version = XVID_VERSION;
	xvid_init.cpu_flags = 0;
	xvid_global(NULL, 0, &xvid_init, NULL);

	memset(&enc_create, 0, sizeof(xvid_enc_create_t));

	enc_create.version = XVID_VERSION;
	enc_create.width = width;
	enc_create.height = height;
	enc_create.fincr = fps_den;
	enc_create.fbase = fps_num;
	enc_create.zones = NULL;
	enc_create.num_zones = 0;
	enc_create.plugins = NULL;
	enc_create.num_plugins = 0;
	enc_create.num_threads = 0;
	enc_create.max_bframes = 0;
	enc_create.max_key_interval = 250;
	enc_create.global = 0;

	encoder_state *state = (encoder_state*)malloc(sizeof(encoder_state));

	int ret = xvid_encore(NULL, XVID_ENC_CREATE, &enc_create, NULL);
	if (ret != 0) {
		free(state);
		return NULL;
	}

	state->encoder_handle = enc_create.handle;
	state->width = width;
	state->height = height;

	return state;
}

EMSCRIPTEN_KEEPALIVE
int encode_frame(
	encoder_state *state,
	unsigned char *yuv_input,
	unsigned char *output_buf,
	int output_buf_size,
	int force_keyframe
) {
	xvid_enc_frame_t enc_frame;
	xvid_enc_stats_t enc_stats;

	memset(&enc_frame, 0, sizeof(xvid_enc_frame_t));
	memset(&enc_stats, 0, sizeof(xvid_enc_stats_t));

	enc_frame.version = XVID_VERSION;
	enc_frame.type = force_keyframe ? XVID_TYPE_IVOP : XVID_TYPE_AUTO;
	enc_frame.bitstream = output_buf;
	enc_frame.length = output_buf_size;
	enc_frame.input.plane[0] = yuv_input;
	enc_frame.input.plane[1] = yuv_input + (state->width * state->height);
	enc_frame.input.plane[2] = yuv_input + (state->width * state->height * 5 / 4);
	enc_frame.input.stride[0] = state->width;
	enc_frame.input.stride[1] = state->width / 2;
	enc_frame.input.stride[2] = state->width / 2;
	enc_frame.input.csp = XVID_CSP_I420;
	enc_frame.vop_flags = 0;
	enc_frame.vol_flags = 0;
	enc_frame.motion = 0;
	enc_frame.quant = 0;

	enc_stats.version = XVID_VERSION;

	int ret = xvid_encore(state->encoder_handle, XVID_ENC_ENCODE, &enc_frame, &enc_stats);

	if (ret > 0) {
		return enc_stats.length;
	}

	return ret;
}

EMSCRIPTEN_KEEPALIVE
void close_encoder(encoder_state *state) {
	if (state) {
		if (state->encoder_handle) {
			xvid_encore(state->encoder_handle, XVID_ENC_DESTROY, NULL, NULL);
		}
		free(state);
	}
}