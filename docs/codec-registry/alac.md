---
description: Apple Lossless Audio Codec (ALAC) audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# ALAC codec registration

## Description

The Apple Lossless Audio Codec (ALAC), specified in the [ALAC Specification](https://alac.macosforge.org/).

## Codec ID

```ts
'alac'
```

## `EncodedPacket` data

The packet's data must be an ALAC frame as described in the [ALAC Specification](https://alac.macosforge.org/).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'alac'
```

## `AudioDecoderConfig` description

`description` must contain a 24-byte ALAC magic cookie (`alac` atom contents) as specified in the [ALAC Specification](https://alac.macosforge.org/).
