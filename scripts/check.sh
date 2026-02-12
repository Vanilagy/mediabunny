#!/bin/bash
set -e

rm -rf dist/modules
tsc -p src --stripInternal false

tsc -p packages/mp3-encoder --noEmit

rm -rf packages/ac3/dist/modules
tsc -p packages/ac3

tsc -p tsconfig.vitest.json --noEmit

tsc -p scripts --noEmit

tsc -p tsconfig.vite.json --noEmit
