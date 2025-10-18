# Quick start

This page is a collection of short code snippets that showcase the most common operations you may use this library for.

## Read file metadata

```ts
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';

const input = new Input({
	formats: ALL_FORMATS, // Supporting all file formats
	source: new BlobSource(file), // Assuming a File instance
});

const duration = await input.computeDuration(); // in seconds
const allTracks = await input.getTracks(); // List of all tracks

// Extract video metadata
const videoTrack = await input.getPrimaryVideoTrack();
if (videoTrack) {
	videoTrack.displayWidth; // in pixels
	videoTrack.displayHeight; // in pixels
	videoTrack.rotation; // in degrees clockwise

	// Estimate frame rate (FPS)
	const packetStats = await videoTrack.computePacketStats(100);
	const averageFrameRate = packetStats.averagePacketRate;
}

// Extract audio metadata
const audioTrack = await input.getPrimaryAudioTrack();
if (audioTrack) {
	audioTrack.numberOfChannels;
	audioTrack.sampleRate; // in Hz
}

// Extract metadata tags
const tags = await input.getMetadataTags();
tags.title; // Title
tags.date; // Release date
tags.images[0]; // Cover art
tags.raw['TBPM']; // Custom tags
// ...
```

::: info
- Check out the <a href="/examples/metadata-extraction" target="_self">Metadata extraction example</a> for this code in action.
- You can read from more than just `File` instances - check out [Input sources](./reading-media-files#input-sources) for more.
:::


## Read media data

```ts
import {
	Input,
	ALL_FORMATS,
	BlobSource,
	VideoSampleSink,
	AudioSampleSink,
} from 'mediabunny';

const input = new Input({
	formats: ALL_FORMATS,
	source: new BlobSource(file),
});

// Read video frames
const videoTrack = await input.getPrimaryVideoTrack();
if (videoTrack) {
	const decodable = await videoTrack.canDecode();
	if (decodable) {
		const sink = new VideoSampleSink(videoTrack);

		// Get the video frame at timestamp 5s
		const videoSample = await sink.getSample(5);
		videoSample.timestamp; // in seconds
		videoSample.duration; // in seconds

		// Draw the frame to a canvas
		videoSample.draw(ctx, 0, 0);

		// Loop over all frames in the first 30s of video
		for await (const sample of sink.samples(0, 30)) {
			// ...
		}
	}
}

// Read audio chunks
const audioTrack = await input.getPrimaryAudioTrack();
if (audioTrack) {
	const decodable = await audioTrack.canDecode();
	if (decodable) {
		const sink = new AudioSampleSink(audioTrack);

		// Get audio chunk at timestamp 5s; a short chunk of audio
		const audioSample = await sink.getSample(5);
		audioSample.timestamp; // in seconds
		audioSample.duration; // in seconds
		audioSample.numberOfFrames;

		// Convert to AudioBuffer for use with the Web Audio API
		const audioBuffer = audioSample.toAudioBuffer();

		// Loop over all samples in the first 30s of audio
		for await (const sample of sink.samples(0, 30)) {
			// ...
		}
	}
}
```

::: info
- Check out the <a href="/examples/media-player" target="_self">Media player example</a> for a demo built on this use case.
- See [Media sinks](./media-sinks) for all the ways to extract media data from tracks.
:::

## Extract video thumbnails

```ts
import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
} from 'mediabunny';

const input = new Input({
	formats: ALL_FORMATS,
	source: new BlobSource(file),
});

const videoTrack = await input.getPrimaryVideoTrack();
if (videoTrack) {
	const decodable = await videoTrack.canDecode();
	if (decodable) {
		const sink = new CanvasSink(videoTrack, {
			width: 320, // Automatically resize the thumbnails
		});

		// Get the thumbnail at timestamp 10s
		const result = await sink.getCanvas(10);
		result.canvas; // HTMLCanvasElement | OffscreenCanvas
		result.timestamp; // in seconds
		result.duration; // in seconds

		// Generate five equally-spaced thumbnails through the video
		const startTimestamp = await videoTrack.getFirstTimestamp();
		const endTimestamp = await videoTrack.computeDuration();
		const timestamps = [0, 0.2, 0.4, 0.6, 0.8].map(
			(t) => startTimestamp + t * (endTimestamp - startTimestamp)
		);

		// Loop over these timestamps
		for await (const result of sink.canvasesAtTimestamps(timestamps)) {
			// ...
		}
	}
}
```

::: info
- Check out the <a href="/examples/thumbnail-generation" target="_self">Thumbnail generation example</a> for this code in action.
- You can further configure [`CanvasSink`](./media-sinks#canvassink).
:::

## Extract encoded packets

```ts
import {
	Input,
	ALL_FORMATS,
	BlobSource,
	EncodedPacketSink,
} from 'mediabunny';

const input = new Input({
	formats: ALL_FORMATS,
	source: new BlobSource(file),
});

const videoTrack = await input.getPrimaryVideoTrack();
if (videoTrack) {
	const sink = new EncodedPacketSink(videoTrack);

	// Get packet for timestamp 10s
	const packet = await sink.getPacket(10);
	packet.data; // Uint8Array
	packet.type; // 'key' | 'delta'
	packet.timestamp; // in seconds
	packet.duration; // in seconds

	// Get the closest key packet to timestamp 10s
	const keyPacket = await sink.getKeyPacket(10);

	// Get the following packet
	const nextPacket = await sink.getNextPacket(keyPacket);

	// Set up a manual decoder
	const decoderConfig = await videoTrack.getDecoderConfig();
	const videoDecoder = new VideoDecoder({
		output: console.log,
		error: console.error,
	});
	videoDecoder.configure(decoderConfig);

	// Loop over all packets in decode order
	for await (const packet of sink.packets()) {
		videoDecoder.decode(packet.toEncodedVideoChunk());
	}

	await videoDecoder.flush();
}
```

::: info
Check out [`EncodedPacketSink`](./media-sinks#encodedpacketsink) for the full documentation.
:::

## Create new media files

```ts
import {
	Output,
	BufferTarget,
	Mp4OutputFormat,
	CanvasSource,
	AudioBufferSource,
	QUALITY_HIGH,
} from 'mediabunny';

// An Output represents a new media file
const output = new Output({
	format: new Mp4OutputFormat(), // The format of the file
	target: new BufferTarget(), // Where to write the file (here, to memory)
});

// Example: add a video track driven by a canvas
const videoSource = new CanvasSource(canvas, {
	codec: 'avc',
	bitrate: QUALITY_HIGH,
});
output.addVideoTrack(videoSource);

// Example: add an audio track driven by AudioBuffers
const audioSource = new AudioBufferSource({
	codec: 'aac',
	bitrate: QUALITY_HIGH,
});
output.addAudioTrack(audioSource);

// Set some metadata tags
output.setMetadataTags({
	title: 'My Movie',
	artist: 'Me',
});

await output.start();

// Add some video frames
for (let frame = 0; ...) {
	await videoSource.add(frame / 30, 1 / 30);
}

// Add some audio data
await audioSource.add(audioBuffer1);
await audioSource.add(audioBuffer2);

await output.finalize();

const buffer = output.target.buffer; // ArrayBuffer containing the final MP4 file
```

::: info
- Check out the <a href="/examples/procedural-generation" target="_self">Procedural generation example</a> for a demo of in-browser video generation.
- You can create files of many different formats; check out [Output formats](./output-formats) for the full list.
- Media data can be added from different sources, see [Media sources](./media-sources).
:::

## Write directly to disk

```ts
import {
	Output,
	StreamTarget,
} from 'mediabunny';

// File System API
const handle = await window.showSaveFilePicker();
const writableStream = await handle.createWritable();

const output = new Output({
	// `chunked: true` to batch disk operations
	target: new StreamTarget(writableStream, { chunked: true }),
	// ...
});

// ...

await output.finalize();

// The file has been fully written to disk
```

## Stream over the network

```ts
import {
	Output,
	StreamTarget,
	StreamTargetChunk,
	Mp4OutputFormat,
} from 'mediabunny';

const { writable, readable } = new TransformStream<StreamTargetChunk, Uint8Array>({
	transform: (chunk, controller) => controller.enqueue(chunk.data),
});

const output = new Output({
	target: new StreamTarget(writable),
	// We must use an append-only format here, such as fragmented MP4
	format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
});

const uploadComplete = fetch('https://example.com/upload', {
	method: 'POST',
	body: readable,
	duplex: 'half',
	headers: {
		'Content-Type': output.format.mimeType,
	},
});

await output.start();

// ...

await output.finalize();
await uploadComplete;
```

::: info
- This code automatically handles the backpressure applied by a slow network.
- Read more on [append-only formats](./output-formats#append-only-writing), a requirement for this pattern.
:::

## Record live media

```ts
import {
	Output,
	BufferTarget,
	WebMOutputFormat,
	MediaStreamVideoTrackSource,
	MediaStreamAudioTrackSource,
	QUALITY_MEDIUM
} from 'mediabunny';

const userMedia = await navigator.mediaDevices.getUserMedia({
	video: true,
	audio: true,
});
const videoTrack = userMedia.getVideoTracks()[0];
const audioTrack = userMedia.getAudioTracks()[0];

const output = new Output({
	format: new WebMOutputFormat(),
	target: new BufferTarget(),
});

if (videoTrack) {
	const source = new MediaStreamVideoTrackSource(videoTrack, {
		codec: 'vp9',
		bitrate: QUALITY_MEDIUM,
	});
	output.addVideoTrack(source);
}

if (audioTrack) {
	const source = new MediaStreamAudioTrackSource(audioTrack, {
		codec: 'opus',
		bitrate: QUALITY_MEDIUM,
	});
	output.addAudioTrack(source);
}

await output.start();

// Wait...

await output.finalize();
```

::: info
- Check out the <a href="/examples/live-recording">Live recording demo</a> for this code in action.
- This is basically [`MediaRecorder`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder), but less sucky.
:::

## Creating transparent video

```ts
import {
	Output,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	QUALITY_MEDIUM,
} from 'mediabunny';

const output = new Output({
	// Use a format that supports transparency:
	format: new WebMOutputFormat(),
	target: new BufferTarget(),
});

const canvas = new OffscreenCanvas(1280, 720);
const context = canvas.getContext('2d', { alpha: true })!;

const source = new CanvasSource(canvas, {
	codec: 'vp9',
	bitrate: QUALITY_MEDIUM,
	alpha: 'keep', // => Also encode alpha data
});
output.addVideoTrack(source);

await output.start();

// Add data...
await source.add(0, 1 / 30);
// ...

await output.finalize();
```

## Check encoding support

```ts
import {
	MovOutputFormat,
	getFirstEncodableVideoCodec,
	getFirstEncodableAudioCodec,
	getEncodableVideoCodecs,
	getEncodableAudioCodecs,
} from 'mediabunny';

const outputFormat = new MovOutputFormat();

// Find the best supported codec for the given container format
const bestVideoCodec = await getFirstEncodableVideoCodec(
	outputFormat.getSupportedVideoCodecs(),
	// Optionally, constrained by these parameters:
	{ width: 1920, height: 1080 },
);
const bestAudioCodec = await getFirstEncodableAudioCodec(
	outputFormat.getSupportedAudioCodecs(),
);

// Find all supported codecs
const supportedVideoCodecs = await getEncodableVideoCodecs();
const supportedAudioCodecs = await getEncodableAudioCodecs();
```

## Convert files

```ts
import {
	Input,
	Output,
	Conversion,
	ALL_FORMATS,
	BlobSource,
	Mp4OutputFormat,
} from 'mediabunny';

// Check the above snippets for more examples of Input and Output
const input = new Input({
	formats: ALL_FORMATS,
	source: new BlobSource(file),
});
const output = new Output({
	format: new Mp4OutputFormat(),
	target: new BufferTarget(),
});

const conversion = await Conversion.init({ input, output });
if (!conversion.isValid) {
	// The conversion isn't possible and would error upon execution.
	// Check `discardedTracks` for the reasons.
	return;
}

// List of tracks that won't make it into the output:
conversion.discardedTracks;

conversion.onProgress = (progress) => {
	progress; // Number between 0 and 1, inclusive
};

await conversion.execute();
// Conversion is complete

const buffer = output.target.buffer; // ArrayBuffer containing the final MP4 file
```

::: info
- This code will automatically transmux (copy media data) when possible, and transcode (re-encode media data) when necessary.
- Refer to [Converting media files](./converting-media-files) for the full documentation.
:::

## Extract audio

```ts
import {
	Input,
	Output,
	Conversion,
	WavOutputFormat,
} from 'mediabunny';

const input = new Input(...);
const output = new Output({
	// Write to a .wav file, keeping only the audio track
	format: new WavOutputFormat(),
	// ...
});

const conversion = await Conversion.init({
	input,
	output,
	audio: {
		sampleRate: 16000, // Resample to 16 kHz
	},
});
await conversion.execute();
// Conversion is complete
```

::: info
- You can extract to other audio-only formats, such as .mp3, .ogg, or even .m4a. See [Output formats](./output-formats).
:::

## Compress media

```ts
import {
	Input,
	Output,
	Conversion,
	QUALITY_LOW,
} from 'mediabunny';

const input = new Input(...);
const output = new Output(...);

const conversion = await Conversion.init({
	input,
	output,
	video: {
		width: 480,
		bitrate: QUALITY_LOW,
	},
	audio: {
		numberOfChannels: 1,
		bitrate: QUALITY_LOW,
	},
	trim: {
		// Let's keep only the first 60 seconds
		start: 0,
		end: 60,
	},
	tags: {}, // Remove any metadata tags
});

await conversion.execute();
// Conversion is complete
```

::: info
- Check out the <a href="/examples/file-compression">File compression example</a> for this code in action.
:::

## Add a video overlay

```ts
import {
	Input,
	Output,
	Conversion,
} from 'mediabunny';

// For example, let's load a watermark image
const watermark = new Image();
watermark.src = '/watermark.jpg';
await new Promise(resolve => watermark.onload = resolve);

const input = new Input(...);
const output = new Output(...);

let ctx: CanvasRenderingContext2D | null = null;
const conversion = await Conversion.init({
	input,
	output,
	video: {
		process: (sample) => {
			if (!ctx) {
				// Create a canvas for image compositing
				const canvas = new OffscreenCanvas(
					sample.displayWidth,
					sample.displayHeight,
				);
				ctx = canvas.getContext('2d')!;
			}

			ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			sample.draw(ctx, 0, 0);
			ctx.drawImage(watermark, 32, 32);

			return ctx.canvas;
		},
	},
});

await conversion.execute();
// Conversion is complete
```