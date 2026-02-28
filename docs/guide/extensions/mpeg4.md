# @mediabunny/mpeg4

MPEG-4 Part 2 (also known as MPEG-4 Visual or DivX/Xvid) is a legacy video codec that was widely used in the 2000s. While modern browsers don't support it in WebCodecs, this extension package provides both encoder and decoder implementations for use with Mediabunny. It uses a highly-performant WASM build of the [Xvid codec](https://www.xvid.com/) under the hood.

**Bundle size:** 566 KB WASM (~150-200 KB gzipped)

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/mpeg4/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/mpeg4
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-mpeg4.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyMpeg4`. Use `mediabunny-mpeg4.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerMpeg4Decoder, registerMpeg4Encoder } from '@mediabunny/mpeg4';

registerMpeg4Decoder();
registerMpeg4Encoder();
```
That's it - Mediabunny now uses the registered MPEG-4 encoder and decoder automatically.

If you only need decoding (e.g., for playing back old video files), you can register just the decoder:
```ts
import { registerMpeg4Decoder } from '@mediabunny/mpeg4';

registerMpeg4Decoder();
```

## Example

Here, we convert an old AVI file with MPEG-4 video to a modern MP4 with H.264:

```ts
import {
    Input,
    ALL_FORMATS,
    BlobSource,
    Output,
    BufferTarget,
    Mp4OutputFormat,
    Conversion,
} from 'mediabunny';
import { registerMpeg4Decoder } from '@mediabunny/mpeg4';

registerMpeg4Decoder();

const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
});
const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
});

const conversion = await Conversion.init({
    input,
    output,
    videoCodec: 'avc', // Transcode to H.264
});
await conversion.execute();

output.target.buffer; // => ArrayBuffer containing the MP4 file
```

## Implementation details

This library implements MPEG-4 Part 2 encoder and decoder by registering custom coder classes with Mediabunny. Each coder, when initialized, spawns a worker which loads a WASM build of the Xvid codec. Raw YUV frames are sent to the worker for encoding, or compressed MPEG-4 bitstream data is sent for decoding.

The WASM build is optimized for size and performance, with all unnecessary features disabled. The codec supports all MPEG-4 profiles including Simple Profile and Advanced Simple Profile.