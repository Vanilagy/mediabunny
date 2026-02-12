# Mediabunny Codec Registry

The Mediabunny Codec Registry formalizes the precise definitions of all video and audio codecs supported by Mediabunny. More specifically, for any given codec, it describes the format that `EncodedPacket`, `VideoDecoderConfig` and `AudioDecoderConfig` must adhere to. All packets coming out of or going into Mediabunny are expected to adhere to this registry.

The registry is an extension of the [WebCodecs Codec Registry](https://www.w3.org/TR/webcodecs-codec-registry/). Mediabunny's registry matches that of WebCodecs for all codecs supported by both.

## Video codecs

- [AVC (H.264)](./avc)
- [HEVC (H.265)](./hevc)
- [VP8](./vp8)
- [VP9](./vp9)
- [AV1](./av1)

## Audio codecs

- [AAC](./aac)
- [Opus](./opus)
- [MP3](./mp3)
- [Vorbis](./vorbis)
- [FLAC](./flac)
- [AC-3](./ac3)
- [E-AC-3](./eac3)
- [Linear PCM](./pcm)
- [μ-law PCM](./ulaw)
- [A-law PCM](./alaw)
