# Writing media files

Mediabunny enables you to create media files with very fine levels of control. You can add an arbitrary number of video, audio and subtitle tracks to a media file, and precisely control the timing of media data. This library supports [many output file formats](./output-formats). Using [output targets](#output-targets), you can decide if you want to build up the entire file in memory or stream it out in chunks as it's being created - allowing you to create very large files.

Mediabunny provides many ways to supply media data for output tracks, nicely integrating with the WebCodecs API, but also allowing you to use your own encoding stack if you wish. These [media sources](./media-sources) come in multiple levels of abstraction, enabling easy use for common use cases while still giving you fine-grained control if you need it.

## Creating an output

Media file creation in Mediabunny revolves around a central class, `Output`. One instance of `Output` represents one media file you want to create.

Start by creating a new instance of `Output` using the desired configuration of the file you want to create:
```ts
import { Output, Mp4OutputFormat, BufferTarget } from 'mediabunny';

// In this example, we'll be creating an MP4 file in memory:
const output = new Output({
	format: new Mp4OutputFormat(),
	target: new BufferTarget(),
});
```

See [Output formats](./output-formats) for a full list of available output formats.\
See [Output targets](#output-targets) for a full list of available output targets.

You can always access `format` and `target` on the output:
```ts
output.format; // => Mp4OutputFormat	
output.target; // => BufferTarget
```

## Adding tracks

There are a couple of methods on an `Output` that you can use to add tracks to it:

```ts
output.addVideoTrack(videoSource);
output.addAudioTrack(audioSource);
output.addSubtitleTrack(subtitleSource);
```

For each track you want to add, you'll need to create a unique [media source](./media-sources) for it. You'll be able to add media data to the output via these media sources. A media source can only ever be used for one output track.

Optionally, you can specify additional track metadata when adding tracks:
```ts
// This specifies that the video track should be rotated by 90 degrees
// clockwise before being displayed by video players, and that a frame rate
// of 30 FPS is expected.
output.addVideoTrack(videoSource, {
	// Clockwise rotation in degrees
	rotation: 90,
	// Expected frame rate in hertz
	frameRate: 30,
});

// This adds two audio tracks; one in English and one in German.
output.addAudioTrack(audioSourceEng, {
	language: 'eng', // ISO 639-2/T language code
	name: 'Developer Commentary', // Sets a user-defined track name
	disposition: { commentary: true }, // Sets additional flags in the file
});
output.addAudioTrack(audioSourceGer, {
	language: 'ger',
});

// This adds multiple subtitle tracks, all for different languages.
output.addSubtitleTrack(subtitleSourceEng, { language: 'eng' });
output.addSubtitleTrack(subtitleSourceGer, { language: 'ger' });
output.addSubtitleTrack(subtitleSourceSpa, { language: 'spa' });
output.addSubtitleTrack(subtitleSourceFre, { language: 'fre' });
output.addSubtitleTrack(subtitleSourceIta, { language: 'ita' });
```

::: info
The optional `frameRate` video track metadata option specifies the expected frame rate of the video. All timestamps and durations of frames that will be added to this track will be snapped to the specified frame rate. You should avoid adding frames more often than the rate permits, as this will lead to multiple frames having the same timestamp.

To precisely achieve common fractional frame rates, make sure to use their exact fractional forms:
$23.976 \rightarrow 24000/1001$\
$29.97 \rightarrow 30000/1001$\
$59.94 \rightarrow 60000/1001$
:::

As an example, let's add two tracks to our output:
- A video track driven by the contents of a `<canvas>` element, encoded using AVC
- An audio track driven by the user's microphone input, encoded using AAC

```ts
import { CanvasSource, MediaStreamAudioTrackSource } from 'mediabunny';

// Assuming `canvasElement` exists
const videoSource = new CanvasSource(canvasElement, {
	codec: 'avc',
	bitrate: 1e6, // 1 Mbps	
});

const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const audioStreamTrack = stream.getAudioTracks()[0];
const audioSource = new MediaStreamAudioTrackSource(audioStreamTrack, {
	codec: 'aac',
	bitrate: 128e3, // 128 kbps
});

output.addVideoTrack(videoSource, { frameRate: 30 });
output.addAudioTrack(audioSource);
```

::: warning
Adding tracks to an `Output` will throw if the track is not compatible with the output format. Be sure to respect the [properties](./output-formats#format-properties) of the output format when adding tracks.
:::

## Setting metadata tags

Mediabunny lets you write additional descriptive metadata tags to an output file, such as title, artist, or cover art:

```ts
output.setMetadataTags({
	title: 'Big Buck Bunny',
	artist: 'Blender Foundation',
	date: new Date('2008-05-20'),
	images: [{
		data: new Uint8Array([...]),
		mimeType: 'image/jpeg',
		kind: 'coverFront',
	}],
});
```

If you add metadata tags, you must call this method *before* starting the `Output`.

For more info on which tags you can write, see [`MetadataTags`](../api/MetadataTags).

## Starting an output

After all tracks have been added to the `Output`, you need to *start* it. Starting an output spins up the writing process, allowing you to now start sending media data to the output file. It also prevents you from adding any new tracks to it.

```ts
await output.start(); // Resolves once the output is ready to receive media data
```

## Adding media data

After starting an `Output`, you can use the media sources you used to add tracks to pipe media data to the output file. The API for this is different for each [media source](./media-sources), but it typically looks something like this:
```ts
mediaSource.add(...);
```

In our example, as soon as we called `start`, the user's microphone input will be piped to the output file. However, we still need to add the data from our canvas. We might do something like this:
```ts
let framesAdded = 0;
const intervalId = setInterval(() => {
	const timestampInSeconds = framesAdded / 30;
	const durationInSeconds = 1 / 30;

	// Captures the canvas state at the time of calling `add`:
	videoSource.add(timestampInSeconds, durationInSeconds);
	framesAdded++;
}, 1000 / 30);
```

And then we'll let this run for as long as we want to capture media data.

## Finalizing an output

Once all media data has been added, the `Output` needs to be *finalized*. Finalization finishes all remaining encoding
work and writes the remaining data to create the final, playable media file.
```ts
await output.finalize(); // Resolves once the output is finalized
```

::: warning
After calling `finalize`, adding more media data to the output results in an error.
:::

In our example, we'll need to do this:
```ts
clearInterval(intervalId); // Stops the canvas loop
audioStreamTrack.stop(); // Stops capturing the user's microphone

await output.finalize();

const file = output.target.buffer; // => Uint8Array
```

## Canceling an output

Sometimes, you may want to cancel the ongoing creation of an output file. For this, use the `cancel` method:
```ts
await output.cancel(); // Resolves once the output is canceled
```

This automatically frees up all resources used by the output process, such as closing all encoders or releasing the
writer.

::: warning
After calling `cancel`, adding more media data to the output results in an error.
:::

In our example, we would do this:
```ts	
clearInterval(intervalId); // Stops the canvas loop
audioStreamTrack.stop(); // Stops capturing the user's microphone

await output.cancel();

// The output is canceled
```	

## Checking output state

You can always check the current state the output is in using its `state` property:
```ts
output.state; // => 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized'
```

- `'pending'` - The output hasn't been started or canceled yet; new tracks can be added.
- `'started'` - The output has been started and is ready to receive media data; tracks can no longer be added. 
- `'finalizing'` - `finalize` has been called but hasn't resolved yet; no more media data can be added.
- `'finalized'` - The output has been finalized and is done writing the file.
- `'canceled'` - The output has been canceled.

## Output targets

The _output target_ determines where the data created by the `Output` will be written. This library offers a couple of targets.

---

All targets have an optional `onwrite` callback you can set to monitor which byte regions are being written to:
```ts
target.onwrite = (start, end) => {
	// ...
};
```

You can use this to track the size of the output file as it grows. But be warned, this function is chatty and gets called *extremely* frequently.

### `BufferTarget`

This target writes all data to a single, contiguous, in-memory `ArrayBuffer`. This buffer will automatically grow as the file becomes larger. Usage is straightforward:
```ts
import { Output, BufferTarget } from 'mediabunny';

const output = new Output({
	target: new BufferTarget(),
	// ...
});

// ...

output.target.buffer; // => null
await output.finalize();
output.target.buffer; // => ArrayBuffer
```

This target is a great choice for small-ish files (< 100 MB), but since all data will be kept in memory, using it for large files is suboptimal. If the output gets very large, the page might crash due to memory exhaustion. For these cases, using `StreamTarget` is recommended.

### `StreamTarget`

This target passes you the data written by the `Output` in small chunks, requiring you to pipe that data elsewhere to manually assemble the final file. Example use cases include writing the file directly to disk, or uploading it to a server over the network.

`StreamTarget` makes use of the Streams API, meaning you'll need to pass it an instance of `WritableStream`:
```ts
import { Output, StreamTarget, StreamTargetChunk } from 'mediabunny';

const writable = new WritableStream({
	write(chunk: StreamTargetChunk) {
		chunk.data; // => Uint8Array
		chunk.position; // => number

		// Do something with the data...
	}
});

const output = new Output({
	target: new StreamTarget(writable),
	// ...
});
```

Each chunk written to the `WritableStream` represents a contiguous chunk of bytes of the output file, `data`, that is expected to be written at the given byte offset, `position`. The `WritableStream` will automatically be closed when `finalize` or `cancel` are called on the `Output`.

::: warning
Note that some byte regions in the output file may be written to multiple times. It is therefore **incorrect** to construct the final file by simply concatenating all `Uint8Array`s together - you **must** write each chunk of data at the specified byte offset position _in the order_ in which the chunks arrived. If you don't do this, your output file will likely be invalid or corrupted.

Some [output formats](./output-formats) have *append-only* writing modes in which the byte offset of a written chunk will always be equal to the total number of bytes in all previously written chunks. In other words, when writing is append-only, simply concatening all `Uint8Array`s yields the correct result. Some APIs (like `appendBuffer` of Media Source Extensions) require this, so make sure to configure your output format accordingly for those cases.
:::

#### Chunked mode

By default, data will be emitted by the `StreamTarget` as soon as it is available. In some formats, these may lead to hundreds of write events per second. If you want to reduce the frequency of writes, `StreamTarget` offers an alternative "chunked mode" in which data will first be accumulated into large chunks of a given size in memory, and then only be emitted once a chunk is completely full.

```ts
new StreamTarget(writable, {
	chunked: true,
	chunkSize: 2 ** 20, // Optional; defaults to 16 MiB
});
```

#### Applying backpressure

Sometimes, the `Output` may produce new data faster than you are able to write it. In this case, you want to communicate to the `Output` that it should "chill out" and slow down to match the pace that the `WritableStream` is able to handle. When using `StreamTarget`, the `Output` will automatically respect the backpressure applied by the `WritableStream`. For this, it is useful to understand the [Stream API concepts](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Concepts) of how to apply backpressure.

For example, the writable may apply backpressure by returning a promise in `write`:
```ts
const writable = new WritableStream({
	write(chunk: StreamTargetChunk) {
		// Pretend writing out data takes 10 milliseconds:
		return new Promise(resolve => setTimeout(resolve, 10));
	}
});
```

::: info
In order for the writable's backpressure to ripple through the entire pipeline, you must make sure to correctly respect the [backpressure applied by media sources](./media-sources#backpressure).
:::

#### Usage with the File System API

`StreamTargetChunk` is designed such that it is compatible with the File System API's `FileSystemWritableFileStream`. This means, if you want to write data directly to disk, you can simply do something like this:

```ts
const handle = await window.showSaveFilePicker();
const writableStream = await handle.createWritable();

const output = new Output({
	target: new StreamTarget(writableStream),
	// ...
});

// ...

await output.finalize(); // Will automatically close the writable stream
```

### `FilePathTarget`

This target writes to a file at the specified path. It is intended for server-side usage in Node, Bun, or Deno, and offers a simpler API than `StreamTarget` when you just want to write directly to a file path.

```ts
import { Output, FilePathTarget } from 'mediabunny';

const output = new Output({
	target: new FilePathTarget('/path/to/output.mp4'),
	// ...
});

// ...

await output.finalize(); // Will automatically close the file handle
```

The internally held file handle will be closed when `finalize` or `cancel` are called on the `Output`.

Writing is chunked by default, for performance. Like `StreamTarget`, you can configure chunked mode options:
```ts
new FilePathTarget('/path/to/output.mp4', {
	chunked: false, // Disable chunking (slower)
	chunkSize: 2 ** 20, // Optional; defaults to 16 MiB
});
```

### `NullTarget`

This target simply discards all data that is passed into it. It is useful for when you need an `Output` but extract data from it differently, for example through output format-specific callbacks or encoder events.

As an example, here we create a fragmented MP4 file and directly handle the individual fragments:
```ts
import { Output, NullTarget, Mp4OutputFormat } from 'mediabunny';

let ftyp: Uint8Array;
let lastMoof: Uint8Array;

const output = new Output({
	target: new NullTarget(),
	format: new Mp4OutputFormat({
		fastStart: 'fragmented',
		onFtyp: (data) => {
			ftyp = data;
		},
		onMoov: (data) => {
			const header = new Uint8Array(ftyp.length + data.length);
			header.set(ftyp, 0);
			header.set(data, ftyp.length);

			// Do something with the header...
		},
		onMoof: (data) => {
			lastMoof = data;
		},
		onMdat: (data) => {
			const segment = new Uint8Array(lastMoof.length + data.length);
			segment.set(lastMoof, 0);
			segment.set(data, lastMoof.length);

			// Do something with the segment...
		},
	}),
});
```

## Packet buffering

Some [output formats](./output-formats) require *packet buffering* for multi-track outputs. Packet buffering occurs because the `Output` must wait for data from all tracks for a given timestamp to continue writing data. For example, should you first encode all your video frames and then encode the audio afterward, the `Output` will have to hold all of the video frames in memory until the audio packets start coming in. This might lead to memory exhaustion should your video be very long. When there is only one media track, this issue does not arise.

Check the [Output formats](./output-formats) page to see which format configurations require packet buffering.

---

If your output format configuration requires packet buffering, make sure to add media data in a somewhat interleaved way to keep memory usage low. For example, if you're creating a 5-minute file, add your data in chunks - 10 seconds of video, then 10 seconds of audio, then repeat - instead of first adding all 300 seconds of video followed by all 300 seconds of audio.

::: info
If this kind of chunking isn't possible for your use case, try adding the media with the overall smaller data footprint first: First add the 300 seconds of audio, then add the 300 seconds of video.
:::

## Output MIME type

Sometimes you may want to retrieve the MIME type of the file created by an `Output`. For example, when working with Media Source Extensions, [`addSourceBuffer`](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/addSourceBuffer) requires the file's full MIME type, including codec strings.

For this, use the following method:
```ts
output.getMimeType(); // => Promise<string>
```

This may resolve to a string like this:
```
video/mp4; codecs="avc1.42c032, mp4a.40.2"
```

::: warning
The promise returned by `getMimeType` only resolves once the precise codec strings for all tracks of the `Output` are known - meaning it potentially needs to wait for all encoders to be fully initialized. Therefore, make sure not to get yourself into a deadlock: Awaiting this method before adding media data to tracks will result in the promise never resolving.
:::

If you don't care about specific track codecs, you can instead use the simpler [`mimeType`](./output-formats#output-format-properties) property on the `Output`'s format:
```ts
output.format.mimeType; // => string
```