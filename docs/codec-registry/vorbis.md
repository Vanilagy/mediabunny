<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# Vorbis codec registration

## Description

The Vorbis audio codec, specified in the [Vorbis I Specification](https://xiph.org/vorbis/doc/Vorbis_I_spec.html).

## Codec ID

```ts
'vorbis'
```

## `EncodedPacket` data

The packet's data must be an audio packet as described in Section 4.3 of the [Vorbis I Specification](https://xiph.org/vorbis/doc/Vorbis_I_spec.html).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'vorbis'
```

## `AudioDecoderConfig` description

`description` must contain Vorbis codec setup data in Xiph extradata format: the `page_segments` field, followed by the `segment_table` field, followed by the three Vorbis header packets (identification header, comments header, and setup header) as defined in Section 4.2 of the [Vorbis I Specification](https://xiph.org/vorbis/doc/Vorbis_I_spec.html).
