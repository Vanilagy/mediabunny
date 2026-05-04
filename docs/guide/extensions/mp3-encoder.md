---
description: The @mediabunny/mp3-encoder extension provides a highly-performant MP3 encoder polyfill for use in the browser and on the server.
---

# @mediabunny/mp3-encoder

Browsers typically have no support for MP3 encoding in their WebCodecs implementations. Given the ubiquity of the format, this extension package provides an MP3 encoder for use with Mediabunny. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a highly-performant WASM build of the [LAME MP3 Encoder](https://lame.sourceforge.io/) under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/mp3-encoder/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

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

## Implementation details

This library implements an MP3 encoder by registering a custom encoder class with Mediabunny. This class, when initialized, spawns a worker which then immediately loads a WASM build of the LAME MP3 encoder. Then, raw data is sent to the worker and encoded data is received from it. These encoded chunks are then concatenated in the main thread and properly split into separate MP3 frames.

Great care was put into ensuring maximum compatibility of this package; it works with bundlers, directly in the browser, as well as in Node, Deno, and Bun. All code (including worker & WASM) are bundled into a single file, eliminating the need for CDNs or WASM path arguments. This packages therefore serves as a reference implementation of WASM-based encoder extensions for Mediabunny.

The WASM build itself is a performance-optimized, SIMD-enabled build of LAME 3.100, with all unneeded features disabled. Because maximum performance was the priority, the build is slighter bigger, but ~130 kB gzipped is still very reasonable in my opinion. In my tests, it encodes 5 seconds of audio in ~90 milliseconds (55x real-time speed).