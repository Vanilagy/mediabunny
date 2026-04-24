# Reading HLS

Mediabunny has full support for reading HLS (.m3u8) playlists, both VOD and live. This page will go into HLS-specific behavior and advice. For general information about how to read any media file (including HLS) in Mediabunny, refer to [Reading media files](./reading-media-files).

## Mental model

Mediabunny exposes HLS playlists as if they were a single giant input file. Like with any other format, it does not ever expose the underlying structure (playlists, segments, decryption keys), but instead exposes an abstract, media data-centric view. Any code written to handle other Mediabunny inputs will automatically work on HLS inputs: they are also just a collection of tracks, and each track contains a linear sequence of media data. The multi-file, multi-playlist and multi-segment nature of HLS is abstracted away and completely hidden from the user.

## HLS inputs

HLS playlists (master & media) are read through the same `Input` interface as all other media files in Mediabunny. HLS must read multiple files, meaning any [`PathedSource`](../api/PathedSource) is required:
```ts
import { Input, UrlSource, HLS_FORMATS } from 'mediabunny';

const input = new Input({
	source: new UrlSource('https://example.com/master.m3u8'),
	formats: HLS_FORMATS, // HLS_FORMATS includes HLS as well as the commonly-used segment formats
});
```

You can supply any custom "path to data" resolution logic by using [`CustomPathedSource`](../api/CustomPathedSource).

## Reading tracks

To retrieve all tracks:
```ts
const tracks = await input.getTracks();
```

Mediabunny flattens all tracks across all variants into a single flat array. If multiple variants reference the same underlying media playlist, the duplicated tracks will be deduplicated.

Since Mediabunny lazy-loads all information, retrieving the list of all tracks is a cheap operation, as it only needs to fetch the master playlist.

If you point Mediabunny directly at a media playlist, then the list of tracks is deduced by the tracks present in the first segment of the playlist.

### Track queries

Mediabunny offers an [`InputTrackQuery`](../api/InputTrackQuery) system to aid with finding tracks in complex many-track inputs such as the ones common with HLS.

Here's a holistic example that constructs an HLS quality ladder and then selects audio tracks based on language:

```ts
import { desc, prefer } from 'mediabunny';

// Get video tracks sorted by their resolution (highest first)
const videoTracks = await input.getVideoTracks({
	sortBy: async track => [
		desc(await track.getDisplayHeight()),
		// Tracks with matching resolution are sorted by bitrate
		desc(await track.getBitrate()),
	],
	// Filter out #EXT-X-I-FRAME-STREAM-INF tracks
	filter: async track => !(await track.hasOnlyKeyPackets()),
});
const availableQualities = videoTracks.length;

// Get the best quality video track
const video = videoTracks[0];

// Get the audio track that accompanies this video track
const matchingAudioTrack = await video.getPrimaryPairableAudioTrack();

// Get all audio tracks
const availableAudioTracks = await video.getPairableAudioTracks();
const availableLanguages = await Promise.all(
	availableAudioTracks.map(track => track.getLanguageCode()),
);

// Get the Spanish audio track
const matchingSpanishAudio = await video.getPrimaryPairableAudioTrack({
	filter: async track => await track.getLanguageCode() === 'es',
});
// Get the Spanish audio track if one exists, otherwise get
// the next best thing
const matchingAudioPreferSpanish = await video.getPrimaryPairableAudioTrack({
	sortBy: async track => prefer(await track.getLanguageCode() === 'es'),
});
```

### Reading track metadata

For general reading of track metadata, see [Reading media files](./reading-media-files). Some notable metadata mappings for HLS are:
```ts
// Returns the value of the BANDWIDTH attribute (peak bitrate).
// If the track is used in multiple variants, this returns the
// max of those bitrates.
await track.getBitrate();

// Same as above, but AVERAGE-BANDWIDTH
await track.getAverageBitrate();

// LANGUAGE attribute
await track.getLanguageCode();

// NAME attribute
await track.getName();

const disposition = await track.getDisposition();
disposition.primary; // => DEFAULT attribute (= primary in Mediabunny)
disposition.default; // => AUTOSELECT attribute

// Indicates an #EXT-X-I-FRAME-STREAM-INF track
await track.hasOnlyKeyPackets();
```

## Track pairings

In Mediabunny, two tracks are considered _pairable_ if they can be presented together. HLS master playlists explicitly model pairability via variant streams and media renditions. Even though Mediabunny does not expose these structures and flattens out all tracks, the pairability graph implied by the master playlist is still available via:
```ts
trackA.canBePairedWith(trackB);
```

Many other methods are available to query pairability and pairable tracks; see the [`InputTrack`](../api/InputTrack) API docs.

### Example

Consider the following two master playlists:

**Playlist #1:**
```m3u8
#EXTM3U

#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720
video-and-audio-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x480
video-and-audio-2.m3u8
```

**Playlist #2:**
```m3u8
#EXTM3U

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",URI="audio-1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",URI="audio-2.m3u8"

#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio"
video-1.m3u8
#EXT-X-STREAM-INF:CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x480,AUDIO="audio"
video-2.m3u8
```

Both of these playlists define exactly four tracks: two video tracks, two audio tracks. _They differ only in their pairability:_
- The first playlist has video-audio pairs. Video track #1 can only go with audio track #1, video track #2 can only go with audio track #2.
- The second playlist is more open. Any video track can be paired with any audio track.

That means, for playlist #1:
```ts
const videoTrack = (await input.getVideoTracks())[0];
(await videoTrack.getPairableTracks()).length; // => 1
```

For playlist #2:
```ts
const videoTrack = (await input.getVideoTracks())[0];
(await videoTrack.getPairableTracks()).length; // => 2
```

## Lazy loading

Track information is lazily loaded. This means this operation only loads the master playlist:
```ts
const track = await input.getPrimaryVideoTrack();
```

Then, operations that only require the media playlist will load only it:
```ts
const duration = await track.getDurationFromMetadata();
```

Finally, some operations require the first segment as well:
```ts
const decoderConfig = await track.getDecoderConfig();
```

Operations that access media data may load any segment necessary to fulfill that request, but not more:
```ts
const sink = new EncodedPacketSink(videoTrack);

// Get the packet somewhere in the middle of the stream at 300s
const middlePacket = await sink.getPacket(300);
```

Some operations may load more or less data depending on the underlying file. For example, this code only requires the
master playlist if the optional `RESOLUTION` attribute is present, but if it is not, Mediabunny has no choice but to
dig into the underlying media data to determine the resolution:
```ts
const width = await track.getDisplayWidth();
const height = await track.getDisplayHeight();
```

---

Playlists are internally cached so they are never read more than once. Segments are only cached if they are still in use; unused
segments are evicted to keep memory usage bounded.

## Unix-timestamped media

Some HLS media playlists (especially the live ones) may look like this:
```m3u8
#EXTM3U
#EXT-X-TARGETDURATION:10

#EXTINF:10,
#EXT-X-PROGRAM-DATE-TIME:2024-01-01T00:00:00Z
segment-1.ts
#EXTINF:10,
#EXT-X-PROGRAM-DATE-TIME:2024-01-01T00:00:10Z
segment-2.ts

#EXT-X-ENDLIST
```

Here, each segment is assigned a specific Unix timestamp, crucial for cross-track synchronization.

Mediabunny does not expose these timestamps as out-of-band metadata. Instead, it shifts the whole track's timeline so
that its timestamps *are* Unix timestamps.

Specifically, this means for the above playlist:
```ts
await track.getFirstTimestamp(); // => 1704067200 (Unix timestamp for 2024-01-01T00:00:00Z)
await track.computeDuration(); // => 1704067220 (Unix timestamp for 2024-01-01T00:00:20Z)

const sink = new EncodedPacketSink(track);
(await sink.getPacket(1704067210))!.timestamp; // => 1704067210 (Unix timestamp for 2024-01-01T00:00:10Z)
```

This makes cross-track synchronization trivial. To know if a track's timestamps are relative to the Unix epoch, use:
```ts
await track.isRelativeToUnixEpoch(); // => boolean
```

## Live HLS

HLS playlists may be live. You can check that a track is live via:
```ts
await track.isLive(); // => boolean
```

Every live track also has a "refresh interval", which is the time in seconds after which new media data is probably available:
```ts
await track.getLiveRefreshInterval(); // => number | null
```

### Mental model

Mediabunny has a very simple mental model for live tracks: they are treated like tracks where media data is continually being added to the end. That also means that the media data *at* the end is not yet known, because the end is not yet known.

Another way to think of it is as input files that have not yet been fully written, where more data is still being added to the end.

The point at which the last piece of media data is currently known is called the **live edge**.

### Reading live media data

This mental model implies that by default, Mediabunny will wait until any reading operation can be resolved, referred to as the "live wait". For example, this code only finishes when the live stream ends:
```ts
const duration = await track.getDurationFromMetadata();
```
This is because the duration can only be known when the live stream has ended.

Similarly, this code will run as long as the live stream runs:
```ts
const sink = new EncodedPacketSink(track);
const iterator = sink.packets();

for await (const packet of iterator) {
	console.log(packet);
}

// Live stream has ended, all packets iterated!
```

---

Sometimes, this behavior is undesirable. Imagine we want to read the frame at the end of the *currently-known* data.

Mediabunny allows you to treat live tracks as if all of the media data is already known. For this, the `skipLiveWait` flag is used:
```ts
// Get the duration up until the current point in the live stream
const currentDuration = await track.getDurationFromMetadata({ skipLiveWait: true });

// Loop over all currently known packets
const sink = new EncodedPacketSink(track);
const iterator = sink.packets(undefined, undefined, { skipLiveWait: true });

for await (const packet of iterator) {
	console.log(packet);
}
```

You can combine `skipLiveWait` with the track's live refresh period to perform polling. For example, this code continually refreshes the currently known duration:
```ts
let knownDuration: number | null = null;

const poll = async () => {
	knownDuration = await track.getDurationFromMetadata({
		skipLiveWait: true,
	});

	const refreshInterval = await track.getLiveRefreshInterval();
	if (refreshInterval === null) {
		return; // The track is no longer live
	}

	setTimeout(poll, 1000 * refreshInterval);
};
await poll();
```

### Live playback

Any media playback requires sampling the media data at a continually increasing timestamp. For live playback, the right timestamp must be found at which continual playback without interruptions can be guaranteed. A good rule of thumb is to use the following:
```ts
const currentDuration = await track.getDurationFromMetadata({
	skipLiveWait: true,
});
const refreshInterval = await track.getLiveRefreshInterval();
const fac = 2;

const playbackStartTime = currentDuration! - fac * refreshInterval!;
```

You can lower `fac` to move playback closer to the live edge (1.5 works fine too), although you should not lower it below 1.

You can make `fac` larger to increase resilience against flaky internet or an unreliable media producer.

## Encrypted content

Some HLS playlists carry encrypted media data. Mediabunny can read data that has been encoded with the following encryption schemes:
- `'AES-128'`
- `'SAMPLE-AES'`
- `'SAMPLE-AES-CTR'`

---

`'SAMPLE-AES'` and `'SAMPLE-AES-CTR'` are currently only supported for ISOBMFF media files. They are most commonly seen in DRM-encrypted content (Widevine, FairPlay, etc.) for which Mediabunny has no way of obtaining the decryption keys by itself, since commercial CDMs don't expose keys to userland (that's the whole point of DRM).

Mediabunny is still able to decrypt the data if you provide it with the decryption keys directly using [`InputOptions.formatOptions.isobmff.resolveKeyId`](../api/IsobmffInputFormatOptions#resolvekeyid). An example:
```ts
// Maps each key ID to a concrete decryption key
const keyMap = new Map([
	['4d97930a3d7b55fa81d0028653f5e499', '429ec76475e7a952d224d8ef867f12b6'],
	['d21373c0b8ab5ba9954742bcdfb5f48b', '150a6c7d7dee6a91b74dccfce5b31928'],
	['6f1729072b4a5cd288c916e11846b89e', 'a84b4bd66901874556093454c075e2c6'],
	['800aacaa522958ae888062b5695db6bf', '775dbf7289c4cc5847becd571f536ff2'],
	['67b30c86756f57c5a0a38a23ac8c9178', 'efa2878c2ccf6dd47ab349fcf90e6259'],
]);

using input = new Input({
	source: new UrlSource(
		'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8',
	),
	formats: ALL_FORMATS,
	formatOptions: {
		isobmff: {
			resolveKeyId: ({ keyId, psshBoxes }) => {
				// psshBoxes contains Protection System Specific Header boxes
				// relevant to this key ID. They can be used to obtain a
				// decryption key from a DRM license server.
				const key = keyMap.get(keyId);
				if (!key) {
					throw new Error('Unknown key ID.');
				}

				return key;
			},
		},
	},
});
```

## Subtitles

Reading subtitles from HLS playlists is not currently supported. Sorry!
