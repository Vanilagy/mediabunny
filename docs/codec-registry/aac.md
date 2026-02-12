<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# AAC codec registration

## Description

The Advanced Audio Coding (AAC) audio codec, specified in [ISO/IEC 14496-3](https://www.iso.org/standard/76383.html).

An AAC bitstream can have either of two formats:
- _AAC_ (raw), where packets contain raw AAC frames (syntax element `raw_data_block()`) as defined in [ISO/IEC 14496-3](https://www.iso.org/standard/76383.html) Section 4.4.2.1. Here, codec metadata is provided out-of-band.
- _ADTS_, where packets contain ADTS frames as defined in [ISO/IEC 14496-3](https://www.iso.org/standard/76383.html) Section 1.A.3.2. Here, codec metadata is provided in-band in each ADTS frame header.

All packets within the bitstream must have the same format.

## Codec ID

```ts
'aac'
```

## `EncodedPacket` data

If the bitstream is in the _AAC_ (raw) format, the packet's data must be a raw AAC frame (syntax element `raw_data_block()`) as defined in [ISO/IEC 14496-3](https://www.iso.org/standard/76383.html) Section 4.4.2.1.

If the bitstream is in the _ADTS_ format, the packet's data must be an ADTS frame as defined in [ISO/IEC 14496-3](https://www.iso.org/standard/76383.html) Section 1.A.3.2.

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

The following fully qualified codec strings are recognized:

- `'mp4a.40.2'` — MPEG-4 AAC-LC
- `'mp4a.40.02'` — MPEG-4 AAC-LC (leading zero for Aud-OTI compatibility)
- `'mp4a.40.5'` — MPEG-4 HE-AAC v1 (AAC-LC + SBR)
- `'mp4a.40.05'` — MPEG-4 HE-AAC v1 (leading zero for Aud-OTI compatibility)
- `'mp4a.40.29'` — MPEG-4 HE-AAC v2 (AAC-LC + SBR + PS)
- `'mp4a.67'` — MPEG-2 AAC-LC

## `AudioDecoderConfig` description

If the bitstream is in the _AAC_ (raw) format, `description` must be an `AudioSpecificConfig` as defined in [ISO/IEC 14496-3](https://www.iso.org/standard/76383.html) Section 1.6.2.1.

If the bitstream is in the _ADTS_ format, `description` must be undefined.
