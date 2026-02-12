<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# MP3 codec registration

## Description

The MP3 audio codec (MPEG-1/2 Audio Layer III), specified in [ISO/IEC 13818-3](https://www.iso.org/standard/26797.html).

## Codec ID

```ts
'mp3'
```

## `EncodedPacket` data

The packet's data must be an MP3 frame as described in Section 2.4.2.2 of [ISO/IEC 13818-3](https://www.iso.org/standard/26797.html).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'mp3'
```

## `AudioDecoderConfig` description

`description` is not used for this codec.
