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
#include "libavutil/log.h"

typedef struct {
	AVCodecContext *codec_ctx;
	AVPacket *packet;
	AVFrame *frame;
	float *input_buffer;
	int input_buffer_size;
	int64_t encoded_pts;
	int encoded_duration;
} EncoderContext;

// Layouts AAC has a channel configuration for, as anything else needs a PCE, which not every player supports (and
// av_channel_layout_default's 2.1 for 3 channels even turns the third one into LFE). 7.1 gets configuration 12: 7 is
// 7.1(wide) by the spec, but decoders like FFmpeg's take it for a mislabeled 7.1 and swap channels around. Quad is the
// exception: it has no channel configuration, but 4.0 would move its rear channels to the center, so it gets a PCE.
static int set_aac_channel_layout(AVChannelLayout *layout, int channels) {
	switch (channels) {
		case 1: {
			AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
			return av_channel_layout_copy(layout, &mono);
		}
		case 2: {
			AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
			return av_channel_layout_copy(layout, &stereo);
		}
		case 3: {
			AVChannelLayout surround = AV_CHANNEL_LAYOUT_SURROUND;
			return av_channel_layout_copy(layout, &surround);
		}
		case 4: {
			AVChannelLayout quad = AV_CHANNEL_LAYOUT_QUAD;
			return av_channel_layout_copy(layout, &quad);
		}
		case 5: {
			AVChannelLayout five_zero = AV_CHANNEL_LAYOUT_5POINT0_BACK;
			return av_channel_layout_copy(layout, &five_zero);
		}
		case 6: {
			AVChannelLayout five_one = AV_CHANNEL_LAYOUT_5POINT1_BACK;
			return av_channel_layout_copy(layout, &five_one);
		}
		case 7: {
			AVChannelLayout six_one = AV_CHANNEL_LAYOUT_6POINT1_BACK;
			return av_channel_layout_copy(layout, &six_one);
		}
		case 8: {
			AVChannelLayout seven_one = AV_CHANNEL_LAYOUT_7POINT1;
			return av_channel_layout_copy(layout, &seven_one);
		}
		default:
			return -1;
	}
}

static AVCodecContext *open_codec_context(int channels, int sample_rate, int bitrate) {
	const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
	if (!codec) return NULL;

	AVCodecContext *codec_ctx = avcodec_alloc_context3(codec);
	if (!codec_ctx) return NULL;

	codec_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
	codec_ctx->sample_rate = sample_rate;
	codec_ctx->bit_rate = bitrate;
	codec_ctx->time_base = (AVRational){1, sample_rate};

	if (set_aac_channel_layout(&codec_ctx->ch_layout, channels) < 0) {
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	if (avcodec_open2(codec_ctx, codec, NULL) < 0) {
		avcodec_free_context(&codec_ctx);
		return NULL;
	}

	return codec_ctx;
}

EMSCRIPTEN_KEEPALIVE
EncoderContext *init_encoder(int channels, int sample_rate, int bitrate) {
	av_log_set_level(AV_LOG_ERROR);

	AVCodecContext *codec_ctx = open_codec_context(channels, sample_rate, bitrate);
	if (!codec_ctx) return NULL;

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
uint8_t *get_encoder_extradata(EncoderContext *ctx) {
	return ctx->codec_ctx->extradata;
}

EMSCRIPTEN_KEEPALIVE
int get_encoder_extradata_size(EncoderContext *ctx) {
	return ctx->codec_ctx->extradata_size;
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
int send_frame(EncoderContext *ctx, int64_t pts) {
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

	return avcodec_send_frame(ctx->codec_ctx, ctx->frame);
}

EMSCRIPTEN_KEEPALIVE
int receive_packet(EncoderContext *ctx) {
	int ret = avcodec_receive_packet(ctx->codec_ctx, ctx->packet);
	if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
		return 0;
	}
	if (ret < 0) return ret;

	ctx->encoded_pts = ctx->packet->pts;
	ctx->encoded_duration = ctx->packet->duration;

	return ctx->packet->size;
}

EMSCRIPTEN_KEEPALIVE
void flush_encoder_start(EncoderContext *ctx) {
	avcodec_send_frame(ctx->codec_ctx, NULL);
}

EMSCRIPTEN_KEEPALIVE
int reset_encoder(EncoderContext *ctx) {
	// The AAC encoder can't be flushed (avcodec_flush_buffers does nothing for it), so once drained, it's done for
	// good. A fresh one takes its place.
	AVCodecContext *codec_ctx = open_codec_context(
		ctx->codec_ctx->ch_layout.nb_channels,
		ctx->codec_ctx->sample_rate,
		ctx->codec_ctx->bit_rate
	);
	if (!codec_ctx) return -1;

	avcodec_free_context(&ctx->codec_ctx);
	ctx->codec_ctx = codec_ctx;

	return 0;
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
