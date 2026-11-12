# Bug hunt report

All 49 slices of Mediabunny (core, shared, and every extension package) were reviewed line by line by
max-effort agents. Every fix below was reproduced first, and each has a regression test that fails without the
fix and passes with it (exceptions are marked). The tests live in the regular suite (new category files:
`test/node/media-sinks.test.ts`, `media-sources.test.ts`, `conversion.test.ts`, `codec.test.ts`,
`misc.test.ts`, `prores-webkit.test.ts`, `test/browser/codec.test.ts`).
Nothing is committed.

Behavior changes worth a look are marked **[behavior change]**.

## Fixed bugs

### MP4 / MOV (ISOBMFF) demuxer ✅

✅ Hybrid fragmented files (samples in moov plus moofs, FFmpeg `-movflags frag_keyframe` without `empty_moov`)
  ignored every fragment (10 of 30 packets). Fix: the lookups no longer return the moov sample table's result
  as soon as it's non-empty. `getPacket`/`getKeyPacket` also run the fragmented lookup and prefer its match (the
  fragments come after the moov samples), and `getNextPacket`/`getNextKeyPacket` continue into the first
  fragment (new `fetchFirstFragmentedPacket`) once the moov samples run out.
✅ `getDurationFromMetadata` returned only the moov part's duration for hybrid fragmented files (now null). Fix:
  return null if the file is fragmented and the moov sample table holds samples.
✅ In hybrid fragmented files without tfdt, the first fragment started at 0, overlapping the moov's samples (FFmpeg
  always writes tfdt, but ISO 14496-12 implies the sum of all earlier sample durations when it's missing). Fix:
  the first fragment's fallback start is the end of the moov sample table's decode timeline.
✅ `readFragment` race: a second request for the same moof during async post-processing got a half-processed
  fragment (undecrypted ciphertext for saiz/saio-only encryption). Fix: `lastReadFragment` now caches the moof
  offset together with a promise of the fully processed fragment, set before the first await, so concurrent reads
  of the same moof share one read (including the aux info resolution). Failed reads are evicted so they can be
  retried.
✅ Fragments without tfdt/tfra drifted by the composition delay with every fragment. Fix: a fragment without
  tfdt continues from the previous fragment's end decode timestamp (the cache stores `endDecodeTimestamp` instead
  of the presentation `endTimestamp`), and `offsetFragmentTrackDataByTimestamp` also shifts `currentTimestamp`.
✅ `lpcm` with 64-bit float samples was unsupported. Fix: map 64-bit float to `pcm-f64`/`pcm-f64be`.
✅ The `srat` box was ignored (96 kHz ipcm/fpcm read as 48 kHz). Fix: parse `srat` and take the sample rate from
  it.
✅ Sample rates >= 65536 Hz, including Mediabunny's own output, read back as 0 (now falls back to the timescale).
  Fix: `sampleRate || track.timescale`.
✅ PCM whose samples span multiple frames (stts delta != 1, e.g. MP4Box) lost almost all its data. Fix: the PCM
  rewrite that turns every chunk into one sample sized each chunk as `samplesPerChunk` frames; it now derives the
  chunk's frame count from its duration (converted from the track timescale to the sample rate).
✅ An all-ones mdhd duration ("unknown") was taken literally (~1.8e12 s). Fix: an all-ones duration (32 or 64
  bits, depending on the version) is mapped to -1, i.e. unknown.
✅ `saio` offsets inside a traf were taken relative to the moof start instead of the traf's base data offset. Fix:
  add the fragment's `baseDataOffset`, just like for the trun data offset (ISO/IEC 14496-12).
✅ A track-level `(c)nam` was decoded as raw text, so its length/language prefix ended up in the track name. Fix:
  read it with `readMetadataStringShort`; only the `name` box is raw text.
✅ PSSH boxes differing only in their KIDs were deduplicated into one (also in HLS). Fix: `psshBoxesAreEqual`
  compares the key IDs too.

### MP4 / MOV muxer and boxes ✅

✅ Key frames in the middle of a fragment were written as non-sync (several GOPs per fragment). Fix: trun's
  first-sample-flags shortcut (first sample gets explicit flags, the rest use the defaults) is only used when the
  first sample's flags occur nowhere else; previously it only checked that the first two samples differed.
✅ Fragmented: the moov was written before every track's start offset was known (missing edit list, A/V desync).
  Fix: until the fragmented header is written, a new chunk is only begun once every track has a
  `startTimestampOffset` or is closed.
✅ Fragmented mdat >= 4 GiB had a size field 8 bytes short. Fix: add the extra 8 header bytes to `mdatSize` when
  switching to the large size.
✅ trun data offset silently overflowed its signed 32 bits for traf data >= 2 GiB past the moof.
  **[behavior change]** Fix: finalizing such a fragment now throws (an explicit base data offset would break MSE's
  required movie-fragment relative addressing); `trun` asserts the offset fits and writes it as `i32`.
✅ CMAF sidx referenced size was silently truncated for segments >= 2 GiB. **[behavior change]** Fix: finalizing
  such a segment now throws (CmafOutputFormat isn't meant for files that large); the sidx box asserts the size.
✅ `onMoof` timestamps were reported in the internal shifted timeline (regression from the negative-timestamp work).
  Fix: take the fragment start timestamp before the chunk is shifted by `startTimestampOffset`.
✅ `fastStart: 'in-memory'` set explicitly failed with AppendOnlyStreamTarget. Fix: the root writer is requested
  as append-only for `'in-memory'` too, not just `'fragmented'`.
✅ `fastStart: 'reserve'` passed 8 extra bytes (the free box header) to `onMoov`. Fix: write the free box first
  (behind the moov's spot), then seek back and track only the moov write.
✅ WebVTT: zero-duration cues hung (OOM) or asserted. Fix: cues whose (timescale-snapped) end isn't after their
  start are dropped, since they're never visible.
✅ WebVTT: touching cues produced zero-length samples (float end times). Fix: cue start/end are snapped to the
  track timescale when queued and those snapped values are used for sample layout.
✅ WebVTT: the `ctim` box was written in seconds instead of milliseconds. Fix: `Math.round(1000 * sampleStart)`.
✅ Disc number was written as atom `disc` instead of iTunes `disk`. Fix: use `disk`.
✅ PCM > 16 bit in MP4 used the QuickTime v1 sound description (AVFoundation: 0 tracks). Fix: drop the bump to
  version 1 for > 16-bit PCM; only MOV uses v1/v2.
✅ MP4 `ipcm`/`fpcm` >= 65536 Hz only had a 0 in the sample entry. Fix: also write an `srat` box with the actual
  rate, like FFmpeg (other codecs keep the 0, which the demuxer falls back from).
✅ MOV audio >= 65536 Hz wrote sample rate 0 (now a QuickTime v2 sound description). Fix: new version 2 sound
  description with a float64 sample rate; linear PCM uses `lpcm` with its format described by the
  format-specific flags.
✅ E-AC-3 in MOV lacked the `wave` wrapper AVFoundation requires. Fix: in MOV, AC-3 and E-AC-3 are written like
  FFmpeg does: a `wave` box holding `frma` and the `dac3`/`dec3` box (AC-3 worked without it, but now matches).
✅ xHE-AAC (`mp4a.40.42`) was rejected by validation although browsers can decode it. Fix: add it to the valid
  AAC codec strings.
✅ `start()` leaked the muxer mutex when it threw, so `finalize()` hung forever. Fix: `try`/`finally` around the
  body to release the mutex.
✅ `onTrackClose()` leaked the muxer mutex when it threw, so `finalize()` hung forever. Fix: same `try`/`finally`.
✅ VP8's `vpcC` had bit depth 0 (the `vp8` codec string has no bit depth field). Fix: default to 8 bits.
✅ MOV `hdlr` component names were written as C strings instead of QuickTime's counted strings. Fix: in MOV, write
  a length byte followed by the name.
✅ (#630) 24-bit FLAC in MP4 was rejected by Chromium's MSE, since the `fLaC` sample entry always declared 16 bits,
  and sample rates of 65536 Hz and above were written as 0. Fix: FLAC's sample entry takes the bit depth from
  STREAMINFO, and in MP4 a FLAC rate that doesn't fit is halved until it does (96 and 192 kHz become 48000), as the
  FLAC mapping prescribes. Other codecs still write 0. MOV keeps its QuickTime layout.

### Matroska / WebM ✅

✅ HE-AAC reported half its sample rate (`OutputSamplingFrequency` was ignored). Fix: parse
  `OutputSamplingFrequency` and, when present, use it as the track's sample rate.
✅ Muxer: AAC's `SamplingFrequency` was the decoder's output rate, and `OutputSamplingFrequency` was never written.
  Fix: like FFmpeg, `SamplingFrequency` is the AudioSpecificConfig's core rate, and if the decoder config's rate
  differs (SBR), it's written as `OutputSamplingFrequency`.
✅ A cluster cut off by the end of the file was dropped entirely. Fix: load the cluster with `requestSliceRange`
  (min 0 bytes) so a truncated cluster yields whatever data is there.
✅ Segment `Info\Title` (where FFmpeg and mkvmerge write the title) was not read. Fix: parse the `Title` element
  into `metadataTags.title` (tags still take precedence).
✅ Track numbers were wrong in multi-segment files. Fix: the counting loop's `break` only left the inner
  per-segment loop; it now returns directly once the track is found.
✅ An unknown-size segment followed by another file (concatenated live recordings) read the next file's clusters.
  Fix: while scanning an unknown-size segment, any level-0 element (EBML header or Segment) ends it, checked on
  the element itself; previously only a Segment ID directly following a cluster was detected.
✅ Projection yaw/pitch/roll were applied as 2D flips/rotation to 360-degree video. Fix: parse `ProjectionType`
  and only apply the pose for rectangular projections (type 0).
✅ Laced frames got timestamps off the tick grid, so `getPacket(packet.timestamp)` could return the previous packet.
  Fix: laced frame boundaries are floored to integer ticks (like FFmpeg), with duration = next boundary - this one.
✅ `DisplayUnit` was ignored, and a lone `DisplayWidth`/`DisplayHeight` was dropped. Fix: with DisplayUnit 0
  (pixels), a missing display dimension defaults to the pixel one; DisplayUnit 4 (unknown) is ignored, like
  FFmpeg does.
✅ Empty elements didn't take their default values (an empty TimestampScale threw, an empty FlagDefault read as 0).
  Fix: elements with a spec default yield it when their size is 0.
✅ EBML lacing with a frame count of 1 threw. Fix: the only frame is also the last one, whose size is never coded,
  so it takes the rest of the block.
✅ Unknown sizes of 2-7 bytes weren't recognized. Fix: a size is unknown when all its data bits are set, at any
  width.
✅ `readUnsignedBigInt` threw on width 0 (an empty `FileUID`). Fix: width 0 reads as 0, as EBML defines.
✅ DefaultDuration-based durations of laced blocks were fractional ticks, cut short by the per-frame flooring. Fix:
  round `frameCount * defaultDuration` to whole ticks.
✅ An unlaced block without BlockDuration got a fractional `defaultDuration`. Fix: round it to whole ticks.
✅ AV1 CodecPrivate was unused, so the codec info came from the first packet only. Fix: extract it from the av1C
  CodecPrivate's config OBUs, falling back to the first packet.
✅ The projection pose was interpreted before ProjectionType if the children came in another order. Fix: the
  Projection children are collected first, and the pose is applied once the whole element is read.
✅ Muxer: MaxBlockAdditionID was missing while BlockAdditions (alpha, WebVTT) were written. Fix: write
  `MaxBlockAdditionID = 1` for video tracks with alpha and for subtitle tracks.
✅ Muxer: BlockDuration went on the last block in decode order instead of presentation order (last frame duration 0
  with B-frames). **[behavior change]** Matroska copies now report the full last-frame duration; three browser
  conversion test expectations that had `- 1/25` baked in were updated. Fix: the last block per track is the one
  with the greatest timestamp, not the last one seen.
✅ Muxer: `start()`, `onTrackClose()` and `finalize()` leaked the mutex when they threw. Fix: `try`/`finally`
  release.

### MPEG-TS muxer ✅

✅ DTS was greater than PTS for every B-frame. Fix: DTS are still the sorted PTS, but shifted back by the largest
  reordering delay seen so far on the track (`reorderDelay`), which keeps DTS <= PTS.
✅ The HEVC access unit delimiter was malformed (FFmpeg bitstream filters failed on every AU). Fix: add the missing
  payload byte (`pic_type` + RBSP stop bit, 0x50).
✅ A rejected first AAC packet left the track half-initialized ("Assertion failed." on the next add). Fix: set
  `inputIsAdts` only after the AudioSpecificConfig was parsed successfully.
✅ `onTrackClose()` leaked the muxer mutex when it threw. Fix: `try`/`finally` release (also for `start()`).

### MPEG-TS demuxer

✅ Wrong section end recorded for PES packets straddling the PAT/PMT (captures joined mid-broadcast). Fix: when a
  contiguous section read hits a packet of another PID, it no longer records that spot as the section's end,
  since the section may continue after the foreign packets.
✅ PAT parsing ignored `pointer_field` (the program was skipped). Fix: the section end is computed from the
  bitstream position after `section_length` instead of assuming the section starts at byte 0.
✅ PMT parsing ignored `pointer_field` (the last stream was dropped). Fix: same as for the PAT.
✅ Init input metadata was never read before use (segments without parameter sets threw). Fix: `await
  initDemuxer.readMetadata()` before looking up its streams.
✅ Race in the `getNextPacket` fast path (Conversion trims dropped a B-frame). Fix: take the PacketBuffer away from
  the old packet before awaiting `readNext()`, so concurrent calls for the same packet can't both advance it.
✅ `getNextPacket`'s slow path gave wrong durations with B-frames. Fix: rewind by `reorderSize` PES packets
  before reading (with the packet itself, that's `reorderSize + 1` packets of history, like in `getPacket`), since
  reordering (and with it the durations) depends on the packets before.
✅ A tiny final AVC slice was dropped or merged. Fix: instead of always peeking 6 bytes of the slice header, only
  as many bytes as `first_mb_in_slice`'s exp-Golomb code actually spans must be buffered.
✅ The last key packet of intra-only AVC had duration 0. Fix: the end-of-stream rewind (to get a proper duration)
  rewinds `reorderSize + 1` PES packets instead of `reorderSize`, which was 0 for intra-only streams.
✅ Lookups rewound into PES packets preceding the PMT. Fix: rewinding stops at the track's first PES packet
  instead of the start of the file.
✅ Open-GOP leading frames (decoded after the first PES packet but presented before it) made `getPacket` return
  null. Fix: drop the early `return null` for timestamps before the first PES packet's PTS; the chunked search is
  just skipped for them.
✅ A multi-packet non-PES section on a track's PID ended the stream early. Fix: the packet reader skips over the
  whole unusable section (to its `endPos`) instead of advancing by one TS packet.
✅ HEVC EOS/EOB NAL units started new access units. Fix: the access-unit-start range ends at AUD (35) instead of
  37, so EOS/EOB close their access unit.
✅ Audio timestamps drifted within multi-frame PES packets (per-frame rounding to 90 kHz). Fix: frame durations
  stay fractional while the PTS accumulates; only `supplyPacket` rounds the PTS, deriving the packet's
  `intrinsicDuration` from the rounded start and end.
✅ Packets without a successor ignored the codec's frame duration (a lone AAC packet had duration 0). Fix:
  `PacketBuffer` falls back to the packet's `intrinsicDuration`, then to the distance to the previous packet in
  presentation order, and only then to `lastDuration` (the `lastDuration` override in `getPacket` was removed).
✅ Negative timestamps after a positive first PES packet came out as ~95443 s (33-bit wrap reference). Fix:
  `normalizeWrappedTimestamp` maps every timestamp into the 2^33-wide window starting 60 s below the first
  timestamp (`modEuclid`), instead of only unwrapping timestamps below the reference.
✅ E-AC-3 dependent substream frames became separate packets (7.1 read as 6 channels with doubled timing). Fix:
  dependent substream frames (strmtyp 1) directly following a frame are appended to its packet.
✅ PMT guessing still applied after the PAT had named the PMT PID. Fix: guess only while no PAT was seen, or on
  the PAT's PMT PID.
✅ The PMT `table_id` wasn't checked, so private sections on the PMT PID were parsed as the PMT. Fix: only a
  section with table_id 0x02 is taken as the PMT.
✅ The AAC resync scan called the throwing ADTS header parser on false syncs, ending the stream. Fix:
  `readAdtsFrameHeader` returns null for frames with several raw data blocks instead of throwing, like it does for
  every other header it can't use (channel configuration 0 is supported now, see ADTS).
✅ (#635) No audio frame of a PES packet came out before the next PES packet had started, since packet reading took
  in whole PES packets, ending each at the next payload unit start. With a live stream, all frames of a PES packet
  arrived late. Fix: `PacketReadingContext` takes in one TS packet at a time, copying its data into a scratch buffer
  that's cleared up to each supplied packet (which gets sliced out of it). Metadata reading and packet lookups now only read PES headers instead of whole
  sections. Reading speed is unchanged (all packets of a 5.3 MB file: 21.3 vs 20.6-21.9 ms).

### Ogg ✅

✅ Muxer: the Vorbis comment header had no framing bit, so libvorbis rejected every file (verified: FFmpeg's
  libvorbis decoder failed to open with AVERROR_INVALIDDATA; players built on libvorbis are inferred, not tested).
  Fix: append a set framing bit byte to the Vorbis comment header.
✅ Muxer: tracks with different sample rates were interleaved by raw sample counts. Fix: compare the queued
  packets' timestamps in seconds (`timestampInSamples / internalSampleRate`).
✅ Muxer: the last page of a track that closed early was held back until finalize. Fix: the final packet of a
  track flushes its page right away; the leftover-page flush in `finalize()` was removed.
✅ Muxer: header pages could follow data pages. Fix: header packets are marked `isHeader` and sort as `-Infinity`
  during interleaving, so all streams' headers come before any data.
✅ Muxer: `onTrackClose()` leaked the mutex when it threw. Fix: `try`/`finally` release (also for `start()`).
✅ Demuxer: seeking used the granule of the page where a packet starts instead of where it ends. Fix: use
  `endPage.granulePosition` instead of `currentPage.granulePosition`.
✅ Demuxer: start trimming in the first page's granule (`ffmpeg -ss -c copy` cuts) was ignored. Fix: if the first
  page with a granule isn't the final page, a granule smaller than the packets' total duration is taken as start
  trimming (no clamping); the clamp now only applies on the final page, where it means end trimming.
✅ Demuxer: with a broken page chain (malformed input), the lookup fallback started at the next packet without
  knowing its timestamp and returned the wrong packet. Fix: the fallback takes the next packet's start from the
  granule position of the page the previous packet ends on.
✅ Demuxer: an empty (0-byte) packet mid-stream silently ended the stream. Since no codec we read from Ogg allows
  empty packets, it now throws. **[behavior change]** Fix: `readPacket` throws on empty packets; the single empty
  packet VLC ends streams with is taken as the end by `findNextPacketStart` and never read.
✅ Demuxer: seeking to the last packet ahead of VLC's empty final packet gave it the wrong Vorbis duration (no
  previous blocksize), since the empty packet counted as a next packet. Fix: same `findNextPacketStart` change, so
  the lookup takes the last-packet path. Partial: the truncated-file variant remains (see "Not fixed", 2).
✅ Muxer: a first packet starting before the earliest representable point was silently shifted forward (losing
  sync with other tracks). **[behavior change]** Fix: Opus grows the pre-skip in the written OpusHead to cover
  the earlier start (up to 65535, and only while the header is unwritten). Vorbis keeps all packets up to the
  first one ending at or after zero on the first page, whose granule position then signals start trimming. What
  still can't be represented (beyond the largest pre-skip, or more than fits on one page) is dropped, earliest
  first, with a one-time warning like Matroska's. Granule positions are never written below zero.
  `OggOutputFormat.negativeTimestampSupport` is now `'prefer-non-negative'` (was `'none'`), so forced copy
  conversions keep their preroll packets at negative timestamps instead of failing.
✅ **[behavior change]** End trimming was removed from Ogg reading and writing, since packet durations can't
  properly signal it (that needs a dedicated mechanism for packets dropping samples). The demuxer no longer clamps
  packets on the EOS page to its granule position, and the muxer no longer shortens the final granule position by
  the last packet's duration.
✅ The MIME type could read `codecs=""`. Fix: check `codecStrings.length > 0` instead of the array's truthiness.

### FLAC ✅

✅ Frame sample-rate code 0b1100 (kHz) was not multiplied by 1000 (12/64 kHz files had 0 packets). Fix: `1000 *
  readU8(slice)`.
✅ The 36-bit STREAMINFO total sample count overflowed. Fix: covered by the `Bitstream` fix below (`readBits`
  accumulates arithmetically), so the plain `readBits(36)` read is correct now.
✅ Coded sample numbers >= 2^31 overflowed. Fix: `readCodedNumber` combines bits with `+ bit * 2 ** index`
  instead of `|`/`<<`.
✅ `getFirstPacket` race corrupted the packet index. Fix: hold the demuxer's `readingMutex` while advancing the
  reader, like the other lookups do.
✅ `getPacket` returned the wrong packet due to float end times. Fix: compute the packet end as `(blockOffset +
  blockSize) / sampleRate`, exactly like the next packet's start timestamp.
✅ Muxer: PICTURE block lengths used UTF-16 length instead of UTF-8 bytes. Fix: encode the MIME type and
  description up front and use the byte lengths (the MIME type was also always written at offset 8).
✅ Muxer: minimum block size 0 for single-frame output. Fix: with a single block, min = max = that block's size,
  raised to at least 16 (RFC 9639 requires 16-65535; FFmpeg rejects smaller values).
✅ Muxer: metadata blocks > 16 MiB silently overflowed the 24-bit length (now throws). Fix: PICTURE and Vorbis
  comment blocks larger than `2 ** 24 - 1` bytes throw.
✅ Muxer: total sample counts >= 2^32 threw (now written). Fix: write all 36 bits with `writeBits(36, ...)`
  (possible thanks to the `Bitstream` fix), or 0 (unknown) if the count doesn't fit in 36 bits.
✅ `FlacOutputFormat` didn't validate `onFrame`. Fix: add the `typeof` check.

### WAVE ✅

✅ `getPacket(exact packet timestamp)` returned the previous packet. Fix: `roundIfAlmostInteger` on `timestamp *
  sampleRate` before computing the packet index.
✅ Unsized sources with an overstated data size (ffmpeg pipe output) dropped the tail. Fix: `getPacketAtIndex` caps
  `dataSize` to the actual data whenever the file size is known; when a read fails because the file is shorter
  (which reveals the file size), it retries with the capped size instead of returning null. `getPacket` likewise
  retries instead of doing a sequential scan from `lastKnownPacketIndex` (removed).
✅ The same case made `computeDuration()` fail with "Assertion failed.". Fix: same change; the removed
  sequential-scan path asserted that the file size was still unknown.
✅ The same case gave a phantom duration once the file size became known. Fix: same change (the `dataSize` cap).
✅ RF64: chunks after the data chunk (e.g. LIST INFO) were never found. Fix: skip the data chunk using the size
  from ds64 rather than the placeholder in the chunk header.
✅ The muxer didn't pad odd-sized data chunks. Fix: write a padding byte at finalize if the data size is odd.
✅ RIFF INFO year was parsed in local time (2013 became 2012-12-31 east of UTC). Fix: use `createUtcDate(year)`.

### MP3 ✅

✅ The Xing/Info frame count included the Xing frame itself (every output one frame too long). Fix: the muxer no
  longer increments `frameCount` for the Xing frame.
✅ VBRI headers were not recognized (VBRI frame emitted as audio, CBR duration estimate). Fix: for Layer III
  frames, check for a `VBRI` header (version 1) 32 bytes past the frame header; such a frame is treated like a
  Xing frame (skipped as audio) and its frame count and file size are used.
✅ Frame header parsing accepted the reserved MPEG version, causing false syncs. Fix: `readMp3FrameHeader` rejects
  MPEG version ID 1 (reserved), like FFmpeg.
✅ Frame header parsing accepted the reserved sample-rate index, causing false syncs. Fix: reject frequency index
  3 instead of mapping it with `% 3`.
✅ The written Xing frame claimed a CRC (protection bit 0) it didn't have (CRC mismatch in checking decoders). Fix:
  set the protection bit, meaning no CRC.
✅ Layer I/II output got a Xing frame, which decoders played as an extra audio frame. Fix: Mp3Muxer writes no
  Xing frame for Layers I and II, since Xing only exists for Layer III.
✅ Trailing ID3v1 and APEv2 tags counted toward the CBR duration estimate. Fix: subtract them (the APE tag with its
  header, if flagged) from the audio end before estimating.

### ADTS / AAC ✅

✅ Output with channel configuration 0 (a PCE, e.g. FFmpeg's default 5.1(side)) was undecodable; the PCE is now
  carried in the ADTS headers. Fix: the PCE is modeled as a parsed `AacProgramConfigElement` with a reader and a
  writer (`readAacProgramConfigElement`/`writeAacProgramConfigElement`); `parseAacAudioSpecificConfig` parses it,
  and `buildAdtsHeaderTemplate` writes it after an `ID_PCE` into every frame's header so decoding can start
  anywhere.
✅ ADTS with channel configuration 0 couldn't be read at all, not even our own output from the fix above (ADTS
  and MPEG-TS demuxers threw, and remuxing to MP4/MKV was impossible). Fix: `readAdtsFrameHeader` accepts
  configuration 0; `readAdtsProgramConfigElement` parses the PCE leading the raw data block, giving the demuxers
  the channel count. The MP4/MKV muxers' ADTS-to-raw conversion passes the parsed PCE to
  `buildAacAudioSpecificConfig`, like FFmpeg's aac_adtstoasc, and strips it from the packets.
✅ Channel configurations > 7 silently produced corrupt headers. **[behavior change]** They now throw. Fix: throw in
  `buildAdtsHeaderTemplate`.
✅ Object types outside 1-4 silently produced corrupt headers. **[behavior change]** They now throw. Fix: throw in
  `buildAdtsHeaderTemplate`.
✅ Sampling frequency index 15 (explicit rate, written by our own config builder for non-table rates) and the
  reserved indices 13/14 were written into ADTS headers. **[behavior change]** They now throw. Fix: throw in
  `buildAdtsHeaderTemplate`, as FFmpeg's adtsenc does.
✅ 960-sample AAC frames were written as ordinary 1024-sample ADTS. **[behavior change]** They now throw. Fix: same
  place, same FFmpeg rule.
✅ A rejected first packet left the muxer half-initialized (and finalize wrote an empty file). Fix: set
  `inputIsAdts` only after the header template was built successfully.
✅ The demuxer stopped at ID3v2 tags between frames. Fix: `advanceReader` loops; whenever no ADTS header is found,
  it tries to skip an ID3v2 tag at that position (not just at file start) and only ends the stream if there's none.
✅ A mid-file sample-rate change (concatenated files) made the demuxer's timestamps jump back. **[behavior
  change]** Fix: like MP3, the stream now ends where the sample rate changes, with a warning, since a track can
  only have one sample rate. MP3 got the same warning, and now also ends there instead of skipping to later
  frames that match the first rate again.
✅ Single-frame ADTS files weren't detected, since detection wants a second frame to confirm. Fix: a first frame
  ending exactly at the end of the file is accepted.

### ID3 and metadata ✅

✅ ID3v2.3 whole-tag unsynchronisation did nothing. Fix: `ununsynchronizeAll` compared the 0xFF byte with itself
  (`bytes[i]`) instead of the byte after it (`bytes[i + 1]`).
✅ ID3v2.2 whole-tag unsynchronisation was ignored. Fix: apply it for `majorVersion <= 3` instead of only 3.
✅ The iTunes non-synchsafe v2.4 frame size workaround was broken. Fix: `isSizeValid` measures the candidate size
  from the frame header's end (`headerEndPos`) instead of the moving `this.pos`.
✅ The v2.4 data length indicator wasn't skipped. Fix: skip its 4 bytes when the frame flag is set, before
  ununsynchronizing and reading the frame.
✅ Empty UTF-16 strings without BOM consumed 1 byte. Fix: a UTF-16 string starting with the 0x0000 terminator is
  read as empty, consuming both bytes.
✅ APIC MIME types were decoded with the frame encoding instead of ISO-8859-1. Fix: always read them as
  ISO-8859-1.
✅ **[behavior change]** COMM frames with a description (iTunNORM etc.) became `tags.comment`; now only
  description-less COMM frames do. Fix: only set `tags.comment` when the description is empty.
✅ TDAT was parsed as a full date (year 2304); TYER+TDAT are now combined. Fix: TYER/TYE and TDAT/TDA are collected
  during frame parsing; after the loop, the year is combined with a valid DDMM from TDAT via `createUtcDate`.
✅ Invalid TYER values stored an Invalid Date (a repo fixture failed conversion). Fix: the combined date is only
  stored if it's valid.
✅ ID3v1 years below 100 gave an Invalid Date. Fix: new `createUtcDate` helper (`setUTCFullYear` on a fresh Date),
  which takes years literally, instead of `new Date(String(year))`.
✅ TYER years below 100 were mapped to 19xx/20xx. Fix: same `createUtcDate`.
✅ TBPM "0" failed validation on conversion. Fix: only accept BPM values > 0.
✅ Writer: USLT frame size used string length instead of UTF-8 bytes. Fix: use the UTF-8 byte length unless the
  text is ISO-8859-1-compatible.
✅ Writer: cover art was duplicated on MP3 -> MP3 conversion. Fix: mark `APIC` as written after writing `images`,
  so the raw APIC frames aren't written again.
✅ `validateMetadataTags` didn't type-check image name/description. Fix: add the string checks.
✅ The v2.2 compression flag was treated as the extended header flag. Fix: a compressed v2.2 tag is skipped with
  a warning, since no compression scheme was ever defined for it.
✅ The footer flag was honored in v2.3 (0x10 is undefined there), skipping 10 bytes into the audio. Fix: only
  honor it for v2.4.
✅ The grouping identity byte wasn't skipped, so the frame was misread ("Unsupported text encoding", which lost
  all tags). Fix: skip it (v2.3 and v2.4) before the data length indicator.
✅ v2.2 `TXX` wasn't parsed like `TXXX`. Fix: parse both the same way, each under its own raw key.
✅ TDRC with a time was parsed as local time, and loose strings like "12" went through `new Date(string)`. Fix:
  TDRC is matched against the ISO 8601 subset ID3v2.4 allows (yyyy up to yyyy-MM-ddTHH:mm:ss) and read as UTC;
  out-of-range fields are rejected. (The other formats' date fields are still open, see "Not fixed", 1.)
✅ The synchsafe size workaround also ran on sizes with a byte >= 0x80, which can't be synchsafe (APIC was cut).
  Fix: such sizes are taken as plain integers.
✅ A v2.4 extended header size was read as a plain u32. Fix: decode it as synchsafe.
✅ A TDAT day past the end of its month (like 3102) rolled over into the next month. Fix: such a TDAT is ignored
  and only the year is used.
✅ Writer: the APIC frame size used the MIME type's string length instead of its UTF-8 byte length. Fix: use the
  byte length when the frame isn't ISO-8859-1.
✅ Test fix: the metadata round-trip tests compared `readTags.date` with itself; they now check the written date.

### HLS reading ✅

✅ Variants referencing undefined media groups lost their tracks. Fix: collect the media tags matching the group
  first; if there are none (rather than only if the attribute is absent), the track lies in the variant stream.
✅ `CHANNELS="16/JOC"` reported 16 channels. Fix: new `parseChannelCount` returns null when the attribute carries
  object coding identifiers (anything but `-` after the slash).
✅ `fLaC` in CODECS wasn't recognized. Fix: `inferCodecFromCodecString` maps `fLaC` to `flac`.
✅ A master playlist with only I-frame variants failed with "Assertion failed.". Fix: the reference track
  selection falls back to the key-packet-only tracks when there are no regular ones.
✅ `joinPaths`: protocol-relative URLs were resolved wrongly. Fix: a `//` path takes only the base URL's scheme.
✅ `joinPaths`: a `://` inside a query made relative URLs look absolute. Fix: a path is absolute only if it starts
  with a URI scheme (regex), which also covers `blob:`/`data:`; the relative path's query/fragment is split off
  before joining and normalizing and appended again afterwards.
✅ `joinPaths`: base URLs without a path lost the host. Fix: if the base's last slash is the one of `://`, append
  `/` + the relative path.
✅ `joinPaths`: excess `..` popped past the root. Fix: `..` doesn't pop the leading empty root segment.
✅ `joinPaths`: dot segments inside the query or fragment were normalized (`seg.ts?p=a/../b`). Fix: same query/
  fragment split as above; only the path is normalized (RFC 3986).
✅ `joinPaths`: scheme URIs without `//` (e.g. `data:` key URIs) were joined onto the base, and `dir/x://y.ts` was
  treated as absolute. Fix: absolute means starting with a scheme followed by `://`, or with `data:` or `blob:`.
  Other colons, like in `seg-12:00.ts`, keep a path relative.
✅ Sparse fMP4 segments with large timestamps shifted by a 2^33 wrap, since the video track's `getFirstTimestamp()`
  returned 0 for a segment without video samples. Fix: new `InputTrack.getFirstTimestampOrNull()`; the wrap
  correction still uses the video track as the reference, but falls back to the other tracks when it has no media
  in the segment. `getFirstSegmentTimestampOffset` and `getMediaOffsetForDiscontinuity` share the same lookup
  (`getReferenceFirstTimestamp`), and `Input.getFirstTimestamp()` now uses the new method too.
✅ Lookups before the first segment's playlist timestamp returned null (call-order dependent). Fix: packet lookups
  fall back to the first segment when `getSegmentAt` finds none, since the media may start before the first
  segment's playlist timestamp.
✅ EXT-X-MAP wiped pending EXTINF/BYTERANGE tags. Fix: remove the reset of `nextSegmentDuration`/byte range state
  from the EXT-X-MAP branch.
✅ Live reloads after the window slid past all known segments used a stale timeline. Fix: when continuing after
  the last known segment, the time of the segments that dropped out unseen is estimated as `(sequence number gap)
  * last duration` instead of one segment duration (for the Unix timestamps too).
✅ After a reload, new segments got the wrong first segment (missing init data). Fix: `currentFirstSegment =
  prevLastSegment.firstSegment ?? prevLastSegment`, since the first segment's `firstSegment` is null.
✅ A discontinuity within the segments that dropped out during a live gap left stale first-segment info (a 48 kHz
  period was timed with the 24 kHz one's offsets). Fix: the first-segment info is reset when the next segment's
  discontinuity number differs from it.
✅ Empty ended playlists waited one target duration per query. Fix: no reload once the stream has ended, and
  `getSegmentAt` honors `skipLiveWait`.

### HLS writing ✅

✅ Closing both tracks of a playlist at once threw an unhandled assertion. Fix: `onTrackClose` skips
  `advancePlaylist` if the other track's close already finished the playlist (`playlist.done`).
✅ VOD playlists had different TARGETDURATIONs. Fix: in VOD mode, media playlists are no longer written as each one
  ends but all together in `finalize()`, once the shared target duration is final.
✅ FORCED=YES was written on audio/video renditions. Fix: only write it for subtitle renditions.
✅ BANDWIDTH was double-counted when the variant's own playlist was a URI-less rendition. Fix: detect when the
  variant's playlist is among its referenced renditions (`ownPlaylistIsReferenced`) and then don't add its own
  bitrates on top of the renditions'.
✅ CODECS was duplicated in the same case. Fix: same detection; the referenced group's codec isn't added again.
✅ I-frame tracks were grouped as VIDEO renditions. Fix: key-packets-only tracks are kept out of the unpaired video
  group and get their own variant streams.
✅ CODECS used WebCodecs strings (`flac` -> `fLaC`, `mp3` -> `mp4a.40.34`). Fix: `toHlsCodecString` maps both.
✅ MP3 decoder configs given as `mp4a.69`/`mp4a.6B` were written to CODECS unmapped. Fix: map them to `mp4a.40.34`.
✅ No single segment format holding paired tracks caused an assertion (now split into renditions). Fix: a 1:1 pair
  only shares a playlist if `deduceSegmentFormat` finds a format for both (it now returns null instead of
  asserting); otherwise the other track is linked as a rendition group.
✅ `start()` leaked the mutex when it threw. Fix: `try`/`finally` release.
✅ Float noise could push TARGETDURATION one too high. Fix: round to 12 decimals before `Math.ceil`.
✅ Duplicate NAMEs within a group weren't made unique. Fix: append " (2)", " (3)", ... to repeated names.
  **[behavior change]** A second rendition named "Audio" is now written as "Audio (2)".
✅ The peak bitrate window was sized by the unrounded global target duration instead of the written integer one
  (BANDWIDTH 5266149 vs 1958671). Fix: `updatePlaylistBitrates` takes the target duration as written.
✅ Output format: NaN/Infinity target duration was accepted. Fix: check with `Number.isFinite`.
✅ Output format: a NaN live segment count was accepted. Fix: check with `isNumber` (which rejects NaN) instead of
  `typeof`.
✅ Reserve-mode MP4 segments failed, since their tracks lacked `maximumPacketCount`. Fix: the HLS muxer sets it to
  the segment's exact packet count when creating the segment's tracks, so `requiresMaximumPacketCount` stays false.
✅ Output format: WebVTT was listed as supported. Fix: remove subtitle codecs from `getSupportedCodecs()` (subtitles
  are currently disabled).
✅ Output format: the TrueHD unsupported-codec hint was wrong. Fix: no "use different segment formats" hint for
  audio codecs with delta packets, since no segment format helps there.

### Other muxers ✅

✅ ADTS, FLAC, MP3, Ogg and WAVE `start()` leaked the muxer mutex when they threw, so `finalize()` hung forever.
  Fix: `try`/`finally` release in each.
✅ MKV `onSegmentHeader` validation named the wrong option. Fix: the message now says `options.onSegmentHeader`.

### Input and InputTrack ✅

✅ A disposed Input threw an internal error instead of InputDisposedError. Fix: the `_rootSource` getter throws
  `InputDisposedError` once disposed; disposal also clears `_sourceCache`.
✅ Failed source requests were cached forever. Fix: remove the pending entry from `_sourceCachePromises` in a
  `finally`, so it's also dropped on failure and later requests retry.
✅ ISOBMFF files without an ftyp box were rejected by detection. Fix: a leading `moov` or `mdat` box is accepted
  (`skip` and `wide` boxes are walked over like `free`).
✅ Frame-rate detection missed CFR video with one tick of timestamp jitter (three repo fixtures now detect 60/60/24).
  Fix: `findUnderlyingFrameRate`'s outlier test allows an extra `multiple * periodUncertainty`, starting at one
  tick and shrinking to `1 / min(totalFrames, MAX_EFFECTIVE_FRAME_SPAN)` as the period is refined, since the
  period's error adds up for each frame a gap spans.
✅ Reserve-mode MP4 conversion threw for tracks whose packets all sit at a single instant, as the infinite packet
  rate made an invalid `maximumPacketCount`. Fix: Conversion uses the packet count for those, which the stats have
  fully counted. `computePacketStats` keeps going past `targetPacketCount` until the time span is positive, and
  rates without any packets or bytes are 0 instead of NaN.
✅ Source cache eviction was FIFO-ish instead of LRU. Fix: a cache hit gives the entry a fresh age from a counter
  instead of incrementing its age.
✅ `Input.computeDuration()` counted tracks without packets as ending at 0, so media lying entirely before zero
  next to an empty track reported a duration of 0. Fix: new `InputTrack.computeDurationOrNull()`; like
  `getFirstTimestamp()`, `Input.computeDuration()` now only counts tracks that have packets.
✅ A 64-bit ftyp size made detection read the brand from the size field (MOV detected as MP4). Fix: with size 1,
  the brand is read after the 64-bit size.
✅ `_getSourceUncached` didn't check disposal. Fix: already covered by the `_rootSource` disposal fix above; a test
  was added. Leftovers: the rejection can arrive up to one refresh interval late, and the HLS wait isn't
  interruptible.
✅ `InputTrack.id` wasn't unique in multi-segment Matroska files, since TrackNumber is only unique per segment.
  **[behavior change]** Fix: the ID is now the track's 1-based index in `getTracks()` for every format, instead
  of the container's own ID (TrackNumber, track_ID, PID, Ogg serial number). Backings no longer have `getId`.

### Sources ✅

✅ FilePathSource emitted no read events. Fix: forward the inner CustomSource's `read` events.
✅ FilePathSource leaked a file descriptor when disposed while opening. Fix: if the source was disposed by the time
  `open` resolves, close the handle and throw `InputDisposedError`.
✅ FilePathSource threw "Assertion failed." when disposed during stat. Fix: `_dispose()` marks the inner
  CustomSource as disposed, so its pending read throws `InputDisposedError` after `getSize` resolves.
✅ FilePathSource was never garbage-collected when never ref'd (the finalizer kept it alive), leaking its fd. Fix:
  the FinalizationRegistry holds the file handle itself instead of a cleanup closure that referenced the source.
✅ UrlSource dropped the headers of a Request passed as its URL. Fix: merge the Request's headers into
  `_requestInit.headers`, since headers passed to `fetch()` replace the request's own.
✅ UrlSource with a relative URL threw outside a window against a server without range support. Fix: the warning
  takes its origin from `response.url` (the server that actually answered, after redirects), falling back to the
  requested URL for synthetic responses.
✅ UrlSource error messages said `[object Request]`. Fix: use `this.rootPath` in the messages.
✅ CustomSource called `getSize` once per concurrent read (FilePathSource leaked a file descriptor for each extra
  call). Fix: concurrent reads share the pending call (`_pendingSize`).
✅ ReadableStreamSource disposed before reading never cancelled its stream. Fix: cancel the stream itself when no
  reader was created yet.
✅ A read straddling the end of an unsized source never settled. Fix: once the size is known, every pending slice
  that extends past it resolves to null; before, only slices starting at or past the end did.
✅ An in-bounds read returned null when its prefetch lay past the end. Fix: same rework; a queued read whose hole
  lies past the end no longer resolves all of its slices to null, only those that extend past the end.
✅ Queued reads stayed non-strict after the size became known (capped responses returned null). Fix: every
  remaining queued read gets `strictTarget = true` (and its hole capped), not just the ones crossing the end.
✅ In-bounds reads returned null when another worker hit the end. Fix: a worker hitting the end only resolves its
  pending slices that extend past its current position; the rest are still being filled by other workers.
✅ RangedSource never emitted read events. Fix: on `ref()`, subscribe to the base source's `read` events and
  re-emit the part overlapping the range, in range coordinates (unsubscribed on dispose).
✅ RangedSource reported its specified length as its size until the base's size was known, then changed it if
  the base was shorter. Fix: the specified length is always the size, and
  reads the base can't satisfy within it throw "Underlying data too short".
✅ UrlSource with a Range offset reported read events in resource coordinates. Fix: map them into source
  coordinates, clipped to the range.
✅ UrlSource never cancelled error responses' bodies, and an idle worker removed after an error kept its request
  running. Fix: cancel the body before throwing, and abort a removed worker's controller.
✅ UrlSource threw a 416 error for `bytes=0-` on an empty resource. Fix: a 416 whose `Content-Range: bytes */N`
  ends at or before the read position resolves the size to N.
✅ CustomPathedSource didn't forward its root's read events. Fix: subscribe once the root resolves, unsubscribe
  on dispose.
✅ CustomPathedSource skipped the bounds check on its first read (its size was unknown before the root resolved).
  Fix: reads past the root's size return null.
✅ CustomSource didn't cancel a stream from `read` that held more than needed. Fix: cancel the reader when done.

### Output, targets and writer ✅

✅ `cancel()` rejected and skipped closing targets after a failed source close. Fix: errors from the sources'
  forced close are swallowed in `cancel()`.
✅ `cancel()` rejected when a target stream had already errored. Fix: target close errors are swallowed in
  `cancel()` (see also the StreamTarget fix below).
✅ Targets obtained while cancel waited for start were never closed. Fix: a new `_targetsClosed` flag, set only
  right before the unfinalized targets are closed, replaces the `state === 'canceled'` check. Targets arriving
  while cancel waits are now remembered and closed along with the others, instead of being "closed" right away
  (a no-op for a never-started StreamTarget) and then used by the muxer.
✅ The `initTarget` result was unchecked. Fix: throw a TypeError if it isn't a `Target`.
✅ A target arriving after cancel cleanup was closed but still returned, so a late HLS segment was written into a
  closed target. Fix: `_getTarget` throws after closing it ("Output has been canceled.", or "Output has already
  been finalized." if a target somehow arrives after a successful finalization).
✅ The `target` getter left the rejected promise of an async root PathedTarget unhandled. Fix: attach a no-op
  handler before throwing the TypeError; the muxer still surfaces the rejection when it awaits the target.
✅ `getMimeType()` never settled after cancel. Fix: race the muxer's MIME type against a `_canceled` promise that
  rejects once the output is canceled.
✅ A discarded target close could become an unhandled rejection. Fix: `.catch(() => {})` on it.
✅ The track limit error said "trackss". Fix: drop the extra "s".
✅ AppendOnlyStreamTarget never emitted `finalized` (HLS `onInit` never fired for it). Fix: emit it after its
  inner StreamTarget finalized.
✅ **[behavior change]** Closing a StreamTarget that was never started did nothing (leaking FilePathTarget handles);
  it now closes the user's stream. Fix: `_close()` acquires a writer itself if there's none. Every target now
  tracks being closed (`Target._close()` sets `_closed` and calls the target's `_release()`), and creating a
  Writer for a closed target throws.
✅ StreamTarget close rejected on an already-errored stream. Fix: `_close()` only closes the writer when its
  `desiredSize` isn't null (errored).
✅ FilePathTarget kept its file handle open after a write failure. Fix: close the file handle in a `finally` in
  `_close()`, since an errored stream never closes it.
✅ Writer tracking used position 0 instead of the tracked start. Fix: `pos = this.trackedStart` when clipping a
  write that begins before the tracked region.

### Media sources (encoding) ✅

✅ `MediaSource.close()` didn't await `onTrackClose()` (unhandled rejection, finalize hang). Fix: await it (the
  base `Muxer.onTrackClose` is now async) and attach a no-op catch to `_closingPromise`, whose error surfaces at
  finalize/cancel.
✅ Custom video encoders were never closed after a failed call. Fix: the CallSerializer fix (see "Small core
  pieces") keeps the queued `close()` from being skipped; flush errors are routed to `setError`.
✅ Custom audio encoders were never closed after a failed call. Fix: same as for video.
✅ Video encoders created while cancel/close ran were never closed. Fix: `flushAndClose` first awaits a pending
  `ensureEncoderPromise`.
✅ Audio encoders created while cancel/close ran were never closed. Fix: same change in the audio wrapper.
✅ Muxer errors for video packets emitted during the final flush were lost. Fix: await `lastMuxerPromise` before
  the final `checkForEncoderError()`.
✅ Muxer errors for audio packets emitted during the final flush were lost. Fix: same change in the audio wrapper.
✅ Errors inside the WebCodecs VideoEncoder output callback were swallowed. Fix: wrap the color and alpha output
  callbacks in `try`/`catch` and route errors to `setError`.
✅ Errors inside the WebCodecs AudioEncoder output callback were swallowed. Fix: same `try`/`catch` -> `setError`.
✅ The key frame interval sentinel collided with negative timestamps. Fix: `lastMultipleOfKeyFrameInterval` uses
  `null` instead of -1 as "none yet".
✅ MediaStreamVideoTrackSource paused before its first frame asserted 250 times per second. Fix: the frame-rate
  timer bases timestamps on a new `firstReceivedFrameTimestamp`, which is also set when the first frame is dropped
  due to pausing.
✅ MediaStreamVideoTrackSource accepted NaN/Infinity frame rates (Infinity looped forever). Fix: validate with
  `Number.isFinite`.
✅ A `process` function returning its input sample closed the caller's sample. Fix: a processed sample that is the
  input sample itself is neither encoded with close-after nor closed afterwards.
✅ Encoding into an encoder that errored mid-add threw a misleading error and leaked the AudioData. Fix: call
  `checkForEncoderError()` before encoding, and close the AudioData in a `finally`.
✅ Adds that weren't awaited overlapped and corrupted the audio (MediaStreamAudioTrackSource duplicated audio, and
  unawaited `AudioSampleSource`/`AudioBufferSource` adds lost or interleaved samples): resampling, gap padding
  and PCM packetization all await partway through. Fix: `AudioEncoderWrapper.add` runs under an `addMutex`, while
  the add validation moved out of the wrappers into the sources' `add` methods (like the packet sources), so an
  add is judged by the moment it's made. `AudioBufferSource` has its own mutex around adding a buffer's chunks, so
  overlapping buffers don't interleave their chunks. A graceful close waits for the
  queued adds; one canceled while waiting drops its sample. Whether a MediaStream sample is dropped is still decided when it's captured.
  **[behavior change]** `getQueueSize()` counts the waiting adds, so MediaStreamAudioTrackSource drops samples
  under backpressure like the video source does.
✅ The MediaStreamAudioTrackSource AudioContext fallback was never closed. Fix: `close()` it instead of
  `suspend()`ing it on teardown (the error path only suspends a context that isn't closed).
✅ `sizeChangeBehavior` fill/contain/cover wasn't used as the default fit for frames of the original size. Fix:
  for those behaviors, `appliedFit` is set from `sizeChangeBehavior` for every frame, not just resized ones.
✅ Un-awaited video adds overlapped, e.g. padding the same frame slots twice with `transform.frameRate`. Fix: like
  audio, `VideoEncoderWrapper.add` runs under an `addMutex` (with validation in the sources' `add` methods), and
  the final frame rate padding at close waits for it. MediaStreamVideoTrackSource now drops frames arriving while
  shutting down, like the audio source, instead of failing the add. **[behavior change]** `getQueueSize()` counts the adds waiting on the mutex,
  so MediaStreamVideoTrackSource drops frames sooner under backpressure.
✅ Empty AudioSamples were turned into AudioData for the WebCodecs encoder, which forbids 0 frames (threw). Fix:
  `encodeSample` skips samples with 0 frames.

### Media sinks (decoding) ✅

✅ Decoders were never closed when `next()` threw while the pump waited on backpressure. Fix: the termination
  paths (disposal, out-of-band error) call `onQueueDequeue()`, waking the waiting pump so it can wind down.
✅ Custom decoders were never closed after a failure (plus an unhandled rejection). Fix: the CallSerializer fix
  (see "Small core pieces") keeps the queued `close()` from being skipped; close errors go to `onError`.
✅ In Chromium, the first AVC/HEVC packet lost its alpha side data (first GOP opaque): the Chromium-only
  first-packet workarounds rebuilt the packet without its side data. Fix: the workarounds (now
  `fixFirstPacketDataForChromium`) produce a `clone()` of the packet, which keeps its side data, and the alpha
  decoder's first packet gets the same workarounds applied to its alpha data.
✅ Alpha merging ignored backpressure (~1 GB in flight). Fix: the reported decode queue size includes the samples
  still waiting in `finalSamples`.
✅ Merged samples behind a failed merge were never closed. Fix: on a failed merge, close the already-merged samples
  queued behind it.
✅ Alpha-merged frames lost their color space and display size. Fix: the merger worker passes `displayWidth`,
  `displayHeight` and `colorSpace` of the color frame into the new VideoFrame.
✅ PCM sample timestamps drifted (samples duplicated at range boundaries). Fix: snap each timestamp to the sample
  grid (`roundToDivisor(t, sampleRate)`).
✅ PCM flush didn't reset its timestamp (`samplesAtTimestamps` returned null). Fix: `flush()` resets
  `currentTimestamp` to null.
✅ `flush()` kept stale input timestamps (shifted timestamps after a frameless chunk and a seek). Fix: clear
  `inputTimestamps` on flush.
✅ (#642) Hidden VP8/VP9 frames stored as packets of their own (VP8 alt-ref frames, VP9 from old FFmpeg) each took
  a timestamp meant for a shown frame, so frames got earlier and earlier timestamps (a Lavf56 VP9 file ended
  14 s early). Fix: a packet queues as many timestamps in `inputTimestamps` as it shows frames
  (`countShownVideoFrames`: VP8's `show_frame`, VP9's `show_frame`/`show_existing_frame`, counted per frame of a
  superframe).
✅ The sample iterators' `throw()` didn't clean up (decoder left open). Fix: `throw()` calls `return()` first,
  like a generator function.
✅ After `return()`, the decoder was only closed once the user's timestamp source yielded again. Fix: waiting for
  the next timestamp races against a termination promise.
✅ `canvases()`/`buffers()` leaked the decoder when the mapping threw. Fix: `mapAsyncGenerator` returns the source
  generator itself when `map` throws, since consumers don't call `return()` after a rejected `next()`.
✅ Tiny PCM packets produced zero-frame samples. Fix: the PCM decoder skips packets with 0 frames, like the
  regular decoder.

### Samples ✅

✅ VideoSample: odd-width subsampled formats lost the last chroma column. Fix: `Math.ceil` instead of `Math.floor`
  for `sourceWidthBytes` in `ComputeLayoutAndAllocationSize`.
✅ VideoSample: raw-buffer samples ignored the visible rect offset. Fix: `copyTo`'s default rect and
  `toVideoFrame()` now use the visible rect (as a `DOMRectInit`) instead of the full coded size, with the coded
  size taken as the smallest one containing the visible rect; plane heights are computed from the visible rect's
  bottom.
✅ VideoSample: RGB<->BGR conversion wrote outside the destination layout. Fix: the swap loop walks the computed
  layout row by row (offset, stride, row width) instead of the whole allocation.
✅ VideoSample: `drawWithFit` never clamped the crop. Fix: use the already-clamped `finalCrop` instead of
  `options.crop`.
✅ VideoSample: `drawWithFit` left the context transformed when it threw (poisoning later transforms). Fix: call
  `toCanvasImageSource()` before `context.save()`.
✅ VideoSample: the YUV->RGB copy leaked a temporary VideoFrame on failure. Fix: close it in a `finally`.
✅ VideoSample: `transform()` dropped encodeOptions (lost key frame requests). Fix: pass `encodeOptions` to the new
  sample.
✅ VideoSample: resource refcounts leaked on failed construction. Fix: take the resource reference only after all
  validation that can throw.
✅ VideoSample: a wrong layout plane count, an empty visible rect or a closed VideoFrame hit `assert()` (or failed
  later) instead of a TypeError. Fix: validate them in the constructor; `copyTo` rects without a size throw too.
✅ VideoSample: the resource branch of `toVideoFrame()` passed duration 0 instead of undefined like the other
  branches (consistency; no glitch observed). Fix: `microsecondDuration || undefined`.
✅ AudioSample: a bare SharedArrayBuffer was rejected. Fix: accept `SharedArrayBuffer` like `ArrayBuffer`.
✅ AudioSample: negative channel counts were accepted. Fix: check `numberOfChannels <= 0` instead of `=== 0`.
✅ AudioSample: resource refcounts leaked on failed construction. Fix: same as for VideoSample.
✅ AudioSample: empty samples couldn't be copied (encoders threw). Fix: `frameOffset` 0 is always in range, in both
  `allocationSize` and `copyTo`.

### Codecs, codec data, encode/decode ✅

✅ Interlaced AVC SPS reported half the height (1080i opened as 1920x536). Fix: coded height is `16 * (2 -
  frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1)`.
✅ HEVC SPS with inter-predicted short-term RPS was misparsed (wrong SAR/color). Fix: `use_delta_flag` is inferred
  as 1 when absent, and the set's `NumDeltaPocs` counts only the kept entries instead of copying the reference
  set's count.
✅ HEVC SPS with long-term reference pictures was misparsed (`lt_ref_pic_poc_lsb_sps` read as ue(v)). Fix: read it
  as `log2_max_pic_order_cnt_lsb_minus4 + 4` fixed bits.
✅ VP9 RGB key frames (profile 1/3) were parsed one bit off (wrong level). Fix: skip the reserved bit after the RGB
  color space in profiles 1 and 3.
✅ E-AC-3 `chan_loc` bits were read in reverse (7.1 reported as 7 channels). Fix: `getEac3ChannelCount` tests
  `1 << bit` instead of `1 << (8 - bit)`.
✅ E-AC-3 dependent substreams were ignored when building dec3 (7.1 muxed to MP4 claimed 5.1). Fix:
  `parseEac3SyncFrame` walks the dependent substream frames following the independent one, counting them into
  `numDepSub` and converting each one's `chanmap` into `chan_loc` bits.
✅ ProRes frames with the minimal 20-byte header had no color info. Fix: accept frame headers of 20 bytes instead
  of requiring 28.
✅ AV1 fallback codec strings used the VP9 level table (Chrome rejected them). Fix: use `AV1_LEVEL_TABLE`.
✅ AV1 level 5.3 had the wrong max picture size. Fix: 8912896 (same as 5.x) instead of 35651584.
✅ `canDecodeVideo`/`canDecodeAudio` cached results across different binary descriptions. Fix: the memo key
  serializes the description's bytes (ArrayBuffers/DataViews stringified to `{}`).
✅ `canEncodeVideo` leaked its probe encoder on Firefox. Fix: close the encoder in a `finally` unless it's already
  closed.
✅ `canDecode` returned a non-Promise for subtitle codecs. Fix: make it `async`.
✅ avcC extension fields were only handled for profiles 100/110/122/144 (an x264 yuv444p avcC lost its bytes).
  Fix: every profile except 66/77/88 has them, as in the current ISO/IEC 14496-15 and FFmpeg.
✅ hvcC put prefix and suffix SEI into one array marked complete. Fix: separate arrays per NAL unit type, with
  array_completeness 0 as the spec requires for non-parameter-set arrays.
✅ The inferred `max_dec_frame_buffering` ignored `max_num_ref_frames`. Fix: `min(max(MaxDpbFrames,
  max_num_ref_frames), 16)`. Caveat: an SPS with MaxDpbFrames 0 but reference frames now gets VUI injected.
✅ AVC profile 144 (and 134/135/138/139) was missing from the chroma_format list, misparsing the SPS. Fix: add
  them.
✅ AVC level 1b used level 1.1 limits. Fix: level_idc 11 with constraint_set3_flag in Baseline/Main/Extended
  uses level 1 limits.
✅ AV1 level selection ignored the maximum frame width and height (2100x64 got a level that can't hold 2100 px).
  Fix: `AV1_LEVEL_TABLE` gained `maxHSize`/`maxVSize`, checked in both codec string paths.
✅ A raw `METADATA_BLOCK_PICTURE` tag duplicated the image in FLAC -> FLAC output. Fix: the raw tag is skipped
  when the images are written separately anyway.

### Conversion ✅

✅ `execute()` stayed 'executing' after a startup failure (output never canceled). Fix: the startup part (duration
  computation, `output.start()`, starting the pumps) moved into the `try` whose `catch` cancels the conversion.
✅ Early cancel gave a generic error instead of ConversionCanceledError. Fix: errors caught after the conversion
  was canceled are no longer rethrown, so execution reaches the ConversionCanceledError path.
✅ Write failures caused unhandled rejections. Fix: `void this.cancel().catch(() => {})` in the error path.
✅ A failed finalize left the state 'done'. Fix: set the state to 'canceled' when `output.finalize()` throws.
✅ The state was 'done' before the output had finalized, so a second `execute()` resolved early. Fix: the state stays
  'executing' during finalization and only becomes 'done' afterwards; a cancel during finalization makes `execute()`
  throw ConversionCanceledError.
✅ The options callback's `n` didn't match `track.number` in 'primary' mode. Fix: pass `track.number` instead of
  separate per-type counters.
✅ Zero-duration frames inside the trim range were dropped when transcoding. Fix: a sample whose clamped start
  equals its clamped end is only skipped if its duration is positive.
✅ Trimmed TrueHD copies lost up to one GOP at the start. Fix: the 'expand' boundary policy only skips a start
  packet wholly before the trim start if the track has only key packets, since a delta-packet group may still
  reach past the start.
✅ Tracks were discarded instead of falling back to PCM. Fix: when the retry with fallback channel count/sample rate
  finds no non-PCM codec either, `outputCodec` now falls back to the first encodable codec (PCM) instead of staying
  null.
✅ Progress was reported as NaN when the total duration was 0. Fix: report 0 progress in that case.
✅ A requested codec the output format can't hold gave the message "any of the codecs  with" (empty list). Fix:
  such codecs get their own message ("the output format cannot contain the requested codecs ...").
✅ Silence padding used the metadata channel count and sample rate (implicitly signaled HE-AAC starting late threw
  when converted to WAV). Fix: take them from the decoded sample.

### Small core pieces ✅

✅ Bitstream reads of 32+ bits overflowed. Fix: accumulate with `2 * result + bit` instead of shifts.
✅ Bitstream writes of 32+ bits (and bit 31 at unaligned offsets) were wrong. Fix: extract each bit as
  `Math.floor(value / 2 ** k) & 1` instead of with 32-bit masks.
✅ `setInt64` big-endian wrote little-endian halves. Fix: pass `false` (big-endian) to both 32-bit writes.
✅ EventEmitter: a `once` listener re-registered during an emit looped forever. Fix: `emit` iterates over a
  snapshot of the listeners (skipping ones removed meanwhile).
✅ EventEmitter: re-entrant emits called `once` listeners twice. Fix: remove a `once` listener before calling it.
✅ CallSerializer stayed rejected after one failure, skipping every later call (including `close()`). Fix: the
  chain continues from `result.catch(() => {})`; the caller still gets the rejected `result`.
✅ The AES-128 decrypt stream leaked the HLS ciphertext reference on error. Fix: `pull` closes in a `catch` too
  (errored streams never call `cancel`), with a `closeOnce` guard making closing idempotent.
✅ `EncodedPacket.clone({ data })` kept the old byteLength. Fix: use `options.data.byteLength` when data is given.
✅ WebVTT: a payload-less cue at the end of the text took the whole text as its payload. Fix: if there's no newline
  after the timing line, the body starts at the end of the text (`indexOf` returned -1 -> 0 before).
✅ WebVTT: hours above 99 dropped the cue. Fix: the timestamp regexes accept `\d{2,}` hours.
✅ WebVTT: a leading BOM threw. Fix: strip a leading U+FEFF before checking the preamble.

### AC-3 / E-AC-3 extension ✅

✅ The decoder read only one frame per packet, so E-AC-3 MP4s with several syncframes per sample failed. Fix: the
  bridge's `decode_packet` was split into `send_decode_packet` and `receive_decoded_frame`; the worker receives
  frames in a loop until none are left and returns them all as chunks. Frames after the first come without PTS
  and continue from the previous frame's end.
✅ Decoder flush dropped the remaining frames. Fix: flushing sends a NULL packet (`send_decode_flush`), receives
  and returns the remaining frames as samples, and only then resets the decoder.
✅ Decoder timestamps were scaled by the decoded rate instead of the track rate. Fix: divide the PTS by
  `this.config.sampleRate`.
✅ The encoder lost the last 256 samples at flush. Fix: flush keeps encoding silence-padded frames until the
  encoder's output (`encodedEndTimestampInSamples`, tracked from the packets' pts + duration) covers all input,
  since the output lags behind the input.
✅ The encoder encoded 3 channels as 2.1 (the third channel was coded as band-limited LFE and lost). Fix: new
  `set_ac3_channel_layout` in the bridge with explicit layouts (3 -> surround) instead of
  `av_channel_layout_default`.
✅ The encoder encoded 4 channels as 4.0 instead of quad. Fix: same mapping (4 -> quad).
✅ `supports()` claimed 7/8 channels, which fail at init. Fix: cap at 6 channels.
✅ `supports()` claimed reduced E-AC-3 sample rates, which fail at init. Fix: only `AC3_SAMPLE_RATES` for both
  codecs.
✅ `supports()` claimed E-AC-3 bitrates FFmpeg rejects at init. Fix: limit E-AC-3 bitrates to what six-block and
  single-block syncframes can hold (AC-3 bitrates are snapped by FFmpeg, so they stay unchecked).
✅ The encoder's per-frame `copyWithin` was quadratic for one huge sample (perf; no test). Fix: same as in the AAC
  encoder below.
✅ The decoder used `frame->data` instead of `extended_data` above 8 channels (no test: no sample available). Fix:
  use `frame->extended_data`.

### DTS extension ✅

✅ Decoder timestamps were scaled by the decoded rate instead of the track rate. Fix: divide the PTS by
  `this.config.sampleRate`.
✅ The encoder ignored its 512-sample codec delay (late audio, lost tail). **[behavior change]** The first DTS
  packet now starts 512 samples before the input, like AAC/AC-3. Fix: input timestamps are shifted back by
  `CODEC_DELAY` (512), and flush pads with enough silence to push the remaining samples through the delay, encoding
  frames until nothing is pending.
✅ The decoder used `frame->data` instead of `extended_data` above 8 channels; DTS:X decodes to 12 (no test: no
  sample available). Fix: use `frame->extended_data`.
✅ The encoder's per-frame `copyWithin` was quadratic for one huge sample (perf; no test). Fix: same as in the AAC
  and AC-3 encoders: frames are encoded from an offset, and the remainder is shifted once per `encode()`.

### TrueHD extension ✅

✅ Streams shorter than 16 access units produced unmuxable output (now padded to 16 AUs with silence). Fix: the
  encoder counts received frames and, on flush, pads with silence up to `MAJOR_SYNC_INTERVAL` (16) access units,
  since FFmpeg's encoder writes no major sync at all for shorter streams.
✅ Decoder timestamps were scaled by the decoded rate instead of the track rate. Fix: divide the PTS by
  `this.config.sampleRate`.
✅ Access units after the first in a multi-AU packet came out with AV_NOPTS_VALUE timestamps. Fix: the worker
  maps NOPTS to null, and such samples continue from the previous sample's end.

### AAC encoder extension ✅

✅ Closing during worker creation leaked the worker. Fix: `init()` stores its work as `initPromise`, and `close()`
  awaits it (ignoring errors) before terminating the worker.
✅ Closing during encoder initialization hung forever. Fix: same change; the init request to the worker now
  settles before the worker is terminated.
✅ 3 channels were encoded as 2.1 (third channel lost). Fix: new `set_aac_channel_layout` in the bridge with
  explicit layouts (3 -> surround) instead of `av_channel_layout_default`.
✅ 7 channels were encoded as 6.1 with a PCE (channel configuration 0), which QuickTime silently drops. (An
  earlier claim that FFmpeg decodes it permuted did not hold up in verification.) **[behavior change]** 7- and
  8-channel AAC now use channel configurations 11/12, which can't go into ADTS/MPEG-TS; `supports()` rejects ADTS
  for them. Fix: the same mapping uses 6.1(back) for 7 and 7.1 for 8 channels; `supports()` returns false for
  ADTS with >= 7 channels.
✅ The encoder couldn't be reused after a flush (stayed at EOF). Fix: `reset_encoder` replaces the drained codec
  context with a freshly opened one (`avcodec_flush_buffers` does nothing for AAC); failures are reported.
✅ Shifting the pending buffer with `copyWithin` after every frame was quadratic for one huge sample (perf; no
  test). Fix: all full frames are encoded from their offsets in the buffer, and the remainder is shifted to the
  front once at the end.

### FLAC encoder extension ✅

✅ Closing during worker creation leaked the worker. Fix: same `initPromise` approach as the AAC encoder.
✅ The encoder couldn't be reused after a flush (libFLAC reset its config). Fix: new `init_stream` re-applies the
  whole configuration (channels, sample rate, bit depth, compression level, verify) before every (re)init.

### MP3 encoder extension ✅

✅ Packet timestamps drifted for large start timestamps (float accumulation). Fix: track the next timestamp as an
  integer sample count (`nextTimestampInSamples`) and derive each packet's timestamp from it.
✅ LAME's negative return codes and failed `_malloc` calls were unchecked (garbage output). Fix: the worker throws
  on negative encode/flush results and on a null `_malloc` result. No test: a repro needs ~4 GB samples.

### ProRes extension ✅

✅ Pixel aspect ratio set only in the container was ignored (Apple writes PAR only in `pasp`). Fix: if the decoder
  config has `displayAspectWidth`/`Height`, derive the pixel aspect ratio from it, overriding the bitstream's.
✅ Color space set only in the container was ignored. Fix: the decoder config's color space fields take precedence
  over the in-band values, like with WebCodecs.
✅ WebKit height trimming corrupted the alpha plane. Fix: the alpha plane is moved to its trimmed position as
  well, like the Y/U/V planes.
✅ `flush()` resolved before the last samples were emitted. Fix: await the last `runDecode` promise instead of the
  decoder's queue draining.

### Server extension (`@mediabunny/server`) ✅

✅ Audio frames ignored the time base numerator. Fix: timestamp is `pts * timeBase.num / timeBase.den`.
✅ Planar audio with more than 8 channels segfaulted. Fix: read and write planes through `frame.extendedData`
  instead of `frame.data`, which only holds 8.
✅ `transform` dropped encodeOptions. Fix: pass `encodeOptions` to the transformed sample.
✅ `transform` emptied the source AVFrame. Fix: add the frame to the filter graph with
  `AV_BUFFERSRC_FLAG_KEEP_REF`.
✅ `transform` dropped the color matrix and range. Fix: pass `colorspace` and `range` in the buffer source args.
✅ `transform` leaked a source frame when copying failed. Fix: the copy into the owned source frame moved inside the
  `try` whose `finally` frees it.
✅ An unknown SAR (0/1) threw. Fix: treat a SAR numerator of 0 as square pixels.
✅ I420AP12 samples failed to convert. Fix: widen them to `YUVA420P16LE`, scaling the 12-bit values to 16 bits.
✅ libx265 dropped forced key frames requested within x265's minimum key frame interval (keys at 0/2/4/40/43 gave
  only 0 and 40). Fix: set the `forced-idr` codec option, as the nvenc paths already do.
✅ VP8 with alpha failed to open. Fix: set `auto-alt-ref=0` when alpha is kept.
✅ ProRes 4444 was encoded 4:2:2. Fix: use `YUV444P10LE` for `ap4h`/`ap4x` when the encoder supports it.
✅ Precise timestamps were lost after a flush. Fix: clear the stale `preciseTimings` at the end of `flush()`.
✅ The video decoder kept its precise timings across a flush, so after seeking back the old entries evicted the
  new ones. Fix: clear `preciseTimings` in the decoder's `flush()` too.
✅ Strict compliance was set for all video decoders (libdav1d rejected an AV1 stream with a trailing byte that
  browsers decode). Fix: only set it for AVC, where it's needed for the inferred reorder buffering.
✅ `supports()` claimed AAC/Opus/E-AC-3/Vorbis channel and rate combinations that fail at open. Fix: AAC is limited
  to 1-6 and 8 channels, Opus to <= 8, E-AC-3 to <= 6, Vorbis to <= 8 channels and <= 50 kHz.
✅ `supports()` claimed AAC ADTS with 4/8 channels, which writes bad headers. Fix: ADTS with 8 channels (channel
  configuration 12) is rejected; 4 channels now work since the ADTS headers carry the PCE (see ADTS / AAC).
✅ 3/5-channel AAC/AC-3 used unspecified channel layouts. Fix: open AAC/AC-3/E-AC-3 with explicit surround (3) and
  5.0(back) (5) layouts.
✅ Vorbis channels 9+ were silent. Fix: `supports()` caps Vorbis at 8 channels, since NodeAV's resampler only
  passes on 8 planes.
✅ TrueHD 3/4 channels were remixed (not lossless). Fix: input with the encoder's channel count takes on the
  encoder's layout in the resampler instead of being remixed from `getChannelLayout`'s.
✅ DTS had an unsignaled 512-sample delay. Fix: shift DTS packet timestamps back by `DTS_ENCODER_DELAY` (512).
✅ AC-3/E-AC-3/DTS lost their tail at flush. Fix: at flush, inject the encoder's held-back amount of silence (256
  or 512 samples) into the resampler to push the remaining audio out.

## Not fixed (for you to look over)

Everything the agents flagged but didn't fix, sorted by why it wasn't fixed. Each item ends with the reason.

### 1. Design decisions and unclear behavior (need your call)

The current behavior is arguably intended, or fixing it means picking between valid options.

✅ Date tags (all formats) are written from the UTC date, so a local-midnight `Date` becomes the previous day east
  of UTC. UTC vs local calendar date is a convention choice.
✅ Matrix coefficient 0 is reported as `'rgb'` (H.273: identity/GBR), but ProRes (RDD 36) defines 0 as "unknown",
  so ProRes files tagged unknown are treated as GBR (verified). Fix: the ProRes branch of `extractColorSpace` maps
  a matrix of 0 to undefined.
✅ AAC codec string validation follows the WebCodecs registration, so AAC-LD/ELD files (e.g. from AudioToolbox)
  fail conversion (verified). Accepting any `mp4a.40.x` would also need ADTS/MPEG-TS guards.
✅ HLS RESOLUTION treats `displayAspectWidth/Height` as pixel sizes (1920x1080 with 16:9 gives `16x9`, reproduced).
  WebCodecs defines them as a ratio, but Chrome's encoder and Mediabunny's demuxers put pixel sizes there. Fix:
  RESOLUTION stretches one side of the coded size by the display aspect ratio, like the demuxers derive square pixel
  sizes.
✅ HLS I-frame playlists put several I-frames per segment (RFC 8216: one each); the alternative is many tiny files.
  Fix: I-frame playlists cut a segment at every key frame. The docs point to single-file segments to avoid the
  many files.
✅ HLS CODECS lists only the first rendition's codec, but should list the union of all codecs in a group (RFC 8216
  4.3.4.1.1). Writing the union would make Mediabunny's own HLS reader throw (hls-demuxer.ts rejects several
  codecs per type), so writer and reader must change together. Fix: the writer lists the codecs of every rendition
  in the referenced group, deduplicated. The reader no longer rejects several codecs per type: if they all infer to
  the same codec, every track gets it without reading media (the full codec string then comes from the media on
  request); only if they're different codecs does it read each rendition's media for its codec, which must then
  hold exactly one track of the type. The same goes for a variant without renditions.
✅ HLS: PDT first appearing in a live reload rewrites segments in use (reproduced: the timeline jumps to ~1.7e9,
  `getPacket` returns the wrong packet, `isRelativeToUnixEpoch` flips). Keep the old timeline or switch to PDT?
  Fix: a reload keeps a timeline that isn't date-time-based; date-times then only add the Unix time mapping. The
  backward extrapolation also measures from the running time, so it accounts for segments that dropped out unseen.
✅ HLS live TARGETDURATION can be smaller than segments cut at key frames (an existing test writes EXTINF:3 under
  TARGETDURATION:2, against RFC 8216). Options: grow it like FFmpeg, force cuts, or require GOPs to fit.
✅ `mediaSamplesAtTimestamps` deadlocks a consumer that yields one timestamp and waits for its sample (reproduced
  with WAV). The held-sample logic (9946bf65) would need an early-emit rule.
✅ `cancel()` during finalizing is a no-op; the code comment says intended, the doc says cancel releases resources.
  Fix: finalizing releases the resources too, so `cancel()` during it now resolves once finalization has settled,
  as its doc promises.
✅ `MediaSource.add()` after `close()` started isn't rejected; rejecting would break MediaStream sources' late adds.
  Fix: the MediaStream sources drop their late frames themselves by now, so `_ensureValidAdd` checks
  `_closingPromise` instead of `_closed`, rejecting adds as soon as `close()` was called.
✅ Input: disposing an Input whose Source is shared doesn't cancel the Input's in-flight operations (reproduced).
  Should disposal abort reads on a source others still use?
✅ `hasHighDynamicRange()` returns true for wide-gamut metadata with an SDR transfer. Possibly intended. Fix: only
  a PQ or HLG transfer counts as HDR.
✅ `computeFrameRateMetrics` with fewer than 2 timestamps reports constant with no underlying rate. Deliberate.
✅ WAVE `getDurationFromMetadata` on unsized sources returns the header's claim until packets are read. Fix: an
  all-ones data size (0xFFFFFFFF, or an RF64 size past what a JS number holds) is a placeholder, so the metadata
  duration is null until the actual data size is known.
✅ WAVE INFO strings are read as Latin-1, but FFmpeg writes UTF-8 (verified mojibake). The writer deliberately
  doesn't support Unicode. Fix: INFO strings are decoded as UTF-8 when they're valid UTF-8, and as Latin-1 (the
  spec's default without a CSET chunk) otherwise.
✅ WAVE output has no `fact` chunk for non-PCM formats. Files play; changing it changes the `onHeader` data. Fix:
  float, A-law and mu-law get a `fact` chunk whose sample count is filled in at finalization (capped at 32 bits, as
  RF64 keeps the full count in ds64). Append-only output leaves it out, since it could never be filled in.
✅ WAVE output has no WAVE_FORMAT_EXTENSIBLE for > 2 channels or > 16 bits. Fix: more than two channels, or integer
  PCM above 16 bits, now use WAVE_FORMAT_EXTENSIBLE with the usual channel mask for the channel count (up to 7.1,
  otherwise none). Float only uses it for its channels, since its format tag already implies the bit depth.
✅ WAVE files with zero-size placeholders (unfinalized, including Mediabunny's own) can't be read; the RIFF-size
  bound is original design. Fix: a RIFF size of 0 (or a ds64 RIFF size of 0 in RF64) marks the file as unfinalized,
  so the file size bounds the chunks instead, and a data size of 0 then means the data goes until the end of the
  file. A data size of 0 in a finalized file still means empty.
✅ ID3: COMM/USLT with a text encoding > 3 silently give undefined, while text frames with one throw and lose the
  whole tag (reproduced). Throw, or skip just the frame? Fix: COMM/USLT read their encoding with
  `readId3V2TextEncoding()` too, so they throw like the text frames.
✅ Full-date fields other than TDRC (Vorbis DATE, MP4 date, MKV DATE, RIFF ICRD/IDIT) still go through
  `new Date(string)`, so short strings hit V8's legacy parsing (TDRC is fixed). These fields are free-form in the
  wild, so a strict parser would drop real dates; which formats to accept is a choice. Fix: a shared
  `parseIsoSuffix` (any prefix of yyyy-MM-ddTHH:mm:ss.sss plus an optional time zone, UTC without one) parses all of
  them, TDRC included. Anything else gives no date, with the string still in `raw`. IDIT is no longer read.
✅ MP3: the Xing/Info frame bitrate differs from the stream bitrate in CBR files (reproduced). No Layer III player
  misbehaves (Layer II, where mpg123 played 20.18 s instead of 5 s, no longer gets a Xing frame), and the code
  comment calls the choice deliberate. Fix: the Xing/Info frame takes the first audio frame's bitrate, going higher
  only if its data doesn't fit, so CBR files state one bitrate throughout.
✅ MP3: Layer I/II streams are labelled `'mp3'` (reproduced); distinguishing them needs new codec identifiers.
✅ MP3: a mid-stream Layer III frame that looks like a VBRI header is dropped as a header frame (reproduced). The
  Xing/VBRI check deliberately runs on every frame.
✅ Ogg: chained links reusing a serial number cross into the next link. Reproduced with `cat b.opus a.opus` (a 1 s
  link, then a 3 s link, both serial 0): `computeDuration` gives 3 instead of 1, and `getPacket(0)` returns a packet
  of the second link. Sequential reading is fine. RFC 3533 forbids such files; support them or not?
✅ The MPEG-TS muxer writes no PCR and writes PAT/PMT only once (strict analyzers flag it).
✅ The MPEG-TS muxer assigns PIDs by first-packet order, so in HLS the audio PID can change between segments. Fix:
  PIDs, PES stream IDs and the PMT order follow the track order, which the HLS muxer keeps the same for every segment.
✅ Matroska Language is ISO 639-2/B, but `languageCode` is documented as /T and the muxer writes /T.
✅ Matroska multi-segment files give duplicate track IDs; needs an ID scheme. Already fixed: `InputTrack.id` is now
  the track's 1-based index in `getTracks()` for every format.
✅ WebVTT in WebM is written as `S_TEXT/WEBVTT`; WebM and FFmpeg expect `D_WEBVTT/*`. Fix: WebM output writes
  `D_WEBVTT/SUBTITLES` with the identifier and settings in front of the cue text (no BlockAdditions, so notes are
  dropped); Matroska output keeps `S_TEXT/WEBVTT`.
✅ Matroska StereoMode side-by-side is ignored for the aspect ratio (reproduced). FFmpeg halves the width on write
  and doubles it on read; follow that convention or not? Fix: on read, a given DisplayWidth is doubled for side by
  side and column interleaved (StereoMode 1, 8, 9, 11), and a given DisplayHeight for top-bottom and row
  interleaved (2, 3, 6, 7). Without a display size, nothing changes.
✅ Matroska Segment Duration is negative when all timestamps are negative (reproduced). Write the span, a Void, or
  0? Fix: the end timestamp clamped to 0, as FFmpeg writes it.
✅ Matroska AV1: the av1C CodecPrivate now feeds the codec info, but the decoder still gets no sequence header
  (reproduced). Pass av1C as the decoder description?
✅ ISOBMFF: PCM silence padding counts toward `maximumPacketCount` in reserve mode (reproduced). Reserve more
  space, or document it? Documented instead: the `maximumPacketCount` doc says gaps in audio may add a packet each,
  depending on the format, since packets there mean the muxer's own packetization.
✅ FFmpeg uses the QuickTime v2 sound description for MOV with more than 2 channels and for E-AC-3; Mediabunny
  uses v1. AVFoundation still accepted a 6-channel E-AC-3 v1 MOV, so no failure was observed. Fix: MOV now uses
  version 2 for more than 2 channels too (multichannel linear PCM then becomes `lpcm`); E-AC-3 left as is.
✅ Mp3Muxer writes no LAME delay when the first packet timestamp is positive (Conversion pads to 0; may be intended).
✅ MP3 remux doesn't carry over the encoder padding, so players play it (1.0 s -> 1.0198 s).
✅ `Quality` accepts inherited keys (`'toString'`) and +-Infinity. Fix: quality levels are checked as own keys of
  `QUALITY_LEVELS`; +-Infinity stays allowed, as intended.
✅ `canEncodeAudio` with a quantizer-only Quality throws instead of returning false (may be intended).
✅ DTS: Quality `'very-low'`/`'low'` aren't encodable at stereo/5.1, since their bitrates fall below what
  `supports()` allows (reproduced). Clamp the Quality's bitrate, or report it as unsupported? Fix: the DTS extension
  and the server extension no longer reject such bitrates in `supports()`, but clamp them to the range the DTS
  encoder accepts^ (`clampDtsBitrate` in shared/dts-misc.ts), so they encode at the lowest bitrate possible.
✅ FLAC encoder extension: float input is floored to 24 bits instead of rounded. FFmpeg does the same, so changing
  it is a choice. Fix: rounded, like Mediabunny's own sample conversions. The DTS and TrueHD bridges truncated their
  float-to-s32 conversion too (and computed it in float, overflowing at full scale); DTS now rounds to 32 bits, and
  TrueHD to the 24 bits FFmpeg's encoder keeps. All three WASM builds were redone and their README hashes updated.
✅ `VideoTransformOptions.alpha` is never read (the code uses `config.alpha`) and isn't validated. Fix: the transform
  now uses `config.transform.alpha` (validated, `'discard'` alone also triggers the transform), separately from the
  encoder's `config.alpha`. The server's `transformVideoSample` ignored the alpha option too; it now premultiplies
  and drops the alpha plane, painting onto black like the browser path.
✅ `transform({ alpha: 'discard' })` keeps an alpha pixel format with opaque pixels.
✅ UrlSource child requests (HLS) inherit the root's Range header but not a Request's headers. Fix: a Request's
  RequestInit fields (headers, credentials, mode, cache and so on) are merged into the source's requestInit, and
  children get that requestInit, with the Range header already stripped.
✅ `getQueryParameter` doesn't decode `+` as a space and treats `?` after `#` as a query (HLS spec ambiguous). Fix:
  only the part before the fragment is searched for a query (like `joinPaths`), which is then read with
  `URLSearchParams`, decoding `+` as a space and malformed escapes leniently.
✅ `getUnixTimeForTimestamp` waits for a timestamp past the live edge (no `skipLiveWait`). Fix: it always skips the
  live wait, since extrapolating from the last known segment is just as precise.
✅ The AAC encoder's 4-channel layout is 4.0 (L R C BC), not Mediabunny's quad convention; AAC has no PCE-free quad.
  Fix: 4 channels are encoded as quad with a PCE, and ADTS is no longer supported for them.
✅ Server: VP8 alpha decodes opaque (docs only promise VP9/ProRes transparency).
✅ Server: the Vorbis bitrate doesn't scale with channel count (6 ch at 48 kHz needs >= 96k).
  Fix: `Quality` now scales Opus and Vorbis bitrates by `numberOfChannels / 2`. AAC stays unscaled, as Chrome on
  Windows only accepts 96k, 128k, 160k and 192k.
✅ Server: a mid-stream x264 switch to lossless (qp 0) changes the SPS profile without a new decoder config
  (reproduced: decoding in avc mode fails at packet 5). Emit a new decoder config, or force a fixed profile?
  Fix: x264 gets qp 1 for a quantizer of 0, so it never goes lossless.
✅ Missing feature: BW64 WAVE.
✅ Missing feature: 12/20-bit WAVE PCM.
✅ Missing feature: reading ADTS frames with multiple raw data blocks.
✅ Missing feature: ADTS resync over junk.
✅ Missing feature: MP3 in MOV via the `.mp3` sample entry (currently written as mp4a, which AVFoundation decodes
  as AAC and fails).
  Fix: MOV output writes MP3 with a `.mp3` sample entry and no esds, like FFmpeg, and the demuxer reads `.mp3`.
✅ Missing feature: EXT-X-I-FRAMES-ONLY in directly loaded media playlists.
  Fix: the media playlist parser reads the tag, and the playlist's tracks then report `hasOnlyKeyPackets()` as true.
✅ Matroska ProjectionPoseYaw/Pitch of 90 deg scale an axis by cos(90 deg) = 0, giving a degenerate matrix.
  Reproduced, but this is how degenerate matrices round-trip through MKV (the existing test "Matroska, degenerate
  matrix" relies on it), so a repro agent's change that ignored quarter turns was reverted. RFC 9559 limits pitch to
  -90..90 and FFmpeg ignores nonzero pitch, so whether to keep this encoding is your call.

### 2. Reproduced, left unfixed because the fix is invasive

✅ FLAC files concatenated with `ffmpeg -f concat -c copy` stop at the first join (10 of 20 packets). The strict
  frame-number check (#194) prevents false syncs; relaxing it needs CRC-16-based acceptance.
✅ FFmpeg's m2ts mode declares AAC as stream_type 0x06 without a descriptor, so the AAC track disappears. Needs
  payload probing for private streams.
✅ ISOBMFF fragments with `omit_tfhd_offset` and a non-A/V track first read video from the moof start. Needs
  sizing the ignored track's truns.
  Fix: the per-traf state moved from the track onto the demuxer, so every traf gets one and every trun is read,
  advancing the implicit base data offset; only tracks we care about store samples.
✅ MP3 detection only tries the first sync candidate (~25% of mid-frame cuts undetected, measured before the
  reserved-header fix). Detection and demuxer both need a shared validated-first-frame search.
  Fix: `readConfirmedMp3FrameHeader` / `readConfirmedAdtsFrameHeader` take the first frame in a window that's
  followed by a matching frame or ends the stream. Detection and each demuxer's first frame search 4096 bytes past
  any ID3v2 tags; when the next frame doesn't follow the previous one, the demuxers resync the same way over 65536
  bytes, matching the stream's parameters. Since this made MP3 claim MPEG-TS files with small MP3 frames,
  `_canReadInput` became `_getMatchPosition`, returning where the format's data starts; the earliest match wins,
  ties go to list order.
✅ Frameless decoder chunks other than hidden VP8/VP9 frames still shift every later timestamp in that decode
  session: AV1 temporal units without a shown frame, HEVC pictures with `pic_output_flag = 0`, and interlaced
  AVC field pairs stored as two packets.
✅ Matroska clusters without BlockDuration/DefaultDuration give the last block per track duration 0 (FFmpeg FLAC
  MKA: 2.926 s vs 3.0). FFmpeg uses codec parsers for this.
✅ Server: multi-frame packets give later frames garbage timestamps (concatenated packets); rare in the wild.
✅ TextDecoder polyfill: one UTF-16 malformed-input case differs from native (found by fuzzing; only where no
  native TextDecoder exists).
  Fix: an unpaired lead surrogate followed by a dangling odd byte now gives one U+FFFD, like native, not two.
✅ Ogg: in a truncated file, a Vorbis packet rewound to still has no previous blocksize for its duration (the VLC
  empty-packet variant is fixed). Needs reading the pages before `lowerPage`.
✅ Read orchestrator: a non-strict worker never becomes strict, so a capped response resolves an in-bounds read to
  null (reproduced). Needs a per-worker "must reach" position.
  Fix: a response ending early no longer tells `UrlSource` anything about the resource's end; it's followed up with
  a new request, and only an empty response at a speculative position (or an encoded one, which can't be continued)
  ends the resource. A 416 without a stated size ends it too when the worker read its way up to that position.

### 3. Not reproduced: tried, but not reachable with the current code

The code is wrong, but no current caller or realistic input hits it.

✅ MPEG-TS muxer: the audio PES length clamp (needs a > 65527-byte audio frame).
  Fix: audio PES packets too large for the length field are written as unbounded instead.
✅ MPEG-TS muxer: if reordering first appears (or grows) in a later GOP, `reorderDelay` grows there and DTS can
  repeat at that boundary.
  Fix: each DTS is clamped to at least the previous one + 1 tick (and the PTS raised along with it should it ever
  fall behind, which takes absurdly dense timestamps).
✅ MPEG-TS and ADTS muxers: neither checks the 8191-byte maximum ADTS frame length (AAC frames hold at most 6144
  bits per channel, so only streams with more than ~10 channels could exceed it).
  Fix: `writeAdtsFrameLength` throws for frames that don't fit, covering both muxers and the AAC encoder extension.
✅ MPEG-TS muxer: AUD TemporalId is always 0 (only matters with temporal scalability).
  Fix: the HEVC AUD takes its TemporalId from the access unit's first VCL NAL unit.
✅ MPEG-TS muxer: `inputIsAnnexB` is set before parsing a (malformed) description.
  Fix: it's set after the description is parsed, like `inputIsAdts`.
✅ MPEG-TS muxer: `finalize()` after a failed start throws a TypeError (cosmetic).
✅ MPEG-TS demuxer: `maybeInsertReferencePacket` with index -1 (100 randomized initInput sessions stayed sorted).
  Fix: the next-entry order and distance checks also run when inserting at the front.
✅ MPEG-TS demuxer: a PUSI=0 first packet records a section end (unreachable after other fixes).
  Fix: replaced with an assertion, since every caller checks for PUSI=1 at that position first.
✅ `setInt64` with negative fractions: no caller passes them.
  Fix: the value is truncated first, so both halves round the same way.
✅ `ilog` with negative input: no caller passes it.
✅ `colorSpaceIsComplete` with `fullRange: null`: no producer emits it.
✅ DTS encoder `flush()` leaves the encoder unusable: Mediabunny never encodes after a flush.
  Fix: FFmpeg's DTS encoder has no delay, so the bridge's `flush_encoder` (which signaled end of stream and discarded
  whatever came out) is removed; the silence padding in `flush()` stays. WASM rebuilt, README hash updated.
✅ Output: `Promise.all` in start/finalize lets other sources keep running after one fails (every case was harmless).
✅ Output: `start()` still starts sources if cancel arrives during `muxer.start()`.
  Fix: `cancel()` waits for an ongoing `start()` to complete before doing anything, so it cleanly comes after it.
✅ Conversion: pumps call `source.close()` while canceled (the force-close always won).
✅ Conversion: `0 * Infinity` in the packet count estimate for a live track whose first packets span zero time.
✅ Ogg muxer: BOS race when a track's first `add()` isn't awaited.
  Fix: muxers know a track is closed only through their own `onTrackClose` (`closedTracks`, run under their mutex
  after queued adds), not through `source._closed`, which the source sets ahead of them. Same in all five muxers.
✅ ProRes extension: aspect_ratio_information 2/3 are display aspect ratios per RDD 36 Table 3 but are treated as
  pixel ratios (Apple and FFmpeg always write 0).
  Fix: fixed in turbores 1.2.5, which the extension now depends on.
✅ MP3: the Xing `fileSize` is read at a fixed offset, but the field is never used.
  Fix: removed the field (Xing and VBRI).
✅ ISOBMFF: AC-3/DTS tracks declared via metadata without a priming packet would hit a bare assert, but
  `getAudioTrackData` throws earlier with a clear message.
✅ Media sinks: ColorAlphaMerger drops a merged frame without closing it after a worker error, but Chrome only
  fires the error event for synchronous throws, and the worker's handler can't throw.
  Fix: a merged frame arriving for a request that's no longer pending is closed.
✅ FLAC encoder extension: the `copyWithin` pattern fixed in the AAC/AC-3 encoders is linear here (single call).
✅ MP3 encoder extension: the bridge ignores `lame_init_params`'s return code; only an allocation failure could
  make it fail.
  Fix: `init_lame` returns NULL when `lame_init` or `lame_init_params` fails, and the worker throws. WASM rebuilt
  (HEAD bridge reproduced the old hash), README hash updated.
✅ HLS: EXT-X-MEDIA TYPE would be written as `SUBTITLE` instead of `SUBTITLES` (subtitles are disabled in HLS
  output).
✅ Extension worker clients: a rejected `createWorker()` is never reset (Node never fails it; browser CSP failures
  arrive as error events).
  Fix: the AC-3, DTS and TrueHD worker clients reset `workerPromise` when `createWorker()` rejects, so the next use
  retries, and `unrefWorker` treats a failed worker promise as no worker.
✅ Extension worker clients: `close()` after a failed init sends ctx 0 (reads zeros, no effect).
  Fix: the AC-3, DTS and TrueHD coders only send the close command when they have a context.
✅ Server: the keyframe flag is wiped by node-av's `Packet.data` setter (no software decoder reads it).
✅ E-AC-3 at high bitrates uses 3-block frames, muxed as 768-sample MP4 samples (FFmpeg decodes them fine).
  Fix: like FFmpeg, the ISOBMFF muxer merges E-AC-3 frames until a sample holds six blocks (ETSI TS 102 366 Annex
  F), and the demuxer splits samples back into frames (an independent sync frame plus its dependents), which the
  codec registry now spells out.
✅ The Chromium Annex B SPS fixup patches only the first SPS (3 B-frame TS files tested, no frames lost).
  Fix: both the Annex B and the avcC path now patch every SPS (the interlace check still looks at the first one).

### 4. Not reproduced: needs a setup we didn't have

Other browsers (only Chrome on macOS was available):

✅ `canDecodeVideo` builds the codec string for 1280x720 regardless of size (Chrome ignores levels).
  Fix: the default codec string now uses the given `codedWidth` and `codedHeight`.
✅ The AVC level ignores frame rate (Chrome ignores levels).
✅ HE-AACv2 is chosen for > 2 channels at <= 24 kHz (Chrome on Mac rejects all AAC at <= 24 kHz).
  Fix: the default AAC codec string is now always AAC-LC (`mp4a.40.2`), which is what encoders produce anyway.
✅ Codec checks ignore `hardwareAcceleration` (Chrome reports HEVC 'prefer-software' as supported).
  Not a bug: both checks pass the option through. Chrome rejects software HEVC decoding, and accepts software
  HEVC encoding because it really works (a frame encodes fine on macOS).
✅ MediaStreamVideoTrackSource worker path (Safari only): late frames after 'stopTrack' reject `errorPromise`.
  Already fixed: `addVideoFrame` drops frames once the source is closing (see the un-awaited video adds item).
✅ MediaStreamVideoTrackSource worker path (Safari only): a late frame can hit a closed VideoFrame.
  Fix: `onVideoFrame` drops frames once the source is closing, before `tick()` can touch `_lastVideoFrame`.
✅ MediaStreamVideoTrackSource worker path (Safari only): the track is posted without a transfer list.
  Fix: a clone of the track is transferred (posting it plainly throws `DataCloneError` in Safari, and transferring
  the original would detach the user's track). Verified in Safari.
✅ BlobSource keeps a dead stream reader after the rare browser blob-stream error.
  Not fixed: no known trigger; the one concrete case (a file changed on disk) fails with a fresh reader too.
✅ AudioEncoder reclamation (QuotaExceededError) isn't handled; unknown whether Chrome reclaims AudioEncoders.
  Not a bug: only hardware VideoEncoders and platform decoders apply codec pressure, so AudioEncoders are never
  reclaimed; a comment in the wrapper says so. Decoder reclamation isn't handled either (postponed: buffering the
  packets since the last key packet needs a cap, past which callers would still see the error).
✅ Inline worker blob URLs are never revoked (~0.7 MB per encoder instance in browsers).
  Fix: the extensions' inline worker plugin creates the blob URL once per worker script and reuses it (core's
  workers already did). Not revoked, since Deno fails when the URL is revoked right after creating the worker.
✅ Inside Web Workers, the extensions' codec worker is re-created every time the last coder closes.
  Not fixed: only costs startup latency now that the blob URL is reused.

Specific real-world files we couldn't produce:

✅ AV1 hidden key frames (`show_frame = 0`) are flagged as key (needs libaom; SVT-AV1 uses INTRA_ONLY).
  Fix: `determineVideoPacketType` also requires `show_frame = 1`, as AV1-ISOBMFF requires for sync samples.
✅ DTS-ES / 96/24 get a wrong `ddts` StreamConstruction (FFmpeg can't encode such streams).
  Fix: the core header's EXT_AUDIO_ID and EXT_AUDIO are parsed, and XCh, XXCh and X96 map to 2, 3 and 4.
✅ Blu-ray "AC-3 core + E-AC-3 dependent" 7.1 returns null from the E-AC-3 parser.
  Not fixed: too niche (also affects MPEG-TS framing and splitEac3AudioFrames; no encoder produces it).
✅ PAFF (field-coded) H.264 gives the second field its own packet (x264 only does MBAFF).
✅ Legacy Matroska `A_AAC/*` codec IDs without CodecPrivate throw (pre-2008 mkvmerge).
  Fix: like FFmpeg, the AudioSpecificConfig is built from the profile in the codec ID and the Audio element
  (explicit SBR signaling for `/SBR`, doubling the sample rate if `OutputSamplingFrequency` is missing).
✅ Matroska laced TrueHD: laced frames all inherit the keyframe flag.
  Fix: like FFmpeg, audio key flags come from the frames themselves via `determineAudioPacketType`, laced or not,
  replacing the SimpleBlock-only Firefox override (so BlockGroup audio is covered too). TrueHD frames that are still
  content-encoded keep the container's flag. The first key frame timestamp is now computed after that.
✅ Opus channel mapping family 3 (projection) truncates the demixing matrix.
  Fix: `dOps` reading and writing copy everything after the mapping family instead of `2 + channels` bytes.
✅ vpcC level 0 is copied into the codec string, which Chrome rejects (FFmpeg only writes it in degenerate cases).
  Fix: `extractVideoCodecString` replaces level 0 with the level derived from the dimensions.

Huge files or allocations:

✅ The co64/stco choice can flip after the last measurement (> 4 GiB in-memory MP4 with an unlucky offset).
  Fix: the in-memory layout is remeasured until the moov and mdat header sizes stop changing, instead of twice.
✅ Matroska 4-byte master sizes overflow above 256 MiB.
  Fix: master elements without a set size width are measured before writing and get exactly the width they need
  (only Segment and Cluster still reserve one, Cluster now 6 bytes). `writeVarInt` throws instead of overflowing.
✅ sidx subsegment durations wrap after ~20.7 h at 57600 Hz.
  Fix: `sidx` throws for such CMAF segments, like the existing 2 GiB size check.
✅ A 1 h gap with `timestampBase: 'unix'` allocates ~1.4 GB of silence at once.
  Fix: the encoder's gap padding, the conversion's start padding and the ISOBMFF PCM gap padding all pad at most a
  second per sample, reusing one silence buffer. Also, `AudioSample` now copies the raw data it's created from, like
  `VideoSample` (internal callers with fresh or immutable buffers pass `_doNotCopy`).

Other platforms, hardware or filesystems:

✅ Electron: node-av returns buffer copies, so writes into `frame.data` would be lost.
  Not fixed (niche): the resampler output (`dstFrame.data`) and `copyAudioSampleToAvFrame` (`extendedData`) write
  into such buffers, so all audio encoding would be silent in Electron. Fix would be `convertFrame` and `fromBuffer`,
  but node-av's audio `fromBuffer` overflows `data[]` for planar audio with more than 8 channels.
✅ VAAPI/QSV encoders need `hw_frames_ctx`, so they likely fail to open.
  Mostly VAAPI: it only accepts hardware frames, and we open encoders with software frames and no frames context.
✅ Hardware decoding is never actually used (software only).
  Not fixed: `getDecoderCodec` returns the regular decoder, which only decodes in hardware with `hwDeviceCtx` set.
  Doing it properly needs hardware frames kept as they are (lazily downloaded when their data is needed) and passed
  straight to hardware encoders, which also covers VAAPI encoding.
✅ FilePathSource ignores short reads (file truncated after stat, FUSE/network filesystems).
  Fix: reads loop until the range is filled, throwing if the file ends early.

### 5. Not reproduced: attempts inconclusive

✅ Samples: `'contain'` mipmapping may under-sample (quality only). In Chrome, the plain draw already averages
  correctly, so there was nothing to see; other browsers couldn't be tested (only Chrome on macOS was available),
  and a naive fix would need huge intermediate canvases.

### 6. Docs

✅ `docs/guide/writing-hls.md` says `disposition.forced` maps to FORCED=YES (no longer true).
  Fix: says subtitle tracks only.
✅ `docs/guide/writing-hls.md` examples use 2-letter `languageCode`s, which throw.
  Fix: three-letter codes, and the disposition example no longer adds the German source as Spanish.
✅ `docs/guide/supported-formats-and-codecs.md` is missing the .wav checkmark for pcm-f64.
  Fix: added.
✅ `docs/guide/reading-media-files.md` says UrlSource's `maxCacheSize` defaults to 8 MiB (code: 64 MiB).
  Fix: 64 MiB, and ReadableStreamSource's 16 MiB corrected to 32 MiB too.
✅ The `CustomSourceOptions.read` TSDoc says `end < fileSize`; it should be `end <= fileSize`.
  Fix: corrected in the TSDoc and the guide.

## Notes

✅ `scripts/esbuild/inlined-workers.ts` caches worker bundles in a shared `node_modules/.cache` with a per-process
  counter, so parallel bundle runs can swap workers between packages. Not a library bug, but it bit the agents.
  Fix: worker bundles are built in memory (`write: false`), so there's no cache; `find-cache-dir` is removed.
✅ `@mediabunny/dts` and `@mediabunny/truehd` have no alias in `vitest.config.ts`; they resolve through
  `node_modules` to `packages/*/dist`.
  Fix: aliased to their `dist/bundles` `.mjs`, like `@mediabunny/ac3`.
