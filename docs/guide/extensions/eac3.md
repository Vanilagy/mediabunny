# @mediabunny/eac3

E-AC-3 (Enhanced AC-3, also known as Dolby Digital Plus) and AC-3 (Dolby Digital) are professional audio codecs widely used in broadcast and streaming. Browsers don't support encoding or decoding these formats in WebCodecs, so this extension package provides both encoder and decoder implementations for use with Mediabunny. It uses a WASM build of [FFmpeg's AC-3 encoder/decoder](https://ffmpeg.org/) under the hood.

**Bundle size:** 893 KB WASM (~250-300 KB gzipped)

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/eac3/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/eac3
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-eac3.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyEac3`. Use `mediabunny-eac3.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerEac3Decoder, registerEac3Encoder } from '@mediabunny/eac3';

registerEac3Decoder();
registerEac3Encoder();
```
That's it - Mediabunny now uses the registered E-AC-3/AC-3 encoder and decoder automatically for both `'eac3'` and `'ac3'` codecs.

If you only need decoding (e.g., for playing back files with Dolby audio), you can register just the decoder:
```ts
import { registerEac3Decoder } from '@mediabunny/eac3';

registerEac3Decoder();
```

## Example

Here, we extract E-AC-3 audio from an MP4 file:

```ts
import {
    Input,
    ALL_FORMATS,
    BlobSource,
    Output,
    BufferTarget,
    AdtsOutputFormat,
    Conversion,
} from 'mediabunny';
import { registerEac3Decoder } from '@mediabunny/eac3';

registerEac3Decoder();

const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
});
const output = new Output({
    format: new AdtsOutputFormat(),
    target: new BufferTarget(),
});

const conversion = await Conversion.init({
    input,
    output,
    audioCodec: 'aac', // Transcode E-AC-3 to AAC
});
await conversion.execute();

output.target.buffer; // => ArrayBuffer containing the AAC file
```

## Supported codecs

This extension supports both:
- `'eac3'` - Enhanced AC-3 (Dolby Digital Plus) - up to 7.1 channels
- `'ac3'` - AC-3 (Dolby Digital) - up to 5.1 channels

## Implementation details

This library implements E-AC-3 and AC-3 encoder/decoder by registering custom coder classes with Mediabunny. Each coder, when initialized, spawns a worker which loads a WASM build of FFmpeg's libavcodec. Raw PCM audio is sent to the worker for encoding, or compressed AC-3 bitstream data is sent for decoding.

The WASM build includes only the AC-3 codec components from FFmpeg, optimized for size. Both encoding and decoding support all standard bitrates and channel configurations.