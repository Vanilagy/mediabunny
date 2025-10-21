#!/bin/bash

set -e

emcc src/eac3-bridge.c lib/libavcodec.a lib/libavutil.a \
	-o build/eac3.js \
	-s EXPORTED_FUNCTIONS='["_init_decoder","_decode_packet","_flush_decoder","_close_decoder","_init_encoder","_encode_samples","_close_encoder","_malloc","_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8","HEAPF32"]' \
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1 \
	-s SINGLE_FILE=1 \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=33554432 \
	-s FILESYSTEM=0 \
	-s ENVIRONMENT=web,worker \
	-s WASM=1 \
	-I./lib \
	-O3 \
	-flto \
	--closure 1

echo "EAC3 bridge built successfully!"
