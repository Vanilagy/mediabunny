---
description: Add support for container formats Mediabunny doesn't ship with by writing your own demuxer and muxer, usable with the regular Input and Output APIs.
---

# Custom containers

Mediabunny allows you to add your own container formats - useful if you need a format that Mediabunny doesn't support, or want to keep a format's implementation in a separate package. A custom format plugs into the same [`Input`](./reading-media-files) and [`Output`](./writing-media-files) APIs as the built-in ones, so [media sinks](./media-sinks) and [conversion](./converting-media-files) work on its video and audio tracks. There is no custom subtitle demuxer yet; a muxer can still implement `addSubtitleCue`.

::: warning
Like [custom coders](./supported-formats-and-codecs#custom-coders), custom containers need to follow specific implementation rules. Pay special attention to the parts labeled with "**must**" to ensure compatibility.
:::

Throughout this guide, we'll implement a deliberately tiny container: a `TEST` signature, a little-endian sample count, then 16-bit mono PCM samples at one sample per second.

## Custom input formats

To read a custom container, you'll need to create a class which extends `CustomInputFormat`. Input formats aren't registered anywhere; instead, you pass an instance of your format in the `formats` list of each `Input` that should read it:
```ts
import { CustomInputFormat, Input, ALL_FORMATS, BlobSource } from 'mediabunny';

class TestInputFormat extends CustomInputFormat {
	get name() {
		return 'Test';
	}

	get mimeType() {
		return 'audio/test';
	}

	// ...
}

const input = new Input({
	formats: [...ALL_FORMATS, new TestInputFormat()],
	source: new BlobSource(file),
});
```

`ALL_FORMATS` only contains the formats built into Mediabunny, so your format always has to be listed explicitly. The `Input` asks the formats in its list, in order, whether they recognize the file and uses the first one that does.

You **must** implement the following members in your input format class:
```ts
class {
	get name(): string;
	get mimeType(): string;
	canReadInput(context: DemuxerContext): Promise<boolean> | boolean;
	createDemuxer(context: DemuxerContext): CustomDemuxer;
}
```
- `name`\
	A human-readable name for the format, such as `'Test'`.
- `mimeType`\
	The base MIME type of the format, such as `'audio/test'`.
- `canReadInput`\
	Called while the `Input` is figuring out which format the file has. Return `true` if the file's signature (and format version, if there is one) matches, and `false` otherwise. Keep it cheap; recognizing the file is separate from parsing it, which happens in the demuxer.
- `createDemuxer`\
	Called once the format has been recognized. Returns the demuxer which will read the file; each `Input` gets its own demuxer.

### The demuxer context

Both methods receive a [`DemuxerContext`](../api/DemuxerContext):
```ts
type DemuxerContext = {
	readonly reader: DemuxerReader;
	readonly signal: AbortSignal;
};
```

`reader` gives you access to the bytes of the file. Its `requestSlice(start, length)` method reads exactly the given byte range and resolves to `null` if the range extends past the end of the file, while `requestSliceRange(start, minLength, maxLength)` accepts a shorter read at the end of the file and resolves to `null` only if fewer than `minLength` bytes are available. Offsets and lengths **must** be non-negative safe integers, and so **must** their sum; the same goes for the length you pass to `readBytes` or `readAscii`. Both methods return a *slice*: a chunk of the file with a read position, which the exported helper functions such as `readU32Le`, `readAscii` or `readBytes` read from and advance. `signal` is aborted once the input is [disposed](./reading-media-files#disposing-inputs).

This is enough to recognize our format:
```ts
async canReadInput(context: DemuxerContext) {
	const slice = await context.reader.requestSlice(0, 4);
	return slice !== null && readAscii(slice, 4) === 'TEST';
}
```

::: warning
Slices may share cached storage with other reads. You **must not** modify the bytes you get back from the reader.
:::

### The demuxer

`createDemuxer` returns a [`CustomDemuxer`](../api/CustomDemuxer), which is a plain object with the following members:
```ts
type CustomDemuxer = {
	getTracks(): Promise<CustomTrack[]> | CustomTrack[];
	getMimeType(): Promise<string> | string;
	getMetadataTags?(): Promise<MetadataTags> | MetadataTags;
	dispose?(): void;
};
```
- `getTracks`\
	Returns the tracks of the file, in file order. Read whatever headers you need here. Mediabunny calls this once and doesn't recheck the tracks if you mutate them later, so they **must** be complete and valid when you return them.
- `getMimeType`\
	Returns the full MIME type of the file, including the codecs if you know them.
- `getMetadataTags`\
	Returns the [descriptive metadata](./reading-media-files#reading-file-metadata) stored in the file.
- `dispose`\
	Called when the input is disposed. Release any resources you hold here; input disposal does not await this method.

These methods may be called independently and concurrently: nothing guarantees that `getTracks` runs before `getMimeType`. If they share initialization work, cache its promise and await it from each method that needs it. A `getTracks` call that throws is not retried, and it doesn't dispose the demuxer either - disposing the input does that.

Tracks are plain objects too, of type [`CustomVideoTrack`](../api/CustomVideoTrack) or [`CustomAudioTrack`](../api/CustomAudioTrack). Their properties describe the track, and their methods retrieve its packets:
```ts
type CustomAudioTrack = {
	type: 'audio';
	id: number;
	codec: AudioCodec | null;
	timeResolution: number;
	numberOfChannels: number;
	sampleRate: number;
	getDecoderConfig(): Promise<AudioDecoderConfig | null> | AudioDecoderConfig | null;

	getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> | EncodedPacket | null;
	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> | EncodedPacket | null;
	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> | EncodedPacket | null;
	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> | EncodedPacket | null;
	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> | EncodedPacket | null;

	// Plus optional metadata such as name, languageCode or bitrate
};
```
Video tracks have `codedWidth` and `codedHeight` instead of the audio properties, plus optional metadata such as `rotation`. See [`BaseCustomTrack`](../api/BaseCustomTrack) for everything a track can carry. Mediabunny checks the track IDs, codec names, time resolution, dimensions, rotation and audio parameters of the tracks you return, as well as `name`, `languageCode`, `disposition`, `pairingMask`, the bitrates, the boolean flags and the color space, and throws if one is invalid.

- `id`\
	A safe integer which uniquely identifies the track within the file. It **must** be different for every track.
- `codec`\
	The track's codec, or `null` if you can't identify it. It **must** be a codec Mediabunny recognizes for the track's type. If the container stores its own codec identifier, preserve it in `internalCodecId`.
- `timeResolution`\
	The number of timestamp units per second used by the container, such as an MP4 track's timescale. **Must** be finite and positive.
- `numberOfChannels`, `sampleRate`, `codedWidth`, `codedHeight`\
	**Must** be positive integers, as must `squarePixelWidth`, `squarePixelHeight`, `displayWidth` and `displayHeight` when you provide them. A provided `rotation` **must** be `0`, `90`, `180` or `270`.
- `pairingMask`\
	Controls which tracks are [pairable](./reading-media-files#reading-track-metadata) with each other. It defaults to `1n`, which makes all tracks pairable; provide masks if your format has alternative track combinations.
- `getDecoderConfig`\
	Returns the [decoder configuration](./reading-media-files#reading-track-metadata) needed to decode the track, or `null` if there is none. The configuration of a PCM track **must** use the track's codec as its codec string.
- `getFirstPacket`, `getNextPacket`, `getPacket`, `getKeyPacket`, `getNextKeyPacket`\
	Supply packets to `PacketReader` and `PacketCursor`. `getPacket` returns the last packet at or before the timestamp in presentation order, `getKeyPacket` the last key packet at or before it, and `getNextKeyPacket` the next key packet in decode order after the given packet. All of them return `null` if there is no such packet.

The packet methods **must** follow these rules:
- Derive the position only from the packet or timestamp passed in, never from state held across calls. Several sinks may read the same track at once, and their calls may overlap.
- Return packets with stable, non-negative sequence numbers in [decode order](./media-sinks#decode-vs-presentation-order), timestamps in seconds, and packet data in the representation the [codec registry](../codec-registry/overview) specifies for the codec.
- `getPacket(Infinity)` **must** return the last packet in presentation order; computing a track's duration relies on it.
- When `options.metadataOnly` is `true`, return a [metadata-only packet](./packets-and-samples#metadata-only-packets) created with `EncodedPacket.metadataOnly`, with the same timing, sequence number and byte length as the full packet, without reading its payload.
- Live tracks **must** implement the [live waiting behavior](./media-sinks#live-tracks) themselves, including `options.skipLiveWait`; Mediabunny passes the options through unchanged.

::: info
All reading methods of the demuxer and its tracks can return promises, but don't have to. Returning plain values where you can avoids a microtask per call.
:::

Putting it together, here's the demuxer for our format. When the file is shorter than its header claims, it throws instead of pretending the track ended, so that a truncated file doesn't read like a complete one:
```ts
import {
	CustomInputFormat,
	EncodedPacket,
	readAscii,
	readBytes,
	readU32Le,
	type CustomAudioTrack,
	type CustomDemuxer,
	type DemuxerContext,
	type PacketRetrievalOptions,
} from 'mediabunny';

class TestInputFormat extends CustomInputFormat {
	get name() {
		return 'Test';
	}

	get mimeType() {
		return 'audio/test';
	}

	async canReadInput(context: DemuxerContext) {
		const slice = await context.reader.requestSlice(0, 4);
		return slice !== null && readAscii(slice, 4) === 'TEST';
	}

	createDemuxer(context: DemuxerContext): CustomDemuxer {
		return {
			async getTracks() {
				const header = await context.reader.requestSlice(4, 4);
				if (!header) {
					throw new Error('File is truncated.');
				}

				const sampleCount = readU32Le(header);
				const getPacket = async (index: number, options: PacketRetrievalOptions) => {
					if (index < 0 || index >= sampleCount) {
						return null;
					}
					if (options.metadataOnly) {
						return EncodedPacket.metadataOnly('key', index, 1, index, 2);
					}

					const slice = await context.reader.requestSlice(8 + 2 * index, 2);
					if (!slice) {
						throw new Error('File is truncated.');
					}

					return new EncodedPacket(readBytes(slice, 2), 'key', index, 1, index);
				};
				const getPacketAt = (timestamp: number, options: PacketRetrievalOptions) => {
					return getPacket(Math.min(Math.floor(timestamp), sampleCount - 1), options);
				};

				const track: CustomAudioTrack = {
					type: 'audio',
					id: 1,
					codec: 'pcm-s16',
					timeResolution: 1,
					numberOfChannels: 1,
					sampleRate: 1,
					getDecoderConfig: () => ({ codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 1 }),
					getFirstPacket: options => getPacket(0, options),
					getNextPacket: (packet, options) => getPacket(packet.sequenceNumber + 1, options),
					getPacket: getPacketAt,
					getKeyPacket: getPacketAt, // Every packet is a key packet
					getNextKeyPacket: (packet, options) => getPacket(packet.sequenceNumber + 1, options),
				};
				return [track];
			},
			getMimeType: () => 'audio/test',
		};
	}
}
```

## Custom output formats

To write a custom container, you'll need to create a class which extends `CustomOutputFormat`, and pass an instance of it as the `format` of your `Output`:
```ts
import { CustomOutputFormat, Output, BufferTarget } from 'mediabunny';

class TestOutputFormat extends CustomOutputFormat {
	// ...
}

const output = new Output({
	format: new TestOutputFormat(),
	target: new BufferTarget(),
});
```

Custom output formats write a single file; a separate [initialization target](./writing-media-files#pathed-multi-file-targets) is not supported.

You **must** implement the following members in your output format class:
```ts
class {
	get name(): string;
	get fileExtension(): string;
	get mimeType(): string;
	get supportsVideoRotationMetadata(): boolean;
	get supportsTimestampedMediaData(): boolean;
	getSupportedCodecs(): MediaCodec[];
	getSupportedTrackCounts(): TrackCountLimits;
	createMuxer(context: MuxerContext): CustomMuxer;
}
```
- `name`\
	A human-readable name for the format, such as `'Test'`.
- `fileExtension`\
	The file extension including the dot, such as `'.test'`.
- `mimeType`\
	The base MIME type of the format, such as `'audio/test'`.
- `supportsVideoRotationMetadata`\
	Whether the format can store a video track's rotation as metadata. If `false`, adding a rotated video track throws.
- `supportsTimestampedMediaData`\
	Whether the format stores the timestamps of its packets. If `true`, the timestamps of added packets are respected, allowing gaps and non-zero start times. If `false`, the media data implicitly starts at zero and follows sequential timing from there, using the intrinsic durations of the packets. This describes what your muxer writes; Mediabunny doesn't rewrite packet timestamps for you, but [conversion](./converting-media-files) uses it to decide whether it needs to pad the start.
- `getSupportedCodecs`\
	Returns the codecs the format can contain. Adding a track with any other codec throws. Only the codec is checked; if your format is picky about channel counts, sample rates or dimensions, check the decoder configuration in the muxer.
- `getSupportedTrackCounts`\
	Returns how many tracks of each type the format allows, as [`TrackCountLimits`](../api/TrackCountLimits).
- `createMuxer`\
	Called when the `Output` is created. Returns the muxer which will write the file; each `Output` gets its own muxer.

### The muxer context

`createMuxer` receives a [`MuxerContext`](../api/MuxerContext):
```ts
type MuxerContext = {
	readonly tracks: readonly OutputTrack[];
	readonly metadataTags: MetadataTags;
	readonly signal: AbortSignal;
	getRootWriter(monotonic?: boolean | ((target: Target) => boolean)): Promise<MuxerWriter>;
};
```
- `tracks`\
	The tracks added to the output. Since tracks are added after the muxer is created, they are complete once `start` is called.
- `metadataTags`\
	The [metadata tags](./writing-media-files#setting-metadata-tags) set on the output. Like the tracks, they are complete once `start` is called.
- `signal`\
	Aborted when the output is [canceled](./writing-media-files#canceling-an-output). Use it to interrupt work you are waiting on.
- `getRootWriter`\
	Returns the writer for the output file. Call it from `start` or later, not from `createMuxer`: before the output has started it throws. Pass `true` as `monotonic` if your format only ever appends to the file and never seeks backwards - this is the same property as [append-only writing](./output-formats#append-only-writing), and it's what allows your format to be used with an [`AppendOnlyStreamTarget`](./writing-media-files#appendonlystreamtarget). If it depends on the target, pass a function instead. `monotonic` defaults to `false`, and repeated calls **must** pass the same boolean or the same function object.

The writer's `write` method writes bytes at the current position and advances it, and `seek` moves that position, for example to patch a size into the header at the end. Regularly `await` its `flush` method; that's how the target's [backpressure](./writing-media-files#applying-backpressure) reaches your muxer.

### The muxer

`createMuxer` returns a [`CustomMuxer`](../api/CustomMuxer), again a plain object:
```ts
type CustomMuxer = {
	start(): Promise<void> | void;
	getMimeType(): Promise<string> | string;
	addEncodedVideoPacket?(track: OutputVideoTrack, packet: EncodedPacket, meta?: EncodedVideoChunkMetadata): Promise<void> | void;
	addEncodedAudioPacket?(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata): Promise<void> | void;
	addSubtitleCue?(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata): Promise<void> | void;
	onTrackClose?(track: OutputTrack): Promise<void> | void;
	finalize(): Promise<void> | void;
	dispose?(): Promise<void> | void;
};
```
- `start`\
	Called when the output is [started](./writing-media-files#starting-an-output). Acquire the writer and write your header here.
- `getMimeType`\
	Returns the full MIME type of the file, including the codecs. It may run while a packet callback is pending, so it can wait for decoder configuration that only arrives with a later packet.
- `addEncodedVideoPacket`, `addEncodedAudioPacket`, `addSubtitleCue`\
	Called for each packet or cue that is added, together with the track it belongs to and the metadata the encoder provided, if any. You **must** implement the ones for the track types your format supports. Mediabunny checks the timestamps before calling you: the first packet of a track is a key packet, timestamps are never negative, and a timestamp is never smaller than the largest timestamp of the previous [GOP](./media-sinks#decode-vs-presentation-order), although packets may be reordered within a GOP.
- `onTrackClose`\
	Called when a track's source finishes closing before finalization has begun.
- `finalize`\
	Called when the output is [finalized](./writing-media-files#finalizing-an-output). Write whatever remains here, such as patching sizes into the header. After this method and `dispose` complete successfully, Mediabunny flushes and finalizes the writer for you.
- `dispose`\
	Called after `finalize`, or when the output is canceled. Release any resources you hold here.

::: info
All muxer callbacks except `getMimeType` are *serialized* across all tracks, so no two of them ever run at the same time.
:::

::: warning
Because of that, a callback **must not** wait for a later callback - for example, a packet callback can't wait for another track's metadata before writing an interleaved header, and can't wait for `dispose`. Buffer the packet and return instead, or the output will deadlock. When the output is canceled, `context.signal` is aborted before pending callbacks are awaited, so use it to interrupt whatever you are waiting on.
:::

Here's the muxer for our format. Since `getSupportedCodecs` only checks the codec, the muxer itself has to reject audio that isn't mono at one sample per second. It does that using the decoder configuration, which has to arrive with the first packet; conversion won't infer those limits for you:
```ts
import {
	CustomOutputFormat,
	type CustomMuxer,
	type EncodedPacket,
	type MuxerContext,
	type MuxerWriter,
	type OutputAudioTrack,
} from 'mediabunny';

const u32Le = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, true);
	return bytes;
};

class TestOutputFormat extends CustomOutputFormat {
	get name() {
		return 'Test';
	}

	get fileExtension() {
		return '.test';
	}

	get mimeType() {
		return 'audio/test';
	}

	get supportsVideoRotationMetadata() {
		return false;
	}

	get supportsTimestampedMediaData() {
		return false; // Samples are written back to back, so their timestamps follow from their position
	}

	getSupportedCodecs() {
		return ['pcm-s16' as const];
	}

	getSupportedTrackCounts() {
		return {
			video: { min: 0, max: 0 },
			audio: { min: 1, max: 1 },
			subtitle: { min: 0, max: 0 },
			total: { min: 1, max: 1 },
		};
	}

	createMuxer(context: MuxerContext): CustomMuxer {
		const bytesPerSample = 2;
		let writer: MuxerWriter;
		let sampleCount = 0;
		let decoderConfig: AudioDecoderConfig | undefined;

		return {
			async start() {
				writer = await context.getRootWriter();
				writer.write(new Uint8Array([84, 69, 83, 84])); // 'TEST'
				writer.write(u32Le(0)); // Patched in finalize
			},
			getMimeType: () => 'audio/test',
			async addEncodedAudioPacket(
				_track: OutputAudioTrack,
				packet: EncodedPacket,
				meta?: EncodedAudioChunkMetadata,
			) {
				const config = meta?.decoderConfig ?? decoderConfig;
				if (!config) {
					throw new Error('The first packet must include a decoder configuration.');
				}
				if (config.numberOfChannels !== 1 || config.sampleRate !== 1) {
					throw new Error('Only mono audio at 1 Hz is supported.');
				}
				decoderConfig = config;

				if (packet.data.byteLength % bytesPerSample !== 0) {
					throw new Error('Packet data must contain whole samples.');
				}

				writer.write(packet.data);
				sampleCount += packet.data.byteLength / bytesPerSample;
				await writer.flush();
			},
			finalize() {
				writer.seek(4);
				writer.write(u32Le(sampleCount));
			},
		};
	}
}
```

That's it - you can now use this format with any `Output`. For a [conversion](./converting-media-files) into it, request what the muxer accepts, here `audio: { numberOfChannels: 1, sampleRate: 1 }`; the supported-codec list doesn't convey those restrictions.
