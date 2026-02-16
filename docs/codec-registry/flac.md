<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# FLAC codec registration

## Description

The Free Lossless Audio Codec (FLAC), specified in the [FLAC Format Specification](https://xiph.org/flac/format.html).

## Codec ID

```ts
'flac'
```

## `EncodedPacket` data

The packet's data must be a FLAC frame as described in the [FLAC Format Specification](https://xiph.org/flac/format.html).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'flac'
```

## `AudioDecoderConfig` description

`description` must contain the bytes `0x66 0x4C 0x61 0x43` (the ASCII string `'fLaC'`), followed by a `STREAMINFO` metadata block as defined in Section 7 of the [FLAC Format Specification](https://xiph.org/flac/format.html).
