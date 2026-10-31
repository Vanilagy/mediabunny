---
description: Dolby TrueHD audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# TrueHD codec registration

## Description

The Dolby TrueHD lossless audio codec, as described in Dolby's _Dolby TrueHD (MLP) high-level bitstream description_. Its predecessor, Meridian Lossless Packing (MLP), is not covered by this registration.

## Codec ID

```ts
'truehd'
```

## `EncodedPacket` data

The packet's data must be exactly one access unit, beginning with the 4-byte access unit header that holds the access unit's length.

## `EncodedPacket` type

If the packet's type is `'key'`, then the access unit is expected to carry a major sync, meaning its bytes 4 through 7 are `0xF8726FBA`. All other access units are of type `'delta'`.

## `AudioDecoderConfig` codec string

```ts
'mlpa'
```

## `AudioDecoderConfig` description

`description` is not used for this codec.
