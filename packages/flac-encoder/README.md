# @mediabunny/flac-encoder

[![](https://img.shields.io/npm/v/@mediabunny/flac-encoder)](https://www.npmjs.com/package/@mediabunny/flac-encoder)
[![](https://img.shields.io/bundlephobia/minzip/@mediabunny/flac-encoder)](https://bundlephobia.com/package/@mediabunny/flac-encoder)
[![](https://img.shields.io/npm/dm/@mediabunny/flac-encoder)](https://www.npmjs.com/package/@mediabunny/flac-encoder)
[![](https://img.shields.io/discord/1390044844285497344?logo=discord&label=Discord)](https://discord.gg/hmpkyYuS4U)

<div align="center">
    <img src="../../docs/public/mediabunny-logo.svg" width="180" height="180">
</div>

No browser currently supports FLAC encoding in their WebCodecs implementations. This extension package provides a reliable FLAC encoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny). It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [libFLAC](https://github.com/xiph/flac) under the hood.

> This package, like the rest of Mediabunny, is enabled by its [sponsors](https://mediabunny.dev/#sponsors) and their donations. If you've derived value from this package, please consider [leaving a donation](https://github.com/sponsors/Vanilagy)! 💘

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/flac-encoder
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-flac-encoder.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyFlacEncoder`. Use `mediabunny-flac-encoder.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerFlacEncoder } from '@mediabunny/flac-encoder';

registerFlacEncoder();
```
That's it - Mediabunny now uses the registered FLAC encoder automatically.

If you want to be more correct, check for native browser support first:
```ts
import { canEncodeAudio } from 'mediabunny';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';

if (!(await canEncodeAudio('flac'))) {
    registerFlacEncoder();
}
```

## Example

Here, we convert an input file to a FLAC file:

```ts
import {
    Input,
    ALL_FORMATS,
    BlobSource,
    Output,
    BufferTarget,
    FlacOutputFormat,
    canEncodeAudio,
    Conversion,
} from 'mediabunny';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';

if (!(await canEncodeAudio('flac'))) {
    registerFlacEncoder();
}

const input = new Input({
    source: new BlobSource(file), // From a file picker, for example
    formats: ALL_FORMATS,
});
const output = new Output({
    format: new FlacOutputFormat(),
    target: new BufferTarget(),
});

const conversion = await Conversion.init({
    input,
    output,
});
await conversion.execute();

output.target.buffer; // => ArrayBuffer containing the FLAC file
```

For more ways of using Mediabunny, refer to its [guide](https://mediabunny.dev/guide/introduction).

## Building and development

For simplicity, all built WASM artifacts are included in the repo, since these rarely change. However, here are the instructions for building them from scratch:

[Install Emscripten](https://emscripten.org/docs/getting_started/downloads.html), install CMake, and clone [libFLAC](https://github.com/xiph/flac). Then, from the Mediabunny root and with Emscripten sourced in:

```bash
export FLAC_PATH=/path/to/flac
export MEDIABUNNY_ROOT=$PWD

cd $FLAC_PATH
mkdir -p build && cd build
emcmake cmake .. \
    -DBUILD_PROGRAMS=OFF \
    -DBUILD_CXXLIBS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_TESTING=OFF \
    -DWITH_OGG=OFF \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_MULTITHREADING=OFF \
    -DINSTALL_MANPAGES=OFF \
    -DCMAKE_C_FLAGS="-DNDEBUG -Oz -flto -msimd128"
emmake make

# Compile the bridge between JavaScript and libFLAC's API
cd $MEDIABUNNY_ROOT/packages/flac-encoder
emcc src/bridge.c \
    $FLAC_PATH/build/src/libFLAC/libFLAC.a \
    -I$FLAC_PATH/include \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web,worker \
    -s FILESYSTEM=0 \
    -s MALLOC=emmalloc \
    -s SUPPORT_LONGJMP=0 \
    -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
    -s EXPORTED_FUNCTIONS=_malloc,_free \
    -msimd128 \
    -flto \
    -Oz \
    -o build/flac.js
```

This generates `build/flac.js`, which contains both the JavaScript "glue code" as well as the compiled WASM inlined.

### Building the package

Then, the complete JavaScript package can be built alongside the rest of Mediabunny by running `npm run build` in Mediabunny's root.
