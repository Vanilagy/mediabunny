# @mediabunny/flac-encoder

No browser currently supports FLAC encoding in their WebCodecs implementations. This extension package provides a reliable FLAC encoder for use with Mediabunny. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [libFLAC](https://github.com/xiph/flac) (the reference FLAC encoder) under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/flac-encoder/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

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
