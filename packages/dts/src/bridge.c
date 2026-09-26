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
DecoderContext *init_decoder() {
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

typedef struct {
	AVCodecContext *codec_ctx;
	AVPacket *packet;
	AVFrame *frame;
	float *input_buffer;
	int input_buffer_size;
	int64_t encoded_pts;
	int encoded_duration;
} EncoderContext;

/**
 * DTS insists on the side-based surround layouts and rejects the back-based ones that av_channel_layout_default hands
 * out for 4, 5 and 6 channels.
 */
static int set_dts_channel_layout(AVChannelLayout *layout, int channels) {
	switch (channels) {
		case 1: {
			AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
			return av_channel_layout_copy(layout, &mono);
		}
		case 2: {
			AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
			return av_channel_layout_copy(layout, &stereo);
		}
		case 4: {
			AVChannelLayout quad_side = AV_CHANNEL_LAYOUT_2_2;
			return av_channel_layout_copy(layout, &quad_side);
		}
		case 5: {
			AVChannelLayout five_zero = AV_CHANNEL_LAYOUT_5POINT0;
			return av_channel_layout_copy(layout, &five_zero);
		}
		case 6: {
			AVChannelLayout five_one = AV_CHANNEL_LAYOUT_5POINT1;
			return av_channel_layout_copy(layout, &five_one);
		}
		default:
			return -1;
	}
}

EMSCRIPTEN_KEEPALIVE
EncoderContext *init_encoder(int channels, int sample_rate, int bitrate) {
	const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_DTS);
	if (!codec) return NULL;

	AVCodecContext *codec_ctx = avcodec_alloc_context3(codec);
	if (!codec_ctx) return NULL;

	codec_ctx->sample_fmt = AV_SAMPLE_FMT_S32;
	codec_ctx->sample_rate = sample_rate;
	codec_ctx->bit_rate = bitrate;
	codec_ctx->time_base = (AVRational){1, sample_rate};

	// FFmpeg marks its DTS encoder experimental, so it refuses to open at the default compliance level
	codec_ctx->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

	if (set_dts_channel_layout(&codec_ctx->ch_layout, channels) < 0) {
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

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
	frame->format = AV_SAMPLE_FMT_S32;
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
int encode_frame(EncoderContext *ctx, int64_t pts) {
	int channels = ctx->codec_ctx->ch_layout.nb_channels;
	int frame_size = ctx->frame->nb_samples;

	ctx->frame->pts = pts;

	// DTS encodes from s32, which is a packed format, so the samples stay interleaved and all land in data[0]
	float *input = ctx->input_buffer;
	int32_t *output = (int32_t *)ctx->frame->data[0];
	for (int i = 0; i < frame_size * channels; i++) {
		float sample = input[i];
		if (sample > 1.0f) sample = 1.0f;
		if (sample < -1.0f) sample = -1.0f;
		output[i] = (int32_t)(sample * 2147483647.0f);
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
int64_t get_encoded_pts(EncoderContext *ctx) {
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
