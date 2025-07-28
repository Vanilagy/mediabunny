# Reading media files

Mediabunny allows you to read media files with great control and efficiency. You can use it to extract metadata (such as duration or resolution), as well as to read actual media data from video and audio tracks with frame-accurate timing. Many commonly used [input file formats](./input-formats) are supported. Using [input sources](#input-sources), data can be read from multiple sources, such as directly from memory, from the user's disk, or even over the network.

Files are always read partially ("lazily"), meaning only the bytes required to extract the requested information will be read, keeping performance high and memory usage low. Therefore, most methods for reading data are asynchronous and return promises.

::: info
Not all data is extracted equally. Methods that are prefixed with `compute` instead of `get` indicate that the library might need to do more work to retrieve the requested data.
:::

## Creating a new input

Reading media files in Mediabunny revolves around a central class, `Input`, from which all reading operations begin. One instance of `Input` represents one media file that we want to read.

Start by creating a new instance of `Input`. Here, we're creating it with a [File](https://developer.mozilla.org/en-US/docs/Web/API/File) instance, meaning we'll be reading data directly from the user's disk:
```ts
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';

const input = new Input({
	formats: ALL_FORMATS,
	source: new BlobSource(file),
});
```

`source` specifies where the `Input` reads data from. See [Input sources](#input-sources) for a full list of available input sources.

`formats` specifies the list of formats that the `Input` should support. This field is mainly used for tree shaking optimizations: Using `ALL_FORMATS` means we can load files of [any format that Mediabunny supports](./supported-formats-and-codecs#container-formats), but requires that we include the parsers for each of these formats. If we know we'll only be reading MP3 or WAVE files, then something like this will reduce the overall bundle size drastically:
```ts
import { Input, MP3, WAVE } from 'mediabunny';

const input = new Input({
	formats: [MP3, WAVE],
	// ....
});
```

Reading operations will throw an error if the file format could not be recognized. See [Input formats](./input-formats) for the full list of available input formats.

::: info
Simply creating an instance of `Input` will perform zero reads and is practically free. The file will only be read once data is requested.
:::

## Reading file metadata

With our instance of `Input` created, you can now start reading file-level metadata.

You can query the concrete format of the file like this:
```ts
await input.getFormat(); // => Mp4InputFormat
```

You can directly retrieve the full MIME type of the file, including track codecs:
```ts
await input.getMimeType(); // => 'video/mp4; codecs="avc1.42c032, mp4a.40.2"'
```

Use `computeDuration` to get the full duration of the media file in seconds:
```ts
await input.computeDuration(); // => 1905.4615
```
More specifically, the duration is defined as the maximum end timestamp across all tracks.

## Reading track metadata

You can extract the list of all media tracks in the file like so:
```ts
await input.getTracks(); // => InputTrack[]
```

There are additional utility methods for retrieving tracks that can be useful:
```ts
await input.getVideoTracks(); // => InputVideoTrack[]
await input.getAudioTracks(); // => InputAudioTrack[]

await input.getPrimaryVideoTrack(); // => InputVideoTrack | null
await input.getPrimaryAudioTrack(); // => InputAudioTrack | null
```

### Subtitle tracks

You can also retrieve subtitle tracks from the input file:

```ts
// Get all subtitle tracks:
await input.getSubtitleTracks(); // => InputSubtitleTrack[]

// Get the primary subtitle track:
await input.getPrimarySubtitleTrack(); // => InputSubtitleTrack | null
```

### Common track metadata

Once you have an `InputTrack`, you can start extracting metadata from it.
```ts
// Get a unique ID for this track in the input file:
track.id; // => number

// Check the track's type:
track.type; // => 'video' | 'audio' | 'subtitle';

// Alternatively, use these type predicate methods:
track.isVideoTrack(); // => boolean
track.isAudioTrack(); // => boolean

// Retrieve the track's language as an ISO 639-2/T language code.
// Resolves to 'und' (undetermined) if the language isn't known.
track.languageCode; // => string
```

#### Codec information

You can query metadata related to the track's codec:
```ts
track.codec; // => MediaCodec | null
```
This field is `null` when the track's codec couldn't be recognized or is not supported by Mediabunny. See [Codecs](./supported-formats-and-codecs#codecs) for the full list of supported codecs.

You can also extract the full codec parameter string from the track, as specified in the [WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/):
```ts
await track.getCodecParameterString(); // => 'avc1.42001f'
```

Just because the codec is known doesn't mean the user's browser will be able to decode it. To check decodability, use `canDecode`:
```ts
await track.canDecode(); // => boolean
```

::: info
This check also takes [custom decoders](./supported-formats-and-codecs#custom-decoders) into account.
:::

#### Track timing info

You can compute the track's specific duration in seconds like so:
```ts
await track.computeDuration(); // => 1902.4615
```
Analogous to the `Input`'s duration, this is identical to the end timestamp of the last sample. A track's duration may be shorter than the `Input`'s total duration if the `Input` has multiple tracks which differ in length.

You can also retrieve the track's *start timestamp* in seconds:
```ts
await track.getFirstTimestamp(); // => 0.041666666666666664
```
This is the opposite of *duration*: It's the start timestamp of the first sample.

::: warning
A track's start timestamp does **NOT** need to be 0. It is typically close to zero, but it may be slightly positive, or even slightly negative.

A _positive start timestamp_ means the first sample is presented *after* the overall composition begins. If this is a video track, you may choose to either display a placeholder image (like a black screen), or to display the first frame as a freeze frame until the second frame starts.

A _negative start timestamp_ means the track begins *before* the composition does; this effectively means that some beginning section of the media data is "cut off". It is recommended not to display samples with negative timestamps.
:::

Another metric related to track timing info is its *time resolution*, which is given in hertz:
```ts
track.timeResolution; // => 24
```
Intuitively, this is the maximum possible "frame rate" of the track (assuming that no two samples have the same timestamp). Mathematically, if $x$ is equal to a track's time resolution, then all timestamps and durations of that track can be expressed as:

$$ \frac{k}{x},\quad k \in \mathbb{Z} $$

::: info
This field only gives an upper bound on a track's frame rate. To get a track's actual frame rate based on its samples, compute its [packet statistics](#packet-statistics).
:::

#### Packet statistics

You can query aggregate statistics about a track's encoded packets:
```ts
await track.computePacketStats(); // => PacketStats

type PacketStats = {
	// The total number of packets.
	packetCount: number;
	// The average number of packets per second.
	// For video tracks, this will equal the average frame rate (FPS).
	averagePacketRate: number;
	// The average number of bits per second.
	averageBitrate: number;
};
```

For example, running this on the video track of a 1080p version of Big Buck Bunny returns this:
```ts
{
	packetCount: 14315,
	averagePacketRate: 24,
	averageBitrate: 9282573.233670976,
}
```

This means the video track has a total of 14315 frames, a frame rate of exactly 24 Hz, and an average bitrate of ~9.28 Mbps.

**Note:** These statistics aren't simply read from file metadata but have to be computed, meaning this method may - depending on the file - need to perform many reads and might take several hundred milliseconds to resolve. To speed up computation, you can compute aggregate statistics for only a subset of packets by passing a parameter to the method:
```ts
await track.computePacketStats(50);
```
This will only look at the first ~50 packets and then return the result. This is great for quickly getting an estimate of frame rate and bitrate, without having to scan through the entire file. For videos with a constant frame rate, this will also always return the correct frame rate.

### Video track metadata

In addition to the [common track metadata](#common-track-metadata), video tracks have additional metadata you can query:

```ts
// Get the raw pixel dimensions of the track's coded samples, before rotation:
videoTrack.codedWidth; // => number
videoTrack.codedHeight; // => number

// Get the displayed pixel dimensions of the track's samples, after rotation:
videoTrack.displayWidth; // => number
videoTrack.displayHeight; // => number

// Get the clockwise rotation in degrees by which the
// track's frames should be rotated:
videoTrack.rotation; // => 0 | 90 | 180 | 270
```

To compute a video track's average frame rate (FPS), use [`computePacketStats`](#packet-statistics):
```ts
const stats = await videoTrack.computePacketStats(100);
const frameRate = stats.averagePacketRate; // Approximate, but often exact
```

You can retrieve the track's decoder configuration, which is a `VideoDecoderConfig` from the WebCodecs API for usage within `VideoDecoder`:
```ts
await videoTrack.getDecoderConfig(); // => VideoDecoderConfig | null
```
This method can resolve to `null` if the track's codec isn't known.

For example, here's the decoder configuration for a 1080p version of Big Buck Bunny:
```ts
{
	codec: 'avc1.4d4029',
	codedWidth: 1920,
	codedHeight: 1080,
	description: new Uint8Array([
		// Bytes of the AVCDecoderConfigurationRecord
		1, 77, 64, 41, 255, 225, 0, 22, 39, 77, 64, 41, 169, 24, 15, 0,
		68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64, 1, 0,
		4, 40, 222, 9, 200,
	]),
}
```

You can directly retrieve information about the video's color space:
```ts
await videoTrack.getColorSpace(); // => VideoColorSpaceInit
```

The resulting object will contain `undefined` values if color space information is not known.

You can also directly check if a video has a _high dynamic range_ (HDR):
```ts
await videoTrack.hasHighDynamicRange(); // => boolean
```
This method compares with the available color space metadata. If it resolves to `true`, then the video is HDR; if it resolves to `false`, the video may or may not be HDR.

### Audio track metadata

In addition to the [common track metadata](#common-track-metadata), audio tracks have additional metadata you can query:

```ts
// Get the number of audio channels:
audioTrack.numberOfChannels; // => number

// Get the audio sample rate in hertz:
audioTrack.sampleRate; // => number
```

You can retrieve the track's decoder configuration, which is an `AudioDecoderConfig` from the WebCodecs API for usage within `AudioDecoder`:
```ts
await audioTrack.getDecoderConfig(); // => AudioDecoderConfig | null
```
This method can resolve to `null` if the track's codec isn't known.

For example, here's the decoder configuration for an AAC audio track:
```ts
{
	codec: 'mp4a.40.2',
	numberOfChannels: 2,
	sampleRate: 44100,
	description: new Uint8Array([
		// Bytes of the AudioSpecificConfig
		17, 144,
	]),
}
```

## Reading media data

Mediabunny has the concept of *media sinks*, which are the way to read media data from an `InputTrack`. Media sinks differ in their API and in their level of abstraction, meaning you can pick whichever sink best fits your use case.

See [Media sinks](./media-sinks) for a full list of sinks.

### Examples

Loop over all raw encoded packets of a track:
```ts
import { EncodedPacketSink } from 'mediabunny';

const videoTrack = await input.getPrimaryVideoTrack();
const sink = new EncodedPacketSink(videoTrack);

for await (const packet of sink.packets()) {
	console.log(packet.timestamp);
}
```

Here we iterate over all samples (frames) of a video track:
```ts
import { VideoSampleSink } from 'mediabunny';

const videoTrack = await input.getPrimaryVideoTrack();
const sink = new VideoSampleSink(videoTrack);

for await (const sample of sink.samples()) {
	// For example, let's draw the sample to a canvas:
	sample.draw(ctx, 0, 0);
}
```

We can also use this sink in more concrete ways:
```ts
// Loop over all frames between the timestamps of 300s and 305s
for await (const sample of sink.samples(300, 305)) {
	// ...
}

// Get the frame that's displayed at timestamp 42s
await sink.getSample(42);
```

We may want to extract downscaled thumbnails from a video track:
```ts
import { CanvasSink } from 'mediabunny';

const videoTrack = await input.getPrimaryVideoTrack();
const sink = new CanvasSink(videoTrack, {
	width: 320,
	height: 180,
});

const startTimestamp = await videoTrack.getFirstTimestamp();
const endTimestamp = await videoTrack.computeDuration();

// Let's generate five equally-spaced thumbnails:
const thumbnailTimestamps = [0, 0.2, 0.4, 0.6, 0.8].map(
	(t) => startTimestamp + t * (endTimestamp - startTimestamp),
);

for await (const result of sink.canvasesAtTimestamps(thumbnailTimestamps)) {
	// Add MrBeast's face to the thumbnail
}
```

We may loop over a section of an audio track and play it using the Web Audio API:
```ts
import { AudioBufferSink } from 'mediabunny';

const audioTrack = await input.getPrimaryAudioTrack();
const sink = new AudioBufferSink(audioTrack);

for await (const { buffer, timestamp } of sink.buffers(5, 10)) {
	const node = audioContext.createBufferSource();
	node.buffer = buffer;
	node.connect(audioContext.destination);
	node.start(timestamp);
}
```

We can extract subtitles from a video file:
```ts
import { SubtitlePacketSink } from 'mediabunny';

const subtitleTrack = await input.getPrimarySubtitleTrack();
if (subtitleTrack) {
	const sink = new SubtitlePacketSink(subtitleTrack);
	
	// Extract all subtitle cues
	for await (const cue of sink.subtitles()) {
		console.log(`[${cue.timestamp}s - ${cue.timestamp + cue.duration}s] ${cue.text}`);
	}
	
	// Or extract subtitles from a specific time range (10s to 60s)
	for await (const cue of sink.subtitles(10, 60)) {
		// Process subtitle cue
	}
}
```

Or we may take the decoding process into our own hands:
```ts
import { EncodedPacketSink } from 'mediabunny';

const videoTrack = await input.getPrimaryVideoTrack();
const sink = new EncodedPacketSink(videoTrack);

const decoder = new VideoDecoder({
	output: console.log,
	error: console.error,
});
decoder.configure(await videoTrack.getDecoderConfig());

// Let's crank through all packets from timestamp 37s to 50s:
let currentPacket = await sink.getKeyPacket(37);
while (currentPacket && currentPacket.timestamp < 50) {
	decoder.decode(currentPacket.toEncodedVideoChunk());
	currentPacket = await sink.getNextPacket(currentPacket);
}

await decoder.flush();
```

As you can see, media sinks are incredibly versatile and allow for efficient, sparse reading of media data within the input file.

## Input sources

The _input source_ determines where the `Input` reads data from.

All sources have an `onread` callback property you can set to inspect which areas of the file are being read:
```ts
source.onread = (start, end) => {
	console.log(`Reading byte range [${start}, ${end})`);
};
```

---

This library offers a couple of sources:

### `BufferSource`

This source uses an in-memory `ArrayBuffer` as the underlying source of data.
```ts
import { BufferSource } from 'mediabunny';

// You can construct a BufferSource directly from ArrayBuffer:
const source = new BufferSource(arrayBuffer);

// Or also from a Uint8Array:
const source = new BufferSource(uint8Array);
```

This source is the fastest but requires the entire input file to be held in memory.

### `BlobSource`

This source is backed by an underlying [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob) object. Since [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) extends `Blob`, this source is perfect for reading data directly from disk.
```ts
import { BlobSource } from 'mediabunny';

fileInput.addEventListener('change', (event) => {
	const file = event.target.files[0];
	const source = new BlobSource(file);
});
```

### `UrlSource` <Badge type="warning" text="beta" />

::: warning
This is a **beta** feature. `UrlSource` tends to make tons of requests and is potentially slow. This is something that will be fixed in the near future.

It still works, but keep in mind it's going to be much higher-latency than reading directly from disk or from memory.
:::

This source fetches data from a URL. This is useful for reading files over the network.
```ts
import { UrlSource } from 'mediabunny';

const source = new UrlSource('https://example.com/bigbuckbunny.mp4');
```

::: warning
If you're using this source in the browser and the URL is on a different origin, make sure [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) is properly configured.
:::

`UrlSource` accepts a few options as its second parameter:
```ts
type UrlSourceOptions = {
	requestInit?: RequestInit;
	getRetryDelay?: (previousAttempts: number) => number | null;
};
```

You can use `requestInit` just like you would in the Fetch API to further customize the request:
```ts
const source = new UrlSource('https://example.com/bigbuckbunny.mp4', {
	requestInit: {
		headers: {
			'X-Custom-Header': 'my-value',
		},
	},
});
```

`getRetryDelay` can be used to control the retry logic used should a request fail. When a request fails, `getRetryDelay` should return the time to wait in seconds before the request will be retried. Returning `null` prevents further retries.
```ts
// UrlSource using retry logic with exponential backoff:
const source = new UrlSource('https://example.com/bigbuckbunny.mp4', {
	getRetryDelay: (previousAttempts) => Math.min(2 ** previousAttempts, 16),
});
```

Not setting `getRetryDelay` means requests will not be retried.

### `StreamSource`

This is a general-purpose input source you can use to read data from anywhere. All other input sources can be implemented on top of `StreamSource`.

For example, here we're reading a file from disk using the Node.js file system:
```ts
import { StreamSource } from 'mediabunny';
import { open } from 'node:fs/promises';

const fileHandle = await open('bigbuckbunny.mp4', 'r');

const source = new StreamSource({
	read: async (start, end) => {
		const buffer = Buffer.alloc(end - start);
		await fileHandle.read(buffer, 0, end - start, start);
		return buffer;
	},
	getSize: async () => {
		const { size } = await fileHandle.stat();
		return size;
	},
});
```

The options of `StreamSource` have the following type:
```ts
type StreamSourceOptions = {
	// Called when data is requested.
	// Should return or resolve to the bytes from the specified byte range.
	read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>;
	// Called when the size of the entire file is requested.
	// Should return or resolve to the size in bytes.
	getSize: () => number | Promise<number>;
};
```