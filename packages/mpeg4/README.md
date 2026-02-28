# @mediabunny/mpeg4-decoder

MPEG-4 Part 2 (XVID/DIVX) decoder extension for Mediabunny, based on Xvid.

Browsers have no native support for MPEG-4 Part 2 video decoding (XVID/DIVX). This extension package provides an MPEG-4 Part 2 decoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny). It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses a highly-performant WASM build of the [Xvid decoder](https://www.xvid.com/) under the hood.

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/mpeg4-decoder
```

## Usage

```ts
import { registerMpeg4Decoder } from '@mediabunny/mpeg4-decoder';

registerMpeg4Decoder();
```

That's it - Mediabunny can now decode XVID/DIVX videos in AVI files.

## Example

Playing an AVI file with XVID video:

```ts
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';
import { registerMpeg4Decoder } from '@mediabunny/mpeg4-decoder';

registerMpeg4Decoder();

const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
});

const videoTrack = await input.getPrimaryVideoTrack();
// Now you can decode XVID video!
```

## License

`@mediabunny/mpeg4-decoder` uses the same MPL-2.0 license as Mediabunny. The Xvid decoder is licensed under GPL.

## Building and development

Building this library is done using the build commands in the [Mediabunny root](https://github.com/Vanilagy/mediabunny).

For simplicity, all built WASM artifacts should be included in the repo. Here are the instructions for building them from scratch:

### Prerequisites

[Install Emscripten](https://emscripten.org/docs/getting_started/downloads.html). The recommended way is using the emsdk.

### Compiling Xvid:

Download Xvid source code:
```bash
svn checkout https://svn.xvid.org/trunk xvid
cd xvid/build/generic
```

Configure and build as static library:
```bash
emconfigure ./configure \
    CFLAGS="-DNDEBUG -O3 -msimd128" \
    --disable-shared \
    --disable-assembly

emmake make
```

This generates `libxvidcore.a`. Copy it to `packages/mpeg4-decoder/build/`.

### Compiling the Xvid bridge:

In `packages/mpeg4-decoder`:

```bash
emcc src/xvid-bridge.c build/libxvidcore.a \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web,worker \
    -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
    -s EXPORTED_FUNCTIONS=_malloc,_free \
    -msimd128 \
    -O3 \
    -o build/xvid.js
```

This generates `build/xvid.js`.

### Building the package

Then build the complete package:
```bash
cd ../..  # Back to mediabunny root
npm run build
```