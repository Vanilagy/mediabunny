/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#include <emscripten.h>
#include <FLAC/stream_encoder.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define BITS_PER_SAMPLE 16
#define COMPRESSION_LEVEL 5

typedef struct {
	int size;
	int samples;
} FrameInfo;

typedef struct {
	FLAC__StreamEncoder *encoder;

	// Input buffer for interleaved int16 samples from JS
	int16_t *input_buffer;
	int input_buffer_size;

	// Widened to int32 for libFLAC
	FLAC__int32 *int32_buffer;
	int int32_buffer_size;

	// Contiguous output buffer for encoded frame data
	uint8_t *output_buffer;
	int output_size;
	int output_capacity;

	// Per-frame metadata so JS can split the output buffer into individual packets
	FrameInfo *frames;
	int frame_count;
	int frames_capacity;

	// Stream header captured during init (fLaC + metadata blocks)
	uint8_t *header_buffer;
	int header_size;
	int header_capacity;
	bool header_done;

	int channels;
} EncoderContext;

static void ensure_output_capacity(EncoderContext *ctx, int needed) {
	if (needed <= ctx->output_capacity) {
		return;
	}

	int new_capacity = ctx->output_capacity;
	if (new_capacity < 4096) {
		new_capacity = 4096;
	}
	while (new_capacity < needed) {
		new_capacity *= 2;
	}

	ctx->output_buffer = realloc(ctx->output_buffer, new_capacity);
	ctx->output_capacity = new_capacity;
}

static FLAC__StreamEncoderWriteStatus write_callback(
	const FLAC__StreamEncoder *encoder,
	const FLAC__byte buffer[],
	size_t bytes,
	uint32_t samples,
	uint32_t current_frame,
	void *client_data
) {
	EncoderContext *ctx = (EncoderContext *)client_data;

	// samples == 0 means this is metadata (stream header)
	if (samples == 0) {
		if (!ctx->header_done) {
			int needed = ctx->header_size + bytes;
			if (needed > ctx->header_capacity) {
				int new_cap = ctx->header_capacity < 256 ? 256 : ctx->header_capacity;
				while (new_cap < needed) { new_cap *= 2; }
				ctx->header_buffer = realloc(ctx->header_buffer, new_cap);
				ctx->header_capacity = new_cap;
			}
			memcpy(ctx->header_buffer + ctx->header_size, buffer, bytes);
			ctx->header_size += bytes;
		}

		return FLAC__STREAM_ENCODER_WRITE_STATUS_OK;
	}

	ctx->header_done = true;

	// Append encoded data
	ensure_output_capacity(ctx, ctx->output_size + bytes);
	memcpy(ctx->output_buffer + ctx->output_size, buffer, bytes);
	ctx->output_size += bytes;

	// Record frame metadata
	if (ctx->frame_count >= ctx->frames_capacity) {
		int new_cap = ctx->frames_capacity < 16 ? 16 : ctx->frames_capacity * 2;
		ctx->frames = realloc(ctx->frames, new_cap * sizeof(FrameInfo));
		ctx->frames_capacity = new_cap;
	}
	ctx->frames[ctx->frame_count].size = bytes;
	ctx->frames[ctx->frame_count].samples = samples;
	ctx->frame_count++;

	return FLAC__STREAM_ENCODER_WRITE_STATUS_OK;
}

static void reset_output(EncoderContext *ctx) {
	ctx->output_size = 0;
	ctx->frame_count = 0;
}

EMSCRIPTEN_KEEPALIVE
int init_encoder(int channels, int sample_rate) {
	EncoderContext *ctx = calloc(1, sizeof(EncoderContext));
	if (!ctx) {
		return 0;
	}

	ctx->channels = channels;

	ctx->encoder = FLAC__stream_encoder_new();
	if (!ctx->encoder) {
		free(ctx);
		return 0;
	}

	FLAC__stream_encoder_set_channels(ctx->encoder, channels);
	FLAC__stream_encoder_set_sample_rate(ctx->encoder, sample_rate);
	FLAC__stream_encoder_set_bits_per_sample(ctx->encoder, BITS_PER_SAMPLE);
	FLAC__stream_encoder_set_compression_level(ctx->encoder, COMPRESSION_LEVEL);
	FLAC__stream_encoder_set_verify(ctx->encoder, false);

	FLAC__StreamEncoderInitStatus status = FLAC__stream_encoder_init_stream(
		ctx->encoder,
		write_callback,
		NULL, // seek callback
		NULL, // tell callback
		NULL, // metadata callback
		ctx
	);

	if (status != FLAC__STREAM_ENCODER_INIT_STATUS_OK) {
		FLAC__stream_encoder_delete(ctx->encoder);
		free(ctx);
		return 0;
	}

	return (int)ctx;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_encode_input_ptr(int ctx_ptr, int size) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;

	if (size > ctx->input_buffer_size) {
		ctx->input_buffer = realloc(ctx->input_buffer, size);
		ctx->input_buffer_size = size;
	}

	return (uint8_t *)ctx->input_buffer;
}

EMSCRIPTEN_KEEPALIVE
int send_samples(int ctx_ptr, int num_samples) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;

	// Widen int16 to int32 for libFLAC
	int total = num_samples * ctx->channels;
	if (total > ctx->int32_buffer_size) {
		ctx->int32_buffer = realloc(ctx->int32_buffer, total * sizeof(FLAC__int32));
		ctx->int32_buffer_size = total;
	}
	for (int i = 0; i < total; i++) {
		ctx->int32_buffer[i] = ctx->input_buffer[i];
	}

	reset_output(ctx);

	FLAC__bool ok = FLAC__stream_encoder_process_interleaved(ctx->encoder, ctx->int32_buffer, num_samples);
	return ok ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_output_data(int ctx_ptr) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;
	return ctx->output_buffer;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_count(int ctx_ptr) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;
	return ctx->frame_count;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_size(int ctx_ptr, int index) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;
	return ctx->frames[index].size;
}

EMSCRIPTEN_KEEPALIVE
int get_frame_samples(int ctx_ptr, int index) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;
	return ctx->frames[index].samples;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *get_header_data(int ctx_ptr) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;
	return ctx->header_buffer;
}

EMSCRIPTEN_KEEPALIVE
int get_header_size(int ctx_ptr) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;
	return ctx->header_size;
}

EMSCRIPTEN_KEEPALIVE
int finish_encoder(int ctx_ptr) {
	EncoderContext *ctx = (EncoderContext *)ctx_ptr;

	reset_output(ctx);

	FLAC__bool ok = FLAC__stream_encoder_finish(ctx->encoder);
	if (!ok) {
		return -1;
	}

	// finish() leaves the encoder uninitialized but retains configuration (channels, sample rate,
	// etc.), so we just re-init the stream to be ready for the next batch of samples.
	ctx->header_size = 0;
	ctx->header_done = false;

	FLAC__StreamEncoderInitStatus status = FLAC__stream_encoder_init_stream(
		ctx->encoder,
		write_callback,
		NULL,
		NULL,
		NULL,
		ctx
	);

	return status == FLAC__STREAM_ENCODER_INIT_STATUS_OK ? 0 : -1;
}
