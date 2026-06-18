---
description: DTS audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# DTS codec registration

## Description

Digital Theater Systems (DTS), also known as DTS Coherent Acoustics.

## Codec ID

```ts
'dts'
```

## `EncodedPacket` data

The packet's data must be one DTS frame. Common DTS core frames begin with the sync word `0x7FFE8001`.

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'dts'
```

The codec strings `'dtsc'`, `'dtsh'`, `'dtsl'` and `'dtse'` are also recognized as DTS codec strings and map to the `'dts'` codec ID.

## `AudioDecoderConfig` description

`description` is not used for this codec.
