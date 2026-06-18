/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include "libavcodec/avcodec.h"

typedef struct {
	AVCodecContext *codec_ctx;
	AVPacket *packet;
	AVFrame *frame;
} DecoderContext;

EMSCRIPTEN_KEEPALIVE
DecoderContext *init_decoder(int codec_id) {
	(void)codec_id;

	const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_DTS);
	if (!codec) return NULL;

	AVCodecContext *codec_ctx = avcodec_alloc_context3(codec);
	if (!codec_ctx) return NULL;

	if (avcodec_open2(codec_ctx, codec, NULL) < 0) {
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	AVPacket *packet = av_packet_alloc();
	if (!packet) {
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	AVFrame *frame = av_frame_alloc();
	if (!frame) {
		av_packet_free(&packet);
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	DecoderContext *ctx = malloc(sizeof(DecoderContext));
	if (!ctx) {
		av_frame_free(&frame);
		av_packet_free(&packet);
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	ctx->codec_ctx = codec_ctx;
	ctx->packet = packet;
	ctx->frame = frame;

	return ctx;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *configure_decode_packet(DecoderContext *ctx, int size) {
	if (av_new_packet(ctx->packet, size) < 0) {
		return NULL;
	}

	return ctx->packet->data;
}

EMSCRIPTEN_KEEPALIVE
int decode_packet(DecoderContext *ctx, int64_t pts) {
	ctx->packet->pts = pts;

	int ret = avcodec_send_packet(ctx->codec_ctx, ctx->packet);
	av_packet_unref(ctx->packet);
	if (ret < 0) return ret;

	ret = avcodec_receive_frame(ctx->codec_ctx, ctx->frame);
	if (ret < 0) return ret;

	return 0;
}

EMSCRIPTEN_KEEPALIVE
int get_decoded_format(DecoderContext *ctx) {
	return ctx->frame->format;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_decoded_plane_ptr(DecoderContext *ctx, int plane) {
	return ctx->frame->data[plane];
}

EMSCRIPTEN_KEEPALIVE
int get_decoded_channels(DecoderContext *ctx) {
	return ctx->frame->ch_layout.nb_channels;
}

EMSCRIPTEN_KEEPALIVE
int get_decoded_sample_rate(DecoderContext *ctx) {
	return ctx->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
int get_decoded_sample_count(DecoderContext *ctx) {
	return ctx->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
int64_t get_decoded_pts(DecoderContext *ctx) {
	return ctx->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
void flush_decoder(DecoderContext *ctx) {
	avcodec_send_packet(ctx->codec_ctx, NULL);
	while (avcodec_receive_frame(ctx->codec_ctx, ctx->frame) == 0) {}
	avcodec_flush_buffers(ctx->codec_ctx);
}

EMSCRIPTEN_KEEPALIVE
void close_decoder(DecoderContext *ctx) {
	av_frame_free(&ctx->frame);
	av_packet_free(&ctx->packet);
	avcodec_free_context(&ctx->codec_ctx);
	free(ctx);
}
