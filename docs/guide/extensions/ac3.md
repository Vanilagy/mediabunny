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

## Usage

```ts
import { registerAc3Decoder, registerAc3Encoder } from '@mediabunny/ac3';

registerAc3Decoder();
registerAc3Encoder();
```
That's it - Mediabunny now uses the registered AC-3/E-AC-3 decoder and encoder automatically.
