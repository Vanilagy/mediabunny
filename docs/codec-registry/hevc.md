<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# HEVC (H.265) codec registration

## Description

The High Efficiency Video Coding (H.265) video codec, specified in [Rec. ITU-T H.265](https://www.itu.int/rec/T-REC-H.265) / [ISO/IEC 23008-2](https://www.iso.org/standard/75484.html).

An HEVC bitstream can have either of two formats:
- _Canonical_ (length-prefixed), as defined in [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html) Section 8.3.2. Here, video parameter sets (VPS/SPS/PPS) are provided out-of-band.
- _Annex B_, as defined in [Rec. ITU-T H.265](https://www.itu.int/rec/T-REC-H.265) Annex B. Here, video parameter sets (VPS/SPS/PPS) must be provided in-band in the respective NALUs.

All packets within the bitstream must have the same format.

## Codec ID

```ts
'hevc'
```

## `EncodedPacket` data

The packet's data must be an access unit as defined in [Rec. ITU-T H.265](https://www.itu.int/rec/T-REC-H.265) Section 7.4.2.4, containing exactly one base layer coded picture, in either _canonical_ or _Annex B_ format.

## `EncodedPacket` type

If the packet's type is `'key'`, then the packet is expected to contain an IDR, CRA, or BLA picture. Additionally, if the bitstream's format is _Annex B_, then this packet is also expected to contain the necessary video parameter sets to initialize the decoder.

## `VideoDecoderConfig` codec string

The full codec string begins with the prefix `'hev1.'` or `'hvc1.'`, with a variable-length suffix of four dot-separated fields as specified in Section E.3 of [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html).

## `VideoDecoderConfig` description

If the bitstream is in the _canonical_ (length-prefixed) format, `description` must be an `HEVCDecoderConfigurationRecord` as defined in [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html) Section 8.3.3.1.

If the bitstream is in the _Annex B_ format, `description` must be undefined.
