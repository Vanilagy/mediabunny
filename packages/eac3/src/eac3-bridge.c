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
#include "../lib/avcodec.h"
#include "../lib/channel_layout.h"
#include "../lib/frame.h"

typedef struct {
	AVCodecContext *ctx;
	AVFrame *frame;
	AVPacket *packet;
} decoder_state;

typedef struct {
	AVCodecContext *ctx;
	AVFrame *frame;
	AVPacket *packet;
} encoder_state;

EMSCRIPTEN_KEEPALIVE
decoder_state* init_decoder(int codec_id, int sample_rate, int channels) {
	const AVCodec *codec = avcodec_find_decoder(codec_id);
	if (!codec) {
		return NULL;
	}

	decoder_state *state = malloc(sizeof(decoder_state));
	state->ctx = avcodec_alloc_context3(codec);
	state->ctx->sample_rate = sample_rate;
	av_channel_layout_default(&state->ctx->ch_layout, channels);

	if (avcodec_open2(state->ctx, codec, NULL) < 0) {
		avcodec_free_context(&state->ctx);
		free(state);
		return NULL;
	}

	state->frame = av_frame_alloc();
	state->packet = av_packet_alloc();

	return state;
}

EMSCRIPTEN_KEEPALIVE
int decode_packet(
	decoder_state *state,
	unsigned char *input_buf,
	int input_size,
	float *output_buf,
	int *out_frames,
	int *out_sample_rate,
	int *out_channels
) {
	av_packet_unref(state->packet);
	state->packet->data = input_buf;
	state->packet->size = input_size;

	int ret = avcodec_send_packet(state->ctx, state->packet);
	if (ret < 0) {
		return ret;
	}

	ret = avcodec_receive_frame(state->ctx, state->frame);
	if (ret < 0) {
		return ret;
	}

	int frames = state->frame->nb_samples;
	int channels = state->frame->ch_layout.nb_channels;

	// Use codec context values if frame values are not set
	int sample_rate = state->frame->sample_rate;
	if (sample_rate == 0) {
		sample_rate = state->ctx->sample_rate;
	}
	if (channels == 0) {
		channels = state->ctx->ch_layout.nb_channels;
	}


	for (int i = 0; i < frames; i++) {
		for (int ch = 0; ch < channels; ch++) {
			float *channel_data = (float*)state->frame->extended_data[ch];
			output_buf[i * channels + ch] = channel_data[i];
		}
	}

	*out_frames = frames;
	*out_sample_rate = sample_rate;
	*out_channels = channels;

	av_frame_unref(state->frame);

	return 0;
}

EMSCRIPTEN_KEEPALIVE
void flush_decoder(decoder_state *state) {
	if (state && state->ctx) {
		avcodec_flush_buffers(state->ctx);
	}
}

EMSCRIPTEN_KEEPALIVE
void close_decoder(decoder_state *state) {
	if (state) {
		if (state->frame) av_frame_free(&state->frame);
		if (state->packet) av_packet_free(&state->packet);
		if (state->ctx) avcodec_free_context(&state->ctx);
		free(state);
	}
}

EMSCRIPTEN_KEEPALIVE
encoder_state* init_encoder(int codec_id, int sample_rate, int channels, int bitrate) {
	const AVCodec *codec = avcodec_find_encoder(codec_id);
	if (!codec) return NULL;

	encoder_state *state = malloc(sizeof(encoder_state));
	state->ctx = avcodec_alloc_context3(codec);
	state->ctx->sample_rate = sample_rate;
	av_channel_layout_default(&state->ctx->ch_layout, channels);
	state->ctx->bit_rate = bitrate;
	state->ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;

	if (avcodec_open2(state->ctx, codec, NULL) < 0) {
		avcodec_free_context(&state->ctx);
		free(state);
		return NULL;
	}

	state->frame = av_frame_alloc();
	state->frame->nb_samples = state->ctx->frame_size;
	state->frame->format = state->ctx->sample_fmt;
	state->frame->sample_rate = sample_rate;
	av_channel_layout_copy(&state->frame->ch_layout, &state->ctx->ch_layout);

	av_frame_get_buffer(state->frame, 0);

	state->packet = av_packet_alloc();

	return state;
}

EMSCRIPTEN_KEEPALIVE
int encode_samples(
	encoder_state *state,
	float *input_buf,
	int num_frames,
	unsigned char *output_buf,
	int output_buf_size
) {
	int channels = state->frame->ch_layout.nb_channels;

	for (int ch = 0; ch < channels; ch++) {
		float *channel_data = (float*)state->frame->extended_data[ch];
		for (int i = 0; i < num_frames; i++) {
			channel_data[i] = input_buf[i * channels + ch];
		}
	}

	state->frame->nb_samples = num_frames;

	int ret = avcodec_send_frame(state->ctx, state->frame);
	if (ret < 0) return ret;

	ret = avcodec_receive_packet(state->ctx, state->packet);
	if (ret < 0) return ret;

	if (state->packet->size > output_buf_size) {
		return -1;
	}

	memcpy(output_buf, state->packet->data, state->packet->size);
	int size = state->packet->size;

	av_packet_unref(state->packet);

	return size;
}

EMSCRIPTEN_KEEPALIVE
void close_encoder(encoder_state *state) {
	if (state) {
		if (state->frame) av_frame_free(&state->frame);
		if (state->packet) av_packet_free(&state->packet);
		if (state->ctx) avcodec_free_context(&state->ctx);
		free(state);
	}
}
