---
description: Install Mediabunny using npm (or your favorite package manager), or include it directly as a <script> tag.
---

# Installation

Install Mediabunny using your favorite package manager:

::: code-group
```bash [npm]
npm install mediabunny
```
```bash [yarn]
yarn add mediabunny
```
```bash [pnpm]
pnpm add mediabunny
```
```bash [bun]
bun add mediabunny
```
:::

::: info
Requires any JavaScript environment that can run ECMAScript 2021 or later. Mediabunny is expected to be run in modern browsers. For types, TypeScript 5.7 or later is required.
:::

Then, simply import it like this:
```ts
import { ... } from 'mediabunny'; // ESM
const { ... } = require('mediabunny'); // or CommonJS
```

ESM is preferred because it gives you tree shaking.

You can also just include the library using a script tag in your HTML:
```html
<script src="mediabunny.cjs"></script>
```

This will add a `Mediabunny` object to the global scope. You can provide types for this global using `mediabunny.d.ts`.

You can download a built distribution file from the [releases page](https://github.com/Vanilagy/mediabunny/releases). Use the `*.cjs` builds for normal script tag inclusion, or the `*.mjs` builds for script tags with `type="module"` or direct imports via ESM. Including the `mediabunny.d.ts` declaration file in your TypeScript project will declare a global `Mediabunny` namespace.