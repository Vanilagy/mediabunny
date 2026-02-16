/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/opt.h"
#include "libavutil/channel_layout.h"

typedef struct {
	AVCodecContext *codec_ctx;
	AVPacket *packet;
	AVFrame *frame;
} DecoderContext;

EMSCRIPTEN_KEEPALIVE
DecoderContext *init_decoder(int codec_id) {
	enum AVCodecID av_codec_id = codec_id == 0 ? AV_CODEC_ID_AC3 : AV_CODEC_ID_EAC3;

	const AVCodec *codec = avcodec_find_decoder(av_codec_id);
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
int decode_packet(DecoderContext *ctx, int pts) {
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
int get_decoded_pts(DecoderContext *ctx) {
	return (int)ctx->frame->pts;
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

typedef struct {
	AVCodecContext *codec_ctx;
	AVPacket *packet;
	AVFrame *frame;
	float *input_buffer;
	int input_buffer_size;
	int encoded_pts;
	int encoded_duration;
} EncoderContext;

EMSCRIPTEN_KEEPALIVE
EncoderContext *init_encoder(int codec_id, int channels, int sample_rate, int bitrate) {
	enum AVCodecID av_codec_id = codec_id == 0 ? AV_CODEC_ID_AC3 : AV_CODEC_ID_EAC3;

	const AVCodec *codec = avcodec_find_encoder(av_codec_id);
	if (!codec) return NULL;

	AVCodecContext *codec_ctx = avcodec_alloc_context3(codec);
	if (!codec_ctx) return NULL;

	codec_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
	codec_ctx->sample_rate = sample_rate;
	codec_ctx->bit_rate = bitrate;
	codec_ctx->time_base = (AVRational){1, sample_rate};

	AVChannelLayout layout;
	av_channel_layout_default(&layout, channels);
	av_channel_layout_copy(&codec_ctx->ch_layout, &layout);
	av_channel_layout_uninit(&layout);

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

	// The frame has a fixed format, so let's create it now:
	frame->format = AV_SAMPLE_FMT_FLTP;
	frame->sample_rate = sample_rate;
	frame->nb_samples = codec_ctx->frame_size;
	av_channel_layout_copy(&frame->ch_layout, &codec_ctx->ch_layout);

	if (av_frame_get_buffer(frame, 0) < 0) {
		av_frame_free(&frame);
		av_packet_free(&packet);
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	EncoderContext *ctx = malloc(sizeof(EncoderContext));
	if (!ctx) {
		av_frame_free(&frame);
		av_packet_free(&packet);
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	ctx->codec_ctx = codec_ctx;
	ctx->packet = packet;
	ctx->frame = frame;
	ctx->input_buffer = NULL;
	ctx->input_buffer_size = 0;
	ctx->encoded_pts = 0;
	ctx->encoded_duration = 0;

	return ctx;
}

EMSCRIPTEN_KEEPALIVE
int get_encoder_frame_size(EncoderContext *ctx) {
	return ctx->codec_ctx->frame_size;
}

EMSCRIPTEN_KEEPALIVE
float *get_encode_input_ptr(EncoderContext *ctx, int size) {
	if (ctx->input_buffer_size < size) {
		free(ctx->input_buffer);
		ctx->input_buffer = malloc(size);
		if (!ctx->input_buffer) {
			ctx->input_buffer_size = 0;
			return NULL;
		}
		ctx->input_buffer_size = size;
	}
	return ctx->input_buffer;
}

EMSCRIPTEN_KEEPALIVE
int encode_frame(EncoderContext *ctx, int pts) {
	int channels = ctx->codec_ctx->ch_layout.nb_channels;
	int frame_size = ctx->frame->nb_samples;

	ctx->frame->pts = pts;

	// Deinterleave f32 input into the frame's f32-planar planes
	float *input = ctx->input_buffer;
	for (int ch = 0; ch < channels; ch++) {
		float *plane = (float *)ctx->frame->data[ch];
		for (int i = 0; i < frame_size; i++) {
			plane[i] = input[i * channels + ch];
		}
	}

	int ret = avcodec_send_frame(ctx->codec_ctx, ctx->frame);
	if (ret < 0) return ret;

	ret = avcodec_receive_packet(ctx->codec_ctx, ctx->packet);
	if (ret < 0) return ret;

	ctx->encoded_pts = ctx->packet->pts;
	ctx->encoded_duration = ctx->packet->duration;

	return ctx->packet->size;
}

EMSCRIPTEN_KEEPALIVE
void flush_encoder(EncoderContext *ctx) {
	avcodec_send_frame(ctx->codec_ctx, NULL);
	while (avcodec_receive_packet(ctx->codec_ctx, ctx->packet) == 0) {
		av_packet_unref(ctx->packet);
	}
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_encoded_data(EncoderContext *ctx) {
	return ctx->packet->data;
}

EMSCRIPTEN_KEEPALIVE
int get_encoded_pts(EncoderContext *ctx) {
	return ctx->encoded_pts;
}

EMSCRIPTEN_KEEPALIVE
int get_encoded_duration(EncoderContext *ctx) {
	return ctx->encoded_duration;
}

EMSCRIPTEN_KEEPALIVE
void close_encoder(EncoderContext *ctx) {
	free(ctx->input_buffer);
	av_frame_free(&ctx->frame);
	av_packet_free(&ctx->packet);
	avcodec_free_context(&ctx->codec_ctx);
	free(ctx);
}
