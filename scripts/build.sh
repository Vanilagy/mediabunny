#!/bin/bash
set -e

# This script must be executed via `npm run build`

LOOSE=false
if [ "$1" = "--loose" ]; then
	LOOSE=true
fi

if [ "$LOOSE" = true ]; then
	API_EXTRACTOR_FLAGS="--local"
else
	API_EXTRACTOR_FLAGS=""
fi

# Clear the stuff from last build
rm -rf dist
rm -rf packages/mp3-encoder/dist
rm -rf packages/ac3/dist
rm -rf packages/aac-encoder/dist
rm -rf packages/flac-encoder/dist
rm -rf packages/prores/dist
rm -rf packages/server/dist

# Ensure license headers on all source files
tsx scripts/ensure-license-headers.ts

# Type check & generate .js and .d.ts files
tsc -p src --stripInternal false # Don't strip internals since the packages may use them
tsc -p packages/mp3-encoder
tsc -p packages/ac3
tsc -p packages/aac-encoder
tsc -p packages/flac-encoder
tsc -p packages/prores
tsc -p packages/server

# Generate the root again, now with internals properly stripped
rm -rf dist
tsc -p src

# So that the resulting files use valid ESM imports with file extension. This only runs for the core Mediabunny as only
# it ships the individual files to npm (for tree shaking, because it's large)
npm run fix-build-import-paths

# Creates bundles for all packages
tsx scripts/bundle.ts

# Declaration file rollup and checks
api-extractor run $API_EXTRACTOR_FLAGS
api-extractor run $API_EXTRACTOR_FLAGS -c packages/mp3-encoder/api-extractor.json
api-extractor run $API_EXTRACTOR_FLAGS -c packages/ac3/api-extractor.json
api-extractor run $API_EXTRACTOR_FLAGS -c packages/aac-encoder/api-extractor.json
api-extractor run $API_EXTRACTOR_FLAGS -c packages/flac-encoder/api-extractor.json
api-extractor run $API_EXTRACTOR_FLAGS -c packages/prores/api-extractor.json
api-extractor run $API_EXTRACTOR_FLAGS -c packages/server/api-extractor.json

if [ "$LOOSE" = false ]; then
	# Checks that all symbols are documented
	tsx scripts/check-docblocks.ts dist/mediabunny.d.ts
	tsx scripts/check-docblocks.ts packages/mp3-encoder/dist/mediabunny-mp3-encoder.d.ts
	tsx scripts/check-docblocks.ts packages/ac3/dist/mediabunny-ac3.d.ts
	tsx scripts/check-docblocks.ts packages/aac-encoder/dist/mediabunny-aac-encoder.d.ts
	tsx scripts/check-docblocks.ts packages/flac-encoder/dist/mediabunny-flac-encoder.d.ts
	tsx scripts/check-docblocks.ts packages/prores/dist/mediabunny-prores.d.ts
	tsx scripts/check-docblocks.ts packages/server/dist/mediabunny-server.d.ts

	# Checks that API docs are generatable
	npm run docs:generate -- --dry
fi

# Appends stuff to the declaration files to register the global variables these libraries expose
echo 'export as namespace Mediabunny;' >> dist/mediabunny.d.ts
echo 'export as namespace MediabunnyMp3Encoder;' >> packages/mp3-encoder/dist/mediabunny-mp3-encoder.d.ts
echo 'export as namespace MediabunnyAc3;' >> packages/ac3/dist/mediabunny-ac3.d.ts
echo 'export as namespace MediabunnyAacEncoder;' >> packages/aac-encoder/dist/mediabunny-aac-encoder.d.ts
echo 'export as namespace MediabunnyFlacEncoder;' >> packages/flac-encoder/dist/mediabunny-flac-encoder.d.ts
echo 'export as namespace MediabunnyProres;' >> packages/prores/dist/mediabunny-prores.d.ts
echo 'export as namespace MediabunnyServer;' >> packages/server/dist/mediabunny-server.d.ts
