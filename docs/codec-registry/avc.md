<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# AVC (H.264) codec registration

## Description

The Advanced Video Coding (H.264) video codec, specified in [Rec. ITU-T H.264](https://www.itu.int/rec/T-REC-H.264) / [ISO/IEC 14496-10](https://www.iso.org/standard/87574.html).

An AVC bitstream can have either of two formats:
- _Canonical_ (length-prefixed), as defined in [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html) Section 5.3.2. Here, video parameter sets (SPS/PPS) are provided out-of-band.
- _Annex B_, as defined in [Rec. ITU-T H.264](https://www.itu.int/rec/T-REC-H.264) Annex B. Here, video parameter sets (SPS/PPS) must be provided in-band in the respective NALUs.

All packets within the bitstream must have the same format.

## Codec ID

```ts
'avc'
```

## `EncodedPacket` data

The packet's data must be an access unit as defined in [Rec. ITU-T H.264](https://www.itu.int/rec/T-REC-H.264) Section 7.4.1.2, in either _canonical_ or _Annex B_ format.

## `EncodedPacket` type

If the packet's type is `'key'`, then the packet is expected to contain a primary coded picture from which decoding can begin. Additionally, if the bitstream's format is _Annex B_, then this packet is also expected to contain the necessary video parameter sets to initialize the decoder.

## `VideoDecoderConfig` codec string

The full codec string begins with the prefix `'avc1.'` or `'avc3.'`, with a suffix of 6 characters as described respectively in Section 3.4 of [RFC 6381](https://www.rfc-editor.org/rfc/rfc6381) and Section 5.4.1 of [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html).

## `VideoDecoderConfig` description

If the bitstream is in the _canonical_ (length-prefixed) format, `description` must be an `AVCDecoderConfigurationRecord` as defined in [ISO/IEC 14496-15](https://www.iso.org/standard/89118.html) Section 5.3.3.1.

If the bitstream is in the _Annex B_ format, `description` must be undefined.