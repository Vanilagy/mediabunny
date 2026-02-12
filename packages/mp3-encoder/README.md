# @mediabunny/mp3-encoder

[![](https://img.shields.io/npm/v/@mediabunny/mp3-encoder)](https://www.npmjs.com/package/@mediabunny/mp3-encoder)
[![](https://img.shields.io/bundlephobia/minzip/@mediabunny/mp3-encoder)](https://bundlephobia.com/package/@mediabunny/mp3-encoder)
[![](https://img.shields.io/npm/dm/@mediabunny/mp3-encoder)](https://www.npmjs.com/package/@mediabunny/mp3-encoder)

<div align="center">
    <img src="./logo.svg" width="180" height="180">
</div>

Browsers typically have no support for MP3 encoding in their WebCodecs implementations. Given the ubiquity of the format, this extension package provides an MP3 encoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny). It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses a highly-performant WASM build of the [LAME MP3 Encoder](https://lame.sourceforge.io/) under the hood.

> This package, like the rest of Mediabunny, is enabled by its [sponsors](https://mediabunny.dev/#sponsors) and their donations. If you've derived value from this package, please consider [leaving a donation](https://github.com/sponsors/Vanilagy)! 💘

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/mp3-encoder
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-mp3-encoder.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyMp3Encoder`. Use `mediabunny-mp3-encoder.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

registerMp3Encoder();
```
That's it - Mediabunny now uses the registered MP3 encoder automatically.

If you want to be more correct, check for native browser support first:
```ts
import { canEncodeAudio } from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

if (!(await canEncodeAudio('mp3'))) {
    registerMp3Encoder();
}
```

## Example

Here, we convert an input file to an MP3:

```ts
import {
    Input,
    ALL_FORMATS,
    BlobSource,
    Output,
    BufferTarget,
    Mp3OutputFormat,
    canEncodeAudio,
    Conversion,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

if (!(await canEncodeAudio('mp3'))) {
    // Only register the custom encoder if there's no native support
    registerMp3Encoder();
}

const input = new Input({
    source: new BlobSource(file), // From a file picker, for example
    formats: ALL_FORMATS,
});
const output = new Output({
    format: new Mp3OutputFormat(),
    target: new BufferTarget(),
});

const conversion = await Conversion.init({
    input,
    output,
});
await conversion.execute();

output.target.buffer; // => ArrayBuffer containing the MP3 file
```

For more ways of using Mediabunny, refer to its [guide](https://mediabunny.dev/guide/introduction).

## License

`@mediabunny/mp3-encoder` uses [the same MPL-2.0 license](https://sourceforge.net/projects/lame/files/lame/) as Mediabunny. The LAME MP3 Encoder is licensed under LGPL. On their [license page](https://lame.sourceforge.io/license.txt), they ask that you give them a shoutout with a link.

## Implementation details

This library implements an MP3 encoder by registering a custom encoder class with Mediabunny. This class, when initialized, spawns a worker which then immediately loads a WASM build of the LAME MP3 encoder. Then, raw data is sent to the worker and encoded data is received from it. These encoded chunks are then concatenated in the main thread and properly split into separate MP3 frames.

Great care was put into ensuring maximum compatibility of this package; it works with bundlers, directly in the browser, as well as in Node, Deno, and Bun. All code (including worker & WASM) are bundled into a single file, eliminating the need for CDNs or WASM path arguments. This packages therefore serves as a reference implementation of WASM-based encoder extensions for Mediabunny.

The WASM build itself is a performance-optimized, SIMD-enabled build of LAME 3.100, with all unneeded features disabled. Because maximum performance was the priority, the build is slighter bigger, but ~130 kB gzipped is still very reasonable in my opinion. In my tests, it encodes 5 seconds of audio in ~90 milliseconds (55x real-time speed).

## Building and development

For simplicity, all built WASM artifacts are included in the repo, since these rarely change. However, here are the instructions for building them from scratch:

### Prerequisites

[Install Emscripten](https://emscripten.org/docs/getting_started/downloads.html). The recommended way is using the emsdk, which involves cloning a repo and running a few commands. The following commands assume Emscripten is sourced in.

### Compiling LAME:

[Download the LAME source code](https://sourceforge.net/projects/lame/files/lame/) from SourceForge. Then, in the folder:

```bash
emconfigure ./configure \
    CFLAGS="-DNDEBUG -DNO_STDIO -O3 -msimd128" \
    --disable-dependency-tracking \
    --disable-shared \
    --disable-gtktest \
    --disable-analyzer-hooks \
    --disable-decoder \
    --disable-frontend

emmake make clean
emmake make
```

This generates `libmp3lame.a`, located in `libmp3lame/.libs`.

### Compiling the LAME bridge:

Now with LAME built, we must build the C code at `src/lame-bridge.c` containing a lean bridge interface between JavaScript and LAME's API. Clone Mediabunny, and then, in `packages/mp3-encoder` and with `build/libmp3lame.a` in place, run:

```bash
emcc src/lame-bridge.c build/libmp3lame.a \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web,worker \
    -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
    -s EXPORTED_FUNCTIONS=_malloc,_free \
    -msimd128 \
    -O3 \
    -o build/lame.js
```

This generates `build/lame.js`, which contains both the JavaScript "glue code" as well as the compiled WASM inlined.

### Building the package

Then, the complete JavaScript package can be built alongside the rest of Mediabunny by running `npm run build` in Mediabunny's root.