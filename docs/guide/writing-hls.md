---
outline: [2, 4]
---

# Writing HLS

Mediabunny has full support for creating new HLS (.m3u8) playlists, both VOD and live. This page will go into HLS-specific behavior and advice. For general information about creating new media files (including HLS) in Mediabunny, refer to [Writing media files](./writing-media-files).

## Structure & mental model

When Mediabunny writes HLS, it will always create the following files:
- One master playlist
- One or more media playlists
- Zero or more media segment files

Mediabunny takes care of creating the playlists and segmenting the media data. All you need to describe are the tracks, the relationships between them, and their media data.

Media segments are always emitted as soon as they are complete. The master and media playlists are emitted upon [finalizing the output](../api/Output#finalize) when in VOD mode (the default). When in [live mode](#live-hls), they will be emitted each time they are updated.

## HLS outputs

HLS playlists are created through the same `Output` interface as all other media files in Mediabunny. The difference is that HLS creates multiple files, meaning a `PathedTarget` is required:
```ts
import { Output, PathedTarget, HlsOutputFormat, MpegTsOutputFormat } from 'mediabunny';

const output = new Output({
	format: new HlsOutputFormat({
		segmentFormat: new MpegTsOutputFormat(), // User-defined segment format
	}),
	target: new PathedTarget(
		'master.m3u8', // The path to the entry file
		({ path }) => {
			// Return a Target here
		},
	),
});
```

The `PathedTarget` requires that you return a [`Target`](../api/Target) for every file (identified by a [path](../api/FilePath)) that Mediabunny wants to write.

### No master playlist

If you only want to write a media playlist and not a master playlist, make use of [`NullTarget`](../api/NullTarget):
```ts
const output = new Output({
	target: new PathedTarget(
		'',
		({ path, isRoot }) => {
			if (isRoot) {
				return new NullTarget();
			}

			// ...
		},
	),
	// ...
});
```

Note that this might write out multiple media playlists based on the configured track pairability; see [Track groups & pairings](#track-groups--pairings).

## Target examples

You are free to use whichever target you want (see [list of targets](./writing-media-files#output-targets)), but here are some examples:

### Write to memory

```ts
const writtenFiles = new Map<string, ArrayBuffer>();

const output = new Output({
	target: new PathedTarget(
		'master.m3u8',
		({ path }) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				writtenFiles.set(path, target.buffer!);
			});

			return target;
		},
	),
	// ...
});

// ...
await output.finalize();

// The final files:
console.log(writtenFiles);
```

### Write to OPFS

```ts
const root = await navigator.storage.getDirectory();

const output = new Output({
	target: new PathedTarget(
		'master.m3u8',
		async ({ path }) => {
			const handle = await root.getFileHandle(path, { create: true });
			const writable = await handle.createWritable();
			return new StreamTarget(writable);
		},
	),
	// ...
});

// ...
await output.finalize();

// Final files now reside in OPFS
```

### Upload to a server

#### Stream upload

This code models a stream upload, where files are being uploaded *while* they are being created:

```ts
const promises: Promise<Response>[] = [];

const output = new Output({
	target: new PathedTarget(
		'master.m3u8',
		async ({ path, mimeType }) => {
			const { writable, readable } = new TransformStream<
				StreamTargetChunk,
				Uint8Array
			>({
				transform: (chunk, controller) =>
					controller.enqueue(chunk.data),
			});

			const url = `/upload?file=${encodeURIComponent(path)}`;
			const promise = fetch(url, {
				method: 'POST',
				body: readable,
				duplex: 'half',
				headers: {
					'Content-Type': mimeType,
				},
			});
			promises.push(promise);

			return new StreamTarget(writable);
		},
	),
	onFinalize: () => Promise.all(promises),
	// ...
});

// ...
await output.finalize();
// All files have been uploaded to the server
```

#### Monolithic upload

If streaming is not possible (e.g. when uploading to S3 via signed `PutObject`, which requires a known `Content-Length`), you can use [`BufferTarget`](../api/BufferTarget) with the [`onFinalize`](../api/BufferTargetOptions#onfinalize) option instead.

You could call `fetch` directly but this would halt Mediabunny's internals until the upload has completed. Instead, using a [`ConcurrentRunner`](../api/ConcurrentRunner) allows Mediabunny to keep producing data internally while the upload is in flight, while also allowing multiple concurrent uploads:

```ts
import { ConcurrentRunner, ... } from 'mediabunny';

// This Mediabunny utility class is used to allow up to two requests
// to run concurrently. When this number is exceeded, backpressure is
// automatically applied internally.
const runner = new ConcurrentRunner(2);

const output = new Output({
	target: new PathedTarget(
		'master.m3u8',
		({ path, mimeType }) =>
			new BufferTarget({
				onFinalize: buffer => runner.run(() =>
					fetch(`/upload?file=${encodeURIComponent(path)}`, {
						method: 'PUT',
						body: buffer,
						headers: {
							'Content-Type': mimeType,
						},
					})
				),
			}),
	),
	onFinalize: () => runner.flush(),
	// ...
});

await output.finalize();
// All files have been uploaded to the server
```

You can also set [`runner.parallelism`](../api/ConcurrentRunner#parallelism) at any time to adjust the concurrency dynamically, and use [`runner.inFlightCount`](../api/ConcurrentRunner#inflightcount) to inspect the current number of running tasks.

## Adding tracks & media

Output tracks can be registered using the usual approach by using [media sources](./media-sources):
```ts
const videoSource = new VideoSampleSource(/* ... */);
const audioSource = new AudioSampleSource(/* ... */);

output.addVideoTrack(videoSource);
output.addAudioTrack(audioSource);

await output.start();
```

Then, add media data like normal. Since Mediabunny takes care of segmentation automatically, it is required to perform [Packet buffering](./writing-media-files#packet-buffering) internally. Therefore, try writing media data in a quasi-interleaved fashion to keep memory usage bounded.

### Multiple resolutions

A common pattern is to offer the same content in multiple resolutions and bitrates. This requires encoding the content multiple times, sometimes with additional downscaling. Mediabunny's [media sources](./media-sources) make this pattern a breeze.

Let's suppose we have a 1080p main video stream. We want to provide a 1080p, 720p, 480p, and 360p variant in the HLS playlist. For that, use this pattern:
```ts
const source1080p = new VideoSampleSource({
	codec: 'avc',
	bitrate: QUALITY_VERY_HIGH,
});
const source720p = new VideoSampleSource({
	codec: 'avc',
	bitrate: QUALITY_HIGH,
	transform: {
		// Frames will be automatically resized to 720p before being encoded
		height: 720,
	},
});
const source480p = new VideoSampleSource({
	codec: 'avc',
	bitrate: QUALITY_MEDIUM,
	transform: {
		height: 480,
	},
});
const source360p = new VideoSampleSource({
	codec: 'avc',
	bitrate: QUALITY_LOW,
	transform: {
		height: 360,
	},
});

const sources = [source1080p, source720p, source480p, source360p];
for (const source of sources) {
	output.addVideoTrack(source);
}

await output.start();

// Then, when adding a new frame:
const sample = // ...
for (const source of sources) {
	await source.add(sample);
}
```

You can extend this pattern to offer content in multiple codecs as well.

For the full list of transformation options, see [`VideoTransformOptions`](../api/VideoTransformOptions) and [`AudioTransformOptions`](../api/AudioTransformOptions).

---

If you're using the [Conversion API](./converting-media-files), you achieve the same thing using [output track fan-out](./converting-media-files#track-fan-out):
```ts
const conversion = await Conversion.init({
	input,
	output,
	video: [
		{ height: 1080, bitrate: QUALITY_VERY_HIGH },
		{ height: 720, bitrate: QUALITY_HIGH },
		{ height: 480, bitrate: QUALITY_MEDIUM },
		{ height: 360, bitrate: QUALITY_LOW },
	],
});
```

### Track metadata

Often you'll want to provide additional [track metadata](../api/BaseTrackMetadata) when dealing with multiple tracks. For example:
```ts
output.addVideoTrack(videoSource);
output.addAudioTrack(audioSourceEn, { languageCode: 'en', name: 'English' });
output.addAudioTrack(audioSourceDe, { languageCode: 'de', name: 'German' });
output.addAudioTrack(audioSourceEs, { languageCode: 'es', name: 'Spanish' });
```

### I-frame only tracks

A track registered like this will be emitted via `#EXT-X-I-FRAME-STREAM-INF`:
```ts
output.addVideoTrack(videoSource, { hasOnlyKeyPackets: true });
```

Note that it is an error to add non-key packets to a track like this.

### DATE-TIME tags

In order to emit `#EXT-X-PROGRAM-DATE-TIME` tags in the media playlist, which map each media time to a definitive point in time, set `isRelativeToUnixEpoch` in the track metadata:
```ts
output.addVideoTrack(videoSource, { isRelativeToUnixEpoch: true });
```

This declares that the timestamps added by you are not relative to the composition start (0), but to the Unix epoch (1 Jan 1970, midnight UTC):
```ts
const source = new EncodedVideoPacketSource('avc');
output.addVideoTrack(source, { isRelativeToUnixEpoch: true });

await output.start();

// 10 FPS starting on 1 Jan 2024, midnight UTC.
// The timestamps *are* Unix timestamps:
await source.add(new EncodedPacket(data, type, 1704067200.0, 0.1));
await source.add(new EncodedPacket(data, type, 1704067200.1, 0.1));
await source.add(new EncodedPacket(data, type, 1704067200.2, 0.1));
// ...
```

The above code will emit a media playlist like this:
```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
#EXT-X-PROGRAM-DATE-TIME:2024-01-01T00:00:00.000Z
segments-1-1.ts

#EXTINF:2,
#EXT-X-PROGRAM-DATE-TIME:2024-01-01T00:00:02.000Z
segments-1-2.ts

...
```

## Track groups & pairings

Mediabunny allows you to add tracks to an HLS playlist in a flat way, but real HLS playlists are structured: Tracks are grouped into variants and media renditions, which imply a track pairability graph: some tracks can be paired with each other (can be presented together), others can't.

You can control these track pairings using _track groups_. Tracks can be assigned to zero or more groups, and groups can be paired:
```ts
import { OutputTrackGroup } from 'mediabunny';

const groupA = new OutputTrackGroup();
const groupB = new OutputTrackGroup();
const groupC = new OutputTrackGroup();

// Pairs A with C and C with A
groupA.pairWith(groupC);

// Track is in one group
output.addVideoTrack(source, { group: groupA });

// Track is in multiple groups
output.addVideoTrack(source, { group: [groupB, groupC] });

// Track is in no groups
output.addVideoTrack(source, { group: [] });
```

### Pairing rule

Two output tracks are considered _pairable_ if at least one of these is true:
- Both tracks are in the same group **and** have a different type (video, audio, subtitle)
- They are in separate groups that have been paired with each other

When not specified, all tracks are automatically assigned to [`Output.defaultTrackGroup`](../api/Output#defaulttrackgroup). This means that all tracks can be paired with any other track of a different type, but no two tracks of the same type can be paired.

### Examples

#### Default pairing (n:k)

Imagine this four-track configuration:
```ts
output.addVideoTrack(source1);
output.addVideoTrack(source2);

output.addAudioTrack(source3);
output.addAudioTrack(source4);
```

Since no track groups are specified, all tracks will be assigned to [`Output.defaultTrackGroup`](../api/Output#defaulttrackgroup). Assuming only one video and audio codec, this leads to a master playlist like this:
```m3u8
#EXTM3U

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-1",NAME="audio-1",URI="audio-1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-1",NAME="audio-1",URI="audio-2.m3u8"

#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio-1"
video-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x480,AUDIO="audio-1"
video-2.m3u8
```

To maintain the "every video track can be paired with every audio track" configuration, the audio tracks have been extracted into a media rendition group via `#EXT-X-MEDIA`.

:::info
Note that tracks in a media rendition group should differ in metadata. Thus, when creating tracks in this configuration, make sure to provide metadata options like `language` or `name` to differentiate the tracks.
:::

#### Codec alternatives

Imagine this configuration where we provide the audio track in two different codecs for broader support:
```ts
output.addVideoTrack(source1);
output.addVideoTrack(source2);

// Different audio codecs:
output.addAudioTrack(sourceAac);
output.addAudioTrack(sourceAc3);
```

This will be emitted as a master playlist like this, which covers every video-audio track permutation:
```m3u8
#EXTM3U

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-1",NAME="audio-1",URI="audio-1.m3u8"

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-2",NAME="audio-2",URI="audio-2.m3u8"

#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio-1"
video-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,ac-3",RESOLUTION=1280x720,AUDIO="audio-2"
video-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x480,AUDIO="audio-1"
video-2.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,ac-3",RESOLUTION=640x480,AUDIO="audio-2"
video-2.m3u8
```

#### One audio per video

To achieve a 1:1 pairing between video and audio tracks, we can group tracks like this:
```ts
const a = new OutputTrackGroup();
const b = new OutputTrackGroup();

output.addVideoTrack(source1, { group: a });
output.addVideoTrack(source2, { group: b });

output.addAudioTrack(source3, { group: a });
output.addAudioTrack(source4, { group: b });
```

This will lead to a master playlist like this:
```m3u8
#EXTM3U

#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720
video-and-audio-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x480
video-and-audio-2.m3u8
```

#### Standalone tracks

If all tracks are meant to be standalone, make sure no two are pairable with each other. One way to express this is:
```ts
output.addVideoTrack(source1, { group: [] });
output.addVideoTrack(source2, { group: [] });

output.addAudioTrack(source3, { group: [] });
output.addAudioTrack(source4, { group: [] });
```

This creates the following master playlist:
```m3u8
#EXTM3U

#EXT-X-STREAM-INF:CODECS="avc1.64001f",RESOLUTION=1280x720
video-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f",RESOLUTION=640x480
video-2.m3u8
#EXT-X-STREAM-INF:CODECS="mp4a.40.2"
audio-1.m3u8
#EXT-X-STREAM-INF:CODECS="mp4a.40.2"
audio-2.m3u8
```

#### Arbitrary pairings

Any symmetric track pairability graph can be modeled using track groups. The construction is as follows:
- Create one group per track
- Assign every track $T_i$ to $G_i$
- If $T_i$ and $T_j$ should be pairable, pair $G_i$ with $G_j$

### Illegal pairings

Not all track pairings can be represented in HLS master playlists. Specifically, it is forbidden to pair tracks of the same type with each other:
```ts
const a = new OutputTrackGroup();
const b = new OutputTrackGroup();
a.pairWith(b);

output.addVideoTrack(source1, { group: a });
output.addVideoTrack(source2, { group: b });
```

This will cause Mediabunny to raise a warning and treat the two tracks as unpaired.

## Output configuration

Mediabunny offers various ways to configure the HLS output via [`HlsOutputFormatOptions`](../api/HlsOutputFormatOptions).

### Segment format

For tree-shaking purposes, you must declare the format of each media segment yourself. Any [output format](./output-formats) works, although not all of them are spec-compliant with HLS. You should stick to the following, well-supported options:

#### MPEG-TS
Tried and true:
```ts
new HlsOutputFormat({
	segmentFormat: new MpegTsOutputFormat(),
});
```

#### CMAF
```ts
new HlsOutputFormat({
	segmentFormat: new CmafOutputFormat(),
});
```

Note that this format emits an init segment in addition to all of the media segments.

#### MP3/ADTS/WAV
These work fine when packaging a single track into a segment:
```ts
// MP3:
new HlsOutputFormat({
	segmentFormat: new Mp3OutputFormat(),
});

// ADTS:
new HlsOutputFormat({
	segmentFormat: new AdtsOutputFormat(),
});

// WAV:
new HlsOutputFormat({
	segmentFormat: new WavOutputFormat(),
});
```

#### Mixed formats

You may want to package audio data into .aac files and video data into .ts files. For this, you can specify an array of output formats:
```ts
new HlsOutputFormat({
	segmentFormat: [
		new AdtsOutputFormat(), // For audio segments
		new MpegTsOutputFormat(), // For video segments
	],
});
```

Mediabunny will then use the first format that can contain all tracks of the segment.

### File names

By default, Mediabunny will create the following file names:
- Master playlist `pathedTarget.rootPath` (name specified by you)
	- Media playlist `'playlist-1.m3u8'`
		- Media segment `'segment-1-1.ts'`
		- Media segment `'segment-1-2.ts'`
		- ...
	- Media playlist `'playlist-2.m3u8'`
		- Init segment `'init-1.m4s'` (Emitted for some segment formats)
		- Media segment `'segment-2-1.m4s'`
		- Media segment `'segment-2-2.m4s'`
		- ...
	- Media playlist `'playlist-3.m3u8'`
		- Single-file segment `segments-3.ts`
	- ...

You can fully customize these names using the following options:
- [`getPlaylistPath`](../api/HlsOutputFormatOptions#getplaylistpath)
- [`getSegmentPath`](../api/HlsOutputFormatOptions#getSegmentPath)
- [`getInitPath`](../api/HlsOutputFormatOptions#getInitPath)

### Segment duration

Use `targetDuration` to set the desired maximum duration for each segment:
```ts
new HlsOutputFormat({
	// ...
	targetDuration: 10, // Defaults to 2 (seconds)
});
```

Mediabunny will then try to maximize the length of each segment while making sure it doesn't exceed the target duration.

Since Mediabunny will only create new segments on key frame boundaries, make sure to provide a key frame at least every `targetDuration` seconds. If you don't, it has no choice but to create longer segments. You can use [`VideoEncodingConfig.keyFrameInterval`](../api/VideoEncodingConfig#keyframeinterval) to control key frame rate.

### Single-file segments

Since HLS supports byte subrange requests, you may want to package all media data into one giant monolithic segment file:
```ts
new HlsOutputFormat({
	// ...
	singleFilePerPlaylist: true,
});
```

This will emit media playlists like this:
```m3u8
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
#EXT-X-BYTERANGE:12345@0
segments-1.ts

#EXTINF:2,
#EXT-X-BYTERANGE:67890@12345
segments-1.ts

...
```

## Live HLS

By default, created HLS playlists are assumed to be VODs. If you instead want to create HLS live streams that are to be consumed while they are being produced, you can use live mode:
```ts
new HlsOutputFormat({
	// ...
	live: true,
});
```

Compared to VOD mode, live mode has these main behavioral differences:
- The `#EXT-X-PLAYLIST-TYPE:VOD` tag is omitted from media playlists
- Media playlists will be emitted as soon as they have one finished segment
- The master playlist will be emitted as soon as every media playlist has been emitted at least once
- Media playlists will be re-emitted each time they are updated (new segment or stream ended)
- The master playlist will be re-emitted each time a media playlist is updated (to refine bitrate values)
- Media playlists will only have the `#EXT-X-ENDLIST` tag when the stream has ended

Since master and media playlists will be written more than once, multiple targets will be requested for the same path. Make sure to return a different `Target` instance each time.

To guarantee A/V sync, make sure to use [DATE-TIME tags](#date-time-tags) when using live mode.

### Ending the stream

Finalizing the output ends the stream for all media playlists and appends `#EXT-X-ENDLIST` to each one of them:
```ts
await output.finalize();
```

You can end the stream for a subset of tracks by closing tracks individually. When the last open track of any media playlist is closed (meaning no more media data can be added), that media playlist's stream will be ended:
```ts
// Assuming a stream with video & audio:

videoSource.close();
// Audio is still running, live stream keeps going
audioSource.close();
// No more media data can come in, live stream has ended
```

### Removing old segments

By default, Mediabunny will keep appending new segments to media playlists without ever removing the old ones. This means that media playlists grow in size until the stream has ended.

To set a cap on the maximum number of segments per playlist, and to tell Mediabunny to pop old segments off the playlist, use `maxLiveSegmentCount`:
```ts
new HlsOutputFormat({
	// ...
	maxLiveSegmentCount: 500, // Defaults to Infinity
	onSegmentPopped: (path, segmentInfo) => // ...
});
```

Whenever a segment is popped off the playlist in this fashion, the `onSegmentPopped` callback is called, which you can use to be notified of a segment being removed and to take action; for example, to delete the segment file. The callback is passed the path of the segment and [`HlsOutputSegmentInfo`](../api/HlsOutputSegmentInfo).

::: info
`onSegmentPopped` is not called when `singleFilePerPlaylist` is enabled.
:::

## Subtitles

Writing subtitles to HLS playlists is not currently supported. Sorry!