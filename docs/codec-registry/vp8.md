<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Video codec" />

# VP8 codec registration

## Description

The VP8 video codec, specified in [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386).

## Codec ID

```ts
'vp8'
```

## `EncodedPacket` data

The packet's data must be a frame as described in Section 4 and Annex A of [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386).

## `EncodedPacket` type

If the packet's type is `'key'`, then the packet is expected to contain a frame where `key_frame` is `true`, as defined in Section 19.1 of [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386).

## `VideoDecoderConfig` codec string

```ts
'vp8'
```

## `VideoDecoderConfig` description

`description` is not used for this codec.
