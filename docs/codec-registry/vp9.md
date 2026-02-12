<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# VP9 codec registration

## Description

The VP9 video codec, specified in the [VP9 Bitstream & Decoding Process Specification](https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.6-20160331-draft.pdf).

## Codec ID

```ts
'vp9'
```

## `EncodedPacket` data

The packet's data must be a frame as described in Section 6 of the [VP9 Bitstream & Decoding Process Specification](https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.6-20160331-draft.pdf).

## `EncodedPacket` type

If the packet's type is `'key'`, then the packet is expected to contain a frame with `frame_type` of `KEY_FRAME`, as defined in Section 7.2 of the [VP9 Bitstream & Decoding Process Specification](https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.6-20160331-draft.pdf).

## `VideoDecoderConfig` codec string

The full codec string begins with the prefix `'vp09.'`, with a variable-length suffix as specified in the [VP Codec ISO Media File Format Binding](https://www.webmproject.org/vp9/mp4/).

## `VideoDecoderConfig` description

`description` is not used for this codec.
