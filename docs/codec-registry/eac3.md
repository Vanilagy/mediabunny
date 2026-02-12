<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# E-AC-3 codec registration

## Description

The Dolby Digital Plus (E-AC-3) audio codec, specified in [ETSI TS 102 366](https://www.etsi.org/deliver/etsi_ts/102300_102399/102366/01.04.01_60/ts_102366v010401p.pdf).

## Codec ID

```ts
'eac3'
```

## `EncodedPacket` data

The packet's data must be a sync frame as defined in Section E.1.2.0 of [ETSI TS 102 366](https://www.etsi.org/deliver/etsi_ts/102300_102399/102366/01.04.01_60/ts_102366v010401p.pdf), beginning with the sync word `0x0B77`.

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'ec-3'
```

## `AudioDecoderConfig` description

`description` is not used for this codec.
