#!/bin/bash
set -e

rm -rf dist/modules
tsc -p src --stripInternal false

rm -rf packages/mp3-encoder/dist/modules
tsc -p packages/mp3-encoder

rm -rf packages/ac3/dist/modules
tsc -p packages/ac3

rm -rf packages/aac-encoder/dist/modules
tsc -p packages/aac-encoder

rm -rf packages/flac-encoder/dist/modules
tsc -p packages/flac-encoder

tsc -p tsconfig.vitest.json --noEmit

tsc -p scripts --noEmit

tsc -p tsconfig.vite.json --noEmit
