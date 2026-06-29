---
description: The @mediabunny/prores extension provides an extremely fast Apple ProRes decoder for the browser.
---

# @mediabunny/prores

Browsers have no support for Apple ProRes in their WebCodecs implementations. This extension package provides a decoder for use with Mediabunny, allowing you to decode ProRes directly in the browser at unprecedented speed. It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses [TurboRes](https://github.com/Vanilagy/turbores), an extremely fast WASM-based ProRes decoder, under the hood.

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/prores/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/prores
```

Alternatively, directly include them using a script tag:
```html
<script src="mediabunny.js"></script>
<script src="mediabunny-prores.js"></script>
```

This will expose the global objects `Mediabunny` and `MediabunnyProres`. Use `mediabunny-prores.d.ts` to provide types for these globals. You can download the built distribution files from the [releases page](https://github.com/Vanilagy/mediabunny/releases).

## Usage

```ts
import { registerProresDecoder } from '@mediabunny/prores';

registerProresDecoder();
```
That's it - Mediabunny now uses the registered ProRes decoder automatically.
