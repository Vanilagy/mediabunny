# @mediabunny/prores

[![](https://img.shields.io/npm/v/@mediabunny/prores)](https://www.npmjs.com/package/@mediabunny/prores)
[![](https://img.shields.io/bundlephobia/minzip/@mediabunny/prores)](https://bundlephobia.com/package/@mediabunny/prores)
[![](https://img.shields.io/npm/dm/@mediabunny/prores)](https://www.npmjs.com/package/@mediabunny/prores)
[![](https://img.shields.io/discord/1390044844285497344?logo=discord&label=Discord)](https://discord.gg/hmpkyYuS4U)

<div align="center">
    <img src="../../docs/public/mediabunny-logo.svg" width="180" height="180">
</div>

Browsers have no support for Apple ProRes in their WebCodecs implementations. This extension package provides a decoder for use with [Mediabunny](https://github.com/Vanilagy/mediabunny), allowing you to decode ProRes directly in the browser at unprecedented speed. It is implemented using Mediabunny's [custom coder API](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) and uses [TurboRes](https://github.com/Vanilagy/turbores), an extremely fast WASM-based ProRes decoder, under the hood.

> This package, like the rest of Mediabunny, is enabled by its [sponsors](https://mediabunny.dev/#sponsors) and their donations. If you've derived value from this package, please consider [leaving a donation](https://github.com/sponsors/Vanilagy)! 💘

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

## Setup

`@mediabunny/prores` can make use of shared-memory multithreading to achieve maximum performance. To enable this in browsers, your website must be cross-origin isolated by setting the following response headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Alternatively, you can use:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```
which is generally more permissive but is not supported in Safari (of course).

---

If you cannot enable cross-origin isolation, `@mediabunny/prores` will fall back to a slower multithreading algorithm.

## Usage

```ts
import { registerProresDecoder } from '@mediabunny/prores';

registerProresDecoder();
```
That's it - Mediabunny now uses the registered ProRes decoder automatically.

For all the ways of using Mediabunny, refer to its [guide](https://mediabunny.dev/guide/introduction).

## Building and development

The complete JavaScript package can be built alongside the rest of Mediabunny by running `npm run build` in Mediabunny's root.
