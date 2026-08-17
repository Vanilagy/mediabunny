---
description: DTS audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# DTS codec registration

## Description

The DTS audio codec (DTS Coherent Acoustics), specified in [ETSI TS 102 114](https://www.etsi.org/deliver/etsi_ts/102100_102199/102114/01.06.01_60/ts_102114v010601p.pdf).

## Codec ID

```ts
'dts'
```

## `EncodedPacket` data

The packet's data must be a core substream frame as defined in Section 5 of [ETSI TS 102 114](https://www.etsi.org/deliver/etsi_ts/102100_102199/102114/01.06.01_60/ts_102114v010601p.pdf), beginning with the sync word `0x7FFE8001`, followed by any number of extension substreams as defined in Section 7.4.1 of [ETSI TS 102 114](https://www.etsi.org/deliver/etsi_ts/102100_102199/102114/01.06.01_60/ts_102114v010601p.pdf), each beginning with the sync word `0x64582025`. The core substream frame may be omitted.

The bitstream must use 16-bit big-endian packing.

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

The codec string must be one of the four four-character codes identifying which substreams the bitstream is built from:

- `'dtsc'` - a core substream only
- `'dtsh'` - a core substream with extension substreams
- `'dtsl'` - extension substreams carrying lossless audio, with no core substream
- `'dtse'` - DTS Express

## `AudioDecoderConfig` description

`description` is not used for this codec.
