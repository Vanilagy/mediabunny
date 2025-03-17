"use strict";
var Metamuxer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    ALL_FORMATS: () => ALL_FORMATS,
    ALL_TRACK_TYPES: () => ALL_TRACK_TYPES,
    AUDIO_CODECS: () => AUDIO_CODECS,
    AudioBufferSink: () => AudioBufferSink,
    AudioBufferSource: () => AudioBufferSource,
    AudioSample: () => AudioSample,
    AudioSampleSink: () => AudioSampleSink,
    AudioSampleSource: () => AudioSampleSource,
    AudioSource: () => AudioSource,
    BaseMediaSampleSink: () => BaseMediaSampleSink,
    BlobSource: () => BlobSource,
    BufferSource: () => BufferSource,
    BufferTarget: () => BufferTarget,
    CanvasSink: () => CanvasSink,
    CanvasSource: () => CanvasSource,
    Conversion: () => Conversion,
    CustomAudioDecoder: () => CustomAudioDecoder,
    CustomAudioEncoder: () => CustomAudioEncoder,
    CustomVideoDecoder: () => CustomVideoDecoder,
    CustomVideoEncoder: () => CustomVideoEncoder,
    EncodedAudioPacketSource: () => EncodedAudioPacketSource,
    EncodedPacket: () => EncodedPacket,
    EncodedPacketSink: () => EncodedPacketSink,
    EncodedVideoPacketSource: () => EncodedVideoPacketSource,
    Input: () => Input,
    InputAudioTrack: () => InputAudioTrack,
    InputFormat: () => InputFormat,
    InputTrack: () => InputTrack,
    InputVideoTrack: () => InputVideoTrack,
    IsobmffInputFormat: () => IsobmffInputFormat,
    IsobmffOutputFormat: () => IsobmffOutputFormat2,
    MATROSKA: () => MATROSKA,
    MP3: () => MP3,
    MP4: () => MP4,
    MatroskaInputFormat: () => MatroskaInputFormat,
    MediaSource: () => MediaSource,
    MediaStreamAudioTrackSource: () => MediaStreamAudioTrackSource,
    MediaStreamVideoTrackSource: () => MediaStreamVideoTrackSource,
    MkvOutputFormat: () => MkvOutputFormat2,
    MovOutputFormat: () => MovOutputFormat,
    Mp3InputFormat: () => Mp3InputFormat,
    Mp3OutputFormat: () => Mp3OutputFormat,
    Mp4InputFormat: () => Mp4InputFormat,
    Mp4OutputFormat: () => Mp4OutputFormat,
    NON_PCM_AUDIO_CODECS: () => NON_PCM_AUDIO_CODECS,
    OGG: () => OGG,
    OggInputFormat: () => OggInputFormat,
    OggOutputFormat: () => OggOutputFormat,
    Output: () => Output,
    OutputFormat: () => OutputFormat,
    PCM_AUDIO_CODECS: () => PCM_AUDIO_CODECS,
    QTFF: () => QTFF,
    QUALITY_HIGH: () => QUALITY_HIGH,
    QUALITY_LOW: () => QUALITY_LOW,
    QUALITY_MEDIUM: () => QUALITY_MEDIUM,
    QUALITY_VERY_HIGH: () => QUALITY_VERY_HIGH,
    QUALITY_VERY_LOW: () => QUALITY_VERY_LOW,
    Quality: () => Quality,
    QuickTimeInputFormat: () => QuickTimeInputFormat,
    SUBTITLE_CODECS: () => SUBTITLE_CODECS,
    Source: () => Source,
    StreamSource: () => StreamSource,
    StreamTarget: () => StreamTarget,
    SubtitleSource: () => SubtitleSource,
    Target: () => Target,
    TextSubtitleSource: () => TextSubtitleSource,
    UrlSource: () => UrlSource,
    VIDEO_CODECS: () => VIDEO_CODECS,
    VideoSample: () => VideoSample,
    VideoSampleSink: () => VideoSampleSink,
    VideoSampleSource: () => VideoSampleSource,
    VideoSource: () => VideoSource,
    WAVE: () => WAVE,
    WEBM: () => WEBM,
    WaveInputFormat: () => WaveInputFormat,
    WaveOutputFormat: () => WaveOutputFormat,
    WebMInputFormat: () => WebMInputFormat,
    WebMOutputFormat: () => WebMOutputFormat,
    canEncode: () => canEncode,
    canEncodeAudio: () => canEncodeAudio,
    canEncodeSubtitles: () => canEncodeSubtitles,
    canEncodeVideo: () => canEncodeVideo,
    convert: () => convert,
    getEncodableAudioCodecs: () => getEncodableAudioCodecs,
    getEncodableCodecs: () => getEncodableCodecs,
    getEncodableSubtitleCodecs: () => getEncodableSubtitleCodecs,
    getEncodableVideoCodecs: () => getEncodableVideoCodecs,
    registerDecoder: () => registerDecoder,
    registerEncoder: () => registerEncoder
  });

  // src/misc.ts
  function assert(x) {
    if (!x) {
      throw new Error("Assertion failed.");
    }
  }
  var normalizeRotation = (rotation) => {
    const mappedRotation = (rotation % 360 + 360) % 360;
    if (mappedRotation === 0 || mappedRotation === 90 || mappedRotation === 180 || mappedRotation === 270) {
      return mappedRotation;
    } else {
      throw new Error(`Invalid rotation ${rotation}.`);
    }
  };
  var last = (arr) => {
    return arr && arr[arr.length - 1];
  };
  var isU32 = (value) => {
    return value >= 0 && value < 2 ** 32;
  };
  var readBits = (bytes2, start, end) => {
    let result = 0;
    for (let i = start; i < end; i++) {
      const byteIndex = Math.floor(i / 8);
      const byte = bytes2[byteIndex];
      const bitIndex = 7 - (i & 7);
      const bit = (byte & 1 << bitIndex) >> bitIndex;
      result <<= 1;
      result |= bit;
    }
    return result;
  };
  var writeBits = (bytes2, start, end, value) => {
    for (let i = start; i < end; i++) {
      const byteIndex = Math.floor(i / 8);
      let byte = bytes2[byteIndex];
      const bitIndex = 7 - (i & 7);
      byte &= ~(1 << bitIndex);
      byte |= (value & 1 << end - i - 1) >> end - i - 1 << bitIndex;
      bytes2[byteIndex] = byte;
    }
  };
  var toUint8Array = (source) => {
    if (source instanceof ArrayBuffer) {
      return new Uint8Array(source);
    } else {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
  };
  var toDataView = (source) => {
    if (source instanceof ArrayBuffer) {
      return new DataView(source);
    } else {
      return new DataView(source.buffer, source.byteOffset, source.byteLength);
    }
  };
  var textEncoder = new TextEncoder();
  var invertObject = (object) => {
    return Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key]));
  };
  var COLOR_PRIMARIES_MAP = {
    bt709: 1,
    // ITU-R BT.709
    bt470bg: 5,
    // ITU-R BT.470BG
    smpte170m: 6,
    // ITU-R BT.601 525 - SMPTE 170M
    bt2020: 9,
    // ITU-R BT.202
    smpte432: 12
    // SMPTE EG 432-1
  };
  var COLOR_PRIMARIES_MAP_INVERSE = invertObject(COLOR_PRIMARIES_MAP);
  var TRANSFER_CHARACTERISTICS_MAP = {
    "bt709": 1,
    // ITU-R BT.709
    "smpte170m": 6,
    // SMPTE 170M
    "linear": 8,
    // Linear transfer characteristics
    "iec61966-2-1": 13,
    // IEC 61966-2-1
    "pg": 16,
    // Rec. ITU-R BT.2100-2 perceptual quantization (PQ) system
    "hlg": 18
    // Rec. ITU-R BT.2100-2 hybrid loggamma (HLG) system
  };
  var TRANSFER_CHARACTERISTICS_MAP_INVERSE = invertObject(TRANSFER_CHARACTERISTICS_MAP);
  var MATRIX_COEFFICIENTS_MAP = {
    "rgb": 0,
    // Identity
    "bt709": 1,
    // ITU-R BT.709
    "bt470bg": 5,
    // ITU-R BT.470BG
    "smpte170m": 6,
    // SMPTE 170M
    "bt2020-ncl": 9
    // ITU-R BT.2020-2 (non-constant luminance)
  };
  var MATRIX_COEFFICIENTS_MAP_INVERSE = invertObject(MATRIX_COEFFICIENTS_MAP);
  var colorSpaceIsComplete = (colorSpace) => {
    return !!colorSpace && !!colorSpace.primaries && !!colorSpace.transfer && !!colorSpace.matrix && colorSpace.fullRange !== void 0;
  };
  var isAllowSharedBufferSource = (x) => {
    return x instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && x instanceof SharedArrayBuffer || ArrayBuffer.isView(x) && !(x instanceof DataView);
  };
  var AsyncMutex = class {
    constructor() {
      this.currentPromise = Promise.resolve();
    }
    async acquire() {
      let resolver;
      const nextPromise = new Promise((resolve) => {
        resolver = resolve;
      });
      const currentPromiseAlias = this.currentPromise;
      this.currentPromise = nextPromise;
      await currentPromiseAlias;
      return resolver;
    }
  };
  var bytesToHexString = (bytes2) => {
    return [...bytes2].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  var reverseBitsU32 = (x) => {
    x = x >> 1 & 1431655765 | (x & 1431655765) << 1;
    x = x >> 2 & 858993459 | (x & 858993459) << 2;
    x = x >> 4 & 252645135 | (x & 252645135) << 4;
    x = x >> 8 & 16711935 | (x & 16711935) << 8;
    x = x >> 16 & 65535 | (x & 65535) << 16;
    return x >>> 0;
  };
  var binarySearchExact = (arr, key, valueGetter) => {
    let low = 0;
    let high = arr.length - 1;
    let res = -1;
    while (low <= high) {
      const mid = low + high >> 1;
      const midVal = valueGetter(arr[mid]);
      if (midVal === key) {
        res = mid;
        high = mid - 1;
      } else if (midVal < key) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return res;
  };
  var binarySearchLessOrEqual = (arr, key, valueGetter) => {
    let ans = -1;
    let low = 0;
    let high = arr.length - 1;
    while (low <= high) {
      const mid = low + (high - low + 1) / 2 | 0;
      const midVal = valueGetter(arr[mid]);
      if (midVal <= key) {
        ans = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return ans;
  };
  var promiseWithResolvers = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  var removeItem = (arr, item) => {
    const index = arr.indexOf(item);
    if (index !== -1) {
      arr.splice(index, 1);
    }
  };
  var findLast = (arr, predicate) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i])) {
        return arr[i];
      }
    }
    return void 0;
  };
  var findLastIndex = (arr, predicate) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i])) {
        return i;
      }
    }
    return -1;
  };
  var toAsyncIterator = async function* (source) {
    if (Symbol.iterator in source) {
      yield* source[Symbol.iterator]();
    } else {
      yield* source[Symbol.asyncIterator]();
    }
  };
  var validateAnyIterable = (iterable) => {
    if (!(Symbol.iterator in iterable) && !(Symbol.asyncIterator in iterable)) {
      throw new TypeError("Argument must be an iterable or async iterable.");
    }
  };
  var getUint24 = (view2, byteOffset, littleEndian) => {
    const byte1 = view2.getUint8(byteOffset);
    const byte2 = view2.getUint8(byteOffset + 1);
    const byte3 = view2.getUint8(byteOffset + 2);
    if (littleEndian) {
      return byte1 | byte2 << 8 | byte3 << 16;
    } else {
      return byte1 << 16 | byte2 << 8 | byte3;
    }
  };
  var getInt24 = (view2, byteOffset, littleEndian) => {
    return getUint24(view2, byteOffset, littleEndian) << 8 >> 8;
  };
  var setUint24 = (view2, byteOffset, value, littleEndian) => {
    value = value >>> 0;
    value = value & 16777215;
    if (littleEndian) {
      view2.setUint8(byteOffset, value & 255);
      view2.setUint8(byteOffset + 1, value >>> 8 & 255);
      view2.setUint8(byteOffset + 2, value >>> 16 & 255);
    } else {
      view2.setUint8(byteOffset, value >>> 16 & 255);
      view2.setUint8(byteOffset + 1, value >>> 8 & 255);
      view2.setUint8(byteOffset + 2, value & 255);
    }
  };
  var setInt24 = (view2, byteOffset, value, littleEndian) => {
    value = clamp(value, -8388608, 8388607);
    if (value < 0) {
      value = value + 16777216 & 16777215;
    }
    setUint24(view2, byteOffset, value, littleEndian);
  };
  var setInt64 = (view2, byteOffset, value, littleEndian) => {
    if (littleEndian) {
      view2.setUint32(byteOffset + 0, value, true);
      view2.setInt32(byteOffset + 4, Math.floor(value / 2 ** 32), true);
    } else {
      view2.setInt32(byteOffset + 0, Math.floor(value / 2 ** 32), true);
      view2.setUint32(byteOffset + 4, value, true);
    }
  };
  var mapAsyncGenerator = (generator, map) => {
    return {
      async next() {
        const result = await generator.next();
        if (result.done) {
          return { value: void 0, done: true };
        } else {
          return { value: map(result.value), done: false };
        }
      },
      return() {
        return generator.return();
      },
      throw(error) {
        return generator.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  };
  var clamp = (value, min, max) => {
    return Math.max(min, Math.min(max, value));
  };
  var UNDETERMINED_LANGUAGE = "und";
  var roundToPrecision = (value, digits) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  var roundToMultiple = (value, multiple) => {
    return Math.round(value / multiple) * multiple;
  };
  var ilog = (x) => {
    let ret = 0;
    while (x) {
      ret++;
      x >>= 1;
    }
    return ret;
  };
  var ISO_639_2_REGEX = /^[a-z]{3}$/;
  var isIso639Dash2LanguageCode = (x) => {
    return ISO_639_2_REGEX.test(x);
  };
  var SECOND_TO_MICROSECOND_FACTOR = 1e6 * (1 + Number.EPSILON);

  // src/custom-coder.ts
  var CustomVideoDecoder = class {
    /** Returns true iff the decoder can decode the given codec configuration. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static supports(codec, config) {
      return false;
    }
  };
  var CustomAudioDecoder = class {
    /** Returns true iff the decoder can decode the given codec configuration. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static supports(codec, config) {
      return false;
    }
  };
  var CustomVideoEncoder = class {
    /** Returns true iff the encoder can encode the given codec configuration. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static supports(codec, config) {
      return false;
    }
  };
  var CustomAudioEncoder = class {
    /** Returns true iff the encoder can encode the given codec configuration. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static supports(codec, config) {
      return false;
    }
  };
  var customVideoDecoders = [];
  var customAudioDecoders = [];
  var customVideoEncoders = [];
  var customAudioEncoders = [];
  var registerDecoder = (decoder) => {
    if (decoder.prototype instanceof CustomVideoDecoder) {
      customVideoDecoders.push(decoder);
    } else if (decoder.prototype instanceof CustomAudioDecoder) {
      customAudioDecoders.push(decoder);
    } else {
      throw new TypeError("Decoder must be a CustomVideoDecoder or CustomAudioDecoder.");
    }
  };
  var registerEncoder = (encoder) => {
    if (encoder.prototype instanceof CustomVideoEncoder) {
      customVideoEncoders.push(encoder);
    } else if (encoder.prototype instanceof CustomAudioEncoder) {
      customAudioEncoders.push(encoder);
    } else {
      throw new TypeError("Encoder must be a CustomVideoEncoder or CustomAudioEncoder.");
    }
  };

  // src/codec.ts
  var VIDEO_CODECS = [
    "avc",
    "hevc",
    "vp9",
    "av1",
    "vp8"
  ];
  var PCM_AUDIO_CODECS = [
    "pcm-s16",
    // We don't prefix 'le' so we're compatible with the WebCodecs-registered PCM codec strings
    "pcm-s16be",
    "pcm-s24",
    "pcm-s24be",
    "pcm-s32",
    "pcm-s32be",
    "pcm-f32",
    "pcm-f32be",
    "pcm-u8",
    "pcm-s8",
    "ulaw",
    "alaw"
  ];
  var NON_PCM_AUDIO_CODECS = [
    "aac",
    "opus",
    "mp3",
    "vorbis",
    "flac"
  ];
  var AUDIO_CODECS = [
    ...NON_PCM_AUDIO_CODECS,
    ...PCM_AUDIO_CODECS
  ];
  var SUBTITLE_CODECS = [
    "webvtt"
  ];
  var AVC_LEVEL_TABLE = [
    { maxMacroblocks: 99, maxBitrate: 64e3, level: 10 },
    // Level 1
    { maxMacroblocks: 396, maxBitrate: 192e3, level: 11 },
    // Level 1.1
    { maxMacroblocks: 396, maxBitrate: 384e3, level: 12 },
    // Level 1.2
    { maxMacroblocks: 396, maxBitrate: 768e3, level: 13 },
    // Level 1.3
    { maxMacroblocks: 396, maxBitrate: 2e6, level: 20 },
    // Level 2
    { maxMacroblocks: 792, maxBitrate: 4e6, level: 21 },
    // Level 2.1
    { maxMacroblocks: 1620, maxBitrate: 4e6, level: 22 },
    // Level 2.2
    { maxMacroblocks: 1620, maxBitrate: 1e7, level: 30 },
    // Level 3
    { maxMacroblocks: 3600, maxBitrate: 14e6, level: 31 },
    // Level 3.1
    { maxMacroblocks: 5120, maxBitrate: 2e7, level: 32 },
    // Level 3.2
    { maxMacroblocks: 8192, maxBitrate: 2e7, level: 40 },
    // Level 4
    { maxMacroblocks: 8192, maxBitrate: 5e7, level: 41 },
    // Level 4.1
    { maxMacroblocks: 8704, maxBitrate: 5e7, level: 42 },
    // Level 4.2
    { maxMacroblocks: 22080, maxBitrate: 135e6, level: 50 },
    // Level 5
    { maxMacroblocks: 36864, maxBitrate: 24e7, level: 51 },
    // Level 5.1
    { maxMacroblocks: 36864, maxBitrate: 24e7, level: 52 },
    // Level 5.2
    { maxMacroblocks: 139264, maxBitrate: 24e7, level: 60 },
    // Level 6
    { maxMacroblocks: 139264, maxBitrate: 48e7, level: 61 },
    // Level 6.1
    { maxMacroblocks: 139264, maxBitrate: 8e8, level: 62 }
    // Level 6.2
  ];
  var HEVC_LEVEL_TABLE = [
    { maxPictureSize: 36864, maxBitrate: 128e3, tier: "L", level: 30 },
    // Level 1 (Low Tier)
    { maxPictureSize: 122880, maxBitrate: 15e5, tier: "L", level: 60 },
    // Level 2 (Low Tier)
    { maxPictureSize: 245760, maxBitrate: 3e6, tier: "L", level: 63 },
    // Level 2.1 (Low Tier)
    { maxPictureSize: 552960, maxBitrate: 6e6, tier: "L", level: 90 },
    // Level 3 (Low Tier)
    { maxPictureSize: 983040, maxBitrate: 1e7, tier: "L", level: 93 },
    // Level 3.1 (Low Tier)
    { maxPictureSize: 2228224, maxBitrate: 12e6, tier: "L", level: 120 },
    // Level 4 (Low Tier)
    { maxPictureSize: 2228224, maxBitrate: 3e7, tier: "H", level: 120 },
    // Level 4 (High Tier)
    { maxPictureSize: 2228224, maxBitrate: 2e7, tier: "L", level: 123 },
    // Level 4.1 (Low Tier)
    { maxPictureSize: 2228224, maxBitrate: 5e7, tier: "H", level: 123 },
    // Level 4.1 (High Tier)
    { maxPictureSize: 8912896, maxBitrate: 25e6, tier: "L", level: 150 },
    // Level 5 (Low Tier)
    { maxPictureSize: 8912896, maxBitrate: 1e8, tier: "H", level: 150 },
    // Level 5 (High Tier)
    { maxPictureSize: 8912896, maxBitrate: 4e7, tier: "L", level: 153 },
    // Level 5.1 (Low Tier)
    { maxPictureSize: 8912896, maxBitrate: 16e7, tier: "H", level: 153 },
    // Level 5.1 (High Tier)
    { maxPictureSize: 8912896, maxBitrate: 6e7, tier: "L", level: 156 },
    // Level 5.2 (Low Tier)
    { maxPictureSize: 8912896, maxBitrate: 24e7, tier: "H", level: 156 },
    // Level 5.2 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 6e7, tier: "L", level: 180 },
    // Level 6 (Low Tier)
    { maxPictureSize: 35651584, maxBitrate: 24e7, tier: "H", level: 180 },
    // Level 6 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 12e7, tier: "L", level: 183 },
    // Level 6.1 (Low Tier)
    { maxPictureSize: 35651584, maxBitrate: 48e7, tier: "H", level: 183 },
    // Level 6.1 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 24e7, tier: "L", level: 186 },
    // Level 6.2 (Low Tier)
    { maxPictureSize: 35651584, maxBitrate: 8e8, tier: "H", level: 186 }
    // Level 6.2 (High Tier)
  ];
  var VP9_LEVEL_TABLE = [
    { maxPictureSize: 36864, maxBitrate: 2e5, level: 10 },
    // Level 1
    { maxPictureSize: 73728, maxBitrate: 8e5, level: 11 },
    // Level 1.1
    { maxPictureSize: 122880, maxBitrate: 18e5, level: 20 },
    // Level 2
    { maxPictureSize: 245760, maxBitrate: 36e5, level: 21 },
    // Level 2.1
    { maxPictureSize: 552960, maxBitrate: 72e5, level: 30 },
    // Level 3
    { maxPictureSize: 983040, maxBitrate: 12e6, level: 31 },
    // Level 3.1
    { maxPictureSize: 2228224, maxBitrate: 18e6, level: 40 },
    // Level 4
    { maxPictureSize: 2228224, maxBitrate: 3e7, level: 41 },
    // Level 4.1
    { maxPictureSize: 8912896, maxBitrate: 6e7, level: 50 },
    // Level 5
    { maxPictureSize: 8912896, maxBitrate: 12e7, level: 51 },
    // Level 5.1
    { maxPictureSize: 8912896, maxBitrate: 18e7, level: 52 },
    // Level 5.2
    { maxPictureSize: 35651584, maxBitrate: 18e7, level: 60 },
    // Level 6
    { maxPictureSize: 35651584, maxBitrate: 24e7, level: 61 },
    // Level 6.1
    { maxPictureSize: 35651584, maxBitrate: 48e7, level: 62 }
    // Level 6.2
  ];
  var AV1_LEVEL_TABLE = [
    { maxPictureSize: 147456, maxBitrate: 15e5, tier: "M", level: 0 },
    // Level 2.0 (Main Tier)
    { maxPictureSize: 278784, maxBitrate: 3e6, tier: "M", level: 1 },
    // Level 2.1 (Main Tier)
    { maxPictureSize: 665856, maxBitrate: 6e6, tier: "M", level: 4 },
    // Level 3.0 (Main Tier)
    { maxPictureSize: 1065024, maxBitrate: 1e7, tier: "M", level: 5 },
    // Level 3.1 (Main Tier)
    { maxPictureSize: 2359296, maxBitrate: 12e6, tier: "M", level: 8 },
    // Level 4.0 (Main Tier)
    { maxPictureSize: 2359296, maxBitrate: 3e7, tier: "H", level: 8 },
    // Level 4.0 (High Tier)
    { maxPictureSize: 2359296, maxBitrate: 2e7, tier: "M", level: 9 },
    // Level 4.1 (Main Tier)
    { maxPictureSize: 2359296, maxBitrate: 5e7, tier: "H", level: 9 },
    // Level 4.1 (High Tier)
    { maxPictureSize: 8912896, maxBitrate: 3e7, tier: "M", level: 12 },
    // Level 5.0 (Main Tier)
    { maxPictureSize: 8912896, maxBitrate: 1e8, tier: "H", level: 12 },
    // Level 5.0 (High Tier)
    { maxPictureSize: 8912896, maxBitrate: 4e7, tier: "M", level: 13 },
    // Level 5.1 (Main Tier)
    { maxPictureSize: 8912896, maxBitrate: 16e7, tier: "H", level: 13 },
    // Level 5.1 (High Tier)
    { maxPictureSize: 8912896, maxBitrate: 6e7, tier: "M", level: 14 },
    // Level 5.2 (Main Tier)
    { maxPictureSize: 8912896, maxBitrate: 24e7, tier: "H", level: 14 },
    // Level 5.2 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 6e7, tier: "M", level: 15 },
    // Level 5.3 (Main Tier)
    { maxPictureSize: 35651584, maxBitrate: 24e7, tier: "H", level: 15 },
    // Level 5.3 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 6e7, tier: "M", level: 16 },
    // Level 6.0 (Main Tier)
    { maxPictureSize: 35651584, maxBitrate: 24e7, tier: "H", level: 16 },
    // Level 6.0 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 1e8, tier: "M", level: 17 },
    // Level 6.1 (Main Tier)
    { maxPictureSize: 35651584, maxBitrate: 48e7, tier: "H", level: 17 },
    // Level 6.1 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 16e7, tier: "M", level: 18 },
    // Level 6.2 (Main Tier)
    { maxPictureSize: 35651584, maxBitrate: 8e8, tier: "H", level: 18 },
    // Level 6.2 (High Tier)
    { maxPictureSize: 35651584, maxBitrate: 16e7, tier: "M", level: 19 },
    // Level 6.3 (Main Tier)
    { maxPictureSize: 35651584, maxBitrate: 8e8, tier: "H", level: 19 }
    // Level 6.3 (High Tier)
  ];
  var VP9_DEFAULT_SUFFIX = ".01.01.01.01.00";
  var AV1_DEFAULT_SUFFIX = ".0.110.01.01.01.0";
  var buildVideoCodecString = (codec, width, height, bitrate) => {
    if (codec === "avc") {
      const profileIndication = 100;
      const totalMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
      const levelInfo = AVC_LEVEL_TABLE.find(
        (level) => totalMacroblocks <= level.maxMacroblocks && bitrate <= level.maxBitrate
      ) ?? last(AVC_LEVEL_TABLE);
      const levelIndication = levelInfo ? levelInfo.level : 0;
      const hexProfileIndication = profileIndication.toString(16).padStart(2, "0");
      const hexProfileCompatibility = "00";
      const hexLevelIndication = levelIndication.toString(16).padStart(2, "0");
      return `avc1.${hexProfileIndication}${hexProfileCompatibility}${hexLevelIndication}`;
    } else if (codec === "hevc") {
      const profilePrefix = "";
      const profileIdc = 1;
      const compatibilityFlags = "6";
      const pictureSize = width * height;
      const levelInfo = HEVC_LEVEL_TABLE.find(
        (level) => pictureSize <= level.maxPictureSize && bitrate <= level.maxBitrate
      ) ?? last(HEVC_LEVEL_TABLE);
      const constraintFlags = "B0";
      return `hev1.${profilePrefix}${profileIdc}.${compatibilityFlags}.${levelInfo.tier}${levelInfo.level}.${constraintFlags}`;
    } else if (codec === "vp8") {
      return "vp8";
    } else if (codec === "vp9") {
      const profile = "00";
      const pictureSize = width * height;
      const levelInfo = VP9_LEVEL_TABLE.find(
        (level) => pictureSize <= level.maxPictureSize && bitrate <= level.maxBitrate
      ) ?? last(VP9_LEVEL_TABLE);
      const bitDepth = "08";
      return `vp09.${profile}.${levelInfo.level.toString().padStart(2, "0")}.${bitDepth}${VP9_DEFAULT_SUFFIX}`;
    } else if (codec === "av1") {
      const profile = 0;
      const pictureSize = width * height;
      const levelInfo = AV1_LEVEL_TABLE.find(
        (level2) => pictureSize <= level2.maxPictureSize && bitrate <= level2.maxBitrate
      ) ?? last(AV1_LEVEL_TABLE);
      const level = levelInfo.level.toString().padStart(2, "0");
      const bitDepth = "08";
      return `av01.${profile}.${level}${levelInfo.tier}.${bitDepth}${AV1_DEFAULT_SUFFIX}`;
    }
    throw new TypeError(`Unhandled codec '${codec}'.`);
  };
  var generateAv1CodecConfigurationFromCodecString = (codecString) => {
    const parts = codecString.split(".");
    const marker = 1;
    const version = 1;
    const firstByte = (marker << 7) + version;
    const profile = Number(parts[1]);
    const levelAndTier = parts[2];
    const level = Number(levelAndTier.slice(0, -1));
    const secondByte = (profile << 5) + level;
    const tier = levelAndTier.slice(-1) === "H" ? 1 : 0;
    const bitDepth = Number(parts[3]);
    const highBitDepth = bitDepth === 8 ? 0 : 1;
    const twelveBit = 0;
    const monochrome = parts[4] ? Number(parts[4]) : 0;
    const chromaSubsamplingX = parts[5] ? Number(parts[5][0]) : 1;
    const chromaSubsamplingY = parts[5] ? Number(parts[5][1]) : 1;
    const chromaSamplePosition = parts[5] ? Number(parts[5][2]) : 0;
    const thirdByte = (tier << 7) + (highBitDepth << 6) + (twelveBit << 5) + (monochrome << 4) + (chromaSubsamplingX << 3) + (chromaSubsamplingY << 2) + chromaSamplePosition;
    const initialPresentationDelayPresent = 0;
    const fourthByte = initialPresentationDelayPresent;
    return [firstByte, secondByte, thirdByte, fourthByte];
  };
  var extractVideoCodecString = (trackInfo) => {
    const { codec, codecDescription: description, colorSpace, vp9CodecInfo, av1CodecInfo } = trackInfo;
    if (codec === "avc") {
      if (!description || description.byteLength < 4) {
        throw new TypeError("AVC description must be at least 4 bytes long.");
      }
      return `avc1.${bytesToHexString(description.subarray(1, 4))}`;
    } else if (codec === "hevc") {
      if (!description) {
        throw new TypeError("HEVC description must be provided.");
      }
      const view2 = toDataView(description);
      let codecString = "hev1.";
      const generalProfileSpace = description[1] >> 6 & 3;
      const generalProfileIdc = description[1] & 31;
      codecString += ["", "A", "B", "C"][generalProfileSpace] + generalProfileIdc;
      codecString += ".";
      const compatibilityFlags = reverseBitsU32(view2.getUint32(2));
      codecString += compatibilityFlags.toString(16);
      codecString += ".";
      const generalTierFlag = description[1] >> 5 & 1;
      const generalLevelIdc = description[12];
      codecString += generalTierFlag === 0 ? "L" : "H";
      codecString += generalLevelIdc;
      codecString += ".";
      const constraintFlags = [];
      for (let i = 0; i < 6; i++) {
        const byte = description[i + 13];
        constraintFlags.push(byte);
      }
      while (constraintFlags[constraintFlags.length - 1] === 0) {
        constraintFlags.pop();
      }
      codecString += constraintFlags.map((x) => x.toString(16)).join(".");
      return codecString;
    } else if (codec === "vp8") {
      return "vp8";
    } else if (codec === "vp9") {
      if (!vp9CodecInfo) {
        const pictureSize = trackInfo.width * trackInfo.height;
        let level2 = last(VP9_LEVEL_TABLE).level;
        for (const entry of VP9_LEVEL_TABLE) {
          if (pictureSize <= entry.maxPictureSize) {
            level2 = entry.level;
            break;
          }
        }
        return `vp09.00.${level2.toString().padStart(2, "0")}.08`;
      }
      const profile = vp9CodecInfo.profile.toString().padStart(2, "0");
      const level = vp9CodecInfo.level.toString().padStart(2, "0");
      const bitDepth = vp9CodecInfo.bitDepth.toString().padStart(2, "0");
      const chromaSubsampling = vp9CodecInfo.chromaSubsampling.toString().padStart(2, "0");
      const colourPrimaries = vp9CodecInfo.colourPrimaries.toString().padStart(2, "0");
      const transferCharacteristics = vp9CodecInfo.transferCharacteristics.toString().padStart(2, "0");
      const matrixCoefficients = vp9CodecInfo.matrixCoefficients.toString().padStart(2, "0");
      const videoFullRangeFlag = vp9CodecInfo.videoFullRangeFlag.toString().padStart(2, "0");
      let string = `vp09.${profile}.${level}.${bitDepth}.${chromaSubsampling}`;
      string += `.${colourPrimaries}.${transferCharacteristics}.${matrixCoefficients}.${videoFullRangeFlag}`;
      const defaultSuffix = ".01.01.01.01.00";
      if (string.endsWith(defaultSuffix)) {
        string = string.slice(0, -defaultSuffix.length);
      }
      return string;
    } else if (codec === "av1") {
      if (!av1CodecInfo) {
        const pictureSize = trackInfo.width * trackInfo.height;
        let level2 = last(VP9_LEVEL_TABLE).level;
        for (const entry of VP9_LEVEL_TABLE) {
          if (pictureSize <= entry.maxPictureSize) {
            level2 = entry.level;
            break;
          }
        }
        return `av01.0.${level2.toString().padStart(2, "0")}M.08`;
      }
      const profile = av1CodecInfo.profile;
      const level = av1CodecInfo.level.toString().padStart(2, "0");
      const tier = av1CodecInfo.tier ? "H" : "M";
      const bitDepth = av1CodecInfo.bitDepth.toString().padStart(2, "0");
      const monochrome = av1CodecInfo.monochrome ? "1" : "0";
      const chromaSubsampling = 100 * av1CodecInfo.chromaSubsamplingX + 10 * av1CodecInfo.chromaSubsamplingY + 1 * (av1CodecInfo.chromaSubsamplingX && av1CodecInfo.chromaSubsamplingY ? av1CodecInfo.chromaSamplePosition : 0);
      const colorPrimaries = colorSpace?.primaries ? COLOR_PRIMARIES_MAP[colorSpace.primaries] : 1;
      const transferCharacteristics = colorSpace?.transfer ? TRANSFER_CHARACTERISTICS_MAP[colorSpace.transfer] : 1;
      const matrixCoefficients = colorSpace?.matrix ? MATRIX_COEFFICIENTS_MAP[colorSpace.matrix] : 1;
      const videoFullRangeFlag = colorSpace?.fullRange ? 1 : 0;
      let string = `av01.${profile}.${level}${tier}.${bitDepth}`;
      string += `.${monochrome}.${chromaSubsampling.toString().padStart(3, "0")}`;
      string += `.${colorPrimaries.toString().padStart(2, "0")}`;
      string += `.${transferCharacteristics.toString().padStart(2, "0")}`;
      string += `.${matrixCoefficients.toString().padStart(2, "0")}`;
      string += `.${videoFullRangeFlag}`;
      const defaultSuffix = ".0.110.01.01.01.0";
      if (string.endsWith(defaultSuffix)) {
        string = string.slice(0, -defaultSuffix.length);
      }
      return string;
    }
    throw new TypeError(`Unhandled codec '${codec}'.`);
  };
  var extractVp9CodecInfoFromFrame = (frame) => {
    const lastByte = frame[frame.length - 1];
    if (lastByte && (lastByte & 224) === 192) {
      const bytesPerFrameSize = ((lastByte & 24) >> 3) + 1;
      const numFrames = (lastByte & 7) + 1;
      const indexSize = 2 + numFrames * bytesPerFrameSize;
      if (frame[frame.length - indexSize] !== lastByte) {
        return null;
      }
      let frameSize = 0;
      const offset = frame.length - indexSize + 1;
      for (let i = 0; i < bytesPerFrameSize; i++) {
        if (!frame[offset + i]) return null;
        frameSize |= frame[offset + i] << 8 * i;
      }
      frame = frame.subarray(0, frameSize);
    }
    let bitPos = 0;
    const frameMarker = readBits(frame, bitPos, bitPos + 2);
    if (frameMarker !== 2) {
      return null;
    }
    bitPos += 2;
    const profileLowBit = readBits(frame, bitPos, bitPos + 1);
    bitPos += 1;
    const profileHighBit = readBits(frame, bitPos, bitPos + 1);
    bitPos += 1;
    const profile = (profileHighBit << 1) + profileLowBit;
    if (profile === 3) {
      bitPos += 1;
    }
    const showExistingFrame = readBits(frame, bitPos, bitPos + 1);
    bitPos += 1;
    if (showExistingFrame === 1) {
      return null;
    }
    const frameType = readBits(frame, bitPos, bitPos + 1);
    bitPos += 1;
    if (frameType !== 0) {
      return null;
    }
    bitPos += 2;
    const syncCode = readBits(frame, bitPos, bitPos + 24);
    if (syncCode !== 4817730) {
      return null;
    }
    bitPos += 24;
    let bitDepth = 8;
    if (profile >= 2) {
      const tenOrTwelveBit = readBits(frame, bitPos, bitPos + 1);
      bitPos += 1;
      bitDepth = tenOrTwelveBit ? 12 : 10;
    }
    const colorSpace = readBits(frame, bitPos, bitPos + 3);
    bitPos += 3;
    let chromaSubsampling = 0;
    let videoFullRangeFlag = 0;
    if (colorSpace !== 7) {
      const colorRange = readBits(frame, bitPos, bitPos + 1);
      bitPos += 1;
      videoFullRangeFlag = colorRange;
      if (profile === 1 || profile === 3) {
        const subsamplingX = readBits(frame, bitPos, bitPos + 1);
        bitPos += 1;
        const subsamplingY = readBits(frame, bitPos, bitPos + 1);
        bitPos += 1;
        chromaSubsampling = !subsamplingX && !subsamplingY ? 3 : subsamplingX && !subsamplingY ? 2 : 1;
        bitPos += 1;
      } else {
        chromaSubsampling = 1;
      }
    } else {
      chromaSubsampling = 3;
      videoFullRangeFlag = 1;
    }
    const widthMinusOne = readBits(frame, bitPos, bitPos + 16);
    bitPos += 16;
    const heightMinusOne = readBits(frame, bitPos, bitPos + 16);
    bitPos += 16;
    const width = widthMinusOne + 1;
    const height = heightMinusOne + 1;
    const pictureSize = width * height;
    let level = last(VP9_LEVEL_TABLE).level;
    for (const entry of VP9_LEVEL_TABLE) {
      if (pictureSize <= entry.maxPictureSize) {
        level = entry.level;
        break;
      }
    }
    const matrixCoefficients = colorSpace === 7 ? 0 : colorSpace === 2 ? 1 : colorSpace === 1 ? 6 : 2;
    const colourPrimaries = colorSpace === 2 ? 1 : colorSpace === 1 ? 6 : 2;
    const transferCharacteristics = colorSpace === 2 ? 1 : colorSpace === 1 ? 6 : 2;
    return {
      profile,
      level,
      bitDepth,
      chromaSubsampling,
      videoFullRangeFlag,
      colourPrimaries,
      transferCharacteristics,
      matrixCoefficients
    };
  };
  var extractAv1CodecInfoFromFrame = (data) => {
    let offset = 0;
    const readLeb128 = () => {
      let value = 0;
      for (let i = 0; i < 8; i++) {
        const byte = data[offset++];
        if (byte === void 0) return 0;
        value |= (byte & 127) << i * 7;
        if (!(byte & 128)) {
          break;
        }
        if (i === 7 && byte & 128) {
          return null;
        }
      }
      if (value >= 2 ** 32 - 1) {
        return null;
      }
      return value;
    };
    while (offset < data.length) {
      const obuHeader = readBits(data, offset * 8, offset * 8 + 8);
      offset += 1;
      const obuType = obuHeader >> 3 & 15;
      const obuExtension = obuHeader >> 2 & 1;
      const obuHasSizeField = obuHeader >> 1 & 1;
      if (obuExtension) {
        offset += 1;
      }
      let obuSize;
      if (obuHasSizeField) {
        const obuSizeValue = readLeb128();
        if (obuSizeValue === null) return null;
        obuSize = obuSizeValue;
      } else {
        obuSize = data.length - offset;
      }
      if (obuType === 1) {
        const startBit = offset * 8;
        let bitOffset = 0;
        const seqProfile = readBits(data, startBit + bitOffset, startBit + bitOffset + 3);
        bitOffset += 3;
        const stillPicture = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
        bitOffset += 1;
        const reducedStillPictureHeader = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
        bitOffset += 1;
        let seqLevel = 0;
        let seqTier = 0;
        let bufferDelayLengthMinus1 = 0;
        if (reducedStillPictureHeader) {
          seqLevel = readBits(data, startBit + bitOffset, startBit + bitOffset + 5);
          bitOffset += 5;
        } else {
          const timingInfoPresentFlag = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
          bitOffset += 1;
          if (timingInfoPresentFlag) {
            bitOffset += 32;
            bitOffset += 32;
            const equalPictureInterval = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
            bitOffset += 1;
            if (equalPictureInterval) {
              return null;
            }
          }
          const decoderModelInfoPresentFlag = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
          bitOffset += 1;
          if (decoderModelInfoPresentFlag) {
            bufferDelayLengthMinus1 = readBits(data, startBit + bitOffset, startBit + bitOffset + 5);
            bitOffset += 5;
            bitOffset += 32;
            bitOffset += 5;
            bitOffset += 5;
          }
          const operatingPointsCntMinus1 = readBits(data, startBit + bitOffset, startBit + bitOffset + 5);
          bitOffset += 5;
          for (let i = 0; i <= operatingPointsCntMinus1; i++) {
            bitOffset += 12;
            const seqLevelIdx = readBits(data, startBit + bitOffset, startBit + bitOffset + 5);
            bitOffset += 5;
            if (i === 0) {
              seqLevel = seqLevelIdx;
            }
            if (seqLevelIdx > 7) {
              const seqTierTemp = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
              bitOffset += 1;
              if (i === 0) {
                seqTier = seqTierTemp;
              }
            }
            if (decoderModelInfoPresentFlag) {
              const decoderModelPresentForThisOp = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
              bitOffset += 1;
              if (decoderModelPresentForThisOp) {
                const n = bufferDelayLengthMinus1 + 1;
                bitOffset += n;
                bitOffset += n;
                bitOffset += 1;
              }
            }
            const initialDisplayDelayPresentFlag = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
            bitOffset += 1;
            if (initialDisplayDelayPresentFlag) {
              bitOffset += 4;
            }
          }
        }
        const highBitdepth = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
        bitOffset += 1;
        let bitDepth = 8;
        if (seqProfile === 2 && highBitdepth) {
          const twelveBit = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
          bitOffset += 1;
          bitDepth = twelveBit ? 12 : 10;
        } else if (seqProfile <= 2) {
          bitDepth = highBitdepth ? 10 : 8;
        }
        let monochrome = 0;
        if (seqProfile !== 1) {
          monochrome = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
          bitOffset += 1;
        }
        let chromaSubsamplingX = 1;
        let chromaSubsamplingY = 1;
        let chromaSamplePosition = 0;
        if (!monochrome) {
          if (seqProfile === 0) {
            chromaSubsamplingX = 1;
            chromaSubsamplingY = 1;
          } else if (seqProfile === 1) {
            chromaSubsamplingX = 0;
            chromaSubsamplingY = 0;
          } else {
            if (bitDepth === 12) {
              chromaSubsamplingX = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
              bitOffset += 1;
              if (chromaSubsamplingX) {
                chromaSubsamplingY = readBits(data, startBit + bitOffset, startBit + bitOffset + 1);
                bitOffset += 1;
              }
            }
          }
          if (chromaSubsamplingX && chromaSubsamplingY) {
            chromaSamplePosition = readBits(data, startBit + bitOffset, startBit + bitOffset + 2);
            bitOffset += 2;
          }
        }
        return {
          profile: seqProfile,
          level: seqLevel,
          tier: seqTier,
          bitDepth,
          monochrome,
          chromaSubsamplingX,
          chromaSubsamplingY,
          chromaSamplePosition
        };
      }
      offset += obuSize;
    }
    return null;
  };
  var buildAudioCodecString = (codec, numberOfChannels, sampleRate) => {
    if (codec === "aac") {
      if (numberOfChannels >= 2 && sampleRate <= 24e3) {
        return "mp4a.40.29";
      }
      if (sampleRate <= 24e3) {
        return "mp4a.40.5";
      }
      return "mp4a.40.2";
    } else if (codec === "mp3") {
      return "mp3";
    } else if (codec === "opus") {
      return "opus";
    } else if (codec === "vorbis") {
      return "vorbis";
    } else if (codec === "flac") {
      return "flac";
    } else if (PCM_AUDIO_CODECS.includes(codec)) {
      return codec;
    }
    throw new TypeError(`Unhandled codec '${codec}'.`);
  };
  var extractAudioCodecString = (trackInfo) => {
    const { codec, codecDescription, aacCodecInfo } = trackInfo;
    if (codec === "aac") {
      if (!aacCodecInfo) {
        throw new TypeError("AAC codec info must be provided.");
      }
      if (aacCodecInfo.isMpeg2) {
        return "mp4a.67";
      } else {
        const audioSpecificConfig = parseAacAudioSpecificConfig(codecDescription);
        return `mp4a.40.${audioSpecificConfig.objectType}`;
      }
    } else if (codec === "mp3") {
      return "mp3";
    } else if (codec === "opus") {
      return "opus";
    } else if (codec === "vorbis") {
      return "vorbis";
    } else if (codec === "flac") {
      return "flac";
    } else if (codec && PCM_AUDIO_CODECS.includes(codec)) {
      return codec;
    }
    throw new TypeError(`Unhandled codec '${codec}'.`);
  };
  var parseAacAudioSpecificConfig = (bytes2) => {
    if (!bytes2 || bytes2.byteLength < 2) {
      throw new TypeError("AAC description must be at least 2 bytes long.");
    }
    let bitOffset = 0;
    let objectType = readBits(bytes2, bitOffset, bitOffset + 5);
    bitOffset += 5;
    if (objectType === 31) {
      objectType = 32 + readBits(bytes2, bitOffset, bitOffset + 6);
      bitOffset += 6;
    }
    const frequencyIndex = readBits(bytes2, bitOffset, bitOffset + 4);
    bitOffset += 4;
    let sampleRate = null;
    if (frequencyIndex === 15) {
      sampleRate = readBits(bytes2, bitOffset, bitOffset + 24);
      bitOffset += 24;
    } else {
      const freqTable = [
        96e3,
        88200,
        64e3,
        48e3,
        44100,
        32e3,
        24e3,
        22050,
        16e3,
        12e3,
        11025,
        8e3,
        7350
      ];
      if (frequencyIndex < freqTable.length) {
        sampleRate = freqTable[frequencyIndex];
      }
    }
    const channelConfiguration = readBits(bytes2, bitOffset, bitOffset + 4);
    bitOffset += 4;
    let numberOfChannels = null;
    if (channelConfiguration >= 1 && channelConfiguration <= 7) {
      const channelMap = {
        1: 1,
        2: 2,
        3: 3,
        4: 4,
        5: 5,
        6: 6,
        7: 8
      };
      numberOfChannels = channelMap[channelConfiguration];
    }
    return {
      objectType,
      frequencyIndex,
      sampleRate,
      channelConfiguration,
      numberOfChannels
    };
  };
  var parseOpusIdentificationHeader = (bytes2) => {
    const view2 = toDataView(bytes2);
    const outputChannelCount = view2.getUint8(9);
    const preSkip = view2.getUint16(10, true);
    const inputSampleRate = view2.getUint32(12, true);
    const outputGain = view2.getInt16(16, true);
    const channelMappingFamily = view2.getUint8(18);
    let channelMappingTable = null;
    if (channelMappingFamily) {
      channelMappingTable = bytes2.subarray(19, 19 + 2 + outputChannelCount);
    }
    return {
      outputChannelCount,
      preSkip,
      inputSampleRate,
      outputGain,
      channelMappingFamily,
      channelMappingTable
    };
  };
  var OPUS_INTERNAL_SAMPLE_RATE = 48e3;
  var OPUS_FRAME_DURATION_TABLE = [
    480,
    960,
    1920,
    2880,
    480,
    960,
    1920,
    2880,
    480,
    960,
    1920,
    2880,
    480,
    960,
    480,
    960,
    120,
    240,
    480,
    960,
    120,
    240,
    480,
    960,
    120,
    240,
    480,
    960,
    120,
    240,
    480,
    960
  ];
  var parseOpusTocByte = (packet) => {
    const config = packet[0] >> 3;
    return {
      durationInSamples: OPUS_FRAME_DURATION_TABLE[config]
    };
  };
  var PCM_CODEC_REGEX = /^pcm-([usf])(\d+)+(be)?$/;
  var parsePcmCodec = (codec) => {
    assert(PCM_AUDIO_CODECS.includes(codec));
    if (codec === "ulaw") {
      return { dataType: "ulaw", sampleSize: 1, littleEndian: true, silentValue: 255 };
    } else if (codec === "alaw") {
      return { dataType: "alaw", sampleSize: 1, littleEndian: true, silentValue: 213 };
    }
    const match = PCM_CODEC_REGEX.exec(codec);
    assert(match);
    let dataType;
    if (match[1] === "u") {
      dataType = "unsigned";
    } else if (match[1] === "s") {
      dataType = "signed";
    } else {
      dataType = "float";
    }
    const sampleSize = Number(match[2]) / 8;
    const littleEndian = match[3] !== "be";
    const silentValue = codec === "pcm-u8" ? 2 ** 7 : 0;
    return { dataType, sampleSize, littleEndian, silentValue };
  };
  var getVideoEncoderConfigExtension = (codec) => {
    if (codec === "avc") {
      return {
        avc: {
          format: "avc"
          // Ensure the format is not Annex B
        }
      };
    } else if (codec === "hevc") {
      return {
        hevc: {
          format: "hevc"
          // Ensure the format is not Annex B
        }
      };
    }
    return {};
  };
  var getAudioEncoderConfigExtension = (codec) => {
    if (codec === "aac") {
      return {
        aac: {
          format: "aac"
          // Ensure the format is not ADTS
        }
      };
    } else if (codec === "opus") {
      return {
        opus: {
          format: "opus"
        }
      };
    }
    return {};
  };
  var Quality = class {
    /** @internal */
    constructor(factor) {
      this._factor = factor;
    }
    /** @internal */
    _toVideoBitrate(codec, width, height) {
      const pixels = width * height;
      const codecEfficiencyFactors = {
        avc: 1,
        // H.264/AVC (baseline)
        hevc: 0.6,
        // H.265/HEVC (~40% more efficient than AVC)
        vp9: 0.6,
        // Similar to HEVC
        av1: 0.4,
        // ~60% more efficient than AVC
        vp8: 1.2
        // Slightly less efficient than AVC
      };
      const getBaseBitrateForPixels = (pixelCount) => {
        const referencePixels = 1920 * 1080;
        const referenceBitrate = 2e6;
        const scaleFactor = Math.pow(pixelCount / referencePixels, 0.75);
        return referenceBitrate * scaleFactor;
      };
      const baseBitrate = getBaseBitrateForPixels(pixels);
      const codecAdjustedBitrate = baseBitrate * codecEfficiencyFactors[codec];
      const finalBitrate = codecAdjustedBitrate * this._factor;
      return Math.ceil(finalBitrate / 1e3) * 1e3;
    }
    /** @internal */
    _toAudioBitrate(codec) {
      if (PCM_AUDIO_CODECS.includes(codec) || codec === "flac") {
        return -1;
      }
      const baseRates = {
        aac: 128e3,
        // 128kbps base for AAC
        opus: 64e3,
        // 64kbps base for Opus
        mp3: 16e4,
        // 160kbps base for MP3
        vorbis: 64e3
        // 64kbps base for Vorbis
      };
      const baseBitrate = baseRates[codec];
      if (!baseBitrate) {
        throw new Error(`Unhandled codec: ${codec}`);
      }
      let finalBitrate = baseBitrate * this._factor;
      if (codec === "aac") {
        const validRates = [96e3, 128e3, 16e4, 192e3];
        finalBitrate = validRates.reduce(
          (prev, curr) => Math.abs(curr - finalBitrate) < Math.abs(prev - finalBitrate) ? curr : prev
        );
      } else if (codec === "opus" || codec === "vorbis") {
        finalBitrate = Math.max(6e3, finalBitrate);
      } else if (codec === "mp3") {
        const validRates = [
          8e3,
          16e3,
          24e3,
          32e3,
          4e4,
          48e3,
          64e3,
          8e4,
          96e3,
          112e3,
          128e3,
          16e4,
          192e3,
          224e3,
          256e3,
          32e4
        ];
        finalBitrate = validRates.reduce(
          (prev, curr) => Math.abs(curr - finalBitrate) < Math.abs(prev - finalBitrate) ? curr : prev
        );
      }
      return Math.round(finalBitrate / 1e3) * 1e3;
    }
  };
  var QUALITY_VERY_LOW = new Quality(0.4);
  var QUALITY_LOW = new Quality(0.6);
  var QUALITY_MEDIUM = new Quality(1);
  var QUALITY_HIGH = new Quality(2);
  var QUALITY_VERY_HIGH = new Quality(4);
  var VALID_VIDEO_CODEC_STRING_PREFIXES = ["avc1", "avc3", "hev1", "hvc1", "vp8", "vp09", "av01"];
  var AVC_CODEC_STRING_REGEX = /^(avc1|avc3)\.[0-9a-fA-F]{6}$/;
  var HEVC_CODEC_STRING_REGEX = /^(hev1|hvc1)\.(?:[ABC]?\d+)\.[0-9a-fA-F]{1,8}\.[LH]\d+(?:\.[0-9a-fA-F]{1,2}){0,6}$/;
  var VP9_CODEC_STRING_REGEX = /^vp09(?:\.\d{2}){3}(?:(?:\.\d{2}){5})?$/;
  var AV1_CODEC_STRING_REGEX = /^av01\.\d\.\d{2}[MH]\.\d{2}(?:\.\d\.\d{3}\.\d{2}\.\d{2}\.\d{2}\.\d)?$/;
  var validateVideoChunkMetadata = (metadata) => {
    if (!metadata) {
      throw new TypeError("Video chunk metadata must be provided.");
    }
    if (typeof metadata !== "object") {
      throw new TypeError("Video chunk metadata must be an object.");
    }
    if (!metadata.decoderConfig) {
      throw new TypeError("Video chunk metadata must include a decoder configuration.");
    }
    if (typeof metadata.decoderConfig !== "object") {
      throw new TypeError("Video chunk metadata decoder configuration must be an object.");
    }
    if (typeof metadata.decoderConfig.codec !== "string") {
      throw new TypeError("Video chunk metadata decoder configuration must specify a codec string.");
    }
    if (!VALID_VIDEO_CODEC_STRING_PREFIXES.some((prefix) => metadata.decoderConfig.codec.startsWith(prefix))) {
      throw new TypeError(
        "Video chunk metadata decoder configuration codec string must be a valid video codec string as specified in the WebCodecs codec registry."
      );
    }
    if (!Number.isInteger(metadata.decoderConfig.codedWidth) || metadata.decoderConfig.codedWidth <= 0) {
      throw new TypeError(
        "Video chunk metadata decoder configuration must specify a valid codedWidth (positive integer)."
      );
    }
    if (!Number.isInteger(metadata.decoderConfig.codedHeight) || metadata.decoderConfig.codedHeight <= 0) {
      throw new TypeError(
        "Video chunk metadata decoder configuration must specify a valid codedHeight (positive integer)."
      );
    }
    if (metadata.decoderConfig.description !== void 0) {
      if (!isAllowSharedBufferSource(metadata.decoderConfig.description)) {
        throw new TypeError(
          "Video chunk metadata decoder configuration description, when defined, must be an ArrayBuffer or an ArrayBuffer view."
        );
      }
    }
    if (metadata.decoderConfig.colorSpace !== void 0) {
      const { colorSpace } = metadata.decoderConfig;
      if (typeof colorSpace !== "object") {
        throw new TypeError(
          "Video chunk metadata decoder configuration colorSpace, when provided, must be an object."
        );
      }
      const primariesValues = Object.keys(COLOR_PRIMARIES_MAP);
      if (colorSpace.primaries != null && !primariesValues.includes(colorSpace.primaries)) {
        throw new TypeError(
          `Video chunk metadata decoder configuration colorSpace primaries, when defined, must be one of ${primariesValues.join(", ")}.`
        );
      }
      const transferValues = Object.keys(TRANSFER_CHARACTERISTICS_MAP);
      if (colorSpace.transfer != null && !transferValues.includes(colorSpace.transfer)) {
        throw new TypeError(
          `Video chunk metadata decoder configuration colorSpace transfer, when defined, must be one of ${transferValues.join(", ")}.`
        );
      }
      const matrixValues = Object.keys(MATRIX_COEFFICIENTS_MAP);
      if (colorSpace.matrix != null && !matrixValues.includes(colorSpace.matrix)) {
        throw new TypeError(
          `Video chunk metadata decoder configuration colorSpace matrix, when defined, must be one of ${matrixValues.join(", ")}.`
        );
      }
      if (colorSpace.fullRange != null && typeof colorSpace.fullRange !== "boolean") {
        throw new TypeError(
          "Video chunk metadata decoder configuration colorSpace fullRange, when defined, must be a boolean."
        );
      }
    }
    if (metadata.decoderConfig.codec.startsWith("avc1") || metadata.decoderConfig.codec.startsWith("avc3")) {
      if (!AVC_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
        throw new TypeError(
          "Video chunk metadata decoder configuration codec string for AVC must be a valid AVC codec string as specified in Section 3.4 of RFC 6381."
        );
      }
      if (!metadata.decoderConfig.description) {
        throw new TypeError(
          "Video chunk metadata decoder configuration for AVC must include a description, which is expected to be an AVCDecoderConfigurationRecord as specified in ISO 14496-15."
        );
      }
    }
    if (metadata.decoderConfig.codec.startsWith("hev1") || metadata.decoderConfig.codec.startsWith("hvc1")) {
      if (!HEVC_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
        throw new TypeError(
          "Video chunk metadata decoder configuration codec string for HEVC must be a valid HEVC codec string as specified in Section E.3 of ISO 14496-15."
        );
      }
      if (!metadata.decoderConfig.description) {
        throw new TypeError(
          "Video chunk metadata decoder configuration for HEVC must include a description, which is expected to be an HEVCDecoderConfigurationRecord as specified in ISO 14496-15."
        );
      }
    }
    if (metadata.decoderConfig.codec.startsWith("vp8")) {
      if (metadata.decoderConfig.codec !== "vp8") {
        throw new TypeError('Video chunk metadata decoder configuration codec string for VP8 must be "vp8".');
      }
    }
    if (metadata.decoderConfig.codec.startsWith("vp09")) {
      if (!VP9_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
        throw new TypeError(
          'Video chunk metadata decoder configuration codec string for VP9 must be a valid VP9 codec string as specified in Section "Codecs Parameter String" of https://www.webmproject.org/vp9/mp4/.'
        );
      }
    }
    if (metadata.decoderConfig.codec.startsWith("av01")) {
      if (!AV1_CODEC_STRING_REGEX.test(metadata.decoderConfig.codec)) {
        throw new TypeError(
          'Video chunk metadata decoder configuration codec string for AV1 must be a valid AV1 codec string as specified in Section "Codecs Parameter String" of https://aomediacodec.github.io/av1-isobmff/.'
        );
      }
    }
  };
  var VALID_AUDIO_CODEC_STRING_PREFIXES = ["mp4a", "mp3", "opus", "vorbis", "flac", "ulaw", "alaw", "pcm"];
  var validateAudioChunkMetadata = (metadata) => {
    if (!metadata) {
      throw new TypeError("Audio chunk metadata must be provided.");
    }
    if (typeof metadata !== "object") {
      throw new TypeError("Audio chunk metadata must be an object.");
    }
    if (!metadata.decoderConfig) {
      throw new TypeError("Audio chunk metadata must include a decoder configuration.");
    }
    if (typeof metadata.decoderConfig !== "object") {
      throw new TypeError("Audio chunk metadata decoder configuration must be an object.");
    }
    if (typeof metadata.decoderConfig.codec !== "string") {
      throw new TypeError("Audio chunk metadata decoder configuration must specify a codec string.");
    }
    if (!VALID_AUDIO_CODEC_STRING_PREFIXES.some((prefix) => metadata.decoderConfig.codec.startsWith(prefix))) {
      throw new TypeError(
        "Audio chunk metadata decoder configuration codec string must be a valid audio codec string as specified in the WebCodecs codec registry."
      );
    }
    if (!Number.isInteger(metadata.decoderConfig.sampleRate) || metadata.decoderConfig.sampleRate <= 0) {
      throw new TypeError(
        "Audio chunk metadata decoder configuration must specify a valid sampleRate (positive integer)."
      );
    }
    if (!Number.isInteger(metadata.decoderConfig.numberOfChannels) || metadata.decoderConfig.numberOfChannels <= 0) {
      throw new TypeError(
        "Audio chunk metadata decoder configuration must specify a valid numberOfChannels (positive integer)."
      );
    }
    if (metadata.decoderConfig.description !== void 0) {
      if (!isAllowSharedBufferSource(metadata.decoderConfig.description)) {
        throw new TypeError(
          "Audio chunk metadata decoder configuration description, when defined, must be an ArrayBuffer or an ArrayBuffer view."
        );
      }
    }
    if (metadata.decoderConfig.codec.startsWith("mp4a")) {
      const validStrings = ["mp4a.40.2", "mp4a.40.02", "mp4a.40.5", "mp4a.40.05", "mp4a.40.29", "mp4a.67"];
      if (!validStrings.includes(metadata.decoderConfig.codec)) {
        throw new TypeError(
          "Audio chunk metadata decoder configuration codec string for AAC must be a valid AAC codec string as specified in https://www.w3.org/TR/webcodecs-aac-codec-registration/."
        );
      }
      if (!metadata.decoderConfig.description) {
        throw new TypeError(
          "Audio chunk metadata decoder configuration for AAC must include a description, which is expected to be an AudioSpecificConfig as specified in ISO 14496-3."
        );
      }
    }
    if (metadata.decoderConfig.codec === "mp3") {
      if (metadata.decoderConfig.codec !== "mp3") {
        throw new TypeError('Audio chunk metadata decoder configuration codec string for MP3 must be "mp3".');
      }
    }
    if (metadata.decoderConfig.codec === "opus") {
      if (metadata.decoderConfig.codec !== "opus") {
        throw new TypeError('Audio chunk metadata decoder configuration codec string for Opus must be "opus".');
      }
      if (metadata.decoderConfig.description && metadata.decoderConfig.description.byteLength < 18) {
        throw new TypeError(
          "Audio chunk metadata decoder configuration description, when specified, is expected to be an Identification Header as specified in Section 5.1 of RFC 7845."
        );
      }
    }
    if (metadata.decoderConfig.codec === "vorbis") {
      if (metadata.decoderConfig.codec !== "vorbis") {
        throw new TypeError('Audio chunk metadata decoder configuration codec string for Vorbis must be "vorbis".');
      }
      if (!metadata.decoderConfig.description) {
        throw new TypeError(
          "Audio chunk metadata decoder configuration for Vorbis must include a description, which is expected to adhere to the format described in https://www.w3.org/TR/webcodecs-vorbis-codec-registration/."
        );
      }
    }
    if (metadata.decoderConfig.codec === "flac") {
      if (metadata.decoderConfig.codec !== "flac") {
        throw new TypeError('Audio chunk metadata decoder configuration codec string for FLAC must be "flac".');
      }
      const minDescriptionSize = 4 + 4 + 34;
      if (!metadata.decoderConfig.description || metadata.decoderConfig.description.byteLength < minDescriptionSize) {
        throw new TypeError(
          "Audio chunk metadata decoder configuration for FLAC must include a description, which is expected to adhere to the format described in https://www.w3.org/TR/webcodecs-flac-codec-registration/."
        );
      }
    }
    if (metadata.decoderConfig.codec.startsWith("pcm") || metadata.decoderConfig.codec.startsWith("ulaw") || metadata.decoderConfig.codec.startsWith("alaw")) {
      if (!PCM_AUDIO_CODECS.includes(metadata.decoderConfig.codec)) {
        throw new TypeError(
          `Audio chunk metadata decoder configuration codec string for PCM must be one of the supported PCM codecs (${PCM_AUDIO_CODECS.join(", ")}).`
        );
      }
    }
  };
  var validateSubtitleMetadata = (metadata) => {
    if (!metadata) {
      throw new TypeError("Subtitle metadata must be provided.");
    }
    if (typeof metadata !== "object") {
      throw new TypeError("Subtitle metadata must be an object.");
    }
    if (!metadata.config) {
      throw new TypeError("Subtitle metadata must include a config object.");
    }
    if (typeof metadata.config !== "object") {
      throw new TypeError("Subtitle metadata config must be an object.");
    }
    if (typeof metadata.config.description !== "string") {
      throw new TypeError("Subtitle metadata config description must be a string.");
    }
  };
  var canEncode = (codec) => {
    if (VIDEO_CODECS.includes(codec)) {
      return canEncodeVideo(codec);
    } else if (AUDIO_CODECS.includes(codec)) {
      return canEncodeAudio(codec);
    } else if (SUBTITLE_CODECS.includes(codec)) {
      return canEncodeSubtitles(codec);
    }
    throw new TypeError(`Unknown codec '${codec}'.`);
  };
  var canEncodeVideo = async (codec, { width = 1280, height = 720, bitrate = 1e6 } = {}) => {
    if (!VIDEO_CODECS.includes(codec)) {
      return false;
    }
    if (!Number.isInteger(width) || width <= 0) {
      throw new TypeError("width must be a positive integer.");
    }
    if (!Number.isInteger(height) || height <= 0) {
      throw new TypeError("height must be a positive integer.");
    }
    if (!Number.isInteger(bitrate) || bitrate <= 0) {
      throw new TypeError("bitrate must be a positive integer.");
    }
    if (customVideoEncoders.length > 0) {
      const encoderConfig = {
        codec: buildVideoCodecString(
          codec,
          width,
          height,
          bitrate
        ),
        width,
        height,
        bitrate,
        ...getVideoEncoderConfigExtension(codec)
      };
      if (customVideoEncoders.some((x) => x.supports(codec, encoderConfig))) {
        return true;
      }
    }
    if (typeof VideoEncoder === "undefined") {
      return false;
    }
    const support = await VideoEncoder.isConfigSupported({
      codec: buildVideoCodecString(codec, width, height, bitrate),
      width,
      height,
      bitrate,
      ...getVideoEncoderConfigExtension(codec)
    });
    return support.supported === true;
  };
  var canEncodeAudio = async (codec, { numberOfChannels = 2, sampleRate = 48e3, bitrate = 128e3 } = {}) => {
    if (!AUDIO_CODECS.includes(codec)) {
      return false;
    }
    if (!Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
      throw new TypeError("numberOfChannels must be a positive integer.");
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new TypeError("sampleRate must be a positive integer.");
    }
    if (!Number.isInteger(bitrate) || bitrate <= 0) {
      throw new TypeError("bitrate must be a positive integer.");
    }
    if (customAudioEncoders.length > 0) {
      const encoderConfig = {
        codec: buildAudioCodecString(
          codec,
          numberOfChannels,
          sampleRate
        ),
        numberOfChannels,
        sampleRate,
        bitrate,
        ...getAudioEncoderConfigExtension(codec)
      };
      if (customAudioEncoders.some((x) => x.supports(codec, encoderConfig))) {
        return true;
      }
    }
    if (PCM_AUDIO_CODECS.includes(codec)) {
      return true;
    }
    if (typeof AudioEncoder === "undefined") {
      return false;
    }
    const support = await AudioEncoder.isConfigSupported({
      codec: buildAudioCodecString(codec, numberOfChannels, sampleRate),
      numberOfChannels,
      sampleRate,
      bitrate,
      ...getAudioEncoderConfigExtension(codec)
    });
    return support.supported === true;
  };
  var canEncodeSubtitles = async (codec) => {
    if (!SUBTITLE_CODECS.includes(codec)) {
      return false;
    }
    return true;
  };
  var getEncodableCodecs = async () => {
    const [videoCodecs, audioCodecs, subtitleCodecs] = await Promise.all([
      getEncodableVideoCodecs(),
      getEncodableAudioCodecs(),
      getEncodableSubtitleCodecs()
    ]);
    return [...videoCodecs, ...audioCodecs, ...subtitleCodecs];
  };
  var getEncodableVideoCodecs = async (checkedCodecs = VIDEO_CODECS, options) => {
    const bools = await Promise.all(checkedCodecs.map((codec) => canEncodeVideo(codec, options)));
    return checkedCodecs.filter((_, i) => bools[i]);
  };
  var getEncodableAudioCodecs = async (checkedCodecs = AUDIO_CODECS, options) => {
    const bools = await Promise.all(checkedCodecs.map((codec) => canEncodeAudio(codec, options)));
    return checkedCodecs.filter((_, i) => bools[i]);
  };
  var getEncodableSubtitleCodecs = async (checkedCodecs = SUBTITLE_CODECS) => {
    const bools = await Promise.all(checkedCodecs.map(canEncodeSubtitles));
    return checkedCodecs.filter((_, i) => bools[i]);
  };

  // src/subtitles.ts
  var cueBlockHeaderRegex = /(?:(.+?)\n)?((?:\d{2}:)?\d{2}:\d{2}.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}.\d{3})/g;
  var preambleStartRegex = /^WEBVTT(.|\n)*?\n{2}/;
  var inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;
  var SubtitleParser = class {
    constructor(options) {
      this.preambleText = null;
      this.preambleEmitted = false;
      this.options = options;
    }
    parse(text) {
      text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      cueBlockHeaderRegex.lastIndex = 0;
      let match;
      if (!this.preambleText) {
        if (!preambleStartRegex.test(text)) {
          throw new Error("WebVTT preamble incorrect.");
        }
        match = cueBlockHeaderRegex.exec(text);
        const preamble = text.slice(0, match?.index ?? text.length).trimEnd();
        if (!preamble) {
          throw new Error("No WebVTT preamble provided.");
        }
        this.preambleText = preamble;
        if (match) {
          text = text.slice(match.index);
          cueBlockHeaderRegex.lastIndex = 0;
        }
      }
      while (match = cueBlockHeaderRegex.exec(text)) {
        const notes = text.slice(0, match.index);
        const cueIdentifier = match[1];
        const matchEnd = match.index + match[0].length;
        const bodyStart = text.indexOf("\n", matchEnd) + 1;
        const cueSettings = text.slice(matchEnd, bodyStart).trim();
        let bodyEnd = text.indexOf("\n\n", matchEnd);
        if (bodyEnd === -1) bodyEnd = text.length;
        const startTime = parseSubtitleTimestamp(match[2]);
        const endTime = parseSubtitleTimestamp(match[3]);
        const duration = endTime - startTime;
        const body = text.slice(bodyStart, bodyEnd).trim();
        text = text.slice(bodyEnd).trimStart();
        cueBlockHeaderRegex.lastIndex = 0;
        const cue = {
          timestamp: startTime / 1e3,
          duration: duration / 1e3,
          text: body,
          identifier: cueIdentifier,
          settings: cueSettings,
          notes
        };
        const meta = {};
        if (!this.preambleEmitted) {
          meta.config = {
            description: this.preambleText
          };
          this.preambleEmitted = true;
        }
        this.options.output(cue, meta);
      }
    }
  };
  var timestampRegex = /(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})/;
  var parseSubtitleTimestamp = (string) => {
    const match = timestampRegex.exec(string);
    if (!match) throw new Error("Expected match.");
    return 60 * 60 * 1e3 * Number(match[1] || "0") + 60 * 1e3 * Number(match[2]) + 1e3 * Number(match[3]) + Number(match[4]);
  };
  var formatSubtitleTimestamp = (timestamp) => {
    const hours = Math.floor(timestamp / (60 * 60 * 1e3));
    const minutes = Math.floor(timestamp % (60 * 60 * 1e3) / (60 * 1e3));
    const seconds = Math.floor(timestamp % (60 * 1e3) / 1e3);
    const milliseconds = timestamp % 1e3;
    return hours.toString().padStart(2, "0") + ":" + minutes.toString().padStart(2, "0") + ":" + seconds.toString().padStart(2, "0") + "." + milliseconds.toString().padStart(3, "0");
  };

  // src/isobmff/isobmff-boxes.ts
  var IsobmffBoxWriter = class {
    constructor(writer) {
      this.writer = writer;
      this.helper = new Uint8Array(8);
      this.helperView = new DataView(this.helper.buffer);
      /**
       * Stores the position from the start of the file to where boxes elements have been written. This is used to
       * rewrite/edit elements that were already added before, and to measure sizes of things.
       */
      this.offsets = /* @__PURE__ */ new WeakMap();
    }
    writeU32(value) {
      this.helperView.setUint32(0, value, false);
      this.writer.write(this.helper.subarray(0, 4));
    }
    writeU64(value) {
      this.helperView.setUint32(0, Math.floor(value / 2 ** 32), false);
      this.helperView.setUint32(4, value, false);
      this.writer.write(this.helper.subarray(0, 8));
    }
    writeAscii(text) {
      for (let i = 0; i < text.length; i++) {
        this.helperView.setUint8(i % 8, text.charCodeAt(i));
        if (i % 8 === 7) this.writer.write(this.helper);
      }
      if (text.length % 8 !== 0) {
        this.writer.write(this.helper.subarray(0, text.length % 8));
      }
    }
    writeBox(box2) {
      this.offsets.set(box2, this.writer.getPos());
      if (box2.contents && !box2.children) {
        this.writeBoxHeader(box2, box2.size ?? box2.contents.byteLength + 8);
        this.writer.write(box2.contents);
      } else {
        const startPos = this.writer.getPos();
        this.writeBoxHeader(box2, 0);
        if (box2.contents) this.writer.write(box2.contents);
        if (box2.children) {
          for (const child of box2.children) if (child) this.writeBox(child);
        }
        const endPos = this.writer.getPos();
        const size = box2.size ?? endPos - startPos;
        this.writer.seek(startPos);
        this.writeBoxHeader(box2, size);
        this.writer.seek(endPos);
      }
    }
    writeBoxHeader(box2, size) {
      this.writeU32(box2.largeSize ? 1 : size);
      this.writeAscii(box2.type);
      if (box2.largeSize) this.writeU64(size);
    }
    measureBoxHeader(box2) {
      return 8 + (box2.largeSize ? 8 : 0);
    }
    patchBox(box2) {
      const boxOffset = this.offsets.get(box2);
      assert(boxOffset !== void 0);
      const endPos = this.writer.getPos();
      this.writer.seek(boxOffset);
      this.writeBox(box2);
      this.writer.seek(endPos);
    }
    measureBox(box2) {
      if (box2.contents && !box2.children) {
        const headerSize = this.measureBoxHeader(box2);
        return headerSize + box2.contents.byteLength;
      } else {
        let result = this.measureBoxHeader(box2);
        if (box2.contents) result += box2.contents.byteLength;
        if (box2.children) {
          for (const child of box2.children) if (child) result += this.measureBox(child);
        }
        return result;
      }
    }
  };
  var bytes = new Uint8Array(8);
  var view = new DataView(bytes.buffer);
  var u8 = (value) => {
    return [(value % 256 + 256) % 256];
  };
  var u16 = (value) => {
    view.setUint16(0, value, false);
    return [bytes[0], bytes[1]];
  };
  var i16 = (value) => {
    view.setInt16(0, value, false);
    return [bytes[0], bytes[1]];
  };
  var u24 = (value) => {
    view.setUint32(0, value, false);
    return [bytes[1], bytes[2], bytes[3]];
  };
  var u32 = (value) => {
    view.setUint32(0, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var i32 = (value) => {
    view.setInt32(0, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var u64 = (value) => {
    view.setUint32(0, Math.floor(value / 2 ** 32), false);
    view.setUint32(4, value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]];
  };
  var fixed_8_8 = (value) => {
    view.setInt16(0, 2 ** 8 * value, false);
    return [bytes[0], bytes[1]];
  };
  var fixed_16_16 = (value) => {
    view.setInt32(0, 2 ** 16 * value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var fixed_2_30 = (value) => {
    view.setInt32(0, 2 ** 30 * value, false);
    return [bytes[0], bytes[1], bytes[2], bytes[3]];
  };
  var variableUnsignedInt = (value, byteLength) => {
    const bytes2 = [];
    let remaining = value;
    do {
      let byte = remaining & 127;
      remaining >>= 7;
      if (bytes2.length > 0) {
        byte |= 128;
      }
      bytes2.push(byte);
      if (byteLength !== void 0) {
        byteLength--;
      }
    } while (remaining > 0 || byteLength);
    return bytes2.reverse();
  };
  var ascii = (text, nullTerminated = false) => {
    const bytes2 = Array(text.length).fill(null).map((_, i) => text.charCodeAt(i));
    if (nullTerminated) bytes2.push(0);
    return bytes2;
  };
  var lastPresentedSample = (samples) => {
    let result = null;
    for (const sample of samples) {
      if (!result || sample.timestamp > result.timestamp) {
        result = sample;
      }
    }
    return result;
  };
  var rotationMatrix = (rotationInDegrees) => {
    const theta = rotationInDegrees * (Math.PI / 180);
    const cosTheta = Math.round(Math.cos(theta));
    const sinTheta = Math.round(Math.sin(theta));
    return [
      cosTheta,
      sinTheta,
      0,
      -sinTheta,
      cosTheta,
      0,
      0,
      0,
      1
    ];
  };
  var IDENTITY_MATRIX = rotationMatrix(0);
  var matrixToBytes = (matrix) => {
    return [
      fixed_16_16(matrix[0]),
      fixed_16_16(matrix[1]),
      fixed_2_30(matrix[2]),
      fixed_16_16(matrix[3]),
      fixed_16_16(matrix[4]),
      fixed_2_30(matrix[5]),
      fixed_16_16(matrix[6]),
      fixed_16_16(matrix[7]),
      fixed_2_30(matrix[8])
    ];
  };
  var box = (type, contents, children) => ({
    type,
    contents: contents && new Uint8Array(contents.flat(10)),
    children
  });
  var fullBox = (type, version, flags, contents, children) => box(
    type,
    [u8(version), u24(flags), contents ?? []],
    children
  );
  var ftyp = (details) => {
    const minorVersion = 512;
    if (details.isMov) {
      return box("ftyp", [
        ascii("qt  "),
        // Major brand
        u32(minorVersion),
        // Minor version
        // Compatible brands
        ascii("qt  ")
      ]);
    }
    if (details.fragmented) {
      return box("ftyp", [
        ascii("iso5"),
        // Major brand
        u32(minorVersion),
        // Minor version
        // Compatible brands
        ascii("iso5"),
        ascii("iso6"),
        ascii("mp41")
      ]);
    }
    return box("ftyp", [
      ascii("isom"),
      // Major brand
      u32(minorVersion),
      // Minor version
      // Compatible brands
      ascii("isom"),
      details.holdsAvc ? ascii("avc1") : [],
      ascii("mp41")
    ]);
  };
  var mdat = (reserveLargeSize) => ({ type: "mdat", largeSize: reserveLargeSize });
  var free = (size) => ({ type: "free", size });
  var moov = (trackDatas, creationTime, fragmented = false) => box("moov", void 0, [
    mvhd(creationTime, trackDatas),
    ...trackDatas.map((x) => trak(x, creationTime)),
    fragmented ? mvex(trackDatas) : null
  ]);
  var mvhd = (creationTime, trackDatas) => {
    const duration = intoTimescale(Math.max(
      0,
      ...trackDatas.filter((x) => x.samples.length > 0).map((x) => {
        const lastSample = lastPresentedSample(x.samples);
        return lastSample.timestamp + lastSample.duration;
      })
    ), GLOBAL_TIMESCALE);
    const nextTrackId = Math.max(0, ...trackDatas.map((x) => x.track.id)) + 1;
    const needsU64 = !isU32(creationTime) || !isU32(duration);
    const u32OrU64 = needsU64 ? u64 : u32;
    return fullBox("mvhd", +needsU64, 0, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(GLOBAL_TIMESCALE),
      // Timescale
      u32OrU64(duration),
      // Duration
      fixed_16_16(1),
      // Preferred rate
      fixed_8_8(1),
      // Preferred volume
      Array(10).fill(0),
      // Reserved
      matrixToBytes(IDENTITY_MATRIX),
      // Matrix
      Array(24).fill(0),
      // Pre-defined
      u32(nextTrackId)
      // Next track ID
    ]);
  };
  var trak = (trackData, creationTime) => box("trak", void 0, [
    tkhd(trackData, creationTime),
    mdia(trackData, creationTime)
  ]);
  var tkhd = (trackData, creationTime) => {
    const lastSample = lastPresentedSample(trackData.samples);
    const durationInGlobalTimescale = intoTimescale(
      lastSample ? lastSample.timestamp + lastSample.duration : 0,
      GLOBAL_TIMESCALE
    );
    const needsU64 = !isU32(creationTime) || !isU32(durationInGlobalTimescale);
    const u32OrU64 = needsU64 ? u64 : u32;
    let matrix;
    if (trackData.type === "video") {
      const rotation = trackData.track.metadata.rotation;
      matrix = rotationMatrix(rotation ?? 0);
    } else {
      matrix = IDENTITY_MATRIX;
    }
    return fullBox("tkhd", +needsU64, 3, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(trackData.track.id),
      // Track ID
      u32(0),
      // Reserved
      u32OrU64(durationInGlobalTimescale),
      // Duration
      Array(8).fill(0),
      // Reserved
      u16(0),
      // Layer
      u16(trackData.track.id),
      // Alternate group
      fixed_8_8(trackData.type === "audio" ? 1 : 0),
      // Volume
      u16(0),
      // Reserved
      matrixToBytes(matrix),
      // Matrix
      fixed_16_16(trackData.type === "video" ? trackData.info.width : 0),
      // Track width
      fixed_16_16(trackData.type === "video" ? trackData.info.height : 0)
      // Track height
    ]);
  };
  var mdia = (trackData, creationTime) => box("mdia", void 0, [
    mdhd(trackData, creationTime),
    hdlr(trackData),
    minf(trackData)
  ]);
  var mdhd = (trackData, creationTime) => {
    const lastSample = lastPresentedSample(trackData.samples);
    const localDuration = intoTimescale(
      lastSample ? lastSample.timestamp + lastSample.duration : 0,
      trackData.timescale
    );
    const needsU64 = !isU32(creationTime) || !isU32(localDuration);
    const u32OrU64 = needsU64 ? u64 : u32;
    let language = 0;
    for (const character of trackData.track.metadata.languageCode ?? UNDETERMINED_LANGUAGE) {
      language <<= 5;
      language += character.charCodeAt(0) - 96;
    }
    return fullBox("mdhd", +needsU64, 0, [
      u32OrU64(creationTime),
      // Creation time
      u32OrU64(creationTime),
      // Modification time
      u32(trackData.timescale),
      // Timescale
      u32OrU64(localDuration),
      // Duration
      u16(language),
      // Language
      u16(0)
      // Quality
    ]);
  };
  var TRACK_TYPE_TO_COMPONENT_SUBTYPE = {
    video: "vide",
    audio: "soun",
    subtitle: "text"
  };
  var TRACK_TYPE_TO_HANDLER_NAME = {
    video: "VideoHandler",
    audio: "SoundHandler",
    subtitle: "TextHandler"
  };
  var hdlr = (trackData) => fullBox("hdlr", 0, 0, [
    ascii("mhlr"),
    // Component type
    ascii(TRACK_TYPE_TO_COMPONENT_SUBTYPE[trackData.type]),
    // Component subtype
    u32(0),
    // Component manufacturer
    u32(0),
    // Component flags
    u32(0),
    // Component flags mask
    ascii(TRACK_TYPE_TO_HANDLER_NAME[trackData.type], true)
    // Component name
  ]);
  var minf = (trackData) => box("minf", void 0, [
    TRACK_TYPE_TO_HEADER_BOX[trackData.type](),
    dinf(),
    stbl(trackData)
  ]);
  var vmhd = () => fullBox("vmhd", 0, 1, [
    u16(0),
    // Graphics mode
    u16(0),
    // Opcolor R
    u16(0),
    // Opcolor G
    u16(0)
    // Opcolor B
  ]);
  var smhd = () => fullBox("smhd", 0, 0, [
    u16(0),
    // Balance
    u16(0)
    // Reserved
  ]);
  var nmhd = () => fullBox("nmhd", 0, 0);
  var TRACK_TYPE_TO_HEADER_BOX = {
    video: vmhd,
    audio: smhd,
    subtitle: nmhd
  };
  var dinf = () => box("dinf", void 0, [
    dref()
  ]);
  var dref = () => fullBox("dref", 0, 0, [
    u32(1)
    // Entry count
  ], [
    url()
  ]);
  var url = () => fullBox("url ", 0, 1);
  var stbl = (trackData) => {
    const needsCtts = trackData.compositionTimeOffsetTable.length > 1 || trackData.compositionTimeOffsetTable.some((x) => x.sampleCompositionTimeOffset !== 0);
    return box("stbl", void 0, [
      stsd(trackData),
      stts(trackData),
      needsCtts ? ctts(trackData) : null,
      needsCtts ? cslg(trackData) : null,
      stsc(trackData),
      stsz(trackData),
      stco(trackData),
      stss(trackData)
    ]);
  };
  var stsd = (trackData) => {
    let sampleDescription;
    if (trackData.type === "video") {
      sampleDescription = videoSampleDescription(
        VIDEO_CODEC_TO_BOX_NAME[trackData.track.source._codec],
        trackData
      );
    } else if (trackData.type === "audio") {
      const boxName = AUDIO_CODEC_TO_BOX_NAME[trackData.track.source._codec];
      assert(boxName);
      sampleDescription = soundSampleDescription(
        boxName,
        trackData
      );
    } else if (trackData.type === "subtitle") {
      sampleDescription = subtitleSampleDescription(
        SUBTITLE_CODEC_TO_BOX_NAME[trackData.track.source._codec],
        trackData
      );
    }
    assert(sampleDescription);
    return fullBox("stsd", 0, 0, [
      u32(1)
      // Entry count
    ], [
      sampleDescription
    ]);
  };
  var videoSampleDescription = (compressionType, trackData) => box(compressionType, [
    Array(6).fill(0),
    // Reserved
    u16(1),
    // Data reference index
    u16(0),
    // Pre-defined
    u16(0),
    // Reserved
    Array(12).fill(0),
    // Pre-defined
    u16(trackData.info.width),
    // Width
    u16(trackData.info.height),
    // Height
    u32(4718592),
    // Horizontal resolution
    u32(4718592),
    // Vertical resolution
    u32(0),
    // Reserved
    u16(1),
    // Frame count
    Array(32).fill(0),
    // Compressor name
    u16(24),
    // Depth
    i16(65535)
    // Pre-defined
  ], [
    VIDEO_CODEC_TO_CONFIGURATION_BOX[trackData.track.source._codec](trackData),
    colorSpaceIsComplete(trackData.info.decoderConfig.colorSpace) ? colr(trackData) : null
  ]);
  var colr = (trackData) => box("colr", [
    ascii("nclx"),
    // Colour type
    u16(COLOR_PRIMARIES_MAP[trackData.info.decoderConfig.colorSpace.primaries]),
    // Colour primaries
    u16(TRANSFER_CHARACTERISTICS_MAP[trackData.info.decoderConfig.colorSpace.transfer]),
    // Transfer characteristics
    u16(MATRIX_COEFFICIENTS_MAP[trackData.info.decoderConfig.colorSpace.matrix]),
    // Matrix coefficients
    u8((trackData.info.decoderConfig.colorSpace.fullRange ? 1 : 0) << 7)
    // Full range flag
  ]);
  var avcC = (trackData) => trackData.info.decoderConfig && box("avcC", [
    // For AVC, description is an AVCDecoderConfigurationRecord, so nothing else to do here
    ...toUint8Array(trackData.info.decoderConfig.description)
  ]);
  var hvcC = (trackData) => trackData.info.decoderConfig && box("hvcC", [
    // For HEVC, description is an HEVCDecoderConfigurationRecord, so nothing else to do here
    ...toUint8Array(trackData.info.decoderConfig.description)
  ]);
  var vpcC = (trackData) => {
    if (!trackData.info.decoderConfig) {
      return null;
    }
    const decoderConfig = trackData.info.decoderConfig;
    const parts = decoderConfig.codec.split(".");
    const profile = Number(parts[1]);
    const level = Number(parts[2]);
    const bitDepth = Number(parts[3]);
    const chromaSubsampling = parts[4] ? Number(parts[4]) : 1;
    const videoFullRangeFlag = parts[8] ? Number(parts[8]) : Number(decoderConfig.colorSpace?.fullRange ?? 0);
    const thirdByte = (bitDepth << 4) + (chromaSubsampling << 1) + videoFullRangeFlag;
    const colourPrimaries = parts[5] ? Number(parts[5]) : decoderConfig.colorSpace?.primaries ? COLOR_PRIMARIES_MAP[decoderConfig.colorSpace.primaries] : 2;
    const transferCharacteristics = parts[6] ? Number(parts[6]) : decoderConfig.colorSpace?.transfer ? TRANSFER_CHARACTERISTICS_MAP[decoderConfig.colorSpace.transfer] : 2;
    const matrixCoefficients = parts[7] ? Number(parts[7]) : decoderConfig.colorSpace?.matrix ? MATRIX_COEFFICIENTS_MAP[decoderConfig.colorSpace.matrix] : 2;
    return fullBox("vpcC", 1, 0, [
      u8(profile),
      // Profile
      u8(level),
      // Level
      u8(thirdByte),
      // Bit depth, chroma subsampling, full range
      u8(colourPrimaries),
      // Colour primaries
      u8(transferCharacteristics),
      // Transfer characteristics
      u8(matrixCoefficients),
      // Matrix coefficients
      u16(0)
      // Codec initialization data size
    ]);
  };
  var av1C = (trackData) => {
    return box("av1C", generateAv1CodecConfigurationFromCodecString(trackData.info.decoderConfig.codec));
  };
  var soundSampleDescription = (compressionType, trackData) => {
    let version = 0;
    let contents;
    let sampleSizeInBits = 16;
    if (PCM_AUDIO_CODECS.includes(trackData.track.source._codec)) {
      const codec = trackData.track.source._codec;
      const { sampleSize } = parsePcmCodec(codec);
      sampleSizeInBits = 8 * sampleSize;
      if (sampleSizeInBits > 16) {
        version = 1;
      }
    }
    if (version === 0) {
      contents = [
        Array(6).fill(0),
        // Reserved
        u16(1),
        // Data reference index
        u16(version),
        // Version
        u16(0),
        // Revision level
        u32(0),
        // Vendor
        u16(trackData.info.numberOfChannels),
        // Number of channels
        u16(sampleSizeInBits),
        // Sample size (bits)
        u16(0),
        // Compression ID
        u16(0),
        // Packet size
        u16(trackData.info.sampleRate < 2 ** 16 ? trackData.info.sampleRate : 0),
        // Sample rate (upper)
        u16(0)
        // Sample rate (lower)
      ];
    } else {
      contents = [
        Array(6).fill(0),
        // Reserved
        u16(1),
        // Data reference index
        u16(version),
        // Version
        u16(0),
        // Revision level
        u32(0),
        // Vendor
        u16(trackData.info.numberOfChannels),
        // Number of channels
        u16(Math.min(sampleSizeInBits, 16)),
        // Sample size (bits)
        u16(0),
        // Compression ID
        u16(0),
        // Packet size
        u16(trackData.info.sampleRate < 2 ** 16 ? trackData.info.sampleRate : 0),
        // Sample rate (upper)
        u16(0),
        // Sample rate (lower)
        u32(1),
        // Samples per packet (must be 1 for uncompressed formats)
        u32(sampleSizeInBits / 8),
        // Bytes per packet
        u32(trackData.info.numberOfChannels * sampleSizeInBits / 8),
        // Bytes per frame
        u32(2)
        // Bytes per sample (constant in FFmpeg)
      ];
    }
    return box(compressionType, contents, [
      AUDIO_CODEC_TO_CONFIGURATION_BOX[trackData.track.source._codec]?.(trackData) ?? null
    ]);
  };
  var esds = (trackData) => {
    let objectTypeIndication;
    switch (trackData.track.source._codec) {
      case "aac":
        {
          objectTypeIndication = 64;
        }
        ;
        break;
      case "mp3":
        {
          objectTypeIndication = 107;
        }
        ;
        break;
      case "vorbis":
        {
          objectTypeIndication = 221;
        }
        ;
        break;
      default:
        throw new Error(`Unhandled audio codec: ${trackData.track.source._codec}`);
    }
    let bytes2 = [
      ...u8(objectTypeIndication),
      // Object type indication
      ...u8(21),
      // stream type(6bits)=5 audio, flags(2bits)=1
      ...u24(0),
      // 24bit buffer size
      ...u32(0),
      // max bitrate
      ...u32(0)
      // avg bitrate
    ];
    if (trackData.info.decoderConfig.description) {
      const description = toUint8Array(trackData.info.decoderConfig.description);
      bytes2 = [
        ...bytes2,
        ...u8(5),
        // TAG(5) = DecoderSpecificInfo
        ...variableUnsignedInt(description.byteLength),
        ...description
      ];
    }
    bytes2 = [
      ...u16(1),
      // ES_ID = 1
      ...u8(0),
      // flags etc = 0
      ...u8(4),
      // TAG(4) = ES Descriptor
      ...variableUnsignedInt(bytes2.length),
      ...bytes2,
      ...u8(6),
      // TAG(6)
      ...u8(1),
      // length
      ...u8(2)
      // data
    ];
    bytes2 = [
      ...u8(3),
      // TAG(3) = Object Descriptor
      ...variableUnsignedInt(bytes2.length),
      ...bytes2
    ];
    return fullBox("esds", 0, 0, bytes2);
  };
  var wave = (trackData) => {
    return box("wave", void 0, [
      frma(trackData),
      enda(trackData),
      box("\0\0\0\0")
      // NULL tag at the end
    ]);
  };
  var frma = (trackData) => {
    return box("frma", [
      ascii(AUDIO_CODEC_TO_BOX_NAME[trackData.track.source._codec])
    ]);
  };
  var enda = (trackData) => {
    const { littleEndian } = parsePcmCodec(trackData.track.source._codec);
    return box("enda", [
      u16(+littleEndian)
    ]);
  };
  var dOps = (trackData) => {
    let outputChannelCount = trackData.info.numberOfChannels;
    let preSkip = 3840;
    let inputSampleRate = trackData.info.sampleRate;
    let outputGain = 0;
    let channelMappingFamily = 0;
    let channelMappingTable = new Uint8Array(0);
    const description = trackData.info.decoderConfig?.description;
    if (description) {
      assert(description.byteLength >= 18);
      const bytes2 = toUint8Array(description);
      const header = parseOpusIdentificationHeader(bytes2);
      outputChannelCount = header.outputChannelCount;
      preSkip = header.preSkip;
      inputSampleRate = header.inputSampleRate;
      outputGain = header.outputGain;
      channelMappingFamily = header.channelMappingFamily;
      if (header.channelMappingTable) {
        channelMappingTable = header.channelMappingTable;
      }
    }
    return box("dOps", [
      u8(0),
      // Version
      u8(outputChannelCount),
      // OutputChannelCount
      u16(preSkip),
      // PreSkip
      u32(inputSampleRate),
      // InputSampleRate
      i16(outputGain),
      // OutputGain
      u8(channelMappingFamily),
      // ChannelMappingFamily
      ...channelMappingTable
    ]);
  };
  var dfLa = (trackData) => {
    const description = trackData.info.decoderConfig?.description;
    assert(description);
    const bytes2 = toUint8Array(description);
    return fullBox("dfLa", 0, 0, [
      ...bytes2.subarray(4)
    ]);
  };
  var subtitleSampleDescription = (compressionType, trackData) => box(compressionType, [
    Array(6).fill(0),
    // Reserved
    u16(1)
    // Data reference index
  ], [
    SUBTITLE_CODEC_TO_CONFIGURATION_BOX[trackData.track.source._codec](trackData)
  ]);
  var vttC = (trackData) => box("vttC", [
    ...textEncoder.encode(trackData.info.config.description)
  ]);
  var stts = (trackData) => {
    return fullBox("stts", 0, 0, [
      u32(trackData.timeToSampleTable.length),
      // Number of entries
      trackData.timeToSampleTable.map((x) => [
        // Time-to-sample table
        u32(x.sampleCount),
        // Sample count
        u32(x.sampleDelta)
        // Sample duration
      ])
    ]);
  };
  var stss = (trackData) => {
    if (trackData.samples.every((x) => x.type === "key")) return null;
    const keySamples = [...trackData.samples.entries()].filter(([, sample]) => sample.type === "key");
    return fullBox("stss", 0, 0, [
      u32(keySamples.length),
      // Number of entries
      keySamples.map(([index]) => u32(index + 1))
      // Sync sample table
    ]);
  };
  var stsc = (trackData) => {
    return fullBox("stsc", 0, 0, [
      u32(trackData.compactlyCodedChunkTable.length),
      // Number of entries
      trackData.compactlyCodedChunkTable.map((x) => [
        // Sample-to-chunk table
        u32(x.firstChunk),
        // First chunk
        u32(x.samplesPerChunk),
        // Samples per chunk
        u32(1)
        // Sample description index
      ])
    ]);
  };
  var stsz = (trackData) => {
    if (trackData.requiresPcmTransformation) {
      assert(trackData.type === "audio");
      const { sampleSize } = parsePcmCodec(trackData.track.source._codec);
      return fullBox("stsz", 0, 0, [
        u32(sampleSize * trackData.info.numberOfChannels),
        // Sample size
        u32(trackData.samples.reduce((acc, x) => acc + intoTimescale(x.duration, trackData.timescale), 0))
      ]);
    }
    return fullBox("stsz", 0, 0, [
      u32(0),
      // Sample size (0 means non-constant size)
      u32(trackData.samples.length),
      // Number of entries
      trackData.samples.map((x) => u32(x.size))
      // Sample size table
    ]);
  };
  var stco = (trackData) => {
    if (trackData.finalizedChunks.length > 0 && last(trackData.finalizedChunks).offset >= 2 ** 32) {
      return fullBox("co64", 0, 0, [
        u32(trackData.finalizedChunks.length),
        // Number of entries
        trackData.finalizedChunks.map((x) => u64(x.offset))
        // Chunk offset table
      ]);
    }
    return fullBox("stco", 0, 0, [
      u32(trackData.finalizedChunks.length),
      // Number of entries
      trackData.finalizedChunks.map((x) => u32(x.offset))
      // Chunk offset table
    ]);
  };
  var ctts = (trackData) => {
    return fullBox("ctts", 1, 0, [
      u32(trackData.compositionTimeOffsetTable.length),
      // Number of entries
      trackData.compositionTimeOffsetTable.map((x) => [
        // Time-to-sample table
        u32(x.sampleCount),
        // Sample count
        i32(x.sampleCompositionTimeOffset)
        // Sample offset
      ])
    ]);
  };
  var cslg = (trackData) => {
    let leastDecodeToDisplayDelta = Infinity;
    let greatestDecodeToDisplayDelta = -Infinity;
    let compositionStartTime = Infinity;
    let compositionEndTime = -Infinity;
    assert(trackData.compositionTimeOffsetTable.length > 0);
    assert(trackData.samples.length > 0);
    for (let i = 0; i < trackData.compositionTimeOffsetTable.length; i++) {
      const entry = trackData.compositionTimeOffsetTable[i];
      leastDecodeToDisplayDelta = Math.min(leastDecodeToDisplayDelta, entry.sampleCompositionTimeOffset);
      greatestDecodeToDisplayDelta = Math.max(greatestDecodeToDisplayDelta, entry.sampleCompositionTimeOffset);
    }
    for (let i = 0; i < trackData.samples.length; i++) {
      const sample = trackData.samples[i];
      compositionStartTime = Math.min(
        compositionStartTime,
        intoTimescale(sample.timestamp, trackData.timescale)
      );
      compositionEndTime = Math.max(
        compositionEndTime,
        intoTimescale(sample.timestamp + sample.duration, trackData.timescale)
      );
    }
    const compositionToDtsShift = Math.max(-leastDecodeToDisplayDelta, 0);
    if (compositionEndTime >= 2 ** 31) {
      return null;
    }
    return fullBox("cslg", 0, 0, [
      i32(compositionToDtsShift),
      // Composition to DTS shift
      i32(leastDecodeToDisplayDelta),
      // Least decode to display delta
      i32(greatestDecodeToDisplayDelta),
      // Greatest decode to display delta
      i32(compositionStartTime),
      // Composition start time
      i32(compositionEndTime)
      // Composition end time
    ]);
  };
  var mvex = (trackDatas) => {
    return box("mvex", void 0, trackDatas.map(trex));
  };
  var trex = (trackData) => {
    return fullBox("trex", 0, 0, [
      u32(trackData.track.id),
      // Track ID
      u32(1),
      // Default sample description index
      u32(0),
      // Default sample duration
      u32(0),
      // Default sample size
      u32(0)
      // Default sample flags
    ]);
  };
  var moof = (sequenceNumber, trackDatas) => {
    return box("moof", void 0, [
      mfhd(sequenceNumber),
      ...trackDatas.map(traf)
    ]);
  };
  var mfhd = (sequenceNumber) => {
    return fullBox("mfhd", 0, 0, [
      u32(sequenceNumber)
      // Sequence number
    ]);
  };
  var fragmentSampleFlags = (sample) => {
    let byte1 = 0;
    let byte2 = 0;
    const byte3 = 0;
    const byte4 = 0;
    const sampleIsDifferenceSample = sample.type === "delta";
    byte2 |= +sampleIsDifferenceSample;
    if (sampleIsDifferenceSample) {
      byte1 |= 1;
    } else {
      byte1 |= 2;
    }
    return byte1 << 24 | byte2 << 16 | byte3 << 8 | byte4;
  };
  var traf = (trackData) => {
    return box("traf", void 0, [
      tfhd(trackData),
      tfdt(trackData),
      trun(trackData)
    ]);
  };
  var tfhd = (trackData) => {
    assert(trackData.currentChunk);
    let tfFlags = 0;
    tfFlags |= 8;
    tfFlags |= 16;
    tfFlags |= 32;
    tfFlags |= 131072;
    const referenceSample = trackData.currentChunk.samples[1] ?? trackData.currentChunk.samples[0];
    const referenceSampleInfo = {
      duration: referenceSample.timescaleUnitsToNextSample,
      size: referenceSample.size,
      flags: fragmentSampleFlags(referenceSample)
    };
    return fullBox("tfhd", 0, tfFlags, [
      u32(trackData.track.id),
      // Track ID
      u32(referenceSampleInfo.duration),
      // Default sample duration
      u32(referenceSampleInfo.size),
      // Default sample size
      u32(referenceSampleInfo.flags)
      // Default sample flags
    ]);
  };
  var tfdt = (trackData) => {
    assert(trackData.currentChunk);
    return fullBox("tfdt", 1, 0, [
      u64(intoTimescale(trackData.currentChunk.startTimestamp, trackData.timescale))
      // Base Media Decode Time
    ]);
  };
  var trun = (trackData) => {
    assert(trackData.currentChunk);
    const allSampleDurations = trackData.currentChunk.samples.map((x) => x.timescaleUnitsToNextSample);
    const allSampleSizes = trackData.currentChunk.samples.map((x) => x.size);
    const allSampleFlags = trackData.currentChunk.samples.map(fragmentSampleFlags);
    const allSampleCompositionTimeOffsets = trackData.currentChunk.samples.map((x) => intoTimescale(x.timestamp - x.decodeTimestamp, trackData.timescale));
    const uniqueSampleDurations = new Set(allSampleDurations);
    const uniqueSampleSizes = new Set(allSampleSizes);
    const uniqueSampleFlags = new Set(allSampleFlags);
    const uniqueSampleCompositionTimeOffsets = new Set(allSampleCompositionTimeOffsets);
    const firstSampleFlagsPresent = uniqueSampleFlags.size === 2 && allSampleFlags[0] !== allSampleFlags[1];
    const sampleDurationPresent = uniqueSampleDurations.size > 1;
    const sampleSizePresent = uniqueSampleSizes.size > 1;
    const sampleFlagsPresent = !firstSampleFlagsPresent && uniqueSampleFlags.size > 1;
    const sampleCompositionTimeOffsetsPresent = uniqueSampleCompositionTimeOffsets.size > 1 || [...uniqueSampleCompositionTimeOffsets].some((x) => x !== 0);
    let flags = 0;
    flags |= 1;
    flags |= 4 * +firstSampleFlagsPresent;
    flags |= 256 * +sampleDurationPresent;
    flags |= 512 * +sampleSizePresent;
    flags |= 1024 * +sampleFlagsPresent;
    flags |= 2048 * +sampleCompositionTimeOffsetsPresent;
    return fullBox("trun", 1, flags, [
      u32(trackData.currentChunk.samples.length),
      // Sample count
      u32(trackData.currentChunk.offset - trackData.currentChunk.moofOffset || 0),
      // Data offset
      firstSampleFlagsPresent ? u32(allSampleFlags[0]) : [],
      trackData.currentChunk.samples.map((_, i) => [
        sampleDurationPresent ? u32(allSampleDurations[i]) : [],
        // Sample duration
        sampleSizePresent ? u32(allSampleSizes[i]) : [],
        // Sample size
        sampleFlagsPresent ? u32(allSampleFlags[i]) : [],
        // Sample flags
        // Sample composition time offsets
        sampleCompositionTimeOffsetsPresent ? i32(allSampleCompositionTimeOffsets[i]) : []
      ])
    ]);
  };
  var mfra = (trackDatas) => {
    return box("mfra", void 0, [
      ...trackDatas.map(tfra),
      mfro()
    ]);
  };
  var tfra = (trackData, trackIndex) => {
    const version = 1;
    return fullBox("tfra", version, 0, [
      u32(trackData.track.id),
      // Track ID
      u32(63),
      // This specifies that traf number, trun number and sample number are 32-bit ints
      u32(trackData.finalizedChunks.length),
      // Number of entries
      trackData.finalizedChunks.map((chunk) => [
        u64(intoTimescale(chunk.samples[0].timestamp, trackData.timescale)),
        // Time (in presentation time)
        u64(chunk.moofOffset),
        // moof offset
        u32(trackIndex + 1),
        // traf number
        u32(1),
        // trun number
        u32(1)
        // Sample number
      ])
    ]);
  };
  var mfro = () => {
    return fullBox("mfro", 0, 0, [
      // This value needs to be overwritten manually from the outside, where the actual size of the enclosing mfra box
      // is known
      u32(0)
      // Size
    ]);
  };
  var vtte = () => box("vtte");
  var vttc = (payload, timestamp, identifier, settings, sourceId) => box("vttc", void 0, [
    sourceId !== null ? box("vsid", [i32(sourceId)]) : null,
    identifier !== null ? box("iden", [...textEncoder.encode(identifier)]) : null,
    timestamp !== null ? box("ctim", [...textEncoder.encode(formatSubtitleTimestamp(timestamp))]) : null,
    settings !== null ? box("sttg", [...textEncoder.encode(settings)]) : null,
    box("payl", [...textEncoder.encode(payload)])
  ]);
  var vtta = (notes) => box("vtta", [...textEncoder.encode(notes)]);
  var VIDEO_CODEC_TO_BOX_NAME = {
    avc: "avc1",
    hevc: "hvc1",
    vp8: "vp08",
    vp9: "vp09",
    av1: "av01"
  };
  var VIDEO_CODEC_TO_CONFIGURATION_BOX = {
    avc: avcC,
    hevc: hvcC,
    vp8: vpcC,
    vp9: vpcC,
    av1: av1C
  };
  var AUDIO_CODEC_TO_BOX_NAME = {
    "aac": "mp4a",
    "mp3": "mp4a",
    "opus": "Opus",
    "vorbis": "mp4a",
    "flac": "fLaC",
    "ulaw": "ulaw",
    "alaw": "alaw",
    "pcm-u8": "raw ",
    "pcm-s8": "sowt",
    "pcm-s16": "sowt",
    "pcm-s16be": "twos",
    "pcm-s24": "in24",
    "pcm-s24be": "in24",
    "pcm-s32": "in32",
    "pcm-s32be": "in32",
    "pcm-f32": "fl32",
    "pcm-f32be": "fl32"
  };
  var AUDIO_CODEC_TO_CONFIGURATION_BOX = {
    "aac": esds,
    "mp3": esds,
    "opus": dOps,
    "vorbis": esds,
    "flac": dfLa,
    "pcm-s24": wave,
    "pcm-s24be": wave,
    "pcm-s32": wave,
    "pcm-s32be": wave,
    "pcm-f32": wave,
    "pcm-f32be": wave
  };
  var SUBTITLE_CODEC_TO_BOX_NAME = {
    webvtt: "wvtt"
  };
  var SUBTITLE_CODEC_TO_CONFIGURATION_BOX = {
    webvtt: vttC
  };

  // src/muxer.ts
  var Muxer = class {
    constructor(output) {
      this.mutex = new AsyncMutex();
      this.trackTimestampInfo = /* @__PURE__ */ new WeakMap();
      this.output = output;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onTrackClose(track) {
    }
    validateAndNormalizeTimestamp(track, timestampInSeconds, isKeyFrame) {
      let timestampInfo = this.trackTimestampInfo.get(track);
      if (!timestampInfo) {
        if (!isKeyFrame) {
          throw new Error("First frame must be a key frame.");
        }
        timestampInfo = {
          timestampOffset: timestampInSeconds,
          maxTimestamp: track.source._offsetTimestamps ? 0 : timestampInSeconds,
          maxTimestampBeforeLastKeyFrame: track.source._offsetTimestamps ? 0 : timestampInSeconds
        };
        this.trackTimestampInfo.set(track, timestampInfo);
      }
      if (track.source._offsetTimestamps) {
        timestampInSeconds -= timestampInfo.timestampOffset;
      }
      if (timestampInSeconds < 0) {
        throw new Error(`Timestamps must be non-negative (got ${timestampInSeconds}s).`);
      }
      if (isKeyFrame) {
        timestampInfo.maxTimestampBeforeLastKeyFrame = timestampInfo.maxTimestamp;
      }
      if (timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyFrame) {
        throw new Error(
          `Timestamps cannot be smaller than the highest timestamp of the previous run (a run begins with a key frame and ends right before the next key frame). Got ${timestampInSeconds}s, but highest timestamp is ${timestampInfo.maxTimestampBeforeLastKeyFrame}s.`
        );
      }
      timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);
      return timestampInSeconds;
    }
  };

  // src/writer.ts
  var Writer = class {
    constructor() {
      /** Setting this to true will cause the writer to ensure data is written in a strictly monotonic, streamable way. */
      this.ensureMonotonicity = false;
    }
    start() {
    }
  };
  var ARRAY_BUFFER_INITIAL_SIZE = 2 ** 16;
  var ARRAY_BUFFER_MAX_SIZE = 2 ** 32;
  var BufferTargetWriter = class extends Writer {
    constructor(target) {
      super();
      this.pos = 0;
      this.maxPos = 0;
      this.target = target;
      this.supportsResize = "resize" in new ArrayBuffer(0);
      if (this.supportsResize) {
        try {
          this.buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE, { maxByteLength: ARRAY_BUFFER_MAX_SIZE });
        } catch {
          this.buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE);
          this.supportsResize = false;
        }
      } else {
        this.buffer = new ArrayBuffer(ARRAY_BUFFER_INITIAL_SIZE);
      }
      this.bytes = new Uint8Array(this.buffer);
    }
    ensureSize(size) {
      let newLength = this.buffer.byteLength;
      while (newLength < size) newLength *= 2;
      if (newLength === this.buffer.byteLength) return;
      if (newLength > ARRAY_BUFFER_MAX_SIZE) {
        throw new Error(
          `ArrayBuffer exceeded maximum size of ${ARRAY_BUFFER_MAX_SIZE} bytes. Please consider using another target.`
        );
      }
      if (this.supportsResize) {
        this.buffer.resize(newLength);
      } else {
        const newBuffer = new ArrayBuffer(newLength);
        const newBytes = new Uint8Array(newBuffer);
        newBytes.set(this.bytes, 0);
        this.buffer = newBuffer;
        this.bytes = newBytes;
      }
    }
    write(data) {
      this.ensureSize(this.pos + data.byteLength);
      this.bytes.set(data, this.pos);
      this.pos += data.byteLength;
      this.maxPos = Math.max(this.maxPos, this.pos);
    }
    seek(newPos) {
      this.pos = newPos;
    }
    getPos() {
      return this.pos;
    }
    async flush() {
    }
    async finalize() {
      this.ensureSize(this.pos);
      this.target.buffer = this.buffer.slice(0, Math.max(this.maxPos, this.pos));
    }
    async close() {
    }
    getSlice(start, end) {
      return this.bytes.slice(start, end);
    }
  };
  var StreamTargetWriter = class extends Writer {
    constructor(target) {
      super();
      this.pos = 0;
      this.sections = [];
      this.lastFlushEnd = 0;
      this.writer = null;
      this.target = target;
    }
    start() {
      this.writer = this.target._writable.getWriter();
    }
    write(data) {
      this.sections.push({
        data: data.slice(),
        start: this.pos
      });
      this.pos += data.byteLength;
    }
    seek(newPos) {
      this.pos = newPos;
    }
    getPos() {
      return this.pos;
    }
    async flush() {
      assert(this.writer);
      if (this.sections.length === 0) return;
      const chunks = [];
      const sorted = [...this.sections].sort((a, b) => a.start - b.start);
      chunks.push({
        start: sorted[0].start,
        size: sorted[0].data.byteLength
      });
      for (let i = 1; i < sorted.length; i++) {
        const lastChunk = chunks[chunks.length - 1];
        const section = sorted[i];
        if (section.start <= lastChunk.start + lastChunk.size) {
          lastChunk.size = Math.max(lastChunk.size, section.start + section.data.byteLength - lastChunk.start);
        } else {
          chunks.push({
            start: section.start,
            size: section.data.byteLength
          });
        }
      }
      for (const chunk of chunks) {
        chunk.data = new Uint8Array(chunk.size);
        for (const section of this.sections) {
          if (chunk.start <= section.start && section.start < chunk.start + chunk.size) {
            chunk.data.set(section.data, section.start - chunk.start);
          }
        }
        if (this.ensureMonotonicity && chunk.start !== this.lastFlushEnd) {
          throw new Error("Internal error: Monotonicity violation.");
        }
        if (this.writer.desiredSize !== null && this.writer.desiredSize <= 0) {
          await this.writer.ready;
        }
        void this.writer.write({
          type: "write",
          data: chunk.data,
          position: chunk.start
        });
        this.lastFlushEnd = chunk.start + chunk.data.byteLength;
      }
      this.sections.length = 0;
    }
    finalize() {
      assert(this.writer);
      return this.writer.close();
    }
    async close() {
      return this.writer?.close();
    }
  };
  var DEFAULT_CHUNK_SIZE = 2 ** 24;
  var MAX_CHUNKS_AT_ONCE = 2;
  var ChunkedStreamTargetWriter = class extends Writer {
    constructor(target) {
      super();
      this.pos = 0;
      /**
       * The data is divided up into fixed-size chunks, whose contents are first filled in RAM and then flushed out.
       * A chunk is flushed if all of its contents have been written.
       */
      this.chunks = [];
      this.lastFlushEnd = 0;
      this.writer = null;
      this.flushedChunkQueue = [];
      this.target = target;
      this.chunkSize = target._options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
      if (!Number.isInteger(this.chunkSize) || this.chunkSize < 2 ** 10) {
        throw new Error("Invalid StreamTarget options: chunkSize must be an integer not smaller than 1024.");
      }
    }
    start() {
      this.writer = this.target._writable.getWriter();
    }
    write(data) {
      this.writeDataIntoChunks(data, this.pos);
      this.queueChunksForFlush();
      this.pos += data.byteLength;
    }
    seek(newPos) {
      this.pos = newPos;
    }
    getPos() {
      return this.pos;
    }
    writeDataIntoChunks(data, position) {
      let chunkIndex = this.chunks.findIndex((x) => x.start <= position && position < x.start + this.chunkSize);
      if (chunkIndex === -1) chunkIndex = this.createChunk(position);
      const chunk = this.chunks[chunkIndex];
      const relativePosition = position - chunk.start;
      const toWrite = data.subarray(0, Math.min(this.chunkSize - relativePosition, data.byteLength));
      chunk.data.set(toWrite, relativePosition);
      const section = {
        start: relativePosition,
        end: relativePosition + toWrite.byteLength
      };
      this.insertSectionIntoChunk(chunk, section);
      if (chunk.written[0].start === 0 && chunk.written[0].end === this.chunkSize) {
        chunk.shouldFlush = true;
      }
      if (this.chunks.length > MAX_CHUNKS_AT_ONCE) {
        for (let i = 0; i < this.chunks.length - 1; i++) {
          this.chunks[i].shouldFlush = true;
        }
        this.queueChunksForFlush();
      }
      if (toWrite.byteLength < data.byteLength) {
        this.writeDataIntoChunks(data.subarray(toWrite.byteLength), position + toWrite.byteLength);
      }
    }
    insertSectionIntoChunk(chunk, section) {
      let low = 0;
      let high = chunk.written.length - 1;
      let index = -1;
      while (low <= high) {
        const mid = Math.floor(low + (high - low + 1) / 2);
        if (chunk.written[mid].start <= section.start) {
          low = mid + 1;
          index = mid;
        } else {
          high = mid - 1;
        }
      }
      chunk.written.splice(index + 1, 0, section);
      if (index === -1 || chunk.written[index].end < section.start) index++;
      while (index < chunk.written.length - 1 && chunk.written[index].end >= chunk.written[index + 1].start) {
        chunk.written[index].end = Math.max(chunk.written[index].end, chunk.written[index + 1].end);
        chunk.written.splice(index + 1, 1);
      }
    }
    createChunk(includesPosition) {
      const start = Math.floor(includesPosition / this.chunkSize) * this.chunkSize;
      const chunk = {
        start,
        data: new Uint8Array(this.chunkSize),
        written: [],
        shouldFlush: false
      };
      this.chunks.push(chunk);
      this.chunks.sort((a, b) => a.start - b.start);
      return this.chunks.indexOf(chunk);
    }
    queueChunksForFlush(force = false) {
      assert(this.writer);
      for (let i = 0; i < this.chunks.length; i++) {
        const chunk = this.chunks[i];
        if (!chunk.shouldFlush && !force) continue;
        for (const section of chunk.written) {
          if (this.ensureMonotonicity && chunk.start + section.start !== this.lastFlushEnd) {
            throw new Error("Internal error: Monotonicity violation.");
          }
          this.flushedChunkQueue.push({
            type: "write",
            data: chunk.data.subarray(section.start, section.end),
            position: chunk.start + section.start
          });
          this.lastFlushEnd = chunk.start + section.end;
        }
        this.chunks.splice(i--, 1);
      }
    }
    async flush() {
      assert(this.writer);
      if (this.flushedChunkQueue.length === 0) return;
      for (const chunk of this.flushedChunkQueue) {
        if (this.writer.desiredSize !== null && this.writer.desiredSize <= 0) {
          await this.writer.ready;
        }
        void this.writer.write(chunk);
      }
      this.flushedChunkQueue.length = 0;
    }
    async finalize() {
      assert(this.writer);
      this.queueChunksForFlush(true);
      await this.flush();
      return this.writer.close();
    }
    async close() {
      return this.writer?.close();
    }
  };

  // src/target.ts
  var Target = class {
    constructor() {
      /** @internal */
      this._output = null;
    }
  };
  var BufferTarget = class extends Target {
    constructor() {
      super(...arguments);
      /** Stores the final output buffer. Until the output is finalized, this will be null. */
      this.buffer = null;
    }
    /** @internal */
    _createWriter() {
      return new BufferTargetWriter(this);
    }
  };
  var StreamTarget = class extends Target {
    constructor(writable, options = {}) {
      super();
      if (!(writable instanceof WritableStream)) {
        throw new TypeError("StreamTarget requires a WritableStream instance.");
      }
      if (options != null && typeof options !== "object") {
        throw new TypeError("StreamTarget options, when provided, must be an object.");
      }
      if (options.chunked !== void 0 && typeof options.chunked !== "boolean") {
        throw new TypeError("options.chunked, when provided, must be a boolean.");
      }
      if (options.chunkSize !== void 0 && (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0)) {
        throw new TypeError("options.chunkSize, when provided, must be a positive integer.");
      }
      this._writable = writable;
      this._options = options;
    }
    /** @internal */
    _createWriter() {
      return this._options.chunked ? new ChunkedStreamTargetWriter(this) : new StreamTargetWriter(this);
    }
  };

  // src/isobmff/isobmff-muxer.ts
  var GLOBAL_TIMESCALE = 1e3;
  var TIMESTAMP_OFFSET = 2082844800;
  var intoTimescale = (timeInSeconds, timescale, round = true) => {
    const value = timeInSeconds * timescale;
    return round ? Math.round(value) : value;
  };
  var IsobmffMuxer = class extends Muxer {
    constructor(output, format) {
      super(output);
      this.auxTarget = new BufferTarget();
      this.auxWriter = this.auxTarget._createWriter();
      this.auxBoxWriter = new IsobmffBoxWriter(this.auxWriter);
      this.ftypSize = null;
      this.mdat = null;
      this.trackDatas = [];
      this.creationTime = Math.floor(Date.now() / 1e3) + TIMESTAMP_OFFSET;
      this.finalizedChunks = [];
      this.nextFragmentNumber = 1;
      // Only relevant for fragmented files, to make sure new fragments start with the highest timestamp seen so far
      this.maxWrittenTimestamp = -Infinity;
      this.writer = output._writer;
      this.boxWriter = new IsobmffBoxWriter(this.writer);
      this.isMov = format instanceof MovOutputFormat;
      const fastStartDefault = this.writer instanceof BufferTargetWriter ? "in-memory" : false;
      this.fastStart = format._options.fastStart ?? fastStartDefault;
      this.isFragmented = this.fastStart === "fragmented";
      if (this.fastStart === "in-memory" || this.isFragmented) {
        this.writer.ensureMonotonicity = true;
      }
    }
    async start() {
      const release = await this.mutex.acquire();
      const holdsAvc = this.output._tracks.some((x) => x.type === "video" && x.source._codec === "avc");
      this.boxWriter.writeBox(ftyp({
        isMov: this.isMov,
        holdsAvc,
        fragmented: this.isFragmented
      }));
      this.ftypSize = this.writer.getPos();
      if (this.fastStart === "in-memory") {
        this.mdat = mdat(false);
      } else if (this.isFragmented) {
      } else {
        this.mdat = mdat(true);
        this.boxWriter.writeBox(this.mdat);
      }
      await this.writer.flush();
      release();
    }
    getVideoTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((x) => x.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      validateVideoChunkMetadata(meta);
      assert(meta);
      assert(meta.decoderConfig);
      assert(meta.decoderConfig.codedWidth !== void 0);
      assert(meta.decoderConfig.codedHeight !== void 0);
      const newTrackData = {
        track,
        type: "video",
        info: {
          width: meta.decoderConfig.codedWidth,
          height: meta.decoderConfig.codedHeight,
          decoderConfig: meta.decoderConfig
        },
        timescale: track.metadata.frameRate ?? 57600,
        samples: [],
        sampleQueue: [],
        timestampProcessingQueue: [],
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        finalizedChunks: [],
        currentChunk: null,
        compactlyCodedChunkTable: [],
        requiresPcmTransformation: false
      };
      this.trackDatas.push(newTrackData);
      this.trackDatas.sort((a, b) => a.track.id - b.track.id);
      return newTrackData;
    }
    getAudioTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((x) => x.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      validateAudioChunkMetadata(meta);
      assert(meta);
      assert(meta.decoderConfig);
      const newTrackData = {
        track,
        type: "audio",
        info: {
          numberOfChannels: meta.decoderConfig.numberOfChannels,
          sampleRate: meta.decoderConfig.sampleRate,
          decoderConfig: meta.decoderConfig
        },
        timescale: meta.decoderConfig.sampleRate,
        samples: [],
        sampleQueue: [],
        timestampProcessingQueue: [],
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        finalizedChunks: [],
        currentChunk: null,
        compactlyCodedChunkTable: [],
        requiresPcmTransformation: !this.isFragmented && PCM_AUDIO_CODECS.includes(track.source._codec)
      };
      this.trackDatas.push(newTrackData);
      this.trackDatas.sort((a, b) => a.track.id - b.track.id);
      return newTrackData;
    }
    getSubtitleTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((x) => x.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      validateSubtitleMetadata(meta);
      assert(meta);
      assert(meta.config);
      const newTrackData = {
        track,
        type: "subtitle",
        info: {
          config: meta.config
        },
        timescale: 1e3,
        // Reasonable
        samples: [],
        sampleQueue: [],
        timestampProcessingQueue: [],
        timeToSampleTable: [],
        compositionTimeOffsetTable: [],
        lastTimescaleUnits: null,
        lastSample: null,
        finalizedChunks: [],
        currentChunk: null,
        compactlyCodedChunkTable: [],
        requiresPcmTransformation: false,
        lastCueEndTimestamp: 0,
        cueQueue: [],
        nextSourceId: 0,
        cueToSourceId: /* @__PURE__ */ new WeakMap()
      };
      this.trackDatas.push(newTrackData);
      this.trackDatas.sort((a, b) => a.track.id - b.track.id);
      return newTrackData;
    }
    async addEncodedVideoPacket(track, packet, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getVideoTrackData(track, meta);
        const timestamp = this.validateAndNormalizeTimestamp(
          trackData.track,
          packet.timestamp,
          packet.type === "key"
        );
        const internalSample = this.createSampleForTrack(
          trackData,
          packet.data,
          timestamp,
          packet.duration,
          packet.type
        );
        await this.registerSample(trackData, internalSample);
      } finally {
        release();
      }
    }
    async addEncodedAudioPacket(track, packet, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getAudioTrackData(track, meta);
        const timestamp = this.validateAndNormalizeTimestamp(
          trackData.track,
          packet.timestamp,
          packet.type === "key"
        );
        const internalSample = this.createSampleForTrack(
          trackData,
          packet.data,
          timestamp,
          packet.duration,
          packet.type
        );
        if (trackData.requiresPcmTransformation) {
          await this.maybePadWithSilence(trackData, timestamp);
        }
        await this.registerSample(trackData, internalSample);
      } finally {
        release();
      }
    }
    async maybePadWithSilence(trackData, untilTimestamp) {
      const lastSample = last(trackData.samples);
      const lastEndTimestamp = lastSample ? lastSample.timestamp + lastSample.duration : 0;
      const delta = untilTimestamp - lastEndTimestamp;
      const deltaInTimescale = intoTimescale(delta, trackData.timescale);
      if (deltaInTimescale > 0) {
        const { sampleSize, silentValue } = parsePcmCodec(
          trackData.info.decoderConfig.codec
        );
        const samplesNeeded = deltaInTimescale * trackData.info.numberOfChannels;
        const data = new Uint8Array(sampleSize * samplesNeeded).fill(silentValue);
        const paddingSample = this.createSampleForTrack(
          trackData,
          new Uint8Array(data.buffer),
          lastEndTimestamp,
          delta,
          "key"
        );
        await this.registerSample(trackData, paddingSample);
      }
    }
    async addSubtitleCue(track, cue, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getSubtitleTrackData(track, meta);
        this.validateAndNormalizeTimestamp(trackData.track, cue.timestamp, true);
        if (track.source._codec === "webvtt") {
          trackData.cueQueue.push(cue);
          await this.processWebVTTCues(trackData, cue.timestamp);
        } else {
        }
      } finally {
        release();
      }
    }
    async processWebVTTCues(trackData, until) {
      while (trackData.cueQueue.length > 0) {
        const timestamps = /* @__PURE__ */ new Set([]);
        for (const cue of trackData.cueQueue) {
          assert(cue.timestamp <= until);
          assert(trackData.lastCueEndTimestamp <= cue.timestamp + cue.duration);
          timestamps.add(Math.max(cue.timestamp, trackData.lastCueEndTimestamp));
          timestamps.add(cue.timestamp + cue.duration);
        }
        const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
        const sampleStart = sortedTimestamps[0];
        const sampleEnd = sortedTimestamps[1] ?? sampleStart;
        if (until < sampleEnd) {
          break;
        }
        if (trackData.lastCueEndTimestamp < sampleStart) {
          this.auxWriter.seek(0);
          const box2 = vtte();
          this.auxBoxWriter.writeBox(box2);
          const body2 = this.auxWriter.getSlice(0, this.auxWriter.getPos());
          const sample2 = this.createSampleForTrack(
            trackData,
            body2,
            trackData.lastCueEndTimestamp,
            sampleStart - trackData.lastCueEndTimestamp,
            "key"
          );
          await this.registerSample(trackData, sample2);
          trackData.lastCueEndTimestamp = sampleStart;
        }
        this.auxWriter.seek(0);
        for (let i = 0; i < trackData.cueQueue.length; i++) {
          const cue = trackData.cueQueue[i];
          if (cue.timestamp >= sampleEnd) {
            break;
          }
          inlineTimestampRegex.lastIndex = 0;
          const containsTimestamp = inlineTimestampRegex.test(cue.text);
          const endTimestamp = cue.timestamp + cue.duration;
          let sourceId = trackData.cueToSourceId.get(cue);
          if (sourceId === void 0 && sampleEnd < endTimestamp) {
            sourceId = trackData.nextSourceId++;
            trackData.cueToSourceId.set(cue, sourceId);
          }
          if (cue.notes) {
            const box3 = vtta(cue.notes);
            this.auxBoxWriter.writeBox(box3);
          }
          const box2 = vttc(
            cue.text,
            containsTimestamp ? sampleStart : null,
            cue.identifier ?? null,
            cue.settings ?? null,
            sourceId ?? null
          );
          this.auxBoxWriter.writeBox(box2);
          if (endTimestamp === sampleEnd) {
            trackData.cueQueue.splice(i--, 1);
          }
        }
        const body = this.auxWriter.getSlice(0, this.auxWriter.getPos());
        const sample = this.createSampleForTrack(trackData, body, sampleStart, sampleEnd - sampleStart, "key");
        await this.registerSample(trackData, sample);
        trackData.lastCueEndTimestamp = sampleEnd;
      }
    }
    createSampleForTrack(trackData, data, timestamp, duration, type) {
      const sample = {
        timestamp,
        decodeTimestamp: timestamp,
        // This may be refined later
        duration,
        data,
        size: data.byteLength,
        type,
        timescaleUnitsToNextSample: intoTimescale(duration, trackData.timescale)
        // Will be refined
      };
      return sample;
    }
    processTimestamps(trackData) {
      if (trackData.timestampProcessingQueue.length === 0) {
        return;
      }
      if (trackData.requiresPcmTransformation) {
        let totalDuration = 0;
        for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
          const sample = trackData.timestampProcessingQueue[i];
          const duration = intoTimescale(sample.duration, trackData.timescale);
          totalDuration += duration;
        }
        if (trackData.timeToSampleTable.length === 0) {
          trackData.timeToSampleTable.push({
            sampleCount: totalDuration,
            sampleDelta: 1
          });
        } else {
          const lastEntry = last(trackData.timeToSampleTable);
          lastEntry.sampleCount += totalDuration;
        }
        trackData.timestampProcessingQueue.length = 0;
        return;
      }
      const sortedTimestamps = trackData.timestampProcessingQueue.map((x) => x.timestamp).sort((a, b) => a - b);
      for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
        const sample = trackData.timestampProcessingQueue[i];
        sample.decodeTimestamp = sortedTimestamps[i];
        if (!this.isFragmented && trackData.lastTimescaleUnits === null) {
          sample.decodeTimestamp = 0;
        }
        const sampleCompositionTimeOffset = intoTimescale(sample.timestamp - sample.decodeTimestamp, trackData.timescale);
        const durationInTimescale = intoTimescale(sample.duration, trackData.timescale);
        if (trackData.lastTimescaleUnits !== null) {
          assert(trackData.lastSample);
          const timescaleUnits = intoTimescale(sample.decodeTimestamp, trackData.timescale, false);
          const delta = Math.round(timescaleUnits - trackData.lastTimescaleUnits);
          assert(delta >= 0);
          trackData.lastTimescaleUnits += delta;
          trackData.lastSample.timescaleUnitsToNextSample = delta;
          if (!this.isFragmented) {
            let lastTableEntry = last(trackData.timeToSampleTable);
            assert(lastTableEntry);
            if (lastTableEntry.sampleCount === 1) {
              lastTableEntry.sampleDelta = delta;
              const entryBefore = trackData.timeToSampleTable[trackData.timeToSampleTable.length - 2];
              if (entryBefore && entryBefore.sampleDelta === delta) {
                entryBefore.sampleCount++;
                trackData.timeToSampleTable.pop();
                lastTableEntry = entryBefore;
              }
            } else if (lastTableEntry.sampleDelta !== delta) {
              lastTableEntry.sampleCount--;
              trackData.timeToSampleTable.push(lastTableEntry = {
                sampleCount: 1,
                sampleDelta: delta
              });
            }
            if (lastTableEntry.sampleDelta === durationInTimescale) {
              lastTableEntry.sampleCount++;
            } else {
              trackData.timeToSampleTable.push({
                sampleCount: 1,
                sampleDelta: durationInTimescale
              });
            }
            const lastCompositionTimeOffsetTableEntry = last(trackData.compositionTimeOffsetTable);
            assert(lastCompositionTimeOffsetTableEntry);
            if (lastCompositionTimeOffsetTableEntry.sampleCompositionTimeOffset === sampleCompositionTimeOffset) {
              lastCompositionTimeOffsetTableEntry.sampleCount++;
            } else {
              trackData.compositionTimeOffsetTable.push({
                sampleCount: 1,
                sampleCompositionTimeOffset
              });
            }
          }
        } else {
          trackData.lastTimescaleUnits = intoTimescale(sample.decodeTimestamp, trackData.timescale, false);
          if (!this.isFragmented) {
            trackData.timeToSampleTable.push({
              sampleCount: 1,
              sampleDelta: durationInTimescale
            });
            trackData.compositionTimeOffsetTable.push({
              sampleCount: 1,
              sampleCompositionTimeOffset
            });
          }
        }
        trackData.lastSample = sample;
      }
      trackData.timestampProcessingQueue.length = 0;
    }
    async registerSample(trackData, sample) {
      if (this.isFragmented) {
        trackData.sampleQueue.push(sample);
        await this.interleaveSamples();
      } else {
        await this.addSampleToTrack(trackData, sample);
      }
    }
    async addSampleToTrack(trackData, sample) {
      if (sample.type === "key") {
        this.processTimestamps(trackData);
      }
      if (!this.isFragmented) {
        trackData.samples.push(sample);
      }
      let beginNewChunk = false;
      if (!trackData.currentChunk) {
        beginNewChunk = true;
      } else {
        const currentChunkDuration = sample.timestamp - trackData.currentChunk.startTimestamp;
        if (this.isFragmented) {
          const keyFrameQueuedEverywhere = this.trackDatas.every((otherTrackData) => {
            if (trackData === otherTrackData) {
              return sample.type === "key";
            }
            const firstQueuedSample = otherTrackData.sampleQueue[0];
            if (firstQueuedSample) {
              return firstQueuedSample.type === "key";
            }
            return otherTrackData.track.source._closed;
          });
          if (currentChunkDuration >= 1 && keyFrameQueuedEverywhere && sample.timestamp > this.maxWrittenTimestamp) {
            beginNewChunk = true;
            await this.finalizeFragment();
          }
        } else {
          beginNewChunk = currentChunkDuration >= 0.5;
        }
      }
      if (beginNewChunk) {
        if (trackData.currentChunk) {
          await this.finalizeCurrentChunk(trackData);
        }
        trackData.currentChunk = {
          startTimestamp: sample.timestamp,
          samples: [],
          offset: null,
          moofOffset: null
        };
      }
      assert(trackData.currentChunk);
      trackData.currentChunk.samples.push(sample);
      trackData.timestampProcessingQueue.push(sample);
      if (this.isFragmented) {
        this.maxWrittenTimestamp = Math.max(this.maxWrittenTimestamp, sample.timestamp);
      }
    }
    async finalizeCurrentChunk(trackData) {
      assert(!this.isFragmented);
      if (!trackData.currentChunk) return;
      trackData.finalizedChunks.push(trackData.currentChunk);
      this.finalizedChunks.push(trackData.currentChunk);
      let sampleCount = trackData.currentChunk.samples.length;
      if (trackData.requiresPcmTransformation) {
        sampleCount = trackData.currentChunk.samples.reduce((acc, sample) => acc + intoTimescale(sample.duration, trackData.timescale), 0);
      }
      if (trackData.compactlyCodedChunkTable.length === 0 || last(trackData.compactlyCodedChunkTable).samplesPerChunk !== sampleCount) {
        trackData.compactlyCodedChunkTable.push({
          firstChunk: trackData.finalizedChunks.length,
          // 1-indexed
          samplesPerChunk: sampleCount
        });
      }
      if (this.fastStart === "in-memory") {
        trackData.currentChunk.offset = 0;
        return;
      }
      trackData.currentChunk.offset = this.writer.getPos();
      for (const sample of trackData.currentChunk.samples) {
        assert(sample.data);
        this.writer.write(sample.data);
        sample.data = null;
      }
      await this.writer.flush();
    }
    async interleaveSamples(isFinalCall = false) {
      assert(this.isFragmented);
      if (!isFinalCall) {
        for (const track of this.output._tracks) {
          if (!track.source._closed && !this.trackDatas.some((x) => x.track === track)) {
            return;
          }
        }
      }
      outer:
        while (true) {
          let trackWithMinTimestamp = null;
          let minTimestamp = Infinity;
          for (const trackData of this.trackDatas) {
            if (!isFinalCall && trackData.sampleQueue.length === 0 && !trackData.track.source._closed) {
              break outer;
            }
            if (trackData.sampleQueue.length > 0 && trackData.sampleQueue[0].timestamp < minTimestamp) {
              trackWithMinTimestamp = trackData;
              minTimestamp = trackData.sampleQueue[0].timestamp;
            }
          }
          if (!trackWithMinTimestamp) {
            break;
          }
          const sample = trackWithMinTimestamp.sampleQueue.shift();
          await this.addSampleToTrack(trackWithMinTimestamp, sample);
        }
    }
    async finalizeFragment(flushWriter = true) {
      assert(this.isFragmented);
      const fragmentNumber = this.nextFragmentNumber++;
      if (fragmentNumber === 1) {
        const movieBox = moov(this.trackDatas, this.creationTime, true);
        this.boxWriter.writeBox(movieBox);
      }
      const tracksInFragment = this.trackDatas.filter((x) => x.currentChunk);
      const moofOffset = this.writer.getPos();
      const moofBox = moof(fragmentNumber, tracksInFragment);
      this.boxWriter.writeBox(moofBox);
      {
        const mdatBox = mdat(false);
        let totalTrackSampleSize = 0;
        for (const trackData of tracksInFragment) {
          for (const sample of trackData.currentChunk.samples) {
            totalTrackSampleSize += sample.size;
          }
        }
        let mdatSize = this.boxWriter.measureBox(mdatBox) + totalTrackSampleSize;
        if (mdatSize >= 2 ** 32) {
          mdatBox.largeSize = true;
          mdatSize = this.boxWriter.measureBox(mdatBox) + totalTrackSampleSize;
        }
        mdatBox.size = mdatSize;
        this.boxWriter.writeBox(mdatBox);
      }
      for (const trackData of tracksInFragment) {
        trackData.currentChunk.offset = this.writer.getPos();
        trackData.currentChunk.moofOffset = moofOffset;
        for (const sample of trackData.currentChunk.samples) {
          this.writer.write(sample.data);
          sample.data = null;
        }
      }
      const endPos = this.writer.getPos();
      this.writer.seek(this.boxWriter.offsets.get(moofBox));
      const newMoofBox = moof(fragmentNumber, tracksInFragment);
      this.boxWriter.writeBox(newMoofBox);
      this.writer.seek(endPos);
      for (const trackData of tracksInFragment) {
        trackData.finalizedChunks.push(trackData.currentChunk);
        this.finalizedChunks.push(trackData.currentChunk);
        trackData.currentChunk = null;
      }
      if (flushWriter) {
        await this.writer.flush();
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async onTrackClose(track) {
      const release = await this.mutex.acquire();
      if (track.type === "subtitle" && track.source._codec === "webvtt") {
        const trackData = this.trackDatas.find((x) => x.track === track);
        if (trackData) {
          await this.processWebVTTCues(trackData, Infinity);
        }
      }
      if (this.isFragmented) {
        await this.interleaveSamples();
      }
      release();
    }
    /** Finalizes the file, making it ready for use. Must be called after all video and audio chunks have been added. */
    async finalize() {
      const release = await this.mutex.acquire();
      for (const trackData of this.trackDatas) {
        if (trackData.type === "subtitle" && trackData.track.source._codec === "webvtt") {
          await this.processWebVTTCues(trackData, Infinity);
        }
      }
      if (this.isFragmented) {
        await this.interleaveSamples(true);
        await this.finalizeFragment(false);
      } else {
        for (const trackData of this.trackDatas) {
          this.processTimestamps(trackData);
          await this.finalizeCurrentChunk(trackData);
        }
      }
      if (this.fastStart === "in-memory") {
        assert(this.mdat);
        let mdatSize;
        for (let i = 0; i < 2; i++) {
          const movieBox2 = moov(this.trackDatas, this.creationTime);
          const movieBoxSize = this.boxWriter.measureBox(movieBox2);
          mdatSize = this.boxWriter.measureBox(this.mdat);
          let currentChunkPos = this.writer.getPos() + movieBoxSize + mdatSize;
          for (const chunk of this.finalizedChunks) {
            chunk.offset = currentChunkPos;
            for (const { data } of chunk.samples) {
              assert(data);
              currentChunkPos += data.byteLength;
              mdatSize += data.byteLength;
            }
          }
          if (currentChunkPos < 2 ** 32) break;
          if (mdatSize >= 2 ** 32) this.mdat.largeSize = true;
        }
        const movieBox = moov(this.trackDatas, this.creationTime);
        this.boxWriter.writeBox(movieBox);
        this.mdat.size = mdatSize;
        this.boxWriter.writeBox(this.mdat);
        for (const chunk of this.finalizedChunks) {
          for (const sample of chunk.samples) {
            assert(sample.data);
            this.writer.write(sample.data);
            sample.data = null;
          }
        }
      } else if (this.isFragmented) {
        const startPos = this.writer.getPos();
        const mfraBox = mfra(this.trackDatas);
        this.boxWriter.writeBox(mfraBox);
        const mfraBoxSize = this.writer.getPos() - startPos;
        this.writer.seek(this.writer.getPos() - 4);
        this.boxWriter.writeU32(mfraBoxSize);
      } else {
        assert(this.mdat);
        assert(this.ftypSize !== null);
        const mdatPos = this.boxWriter.offsets.get(this.mdat);
        assert(mdatPos !== void 0);
        const mdatSize = this.writer.getPos() - mdatPos;
        this.mdat.size = mdatSize;
        this.mdat.largeSize = mdatSize >= 2 ** 32;
        this.boxWriter.patchBox(this.mdat);
        const movieBox = moov(this.trackDatas, this.creationTime);
        if (typeof this.fastStart === "object") {
          this.writer.seek(this.ftypSize);
          this.boxWriter.writeBox(movieBox);
          const remainingBytes = mdatPos - this.writer.getPos();
          this.boxWriter.writeBox(free(remainingBytes));
        } else {
          this.boxWriter.writeBox(movieBox);
        }
      }
      release();
    }
  };

  // src/matroska/ebml.ts
  var EBMLFloat32 = class {
    constructor(value) {
      this.value = value;
    }
  };
  var EBMLFloat64 = class {
    constructor(value) {
      this.value = value;
    }
  };
  var EBMLSignedInt = class {
    constructor(value) {
      this.value = value;
    }
  };
  var measureUnsignedInt = (value) => {
    if (value < 1 << 8) {
      return 1;
    } else if (value < 1 << 16) {
      return 2;
    } else if (value < 1 << 24) {
      return 3;
    } else if (value < 2 ** 32) {
      return 4;
    } else if (value < 2 ** 40) {
      return 5;
    } else {
      return 6;
    }
  };
  var measureSignedInt = (value) => {
    if (value >= -(1 << 6) && value < 1 << 6) {
      return 1;
    } else if (value >= -(1 << 13) && value < 1 << 13) {
      return 2;
    } else if (value >= -(1 << 20) && value < 1 << 20) {
      return 3;
    } else if (value >= -(1 << 27) && value < 1 << 27) {
      return 4;
    } else if (value >= -(2 ** 34) && value < 2 ** 34) {
      return 5;
    } else {
      return 6;
    }
  };
  var measureVarInt = (value) => {
    if (value < (1 << 7) - 1) {
      return 1;
    } else if (value < (1 << 14) - 1) {
      return 2;
    } else if (value < (1 << 21) - 1) {
      return 3;
    } else if (value < (1 << 28) - 1) {
      return 4;
    } else if (value < 2 ** 35 - 1) {
      return 5;
    } else if (value < 2 ** 42 - 1) {
      return 6;
    } else {
      throw new Error("EBML varint size not supported " + value);
    }
  };
  var EBMLWriter = class {
    constructor(writer) {
      this.writer = writer;
      this.helper = new Uint8Array(8);
      this.helperView = new DataView(this.helper.buffer);
      /**
       * Stores the position from the start of the file to where EBML elements have been written. This is used to
       * rewrite/edit elements that were already added before, and to measure sizes of things.
       */
      this.offsets = /* @__PURE__ */ new WeakMap();
      /** Same as offsets, but stores position where the element's data starts (after ID and size fields). */
      this.dataOffsets = /* @__PURE__ */ new WeakMap();
    }
    writeByte(value) {
      this.helperView.setUint8(0, value);
      this.writer.write(this.helper.subarray(0, 1));
    }
    writeFloat32(value) {
      this.helperView.setFloat32(0, value, false);
      this.writer.write(this.helper.subarray(0, 4));
    }
    writeFloat64(value) {
      this.helperView.setFloat64(0, value, false);
      this.writer.write(this.helper);
    }
    writeUnsignedInt(value, width = measureUnsignedInt(value)) {
      let pos = 0;
      switch (width) {
        case 6:
          this.helperView.setUint8(pos++, value / 2 ** 40 | 0);
        // eslint-disable-next-line no-fallthrough
        case 5:
          this.helperView.setUint8(pos++, value / 2 ** 32 | 0);
        // eslint-disable-next-line no-fallthrough
        case 4:
          this.helperView.setUint8(pos++, value >> 24);
        // eslint-disable-next-line no-fallthrough
        case 3:
          this.helperView.setUint8(pos++, value >> 16);
        // eslint-disable-next-line no-fallthrough
        case 2:
          this.helperView.setUint8(pos++, value >> 8);
        // eslint-disable-next-line no-fallthrough
        case 1:
          this.helperView.setUint8(pos++, value);
          break;
        default:
          throw new Error("Bad unsigned int size " + width);
      }
      this.writer.write(this.helper.subarray(0, pos));
    }
    writeSignedInt(value, width = measureSignedInt(value)) {
      if (value < 0) {
        value += 2 ** (width * 8);
      }
      this.writeUnsignedInt(value, width);
    }
    writeVarInt(value, width = measureVarInt(value)) {
      let pos = 0;
      switch (width) {
        case 1:
          this.helperView.setUint8(pos++, 1 << 7 | value);
          break;
        case 2:
          this.helperView.setUint8(pos++, 1 << 6 | value >> 8);
          this.helperView.setUint8(pos++, value);
          break;
        case 3:
          this.helperView.setUint8(pos++, 1 << 5 | value >> 16);
          this.helperView.setUint8(pos++, value >> 8);
          this.helperView.setUint8(pos++, value);
          break;
        case 4:
          this.helperView.setUint8(pos++, 1 << 4 | value >> 24);
          this.helperView.setUint8(pos++, value >> 16);
          this.helperView.setUint8(pos++, value >> 8);
          this.helperView.setUint8(pos++, value);
          break;
        case 5:
          this.helperView.setUint8(pos++, 1 << 3 | value / 2 ** 32 & 7);
          this.helperView.setUint8(pos++, value >> 24);
          this.helperView.setUint8(pos++, value >> 16);
          this.helperView.setUint8(pos++, value >> 8);
          this.helperView.setUint8(pos++, value);
          break;
        case 6:
          this.helperView.setUint8(pos++, 1 << 2 | value / 2 ** 40 & 3);
          this.helperView.setUint8(pos++, value / 2 ** 32 | 0);
          this.helperView.setUint8(pos++, value >> 24);
          this.helperView.setUint8(pos++, value >> 16);
          this.helperView.setUint8(pos++, value >> 8);
          this.helperView.setUint8(pos++, value);
          break;
        default:
          throw new Error("Bad EBML varint size " + width);
      }
      this.writer.write(this.helper.subarray(0, pos));
    }
    // Assumes the string is ASCII
    writeString(str) {
      this.writer.write(new Uint8Array(str.split("").map((x) => x.charCodeAt(0))));
    }
    writeEBML(data) {
      if (data === null) return;
      if (data instanceof Uint8Array) {
        this.writer.write(data);
      } else if (Array.isArray(data)) {
        for (const elem of data) {
          this.writeEBML(elem);
        }
      } else {
        this.offsets.set(data, this.writer.getPos());
        this.writeUnsignedInt(data.id);
        if (Array.isArray(data.data)) {
          const sizePos = this.writer.getPos();
          const sizeSize = data.size === -1 ? 1 : data.size ?? 4;
          if (data.size === -1) {
            this.writeByte(255);
          } else {
            this.writer.seek(this.writer.getPos() + sizeSize);
          }
          const startPos = this.writer.getPos();
          this.dataOffsets.set(data, startPos);
          this.writeEBML(data.data);
          if (data.size !== -1) {
            const size = this.writer.getPos() - startPos;
            const endPos = this.writer.getPos();
            this.writer.seek(sizePos);
            this.writeVarInt(size, sizeSize);
            this.writer.seek(endPos);
          }
        } else if (typeof data.data === "number") {
          const size = data.size ?? measureUnsignedInt(data.data);
          this.writeVarInt(size);
          this.writeUnsignedInt(data.data, size);
        } else if (typeof data.data === "string") {
          this.writeVarInt(data.data.length);
          this.writeString(data.data);
        } else if (data.data instanceof Uint8Array) {
          this.writeVarInt(data.data.byteLength, data.size);
          this.writer.write(data.data);
        } else if (data.data instanceof EBMLFloat32) {
          this.writeVarInt(4);
          this.writeFloat32(data.data.value);
        } else if (data.data instanceof EBMLFloat64) {
          this.writeVarInt(8);
          this.writeFloat64(data.data.value);
        } else if (data.data instanceof EBMLSignedInt) {
          const size = data.size ?? measureSignedInt(data.data.value);
          this.writeVarInt(size);
          this.writeSignedInt(data.data.value, size);
        }
      }
    }
  };
  var MAX_VAR_INT_SIZE = 8;
  var MIN_HEADER_SIZE = 2;
  var MAX_HEADER_SIZE = 4 + MAX_VAR_INT_SIZE;
  var EBMLReader = class {
    constructor(reader) {
      this.reader = reader;
      this.pos = 0;
    }
    readBytes(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      return new Uint8Array(view2.buffer, offset, length);
    }
    readU8() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 1);
      this.pos++;
      return view2.getUint8(offset);
    }
    readS16() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 2);
      this.pos += 2;
      return view2.getInt16(offset, false);
    }
    readVarIntSize() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 1);
      const firstByte = view2.getUint8(offset);
      let width = 1;
      let mask = 128;
      while ((firstByte & mask) === 0 && width < 8) {
        width++;
        mask >>= 1;
      }
      return width;
    }
    readVarInt() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 1);
      const firstByte = view2.getUint8(offset);
      let width = 1;
      let mask = 128;
      while ((firstByte & mask) === 0 && width < MAX_VAR_INT_SIZE) {
        width++;
        mask >>= 1;
      }
      const { view: fullView, offset: fullOffset } = this.reader.getViewAndOffset(this.pos, this.pos + width);
      let value = firstByte & mask - 1;
      for (let i = 1; i < width; i++) {
        value = value << 8 | fullView.getUint8(fullOffset + i);
      }
      this.pos += width;
      return value;
    }
    readUnsignedInt(width) {
      if (width < 1 || width > 8) {
        throw new Error("Bad unsigned int size " + width);
      }
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + width);
      let value = 0;
      for (let i = 0; i < width; i++) {
        value = value << 8 | view2.getUint8(offset + i);
      }
      this.pos += width;
      return value;
    }
    readSignedInt(width) {
      let value = this.readUnsignedInt(width);
      if (value & 1 << width * 8 - 1) {
        value -= 2 ** (width * 8);
      }
      return value;
    }
    readFloat(width) {
      if (width === 0) {
        return 0;
      }
      if (width !== 4 && width !== 8) {
        throw new Error("Bad float size " + width);
      }
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + width);
      const value = width === 4 ? view2.getFloat32(offset, false) : view2.getFloat64(offset, false);
      this.pos += width;
      return value;
    }
    readString(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      return String.fromCharCode(...new Uint8Array(view2.buffer, offset, length));
    }
    readElementId() {
      const size = this.readVarIntSize();
      const id = this.readUnsignedInt(size);
      return id;
    }
    readElementSize() {
      let size = this.readU8();
      if (size === 255) {
        size = -1;
      } else {
        this.pos--;
        size = this.readVarInt();
      }
      return size;
    }
    readElementHeader() {
      const id = this.readElementId();
      const size = this.readElementSize();
      return { id, size };
    }
  };
  var CODEC_STRING_MAP = {
    "avc": "V_MPEG4/ISO/AVC",
    "hevc": "V_MPEGH/ISO/HEVC",
    "vp8": "V_VP8",
    "vp9": "V_VP9",
    "av1": "V_AV1",
    "aac": "A_AAC",
    "mp3": "A_MPEG/L3",
    "opus": "A_OPUS",
    "vorbis": "A_VORBIS",
    "flac": "A_FLAC",
    "pcm-u8": "A_PCM/INT/LIT",
    "pcm-s16": "A_PCM/INT/LIT",
    "pcm-s16be": "A_PCM/INT/BIG",
    "pcm-s24": "A_PCM/INT/LIT",
    "pcm-s24be": "A_PCM/INT/BIG",
    "pcm-s32": "A_PCM/INT/LIT",
    "pcm-s32be": "A_PCM/INT/BIG",
    "pcm-f32": "A_PCM/FLOAT/IEEE",
    "webvtt": "S_TEXT/WEBVTT"
  };

  // src/matroska/matroska-muxer.ts
  var MAX_CHUNK_LENGTH_MS = 2 ** 15;
  var APP_NAME = "https://github.com/Vanilagy/webm-muxer";
  var SEGMENT_SIZE_BYTES = 6;
  var CLUSTER_SIZE_BYTES = 5;
  var TRACK_TYPE_MAP = {
    video: 1,
    audio: 2,
    subtitle: 17
  };
  var MatroskaMuxer = class extends Muxer {
    constructor(output, format) {
      super(output);
      this.trackDatas = [];
      this.segment = null;
      this.segmentInfo = null;
      this.seekHead = null;
      this.tracksElement = null;
      this.segmentDuration = null;
      this.cues = null;
      this.currentCluster = null;
      this.currentClusterStartMsTimestamp = null;
      this.currentClusterMaxMsTimestamp = null;
      this.trackDatasInCurrentCluster = /* @__PURE__ */ new Map();
      this.duration = 0;
      this.writer = output._writer;
      this.format = format;
      this.ebmlWriter = new EBMLWriter(this.writer);
      if (this.format._options.streamable) {
        this.writer.ensureMonotonicity = true;
      }
    }
    async start() {
      const release = await this.mutex.acquire();
      this.writeEBMLHeader();
      if (!this.format._options.streamable) {
        this.createSeekHead();
      }
      this.createSegmentInfo();
      this.createCues();
      await this.writer.flush();
      release();
    }
    writeEBMLHeader() {
      const ebmlHeader = { id: 440786851 /* EBML */, data: [
        { id: 17030 /* EBMLVersion */, data: 1 },
        { id: 17143 /* EBMLReadVersion */, data: 1 },
        { id: 17138 /* EBMLMaxIDLength */, data: 4 },
        { id: 17139 /* EBMLMaxSizeLength */, data: 8 },
        { id: 17026 /* DocType */, data: this.format instanceof WebMOutputFormat ? "webm" : "matroska" },
        { id: 17031 /* DocTypeVersion */, data: 2 },
        { id: 17029 /* DocTypeReadVersion */, data: 2 }
      ] };
      this.ebmlWriter.writeEBML(ebmlHeader);
    }
    /**
     * Creates a SeekHead element which is positioned near the start of the file and allows the media player to seek to
     * relevant sections more easily. Since we don't know the positions of those sections yet, we'll set them later.
     */
    createSeekHead() {
      const kaxCues = new Uint8Array([28, 83, 187, 107]);
      const kaxInfo = new Uint8Array([21, 73, 169, 102]);
      const kaxTracks = new Uint8Array([22, 84, 174, 107]);
      const seekHead = { id: 290298740 /* SeekHead */, data: [
        { id: 19899 /* Seek */, data: [
          { id: 21419 /* SeekID */, data: kaxCues },
          { id: 21420 /* SeekPosition */, size: 5, data: 0 }
        ] },
        { id: 19899 /* Seek */, data: [
          { id: 21419 /* SeekID */, data: kaxInfo },
          { id: 21420 /* SeekPosition */, size: 5, data: 0 }
        ] },
        { id: 19899 /* Seek */, data: [
          { id: 21419 /* SeekID */, data: kaxTracks },
          { id: 21420 /* SeekPosition */, size: 5, data: 0 }
        ] }
      ] };
      this.seekHead = seekHead;
    }
    createSegmentInfo() {
      const segmentDuration = { id: 17545 /* Duration */, data: new EBMLFloat64(0) };
      this.segmentDuration = segmentDuration;
      const segmentInfo = { id: 357149030 /* Info */, data: [
        { id: 2807729 /* TimestampScale */, data: 1e6 },
        { id: 19840 /* MuxingApp */, data: APP_NAME },
        { id: 22337 /* WritingApp */, data: APP_NAME },
        !this.format._options.streamable ? segmentDuration : null
      ] };
      this.segmentInfo = segmentInfo;
    }
    createTracks() {
      const tracksElement = { id: 374648427 /* Tracks */, data: [] };
      this.tracksElement = tracksElement;
      for (const trackData of this.trackDatas) {
        const codecId = CODEC_STRING_MAP[trackData.track.source._codec];
        assert(codecId);
        let seekPreRollNs = 0;
        if (trackData.type === "audio" && trackData.track.source._codec === "opus") {
          seekPreRollNs = 1e6 * 80;
          const description = trackData.info.decoderConfig.description;
          if (description) {
            const bytes2 = toUint8Array(description);
            const header = parseOpusIdentificationHeader(bytes2);
            seekPreRollNs = Math.round(1e9 * (header.preSkip / OPUS_INTERNAL_SAMPLE_RATE));
          }
        }
        tracksElement.data.push({ id: 174 /* TrackEntry */, data: [
          { id: 215 /* TrackNumber */, data: trackData.track.id },
          { id: 29637 /* TrackUID */, data: trackData.track.id },
          { id: 131 /* TrackType */, data: TRACK_TYPE_MAP[trackData.type] },
          { id: 156 /* FlagLacing */, data: 0 },
          { id: 2274716 /* Language */, data: trackData.track.metadata.languageCode ?? UNDETERMINED_LANGUAGE },
          { id: 134 /* CodecID */, data: codecId },
          { id: 22186 /* CodecDelay */, data: 0 },
          { id: 22203 /* SeekPreRoll */, data: seekPreRollNs },
          trackData.type === "video" ? this.videoSpecificTrackInfo(trackData) : null,
          trackData.type === "audio" ? this.audioSpecificTrackInfo(trackData) : null,
          trackData.type === "subtitle" ? this.subtitleSpecificTrackInfo(trackData) : null
        ] });
      }
    }
    videoSpecificTrackInfo(trackData) {
      const { frameRate, rotation } = trackData.track.metadata;
      const elements = [
        trackData.info.decoderConfig.description ? {
          id: 25506 /* CodecPrivate */,
          data: toUint8Array(trackData.info.decoderConfig.description)
        } : null,
        frameRate ? {
          id: 2352003 /* DefaultDuration */,
          data: 1e9 / frameRate
        } : null
      ];
      const flippedRotation = rotation ? normalizeRotation(-rotation) : 0;
      const colorSpace = trackData.info.decoderConfig.colorSpace;
      const videoElement = { id: 224 /* Video */, data: [
        { id: 176 /* PixelWidth */, data: trackData.info.width },
        { id: 186 /* PixelHeight */, data: trackData.info.height },
        colorSpaceIsComplete(colorSpace) ? {
          id: 21936 /* Colour */,
          data: [
            {
              id: 21937 /* MatrixCoefficients */,
              data: MATRIX_COEFFICIENTS_MAP[colorSpace.matrix]
            },
            {
              id: 21946 /* TransferCharacteristics */,
              data: TRANSFER_CHARACTERISTICS_MAP[colorSpace.transfer]
            },
            {
              id: 21947 /* Primaries */,
              data: COLOR_PRIMARIES_MAP[colorSpace.primaries]
            },
            {
              id: 21945 /* Range */,
              data: colorSpace.fullRange ? 2 : 1
            }
          ]
        } : null,
        flippedRotation ? {
          id: 30320 /* Projection */,
          data: [
            {
              id: 30321 /* ProjectionType */,
              data: 0
              // rectangular
            },
            {
              id: 30325 /* ProjectionPoseRoll */,
              data: new EBMLFloat32((flippedRotation + 180) % 360 - 180)
              // [0, 270] -> [-180, 90]
            }
          ]
        } : null
      ] };
      elements.push(videoElement);
      return elements;
    }
    audioSpecificTrackInfo(trackData) {
      const pcmInfo = PCM_AUDIO_CODECS.includes(trackData.track.source._codec) ? parsePcmCodec(trackData.track.source._codec) : null;
      return [
        trackData.info.decoderConfig.description ? {
          id: 25506 /* CodecPrivate */,
          data: toUint8Array(trackData.info.decoderConfig.description)
        } : null,
        { id: 225 /* Audio */, data: [
          { id: 181 /* SamplingFrequency */, data: new EBMLFloat32(trackData.info.sampleRate) },
          { id: 159 /* Channels */, data: trackData.info.numberOfChannels },
          pcmInfo ? { id: 25188 /* BitDepth */, data: 8 * pcmInfo.sampleSize } : null
        ] }
      ];
    }
    subtitleSpecificTrackInfo(trackData) {
      return [
        { id: 25506 /* CodecPrivate */, data: textEncoder.encode(trackData.info.config.description) }
      ];
    }
    createSegment() {
      const segment = {
        id: 408125543 /* Segment */,
        size: this.format._options.streamable ? -1 : SEGMENT_SIZE_BYTES,
        data: [
          !this.format._options.streamable ? this.seekHead : null,
          this.segmentInfo,
          this.tracksElement
        ]
      };
      this.segment = segment;
      this.ebmlWriter.writeEBML(segment);
    }
    createCues() {
      this.cues = { id: 475249515 /* Cues */, data: [] };
    }
    get segmentDataOffset() {
      assert(this.segment);
      return this.ebmlWriter.dataOffsets.get(this.segment);
    }
    getVideoTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((x) => x.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      validateVideoChunkMetadata(meta);
      assert(meta);
      assert(meta.decoderConfig);
      assert(meta.decoderConfig.codedWidth !== void 0);
      assert(meta.decoderConfig.codedHeight !== void 0);
      const newTrackData = {
        track,
        type: "video",
        info: {
          width: meta.decoderConfig.codedWidth,
          height: meta.decoderConfig.codedHeight,
          decoderConfig: meta.decoderConfig
        },
        chunkQueue: [],
        lastWrittenMsTimestamp: null
      };
      if (track.source._codec === "av1") {
        newTrackData.info.decoderConfig = {
          ...newTrackData.info.decoderConfig,
          description: new Uint8Array(
            generateAv1CodecConfigurationFromCodecString(newTrackData.info.decoderConfig.codec)
          )
        };
      }
      this.trackDatas.push(newTrackData);
      this.trackDatas.sort((a, b) => a.track.id - b.track.id);
      return newTrackData;
    }
    getAudioTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((x) => x.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      validateAudioChunkMetadata(meta);
      assert(meta);
      assert(meta.decoderConfig);
      const newTrackData = {
        track,
        type: "audio",
        info: {
          numberOfChannels: meta.decoderConfig.numberOfChannels,
          sampleRate: meta.decoderConfig.sampleRate,
          decoderConfig: meta.decoderConfig
        },
        chunkQueue: [],
        lastWrittenMsTimestamp: null
      };
      this.trackDatas.push(newTrackData);
      this.trackDatas.sort((a, b) => a.track.id - b.track.id);
      return newTrackData;
    }
    getSubtitleTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((x) => x.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      validateSubtitleMetadata(meta);
      assert(meta);
      assert(meta.config);
      const newTrackData = {
        track,
        type: "subtitle",
        info: {
          config: meta.config
        },
        chunkQueue: [],
        lastWrittenMsTimestamp: null
      };
      this.trackDatas.push(newTrackData);
      this.trackDatas.sort((a, b) => a.track.id - b.track.id);
      return newTrackData;
    }
    async addEncodedVideoPacket(track, packet, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getVideoTrackData(track, meta);
        const isKeyFrame = packet.type === "key";
        const timestamp = this.validateAndNormalizeTimestamp(trackData.track, packet.timestamp, isKeyFrame);
        const videoChunk = this.createInternalChunk(packet.data, timestamp, packet.duration, packet.type);
        if (track.source._codec === "vp9") this.fixVP9ColorSpace(trackData, videoChunk);
        trackData.chunkQueue.push(videoChunk);
        await this.interleaveChunks();
      } finally {
        release();
      }
    }
    async addEncodedAudioPacket(track, packet, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getAudioTrackData(track, meta);
        const isKeyFrame = packet.type === "key";
        const timestamp = this.validateAndNormalizeTimestamp(trackData.track, packet.timestamp, isKeyFrame);
        const audioChunk = this.createInternalChunk(packet.data, timestamp, packet.duration, packet.type);
        trackData.chunkQueue.push(audioChunk);
        await this.interleaveChunks();
      } finally {
        release();
      }
    }
    async addSubtitleCue(track, cue, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getSubtitleTrackData(track, meta);
        const timestamp = this.validateAndNormalizeTimestamp(trackData.track, cue.timestamp, true);
        let bodyText = cue.text;
        const timestampMs = Math.round(timestamp * 1e3);
        inlineTimestampRegex.lastIndex = 0;
        bodyText = bodyText.replace(inlineTimestampRegex, (match) => {
          const time = parseSubtitleTimestamp(match.slice(1, -1));
          const offsetTime = time - timestampMs;
          return `<${formatSubtitleTimestamp(offsetTime)}>`;
        });
        const body = textEncoder.encode(bodyText);
        const additions = `${cue.settings ?? ""}
${cue.identifier ?? ""}
${cue.notes ?? ""}`;
        const subtitleChunk = this.createInternalChunk(
          body,
          timestamp,
          cue.duration,
          "key",
          additions.trim() ? textEncoder.encode(additions) : null
        );
        trackData.chunkQueue.push(subtitleChunk);
        await this.interleaveChunks();
      } finally {
        release();
      }
    }
    async interleaveChunks(isFinalCall = false) {
      if (!isFinalCall) {
        for (const track of this.output._tracks) {
          if (!track.source._closed && !this.trackDatas.some((x) => x.track === track)) {
            return;
          }
        }
      }
      outer:
        while (true) {
          let trackWithMinTimestamp = null;
          let minTimestamp = Infinity;
          for (const trackData of this.trackDatas) {
            if (!isFinalCall && trackData.chunkQueue.length === 0 && !trackData.track.source._closed) {
              break outer;
            }
            if (trackData.chunkQueue.length > 0 && trackData.chunkQueue[0].timestamp < minTimestamp) {
              trackWithMinTimestamp = trackData;
              minTimestamp = trackData.chunkQueue[0].timestamp;
            }
          }
          if (!trackWithMinTimestamp) {
            break;
          }
          const chunk = trackWithMinTimestamp.chunkQueue.shift();
          this.writeBlock(trackWithMinTimestamp, chunk);
        }
      if (!isFinalCall) {
        await this.writer.flush();
      }
    }
    /** Due to [a bug in Chromium](https://bugs.chromium.org/p/chromium/issues/detail?id=1377842), VP9 streams often
     * lack color space information. This method patches in that information. */
    // http://downloads.webmproject.org/docs/vp9/vp9-bitstream_superframe-and-uncompressed-header_v1.0.pdf
    fixVP9ColorSpace(trackData, chunk) {
      if (chunk.type !== "key") return;
      if (!trackData.info.decoderConfig.colorSpace || !trackData.info.decoderConfig.colorSpace.matrix) return;
      let i = 0;
      if (readBits(chunk.data, 0, 2) !== 2) return;
      i += 2;
      const profile = (readBits(chunk.data, i + 1, i + 2) << 1) + readBits(chunk.data, i + 0, i + 1);
      i += 2;
      if (profile === 3) i++;
      const showExistingFrame = readBits(chunk.data, i + 0, i + 1);
      i++;
      if (showExistingFrame) return;
      const frameType = readBits(chunk.data, i + 0, i + 1);
      i++;
      if (frameType !== 0) return;
      i += 2;
      const syncCode = readBits(chunk.data, i + 0, i + 24);
      i += 24;
      if (syncCode !== 4817730) return;
      if (profile >= 2) i++;
      const colorSpaceID = {
        rgb: 7,
        bt709: 2,
        bt470bg: 1,
        smpte170m: 3
      }[trackData.info.decoderConfig.colorSpace.matrix];
      writeBits(chunk.data, i + 0, i + 3, colorSpaceID);
    }
    /** Converts a read-only external chunk into an internal one for easier use. */
    createInternalChunk(data, timestamp, duration, type, additions = null) {
      const internalChunk = {
        data,
        type,
        timestamp,
        duration,
        additions
      };
      return internalChunk;
    }
    /** Writes a block containing media data to the file. */
    writeBlock(trackData, chunk) {
      if (!this.segment) {
        this.createTracks();
        this.createSegment();
      }
      const msTimestamp = Math.round(1e3 * chunk.timestamp);
      const keyFrameQueuedEverywhere = this.trackDatas.every((otherTrackData) => {
        if (trackData === otherTrackData) {
          return chunk.type === "key";
        }
        const firstQueuedSample = otherTrackData.chunkQueue[0];
        if (firstQueuedSample) {
          return firstQueuedSample.type === "key";
        }
        return otherTrackData.track.source._closed;
      });
      if (!this.currentCluster || keyFrameQueuedEverywhere && msTimestamp > this.currentClusterMaxMsTimestamp && msTimestamp - this.currentClusterStartMsTimestamp >= 1e3) {
        this.createNewCluster(msTimestamp);
      }
      const relativeTimestamp = msTimestamp - this.currentClusterStartMsTimestamp;
      if (relativeTimestamp < -(2 ** 15)) {
        return;
      }
      const clusterIsTooLong = relativeTimestamp >= MAX_CHUNK_LENGTH_MS;
      if (clusterIsTooLong) {
        throw new Error(
          `Current Matroska cluster exceeded its maximum allowed length of ${MAX_CHUNK_LENGTH_MS} milliseconds. In order to produce a correct WebM file, you must pass in a key frame at least every ${MAX_CHUNK_LENGTH_MS} milliseconds.`
        );
      }
      const prelude = new Uint8Array(4);
      const view2 = new DataView(prelude.buffer);
      view2.setUint8(0, 128 | trackData.track.id);
      view2.setInt16(1, relativeTimestamp, false);
      const msDuration = Math.round(1e3 * chunk.duration);
      if (msDuration === 0 && !chunk.additions) {
        view2.setUint8(3, Number(chunk.type === "key") << 7);
        const simpleBlock = { id: 163 /* SimpleBlock */, data: [
          prelude,
          chunk.data
        ] };
        this.ebmlWriter.writeEBML(simpleBlock);
      } else {
        const blockGroup = { id: 160 /* BlockGroup */, data: [
          { id: 161 /* Block */, data: [
            prelude,
            chunk.data
          ] },
          chunk.type === "delta" ? {
            id: 251 /* ReferenceBlock */,
            data: new EBMLSignedInt(trackData.lastWrittenMsTimestamp - msTimestamp)
          } : null,
          chunk.additions ? { id: 30113 /* BlockAdditions */, data: [
            { id: 166 /* BlockMore */, data: [
              { id: 165 /* BlockAdditional */, data: chunk.additions },
              { id: 238 /* BlockAddID */, data: 1 }
            ] }
          ] } : null,
          msDuration > 0 ? { id: 155 /* BlockDuration */, data: msDuration } : null
        ] };
        this.ebmlWriter.writeEBML(blockGroup);
      }
      this.duration = Math.max(this.duration, msTimestamp + msDuration);
      trackData.lastWrittenMsTimestamp = msTimestamp;
      if (!this.trackDatasInCurrentCluster.has(trackData)) {
        this.trackDatasInCurrentCluster.set(trackData, {
          firstMsTimestamp: msTimestamp
        });
      }
      this.currentClusterMaxMsTimestamp = Math.max(this.currentClusterMaxMsTimestamp, msTimestamp);
    }
    /** Creates a new Cluster element to contain media chunks. */
    createNewCluster(msTimestamp) {
      if (this.currentCluster && !this.format._options.streamable) {
        this.finalizeCurrentCluster();
      }
      this.currentCluster = {
        id: 524531317 /* Cluster */,
        size: this.format._options.streamable ? -1 : CLUSTER_SIZE_BYTES,
        data: [
          { id: 231 /* Timestamp */, data: msTimestamp }
        ]
      };
      this.ebmlWriter.writeEBML(this.currentCluster);
      this.currentClusterStartMsTimestamp = msTimestamp;
      this.currentClusterMaxMsTimestamp = msTimestamp;
      this.trackDatasInCurrentCluster.clear();
    }
    finalizeCurrentCluster() {
      assert(this.currentCluster);
      const clusterSize = this.writer.getPos() - this.ebmlWriter.dataOffsets.get(this.currentCluster);
      const endPos = this.writer.getPos();
      this.writer.seek(this.ebmlWriter.offsets.get(this.currentCluster) + 4);
      this.ebmlWriter.writeVarInt(clusterSize, CLUSTER_SIZE_BYTES);
      this.writer.seek(endPos);
      const clusterOffsetFromSegment = this.ebmlWriter.offsets.get(this.currentCluster) - this.segmentDataOffset;
      const groupedByTimestamp = /* @__PURE__ */ new Map();
      for (const [trackData, { firstMsTimestamp }] of this.trackDatasInCurrentCluster) {
        if (!groupedByTimestamp.has(firstMsTimestamp)) {
          groupedByTimestamp.set(firstMsTimestamp, []);
        }
        groupedByTimestamp.get(firstMsTimestamp).push(trackData);
      }
      const groupedAndSortedByTimestamp = [...groupedByTimestamp.entries()].sort((a, b) => a[0] - b[0]);
      for (const [msTimestamp, trackDatas] of groupedAndSortedByTimestamp) {
        assert(this.cues);
        this.cues.data.push({ id: 187 /* CuePoint */, data: [
          { id: 179 /* CueTime */, data: msTimestamp },
          // Create CueTrackPositions for each track that starts at this timestamp
          ...trackDatas.map((trackData) => {
            return { id: 183 /* CueTrackPositions */, data: [
              { id: 247 /* CueTrack */, data: trackData.track.id },
              { id: 241 /* CueClusterPosition */, data: clusterOffsetFromSegment }
            ] };
          })
        ] });
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async onTrackClose() {
      const release = await this.mutex.acquire();
      await this.interleaveChunks();
      release();
    }
    /** Finalizes the file, making it ready for use. Must be called after all media chunks have been added. */
    async finalize() {
      const release = await this.mutex.acquire();
      if (!this.segment) {
        this.createTracks();
        this.createSegment();
      }
      await this.interleaveChunks(true);
      if (!this.format._options.streamable && this.currentCluster) {
        this.finalizeCurrentCluster();
      }
      assert(this.cues);
      this.ebmlWriter.writeEBML(this.cues);
      if (!this.format._options.streamable) {
        const endPos = this.writer.getPos();
        const segmentSize = this.writer.getPos() - this.segmentDataOffset;
        this.writer.seek(this.ebmlWriter.offsets.get(this.segment) + 4);
        this.ebmlWriter.writeVarInt(segmentSize, SEGMENT_SIZE_BYTES);
        this.segmentDuration.data = new EBMLFloat64(this.duration);
        this.writer.seek(this.ebmlWriter.offsets.get(this.segmentDuration));
        this.ebmlWriter.writeEBML(this.segmentDuration);
        this.seekHead.data[0].data[1].data = this.ebmlWriter.offsets.get(this.cues) - this.segmentDataOffset;
        this.seekHead.data[1].data[1].data = this.ebmlWriter.offsets.get(this.segmentInfo) - this.segmentDataOffset;
        this.seekHead.data[2].data[1].data = this.ebmlWriter.offsets.get(this.tracksElement) - this.segmentDataOffset;
        this.writer.seek(this.ebmlWriter.offsets.get(this.seekHead));
        this.ebmlWriter.writeEBML(this.seekHead);
        this.writer.seek(endPos);
      }
      release();
    }
  };

  // src/mp3/mp3-misc.ts
  var FRAME_HEADER_SIZE = 4;
  var MPEG_V1_BITRATES = {
    // Layer 3
    1: [-1, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
    // Layer 2
    2: [-1, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1],
    // Layer 1
    3: [-1, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1]
  };
  var MPEG_V2_BITRATES = {
    // Layer 3
    1: [-1, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1],
    // Layer 2
    2: [-1, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
    // Layer 1
    3: [-1, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1]
  };
  var SAMPLING_RATES = {
    // MPEG Version 2.5
    0: [11025, 12e3, 8e3, -1],
    // MPEG Version 2 (ISO/IEC 13818-3)
    2: [22050, 24e3, 16e3, -1],
    // MPEG Version 1 (ISO/IEC 11172-3)
    3: [44100, 48e3, 32e3, -1]
  };
  var XING = 1483304551;
  var INFO = 1231971951;
  var computeMp3FrameSize = (layer, bitrate, sampleRate, padding) => {
    if (layer === 3) {
      return Math.floor((12 * bitrate / sampleRate + padding) * 4);
    } else {
      return Math.floor(144 * bitrate / sampleRate + padding);
    }
  };
  var getXingOffset = (mpegVersionId, channel) => {
    return mpegVersionId === 3 ? channel === 3 ? 21 : 36 : channel === 3 ? 13 : 21;
  };
  var readFrameHeader = (word, reader) => {
    const startPos = reader.pos;
    const firstByte = word >>> 24;
    const secondByte = word >>> 16 & 255;
    const thirdByte = word >>> 8 & 255;
    const fourthByte = word & 255;
    if (firstByte !== 255 && secondByte !== 255 && thirdByte !== 255 && fourthByte !== 255) {
      reader.pos += 4;
      return null;
    }
    reader.pos += 1;
    if ((secondByte & 224) !== 224) {
      return null;
    }
    const mpegVersionId = secondByte >> 3 & 3;
    const layer = secondByte >> 1 & 3;
    const bitrateIndex = thirdByte >> 4 & 15;
    const frequencyIndex = thirdByte >> 2 & 3;
    const padding = thirdByte >> 1 & 1;
    const channel = fourthByte >> 6 & 3;
    const modeExtension = fourthByte >> 4 & 3;
    const copyright = fourthByte >> 3 & 1;
    const original = fourthByte >> 2 & 1;
    const emphasis = fourthByte & 3;
    const kilobitRate = mpegVersionId === 3 ? MPEG_V1_BITRATES[layer]?.[bitrateIndex] : MPEG_V2_BITRATES[layer]?.[bitrateIndex];
    if (!kilobitRate || kilobitRate === -1) {
      return null;
    }
    const bitrate = kilobitRate * 1e3;
    const sampleRate = SAMPLING_RATES[mpegVersionId]?.[frequencyIndex];
    if (!sampleRate || sampleRate === -1) {
      return null;
    }
    const frameLength = computeMp3FrameSize(layer, bitrate, sampleRate, padding);
    if (reader.fileSize !== null && reader.fileSize - startPos < frameLength) {
      return null;
    }
    let audioSamplesInFrame;
    if (mpegVersionId === 3) {
      audioSamplesInFrame = layer === 3 ? 384 : 1152;
    } else {
      if (layer === 3) {
        audioSamplesInFrame = 384;
      } else if (layer === 2) {
        audioSamplesInFrame = 1152;
      } else {
        audioSamplesInFrame = 576;
      }
    }
    return {
      startPos,
      totalSize: frameLength,
      mpegVersionId,
      layer,
      bitrate,
      frequencyIndex,
      sampleRate,
      channel,
      modeExtension,
      copyright,
      original,
      emphasis,
      audioSamplesInFrame
    };
  };

  // src/mp3/mp3-writer.ts
  var Mp3Writer = class {
    constructor(writer) {
      this.writer = writer;
      this.helper = new Uint8Array(8);
      this.helperView = new DataView(this.helper.buffer);
    }
    writeU32(value) {
      this.helperView.setUint32(0, value, false);
      this.writer.write(this.helper.subarray(0, 4));
    }
    writeXingFrame(data) {
      const startPos = this.writer.getPos();
      const firstByte = 255;
      const secondByte = 224 | data.mpegVersionId << 3 | data.layer << 1;
      const bitrateGroup = data.mpegVersionId === 3 ? MPEG_V1_BITRATES : MPEG_V2_BITRATES;
      const bitrates = bitrateGroup?.[data.layer];
      if (!bitrates) {
        throw new Error("Invalid MPEG version and layer combination.");
      }
      const sampleRate = SAMPLING_RATES[data.mpegVersionId]?.[data.frequencyIndex];
      if (!sampleRate || sampleRate === -1) {
        throw new Error("Invalid MPEG version and frequency index combination.");
      }
      const padding = 0;
      const neededBytes = 155;
      const bitrateIndex = bitrates.findIndex((kbr) => {
        return computeMp3FrameSize(data.layer, 1e3 * kbr, sampleRate, padding) >= neededBytes;
      });
      if (bitrateIndex === -1) {
        throw new Error("No suitable bitrate found.");
      }
      const thirdByte = bitrateIndex << 4 | data.frequencyIndex << 2 | padding << 1;
      const fourthByte = data.channel << 6 | data.modeExtension << 4 | data.copyright << 3 | data.original << 2 | data.emphasis;
      this.helper[0] = firstByte;
      this.helper[1] = secondByte;
      this.helper[2] = thirdByte;
      this.helper[3] = fourthByte;
      this.writer.write(this.helper.subarray(0, 4));
      const xingOffset = getXingOffset(data.mpegVersionId, data.channel);
      this.writer.seek(startPos + xingOffset);
      this.writeU32(XING);
      let flags = 0;
      if (data.frameCount !== null) {
        flags |= 1;
      }
      if (data.fileSize !== null) {
        flags |= 2;
      }
      if (data.toc !== null) {
        flags |= 4;
      }
      this.writeU32(flags);
      this.writeU32(data.frameCount ?? 0);
      this.writeU32(data.fileSize ?? 0);
      this.writer.write(data.toc ?? new Uint8Array(100));
      const frameSize = computeMp3FrameSize(data.layer, 1e3 * bitrates[bitrateIndex], sampleRate, padding);
      this.writer.seek(startPos + frameSize);
    }
  };

  // src/mp3/mp3-muxer.ts
  var Mp3Muxer = class extends Muxer {
    constructor(output) {
      super(output);
      this.xingFrameData = null;
      this.frameCount = 0;
      this.framePositions = [];
      this.writer = output._writer;
      this.mp3Writer = new Mp3Writer(output._writer);
    }
    async start() {
    }
    async addEncodedVideoPacket() {
      throw new Error("MP3 does not support video.");
    }
    async addEncodedAudioPacket(track, packet) {
      const release = await this.mutex.acquire();
      try {
        if (!this.xingFrameData) {
          const view2 = toDataView(packet.data);
          if (view2.byteLength < 4) {
            throw new Error("Invalid MP3 header in sample.");
          }
          const word = view2.getUint32(0, false);
          const header = readFrameHeader(word, { pos: 0, fileSize: null });
          if (!header) {
            throw new Error("Invalid MP3 header in sample.");
          }
          const xingOffset = getXingOffset(header.mpegVersionId, header.channel);
          if (view2.byteLength >= xingOffset + 4) {
            const word2 = view2.getUint32(xingOffset, false);
            const isXing = word2 === XING || word2 === INFO;
            if (isXing) {
              return;
            }
          }
          this.xingFrameData = {
            mpegVersionId: header.mpegVersionId,
            layer: header.layer,
            frequencyIndex: header.frequencyIndex,
            channel: header.channel,
            modeExtension: header.modeExtension,
            copyright: header.copyright,
            original: header.original,
            emphasis: header.emphasis,
            frameCount: null,
            fileSize: null,
            toc: null
          };
          this.mp3Writer.writeXingFrame(this.xingFrameData);
          this.frameCount++;
        }
        this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === "key");
        this.framePositions.push(this.writer.getPos());
        this.writer.write(packet.data);
        this.frameCount++;
        await this.writer.flush();
      } finally {
        release();
      }
    }
    async addSubtitleCue() {
      throw new Error("MP3 does not support subtitles.");
    }
    async finalize() {
      if (!this.xingFrameData) {
        return;
      }
      const release = await this.mutex.acquire();
      const endPos = this.writer.getPos();
      this.writer.seek(0);
      const toc = new Uint8Array(100);
      for (let i = 0; i < 100; i++) {
        const index = Math.floor(this.framePositions.length * (i / 100));
        assert(index !== -1 && index < this.framePositions.length);
        const byteOffset = this.framePositions[index];
        toc[i] = 256 * (byteOffset / endPos);
      }
      this.xingFrameData.frameCount = this.frameCount;
      this.xingFrameData.fileSize = endPos;
      this.xingFrameData.toc = toc;
      this.mp3Writer.writeXingFrame(this.xingFrameData);
      this.writer.seek(endPos);
      release();
    }
  };

  // src/ogg/ogg-misc.ts
  var OGGS = 1399285583;
  var OGG_CRC_POLYNOMIAL = 79764919;
  var OGG_CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n << 24;
    for (let k = 0; k < 8; k++) {
      crc = crc & 2147483648 ? crc << 1 ^ OGG_CRC_POLYNOMIAL : crc << 1;
    }
    OGG_CRC_TABLE[n] = crc >>> 0 & 4294967295;
  }
  var computeOggPageCrc = (bytes2) => {
    const view2 = toDataView(bytes2);
    const originalChecksum = view2.getUint32(22, true);
    view2.setUint32(22, 0, true);
    let crc = 0;
    for (let i = 0; i < bytes2.length; i++) {
      const byte = bytes2[i];
      crc = (crc << 8 ^ OGG_CRC_TABLE[crc >>> 24 ^ byte]) >>> 0;
    }
    view2.setUint32(22, originalChecksum, true);
    return crc;
  };
  var extractSampleMetadata = (data, codecInfo, vorbisLastBlocksize) => {
    let durationInSamples = 0;
    let currentBlocksize = null;
    if (data.length > 0) {
      if (codecInfo.codec === "vorbis") {
        assert(codecInfo.vorbisInfo);
        const vorbisModeCount = codecInfo.vorbisInfo.modeBlockflags.length;
        const bitCount = ilog(vorbisModeCount - 1);
        const modeMask = (1 << bitCount) - 1 << 1;
        const modeNumber = (data[0] & modeMask) >> 1;
        if (modeNumber >= codecInfo.vorbisInfo.modeBlockflags.length) {
          throw new Error("Invalid mode number.");
        }
        let prevBlocksize = vorbisLastBlocksize;
        const blockflag = codecInfo.vorbisInfo.modeBlockflags[modeNumber];
        currentBlocksize = codecInfo.vorbisInfo.blocksizes[blockflag];
        if (blockflag === 1) {
          const prevMask = (modeMask | 1) + 1;
          const flag = data[0] & prevMask ? 1 : 0;
          prevBlocksize = codecInfo.vorbisInfo.blocksizes[flag];
        }
        durationInSamples = prevBlocksize !== null ? prevBlocksize + currentBlocksize >> 2 : 0;
      } else if (codecInfo.codec === "opus") {
        const toc = parseOpusTocByte(data);
        durationInSamples = toc.durationInSamples;
      }
    }
    return {
      durationInSamples,
      vorbisBlockSize: currentBlocksize
    };
  };
  var parseModesFromVorbisSetupPacket = (setupHeader) => {
    class Bitstream {
      constructor(bytes2) {
        this.bytes = bytes2;
        this.pos = 0;
      }
      read(n) {
        const result = readBits(this.bytes, this.pos, this.pos + n);
        this.pos += n;
        return result;
      }
      skip(n) {
        this.pos += n;
      }
      getBitsLeft() {
        return this.bytes.length * 8 - this.pos;
      }
      getBitCount() {
        return this.pos;
      }
      clone() {
        const clone = new Bitstream(this.bytes);
        clone.pos = this.pos;
        return clone;
      }
    }
    if (setupHeader.length < 7) {
      throw new Error("Setup header is too short.");
    }
    if (setupHeader[0] !== 5) {
      throw new Error("Wrong packet type in Setup header.");
    }
    const signature = String.fromCharCode(...setupHeader.slice(1, 7));
    if (signature !== "vorbis") {
      throw new Error("Invalid packet signature in Setup header.");
    }
    const bufSize = setupHeader.length;
    const revBuffer = new Uint8Array(bufSize);
    for (let i = 0; i < bufSize; i++) {
      revBuffer[i] = setupHeader[bufSize - 1 - i];
    }
    const bs = new Bitstream(revBuffer);
    let gotFramingBit = 0;
    while (bs.getBitsLeft() > 97) {
      if (bs.read(1) === 1) {
        gotFramingBit = bs.getBitCount();
        break;
      }
    }
    if (gotFramingBit === 0) {
      throw new Error("Invalid Setup header: framing bit not found.");
    }
    let modeCount = 0;
    let gotModeHeader = false;
    let lastModeCount = 0;
    while (bs.getBitsLeft() >= 97) {
      const tempPos = bs.pos;
      const a = bs.read(8);
      const b = bs.read(16);
      const c = bs.read(16);
      if (a > 63 || b !== 0 || c !== 0) {
        bs.pos = tempPos;
        break;
      }
      bs.skip(1);
      modeCount++;
      if (modeCount > 64) {
        break;
      }
      const bsClone = bs.clone();
      const candidate = bsClone.read(6) + 1;
      if (candidate === modeCount) {
        gotModeHeader = true;
        lastModeCount = modeCount;
      }
    }
    if (!gotModeHeader) {
      throw new Error("Invalid Setup header: mode header not found.");
    }
    if (lastModeCount > 63) {
      throw new Error(`Unsupported mode count: ${lastModeCount}.`);
    }
    const finalModeCount = lastModeCount;
    bs.pos = 0;
    bs.skip(gotFramingBit);
    const modeBlockflags = Array(finalModeCount).fill(0);
    for (let i = finalModeCount - 1; i >= 0; i--) {
      bs.skip(40);
      modeBlockflags[i] = bs.read(1);
    }
    return { modeBlockflags };
  };

  // src/ogg/ogg-reader.ts
  var MIN_PAGE_HEADER_SIZE = 27;
  var MAX_PAGE_HEADER_SIZE = 27 + 255;
  var MAX_PAGE_SIZE = MAX_PAGE_HEADER_SIZE + 255 * 255;
  var OggReader = class {
    constructor(reader) {
      this.reader = reader;
      this.pos = 0;
    }
    readBytes(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      return new Uint8Array(view2.buffer, offset, length);
    }
    readU8() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 1);
      this.pos += 1;
      return view2.getUint8(offset);
    }
    readU32() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 4);
      this.pos += 4;
      return view2.getUint32(offset, true);
    }
    readI32() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 4);
      this.pos += 4;
      return view2.getInt32(offset, true);
    }
    readI64() {
      const low = this.readU32();
      const high = this.readI32();
      return high * 4294967296 + low;
    }
    readAscii(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      let str = "";
      for (let i = 0; i < length; i++) {
        str += String.fromCharCode(view2.getUint8(offset + i));
      }
      return str;
    }
    readPageHeader() {
      const startPos = this.pos;
      const capturePattern = this.readU32();
      if (capturePattern !== OGGS) {
        return null;
      }
      this.pos += 1;
      const headerType = this.readU8();
      const granulePosition = this.readI64();
      const serialNumber = this.readU32();
      const sequenceNumber = this.readU32();
      const checksum = this.readU32();
      const numberPageSegments = this.readU8();
      const lacingValues = new Uint8Array(numberPageSegments);
      for (let i = 0; i < numberPageSegments; i++) {
        lacingValues[i] = this.readU8();
      }
      const headerSize = 27 + numberPageSegments;
      const dataSize = lacingValues.reduce((a, b) => a + b, 0);
      const totalSize = headerSize + dataSize;
      return {
        headerStartPos: startPos,
        totalSize,
        dataStartPos: startPos + headerSize,
        dataSize,
        headerType,
        granulePosition,
        serialNumber,
        sequenceNumber,
        checksum,
        lacingValues
      };
    }
    findNextPageHeader(until) {
      while (this.pos < until - (4 - 1)) {
        const word = this.readU32();
        const firstByte = word & 255;
        const secondByte = word >>> 8 & 255;
        const thirdByte = word >>> 16 & 255;
        const fourthByte = word >>> 24 & 255;
        const O = 79;
        if (firstByte !== O && secondByte !== O && thirdByte !== O && fourthByte !== O) {
          continue;
        }
        this.pos -= 4;
        if (word === OGGS) {
          return true;
        }
        this.pos += 1;
      }
      return false;
    }
  };

  // src/ogg/ogg-muxer.ts
  var PAGE_SIZE_TARGET = 8192;
  var OggMuxer = class extends Muxer {
    constructor(output) {
      super(output);
      this.trackDatas = [];
      this.bosPagesWritten = false;
      this.pageBytes = new Uint8Array(MAX_PAGE_SIZE);
      this.pageView = new DataView(this.pageBytes.buffer);
      this.writer = output._writer;
    }
    async start() {
    }
    addEncodedVideoPacket() {
      throw new Error("Video tracks are not supported.");
    }
    getTrackData(track, meta) {
      const existingTrackData = this.trackDatas.find((td) => td.track === track);
      if (existingTrackData) {
        return existingTrackData;
      }
      let serialNumber;
      do {
        serialNumber = Math.floor(2 ** 32 * Math.random());
      } while (this.trackDatas.some((td) => td.serialNumber === serialNumber));
      assert(track.source._codec === "vorbis" || track.source._codec === "opus");
      assert(meta);
      assert(meta.decoderConfig);
      assert(meta.decoderConfig.sampleRate);
      const newTrackData = {
        track,
        serialNumber,
        internalSampleRate: track.source._codec === "opus" ? OPUS_INTERNAL_SAMPLE_RATE : meta.decoderConfig.sampleRate,
        codecInfo: {
          codec: track.source._codec,
          vorbisInfo: null,
          opusInfo: null
        },
        vorbisLastBlocksize: null,
        packetQueue: [],
        currentTimestampInSamples: 0,
        pagesWritten: 0,
        currentGranulePosition: 0,
        currentLacingValues: [],
        currentPageData: [],
        currentPageSize: 27,
        currentPageStartsWithFreshPacket: true
      };
      this.queueHeaderPackets(newTrackData, meta);
      this.trackDatas.push(newTrackData);
      return newTrackData;
    }
    queueHeaderPackets(trackData, meta) {
      assert(meta.decoderConfig);
      if (trackData.track.source._codec === "vorbis") {
        assert(meta.decoderConfig.description);
        const bytes2 = toUint8Array(meta.decoderConfig.description);
        if (bytes2[0] !== 2) {
          throw new TypeError("First byte of Vorbis decoder description must be 2.");
        }
        let pos = 1;
        const readPacketLength = () => {
          let length = 0;
          while (true) {
            const value = bytes2[pos++];
            if (value === void 0) {
              throw new TypeError("Vorbis decoder description is too short.");
            }
            length += value;
            if (value < 255) {
              return length;
            }
          }
        };
        const identificationHeaderLength = readPacketLength();
        const commentHeaderLength = readPacketLength();
        const setupHeaderLength = bytes2.length - pos;
        if (setupHeaderLength <= 0) {
          throw new TypeError("Vorbis decoder description is too short.");
        }
        const identificationHeader = bytes2.subarray(pos, pos += identificationHeaderLength);
        const commentHeader = bytes2.subarray(pos, pos += commentHeaderLength);
        const setupHeader = bytes2.subarray(pos);
        trackData.packetQueue.push({
          data: identificationHeader,
          endGranulePosition: 0,
          timestamp: 0,
          forcePageFlush: true
        }, {
          data: commentHeader,
          endGranulePosition: 0,
          timestamp: 0,
          forcePageFlush: false
        }, {
          data: setupHeader,
          endGranulePosition: 0,
          timestamp: 0,
          forcePageFlush: true
          // The last header packet must flush the page
        });
        const view2 = toDataView(identificationHeader);
        const blockSizeByte = view2.getUint8(28);
        trackData.codecInfo.vorbisInfo = {
          blocksizes: [
            1 << (blockSizeByte & 15),
            1 << (blockSizeByte >> 4)
          ],
          modeBlockflags: parseModesFromVorbisSetupPacket(setupHeader).modeBlockflags
        };
      } else if (trackData.track.source._codec === "opus") {
        if (!meta.decoderConfig.description) {
          throw new TypeError("For Ogg, Opus decoder description is required.");
        }
        const identificationHeader = toUint8Array(meta.decoderConfig.description);
        const commentHeader = new Uint8Array(8 + 4 + 4);
        const view2 = new DataView(commentHeader.buffer);
        view2.setUint32(0, 1332770163, false);
        view2.setUint32(4, 1415669619, false);
        view2.setUint32(8, 0, true);
        view2.setUint32(12, 0, true);
        trackData.packetQueue.push({
          data: identificationHeader,
          endGranulePosition: 0,
          timestamp: 0,
          forcePageFlush: true
        }, {
          data: commentHeader,
          endGranulePosition: 0,
          timestamp: 0,
          forcePageFlush: true
          // The last header packet must flush the page
        });
        trackData.codecInfo.opusInfo = {
          preSkip: parseOpusIdentificationHeader(identificationHeader).preSkip
        };
      }
    }
    async addEncodedAudioPacket(track, packet, meta) {
      const release = await this.mutex.acquire();
      try {
        const trackData = this.getTrackData(track, meta);
        this.validateAndNormalizeTimestamp(trackData.track, packet.timestamp, packet.type === "key");
        const currentTimestampInSamples = trackData.currentTimestampInSamples;
        const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
          packet.data,
          trackData.codecInfo,
          trackData.vorbisLastBlocksize
        );
        trackData.currentTimestampInSamples += durationInSamples;
        trackData.vorbisLastBlocksize = vorbisBlockSize;
        trackData.packetQueue.push({
          data: packet.data,
          endGranulePosition: trackData.currentTimestampInSamples,
          timestamp: currentTimestampInSamples / trackData.internalSampleRate,
          forcePageFlush: false
        });
        await this.interleavePages();
      } finally {
        release();
      }
    }
    addSubtitleCue() {
      throw new Error("Subtitle tracks are not supported.");
    }
    async interleavePages(isFinalCall = false) {
      if (!this.bosPagesWritten) {
        for (const track of this.output._tracks) {
          if (!track.source._closed && !this.trackDatas.some((x) => x.track === track)) {
            return;
          }
        }
        for (const trackData of this.trackDatas) {
          while (trackData.packetQueue.length > 0) {
            const packet = trackData.packetQueue.shift();
            this.writePacket(trackData, packet, false);
            if (packet.forcePageFlush) {
              break;
            }
          }
        }
        this.bosPagesWritten = true;
      }
      outer:
        while (true) {
          let trackWithMinTimestamp = null;
          let minTimestamp = Infinity;
          for (const trackData of this.trackDatas) {
            if (!isFinalCall && trackData.packetQueue.length <= 1 && !trackData.track.source._closed) {
              break outer;
            }
            if (trackData.packetQueue.length > 0 && trackData.packetQueue[0].timestamp < minTimestamp) {
              trackWithMinTimestamp = trackData;
              minTimestamp = trackData.packetQueue[0].timestamp;
            }
          }
          if (!trackWithMinTimestamp) {
            break;
          }
          const packet = trackWithMinTimestamp.packetQueue.shift();
          const isFinalPacket = trackWithMinTimestamp.packetQueue.length === 0;
          this.writePacket(trackWithMinTimestamp, packet, isFinalPacket);
        }
      if (!isFinalCall) {
        await this.writer.flush();
      }
    }
    writePacket(trackData, packet, isFinalPacket) {
      let remainingLength = packet.data.length;
      let dataStartOffset = 0;
      let dataOffset = 0;
      while (true) {
        if (trackData.currentLacingValues.length === 0 && dataStartOffset > 0) {
          trackData.currentPageStartsWithFreshPacket = false;
        }
        const segmentSize = Math.min(255, remainingLength);
        trackData.currentLacingValues.push(segmentSize);
        trackData.currentPageSize++;
        dataOffset += segmentSize;
        const segmentIsLastOfPacket = remainingLength < 255;
        if (trackData.currentLacingValues.length === 255) {
          const slice2 = packet.data.subarray(dataStartOffset, dataOffset);
          dataStartOffset = dataOffset;
          trackData.currentPageData.push(slice2);
          trackData.currentPageSize += slice2.length;
          this.writePage(trackData, isFinalPacket && segmentIsLastOfPacket);
          if (segmentIsLastOfPacket) {
            return;
          }
        }
        if (segmentIsLastOfPacket) {
          break;
        }
        remainingLength -= 255;
      }
      const slice = packet.data.subarray(dataStartOffset);
      trackData.currentPageData.push(slice);
      trackData.currentPageSize += slice.length;
      trackData.currentGranulePosition = packet.endGranulePosition;
      if (trackData.currentPageSize >= PAGE_SIZE_TARGET || packet.forcePageFlush) {
        this.writePage(trackData, isFinalPacket);
      }
    }
    writePage(trackData, isEos) {
      this.pageView.setUint32(0, OGGS, true);
      this.pageView.setUint8(4, 0);
      let headerType = 0;
      if (!trackData.currentPageStartsWithFreshPacket) {
        headerType |= 1;
      }
      if (trackData.pagesWritten === 0) {
        headerType |= 2;
      }
      if (isEos) {
        headerType |= 4;
      }
      this.pageView.setUint8(5, headerType);
      const granulePosition = trackData.currentLacingValues.every((x) => x === 255) ? -1 : trackData.currentGranulePosition;
      setInt64(this.pageView, 6, granulePosition, true);
      this.pageView.setUint32(14, trackData.serialNumber, true);
      this.pageView.setUint32(18, trackData.pagesWritten, true);
      this.pageView.setUint32(22, 0, true);
      this.pageView.setUint8(26, trackData.currentLacingValues.length);
      this.pageBytes.set(trackData.currentLacingValues, 27);
      let pos = 27 + trackData.currentLacingValues.length;
      for (const data of trackData.currentPageData) {
        this.pageBytes.set(data, pos);
        pos += data.length;
      }
      const slice = this.pageBytes.subarray(0, pos);
      const crc = computeOggPageCrc(slice);
      this.pageView.setUint32(22, crc, true);
      trackData.pagesWritten++;
      trackData.currentLacingValues.length = 0;
      trackData.currentPageData.length = 0;
      trackData.currentPageSize = 27;
      trackData.currentPageStartsWithFreshPacket = true;
      this.writer.write(slice);
    }
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async onTrackClose() {
      const release = await this.mutex.acquire();
      await this.interleavePages();
      release();
    }
    async finalize() {
      const release = await this.mutex.acquire();
      await this.interleavePages(true);
      for (const trackData of this.trackDatas) {
        if (trackData.currentLacingValues.length > 0) {
          this.writePage(trackData, true);
        }
      }
      release();
    }
  };

  // src/demuxer.ts
  var Demuxer = class {
    constructor(input) {
      this.input = input;
    }
  };

  // src/packet.ts
  var PLACEHOLDER_DATA = new Uint8Array(0);
  var EncodedPacket = class _EncodedPacket {
    constructor(data, type, timestamp, duration, sequenceNumber = -1, byteLength = data.byteLength) {
      this.data = data;
      this.type = type;
      this.timestamp = timestamp;
      this.duration = duration;
      this.sequenceNumber = sequenceNumber;
      this.byteLength = byteLength;
      if (!(data instanceof Uint8Array)) {
        throw new TypeError("data must be a Uint8Array.");
      }
      if (type !== "key" && type !== "delta") {
        throw new TypeError('type must be either "key" or "delta".');
      }
      if (!Number.isFinite(timestamp)) {
        throw new TypeError("timestamp must be a number.");
      }
      if (!Number.isFinite(duration) || duration < 0) {
        throw new TypeError("duration must be a non-negative number.");
      }
      if (!Number.isFinite(sequenceNumber)) {
        throw new TypeError("sequenceNumber must be a number.");
      }
      if (!Number.isInteger(byteLength) || byteLength < 0) {
        throw new TypeError("byteLength must be a non-negative integer.");
      }
    }
    /** If this packet is a metadata-only packet. Metadata-only packets don't contain their packet data. */
    get isMetadataOnly() {
      return this.data === PLACEHOLDER_DATA;
    }
    /** The timestamp of this packet in microseconds. */
    get microsecondTimestamp() {
      return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.timestamp);
    }
    /** The duration of this packet in microseconds. */
    get microsecondDuration() {
      return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.duration);
    }
    /** Converts this packet to an EncodedVideoChunk for use with the WebCodecs API. */
    toEncodedVideoChunk() {
      if (this.isMetadataOnly) {
        throw new TypeError("Metadata-only packets cannot be converted to a video chunk.");
      }
      if (typeof EncodedVideoChunk === "undefined") {
        throw new Error("Your browser does not support EncodedVideoChunk.");
      }
      return new EncodedVideoChunk({
        data: this.data,
        type: this.type,
        timestamp: this.microsecondTimestamp,
        duration: this.microsecondDuration
      });
    }
    /** Converts this packet to an EncodedAudioChunk for use with the WebCodecs API. */
    toEncodedAudioChunk() {
      if (this.isMetadataOnly) {
        throw new TypeError("Metadata-only packets cannot be converted to an audio chunk.");
      }
      if (typeof EncodedAudioChunk === "undefined") {
        throw new Error("Your browser does not support EncodedAudioChunk.");
      }
      return new EncodedAudioChunk({
        data: this.data,
        type: this.type,
        timestamp: this.microsecondTimestamp,
        duration: this.microsecondDuration
      });
    }
    /**
     * Creates an EncodedPacket from an EncodedVideoChunk or EncodedAudioChunk. This method is useful for converting
     * chunks from the WebCodecs API to EncodedPackets.
     */
    static fromEncodedChunk(chunk) {
      if (!(chunk instanceof EncodedVideoChunk || chunk instanceof EncodedAudioChunk)) {
        throw new TypeError("chunk must be an EncodedVideoChunk or EncodedAudioChunk.");
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      return new _EncodedPacket(
        data,
        chunk.type,
        chunk.timestamp / 1e6,
        (chunk.duration ?? 0) / 1e6
      );
    }
    /** Clones this packet while optionally updating timing information. */
    clone(options) {
      if (options !== void 0 && (typeof options !== "object" || options === null)) {
        throw new TypeError("options, when provided, must be an object.");
      }
      if (options?.timestamp !== void 0 && !Number.isFinite(options.timestamp)) {
        throw new TypeError("options.timestamp, when provided, must be a number.");
      }
      if (options?.duration !== void 0 && !Number.isFinite(options.duration)) {
        throw new TypeError("options.duration, when provided, must be a number.");
      }
      return new _EncodedPacket(
        this.data,
        this.type,
        options?.timestamp ?? this.timestamp,
        options?.duration ?? this.duration,
        this.sequenceNumber,
        this.byteLength
      );
    }
  };

  // src/pcm.ts
  var toUlaw = (s16) => {
    const MULAW_MAX = 8191;
    const MULAW_BIAS = 33;
    let number = s16;
    let mask = 4096;
    let sign = 0;
    let position = 12;
    let lsb = 0;
    if (number < 0) {
      number = -number;
      sign = 128;
    }
    number += MULAW_BIAS;
    if (number > MULAW_MAX) {
      number = MULAW_MAX;
    }
    for (; (number & mask) !== mask && position >= 5; mask >>= 1, position--) {
    }
    lsb = number >> position - 4 & 15;
    return ~(sign | position - 5 << 4 | lsb) & 255;
  };
  var fromUlaw = (u82) => {
    const MULAW_BIAS = 33;
    let sign = 0;
    let position = 0;
    let number = ~u82;
    if (number & 128) {
      number &= ~(1 << 7);
      sign = -1;
    }
    position = ((number & 240) >> 4) + 5;
    const decoded = (1 << position | (number & 15) << position - 4 | 1 << position - 5) - MULAW_BIAS;
    return sign === 0 ? decoded : -decoded;
  };
  var toAlaw = (s16) => {
    const ALAW_MAX = 4095;
    let mask = 2048;
    let sign = 0;
    let position = 11;
    let lsb = 0;
    let number = s16;
    if (number < 0) {
      number = -number;
      sign = 128;
    }
    if (number > ALAW_MAX) {
      number = ALAW_MAX;
    }
    for (; (number & mask) !== mask && position >= 5; mask >>= 1, position--) {
    }
    lsb = number >> (position === 4 ? 1 : position - 4) & 15;
    return (sign | position - 4 << 4 | lsb) ^ 85;
  };
  var fromAlaw = (u82) => {
    let sign = 0;
    let position = 0;
    let number = u82 ^ 85;
    if (number & 128) {
      number &= ~(1 << 7);
      sign = -1;
    }
    position = ((number & 240) >> 4) + 4;
    let decoded = 0;
    if (position !== 4) {
      decoded = 1 << position | (number & 15) << position - 4 | 1 << position - 5;
    } else {
      decoded = number << 1 | 1;
    }
    return sign === 0 ? decoded : -decoded;
  };

  // src/sample.ts
  var VideoSample = class _VideoSample {
    constructor(data, init) {
      /** @internal */
      this._closed = false;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        if (!init || typeof init !== "object") {
          throw new TypeError("init must be an object.");
        }
        if (!("format" in init) || typeof init.format !== "string") {
          throw new TypeError("init.format must be a string.");
        }
        if (!Number.isInteger(init.codedWidth) || init.codedWidth <= 0) {
          throw new TypeError("init.codedWidth must be a positive integer.");
        }
        if (!Number.isInteger(init.codedHeight) || init.codedHeight <= 0) {
          throw new TypeError("init.codedHeight must be a positive integer.");
        }
        if (init.rotation !== void 0 && ![0, 90, 180, 270].includes(init.rotation)) {
          throw new TypeError("init.rotation, when provided, must be 0, 90, 180, or 270.");
        }
        if (!Number.isFinite(init.timestamp)) {
          throw new TypeError("init.timestamp must be a number.");
        }
        if (init.duration !== void 0 && (!Number.isFinite(init.duration) || init.duration < 0)) {
          throw new TypeError("init.duration, when provided, must be a non-negative number.");
        }
        this._data = toUint8Array(data).slice();
        this.format = init.format;
        this.codedWidth = init.codedWidth;
        this.codedHeight = init.codedHeight;
        this.rotation = init.rotation ?? 0;
        this.timestamp = init.timestamp;
        this.duration = init.duration ?? 0;
        this.colorSpace = new VideoColorSpace(init.colorSpace);
      } else if (typeof VideoFrame !== "undefined" && data instanceof VideoFrame) {
        if (init?.rotation !== void 0 && ![0, 90, 180, 270].includes(init.rotation)) {
          throw new TypeError("init.rotation, when provided, must be 0, 90, 180, or 270.");
        }
        if (init?.timestamp !== void 0 && !Number.isFinite(init?.timestamp)) {
          throw new TypeError("init.timestamp, when provided, must be a number.");
        }
        if (init?.duration !== void 0 && (!Number.isFinite(init.duration) || init.duration < 0)) {
          throw new TypeError("init.duration, when provided, must be a non-negative number.");
        }
        this._data = data;
        this.format = data.format;
        this.codedWidth = data.codedWidth;
        this.codedHeight = data.codedHeight;
        this.rotation = init?.rotation ?? 0;
        this.timestamp = init?.timestamp ?? data.timestamp / 1e6;
        this.duration = init?.duration ?? (data.duration ?? 0) / 1e6;
        this.colorSpace = data.colorSpace;
      } else if (typeof HTMLImageElement !== "undefined" && data instanceof HTMLImageElement || typeof SVGImageElement !== "undefined" && data instanceof SVGImageElement || typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap || typeof HTMLVideoElement !== "undefined" && data instanceof HTMLVideoElement || typeof HTMLCanvasElement !== "undefined" && data instanceof HTMLCanvasElement || typeof OffscreenCanvas !== "undefined" && data instanceof OffscreenCanvas) {
        if (!init || typeof init !== "object") {
          throw new TypeError("init must be an object.");
        }
        if (init.rotation !== void 0 && ![0, 90, 180, 270].includes(init.rotation)) {
          throw new TypeError("init.rotation, when provided, must be 0, 90, 180, or 270.");
        }
        if (!Number.isFinite(init.timestamp)) {
          throw new TypeError("init.timestamp must be a number.");
        }
        if (init.duration !== void 0 && (!Number.isFinite(init.duration) || init.duration < 0)) {
          throw new TypeError("init.duration, when provided, must be a non-negative number.");
        }
        if (typeof VideoFrame !== "undefined") {
          return new _VideoSample(
            new VideoFrame(data, {
              timestamp: Math.trunc(init.timestamp * SECOND_TO_MICROSECOND_FACTOR),
              duration: Math.trunc((init.duration ?? 0) * SECOND_TO_MICROSECOND_FACTOR)
            }),
            init
          );
        }
        let width = 0;
        let height = 0;
        if ("naturalWidth" in data) {
          width = data.naturalWidth;
          height = data.naturalHeight;
        } else if ("videoWidth" in data) {
          width = data.videoWidth;
          height = data.videoHeight;
        } else if ("width" in data) {
          width = Number(data.width);
          height = Number(data.height);
        }
        if (!width || !height) {
          throw new TypeError("Could not determine dimensions.");
        }
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        assert(context);
        context.drawImage(data, 0, 0);
        this._data = canvas;
        this.format = "RGBX";
        this.codedWidth = width;
        this.codedHeight = height;
        this.rotation = init.rotation ?? 0;
        this.timestamp = init.timestamp;
        this.duration = init.duration ?? 0;
        this.colorSpace = new VideoColorSpace({
          matrix: "rgb",
          primaries: "bt709",
          transfer: "iec61966-2-1",
          fullRange: true
        });
      } else {
        throw new TypeError("Invalid data type: Must be a BufferSource or CanvasImageSource.");
      }
    }
    /** The width of the frame in pixels after rotation. */
    get displayWidth() {
      return this.rotation % 180 === 0 ? this.codedWidth : this.codedHeight;
    }
    /** The height of the frame in pixels after rotation. */
    get displayHeight() {
      return this.rotation % 180 === 0 ? this.codedHeight : this.codedWidth;
    }
    /** The timestamp of the frame in microseconds. */
    get microsecondTimestamp() {
      return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.timestamp);
    }
    /** The duration of the frame in microseconds. */
    get microsecondDuration() {
      return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.duration);
    }
    /** Clones this video sample. */
    clone() {
      if (this._closed) {
        throw new Error("VideoSample is closed.");
      }
      assert(this._data !== null);
      if (isVideoFrame(this._data)) {
        return new _VideoSample(this._data.clone());
      } else if (this._data instanceof Uint8Array) {
        return new _VideoSample(this._data.slice(), {
          format: this.format,
          codedWidth: this.codedWidth,
          codedHeight: this.codedHeight,
          timestamp: this.timestamp,
          duration: this.duration,
          colorSpace: this.colorSpace
        });
      } else {
        return new _VideoSample(this._data, {
          format: this.format,
          codedWidth: this.codedWidth,
          codedHeight: this.codedHeight,
          timestamp: this.timestamp,
          duration: this.duration,
          colorSpace: this.colorSpace
        });
      }
    }
    /**
     * Closes this video sample, releasing held resources. Video samples should be closed as soon as they are not
     * needed anymore.
     */
    close() {
      if (this._closed) {
        return;
      }
      if (isVideoFrame(this._data)) {
        this._data.close();
      } else {
        this._data = null;
      }
      this._closed = true;
    }
    /** Returns the number of bytes required to hold this video sample's pixel data. */
    allocationSize() {
      if (this._closed) {
        throw new Error("VideoSample is closed.");
      }
      assert(this._data !== null);
      if (isVideoFrame(this._data)) {
        return this._data.allocationSize();
      } else if (this._data instanceof Uint8Array) {
        return this._data.byteLength;
      } else {
        return this.codedWidth * this.codedHeight * 4;
      }
    }
    /** Copies this video sample's pixel data to an ArrayBuffer or ArrayBufferView. */
    async copyTo(destination) {
      if (!isAllowSharedBufferSource(destination)) {
        throw new TypeError("destination must be an ArrayBuffer or an ArrayBuffer view.");
      }
      if (this._closed) {
        throw new Error("VideoSample is closed.");
      }
      assert(this._data !== null);
      if (isVideoFrame(this._data)) {
        await this._data.copyTo(destination);
      } else if (this._data instanceof Uint8Array) {
        const dest = toUint8Array(destination);
        dest.set(this._data);
      } else {
        const canvas = this._data;
        const context = canvas.getContext("2d", { alpha: false });
        assert(context);
        const imageData = context.getImageData(0, 0, this.codedWidth, this.codedHeight);
        const dest = toUint8Array(destination);
        dest.set(imageData.data);
      }
    }
    /**
     * Converts this video sample to a VideoFrame for use with the WebCodecs API. The VideoFrame returned by this
     * method *must* be closed separately from this video sample.
     */
    toVideoFrame() {
      if (this._closed) {
        throw new Error("VideoSample is closed.");
      }
      assert(this._data !== null);
      if (isVideoFrame(this._data)) {
        return new VideoFrame(this._data, {
          timestamp: this.microsecondTimestamp,
          duration: this.microsecondDuration || void 0
          // Drag 0 duration to undefined, glitches some codecs
        });
      } else if (this._data instanceof Uint8Array) {
        return new VideoFrame(this._data, {
          format: this.format,
          codedWidth: this.codedWidth,
          codedHeight: this.codedHeight,
          timestamp: this.microsecondTimestamp,
          duration: this.microsecondDuration,
          colorSpace: this.colorSpace
        });
      } else {
        return new VideoFrame(this._data, {
          timestamp: this.microsecondTimestamp,
          duration: this.microsecondDuration
        });
      }
    }
    /**
     * Draws the video sample to a 2D canvas context. Rotation metadata will be taken into account.
     *
     * @param dx - The x-coordinate in the destination canvas at which to place the top-left corner of the source image.
     * @param dy - The y-coordinate in the destination canvas at which to place the top-left corner of the source image.
     * @param dWidth - The width to draw the image in the destination canvas. This allows scaling of the drawn image.
     * @param dHeight - The height to draw the image in the destination canvas. This allows scaling of the drawn image.
     */
    draw(context, dx, dy, dWidth = this.displayWidth, dHeight = this.displayHeight) {
      if (!(typeof CanvasRenderingContext2D !== "undefined" && context instanceof CanvasRenderingContext2D || typeof OffscreenCanvasRenderingContext2D !== "undefined" && context instanceof OffscreenCanvasRenderingContext2D)) {
        throw new TypeError("context must be a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D.");
      }
      if (!Number.isFinite(dx)) {
        throw new TypeError("dx must be a number.");
      }
      if (!Number.isFinite(dy)) {
        throw new TypeError("dy must be a number.");
      }
      if (!Number.isFinite(dWidth) || dWidth < 0) {
        throw new TypeError("dWidth must be a non-negative number.");
      }
      if (!Number.isFinite(dHeight) || dHeight < 0) {
        throw new TypeError("dHeight must be a non-negative number.");
      }
      if (this._closed) {
        throw new Error("VideoSample is closed.");
      }
      const source = this.toCanvasImageSource();
      context.save();
      const centerX = dx + dWidth / 2;
      const centerY = dy + dHeight / 2;
      context.translate(centerX, centerY);
      context.rotate(this.rotation * Math.PI / 180);
      const aspectRatioChange = this.rotation % 180 === 0 ? 1 : dWidth / dHeight;
      context.scale(1 / aspectRatioChange, aspectRatioChange);
      context.drawImage(
        source,
        -dWidth / 2,
        -dHeight / 2,
        dWidth,
        dHeight
      );
      context.restore();
    }
    /** Converts this video sample to a CanvasImageSource for drawing to a canvas. */
    toCanvasImageSource() {
      if (this._closed) {
        throw new Error("VideoSample is closed.");
      }
      assert(this._data !== null);
      if (this._data instanceof Uint8Array) {
        return this.toVideoFrame();
      } else {
        return this._data;
      }
    }
    /** Sets the rotation metadata of this video sample. */
    setRotation(newRotation) {
      if (![0, 90, 180, 270].includes(newRotation)) {
        throw new TypeError("newRotation must be 0, 90, 180, or 270.");
      }
      this.rotation = newRotation;
    }
    /** Sets the timestamp of this video sample, in seconds. */
    setTimestamp(newTimestamp) {
      if (!Number.isFinite(newTimestamp)) {
        throw new TypeError("newTimestamp must be a number.");
      }
      this.timestamp = newTimestamp;
    }
    /** Sets the duration of this video sample, in seconds. */
    setDuration(newDuration) {
      if (!Number.isFinite(newDuration) || newDuration < 0) {
        throw new TypeError("newDuration must be a non-negative number.");
      }
      this.duration = newDuration;
    }
  };
  var isVideoFrame = (x) => {
    return typeof VideoFrame !== "undefined" && x instanceof VideoFrame;
  };
  var AUDIO_SAMPLE_FORMATS = /* @__PURE__ */ new Set(
    ["f32", "f32-planar", "s16", "s16-planar", "s32", "s32-planar", "u8", "u8-planar"]
  );
  var AudioSample = class _AudioSample {
    constructor(init) {
      /** @internal */
      this._closed = false;
      if (isAudioData(init)) {
        if (init.format === null) {
          throw new TypeError("AudioData with null format is not supported.");
        }
        this._data = init;
        this.format = init.format;
        this.sampleRate = init.sampleRate;
        this.numberOfFrames = init.numberOfFrames;
        this.numberOfChannels = init.numberOfChannels;
        this.timestamp = init.timestamp / 1e6;
        this.duration = init.numberOfFrames / init.sampleRate;
      } else {
        if (!init || typeof init !== "object") {
          throw new TypeError("Invalid AudioDataInit: must be an object.");
        }
        if (!AUDIO_SAMPLE_FORMATS.has(init.format)) {
          throw new TypeError("Invalid AudioDataInit: invalid format.");
        }
        if (!Number.isFinite(init.sampleRate) || init.sampleRate <= 0) {
          throw new TypeError("Invalid AudioDataInit: sampleRate must be > 0.");
        }
        if (!Number.isInteger(init.numberOfChannels) || init.numberOfChannels === 0) {
          throw new TypeError("Invalid AudioDataInit: numberOfChannels must be an integer > 0.");
        }
        if (!Number.isFinite(init?.timestamp)) {
          throw new TypeError("init.timestamp must be a number.");
        }
        const numberOfFrames = init.data.byteLength / (getBytesPerSample(init.format) * init.numberOfChannels);
        if (!Number.isInteger(numberOfFrames)) {
          throw new TypeError("Invalid AudioDataInit: data size is not a multiple of frame size.");
        }
        this.format = init.format;
        this.sampleRate = init.sampleRate;
        this.numberOfFrames = numberOfFrames;
        this.numberOfChannels = init.numberOfChannels;
        this.timestamp = init.timestamp;
        this.duration = numberOfFrames / init.sampleRate;
        let dataBuffer;
        if (init.data instanceof ArrayBuffer) {
          dataBuffer = new Uint8Array(init.data);
        } else if (ArrayBuffer.isView(init.data)) {
          dataBuffer = new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength);
        } else {
          throw new TypeError("Invalid AudioDataInit: data is not a BufferSource.");
        }
        const expectedSize = this.numberOfFrames * this.numberOfChannels * getBytesPerSample(this.format);
        if (dataBuffer.byteLength < expectedSize) {
          throw new TypeError("Invalid AudioDataInit: insufficient data size.");
        }
        this._data = dataBuffer;
      }
    }
    /** The timestamp of the sample in microseconds. */
    get microsecondTimestamp() {
      return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.timestamp);
    }
    /** The duration of the sample in microseconds. */
    get microsecondDuration() {
      return Math.trunc(SECOND_TO_MICROSECOND_FACTOR * this.duration);
    }
    /** Returns the number of bytes required to hold the audio sample's data as specified by the given options. */
    allocationSize(options) {
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (!Number.isInteger(options.planeIndex) || options.planeIndex < 0) {
        throw new TypeError("planeIndex must be a non-negative integer.");
      }
      if (options.format !== void 0 && !AUDIO_SAMPLE_FORMATS.has(options.format)) {
        throw new TypeError("Invalid format.");
      }
      if (options.frameOffset !== void 0 && (!Number.isInteger(options.frameOffset) || options.frameOffset < 0)) {
        throw new TypeError("frameOffset must be a non-negative integer.");
      }
      if (options.frameCount !== void 0 && (!Number.isInteger(options.frameCount) || options.frameCount < 0)) {
        throw new TypeError("frameCount must be a non-negative integer.");
      }
      if (this._closed) {
        throw new Error("AudioSample is closed.");
      }
      const destFormat = options.format ?? this.format;
      const frameOffset = options.frameOffset ?? 0;
      if (frameOffset >= this.numberOfFrames) {
        throw new RangeError("frameOffset out of range");
      }
      const copyFrameCount = options.frameCount !== void 0 ? options.frameCount : this.numberOfFrames - frameOffset;
      if (copyFrameCount > this.numberOfFrames - frameOffset) {
        throw new RangeError("frameCount out of range");
      }
      const bytesPerSample = getBytesPerSample(destFormat);
      const isPlanar = formatIsPlanar(destFormat);
      if (isPlanar && options.planeIndex >= this.numberOfChannels) {
        throw new RangeError("planeIndex out of range");
      }
      if (!isPlanar && options.planeIndex !== 0) {
        throw new RangeError("planeIndex out of range");
      }
      const elementCount = isPlanar ? copyFrameCount : copyFrameCount * this.numberOfChannels;
      return elementCount * bytesPerSample;
    }
    /** Copies the audio sample's data to an ArrayBuffer or ArrayBufferView as specified by the given options. */
    copyTo(destination, options) {
      if (!isAllowSharedBufferSource(destination)) {
        throw new TypeError("destination must be an ArrayBuffer or an ArrayBuffer view.");
      }
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (!Number.isInteger(options.planeIndex) || options.planeIndex < 0) {
        throw new TypeError("planeIndex must be a non-negative integer.");
      }
      if (options.format !== void 0 && !AUDIO_SAMPLE_FORMATS.has(options.format)) {
        throw new TypeError("Invalid format.");
      }
      if (options.frameOffset !== void 0 && (!Number.isInteger(options.frameOffset) || options.frameOffset < 0)) {
        throw new TypeError("frameOffset must be a non-negative integer.");
      }
      if (options.frameCount !== void 0 && (!Number.isInteger(options.frameCount) || options.frameCount < 0)) {
        throw new TypeError("frameCount must be a non-negative integer.");
      }
      if (this._closed) {
        throw new Error("AudioSample is closed.");
      }
      const { planeIndex, format, frameCount: optFrameCount, frameOffset: optFrameOffset } = options;
      const destFormat = format ?? this.format;
      if (!destFormat) throw new Error("Destination format not determined");
      const numFrames = this.numberOfFrames;
      const numChannels = this.numberOfChannels;
      const frameOffset = optFrameOffset ?? 0;
      if (frameOffset >= numFrames) {
        throw new RangeError("frameOffset out of range");
      }
      const copyFrameCount = optFrameCount !== void 0 ? optFrameCount : numFrames - frameOffset;
      if (copyFrameCount > numFrames - frameOffset) {
        throw new RangeError("frameCount out of range");
      }
      const destBytesPerSample = getBytesPerSample(destFormat);
      const destIsPlanar = formatIsPlanar(destFormat);
      if (destIsPlanar && planeIndex >= numChannels) {
        throw new RangeError("planeIndex out of range");
      }
      if (!destIsPlanar && planeIndex !== 0) {
        throw new RangeError("planeIndex out of range");
      }
      const destElementCount = destIsPlanar ? copyFrameCount : copyFrameCount * numChannels;
      const requiredSize = destElementCount * destBytesPerSample;
      if (destination.byteLength < requiredSize) {
        throw new RangeError("Destination buffer is too small");
      }
      const destView = toDataView(destination);
      const writeFn = getWriteFunction(destFormat);
      if (isAudioData(this._data)) {
        if (destIsPlanar) {
          if (destFormat === "f32-planar") {
            this._data.copyTo(destination, {
              planeIndex,
              frameOffset,
              frameCount: copyFrameCount,
              format: "f32-planar"
            });
          } else {
            const tempBuffer = new ArrayBuffer(copyFrameCount * 4);
            const tempArray = new Float32Array(tempBuffer);
            this._data.copyTo(tempArray, {
              planeIndex,
              frameOffset,
              frameCount: copyFrameCount,
              format: "f32-planar"
            });
            const tempView = new DataView(tempBuffer);
            for (let i = 0; i < copyFrameCount; i++) {
              const destOffset = i * destBytesPerSample;
              const sample = tempView.getFloat32(i * 4, true);
              writeFn(destView, destOffset, sample);
            }
          }
        } else {
          const numCh = numChannels;
          const temp = new Float32Array(copyFrameCount);
          for (let ch = 0; ch < numCh; ch++) {
            this._data.copyTo(temp, {
              planeIndex: ch,
              frameOffset,
              frameCount: copyFrameCount,
              format: "f32-planar"
            });
            for (let i = 0; i < copyFrameCount; i++) {
              const destIndex = i * numCh + ch;
              const destOffset = destIndex * destBytesPerSample;
              writeFn(destView, destOffset, temp[i]);
            }
          }
        }
      } else {
        const uint8Data = this._data;
        const srcView = new DataView(uint8Data.buffer, uint8Data.byteOffset, uint8Data.byteLength);
        const srcFormat = this.format;
        const readFn = getReadFunction(srcFormat);
        const srcBytesPerSample = getBytesPerSample(srcFormat);
        const srcIsPlanar = formatIsPlanar(srcFormat);
        for (let i = 0; i < copyFrameCount; i++) {
          if (destIsPlanar) {
            const destOffset = i * destBytesPerSample;
            let srcOffset;
            if (srcIsPlanar) {
              srcOffset = (planeIndex * numFrames + (i + frameOffset)) * srcBytesPerSample;
            } else {
              srcOffset = ((i + frameOffset) * numChannels + planeIndex) * srcBytesPerSample;
            }
            const normalized = readFn(srcView, srcOffset);
            writeFn(destView, destOffset, normalized);
          } else {
            for (let ch = 0; ch < numChannels; ch++) {
              const destIndex = i * numChannels + ch;
              const destOffset = destIndex * destBytesPerSample;
              let srcOffset;
              if (srcIsPlanar) {
                srcOffset = (ch * numFrames + (i + frameOffset)) * srcBytesPerSample;
              } else {
                srcOffset = ((i + frameOffset) * numChannels + ch) * srcBytesPerSample;
              }
              const normalized = readFn(srcView, srcOffset);
              writeFn(destView, destOffset, normalized);
            }
          }
        }
      }
    }
    /** Clones this audio sample. */
    clone() {
      if (this._closed) {
        throw new Error("AudioSample is closed.");
      }
      if (isAudioData(this._data)) {
        return new _AudioSample(this._data.clone());
      } else {
        return new _AudioSample({
          format: this.format,
          sampleRate: this.sampleRate,
          numberOfFrames: this.numberOfFrames,
          numberOfChannels: this.numberOfChannels,
          timestamp: this.timestamp,
          data: this._data
        });
      }
    }
    /**
     * Closes this audio sample, releasing held resources. Audio samples should be closed as soon as they are not
     * needed anymore.
     */
    close() {
      if (this._closed) {
        return;
      }
      if (isAudioData(this._data)) {
        this._data.close();
      } else {
        this._data = new Uint8Array(0);
      }
      this._closed = true;
    }
    /**
     * Converts this audio sample to an AudioData for use with the WebCodecs API. The AudioData returned by this
     * method *must* be closed separately from this audio sample.
     */
    toAudioData() {
      if (this._closed) {
        throw new Error("AudioSample is closed.");
      }
      if (isAudioData(this._data)) {
        if (this._data.timestamp === this.microsecondTimestamp) {
          return this._data.clone();
        } else {
          if (formatIsPlanar(this.format)) {
            const size = this.allocationSize({ planeIndex: 0, format: this.format });
            const data = new ArrayBuffer(size * this.numberOfChannels);
            for (let i = 0; i < this.numberOfChannels; i++) {
              this.copyTo(new Uint8Array(data, i * size, size), { planeIndex: i, format: this.format });
            }
            return new AudioData({
              format: this.format,
              sampleRate: this.sampleRate,
              numberOfFrames: this.numberOfFrames,
              numberOfChannels: this.numberOfChannels,
              timestamp: this.microsecondTimestamp,
              data
            });
          } else {
            const data = new ArrayBuffer(this.allocationSize({ planeIndex: 0, format: this.format }));
            this.copyTo(new DataView(data), { planeIndex: 0, format: this.format });
            return new AudioData({
              format: this.format,
              sampleRate: this.sampleRate,
              numberOfFrames: this.numberOfFrames,
              numberOfChannels: this.numberOfChannels,
              timestamp: this.microsecondTimestamp,
              data
            });
          }
        }
      } else {
        return new AudioData({
          format: this.format,
          sampleRate: this.sampleRate,
          numberOfFrames: this.numberOfFrames,
          numberOfChannels: this.numberOfChannels,
          timestamp: this.microsecondTimestamp,
          data: this._data
        });
      }
    }
    /** Convert this audio sample to an AudioBuffer for use with the Web Audio API. */
    toAudioBuffer() {
      if (this._closed) {
        throw new Error("AudioSample is closed.");
      }
      const audioBuffer = new AudioBuffer({
        numberOfChannels: this.numberOfChannels,
        length: this.numberOfFrames,
        sampleRate: this.sampleRate
      });
      const dataBytes = new Float32Array(this.allocationSize({ planeIndex: 0, format: "f32-planar" }) / 4);
      for (let i = 0; i < this.numberOfChannels; i++) {
        this.copyTo(dataBytes, { planeIndex: i, format: "f32-planar" });
        audioBuffer.copyToChannel(dataBytes, i);
      }
      return audioBuffer;
    }
    /** Sets the timestamp of this audio sample, in seconds. */
    setTimestamp(newTimestamp) {
      if (!Number.isFinite(newTimestamp)) {
        throw new TypeError("newTimestamp must be a number.");
      }
      this.timestamp = newTimestamp;
    }
  };
  var getBytesPerSample = (format) => {
    switch (format) {
      case "u8":
      case "u8-planar":
        return 1;
      case "s16":
      case "s16-planar":
        return 2;
      case "s32":
      case "s32-planar":
        return 4;
      case "f32":
      case "f32-planar":
        return 4;
      default:
        throw new Error("Unknown AudioSampleFormat");
    }
  };
  var formatIsPlanar = (format) => {
    switch (format) {
      case "u8-planar":
      case "s16-planar":
      case "s32-planar":
      case "f32-planar":
        return true;
      default:
        return false;
    }
  };
  var getReadFunction = (format) => {
    switch (format) {
      case "u8":
      case "u8-planar":
        return (view2, offset) => (view2.getUint8(offset) - 128) / 128;
      case "s16":
      case "s16-planar":
        return (view2, offset) => view2.getInt16(offset, true) / 32768;
      case "s32":
      case "s32-planar":
        return (view2, offset) => view2.getInt32(offset, true) / 2147483648;
      case "f32":
      case "f32-planar":
        return (view2, offset) => view2.getFloat32(offset, true);
    }
  };
  var getWriteFunction = (format) => {
    switch (format) {
      case "u8":
      case "u8-planar":
        return (view2, offset, value) => view2.setUint8(offset, clamp((value + 1) * 127.5, 0, 255));
      case "s16":
      case "s16-planar":
        return (view2, offset, value) => view2.setInt16(offset, clamp(Math.round(value * 32767), -32768, 32767), true);
      case "s32":
      case "s32-planar":
        return (view2, offset, value) => view2.setInt32(offset, clamp(Math.round(value * 2147483647), -2147483648, 2147483647), true);
      case "f32":
      case "f32-planar":
        return (view2, offset, value) => view2.setFloat32(offset, value, true);
    }
  };
  var isAudioData = (x) => {
    return typeof AudioData !== "undefined" && x instanceof AudioData;
  };

  // src/media-sink.ts
  var validatePacketRetrievalOptions = (options) => {
    if (!options || typeof options !== "object") {
      throw new TypeError("options must be an object.");
    }
    if (options.metadataOnly !== void 0 && typeof options.metadataOnly !== "boolean") {
      throw new TypeError("options.metadataOnly, when defined, must be a boolean.");
    }
  };
  var validateTimestamp = (timestamp) => {
    if (typeof timestamp !== "number" || Number.isNaN(timestamp)) {
      throw new TypeError("timestamp must be a number.");
    }
  };
  var EncodedPacketSink = class {
    constructor(track) {
      if (!(track instanceof InputTrack)) {
        throw new TypeError("track must be an InputTrack.");
      }
      this._track = track;
    }
    /**
     * Retrieves the track's first packet (in decode order), or null if it has no packets. The first packet is very
     * likely to be a key packet.
     */
    getFirstPacket(options = {}) {
      validatePacketRetrievalOptions(options);
      return this._track._backing.getFirstPacket(options);
    }
    /**
     * Retrieves the packet corresponding to the given timestamp, in seconds. More specifically, returns the last packet
     * (in presentation order) with a start timestamp less than or equal to the given timestamp. This method can be
     * used to retrieve a track's last packet using `getPacket(Infinity)`. The method returns null if the timestamp
     * is before the first packet in the track.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getPacket(timestamp, options = {}) {
      validateTimestamp(timestamp);
      validatePacketRetrievalOptions(options);
      return this._track._backing.getPacket(timestamp, options);
    }
    /**
     * Retrieves the packet following the given packet (in decode order), or null if the given packet is the
     * last packet.
     */
    getNextPacket(packet, options = {}) {
      if (!(packet instanceof EncodedPacket)) {
        throw new TypeError("packet must be an EncodedPacket.");
      }
      validatePacketRetrievalOptions(options);
      return this._track._backing.getNextPacket(packet, options);
    }
    /**
     * Retrieves the key packet corresponding to the given timestamp, in seconds. More specifically, returns the last
     * key packet (in presentation order) with a start timestamp less than or equal to the given timestamp. A key packet
     * is a packet that doesn't require previous packets to be decoded. This method can be used to retrieve a track's
     * last key packet using `getKeyPacket(Infinity)`. The method returns null if the timestamp is before the first
     * key packet in the track.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getKeyPacket(timestamp, options = {}) {
      validateTimestamp(timestamp);
      validatePacketRetrievalOptions(options);
      return this._track._backing.getKeyPacket(timestamp, options);
    }
    /**
     * Retrieves the key packet following the given packet (in decode order), or null if the given packet is the last
     * key packet.
     */
    getNextKeyPacket(packet, options = {}) {
      if (!(packet instanceof EncodedPacket)) {
        throw new TypeError("packet must be an EncodedPacket.");
      }
      validatePacketRetrievalOptions(options);
      return this._track._backing.getNextKeyPacket(packet, options);
    }
    /**
     * Creates an async iterator that yields the packets in this track in decode order. To enable fast iteration, this
     * method will intelligently preload packets based on the speed of the consumer.
     *
     * @param startPacket - (optional) The packet from which iteration should begin. This packet will also be yielded.
     * @param endTimestamp - The timestamp in seconds at which to stop iteration. This timestamp is exclusive.
     */
    packets(startPacket, endTimestamp = Infinity, options) {
      const packetQueue = [];
      let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
      let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
      let ended = false;
      let terminated = false;
      let outOfBandError = null;
      const timestamps = [];
      const maxQueueSize = () => Math.max(2, timestamps.length);
      (async () => {
        let packet = startPacket ?? await this.getFirstPacket(options);
        while (packet && !terminated) {
          if (packet.timestamp >= endTimestamp) {
            break;
          }
          if (packetQueue.length > maxQueueSize()) {
            ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
            await queueDequeue;
            continue;
          }
          packetQueue.push(packet);
          onQueueNotEmpty();
          ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
          packet = await this.getNextPacket(packet, options);
        }
        ended = true;
        onQueueNotEmpty();
      })().catch((error) => {
        if (!outOfBandError) {
          outOfBandError = error;
          onQueueNotEmpty();
        }
      });
      return {
        async next() {
          while (true) {
            if (terminated) {
              return { value: void 0, done: true };
            } else if (outOfBandError) {
              throw outOfBandError;
            } else if (packetQueue.length > 0) {
              const value = packetQueue.shift();
              const now = performance.now();
              timestamps.push(now);
              while (timestamps.length > 0 && now - timestamps[0] >= 1e3) {
                timestamps.shift();
              }
              onQueueDequeue();
              return { value, done: false };
            } else if (ended) {
              return { value: void 0, done: true };
            } else {
              await queueNotEmpty;
            }
          }
        },
        async return() {
          terminated = true;
          onQueueDequeue();
          onQueueNotEmpty();
          return { value: void 0, done: true };
        },
        async throw(error) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        }
      };
    }
  };
  var DecoderWrapper = class {
    constructor(onSample, onError) {
      this.onSample = onSample;
      this.onError = onError;
    }
  };
  var BaseMediaSampleSink = class {
    /** @internal */
    mediaSamplesInRange(startTimestamp = 0, endTimestamp = Infinity) {
      validateTimestamp(startTimestamp);
      validateTimestamp(endTimestamp);
      const MAX_QUEUE_SIZE = 8;
      const sampleQueue = [];
      let firstSampleQueued = false;
      let lastSample = null;
      let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
      let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
      let decoderIsFlushed = false;
      let ended = false;
      let terminated = false;
      let outOfBandError = null;
      (async () => {
        const decoderError = new Error();
        const decoder = await this._createDecoder((sample) => {
          onQueueDequeue();
          if (sample.timestamp >= endTimestamp) {
            ended = true;
          }
          if (ended) {
            sample.close();
            return;
          }
          if (lastSample) {
            if (sample.timestamp > startTimestamp) {
              sampleQueue.push(lastSample);
              firstSampleQueued = true;
            } else {
              lastSample.close();
            }
          }
          if (sample.timestamp >= startTimestamp) {
            sampleQueue.push(sample);
            firstSampleQueued = true;
          }
          lastSample = firstSampleQueued ? null : sample;
          if (sampleQueue.length > 0) {
            onQueueNotEmpty();
            ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
          }
        }, (error) => {
          if (!outOfBandError) {
            error.stack = decoderError.stack;
            outOfBandError = error;
            onQueueNotEmpty();
          }
        });
        const packetSink = this._createPacketSink();
        const keyPacket = await packetSink.getKeyPacket(startTimestamp) ?? await packetSink.getFirstPacket();
        if (!keyPacket) {
          return;
        }
        let currentPacket = keyPacket;
        let packetsEndTimestamp = Infinity;
        if (endTimestamp < Infinity) {
          const endPacket = await packetSink.getPacket(endTimestamp);
          const endKeyPacket = !endPacket ? null : endPacket.type === "key" && endPacket.timestamp === endTimestamp ? endPacket : await packetSink.getNextKeyPacket(endPacket);
          if (endKeyPacket) {
            packetsEndTimestamp = endKeyPacket.timestamp;
          }
        }
        const packets = packetSink.packets(keyPacket, packetsEndTimestamp);
        await packets.next();
        while (currentPacket && !ended) {
          if (sampleQueue.length + decoder.getDecodeQueueSize() > MAX_QUEUE_SIZE) {
            ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
            await queueDequeue;
            continue;
          }
          decoder.decode(currentPacket);
          const packetResult = await packets.next();
          if (packetResult.done) {
            break;
          }
          currentPacket = packetResult.value;
        }
        await packets.return();
        if (!terminated) await decoder.flush();
        decoder.close();
        if (!firstSampleQueued && lastSample) {
          sampleQueue.push(lastSample);
        }
        decoderIsFlushed = true;
        onQueueNotEmpty();
      })().catch((error) => {
        if (!outOfBandError) {
          outOfBandError = error;
          onQueueNotEmpty();
        }
      });
      return {
        async next() {
          while (true) {
            if (terminated) {
              return { value: void 0, done: true };
            } else if (outOfBandError) {
              throw outOfBandError;
            } else if (sampleQueue.length > 0) {
              const value = sampleQueue.shift();
              onQueueDequeue();
              return { value, done: false };
            } else if (!decoderIsFlushed) {
              await queueNotEmpty;
            } else {
              return { value: void 0, done: true };
            }
          }
        },
        async return() {
          terminated = true;
          ended = true;
          onQueueDequeue();
          onQueueNotEmpty();
          lastSample?.close();
          for (const sample of sampleQueue) {
            sample.close();
          }
          return { value: void 0, done: true };
        },
        async throw(error) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        }
      };
    }
    /** @internal */
    mediaSamplesAtTimestamps(timestamps) {
      validateAnyIterable(timestamps);
      const timestampIterator = toAsyncIterator(timestamps);
      const timestampsOfInterest = [];
      const MAX_QUEUE_SIZE = 8;
      const sampleQueue = [];
      let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
      let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
      let decoderIsFlushed = false;
      let terminated = false;
      let outOfBandError = null;
      let lastUsedSample = null;
      const pushToQueue = (sample) => {
        sampleQueue.push(sample);
        onQueueNotEmpty();
        ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
      };
      (async () => {
        const decoderError = new Error();
        const decoder = await this._createDecoder((sample) => {
          onQueueDequeue();
          if (terminated) {
            sample.close();
            return;
          }
          let sampleUsed = false;
          while (timestampsOfInterest.length > 0 && sample.timestamp - timestampsOfInterest[0] > -1e-10) {
            pushToQueue(sample.clone());
            timestampsOfInterest.shift();
            sampleUsed = true;
          }
          if (sampleUsed) {
            lastUsedSample?.close();
            lastUsedSample = sample;
          } else {
            sample.close();
          }
        }, (error) => {
          if (!outOfBandError) {
            error.stack = decoderError.stack;
            outOfBandError = error;
            onQueueNotEmpty();
          }
        });
        const packetSink = this._createPacketSink();
        let lastKeyPacket = null;
        let lastPacket = null;
        for await (const timestamp of timestampIterator) {
          validateTimestamp(timestamp);
          while (sampleQueue.length + decoder.getDecodeQueueSize() > MAX_QUEUE_SIZE && !terminated) {
            ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
            await queueDequeue;
          }
          if (terminated) {
            break;
          }
          const targetPacket = await packetSink.getPacket(timestamp);
          if (!targetPacket) {
            pushToQueue(null);
            continue;
          }
          const keyPacket = await packetSink.getKeyPacket(timestamp);
          if (!keyPacket) {
            pushToQueue(null);
            continue;
          }
          if (lastPacket && targetPacket.sequenceNumber < lastPacket.sequenceNumber) {
            await decoder.flush();
            timestampsOfInterest.length = 0;
          }
          if (lastKeyPacket && keyPacket.sequenceNumber === lastKeyPacket.sequenceNumber && targetPacket.timestamp >= lastPacket.timestamp) {
            assert(lastPacket);
            if (targetPacket.sequenceNumber === lastPacket.sequenceNumber && timestampsOfInterest.length === 0) {
              if (lastUsedSample) {
                pushToQueue(lastUsedSample.clone());
              }
            } else {
              timestampsOfInterest.push(targetPacket.timestamp);
            }
          } else {
            lastKeyPacket = keyPacket;
            lastPacket = keyPacket;
            decoder.decode(keyPacket);
            timestampsOfInterest.push(targetPacket.timestamp);
          }
          while (lastPacket.sequenceNumber < targetPacket.sequenceNumber) {
            const nextPacket = await packetSink.getNextPacket(lastPacket);
            assert(nextPacket);
            lastPacket = nextPacket;
            decoder.decode(nextPacket);
          }
        }
        if (!terminated) {
          await decoder.flush();
          lastUsedSample?.close();
        }
        decoder.close();
        decoderIsFlushed = true;
        onQueueNotEmpty();
      })().catch((error) => {
        if (!outOfBandError) {
          outOfBandError = error;
          onQueueNotEmpty();
        }
      });
      return {
        async next() {
          while (true) {
            if (terminated) {
              return { value: void 0, done: true };
            } else if (outOfBandError) {
              throw outOfBandError;
            } else if (sampleQueue.length > 0) {
              const value = sampleQueue.shift();
              assert(value !== void 0);
              onQueueDequeue();
              return { value, done: false };
            } else if (!decoderIsFlushed) {
              await queueNotEmpty;
            } else {
              return { value: void 0, done: true };
            }
          }
        },
        async return() {
          terminated = true;
          onQueueDequeue();
          onQueueNotEmpty();
          for (const sample of sampleQueue) {
            sample?.close();
          }
          lastUsedSample?.close();
          return { value: void 0, done: true };
        },
        async throw(error) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        }
      };
    }
  };
  var VideoDecoderWrapper = class extends DecoderWrapper {
    constructor(onSample, onError, codec, decoderConfig, rotation, timeResolution) {
      super(onSample, onError);
      this.rotation = rotation;
      this.timeResolution = timeResolution;
      this.decoder = null;
      this.customDecoder = null;
      this.lastCustomDecoderPromise = Promise.resolve();
      this.customDecoderQueueSize = 0;
      this.sampleQueue = [];
      const sampleHandler = (sample) => {
        if (this.sampleQueue.length > 0 && sample.timestamp >= last(this.sampleQueue).timestamp) {
          for (const sample2 of this.sampleQueue) {
            this.finalizeAndEmitSample(sample2);
          }
          this.sampleQueue.length = 0;
        }
        const insertionIndex = binarySearchLessOrEqual(
          this.sampleQueue,
          sample.timestamp,
          (x) => x.timestamp
        );
        this.sampleQueue.splice(insertionIndex + 1, 0, sample);
      };
      const MatchingCustomDecoder = customVideoDecoders.find((x) => x.supports(codec, decoderConfig));
      if (MatchingCustomDecoder) {
        this.customDecoder = new MatchingCustomDecoder();
        this.customDecoder.codec = codec;
        this.customDecoder.config = decoderConfig;
        this.customDecoder.onSample = sampleHandler;
        this.customDecoder.init();
      } else {
        this.decoder = new VideoDecoder({
          output: (frame) => sampleHandler(new VideoSample(frame)),
          error: onError
        });
        this.decoder.configure(decoderConfig);
      }
    }
    finalizeAndEmitSample(sample) {
      sample.setTimestamp(Math.round(sample.timestamp * this.timeResolution) / this.timeResolution);
      sample.setDuration(Math.round(sample.duration * this.timeResolution) / this.timeResolution);
      this.onSample(sample);
    }
    getDecodeQueueSize() {
      if (this.customDecoder) {
        return this.customDecoderQueueSize;
      } else {
        assert(this.decoder);
        return this.decoder.decodeQueueSize;
      }
    }
    decode(packet) {
      if (this.customDecoder) {
        this.customDecoderQueueSize++;
        this.lastCustomDecoderPromise = this.lastCustomDecoderPromise.then(() => {
          return this.customDecoder.decode(packet);
        });
        void this.lastCustomDecoderPromise.then(() => this.customDecoderQueueSize--);
      } else {
        assert(this.decoder);
        this.decoder.decode(packet.toEncodedVideoChunk());
      }
    }
    async flush() {
      if (this.customDecoder) {
        await this.lastCustomDecoderPromise.then(() => this.customDecoder.flush());
      } else {
        assert(this.decoder);
        await this.decoder.flush();
      }
      for (const sample of this.sampleQueue) {
        this.finalizeAndEmitSample(sample);
      }
      this.sampleQueue.length = 0;
    }
    close() {
      if (this.customDecoder) {
        void this.lastCustomDecoderPromise.then(() => this.customDecoder.close());
      } else {
        assert(this.decoder);
        this.decoder.close();
      }
      for (const sample of this.sampleQueue) {
        sample.close();
      }
      this.sampleQueue.length = 0;
    }
  };
  var VideoSampleSink = class extends BaseMediaSampleSink {
    constructor(videoTrack) {
      if (!(videoTrack instanceof InputVideoTrack)) {
        throw new TypeError("videoTrack must be an InputVideoTrack.");
      }
      super();
      this._videoTrack = videoTrack;
    }
    /** @internal */
    async _createDecoder(onSample, onError) {
      if (!await this._videoTrack.canDecode()) {
        throw new Error(
          "This video track cannot be decoded by this browser. Make sure to check decodability before using a track."
        );
      }
      const codec = this._videoTrack.codec;
      const rotation = this._videoTrack.rotation;
      const decoderConfig = await this._videoTrack.getDecoderConfig();
      const timeResolution = this._videoTrack.timeResolution;
      assert(codec && decoderConfig);
      return new VideoDecoderWrapper(onSample, onError, codec, decoderConfig, rotation, timeResolution);
    }
    /** @internal */
    _createPacketSink() {
      return new EncodedPacketSink(this._videoTrack);
    }
    /**
     * Retrieves the video sample (frame) corresponding to the given timestamp, in seconds. More specifically, returns
     * the last video sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getSample(timestamp) {
      validateTimestamp(timestamp);
      for await (const sample of this.mediaSamplesAtTimestamps([timestamp])) {
        return sample;
      }
      throw new Error("Internal error: Iterator returned nothing.");
    }
    /**
     * Creates an async iterator that yields the video samples (frames) of this track in presentation order. This method
     * will intelligently pre-decode a few frames ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
     */
    samples(startTimestamp = 0, endTimestamp = Infinity) {
      return this.mediaSamplesInRange(startTimestamp, endTimestamp);
    }
    /**
     * Creates an async iterator that yields a video sample (frame) for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
     * yield null if no frame is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    samplesAtTimestamps(timestamps) {
      return this.mediaSamplesAtTimestamps(timestamps);
    }
  };
  var CanvasSink = class {
    constructor(videoTrack, options = {}) {
      /** @internal */
      this._nextCanvasIndex = 0;
      if (!(videoTrack instanceof InputVideoTrack)) {
        throw new TypeError("videoTrack must be an InputVideoTrack.");
      }
      if (options && typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (options.width !== void 0 && (!Number.isInteger(options.width) || options.width <= 0)) {
        throw new TypeError("options.width, when defined, must be a positive integer.");
      }
      if (options.height !== void 0 && (!Number.isInteger(options.height) || options.height <= 0)) {
        throw new TypeError("options.height, when defined, must be a positive integer.");
      }
      if (options.fit !== void 0 && !["fill", "contain", "cover"].includes(options.fit)) {
        throw new TypeError('options.fit, when provided, must be one of "fill", "contain", or "cover".');
      }
      if (options.width !== void 0 && options.height !== void 0 && options.fit === void 0) {
        throw new TypeError(
          "When both options.width and options.height are provided, options.fit must also be provided."
        );
      }
      if (options.rotation !== void 0 && ![0, 90, 180, 270].includes(options.rotation)) {
        throw new TypeError("options.rotation, when provided, must be 0, 90, 180 or 270.");
      }
      if (options.poolSize !== void 0 && (typeof options.poolSize !== "number" || !Number.isInteger(options.poolSize) || options.poolSize < 0)) {
        throw new TypeError("poolSize must be a non-negative integer.");
      }
      const rotation = options.rotation ?? videoTrack.rotation;
      let [width, height] = rotation % 180 === 0 ? [videoTrack.codedWidth, videoTrack.codedHeight] : [videoTrack.codedHeight, videoTrack.codedWidth];
      const originalAspectRatio = width / height;
      if (options.width !== void 0 && options.height === void 0) {
        width = options.width;
        height = Math.round(width / originalAspectRatio);
      } else if (options.width === void 0 && options.height !== void 0) {
        height = options.height;
        width = Math.round(height * originalAspectRatio);
      } else if (options.width !== void 0 && options.height !== void 0) {
        width = options.width;
        height = options.height;
      }
      this._videoTrack = videoTrack;
      this._width = width;
      this._height = height;
      this._rotation = rotation;
      this._fit = options.fit ?? "fill";
      this._videoSampleSink = new VideoSampleSink(videoTrack);
      this._canvasPool = Array.from({ length: options.poolSize ?? 0 }, () => null);
    }
    /** @internal */
    _videoSampleToWrappedCanvas(sample) {
      let canvas = this._canvasPool[this._nextCanvasIndex];
      if (!canvas) {
        if (typeof OffscreenCanvas !== "undefined") {
          canvas = new OffscreenCanvas(this._width, this._height);
        } else {
          canvas = document.createElement("canvas");
          canvas.width = this._width;
          canvas.height = this._height;
        }
        if (this._canvasPool.length > 0) {
          this._canvasPool[this._nextCanvasIndex] = canvas;
        }
      }
      if (this._canvasPool.length > 0) {
        this._nextCanvasIndex = (this._nextCanvasIndex + 1) % this._canvasPool.length;
      }
      const context = canvas.getContext("2d", { alpha: false });
      assert(context);
      context.resetTransform();
      let dx;
      let dy;
      let newWidth;
      let newHeight;
      if (this._fit === "fill") {
        dx = 0;
        dy = 0;
        newWidth = this._width;
        newHeight = this._height;
      } else {
        const [sampleWidth, sampleHeight] = this._rotation % 180 === 0 ? [sample.codedWidth, sample.codedHeight] : [sample.codedHeight, sample.codedWidth];
        const scale = this._fit === "contain" ? Math.min(this._width / sampleWidth, this._height / sampleHeight) : Math.max(this._width / sampleWidth, this._height / sampleHeight);
        newWidth = sampleWidth * scale;
        newHeight = sampleHeight * scale;
        dx = (this._width - newWidth) / 2;
        dy = (this._height - newHeight) / 2;
      }
      const aspectRatioChange = this._rotation % 180 === 0 ? 1 : newWidth / newHeight;
      context.translate(this._width / 2, this._height / 2);
      context.rotate(this._rotation * Math.PI / 180);
      context.scale(1 / aspectRatioChange, aspectRatioChange);
      context.translate(-this._width / 2, -this._height / 2);
      context.drawImage(sample.toCanvasImageSource(), dx, dy, newWidth, newHeight);
      const result = {
        canvas,
        timestamp: sample.timestamp,
        duration: sample.duration
      };
      sample.close();
      return result;
    }
    /**
     * Retrieves a canvas with the video frame corresponding to the given timestamp, in seconds. More specifically,
     * returns the last video frame (in presentation order) with a start timestamp less than or equal to the given
     * timestamp. Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getCanvas(timestamp) {
      validateTimestamp(timestamp);
      const sample = await this._videoSampleSink.getSample(timestamp);
      return sample && this._videoSampleToWrappedCanvas(sample);
    }
    /**
     * Creates an async iterator that yields canvases with the video frames of this track in presentation order. This
     * method will intelligently pre-decode a few frames ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding canvases (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding canvases (exclusive).
     */
    canvases(startTimestamp = 0, endTimestamp = Infinity) {
      return mapAsyncGenerator(
        this._videoSampleSink.samples(startTimestamp, endTimestamp),
        (sample) => this._videoSampleToWrappedCanvas(sample)
      );
    }
    /**
     * Creates an async iterator that yields a canvas for each timestamp in the argument. This method uses an optimized
     * decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most once, and is
     * therefore more efficient than manually getting the canvas for every timestamp. The iterator may yield null if
     * no frame is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    canvasesAtTimestamps(timestamps) {
      return mapAsyncGenerator(
        this._videoSampleSink.samplesAtTimestamps(timestamps),
        (sample) => sample && this._videoSampleToWrappedCanvas(sample)
      );
    }
  };
  var AudioDecoderWrapper = class extends DecoderWrapper {
    constructor(onSample, onError, codec, decoderConfig) {
      super(onSample, onError);
      this.decoder = null;
      this.customDecoder = null;
      this.lastCustomDecoderPromise = Promise.resolve();
      this.customDecoderQueueSize = 0;
      const sampleHandler = (sample) => {
        const sampleRate = decoderConfig.sampleRate;
        sample.setTimestamp(Math.round(sample.timestamp * sampleRate) / sampleRate);
        onSample(sample);
      };
      const MatchingCustomDecoder = customAudioDecoders.find((x) => x.supports(codec, decoderConfig));
      if (MatchingCustomDecoder) {
        this.customDecoder = new MatchingCustomDecoder();
        this.customDecoder.codec = codec;
        this.customDecoder.config = decoderConfig;
        this.customDecoder.onSample = sampleHandler;
        this.customDecoder.init();
      } else {
        this.decoder = new AudioDecoder({
          output: (data) => sampleHandler(new AudioSample(data)),
          error: onError
        });
        this.decoder.configure(decoderConfig);
      }
    }
    getDecodeQueueSize() {
      if (this.customDecoder) {
        return this.customDecoderQueueSize;
      } else {
        assert(this.decoder);
        return this.decoder.decodeQueueSize;
      }
    }
    decode(packet) {
      if (this.customDecoder) {
        this.customDecoderQueueSize++;
        this.lastCustomDecoderPromise = this.lastCustomDecoderPromise.then(() => {
          return this.customDecoder.decode(packet);
        });
        void this.lastCustomDecoderPromise.then(() => this.customDecoderQueueSize--);
      } else {
        assert(this.decoder);
        this.decoder.decode(packet.toEncodedAudioChunk());
      }
    }
    flush() {
      if (this.customDecoder) {
        return this.lastCustomDecoderPromise.then(() => this.customDecoder.flush());
      } else {
        assert(this.decoder);
        return this.decoder.flush();
      }
    }
    close() {
      if (this.customDecoder) {
        void this.lastCustomDecoderPromise.then(() => this.customDecoder.close());
      } else {
        assert(this.decoder);
        this.decoder.close();
      }
    }
  };
  var PcmAudioDecoderWrapper = class extends DecoderWrapper {
    constructor(onSample, onError, decoderConfig) {
      super(onSample, onError);
      this.decoderConfig = decoderConfig;
      // Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
      // inaccurate) sample timestamps.
      this.currentTimestamp = null;
      assert(PCM_AUDIO_CODECS.includes(decoderConfig.codec));
      this.codec = decoderConfig.codec;
      const { dataType, sampleSize, littleEndian } = parsePcmCodec(this.codec);
      this.inputSampleSize = sampleSize;
      switch (sampleSize) {
        case 1:
          {
            if (dataType === "unsigned") {
              this.readInputValue = (view2, byteOffset) => view2.getUint8(byteOffset) - 2 ** 7;
            } else if (dataType === "signed") {
              this.readInputValue = (view2, byteOffset) => view2.getInt8(byteOffset);
            } else if (dataType === "ulaw") {
              this.readInputValue = (view2, byteOffset) => fromUlaw(view2.getUint8(byteOffset));
            } else if (dataType === "alaw") {
              this.readInputValue = (view2, byteOffset) => fromAlaw(view2.getUint8(byteOffset));
            } else {
              assert(false);
            }
          }
          ;
          break;
        case 2:
          {
            if (dataType === "unsigned") {
              this.readInputValue = (view2, byteOffset) => view2.getUint16(byteOffset, littleEndian) - 2 ** 15;
            } else if (dataType === "signed") {
              this.readInputValue = (view2, byteOffset) => view2.getInt16(byteOffset, littleEndian);
            } else {
              assert(false);
            }
          }
          ;
          break;
        case 3:
          {
            if (dataType === "unsigned") {
              this.readInputValue = (view2, byteOffset) => getUint24(view2, byteOffset, littleEndian) - 2 ** 23;
            } else if (dataType === "signed") {
              this.readInputValue = (view2, byteOffset) => getInt24(view2, byteOffset, littleEndian);
            } else {
              assert(false);
            }
          }
          ;
          break;
        case 4:
          {
            if (dataType === "unsigned") {
              this.readInputValue = (view2, byteOffset) => view2.getUint32(byteOffset, littleEndian) - 2 ** 31;
            } else if (dataType === "signed") {
              this.readInputValue = (view2, byteOffset) => view2.getInt32(byteOffset, littleEndian);
            } else if (dataType === "float") {
              this.readInputValue = (view2, byteOffset) => view2.getFloat32(byteOffset, littleEndian);
            } else {
              assert(false);
            }
          }
          ;
          break;
      }
      switch (sampleSize) {
        case 1:
          {
            if (dataType === "ulaw" || dataType === "alaw") {
              this.outputSampleSize = 2;
              this.outputFormat = "s16";
              this.writeOutputValue = (view2, byteOffset, value) => view2.setInt16(byteOffset, value, true);
            } else {
              this.outputSampleSize = 1;
              this.outputFormat = "u8";
              this.writeOutputValue = (view2, byteOffset, value) => view2.setUint8(byteOffset, value + 2 ** 7);
            }
          }
          ;
          break;
        case 2:
          {
            this.outputSampleSize = 2;
            this.outputFormat = "s16";
            this.writeOutputValue = (view2, byteOffset, value) => view2.setInt16(byteOffset, value, true);
          }
          ;
          break;
        case 3:
          {
            this.outputSampleSize = 4;
            this.outputFormat = "s32";
            this.writeOutputValue = (view2, byteOffset, value) => view2.setInt32(byteOffset, value << 8, true);
          }
          ;
          break;
        case 4:
          {
            this.outputSampleSize = 4;
            if (dataType === "float") {
              this.outputFormat = "f32";
              this.writeOutputValue = (view2, byteOffset, value) => view2.setFloat32(byteOffset, value, true);
            } else {
              this.outputFormat = "s32";
              this.writeOutputValue = (view2, byteOffset, value) => view2.setInt32(byteOffset, value, true);
            }
          }
          ;
          break;
      }
      ;
    }
    getDecodeQueueSize() {
      return 0;
    }
    decode(packet) {
      const inputView = toDataView(packet.data);
      const numberOfFrames = packet.byteLength / this.decoderConfig.numberOfChannels / this.inputSampleSize;
      const outputBufferSize = numberOfFrames * this.decoderConfig.numberOfChannels * this.outputSampleSize;
      const outputBuffer = new ArrayBuffer(outputBufferSize);
      const outputView = new DataView(outputBuffer);
      for (let i = 0; i < numberOfFrames * this.decoderConfig.numberOfChannels; i++) {
        const inputIndex = i * this.inputSampleSize;
        const outputIndex = i * this.outputSampleSize;
        const value = this.readInputValue(inputView, inputIndex);
        this.writeOutputValue(outputView, outputIndex, value);
      }
      const preciseDuration = numberOfFrames / this.decoderConfig.sampleRate;
      if (this.currentTimestamp === null || Math.abs(packet.timestamp - this.currentTimestamp) >= preciseDuration) {
        this.currentTimestamp = packet.timestamp;
      }
      const preciseTimestamp = this.currentTimestamp;
      this.currentTimestamp += preciseDuration;
      const audioSample = new AudioSample({
        format: this.outputFormat,
        data: outputBuffer,
        numberOfChannels: this.decoderConfig.numberOfChannels,
        sampleRate: this.decoderConfig.sampleRate,
        numberOfFrames,
        timestamp: preciseTimestamp
      });
      this.onSample(audioSample);
    }
    async flush() {
    }
    close() {
    }
  };
  var AudioSampleSink = class extends BaseMediaSampleSink {
    constructor(audioTrack) {
      if (!(audioTrack instanceof InputAudioTrack)) {
        throw new TypeError("audioTrack must be an InputAudioTrack.");
      }
      super();
      this._audioTrack = audioTrack;
    }
    /** @internal */
    async _createDecoder(onSample, onError) {
      if (!await this._audioTrack.canDecode()) {
        throw new Error(
          "This audio track cannot be decoded by this browser. Make sure to check decodability before using a track."
        );
      }
      const codec = this._audioTrack.codec;
      const decoderConfig = await this._audioTrack.getDecoderConfig();
      assert(codec && decoderConfig);
      if (PCM_AUDIO_CODECS.includes(decoderConfig.codec)) {
        return new PcmAudioDecoderWrapper(onSample, onError, decoderConfig);
      } else {
        return new AudioDecoderWrapper(onSample, onError, codec, decoderConfig);
      }
    }
    /** @internal */
    _createPacketSink() {
      return new EncodedPacketSink(this._audioTrack);
    }
    /**
     * Retrieves the audio sample corresponding to the given timestamp, in seconds. More specifically, returns
     * the last audio sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getSample(timestamp) {
      validateTimestamp(timestamp);
      for await (const sample of this.mediaSamplesAtTimestamps([timestamp])) {
        return sample;
      }
      throw new Error("Internal error: Iterator returned nothing.");
    }
    /**
     * Creates an async iterator that yields the audio samples of this track in presentation order. This method
     * will intelligently pre-decode a few samples ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
     */
    samples(startTimestamp = 0, endTimestamp = Infinity) {
      return this.mediaSamplesInRange(startTimestamp, endTimestamp);
    }
    /**
     * Creates an async iterator that yields an audio sample for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
     * yield null if no sample is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    samplesAtTimestamps(timestamps) {
      return this.mediaSamplesAtTimestamps(timestamps);
    }
  };
  var AudioBufferSink = class {
    constructor(audioTrack) {
      if (!(audioTrack instanceof InputAudioTrack)) {
        throw new TypeError("audioTrack must be an InputAudioTrack.");
      }
      this._audioSampleSink = new AudioSampleSink(audioTrack);
    }
    /** @internal */
    _audioSampleToWrappedArrayBuffer(sample) {
      return {
        buffer: sample.toAudioBuffer(),
        timestamp: sample.timestamp,
        duration: sample.duration
      };
    }
    /**
     * Retrieves the audio buffer corresponding to the given timestamp, in seconds. More specifically, returns
     * the last audio buffer (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getBuffer(timestamp) {
      validateTimestamp(timestamp);
      const data = await this._audioSampleSink.getSample(timestamp);
      return data && this._audioSampleToWrappedArrayBuffer(data);
    }
    /**
     * Creates an async iterator that yields audio buffers of this track in presentation order. This method
     * will intelligently pre-decode a few buffers ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding buffers (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding buffers (exclusive).
     */
    buffers(startTimestamp = 0, endTimestamp = Infinity) {
      return mapAsyncGenerator(
        this._audioSampleSink.samples(startTimestamp, endTimestamp),
        (data) => this._audioSampleToWrappedArrayBuffer(data)
      );
    }
    /**
     * Creates an async iterator that yields an audio buffer for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the buffer for every timestamp. The iterator may
     * yield null if no buffer is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    buffersAtTimestamps(timestamps) {
      return mapAsyncGenerator(
        this._audioSampleSink.samplesAtTimestamps(timestamps),
        (data) => data && this._audioSampleToWrappedArrayBuffer(data)
      );
    }
  };

  // src/input-track.ts
  var InputTrack = class {
    /** @internal */
    constructor(backing) {
      this._backing = backing;
    }
    /** Returns true iff this track is a video track. */
    isVideoTrack() {
      return this instanceof InputVideoTrack;
    }
    /** Returns true iff this track is an audio track. */
    isAudioTrack() {
      return this instanceof InputAudioTrack;
    }
    /** The unique ID of this track in the input file. */
    get id() {
      return this._backing.getId();
    }
    /** The ISO 639-2 language code for this track. If the language is unknown, this field is 'und' (undetermined). */
    get languageCode() {
      return this._backing.getLanguageCode();
    }
    /**
     * A positive number x such that all timestamps and durations of all packets of this track are
     * integer multiples of 1/x.
     */
    get timeResolution() {
      return this._backing.getTimeResolution();
    }
    /**
     * Returns the start timestamp of the first packet of this track, in seconds. While often near zero, this value
     * may be positive or even negative. A negative starting timestamp means the track's timing has been offset. Samples
     * with a negative timestamp should not be presented.
     */
    getFirstTimestamp() {
      return this._backing.getFirstTimestamp();
    }
    /** Returns the end timestamp of the last packet of this track, in seconds. */
    computeDuration() {
      return this._backing.computeDuration();
    }
    /** Computes aggregate packet statistics for this track, such as average packet rate or bitrate. */
    async computePacketStats() {
      const sink = new EncodedPacketSink(this);
      let startTimestamp = Infinity;
      let endTimestamp = -Infinity;
      let packetCount = 0;
      let totalPacketBytes = 0;
      for await (const packet of sink.packets(void 0, void 0, { metadataOnly: true })) {
        startTimestamp = Math.min(startTimestamp, packet.timestamp);
        endTimestamp = Math.max(endTimestamp, packet.timestamp + packet.duration);
        packetCount++;
        totalPacketBytes += packet.byteLength;
      }
      return {
        packetCount,
        averagePacketRate: packetCount ? Number((packetCount / (endTimestamp - startTimestamp)).toPrecision(16)) : 0,
        averageBitrate: packetCount ? Number((8 * totalPacketBytes / (endTimestamp - startTimestamp)).toPrecision(16)) : 0
      };
    }
  };
  var InputVideoTrack = class extends InputTrack {
    /** @internal */
    constructor(backing) {
      super(backing);
      this._backing = backing;
    }
    get type() {
      return "video";
    }
    get codec() {
      return this._backing.getCodec();
    }
    /** The width of the track's coded samples, before any transformations or rotations. */
    get codedWidth() {
      return this._backing.getCodedWidth();
    }
    /** The height of the track's coded samples, before any transformations or rotations. */
    get codedHeight() {
      return this._backing.getCodedHeight();
    }
    /** The angle in degrees by which the track's frames should be rotated (clockwise). */
    get rotation() {
      return this._backing.getRotation();
    }
    /** The width of the track's frames after rotation. */
    get displayWidth() {
      const rotation = this._backing.getRotation();
      return rotation % 180 === 0 ? this._backing.getCodedWidth() : this._backing.getCodedHeight();
    }
    /** The height of the track's frames after rotation. */
    get displayHeight() {
      const rotation = this._backing.getRotation();
      return rotation % 180 === 0 ? this._backing.getCodedHeight() : this._backing.getCodedWidth();
    }
    /** Returns the color space of the track's samples. */
    getColorSpace() {
      return this._backing.getColorSpace();
    }
    /** Returns true iff the track's samples use a high dynamic range (HDR). */
    async hasHighDynamicRange() {
      const colorSpace = await this._backing.getColorSpace();
      return colorSpace.primaries === "bt2020" || colorSpace.primaries === "smpte432" || colorSpace.transfer === "pg" || colorSpace.transfer === "hlg" || colorSpace.matrix === "bt2020-ncl";
    }
    /** Returns the decoder configuration for decoding the track's packets using a VideoDecoder. */
    getDecoderConfig() {
      return this._backing.getDecoderConfig();
    }
    async getCodecParameterString() {
      const decoderConfig = await this._backing.getDecoderConfig();
      return decoderConfig?.codec ?? null;
    }
    async canDecode() {
      try {
        const decoderConfig = await this._backing.getDecoderConfig();
        if (!decoderConfig) {
          return false;
        }
        const codec = this._backing.getCodec();
        assert(codec !== null);
        if (customVideoDecoders.some((x) => x.supports(codec, decoderConfig))) {
          return true;
        }
        if (typeof VideoDecoder === "undefined") {
          return false;
        }
        const support = await VideoDecoder.isConfigSupported(decoderConfig);
        return support.supported === true;
      } catch (error) {
        console.error("Error during decodability check:", error);
        return false;
      }
    }
  };
  var InputAudioTrack = class extends InputTrack {
    /** @internal */
    constructor(backing) {
      super(backing);
      this._backing = backing;
    }
    get type() {
      return "audio";
    }
    get codec() {
      return this._backing.getCodec();
    }
    /** The number of audio channels in the track. */
    get numberOfChannels() {
      return this._backing.getNumberOfChannels();
    }
    /** The track's audio sample rate in hertz. */
    get sampleRate() {
      return this._backing.getSampleRate();
    }
    /** Returns the decoder configuration for decoding the track's packets using an AudioDecoder. */
    getDecoderConfig() {
      return this._backing.getDecoderConfig();
    }
    async getCodecParameterString() {
      const decoderConfig = await this._backing.getDecoderConfig();
      return decoderConfig?.codec ?? null;
    }
    async canDecode() {
      try {
        const decoderConfig = await this._backing.getDecoderConfig();
        if (!decoderConfig) {
          return false;
        }
        const codec = this._backing.getCodec();
        assert(codec !== null);
        if (customAudioDecoders.some((x) => x.supports(codec, decoderConfig))) {
          return true;
        }
        if (decoderConfig.codec.startsWith("pcm-")) {
          return true;
        } else {
          if (typeof AudioDecoder === "undefined") {
            return false;
          }
          const support = await AudioDecoder.isConfigSupported(decoderConfig);
          return support.supported === true;
        }
      } catch (error) {
        console.error("Error during decodability check:", error);
        return false;
      }
    }
  };

  // src/reader.ts
  var Reader = class {
    constructor(source, maxStorableBytes = Infinity) {
      this.source = source;
      this.maxStorableBytes = maxStorableBytes;
      this.loadedSegments = [];
      this.loadingSegments = [];
      this.sourceSizePromise = null;
      this.nextAge = 0;
      this.totalStoredBytes = 0;
    }
    async loadRange(start, end) {
      end = Math.min(end, await this.source._getSize());
      if (start >= end) {
        return;
      }
      const matchingLoadingSegment = this.loadingSegments.find((x) => x.start <= start && x.end >= end);
      if (matchingLoadingSegment) {
        await matchingLoadingSegment.promise;
        return;
      }
      const index = binarySearchLessOrEqual(
        this.loadedSegments,
        start,
        (x) => x.start
      );
      if (index !== -1) {
        for (let i = index; i < this.loadedSegments.length; i++) {
          const segment = this.loadedSegments[i];
          if (segment.start > start) {
            break;
          }
          const segmentEncasesRequestedRange = segment.end >= end;
          if (segmentEncasesRequestedRange) {
            return;
          }
        }
      }
      this.source.onread?.({ start, end });
      const bytesPromise = this.source._read(start, end);
      const loadingSegment = { start, end, promise: bytesPromise };
      this.loadingSegments.push(loadingSegment);
      const bytes2 = await bytesPromise;
      removeItem(this.loadingSegments, loadingSegment);
      this.insertIntoLoadedSegments(start, bytes2);
    }
    insertIntoLoadedSegments(start, bytes2) {
      const segment = {
        start,
        end: start + bytes2.byteLength,
        bytes: bytes2,
        view: new DataView(bytes2.buffer),
        age: this.nextAge++
      };
      let index = binarySearchLessOrEqual(this.loadedSegments, start, (x) => x.start);
      if (index === -1 || this.loadedSegments[index].start < segment.start) {
        index++;
      }
      this.loadedSegments.splice(index, 0, segment);
      this.totalStoredBytes += bytes2.byteLength;
      for (let i = index + 1; i < this.loadedSegments.length; i++) {
        const otherSegment = this.loadedSegments[i];
        if (otherSegment.start >= segment.end) {
          break;
        }
        if (segment.start <= otherSegment.start && otherSegment.end <= segment.end) {
          this.loadedSegments.splice(i, 1);
          i--;
        }
      }
      while (this.totalStoredBytes > this.maxStorableBytes && this.loadedSegments.length > 1) {
        let oldestSegment = null;
        let oldestSegmentIndex = -1;
        for (let i = 0; i < this.loadedSegments.length; i++) {
          const candidate = this.loadedSegments[i];
          if (!oldestSegment || candidate.age < oldestSegment.age) {
            oldestSegment = candidate;
            oldestSegmentIndex = i;
          }
        }
        assert(oldestSegment);
        this.totalStoredBytes -= oldestSegment.bytes.byteLength;
        this.loadedSegments.splice(oldestSegmentIndex, 1);
      }
    }
    getViewAndOffset(start, end) {
      const startIndex = binarySearchLessOrEqual(this.loadedSegments, start, (x) => x.start);
      let segment = null;
      if (startIndex !== -1) {
        for (let i = startIndex; i < this.loadedSegments.length; i++) {
          const candidate = this.loadedSegments[i];
          if (candidate.start > start) {
            break;
          }
          if (end <= candidate.end) {
            segment = candidate;
            break;
          }
        }
      }
      if (!segment) {
        throw new Error(`No segment loaded for range [${start}, ${end}).`);
      }
      segment.age = this.nextAge++;
      return {
        view: segment.view,
        offset: segment.bytes.byteOffset + start - segment.start
      };
    }
    forgetRange(start, end) {
      if (end <= start) {
        return;
      }
      const startIndex = binarySearchLessOrEqual(this.loadedSegments, start, (x) => x.start);
      if (startIndex === -1) {
        return;
      }
      const segment = this.loadedSegments[startIndex];
      if (segment.start !== start || segment.end !== end) {
        return;
      }
      this.loadedSegments.splice(startIndex, 1);
      this.totalStoredBytes -= segment.bytes.byteLength;
    }
  };

  // src/wave/riff-reader.ts
  var RiffReader = class {
    constructor(reader) {
      this.reader = reader;
      this.pos = 0;
      this.littleEndian = true;
    }
    readBytes(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      return new Uint8Array(view2.buffer, offset, length);
    }
    readU16() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 2);
      this.pos += 2;
      return view2.getUint16(offset, this.littleEndian);
    }
    readU32() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 4);
      this.pos += 4;
      return view2.getUint32(offset, this.littleEndian);
    }
    readAscii(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      let str = "";
      for (let i = 0; i < length; i++) {
        str += String.fromCharCode(view2.getUint8(offset + i));
      }
      return str;
    }
  };

  // src/wave/wave-demuxer.ts
  var WaveDemuxer = class extends Demuxer {
    constructor(input) {
      super(input);
      this.metadataPromise = null;
      this.dataStart = -1;
      this.dataSize = -1;
      this.audioInfo = null;
      this.tracks = [];
      this.metadataReader = new RiffReader(input._mainReader);
      this.chunkReader = new RiffReader(new Reader(input._source, 64 * 2 ** 20));
    }
    async readMetadata() {
      return this.metadataPromise ??= (async () => {
        const riffType = this.metadataReader.readAscii(4);
        this.metadataReader.littleEndian = riffType === "RIFF";
        const totalFileSize = this.metadataReader.readU32() + 8;
        const format = this.metadataReader.readAscii(4);
        if (format !== "WAVE") {
          throw new Error("Invalid WAVE file - wrong format");
        }
        this.metadataReader.pos = 12;
        while (this.metadataReader.pos < totalFileSize) {
          await this.metadataReader.reader.loadRange(this.metadataReader.pos, this.metadataReader.pos + 8);
          const chunkId = this.metadataReader.readAscii(4);
          const chunkSize = this.metadataReader.readU32();
          const startPos = this.metadataReader.pos;
          if (chunkId === "fmt ") {
            await this.parseFmtChunk(chunkSize);
          } else if (chunkId === "data") {
            this.dataStart = this.metadataReader.pos;
            this.dataSize = chunkSize;
          }
          this.metadataReader.pos = startPos + chunkSize + (chunkSize & 1);
        }
        if (!this.audioInfo) {
          throw new Error('Invalid WAVE file - missing "fmt " chunk');
        }
        if (this.dataStart === -1) {
          throw new Error('Invalid WAVE file - missing "data" chunk');
        }
        const blockSize = this.audioInfo.blockSizeInBytes;
        this.dataSize = Math.floor(this.dataSize / blockSize) * blockSize;
        this.tracks.push(new InputAudioTrack(new WaveAudioTrackBacking(this)));
      })();
    }
    async parseFmtChunk(size) {
      await this.metadataReader.reader.loadRange(this.metadataReader.pos, this.metadataReader.pos + size);
      let formatTag = this.metadataReader.readU16();
      const numChannels = this.metadataReader.readU16();
      const sampleRate = this.metadataReader.readU32();
      this.metadataReader.pos += 4;
      const blockAlign = this.metadataReader.readU16();
      let bitsPerSample;
      if (size === 14) {
        bitsPerSample = 8;
      } else {
        bitsPerSample = this.metadataReader.readU16();
      }
      if (size >= 18 && formatTag !== 357) {
        const cbSize = this.metadataReader.readU16();
        const remainingSize = size - 18;
        const extensionSize = Math.min(remainingSize, cbSize);
        if (extensionSize >= 22 && formatTag === 65534 /* EXTENSIBLE */) {
          this.metadataReader.pos += 2 + 4;
          const subFormat = this.metadataReader.readBytes(16);
          formatTag = subFormat[0] | subFormat[1] << 8;
        }
      }
      if (formatTag === 7 /* MULAW */ || formatTag === 6 /* ALAW */) {
        bitsPerSample = 8;
      }
      this.audioInfo = {
        format: formatTag,
        numberOfChannels: numChannels,
        sampleRate,
        sampleSizeInBytes: Math.ceil(bitsPerSample / 8),
        blockSizeInBytes: blockAlign
      };
    }
    getCodec() {
      assert(this.audioInfo);
      if (this.audioInfo.format === 7 /* MULAW */) {
        return "ulaw";
      }
      if (this.audioInfo.format === 6 /* ALAW */) {
        return "alaw";
      }
      if (this.audioInfo.format === 1 /* PCM */) {
        if (this.audioInfo.sampleSizeInBytes === 1) {
          return "pcm-u8";
        } else if (this.audioInfo.sampleSizeInBytes === 2) {
          return "pcm-s16";
        } else if (this.audioInfo.sampleSizeInBytes === 3) {
          return "pcm-s24";
        } else if (this.audioInfo.sampleSizeInBytes === 4) {
          return "pcm-s32";
        }
      }
      if (this.audioInfo.format === 3 /* IEEE_FLOAT */) {
        if (this.audioInfo.sampleSizeInBytes === 4) {
          return "pcm-f32";
        }
      }
      return null;
    }
    async getMimeType() {
      return "audio/wav";
    }
    async computeDuration() {
      await this.readMetadata();
      assert(this.audioInfo);
      const numberOfBlocks = this.dataSize / this.audioInfo.blockSizeInBytes;
      return numberOfBlocks / this.audioInfo.sampleRate;
    }
    async getTracks() {
      await this.readMetadata();
      return this.tracks;
    }
  };
  var PACKET_SIZE_IN_FRAMES = 2048;
  var WaveAudioTrackBacking = class {
    constructor(demuxer) {
      this.demuxer = demuxer;
    }
    getId() {
      return 1;
    }
    getCodec() {
      return this.demuxer.getCodec();
    }
    async getDecoderConfig() {
      const codec = this.demuxer.getCodec();
      if (!codec) {
        return null;
      }
      assert(this.demuxer.audioInfo);
      return {
        codec,
        numberOfChannels: this.demuxer.audioInfo.numberOfChannels,
        sampleRate: this.demuxer.audioInfo.sampleRate
      };
    }
    computeDuration() {
      return this.demuxer.computeDuration();
    }
    getNumberOfChannels() {
      assert(this.demuxer.audioInfo);
      return this.demuxer.audioInfo.numberOfChannels;
    }
    getSampleRate() {
      assert(this.demuxer.audioInfo);
      return this.demuxer.audioInfo.sampleRate;
    }
    getTimeResolution() {
      assert(this.demuxer.audioInfo);
      return this.demuxer.audioInfo.sampleRate;
    }
    getLanguageCode() {
      return UNDETERMINED_LANGUAGE;
    }
    async getFirstTimestamp() {
      return 0;
    }
    async getPacketAtIndex(packetIndex, options) {
      assert(this.demuxer.audioInfo);
      const startOffset = packetIndex * PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes;
      if (startOffset >= this.demuxer.dataSize) {
        return null;
      }
      const sizeInBytes = Math.min(
        PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes,
        this.demuxer.dataSize - startOffset
      );
      let data;
      if (options.metadataOnly) {
        data = PLACEHOLDER_DATA;
      } else {
        const sizeOfOnePacket = PACKET_SIZE_IN_FRAMES * this.demuxer.audioInfo.blockSizeInBytes;
        const chunkSize = Math.ceil(2 ** 19 / sizeOfOnePacket) * sizeOfOnePacket;
        const chunkStart = Math.floor(startOffset / chunkSize) * chunkSize;
        const chunkEnd = chunkStart + chunkSize;
        await this.demuxer.chunkReader.reader.loadRange(
          this.demuxer.dataStart + chunkStart,
          this.demuxer.dataStart + chunkEnd
        );
        this.demuxer.chunkReader.pos = this.demuxer.dataStart + startOffset;
        data = this.demuxer.chunkReader.readBytes(sizeInBytes);
      }
      const timestamp = packetIndex * PACKET_SIZE_IN_FRAMES / this.demuxer.audioInfo.sampleRate;
      const duration = sizeInBytes / this.demuxer.audioInfo.blockSizeInBytes / this.demuxer.audioInfo.sampleRate;
      return new EncodedPacket(
        data,
        "key",
        timestamp,
        duration,
        packetIndex
      );
    }
    getFirstPacket(options) {
      return this.getPacketAtIndex(0, options);
    }
    getPacket(timestamp, options) {
      assert(this.demuxer.audioInfo);
      const packetIndex = Math.floor(timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES);
      return this.getPacketAtIndex(packetIndex, options);
    }
    getNextPacket(packet, options) {
      assert(this.demuxer.audioInfo);
      const packetIndex = Math.round(packet.timestamp * this.demuxer.audioInfo.sampleRate / PACKET_SIZE_IN_FRAMES);
      return this.getPacketAtIndex(packetIndex + 1, options);
    }
    getKeyPacket(timestamp, options) {
      return this.getPacket(timestamp, options);
    }
    getNextKeyPacket(packet, options) {
      return this.getNextPacket(packet, options);
    }
  };

  // src/wave/riff-writer.ts
  var RiffWriter = class {
    constructor(writer) {
      this.writer = writer;
      this.helper = new Uint8Array(8);
      this.helperView = new DataView(this.helper.buffer);
    }
    writeU32(value) {
      this.helperView.setUint32(0, value, true);
      this.writer.write(this.helper.subarray(0, 4));
    }
    writeU16(value) {
      this.helperView.setUint16(0, value, true);
      this.writer.write(this.helper.subarray(0, 2));
    }
    writeAscii(text) {
      this.writer.write(new TextEncoder().encode(text));
    }
  };

  // src/wave/wave-muxer.ts
  var WaveMuxer = class extends Muxer {
    constructor(output) {
      super(output);
      this.headerWritten = false;
      this.dataSize = 0;
      this.writer = output._writer;
      this.riffWriter = new RiffWriter(output._writer);
    }
    async start() {
    }
    async addEncodedVideoPacket() {
      throw new Error("WAVE does not support video.");
    }
    async addEncodedAudioPacket(track, packet, meta) {
      const release = await this.mutex.acquire();
      try {
        if (!this.headerWritten) {
          if (!meta?.decoderConfig) {
            throw new Error("Decoder config is required for first audio sample.");
          }
          this.writeHeader(track, meta.decoderConfig);
          this.headerWritten = true;
        }
        this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === "key");
        this.writer.write(packet.data);
        this.dataSize += packet.data.byteLength;
        await this.writer.flush();
      } finally {
        release();
      }
    }
    async addSubtitleCue() {
      throw new Error("WAVE does not support subtitles.");
    }
    writeHeader(track, config) {
      let format;
      const codec = track.source._codec;
      const pcmInfo = parsePcmCodec(codec);
      if (pcmInfo.dataType === "ulaw") {
        format = 7 /* MULAW */;
      } else if (pcmInfo.dataType === "alaw") {
        format = 6 /* ALAW */;
      } else if (pcmInfo.dataType === "float") {
        format = 3 /* IEEE_FLOAT */;
      } else {
        format = 1 /* PCM */;
      }
      const channels = config.numberOfChannels;
      const sampleRate = config.sampleRate;
      const blockSize = pcmInfo.sampleSize * channels;
      this.riffWriter.writeAscii("RIFF");
      this.riffWriter.writeU32(0);
      this.riffWriter.writeAscii("WAVE");
      this.riffWriter.writeAscii("fmt ");
      this.riffWriter.writeU32(16);
      this.riffWriter.writeU16(format);
      this.riffWriter.writeU16(channels);
      this.riffWriter.writeU32(sampleRate);
      this.riffWriter.writeU32(sampleRate * blockSize);
      this.riffWriter.writeU16(blockSize);
      this.riffWriter.writeU16(8 * pcmInfo.sampleSize);
      this.riffWriter.writeAscii("data");
      this.riffWriter.writeU32(0);
    }
    async finalize() {
      const release = await this.mutex.acquire();
      const endPos = this.writer.getPos();
      this.writer.seek(4);
      this.riffWriter.writeU32(this.dataSize + 36);
      this.writer.seek(40);
      this.riffWriter.writeU32(this.dataSize);
      this.writer.seek(endPos);
      release();
    }
  };

  // src/output-format.ts
  var OutputFormat = class {
    /** Returns a list of video codecs that this output format can contain. */
    getSupportedVideoCodecs() {
      return this.getSupportedCodecs().filter((codec) => VIDEO_CODECS.includes(codec));
    }
    /** Returns a list of audio codecs that this output format can contain. */
    getSupportedAudioCodecs() {
      return this.getSupportedCodecs().filter((codec) => AUDIO_CODECS.includes(codec));
    }
    /** Returns a list of subtitle codecs that this output format can contain. */
    getSupportedSubtitleCodecs() {
      return this.getSupportedCodecs().filter((codec) => SUBTITLE_CODECS.includes(codec));
    }
    /** @internal */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _codecUnsupportedHint(codec) {
      return "";
    }
  };
  var IsobmffOutputFormat2 = class extends OutputFormat {
    constructor(options = {}) {
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (options.fastStart !== void 0 && ![false, "in-memory", "fragmented"].includes(options.fastStart)) {
        throw new TypeError('options.fastStart, when provided, must be false, "in-memory", or "fragmented".');
      }
      super();
      this._options = options;
    }
    getSupportedTrackCounts() {
      return {
        video: { min: 0, max: Infinity },
        audio: { min: 0, max: Infinity },
        subtitle: { min: 0, max: Infinity },
        total: { min: 1, max: 2 ** 32 - 1 }
        // Have fun reaching this one
      };
    }
    get supportsVideoRotationMetadata() {
      return true;
    }
    /** @internal */
    _createMuxer(output) {
      return new IsobmffMuxer(output, this);
    }
  };
  var Mp4OutputFormat = class extends IsobmffOutputFormat2 {
    /** @internal */
    get _name() {
      return "MP4";
    }
    get fileExtension() {
      return ".mp4";
    }
    getSupportedCodecs() {
      return [
        ...VIDEO_CODECS,
        ...NON_PCM_AUDIO_CODECS,
        ...SUBTITLE_CODECS
      ];
    }
    /** @internal */
    _codecUnsupportedHint(codec) {
      if (new MovOutputFormat().getSupportedCodecs().includes(codec)) {
        return " Switching to MOV will grant support for this codec.";
      }
      return "";
    }
  };
  var MovOutputFormat = class extends IsobmffOutputFormat2 {
    /** @internal */
    get _name() {
      return "MOV";
    }
    get fileExtension() {
      return ".mov";
    }
    getSupportedCodecs() {
      return [
        ...VIDEO_CODECS,
        ...AUDIO_CODECS
      ];
    }
    /** @internal */
    _codecUnsupportedHint(codec) {
      if (new Mp4OutputFormat().getSupportedCodecs().includes(codec)) {
        return " Switching to MP4 will grant support for this codec.";
      }
      return "";
    }
  };
  var MkvOutputFormat2 = class extends OutputFormat {
    constructor(options = {}) {
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (options.streamable !== void 0 && typeof options.streamable !== "boolean") {
        throw new TypeError("options.streamable, when provided, must be a boolean.");
      }
      super();
      this._options = options;
    }
    /** @internal */
    _createMuxer(output) {
      return new MatroskaMuxer(output, this);
    }
    /** @internal */
    get _name() {
      return "Matroska";
    }
    getSupportedTrackCounts() {
      return {
        video: { min: 0, max: Infinity },
        audio: { min: 0, max: Infinity },
        subtitle: { min: 0, max: Infinity },
        total: { min: 1, max: 127 }
      };
    }
    get fileExtension() {
      return ".mkv";
    }
    getSupportedCodecs() {
      return [
        ...VIDEO_CODECS,
        ...NON_PCM_AUDIO_CODECS,
        ...PCM_AUDIO_CODECS.filter((codec) => !["pcm-s8", "pcm-f32be", "ulaw", "alaw"].includes(codec)),
        ...SUBTITLE_CODECS
      ];
    }
    get supportsVideoRotationMetadata() {
      return false;
    }
  };
  var WebMOutputFormat = class extends MkvOutputFormat2 {
    getSupportedCodecs() {
      return [
        ...VIDEO_CODECS.filter((codec) => ["vp8", "vp9", "av1"].includes(codec)),
        ...AUDIO_CODECS.filter((codec) => ["opus", "vorbis"].includes(codec)),
        ...SUBTITLE_CODECS
      ];
    }
    /** @internal */
    get _name() {
      return "WebM";
    }
    get fileExtension() {
      return ".webm";
    }
    /** @internal */
    _codecUnsupportedHint(codec) {
      if (new MkvOutputFormat2().getSupportedCodecs().includes(codec)) {
        return " Switching to MKV will grant support for this codec.";
      }
      return "";
    }
  };
  var Mp3OutputFormat = class extends OutputFormat {
    /** @internal */
    _createMuxer(output) {
      return new Mp3Muxer(output);
    }
    /** @internal */
    get _name() {
      return "MP3";
    }
    getSupportedTrackCounts() {
      return {
        video: { min: 0, max: 0 },
        audio: { min: 1, max: 1 },
        subtitle: { min: 0, max: 0 },
        total: { min: 1, max: 1 }
      };
    }
    get fileExtension() {
      return ".mp3";
    }
    getSupportedCodecs() {
      return ["mp3"];
    }
    get supportsVideoRotationMetadata() {
      return false;
    }
  };
  var WaveOutputFormat = class extends OutputFormat {
    /** @internal */
    _createMuxer(output) {
      return new WaveMuxer(output);
    }
    /** @internal */
    get _name() {
      return "WAVE";
    }
    getSupportedTrackCounts() {
      return {
        video: { min: 0, max: 0 },
        audio: { min: 1, max: 1 },
        subtitle: { min: 0, max: 0 },
        total: { min: 1, max: 1 }
      };
    }
    get fileExtension() {
      return ".wav";
    }
    getSupportedCodecs() {
      return [
        ...PCM_AUDIO_CODECS.filter(
          (codec) => ["pcm-s16", "pcm-s24", "pcm-s32", "pcm-f32", "pcm-u8", "ulaw", "alaw"].includes(codec)
        )
      ];
    }
    get supportsVideoRotationMetadata() {
      return false;
    }
  };
  var OggOutputFormat = class extends OutputFormat {
    /** @internal */
    _createMuxer(output) {
      return new OggMuxer(output);
    }
    /** @internal */
    get _name() {
      return "Ogg";
    }
    getSupportedTrackCounts() {
      return {
        video: { min: 0, max: 0 },
        audio: { min: 0, max: Infinity },
        subtitle: { min: 0, max: 0 },
        total: { min: 1, max: 2 ** 32 }
      };
    }
    get fileExtension() {
      return ".ogg";
    }
    getSupportedCodecs() {
      return [
        ...AUDIO_CODECS.filter((codec) => ["vorbis", "opus"].includes(codec))
      ];
    }
    get supportsVideoRotationMetadata() {
      return false;
    }
  };

  // src/media-source.ts
  var MediaSource = class {
    constructor() {
      /** @internal */
      this._connectedTrack = null;
      /** @internal */
      this._closingPromise = null;
      /** @internal */
      this._closed = false;
      /** @internal */
      this._offsetTimestamps = false;
    }
    /** @internal */
    _ensureValidAdd() {
      if (!this._connectedTrack) {
        throw new Error("Source is not connected to an output track.");
      }
      if (this._connectedTrack.output.state === "canceled") {
        throw new Error("Output has been canceled.");
      }
      if (this._connectedTrack.output.state === "finalizing" || this._connectedTrack.output.state === "finalized") {
        throw new Error("Output has been finalized.");
      }
      if (this._connectedTrack.output.state === "pending") {
        throw new Error("Output has not started.");
      }
      if (this._closed) {
        throw new Error("Source is closed.");
      }
    }
    /** @internal */
    _start() {
    }
    /** @internal */
    async _flush() {
    }
    /**
     * Closes this source. This prevents future samples from being added and signals to the output file that no further
     * samples will come in for this track. Calling `.close()` is optional but recommended after adding the
     * last sample - for improved performance and reduced memory usage.
     */
    close() {
      if (this._closingPromise) {
        throw new Error("Source already closed.");
      }
      const connectedTrack = this._connectedTrack;
      if (!connectedTrack) {
        throw new Error("Cannot call close without connecting the source to an output track.");
      }
      if (connectedTrack.output.state === "pending") {
        throw new Error("Cannot call close before output has been started.");
      }
      return this._closingPromise = (async () => {
        await this._flush();
        this._closed = true;
        if (connectedTrack.output.state === "finalizing" || connectedTrack.output.state === "finalized") {
          return;
        }
        connectedTrack.output._muxer.onTrackClose(connectedTrack);
      })();
    }
    /** @internal */
    async _flushOrWaitForClose() {
      if (this._closingPromise) {
        return this._closingPromise;
      } else {
        return this._flush();
      }
    }
  };
  var VideoSource = class extends MediaSource {
    constructor(codec) {
      super();
      /** @internal */
      this._connectedTrack = null;
      if (!VIDEO_CODECS.includes(codec)) {
        throw new TypeError(`Invalid video codec '${codec}'. Must be one of: ${VIDEO_CODECS.join(", ")}.`);
      }
      this._codec = codec;
    }
  };
  var EncodedVideoPacketSource = class extends VideoSource {
    constructor(codec) {
      super(codec);
    }
    /**
     * Adds an encoded packet to the output video track.
     *
     * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
     * decoder config.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(packet, meta) {
      if (!(packet instanceof EncodedPacket)) {
        throw new TypeError("packet must be an EncodedPacket.");
      }
      if (packet.isMetadataOnly) {
        throw new TypeError("Metadata-only packets cannot be added.");
      }
      this._ensureValidAdd();
      return this._connectedTrack.output._muxer.addEncodedVideoPacket(this._connectedTrack, packet, meta);
    }
  };
  var validateVideoEncodingConfig = (config) => {
    if (!config || typeof config !== "object") {
      throw new TypeError("Encoding config must be an object.");
    }
    if (!VIDEO_CODECS.includes(config.codec)) {
      throw new TypeError(`Invalid video codec '${config.codec}'. Must be one of: ${VIDEO_CODECS.join(", ")}.`);
    }
    if (!(config.bitrate instanceof Quality) && (!Number.isInteger(config.bitrate) || config.bitrate <= 0)) {
      throw new TypeError("config.bitrate must be a positive integer or a quality.");
    }
    if (config.latencyMode !== void 0 && !["quality", "realtime"].includes(config.latencyMode)) {
      throw new TypeError("config.latencyMode, when provided, must be 'quality' or 'realtime'.");
    }
    if (config.keyFrameInterval !== void 0 && (!Number.isFinite(config.keyFrameInterval) || config.keyFrameInterval < 0)) {
      throw new TypeError("config.keyFrameInterval, when provided, must be a non-negative number.");
    }
    if (config.onEncodedPacket !== void 0 && typeof config.onEncodedPacket !== "function") {
      throw new TypeError("config.onEncodedChunk, when provided, must be a function.");
    }
    if (config.onEncodingError !== void 0 && typeof config.onEncodingError !== "function") {
      throw new TypeError("config.onEncodingError, when provided, must be a function.");
    }
  };
  var VideoEncoderWrapper = class {
    constructor(source, encodingConfig) {
      this.source = source;
      this.encodingConfig = encodingConfig;
      this.ensureEncoderPromise = null;
      this.encoderInitialized = false;
      this.encoder = null;
      this.muxer = null;
      this.lastMultipleOfKeyFrameInterval = -1;
      this.lastWidth = null;
      this.lastHeight = null;
      this.customEncoder = null;
      this.lastCustomEncoderPromise = Promise.resolve();
      this.customEncoderQueueSize = 0;
    }
    async add(videoSample, shouldClose, encodeOptions) {
      this.source._ensureValidAdd();
      if (this.lastWidth !== null && this.lastHeight !== null) {
        if (videoSample.codedWidth !== this.lastWidth || videoSample.codedHeight !== this.lastHeight) {
          throw new Error(
            `Video sample size must remain constant. Expected ${this.lastWidth}x${this.lastHeight}, got ${videoSample.codedWidth}x${videoSample.codedHeight}.`
          );
        }
      } else {
        this.lastWidth = videoSample.codedWidth;
        this.lastHeight = videoSample.codedHeight;
      }
      if (!this.encoderInitialized) {
        if (this.ensureEncoderPromise) {
          await this.ensureEncoderPromise;
        } else {
          await this.ensureEncoder(videoSample);
        }
      }
      assert(this.encoderInitialized);
      const keyFrameInterval = this.encodingConfig.keyFrameInterval ?? 5;
      const multipleOfKeyFrameInterval = Math.floor(videoSample.timestamp / keyFrameInterval);
      const finalEncodeOptions = {
        ...encodeOptions,
        keyFrame: encodeOptions?.keyFrame || keyFrameInterval === 0 || multipleOfKeyFrameInterval !== this.lastMultipleOfKeyFrameInterval
      };
      this.lastMultipleOfKeyFrameInterval = multipleOfKeyFrameInterval;
      if (this.customEncoder) {
        this.customEncoderQueueSize++;
        this.lastCustomEncoderPromise = this.lastCustomEncoderPromise.then(() => {
          return this.customEncoder.encode(videoSample, finalEncodeOptions);
        });
        void this.lastCustomEncoderPromise.then(() => {
          this.customEncoderQueueSize--;
          if (shouldClose) {
            videoSample.close();
          }
        });
        if (this.customEncoderQueueSize >= 4) {
          await this.lastCustomEncoderPromise;
        }
      } else {
        assert(this.encoder);
        const videoFrame = videoSample.toVideoFrame();
        this.encoder.encode(videoFrame, finalEncodeOptions);
        videoFrame.close();
        if (shouldClose) {
          videoSample.close();
        }
        if (this.encoder.encodeQueueSize >= 4) {
          await new Promise((resolve) => this.encoder.addEventListener("dequeue", resolve, { once: true }));
        }
      }
      await this.muxer.mutex.currentPromise;
    }
    async ensureEncoder(videoSample) {
      if (this.encoder) {
        return;
      }
      const { promise, resolve } = promiseWithResolvers();
      this.ensureEncoderPromise = promise;
      const width = videoSample.codedWidth;
      const height = videoSample.codedHeight;
      const bitrate = this.encodingConfig.bitrate instanceof Quality ? this.encodingConfig.bitrate._toVideoBitrate(this.encodingConfig.codec, width, height) : this.encodingConfig.bitrate;
      const encoderConfig = {
        codec: buildVideoCodecString(
          this.encodingConfig.codec,
          width,
          height,
          bitrate
        ),
        width,
        height,
        bitrate,
        framerate: this.source._connectedTrack?.metadata.frameRate,
        latencyMode: this.encodingConfig.latencyMode,
        ...getVideoEncoderConfigExtension(this.encodingConfig.codec)
      };
      const MatchingCustomEncoder = customVideoEncoders.find((x) => x.supports(
        this.encodingConfig.codec,
        encoderConfig
      ));
      if (MatchingCustomEncoder) {
        this.customEncoder = new MatchingCustomEncoder();
        this.customEncoder.codec = this.encodingConfig.codec;
        this.customEncoder.config = encoderConfig;
        this.customEncoder.onPacket = (packet, meta) => {
          this.encodingConfig.onEncodedPacket?.(packet, meta);
          void this.muxer.addEncodedVideoPacket(this.source._connectedTrack, packet, meta);
        };
        this.customEncoder.init();
      } else {
        if (typeof VideoEncoder === "undefined") {
          throw new Error("VideoEncoder is not supported by this browser.");
        }
        const support = await VideoEncoder.isConfigSupported(encoderConfig);
        if (!support.supported) {
          throw new Error(
            "This specific encoder configuration is not supported by this browser. Consider using another codec or changing your video parameters."
          );
        }
        this.encoder = new VideoEncoder({
          output: (chunk, meta) => {
            const packet = EncodedPacket.fromEncodedChunk(chunk);
            this.encodingConfig.onEncodedPacket?.(packet, meta);
            void this.muxer.addEncodedVideoPacket(this.source._connectedTrack, packet, meta);
          },
          error: this.encodingConfig.onEncodingError ?? ((error) => console.error("VideoEncoder error:", error))
        });
        this.encoder.configure(encoderConfig);
      }
      assert(this.source._connectedTrack);
      this.muxer = this.source._connectedTrack.output._muxer;
      this.encoderInitialized = true;
      resolve();
    }
    async flush() {
      if (this.customEncoder) {
        await this.lastCustomEncoderPromise.then(() => this.customEncoder.flush());
      } else if (this.encoder) {
        await this.encoder.flush();
        this.encoder.close();
      }
    }
    getQueueSize() {
      if (this.customEncoder) {
        return this.customEncoderQueueSize;
      } else {
        assert(this.encoder);
        return this.encoder.encodeQueueSize;
      }
    }
  };
  var VideoSampleSource = class extends VideoSource {
    constructor(encodingConfig) {
      validateVideoEncodingConfig(encodingConfig);
      super(encodingConfig.codec);
      this._encoder = new VideoEncoderWrapper(this, encodingConfig);
    }
    /**
     * Encodes a video sample (frame) and then adds it to the output.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(videoSample, encodeOptions) {
      if (!(videoSample instanceof VideoSample)) {
        throw new TypeError("videoSample must be a VideoSample.");
      }
      return this._encoder.add(videoSample, false, encodeOptions);
    }
    /** @internal */
    _flush() {
      return this._encoder.flush();
    }
  };
  var CanvasSource = class extends VideoSource {
    constructor(canvas, encodingConfig) {
      if (!(typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) && !(typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas)) {
        throw new TypeError("canvas must be an HTMLCanvasElement or OffscreenCanvas.");
      }
      validateVideoEncodingConfig(encodingConfig);
      super(encodingConfig.codec);
      this._encoder = new VideoEncoderWrapper(this, encodingConfig);
      this._canvas = canvas;
    }
    /**
     * Captures the current canvas state as a video sample (frame), encodes it and adds it to the output.
     *
     * @param timestamp - The timestamp of the sample, in seconds.
     * @param duration - The duration of the sample, in seconds.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(timestamp, duration = 0, encodeOptions) {
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new TypeError("timestamp must be a non-negative number.");
      }
      if (!Number.isFinite(duration) || duration < 0) {
        throw new TypeError("duration must be a non-negative number.");
      }
      const sample = new VideoSample(this._canvas, { timestamp, duration });
      return this._encoder.add(sample, true, encodeOptions);
    }
    /** @internal */
    _flush() {
      return this._encoder.flush();
    }
  };
  var MediaStreamVideoTrackSource = class extends VideoSource {
    constructor(track, encodingConfig) {
      if (!(track instanceof MediaStreamTrack) || track.kind !== "video") {
        throw new TypeError("track must be a video MediaStreamTrack.");
      }
      validateVideoEncodingConfig(encodingConfig);
      encodingConfig = {
        ...encodingConfig,
        latencyMode: "realtime"
      };
      super(encodingConfig.codec);
      /** @internal */
      this._abortController = null;
      /** @internal */
      this._offsetTimestamps = true;
      this._encoder = new VideoEncoderWrapper(this, encodingConfig);
      this._track = track;
    }
    /** @internal */
    _start() {
      this._abortController = new AbortController();
      const processor = new MediaStreamTrackProcessor({ track: this._track });
      const consumer = new WritableStream({
        write: (videoFrame) => {
          if (this._encoder.getQueueSize() >= 4) {
            videoFrame.close();
            return;
          }
          void this._encoder.add(new VideoSample(videoFrame), true);
        }
      });
      processor.readable.pipeTo(consumer, {
        signal: this._abortController.signal
      }).catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Pipe error:", err);
      });
    }
    /** @internal */
    async _flush() {
      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
      await this._encoder.flush();
    }
  };
  var AudioSource = class extends MediaSource {
    constructor(codec) {
      super();
      /** @internal */
      this._connectedTrack = null;
      if (!AUDIO_CODECS.includes(codec)) {
        throw new TypeError(`Invalid audio codec '${codec}'. Must be one of: ${AUDIO_CODECS.join(", ")}.`);
      }
      this._codec = codec;
    }
  };
  var EncodedAudioPacketSource = class extends AudioSource {
    constructor(codec) {
      super(codec);
    }
    /**
     * Adds an encoded packet to the output audio track.
     *
     * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
     * decoder config.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(packet, meta) {
      if (!(packet instanceof EncodedPacket)) {
        throw new TypeError("packet must be an EncodedPacket.");
      }
      if (packet.isMetadataOnly) {
        throw new TypeError("Metadata-only packets cannot be added.");
      }
      this._ensureValidAdd();
      return this._connectedTrack.output._muxer.addEncodedAudioPacket(this._connectedTrack, packet, meta);
    }
  };
  var validateAudioEncodingConfig = (config) => {
    if (!config || typeof config !== "object") {
      throw new TypeError("Encoding config must be an object.");
    }
    if (!AUDIO_CODECS.includes(config.codec)) {
      throw new TypeError(`Invalid audio codec '${config.codec}'. Must be one of: ${AUDIO_CODECS.join(", ")}.`);
    }
    if (config.bitrate === void 0 && (!PCM_AUDIO_CODECS.includes(config.codec) || config.codec === "flac")) {
      throw new TypeError("config.bitrate must be provided for compressed audio codecs.");
    }
    if (config.bitrate !== void 0 && !(config.bitrate instanceof Quality) && (!Number.isInteger(config.bitrate) || config.bitrate <= 0)) {
      throw new TypeError("config.bitrate, when provided, must be a positive integer or a quality.");
    }
    if (config.onEncodingError !== void 0 && typeof config.onEncodingError !== "function") {
      throw new TypeError("config.onEncodingError, when provided, must be a function.");
    }
  };
  var AudioEncoderWrapper = class {
    constructor(source, encodingConfig) {
      this.source = source;
      this.encodingConfig = encodingConfig;
      this.ensureEncoderPromise = null;
      this.encoderInitialized = false;
      this.encoder = null;
      this.muxer = null;
      this.lastNumberOfChannels = null;
      this.lastSampleRate = null;
      this.isPcmEncoder = false;
      this.outputSampleSize = null;
      this.writeOutputValue = null;
      this.customEncoder = null;
      this.lastCustomEncoderPromise = Promise.resolve();
      this.customEncoderQueueSize = 0;
    }
    async add(audioSample, shouldClose) {
      this.source._ensureValidAdd();
      if (this.lastNumberOfChannels !== null && this.lastSampleRate !== null) {
        if (audioSample.numberOfChannels !== this.lastNumberOfChannels || audioSample.sampleRate !== this.lastSampleRate) {
          throw new Error(
            `Audio parameters must remain constant. Expected ${this.lastNumberOfChannels} channels at ${this.lastSampleRate} Hz, got ${audioSample.numberOfChannels} channels at ${audioSample.sampleRate} Hz.`
          );
        }
      } else {
        this.lastNumberOfChannels = audioSample.numberOfChannels;
        this.lastSampleRate = audioSample.sampleRate;
      }
      if (!this.encoderInitialized) {
        if (this.ensureEncoderPromise) {
          await this.ensureEncoderPromise;
        } else {
          await this.ensureEncoder(audioSample);
        }
      }
      assert(this.encoderInitialized);
      if (this.customEncoder) {
        this.customEncoderQueueSize++;
        this.lastCustomEncoderPromise = this.lastCustomEncoderPromise.then(() => {
          return this.customEncoder.encode(audioSample);
        });
        void this.lastCustomEncoderPromise.then(() => {
          this.customEncoderQueueSize--;
          if (shouldClose) {
            audioSample.close();
          }
        });
        if (this.customEncoderQueueSize >= 4) {
          await this.lastCustomEncoderPromise;
        }
        await this.muxer.mutex.currentPromise;
      } else if (this.isPcmEncoder) {
        await this.doPcmEncoding(audioSample, shouldClose);
      } else {
        assert(this.encoder);
        const audioData = audioSample.toAudioData();
        this.encoder.encode(audioData);
        audioData.close();
        if (shouldClose) {
          audioSample.close();
        }
        if (this.encoder.encodeQueueSize >= 4) {
          await new Promise((resolve) => this.encoder.addEventListener("dequeue", resolve, { once: true }));
        }
        await this.muxer.mutex.currentPromise;
      }
    }
    async doPcmEncoding(audioSample, shouldClose) {
      assert(this.outputSampleSize);
      assert(this.writeOutputValue);
      const { numberOfChannels, numberOfFrames, sampleRate, timestamp } = audioSample;
      const CHUNK_SIZE = 2048;
      const outputs = [];
      for (let frame = 0; frame < numberOfFrames; frame += CHUNK_SIZE) {
        const frameCount = Math.min(CHUNK_SIZE, audioSample.numberOfFrames - frame);
        const outputSize = frameCount * numberOfChannels * this.outputSampleSize;
        const outputBuffer = new ArrayBuffer(outputSize);
        const outputView = new DataView(outputBuffer);
        outputs.push({ frameCount, view: outputView });
      }
      const allocationSize = audioSample.allocationSize({ planeIndex: 0, format: "f32-planar" });
      const floats = new Float32Array(allocationSize / Float32Array.BYTES_PER_ELEMENT);
      for (let i = 0; i < numberOfChannels; i++) {
        audioSample.copyTo(floats, { planeIndex: i, format: "f32-planar" });
        for (let j = 0; j < outputs.length; j++) {
          const { frameCount, view: view2 } = outputs[j];
          for (let k = 0; k < frameCount; k++) {
            this.writeOutputValue(
              view2,
              (k * numberOfChannels + i) * this.outputSampleSize,
              floats[j * CHUNK_SIZE + k]
            );
          }
        }
      }
      if (shouldClose) {
        audioSample.close();
      }
      const meta = {
        decoderConfig: {
          codec: this.encodingConfig.codec,
          numberOfChannels,
          sampleRate
        }
      };
      for (let i = 0; i < outputs.length; i++) {
        const { frameCount, view: view2 } = outputs[i];
        const outputBuffer = view2.buffer;
        const startFrame = i * CHUNK_SIZE;
        const packet = new EncodedPacket(
          new Uint8Array(outputBuffer),
          "key",
          timestamp + startFrame / sampleRate,
          frameCount / sampleRate
        );
        this.encodingConfig.onEncodedPacket?.(packet, meta);
        await this.muxer.addEncodedAudioPacket(this.source._connectedTrack, packet, meta);
      }
    }
    async ensureEncoder(audioSample) {
      if (this.encoderInitialized) {
        return;
      }
      const { promise, resolve } = promiseWithResolvers();
      this.ensureEncoderPromise = promise;
      const { numberOfChannels, sampleRate } = audioSample;
      const bitrate = this.encodingConfig.bitrate instanceof Quality ? this.encodingConfig.bitrate._toAudioBitrate(this.encodingConfig.codec) : this.encodingConfig.bitrate;
      const encoderConfig = {
        codec: buildAudioCodecString(
          this.encodingConfig.codec,
          numberOfChannels,
          sampleRate
        ),
        numberOfChannels,
        sampleRate,
        bitrate,
        ...getAudioEncoderConfigExtension(this.encodingConfig.codec)
      };
      const MatchingCustomEncoder = customAudioEncoders.find((x) => x.supports(
        this.encodingConfig.codec,
        encoderConfig
      ));
      if (MatchingCustomEncoder) {
        this.customEncoder = new MatchingCustomEncoder();
        this.customEncoder.codec = this.encodingConfig.codec;
        this.customEncoder.config = encoderConfig;
        this.customEncoder.onPacket = (packet, meta) => {
          this.encodingConfig.onEncodedPacket?.(packet, meta);
          void this.muxer.addEncodedAudioPacket(this.source._connectedTrack, packet, meta);
        };
        this.customEncoder.init();
      } else if (PCM_AUDIO_CODECS.includes(this.encodingConfig.codec)) {
        this.initPcmEncoder();
      } else {
        if (typeof AudioEncoder === "undefined") {
          throw new Error("AudioEncoder is not supported by this browser.");
        }
        const support = await AudioEncoder.isConfigSupported(encoderConfig);
        if (!support.supported) {
          throw new Error(
            "This specific encoder configuration not supported by this browser. Consider using another codec or changing your audio parameters."
          );
        }
        this.encoder = new AudioEncoder({
          output: (chunk, meta) => {
            const packet = EncodedPacket.fromEncodedChunk(chunk);
            this.encodingConfig.onEncodedPacket?.(packet, meta);
            void this.muxer.addEncodedAudioPacket(this.source._connectedTrack, packet, meta);
          },
          error: this.encodingConfig.onEncodingError ?? ((error) => console.error("AudioEncoder error:", error))
        });
        this.encoder.configure(encoderConfig);
      }
      assert(this.source._connectedTrack);
      this.muxer = this.source._connectedTrack.output._muxer;
      this.encoderInitialized = true;
      resolve();
    }
    initPcmEncoder() {
      this.isPcmEncoder = true;
      const codec = this.encodingConfig.codec;
      const { dataType, sampleSize, littleEndian } = parsePcmCodec(codec);
      this.outputSampleSize = sampleSize;
      switch (sampleSize) {
        case 1:
          {
            if (dataType === "unsigned") {
              this.writeOutputValue = (view2, byteOffset, value) => view2.setUint8(byteOffset, clamp((value + 1) * 127.5, 0, 255));
            } else if (dataType === "signed") {
              this.writeOutputValue = (view2, byteOffset, value) => {
                view2.setInt8(byteOffset, clamp(Math.round(value * 128), -128, 127));
              };
            } else if (dataType === "ulaw") {
              this.writeOutputValue = (view2, byteOffset, value) => {
                const int16 = clamp(Math.floor(value * 32767), -32768, 32767);
                view2.setUint8(byteOffset, toUlaw(int16));
              };
            } else if (dataType === "alaw") {
              this.writeOutputValue = (view2, byteOffset, value) => {
                const int16 = clamp(Math.floor(value * 32767), -32768, 32767);
                view2.setUint8(byteOffset, toAlaw(int16));
              };
            } else {
              assert(false);
            }
          }
          ;
          break;
        case 2:
          {
            if (dataType === "unsigned") {
              this.writeOutputValue = (view2, byteOffset, value) => view2.setUint16(byteOffset, clamp((value + 1) * 32767.5, 0, 65535), littleEndian);
            } else if (dataType === "signed") {
              this.writeOutputValue = (view2, byteOffset, value) => view2.setInt16(byteOffset, clamp(Math.round(value * 32767), -32768, 32767), littleEndian);
            } else {
              assert(false);
            }
          }
          ;
          break;
        case 3:
          {
            if (dataType === "unsigned") {
              this.writeOutputValue = (view2, byteOffset, value) => setUint24(view2, byteOffset, clamp((value + 1) * 83886075e-1, 0, 16777215), littleEndian);
            } else if (dataType === "signed") {
              this.writeOutputValue = (view2, byteOffset, value) => setInt24(
                view2,
                byteOffset,
                clamp(Math.round(value * 8388607), -8388608, 8388607),
                littleEndian
              );
            } else {
              assert(false);
            }
          }
          ;
          break;
        case 4: {
          if (dataType === "unsigned") {
            this.writeOutputValue = (view2, byteOffset, value) => view2.setUint32(byteOffset, clamp((value + 1) * 21474836475e-1, 0, 4294967295), littleEndian);
          } else if (dataType === "signed") {
            this.writeOutputValue = (view2, byteOffset, value) => view2.setInt32(
              byteOffset,
              clamp(Math.round(value * 2147483647), -2147483648, 2147483647),
              littleEndian
            );
          } else if (dataType === "float") {
            this.writeOutputValue = (view2, byteOffset, value) => view2.setFloat32(byteOffset, value, littleEndian);
          } else {
            assert(false);
          }
        }
      }
    }
    async flush() {
      if (this.customEncoder) {
        await this.lastCustomEncoderPromise.then(() => this.customEncoder.flush());
      } else if (this.encoder) {
        await this.encoder.flush();
        this.encoder.close();
      }
    }
    getQueueSize() {
      if (this.customEncoder) {
        return this.customEncoderQueueSize;
      } else if (this.isPcmEncoder) {
        return 0;
      } else {
        assert(this.encoder);
        return this.encoder.encodeQueueSize;
      }
    }
  };
  var AudioSampleSource = class extends AudioSource {
    constructor(encodingConfig) {
      validateAudioEncodingConfig(encodingConfig);
      super(encodingConfig.codec);
      this._encoder = new AudioEncoderWrapper(this, encodingConfig);
    }
    /**
     * Encodes an audio sample and then adds it to the output.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(audioSample) {
      if (!(audioSample instanceof AudioSample)) {
        throw new TypeError("audioSample must be an AudioSample.");
      }
      return this._encoder.add(audioSample, false);
    }
    /** @internal */
    _flush() {
      return this._encoder.flush();
    }
  };
  var AudioBufferSource = class extends AudioSource {
    constructor(encodingConfig) {
      validateAudioEncodingConfig(encodingConfig);
      super(encodingConfig.codec);
      /** @internal */
      this._accumulatedFrameCount = 0;
      this._encoder = new AudioEncoderWrapper(this, encodingConfig);
    }
    /**
     * Converts an AudioBuffer to audio samples, encodes them and adds them to the output. The first AudioBuffer will
     * be played at timestamp 0, and any subsequent AudioBuffer will have a timestamp equal to the total duration of
     * all previous AudioBuffers.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(audioBuffer) {
      if (!(audioBuffer instanceof AudioBuffer)) {
        throw new TypeError("audioBuffer must be an AudioBuffer.");
      }
      const MAX_FLOAT_COUNT = 64 * 1024 * 1024;
      const numberOfChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const totalFrames = audioBuffer.length;
      const maxFramesPerChunk = Math.floor(MAX_FLOAT_COUNT / numberOfChannels);
      let currentRelativeFrame = 0;
      let remainingFrames = totalFrames;
      const promises = [];
      while (remainingFrames > 0) {
        const framesToCopy = Math.min(maxFramesPerChunk, remainingFrames);
        const chunkData = new Float32Array(numberOfChannels * framesToCopy);
        for (let channel = 0; channel < numberOfChannels; channel++) {
          audioBuffer.copyFromChannel(
            chunkData.subarray(channel * framesToCopy, channel * framesToCopy + framesToCopy),
            channel,
            currentRelativeFrame
          );
        }
        const audioSample = new AudioSample({
          format: "f32-planar",
          sampleRate,
          numberOfFrames: framesToCopy,
          numberOfChannels,
          timestamp: (this._accumulatedFrameCount + currentRelativeFrame) / sampleRate,
          data: chunkData
        });
        promises.push(this._encoder.add(audioSample, true));
        currentRelativeFrame += framesToCopy;
        remainingFrames -= framesToCopy;
      }
      this._accumulatedFrameCount += totalFrames;
      return Promise.all(promises);
    }
    /** @internal */
    _flush() {
      return this._encoder.flush();
    }
  };
  var MediaStreamAudioTrackSource = class extends AudioSource {
    constructor(track, encodingConfig) {
      if (!(track instanceof MediaStreamTrack) || track.kind !== "audio") {
        throw new TypeError("track must be an audio MediaStreamTrack.");
      }
      validateAudioEncodingConfig(encodingConfig);
      super(encodingConfig.codec);
      /** @internal */
      this._abortController = null;
      /** @internal */
      this._offsetTimestamps = true;
      this._encoder = new AudioEncoderWrapper(this, encodingConfig);
      this._track = track;
    }
    /** @internal */
    _start() {
      this._abortController = new AbortController();
      const processor = new MediaStreamTrackProcessor({ track: this._track });
      const consumer = new WritableStream({
        write: (audioData) => {
          if (this._encoder.getQueueSize() >= 4) {
            audioData.close();
            return;
          }
          void this._encoder.add(new AudioSample(audioData), true);
        }
      });
      processor.readable.pipeTo(consumer, {
        signal: this._abortController.signal
      }).catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Pipe error:", err);
      });
    }
    /** @internal */
    async _flush() {
      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
      await this._encoder.flush();
    }
  };
  var SubtitleSource = class extends MediaSource {
    constructor(codec) {
      super();
      /** @internal */
      this._connectedTrack = null;
      if (!SUBTITLE_CODECS.includes(codec)) {
        throw new TypeError(`Invalid subtitle codec '${codec}'. Must be one of: ${SUBTITLE_CODECS.join(", ")}.`);
      }
      this._codec = codec;
    }
  };
  var TextSubtitleSource = class extends SubtitleSource {
    constructor(codec) {
      super(codec);
      this._parser = new SubtitleParser({
        codec,
        output: (cue, metadata) => this._connectedTrack?.output._muxer.addSubtitleCue(this._connectedTrack, cue, metadata)
      });
    }
    /**
     * Parses the subtitle text according to the specified codec and adds it to the output track. You don't have to
     * add the entire subtitle file at once here; you can provide it in chunks.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(text) {
      if (typeof text !== "string") {
        throw new TypeError("text must be a string.");
      }
      this._ensureValidAdd();
      this._parser.parse(text);
      return this._connectedTrack.output._muxer.mutex.currentPromise;
    }
  };

  // src/output.ts
  var ALL_TRACK_TYPES = ["video", "audio", "subtitle"];
  var validateBaseTrackMetadata = (metadata) => {
    if (!metadata || typeof metadata !== "object") {
      throw new TypeError("metadata must be an object.");
    }
    if (metadata.languageCode !== void 0 && !isIso639Dash2LanguageCode(metadata.languageCode)) {
      throw new TypeError("metadata.languageCode must be a three-letter, ISO 639-2 language code.");
    }
  };
  var Output = class {
    constructor(options) {
      /** The current state of the output. */
      this.state = "pending";
      /** @internal */
      this._tracks = [];
      /** @internal */
      this._startPromise = null;
      /** @internal */
      this._cancelPromise = null;
      /** @internal */
      this._finalizePromise = null;
      /** @internal */
      this._mutex = new AsyncMutex();
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (!(options.format instanceof OutputFormat)) {
        throw new TypeError("options.format must be an OutputFormat.");
      }
      if (!(options.target instanceof Target)) {
        throw new TypeError("options.target must be a Target.");
      }
      if (options.target._output) {
        throw new Error("Target is already used for another output.");
      }
      options.target._output = this;
      this.format = options.format;
      this.target = options.target;
      this._writer = options.target._createWriter();
      this._muxer = options.format._createMuxer(this);
    }
    /** Adds a video track to the output with the given source. Must be called before output is started. */
    addVideoTrack(source, metadata = {}) {
      if (!(source instanceof VideoSource)) {
        throw new TypeError("source must be a VideoSource.");
      }
      validateBaseTrackMetadata(metadata);
      if (metadata.rotation !== void 0 && ![0, 90, 180, 270].includes(metadata.rotation)) {
        throw new TypeError(`Invalid video rotation: ${metadata.rotation}. Has to be 0, 90, 180 or 270.`);
      }
      if (!this.format.supportsVideoRotationMetadata && metadata.rotation) {
        throw new Error(`${this.format._name} does not support video rotation metadata.`);
      }
      if (metadata.frameRate !== void 0 && (!Number.isInteger(metadata.frameRate) || metadata.frameRate <= 0)) {
        throw new TypeError(
          `Invalid video frame rate: ${metadata.frameRate}. Must be a positive integer.`
        );
      }
      this._addTrack("video", source, metadata);
    }
    /** Adds an audio track to the output with the given source. Must be called before output is started. */
    addAudioTrack(source, metadata = {}) {
      if (!(source instanceof AudioSource)) {
        throw new TypeError("source must be an AudioSource.");
      }
      validateBaseTrackMetadata(metadata);
      this._addTrack("audio", source, metadata);
    }
    /** Adds a subtitle track to the output with the given source. Must be called before output is started. */
    addSubtitleTrack(source, metadata = {}) {
      if (!(source instanceof SubtitleSource)) {
        throw new TypeError("source must be a SubtitleSource.");
      }
      validateBaseTrackMetadata(metadata);
      this._addTrack("subtitle", source, metadata);
    }
    /** @internal */
    _addTrack(type, source, metadata) {
      if (this.state !== "pending") {
        throw new Error("Cannot add track after output has been started or canceled.");
      }
      if (source._connectedTrack) {
        throw new Error("Source is already used for a track.");
      }
      const supportedTrackCounts = this.format.getSupportedTrackCounts();
      const presentTracksOfThisType = this._tracks.reduce(
        (count, track2) => count + (track2.type === type ? 1 : 0),
        0
      );
      const maxCount = supportedTrackCounts[type].max;
      if (presentTracksOfThisType === maxCount) {
        throw new Error(
          maxCount === 0 ? `${this.format._name} does not support ${type} tracks.` : `${this.format._name} does not support more than ${maxCount} ${type} track${maxCount === 1 ? "" : "s"}.`
        );
      }
      const maxTotalCount = supportedTrackCounts.total.max;
      if (this._tracks.length === maxTotalCount) {
        throw new Error(
          `${this.format._name} does not support more than ${maxTotalCount} tracks${maxTotalCount === 1 ? "" : "s"} in total.`
        );
      }
      const track = {
        id: this._tracks.length + 1,
        output: this,
        type,
        source,
        metadata
      };
      if (track.type === "video") {
        const supportedVideoCodecs = this.format.getSupportedVideoCodecs();
        if (supportedVideoCodecs.length === 0) {
          throw new Error(
            `${this.format._name} does not support video tracks.` + this.format._codecUnsupportedHint(track.source._codec)
          );
        } else if (!supportedVideoCodecs.includes(track.source._codec)) {
          throw new Error(
            `Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported video codecs are: ${supportedVideoCodecs.map((codec) => `'${codec}'`).join(", ")}.` + this.format._codecUnsupportedHint(track.source._codec)
          );
        }
      } else if (track.type === "audio") {
        const supportedAudioCodecs = this.format.getSupportedAudioCodecs();
        if (supportedAudioCodecs.length === 0) {
          throw new Error(
            `${this.format._name} does not support audio tracks.` + this.format._codecUnsupportedHint(track.source._codec)
          );
        } else if (!supportedAudioCodecs.includes(track.source._codec)) {
          throw new Error(
            `Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported audio codecs are: ${supportedAudioCodecs.map((codec) => `'${codec}'`).join(", ")}.` + this.format._codecUnsupportedHint(track.source._codec)
          );
        }
      } else if (track.type === "subtitle") {
        const supportedSubtitleCodecs = this.format.getSupportedSubtitleCodecs();
        if (supportedSubtitleCodecs.length === 0) {
          throw new Error(
            `${this.format._name} does not support subtitle tracks.` + this.format._codecUnsupportedHint(track.source._codec)
          );
        } else if (!supportedSubtitleCodecs.includes(track.source._codec)) {
          throw new Error(
            `Codec '${track.source._codec}' cannot be contained within ${this.format._name}. Supported subtitle codecs are: ${supportedSubtitleCodecs.map((codec) => `'${codec}'`).join(", ")}.` + this.format._codecUnsupportedHint(track.source._codec)
          );
        }
      }
      this._tracks.push(track);
      source._connectedTrack = track;
    }
    /**
     * Starts the creation of the output file. This method should be called after all tracks have been added. Only after
     * the output has started can media samples be added to the tracks.
     *
     * @returns A promise that resolves when the output has successfully started and is ready to receive media samples.
     */
    async start() {
      const supportedTrackCounts = this.format.getSupportedTrackCounts();
      for (const trackType of ALL_TRACK_TYPES) {
        const presentTracksOfThisType = this._tracks.reduce(
          (count, track) => count + (track.type === trackType ? 1 : 0),
          0
        );
        const minCount = supportedTrackCounts[trackType].min;
        if (presentTracksOfThisType < minCount) {
          throw new Error(
            minCount === supportedTrackCounts[trackType].max ? `${this.format._name} requires exactly ${minCount} ${trackType} track${minCount === 1 ? "" : "s"}.` : `${this.format._name} requires at least ${minCount} ${trackType} track${minCount === 1 ? "" : "s"}.`
          );
        }
      }
      const totalMinCount = supportedTrackCounts.total.min;
      if (this._tracks.length < totalMinCount) {
        throw new Error(
          totalMinCount === supportedTrackCounts.total.max ? `${this.format._name} requires exactly ${totalMinCount} track${totalMinCount === 1 ? "" : "s"}.` : `${this.format._name} requires at least ${totalMinCount} track${totalMinCount === 1 ? "" : "s"}.`
        );
      }
      if (this.state === "canceled") {
        throw new Error("Output has been canceled.");
      }
      if (this._startPromise) {
        console.warn("Output has already been started.");
        return this._startPromise;
      }
      return this._startPromise = (async () => {
        this.state = "started";
        this._writer.start();
        const release = await this._mutex.acquire();
        await this._muxer.start();
        for (const track of this._tracks) {
          track.source._start();
        }
        release();
      })();
    }
    /**
     * Cancels the creation of the output file, releasing internal resources like encoders and preventing further
     * samples from being added.
     *
     * @returns A promise that resolves once all internal resources have been released.
     */
    async cancel() {
      if (this._cancelPromise) {
        console.warn("Output has already been canceled.");
        return this._cancelPromise;
      } else if (this.state === "finalizing" || this.state === "finalized") {
        console.warn("Output has already been finalized.");
        return;
      }
      return this._cancelPromise = (async () => {
        this.state = "canceled";
        const release = await this._mutex.acquire();
        const promises = this._tracks.map((x) => x.source._flushOrWaitForClose());
        await Promise.all(promises);
        await this._writer.close();
        release();
      })();
    }
    /**
     * Finalizes the output file. This method must be called after all media samples across all tracks have been added.
     * Once the Promise returned by this method completes, the output file is ready.
     */
    async finalize() {
      if (this.state === "pending") {
        throw new Error("Cannot finalize before starting.");
      }
      if (this.state === "canceled") {
        throw new Error("Cannot finalize after canceling.");
      }
      if (this._finalizePromise) {
        console.warn("Output has already been finalized.");
        return this._finalizePromise;
      }
      return this._finalizePromise = (async () => {
        this.state = "finalizing";
        const release = await this._mutex.acquire();
        const promises = this._tracks.map((x) => x.source._flushOrWaitForClose());
        await Promise.all(promises);
        await this._muxer.finalize();
        await this._writer.flush();
        await this._writer.finalize();
        this.state = "finalized";
        release();
      })();
    }
  };

  // src/source.ts
  var Source = class {
    constructor() {
      /** @internal */
      this._sizePromise = null;
      /** Called each time data is requested from the source. */
      this.onread = null;
    }
    /** @internal */
    _getSize() {
      return this._sizePromise ??= this._retrieveSize();
    }
  };
  var BufferSource = class extends Source {
    constructor(buffer) {
      if (!(buffer instanceof ArrayBuffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError("buffer must be an ArrayBuffer or Uint8Array.");
      }
      super();
      this._bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    }
    /** @internal */
    async _read(start, end) {
      return this._bytes.subarray(start, end);
    }
    /** @internal */
    async _retrieveSize() {
      return this._bytes.byteLength;
    }
  };
  var StreamSource = class extends Source {
    constructor(options) {
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (typeof options.read !== "function") {
        throw new TypeError("options.read must be a function.");
      }
      if (typeof options.getSize !== "function") {
        throw new TypeError("options.getSize must be a function.");
      }
      super();
      this._options = options;
    }
    /** @internal */
    async _read(start, end) {
      return this._options.read(start, end);
    }
    /** @internal */
    async _retrieveSize() {
      return this._options.getSize();
    }
  };
  var BlobSource = class extends Source {
    constructor(blob) {
      if (!(blob instanceof Blob)) {
        throw new TypeError("blob must be a Blob.");
      }
      super();
      this._blob = blob;
    }
    /** @internal */
    async _read(start, end) {
      const slice = this._blob.slice(start, end);
      const buffer = await slice.arrayBuffer();
      return new Uint8Array(buffer);
    }
    /** @internal */
    async _retrieveSize() {
      return this._blob.size;
    }
  };
  var UrlSource = class extends Source {
    constructor(url2, options = {}) {
      if (typeof url2 !== "string") {
        throw new TypeError("url must be a string.");
      }
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (options.withCredentials !== void 0 && typeof options.withCredentials !== "boolean") {
        throw new TypeError("options.withCredentials, when specified, must be a boolean.");
      }
      super();
      /** @internal */
      this._fullData = null;
      this._url = url2;
      this._withCredentials = options.withCredentials ?? false;
    }
    /** @internal */
    _makeRequest(range) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", this._url, true);
        xhr.responseType = "arraybuffer";
        xhr.withCredentials = this._withCredentials;
        if (range) {
          xhr.setRequestHeader("Range", `bytes=${range.start}-${range.end - 1}`);
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const buffer = xhr.response;
            if (!range) {
              this._fullData = buffer;
            }
            resolve({
              response: buffer,
              statusCode: xhr.status
            });
          } else {
            reject(new Error(`Error fetching ${this._url}: ${xhr.status} ${xhr.statusText}`));
          }
        };
        xhr.onerror = () => {
          reject(new Error("Network error occurred."));
        };
        xhr.ontimeout = () => {
          reject(new Error("Request timed out."));
        };
        xhr.send();
      });
    }
    /** @internal */
    async _read(start, end) {
      if (this._fullData) {
        return new Uint8Array(this._fullData, start, end - start);
      }
      const { response, statusCode } = await this._makeRequest({ start, end });
      if (statusCode === 200) {
        const fullData = new Uint8Array(response);
        return fullData.subarray(start, end);
      }
      return new Uint8Array(response);
    }
    /** @internal */
    async _retrieveSize() {
      if (this._fullData) {
        return this._fullData.byteLength;
      }
      const xhr = new XMLHttpRequest();
      xhr.open("GET", this._url, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = this._withCredentials;
      xhr.setRequestHeader("Range", "bytes=0-0");
      await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Error fetching ${this._url} (Range): ${xhr.status} ${xhr.statusText}`));
          }
        };
        xhr.onerror = () => {
          reject(new Error("Network error occurred."));
        };
        xhr.send();
      });
      const contentRange = xhr.getResponseHeader("Content-Range");
      if (contentRange) {
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
        if (match && match[1]) {
          return parseInt(match[1], 10);
        }
      }
      const contentLength = xhr.getResponseHeader("Content-Length");
      if (contentLength) {
        return parseInt(contentLength, 10);
      }
      const { response } = await this._makeRequest();
      return response.byteLength;
    }
  };

  // src/isobmff/isobmff-reader.ts
  var MAX_BOX_HEADER_SIZE = 16;
  var IsobmffReader = class {
    constructor(reader) {
      this.reader = reader;
      this.pos = 0;
    }
    readBytes(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      return new Uint8Array(view2.buffer, offset, length);
    }
    readU8() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 1);
      this.pos++;
      return view2.getUint8(offset);
    }
    readU16() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 2);
      this.pos += 2;
      return view2.getUint16(offset, false);
    }
    readI16() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 2);
      this.pos += 2;
      return view2.getInt16(offset, false);
    }
    readU24() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 3);
      this.pos += 3;
      const high = view2.getUint16(offset, false);
      const low = view2.getUint8(offset + 2);
      return high * 256 + low;
    }
    readU32() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 4);
      this.pos += 4;
      return view2.getUint32(offset, false);
    }
    readI32() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 4);
      this.pos += 4;
      return view2.getInt32(offset, false);
    }
    readU64() {
      const high = this.readU32();
      const low = this.readU32();
      return high * 4294967296 + low;
    }
    readI64() {
      const high = this.readI32();
      const low = this.readU32();
      return high * 4294967296 + low;
    }
    readF64() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 8);
      this.pos += 8;
      return view2.getFloat64(offset, false);
    }
    readFixed_16_16() {
      return this.readI32() / 65536;
    }
    readFixed_2_30() {
      return this.readI32() / 1073741824;
    }
    readAscii(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      let str = "";
      for (let i = 0; i < length; i++) {
        str += String.fromCharCode(view2.getUint8(offset + i));
      }
      return str;
    }
    readIsomVariableInteger() {
      let result = 0;
      for (let i = 0; i < 4; i++) {
        result <<= 7;
        const nextByte = this.readU8();
        result |= nextByte & 127;
        if ((nextByte & 128) === 0) {
          break;
        }
      }
      return result;
    }
    readBoxHeader() {
      let totalSize = this.readU32();
      const name = this.readAscii(4);
      let headerSize = 8;
      const hasLargeSize = totalSize === 1;
      if (hasLargeSize) {
        totalSize = this.readU64();
        headerSize = 16;
      }
      return { name, totalSize, headerSize, contentSize: totalSize - headerSize };
    }
  };

  // src/isobmff/isobmff-demuxer.ts
  var IsobmffDemuxer = class extends Demuxer {
    constructor(input) {
      super(input);
      this.currentTrack = null;
      this.tracks = [];
      this.metadataPromise = null;
      this.movieTimescale = -1;
      this.movieDurationInTimescale = -1;
      this.isQuickTime = false;
      this.isFragmented = false;
      this.fragmentTrackDefaults = [];
      this.fragments = [];
      this.currentFragment = null;
      this.fragmentLookupMutex = new AsyncMutex();
      this.metadataReader = new IsobmffReader(input._mainReader);
      this.chunkReader = new IsobmffReader(new Reader(input._source, 64 * 2 ** 20));
    }
    async computeDuration() {
      const tracks = await this.getTracks();
      const trackDurations = await Promise.all(tracks.map((x) => x.computeDuration()));
      return Math.max(0, ...trackDurations);
    }
    async getTracks() {
      await this.readMetadata();
      return this.tracks.map((track) => track.inputTrack);
    }
    async getMimeType() {
      await this.readMetadata();
      const base = this.tracks.some((x) => x.info?.type === "video") ? "video/" : this.tracks.some((x) => x.info?.type === "audio") ? "audio/" : "application/";
      let string = base + (this.isQuickTime ? "quicktime" : "mp4");
      if (this.tracks.length > 0) {
        const codecMimeTypes = await Promise.all(this.tracks.map((x) => x.inputTrack.getCodecParameterString()));
        const uniqueCodecMimeTypes = [...new Set(codecMimeTypes.filter(Boolean))];
        string += `; codecs="${uniqueCodecMimeTypes.join(", ")}"`;
      }
      return string;
    }
    readMetadata() {
      return this.metadataPromise ??= (async () => {
        const sourceSize = await this.metadataReader.reader.source._getSize();
        while (this.metadataReader.pos < sourceSize) {
          await this.metadataReader.reader.loadRange(
            this.metadataReader.pos,
            this.metadataReader.pos + MAX_BOX_HEADER_SIZE
          );
          const startPos = this.metadataReader.pos;
          const boxInfo = this.metadataReader.readBoxHeader();
          if (boxInfo.name === "ftyp") {
            const majorBrand = this.metadataReader.readAscii(4);
            this.isQuickTime = majorBrand === "qt  ";
          } else if (boxInfo.name === "moov") {
            await this.metadataReader.reader.loadRange(
              this.metadataReader.pos,
              this.metadataReader.pos + boxInfo.contentSize
            );
            this.readContiguousBoxes(boxInfo.contentSize);
            for (const track of this.tracks) {
              const previousSegmentDurationsInSeconds = track.editListPreviousSegmentDurations / this.movieTimescale;
              track.editListOffset -= Math.round(previousSegmentDurationsInSeconds * track.timescale);
            }
            break;
          }
          this.metadataReader.pos = startPos + boxInfo.totalSize;
        }
        if (this.isFragmented) {
          await this.metadataReader.reader.loadRange(sourceSize - 4, sourceSize);
          this.metadataReader.pos = sourceSize - 4;
          const lastWord = this.metadataReader.readU32();
          const potentialMfraPos = sourceSize - lastWord;
          if (potentialMfraPos >= 0 && potentialMfraPos < sourceSize) {
            await this.metadataReader.reader.loadRange(potentialMfraPos, sourceSize);
            this.metadataReader.pos = potentialMfraPos;
            const boxInfo = this.metadataReader.readBoxHeader();
            if (boxInfo.name === "mfra") {
              this.readContiguousBoxes(boxInfo.contentSize);
            }
          }
        }
      })();
    }
    getSampleTableForTrack(internalTrack) {
      if (internalTrack.sampleTable) {
        return internalTrack.sampleTable;
      }
      const sampleTable = {
        sampleTimingEntries: [],
        sampleCompositionTimeOffsets: [],
        sampleSizes: [],
        keySampleIndices: null,
        chunkOffsets: [],
        sampleToChunk: [],
        presentationTimestamps: null,
        presentationTimestampIndexMap: null
      };
      internalTrack.sampleTable = sampleTable;
      this.metadataReader.pos = internalTrack.sampleTableByteOffset;
      this.currentTrack = internalTrack;
      this.traverseBox();
      this.currentTrack = null;
      const isPcmCodec = internalTrack.info?.type === "audio" && internalTrack.info.codec && PCM_AUDIO_CODECS.includes(internalTrack.info.codec);
      if (isPcmCodec && sampleTable.sampleCompositionTimeOffsets.length === 0) {
        const newSampleTimingEntries = [];
        const newSampleSizes = [];
        for (let i = 0; i < sampleTable.sampleToChunk.length; i++) {
          const chunkEntry = sampleTable.sampleToChunk[i];
          const nextEntry = sampleTable.sampleToChunk[i + 1];
          const chunkCount = (nextEntry ? nextEntry.startChunkIndex : sampleTable.chunkOffsets.length) - chunkEntry.startChunkIndex;
          for (let j = 0; j < chunkCount; j++) {
            const startSampleIndex = chunkEntry.startSampleIndex + j * chunkEntry.samplesPerChunk;
            const endSampleIndex = startSampleIndex + chunkEntry.samplesPerChunk;
            const startTimingEntryIndex = binarySearchLessOrEqual(
              sampleTable.sampleTimingEntries,
              startSampleIndex,
              (x) => x.startIndex
            );
            const startTimingEntry = sampleTable.sampleTimingEntries[startTimingEntryIndex];
            const endTimingEntryIndex = binarySearchLessOrEqual(
              sampleTable.sampleTimingEntries,
              endSampleIndex,
              (x) => x.startIndex
            );
            const endTimingEntry = sampleTable.sampleTimingEntries[endTimingEntryIndex];
            const firstSampleTimestamp = startTimingEntry.startDecodeTimestamp + (startSampleIndex - startTimingEntry.startIndex) * startTimingEntry.delta;
            const lastSampleTimestamp = endTimingEntry.startDecodeTimestamp + (endSampleIndex - endTimingEntry.startIndex) * endTimingEntry.delta;
            const delta = lastSampleTimestamp - firstSampleTimestamp;
            const lastSampleTimingEntry = last(newSampleTimingEntries);
            if (lastSampleTimingEntry && lastSampleTimingEntry.delta === delta) {
              lastSampleTimingEntry.count++;
            } else {
              newSampleTimingEntries.push({
                startIndex: chunkEntry.startChunkIndex + j,
                startDecodeTimestamp: firstSampleTimestamp,
                count: 1,
                delta
              });
            }
            let chunkSize = 0;
            if (sampleTable.sampleSizes.length === 1) {
              chunkSize = sampleTable.sampleSizes[0] * chunkEntry.samplesPerChunk;
            } else {
              for (let k = startSampleIndex; k < endSampleIndex; k++) {
                chunkSize += sampleTable.sampleSizes[k];
              }
            }
            newSampleSizes.push(chunkSize);
          }
          chunkEntry.startSampleIndex = chunkEntry.startChunkIndex;
          chunkEntry.samplesPerChunk = 1;
        }
        sampleTable.sampleTimingEntries = newSampleTimingEntries;
        sampleTable.sampleSizes = newSampleSizes;
      }
      if (sampleTable.sampleCompositionTimeOffsets.length > 0) {
        sampleTable.presentationTimestamps = [];
        for (const entry of sampleTable.sampleTimingEntries) {
          for (let i = 0; i < entry.count; i++) {
            sampleTable.presentationTimestamps.push({
              presentationTimestamp: entry.startDecodeTimestamp + i * entry.delta,
              sampleIndex: entry.startIndex + i
            });
          }
        }
        for (const entry of sampleTable.sampleCompositionTimeOffsets) {
          for (let i = 0; i < entry.count; i++) {
            const sampleIndex = entry.startIndex + i;
            const sample = sampleTable.presentationTimestamps[sampleIndex];
            if (!sample) {
              continue;
            }
            sample.presentationTimestamp += entry.offset;
          }
        }
        sampleTable.presentationTimestamps.sort((a, b) => a.presentationTimestamp - b.presentationTimestamp);
        sampleTable.presentationTimestampIndexMap = Array(sampleTable.presentationTimestamps.length).fill(-1);
        for (let i = 0; i < sampleTable.presentationTimestamps.length; i++) {
          sampleTable.presentationTimestampIndexMap[sampleTable.presentationTimestamps[i].sampleIndex] = i;
        }
      } else {
      }
      return sampleTable;
    }
    async readFragment() {
      const startPos = this.metadataReader.pos;
      await this.metadataReader.reader.loadRange(
        this.metadataReader.pos,
        this.metadataReader.pos + MAX_BOX_HEADER_SIZE
      );
      const moofBoxInfo = this.metadataReader.readBoxHeader();
      assert(moofBoxInfo.name === "moof");
      await this.metadataReader.reader.loadRange(startPos, startPos + moofBoxInfo.totalSize);
      this.metadataReader.pos = startPos;
      this.traverseBox();
      const index = binarySearchExact(this.fragments, startPos, (x) => x.moofOffset);
      assert(index !== -1);
      const fragment = this.fragments[index];
      assert(fragment.moofOffset === startPos);
      this.metadataReader.reader.forgetRange(startPos, startPos + moofBoxInfo.totalSize);
      for (const [trackId, trackData] of fragment.trackData) {
        if (trackData.startTimestampIsFinal) {
          continue;
        }
        const internalTrack = this.tracks.find((x) => x.id === trackId);
        this.metadataReader.pos = 0;
        let currentFragment = null;
        let lastFragment = null;
        const index2 = binarySearchLessOrEqual(
          internalTrack.fragments,
          startPos - 1,
          (x) => x.moofOffset
        );
        if (index2 !== -1) {
          currentFragment = internalTrack.fragments[index2];
          lastFragment = currentFragment;
          this.metadataReader.pos = currentFragment.moofOffset + currentFragment.moofSize;
        }
        let nextFragmentIsFirstFragment = this.metadataReader.pos === 0;
        while (this.metadataReader.pos < startPos) {
          if (currentFragment?.nextFragment) {
            currentFragment = currentFragment.nextFragment;
            this.metadataReader.pos = currentFragment.moofOffset + currentFragment.moofSize;
          } else {
            await this.metadataReader.reader.loadRange(
              this.metadataReader.pos,
              this.metadataReader.pos + MAX_BOX_HEADER_SIZE
            );
            const startPos2 = this.metadataReader.pos;
            const boxInfo = this.metadataReader.readBoxHeader();
            if (boxInfo.name === "moof") {
              const index3 = binarySearchExact(this.fragments, startPos2, (x) => x.moofOffset);
              let fragment2;
              if (index3 === -1) {
                this.metadataReader.pos = startPos2;
                fragment2 = await this.readFragment();
              } else {
                fragment2 = this.fragments[index3];
              }
              if (currentFragment) currentFragment.nextFragment = fragment2;
              currentFragment = fragment2;
              if (nextFragmentIsFirstFragment) {
                fragment2.isKnownToBeFirstFragment = true;
                nextFragmentIsFirstFragment = false;
              }
            }
            this.metadataReader.pos = startPos2 + boxInfo.totalSize;
          }
          if (currentFragment && currentFragment.trackData.has(trackId)) {
            lastFragment = currentFragment;
          }
        }
        if (lastFragment) {
          const otherTrackData = lastFragment.trackData.get(trackId);
          assert(otherTrackData.startTimestampIsFinal);
          offsetFragmentTrackDataByTimestamp(trackData, otherTrackData.endTimestamp);
        }
        trackData.startTimestampIsFinal = true;
      }
      return fragment;
    }
    readContiguousBoxes(totalSize) {
      const startIndex = this.metadataReader.pos;
      while (this.metadataReader.pos - startIndex < totalSize) {
        this.traverseBox();
      }
    }
    traverseBox() {
      const startPos = this.metadataReader.pos;
      const boxInfo = this.metadataReader.readBoxHeader();
      const boxEndPos = startPos + boxInfo.totalSize;
      switch (boxInfo.name) {
        case "mdia":
        case "minf":
        case "dinf":
        case "mfra":
        case "edts":
          {
            this.readContiguousBoxes(boxInfo.contentSize);
          }
          ;
          break;
        case "mvhd":
          {
            const version = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            if (version === 1) {
              this.metadataReader.pos += 8 + 8;
              this.movieTimescale = this.metadataReader.readU32();
              this.movieDurationInTimescale = this.metadataReader.readU64();
            } else {
              this.metadataReader.pos += 4 + 4;
              this.movieTimescale = this.metadataReader.readU32();
              this.movieDurationInTimescale = this.metadataReader.readU32();
            }
          }
          ;
          break;
        case "trak":
          {
            const track = {
              id: -1,
              demuxer: this,
              inputTrack: null,
              info: null,
              timescale: -1,
              durationInMovieTimescale: -1,
              durationInMediaTimescale: -1,
              rotation: 0,
              languageCode: UNDETERMINED_LANGUAGE,
              sampleTableByteOffset: -1,
              sampleTable: null,
              fragmentLookupTable: null,
              currentFragmentState: null,
              fragments: [],
              editListPreviousSegmentDurations: 0,
              editListOffset: 0
            };
            this.currentTrack = track;
            this.readContiguousBoxes(boxInfo.contentSize);
            if (track.id !== -1 && track.timescale !== -1 && track.info !== null) {
              if (track.info.type === "video" && track.info.width !== -1) {
                const videoTrack = track;
                track.inputTrack = new InputVideoTrack(new IsobmffVideoTrackBacking(videoTrack));
                this.tracks.push(track);
              } else if (track.info.type === "audio" && track.info.numberOfChannels !== -1) {
                const audioTrack = track;
                track.inputTrack = new InputAudioTrack(new IsobmffAudioTrackBacking(audioTrack));
                this.tracks.push(track);
              }
            }
            this.currentTrack = null;
          }
          ;
          break;
        case "tkhd":
          {
            const track = this.currentTrack;
            assert(track);
            const version = this.metadataReader.readU8();
            const flags = this.metadataReader.readU24();
            const trackEnabled = (flags & 1) !== 0;
            if (!trackEnabled) {
              break;
            }
            if (version === 0) {
              this.metadataReader.pos += 8;
              track.id = this.metadataReader.readU32();
              this.metadataReader.pos += 4;
              track.durationInMovieTimescale = this.metadataReader.readU32();
            } else if (version === 1) {
              this.metadataReader.pos += 16;
              track.id = this.metadataReader.readU32();
              this.metadataReader.pos += 4;
              track.durationInMovieTimescale = this.metadataReader.readU64();
            } else {
              throw new Error(`Incorrect track header version ${version}.`);
            }
            this.metadataReader.pos += 2 * 4 + 2 + 2 + 2 + 2;
            const matrix = [
              this.metadataReader.readFixed_16_16(),
              this.metadataReader.readFixed_16_16(),
              this.metadataReader.readFixed_2_30(),
              this.metadataReader.readFixed_16_16(),
              this.metadataReader.readFixed_16_16(),
              this.metadataReader.readFixed_2_30(),
              this.metadataReader.readFixed_16_16(),
              this.metadataReader.readFixed_16_16(),
              this.metadataReader.readFixed_2_30()
            ];
            const rotation = normalizeRotation(roundToMultiple(extractRotationFromMatrix(matrix), 90));
            assert(rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270);
            track.rotation = rotation;
          }
          ;
          break;
        case "elst":
          {
            const track = this.currentTrack;
            assert(track);
            const version = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            let relevantEntryFound = false;
            let previousSegmentDurations = 0;
            const entryCount = this.metadataReader.readU32();
            for (let i = 0; i < entryCount; i++) {
              const segmentDuration = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();
              const mediaTime = version === 1 ? this.metadataReader.readI64() : this.metadataReader.readI32();
              const mediaRate = this.metadataReader.readFixed_16_16();
              if (segmentDuration === 0) {
                continue;
              }
              if (relevantEntryFound) {
                throw new Error("Unsupported edit list: multiple edits are not supported.");
              }
              if (mediaTime === -1) {
                previousSegmentDurations += segmentDuration;
                continue;
              }
              if (mediaRate !== 1) {
                throw new Error("Unsupported edit list: media rate must be 1.");
              }
              track.editListPreviousSegmentDurations = previousSegmentDurations;
              track.editListOffset = mediaTime;
              relevantEntryFound = true;
            }
          }
          ;
          break;
        case "mdhd":
          {
            const track = this.currentTrack;
            assert(track);
            const version = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            if (version === 0) {
              this.metadataReader.pos += 8;
              track.timescale = this.metadataReader.readU32();
              track.durationInMediaTimescale = this.metadataReader.readU32();
            } else if (version === 1) {
              this.metadataReader.pos += 16;
              track.timescale = this.metadataReader.readU32();
              track.durationInMediaTimescale = this.metadataReader.readU64();
            }
            let language = this.metadataReader.readU16();
            if (language > 0) {
              track.languageCode = "";
              for (let i = 0; i < 3; i++) {
                track.languageCode = String.fromCharCode(96 + (language & 31)) + track.languageCode;
                language >>= 5;
              }
              if (!isIso639Dash2LanguageCode(track.languageCode)) {
                track.languageCode = UNDETERMINED_LANGUAGE;
              }
            }
          }
          ;
          break;
        case "hdlr":
          {
            const track = this.currentTrack;
            assert(track);
            this.metadataReader.pos += 8;
            const handlerType = this.metadataReader.readAscii(4);
            if (handlerType === "vide") {
              track.info = {
                type: "video",
                width: -1,
                height: -1,
                codec: null,
                codecDescription: null,
                colorSpace: null,
                vp9CodecInfo: null,
                av1CodecInfo: null
              };
            } else if (handlerType === "soun") {
              track.info = {
                type: "audio",
                numberOfChannels: -1,
                sampleRate: -1,
                codec: null,
                codecDescription: null,
                aacCodecInfo: null
              };
            }
          }
          ;
          break;
        case "stbl":
          {
            const track = this.currentTrack;
            assert(track);
            track.sampleTableByteOffset = startPos;
            this.readContiguousBoxes(boxInfo.contentSize);
          }
          ;
          break;
        case "stsd":
          {
            const track = this.currentTrack;
            assert(track);
            if (track.info === null || track.sampleTable) {
              break;
            }
            const stsdVersion = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            const entries = this.metadataReader.readU32();
            for (let i = 0; i < entries; i++) {
              const sampleBoxInfo = this.metadataReader.readBoxHeader();
              const lowercaseBoxName = sampleBoxInfo.name.toLowerCase();
              if (track.info.type === "video") {
                if (lowercaseBoxName === "avc1") {
                  track.info.codec = "avc";
                } else if (lowercaseBoxName === "hvc1" || lowercaseBoxName === "hev1") {
                  track.info.codec = "hevc";
                } else if (lowercaseBoxName === "vp08") {
                  track.info.codec = "vp8";
                } else if (lowercaseBoxName === "vp09") {
                  track.info.codec = "vp9";
                } else if (lowercaseBoxName === "av01") {
                  track.info.codec = "av1";
                } else {
                  console.warn(`Unsupported video codec (sample entry type '${sampleBoxInfo.name}').`);
                }
                this.metadataReader.pos += 6 * 1 + 2 + 2 + 2 + 3 * 4;
                track.info.width = this.metadataReader.readU16();
                track.info.height = this.metadataReader.readU16();
                this.metadataReader.pos += 4 + 4 + 4 + 2 + 32 + 2 + 2;
                this.readContiguousBoxes(startPos + sampleBoxInfo.totalSize - this.metadataReader.pos);
              } else {
                if (lowercaseBoxName === "mp4a") {
                } else if (lowercaseBoxName === "opus") {
                  track.info.codec = "opus";
                } else if (lowercaseBoxName === "flac") {
                  track.info.codec = "flac";
                } else if (lowercaseBoxName === "twos" || lowercaseBoxName === "sowt" || lowercaseBoxName === "raw " || lowercaseBoxName === "in24" || lowercaseBoxName === "in32" || lowercaseBoxName === "fl32" || lowercaseBoxName === "lpcm") {
                } else if (lowercaseBoxName === "ulaw") {
                  track.info.codec = "ulaw";
                } else if (lowercaseBoxName === "alaw") {
                  track.info.codec = "alaw";
                } else {
                  console.warn(`Unsupported audio codec (sample entry type '${sampleBoxInfo.name}').`);
                }
                this.metadataReader.pos += 6 * 1 + 2;
                const version = this.metadataReader.readU16();
                this.metadataReader.pos += 3 * 2;
                let channelCount = this.metadataReader.readU16();
                let sampleSize = this.metadataReader.readU16();
                this.metadataReader.pos += 2 * 2;
                let sampleRate = this.metadataReader.readU32() / 65536;
                if (stsdVersion === 0 && version > 0) {
                  if (version === 1) {
                    this.metadataReader.pos += 4;
                    sampleSize = 8 * this.metadataReader.readU32();
                    this.metadataReader.pos += 2 * 4;
                  } else if (version === 2) {
                    this.metadataReader.pos += 4;
                    sampleRate = this.metadataReader.readF64();
                    channelCount = this.metadataReader.readU32();
                    this.metadataReader.pos += 4;
                    sampleSize = this.metadataReader.readU32();
                    const flags = this.metadataReader.readU32();
                    this.metadataReader.pos += 2 * 4;
                    if (lowercaseBoxName === "lpcm") {
                      const bytesPerSample = sampleSize + 7 >> 3;
                      const isFloat = Boolean(flags & 1);
                      const isBigEndian = Boolean(flags & 2);
                      const sFlags = flags & 4 ? -1 : 0;
                      if (sampleSize > 0 && sampleSize <= 64) {
                        if (isFloat) {
                          if (sampleSize === 32) {
                            track.info.codec = isBigEndian ? "pcm-f32be" : "pcm-f32";
                          }
                        } else {
                          if (sFlags & 1 << bytesPerSample - 1) {
                            if (bytesPerSample === 1) {
                              track.info.codec = "pcm-s8";
                            } else if (bytesPerSample === 2) {
                              track.info.codec = isBigEndian ? "pcm-s16be" : "pcm-s16";
                            } else if (bytesPerSample === 3) {
                              track.info.codec = isBigEndian ? "pcm-s24be" : "pcm-s24";
                            } else if (bytesPerSample === 4) {
                              track.info.codec = isBigEndian ? "pcm-s32be" : "pcm-s32";
                            }
                          } else {
                            if (bytesPerSample === 1) {
                              track.info.codec = "pcm-u8";
                            }
                          }
                        }
                      }
                      if (track.info.codec === null) {
                        console.warn("Unsupported PCM format.");
                      }
                    }
                  }
                }
                track.info.numberOfChannels = channelCount;
                track.info.sampleRate = sampleRate;
                if (lowercaseBoxName === "twos") {
                  if (sampleSize === 8) {
                    track.info.codec = "pcm-s8";
                  } else if (sampleSize === 16) {
                    track.info.codec = "pcm-s16be";
                  } else {
                    throw new Error(`Unsupported sample size ${sampleSize} for codec 'twos'.`);
                  }
                } else if (lowercaseBoxName === "sowt") {
                  if (sampleSize === 8) {
                    track.info.codec = "pcm-s8";
                  } else if (sampleSize === 16) {
                    track.info.codec = "pcm-s16";
                  } else {
                    throw new Error(`Unsupported sample size ${sampleSize} for codec 'sowt'.`);
                  }
                } else if (lowercaseBoxName === "raw ") {
                  track.info.codec = "pcm-u8";
                } else if (lowercaseBoxName === "in24") {
                  track.info.codec = "pcm-s24be";
                } else if (lowercaseBoxName === "in32") {
                  track.info.codec = "pcm-s32be";
                } else if (lowercaseBoxName === "fl32") {
                  track.info.codec = "pcm-f32be";
                }
                this.readContiguousBoxes(startPos + sampleBoxInfo.totalSize - this.metadataReader.pos);
              }
            }
          }
          ;
          break;
        case "avcC":
          {
            const track = this.currentTrack;
            assert(track && track.info);
            track.info.codecDescription = this.metadataReader.readBytes(boxInfo.contentSize);
          }
          ;
          break;
        case "hvcC":
          {
            const track = this.currentTrack;
            assert(track && track.info);
            track.info.codecDescription = this.metadataReader.readBytes(boxInfo.contentSize);
          }
          ;
          break;
        case "vpcC":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "video");
            this.metadataReader.pos += 4;
            const profile = this.metadataReader.readU8();
            const level = this.metadataReader.readU8();
            const thirdByte = this.metadataReader.readU8();
            const bitDepth = thirdByte >> 4;
            const chromaSubsampling = thirdByte >> 1 & 7;
            const videoFullRangeFlag = thirdByte & 1;
            const colourPrimaries = this.metadataReader.readU8();
            const transferCharacteristics = this.metadataReader.readU8();
            const matrixCoefficients = this.metadataReader.readU8();
            track.info.vp9CodecInfo = {
              profile,
              level,
              bitDepth,
              chromaSubsampling,
              videoFullRangeFlag,
              colourPrimaries,
              transferCharacteristics,
              matrixCoefficients
            };
          }
          ;
          break;
        case "av1C":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "video");
            this.metadataReader.pos += 1;
            const secondByte = this.metadataReader.readU8();
            const profile = secondByte >> 5;
            const level = secondByte & 31;
            const thirdByte = this.metadataReader.readU8();
            const tier = thirdByte >> 7;
            const highBitDepth = thirdByte >> 6 & 1;
            const twelveBit = thirdByte >> 5 & 1;
            const monochrome = thirdByte >> 4 & 1;
            const chromaSubsamplingX = thirdByte >> 3 & 1;
            const chromaSubsamplingY = thirdByte >> 2 & 1;
            const chromaSamplePosition = thirdByte & 3;
            const bitDepth = profile == 2 && highBitDepth ? twelveBit ? 12 : 10 : highBitDepth ? 10 : 8;
            track.info.av1CodecInfo = {
              profile,
              level,
              tier,
              bitDepth,
              monochrome,
              chromaSubsamplingX,
              chromaSubsamplingY,
              chromaSamplePosition
            };
          }
          ;
          break;
        case "colr":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "video");
            const colourType = this.metadataReader.readAscii(4);
            if (colourType !== "nclx") {
              break;
            }
            const colourPrimaries = this.metadataReader.readU16();
            const transferCharacteristics = this.metadataReader.readU16();
            const matrixCoefficients = this.metadataReader.readU16();
            const fullRangeFlag = Boolean(this.metadataReader.readU8() & 128);
            track.info.colorSpace = {
              primaries: COLOR_PRIMARIES_MAP_INVERSE[colourPrimaries],
              transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics],
              matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients],
              fullRange: fullRangeFlag
            };
          }
          ;
          break;
        case "wave":
          {
            if (boxInfo.totalSize > 8) {
              this.readContiguousBoxes(boxInfo.contentSize);
            }
          }
          ;
          break;
        case "esds":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "audio");
            this.metadataReader.pos += 4;
            const tag = this.metadataReader.readU8();
            assert(tag === 3);
            this.metadataReader.readIsomVariableInteger();
            this.metadataReader.pos += 2;
            const mixed = this.metadataReader.readU8();
            const streamDependenceFlag = (mixed & 128) !== 0;
            const urlFlag = (mixed & 64) !== 0;
            const ocrStreamFlag = (mixed & 32) !== 0;
            if (streamDependenceFlag) {
              this.metadataReader.pos += 2;
            }
            if (urlFlag) {
              const urlLength = this.metadataReader.readU8();
              this.metadataReader.pos += urlLength;
            }
            if (ocrStreamFlag) {
              this.metadataReader.pos += 2;
            }
            const decoderConfigTag = this.metadataReader.readU8();
            assert(decoderConfigTag === 4);
            const decoderConfigDescriptorLength = this.metadataReader.readIsomVariableInteger();
            const payloadStart = this.metadataReader.pos;
            const objectTypeIndication = this.metadataReader.readU8();
            if (objectTypeIndication === 64 || objectTypeIndication === 103) {
              track.info.codec = "aac";
              track.info.aacCodecInfo = { isMpeg2: objectTypeIndication === 103 };
            } else if (objectTypeIndication === 105 || objectTypeIndication === 107) {
              track.info.codec = "mp3";
            } else if (objectTypeIndication === 221) {
              track.info.codec = "vorbis";
            } else {
              console.warn(
                `Unsupported audio codec (objectTypeIndication ${objectTypeIndication}) - discarding track.`
              );
            }
            this.metadataReader.pos += 1 + 3 + 4 + 4;
            if (decoderConfigDescriptorLength > this.metadataReader.pos - payloadStart) {
              const decoderSpecificInfoTag = this.metadataReader.readU8();
              assert(decoderSpecificInfoTag === 5);
              const decoderSpecificInfoLength = this.metadataReader.readIsomVariableInteger();
              track.info.codecDescription = this.metadataReader.readBytes(decoderSpecificInfoLength);
              if (track.info.codec === "aac") {
                const audioSpecificConfig = parseAacAudioSpecificConfig(track.info.codecDescription);
                if (audioSpecificConfig.numberOfChannels !== null) {
                  track.info.numberOfChannels = audioSpecificConfig.numberOfChannels;
                }
                if (audioSpecificConfig.sampleRate !== null) {
                  track.info.sampleRate = audioSpecificConfig.sampleRate;
                }
              }
            }
          }
          ;
          break;
        case "enda":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "audio");
            const littleEndian = this.metadataReader.readU16() & 255;
            if (littleEndian) {
              if (track.info.codec === "pcm-s16be") {
                track.info.codec = "pcm-s16";
              } else if (track.info.codec === "pcm-s24be") {
                track.info.codec = "pcm-s24";
              } else if (track.info.codec === "pcm-s32be") {
                track.info.codec = "pcm-s32";
              } else if (track.info.codec === "pcm-f32be") {
                track.info.codec = "pcm-f32";
              }
            }
          }
          ;
          break;
        case "dOps":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "audio");
            this.metadataReader.pos += 1;
            const outputChannelCount = this.metadataReader.readU8();
            const preSkip = this.metadataReader.readU16();
            const inputSampleRate = this.metadataReader.readU32();
            const outputGain = this.metadataReader.readI16();
            const channelMappingFamily = this.metadataReader.readU8();
            let channelMappingTable;
            if (channelMappingFamily !== 0) {
              channelMappingTable = this.metadataReader.readBytes(2 + outputChannelCount);
            } else {
              channelMappingTable = new Uint8Array(0);
            }
            const description = new Uint8Array(8 + 1 + 1 + 2 + 4 + 2 + 1 + channelMappingTable.byteLength);
            const view2 = new DataView(description.buffer);
            view2.setUint32(0, 1332770163, false);
            view2.setUint32(4, 1214603620, false);
            view2.setUint8(8, 1);
            view2.setUint8(9, outputChannelCount);
            view2.setUint16(10, preSkip, true);
            view2.setUint32(12, inputSampleRate, true);
            view2.setInt16(16, outputGain, true);
            view2.setUint8(18, channelMappingFamily);
            description.set(channelMappingTable, 19);
            track.info.codecDescription = description;
            track.info.numberOfChannels = outputChannelCount;
            track.info.sampleRate = inputSampleRate;
          }
          ;
          break;
        case "dfLa":
          {
            const track = this.currentTrack;
            assert(track && track.info?.type === "audio");
            this.metadataReader.pos += 4;
            const BLOCK_TYPE_MASK = 127;
            const LAST_METADATA_BLOCK_FLAG_MASK = 128;
            const startPos2 = this.metadataReader.pos;
            while (this.metadataReader.pos < boxEndPos) {
              const flagAndType = this.metadataReader.readU8();
              const metadataBlockLength = this.metadataReader.readU24();
              const type = flagAndType & BLOCK_TYPE_MASK;
              if (type === 0) {
                this.metadataReader.pos += 10;
                const word = this.metadataReader.readU32();
                const sampleRate = word >>> 12;
                const numberOfChannels = (word >> 9 & 7) + 1;
                track.info.sampleRate = sampleRate;
                track.info.numberOfChannels = numberOfChannels;
                this.metadataReader.pos += 20;
              } else {
                this.metadataReader.pos += metadataBlockLength;
              }
              if (flagAndType & LAST_METADATA_BLOCK_FLAG_MASK) {
                break;
              }
            }
            const endPos = this.metadataReader.pos;
            this.metadataReader.pos = startPos2;
            const bytes2 = this.metadataReader.readBytes(endPos - startPos2);
            const description = new Uint8Array(4 + bytes2.byteLength);
            const view2 = new DataView(description.buffer);
            view2.setUint32(0, 1716281667, false);
            description.set(bytes2, 4);
            track.info.codecDescription = description;
          }
          ;
          break;
        case "stts":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 4;
            const entryCount = this.metadataReader.readU32();
            let currentIndex = 0;
            let currentTimestamp = 0;
            for (let i = 0; i < entryCount; i++) {
              const sampleCount = this.metadataReader.readU32();
              const sampleDelta = this.metadataReader.readU32();
              track.sampleTable.sampleTimingEntries.push({
                startIndex: currentIndex,
                startDecodeTimestamp: currentTimestamp,
                count: sampleCount,
                delta: sampleDelta
              });
              currentIndex += sampleCount;
              currentTimestamp += sampleCount * sampleDelta;
            }
          }
          ;
          break;
        case "ctts":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 1 + 3;
            const entryCount = this.metadataReader.readU32();
            let sampleIndex = 0;
            for (let i = 0; i < entryCount; i++) {
              const sampleCount = this.metadataReader.readU32();
              const sampleOffset = this.metadataReader.readI32();
              track.sampleTable.sampleCompositionTimeOffsets.push({
                startIndex: sampleIndex,
                count: sampleCount,
                offset: sampleOffset
              });
              sampleIndex += sampleCount;
            }
          }
          ;
          break;
        case "stsz":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 4;
            const sampleSize = this.metadataReader.readU32();
            const sampleCount = this.metadataReader.readU32();
            if (sampleSize === 0) {
              for (let i = 0; i < sampleCount; i++) {
                const sampleSize2 = this.metadataReader.readU32();
                track.sampleTable.sampleSizes.push(sampleSize2);
              }
            } else {
              track.sampleTable.sampleSizes.push(sampleSize);
            }
          }
          ;
          break;
        case "stz2":
          {
            throw new Error("Unsupported.");
          }
          ;
        case "stss":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 4;
            track.sampleTable.keySampleIndices = [];
            const entryCount = this.metadataReader.readU32();
            for (let i = 0; i < entryCount; i++) {
              const sampleIndex = this.metadataReader.readU32() - 1;
              track.sampleTable.keySampleIndices.push(sampleIndex);
            }
          }
          ;
          break;
        case "stsc":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 4;
            const entryCount = this.metadataReader.readU32();
            for (let i = 0; i < entryCount; i++) {
              const startChunkIndex = this.metadataReader.readU32() - 1;
              const samplesPerChunk = this.metadataReader.readU32();
              const sampleDescriptionIndex = this.metadataReader.readU32();
              track.sampleTable.sampleToChunk.push({
                startSampleIndex: -1,
                startChunkIndex,
                samplesPerChunk,
                sampleDescriptionIndex
              });
            }
            let startSampleIndex = 0;
            for (let i = 0; i < track.sampleTable.sampleToChunk.length; i++) {
              track.sampleTable.sampleToChunk[i].startSampleIndex = startSampleIndex;
              if (i < track.sampleTable.sampleToChunk.length - 1) {
                const nextChunk = track.sampleTable.sampleToChunk[i + 1];
                const chunkCount = nextChunk.startChunkIndex - track.sampleTable.sampleToChunk[i].startChunkIndex;
                startSampleIndex += chunkCount * track.sampleTable.sampleToChunk[i].samplesPerChunk;
              }
            }
          }
          ;
          break;
        case "stco":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 4;
            const entryCount = this.metadataReader.readU32();
            for (let i = 0; i < entryCount; i++) {
              const chunkOffset = this.metadataReader.readU32();
              track.sampleTable.chunkOffsets.push(chunkOffset);
            }
          }
          ;
          break;
        case "co64":
          {
            const track = this.currentTrack;
            assert(track);
            if (!track.sampleTable) {
              break;
            }
            this.metadataReader.pos += 4;
            const entryCount = this.metadataReader.readU32();
            for (let i = 0; i < entryCount; i++) {
              const chunkOffset = this.metadataReader.readU64();
              track.sampleTable.chunkOffsets.push(chunkOffset);
            }
          }
          ;
          break;
        case "mvex":
          {
            this.isFragmented = true;
            this.readContiguousBoxes(boxInfo.contentSize);
          }
          ;
          break;
        case "mehd":
          {
            const version = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            const fragmentDuration = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();
            this.movieDurationInTimescale = fragmentDuration;
          }
          ;
          break;
        case "trex":
          {
            this.metadataReader.pos += 4;
            const trackId = this.metadataReader.readU32();
            const defaultSampleDescriptionIndex = this.metadataReader.readU32();
            const defaultSampleDuration = this.metadataReader.readU32();
            const defaultSampleSize = this.metadataReader.readU32();
            const defaultSampleFlags = this.metadataReader.readU32();
            this.fragmentTrackDefaults.push({
              trackId,
              defaultSampleDescriptionIndex,
              defaultSampleDuration,
              defaultSampleSize,
              defaultSampleFlags
            });
          }
          ;
          break;
        case "tfra":
          {
            const version = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            const trackId = this.metadataReader.readU32();
            const track = this.tracks.find((x2) => x2.id === trackId);
            if (!track) {
              break;
            }
            track.fragmentLookupTable = [];
            const word = this.metadataReader.readU32();
            const lengthSizeOfTrafNum = (word & 48) >> 4;
            const lengthSizeOfTrunNum = (word & 12) >> 2;
            const lengthSizeOfSampleNum = word & 3;
            const x = this.metadataReader;
            const functions = [x.readU8.bind(x), x.readU16.bind(x), x.readU24.bind(x), x.readU32.bind(x)];
            const readTrafNum = functions[lengthSizeOfTrafNum];
            const readTrunNum = functions[lengthSizeOfTrunNum];
            const readSampleNum = functions[lengthSizeOfSampleNum];
            const numberOfEntries = this.metadataReader.readU32();
            for (let i = 0; i < numberOfEntries; i++) {
              const time = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();
              const moofOffset = version === 1 ? this.metadataReader.readU64() : this.metadataReader.readU32();
              const trafNumber = readTrafNum();
              const trunNumber = readTrunNum();
              const sampleNumber = readSampleNum();
              track.fragmentLookupTable.push({
                timestamp: time,
                moofOffset
              });
            }
          }
          ;
          break;
        case "moof":
          {
            this.currentFragment = {
              moofOffset: startPos,
              moofSize: boxInfo.totalSize,
              implicitBaseDataOffset: startPos,
              trackData: /* @__PURE__ */ new Map(),
              dataStart: Infinity,
              dataEnd: 0,
              nextFragment: null,
              isKnownToBeFirstFragment: false
            };
            this.readContiguousBoxes(boxInfo.contentSize);
            const insertionIndex = binarySearchLessOrEqual(
              this.fragments,
              this.currentFragment.moofOffset,
              (x) => x.moofOffset
            );
            this.fragments.splice(insertionIndex + 1, 0, this.currentFragment);
            for (const [, trackData] of this.currentFragment.trackData) {
              const firstSample = trackData.samples[0];
              const lastSample = last(trackData.samples);
              this.currentFragment.dataStart = Math.min(
                this.currentFragment.dataStart,
                firstSample.byteOffset
              );
              this.currentFragment.dataEnd = Math.max(
                this.currentFragment.dataEnd,
                lastSample.byteOffset + lastSample.byteSize
              );
            }
            this.currentFragment = null;
          }
          ;
          break;
        case "traf":
          {
            assert(this.currentFragment);
            this.readContiguousBoxes(boxInfo.contentSize);
            if (this.currentTrack) {
              const trackData = this.currentFragment.trackData.get(this.currentTrack.id);
              if (trackData) {
                const insertionIndex = binarySearchLessOrEqual(
                  this.currentTrack.fragments,
                  this.currentFragment.moofOffset,
                  (x) => x.moofOffset
                );
                this.currentTrack.fragments.splice(insertionIndex + 1, 0, this.currentFragment);
                const { currentFragmentState } = this.currentTrack;
                assert(currentFragmentState);
                if (currentFragmentState.startTimestamp !== null) {
                  offsetFragmentTrackDataByTimestamp(trackData, currentFragmentState.startTimestamp);
                  trackData.startTimestampIsFinal = true;
                }
              }
              this.currentTrack.currentFragmentState = null;
              this.currentTrack = null;
            }
          }
          ;
          break;
        case "tfhd":
          {
            assert(this.currentFragment);
            this.metadataReader.pos += 1;
            const flags = this.metadataReader.readU24();
            const baseDataOffsetPresent = Boolean(flags & 1);
            const sampleDescriptionIndexPresent = Boolean(flags & 2);
            const defaultSampleDurationPresent = Boolean(flags & 8);
            const defaultSampleSizePresent = Boolean(flags & 16);
            const defaultSampleFlagsPresent = Boolean(flags & 32);
            const durationIsEmpty = Boolean(flags & 65536);
            const defaultBaseIsMoof = Boolean(flags & 131072);
            const trackId = this.metadataReader.readU32();
            const track = this.tracks.find((x) => x.id === trackId);
            if (!track) {
              break;
            }
            const defaults = this.fragmentTrackDefaults.find((x) => x.trackId === trackId);
            this.currentTrack = track;
            track.currentFragmentState = {
              baseDataOffset: this.currentFragment.implicitBaseDataOffset,
              sampleDescriptionIndex: defaults?.defaultSampleDescriptionIndex ?? null,
              defaultSampleDuration: defaults?.defaultSampleDuration ?? null,
              defaultSampleSize: defaults?.defaultSampleSize ?? null,
              defaultSampleFlags: defaults?.defaultSampleFlags ?? null,
              startTimestamp: null
            };
            if (baseDataOffsetPresent) {
              track.currentFragmentState.baseDataOffset = this.metadataReader.readU64();
            } else if (defaultBaseIsMoof) {
              track.currentFragmentState.baseDataOffset = this.currentFragment.moofOffset;
            }
            if (sampleDescriptionIndexPresent) {
              track.currentFragmentState.sampleDescriptionIndex = this.metadataReader.readU32();
            }
            if (defaultSampleDurationPresent) {
              track.currentFragmentState.defaultSampleDuration = this.metadataReader.readU32();
            }
            if (defaultSampleSizePresent) {
              track.currentFragmentState.defaultSampleSize = this.metadataReader.readU32();
            }
            if (defaultSampleFlagsPresent) {
              track.currentFragmentState.defaultSampleFlags = this.metadataReader.readU32();
            }
            if (durationIsEmpty) {
              track.currentFragmentState.defaultSampleDuration = 0;
            }
          }
          ;
          break;
        case "tfdt":
          {
            const track = this.currentTrack;
            if (!track) {
              break;
            }
            assert(track.currentFragmentState);
            const version = this.metadataReader.readU8();
            this.metadataReader.pos += 3;
            const baseMediaDecodeTime = version === 0 ? this.metadataReader.readU32() : this.metadataReader.readU64();
            track.currentFragmentState.startTimestamp = baseMediaDecodeTime;
          }
          ;
          break;
        case "trun":
          {
            const track = this.currentTrack;
            if (!track) {
              break;
            }
            assert(this.currentFragment);
            assert(track.currentFragmentState);
            if (this.currentFragment.trackData.has(track.id)) {
              throw new Error("Can't have two trun boxes for the same track in one fragment.");
            }
            const version = this.metadataReader.readU8();
            const flags = this.metadataReader.readU24();
            const dataOffsetPresent = Boolean(flags & 1);
            const firstSampleFlagsPresent = Boolean(flags & 4);
            const sampleDurationPresent = Boolean(flags & 256);
            const sampleSizePresent = Boolean(flags & 512);
            const sampleFlagsPresent = Boolean(flags & 1024);
            const sampleCompositionTimeOffsetsPresent = Boolean(flags & 2048);
            const sampleCount = this.metadataReader.readU32();
            let dataOffset = track.currentFragmentState.baseDataOffset;
            if (dataOffsetPresent) {
              dataOffset += this.metadataReader.readI32();
            }
            let firstSampleFlags = null;
            if (firstSampleFlagsPresent) {
              firstSampleFlags = this.metadataReader.readU32();
            }
            let currentOffset = dataOffset;
            if (sampleCount === 0) {
              this.currentFragment.implicitBaseDataOffset = currentOffset;
              break;
            }
            let currentTimestamp = 0;
            const trackData = {
              startTimestamp: 0,
              endTimestamp: 0,
              samples: [],
              presentationTimestamps: [],
              startTimestampIsFinal: false
            };
            this.currentFragment.trackData.set(track.id, trackData);
            for (let i = 0; i < sampleCount; i++) {
              let sampleDuration;
              if (sampleDurationPresent) {
                sampleDuration = this.metadataReader.readU32();
              } else {
                assert(track.currentFragmentState.defaultSampleDuration !== null);
                sampleDuration = track.currentFragmentState.defaultSampleDuration;
              }
              let sampleSize;
              if (sampleSizePresent) {
                sampleSize = this.metadataReader.readU32();
              } else {
                assert(track.currentFragmentState.defaultSampleSize !== null);
                sampleSize = track.currentFragmentState.defaultSampleSize;
              }
              let sampleFlags;
              if (sampleFlagsPresent) {
                sampleFlags = this.metadataReader.readU32();
              } else {
                assert(track.currentFragmentState.defaultSampleFlags !== null);
                sampleFlags = track.currentFragmentState.defaultSampleFlags;
              }
              if (i === 0 && firstSampleFlags !== null) {
                sampleFlags = firstSampleFlags;
              }
              let sampleCompositionTimeOffset = 0;
              if (sampleCompositionTimeOffsetsPresent) {
                if (version === 0) {
                  sampleCompositionTimeOffset = this.metadataReader.readU32();
                } else {
                  sampleCompositionTimeOffset = this.metadataReader.readI32();
                }
              }
              const isKeyFrame = !(sampleFlags & 65536);
              trackData.samples.push({
                presentationTimestamp: currentTimestamp + sampleCompositionTimeOffset,
                duration: sampleDuration,
                byteOffset: currentOffset,
                byteSize: sampleSize,
                isKeyFrame
              });
              currentOffset += sampleSize;
              currentTimestamp += sampleDuration;
            }
            trackData.presentationTimestamps = trackData.samples.map((x, i) => ({ presentationTimestamp: x.presentationTimestamp, sampleIndex: i })).sort((a, b) => a.presentationTimestamp - b.presentationTimestamp);
            for (let i = 0; i < trackData.presentationTimestamps.length - 1; i++) {
              const current = trackData.presentationTimestamps[i];
              const next = trackData.presentationTimestamps[i + 1];
              const duration = next.presentationTimestamp - current.presentationTimestamp;
              trackData.samples[current.sampleIndex].duration = duration;
            }
            const firstSample = trackData.samples[trackData.presentationTimestamps[0].sampleIndex];
            const lastSample = trackData.samples[last(trackData.presentationTimestamps).sampleIndex];
            trackData.startTimestamp = firstSample.presentationTimestamp;
            trackData.endTimestamp = lastSample.presentationTimestamp + lastSample.duration;
            this.currentFragment.implicitBaseDataOffset = currentOffset;
          }
          ;
          break;
      }
      this.metadataReader.pos = boxEndPos;
    }
  };
  var IsobmffTrackBacking = class {
    constructor(internalTrack) {
      this.internalTrack = internalTrack;
      this.packetToSampleIndex = /* @__PURE__ */ new WeakMap();
      this.packetToFragmentLocation = /* @__PURE__ */ new WeakMap();
    }
    getId() {
      return this.internalTrack.id;
    }
    getCodec() {
      throw new Error("Not implemented on base class.");
    }
    getLanguageCode() {
      return this.internalTrack.languageCode;
    }
    getTimeResolution() {
      return this.internalTrack.timescale;
    }
    async computeDuration() {
      const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
      return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
    }
    async getFirstTimestamp() {
      const firstPacket = await this.getFirstPacket({ metadataOnly: true });
      return firstPacket?.timestamp ?? 0;
    }
    async getFirstPacket(options) {
      if (this.internalTrack.demuxer.isFragmented) {
        return this.performFragmentedLookup(
          () => {
            const startFragment = this.internalTrack.demuxer.fragments[0] ?? null;
            if (startFragment?.isKnownToBeFirstFragment) {
              let currentFragment = startFragment;
              while (currentFragment) {
                const trackData = currentFragment.trackData.get(this.internalTrack.id);
                if (trackData) {
                  return {
                    fragmentIndex: binarySearchExact(
                      this.internalTrack.fragments,
                      currentFragment.moofOffset,
                      (x) => x.moofOffset
                    ),
                    sampleIndex: 0,
                    correctSampleFound: true
                  };
                }
                currentFragment = currentFragment.nextFragment;
              }
            }
            return {
              fragmentIndex: -1,
              sampleIndex: -1,
              correctSampleFound: false
            };
          },
          -Infinity,
          // Use -Infinity as a search timestamp to avoid using the lookup entries
          Infinity,
          options
        );
      }
      return this.fetchPacketForSampleIndex(0, options);
    }
    mapTimestampIntoTimescale(timestamp) {
      return roundToPrecision(timestamp * this.internalTrack.timescale, 14) + this.internalTrack.editListOffset;
    }
    async getPacket(timestamp, options) {
      const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);
      if (this.internalTrack.demuxer.isFragmented) {
        return this.performFragmentedLookup(
          () => this.findSampleInFragmentsForTimestamp(timestampInTimescale),
          timestampInTimescale,
          timestampInTimescale,
          options
        );
      } else {
        const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
        const sampleIndex = getSampleIndexForTimestamp(sampleTable, timestampInTimescale);
        return this.fetchPacketForSampleIndex(sampleIndex, options);
      }
    }
    async getNextPacket(packet, options) {
      if (this.internalTrack.demuxer.isFragmented) {
        const locationInFragment = this.packetToFragmentLocation.get(packet);
        if (locationInFragment === void 0) {
          throw new Error("Packet was not created from this track.");
        }
        const trackData = locationInFragment.fragment.trackData.get(this.internalTrack.id);
        const fragmentSample = trackData.samples[locationInFragment.sampleIndex];
        const fragmentIndex = binarySearchExact(
          this.internalTrack.fragments,
          locationInFragment.fragment.moofOffset,
          (x) => x.moofOffset
        );
        assert(fragmentIndex !== -1);
        return this.performFragmentedLookup(
          () => {
            if (locationInFragment.sampleIndex + 1 < trackData.samples.length) {
              return {
                fragmentIndex,
                sampleIndex: locationInFragment.sampleIndex + 1,
                correctSampleFound: true
              };
            } else {
              let currentFragment = locationInFragment.fragment;
              while (currentFragment.nextFragment) {
                currentFragment = currentFragment.nextFragment;
                const trackData2 = currentFragment.trackData.get(this.internalTrack.id);
                if (trackData2) {
                  const fragmentIndex2 = binarySearchExact(
                    this.internalTrack.fragments,
                    currentFragment.moofOffset,
                    (x) => x.moofOffset
                  );
                  assert(fragmentIndex2 !== -1);
                  return {
                    fragmentIndex: fragmentIndex2,
                    sampleIndex: 0,
                    correctSampleFound: true
                  };
                }
              }
              return {
                fragmentIndex,
                sampleIndex: -1,
                correctSampleFound: false
              };
            }
          },
          fragmentSample.presentationTimestamp,
          Infinity,
          options
        );
      }
      const sampleIndex = this.packetToSampleIndex.get(packet);
      if (sampleIndex === void 0) {
        throw new Error("Packet was not created from this track.");
      }
      return this.fetchPacketForSampleIndex(sampleIndex + 1, options);
    }
    async getKeyPacket(timestamp, options) {
      const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);
      if (this.internalTrack.demuxer.isFragmented) {
        return this.performFragmentedLookup(
          () => this.findKeySampleInFragmentsForTimestamp(timestampInTimescale),
          timestampInTimescale,
          timestampInTimescale,
          options
        );
      }
      const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
      const sampleIndex = getSampleIndexForTimestamp(sampleTable, timestampInTimescale);
      const keyFrameSampleIndex = sampleIndex === -1 ? -1 : getRelevantKeyframeIndexForSample(sampleTable, sampleIndex);
      return this.fetchPacketForSampleIndex(keyFrameSampleIndex, options);
    }
    async getNextKeyPacket(packet, options) {
      if (this.internalTrack.demuxer.isFragmented) {
        const locationInFragment = this.packetToFragmentLocation.get(packet);
        if (locationInFragment === void 0) {
          throw new Error("Packet was not created from this track.");
        }
        const trackData = locationInFragment.fragment.trackData.get(this.internalTrack.id);
        const fragmentSample = trackData.samples[locationInFragment.sampleIndex];
        const fragmentIndex = binarySearchExact(
          this.internalTrack.fragments,
          locationInFragment.fragment.moofOffset,
          (x) => x.moofOffset
        );
        assert(fragmentIndex !== -1);
        return this.performFragmentedLookup(
          () => {
            const nextKeyFrameIndex = trackData.samples.findIndex(
              (x, i) => x.isKeyFrame && i > locationInFragment.sampleIndex
            );
            if (nextKeyFrameIndex !== -1) {
              return {
                fragmentIndex,
                sampleIndex: nextKeyFrameIndex,
                correctSampleFound: true
              };
            } else {
              let currentFragment = locationInFragment.fragment;
              while (currentFragment.nextFragment) {
                currentFragment = currentFragment.nextFragment;
                const trackData2 = currentFragment.trackData.get(this.internalTrack.id);
                if (trackData2) {
                  const fragmentIndex2 = binarySearchExact(
                    this.internalTrack.fragments,
                    currentFragment.moofOffset,
                    (x) => x.moofOffset
                  );
                  assert(fragmentIndex2 !== -1);
                  const keyFrameIndex = trackData2.samples.findIndex((x) => x.isKeyFrame);
                  if (keyFrameIndex === -1) {
                    throw new Error("Not supported: Fragment does not contain key sample.");
                  }
                  return {
                    fragmentIndex: fragmentIndex2,
                    sampleIndex: keyFrameIndex,
                    correctSampleFound: true
                  };
                }
              }
              return {
                fragmentIndex,
                sampleIndex: -1,
                correctSampleFound: false
              };
            }
          },
          fragmentSample.presentationTimestamp,
          Infinity,
          options
        );
      }
      const sampleIndex = this.packetToSampleIndex.get(packet);
      if (sampleIndex === void 0) {
        throw new Error("Packet was not created from this track.");
      }
      const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
      const nextKeyFrameSampleIndex = getNextKeyframeIndexForSample(sampleTable, sampleIndex);
      return this.fetchPacketForSampleIndex(nextKeyFrameSampleIndex, options);
    }
    async fetchPacketForSampleIndex(sampleIndex, options) {
      if (sampleIndex === -1) {
        return null;
      }
      const sampleTable = this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
      const sampleInfo = getSampleInfo(sampleTable, sampleIndex);
      if (!sampleInfo) {
        return null;
      }
      let data;
      if (options.metadataOnly) {
        data = PLACEHOLDER_DATA;
      } else {
        await this.internalTrack.demuxer.chunkReader.reader.loadRange(
          sampleInfo.chunkOffset,
          sampleInfo.chunkOffset + sampleInfo.chunkSize
        );
        this.internalTrack.demuxer.chunkReader.pos = sampleInfo.sampleOffset;
        data = this.internalTrack.demuxer.chunkReader.readBytes(sampleInfo.sampleSize);
      }
      const timestamp = (sampleInfo.presentationTimestamp - this.internalTrack.editListOffset) / this.internalTrack.timescale;
      const duration = sampleInfo.duration / this.internalTrack.timescale;
      const packet = new EncodedPacket(
        data,
        sampleInfo.isKeyFrame ? "key" : "delta",
        timestamp,
        duration,
        sampleIndex,
        sampleInfo.sampleSize
      );
      this.packetToSampleIndex.set(packet, sampleIndex);
      return packet;
    }
    async fetchPacketInFragment(fragment, sampleIndex, options) {
      if (sampleIndex === -1) {
        return null;
      }
      const trackData = fragment.trackData.get(this.internalTrack.id);
      const fragmentSample = trackData.samples[sampleIndex];
      assert(fragmentSample);
      let data;
      if (options.metadataOnly) {
        data = PLACEHOLDER_DATA;
      } else {
        await this.internalTrack.demuxer.chunkReader.reader.loadRange(fragment.dataStart, fragment.dataEnd);
        this.internalTrack.demuxer.chunkReader.pos = fragmentSample.byteOffset;
        data = this.internalTrack.demuxer.chunkReader.readBytes(fragmentSample.byteSize);
      }
      const timestamp = (fragmentSample.presentationTimestamp - this.internalTrack.editListOffset) / this.internalTrack.timescale;
      const duration = fragmentSample.duration / this.internalTrack.timescale;
      const packet = new EncodedPacket(
        data,
        fragmentSample.isKeyFrame ? "key" : "delta",
        timestamp,
        duration,
        fragment.moofOffset + sampleIndex,
        fragmentSample.byteSize
      );
      this.packetToFragmentLocation.set(packet, { fragment, sampleIndex });
      return packet;
    }
    findSampleInFragmentsForTimestamp(timestampInTimescale) {
      const fragmentIndex = binarySearchLessOrEqual(
        this.internalTrack.fragments,
        timestampInTimescale,
        (x) => x.trackData.get(this.internalTrack.id).startTimestamp
      );
      let sampleIndex = -1;
      let correctSampleFound = false;
      if (fragmentIndex !== -1) {
        const fragment = this.internalTrack.fragments[fragmentIndex];
        const trackData = fragment.trackData.get(this.internalTrack.id);
        const index = binarySearchLessOrEqual(
          trackData.presentationTimestamps,
          timestampInTimescale,
          (x) => x.presentationTimestamp
        );
        assert(index !== -1);
        sampleIndex = trackData.presentationTimestamps[index].sampleIndex;
        correctSampleFound = timestampInTimescale < trackData.endTimestamp;
      }
      return { fragmentIndex, sampleIndex, correctSampleFound };
    }
    findKeySampleInFragmentsForTimestamp(timestampInTimescale) {
      const fragmentIndex = binarySearchLessOrEqual(
        this.internalTrack.fragments,
        timestampInTimescale,
        (x) => x.trackData.get(this.internalTrack.id).startTimestamp
      );
      let sampleIndex = -1;
      let correctSampleFound = false;
      if (fragmentIndex !== -1) {
        const fragment = this.internalTrack.fragments[fragmentIndex];
        const trackData = fragment.trackData.get(this.internalTrack.id);
        const index = findLastIndex(trackData.presentationTimestamps, (x) => {
          const sample = trackData.samples[x.sampleIndex];
          return sample.isKeyFrame && x.presentationTimestamp <= timestampInTimescale;
        });
        if (index === -1) {
          throw new Error("Not supported: Fragment does not begin with a key sample.");
        }
        const entry = trackData.presentationTimestamps[index];
        sampleIndex = entry.sampleIndex;
        correctSampleFound = timestampInTimescale < trackData.endTimestamp;
      }
      return { fragmentIndex, sampleIndex, correctSampleFound };
    }
    /** Looks for a packet in the fragments while trying to load as few fragments as possible to retrieve it. */
    async performFragmentedLookup(getBestMatch, searchTimestamp, latestTimestamp, options) {
      const demuxer = this.internalTrack.demuxer;
      const release = await demuxer.fragmentLookupMutex.acquire();
      try {
        const { fragmentIndex, sampleIndex, correctSampleFound } = getBestMatch();
        if (correctSampleFound) {
          const fragment = this.internalTrack.fragments[fragmentIndex];
          return this.fetchPacketInFragment(fragment, sampleIndex, options);
        }
        const metadataReader = demuxer.metadataReader;
        const sourceSize = await metadataReader.reader.source._getSize();
        let prevFragment = null;
        let bestFragmentIndex = fragmentIndex;
        let bestSampleIndex = sampleIndex;
        const lookupEntryIndex = this.internalTrack.fragmentLookupTable ? binarySearchLessOrEqual(
          this.internalTrack.fragmentLookupTable,
          searchTimestamp,
          (x) => x.timestamp
        ) : -1;
        const lookupEntry = lookupEntryIndex !== -1 ? this.internalTrack.fragmentLookupTable[lookupEntryIndex] : null;
        let nextFragmentIsFirstFragment = false;
        if (fragmentIndex === -1) {
          metadataReader.pos = lookupEntry?.moofOffset ?? 0;
          nextFragmentIsFirstFragment = metadataReader.pos === 0;
        } else {
          const fragment = this.internalTrack.fragments[fragmentIndex];
          if (!lookupEntry || fragment.moofOffset >= lookupEntry.moofOffset) {
            metadataReader.pos = fragment.moofOffset + fragment.moofSize;
            prevFragment = fragment;
          } else {
            metadataReader.pos = lookupEntry.moofOffset;
          }
        }
        while (metadataReader.pos < sourceSize) {
          if (prevFragment) {
            const trackData = prevFragment.trackData.get(this.internalTrack.id);
            if (trackData && trackData.startTimestamp > latestTimestamp) {
              break;
            }
            if (prevFragment.nextFragment) {
              metadataReader.pos = prevFragment.nextFragment.moofOffset + prevFragment.nextFragment.moofSize;
              prevFragment = prevFragment.nextFragment;
              continue;
            }
          }
          await metadataReader.reader.loadRange(metadataReader.pos, metadataReader.pos + MAX_BOX_HEADER_SIZE);
          const startPos = metadataReader.pos;
          const boxInfo = metadataReader.readBoxHeader();
          if (boxInfo.name === "moof") {
            const index = binarySearchExact(demuxer.fragments, startPos, (x) => x.moofOffset);
            let fragment;
            if (index === -1) {
              metadataReader.pos = startPos;
              fragment = await demuxer.readFragment();
            } else {
              fragment = demuxer.fragments[index];
            }
            if (prevFragment) prevFragment.nextFragment = fragment;
            prevFragment = fragment;
            if (nextFragmentIsFirstFragment) {
              fragment.isKnownToBeFirstFragment = true;
              nextFragmentIsFirstFragment = false;
            }
            const { fragmentIndex: fragmentIndex2, sampleIndex: sampleIndex2, correctSampleFound: correctSampleFound2 } = getBestMatch();
            if (correctSampleFound2) {
              const fragment2 = this.internalTrack.fragments[fragmentIndex2];
              return this.fetchPacketInFragment(fragment2, sampleIndex2, options);
            }
            if (fragmentIndex2 !== -1) {
              bestFragmentIndex = fragmentIndex2;
              bestSampleIndex = sampleIndex2;
            }
          }
          metadataReader.pos = startPos + boxInfo.totalSize;
        }
        let result = null;
        const bestFragment = bestFragmentIndex !== -1 ? this.internalTrack.fragments[bestFragmentIndex] : null;
        if (bestFragment) {
          result = await this.fetchPacketInFragment(bestFragment, bestSampleIndex, options);
        }
        if (!result && lookupEntry && (!bestFragment || bestFragment.moofOffset < lookupEntry.moofOffset)) {
          const previousLookupEntry = this.internalTrack.fragmentLookupTable[lookupEntryIndex - 1];
          const newSearchTimestamp = previousLookupEntry?.timestamp ?? -Infinity;
          return this.performFragmentedLookup(getBestMatch, newSearchTimestamp, latestTimestamp, options);
        }
        return result;
      } finally {
        release();
      }
    }
  };
  var IsobmffVideoTrackBacking = class extends IsobmffTrackBacking {
    constructor(internalTrack) {
      super(internalTrack);
      this.decoderConfigPromise = null;
      this.internalTrack = internalTrack;
    }
    getCodec() {
      return this.internalTrack.info.codec;
    }
    getCodedWidth() {
      return this.internalTrack.info.width;
    }
    getCodedHeight() {
      return this.internalTrack.info.height;
    }
    getRotation() {
      return this.internalTrack.rotation;
    }
    async getColorSpace() {
      return {
        primaries: this.internalTrack.info.colorSpace?.primaries,
        transfer: this.internalTrack.info.colorSpace?.transfer,
        matrix: this.internalTrack.info.colorSpace?.matrix,
        fullRange: this.internalTrack.info.colorSpace?.fullRange
      };
    }
    async getDecoderConfig() {
      if (!this.internalTrack.info.codec) {
        return null;
      }
      return this.decoderConfigPromise ??= (async () => {
        if (this.internalTrack.info.codec === "vp9" && !this.internalTrack.info.vp9CodecInfo) {
          const firstPacket = await this.getFirstPacket({});
          this.internalTrack.info.vp9CodecInfo = firstPacket && extractVp9CodecInfoFromFrame(firstPacket.data);
        }
        return {
          codec: extractVideoCodecString(this.internalTrack.info),
          codedWidth: this.internalTrack.info.width,
          codedHeight: this.internalTrack.info.height,
          description: this.internalTrack.info.codecDescription ?? void 0,
          colorSpace: this.internalTrack.info.colorSpace ?? void 0
        };
      })();
    }
  };
  var IsobmffAudioTrackBacking = class extends IsobmffTrackBacking {
    constructor(internalTrack) {
      super(internalTrack);
      this.decoderConfig = null;
      this.internalTrack = internalTrack;
    }
    getCodec() {
      return this.internalTrack.info.codec;
    }
    getNumberOfChannels() {
      return this.internalTrack.info.numberOfChannels;
    }
    getSampleRate() {
      return this.internalTrack.info.sampleRate;
    }
    async getDecoderConfig() {
      if (!this.internalTrack.info.codec) {
        return null;
      }
      return this.decoderConfig ??= {
        codec: extractAudioCodecString(this.internalTrack.info),
        numberOfChannels: this.internalTrack.info.numberOfChannels,
        sampleRate: this.internalTrack.info.sampleRate,
        description: this.internalTrack.info.codecDescription ?? void 0
      };
    }
  };
  var getSampleIndexForTimestamp = (sampleTable, timescaleUnits) => {
    if (sampleTable.presentationTimestamps) {
      const index = binarySearchLessOrEqual(
        sampleTable.presentationTimestamps,
        timescaleUnits,
        (x) => x.presentationTimestamp
      );
      if (index === -1) {
        return -1;
      }
      return sampleTable.presentationTimestamps[index].sampleIndex;
    } else {
      const index = binarySearchLessOrEqual(
        sampleTable.sampleTimingEntries,
        timescaleUnits,
        (x) => x.startDecodeTimestamp
      );
      if (index === -1) {
        return -1;
      }
      const entry = sampleTable.sampleTimingEntries[index];
      return entry.startIndex + Math.min(Math.floor((timescaleUnits - entry.startDecodeTimestamp) / entry.delta), entry.count - 1);
    }
  };
  var getSampleInfo = (sampleTable, sampleIndex) => {
    const timingEntryIndex = binarySearchLessOrEqual(sampleTable.sampleTimingEntries, sampleIndex, (x) => x.startIndex);
    const timingEntry = sampleTable.sampleTimingEntries[timingEntryIndex];
    if (!timingEntry || timingEntry.startIndex + timingEntry.count <= sampleIndex) {
      return null;
    }
    const decodeTimestamp = timingEntry.startDecodeTimestamp + (sampleIndex - timingEntry.startIndex) * timingEntry.delta;
    let presentationTimestamp = decodeTimestamp;
    const offsetEntryIndex = binarySearchLessOrEqual(
      sampleTable.sampleCompositionTimeOffsets,
      sampleIndex,
      (x) => x.startIndex
    );
    const offsetEntry = sampleTable.sampleCompositionTimeOffsets[offsetEntryIndex];
    if (offsetEntry && sampleIndex - offsetEntry.startIndex < offsetEntry.count) {
      presentationTimestamp += offsetEntry.offset;
    }
    const sampleSize = sampleTable.sampleSizes[Math.min(sampleIndex, sampleTable.sampleSizes.length - 1)];
    const chunkEntryIndex = binarySearchLessOrEqual(sampleTable.sampleToChunk, sampleIndex, (x) => x.startSampleIndex);
    const chunkEntry = sampleTable.sampleToChunk[chunkEntryIndex];
    assert(chunkEntry);
    const chunkIndex = chunkEntry.startChunkIndex + Math.floor((sampleIndex - chunkEntry.startSampleIndex) / chunkEntry.samplesPerChunk);
    const chunkOffset = sampleTable.chunkOffsets[chunkIndex];
    const startSampleIndexOfChunk = chunkEntry.startSampleIndex + (chunkIndex - chunkEntry.startChunkIndex) * chunkEntry.samplesPerChunk;
    let chunkSize = 0;
    let sampleOffset = chunkOffset;
    if (sampleTable.sampleSizes.length === 1) {
      sampleOffset += sampleSize * (sampleIndex - startSampleIndexOfChunk);
      chunkSize += sampleSize * chunkEntry.samplesPerChunk;
    } else {
      for (let i = startSampleIndexOfChunk; i < startSampleIndexOfChunk + chunkEntry.samplesPerChunk; i++) {
        const sampleSize2 = sampleTable.sampleSizes[i];
        if (i < sampleIndex) {
          sampleOffset += sampleSize2;
        }
        chunkSize += sampleSize2;
      }
    }
    let duration = timingEntry.delta;
    if (sampleTable.presentationTimestamps) {
      const presentationIndex = sampleTable.presentationTimestampIndexMap[sampleIndex];
      assert(presentationIndex !== void 0);
      if (presentationIndex < sampleTable.presentationTimestamps.length - 1) {
        const nextEntry = sampleTable.presentationTimestamps[presentationIndex + 1];
        const nextPresentationTimestamp = nextEntry.presentationTimestamp;
        duration = nextPresentationTimestamp - presentationTimestamp;
      }
    }
    return {
      presentationTimestamp,
      duration,
      sampleOffset,
      sampleSize,
      chunkOffset,
      chunkSize,
      isKeyFrame: sampleTable.keySampleIndices ? binarySearchExact(sampleTable.keySampleIndices, sampleIndex, (x) => x) !== -1 : true
    };
  };
  var getRelevantKeyframeIndexForSample = (sampleTable, sampleIndex) => {
    if (!sampleTable.keySampleIndices) {
      return sampleIndex;
    }
    const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, (x) => x);
    return sampleTable.keySampleIndices[index] ?? -1;
  };
  var getNextKeyframeIndexForSample = (sampleTable, sampleIndex) => {
    if (!sampleTable.keySampleIndices) {
      return sampleIndex + 1;
    }
    const index = binarySearchLessOrEqual(sampleTable.keySampleIndices, sampleIndex, (x) => x);
    return sampleTable.keySampleIndices[index + 1] ?? -1;
  };
  var offsetFragmentTrackDataByTimestamp = (trackData, timestamp) => {
    trackData.startTimestamp += timestamp;
    trackData.endTimestamp += timestamp;
    for (const sample of trackData.samples) {
      sample.presentationTimestamp += timestamp;
    }
    for (const entry of trackData.presentationTimestamps) {
      entry.presentationTimestamp += timestamp;
    }
  };
  var extractRotationFromMatrix = (matrix) => {
    const [m11, , , m21] = matrix;
    const scaleX = Math.hypot(m11, m21);
    const cosTheta = m11 / scaleX;
    const sinTheta = m21 / scaleX;
    return -Math.atan2(sinTheta, cosTheta) * (180 / Math.PI);
  };

  // src/matroska/matroska-demuxer.ts
  var METADATA_ELEMENTS = [
    { id: 290298740 /* SeekHead */, flag: "seekHeadSeen" },
    { id: 357149030 /* Info */, flag: "infoSeen" },
    { id: 374648427 /* Tracks */, flag: "tracksSeen" },
    { id: 475249515 /* Cues */, flag: "cuesSeen" }
  ];
  var MatroskaDemuxer = class extends Demuxer {
    constructor(input) {
      super(input);
      this.readMetadataPromise = null;
      this.segments = [];
      this.currentSegment = null;
      this.currentTrack = null;
      this.currentCluster = null;
      this.currentBlock = null;
      this.currentCueTime = null;
      this.isWebM = false;
      this.metadataReader = new EBMLReader(input._mainReader);
      this.clusterReader = new EBMLReader(new Reader(input._source, 64 * 2 ** 20));
    }
    async computeDuration() {
      const tracks = await this.getTracks();
      const trackDurations = await Promise.all(tracks.map((x) => x.computeDuration()));
      return Math.max(0, ...trackDurations);
    }
    async getTracks() {
      await this.readMetadata();
      return this.segments.flatMap((segment) => segment.tracks.map((track) => track.inputTrack));
    }
    async getMimeType() {
      await this.readMetadata();
      const base = this.segments.some((segment) => segment.tracks.some((x) => x.info?.type === "video")) ? "video/" : this.segments.some((segment) => segment.tracks.some((x) => x.info?.type === "audio")) ? "audio/" : "application/";
      let string = base + (this.isWebM ? "webm" : "x-matroska");
      const tracks = await this.getTracks();
      if (tracks.length > 0) {
        const codecMimeTypes = await Promise.all(tracks.map((x) => x.getCodecParameterString()));
        const uniqueCodecMimeTypes = [...new Set(codecMimeTypes.filter(Boolean))];
        string += `; codecs="${uniqueCodecMimeTypes.join(", ")}"`;
      }
      return string;
    }
    assertDefinedSize(size) {
      if (size === -1) {
        throw new Error("Undefined element size is used in a place where it is not supported.");
      }
    }
    readMetadata() {
      return this.readMetadataPromise ??= (async () => {
        this.metadataReader.pos = 0;
        const fileSize = await this.input._source._getSize();
        while (this.metadataReader.pos < fileSize - MIN_HEADER_SIZE) {
          await this.metadataReader.reader.loadRange(
            this.metadataReader.pos,
            this.metadataReader.pos + MAX_HEADER_SIZE
          );
          const { id, size } = this.metadataReader.readElementHeader();
          const startPos = this.metadataReader.pos;
          if (id === 440786851 /* EBML */) {
            await this.metadataReader.reader.loadRange(this.metadataReader.pos, this.metadataReader.pos + size);
            this.readContiguousElements(this.metadataReader, size);
          } else if (id === 408125543 /* Segment */) {
            await this.readSegment(size);
            if (size === -1) {
              break;
            }
          }
          this.assertDefinedSize(size);
          this.metadataReader.pos = startPos + size;
        }
      })();
    }
    async readSegment(dataSize) {
      const segmentDataStart = this.metadataReader.pos;
      this.currentSegment = {
        seekHeadSeen: false,
        infoSeen: false,
        tracksSeen: false,
        cuesSeen: false,
        timestampScale: -1,
        timestampFactor: -1,
        duration: -1,
        seekEntries: [],
        tracks: [],
        cuePoints: [],
        dataStartPos: segmentDataStart,
        elementEndPos: dataSize === -1 ? await this.input._source._getSize() - MIN_HEADER_SIZE : segmentDataStart + dataSize,
        clusterSeekStartPos: segmentDataStart,
        clusters: [],
        clusterLookupMutex: new AsyncMutex()
      };
      this.segments.push(this.currentSegment);
      await this.metadataReader.reader.loadRange(
        this.metadataReader.pos,
        this.metadataReader.pos + 2 ** 14
      );
      let clusterEncountered = false;
      while (this.metadataReader.pos < this.currentSegment.elementEndPos) {
        await this.metadataReader.reader.loadRange(
          this.metadataReader.pos,
          this.metadataReader.pos + MAX_HEADER_SIZE
        );
        const elementStartPos = this.metadataReader.pos;
        const { id, size } = this.metadataReader.readElementHeader();
        const dataStartPos = this.metadataReader.pos;
        const metadataElementIndex = METADATA_ELEMENTS.findIndex((x) => x.id === id);
        if (metadataElementIndex !== -1) {
          const field = METADATA_ELEMENTS[metadataElementIndex].flag;
          this.currentSegment[field] = true;
          await this.metadataReader.reader.loadRange(this.metadataReader.pos, this.metadataReader.pos + size);
          this.readContiguousElements(this.metadataReader, size);
        } else if (id === 524531317 /* Cluster */) {
          if (!clusterEncountered) {
            clusterEncountered = true;
            this.currentSegment.clusterSeekStartPos = elementStartPos;
          }
        }
        if (this.currentSegment.infoSeen && this.currentSegment.tracksSeen && this.currentSegment.cuesSeen) {
          break;
        }
        if (this.currentSegment.seekHeadSeen) {
          let hasInfo = this.currentSegment.infoSeen;
          let hasTracks = this.currentSegment.tracksSeen;
          let hasCues = this.currentSegment.cuesSeen;
          for (const entry of this.currentSegment.seekEntries) {
            if (entry.id === 357149030 /* Info */) {
              hasInfo = true;
            } else if (entry.id === 374648427 /* Tracks */) {
              hasTracks = true;
            } else if (entry.id === 475249515 /* Cues */) {
              hasCues = true;
            }
          }
          if (hasInfo && hasTracks && hasCues) {
            break;
          }
        }
        this.assertDefinedSize(size);
        this.metadataReader.pos = dataStartPos + size;
        if (!clusterEncountered) {
          this.currentSegment.clusterSeekStartPos = this.metadataReader.pos;
        }
      }
      for (const target of METADATA_ELEMENTS) {
        if (this.currentSegment[target.flag]) continue;
        const seekEntry = this.currentSegment.seekEntries.find((entry) => entry.id === target.id);
        if (!seekEntry) continue;
        this.metadataReader.pos = segmentDataStart + seekEntry.segmentPosition;
        await this.metadataReader.reader.loadRange(
          this.metadataReader.pos,
          this.metadataReader.pos + 2 ** 12
          // Load a larger range, assuming the correct element will be there
        );
        const { id, size } = this.metadataReader.readElementHeader();
        if (id !== target.id) continue;
        this.currentSegment[target.flag] = true;
        await this.metadataReader.reader.loadRange(this.metadataReader.pos, this.metadataReader.pos + size);
        this.readContiguousElements(this.metadataReader, size);
      }
      this.currentSegment.tracks.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      this.currentSegment.cuePoints.sort((a, b) => a.clusterPosition - b.clusterPosition);
      const allTrackIds = this.currentSegment.tracks.map((x) => x.id);
      const remainingTrackIds = /* @__PURE__ */ new Set();
      let lastClusterPosition = null;
      let lastCuePoint = null;
      for (const cuePoint of this.currentSegment.cuePoints) {
        if (cuePoint.clusterPosition !== lastClusterPosition) {
          for (const id of remainingTrackIds) {
            assert(lastCuePoint);
            const track2 = this.currentSegment.tracks.find((x) => x.id === id);
            track2.cuePoints.push(lastCuePoint);
          }
          for (const id of allTrackIds) {
            remainingTrackIds.add(id);
          }
        }
        lastCuePoint = cuePoint;
        if (!remainingTrackIds.has(cuePoint.trackId)) {
          continue;
        }
        const track = this.currentSegment.tracks.find((x) => x.id === cuePoint.trackId);
        track.cuePoints.push(cuePoint);
        remainingTrackIds.delete(cuePoint.trackId);
        lastClusterPosition = cuePoint.clusterPosition;
      }
      for (const id of remainingTrackIds) {
        assert(lastCuePoint);
        const track = this.currentSegment.tracks.find((x) => x.id === id);
        track.cuePoints.push(lastCuePoint);
      }
      for (const track of this.currentSegment.tracks) {
        track.cuePoints.sort((a, b) => a.time - b.time);
      }
      this.currentSegment = null;
    }
    async readCluster(segment) {
      await this.metadataReader.reader.loadRange(this.metadataReader.pos, this.metadataReader.pos + MAX_HEADER_SIZE);
      const elementStartPos = this.metadataReader.pos;
      const { id, size } = this.metadataReader.readElementHeader();
      const dataStartPos = this.metadataReader.pos;
      assert(id === 524531317 /* Cluster */);
      this.clusterReader.pos = dataStartPos;
      await this.clusterReader.reader.loadRange(this.clusterReader.pos, this.clusterReader.pos + size);
      const cluster = {
        elementStartPos,
        elementEndPos: dataStartPos + size,
        dataStartPos,
        timestamp: -1,
        trackData: /* @__PURE__ */ new Map(),
        nextCluster: null,
        isKnownToBeFirstCluster: false
      };
      this.currentCluster = cluster;
      this.readContiguousElements(this.clusterReader, size);
      for (const [trackId, trackData] of cluster.trackData) {
        let blockReferencesExist = false;
        assert(trackData.blocks.length > 0);
        for (let i = 0; i < trackData.blocks.length; i++) {
          const block = trackData.blocks[i];
          block.timestamp += cluster.timestamp;
          blockReferencesExist ||= block.referencedTimestamps.length > 0;
        }
        if (blockReferencesExist) {
          trackData.blocks = sortBlocksByReferences(trackData.blocks);
        }
        trackData.presentationTimestamps = trackData.blocks.map((block, i) => ({ timestamp: block.timestamp, blockIndex: i })).sort((a, b) => a.timestamp - b.timestamp);
        let hasKeyFrame = false;
        for (let i = 0; i < trackData.presentationTimestamps.length; i++) {
          const entry = trackData.presentationTimestamps[i];
          const block = trackData.blocks[entry.blockIndex];
          if (block.isKeyFrame) {
            hasKeyFrame = true;
            if (trackData.firstKeyFrameTimestamp === null && block.isKeyFrame) {
              trackData.firstKeyFrameTimestamp = block.timestamp;
            }
          }
          if (i < trackData.presentationTimestamps.length - 1) {
            const nextEntry = trackData.presentationTimestamps[i + 1];
            const nextBlock = trackData.blocks[nextEntry.blockIndex];
            block.duration = nextBlock.timestamp - block.timestamp;
          }
        }
        const firstBlock = trackData.blocks[trackData.presentationTimestamps[0].blockIndex];
        const lastBlock = trackData.blocks[last(trackData.presentationTimestamps).blockIndex];
        trackData.startTimestamp = firstBlock.timestamp;
        trackData.endTimestamp = lastBlock.timestamp + lastBlock.duration;
        const track = segment.tracks.find((x) => x.id === trackId);
        if (track) {
          const insertionIndex2 = binarySearchLessOrEqual(
            track.clusters,
            cluster.timestamp,
            (x) => x.timestamp
          );
          track.clusters.splice(insertionIndex2 + 1, 0, cluster);
          if (hasKeyFrame) {
            const insertionIndex3 = binarySearchLessOrEqual(
              track.clustersWithKeyFrame,
              cluster.timestamp,
              (x) => x.timestamp
            );
            track.clustersWithKeyFrame.splice(insertionIndex3 + 1, 0, cluster);
          }
        }
      }
      const insertionIndex = binarySearchLessOrEqual(
        segment.clusters,
        elementStartPos,
        (x) => x.elementStartPos
      );
      segment.clusters.splice(insertionIndex + 1, 0, cluster);
      this.currentCluster = null;
      return cluster;
    }
    getTrackDataInCluster(cluster, trackNumber) {
      let trackData = cluster.trackData.get(trackNumber);
      if (!trackData) {
        trackData = {
          startTimestamp: 0,
          endTimestamp: 0,
          firstKeyFrameTimestamp: null,
          blocks: [],
          presentationTimestamps: []
        };
        cluster.trackData.set(trackNumber, trackData);
      }
      return trackData;
    }
    readContiguousElements(reader, totalSize) {
      const startIndex = reader.pos;
      while (reader.pos - startIndex < totalSize) {
        this.traverseElement(reader);
      }
    }
    traverseElement(reader) {
      const { id, size } = reader.readElementHeader();
      const dataStartPos = reader.pos;
      switch (id) {
        case 17026 /* DocType */:
          {
            this.isWebM = reader.readString(size) === "webm";
          }
          ;
          break;
        case 19899 /* Seek */:
          {
            if (!this.currentSegment) break;
            const seekEntry = { id: -1, segmentPosition: -1 };
            this.currentSegment.seekEntries.push(seekEntry);
            this.readContiguousElements(reader, size);
            if (seekEntry.id === -1 || seekEntry.segmentPosition === -1) {
              this.currentSegment.seekEntries.pop();
            }
          }
          ;
          break;
        case 21419 /* SeekID */:
          {
            const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
            if (!lastSeekEntry) break;
            lastSeekEntry.id = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 21420 /* SeekPosition */:
          {
            const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
            if (!lastSeekEntry) break;
            lastSeekEntry.segmentPosition = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 2807729 /* TimestampScale */:
          {
            if (!this.currentSegment) break;
            this.currentSegment.timestampScale = reader.readUnsignedInt(size);
            this.currentSegment.timestampFactor = 1e9 / this.currentSegment.timestampScale;
          }
          ;
          break;
        case 17545 /* Duration */:
          {
            if (!this.currentSegment) break;
            this.currentSegment.duration = reader.readFloat(size);
          }
          ;
          break;
        case 174 /* TrackEntry */:
          {
            if (!this.currentSegment) break;
            this.currentTrack = {
              id: -1,
              segment: this.currentSegment,
              demuxer: this,
              clusters: [],
              clustersWithKeyFrame: [],
              cuePoints: [],
              isDefault: false,
              inputTrack: null,
              codecId: null,
              codecPrivate: null,
              languageCode: UNDETERMINED_LANGUAGE,
              info: null
            };
            this.readContiguousElements(reader, size);
            if (this.currentTrack && this.currentTrack.id !== -1 && this.currentTrack.codecId && this.currentTrack.info) {
              const slashIndex = this.currentTrack.codecId.indexOf("/");
              const codecIdWithoutSuffix = slashIndex === -1 ? this.currentTrack.codecId : this.currentTrack.codecId.slice(0, slashIndex);
              if (this.currentTrack.info.type === "video" && this.currentTrack.info.width !== -1 && this.currentTrack.info.height !== -1) {
                if (this.currentTrack.codecId === CODEC_STRING_MAP.avc) {
                  this.currentTrack.info.codec = "avc";
                } else if (this.currentTrack.codecId === CODEC_STRING_MAP.hevc) {
                  this.currentTrack.info.codec = "hevc";
                } else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp8) {
                  this.currentTrack.info.codec = "vp8";
                } else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp9) {
                  this.currentTrack.info.codec = "vp9";
                } else if (codecIdWithoutSuffix === CODEC_STRING_MAP.av1) {
                  this.currentTrack.info.codec = "av1";
                }
                const videoTrack = this.currentTrack;
                const inputTrack = new InputVideoTrack(new MatroskaVideoTrackBacking(videoTrack));
                this.currentTrack.inputTrack = inputTrack;
                this.currentSegment.tracks.push(this.currentTrack);
              } else if (this.currentTrack.info.type === "audio" && this.currentTrack.info.numberOfChannels !== -1 && this.currentTrack.info.sampleRate !== -1) {
                if (codecIdWithoutSuffix === CODEC_STRING_MAP.aac) {
                  this.currentTrack.info.codec = "aac";
                  this.currentTrack.info.aacCodecInfo = {
                    isMpeg2: this.currentTrack.codecId.includes("MPEG2")
                  };
                } else if (this.currentTrack.codecId === CODEC_STRING_MAP.mp3) {
                  this.currentTrack.info.codec = "mp3";
                } else if (codecIdWithoutSuffix === CODEC_STRING_MAP.opus) {
                  this.currentTrack.info.codec = "opus";
                } else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vorbis) {
                  this.currentTrack.info.codec = "vorbis";
                } else if (codecIdWithoutSuffix === CODEC_STRING_MAP.flac) {
                  this.currentTrack.info.codec = "flac";
                } else if (this.currentTrack.codecId === "A_PCM/INT/LIT") {
                  if (this.currentTrack.info.bitDepth === 8) {
                    this.currentTrack.info.codec = "pcm-u8";
                  } else if (this.currentTrack.info.bitDepth === 16) {
                    this.currentTrack.info.codec = "pcm-s16";
                  } else if (this.currentTrack.info.bitDepth === 24) {
                    this.currentTrack.info.codec = "pcm-s24";
                  } else if (this.currentTrack.info.bitDepth === 32) {
                    this.currentTrack.info.codec = "pcm-s32";
                  }
                } else if (this.currentTrack.codecId === "A_PCM/INT/BIG") {
                  if (this.currentTrack.info.bitDepth === 8) {
                    this.currentTrack.info.codec = "pcm-u8";
                  } else if (this.currentTrack.info.bitDepth === 16) {
                    this.currentTrack.info.codec = "pcm-s16be";
                  } else if (this.currentTrack.info.bitDepth === 24) {
                    this.currentTrack.info.codec = "pcm-s24be";
                  } else if (this.currentTrack.info.bitDepth === 32) {
                    this.currentTrack.info.codec = "pcm-s32be";
                  }
                } else if (this.currentTrack.codecId === "A_PCM/FLOAT/IEEE") {
                  if (this.currentTrack.info.bitDepth === 32) {
                    this.currentTrack.info.codec = "pcm-f32";
                  }
                }
                const audioTrack = this.currentTrack;
                const inputTrack = new InputAudioTrack(new MatroskaAudioTrackBacking(audioTrack));
                this.currentTrack.inputTrack = inputTrack;
                this.currentSegment.tracks.push(this.currentTrack);
              }
            }
            this.currentTrack = null;
          }
          ;
          break;
        case 215 /* TrackNumber */:
          {
            if (!this.currentTrack) break;
            this.currentTrack.id = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 131 /* TrackType */:
          {
            if (!this.currentTrack) break;
            const type = reader.readUnsignedInt(size);
            if (type === 1) {
              this.currentTrack.info = {
                type: "video",
                width: -1,
                height: -1,
                rotation: 0,
                codec: null,
                colorSpace: null
              };
            } else if (type === 2) {
              this.currentTrack.info = {
                type: "audio",
                numberOfChannels: -1,
                sampleRate: -1,
                bitDepth: -1,
                codec: null,
                aacCodecInfo: null
              };
            }
          }
          ;
          break;
        case 185 /* FlagEnabled */:
          {
            if (!this.currentTrack) break;
            const enabled = reader.readUnsignedInt(size);
            if (!enabled) {
              this.currentSegment.tracks.pop();
              this.currentTrack = null;
            }
          }
          ;
          break;
        case 136 /* FlagDefault */:
          {
            if (!this.currentTrack) break;
            this.currentTrack.isDefault = !!reader.readUnsignedInt(size);
          }
          ;
          break;
        case 134 /* CodecID */:
          {
            if (!this.currentTrack) break;
            this.currentTrack.codecId = reader.readString(size);
          }
          ;
          break;
        case 25506 /* CodecPrivate */:
          {
            if (!this.currentTrack) break;
            this.currentTrack.codecPrivate = reader.readBytes(size);
          }
          ;
          break;
        case 2274716 /* Language */:
          {
            if (!this.currentTrack) break;
            this.currentTrack.languageCode = reader.readString(size);
            if (!isIso639Dash2LanguageCode(this.currentTrack.languageCode)) {
              this.currentTrack.languageCode = UNDETERMINED_LANGUAGE;
            }
          }
          ;
          break;
        case 224 /* Video */:
          {
            if (this.currentTrack?.info?.type !== "video") break;
            this.readContiguousElements(reader, size);
          }
          ;
          break;
        case 176 /* PixelWidth */:
          {
            if (this.currentTrack?.info?.type !== "video") break;
            this.currentTrack.info.width = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 186 /* PixelHeight */:
          {
            if (this.currentTrack?.info?.type !== "video") break;
            this.currentTrack.info.height = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 21936 /* Colour */:
          {
            if (this.currentTrack?.info?.type !== "video") break;
            this.currentTrack.info.colorSpace = {};
            this.readContiguousElements(reader, size);
          }
          ;
          break;
        case 21937 /* MatrixCoefficients */:
          {
            if (this.currentTrack?.info?.type !== "video" || !this.currentTrack.info.colorSpace) break;
            const matrixCoefficients = reader.readUnsignedInt(size);
            const mapped = MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients] ?? null;
            this.currentTrack.info.colorSpace.matrix = mapped;
          }
          ;
          break;
        case 21945 /* Range */:
          {
            if (this.currentTrack?.info?.type !== "video" || !this.currentTrack.info.colorSpace) break;
            this.currentTrack.info.colorSpace.fullRange = reader.readUnsignedInt(size) === 2;
          }
          ;
          break;
        case 21946 /* TransferCharacteristics */:
          {
            if (this.currentTrack?.info?.type !== "video" || !this.currentTrack.info.colorSpace) break;
            const transferCharacteristics = reader.readUnsignedInt(size);
            const mapped = TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics] ?? null;
            this.currentTrack.info.colorSpace.transfer = mapped;
          }
          ;
          break;
        case 21947 /* Primaries */:
          {
            if (this.currentTrack?.info?.type !== "video" || !this.currentTrack.info.colorSpace) break;
            const primaries = reader.readUnsignedInt(size);
            const mapped = COLOR_PRIMARIES_MAP_INVERSE[primaries] ?? null;
            this.currentTrack.info.colorSpace.primaries = mapped;
          }
          ;
          break;
        case 30320 /* Projection */:
          {
            if (this.currentTrack?.info?.type !== "video") break;
            this.readContiguousElements(reader, size);
          }
          ;
          break;
        case 30325 /* ProjectionPoseRoll */:
          {
            if (this.currentTrack?.info?.type !== "video") break;
            const rotation = reader.readFloat(size);
            const flippedRotation = -rotation;
            try {
              this.currentTrack.info.rotation = normalizeRotation(flippedRotation);
            } catch {
            }
          }
          ;
          break;
        case 225 /* Audio */:
          {
            if (this.currentTrack?.info?.type !== "audio") break;
            this.readContiguousElements(reader, size);
          }
          ;
          break;
        case 181 /* SamplingFrequency */:
          {
            if (this.currentTrack?.info?.type !== "audio") break;
            this.currentTrack.info.sampleRate = reader.readFloat(size);
          }
          ;
          break;
        case 159 /* Channels */:
          {
            if (this.currentTrack?.info?.type !== "audio") break;
            this.currentTrack.info.numberOfChannels = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 25188 /* BitDepth */:
          {
            if (this.currentTrack?.info?.type !== "audio") break;
            this.currentTrack.info.bitDepth = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 187 /* CuePoint */:
          {
            if (!this.currentSegment) break;
            this.readContiguousElements(reader, size);
            this.currentCueTime = null;
          }
          ;
          break;
        case 179 /* CueTime */:
          {
            this.currentCueTime = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 183 /* CueTrackPositions */:
          {
            if (this.currentCueTime === null) break;
            assert(this.currentSegment);
            const cuePoint = { time: this.currentCueTime, trackId: -1, clusterPosition: -1 };
            this.currentSegment.cuePoints.push(cuePoint);
            this.readContiguousElements(reader, size);
            if (cuePoint.trackId === -1 || cuePoint.clusterPosition === -1) {
              this.currentSegment.cuePoints.pop();
            }
          }
          ;
          break;
        case 247 /* CueTrack */:
          {
            const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
            if (!lastCuePoint) break;
            lastCuePoint.trackId = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 241 /* CueClusterPosition */:
          {
            const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
            if (!lastCuePoint) break;
            assert(this.currentSegment);
            lastCuePoint.clusterPosition = this.currentSegment.dataStartPos + reader.readUnsignedInt(size);
          }
          ;
          break;
        case 231 /* Timestamp */:
          {
            if (!this.currentCluster) break;
            this.currentCluster.timestamp = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 163 /* SimpleBlock */:
          {
            if (!this.currentCluster) break;
            const trackNumber = reader.readVarInt();
            const relativeTimestamp = reader.readS16();
            const flags = reader.readU8();
            const isKeyFrame = !!(flags & 128);
            const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
            trackData.blocks.push({
              timestamp: relativeTimestamp,
              // We'll add the cluster's timestamp to this later
              duration: 0,
              isKeyFrame,
              referencedTimestamps: [],
              data: reader.readBytes(size - (reader.pos - dataStartPos))
            });
          }
          ;
          break;
        case 160 /* BlockGroup */:
          {
            if (!this.currentCluster) break;
            this.readContiguousElements(reader, size);
            if (this.currentBlock) {
              for (let i = 0; i < this.currentBlock.referencedTimestamps.length; i++) {
                this.currentBlock.referencedTimestamps[i] += this.currentBlock.timestamp;
              }
              this.currentBlock = null;
            }
          }
          ;
          break;
        case 161 /* Block */:
          {
            if (!this.currentCluster) break;
            const trackNumber = reader.readVarInt();
            const relativeTimestamp = reader.readS16();
            const flags = reader.readU8();
            const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
            this.currentBlock = {
              timestamp: relativeTimestamp,
              // We'll add the cluster's timestamp to this later
              duration: 0,
              isKeyFrame: true,
              referencedTimestamps: [],
              data: reader.readBytes(size - (reader.pos - dataStartPos))
            };
            trackData.blocks.push(this.currentBlock);
          }
          ;
          break;
        case 155 /* BlockDuration */:
          {
            if (!this.currentBlock) break;
            this.currentBlock.duration = reader.readUnsignedInt(size);
          }
          ;
          break;
        case 251 /* ReferenceBlock */:
          {
            if (!this.currentBlock) break;
            this.currentBlock.isKeyFrame = false;
            const relativeTimestamp = reader.readSignedInt(size);
            this.currentBlock.referencedTimestamps.push(relativeTimestamp);
          }
          ;
          break;
      }
      this.assertDefinedSize(size);
      reader.pos = dataStartPos + size;
    }
  };
  var MatroskaTrackBacking = class {
    constructor(internalTrack) {
      this.internalTrack = internalTrack;
      this.packetToClusterLocation = /* @__PURE__ */ new WeakMap();
    }
    getId() {
      return this.internalTrack.id;
    }
    getCodec() {
      throw new Error("Not implemented on base class.");
    }
    async computeDuration() {
      const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
      return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
    }
    getLanguageCode() {
      return this.internalTrack.languageCode;
    }
    async getFirstTimestamp() {
      const firstPacket = await this.getFirstPacket({ metadataOnly: true });
      return firstPacket?.timestamp ?? 0;
    }
    getTimeResolution() {
      return this.internalTrack.segment.timestampFactor;
    }
    async getFirstPacket(options) {
      return this.performClusterLookup(
        () => {
          const startCluster = this.internalTrack.segment.clusters[0] ?? null;
          if (startCluster?.isKnownToBeFirstCluster) {
            let currentCluster = startCluster;
            while (currentCluster) {
              const trackData = currentCluster.trackData.get(this.internalTrack.id);
              if (trackData) {
                return {
                  clusterIndex: binarySearchExact(
                    this.internalTrack.clusters,
                    currentCluster.elementStartPos,
                    (x) => x.elementStartPos
                  ),
                  blockIndex: 0,
                  correctBlockFound: true
                };
              }
              currentCluster = currentCluster.nextCluster;
            }
          }
          return {
            clusterIndex: -1,
            blockIndex: -1,
            correctBlockFound: false
          };
        },
        -Infinity,
        // Use -Infinity as a search timestamp to avoid using the cues
        Infinity,
        options
      );
    }
    intoTimescale(timestamp) {
      return roundToPrecision(timestamp * this.internalTrack.segment.timestampFactor, 14);
    }
    async getPacket(timestamp, options) {
      const timestampInTimescale = this.intoTimescale(timestamp);
      return this.performClusterLookup(
        () => this.findBlockInClustersForTimestamp(timestampInTimescale),
        timestampInTimescale,
        timestampInTimescale,
        options
      );
    }
    async getNextPacket(packet, options) {
      const locationInCluster = this.packetToClusterLocation.get(packet);
      if (locationInCluster === void 0) {
        throw new Error("Packet was not created from this track.");
      }
      const trackData = locationInCluster.cluster.trackData.get(this.internalTrack.id);
      const block = trackData.blocks[locationInCluster.blockIndex];
      const clusterIndex = binarySearchExact(
        this.internalTrack.clusters,
        locationInCluster.cluster.elementStartPos,
        (x) => x.elementStartPos
      );
      assert(clusterIndex !== -1);
      return this.performClusterLookup(
        () => {
          if (locationInCluster.blockIndex + 1 < trackData.blocks.length) {
            return {
              clusterIndex,
              blockIndex: locationInCluster.blockIndex + 1,
              correctBlockFound: true
            };
          } else {
            let currentCluster = locationInCluster.cluster;
            while (currentCluster.nextCluster) {
              currentCluster = currentCluster.nextCluster;
              const trackData2 = currentCluster.trackData.get(this.internalTrack.id);
              if (trackData2) {
                const clusterIndex2 = binarySearchExact(
                  this.internalTrack.clusters,
                  currentCluster.elementStartPos,
                  (x) => x.elementStartPos
                );
                assert(clusterIndex2 !== -1);
                return {
                  clusterIndex: clusterIndex2,
                  blockIndex: 0,
                  correctBlockFound: true
                };
              }
            }
            return {
              clusterIndex,
              blockIndex: -1,
              correctBlockFound: false
            };
          }
        },
        block.timestamp,
        Infinity,
        options
      );
    }
    async getKeyPacket(timestamp, options) {
      const timestampInTimescale = this.intoTimescale(timestamp);
      return this.performClusterLookup(
        () => this.findKeyBlockInClustersForTimestamp(timestampInTimescale),
        timestampInTimescale,
        timestampInTimescale,
        options
      );
    }
    async getNextKeyPacket(packet, options) {
      const locationInCluster = this.packetToClusterLocation.get(packet);
      if (locationInCluster === void 0) {
        throw new Error("Packet was not created from this track.");
      }
      const trackData = locationInCluster.cluster.trackData.get(this.internalTrack.id);
      const block = trackData.blocks[locationInCluster.blockIndex];
      const clusterIndex = binarySearchExact(
        this.internalTrack.clusters,
        locationInCluster.cluster.elementStartPos,
        (x) => x.elementStartPos
      );
      assert(clusterIndex !== -1);
      return this.performClusterLookup(
        () => {
          const nextKeyFrameIndex = trackData.blocks.findIndex(
            (x, i) => x.isKeyFrame && i > locationInCluster.blockIndex
          );
          if (nextKeyFrameIndex !== -1) {
            return {
              clusterIndex,
              blockIndex: nextKeyFrameIndex,
              correctBlockFound: true
            };
          } else {
            let currentCluster = locationInCluster.cluster;
            while (currentCluster.nextCluster) {
              currentCluster = currentCluster.nextCluster;
              const trackData2 = currentCluster.trackData.get(this.internalTrack.id);
              if (trackData2 && trackData2.firstKeyFrameTimestamp !== null) {
                const clusterIndex2 = binarySearchExact(
                  this.internalTrack.clusters,
                  currentCluster.elementStartPos,
                  (x) => x.elementStartPos
                );
                assert(clusterIndex2 !== -1);
                const keyFrameIndex = trackData2.blocks.findIndex((x) => x.isKeyFrame);
                assert(keyFrameIndex !== -1);
                return {
                  clusterIndex: clusterIndex2,
                  blockIndex: keyFrameIndex,
                  correctBlockFound: true
                };
              }
            }
            return {
              clusterIndex,
              blockIndex: -1,
              correctBlockFound: false
            };
          }
        },
        block.timestamp,
        Infinity,
        options
      );
    }
    async fetchPacketInCluster(cluster, blockIndex, options) {
      if (blockIndex === -1) {
        return null;
      }
      const trackData = cluster.trackData.get(this.internalTrack.id);
      const block = trackData.blocks[blockIndex];
      assert(block);
      const data = options.metadataOnly ? PLACEHOLDER_DATA : block.data;
      const timestamp = block.timestamp / this.internalTrack.segment.timestampFactor;
      const duration = block.duration / this.internalTrack.segment.timestampFactor;
      const packet = new EncodedPacket(
        data,
        block.isKeyFrame ? "key" : "delta",
        timestamp,
        duration,
        cluster.dataStartPos + blockIndex,
        block.data.byteLength
      );
      this.packetToClusterLocation.set(packet, { cluster, blockIndex });
      return packet;
    }
    findBlockInClustersForTimestamp(timestampInTimescale) {
      const clusterIndex = binarySearchLessOrEqual(
        this.internalTrack.clusters,
        timestampInTimescale,
        (x) => x.trackData.get(this.internalTrack.id).startTimestamp
      );
      let blockIndex = -1;
      let correctBlockFound = false;
      if (clusterIndex !== -1) {
        const cluster = this.internalTrack.clusters[clusterIndex];
        const trackData = cluster.trackData.get(this.internalTrack.id);
        const index = binarySearchLessOrEqual(
          trackData.presentationTimestamps,
          timestampInTimescale,
          (x) => x.timestamp
        );
        assert(index !== -1);
        blockIndex = trackData.presentationTimestamps[index].blockIndex;
        correctBlockFound = timestampInTimescale < trackData.endTimestamp;
      }
      return { clusterIndex, blockIndex, correctBlockFound };
    }
    findKeyBlockInClustersForTimestamp(timestampInTimescale) {
      const indexInKeyFrameClusters = binarySearchLessOrEqual(
        this.internalTrack.clustersWithKeyFrame,
        timestampInTimescale,
        (x) => x.trackData.get(this.internalTrack.id).firstKeyFrameTimestamp
      );
      let clusterIndex = -1;
      let blockIndex = -1;
      let correctBlockFound = false;
      if (indexInKeyFrameClusters !== -1) {
        const cluster = this.internalTrack.clustersWithKeyFrame[indexInKeyFrameClusters];
        clusterIndex = binarySearchExact(
          this.internalTrack.clusters,
          cluster.elementStartPos,
          (x) => x.elementStartPos
        );
        assert(clusterIndex !== -1);
        const trackData = cluster.trackData.get(this.internalTrack.id);
        const index = findLastIndex(trackData.presentationTimestamps, (x) => {
          const block = trackData.blocks[x.blockIndex];
          return block.isKeyFrame && x.timestamp <= timestampInTimescale;
        });
        assert(index !== -1);
        const entry = trackData.presentationTimestamps[index];
        blockIndex = entry.blockIndex;
        correctBlockFound = timestampInTimescale < trackData.endTimestamp;
      }
      return { clusterIndex, blockIndex, correctBlockFound };
    }
    /** Looks for a packet in the clusters while trying to load as few clusters as possible to retrieve it. */
    async performClusterLookup(getBestMatch, searchTimestamp, latestTimestamp, options) {
      const { demuxer, segment } = this.internalTrack;
      const release = await segment.clusterLookupMutex.acquire();
      try {
        const { clusterIndex, blockIndex, correctBlockFound } = getBestMatch();
        if (correctBlockFound) {
          const cluster = this.internalTrack.clusters[clusterIndex];
          return this.fetchPacketInCluster(cluster, blockIndex, options);
        }
        const metadataReader = demuxer.metadataReader;
        let prevCluster = null;
        let bestClusterIndex = clusterIndex;
        let bestBlockIndex = blockIndex;
        const cuePointIndex = binarySearchLessOrEqual(
          this.internalTrack.cuePoints,
          searchTimestamp,
          (x) => x.time
        );
        const cuePoint = cuePointIndex !== -1 ? this.internalTrack.cuePoints[cuePointIndex] : null;
        let nextClusterIsFirstCluster = false;
        if (clusterIndex === -1) {
          metadataReader.pos = cuePoint?.clusterPosition ?? segment.clusterSeekStartPos;
          nextClusterIsFirstCluster = metadataReader.pos === segment.clusterSeekStartPos;
        } else {
          const cluster = this.internalTrack.clusters[clusterIndex];
          if (!cuePoint || cluster.elementStartPos >= cuePoint.clusterPosition) {
            metadataReader.pos = cluster.elementEndPos;
            prevCluster = cluster;
          } else {
            metadataReader.pos = cuePoint.clusterPosition;
          }
        }
        while (metadataReader.pos < segment.elementEndPos) {
          if (prevCluster) {
            const trackData = prevCluster.trackData.get(this.internalTrack.id);
            if (trackData && trackData.startTimestamp > latestTimestamp) {
              break;
            }
            if (prevCluster.nextCluster) {
              metadataReader.pos = prevCluster.nextCluster.elementEndPos;
              prevCluster = prevCluster.nextCluster;
              continue;
            }
          }
          await metadataReader.reader.loadRange(metadataReader.pos, metadataReader.pos + MAX_HEADER_SIZE);
          const elementStartPos = metadataReader.pos;
          const { id, size } = metadataReader.readElementHeader();
          const dataStartPos = metadataReader.pos;
          if (id === 524531317 /* Cluster */) {
            const index = binarySearchExact(segment.clusters, elementStartPos, (x) => x.elementStartPos);
            let cluster;
            if (index === -1) {
              metadataReader.pos = elementStartPos;
              cluster = await demuxer.readCluster(segment);
            } else {
              cluster = segment.clusters[index];
            }
            if (prevCluster) prevCluster.nextCluster = cluster;
            prevCluster = cluster;
            if (nextClusterIsFirstCluster) {
              cluster.isKnownToBeFirstCluster = true;
              nextClusterIsFirstCluster = false;
            }
            const { clusterIndex: clusterIndex2, blockIndex: blockIndex2, correctBlockFound: correctBlockFound2 } = getBestMatch();
            if (correctBlockFound2) {
              const cluster2 = this.internalTrack.clusters[clusterIndex2];
              return this.fetchPacketInCluster(cluster2, blockIndex2, options);
            }
            if (clusterIndex2 !== -1) {
              bestClusterIndex = clusterIndex2;
              bestBlockIndex = blockIndex2;
            }
          }
          metadataReader.pos = dataStartPos + size;
        }
        let result = null;
        const bestCluster = bestClusterIndex !== -1 ? this.internalTrack.clusters[bestClusterIndex] : null;
        if (bestCluster) {
          result = await this.fetchPacketInCluster(bestCluster, bestBlockIndex, options);
        }
        if (!result && cuePoint && (!bestCluster || bestCluster.elementStartPos < cuePoint.clusterPosition)) {
          const previousCuePoint = this.internalTrack.cuePoints[cuePointIndex - 1];
          const newSearchTimestamp = previousCuePoint?.time ?? -Infinity;
          return this.performClusterLookup(getBestMatch, newSearchTimestamp, latestTimestamp, options);
        }
        return result;
      } finally {
        release();
      }
    }
  };
  var MatroskaVideoTrackBacking = class extends MatroskaTrackBacking {
    constructor(internalTrack) {
      super(internalTrack);
      this.decoderConfigPromise = null;
      this.internalTrack = internalTrack;
    }
    getCodec() {
      return this.internalTrack.info.codec;
    }
    getCodedWidth() {
      return this.internalTrack.info.width;
    }
    getCodedHeight() {
      return this.internalTrack.info.height;
    }
    getRotation() {
      return this.internalTrack.info.rotation;
    }
    async getColorSpace() {
      return {
        primaries: this.internalTrack.info.colorSpace?.primaries,
        transfer: this.internalTrack.info.colorSpace?.transfer,
        matrix: this.internalTrack.info.colorSpace?.matrix,
        fullRange: this.internalTrack.info.colorSpace?.fullRange
      };
    }
    async getDecoderConfig() {
      if (!this.internalTrack.info.codec) {
        return null;
      }
      return this.decoderConfigPromise ??= (async () => {
        let firstPacket = null;
        const needsPacketForAdditionalInfo = this.internalTrack.info.codec === "vp9" || this.internalTrack.info.codec === "av1";
        if (needsPacketForAdditionalInfo) {
          firstPacket = await this.getFirstPacket({});
        }
        return {
          codec: extractVideoCodecString({
            width: this.internalTrack.info.width,
            height: this.internalTrack.info.height,
            codec: this.internalTrack.info.codec,
            codecDescription: this.internalTrack.codecPrivate,
            colorSpace: this.internalTrack.info.colorSpace,
            vp9CodecInfo: this.internalTrack.info.codec === "vp9" && firstPacket ? extractVp9CodecInfoFromFrame(firstPacket.data) : null,
            av1CodecInfo: this.internalTrack.info.codec === "av1" && firstPacket ? extractAv1CodecInfoFromFrame(firstPacket.data) : null
          }),
          codedWidth: this.internalTrack.info.width,
          codedHeight: this.internalTrack.info.height,
          description: this.internalTrack.codecPrivate ?? void 0,
          colorSpace: this.internalTrack.info.colorSpace ?? void 0
        };
      })();
    }
  };
  var MatroskaAudioTrackBacking = class extends MatroskaTrackBacking {
    constructor(internalTrack) {
      super(internalTrack);
      this.decoderConfig = null;
      this.internalTrack = internalTrack;
    }
    getCodec() {
      return this.internalTrack.info.codec;
    }
    getNumberOfChannels() {
      return this.internalTrack.info.numberOfChannels;
    }
    getSampleRate() {
      return this.internalTrack.info.sampleRate;
    }
    async getDecoderConfig() {
      if (!this.internalTrack.info.codec) {
        return null;
      }
      return this.decoderConfig ??= {
        codec: extractAudioCodecString({
          codec: this.internalTrack.info.codec,
          codecDescription: this.internalTrack.codecPrivate,
          aacCodecInfo: this.internalTrack.info.aacCodecInfo
        }),
        numberOfChannels: this.internalTrack.info.numberOfChannels,
        sampleRate: this.internalTrack.info.sampleRate,
        description: this.internalTrack.codecPrivate ?? void 0
      };
    }
  };
  var sortBlocksByReferences = (blocks) => {
    const timestampToBlock = /* @__PURE__ */ new Map();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      timestampToBlock.set(block.timestamp, block);
    }
    const processedBlocks = /* @__PURE__ */ new Set();
    const result = [];
    const processBlock = (block) => {
      if (processedBlocks.has(block)) {
        return;
      }
      processedBlocks.add(block);
      for (let j = 0; j < block.referencedTimestamps.length; j++) {
        const timestamp = block.referencedTimestamps[j];
        const otherBlock = timestampToBlock.get(timestamp);
        if (!otherBlock) {
          continue;
        }
        processBlock(otherBlock);
      }
      result.push(block);
    };
    for (let i = 0; i < blocks.length; i++) {
      processBlock(blocks[i]);
    }
    return result;
  };

  // src/mp3/mp3-reader.ts
  var Mp3Reader = class {
    constructor(reader) {
      this.reader = reader;
      this.pos = 0;
      this.fileSize = null;
    }
    readBytes(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      return new Uint8Array(view2.buffer, offset, length);
    }
    readU16() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 2);
      this.pos += 2;
      return view2.getUint16(offset, false);
    }
    readU32() {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + 4);
      this.pos += 4;
      return view2.getUint32(offset, false);
    }
    readAscii(length) {
      const { view: view2, offset } = this.reader.getViewAndOffset(this.pos, this.pos + length);
      this.pos += length;
      let str = "";
      for (let i = 0; i < length; i++) {
        str += String.fromCharCode(view2.getUint8(offset + i));
      }
      return str;
    }
    readId3() {
      const tag = this.readAscii(3);
      if (tag !== "ID3") {
        this.pos -= 3;
        return null;
      }
      this.pos += 3;
      const size = decodeSynchsafe(this.readU32());
      return { size };
    }
    readNextFrameHeader(until) {
      assert(this.fileSize);
      until ??= this.fileSize;
      while (this.pos < until - FRAME_HEADER_SIZE) {
        const word = this.readU32();
        this.pos -= 4;
        const header = readFrameHeader(word, this);
        if (header) {
          return header;
        }
      }
      return null;
    }
  };
  var decodeSynchsafe = (synchsafed) => {
    let mask = 2130706432;
    let unsynchsafed = 0;
    while (mask !== 0) {
      unsynchsafed >>= 1;
      unsynchsafed |= synchsafed & mask;
      mask >>= 8;
    }
    return unsynchsafed;
  };

  // src/mp3/mp3-demuxer.ts
  var Mp3Demuxer = class extends Demuxer {
    constructor(input) {
      super(input);
      this.metadataPromise = null;
      this.firstFrameHeader = null;
      this.allSamples = [];
      this.tracks = [];
      this.reader = new Mp3Reader(input._mainReader);
    }
    async readMetadata() {
      return this.metadataPromise ??= (async () => {
        const fileSize = await this.input._source._getSize();
        this.reader.fileSize = fileSize;
        await this.reader.reader.loadRange(0, fileSize);
        const id3Tag = this.reader.readId3();
        if (id3Tag) {
          this.reader.pos += id3Tag.size;
        }
        let nextTimestampInSamples = 0;
        while (true) {
          const header = this.reader.readNextFrameHeader();
          if (!header) {
            break;
          }
          const xingOffset = getXingOffset(header.mpegVersionId, header.channel);
          this.reader.pos = header.startPos + xingOffset;
          const word = this.reader.readU32();
          const isXing = word === XING || word === INFO;
          this.reader.pos = header.startPos + header.totalSize - 1;
          if (isXing) {
            continue;
          }
          if (!this.firstFrameHeader) {
            this.firstFrameHeader = header;
          }
          const sampleDuration = header.audioSamplesInFrame / header.sampleRate;
          const sample = {
            timestamp: nextTimestampInSamples / header.sampleRate,
            duration: sampleDuration,
            dataStart: header.startPos,
            dataSize: header.totalSize
          };
          this.allSamples.push(sample);
          nextTimestampInSamples += header.audioSamplesInFrame;
        }
        if (!this.firstFrameHeader) {
          throw new Error("No MP3 frames found.");
        }
        this.tracks = [new InputAudioTrack(new Mp3AudioTrackBacking(this))];
      })();
    }
    async getMimeType() {
      return "audio/mpeg";
    }
    async getTracks() {
      await this.readMetadata();
      return this.tracks;
    }
    async computeDuration() {
      await this.readMetadata();
      const lastSample = last(this.allSamples);
      assert(lastSample);
      return lastSample.timestamp + lastSample.duration;
    }
  };
  var Mp3AudioTrackBacking = class {
    constructor(demuxer) {
      this.demuxer = demuxer;
    }
    getId() {
      return 1;
    }
    async getFirstTimestamp() {
      return 0;
    }
    getTimeResolution() {
      assert(this.demuxer.firstFrameHeader);
      return this.demuxer.firstFrameHeader.sampleRate / this.demuxer.firstFrameHeader.audioSamplesInFrame;
    }
    computeDuration() {
      return this.demuxer.computeDuration();
    }
    getLanguageCode() {
      return UNDETERMINED_LANGUAGE;
    }
    getCodec() {
      return "mp3";
    }
    getNumberOfChannels() {
      assert(this.demuxer.firstFrameHeader);
      return this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2;
    }
    getSampleRate() {
      assert(this.demuxer.firstFrameHeader);
      return this.demuxer.firstFrameHeader.sampleRate;
    }
    async getDecoderConfig() {
      assert(this.demuxer.firstFrameHeader);
      return {
        codec: "mp3",
        numberOfChannels: this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2,
        sampleRate: this.demuxer.firstFrameHeader.sampleRate
      };
    }
    getPacketAtIndex(sampleIndex, options) {
      if (sampleIndex === -1) {
        return null;
      }
      const rawSample = this.demuxer.allSamples[sampleIndex];
      if (!rawSample) {
        return null;
      }
      let data;
      if (options.metadataOnly) {
        data = PLACEHOLDER_DATA;
      } else {
        this.demuxer.reader.pos = rawSample.dataStart;
        data = this.demuxer.reader.readBytes(rawSample.dataSize);
      }
      return new EncodedPacket(
        data,
        "key",
        rawSample.timestamp,
        rawSample.duration,
        sampleIndex
      );
    }
    async getFirstPacket(options) {
      return this.getPacketAtIndex(0, options);
    }
    async getNextPacket(packet, options) {
      const sampleIndex = binarySearchExact(
        this.demuxer.allSamples,
        packet.timestamp,
        (x) => x.timestamp
      );
      if (sampleIndex === -1) {
        throw new Error("Packet was not created from this track.");
      }
      return this.getPacketAtIndex(sampleIndex + 1, options);
    }
    async getPacket(timestamp, options) {
      const index = binarySearchLessOrEqual(
        this.demuxer.allSamples,
        timestamp,
        (x) => x.timestamp
      );
      return this.getPacketAtIndex(index, options);
    }
    getKeyPacket(timestamp, options) {
      return this.getPacket(timestamp, options);
    }
    getNextKeyPacket(packet, options) {
      return this.getNextPacket(packet, options);
    }
  };

  // src/ogg/ogg-demuxer.ts
  var OggDemuxer = class extends Demuxer {
    constructor(input) {
      super(input);
      this.metadataPromise = null;
      this.fileSize = null;
      this.bitstreams = [];
      this.tracks = [];
      this.reader = new OggReader(new Reader(input._source, 64 * 2 ** 20));
    }
    async readMetadata() {
      return this.metadataPromise ??= (async () => {
        this.fileSize = await this.input._source._getSize();
        while (this.reader.pos < this.fileSize - MIN_PAGE_HEADER_SIZE) {
          await this.reader.reader.loadRange(
            this.reader.pos,
            this.reader.pos + MAX_PAGE_HEADER_SIZE
          );
          const page = this.reader.readPageHeader();
          if (!page) {
            break;
          }
          const isBos = !!(page.headerType & 2);
          if (!isBos) {
            break;
          }
          this.bitstreams.push({
            serialNumber: page.serialNumber,
            bosPage: page,
            description: null,
            numberOfChannels: -1,
            sampleRate: -1,
            codecInfo: {
              codec: null,
              vorbisInfo: null,
              opusInfo: null
            },
            lastMetadataPacket: null
          });
          this.reader.pos = page.headerStartPos + page.totalSize;
        }
        for (const bitstream of this.bitstreams) {
          const firstPacket = await this.readPacket(this.reader, bitstream.bosPage, 0);
          if (!firstPacket) {
            continue;
          }
          if (
            // Check for Vorbis
            firstPacket.data.byteLength >= 7 && firstPacket.data[0] === 1 && firstPacket.data[1] === 118 && firstPacket.data[2] === 111 && firstPacket.data[3] === 114 && firstPacket.data[4] === 98 && firstPacket.data[5] === 105 && firstPacket.data[6] === 115
          ) {
            await this.readVorbisMetadata(firstPacket, bitstream);
          } else if (
            // Check for Opus
            firstPacket.data.byteLength >= 8 && firstPacket.data[0] === 79 && firstPacket.data[1] === 112 && firstPacket.data[2] === 117 && firstPacket.data[3] === 115 && firstPacket.data[4] === 72 && firstPacket.data[5] === 101 && firstPacket.data[6] === 97 && firstPacket.data[7] === 100
          ) {
            await this.readOpusMetadata(firstPacket, bitstream);
          }
          if (bitstream.codecInfo.codec !== null) {
            this.tracks.push(new InputAudioTrack(new OggAudioTrackBacking(bitstream, this)));
          }
        }
      })();
    }
    async readVorbisMetadata(firstPacket, bitstream) {
      let nextPacketPosition = await this.findNextPacketStart(this.reader, firstPacket);
      if (!nextPacketPosition) {
        return;
      }
      const secondPacket = await this.readPacket(
        this.reader,
        nextPacketPosition.startPage,
        nextPacketPosition.startSegmentIndex
      );
      if (!secondPacket) {
        return;
      }
      nextPacketPosition = await this.findNextPacketStart(this.reader, secondPacket);
      if (!nextPacketPosition) {
        return;
      }
      const thirdPacket = await this.readPacket(
        this.reader,
        nextPacketPosition.startPage,
        nextPacketPosition.startSegmentIndex
      );
      if (!thirdPacket) {
        return;
      }
      if (secondPacket.data[0] !== 3 || thirdPacket.data[0] !== 5) {
        return;
      }
      const lacingValues = [];
      const addBytesToSegmentTable = (bytes2) => {
        while (true) {
          lacingValues.push(Math.min(255, bytes2));
          if (bytes2 < 255) {
            break;
          }
          bytes2 -= 255;
        }
      };
      addBytesToSegmentTable(firstPacket.data.length);
      addBytesToSegmentTable(secondPacket.data.length);
      const description = new Uint8Array(
        1 + lacingValues.length + firstPacket.data.length + secondPacket.data.length + thirdPacket.data.length
      );
      description[0] = lacingValues.length;
      description.set(
        lacingValues,
        1
      );
      description.set(
        firstPacket.data,
        1 + lacingValues.length
      );
      description.set(
        secondPacket.data,
        1 + lacingValues.length + firstPacket.data.length
      );
      description.set(
        thirdPacket.data,
        1 + lacingValues.length + firstPacket.data.length + secondPacket.data.length
      );
      bitstream.codecInfo.codec = "vorbis";
      bitstream.description = description;
      bitstream.lastMetadataPacket = thirdPacket;
      const view2 = toDataView(firstPacket.data);
      bitstream.numberOfChannels = view2.getUint8(11);
      bitstream.sampleRate = view2.getUint32(12, true);
      const blockSizeByte = view2.getUint8(28);
      bitstream.codecInfo.vorbisInfo = {
        blocksizes: [
          1 << (blockSizeByte & 15),
          1 << (blockSizeByte >> 4)
        ],
        modeBlockflags: parseModesFromVorbisSetupPacket(thirdPacket.data).modeBlockflags
      };
    }
    async readOpusMetadata(firstPacket, bitstream) {
      const nextPacketPosition = await this.findNextPacketStart(this.reader, firstPacket);
      if (!nextPacketPosition) {
        return;
      }
      const secondPacket = await this.readPacket(
        this.reader,
        nextPacketPosition.startPage,
        nextPacketPosition.startSegmentIndex
      );
      if (!secondPacket) {
        return;
      }
      bitstream.codecInfo.codec = "opus";
      bitstream.description = firstPacket.data;
      bitstream.lastMetadataPacket = secondPacket;
      const header = parseOpusIdentificationHeader(firstPacket.data);
      bitstream.numberOfChannels = header.outputChannelCount;
      bitstream.sampleRate = header.inputSampleRate;
      bitstream.codecInfo.opusInfo = {
        preSkip: header.preSkip
      };
    }
    async readPacket(reader, startPage, startSegmentIndex) {
      assert(startSegmentIndex < startPage.lacingValues.length);
      assert(this.fileSize);
      let startDataOffset = 0;
      for (let i = 0; i < startSegmentIndex; i++) {
        startDataOffset += startPage.lacingValues[i];
      }
      let currentPage = startPage;
      let currentDataOffset = startDataOffset;
      let currentSegmentIndex = startSegmentIndex;
      const chunks = [];
      outer:
        while (true) {
          await reader.reader.loadRange(
            currentPage.dataStartPos,
            currentPage.dataStartPos + currentPage.dataSize
          );
          reader.pos = currentPage.dataStartPos;
          const pageData = reader.readBytes(currentPage.dataSize);
          while (true) {
            if (currentSegmentIndex === currentPage.lacingValues.length) {
              chunks.push(pageData.subarray(startDataOffset, currentDataOffset));
              break;
            }
            const lacingValue = currentPage.lacingValues[currentSegmentIndex];
            currentDataOffset += lacingValue;
            if (lacingValue < 255) {
              chunks.push(pageData.subarray(startDataOffset, currentDataOffset));
              break outer;
            }
            currentSegmentIndex++;
          }
          while (true) {
            reader.pos = currentPage.headerStartPos + currentPage.totalSize;
            if (reader.pos >= this.fileSize - MIN_PAGE_HEADER_SIZE) {
              return null;
            }
            await reader.reader.loadRange(reader.pos, reader.pos + MAX_PAGE_HEADER_SIZE);
            const nextPage = reader.readPageHeader();
            if (!nextPage) {
              return null;
            }
            currentPage = nextPage;
            if (currentPage.serialNumber === startPage.serialNumber) {
              break;
            }
          }
          startDataOffset = 0;
          currentDataOffset = 0;
          currentSegmentIndex = 0;
        }
      const totalPacketSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const packetData = new Uint8Array(totalPacketSize);
      let offset = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        packetData.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        data: packetData,
        endPage: currentPage,
        endSegmentIndex: currentSegmentIndex
      };
    }
    async findNextPacketStart(reader, lastPacket) {
      assert(this.fileSize !== null);
      if (lastPacket.endSegmentIndex < lastPacket.endPage.lacingValues.length - 1) {
        return { startPage: lastPacket.endPage, startSegmentIndex: lastPacket.endSegmentIndex + 1 };
      }
      const isEos = !!(lastPacket.endPage.headerType & 4);
      if (isEos) {
        return null;
      }
      reader.pos = lastPacket.endPage.headerStartPos + lastPacket.endPage.totalSize;
      while (true) {
        if (reader.pos >= this.fileSize - MIN_PAGE_HEADER_SIZE) {
          return null;
        }
        await reader.reader.loadRange(reader.pos, reader.pos + MAX_PAGE_HEADER_SIZE);
        const nextPage = reader.readPageHeader();
        if (!nextPage) {
          return null;
        }
        if (nextPage.serialNumber === lastPacket.endPage.serialNumber) {
          return { startPage: nextPage, startSegmentIndex: 0 };
        }
        reader.pos = nextPage.headerStartPos + nextPage.totalSize;
      }
    }
    async getMimeType() {
      await this.readMetadata();
      let string = "audio/ogg";
      if (this.tracks.length > 0) {
        const codecMimeTypes = await Promise.all(this.tracks.map((x) => x.getCodecParameterString()));
        const uniqueCodecMimeTypes = [...new Set(codecMimeTypes.filter(Boolean))];
        string += `; codecs="${uniqueCodecMimeTypes.join(", ")}"`;
      }
      return string;
    }
    async getTracks() {
      await this.readMetadata();
      return this.tracks;
    }
    async computeDuration() {
      const tracks = await this.getTracks();
      const trackDurations = await Promise.all(tracks.map((x) => x.computeDuration()));
      return Math.max(0, ...trackDurations);
    }
  };
  var OggAudioTrackBacking = class {
    constructor(bitstream, demuxer) {
      this.bitstream = bitstream;
      this.demuxer = demuxer;
      this.encodedPacketToMetadata = /* @__PURE__ */ new WeakMap();
      this.internalSampleRate = bitstream.codecInfo.codec === "opus" ? OPUS_INTERNAL_SAMPLE_RATE : bitstream.sampleRate;
    }
    getId() {
      return this.bitstream.serialNumber;
    }
    getNumberOfChannels() {
      return this.bitstream.numberOfChannels;
    }
    getSampleRate() {
      return this.bitstream.sampleRate;
    }
    getTimeResolution() {
      return this.bitstream.sampleRate;
    }
    getCodec() {
      return this.bitstream.codecInfo.codec;
    }
    async getDecoderConfig() {
      assert(this.bitstream.codecInfo.codec);
      return {
        codec: this.bitstream.codecInfo.codec,
        numberOfChannels: this.bitstream.numberOfChannels,
        sampleRate: this.bitstream.sampleRate,
        description: this.bitstream.description ?? void 0
      };
    }
    getLanguageCode() {
      return UNDETERMINED_LANGUAGE;
    }
    async getFirstTimestamp() {
      return 0;
    }
    async computeDuration() {
      const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
      return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
    }
    granulePositionToTimestampInSamples(granulePosition) {
      if (this.bitstream.codecInfo.codec === "opus") {
        assert(this.bitstream.codecInfo.opusInfo);
        return granulePosition - this.bitstream.codecInfo.opusInfo.preSkip;
      }
      return granulePosition;
    }
    createEncodedPacketFromOggPacket(packet, additional, options) {
      if (!packet) {
        return null;
      }
      const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
        packet.data,
        this.bitstream.codecInfo,
        additional.vorbisLastBlocksize
      );
      const encodedPacket = new EncodedPacket(
        options.metadataOnly ? PLACEHOLDER_DATA : packet.data,
        "key",
        Math.max(0, additional.timestampInSamples) / this.internalSampleRate,
        durationInSamples / this.internalSampleRate,
        packet.endPage.headerStartPos + packet.endSegmentIndex
      );
      this.encodedPacketToMetadata.set(encodedPacket, {
        packet,
        timestampInSamples: additional.timestampInSamples,
        durationInSamples,
        vorbisBlockSize
      });
      return encodedPacket;
    }
    async getFirstPacket(options) {
      assert(this.bitstream.lastMetadataPacket);
      const packetPosition = await this.demuxer.findNextPacketStart(
        this.demuxer.reader,
        this.bitstream.lastMetadataPacket
      );
      if (!packetPosition) {
        return null;
      }
      let timestampInSamples = 0;
      if (this.bitstream.codecInfo.codec === "opus") {
        assert(this.bitstream.codecInfo.opusInfo);
        timestampInSamples -= this.bitstream.codecInfo.opusInfo.preSkip;
      }
      const packet = await this.demuxer.readPacket(
        this.demuxer.reader,
        packetPosition.startPage,
        packetPosition.startSegmentIndex
      );
      return this.createEncodedPacketFromOggPacket(
        packet,
        {
          timestampInSamples,
          vorbisLastBlocksize: null
        },
        options
      );
    }
    async getNextPacket(prevPacket, options) {
      const prevMetadata = this.encodedPacketToMetadata.get(prevPacket);
      if (!prevMetadata) {
        throw new Error("Packet was not created from this track.");
      }
      const packetPosition = await this.demuxer.findNextPacketStart(this.demuxer.reader, prevMetadata.packet);
      if (!packetPosition) {
        return null;
      }
      const timestampInSamples = prevMetadata.timestampInSamples + prevMetadata.durationInSamples;
      const packet = await this.demuxer.readPacket(
        this.demuxer.reader,
        packetPosition.startPage,
        packetPosition.startSegmentIndex
      );
      return this.createEncodedPacketFromOggPacket(
        packet,
        {
          timestampInSamples,
          vorbisLastBlocksize: prevMetadata.vorbisBlockSize
        },
        options
      );
    }
    async getPacket(timestamp, options) {
      assert(this.demuxer.fileSize !== null);
      const timestampInSamples = roundToPrecision(timestamp * this.internalSampleRate, 14);
      if (timestampInSamples === 0) {
        return this.getFirstPacket(options);
      }
      if (timestampInSamples < 0) {
        return null;
      }
      const reader = this.demuxer.reader;
      assert(this.bitstream.lastMetadataPacket);
      const startPosition = await this.demuxer.findNextPacketStart(
        reader,
        this.bitstream.lastMetadataPacket
      );
      if (!startPosition) {
        return null;
      }
      let lowPage = startPosition.startPage;
      let high = this.demuxer.fileSize;
      const lowPages = [lowPage];
      outer:
        while (lowPage.headerStartPos + lowPage.totalSize < high) {
          const low = lowPage.headerStartPos;
          const mid = Math.floor((low + high) / 2);
          let searchStartPos = mid;
          while (true) {
            const until = Math.min(
              searchStartPos + MAX_PAGE_SIZE,
              high - MIN_PAGE_HEADER_SIZE
            );
            await reader.reader.loadRange(searchStartPos, until);
            reader.pos = searchStartPos;
            const found = reader.findNextPageHeader(until);
            if (!found) {
              high = mid + MIN_PAGE_HEADER_SIZE;
              continue outer;
            }
            await reader.reader.loadRange(reader.pos, reader.pos + MAX_PAGE_HEADER_SIZE);
            const page = reader.readPageHeader();
            assert(page);
            let pageValid = false;
            if (page.serialNumber === this.bitstream.serialNumber) {
              pageValid = true;
            } else {
              await reader.reader.loadRange(page.headerStartPos, page.headerStartPos + page.totalSize);
              reader.pos = page.headerStartPos;
              const bytes2 = reader.readBytes(page.totalSize);
              const crc = computeOggPageCrc(bytes2);
              pageValid = crc === page.checksum;
            }
            if (!pageValid) {
              searchStartPos = page.headerStartPos + 4;
              continue;
            }
            if (pageValid && page.serialNumber !== this.bitstream.serialNumber) {
              searchStartPos = page.headerStartPos + page.totalSize;
              continue;
            }
            const isContinuationPage = page.granulePosition === -1;
            if (isContinuationPage) {
              searchStartPos = page.headerStartPos + page.totalSize;
              continue;
            }
            if (this.granulePositionToTimestampInSamples(page.granulePosition) > timestampInSamples) {
              high = page.headerStartPos;
            } else {
              lowPage = page;
              lowPages.push(page);
            }
            continue outer;
          }
        }
      let lowerPage = startPosition.startPage;
      for (const otherLowPage of lowPages) {
        if (otherLowPage.granulePosition === lowPage.granulePosition) {
          break;
        }
        if (!lowerPage || otherLowPage.headerStartPos > lowerPage.headerStartPos) {
          lowerPage = otherLowPage;
        }
      }
      let currentPage = lowerPage;
      const previousPages = [currentPage];
      while (true) {
        if (currentPage.serialNumber === this.bitstream.serialNumber && currentPage.granulePosition === lowPage.granulePosition) {
          break;
        }
        reader.pos = currentPage.headerStartPos + currentPage.totalSize;
        await reader.reader.loadRange(reader.pos, reader.pos + MAX_PAGE_HEADER_SIZE);
        const nextPage = reader.readPageHeader();
        assert(nextPage);
        currentPage = nextPage;
        if (currentPage.serialNumber === this.bitstream.serialNumber) {
          previousPages.push(currentPage);
        }
      }
      assert(currentPage.granulePosition !== -1);
      let currentSegmentIndex = null;
      let currentTimestampInSamples;
      let currentTimestampIsCorrect;
      let endPage = currentPage;
      let endSegmentIndex = 0;
      if (currentPage.headerStartPos === startPosition.startPage.headerStartPos) {
        currentTimestampInSamples = this.granulePositionToTimestampInSamples(0);
        currentTimestampIsCorrect = true;
        currentSegmentIndex = 0;
      } else {
        currentTimestampInSamples = 0;
        currentTimestampIsCorrect = false;
        for (let i = currentPage.lacingValues.length - 1; i >= 0; i--) {
          const value = currentPage.lacingValues[i];
          if (value < 255) {
            currentSegmentIndex = i + 1;
            break;
          }
        }
        if (currentSegmentIndex === null) {
          throw new Error("Invalid page with granule position: no packets end on this page.");
        }
        endSegmentIndex = currentSegmentIndex - 1;
        const pseudopacket = {
          data: PLACEHOLDER_DATA,
          endPage,
          endSegmentIndex
        };
        const nextPosition = await this.demuxer.findNextPacketStart(reader, pseudopacket);
        if (nextPosition) {
          const endPosition = findPreviousPacketEndPosition(previousPages, currentPage, currentSegmentIndex);
          assert(endPosition);
          const startPosition2 = findPacketStartPosition(
            previousPages,
            endPosition.page,
            endPosition.segmentIndex
          );
          if (startPosition2) {
            currentPage = startPosition2.page;
            currentSegmentIndex = startPosition2.segmentIndex;
          }
        } else {
          while (true) {
            const endPosition = findPreviousPacketEndPosition(previousPages, currentPage, currentSegmentIndex);
            if (!endPosition) {
              break;
            }
            const startPosition2 = findPacketStartPosition(
              previousPages,
              endPosition.page,
              endPosition.segmentIndex
            );
            if (!startPosition2) {
              break;
            }
            currentPage = startPosition2.page;
            currentSegmentIndex = startPosition2.segmentIndex;
            if (endPosition.page.headerStartPos !== endPage.headerStartPos) {
              endPage = endPosition.page;
              endSegmentIndex = endPosition.segmentIndex;
              break;
            }
          }
        }
      }
      let lastEncodedPacket = null;
      let lastEncodedPacketMetadata = null;
      while (currentPage !== null) {
        assert(currentSegmentIndex !== null);
        const packet = await this.demuxer.readPacket(reader, currentPage, currentSegmentIndex);
        if (!packet) {
          break;
        }
        const skipPacket = currentPage.headerStartPos === startPosition.startPage.headerStartPos && currentSegmentIndex < startPosition.startSegmentIndex;
        if (!skipPacket) {
          let encodedPacket = this.createEncodedPacketFromOggPacket(
            packet,
            {
              timestampInSamples: currentTimestampInSamples,
              vorbisLastBlocksize: lastEncodedPacketMetadata?.vorbisBlockSize ?? null
            },
            options
          );
          assert(encodedPacket);
          let encodedPacketMetadata = this.encodedPacketToMetadata.get(encodedPacket);
          assert(encodedPacketMetadata);
          if (!currentTimestampIsCorrect && packet.endPage.headerStartPos === endPage.headerStartPos && packet.endSegmentIndex === endSegmentIndex) {
            currentTimestampInSamples = this.granulePositionToTimestampInSamples(currentPage.granulePosition);
            currentTimestampIsCorrect = true;
            encodedPacket = this.createEncodedPacketFromOggPacket(
              packet,
              {
                timestampInSamples: currentTimestampInSamples - encodedPacketMetadata.durationInSamples,
                vorbisLastBlocksize: lastEncodedPacketMetadata?.vorbisBlockSize ?? null
              },
              options
            );
            assert(encodedPacket);
            encodedPacketMetadata = this.encodedPacketToMetadata.get(encodedPacket);
            assert(encodedPacketMetadata);
          } else {
            currentTimestampInSamples += encodedPacketMetadata.durationInSamples;
          }
          lastEncodedPacket = encodedPacket;
          lastEncodedPacketMetadata = encodedPacketMetadata;
          if (currentTimestampIsCorrect && // Next timestamp will be too late
          (Math.max(currentTimestampInSamples, 0) > timestampInSamples || Math.max(encodedPacketMetadata.timestampInSamples, 0) === timestampInSamples)) {
            break;
          }
        }
        const nextPosition = await this.demuxer.findNextPacketStart(reader, packet);
        if (!nextPosition) {
          break;
        }
        currentPage = nextPosition.startPage;
        currentSegmentIndex = nextPosition.startSegmentIndex;
      }
      return lastEncodedPacket;
    }
    getKeyPacket(timestamp, options) {
      return this.getPacket(timestamp, options);
    }
    getNextKeyPacket(packet, options) {
      return this.getNextPacket(packet, options);
    }
  };
  var findPacketStartPosition = (pageList, endPage, endSegmentIndex) => {
    let page = endPage;
    let segmentIndex = endSegmentIndex;
    outer:
      while (true) {
        segmentIndex--;
        for (segmentIndex; segmentIndex >= 0; segmentIndex--) {
          const lacingValue = page.lacingValues[segmentIndex];
          if (lacingValue < 255) {
            segmentIndex++;
            break outer;
          }
        }
        assert(segmentIndex === -1);
        const pageStartsWithFreshPacket = !(page.headerType & 1);
        if (pageStartsWithFreshPacket) {
          segmentIndex = 0;
          break;
        }
        const previousPage = findLast(
          pageList,
          (x) => x.headerStartPos < page.headerStartPos
        );
        if (!previousPage) {
          return null;
        }
        page = previousPage;
        segmentIndex = page.lacingValues.length;
      }
    assert(segmentIndex !== -1);
    if (segmentIndex === page.lacingValues.length) {
      const nextPage = pageList[pageList.indexOf(page) + 1];
      assert(nextPage);
      page = nextPage;
      segmentIndex = 0;
    }
    return { page, segmentIndex };
  };
  var findPreviousPacketEndPosition = (pageList, startPage, startSegmentIndex) => {
    if (startSegmentIndex > 0) {
      return { page: startPage, segmentIndex: startSegmentIndex - 1 };
    }
    const previousPage = findLast(
      pageList,
      (x) => x.headerStartPos < startPage.headerStartPos
    );
    if (!previousPage) {
      return null;
    }
    return { page: previousPage, segmentIndex: previousPage.lacingValues.length - 1 };
  };

  // src/input-format.ts
  var InputFormat = class {
  };
  var IsobmffInputFormat = class extends InputFormat {
    /** @internal */
    async _getMajorBrand(input) {
      const sourceSize = await input._mainReader.source._getSize();
      if (sourceSize < 12) {
        return null;
      }
      const isobmffReader = new IsobmffReader(input._mainReader);
      isobmffReader.pos = 4;
      const fourCc = isobmffReader.readAscii(4);
      if (fourCc !== "ftyp") {
        return null;
      }
      return isobmffReader.readAscii(4);
    }
    /** @internal */
    _createDemuxer(input) {
      return new IsobmffDemuxer(input);
    }
  };
  var Mp4InputFormat = class extends IsobmffInputFormat {
    /** @internal */
    async _canReadInput(input) {
      const majorBrand = await this._getMajorBrand(input);
      return !!majorBrand && majorBrand !== "qt  ";
    }
    getName() {
      return "MP4";
    }
    getMimeType() {
      return "video/mp4";
    }
  };
  var QuickTimeInputFormat = class extends IsobmffInputFormat {
    /** @internal */
    async _canReadInput(input) {
      const majorBrand = await this._getMajorBrand(input);
      return majorBrand === "qt  ";
    }
    getName() {
      return "QuickTime File Format";
    }
    getMimeType() {
      return "video/quicktime";
    }
  };
  var MatroskaInputFormat = class extends InputFormat {
    /** @internal */
    async isSupportedEBMLOfDocType(input, desiredDocType) {
      const sourceSize = await input._mainReader.source._getSize();
      if (sourceSize < 8) {
        return false;
      }
      const ebmlReader = new EBMLReader(input._mainReader);
      const varIntSize = ebmlReader.readVarIntSize();
      if (varIntSize < 1 || varIntSize > 8) {
        return false;
      }
      const id = ebmlReader.readUnsignedInt(varIntSize);
      if (id !== 440786851 /* EBML */) {
        return false;
      }
      const dataSize = ebmlReader.readElementSize();
      if (dataSize === -1) {
        return false;
      }
      const startPos = ebmlReader.pos;
      while (ebmlReader.pos < startPos + dataSize) {
        const { id: id2, size } = ebmlReader.readElementHeader();
        const dataStartPos = ebmlReader.pos;
        if (size === -1) return false;
        switch (id2) {
          case 17030 /* EBMLVersion */:
            {
              const ebmlVersion = ebmlReader.readUnsignedInt(size);
              if (ebmlVersion !== 1) {
                return false;
              }
            }
            ;
            break;
          case 17143 /* EBMLReadVersion */:
            {
              const ebmlReadVersion = ebmlReader.readUnsignedInt(size);
              if (ebmlReadVersion !== 1) {
                return false;
              }
            }
            ;
            break;
          case 17026 /* DocType */:
            {
              const docType = ebmlReader.readString(size);
              if (docType !== desiredDocType) {
                return false;
              }
            }
            ;
            break;
          case 17031 /* DocTypeVersion */:
            {
              const docTypeVersion = ebmlReader.readUnsignedInt(size);
              if (docTypeVersion > 4) {
                return false;
              }
            }
            ;
            break;
        }
        ebmlReader.pos = dataStartPos + size;
      }
      return true;
    }
    /** @internal */
    _canReadInput(input) {
      return this.isSupportedEBMLOfDocType(input, "matroska");
    }
    /** @internal */
    _createDemuxer(input) {
      return new MatroskaDemuxer(input);
    }
    getName() {
      return "Matroska";
    }
    getMimeType() {
      return "video/x-matroska";
    }
  };
  var WebMInputFormat = class extends MatroskaInputFormat {
    /** @internal */
    _canReadInput(input) {
      return this.isSupportedEBMLOfDocType(input, "webm");
    }
    getName() {
      return "WebM";
    }
    getMimeType() {
      return "video/webm";
    }
  };
  var Mp3InputFormat = class extends InputFormat {
    /** @internal */
    async _canReadInput(input) {
      const sourceSize = await input._mainReader.source._getSize();
      if (sourceSize < 4) {
        return false;
      }
      const mp3Reader = new Mp3Reader(input._mainReader);
      mp3Reader.fileSize = sourceSize;
      const id3Tag = mp3Reader.readId3();
      if (id3Tag) {
        mp3Reader.pos += id3Tag.size;
      }
      const framesStartPos = mp3Reader.pos;
      await mp3Reader.reader.loadRange(mp3Reader.pos, mp3Reader.pos + 4096);
      const firstHeader = mp3Reader.readNextFrameHeader(framesStartPos + 4096);
      if (!firstHeader) {
        return false;
      }
      if (id3Tag) {
        return true;
      }
      mp3Reader.pos = firstHeader.startPos + firstHeader.totalSize;
      const secondHeader = mp3Reader.readNextFrameHeader(framesStartPos + 4096);
      if (!secondHeader) {
        return false;
      }
      if (firstHeader.channel !== secondHeader.channel || firstHeader.sampleRate !== secondHeader.sampleRate) {
        return false;
      }
      return true;
    }
    /** @internal */
    _createDemuxer(input) {
      return new Mp3Demuxer(input);
    }
    getName() {
      return "MP3";
    }
    getMimeType() {
      return "audio/mpeg";
    }
  };
  var WaveInputFormat = class extends InputFormat {
    /** @internal */
    async _canReadInput(input) {
      const sourceSize = await input._mainReader.source._getSize();
      if (sourceSize < 12) {
        return false;
      }
      const riffReader = new RiffReader(input._mainReader);
      const riffType = riffReader.readAscii(4);
      if (riffType !== "RIFF" && riffType !== "RIFX") {
        return false;
      }
      riffReader.pos = 8;
      const format = riffReader.readAscii(4);
      return format === "WAVE";
    }
    /** @internal */
    _createDemuxer(input) {
      return new WaveDemuxer(input);
    }
    getName() {
      return "WAVE";
    }
    getMimeType() {
      return "audio/wav";
    }
  };
  var OggInputFormat = class extends InputFormat {
    /** @internal */
    async _canReadInput(input) {
      const sourceSize = await input._mainReader.source._getSize();
      if (sourceSize < 4) {
        return false;
      }
      const oggReader = new OggReader(input._mainReader);
      return oggReader.readAscii(4) === "OggS";
    }
    /** @internal */
    _createDemuxer(input) {
      return new OggDemuxer(input);
    }
    getName() {
      return "Ogg";
    }
    getMimeType() {
      return "application/ogg";
    }
  };
  var MP4 = new Mp4InputFormat();
  var QTFF = new QuickTimeInputFormat();
  var MATROSKA = new MatroskaInputFormat();
  var WEBM = new WebMInputFormat();
  var MP3 = new Mp3InputFormat();
  var WAVE = new WaveInputFormat();
  var OGG = new OggInputFormat();
  var ALL_FORMATS = [MP4, QTFF, MATROSKA, WEBM, WAVE, OGG, MP3];

  // src/input.ts
  var Input = class {
    constructor(options) {
      /** @internal */
      this._demuxerPromise = null;
      /** @internal */
      this._format = null;
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (!Array.isArray(options.formats) || options.formats.some((x) => !(x instanceof InputFormat))) {
        throw new TypeError("options.formats must be an array of InputFormat.");
      }
      if (!(options.source instanceof Source)) {
        throw new TypeError("options.source must be a Source.");
      }
      this._formats = options.formats;
      this._source = options.source;
      this._mainReader = new Reader(options.source);
    }
    /** @internal */
    _getDemuxer() {
      return this._demuxerPromise ??= (async () => {
        await this._mainReader.loadRange(0, 4096);
        for (const format of this._formats) {
          const canRead = await format._canReadInput(this);
          if (canRead) {
            this._format = format;
            return format._createDemuxer(this);
          }
        }
        throw new Error("Input has an unsupported or unrecognizable format.");
      })();
    }
    /**
     * Returns the format of the input file. You can compare this result directly to the InputFormat singletons or use
     * `instanceof` checks for subset-aware logic (for example, `format instanceof MatroskaInputFormat` is true for
     * both MKV and WebM).
     */
    async getFormat() {
      await this._getDemuxer();
      assert(this._format);
      return this._format;
    }
    /**
     * Computes the duration of the longest track in this input file, in seconds. More precisely, returns the largest
     * end timestamp among all tracks.
     */
    async computeDuration() {
      const demuxer = await this._getDemuxer();
      return demuxer.computeDuration();
    }
    /** Returns the list of all tracks of this input file. */
    async getTracks() {
      const demuxer = await this._getDemuxer();
      return demuxer.getTracks();
    }
    /** Returns the list of all video tracks of this input file. */
    async getVideoTracks() {
      const tracks = await this.getTracks();
      return tracks.filter((x) => x.isVideoTrack());
    }
    /** Returns the primary video track of this input file, or null if there are no video tracks. */
    async getPrimaryVideoTrack() {
      const tracks = await this.getTracks();
      return tracks.find((x) => x.isVideoTrack()) ?? null;
    }
    /** Returns the list of all audio tracks of this input file. */
    async getAudioTracks() {
      const tracks = await this.getTracks();
      return tracks.filter((x) => x.isAudioTrack());
    }
    /** Returns the primary audio track of this input file, or null if there are no audio tracks. */
    async getPrimaryAudioTrack() {
      const tracks = await this.getTracks();
      return tracks.find((x) => x.isAudioTrack()) ?? null;
    }
    /** Returns the full MIME type of this input file, including track codecs. */
    async getMimeType() {
      const demuxer = await this._getDemuxer();
      return demuxer.getMimeType();
    }
    /** Returns the size of the input file, in bytes. */
    async getSize() {
      return await this._source._getSize();
    }
  };

  // src/conversion.ts
  var FALLBACK_NUMBER_OF_CHANNELS = 2;
  var FALLBACK_SAMPLE_RATE = 48e3;
  var convert = async (options) => {
    const conversion = await Conversion.init(options);
    await conversion.execute();
    return conversion;
  };
  var Conversion = class _Conversion {
    constructor(options) {
      /** @internal */
      this._addedCounts = {
        video: 0,
        audio: 0,
        subtitle: 0
      };
      /** @internal */
      this._totalTrackCount = 0;
      /** @internal */
      this._trackPromises = [];
      /** @internal */
      this._executed = false;
      /** @internal */
      this._synchronizer = new TrackSynchronizer();
      /** @internal */
      this._totalDuration = null;
      /** @internal */
      this._maxTimestamps = /* @__PURE__ */ new Map();
      // Track ID -> timestamp
      /** @internal */
      this._canceled = false;
      /**
       * A number between 0 and 1, indicating the completion of the conversion. If the `computeProgress` option is not
       * enabled, this value will be stuck at 0.
       */
      this.progress = 0;
      /**
       * A callback that is fired whenever the conversion progresses. Only called if the `computeProgress` option
       * is enabled.
       */
      this.onProgress = void 0;
      /** The list of tracks that are included in the output file. */
      this.utilizedTracks = [];
      /** The list of tracks from the input file that have been discarded, alongside the discard reason. */
      this.discardedTracks = [];
      if (!options || typeof options !== "object") {
        throw new TypeError("options must be an object.");
      }
      if (!(options.input instanceof Input)) {
        throw new TypeError("options.input must be an Input.");
      }
      if (!(options.output instanceof Output)) {
        throw new TypeError("options.output must be an Output.");
      }
      if (options.video !== void 0 && (!options.video || typeof options.video !== "object")) {
        throw new TypeError("options.video, when provided, must be an object.");
      }
      if (options.video?.discard !== void 0 && typeof options.video.discard !== "boolean") {
        throw new TypeError("options.video.discard, when provided, must be a boolean.");
      }
      if (options.video?.forceReencode !== void 0 && typeof options.video.forceReencode !== "boolean") {
        throw new TypeError("options.video.forceReencode, when provided, must be a boolean.");
      }
      if (options.video?.codec !== void 0 && !VIDEO_CODECS.includes(options.video.codec)) {
        throw new TypeError(
          `options.video.codec, when provided, must be one of: ${VIDEO_CODECS.join(", ")}.`
        );
      }
      if (options.video?.bitrate !== void 0 && !(options.video.bitrate instanceof Quality) && (!Number.isInteger(options.video.bitrate) || options.video.bitrate <= 0)) {
        throw new TypeError("options.video.bitrate, when provided, must be a positive integer or a quality.");
      }
      if (options.video?.width !== void 0 && (!Number.isInteger(options.video.width) || options.video.width <= 0)) {
        throw new TypeError("options.video.width, when provided, must be a positive integer.");
      }
      if (options.video?.height !== void 0 && (!Number.isInteger(options.video.height) || options.video.height <= 0)) {
        throw new TypeError("options.video.height, when provided, must be a positive integer.");
      }
      if (options.video?.fit !== void 0 && !["fill", "contain", "cover"].includes(options.video.fit)) {
        throw new TypeError('options.video.fit, when provided, must be one of "fill", "contain", or "cover".');
      }
      if (options.video?.width !== void 0 && options.video.height !== void 0 && options.video.fit === void 0) {
        throw new TypeError(
          "When both options.video.width and options.video.height are provided, options.video.fit must also be provided."
        );
      }
      if (options.video?.rotate !== void 0 && ![0, 90, 180, 270].includes(options.video.rotate)) {
        throw new TypeError("options.video.rotate, when provided, must be 0, 90, 180 or 270.");
      }
      if (options.audio !== void 0 && (!options.audio || typeof options.audio !== "object")) {
        throw new TypeError("options.video, when provided, must be an object.");
      }
      if (options.audio?.discard !== void 0 && typeof options.audio.discard !== "boolean") {
        throw new TypeError("options.audio.discard, when provided, must be a boolean.");
      }
      if (options.audio?.forceReencode !== void 0 && typeof options.audio.forceReencode !== "boolean") {
        throw new TypeError("options.audio.forceReencode, when provided, must be a boolean.");
      }
      if (options.audio?.codec !== void 0 && !AUDIO_CODECS.includes(options.audio.codec)) {
        throw new TypeError(
          `options.audio.codec, when provided, must be one of: ${AUDIO_CODECS.join(", ")}.`
        );
      }
      if (options.audio?.bitrate !== void 0 && !(options.audio.bitrate instanceof Quality) && (!Number.isInteger(options.audio.bitrate) || options.audio.bitrate <= 0)) {
        throw new TypeError("options.audio.bitrate, when provided, must be a positive integer or a quality.");
      }
      if (options.audio?.numberOfChannels !== void 0 && (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0)) {
        throw new TypeError("options.audio.numberOfChannels, when provided, must be a positive integer.");
      }
      if (options.audio?.sampleRate !== void 0 && (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0)) {
        throw new TypeError("options.audio.sampleRate, when provided, must be a positive integer.");
      }
      if (options.trim !== void 0 && (!options.trim || typeof options.trim !== "object")) {
        throw new TypeError("options.trim, when provided, must be an object.");
      }
      if (options.trim?.start !== void 0 && (!Number.isFinite(options.trim.start) || options.trim.start < 0)) {
        throw new TypeError("options.trim.start, when provided, must be a non-negative number.");
      }
      if (options.trim?.end !== void 0 && (!Number.isFinite(options.trim.end) || options.trim.end < 0)) {
        throw new TypeError("options.trim.end, when provided, must be a non-negative number.");
      }
      if (options.trim?.start !== void 0 && options.trim.end !== void 0 && options.trim.start >= options.trim.end) {
        throw new TypeError("options.trim.start must be less than options.trim.end.");
      }
      if (options.computeProgress !== void 0 && typeof options.computeProgress !== "boolean") {
        throw new TypeError("options.computeProgress, when provided, must be a boolean.");
      }
      this._options = options;
      this._input = options.input;
      this._output = options.output;
      this._startTimestamp = options.trim?.start ?? 0;
      this._endTimestamp = options.trim?.end ?? Infinity;
      const { promise: started, resolve: start } = promiseWithResolvers();
      this._started = started;
      this._start = start;
    }
    /** Initializes a new conversion process without starting the conversion. */
    static async init(options) {
      const conversion = new _Conversion(options);
      await conversion._init();
      return conversion;
    }
    /** @internal */
    async _init() {
      const inputTracks = await this._input.getTracks();
      const outputTrackCounts = this._output.format.getSupportedTrackCounts();
      for (const track of inputTracks) {
        if (this._totalTrackCount === outputTrackCounts.total.max) {
          this.discardedTracks.push({
            track,
            reason: "maxTrackCountReached"
          });
          continue;
        }
        if (this._addedCounts[track.type] === outputTrackCounts[track.type].max) {
          this.discardedTracks.push({
            track,
            reason: "maxTrackCountOfTypeReached"
          });
          continue;
        }
        if (track.isVideoTrack()) {
          if (this._options.video?.discard) {
            this.discardedTracks.push({
              track,
              reason: "discardedByUser"
            });
            continue;
          }
          await this._processVideoTrack(track);
        } else if (track.isAudioTrack()) {
          if (this._options.audio?.discard) {
            this.discardedTracks.push({
              track,
              reason: "discardedByUser"
            });
            continue;
          }
          await this._processAudioTrack(track);
        }
      }
      if (this._options.computeProgress) {
        this._totalDuration = Math.min(
          await this._input.computeDuration() - this._startTimestamp,
          this._endTimestamp - this._startTimestamp
        );
        this.onProgress?.();
      }
    }
    /** Starts the conversion process. */
    async execute() {
      if (this._executed) {
        throw new Error("Conversion cannot be executed twice.");
      }
      this._executed = true;
      await this._output.start();
      this._start();
      await Promise.all(this._trackPromises);
      if (this._canceled) {
        await new Promise(() => {
        });
      }
      await this._output.finalize();
      if (this._options.computeProgress) {
        this.progress = 1;
        this.onProgress?.();
      }
    }
    /** Cancels the conversion process. Does nothing if the conversion is already complete. */
    async cancel() {
      if (this._output.state === "finalizing" || this._output.state === "finalized") {
        return;
      }
      if (this._canceled) {
        console.warn("Conversion already canceled.");
        return;
      }
      this._canceled = true;
      await this._output.cancel();
    }
    /** @internal */
    async _processVideoTrack(track) {
      const sourceCodec = track.codec;
      if (!sourceCodec) {
        this.discardedTracks.push({
          track,
          reason: "unknownSourceCodec"
        });
        return;
      }
      let videoSource;
      const totalRotation = normalizeRotation(track.rotation + (this._options.video?.rotate ?? 0));
      const outputSupportsRotation = this._output.format.supportsVideoRotationMetadata;
      const [originalWidth, originalHeight] = totalRotation % 180 === 0 ? [track.codedWidth, track.codedHeight] : [track.codedHeight, track.codedWidth];
      let width = originalWidth;
      let height = originalHeight;
      const aspectRatio = width / height;
      const ceilToMultipleOfTwo = (value) => Math.ceil(value / 2) * 2;
      if (this._options.video?.width !== void 0 && this._options.video.height === void 0) {
        width = ceilToMultipleOfTwo(this._options.video.width);
        height = ceilToMultipleOfTwo(Math.round(width / aspectRatio));
      } else if (this._options.video?.width === void 0 && this._options.video?.height !== void 0) {
        height = ceilToMultipleOfTwo(this._options.video.height);
        width = ceilToMultipleOfTwo(Math.round(height * aspectRatio));
      } else if (this._options.video?.width !== void 0 && this._options.video.height !== void 0) {
        width = ceilToMultipleOfTwo(this._options.video.width);
        height = ceilToMultipleOfTwo(this._options.video.height);
      }
      const firstTimestamp = await track.getFirstTimestamp();
      const needsReencode = !!this._options.video?.forceReencode || this._startTimestamp > 0 || firstTimestamp < 0;
      const needsRerender = width !== originalWidth || height !== originalHeight || totalRotation !== 0 && !outputSupportsRotation;
      let videoCodecs = this._output.format.getSupportedVideoCodecs();
      if (!needsReencode && !this._options.video?.bitrate && !needsRerender && videoCodecs.includes(sourceCodec) && (!this._options.video?.codec || this._options.video?.codec === sourceCodec)) {
        const source = new EncodedVideoPacketSource(sourceCodec);
        videoSource = source;
        this._trackPromises.push((async () => {
          await this._started;
          const sink = new EncodedPacketSink(track);
          const decoderConfig = await track.getDecoderConfig();
          const meta = { decoderConfig: decoderConfig ?? void 0 };
          for await (const packet of sink.packets(void 0, this._endTimestamp)) {
            if (this._synchronizer.shouldWait(track.id, packet.timestamp)) {
              await this._synchronizer.wait(packet.timestamp);
            }
            if (this._canceled) {
              return;
            }
            await source.add(packet, meta);
            this._reportProgress(track.id, packet.timestamp + packet.duration);
          }
          await source.close();
          this._synchronizer.closeTrack(track.id);
        })());
      } else {
        const canDecode = await track.canDecode();
        if (!canDecode) {
          this.discardedTracks.push({
            track,
            reason: "undecodableSourceCodec"
          });
          return;
        }
        if (this._options.video?.codec) {
          videoCodecs = videoCodecs.filter((codec) => codec === this._options.video?.codec);
        }
        const encodableCodecs = await getEncodableVideoCodecs(videoCodecs, { width, height });
        if (encodableCodecs.length === 0) {
          this.discardedTracks.push({
            track,
            reason: "noEncodableTargetCodec"
          });
          return;
        }
        const encodingConfig = {
          codec: encodableCodecs[0],
          bitrate: this._options.video?.bitrate ?? QUALITY_HIGH,
          onEncodedPacket: (sample) => this._reportProgress(track.id, sample.timestamp + sample.duration)
        };
        if (needsRerender) {
          const source = new VideoSampleSource(encodingConfig);
          videoSource = source;
          this._trackPromises.push((async () => {
            await this._started;
            const sink = new CanvasSink(track, {
              width,
              height,
              fit: this._options.video?.fit ?? "fill",
              rotation: totalRotation,
              // Bake the rotation into the output
              poolSize: 1
            });
            const iterator = sink.canvases(this._startTimestamp, this._endTimestamp);
            for await (const { canvas, timestamp, duration } of iterator) {
              if (this._synchronizer.shouldWait(track.id, timestamp)) {
                await this._synchronizer.wait(timestamp);
              }
              if (this._canceled) {
                return;
              }
              const sample = new VideoSample(canvas, {
                timestamp: Math.max(timestamp - this._startTimestamp, 0),
                duration
              });
              await source.add(sample);
              sample.close();
            }
          })());
        } else {
          const source = new VideoSampleSource(encodingConfig);
          videoSource = source;
          this._trackPromises.push((async () => {
            await this._started;
            const sink = new VideoSampleSink(track);
            for await (const sample of sink.samples(this._startTimestamp, this._endTimestamp)) {
              if (this._synchronizer.shouldWait(track.id, sample.timestamp)) {
                await this._synchronizer.wait(sample.timestamp);
              }
              sample.setTimestamp(Math.max(sample.timestamp - this._startTimestamp, 0));
              if (this._canceled) {
                return;
              }
              await source.add(sample);
              sample.close();
            }
            await source.close();
            this._synchronizer.closeTrack(track.id);
          })());
        }
      }
      this._output.addVideoTrack(videoSource, {
        languageCode: track.languageCode,
        rotation: needsRerender ? 0 : totalRotation
        // Rerendering will bake the rotation into the output
      });
      this._addedCounts.video++;
      this._totalTrackCount++;
      this.utilizedTracks.push(track);
    }
    /** @internal */
    async _processAudioTrack(track) {
      const sourceCodec = track.codec;
      if (!sourceCodec) {
        this.discardedTracks.push({
          track,
          reason: "unknownSourceCodec"
        });
        return;
      }
      let audioSource;
      const originalNumberOfChannels = track.numberOfChannels;
      const originalSampleRate = track.sampleRate;
      const firstTimestamp = await track.getFirstTimestamp();
      let numberOfChannels = this._options.audio?.numberOfChannels ?? originalNumberOfChannels;
      let sampleRate = this._options.audio?.sampleRate ?? originalSampleRate;
      let needsResample = numberOfChannels !== originalNumberOfChannels || sampleRate !== originalSampleRate || this._startTimestamp > 0 || firstTimestamp < 0;
      let audioCodecs = this._output.format.getSupportedAudioCodecs();
      if (!this._options.audio?.forceReencode && !this._options.audio?.bitrate && !needsResample && audioCodecs.includes(sourceCodec) && (!this._options.audio?.codec || this._options.audio.codec === sourceCodec)) {
        const source = new EncodedAudioPacketSource(sourceCodec);
        audioSource = source;
        this._trackPromises.push((async () => {
          await this._started;
          const sink = new EncodedPacketSink(track);
          const decoderConfig = await track.getDecoderConfig();
          const meta = { decoderConfig: decoderConfig ?? void 0 };
          for await (const packet of sink.packets(void 0, this._endTimestamp)) {
            if (this._synchronizer.shouldWait(track.id, packet.timestamp)) {
              await this._synchronizer.wait(packet.timestamp);
            }
            if (this._canceled) {
              return;
            }
            await source.add(packet, meta);
            this._reportProgress(track.id, packet.timestamp + packet.duration);
          }
          await source.close();
          this._synchronizer.closeTrack(track.id);
        })());
      } else {
        const canDecode = await track.canDecode();
        if (!canDecode) {
          this.discardedTracks.push({
            track,
            reason: "undecodableSourceCodec"
          });
          return;
        }
        let codecOfChoice = null;
        if (this._options.audio?.codec) {
          audioCodecs = audioCodecs.filter((codec) => codec === this._options.audio.codec);
        }
        const encodableCodecs = await getEncodableAudioCodecs(audioCodecs, {
          numberOfChannels,
          sampleRate
        });
        if (!encodableCodecs.some((codec) => NON_PCM_AUDIO_CODECS.includes(codec)) && audioCodecs.some((codec) => NON_PCM_AUDIO_CODECS.includes(codec)) && (numberOfChannels !== FALLBACK_NUMBER_OF_CHANNELS || sampleRate !== FALLBACK_SAMPLE_RATE)) {
          const encodableCodecsWithDefaultParams = await getEncodableAudioCodecs(audioCodecs, {
            numberOfChannels: FALLBACK_NUMBER_OF_CHANNELS,
            sampleRate: FALLBACK_SAMPLE_RATE
          });
          if (encodableCodecsWithDefaultParams.some((codec) => NON_PCM_AUDIO_CODECS.includes(codec))) {
            needsResample = true;
            codecOfChoice = encodableCodecsWithDefaultParams[0];
            numberOfChannels = FALLBACK_NUMBER_OF_CHANNELS;
            sampleRate = FALLBACK_SAMPLE_RATE;
          }
        } else {
          codecOfChoice = encodableCodecs[0] ?? null;
        }
        if (codecOfChoice === null) {
          this.discardedTracks.push({
            track,
            reason: "noEncodableTargetCodec"
          });
          return;
        }
        if (needsResample) {
          audioSource = this._resampleAudio(track, codecOfChoice, numberOfChannels, sampleRate);
        } else {
          const source = new AudioSampleSource({
            codec: codecOfChoice,
            bitrate: this._options.audio?.bitrate ?? QUALITY_HIGH,
            onEncodedPacket: (packet) => this._reportProgress(track.id, packet.timestamp + packet.duration)
          });
          audioSource = source;
          this._trackPromises.push((async () => {
            await this._started;
            const sink = new AudioSampleSink(track);
            for await (const sample of sink.samples(void 0, this._endTimestamp)) {
              if (this._synchronizer.shouldWait(track.id, sample.timestamp)) {
                await this._synchronizer.wait(sample.timestamp);
              }
              if (this._canceled) {
                return;
              }
              await source.add(sample);
              sample.close();
            }
            await source.close();
            this._synchronizer.closeTrack(track.id);
          })());
        }
      }
      this._output.addAudioTrack(audioSource, {
        languageCode: track.languageCode
      });
      this._addedCounts.audio++;
      this._totalTrackCount++;
      this.utilizedTracks.push(track);
    }
    /**
     * Resamples the audio by decoding it, playing it onto an OfflineAudioContext and encoding the
     * resulting AudioBuffer.
     * @internal
     */
    _resampleAudio(track, codec, targetNumberOfChannels, targetSampleRate) {
      const source = new AudioBufferSource({
        codec,
        bitrate: this._options.audio?.bitrate ?? QUALITY_HIGH,
        onEncodedPacket: (packet) => this._reportProgress(track.id, packet.timestamp + packet.duration)
      });
      this._trackPromises.push((async () => {
        await this._started;
        const trackDuration = Math.min(
          await track.computeDuration() - this._startTimestamp,
          this._endTimestamp - this._startTimestamp
        );
        const totalFrameCount = Math.round(trackDuration * targetSampleRate);
        const maxChunkLength = 5 * targetSampleRate;
        let currentContextStartFrame = 0;
        let currentContext = new OfflineAudioContext({
          length: Math.min(totalFrameCount - currentContextStartFrame, maxChunkLength),
          numberOfChannels: targetNumberOfChannels,
          sampleRate: targetSampleRate
        });
        const sink = new AudioBufferSink(track);
        const iterator = sink.buffers(this._startTimestamp, this._endTimestamp);
        for await (const { buffer, timestamp, duration } of iterator) {
          if (this._synchronizer.shouldWait(track.id, timestamp)) {
            await this._synchronizer.wait(timestamp);
          }
          const offsetTimestamp = timestamp - this._startTimestamp;
          const endTimestamp = offsetTimestamp + duration;
          while (currentContext) {
            const currentContextStartTime = currentContextStartFrame / targetSampleRate;
            const currentContextEndTime = (currentContextStartFrame + currentContext.length) / targetSampleRate;
            if (offsetTimestamp < currentContextEndTime) {
              const node = currentContext.createBufferSource();
              node.buffer = buffer;
              node.connect(currentContext.destination);
              if (offsetTimestamp < currentContextStartTime) {
                node.start(0, currentContextStartTime - offsetTimestamp);
              } else {
                node.start(offsetTimestamp - currentContextStartTime);
              }
            }
            if (endTimestamp >= currentContextEndTime) {
              const renderedBuffer = await currentContext.startRendering();
              if (this._canceled) {
                return;
              }
              await source.add(renderedBuffer);
              currentContextStartFrame += currentContext.length;
              const newLength = Math.min(
                totalFrameCount - currentContextStartFrame,
                maxChunkLength
              );
              currentContext = newLength > 0 ? new OfflineAudioContext({
                length: newLength,
                numberOfChannels: targetNumberOfChannels,
                sampleRate: targetSampleRate
              }) : null;
            } else {
              break;
            }
          }
        }
        if (currentContext) {
          const renderedBuffer = await currentContext.startRendering();
          if (this._canceled) {
            return;
          }
          await source.add(renderedBuffer);
        }
        await source.close();
        this._synchronizer.closeTrack(track.id);
      })());
      return source;
    }
    /** @internal */
    _reportProgress(trackId, endTimestamp) {
      if (!this._options.computeProgress) {
        return;
      }
      assert(this._totalDuration !== null);
      this._maxTimestamps.set(trackId, Math.max(endTimestamp, this._maxTimestamps.get(trackId) ?? -Infinity));
      let totalTimestamps = 0;
      for (const [, timestamp] of this._maxTimestamps) {
        totalTimestamps += timestamp;
      }
      const averageTimestamp = totalTimestamps / this._totalTrackCount;
      this.progress = 0.99 * clamp(averageTimestamp / this._totalDuration, 0, 1);
      this.onProgress?.();
    }
  };
  var MAX_TIMESTAMP_GAP = 5;
  var TrackSynchronizer = class {
    constructor() {
      this.maxTimestamps = /* @__PURE__ */ new Map();
      // Track ID -> timestamp
      this.resolvers = [];
    }
    computeMinAndMaybeResolve() {
      let newMin = Infinity;
      for (const [, timestamp] of this.maxTimestamps) {
        newMin = Math.min(newMin, timestamp);
      }
      for (let i = 0; i < this.resolvers.length; i++) {
        const entry = this.resolvers[i];
        if (entry.timestamp - newMin < MAX_TIMESTAMP_GAP) {
          entry.resolve();
          this.resolvers.splice(i, 1);
          i--;
        }
      }
      return newMin;
    }
    shouldWait(trackId, timestamp) {
      this.maxTimestamps.set(trackId, Math.max(timestamp, this.maxTimestamps.get(trackId) ?? -Infinity));
      const newMin = this.computeMinAndMaybeResolve();
      return timestamp - newMin >= MAX_TIMESTAMP_GAP;
    }
    wait(timestamp) {
      const { promise, resolve } = promiseWithResolvers();
      this.resolvers.push({
        timestamp,
        resolve
      });
      return promise;
    }
    closeTrack(trackId) {
      this.maxTimestamps.delete(trackId);
      this.computeMinAndMaybeResolve();
    }
  };
  return __toCommonJS(index_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, Metamuxer)
