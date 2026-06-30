---
description: Apple ProRes video codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# ProRes codec registration

## Description

The Apple ProRes video codec, as specified in [SMPTE RDD 36](https://pub.smpte.org/doc/rdd36/).

## Codec ID

```ts
'prores'
```

## `EncodedPacket` data

The packet's data must be a `frame()` as defined in [SMPTE RDD 36](https://pub.smpte.org/doc/rdd36/).

## `EncodedPacket` type

Since ProRes is intra-frame-only, every packet is a key frame and its type is therefore always `'key'`.

## `VideoDecoderConfig` codec string

The codec string must be one of the six four-character codes identifying the ProRes profile:

- `'ap4x'` - ProRes 4444 XQ
- `'ap4h'` - ProRes 4444
- `'apch'` - ProRes 422 High Quality
- `'apcn'` - ProRes 422 Standard Definition
- `'apcs'` - ProRes 422 LT
- `'apco'` - ProRes 422 Proxy

## `VideoDecoderConfig` description

`description` is not used for this codec.
