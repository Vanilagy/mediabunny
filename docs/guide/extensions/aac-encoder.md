# @mediabunny/aac-encoder

Some browsers lack support for AAC encoding in their WebCodecs implementations. This extension package provides a reliable AAC-LC encoder for use with Mediabunny. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s AAC encoder under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/aac-encoder/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

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
