---
description: Versatile Video Coding (H.266) video codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# VVC (H.266) codec registration

## Description

The Versatile Video Coding (H.266) video codec, specified in [Rec. ITU-T H.266](https://www.itu.int/rec/T-REC-H.266).

## Codec ID

```ts
'vvc'
```

## `EncodedPacket` data

The packet's data must be an access unit as defined in [Rec. ITU-T H.266](https://www.itu.int/rec/T-REC-H.266), containing exactly one coded picture, in either _canonical_ (length-prefixed) or _Annex B_ format.

All packets within the bitstream must have the same format.

## `EncodedPacket` type

If the packet's type is `'key'`, then the packet is expected to contain an IDR, CRA, or BLA picture.

## `VideoDecoderConfig` codec string

The full codec string begins with the prefix `'vvc1.'` or `'vvi1.'`, with a variable-length suffix as specified in [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html).

## `VideoDecoderConfig` description

`description` is not used for this codec.
