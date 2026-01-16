# Input formats

Mediabunny supports a wide variety of commonly used container formats for reading input files. These *input formats* are used in two ways:
- When creating an `Input`, they are used to specify the list of supported container formats. See [Creating a new input](./reading-media-files#creating-a-new-input) for more.
- Given an existing `Input`, its `getFormat` method returns the *actual* format of the file as an `InputFormat`.

## Input format properties

Retrieve the full written name of the format like this:
```ts
inputFormat.name; // => 'MP4'
```

You can also retrieve the format's base MIME type:
```ts
inputFormat.mimeType; // => 'video/mp4'
```

If you want a file's full MIME type, which depends on track codecs, use [`getMimeType`](./reading-media-files#reading-file-metadata) on `Input` instead.

## Input format singletons

Since input formats don't require any additional configuration, each input format is directly available as an exported singleton instance:
```ts
import {
	MP4, // MP4 input format singleton
	QTFF, // QuickTime File Format input format singleton
	MATROSKA, // Matroska input format singleton
	WEBM, // WebM input format singleton
	MP3, // MP3 input format singleton
	WAVE, // WAVE input format singleton
	OGG, // Ogg input format singleton
	ADTS, // ADTS input format singleton
	FLAC, // FLAC input format singleton
	MPEG_TS, // MPEG-TS input format singleton
} from 'mediabunny';
```

You can use these singletons when creating an input:
```ts
import { Input, MP3, WAVE, OGG } from 'mediabunny';

const input = new Input({
	formats: [MP3, WAVE, OGG],
	// ...
});
```

You can also use them for checking the actual format of an `Input`:
```ts
import { MP3 } from 'mediabunny';

const isMp3 = (await input.getFormat()) === MP3;
```

There is a special `ALL_FORMATS` constant exported by Mediabunny which contains every input format singleton. Use this constant if you want to support as many formats as possible:
```ts
import { Input, ALL_FORMATS } from 'mediabunny';

const input = new Input({
	formats: ALL_FORMATS,
	// ...
});
```

::: info
Using `ALL_FORMATS` means [demuxers](https://en.wikipedia.org/wiki/Demultiplexer_(media_file)) for all formats must be included in the bundle, which can increase the bundle size significantly. Use it only if you need to support all formats.
:::

## Input format class hierarchy

In addition to singletons, input format classes are structured hierarchically:
- `InputFormat` (abstract)
	- `IsobmffInputFormat` (abstract)
		- `Mp4InputFormat`
		- `QuickTimeInputFormat`
	- `MatroskaInputFormat`
		- `WebMInputFormat`
	- `Mp3InputFormat`
	- `WaveInputFormat`
	- `OggInputFormat`
	- `AdtsInputFormat`
	- `FlacInputFormat`
	- `MpegTsInputFormat`

This means you can also perform input format checks using `instanceof` instead of `===` comparisons. For example:
```ts
import { Mp3InputFormat } from 'mediabunny';

// Check if the file is MP3:
(await input.getFormat()) instanceof Mp3InputFormat;

// Check if the file is Matroska (MKV + WebM):
(await input.getFormat()) instanceof MatroskaInputFormat;

// Check if the file is MP4 or QuickTime:
(await input.getFormat()) instanceof IsobmffInputFormat;
```

::: info
Well, actually 🤓☝️, the QuickTime File Format is technically not an instance of the ISO Base Media File Format (ISOBMFF) - instead, ISOBMFF is a standard originally inspired by QTFF. However, as the two are extremely similar and are used in the same way, we consider QTFF an instance of `IsobmffInputFormat` for convenience.
:::