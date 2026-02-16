<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# Linear PCM codecs registration

## Description

A family of linear pulse-code modulation (PCM) audio codecs of various bit depths and byte orders.

## Codec IDs

| Codec ID | Description |
| --- | --- |
| `'pcm-u8'` | Unsigned 8-bit integer |
| `'pcm-s8'` | Signed 8-bit integer |
| `'pcm-s16'` | Signed 16-bit integer, little-endian |
| `'pcm-s16be'` | Signed 16-bit integer, big-endian |
| `'pcm-s24'` | Signed 24-bit integer, little-endian |
| `'pcm-s24be'` | Signed 24-bit integer, big-endian |
| `'pcm-s32'` | Signed 32-bit integer, little-endian |
| `'pcm-s32be'` | Signed 32-bit integer, big-endian |
| `'pcm-f32'` | 32-bit float, little-endian |
| `'pcm-f32be'` | 32-bit float, big-endian |
| `'pcm-f64'` | 64-bit float, little-endian |
| `'pcm-f64be'` | 64-bit float, big-endian |

## `EncodedPacket` data

The packet's data must be a sequence of bytes of arbitrary length (divisible by the size of one frame), with each sample occupying the number of bits defined by the codec ID. For multichannel audio, samples from different channels are interleaved.

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

The codec string is the same as the codec ID (e.g. `'pcm-s16'`, `'pcm-f32'`).

## `AudioDecoderConfig` description

`description` is not used for this codec.
