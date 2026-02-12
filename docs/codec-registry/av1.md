<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# AV1 codec registration

## Description

The AOMedia Video 1 (AV1) video codec, specified in the [AV1 Bitstream & Decoding Process Specification](https://aomediacodec.github.io/av1-spec/).

## Codec ID

```ts
'av1'
```

## `EncodedPacket` data

The packet's data must comply with the low-overhead bitstream format as defined in Section 5 of the [AV1 Bitstream & Decoding Process Specification](https://aomediacodec.github.io/av1-spec/).

## `EncodedPacket` type

If the packet's type is `'key'`, then the packet is expected to contain a frame with `frame_type` of `KEY_FRAME`, as defined in Section 6.8.2 of the [AV1 Bitstream & Decoding Process Specification](https://aomediacodec.github.io/av1-spec/).

## `VideoDecoderConfig` codec string

The full codec string begins with the prefix `'av01.'`, with a variable-length suffix as specified in Section 5 of the [AV1 Codec ISO Media File Format Binding](https://aomediacodec.github.io/av1-isobmff/).

## `VideoDecoderConfig` description

`description` is not used for this codec.
