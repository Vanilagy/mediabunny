# Media sources

## Introduction

_Media sources_ provide APIs for adding media data to an output file. Different media sources provide different levels of abstraction and cater to different use cases.

For information on how to use media sources to create output tracks, check [Writing media files](./writing-media-files).

Most media sources follow this code pattern to add media data:
```ts
await mediaSource.add(...);
```

### Closing sources

When you're done using the source, meaning no additional media data will be added, it's best to close the source as soon as possible:
```ts
mediaSource.close();
```
Closing sources manually is _technically_ not required and will happen automatically when finalizing the `Output`. However, if your `Output` has multiple tracks and not all of them finish supplying their data at the same time (for example, adding all audio first and then all video), closing sources early will improve performance and lower memory usage. This is because the `Output` can better "plan ahead", knowing it doesn't have to wait for certain tracks anymore (see [Packet buffering](./writing-media-files#packet-buffering)). Therefore, it is good practice to always manually close all media sources as soon as you are done using them.

### Backpressure

Media sources are the means by which backpressure is propagated from the output pipeline into your application logic. The `Output` may want to apply backpressure if the encoders or the [StreamTarget](./writing-media-files#streamtarget)'s writable can't keep up.

Backpressure is communicated by media sources via promises. All media sources with an `add` method return a promise:
```ts
mediaSource.add(...); // => Promise<void>
```
This promise resolves when the source is ready to receive more data. In most cases, the promise will resolve instantly, but if some part of the output pipeline is overworked, it will remain pending until the output is ready to continue. Therefore, by awaiting this promise, you automatically propagate backpressure into your application logic:
```ts
// Wrong: // [!code error]
while (notDone) { // [!code error]
	mediaSource.add(...); // [!code error]
} // [!code error]

// Correct:
while (notDone) {
	await mediaSource.add(...);
}
```

### Video encoding config

All video sources that handle encoding internally require you to specify a `VideoEncodingConfig`, specifying the codec configuration to use:
```ts
type VideoEncodingConfig = {
	codec: VideoCodec;
	bitrate: number | Quality;
	alpha?: 'discard' | 'keep';
	bitrateMode?: 'constant' | 'variable';
	latencyMode?: 'quality' | 'realtime';
	keyFrameInterval?: number;
	fullCodecString?: string;
	hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
	scalabilityMode?: string;
	contentHint?: string;
	sizeChangeBehavior?: 'deny' | 'passThrough' | 'fill' | 'contain' | 'cover';

	onEncodedPacket?: (
		packet: EncodedPacket,
		meta: EncodedVideoChunkMetadata | undefined
	) => unknown;
	onEncoderConfig?: (
		config: VideoEncoderConfig
	) => unknown;
};
```
- `codec`: The [video codec](./supported-formats-and-codecs#video-codecs) used for encoding.
- `bitrate`: The target number of bits per second. Alternatively, this can be a [subjective quality](#subjective-qualities).
- `alpha`:  What to do with alpha data contained in the video samples.
	- `'discard'` (default): Only the samples' color data is kept; the video is opaque.
	- `'keep'`: The samples' alpha data is also encoded as side data. Make sure to pair this mode with a container format that supports transparency (such as WebM or Matroska).
- `bitrateMode`: Can be used to control constant vs. variable bitrate.
- `latencyMode`: The latency mode as specified by the WebCodecs API. Browsers default to `quality`. Media stream-driven video sources will automatically use the `realtime` setting.
- `keyFrameInterval`: The maximum interval in seconds between two adjacent key frames. Defaults to 5 seconds. More frequent key frames improve seeking behavior but increase file size. When using multiple video tracks, this value should be set to the same value for all tracks.
- `fullCodecString`: Allows you to optionally specify the full codec string used by the video encoder, as specified in the [WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/). For example, you may set it to `'avc1.42001f'` when using AVC. Keep in mind that the codec string must still match the codec specified in `codec`. If you don't set this field, a codec string will be generated automatically.
- `hardwareAcceleration`: A hint that configures the hardware acceleration method of this codec. This is best left on `'no-preference'`.
- `scalabilityMode`: An encoding scalability mode identifier as defined by [WebRTC-SVC](https://w3c.github.io/webrtc-svc/#scalabilitymodes*).
- `contentHint`: An encoding video content hint as defined by [mst-content-hint](https://w3c.github.io/mst-content-hint/#video-content-hints).
- `sizeChangeBehavior`: Video frames may change size overtime. This field controls the behavior in case this happens. Defaults to `'deny'`. 
- `onEncodedPacket`: Called for each successfully encoded packet. Useful for determining encoding progress.
- `onEncoderConfig`: Called when the internal encoder config, as used by the WebCodecs API, is created. You can use this to introspect the full codec string.

### Audio encoding config

All audio sources that handle encoding internally require you to specify an `AudioEncodingConfig`, specifying the codec configuration to use:
```ts
type AudioEncodingConfig = {
	codec: AudioCodec;
	bitrate?: number | Quality;
	bitrateMode?: 'constant' | 'variable';
	fullCodecString?: string;

	onEncodedPacket?: (
		packet: EncodedPacket,
		meta: EncodedAudioChunkMetadata | undefined
	) => unknown;
	onEncoderConfig?: (
		config: AudioEncoderConfig
	) => unknown;
};
```
- `codec`: The [audio codec](./supported-formats-and-codecs#audio-codecs) used for encoding. Can be omitted for uncompressed PCM codecs.
- `bitrate`: The target number of bits per second. Alternatively, this can be a [subjective quality](#subjective-qualities).
- `bitrateMode`: Can be used to control constant vs. variable bitrate.
- `fullCodecString`: Allows you to optionally specify the full codec string used by the audio encoder, as specified in the [WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/). For example, you may set it to `'mp4a.40.2'` when using AAC. Keep in mind that the codec string must still match the codec specified in `codec`. If you don't set this field, a codec string will be generated automatically.
- `onEncodedPacket`: Called for each successfully encoded packet. Useful for determining encoding progress.	
- `onEncoderConfig`: Called when the internal encoder config, as used by the WebCodecs API, is created. You can use this to introspect the full codec string.

### Subjective qualities

Mediabunny provides five subjective quality options as an alternative to manually providing a bitrate. From a subjective quality, a bitrate will be calculated internally based on the codec and track information (width, height, sample rate, ...).

```ts
import {
	QUALITY_VERY_LOW,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from 'mediabunny';
```

## Video sources

Video sources feed data to video tracks on an `Output`. They all extend the abstract `VideoSource` class.

### `VideoSampleSource`

This source takes [video samples](./packets-and-samples#videosample), encodes them, and passes the encoded data to the output.

```ts
import { VideoSampleSource } from 'mediabunny';

const sampleSource = new VideoSampleSource({
	codec: 'avc',
	bitrate: 1e6,
});

await sampleSource.add(videoSample);
videoSample.close(); // If it's not needed anymore

// You may optionally force samples to be encoded as key frames:
await sampleSource.add(videoSample, { keyFrame: true });
```

### `CanvasSource`

This source simplifies a common pattern: A single canvas is repeatedly updated in a render loop and each frame is added to the output file.

```ts
import { CanvasSource, QUALITY_MEDIUM } from 'mediabunny';

const canvasSource = new CanvasSource(canvasElement, {
	codec: 'av1',
	bitrate: QUALITY_MEDIUM,
});

await canvasSource.add(0.0, 0.1); // Timestamp, duration (in seconds)
await canvasSource.add(0.1, 0.1);
await canvasSource.add(0.2, 0.1);

// You may optionally force frames to be encoded as key frames:
await canvasSource.add(0.3, 0.1, { keyFrame: true });
```

### `MediaStreamVideoTrackSource`

This is a source for use with the [Media Capture and Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API). Use this source if you want to pipe a real-time video source (such as a webcam or screen recording) to an output file.

```ts
import { MediaStreamVideoTrackSource } from 'mediabunny';

// Get the user's screen
const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
const videoTrack = stream.getVideoTracks()[0];

const videoTrackSource = new MediaStreamVideoTrackSource(videoTrack, {
	codec: 'vp9',
	bitrate: 1e7,
});

// Make sure to allow any internal errors to properly bubble up
videoTrackSource.errorPromise.catch((error) => ...);
```

This source requires no additional method calls; data will automatically be captured and piped to the output file as soon as `start()` is called on the `Output`. Make sure to `stop()` on `videoTrack` after finalizing the `Output` if you don't need the user's media anymore.

::: info
If this source is the only MediaStreamTrack source in the `Output`, then the first video sample added by it starts at timestamp 0. If there are multiple, then the earliest media sample across all tracks starts at timestamp 0, and all tracks will be perfectly synchronized with each other.
:::

::: warning
`MediaStreamVideoTrackSource`'s internals are detached from the typical code flow but can still throw, so make sure to utilize `errorPromise` to deal with any errors and to stop the `Output`.
:::

### `EncodedVideoPacketSource`

The most barebones of all video sources, this source can be used to directly pipe [encoded packets](./packets-and-samples#encodedpacket) of video data to the output. This source requires that you take care of the encoding process yourself, which enables you to use the WebCodecs API manually or to plug in your own encoding stack. Alternatively, you may retrieve the encoded packets directly by reading them from another media file, allowing you to skip decoding and reencoding video data.

```ts
import { EncodedVideoPacketSource } from 'mediabunny';

// You must specify the codec name:
const packetSource = new EncodedVideoPacketSource('vp9');

await packetSource.add(packet1);
await packetSource.add(packet2);
```

> [!IMPORTANT]
> You must add the packets in decode order.

You will need to provide additional metadata alongside your first call to `add` to give the `Output` more information about the shape and form of the video data. This metadata must be in the form of the WebCodecs API's `EncodedVideoChunkMetadata`. It might look like this:
```ts
await packetSource.add(firstPacket, {
	decoderConfig: {
		codec: 'vp09.00.31.08',
		codedWidth: 1280,
		codedHeight: 720,
		colorSpace: {
			primaries: 'bt709',
			transfer: 'iec61966-2-1',
			matrix: 'smpte170m',
			fullRange: false,
		},
		description: undefined,
	},
});
```

`codec`, `codedWidth`, and `codedHeight` are required for all codecs, whereas `description` is required for some codecs. Additional fields, such as `colorSpace`, are optional. The [WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/) specifies the formats of `codec` and `description` for each video codec, which you must adhere to.

#### B-frames

Some video codecs use *B-frames*, which are frames that require both the previous and the next frame to be decoded. For example, you may have something like this:
```md
Frame 1: 0.0s, I-frame (key frame)
Frame 2: 0.1s, B-frame
Frame 3: 0.2s, P-frame
```
The decode order for these frames will be:
```md
Frame 1 -> Frame 3 -> Frame 2
```
Some file formats have an explicit notion of both a "decode timestamp" and a "presentation timestamp" to model B-frames or out-of-order decoding. However, Mediabunny packets only specify their *presentation timestamp*. Decode order is determined by the order in which you add the packets, so in our example, you must add the packets like this:
```ts
await packetSource.add(packetForFrame1); // 0.0s
await packetSource.add(packetForFrame3); // 0.2s
await packetSource.add(packetForFrame2); // 0.1s
```

You are allowed to provide wildly out-of-order presentation timestamp sequences, but there is a hard constraint:

> [!IMPORTANT]
> A packet you add must not have a smaller timestamp than the largest timestamp you added before adding the last key frame.

This is quite a mouthful, so this example will hopefully clarify it:
```md
# Legal:
Packet 1: 0.0s, key frame
Packet 2: 0.3s, delta frame
Packet 3: 0.2s, delta frame
Packet 4: 0.1s, delta frame
Packet 5: 0.4s, key frame
Packet 6: 0.5s, delta frame

# Also legal:
Packet 1: 0.0s, key frame
Packet 2: 0.3s, delta frame
Packet 3: 0.2s, delta frame
Packet 4: 0.1s, delta frame
Packet 5: 0.4s, key frame
Packet 6: 0.35s, delta frame
Packet 7: 0.3s, delta frame
Packet 8: 0.5s, delta frame

# Illegal:
Packet 1: 0.0s, key frame
Packet 2: 0.3s, delta frame
Packet 3: 0.2s, delta frame
Packet 4: 0.1s, delta frame
Packet 5: 0.4s, key frame
Packet 6: 0.25s, delta frame
```

## Audio sources

Audio sources feed data to audio tracks on an `Output`. They all extend the abstract `AudioSource` class.

### `AudioSampleSource`

This source takes [audio samples](./packets-and-samples#audiosample), encodes them, and passes the encoded data to the output.

```ts
import { AudioSampleSource } from 'mediabunny';

const sampleSource = new AudioSampleSource({
	codec: 'aac',
	bitrate: 128e3,
});

await sampleSource.add(audioSample);
audioSample.close(); // If it's not needed anymore
```

### `AudioBufferSource`

This source directly accepts instances of `AudioBuffer` as data, simplifying usage with the Web Audio API. The first AudioBuffer will be played at timestamp 0, and any subsequent AudioBuffer will be appended after all previous AudioBuffers.

```ts
import { AudioBufferSource, QUALITY_MEDIUM } from 'mediabunny';

const bufferSource = new AudioBufferSource({
	codec: 'opus',
	bitrate: QUALITY_MEDIUM,
});

await bufferSource.add(audioBuffer1);
await bufferSource.add(audioBuffer2);
await bufferSource.add(audioBuffer3);
```

### `MediaStreamAudioTrackSource`

This is a source for use with the [Media Capture and Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API). Use this source if you want to pipe a real-time audio source (such as a microphone or audio from the user's computer) to an output file.

```ts
import { MediaStreamAudioTrackSource } from 'mediabunny';

// Get the user's microphone
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const audioTrack = stream.getAudioTracks()[0];

const audioTrackSource = new MediaStreamAudioTrackSource(audioTrack, {
	codec: 'opus',
	bitrate: 128e3,
});

// Make sure to allow any internal errors to properly bubble up
audioTrackSource.errorPromise.catch((error) => ...);
```

This source requires no additional method calls; data will automatically be captured and piped to the output file as soon as `start()` is called on the `Output`. Make sure to `stop()` on `audioTrack` after finalizing the `Output` if you don't need the user's media anymore.

::: info
If this source is the only MediaStreamTrack source in the `Output`, then the first audio sample added by it starts at timestamp 0. If there are multiple, then the earliest media sample across all tracks starts at timestamp 0, and all tracks will be perfectly synchronized with each other.
:::

::: warning
`MediaStreamAudioTrackSource`'s internals are detached from the typical code flow but can still throw, so make sure to utilize `errorPromise` to deal with any errors and to stop the `Output`.
:::

### `EncodedAudioPacketSource`

The most barebones of all audio sources, this source can be used to directly pipe [encoded packets](./packets-and-samples#encodedpacket) of audio data to the output. This source requires that you take care of the encoding process yourself, which enables you to use the WebCodecs API manually or to plug in your own encoding stack. Alternatively, you may retrieve the encoded packets directly by reading them from another media file, allowing you to skip decoding and reencoding audio data.

```ts
import { EncodedAudioPacketSource } from 'mediabunny';

// You must specify the codec name:
const packetSource = new EncodedAudioPacketSource('aac');

await packetSource.add(packet);
```

You will need to provide additional metadata alongside your first call to `add` to give the `Output` more information about the shape and form of the audio data. This metadata must be in the form of the WebCodecs API's `EncodedAudioChunkMetadata`. It might look like this:
```ts
await packetSource.add(firstPacket, {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
		description: new Uint8Array([17, 144]),
	},
});
```

`codec`, `numberOfChannels`, and `sampleRate` are required for all codecs, whereas `description` is required for some codecs. The [WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/) specifies the formats of `codec` and `description` for each audio codec, which you must adhere to.

## Subtitle sources

Subtitle sources feed data to subtitle tracks on an `Output`. They all extend the abstract `SubtitleSource` class.

### `TextSubtitleSource`

This source feeds subtitle cues to the output from a text file in which the subtitles are defined.

```ts
import { TextSubtitleSource } from 'mediabunny';

const textSource = new TextSubtitleSource('webvtt');

const text = 
`WEBVTT

00:00:00.000 --> 00:00:02.000
This is your last chance.

00:00:02.500 --> 00:00:04.000
After this, there is no turning back.

00:00:04.500 --> 00:00:06.000
If you take the blue pill, the story ends.

00:00:06.500 --> 00:00:08.000
You wake up in your bed and believe whatever you want to believe.

00:00:08.500 --> 00:00:10.000	
If you take the red pill, you stay in Wonderland

00:00:10.500 --> 00:00:12.000
and I show you how deep the rabbit hole goes.
`;

await textSource.add(text);
```

If you add the entire subtitle file at once, make sure to [close the source](#closing-sources) immediately after:
```ts
textSource.close();
```

You can also add cues individually in small chunks:
```ts
import { TextSubtitleSource } from 'mediabunny';

const textSource = new TextSubtitleSource('webvtt');

await textSource.add('WEBVTT\n\n');
await textSource.add('00:00:00.000 --> 00:00:02.000\nHello there!\n\n');
await textSource.add('00:00:02.500 --> 00:00:04.000\nChunky chunks.\n\n');
```

The chunks have certain constraints: A cue must be fully contained within a chunk and cannot be split across multiple smaller chunks (although a chunk can contain multiple cues). Also, the WebVTT preamble must be added first and all at once.