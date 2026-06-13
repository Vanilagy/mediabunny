---
description: Digital Theater Systems (DTS) audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# DTS codec registration

## Description

The Digital Theater Systems (DTS) audio codec, specified in [ETSI TS 102 114](https://www.etsi.org/deliver/etsi_ts/102100_102199/102114/01.04.01_60/ts_102114v010401p.pdf).

## Codec ID

```ts
'dts'
```

## `EncodedPacket` data

The packet's data must be a DTS audio frame, beginning with the sync word `0x7FFE8001` (or `0x1FFFE8001` for DTS-HD).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'dtsc'
```

## `AudioDecoderConfig` description

`description` is not used for this codec.
