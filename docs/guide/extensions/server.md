---
description: Add full video and audio decoder and encoder support for use in server-side environments, like Node, Bun, or Deno.
---

# @mediabunny/server

By default, Mediabunny requires a browser environment for full access to decoders, encoders, and video processing features. `@mediabunny/server` uses [NodeAV](https://github.com/seydx/node-av) to polyfill this functionality for server-side environments such as Node, Bun, or Deno, enabling the usage of all Mediabunny features on the server. The result is a server-side media processing API that integrates naturally with TypeScript as opposed to the awkwardness and inefficiencies of calling out to the FFmpeg CLI.

Features added by this package include:
- Video decoders and encoders for AVC (H.264), HEVC (H.265), VP8, VP9, and AV1. Supports both length-prefixed and Annex B AVC/HEVC as well as transparent video via VP9.
- Audio decoders and encoders for AAC, MP3, Vorbis, Opus, FLAC, AC-3 and E-AC-3. Supports AAC in both AAC and ADTS formats.
- Video frame transformation support (resize, rotate, crop)
- Automatic hardware acceleration on all platforms (macOS, Linux, Windows)
- Built-in multithreading
- Zero-copy decode and encode paths

<a class="!no-underline inline-flex items-center gap-1.5" :no-icon="true" href="https://github.com/Vanilagy/mediabunny/blob/main/packages/server/README.md">
	GitHub page
	<span class="vpi-arrow-right" />
</a>

## Installation

This library peer-depends on Mediabunny. Install both using npm:
```bash
npm install mediabunny @mediabunny/server
```

## Usage

```ts
import { registerMediabunnyServer } from '@mediabunny/server';
registerMediabunnyServer();
```

That's it - you now have access to the full Mediabunny feature set on the server.

## Upload media compression example

Here, we set up a simple media compression server in Node.js. The client's request body is streamed to Mediabunny, the media gets processed, and the output is streamed directly to the disk. Memory usage is O(1) due to pipelining, and an overly fast uploader is automatically slowed down due to stream backpressure.

```ts
import { ALL_FORMATS, Conversion, FilePathTarget, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM, ReadableStreamSource } from "mediabunny";
import { registerMediabunnyServer } from "@mediabunny/server";
import { Readable } from "node:stream";
import http from "node:http";

registerMediabunnyServer();

const server = http.createServer(async (req, res) => {
    // Read the request body as a stream
	const stream = Readable.toWeb(req) as ReadableStream<Uint8Array>;
	const input = new Input({
		source: new ReadableStreamSource(stream),
		formats: ALL_FORMATS,
	});

    // Stream the output directly to the disk, could also stream to S3 etc.
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new FilePathTarget(`./converted-${crypto.randomUUID()}.mp4`),
	});

	try {
		const conversion = await Conversion.init({
			input,
			output,
			video: async track => ({
				codec: 'avc',
				height: Math.min(720, await track.getDisplayHeight()),
				bitrate: QUALITY_MEDIUM,
			}),
		});
		await conversion.execute();
	
		res.statusCode = 204;
		res.end();
	} catch (error) {
		res.statusCode = 500;
		res.end();

		console.error("Error processing media:", error);
	}
});

server.listen(3000);
```

For all the other ways to use Mediabunny, refer to its [guide](https://mediabunny.dev/guide/introduction).

## Performance

`@mediabunny/server` is extremely performant as it is a thin wrapper around [NodeAV](https://github.com/seydx/node-av), which itself is a thin wrapper around the FFmpeg C API. All decoders and encoders automatically run on separate threads, keeping the main thread unblocked. Hardware acceleration is automatically detected and utilized on all operating systems whenever available (unless explicitly disabled using `hardwareAcceleration: 'prefer-software'`). Video frame and audio sample data is never copied from FFmpeg unless explicitly requested via `VideoSample.copyTo()` and `AudioSample.copyTo()`, and zero-copy GPU decode -> encode paths are used automatically whenever possible.

## Advanced usage

### Usage with NodeAV

`@mediabunny/server` provides `AvFrameVideoSampleResource` and `AvFrameAudioSampleResource` as a means to create `VideoSample` and `AudioSample` instances that are directly backed by data residing in NodeAV's [`Frame`](https://seydx.github.io/node-av/api/lib/classes/Frame.html) (and therefore FFmpeg's `AVFrame`) without ever having to copy data to or from JavaScript. Reading NodeAV's documentation can help you make full use of this integration.

To convert between Mediabunny and NodeAV (FFmpeg) worlds, you can do this:
```ts
import { VideoSample, AudioSample } from 'mediabunny';
import { AvFrameVideoSampleResource, AvFrameAudioSampleResource, toAvFrame } from '@mediabunny/server';

// Frame -> VideoSample
new VideoSample(new AvFrameVideoSampleResource(frame), { timestamp });

// Frame -> AudioSample
new AudioSample(new AvFrameAudioSampleResource(frame));
// (uses the timestamp in the frame)

// VideoSample -> Frame
await toAvFrame(videoSample, frame);

// AudioSample -> Frame
await toAvFrame(audioSample, frame);
```

#### Electron example

For example, when using Electron, we may want to capture the app's contents without moving video data from the GPU to the CPU:
```ts
import { VideoSample } from 'mediabunny';
import { AvFrameVideoSampleResource } from '@mediabunny/server';
import { HardwareContext, SharedTexture, AV_HWDEVICE_TYPE_VIDEOTOOLBOX } from 'node-av';

// Create hardware context (platform-specific)
const hw = HardwareContext.create(AV_HWDEVICE_TYPE_VIDEOTOOLBOX);
using sharedTexture = SharedTexture.create(hw);

// In Electron paint event with offscreen rendering
offscreen.webContents.on('paint', (event) => {
    const texture = event.texture;
    if (!texture?.textureInfo) {
        return;
    }

    // Import as hardware frame (zero-copy)
    const frame = sharedTexture.importTexture(texture.textureInfo, { pts: 0n });
    const sample = new VideoSample(new AvFrameVideoSampleResource(frame), {
        timestamp: 0,
        duration: 0,
    });

    texture.release();
});
```

#### Microphone recording example

Here, we're using NodeAV's Device API to access the user's microphone:
```ts
import { AudioSample } from 'mediabunny';
import { AvFrameAudioSampleResource } from '@mediabunny/server';
import { DeviceAPI, Decoder } from 'node-av';

await using mic = await DeviceAPI.openMicrophone();
const audioStream = mic.audio()!;
using decoder = await Decoder.create(audioStream);

let firstTimestamp: number | null = null;
for await (const frame of decoder.frames(mic.packets(audioStream.index))) {
    if (!frame) {
        break;
    }

    const sample = new AudioSample(new AvFrameAudioSampleResource(frame));
    
    if (firstTimestamp === null) {
        firstTimestamp = sample.timestamp;
    }

    // Offset timestamps so they start at 0
    sample.setTimestamp(sample.timestamp - firstTimestamp);

    // Do something with the sample now, like passing it to an AudioSampleSource
    // ...
}
```

### Video and audio processing

Browser environments ship with many API goodies such as the Canvas 2D API which are a naturally great fit for doing video frame processing, and they integrate well with Mediabunny. On the server, these APIs don't exist, so other approaches must be used:

#### VideoSample.transform()

This method allows for simple transformations on `VideoSample` instances and works when `@mediabunny/server` has been registered:
```ts
const transformed = await sample.transform({
    width: 640,
    height: 360,
    fit: 'cover',
});
```

#### NodeAV filter graphs

FFmpeg's `libavfilter` is an incredibly powerful and generic media processing library, and all of it is directly accessible via NodeAV. It works for both video as well as audio data.

For example, here we combine Mediabunny's Conversion API with a filter graph to grayscale a video:
```ts
import { Conversion } from 'mediabunny';
import { AvFrameVideoSampleResource, toAvFrame } from '@mediabunny/server';
import { Frame, FilterAPI } from 'node-av';

async function* one(f: Frame) { yield f; }

const conversion = await Conversion.init({
    // ...
    video: {
        process: async (sample) => {
            // VideoSample -> Frame
            using inFrame = new Frame();
            inFrame.alloc();
            await toAvFrame(sample, inFrame);

            // Frame -> filter -> AvFrameVideoSampleResource
            using filter = FilterAPI.create('format=gray');
            for await (const outFrame of filter.frames(one(inFrame))) {
                return outFrame && new AvFrameVideoSampleResource(outFrame);
            }

            return null;
        },
    },
    // ...
});
await conversion.execute();
```

#### Canvas API polyfills

Libraries like [Skia Canvas](https://github.com/samizdatco/skia-canvas) provide GPU-enabled polyfills for the Canvas 2D API. Using it with Mediabunny is simply a matter of converting from and to the Canvas API:
```ts
const width = videoSample.displayWidth;
const height = videoSample.displayHeight;

const canvas = new Canvas(width, height);
const ctx = canvas.getContext('2d');

// Copy data from VideoSample
const imageData = ctx.createImageData(width, height);
await videoSample.copyTo(imageData.data, { format: 'RGBA' });
ctx.putImageData(imageData, 0, 0);

// Issue draw commands
ctx.fillStyle = 'red';
ctx.fillRect(20, 20, 100, 60);

// Convert to VideoSample again
const pixels = ctx.getImageData(0, 0, width, height).data;
return new VideoSample(pixels, {
    format: 'RGBA',
    codedWidth: width,
    codedHeight: height,
    timestamp: videoSample.timestamp,
    duration: videoSample.duration,
});
```

## Implementation details

`@mediabunny/server` uses [NodeAV](https://github.com/seydx/node-av) under the hood which provides N-API C bindings to FFmpeg's C API. Using NodeAV, this package implements [custom decoders and encoders](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders) by directly using the APIs provided by `libavcodec`.

For encoding, video frames and audio samples are transferred to FFmpeg by converting them to an `AVFrame` and are then passed to the correct encoder. The resulting packets are then normalized into the format expected by WebCodecs and the [Mediabunny Codec Registry](https://mediabunny.dev/codec-registry/overview). For decoding, the above process is inverted: packets and decoder metadata are passed to the correct decoder, and the resulting `AVFrame` instances are wrapped in `VideoSample` or `AudioSample` instances. Video frame transformations (resize, rotate, crop) are implemented using the `libavfilter` API.

Whenever possible, `AVFrame`s are never copied over to JavaScript unless explicitly needed. This enables zero-copy decode -> transformation -> encode paths.