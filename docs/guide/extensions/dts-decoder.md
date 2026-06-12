---
description: The @mediabunny/dts-decoder extension provides a fast DTS decoder for both browser and server environments.
---

# @mediabunny/dts-decoder

Browsers have no support for DTS in their WebCodecs implementations. This extension package provides a decoder for use with Mediabunny, allowing you to decode DTS audio directly in the browser. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s DTS decoder under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/dts-decoder/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/dts-decoder
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-dts-decoder.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyDtsDecoder`. Use `mediabunny-dts-decoder.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerDtsDecoder } from '@mediabunny/dts-decoder';

registerDtsDecoder();
```
That's it - Mediabunny now uses the registered DTS decoder automatically.
