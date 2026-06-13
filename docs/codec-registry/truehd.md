---
description: Dolby TrueHD audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# Dolby TrueHD codec registration

## Description

The Dolby TrueHD audio codec, specified in [Dolby TrueHD specification](https://developer.dolby.com/).

## Codec ID

```ts
'truehd'
```

## `EncodedPacket` data

The packet's data must be a TrueHD access unit, beginning with the MLP sync word `0x31 0x6C 0x70` (the ASCII string `'1lp'`) or the TrueHD sync word `0x41 0x6C 0x70` (the ASCII string `'Alp'`).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'mlpa'
```

## `AudioDecoderConfig` description

`description` is not used for this codec.
