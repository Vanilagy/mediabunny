# @mediabunny/aac-encoder

[![](https://img.shields.io/npm/v/@mediabunny/aac-encoder)](https://www.npmjs.com/package/@mediabunny/aac-encoder)
[![](https://img.shields.io/bundlephobia/minzip/@mediabunny/aac-encoder)](https://bundlephobia.com/package/@mediabunny/aac-encoder)
[![](https://img.shields.io/npm/dm/@mediabunny/aac-encoder)](https://www.npmjs.com/package/@mediabunny/aac-encoder)
[![](https://img.shields.io/discord/1390044844285497344?logo=discord&label=Discord)](https://discord.gg/hmpkyYuS4U)

<div align="center">
    <img src="../../docs/public/mediabunny-logo.svg" width="180" height="180">
</div>

Some browsers lack support for AAC encoding in their WebCodecs implementations. This extension package provides a reliable AAC-LC encoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny). It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s AAC encoder under the hood.

> This package, like the rest of Mediabunny, is enabled by its [sponsors](https://mediabunny.dev/#sponsors) and their donations. If you've derived value from this package, please consider [leaving a donation](https://github.com/sponsors/Vanilagy)! 💘

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/aac-encoder
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-aac-encoder.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyAacEncoder`. Use `mediabunny-aac-encoder.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerAacEncoder } from '@mediabunny/aac-encoder';

registerAacEncoder();
```
That's it - Mediabunny now uses the registered AAC encoder automatically.

If you want to be more correct, check for native browser support first:
```ts
import { canEncodeAudio } from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';

if (!(await canEncodeAudio('aac'))) {
    registerAacEncoder();
}
```

## Example

Here, we convert an input file to an MP4 with AAC audio:

```ts
import {
    Input,
    ALL_FORMATS,
    BlobSource,
    Output,
    BufferTarget,
    Mp4OutputFormat,
    canEncodeAudio,
    Conversion,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';

if (!(await canEncodeAudio('aac'))) {
    // Only register the custom encoder if there's no native support
    registerAacEncoder();
}

const input = new Input({
    source: new BlobSource(file), // From a file picker, for example
    formats: ALL_FORMATS,
});
const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
});

const conversion = await Conversion.init({
    input,
    output,
});
await conversion.execute();

output.target.buffer; // => ArrayBuffer containing the MP4 file
```

For more ways of using Mediabunny, refer to its [guide](https://mediabunny.dev/guide/introduction).

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
    --enable-encoder=aac \
    --cc="emcc" \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-DNDEBUG -Oz -flto -msimd128" \
    --extra-ldflags="-Oz -flto"
emmake make

# Compile the bridge between JavaScript and FFmpeg's API
cd $MEDIABUNNY_ROOT/packages/aac-encoder
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
    -o build/aac.js
```

This generates `build/aac.js`, which contains both the JavaScript "glue code" as well as the compiled WASM inlined.

### Building the package

Then, the complete JavaScript package can be built alongside the rest of Mediabunny by running `npm run build` in Mediabunny's root.
