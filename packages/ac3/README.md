# @mediabunny/ac3

[![](https://img.shields.io/npm/v/@mediabunny/ac3)](https://www.npmjs.com/package/@mediabunny/ac3)
[![](https://img.shields.io/bundlephobia/minzip/@mediabunny/ac3)](https://bundlephobia.com/package/@mediabunny/ac3)
[![](https://img.shields.io/npm/dm/@mediabunny/ac3)](https://www.npmjs.com/package/@mediabunny/ac3)
[![](https://img.shields.io/discord/1390044844285497344?logo=discord&label=Discord)](https://discord.gg/hmpkyYuS4U)

<div align="center">
    <img src="../../docs/public/mediabunny-logo.svg" width="180" height="180">
</div>

Browsers have no support for AC-3 (Dolby Digital) or E-AC-3 (Dolby Digital Plus) in their WebCodecs implementations. This extension package provides both a decoder and encoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny), allowing you to decode and encode these codecs directly in the browser. It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s AC-3 and E-AC-3 coders under the hood.

> This package, like the rest of Mediabunny, is enabled by its [sponsors](https://mediabunny.dev/#sponsors) and their donations. If you've derived value from this package, please consider [leaving a donation](https://github.com/sponsors/Vanilagy)! 💘

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/ac3
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-ac3.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyAc3`. Use `mediabunny-ac3.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';

registerAc3Decoder();
registerAc3Encoder();
```
That's it - Mediabunny now uses the registered AC-3/E-AC-3 decoder and encoder automatically.

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
    --enable-decoder=ac3 \
    --enable-decoder=eac3 \
    --enable-encoder=ac3 \
    --enable-encoder=eac3 \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto -msimd128" \
    --extra-ldflags="-Oz -flto"
emmake make

# Compile the bridge between JavaScript and FFmpeg's API
cd $MEDIABUNNY_ROOT/packages/ac3
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
    -o build/ac3.js
```

This generates `build/ac3.js`, which contains both the JavaScript "glue code" as well as the compiled WASM inlined.

### Building the package

Then, the complete JavaScript package can be built alongside the rest of Mediabunny by running `npm run build` in Mediabunny's root.
