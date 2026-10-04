---
description: mjpeg definitions.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# MJPEG codec registration

## Description

There's no official specification for this video codec. But it's generally known
that each frame is a jpeg image.

## Codec ID

```ts
'mjpeg'
```

## `EncodedPacket` data

Each packet data should be a jpeg image as defined in
[ITU-T81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf)

https://developer.apple.com/documentation/quicktime-file-format/video_sample_data#Motion-JPEG

## `EncodedPacket` type

Since Mjpeg is intra-frame-only, every packet is a key frame and its type is
therefore always `'key'`.

## `VideoDecoderConfig` codec string

The codec string must be one of the four four-character codes:

- `'mjpg'`
- `'jpeg'`
- `'mjpa'`
- `'mjpb'`

## `VideoDecoderConfig` description

`description` is not used for this codec.

