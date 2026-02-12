#include <emscripten.h>
#include <stdio.h>
#include "libavcodec/avcodec.h"
#include "libavutil/pixdesc.h"
#include "libavutil/imgutils.h"

typedef struct {
	AVCodecContext *codec_ctx;
	AVPacket *packet;
	AVFrame *frame;
	uint8_t *buffer;
	int buffer_size;
} DecoderContext;

EMSCRIPTEN_KEEPALIVE
DecoderContext *init_decoder() {
	const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_PRORES);
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
	ctx->buffer = NULL;
	ctx->buffer_size = 0;

	return ctx;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *configure_packet(DecoderContext *ctx, int size) {
	if (av_new_packet(ctx->packet, size) < 0) {
		return NULL;
	}

	ctx->packet->pts = 0;
	ctx->packet->dts = AV_NOPTS_VALUE;
	ctx->packet->time_base.num = 1;
	ctx->packet->time_base.den = 1;
	ctx->packet->flags = AV_PKT_FLAG_KEY;

	return ctx->packet->data;
}

EMSCRIPTEN_KEEPALIVE
int decode_packet(DecoderContext *ctx) {
	double start = emscripten_get_now();

	int ret = avcodec_send_packet(ctx->codec_ctx, ctx->packet);
	if (ret < 0) {
		return ret;
	}

	double after_send = emscripten_get_now();

	ret = avcodec_receive_frame(ctx->codec_ctx, ctx->frame);
	if (ret < 0) {
		return ret;
	}

	double after_receive = emscripten_get_now();

	// Calculate required buffer size
	int required_size = av_image_get_buffer_size(
		ctx->frame->format,
		ctx->frame->width,
		ctx->frame->height,
		1
	);

	if (required_size < 0) {
		return required_size;
	}

	// Reallocate buffer if needed
	if (ctx->buffer_size < required_size) {
		free(ctx->buffer);
		ctx->buffer = malloc(required_size);
		if (!ctx->buffer) {
			ctx->buffer_size = 0;
			return AVERROR(ENOMEM);
		}
		ctx->buffer_size = required_size;
	}

	double after_alloc = emscripten_get_now();

	// Copy frame data to contiguous buffer
	ret = av_image_copy_to_buffer(
		ctx->buffer,
		ctx->buffer_size,
		(const uint8_t * const *)ctx->frame->data,
		ctx->frame->linesize,
		ctx->frame->format,
		ctx->frame->width,
		ctx->frame->height,
		1
	);

	if (ret < 0) {
		return ret;
	}

	double after_copy = emscripten_get_now();

	printf("Timing: send=%.2fms receive=%.2fms alloc=%.2fms copy=%.2fms total=%.2fms\n",
		after_send - start,
		after_receive - after_send,
		after_alloc - after_receive,
		after_copy - after_alloc,
		after_copy - start);

	return 0;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_width(DecoderContext *ctx) {
	return ctx->frame->width;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_height(DecoderContext *ctx) {
	return ctx->frame->height;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_format(DecoderContext *ctx) {
	return ctx->frame->format;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_num_planes(DecoderContext *ctx) {
	return av_pix_fmt_count_planes(ctx->frame->format);
}

EMSCRIPTEN_KEEPALIVE
int get_frame_linesize(DecoderContext *ctx, int n) {
	return ctx->frame->linesize[n];
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_frame_data(DecoderContext *ctx, int n) {
	return ctx->frame->data[n];
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_frame_data_ptr(DecoderContext *ctx) {
	return ctx->buffer;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_data_size(DecoderContext *ctx) {
	return ctx->buffer_size;
}