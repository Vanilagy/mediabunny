---
description: The @mediabunny/mjpeg extension provides an mjpeg encoding and encoding for browsers.
---

# @mediabunny/prores

Browsers don't support mjpeg in their WebCodecs implementations. This extension package provides a decoder and encoder for use with Mediabunny, allowing you to decode mjpeg in the browser. It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and the canvas API.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/mjpeg/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/mjpeg
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-mjpeg.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyMjpeg`. Use `mediabunny-mjpeg.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerMjpegDecoder, registerMjpegEncoder } from '@mediabunny/mjpeg';

registerMjpegDecoder();
registerMjpegEncoder();
```
