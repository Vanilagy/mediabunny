# Media sinks

## Introduction

*Media sinks* offer ways to extract media data from an `InputTrack`. Different media sinks provide different levels of abstraction and cater to different use cases.

For information on how to obtain input tracks, or how to generally read data from media files, refer to [Reading media files](./reading-media-files).

### General usage

> General usage patterns of media sinks will be demonstrated using a fictional `FooSink`.

Media sinks are like miniature "namespaces" for retrieving media data, scoped to a specific track. This means that you'll typically only need to construct one sink per type for a track.
```ts
const track = await input.getPrimaryVideoTrack();
const sink = new FooSink(track);
```

Constructing the sink is virtually free and does not perform any media data reads.

To read media data, each sink offers a different set of methods. You can call these methods as many times as you want; their calls will be independent since media sinks are stateless[^1].
```ts
await sink.getFoo(1);
await sink.getFoo(2);
await sink.getFoo(3);
```

[^1]: Almost: `CanvasSink` becomes stateful when using a [canvas pool](#canvas-pool).

### Async iterators

Media sinks make heavy use of [async iterators](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator). They allow you to iterate over a set of media data (like all frames in a video track) efficiently, only having to read small sections of the file at any given point.

Async iterators are extremely ergonomic with `for await...of` loops:
```ts
for await (const foo of sink.foos()) {
	console.log(foo.timestamp);
}
```

Just like in regular `for` loops, the `break` statement can be used to exit the loop early. This will automatically clean up any internal resources (such as decoders) used by the async iterator:
```ts
// Loop only over the first 5 foos
let count = 0;
for await (const foo of sink.foos()) {
	console.log(foo.timestamp);
	if (++count === 5) break;
}
```

Async iterators are also useful outside of `for` loops. Here, the `next` method is used to retrieve the next item in the iteration:
```ts
const foos = sink.foos();

const foo1Result = await foos.next();
const foo2Result = await foos.next();

const foo1 = foo1Result.value; // Might be `undefined` if the iteration is complete
```

::: warning
When you manually use async iterators, make sure to call `return` on them once you're done:
```ts
await foos.return();
```
This ensures all internally held resources are freed.
:::

### Decode vs. presentation order

Packets may appear out-of-order in the file, meaning the order in which they are decoded does not correspond to the order in which the decoded data is displayed (see [B-frames](./media-sources#b-frames)). The methods on media sinks differ with respect to which ordering they use to query and retrieve packets. So, just keep these definitions in mind:
- **Presentation order:** The order in which the data is to be presented; sorted by timestamp.
- **Decode order:** The order in which packets must be decoded; not always sorted by timestamp.

## General sinks

There is one media sink which can be used with any `InputTrack`:

### `EncodedPacketSink`

This sink can be used to extract raw, [encoded packets](./packets-and-samples#encodedpacket) from media files and is the most elementary media sink. `EncodedPacketSink` is useful if you don't care about the decoded media data (for example, you're only interested in timestamps), or if you want to roll your own decoding logic.

Start by constructing the sink from any `InputTrack`:
```ts
import { EncodedPacketSink } from 'mediabunny';

const sink = new EncodedPacketSink(track);
```

You can retrieve specific packets given a timestamp in seconds:
```ts
await sink.getPacket(5); // => EncodedPacket | null

// Or, retrieving only packets with type 'key':
await sink.getKeyPacket(5); // => EncodedPacket | null
```

When retrieving a packet using a timestamp, the last packet (in [presentation order](#decode-vs-presentation-order)) with a timestamp less than or equal to the search timestamp will be returned. The methods return `null` if there exists no such packet.

There is a special method for retrieving the first packet (in [decode order](#decode-vs-presentation-order)):
```ts
await sink.getFirstPacket(); // => EncodedPacket | null
```
The last packet (in [presentation order](#decode-vs-presentation-order)) can be retrieved like so:
```ts
await sink.getPacket(Infinity); // => EncodedPacket | null
```

Once you have a packet, you can retrieve the packet's successor (in [decode order](#decode-vs-presentation-order)) like so:
```ts
await sink.getNextPacket(packet); // => EncodedPacket | null

// Or jump straight to the next packet with type 'key':
await sink.getNextKeyPacket(packet); // => EncodedPacket | null
```
These methods return `null` if there is no next packet.

These methods can be combined to iterate over a range of packets. Starting from an initial packet, call `getNextPacket` in a loop to iterate over packets:
```ts
let currentPacket = await sink.getFirstPacket();
while (currentPacket) {
	console.log('Packet:', currentPacket);
	// Do something with the packet

	currentPacket = await sink.getNextPacket(currentPacket);
}
```

While this approach works, `EncodedPacketSink` also provides a dedicated `packets` iterator function, which iterates over packets in [decode order](#decode-vs-presentation-order):
```ts
for await (const packet of sink.packets()) {
	// ...
}
```
You can also constrain the iteration using a packet range, where the iteration will go from the starting packet up to (but excluding) the end packet:
```ts
const start = await sink.getPacket(5);
const end = await sink.getPacket(10, { metadataOnly: true });

for await (const packet of sink.packets(start, end)) {
	// ...
}
```

The `packets` method is more performant than manual iteration as it will intelligently preload future packets before they are needed.

#### Verifying key packets

By default, packet types are determined using the metadata provided by the containing file. Some files can erroneously label some delta packets as key packets, leading to potential decoder errors. To be guaranteed that a key packet is actually a key packet, you can enable the `verifyKeyPackets` option:
```ts
// If the packet returned by this method has type: 'key', it's guaranteed
// to be a key packet.
await sink.getPacket(5, { verifyKeyPackets: true });

// Returned packets are guaranteed to be key packets
await sink.getKeyPacket(10, { verifyKeyPackets: true });
await sink.getNextKeyPacket(packet, { verifyKeyPackets: true });

// Also works for the iterator:
for await (const packet of sink.packets(
	undefined,
	undefined,
	{ verifyKeyPackets: true },
)) {
	// ...
}
```

::: info
`verifyKeyPackets` only works when `metadataOnly` is not also enabled.
:::

#### Metadata-only packet retrieval

Sometimes, you're only interested in a packet's metadata (timestamp, duration, type, ...) and not in its encoded media data. All methods on `EncodedPacketSink` accept a final `options` parameter which you can use to retrieve [metadata-only packets](./packets-and-samples#metadata-only-packets):
```ts
const packet = await sink.getPacket(5, { metadataOnly: true });

packet.isMetadataOnly; // => true
packet.data; // => Uint8Array([])
```
Retrieving metadata-only packets is more efficient for some input formats: Only the metadata section of the file must be read, not the media data section.

## Video data sinks

These sinks can only be used with an `InputVideoTrack`.

### `VideoSampleSink`

Use this sink to extract decoded [video samples](./packets-and-samples#videosample) (frames) from a video track. The sink will automatically handle the decoding internally.

::: info
All operations of this sink use [presentation order](#decode-vs-presentation-order).
:::

Create the sink like so:
```ts
import { VideoSampleSink } from 'mediabunny';

const sink = new VideoSampleSink(videoTrack);
```

#### Single retrieval

You can retrieve the sample presented at a given timestamp in seconds:
```ts
await sink.getSample(5);

// Extracting the first sample:
await sink.getSample(await videoTrack.getFirstTimestamp());

// Extracting the last sample:
await sink.getSample(Infinity);
```
This method returns the last sample with a timestamp less than or equal to the search timestamp, or `null` if there is no such sample.

#### Range iteration

You can use the `samples` iterator method to iterate over a contiguous range of samples:
```ts
// Iterate over all samples:
for await (const sample of sink.samples()) {
	console.log('Sample:', sample);
	// Do something with the sample

	sample.close();
}

// Iterate over all samples in a specific time range:
for await (const sample of sink.samples(5, 10)) {
	// ...
	sample.close();
}
```
The `samples` iterator yields the samples in [presentation order](#decode-vs-presentation-order) (sorted by timestamp).

#### Sparse iteration

Sometimes, you may want to retrieve the samples for multiple timestamps at once (for example, for generating thumbnails). While you could call `getSample` multiple times, the `samplesAtTimestamps` method provides a more efficient way:
```ts
for await (const sample of sink.samplesAtTimestamps([0, 1, 2, 3, 4, 5])) {
	// `sample` is either VideoSample or null
	sample.close();
}

// Any timestamp sequence is allowed:
sink.samplesAtTimestamps([1, 2, 3]);
sink.samplesAtTimestamps([4, 5, 5, 5]);
sink.samplesAtTimestamps([10, -2, 3]);
```
This method is more efficient than multiple calls to `getSample` because it avoids decoding the same packet twice.

In addition to arrays, you can pass any iterable into this method:
```ts
sink.samplesAtTimestamps(new Set([2, 3, 3, 4]));

sink.samplesAtTimestamps((function* () {
	for (let i = 0; i < 5; i++) {
		yield i;
	}
})());

sink.samplesAtTimestamps((async function* () {
	const firstTimestamp = await videoTrack.getFirstTimestamp();
	const lastTimestamp = await videoTrack.computeDuration();

	for (let i = 0; i <= 100; i++) {
		yield firstTimestamp + (lastTimestamp - firstTimestamp) * i / 100;
	}
})());
```

Passing an async iterable is especially useful when paired with `EncodedPacketSink`. Imagine you want to retrieve every key frame. A naive implementation might look like this:
```ts
// Naive, bad implementation: // [!code error]
const packetSink = new EncodedPacketSink(videoTrack);
const keyFrameTimestamps: number[] = [];

let currentPacket = await packetSink.getFirstPacket();
while (currentPacket) {
	keyFrameTimestamps.push(currentPacket.timestamp);
	currentPacket = await packetSink.getNextKeyPacket(currentPacket);
}

const sampleSink = new VideoSampleSink(videoTrack);
const keyFrameSamples = sampleSink.samplesAtTimestamps(keyFrameTimestamps);

for await (const sample of keyFrameSamples) {
	// ...
	sample.close();
}
```

The issue with this implementation is that it first iterates over all key packets before yielding the first sample. The better implementation is this:
```ts
// Better implementation:
const packetSink = new EncodedPacketSink(videoTrack);
const sampleSink = new VideoSampleSink(videoTrack);	

const keyFrameSamples = sampleSink.samplesAtTimestamps((async function* () {
	let currentPacket = await packetSink.getFirstPacket();

	while (currentPacket) {
		yield currentPacket.timestamp;
		currentPacket = await packetSink.getNextKeyPacket(currentPacket);
	}
})());

for await (const sample of keyFrameSamples) {
	// ...
	sample.close();
}
```

### `CanvasSink`

While `VideoSampleSink` extracts raw decoded video samples, you can use `CanvasSink` to extract these samples as canvases instead. In doing so, certain operations such as scaling, rotating, and cropping can also be handled by the sink. The downside is the additional VRAM requirements for the canvases' framebuffers.

::: info
This sink yields `HTMLCanvasElement` whenever possible, and falls back to `OffscreenCanvas` otherwise (in Worker contexts, for example).
:::

Create the sink like so:
```ts
import { CanvasSink } from 'mediabunny';

const sink = new CanvasSink(videoTrack, options);
```

Here, `options` has the following type:
```ts
type CanvasSinkOptions = {
	width?: number;
	height?: number;
	fit?: 'fill' | 'contain' | 'cover';
	rotation?: 0 | 90 | 180 | 270;
	crop?: { left: number; top: number; width: number; height: number };
	poolSize?: number;
};
```
- `width`\
	The width of the output canvas in pixels. When omitted but `height` is set, the width will be calculated automatically to maintain the original aspect ratio. Otherwise, the width will be set to the original width of the video.
- `height`\
	The height of the output canvas in pixels. When omitted but `width` is set, the height will be calculated automatically to maintain the original aspect ratio. Otherwise, the height will be set to the original height of the video.
- `fit`\
	*Required* when both `width` and `height` are set, this option sets the fitting algorithm to use.
	- `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
	- `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to letterboxing.
	- `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.
- `rotation`\
	The clockwise rotation by which to rotate the raw video frame. Defaults to the rotation set in the file metadata. Rotation is applied before cropping and resizing.
- `crop`\
	Specifies the rectangular region of the input video to crop to. The crop region will automatically be clamped to the dimensions of the input video track. Cropping is performed after rotation but before resizing.
- `poolSize`\
	See [Canvas pool](#canvas-pool).

Some examples:
```ts
// This sink yields canvases with the unaltered display dimensions of the track,
// and respecting the track's rotation metadata.
new CanvasSink(videoTrack);

// This sink yields canvases with a width of 1280 and a height that maintains the
// original display aspect ratio.
new CanvasSink(videoTrack, {
	width: 1280,
});

// This sink yields square canvases, with the video frame scaled to completely
// cover the canvas.
new CanvasSink(videoTrack, {
	width: 512,
	height: 512,
	fit: 'cover',
});

// This sink yields canvases with the unaltered coded dimensions of the track,
// and without applying any rotation.
new CanvasSink(videoTrack, {
	rotation: 0,
});
```

The methods for retrieving canvases are analogous to those on `VideoSampleSink`:
- `getCanvas`\
	Gets the canvas for a given timestamp; see [Single retrieval](#single-retrieval).
- `canvases`\
Iterates over a range of canvases; see [Range iteration](#range-iteration).
- `canvasesAtTimestamps`\
	Iterates over canvases at specific timestamps; see [Sparse iteration](#sparse-iteration).

These methods yield `WrappedCanvas` instances:
```ts
type WrappedCanvas = {
	// A canvas element or offscreen canvas.
	canvas: HTMLCanvasElement | OffscreenCanvas;
	// The timestamp of the corresponding video sample, in seconds.
	timestamp: number;
	// The duration of the corresponding video sample, in seconds.
	duration: number;
};
```

#### Canvas pool

By default, a new canvas is created for every canvas yielded by this sink. If you know you'll keep only a few canvases around at any given time, you should make use of the `poolSize` option. This integer value specifies the number of canvases in the pool; these canvases are then reused in a ring buffer / round-robin type fashion. This keeps the amount of allocated VRAM constant and relieves the browser from constantly allocating/deallocating canvases. A pool size of 0 or `undefined` disables the pool.

An illustration using a pool size of 3:
```ts
const sink = new CanvasSink(videoTrack, { poolSize: 3 });

const a = await sink.getCanvas(42);
const b = await sink.getCanvas(42);
const c = await sink.getCanvas(42);
const d = await sink.getCanvas(42);
const e = await sink.getCanvas(42);
const f = await sink.getCanvas(42);

assert(a.canvas === d.canvas);
assert(b.canvas === e.canvas);
assert(c.canvas === f.canvas);
assert(a.canvas !== b.canvas);
assert(a.canvas !== c.canvas);
```

For closed iterators, a pool size of 1 is sufficient:
```ts
const sink = new CanvasSink(videoTrack, { poolSize: 1 });
const canvases = sink.canvases();

for await (const { canvas, timestamp } of canvases) {
	// ...
}
```

## Audio data sinks

These sinks can only be used with an `InputAudioTrack`.

### `AudioSampleSink`

Use this sink to extract decoded [audio samples](./packets-and-samples#audiosample) from an audio track. The sink will automatically handle the decoding internally.

Create the sink like so:
```ts
import { AudioSampleSink } from 'mediabunny';

const sink = new AudioSampleSink(audioTrack);
```

The methods for retrieving samples are analogous to those on `VideoSampleSink`.
- `getSample`\
  	Gets the sample for a given timestamp; see [Single retrieval](#single-retrieval).
- `samples`\
  	Iterates over a range of samples; see [Range iteration](#range-iteration).
- `samplesAtTimestamps`\
  	Iterates over samples at specific timestamps; see [Sparse iteration](#sparse-iteration).

These methods yield [`AudioSample`](./packets-and-samples#audiosample) instances.

For example, let's use this sink to calculate the average loudness of an audio track using [root mean square](https://en.wikipedia.org/wiki/Root_mean_square):
```ts
const sink = new AudioSampleSink(audioTrack);

let sumOfSquares = 0;
let totalSampleCount = 0;

for await (const sample of sink.samples()) {
	const bytesNeeded = sample.allocationSize({ format: 'f32', planeIndex: 0 });
	const floats = new Float32Array(bytesNeeded / 4);
	sample.copyTo(floats, { format: 'f32', planeIndex: 0 });

	for (let i = 0; i < floats.length; i++) {
		sumOfSquares += floats[i] ** 2;
	}

	totalSampleCount += floats.length;
}

const averageLoudness = Math.sqrt(sumOfSquares / totalSampleCount);
```

### `AudioBufferSink`

While `AudioSampleSink` extracts raw decoded audio samples, you can use `AudioBufferSink` to directly extract [`AudioBuffer`](https://developer.mozilla.org/en-US/docs/Web/API/AudioBuffer) instances instead. This is particularly useful when working with the Web Audio API.

Create the sink like so:
```ts
import { AudioBufferSink } from 'mediabunny';

const sink = new AudioBufferSink(audioTrack);
```

The methods for retrieving audio buffers are analogous to those on `VideoSampleSink`:
- `getBuffer`\
	Gets the buffer for a given timestamp; see [Single retrieval](#single-retrieval).
- `buffers`\
	Iterates over a range of buffers; see [Range iteration](#range-iteration).
- `buffersAtTimestamps`\
	Iterates over buffers at specific timestamps; see [Sparse iteration](#sparse-iteration).

These methods yield `WrappedAudioBuffer` instances:
```ts
type WrappedAudioBuffer = {
	// An AudioBuffer that can be used with the Web Audio API.
	buffer: AudioBuffer;
	// The timestamp of the corresponding audio sample, in seconds.
	timestamp: number;
	// The duration of the corresponding audio sample, in seconds.
	duration: number;
};
```

For example, let's use this sink to play the last 10 seconds of an audio track:
```ts
const sink = new AudioBufferSink(audioTrack);
const audioContext = new AudioContext();
const lastTimestamp = await audioTrack.computeDuration();
const baseTime = audioContext.currentTime;

for await (const { buffer, timestamp } of sink.buffers(lastTimestamp - 10)) {
	const source = audioContext.createBufferSource();
	source.buffer = buffer;
	source.connect(audioContext.destination);
	source.start(baseTime + timestamp);
}
```
