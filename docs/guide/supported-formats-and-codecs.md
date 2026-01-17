# Supported formats & codecs
 
## Container formats

Mediabunny supports many commonly used media container formats, all of which are supported bidirectionally (reading & writing):

- ISOBMFF-based formats (.mp4, .m4v, .m4a, ...)
- QuickTime File Format (.mov)
- Matroska (.mkv)
- WebM (.webm)
- Ogg (.ogg)
- MP3 (.mp3)
- WAVE (.wav)
- ADTS (.aac)
- FLAC (.flac)

## Codecs

Mediabunny supports a wide range of video, audio, and subtitle codecs. More specifically, it supports all codecs specified by the WebCodecs API and a few additional PCM codecs out of the box.

The availability of the codecs provided by the WebCodecs API depends on the browser and thus cannot be guaranteed by this library. Mediabunny provides [special utility functions](#querying-codec-encodability) to check which codecs are able to be encoded. You can also specify [custom coders](#custom-coders) to provide your own encoder/decoder implementation if the browser doesn't support the codec natively.

::: info
Mediabunny ships with built-in decoders and encoders for all audio PCM codecs, meaning they are always supported.
:::

### Video codecs

- `'avc'` - Advanced Video Coding (AVC) / H.264
- `'hevc'` - High Efficiency Video Coding (HEVC) / H.265
- `'vp8'` - VP8
- `'vp9'` - VP9
- `'av1'` - AOMedia Video 1 (AV1)

### Audio codecs

- `'aac'` - Advanced Audio Coding (AAC)
- `'opus'` - Opus
- `'mp3'` - MP3
- `'vorbis'` - Vorbis
- `'flac'` - Free Lossless Audio Codec (FLAC)
- `'ac3'` - Dolby Digital (AC-3)
- `'eac3'` - Dolby Digital Plus (E-AC-3)
- `'pcm-u8'` - 8-bit unsigned PCM
- `'pcm-s8'` - 8-bit signed PCM
- `'pcm-s16'` - 16-bit little-endian signed PCM
- `'pcm-s16be'` - 16-bit big-endian signed PCM
- `'pcm-s24'` - 24-bit little-endian signed PCM
- `'pcm-s24be'` - 24-bit big-endian signed PCM
- `'pcm-s32'` - 32-bit little-endian signed PCM
- `'pcm-s32be'` - 32-bit big-endian signed PCM
- `'pcm-f32'` - 32-bit little-endian float PCM
- `'pcm-f32be'` - 32-bit big-endian float PCM
- `'pcm-f64'` - 64-bit little-endian float PCM
- `'pcm-f64be'` - 64-bit big-endian float PCM
- `'ulaw'` - μ-law PCM
- `'alaw'` - A-law PCM

### Subtitle codecs

- `'webvtt'` - WebVTT

## Compatibility table

Not all codecs can be used with all containers. The following table specifies the supported codec-container combinations:

|                |   .mp4   | .mov  | .mkv  | .webm[^1] | .ogg  | .mp3  | .wav  | .aac  | .flac |
|:--------------:|:--------:|:-----:|:-----:|:---------:|:-----:|:-----:|:-----:|:-----:|:-----:|
| `'avc'`        |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'hevc'`       |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'vp8'`        |    ✓     |   ✓   |   ✓   |     ✓     |       |       |       |       |       |
| `'vp9'`        |    ✓     |   ✓   |   ✓   |     ✓     |       |       |       |       |       |
| `'av1'`        |    ✓     |   ✓   |   ✓   |     ✓     |       |       |       |       |       |
| `'aac'`        |    ✓     |   ✓   |   ✓   |           |       |       |       |   ✓   |       |
| `'opus'`       |    ✓     |   ✓   |   ✓   |     ✓     |   ✓   |       |       |       |       |
| `'mp3'`        |    ✓     |   ✓   |   ✓   |           |       |   ✓   |       |       |       |
| `'vorbis'`     |    ✓     |   ✓   |   ✓   |     ✓     |   ✓   |       |       |       |       |
| `'flac'`       |    ✓     |   ✓   |   ✓   |           |       |       |       |       |   ✓   |
| `'ac3'`[^2]    |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'eac3'`[^2]   |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'pcm-u8'`     |          |   ✓   |   ✓   |           |       |       |   ✓   |       |       |
| `'pcm-s8'`     |          |   ✓   |       |           |       |       |       |       |       |
| `'pcm-s16'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |
| `'pcm-s16be'`  |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'pcm-s24'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |
| `'pcm-s24be'`  |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'pcm-s32'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |
| `'pcm-s32be'`  |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'pcm-f32'`    |    ✓     |   ✓   |   ✓   |           |       |       |   ✓   |       |       |
| `'pcm-f32be'`  |    ✓     |   ✓   |       |           |       |       |       |       |       |
| `'pcm-f64'`    |    ✓     |   ✓   |   ✓   |           |       |       |       |       |       |
| `'pcm-f64be'`  |    ✓     |   ✓   |       |           |       |       |       |       |       |
| `'ulaw'`       |          |   ✓   |       |           |       |       |   ✓   |       |       |
| `'alaw'`       |          |   ✓   |       |           |       |       |   ✓   |       |       |
| `'webvtt'`[^3] |   (✓)    |       |  (✓)  |    (✓)    |       |       |       |       |       |


[^1]: WebM only supports a small subset of the codecs supported by Matroska. However, this library can technically read all codecs from a WebM that are supported by Matroska.
[^2]: AC-3 and E-AC-3 are not natively supported by WebCodecs. To encode or decode these codecs, you must provide a [custom coder](#custom-coders).
[^3]: WebVTT can only be written, not read.

## Querying codec encodability

Mediabunny provides utility functions that you can use to check if the browser can encode a given codec. Additionally, you
can check if a codec is encodable with a specific _configuration_.

`canEncode` tests whether a codec can be encoded using typical settings:
```ts
import { canEncode } from 'mediabunny';

canEncode('avc'); // => Promise<boolean>
canEncode('opus'); // => Promise<boolean>
```
Video codecs are checked using 1280x720 @1Mbps, while audio codecs are checked using 2 channels, 48 kHz @128kbps.

You can also check encodability using specific configurations:
```ts
import { canEncodeVideo, canEncodeAudio } from 'mediabunny';

canEncodeVideo('hevc', {
	width: 1920, height: 1080, bitrate: 1e7
}); // => Promise<boolean>

canEncodeAudio('aac', {
	numberOfChannels: 1, sampleRate: 44100, bitrate: 192e3
}); // => Promise<boolean>
```

Additionally, most properties of [`VideoEncodingConfig`](./media-sources#video-encoding-config) and [`AudioEncodingConfig`](./media-sources#audio-encoding-config) can be used here as well.

---

In addition, you can use the following functions to check encodability for multiple codecs at once, getting back a list of supported codecs:
```ts
import {
	getEncodableCodecs,
	getEncodableVideoCodecs,
	getEncodableAudioCodecs,
	getEncodableSubtitleCodecs,
} from 'mediabunny';

getEncodableCodecs(); // => Promise<MediaCodec[]>
getEncodableVideoCodecs(); // => Promise<VideoCodec[]>
getEncodableAudioCodecs(); // => Promise<AudioCodec[]>
getEncodableSubtitleCodecs(); // => Promise<SubtitleCodec[]>

// These functions also accept optional configuration options.
// Here, we check which of AVC, HEVC and VP8 can be encoded at 1920x1080 @10Mbps:
getEncodableVideoCodecs(
	['avc', 'hevc', 'vp8'],
	{ width: 1920, height: 1080, bitrate: 1e7 },
); // => Promise<VideoCodec[]>
```

---

If you simply want to find the best codec that the browser can encode, you can use these functions, which return the first codec supported by the browser:
```ts
import {
	getFirstEncodableVideoCodec,
	getFirstEncodableAudioCodec,
	getFirstEncodableSubtitleCodec,
} from 'mediabunny';

getFirstEncodableVideoCodec(['avc', 'vp9', 'av1']); // => Promise<VideoCodec | null>
getFirstEncodableAudioCodec(['opus', 'aac']); // => Promise<AudioCodec | null>

getFirstEncodableVideoCodec(
	['avc', 'hevc', 'vp8'],
	{ width: 1920, height: 1080, bitrate: 1e7 },
); // => Promise<VideoCodec | null>
```

If none of the listed codecs is supported, `null` is returned.

These functions are especially useful in conjunction with an [output format](./output-formats) to retrieve the best codec that is supported both by the encoder as well as the container format:
```ts
import {
	Mp4OutputFormat,
	getFirstEncodableVideoCodec,
} from 'mediabunny';

const outputFormat = new Mp4OutputFormat();
const containableVideoCodecs = outputFormat.getSupportedVideoCodecs();
const bestVideoCodec = await getFirstEncodableVideoCodec(containableVideoCodecs);
```

::: info
Codec encodability checks take [custom encoders](#custom-encoders) into account.
:::

## Querying codec decodability

Whether a codec can be decoded depends on the specific codec configuration of an `InputTrack`; you can use its [`canDecode`](./reading-media-files#codec-information) method to check.

## Custom coders

Mediabunny allows you to register your own custom encoders and decoders - useful if you want to polyfill a codec that's not supported in all browsers, or want to use Mediabunny outside of an environment with WebCodecs (such as Node.js).

Encoders and decoders can be registered for [all video and audio codecs](#codecs) supported by the library. It is not possible to add new codecs.

::: warning
Mediabunny requires customs encoders and decoders to follow very specific implementation rules. Pay special attention to the parts labeled with "**must**" to ensure compatibility.
:::

### Custom encoders

To create a custom video or audio encoder, you'll need to create a class which extends `CustomVideoEncoder` or `CustomAudioEncoder`. Then, you **must** register this class using `registerEncoder`:
```ts
import { CustomAudioEncoder, registerEncoder } from 'mediabunny';

class MyAwesomeMp3Encoder extends CustomAudioEncoder {
	// ...
}
registerEncoder(MyAwesomeMp3Encoder);
```

The following properties are available on each encoder instance and are set by the library:
```ts
class {
	// For video encoders:
	codec: VideoCodec;
	config: VideoEncoderConfig;
	onPacket: (packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) => unknown;

	// For audio encoders:
	codec: AudioCodec;
	config: AudioEncoderConfig;
	onPacket: (packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) => unknown;
}
```

`codec` and `config` specify the concrete codec configuration to use, and `onPacket` is a method that your code **must** call for each encoded packet it creates.

You **must** implement the following methods in your custom encoder class:
```ts
class {
	// For video encoders:
	static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean;
	// For audio encoders:
	static supports(codec: AudioCodec, config: AudioEncoderConfig): boolean;

	init(): Promise<void> | void;
	encode(sample: VideoSample, options: VideoEncoderEncodeOptions): Promise<void> | void; // For video
	encode(sample: AudioSample): Promise<void> | void; // For audio
	flush(): Promise<void> | void;
	close(): Promise<void> | void;
}
```
- `supports`\
	This is a *static* method that **must** return `true` if the encoder is able to encode the specified codec, and `false` if not. If it returns `true`, a new instance of your encoder class will be created by the library and will be used for encoding, taking precedence over the default encoders.
- `init`\
	Called by the library after your class is instantiated. Place any initialization logic here.
- `encode`\
	Called for each sample that is to be encoded. The resulting encoded packet **must** then be passed to the `onPacket` method.
- `flush`\
	Called when the encoder is expected to finish the encoding process for all remaining samples that haven't finished encoding yet. This method **must** return/resolve only once all samples passed to `encode` have been fully encoded. It **must** then reset its own internal state to be ready for the next encoding batch.
- `close`\
	Called when the encoder is no longer needed and can release its internal resources.

::: info
All instance methods of the class can return promises. In this case, the library will make sure to *serialize* all method calls such that no two methods ever run concurrently.
:::

::: warning
The packets passed to `onPacket` **must** be in [decode order](./media-sinks.md#decode-vs-presentation-order).
:::

### Custom decoders

To create a custom video or audio decoder, you'll need to create a class which extends `CustomVideoDecoder` or `CustomAudioDecoder`. Then, you **must** register this class using `registerDecoder`:
```ts
import { CustomAudioDecoder, registerDecoder } from 'mediabunny';

class MyAwesomeMp3Decoder extends CustomAudioDecoder {
	// ...
}
registerDecoder(MyAwesomeMp3Decoder);
```

The following properties are available on each decoder instance and are set by the library:
```ts
class {
	// For video decoders:
	codec: VideoCodec;
	config: VideoDecoderConfig;
	onSample: (sample: VideoSample) => unknown;

	// For audio decoders:
	codec: AudioCodec;
	config: AudioDecoderConfig;
	onSample: (sample: AudioSample) => unknown;
}
```

`codec` and `config` specify the concrete codec configuration to use, and `onSample` is a method that your code **must** call for each video/audio sample it creates.

You **must** implement the following methods in your custom decoder class:
```ts
class {
	// For video decoders:
	static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean;
	// For audio decoders:
	static supports(codec: AudioCodec, config: AudioDecoderConfig): boolean;

	init(): Promise<void> | void;
	decode(packet: EncodedPacket): Promise<void> | void;
	flush(): Promise<void> | void;
	close(): Promise<void> | void;
}
```
- `supports`\
	This is a *static* method that **must** return `true` if the decoder is able to decode the specified codec, and `false` if not. If it returns `true`, a new instance of your decoder class will be created by the library and will be used for decoding, taking precedence over the default decoders.
- `init`\
	Called by the library after your class is instantiated. Place any initialization logic here.
- `decode`\
	Called for each `EncodedPacket` that is to be decoded. The resulting video or audio sample **must** then be passed to the `onSample` method.
- `flush`\
	Called when the decoder is expected to finish the decoding process for all remaining packets that haven't finished decoding yet. This method **must** return/resolve only once all packets passed to `decode` have been fully decoded. It **must** then reset its own internal state to be ready for the next decoding batch.
- `close`\
	Called when the decoder is no longer needed and can release its internal resources.

::: info
All instance methods of the class can return promises. In this case, the library will make sure to *serialize* all method calls such that no two methods ever run concurrently.
:::

::: warning
The samples passed to `onSample` **must** be sorted by increasing timestamp. This especially means if the decoder is decoding a video stream that makes use of [B-frames](./media-sources.md#b-frames), the decoder **must** internally hold on to these frames so it can emit them sorted by presentation timestamp. This strict sorting requirement is reset each time `flush` is called.
:::