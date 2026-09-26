---
description: The @mediabunny/dts extension provides fast DTS decoders and encoders for both browser and server environments.
---

# @mediabunny/dts

Browsers have no support for the DTS audio codec in their WebCodecs implementations. This extension package provides both a decoder and encoder for use with Mediabunny, allowing you to decode and encode this codec directly in the browser. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s DTS coders under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/dts/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/dts
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-dts.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyDts`. Use `mediabunny-dts.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerDtsDecoder, registerDtsEncoder } from '@mediabunny/dts';

registerDtsDecoder();
registerDtsEncoder();
```
That's it - Mediabunny now uses the registered DTS decoder and encoder automatically.
