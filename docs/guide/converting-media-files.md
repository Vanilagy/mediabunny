# Converting media files

The [reading](./reading-media-files) and [writing](./writing-media-files) primitives in Mediabunny provide everything you need to convert media files. However, since this is such a common operation and the details can be tricky, Mediabunny ships with a built-in file conversion abstraction.

It has the following features:

- Transmuxing (changing the container format)
- Transcoding (changing a track's codec)
- Track removal
- Compression
- Trimming
- Video resizing & fitting
- Video rotation
- Video frame rate adjustment
- Audio resampling
- Audio up/downmixing

The conversion API was built to be simple, versatile and extremely performant.

## Basic usage

### Running a conversion

Each conversion process is represented by an instance of `Conversion`. Create a new instance using `Conversion.init(...)`, then run the conversion using `.execute()`.

Here, we're converting to WebM:
```ts
import {
	Input,
	Output,
	WebMOutputFormat,
	BufferTarget,
	Conversion,
} from 'mediabunny';

const input = new Input({ ... });
const output = new Output({
	format: new WebMOutputFormat(),
	target: new BufferTarget(),
});

const conversion = await Conversion.init({ input, output });
await conversion.execute();

// output.target.buffer contains the final file
```

That's it! A `Conversion` simply takes an instance of `Input` and `Output`, then reads the data from the input and writes it to the output. If you're unfamiliar with [`Input`](./reading-media-files) and [`Output`](./writing-media-files), check out their respective guides.

::: info
The `Output` passed to the `Conversion` must be *fresh*; that is, it must have no added tracks and be in the `'pending'` state (not started yet).
:::

Unconfigured, the conversion process handles all the details automatically, such as:

- Copying media data whenever possible, otherwise transcoding it
- Dropping tracks that aren't supported in the output format

You should consider inspecting the [discarded tracks](#discarded-tracks) before executing a `Conversion`.

### Monitoring progress

To monitor the progress of a `Conversion`, set its `onProgress` property *before* calling `execute`:
```ts
const conversion = await Conversion.init({ input, output });

conversion.onProgress = (progress: number) => {
	// `progress` is a number between 0 and 1 (inclusive)
};

await conversion.execute();
```

This callback is called each time the progress of the conversion advances.

::: warning
A progress of `1` doesn't indicate the conversion has finished; the conversion is only finished once the promise returned by `.execute()` resolves.
:::

::: warning
Tracking conversion progress can slightly affect performance as it requires knowledge of the input file's total duration. This is usually negligible but should be avoided when using append-only input sources such as [`ReadableStreamSource`](./reading-media-files#readablestreamsource).
:::

If you want to monitor the output size of the conversion (in bytes), simply use the `onwrite` callback on your `Target`:
```ts
let currentFileSize = 0;

output.target.onwrite = (start, end) => {
	currentFileSize = Math.max(currentFileSize, end);
};
```

### Canceling a conversion

Sometimes, you may want to cancel an ongoing conversion process. For this, use the `cancel` method:
```ts
await conversion.cancel(); // Resolves once the conversion is canceled
```

This automatically frees up all resources used by the conversion process.

## Video options

You can set the `video` property in the conversion options to configure the converter's behavior for video tracks. The options are:
```ts
type ConversionVideoOptions = {
	discard?: boolean;
	width?: number;
	height?: number;
	fit?: 'fill' | 'contain' | 'cover';
	rotate?: 0 | 90 | 180 | 270;
	frameRate?: number;
	codec?: VideoCodec;
	bitrate?: number | Quality;
	forceTranscode?: boolean;
};
```

For example, here we resize the video track to 720p:
```ts
const conversion = await Conversion.init({
	input,
	output,
	video: {
		width: 1280,
		height: 720,
		fit: 'contain',
	},
});
```

::: info
The provided configuration will apply equally to all video tracks of the input. If you want to apply a separate configuration to each video track, check [track-specific options](#track-specific-options).
:::

### Discarding video

If you want to get rid of the video track, use `discard: true`.

### Resizing/rotating video

The `width`, `height` and `fit` properties control how the video is resized. If only `width` or `height` is provided, the other value is deduced automatically to preserve the video's original aspect ratio. If both are used, `fit` must be set to control the fitting algorithm:
- `'fill'` will stretch the image to fill the entire box, potentially altering aspect ratio.
- `'contain'` will contain the entire image within the box while preserving aspect ratio. This may lead to letterboxing.
- `'cover'` will scale the image until the entire box is filled, while preserving aspect ratio.

`rotation` rotates the video by the specified number of degrees clockwise. This rotation is applied on top of any rotation metadata in the original input file.

If `width` or `height` is used in conjunction with `rotation`, they control the post-rotation dimensions.

If you want to apply max/min constraints to a video's dimensions, check out [track-specific options](#track-specific-options).

In the rare case that the input video changes size over time, the `fit` field can be used to control the size change behavior (see [`VideoEncodingConfig`](./media-sources#video-encoding-config)). When unset, the behavior is `'passThrough'`.

### Adjusting frame rate

The `frameRate` property can be used to set the frame rate of the output video in Hz. If not specified, the original input frame rate will be used (which may be variable).

### Transcoding video

Use the `codec` property to control the codec of the output track. This should be set to a [codec](./supported-formats-and-codecs#video-codecs) supported by the output file, or else the track will be [discarded](#discarded-tracks).

Use the `bitrate` property to control the bitrate of the output video. For example, you can use this field to compress the video track. Accepted values are the number of bits per second or a [subjective quality](./media-sources#subjective-qualities). If this property is set, transcoding will always happen. If this property is not set but transcoding is still required, `QUALITY_HIGH` will be used as the value.

If you want to prevent direct copying of media data and force a transcoding step, use `forceTranscode: true`.

## Audio options

You can set the `audio` property in the conversion options to configure the converter's behavior for audio tracks. The options are:
```ts
type ConversionAudioOptions = {
	discard?: boolean;
	codec?: AudioCodec;
	bitrate?: number | Quality;
	numberOfChannels?: number;
	sampleRate?: number;
	forceTranscode?: boolean;
};
```

For example, here we convert the audio track to mono and set a specific sample rate:
```ts
const conversion = await Conversion.init({
	input,
	output,
	audio: {
		numberOfChannels: 1,
		sampleRate: 48000,
	},
});
```

::: info
The provided configuration will apply equally to all audio tracks of the input. If you want to apply a separate configuration to each audio track, check [track-specific options](#track-specific-options).
:::

### Discarding audio

If you want to get rid of the audio track, use `discard: true`.

### Resampling audio

The `numberOfChannels` property controls the channel count of the output audio (e.g., 1 for mono, 2 for stereo). If this value differs from the number of channels in the input track, Mediabunny will perform up/downmixing of the channel data using [the same algorithm as the Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API#audio_channels).

The `sampleRate` property controls the sample rate in Hz (e.g., 44100, 48000). If this value differs from the input track's sample rate, Mediabunny will resample the audio.

### Transcoding audio

Use the `codec` property to control the codec of the output track. This should be set to a [codec](./supported-formats-and-codecs#audio-codecs) supported by the output file, or else the track will be [discarded](#discarded-tracks).

Use the `bitrate` property to control the bitrate of the output audio. For example, you can use this field to compress the audio track. Accepted values are the number of bits per second or a [subjective quality](./media-sources#subjective-qualities). If this property is set, transcoding will always happen. If this property is not set but transcoding is still required, `QUALITY_HIGH` will be used as the value.

If you want to prevent direct copying of media data and force a transcoding step, use `forceTranscode: true`.

## Track-specific options

You may want to configure your video and audio options differently depending on the specifics of the input track. Or, in case a media file has multiple video or audio tracks, you may want to discard only specific tracks or configure each track separately.

For this, instead of passing an object for `video` and `audio`, you can instead pass a function:

```ts
const conversion = await Conversion.init({
	input,
	output,

	// Function gets invoked for each video track:
	video: (videoTrack, n) => {
		if (n > 1) {
			// Keep only the first video track
			return { discard: true };
		}

		return {
			// Shrink width to 640 only if the track is wider
			width: Math.min(videoTrack.displayWidth, 640),
		};
	},

	// Async functions work too:
	audio: async (audioTrack, n) => {
		if (audioTrack.languageCode !== 'rus') {
			// Keep only Russian audio tracks
			return { discard: true };
		}

		return {
			codec: 'aac',
		};
	},
});
```

For documentation about the properties of video and audio tracks, refer to [Reading track metadata](./reading-media-files#reading-track-metadata).

## Trimming

Use the `trim` property in the conversion options to extract only a section of the input file into the output file:

```ts
type ConversionOptions = {
	// ...
	trim?: {
		start: number; // in seconds
		end: number; // in seconds
	};
	// ...
};
```

For example, here we extract a clip from 10s to 25s:
```ts
const conversion = await Conversion.init({
	input,
	output,
	trim: {
		start: 10,
		end: 25,
	},
});
```

In this case, the output will be 15 seconds long.

If only `start` is set, the clip will run until the end of the input file. If only `end` is set, the clip will start at the beginning of the input file.

## Discarded tracks

If an input track is excluded from the output file, it is considered *discarded*. The list of discarded tracks can be accessed after initializing a `Conversion`:
```ts
const conversion = await Conversion.init({ input, output });
conversion.discardedTracks; // => DiscardedTrack[]

type DiscardedTrack = {
	// The track that was discarded
	track: InputTrack;
	// The reason for discarding the track
	reason:
		| 'discarded_by_user'
		| 'max_track_count_reached'
		| 'max_track_count_of_type_reached'
		| 'unknown_source_codec'
		| 'undecodable_source_codec'
		| 'no_encodable_target_codec';
};
```

Since you can inspect this list before executing a `Conversion`, this gives you the option to decide if you still want to move forward with the conversion process.

---

The following reasons exist:
- `discarded_by_user`\
	You discarded this track by setting `discard: true`.
- `max_track_count_reached`\
	The output had no more room for another track.
- `max_track_count_of_type_reached`\
	The output had no more room for another track of this type, or the output doesn't support this track type at all.
- `unknown_source_codec`\
	We don't know the codec of the input track and therefore don't know what to do with it.
- `undecodable_source_codec`\
	The input track's codec is known, but we are unable to decode it.
- `no_encodable_target_codec`\
	We can't find a codec that we are able to encode and that can be contained within the output format. This reason can be hit if the environment doesn't support the necessary encoders, or if you requested a codec that cannot be contained within the output format.

---

On the flip side, you can always query which input tracks made it into the output:
```ts
const conversion = await Conversion.init({ input, output });
conversion.utilizedTracks; // => InputTrack[]
```