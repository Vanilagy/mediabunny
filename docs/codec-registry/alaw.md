<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# A-law PCM codec registration

## Description

The A-law companded PCM audio codec, specified in [ITU-T G.711](https://www.itu.int/rec/T-REC-G.711) Tables 1a and 1b.

## Codec ID

```ts
'alaw'
```

## `EncodedPacket` data

The packet's data must be a sequence of bytes of arbitrary length (divisible by the channel count), where each byte is an A-law encoded PCM sample. For multichannel audio, samples from different channels are interleaved.

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'alaw'
```

## `AudioDecoderConfig` description

`description` is not used for this codec.
