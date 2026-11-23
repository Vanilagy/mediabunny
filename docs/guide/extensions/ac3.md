---
description: The @mediabunny/ac3 extension provides fast AC-3 and E-AC-3 decoders and encoders for both browser and server environments.
---

# @mediabunny/ac3

Browsers have no support for AC-3 (Dolby Digital) or E-AC-3 (Dolby Digital Plus) in their WebCodecs implementations. This extension package provides both a decoder and encoder for use with Mediabunny, allowing you to decode and encode these codecs directly in the browser. It is implemented using Mediabunny's [custom coder API](../supported-formats-and-codecs#custom-coders) and uses a fast, size-optimized WASM build of [FFmpeg](https://ffmpeg.org/)'s AC-3 and E-AC-3 coders under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/ac3/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/ac3
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-ac3.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyAc3`. Use `mediabunny-ac3.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

### Content Security Policy

The decoder and encoder run in a Web Worker, which by default is created from a `blob:` URL. If your Content Security Policy doesn't allow that, host `mediabunny-ac3.worker.js` yourself and point the extension to it before decoding or encoding starts:
```js
globalThis[Symbol.for('@mediabunny/ac3:workerUrl')] = '/path/to/mediabunny-ac3.worker.js';
```
The value must be a string or `URL`. You can download the worker file from the [releases page](https://github.com/Vanilagy/mediabunny/releases); it's also included in the npm package under `dist/bundles/`. Since the codecs use WebAssembly, your policy must also allow `'wasm-unsafe-eval'` in `script-src`.

## Usage

```ts
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';

registerAc3Decoder();
registerAc3Encoder();
```
That's it - Mediabunny now uses the registered AC-3/E-AC-3 decoder and encoder automatically.
