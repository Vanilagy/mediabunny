# Introduction

Mediabunny is a JavaScript library for reading, writing, and converting media files (like MP4 or WebM), directly in the browser. It aims to be a complete toolkit for high-performance media operations on the web. It's written from scratch in pure TypeScript, has zero dependencies, and is extremely tree-shakable, meaning you only include what you use. You can think of it a bit like [FFmpeg](https://ffmpeg.org/), but built for the web's needs.

## Features

Here's a long list of stuff this library does:

- Reading metadata from media files
- Extracting media data from media files
- Creating new media files
- Converting media files
- Hardware-accelerated decoding & encoding (via the WebCodecs API)
- Support for multiple video, audio and subtitle tracks
- Read & write support for many container formats (.mp4, .mov, .webm, .mkv, .mp3, .wav, .ogg, .aac, .flac, .ts), including variations such as MP4 with Fast Start, fragmented MP4, streamable Matroska, transparent WebM, etc.
- Support for 25 different codecs
- Lazy, optimized, on-demand file reading
- Input and output streaming, arbitrary file size support
- File location independence (memory, disk, network, ...)
- Utilities for compression, resizing, rotation, cropping, resampling, trimming
- Metadata tag reading & writing (title, artist, cover art, custom tags, attached files, etc.)
- Transmuxing and transcoding
- Microsecond-accurate reading and writing precision
- Efficient seeking through time
- Pipelined design for efficient hardware usage and automatic backpressure
- Custom encoder & decoder support for polyfilling
- Low- & high-level abstractions for different use cases
- Performant everything
- Node.js support

...and there's probably more.

## Use cases

Mediabunny is a general-purpose toolkit and can be used in infinitely many ways. But, here are a few ideas:

- File conversion & compression
- Displaying file metadata (duration, dimensions, ...)
- Extracting thumbnails
- Creating videos in the browser
- Building a video editor
- Live recording & streaming
- Efficient, sample-accurate playback of large files via the Web Audio API

Check out the [Examples](/examples) page for demo implementations of many of these ideas!

## Getting started

To get going with Mediabunny, here are some starting points:
- Check out [Quick start](./quick-start) for a collection of useful code snippets
- Start with [Reading media files](./reading-media-files) if you want to do read operations.
- Start with [Writing media files](./writing-media-files) if you want to do write operations.
- Start with [Converting media files](./converting-media-files) if you care about file conversions.
- Dive into [Packets & samples](./packets-and-samples) for a deeper understanding of the concepts underlying this library.

## Motivation

Mediabunny is the evolution of my previous libraries, [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [webm-muxer](https://github.com/Vanilagy/webm-muxer), which were both created due to the advent of the WebCodecs API. While they fulfilled their job just fine, I saw a few painpoints:
- Lots of duplicated code between the two libraries, otherwise very similar API.
- No help with the difficulties of navigating the WebCodecs API & related browser APIs.
- "mp4-demuxer when??"

This library is the result of unifying these libraries into one, solving all the above issues, and expanding the scope. Now:
- Changing the output file format is a single-line change; the rest of the API is identical.
- Lots of abstractions on top of the WebCodecs API & browser APIs are provided.
- mp4-demuxer now.

Due to tree shaking, if you only need an MP4 or WebM muxer, this library's bundle size will still be very small.

### Migration

If you're coming from mp4-muxer or webm-muxer, you should migrate to Mediabunny. For that, refer to these guides:

- [Guide: Migrating from mp4-muxer to Mediabunny](https://github.com/Vanilagy/mp4-muxer/blob/main/MIGRATION-GUIDE.md)
- [Guide: Migrating from webm-muxer to Mediabunny](https://github.com/Vanilagy/webm-muxer/blob/main/MIGRATION-GUIDE.md)

## Technical overview

At its core, Mediabunny is a collection of multiplexers and demultiplexers, one of each for every container format. Demultiplexers stream data from *sources*, while multiplexers stream data to *targets*. Every demultiplexer is capable of extracting file metadata as well as compressed media data, while multiplexers write metadata and encoded media data into a new file.

Mediabunny then provides several wrappers around the WebCodecs API to simplify usage: for reading, it creates decoders with the correct codec configuration and efficiently decodes media data in a pipelined way. For writing, it figures out the necessary codec configuration and sets up encoders which are then used to encode raw media data, while respecting the backpressure applied by the encoder. Extracting the right decoder configuration from a media file can be tricky and sometimes involves diving into encoded media packet bitstreams.

The conversion abstraction is built on top of Mediabunny's reading and writing primitives and combines them both in a heavily-pipelined way, making sure reading and writing happen in lockstep. It also consists of a lot of conditional logic probing output track compatibility, decoding support, and finding encodable codec configurations. It makes use of the Canvas API for video processing operations, and uses a custom implementation for audio resampling and up/downmixing.