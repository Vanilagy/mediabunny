#!/bin/bash

set -e

emcc src/xvid-bridge.c lib/libxvidcore.a \
	-o build/xvid.js \
	-s EXPORTED_FUNCTIONS='["_init_decoder","_decode_frame","_close_decoder","_malloc","_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8"]' \
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1 \
	-s SINGLE_FILE=1 \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=16777216 \
	-s FILESYSTEM=0 \
	-s ENVIRONMENT=web,worker \
	-s WASM=1 \
	-I./lib \
	-O3 \
	-flto \
	--closure 1

echo "MPEG4 bridge built successfully!"
