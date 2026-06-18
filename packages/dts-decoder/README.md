# @mediabunny/dts-decoder

[![](https://img.shields.io/npm/v/@mediabunny/dts-decoder)](https://www.npmjs.com/package/@mediabunny/dts-decoder)
[![](https://img.shields.io/bundlephobia/minzip/@mediabunny/dts-decoder)](https://bundlephobia.com/package/@mediabunny/dts-decoder)
[![](https://img.shields.io/npm/dm/@mediabunny/dts-decoder)](https://www.npmjs.com/package/@mediabunny/dts-decoder)
[![](https://img.shields.io/discord/1390044844285497344?logo=discord&label=Discord)](https://discord.gg/hmpkyYuS4U)

<div align="center">
    <img src="../../docs/public/mediabunny-logo.svg" width="180" height="180">
</div>

Browsers have no support for DTS in their WebCodecs implementations. This extension package provides a decoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny), allowing you to decode DTS audio directly in the browser. It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s DTS decoder under the hood.

> This package, like the rest of Mediabunny, is enabled by its [sponsors](https://mediabunny.dev/#sponsors) and their donations. If you've derived value from this package, please consider [leaving a donation](https://github.com/sponsors/Vanilagy)!

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/dts-decoder
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-dts-decoder.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyDtsDecoder`. Use `mediabunny-dts-decoder.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerDtsDecoder } from '@mediabunny/dts-decoder';

registerDtsDecoder();
```
That's it - Mediabunny now uses the registered DTS decoder automatically.

## Building and development

For simplicity, all built WASM artifacts are included in the repo, since these rarely change. However, here are the instructions for building them from scratch:

[Install Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and clone [FFmpeg](https://github.com/FFmpeg/FFmpeg). Then, from the Mediabunny root and with Emscripten sourced in:

```bash
export FFMPEG_PATH=/path/to/ffmpeg
export MEDIABUNNY_ROOT=$PWD

# Build FFmpeg
cd $FFMPEG_PATH
emmake make distclean
emconfigure ./configure \
    --target-os=none \
    --arch=x86_32 \
    --enable-cross-compile \
    --disable-asm \
    --disable-x86asm \
    --disable-inline-asm \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-all \
    --disable-everything \
    --disable-autodetect \
    --disable-pthreads \
    --disable-runtime-cpudetect \
    --enable-avcodec \
    --enable-decoder=dca \
    --enable-parser=dca \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto -msimd128" \
    --extra-ldflags="-Oz -flto"
emmake make

# Compile the bridge between JavaScript and FFmpeg's API
cd $MEDIABUNNY_ROOT/packages/dts-decoder
emcc src/bridge.c \
    $FFMPEG_PATH/libavcodec/libavcodec.a \
    $FFMPEG_PATH/libavutil/libavutil.a \
    -I$FFMPEG_PATH \
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
    -o build/dts.js
```

This generates `build/dts.js`, which contains both the JavaScript "glue code" as well as the compiled WASM inlined.

### Building the package

Then, the complete JavaScript package can be built alongside the rest of Mediabunny by running `npm run build` in Mediabunny's root.
