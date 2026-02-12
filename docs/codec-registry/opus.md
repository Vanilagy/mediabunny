<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# Opus codec registration

## Description

The Opus audio codec, specified in [RFC 6716](https://www.rfc-editor.org/rfc/rfc6716).

## Codec ID

```ts
'opus'
```

## `EncodedPacket` data

The packet's data must be an Opus packet as described in Section 3 of [RFC 6716](https://www.rfc-editor.org/rfc/rfc6716).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

```ts
'opus'
```

## `AudioDecoderConfig` description

If present, `description` must be an Identification Header as defined in Section 5.1 of [RFC 7845](https://www.rfc-editor.org/rfc/rfc7845).
