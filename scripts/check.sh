#!/bin/bash
set -e

rm -rf dist/modules
tsc -p src --stripInternal false

rm -rf dist/packages
tsc -p tsconfig.packages.json

tsc -p tsconfig.vitest.json --noEmit

tsc -p scripts --noEmit

tsc -p tsconfig.vite.json --noEmit
