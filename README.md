# Mediabunny - JavaScript media toolkit

[![](https://img.shields.io/npm/v/mediabunny)](https://www.npmjs.com/package/mediabunny)
[![](https://img.shields.io/bundlephobia/minzip/mediabunny)](https://bundlephobia.com/package/mediabunny)
[![](https://img.shields.io/npm/dm/mediabunny)](https://www.npmjs.com/package/mediabunny)
[![](https://img.shields.io/discord/1390044844285497344?logo=discord&label=Discord)](https://discord.gg/hmpkyYuS4U)

<div align="center">
    <img src="./docs/public/mediabunny-logo.svg" width="180" height="180">
</div>

Mediabunny is a JavaScript library for reading, writing, and converting media files (like MP4, WebM, MP3), directly in the browser. It aims to be a complete toolkit for high-performance media operations on the web. It's written from scratch in pure TypeScript, has zero dependencies, is very performant, and is extremely tree-shakable, meaning you only include what you use. You can think of it a bit like [FFmpeg](https://ffmpeg.org/), but built from the ground up for the web.

[Documentation](https://mediabunny.dev) | [Examples](https://mediabunny.dev/examples) | [Sponsoring](#sponsoring) | [License](#license) | [Discord](https://discord.gg/hmpkyYuS4U)

### Gold sponsors

<div align="center">
  <a href="https://remotion.dev/" target="_blank" rel="sponsored">
    <picture>
      <source srcset="./docs/public/sponsors/remotion-dark.png" media="(prefers-color-scheme: dark)">
      <img src="./docs/public/sponsors/remotion-light.png" width="60" height="60" alt="Remotion">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.gling.ai/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/gling.svg" width="60" height="60" alt="Gling AI">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://diffusion.studio/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/diffusionstudio.png" width="60" height="60" alt="Diffusion Studio">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://kino.ai/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/kino.jpg" width="60" height="60" alt="Kino">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://screen.studio/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/screen-studio.webp" width="60" height="60" alt="Screen Studio">
  </a>
</div>

### Silver sponsors

<div align="center">
  <a href="https://ponder.ai/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/ponder.png" width="50" height="50" alt="Ponder">
  </a>
</div>

### Bronze sponsors

<div align="center">
  <a href="https://elevenlabs.io/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/elevenlabs.png" width="40" height="40" alt="ElevenLabs">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.reactvideoeditor.com/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/rve.png" width="40" height="40" alt="React Video Editor">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.mux.com/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/mux.jpg" width="40" height="40" alt="Mux">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://jellypod.ai/" target="_blank" rel="sponsored">
    <img src="./docs/public/sponsors/jellypod.png" width="40" height="40" alt="Jellypod">
  </a>
</div>

[Sponsor Mediabunny's development](https://github.com/sponsors/Vanilagy)

## Features

Core features include:

- **Wide format support**: Read and write MP4, MOV, WebM, MKV, WAVE, MP3, Ogg, ADTS, FLAC, MPEG-TS
- **Built-in encoding & decoding**: Supports 25+ video, audio, and subtitle codecs, hardware-accelerated using the WebCodecs API
- **High precision**: Fine-grained, microsecond-accurate reading and writing operations
- **Conversion API**: Easy-to-use API with features such as transmuxing, transcoding, resizing, rotation, cropping, resampling, trimming, and more
- **Streaming I/O**: Handle reading & writing files of any size with memory-efficient streaming
- **Tree-shakable**: Only bundle what you use (as small as 5 kB gzipped)
- **Zero dependencies**: Implemented in highly performant TypeScript
- **Cross-platform**: Works in browsers and Node.js

[See full feature list](https://mediabunny.dev/guide/introduction#features)

## Quick start

### Installation

Install it via npm:

```bash
npm install mediabunny
```

Alternatively, include it directly with a script tag using one of the [builds](https://github.com/Vanilagy/mediabunny/releases). Doing so exposes a global `Mediabunny` object.
```html
<script src="mediabunny.cjs"></script>
```

Requires any JavaScript environment that can run ECMAScript 2021 or later. Mediabunny is expected to be run in modern browsers. For types, TypeScript 5.7 or later is required.

### Read file metadata

```js
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';

const input = new Input({
    source: new BlobSource(file), // Reading from disk
    formats: ALL_FORMATS,
});

const duration = await input.computeDuration(); // in seconds
const videoTrack = await input.getPrimaryVideoTrack();
const audioTrack = await input.getPrimaryAudioTrack();
const { displayWidth, displayHeight, rotation } = videoTrack;
const { sampleRate, numberOfChannels } = audioTrack;
const { title, artist, album } = await input.getMetadataTags();
```

### Create new media files

```js
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } from 'mediabunny';

const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(), // Writing to memory
});

// Add a video track backed by a canvas element
const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: QUALITY_HIGH,
});
output.addVideoTrack(videoSource);

await output.start();
// Add frames...
await output.finalize();

const buffer = output.target.buffer; // Final MP4 file
```

### Convert files

```js
import { Input, Output, Conversion, ALL_FORMATS, BlobSource, WebMOutputFormat } from 'mediabunny';

const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
});

const output = new Output({
    format: new WebMOutputFormat(), // Convert to WebM
    target: new BufferTarget(),
});

const conversion = await Conversion.init({ input, output });
await conversion.execute();
```

[See more code snippets](https://mediabunny.dev/guide/quick-start)

## Documentation

Visit the [Docs](https://mediabunny.dev/guide/introduction) for comprehensive guides, examples and API documentation.

## Sponsoring

[See all sponsors](https://mediabunny.dev/#sponsors)

Mediabunny is an open-source project released under the <a href="https://choosealicense.com/licenses/mpl-2.0/" target="_blank">MPL-2.0</a> and is therefore free to use for any purpose, including closed-source commercial use. A permissive license is essential for a foundational library like this to truly thrive. That said, this project requires an immense amount of work and care to maintain and expand. This is made possible by the generous financial backing of the sponsors of this project.

If you have derived considerable value from this project, please consider [sponsoring it](https://github.com/sponsors/Vanilagy) or providing a one-time donation. Thank you! 🩷

## License

This project is licensed under the [Mozilla Public License 2.0](https://choosealicense.com/licenses/mpl-2.0/). This is a very permissive weak copyleft license, not much different from the MIT License, allowing you to:
- Use Mediabunny for any purpose, commercial or non-commercial, without royalties
- Use Mediabunny in open- and closed-source projects
- Freely distribute projects built with Mediabunny
- Inspect and modify Mediabunny's source code

However, you have the following obligation:
- If you modify Mediabunny's licensed source code (e.g. in a fork) and then distribute it, you must publicly publish your modifications under the Mozilla Public License 2.0.

This ensures that library usage remains permissive for everybody, while any improvements to Mediabunny remain in the open, benefiting everyone.

You are not allowed to:
- Remove the license and copyright headers from any Mediabunny source file
- Claim the "Mediabunny" trademark

And finally, Mediabunny - like any other library - comes with no warranty of any kind and is not liable for any direct or indirect damages.

> This is not legal advice. Refer to the full text of the [Mozilla Public License 2.0](https://choosealicense.com/licenses/mpl-2.0/) for the binding license agreement.

## Implementation & development

Mediabunny is implemented from scratch in pure TypeScript with zero dependencies. At its core, the library is a collection of multiplexers and demultiplexers (one for every container format), which are then connected together via abstractions around the WebCodecs API. The logic is heavily pipelined and lazy, keeping performance high and memory usage low. If this stuff interests you, refer to the [Technical overview](https://mediabunny.dev/guide/introduction#technical-overview) for more.

For development, clone this repository and install it using a modern version of Node.js and npm. The build system uses TypeScript, esbuild, API Extractor, Vite, and VitePress.

```bash
npm install # Install dependencies
npm run watch # Build bundles on watch mode

npm run build # Production build with type definitions

npm run check # Type checking
npm run lint # ESLint

npm run docs:generate # Generates API docs
npm run docs:dev # Start docs development server
npm run dev # Start examples development server, will run at http://localhost:5173/examples/[name]/
  
npm run docs:build # Build docs and examples
```