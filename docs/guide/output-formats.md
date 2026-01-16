# Output formats

## Introduction

An _output format_ specifies the container format of the data written by an `Output`. Mediabunny supports many commonly used container formats, each having format-specific options.

Many formats also offer *data callbacks*, which are special callbacks that fire for specific data regions in the output file.

### Output format properties

All output formats have a common set of properties you can query.

```ts
// Get the format's file extension:
format.fileExtension; // => '.mp4'

// Get the format's base MIME type:
format.mimeType; // => 'video/mp4'

// Check which codecs can be contained by the format:
format.getSupportedCodecs(); // => MediaCodec[]
format.getSupportedVideoCodecs(); // => VideoCodec[]
format.getSupportedAudioCodecs(); // => AudioCodec[]
format.getSupportedSubtitleCodecs(); // => SubtitleCodec[]

// Check if the format supports video tracks with rotation metadata:
format.supportsVideoRotationMetadata; // => boolean
```

Refer to the [compatibility table](./supported-formats-and-codecs.md#compatibility-table) to see which codecs can be used with which output format.

Formats also differ in the amount and types of tracks they can contain. You can retrieve this information using:
```ts
format.getSupportedTrackCounts(); // => TrackCountLimits

type TrackCountLimits = {
	video: { min: number, max: number },
	audio: { min: number, max: number },
	subtitle: { min: number, max: number },
	total: { min: number, max: number },
};
```

### Append-only writing

Some output format configurations write in an *append-only* fashion. This means they only ever add new data to the end, and never have to seek back to overwrite a previously-written section of the file. Or, put formally: the byte offset of any write is exactly equal to the number of bytes written before it.

Append-only formats, in combination with [`StreamTarget`](./writing-media-files#streamtarget), have some useful properties. They enable use with [Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API) and allow for trivial streaming across the network, such as for file uploads.

## MP4

This output format creates MP4 files.
```ts
import { Output, Mp4OutputFormat } from 'mediabunny';

const output = new Output({
	format: new Mp4OutputFormat(options),
	// ...
});
```

The following options are available:
```ts
type IsobmffOutputFormatOptions = {
	fastStart?: false | 'in-memory' | 'reserve' | 'fragmented';
	minimumFragmentDuration?: number;
	metadataFormat?: 'mdir' | 'mdta' | 'udta' | 'auto';

	onFtyp?: (data: Uint8Array, position: number) => unknown;
	onMoov?: (data: Uint8Array, position: number) => unknown;
	onMdat?: (data: Uint8Array, position: number) => unknown;
	onMoof?: (data: Uint8Array, position: number, timestamp: number) => unknown;
};
```
- `fastStart`\
	Controls the placement of metadata in the file. Placing metadata at the start of the file is known as "Fast Start" and provides certain benefits: The file becomes easier to stream over the web without range requests, and sites like YouTube can start processing the video while it's uploading. However, placing metadata at the start of the file can require more processing and memory in the writing step. This library provides full control over the placement of metadata by setting `fastStart` to one of these options:
	- `false`\
		Disables Fast Start, placing the metadata at the end of the file. Fastest and uses the least memory.
	- `'in-memory'`\
		Produces a file with Fast Start by keeping all media chunks in memory until the file is finalized. This produces a high-quality and compact output at the cost of a more expensive finalization step and higher memory requirements.
		::: info
		This option ensures [append-only writing](#append-only-writing), although all the writing happens in bulk, at the end.
		:::
	- `'reserve'`\
		Produces a file with Fast Start by reserving space at the start of the file into which the metadata will be written later. This requires knowledge about the expected length of the file beforehand. When using this option, you must set the [`maximumPacketCount`](../api/BaseTrackMetadata#maximumpacketcount) field in the track metadata for all tracks.
	- `'fragmented'`\
		Produces a _fragmented MP4 (fMP4)_ file, evenly placing sample metadata throughout the file by grouping it into "fragments" (short sections of media), while placing general metadata at the beginning of the file. Fragmented files are ideal in streaming contexts, as each fragment can be played individually without requiring knowledge of the other fragments. Furthermore, they remain lightweight to create no matter how large the file becomes, as they don't require media to be kept in memory for very long. However, fragmented files are not as widely and wholly supported as regular MP4 files, and some players don't provide seeking functionality for them.
		::: info
		This option ensures [append-only writing](#append-only-writing).
		:::
		::: warning
		This option requires [packet buffering](./writing-media-files#packet-buffering).
		:::
	- `undefined`\
		The default option; it behaves like `'in-memory'` when using [`BufferTarget`](./writing-media-files#buffertarget) and like `false` otherwise.
- `minimumFragmentDuration`\
	Only relevant when `fastStart` is `'fragmented'`. Sets the minimum duration in seconds a fragment must have to be finalized and written to the file. Defaults to 1 second.
- `metadataFormat`\
	The metadata format to use for writing metadata tags.
	- `'auto'` (default): Behaves like `'mdir'` for MP4 and like `'udta'` for QuickTime, matching FFmpeg's default behavior.
	- `'mdir'`: Write tags into `moov/udta/meta` using the 'mdir' handler format.
	- `'mdta'`: Write tags into `moov/udta/meta` using the 'mdta' handler format, equivalent to FFmpeg's `use_metadata_tags` flag. This allows for custom keys of arbitrary length.
	- `'udta'`: Write tags directly into `moov/udta`.
- `onFtyp`\
	Will be called once the ftyp (File Type) box of the output file has been written.
- `onMoov`\
	Will be called once the moov (Movie) box of the output file has been written.
- `onMdat`\
	Will be called for each finalized mdat (Media Data) box of the output file. Usage of this callback is not recommended when not using `fastStart: 'fragmented'`, as there will be one monolithic mdat box which might require large amounts of memory.
- `onMoof`\
	Will be called for each finalized moof (Movie Fragment) box of the output file. The fragment's start timestamp in seconds is also passed.

## QuickTime File Format (.mov)

This output format creates QuickTime files (.mov).
```ts
import { Output, MovOutputFormat } from 'mediabunny';

const output = new Output({
	format: new MovOutputFormat(options),
	// ...
});
```

The available options are the same `IsobmffOutputFormatOptions` used by [MP4](#mp4).

## WebM

This output format creates WebM files.
```ts
import { Output, WebMOutputFormat } from 'mediabunny';

const output = new Output({
	format: new WebMOutputFormat(options),
	// ...
});
```

The following options are available:
```ts
type MkvOutputFormatOptions = {
	appendOnly?: boolean;
	minimumClusterDuration?: number;

	onEbmlHeader?: (data: Uint8Array, position: number) => void;
	onSegmentHeader?: (data: Uint8Array, position: number) => unknown;
	onCluster?: (data: Uint8Array, position: number, timestamp: number) => unknown;
};
```
- `appendOnly`\
	Configures the output to write data in an append-only fashion. This is useful for live-streaming the output as it's being created. Note that when enabled, certain features like file duration or seeking will be disabled or impacted, so don't use this option when you want to write out a media file for later use.
	::: info
	This option ensures [append-only writing](#append-only-writing).
	:::
- `minimumClusterDuration`\
	Sets the minimum duration in seconds a cluster must have to be finalized and written to the file. Defaults to 1 second.
- `onEbmlHeader`\
	Will be called once the EBML header of the output file has been written.
- `onSegmentHeader`\
	Will be called once the header part of the Matroska Segment element has been written. The header data includes the Segment element and everything inside it, up to (but excluding) the first Matroska Cluster.
- `onCluster`\
	Will be called for each finalized Matroska Cluster of the output file. The cluster's start timestamp in seconds is also passed.

## Matroska (.mkv)

This output format creates Matroska files (.mkv).
```ts
import { Output, MkvOutputFormat } from 'mediabunny';

const output = new Output({
	format: new MkvOutputFormat(options),
	// ...
});
```

The available options are the same `MkvOutputFormatOptions` used by [WebM](#webm).

## Ogg

This output format creates Ogg files.
```ts
import { Output, OggOutputFormat } from 'mediabunny';

const output = new Output({
	format: new OggOutputFormat(options),
	// ...
});
```

::: info
This format ensures [append-only writing](#append-only-writing).
:::

The following options are available:
```ts
type OggOutputFormatOptions = {
	maximumPageDuration?: number;
	onPage?: (data: Uint8Array, position: number, source: MediaSource) => unknown;
};
```
- `maximumPageDuration`\
	The maximum duration in seconds of each Ogg page. Pages will be flushed early if adding another packet would cause the page to exceed this duration. This is useful for streaming contexts where more frequent page output is desired. By default, pages are only flushed when they exceed a certain size.
- `onPage`\
	Will be called for each finalized Ogg page of the output file. The [media source](./media-sources) backing the page's track (logical bitstream) is also passed.

## MP3

This output format creates MP3 files.
```ts
import { Output, Mp3OutputFormat } from 'mediabunny';	

const output = new Output({
	format: new Mp3OutputFormat(options),
	// ...
});
```

The following options are available:
```ts
type Mp3OutputFormatOptions = {
	xingHeader?: boolean;
	onXingFrame?: (data: Uint8Array, position: number) => unknown;
};
```
- `xingHeader`\
	Controls whether the Xing header, which contains additional metadata as well as an index, is written to the start of the MP3 file. Defaults to `true`.
	::: info
	When set to `false`, this option ensures [append-only writing](#append-only-writing).
	:::
- `onXingFrame`\
	Will be called once the Xing metadata frame is finalized, which happens at the end of the writing process. This callback only fires if `xingHeader` isn't set to `false`.

::: info
Most browsers don't support encoding MP3. Use the official [`@mediabunny/mp3-encoder`](./extensions/mp3-encoder) package to polyfill an encoder.
:::

## WAVE

This output format creates WAVE (.wav) files.
```ts
import { Output, WavOutputFormat } from 'mediabunny';	

const output = new Output({
	format: new WavOutputFormat(options),
	// ...
});
```

The following options are available:
```ts
type WavOutputFormatOptions = {
	large?: boolean;
	metadataFormat?: 'info' | 'id3';
	onHeader?: (data: Uint8Array, position: number) => unknown;
};
```
- `large`\
	When enabled, an RF64 file be written, allowing for file sizes to exceed 4 GiB, which is otherwise not possible for regular WAVE files.
- `metadataFormat`\
	The metadata format to use for writing metadata tags.
	- `'info'` (default): Writes metadata into a RIFF INFO LIST chunk, the default way to contain metadata tags within WAVE. Only allows for a limited subset of tags to be written.
	- `'id3'`: Writes metadata into an ID3 chunk. Non-default, but used by many taggers in practice. Allows for a much larger and richer set of tags to be written.
- `onHeader`\
	Will be called once the file header is written. The header consists of the RIFF header, the format chunk, and the start of the data chunk (with a placeholder size of 0).

## ADTS

This output format creates ADTS (.aac) files.
```ts
import { Output, AdtsOutputFormat } from 'mediabunny';	

const output = new Output({
	format: new AdtsOutputFormat(options),
	// ...
});
```

::: info
This format ensures [append-only writing](#append-only-writing).
:::

The following options are available:
```ts
type AdtsOutputFormatOptions = {
	onFrame?: (data: Uint8Array, position: number) => unknown;
};
```
- `onFrame`\
	Will be called for each ADTS frame that is written.

## FLAC

This output format creates FLAC (.flac) files.
```ts
import { Output, FlacOutputFormat } from 'mediabunny';

const output = new Output({
	format: new FlacOutputFormat(options),
	// ...
});
```

The following options are available:
```ts
type FlacOutputFormatOptions = {
	onFrame?: (data: Uint8Array, position: number) => unknown;
};
```
- `onFrame`\
	Will be called for each FLAC frame that is written.

## MPEG-TS

This output format creates MPEG Transport Stream (.ts) files.
```ts
import { Output, MpegTsOutputFormat } from 'mediabunny';

const output = new Output({
	format: new MpegTsOutputFormat(options),
	// ...
});
```

::: info
This format ensures [append-only writing](#append-only-writing).
:::

The following options are available:
```ts
type MpegTsOutputFormatOptions = {
	onPacket?: (data: Uint8Array, position: number) => unknown;
};
```
- `onPacket`\
	Will be called for each 188-byte Transport Stream packet that is written.