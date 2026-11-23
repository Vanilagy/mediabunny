---
description: The @mediabunny/truehd extension provides fast Dolby TrueHD decoders and encoders for both browser and server environments.
---

# @mediabunny/truehd

Browsers have no support for the Dolby TrueHD audio codec in their WebCodecs implementations. This extension package provides both a decoder and encoder for use with Mediabunny, allowing you to decode and encode this codec directly in the browser. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s TrueHD coders under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/truehd/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/truehd
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-truehd.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyTrueHd`. Use `mediabunny-truehd.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

### Content Security Policy

The decoder and encoder run in a Web Worker, which by default is created from a `blob:` URL. If your Content Security Policy doesn't allow that, host `mediabunny-truehd.worker.js` yourself and point the extension to it before decoding or encoding starts:
```js
globalThis[Symbol.for('@mediabunny/truehd:workerUrl')] = '/path/to/mediabunny-truehd.worker.js';
```
The value must be a string or `URL`. You can download the worker file from the [releases page](https://github.com/Vanilagy/mediabunny/releases); it's also included in the npm package under `dist/bundles/`. Since the codecs use WebAssembly, your policy must also allow `'wasm-unsafe-eval'` in `script-src`.

## Usage

```ts
import { registerTrueHdDecoder, registerTrueHdEncoder } from '@mediabunny/truehd';

registerTrueHdDecoder();
registerTrueHdEncoder();
```
That's it - Mediabunny now uses the registered TrueHD decoder and encoder automatically.
