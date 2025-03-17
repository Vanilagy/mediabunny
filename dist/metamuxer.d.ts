/**
 * List of all input format singletons. If you don't need to support all input formats, you should specify the
 * formats individually for better tree shaking.
 * @public
 */
export declare const ALL_FORMATS: InputFormat[];

/**
 * List of all track types.
 * @public
 */
export declare const ALL_TRACK_TYPES: readonly ["video", "audio", "subtitle"];

/**
 * Sync or async iterable.
 * @public
 */
export declare type AnyIterable<T> = Iterable<T> | AsyncIterable<T>;

/**
 * List of known audio codecs, ordered by encoding preference.
 * @public
 */
export declare const AUDIO_CODECS: readonly ["aac", "opus", "mp3", "vorbis", "flac", "pcm-s16", "pcm-s16be", "pcm-s24", "pcm-s24be", "pcm-s32", "pcm-s32be", "pcm-f32", "pcm-f32be", "pcm-u8", "pcm-s8", "ulaw", "alaw"];

/**
 * A sink that retrieves decoded audio samples from an audio track and converts them to AudioBuffers. This is often
 * more useful than directly retrieving audio samples, as AudioBuffers can be directly used with the Web Audio API.
 * @public
 */
export declare class AudioBufferSink {
    constructor(audioTrack: InputAudioTrack);
    /**
     * Retrieves the audio buffer corresponding to the given timestamp, in seconds. More specifically, returns
     * the last audio buffer (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getBuffer(timestamp: number): Promise<WrappedAudioBuffer | null>;
    /**
     * Creates an async iterator that yields audio buffers of this track in presentation order. This method
     * will intelligently pre-decode a few buffers ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding buffers (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding buffers (exclusive).
     */
    buffers(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<WrappedAudioBuffer, void, unknown>;
    /**
     * Creates an async iterator that yields an audio buffer for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the buffer for every timestamp. The iterator may
     * yield null if no buffer is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    buffersAtTimestamps(timestamps: AnyIterable<number>): AsyncGenerator<WrappedAudioBuffer | null, void, unknown>;
}

/**
 * This source can be used to add audio data from an AudioBuffer to the output track. This is useful when working with
 * the Web Audio API.
 * @public
 */
export declare class AudioBufferSource extends AudioSource {
    constructor(encodingConfig: AudioEncodingConfig);
    /**
     * Converts an AudioBuffer to audio samples, encodes them and adds them to the output. The first AudioBuffer will
     * be played at timestamp 0, and any subsequent AudioBuffer will have a timestamp equal to the total duration of
     * all previous AudioBuffers.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(audioBuffer: AudioBuffer): Promise<void[]>;
}

/**
 * Union type of known audio codecs.
 * @public
 */
export declare type AudioCodec = typeof AUDIO_CODECS[number];

/**
 * Configuration object that controls audio encoding. Can be used to set codec, quality, and more.
 * @public
 */
export declare type AudioEncodingConfig = {
    /** The audio codec that should be used for encoding the audio samples. */
    codec: AudioCodec;
    /**
     * The target bitrate for the encoded audio, in bits per second. Alternatively, a subjective Quality can
     * be provided. Required for compressed audio codecs, unused for PCM codecs.
     */
    bitrate?: number | Quality;
    /** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
    onEncodedPacket?: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => unknown;
    /** Called when an error occurs during encoding. */
    onEncodingError?: (error: Error) => unknown;
};

/**
 * Represents a raw, unencoded audio sample. Mainly used as an expressive wrapper around WebCodecs API's AudioData,
 * but can also be used standalone.
 * @public
 */
export declare class AudioSample {
    /** The audio sample format. */
    readonly format: AudioSampleFormat;
    /** The audio sample rate in hertz. */
    readonly sampleRate: number;
    /**
     * The number of audio frames in the sample, per channel. In other words, the length of this audio sample in frames.
     */
    readonly numberOfFrames: number;
    /** The number of audio channels. */
    readonly numberOfChannels: number;
    /** The timestamp of the sample in seconds. */
    readonly duration: number;
    /**
     * The timestamp of the sample in seconds. May be negative. Samples with negative end timestamps should not
     * be presented.
     */
    readonly timestamp: number;
    /** The timestamp of the sample in microseconds. */
    get microsecondTimestamp(): number;
    /** The duration of the sample in microseconds. */
    get microsecondDuration(): number;
    constructor(init: AudioData | AudioSampleInit);
    /** Returns the number of bytes required to hold the audio sample's data as specified by the given options. */
    allocationSize(options: AudioSampleCopyToOptions): number;
    /** Copies the audio sample's data to an ArrayBuffer or ArrayBufferView as specified by the given options. */
    copyTo(destination: AllowSharedBufferSource, options: AudioSampleCopyToOptions): void;
    /** Clones this audio sample. */
    clone(): AudioSample;
    /**
     * Closes this audio sample, releasing held resources. Audio samples should be closed as soon as they are not
     * needed anymore.
     */
    close(): void;
    /**
     * Converts this audio sample to an AudioData for use with the WebCodecs API. The AudioData returned by this
     * method *must* be closed separately from this audio sample.
     */
    toAudioData(): AudioData;
    /** Convert this audio sample to an AudioBuffer for use with the Web Audio API. */
    toAudioBuffer(): AudioBuffer;
    /** Sets the timestamp of this audio sample, in seconds. */
    setTimestamp(newTimestamp: number): void;
}

/**
 * Options used for copying audio sample data.
 * @public
 */
export declare type AudioSampleCopyToOptions = {
    /**
     * The index identifying the plane to copy from. This must be 0 if using a non-planar (interleaved) output format.
     */
    planeIndex: number;
    /** The output format for the destination data. Defaults to the AudioSample's format. */
    format?: AudioSampleFormat;
    /** An offset into the source plane data indicating which frame to begin copying from. Defaults to 0. */
    frameOffset?: number;
    /**
     * The number of frames to copy. If not provided, the copy will include all frames in the plane beginning
     * with frameOffset.
     */
    frameCount?: number;
};

/**
 * Metadata used for AudioSample initialization.
 * @public
 */
export declare type AudioSampleInit = {
    /** The audio data for this sample. */
    data: AllowSharedBufferSource;
    /** The audio sample format. */
    format: AudioSampleFormat;
    /** The number of audio channels. */
    numberOfChannels: number;
    /** The audio sample rate in hertz. */
    sampleRate: number;
    /** The timestamp of the sample in seconds. */
    timestamp: number;
};

/**
 * Sink for retrieving decoded audio samples from an audio track.
 * @public
 */
export declare class AudioSampleSink extends BaseMediaSampleSink<AudioSample> {
    constructor(audioTrack: InputAudioTrack);
    /**
     * Retrieves the audio sample corresponding to the given timestamp, in seconds. More specifically, returns
     * the last audio sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getSample(timestamp: number): Promise<AudioSample | null>;
    /**
     * Creates an async iterator that yields the audio samples of this track in presentation order. This method
     * will intelligently pre-decode a few samples ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
     */
    samples(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<AudioSample, void, unknown>;
    /**
     * Creates an async iterator that yields an audio sample for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
     * yield null if no sample is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    samplesAtTimestamps(timestamps: AnyIterable<number>): AsyncGenerator<AudioSample | null, void, unknown>;
}

/**
 * This source can be used to add raw, unencoded audio samples to an output audio track. These samples will
 * automatically be encoded and then piped into the output.
 * @public
 */
export declare class AudioSampleSource extends AudioSource {
    constructor(encodingConfig: AudioEncodingConfig);
    /**
     * Encodes an audio sample and then adds it to the output.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(audioSample: AudioSample): Promise<void>;
}

/**
 * Base class for audio sources - sources for audio tracks.
 * @public
 */
export declare abstract class AudioSource extends MediaSource_2 {
    constructor(codec: AudioCodec);
}

/**
 * Additional metadata for audio tracks.
 * @public
 */
export declare type AudioTrackMetadata = BaseTrackMetadata & {};

/**
 * Base class for decoded media sample sinks.
 * @public
 */
export declare abstract class BaseMediaSampleSink<MediaSample extends VideoSample | AudioSample> {
}

/**
 * Base track metadata, applicable to all tracks.
 * @public
 */
export declare type BaseTrackMetadata = {
    /** The three-letter, ISO 639-2 language code specifying the language of this track. */
    languageCode?: string;
};

/**
 * A source backed by a Blob. Since Files are also Blobs, this is the source to use when reading files off the disk.
 * @public
 */
export declare class BlobSource extends Source {
    constructor(blob: Blob);
}

/**
 * A source backed by an ArrayBuffer or ArrayBufferView, with the entire file held in memory.
 * @public
 */
declare class BufferSource_2 extends Source {
    constructor(buffer: ArrayBuffer | Uint8Array);
}
export { BufferSource_2 as BufferSource }

/**
 * A target that writes data directly into an ArrayBuffer in memory. Great for performance, but not suitable for very
 * large files. The buffer will be available once the output has been finalized.
 * @public
 */
export declare class BufferTarget extends Target {
    /** Stores the final output buffer. Until the output is finalized, this will be null. */
    buffer: ArrayBuffer | null;
}

/**
 * Checks if the browser is able to encode the given codec.
 * @public
 */
export declare const canEncode: (codec: MediaCodec) => Promise<boolean>;

/**
 * Checks if the browser is able to encode the given audio codec with the given parameters.
 * @public
 */
export declare const canEncodeAudio: (codec: AudioCodec, { numberOfChannels, sampleRate, bitrate }?: {
    numberOfChannels?: number;
    sampleRate?: number;
    bitrate?: number;
}) => Promise<boolean>;

/**
 * Checks if the browser is able to encode the given subtitle codec.
 * @public
 */
export declare const canEncodeSubtitles: (codec: SubtitleCodec) => Promise<boolean>;

/**
 * Checks if the browser is able to encode the given video codec with the given parameters.
 * @public
 */
export declare const canEncodeVideo: (codec: VideoCodec, { width, height, bitrate }?: {
    width?: number;
    height?: number;
    bitrate?: number;
}) => Promise<boolean>;

/**
 * A sink that renders video samples (frames) of the given video track to canvases. This is often more useful than
 * directly retrieving frames, as it comes with common preprocessing steps such as resizing or applying rotation
 * metadata.
 * @public
 */
export declare class CanvasSink {
    constructor(videoTrack: InputVideoTrack, options?: CanvasSinkOptions);
    /**
     * Retrieves a canvas with the video frame corresponding to the given timestamp, in seconds. More specifically,
     * returns the last video frame (in presentation order) with a start timestamp less than or equal to the given
     * timestamp. Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getCanvas(timestamp: number): Promise<WrappedCanvas | null>;
    /**
     * Creates an async iterator that yields canvases with the video frames of this track in presentation order. This
     * method will intelligently pre-decode a few frames ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding canvases (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding canvases (exclusive).
     */
    canvases(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<WrappedCanvas, void, unknown>;
    /**
     * Creates an async iterator that yields a canvas for each timestamp in the argument. This method uses an optimized
     * decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most once, and is
     * therefore more efficient than manually getting the canvas for every timestamp. The iterator may yield null if
     * no frame is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    canvasesAtTimestamps(timestamps: AnyIterable<number>): AsyncGenerator<WrappedCanvas | null, void, unknown>;
}

/**
 * Options for constructing a CanvasSink.
 * @public
 */
export declare type CanvasSinkOptions = {
    /**
     * The width of the output canvas, defaulting to the display width of the video track. If height is not set, it
     * will be deduced automatically based on aspect ratio.
     */
    width?: number;
    /**
     * The height of the output canvas, defaulting to the display height of the video track. If width is not set, it
     * will be deduced automatically based on aspect ratio.
     */
    height?: number;
    /**
     * The fitting algorithm in case both width and height are set.
     *
     * - 'fill' will stretch the image to fill the entire box, potentially altering aspect ratio.
     * - 'contain' will contain the entire image within the box while preserving aspect ratio. This may lead to
     * letterboxing.
     * - 'cover' will scale the image until the entire box is filled, while preserving aspect ratio.
     */
    fit?: 'fill' | 'contain' | 'cover';
    /**
     * The clockwise rotation by which to rotate the raw video frame. Defaults to the rotation set in the file metadata.
     * Rotation is applied before resizing.
     */
    rotation?: Rotation;
    /**
     * When set, specifies the number of canvases in the pool. These canvases will be reused in a ring buffer /
     * round-robin type fashion. This keeps the amount of allocated VRAM constant and relieves the browser from
     * constantly allocating/deallocating canvases. A pool size of 0 or `undefined` disables the pool and means a new
     * canvas is created each time.
     */
    poolSize?: number;
};

/**
 * This source can be used to add video frames to the output track from a fixed canvas element. Since canvases are often
 * used for rendering, this source provides a convenient wrapper around VideoSampleSource.
 * @public
 */
export declare class CanvasSource extends VideoSource {
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas, encodingConfig: VideoEncodingConfig);
    /**
     * Captures the current canvas state as a video sample (frame), encodes it and adds it to the output.
     *
     * @param timestamp - The timestamp of the sample, in seconds.
     * @param duration - The duration of the sample, in seconds.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(timestamp: number, duration?: number, encodeOptions?: VideoEncoderEncodeOptions): Promise<void>;
}

/**
 * Represents a media file conversion process.
 * @public
 */
export declare class Conversion {
    /**
     * A number between 0 and 1, indicating the completion of the conversion. If the `computeProgress` option is not
     * enabled, this value will be stuck at 0.
     */
    progress: number;
    /**
     * A callback that is fired whenever the conversion progresses. Only called if the `computeProgress` option
     * is enabled.
     */
    onProgress?: () => unknown;
    /** The list of tracks that are included in the output file. */
    utilizedTracks: InputTrack[];
    /** The list of tracks from the input file that have been discarded, alongside the discard reason. */
    discardedTracks: {
        /** The track that was discarded. */
        track: InputTrack;
        /** The reason for discarding the track. */
        reason: 'discardedByUser' | 'maxTrackCountReached' | 'maxTrackCountOfTypeReached' | 'unknownSourceCodec' | 'undecodableSourceCodec' | 'noEncodableTargetCodec';
    }[];
    /** Initializes a new conversion process without starting the conversion. */
    static init(options: ConversionOptions): Promise<Conversion>;
    private constructor();
    /** Starts the conversion process. */
    execute(): Promise<void>;
    /** Cancels the conversion process. Does nothing if the conversion is already complete. */
    cancel(): Promise<void>;
}

/**
 * The options for media file conversion.
 * @public
 */
export declare type ConversionOptions = {
    /** The input file. */
    input: Input;
    /** The output file. */
    output: Output;
    /** Video-specific options. */
    video?: {
        /** If true, all video tracks will be discarded and will not be present in the output. */
        discard?: boolean;
        /** The desired output video codec. */
        codec?: VideoCodec;
        /** The desired bitrate of the output video. */
        bitrate?: VideoEncodingConfig['bitrate'];
        /**
         * The desired width of the output video, defaulting to the video's natural display width. If height is not set,
         * it will be deduced automatically based on aspect ratio.
         */
        width?: number;
        /**
         * The desired height of the output video, defaulting to the video's natural display height. If width is not
         * set, it will be deduced automatically based on aspect ratio.
         */
        height?: number;
        /**
         * The fitting algorithm in case both width and height are set.
         *
         * - 'fill' will stretch the image to fill the entire box, potentially altering aspect ratio.
         * - 'contain' will contain the entire image within the box while preserving aspect ratio. This may lead to
         * letterboxing.
         * - 'cover' will scale the image until the entire box is filled, while preserving aspect ratio.
         */
        fit?: 'fill' | 'contain' | 'cover';
        /**
         * The angle in degrees to rotate the input video by, clockwise. Rotation is applied before resizing. This
         * rotation is _in addition to_ the natural rotation of the input video as specified in input file's metadata.
         */
        rotate?: Rotation;
        /** When true, video will always be re-encoded instead of directly copying over the encoded samples. */
        forceReencode?: boolean;
    };
    /** Audio-specific options. */
    audio?: {
        /** If true, all audio tracks will be discarded and will not be present in the output. */
        discard?: boolean;
        /** The desired output audio codec. */
        codec?: AudioCodec;
        /** The desired bitrate of the output audio. */
        bitrate?: AudioEncodingConfig['bitrate'];
        /** The desired channel count of the output audio. */
        numberOfChannels?: number;
        /** The desired sample rate of the output audio. */
        sampleRate?: number;
        /** When true, audio will always be re-encoded instead of directly copying over the encoded samples. */
        forceReencode?: boolean;
    };
    /** Options to trim the input file. */
    trim?: {
        /** The time in the input file at which the output file should start. Must be less than `end`.  */
        start: number;
        /** The time in the input file at which the output file should end. Must be greater than `start`. */
        end: number;
    };
    /**
     * When set to true, the current progress of the conversion will be computed and kept up to date in the `progress`
     * field of the Conversion instance.
     */
    computeProgress?: boolean;
};

/**
 * Utility function to convert one media file into another. In addition to conversion, this function can be used to
 * resize and rotate video, resample audio, drop tracks, or trim to a specific time range.
 * @public
 */
export declare const convert: (options: ConversionOptions) => Promise<Conversion>;

/**
 * Base class for custom audio decoders. To add your own custom audio decoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the decoder using `registerDecoder`.
 * @public
 */
export declare abstract class CustomAudioDecoder {
    /** The input audio's codec. */
    codec: AudioCodec;
    /** The input audio's decoder config. */
    config: AudioDecoderConfig;
    /** The callback to call when a decoded AudioSample is available. */
    onSample: (sample: AudioSample) => unknown;
    /** Returns true iff the decoder can decode the given codec configuration. */
    static supports(codec: AudioCodec, config: AudioDecoderConfig): boolean;
    /** Called after decoder creation; can be used for custom initialization logic. */
    abstract init(): void;
    /** Decodes the provided encoded packet. */
    abstract decode(packet: EncodedPacket): Promise<void> | void;
    /** Decodes all remaining packets and then resolves. */
    abstract flush(): Promise<void> | void;
    /** Called when the decoder is no longer needed and its resources can be freed. */
    abstract close(): Promise<void> | void;
}

/**
 * Base class for custom audio encoders. To add your own custom audio encoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the encoder using `registerEncoder`.
 * @public
 */
export declare abstract class CustomAudioEncoder {
    /** The codec with which to encode the audio. */
    codec: AudioCodec;
    /** Config for the encoder. */
    config: AudioEncoderConfig;
    /** The callback to call when an EncodedPacket is available. */
    onPacket: (packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) => unknown;
    /** Returns true iff the encoder can encode the given codec configuration. */
    static supports(codec: AudioCodec, config: AudioEncoderConfig): boolean;
    /** Called after encoder creation; can be used for custom initialization logic. */
    abstract init(): void;
    /** Encodes the provided audio sample. */
    abstract encode(audioSample: AudioSample): Promise<void> | void;
    /** Encodes all remaining audio samples and then resolves. */
    abstract flush(): Promise<void> | void;
    /** Called when the encoder is no longer needed and its resources can be freed. */
    abstract close(): Promise<void> | void;
}

/**
 * Base class for custom video decoders. To add your own custom video decoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the decoder using `registerDecoder`.
 * @public
 */
export declare abstract class CustomVideoDecoder {
    /** The input video's codec. */
    codec: VideoCodec;
    /** The input video's decoder config. */
    config: VideoDecoderConfig;
    /** The callback to call when a decoded VideoSample is available. */
    onSample: (sample: VideoSample) => unknown;
    /** Returns true iff the decoder can decode the given codec configuration. */
    static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean;
    /** Called after decoder creation; can be used for custom initialization logic. */
    abstract init(): void;
    /** Decodes the provided encoded packet. */
    abstract decode(packet: EncodedPacket): Promise<void> | void;
    /** Decodes all remaining packets and then resolves. */
    abstract flush(): Promise<void> | void;
    /** Called when the decoder is no longer needed and its resources can be freed. */
    abstract close(): Promise<void> | void;
}

/**
 * Base class for custom video encoders. To add your own custom video encoder, extend this class, implement the
 * abstract methods and static `supports` method, and register the encoder using `registerEncoder`.
 * @public
 */
export declare abstract class CustomVideoEncoder {
    /** The codec with which to encode the video. */
    codec: VideoCodec;
    /** Config for the encoder. */
    config: VideoEncoderConfig;
    /** The callback to call when an EncodedPacket is available. */
    onPacket: (packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) => unknown;
    /** Returns true iff the encoder can encode the given codec configuration. */
    static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean;
    /** Called after encoder creation; can be used for custom initialization logic. */
    abstract init(): void;
    /** Encodes the provided video sample. */
    abstract encode(videoSample: VideoSample, options: VideoEncoderEncodeOptions): Promise<void> | void;
    /** Encodes all remaining video samples and then resolves. */
    abstract flush(): Promise<void> | void;
    /** Called when the encoder is no longer needed and its resources can be freed. */
    abstract close(): Promise<void> | void;
}

/**
 * The most basic audio source; can be used to directly pipe encoded packets into the output file.
 * @public
 */
export declare class EncodedAudioPacketSource extends AudioSource {
    constructor(codec: AudioCodec);
    /**
     * Adds an encoded packet to the output audio track.
     *
     * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
     * decoder config.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(packet: EncodedPacket, meta?: EncodedAudioChunkMetadata): Promise<void>;
}

/**
 * Represents an encoded chunk of media. Mainly used as an expressive wrapper around WebCodecs API's EncodedVideoChunk
 * and EncodedAudioChunk, but can also be used standalone.
 * @public
 */
export declare class EncodedPacket {
    /** The encoded data of this packet. */
    readonly data: Uint8Array;
    /** The type of this packet. */
    readonly type: PacketType;
    /**
     * The timestamp of this packet in seconds. May be negative. Samples with negative end timestamps should not
     * be presented.
     */
    readonly timestamp: number;
    /** The duration of this packet in seconds. */
    readonly duration: number;
    /**
     * The sequence number of this packet. The sequence number indicates the decode order of the packets. Packet A
     * must be decoded before packet B if A has a lower sequence number than B. If two packets have the same
     * sequence number, they are the same packet. Otherwise, sequence numbers are arbitrary and are not guaranteed
     * to have any meaning besides their relative ordering. Negative sequence numbers mean the sequence number
     * is undefined.
     */
    readonly sequenceNumber: number;
    /**
     * The actual byte length of the data in this packet. This field is useful for metadata-only packets where the
     * `data` field contains no bytes.
     */
    readonly byteLength: number;
    constructor(
    /** The encoded data of this packet. */
    data: Uint8Array, 
    /** The type of this packet. */
    type: PacketType, 
    /**
     * The timestamp of this packet in seconds. May be negative. Samples with negative end timestamps should not
     * be presented.
     */
    timestamp: number, 
    /** The duration of this packet in seconds. */
    duration: number, 
    /**
     * The sequence number of this packet. The sequence number indicates the decode order of the packets. Packet A
     * must be decoded before packet B if A has a lower sequence number than B. If two packets have the same
     * sequence number, they are the same packet. Otherwise, sequence numbers are arbitrary and are not guaranteed
     * to have any meaning besides their relative ordering. Negative sequence numbers mean the sequence number
     * is undefined.
     */
    sequenceNumber?: number, 
    /**
     * The actual byte length of the data in this packet. This field is useful for metadata-only packets where the
     * `data` field contains no bytes.
     */
    byteLength?: number);
    /** If this packet is a metadata-only packet. Metadata-only packets don't contain their packet data. */
    get isMetadataOnly(): boolean;
    /** The timestamp of this packet in microseconds. */
    get microsecondTimestamp(): number;
    /** The duration of this packet in microseconds. */
    get microsecondDuration(): number;
    /** Converts this packet to an EncodedVideoChunk for use with the WebCodecs API. */
    toEncodedVideoChunk(): EncodedVideoChunk;
    /** Converts this packet to an EncodedAudioChunk for use with the WebCodecs API. */
    toEncodedAudioChunk(): EncodedAudioChunk;
    /**
     * Creates an EncodedPacket from an EncodedVideoChunk or EncodedAudioChunk. This method is useful for converting
     * chunks from the WebCodecs API to EncodedPackets.
     */
    static fromEncodedChunk(chunk: EncodedVideoChunk | EncodedAudioChunk): EncodedPacket;
    /** Clones this packet while optionally updating timing information. */
    clone(options?: {
        /** The timestamp of the cloned packet in seconds. */
        timestamp?: number;
        /** The duration of the cloned packet in seconds. */
        duration?: number;
    }): EncodedPacket;
}

/**
 * Sink for retrieving encoded packets from an input track.
 * @public
 */
export declare class EncodedPacketSink {
    constructor(track: InputTrack);
    /**
     * Retrieves the track's first packet (in decode order), or null if it has no packets. The first packet is very
     * likely to be a key packet.
     */
    getFirstPacket(options?: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    /**
     * Retrieves the packet corresponding to the given timestamp, in seconds. More specifically, returns the last packet
     * (in presentation order) with a start timestamp less than or equal to the given timestamp. This method can be
     * used to retrieve a track's last packet using `getPacket(Infinity)`. The method returns null if the timestamp
     * is before the first packet in the track.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getPacket(timestamp: number, options?: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    /**
     * Retrieves the packet following the given packet (in decode order), or null if the given packet is the
     * last packet.
     */
    getNextPacket(packet: EncodedPacket, options?: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    /**
     * Retrieves the key packet corresponding to the given timestamp, in seconds. More specifically, returns the last
     * key packet (in presentation order) with a start timestamp less than or equal to the given timestamp. A key packet
     * is a packet that doesn't require previous packets to be decoded. This method can be used to retrieve a track's
     * last key packet using `getKeyPacket(Infinity)`. The method returns null if the timestamp is before the first
     * key packet in the track.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getKeyPacket(timestamp: number, options?: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    /**
     * Retrieves the key packet following the given packet (in decode order), or null if the given packet is the last
     * key packet.
     */
    getNextKeyPacket(packet: EncodedPacket, options?: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    /**
     * Creates an async iterator that yields the packets in this track in decode order. To enable fast iteration, this
     * method will intelligently preload packets based on the speed of the consumer.
     *
     * @param startPacket - (optional) The packet from which iteration should begin. This packet will also be yielded.
     * @param endTimestamp - The timestamp in seconds at which to stop iteration. This timestamp is exclusive.
     */
    packets(startPacket?: EncodedPacket, endTimestamp?: number, options?: PacketRetrievalOptions): AsyncGenerator<EncodedPacket, void, unknown>;
}

/**
 * The most basic video source; can be used to directly pipe encoded packets into the output file.
 * @public
 */
export declare class EncodedVideoPacketSource extends VideoSource {
    constructor(codec: VideoCodec);
    /**
     * Adds an encoded packet to the output video track.
     *
     * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
     * decoder config.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(packet: EncodedPacket, meta?: EncodedVideoChunkMetadata): Promise<void>;
}

/**
 * Returns the list of all audio codecs that can be encoded by the browser.
 * @public
 */
export declare const getEncodableAudioCodecs: (checkedCodecs?: AudioCodec[], options?: {
    numberOfChannels?: number;
    sampleRate?: number;
    bitrate?: number;
}) => Promise<AudioCodec[]>;

/**
 * Returns the list of all media codecs that can be encoded by the browser.
 * @public
 */
export declare const getEncodableCodecs: () => Promise<MediaCodec[]>;

/**
 * Returns the list of all subtitle codecs that can be encoded by the browser.
 * @public
 */
export declare const getEncodableSubtitleCodecs: (checkedCodecs?: SubtitleCodec[]) => Promise<SubtitleCodec[]>;

/**
 * Returns the list of all video codecs that can be encoded by the browser.
 * @public
 */
export declare const getEncodableVideoCodecs: (checkedCodecs?: VideoCodec[], options?: {
    width?: number;
    height?: number;
    bitrate?: number;
}) => Promise<VideoCodec[]>;

/**
 * Specifies an inclusive range of integers.
 * @public
 */
export declare type InclusiveIntegerRange = {
    /** The integer cannot be less than this. */
    min: number;
    /** The integer cannot be greater than this. */
    max: number;
};

/**
 * Represents an input media file. This is the root object from which all media read operations start.
 * @public
 */
export declare class Input {
    constructor(options: InputOptions);
    /**
     * Returns the format of the input file. You can compare this result directly to the InputFormat singletons or use
     * `instanceof` checks for subset-aware logic (for example, `format instanceof MatroskaInputFormat` is true for
     * both MKV and WebM).
     */
    getFormat(): Promise<InputFormat>;
    /**
     * Computes the duration of the longest track in this input file, in seconds. More precisely, returns the largest
     * end timestamp among all tracks.
     */
    computeDuration(): Promise<number>;
    /** Returns the list of all tracks of this input file. */
    getTracks(): Promise<InputTrack[]>;
    /** Returns the list of all video tracks of this input file. */
    getVideoTracks(): Promise<InputVideoTrack[]>;
    /** Returns the primary video track of this input file, or null if there are no video tracks. */
    getPrimaryVideoTrack(): Promise<InputVideoTrack | null>;
    /** Returns the list of all audio tracks of this input file. */
    getAudioTracks(): Promise<InputAudioTrack[]>;
    /** Returns the primary audio track of this input file, or null if there are no audio tracks. */
    getPrimaryAudioTrack(): Promise<InputAudioTrack | null>;
    /** Returns the full MIME type of this input file, including track codecs. */
    getMimeType(): Promise<string>;
    /** Returns the size of the input file, in bytes. */
    getSize(): Promise<number>;
}

/**
 * Represents an audio track in an input file.
 * @public
 */
export declare class InputAudioTrack extends InputTrack {
    get type(): TrackType;
    get codec(): AudioCodec | null;
    /** The number of audio channels in the track. */
    get numberOfChannels(): number;
    /** The track's audio sample rate in hertz. */
    get sampleRate(): number;
    /** Returns the decoder configuration for decoding the track's packets using an AudioDecoder. */
    getDecoderConfig(): Promise<AudioDecoderConfig | null>;
    getCodecParameterString(): Promise<string | null>;
    canDecode(): Promise<boolean>;
}

/**
 * Base class representing an input media file format.
 * @public
 */
export declare abstract class InputFormat {
    /** Returns the name of the input format. */
    abstract getName(): string;
    /** Returns the typical base MIME type of the input format. */
    abstract getMimeType(): string;
}

/**
 * The options for creating an Input object.
 * @public
 */
export declare type InputOptions = {
    /** A list of supported formats. If the source file is not of one of these formats, then it cannot be read. */
    formats: InputFormat[];
    /** The source from which data will be read. */
    source: Source;
};

/**
 * Represents a media track in an input file.
 * @public
 */
export declare abstract class InputTrack {
    /** The type of the track. */
    abstract get type(): TrackType;
    /** The codec of the track's packets. */
    abstract get codec(): MediaCodec | null;
    /** Returns the full codec parameter string for this track. */
    abstract getCodecParameterString(): Promise<string | null>;
    /** Checks if this track's packets can be decoded by the browser. */
    abstract canDecode(): Promise<boolean>;
    /** Returns true iff this track is a video track. */
    isVideoTrack(): this is InputVideoTrack;
    /** Returns true iff this track is an audio track. */
    isAudioTrack(): this is InputAudioTrack;
    /** The unique ID of this track in the input file. */
    get id(): number;
    /** The ISO 639-2 language code for this track. If the language is unknown, this field is 'und' (undetermined). */
    get languageCode(): string;
    /**
     * A positive number x such that all timestamps and durations of all packets of this track are
     * integer multiples of 1/x.
     */
    get timeResolution(): number;
    /**
     * Returns the start timestamp of the first packet of this track, in seconds. While often near zero, this value
     * may be positive or even negative. A negative starting timestamp means the track's timing has been offset. Samples
     * with a negative timestamp should not be presented.
     */
    getFirstTimestamp(): Promise<number>;
    /** Returns the end timestamp of the last packet of this track, in seconds. */
    computeDuration(): Promise<number>;
    /** Computes aggregate packet statistics for this track, such as average packet rate or bitrate. */
    computePacketStats(): Promise<PacketStats>;
}

/**
 * Represents a video track in an input file.
 * @public
 */
export declare class InputVideoTrack extends InputTrack {
    get type(): TrackType;
    get codec(): "avc" | "hevc" | "vp9" | "av1" | "vp8" | null;
    /** The width of the track's coded samples, before any transformations or rotations. */
    get codedWidth(): number;
    /** The height of the track's coded samples, before any transformations or rotations. */
    get codedHeight(): number;
    /** The angle in degrees by which the track's frames should be rotated (clockwise). */
    get rotation(): Rotation;
    /** The width of the track's frames after rotation. */
    get displayWidth(): number;
    /** The height of the track's frames after rotation. */
    get displayHeight(): number;
    /** Returns the color space of the track's samples. */
    getColorSpace(): Promise<VideoColorSpaceInit>;
    /** Returns true iff the track's samples use a high dynamic range (HDR). */
    hasHighDynamicRange(): Promise<boolean>;
    /** Returns the decoder configuration for decoding the track's packets using a VideoDecoder. */
    getDecoderConfig(): Promise<VideoDecoderConfig | null>;
    getCodecParameterString(): Promise<string | null>;
    canDecode(): Promise<boolean>;
}

/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @public
 */
export declare abstract class IsobmffInputFormat extends InputFormat {
}

/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @public
 */
export declare abstract class IsobmffOutputFormat extends OutputFormat {
    constructor(options?: IsobmffOutputFormatOptions);
    getSupportedTrackCounts(): TrackCountLimits;
    get supportsVideoRotationMetadata(): boolean;
}

/**
 * Options controlling the format of an output ISOBMFF file.
 * @public
 */
export declare type IsobmffOutputFormatOptions = {
    /**
     * Controls the placement of metadata in the file. Placing metadata at the start of the file is known as "Fast
     * Start", which results in better playback at the cost of more required processing or memory.
     *
     * Use `false` to disable Fast Start, placing the metadata at the end of the file. Fastest and uses the least
     * memory.
     *
     * Use `'in-memory'` to produce a file with Fast Start by keeping all media chunks in memory until the file is
     * finalized. This produces a high-quality and compact output at the cost of a more expensive finalization step and
     * higher memory requirements. Data will be written monotonically (in order) when this option is set.
     *
     * Use `'fragmented'` to place metadata at the start of the file by creating a fragmented file. In a
     * fragmented file, chunks of media and their metadata are written to the file in "fragments", eliminating the need
     * to put all metadata in one place. Fragmented files are useful for streaming, as they allow for better random
     * access. Furthermore, they remain lightweight to create even for very large files, as they don't require all media
     * to be kept in memory. However, fragmented files are not as widely and wholly supported as regular MP4/MOV files.
     * Data will be written monotonically (in order) when this option is set.
     *
     * When this field is not defined, either `false` or `'in-memory'` will be used, automatically determined based on
     * the type of output target used.
     */
    fastStart?: false | 'in-memory' | 'fragmented';
};

/**
 * Matroska input format singleton.
 * @public
 */
export declare const MATROSKA: MatroskaInputFormat;

/**
 * Matroska file format.
 * @public
 */
export declare class MatroskaInputFormat extends InputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * Union type of known media codecs.
 * @public
 */
export declare type MediaCodec = VideoCodec | AudioCodec | SubtitleCodec;

/**
 * Base class for media sources. Media sources are used to add media samples to an output file.
 * @public
 */
declare abstract class MediaSource_2 {
    /**
     * Closes this source. This prevents future samples from being added and signals to the output file that no further
     * samples will come in for this track. Calling `.close()` is optional but recommended after adding the
     * last sample - for improved performance and reduced memory usage.
     */
    close(): Promise<void>;
}
export { MediaSource_2 as MediaSource }

/**
 * Audio source that encodes the data of a MediaStreamAudioTrack and pipes it into the output. This is useful for
 * capturing live or real-time audio such as microphones or audio from other media elements. Audio will automatically
 * start being captured once the connected Output is started, and will keep being captured until the Output is
 * finalized or this source is closed.
 * @public
 */
export declare class MediaStreamAudioTrackSource extends AudioSource {
    constructor(track: MediaStreamAudioTrack, encodingConfig: AudioEncodingConfig);
}

/**
 * Video source that encodes the frames of a MediaStreamVideoTrack and pipes them into the output. This is useful for
 * capturing live or real-time data such as webcams or screen captures. Frames will automatically start being captured
 * once the connected Output is started, and will keep being captured until the Output is finalized or this source
 * is closed.
 * @public
 */
export declare class MediaStreamVideoTrackSource extends VideoSource {
    constructor(track: MediaStreamVideoTrack, encodingConfig: VideoEncodingConfig);
}

/**
 * Matroska file format.
 * @public
 */
export declare class MkvOutputFormat extends OutputFormat {
    constructor(options?: MkvOutputFormatOptions);
    getSupportedTrackCounts(): TrackCountLimits;
    get fileExtension(): string;
    getSupportedCodecs(): MediaCodec[];
    get supportsVideoRotationMetadata(): boolean;
}

/**
 * Options controlling the format of an output Matroska file.
 * @public
 */
export declare type MkvOutputFormatOptions = {
    /**
     * Configures the output to only write data monotonically, useful for live-streaming the file as it's being muxed.
     * When enabled, some features such as storing duration and seeking will be disabled or impacted, so don't use this
     * option when you want to write out a file for later use.
     */
    streamable?: boolean;
};

/**
 * QuickTime File Format (QTFF), often called MOV. Supports all video and audio codecs, but not subtitle codecs.
 * @public
 */
export declare class MovOutputFormat extends IsobmffOutputFormat {
    get fileExtension(): string;
    getSupportedCodecs(): MediaCodec[];
}

/**
 * MP3 input format singleton.
 * @public
 */
export declare const MP3: Mp3InputFormat;

/**
 * MP3 file format.
 * @public
 */
export declare class Mp3InputFormat extends InputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * MP3 file format.
 * @public
 */
export declare class Mp3OutputFormat extends OutputFormat {
    getSupportedTrackCounts(): TrackCountLimits;
    get fileExtension(): string;
    getSupportedCodecs(): MediaCodec[];
    get supportsVideoRotationMetadata(): boolean;
}

/**
 * MP4 input format singleton.
 * @public
 */
export declare const MP4: Mp4InputFormat;

/**
 * MPEG-4 Part 14 (MP4) file format.
 * @public
 */
export declare class Mp4InputFormat extends IsobmffInputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * MPEG-4 Part 14 (MP4) file format. Supports all codecs except PCM audio codecs.
 * @public
 */
export declare class Mp4OutputFormat extends IsobmffOutputFormat {
    get fileExtension(): string;
    getSupportedCodecs(): MediaCodec[];
}

/**
 * List of known compressed audio codecs, ordered by encoding preference.
 * @public
 */
export declare const NON_PCM_AUDIO_CODECS: readonly ["aac", "opus", "mp3", "vorbis", "flac"];

/**
 * Ogg input format singleton.
 * @public
 */
export declare const OGG: OggInputFormat;

/**
 * Ogg file format.
 * @public
 */
export declare class OggInputFormat extends InputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * Ogg file format.
 * @public
 */
export declare class OggOutputFormat extends OutputFormat {
    getSupportedTrackCounts(): TrackCountLimits;
    get fileExtension(): string;
    getSupportedCodecs(): MediaCodec[];
    get supportsVideoRotationMetadata(): boolean;
}

/**
 * Main class orchestrating the creation of a new media file.
 * @public
 */
export declare class Output<F extends OutputFormat = OutputFormat, T extends Target = Target> {
    /** The format of the output file. */
    format: F;
    /** The target to which the file will be written. */
    target: T;
    /** The current state of the output. */
    state: 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized';
    constructor(options: OutputOptions<F, T>);
    /** Adds a video track to the output with the given source. Must be called before output is started. */
    addVideoTrack(source: VideoSource, metadata?: VideoTrackMetadata): void;
    /** Adds an audio track to the output with the given source. Must be called before output is started. */
    addAudioTrack(source: AudioSource, metadata?: AudioTrackMetadata): void;
    /** Adds a subtitle track to the output with the given source. Must be called before output is started. */
    addSubtitleTrack(source: SubtitleSource, metadata?: SubtitleTrackMetadata): void;
    /**
     * Starts the creation of the output file. This method should be called after all tracks have been added. Only after
     * the output has started can media samples be added to the tracks.
     *
     * @returns A promise that resolves when the output has successfully started and is ready to receive media samples.
     */
    start(): Promise<void>;
    /**
     * Cancels the creation of the output file, releasing internal resources like encoders and preventing further
     * samples from being added.
     *
     * @returns A promise that resolves once all internal resources have been released.
     */
    cancel(): Promise<void>;
    /**
     * Finalizes the output file. This method must be called after all media samples across all tracks have been added.
     * Once the Promise returned by this method completes, the output file is ready.
     */
    finalize(): Promise<void>;
}

/**
 * Base class representing an output media file format.
 * @public
 */
export declare abstract class OutputFormat {
    /** The file extension used by this output format, beginning with a dot. */
    abstract get fileExtension(): string;
    /** Returns a list of media codecs that this output format can contain. */
    abstract getSupportedCodecs(): MediaCodec[];
    /** Returns the number of tracks that this output format supports. */
    abstract getSupportedTrackCounts(): TrackCountLimits;
    /** Whether this output format supports video rotation metadata. */
    abstract get supportsVideoRotationMetadata(): boolean;
    /** Returns a list of video codecs that this output format can contain. */
    getSupportedVideoCodecs(): VideoCodec[];
    /** Returns a list of audio codecs that this output format can contain. */
    getSupportedAudioCodecs(): AudioCodec[];
    /** Returns a list of subtitle codecs that this output format can contain. */
    getSupportedSubtitleCodecs(): SubtitleCodec[];
}

/**
 * The options for creating an Output object.
 * @public
 */
export declare type OutputOptions<F extends OutputFormat = OutputFormat, T extends Target = Target> = {
    /** The format of the output file. */
    format: F;
    /** The target to which the file will be written. */
    target: T;
};

/**
 * Additional options for controlling packet retrieval.
 * @public
 */
export declare type PacketRetrievalOptions = {
    /**
     * When set to true, only packet metadata (like timestamp) will be retrieved - the actual packet data will not
     * be loaded.
     */
    metadataOnly?: boolean;
};

/**
 * Contains aggregate statistics about the encoded packets of a track.
 * @public
 */
export declare type PacketStats = {
    /** The total number of packets. */
    packetCount: number;
    /** The average number of packets per second. For video tracks, this will equal the average frame rate (FPS). */
    averagePacketRate: number;
    /** The average number of bits per second. */
    averageBitrate: number;
};

/**
 * The type of a packet. Key packets can be decoded without previous packets, while delta packets depend on previous
 * packets.
 * @public
 */
export declare type PacketType = 'key' | 'delta';

/**
 * List of known PCM (uncompressed) audio codecs, ordered by encoding preference.
 * @public
 */
export declare const PCM_AUDIO_CODECS: readonly ["pcm-s16", "pcm-s16be", "pcm-s24", "pcm-s24be", "pcm-s32", "pcm-s32be", "pcm-f32", "pcm-f32be", "pcm-u8", "pcm-s8", "ulaw", "alaw"];

/**
 * QuickTime File Format input format singleton.
 * @public
 */
export declare const QTFF: QuickTimeInputFormat;

/**
 * Represents a subjective media quality level.
 * @public
 */
export declare class Quality {
}

/**
 * Represents a high media quality.
 * @public
 */
export declare const QUALITY_HIGH: Quality;

/**
 * Represents a low media quality.
 * @public
 */
export declare const QUALITY_LOW: Quality;

/**
 * Represents a medium media quality.
 * @public
 */
export declare const QUALITY_MEDIUM: Quality;

/**
 * Represents a very high media quality.
 * @public
 */
export declare const QUALITY_VERY_HIGH: Quality;

/**
 * Represents a very low media quality.
 * @public
 */
export declare const QUALITY_VERY_LOW: Quality;

/**
 * QuickTime File Format (QTFF), often called MOV.
 * @public
 */
export declare class QuickTimeInputFormat extends IsobmffInputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * Registers a custom video or audio decoder. Registered decoders will automatically be used for decoding whenever
 * possible.
 * @public
 */
export declare const registerDecoder: (decoder: typeof CustomVideoDecoder | typeof CustomAudioDecoder) => void;

/**
 * Registers a custom video or audio encoder. Registered encoders will automatically be used for encoding whenever
 * possible.
 * @public
 */
export declare const registerEncoder: (encoder: typeof CustomVideoEncoder | typeof CustomAudioEncoder) => void;

/**
 * Represents a clockwise rotation in degrees.
 * @public
 */
export declare type Rotation = 0 | 90 | 180 | 270;

/**
 * Sets all keys K of T to be required.
 * @public
 */
export declare type SetRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * The source base class, representing a resource from which bytes can be read.
 * @public
 */
export declare abstract class Source {
    /** Called each time data is requested from the source. */
    onread: ((range: {
        /** The start byte offset (inclusive). */
        start: number;
        /** The end byte offset (exclusive). */
        end: number;
    }) => unknown) | null;
}

/**
 * A general-purpose, callback-driven source that can get its data from anywhere.
 * @public
 */
export declare class StreamSource extends Source {
    constructor(options: StreamSourceOptions);
}

/**
 * Options for defining a StreamSource.
 * @public
 */
export declare type StreamSourceOptions = {
    /** Called when data is requested. Should return or resolve to the bytes from the specified byte range. */
    read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>;
    /** Called when the size of the entire file is requested. Should return or resolve to the size in bytes. */
    getSize: () => number | Promise<number>;
};

/**
 * This target writes data to a WritableStream, making it a general-purpose target for writing data anywhere. It is
 * also compatible with FileSystemWritableFileStream for use with the File System Access API. The WritableStream can
 * also apply backpressure, which will propagate to the output and throttle the encoders.
 * @public
 */
export declare class StreamTarget extends Target {
    constructor(writable: WritableStream<StreamTargetChunk>, options?: StreamTargetOptions);
}

/**
 * A data chunk for StreamTarget.
 * @public
 */
export declare type StreamTargetChunk = {
    /** The operation type. */
    type: 'write';
    /** The data to write. */
    data: Uint8Array;
    /** The byte offset in the output file at which to write the data. */
    position: number;
};

/**
 * Options for StreamTarget.
 * @public
 */
export declare type StreamTargetOptions = {
    /**
     * When setting this to true, data created by the output will first be accumulated and only written out
     * once it has reached sufficient size, using a default chunk size of 16 MiB. This is useful for reducing the total
     * amount of writes, at the cost of latency.
     */
    chunked?: boolean;
    /** When using `chunked: true`, this specifies the maximum size of each chunk. Defaults to 16 MiB. */
    chunkSize?: number;
};

/**
 * List of known subtitle codecs, ordered by encoding preference.
 * @public
 */
export declare const SUBTITLE_CODECS: readonly ["webvtt"];

/**
 * Union type of known subtitle codecs.
 * @public
 */
export declare type SubtitleCodec = typeof SUBTITLE_CODECS[number];

/**
 * Base class for subtitle sources - sources for subtitle tracks.
 * @public
 */
export declare abstract class SubtitleSource extends MediaSource_2 {
    constructor(codec: SubtitleCodec);
}

/**
 * Additional metadata for subtitle tracks.
 * @public
 */
export declare type SubtitleTrackMetadata = BaseTrackMetadata & {};

/**
 * Base class for targets, specifying where output files are written.
 * @public
 */
export declare abstract class Target {
}

/**
 * This source can be used to add subtitles from a subtitle text file.
 * @public
 */
export declare class TextSubtitleSource extends SubtitleSource {
    constructor(codec: SubtitleCodec);
    /**
     * Parses the subtitle text according to the specified codec and adds it to the output track. You don't have to
     * add the entire subtitle file at once here; you can provide it in chunks.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(text: string): Promise<void>;
}

/**
 * Specifies the number of tracks (for each track type and in total) that an output format supports.
 * @public
 */
export declare type TrackCountLimits = {
    [K in TrackType]: InclusiveIntegerRange;
} & {
    /** Specifies the overall allowed range of track counts for the output format. */
    total: InclusiveIntegerRange;
};

/**
 * Union type of all track types.
 * @public
 */
export declare type TrackType = typeof ALL_TRACK_TYPES[number];

/**
 * A source backed by a URL. This is useful for reading data from the network. Be careful using this source however,
 * as it typically comes with increased latency.
 * @public
 */
export declare class UrlSource extends Source {
    constructor(url: string, options?: {
        /** If credentials are to be included in a cross-origin request. */
        withCredentials?: boolean;
    });
}

/**
 * List of known video codecs, ordered by encoding preference.
 * @public
 */
export declare const VIDEO_CODECS: readonly ["avc", "hevc", "vp9", "av1", "vp8"];

/**
 * Union type of known video codecs.
 * @public
 */
export declare type VideoCodec = typeof VIDEO_CODECS[number];

/**
 * Configuration object that controls video encoding. Can be used to set codec, quality, and more.
 * @public
 */
export declare type VideoEncodingConfig = {
    /** The video codec that should be used for encoding the video samples (frames). */
    codec: VideoCodec;
    /**
     * The target bitrate for the encoded video, in bits per second. Alternatively, a subjective Quality can
     * be provided.
     */
    bitrate: number | Quality;
    /** The latency mode used by the encoder; controls the performance-quality tradeoff. */
    latencyMode?: VideoEncoderConfig['latencyMode'];
    /**
     * The interval, in seconds, of how often frames are encoded as a key frame. The default is 5 seconds. Frequent key
     * frames improve seeking behavior but increase file size. When using multiple video tracks, you should give them
     * all the same key frame interval.
     */
    keyFrameInterval?: number;
    /** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
    onEncodedPacket?: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => unknown;
    /** Called when an error occurs during encoding. */
    onEncodingError?: (error: Error) => unknown;
};

/**
 * Represents a raw, unencoded video sample (frame). Mainly used as an expressive wrapper around WebCodecs API's
 * VideoFrame, but can also be used standalone.
 * @public
 */
export declare class VideoSample {
    /** The internal pixel format in which the frame is stored. */
    readonly format: VideoPixelFormat | null;
    /** The width of the frame in pixels. */
    readonly codedWidth: number;
    /** The height of the frame in pixels. */
    readonly codedHeight: number;
    /** The rotation of the frame in degrees, clockwise. */
    readonly rotation: Rotation;
    /**
     * The timestamp of the frame in seconds. May be negative. Frames with negative end timestamps should not
     * be presented.
     */
    readonly timestamp: number;
    /** The duration of the frame in seconds. */
    readonly duration: number;
    /** The color space of the frame. */
    readonly colorSpace: VideoColorSpace;
    /** The width of the frame in pixels after rotation. */
    get displayWidth(): number;
    /** The height of the frame in pixels after rotation. */
    get displayHeight(): number;
    /** The timestamp of the frame in microseconds. */
    get microsecondTimestamp(): number;
    /** The duration of the frame in microseconds. */
    get microsecondDuration(): number;
    constructor(data: VideoFrame, init?: VideoSampleInit);
    constructor(data: CanvasImageSource, init: SetRequired<VideoSampleInit, 'timestamp'>);
    constructor(data: BufferSource, init: SetRequired<VideoSampleInit, 'format' | 'codedWidth' | 'codedHeight' | 'timestamp'>);
    /** Clones this video sample. */
    clone(): VideoSample;
    /**
     * Closes this video sample, releasing held resources. Video samples should be closed as soon as they are not
     * needed anymore.
     */
    close(): void;
    /** Returns the number of bytes required to hold this video sample's pixel data. */
    allocationSize(): number;
    /** Copies this video sample's pixel data to an ArrayBuffer or ArrayBufferView. */
    copyTo(destination: AllowSharedBufferSource): Promise<void>;
    /**
     * Converts this video sample to a VideoFrame for use with the WebCodecs API. The VideoFrame returned by this
     * method *must* be closed separately from this video sample.
     */
    toVideoFrame(): VideoFrame;
    /**
     * Draws the video sample to a 2D canvas context. Rotation metadata will be taken into account.
     *
     * @param dx - The x-coordinate in the destination canvas at which to place the top-left corner of the source image.
     * @param dy - The y-coordinate in the destination canvas at which to place the top-left corner of the source image.
     * @param dWidth - The width to draw the image in the destination canvas. This allows scaling of the drawn image.
     * @param dHeight - The height to draw the image in the destination canvas. This allows scaling of the drawn image.
     */
    draw(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, dx: number, dy: number, dWidth?: number, dHeight?: number): void;
    /** Converts this video sample to a CanvasImageSource for drawing to a canvas. */
    toCanvasImageSource(): VideoFrame | OffscreenCanvas;
    /** Sets the rotation metadata of this video sample. */
    setRotation(newRotation: Rotation): void;
    /** Sets the timestamp of this video sample, in seconds. */
    setTimestamp(newTimestamp: number): void;
    /** Sets the duration of this video sample, in seconds. */
    setDuration(newDuration: number): void;
}

/**
 * Metadata used for VideoSample initialization.
 * @public
 */
export declare type VideoSampleInit = {
    /** The internal pixel format in which the frame is stored. */
    format?: VideoPixelFormat;
    /** The width of the frame in pixels. */
    codedWidth?: number;
    /** The height of the frame in pixels. */
    codedHeight?: number;
    /** The rotation of the frame in degrees, clockwise. */
    rotation?: Rotation;
    /** The timestamp of the frame in seconds. */
    timestamp?: number;
    /** The duration of the frame in seconds. */
    duration?: number;
    /** The color space of the frame. */
    colorSpace?: VideoColorSpaceInit;
};

/**
 * A sink that retrieves decoded video samples (video frames) from a video track.
 * @public
 */
export declare class VideoSampleSink extends BaseMediaSampleSink<VideoSample> {
    constructor(videoTrack: InputVideoTrack);
    /**
     * Retrieves the video sample (frame) corresponding to the given timestamp, in seconds. More specifically, returns
     * the last video sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getSample(timestamp: number): Promise<VideoSample | null>;
    /**
     * Creates an async iterator that yields the video samples (frames) of this track in presentation order. This method
     * will intelligently pre-decode a few frames ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
     */
    samples(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<VideoSample, void, unknown>;
    /**
     * Creates an async iterator that yields a video sample (frame) for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
     * yield null if no frame is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    samplesAtTimestamps(timestamps: AnyIterable<number>): AsyncGenerator<VideoSample | null, void, unknown>;
}

/**
 * This source can be used to add raw, unencoded video samples (frames) to an output video track. These frames will
 * automatically be encoded and then piped into the output.
 * @public
 */
export declare class VideoSampleSource extends VideoSource {
    constructor(encodingConfig: VideoEncodingConfig);
    /**
     * Encodes a video sample (frame) and then adds it to the output.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(videoSample: VideoSample, encodeOptions?: VideoEncoderEncodeOptions): Promise<void>;
}

/**
 * Base class for video sources - sources for video tracks.
 * @public
 */
export declare abstract class VideoSource extends MediaSource_2 {
    constructor(codec: VideoCodec);
}

/**
 * Additional metadata for video tracks.
 * @public
 */
export declare type VideoTrackMetadata = BaseTrackMetadata & {
    /** The angle in degrees by which the track's frames should be rotated (clockwise). */
    rotation?: Rotation;
    /** The expected video frame rate. You should not exceed the value you set here. */
    frameRate?: number;
};

/**
 * WAVE input format singleton.
 * @public
 */
export declare const WAVE: WaveInputFormat;

/**
 * WAVE file format, based on RIFF.
 * @public
 */
export declare class WaveInputFormat extends InputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * WAVE file format, based on RIFF.
 * @public
 */
export declare class WaveOutputFormat extends OutputFormat {
    getSupportedTrackCounts(): TrackCountLimits;
    get fileExtension(): string;
    getSupportedCodecs(): MediaCodec[];
    get supportsVideoRotationMetadata(): boolean;
}

/**
 * WebM input format singleton.
 * @public
 */
export declare const WEBM: WebMInputFormat;

/**
 * WebM file format, based on Matroska.
 * @public
 */
export declare class WebMInputFormat extends MatroskaInputFormat {
    getName(): string;
    getMimeType(): string;
}

/**
 * WebM file format, based on Matroska.
 * @public
 */
export declare class WebMOutputFormat extends MkvOutputFormat {
    getSupportedCodecs(): MediaCodec[];
    get fileExtension(): string;
}

/**
 * Options controlling the format of an output WebM file.
 * @public
 */
export declare type WebMOutputFormatOptions = MkvOutputFormatOptions;

/**
 * An AudioBuffer with additional timing information (timestamp & duration).
 * @public
 */
export declare type WrappedAudioBuffer = {
    /** An AudioBuffer. */
    buffer: AudioBuffer;
    /** The timestamp of the corresponding audio sample, in seconds. */
    timestamp: number;
    /** The duration of the corresponding audio sample, in seconds. */
    duration: number;
};

/**
 * A canvas with additional timing information (timestamp & duration).
 * @public
 */
export declare type WrappedCanvas = {
    /** A canvas element or offscreen canvas. */
    canvas: HTMLCanvasElement | OffscreenCanvas;
    /** The timestamp of the corresponding video sample, in seconds. */
    timestamp: number;
    /** The duration of the corresponding video sample, in seconds. */
    duration: number;
};

export { }

export as namespace Metamuxer;