/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// <reference types="dom-mediacapture-transform" preserve="true" />
/// <reference types="dom-webcodecs" preserve="true" />

const MEDIABUNNY_LOADED_SYMBOL = Symbol.for('mediabunny loaded');
if ((globalThis as Record<symbol, unknown>)[MEDIABUNNY_LOADED_SYMBOL]) {
	console.error(
		'[WARNING]\nMediabunny was loaded twice.'
		+ ' This will likely cause Mediabunny not to work correctly.'
		+ ' Check if multiple dependencies are importing different versions of Mediabunny,'
		+ ' or if something is being bundled incorrectly.',
	);
}
(globalThis as Record<symbol, unknown>)[MEDIABUNNY_LOADED_SYMBOL] = true;

export {
	Output,
	type OutputOptions,
	OutputTrack,
	OutputVideoTrack,
	OutputAudioTrack,
	OutputSubtitleTrack,
	OutputTrackGroup,
	type BaseTrackMetadata,
	type VideoTrackMetadata,
	type AudioTrackMetadata,
	type SubtitleTrackMetadata,
	type OutputEvents,
} from './output';
export {
	OutputFormat,
	AdtsOutputFormat,
	type AdtsOutputFormatOptions,
	CmafOutputFormat,
	type CmafOutputFormatOptions,
	FlacOutputFormat,
	type FlacOutputFormatOptions,
	HlsOutputFormat,
	type HlsOutputFormatOptions,
	type HlsOutputPlaylistInfo,
	type HlsOutputSegmentInfo,
	IsobmffOutputFormat,
	type IsobmffOutputFormatOptions,
	MkvOutputFormat,
	type MkvOutputFormatOptions,
	MovOutputFormat,
	Mp3OutputFormat,
	type Mp3OutputFormatOptions,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	type MpegTsOutputFormatOptions,
	OggOutputFormat,
	type OggOutputFormatOptions,
	WavOutputFormat,
	type WavOutputFormatOptions,
	WebMOutputFormat,
	type WebMOutputFormatOptions,
	type InclusiveIntegerRange,
	type TrackCountLimits,
} from './output-format';
export {
	MediaSource,
	VideoSource,
	AudioSource,
	SubtitleSource,
	AudioBufferSource,
	AudioSampleSource,
	CanvasSource,
	EncodedAudioPacketSource,
	EncodedVideoPacketSource,
	MediaStreamAudioTrackSource,
	type MediaStreamAudioTrackSourceOptions,
	MediaStreamVideoTrackSource,
	type MediaStreamVideoTrackSourceOptions,
	TextSubtitleSource,
	VideoSampleSource,
} from './media-source';
export {
	type MediaCodec,
	type VideoCodec,
	type AudioCodec,
	type SubtitleCodec,
	VIDEO_CODECS,
	AUDIO_CODECS,
	PCM_AUDIO_CODECS,
	NON_PCM_AUDIO_CODECS,
	SUBTITLE_CODECS,
} from './codec';
export {
	canDecode,
	canDecodeVideo,
	canDecodeAudio,
	getDecodableCodecs,
	getDecodableVideoCodecs,
	getDecodableAudioCodecs,
} from './decode';
export {
	type VideoEncodingConfig,
	type VideoEncodingAdditionalOptions,
	type VideoTransformOptions,
	type AudioEncodingConfig,
	type AudioEncodingAdditionalOptions,
	type AudioTransformOptions,
	canEncode,
	canEncodeVideo,
	canEncodeAudio,
	canEncodeSubtitles,
	getEncodableCodecs,
	getEncodableVideoCodecs,
	getEncodableAudioCodecs,
	getEncodableSubtitleCodecs,
	getFirstEncodableVideoCodec,
	getFirstEncodableAudioCodec,
	getFirstEncodableSubtitleCodec,
	Quality,
	QUALITY_VERY_LOW,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from './encode';
export {
	Target,
	type TargetEvents,
	type TargetRequest,
	AppendOnlyStreamTarget,
	BufferTarget,
	type BufferTargetOptions,
	FilePathTarget,
	type FilePathTargetOptions,
	NullTarget,
	PathedTarget,
	RangedTarget,
	StreamTarget,
	type StreamTargetOptions,
	type StreamTargetChunk,
} from './target';
export {
	type AnyIterable,
	ConcurrentRunner,
	EventEmitter,
	type EventListenerOptions,
	type FilePath,
	type MaybePromise,
} from './misc';
export {
	type PsshBox,
} from './isobmff/isobmff-misc';
export {
	type Rational,
	type Rectangle,
	type Rotation,
	type SetOptional,
	type SetRequired,
} from './misc';
export {
	type TrackType,
	ALL_TRACK_TYPES,
} from './output';
export {
	Source,
	type SourceEvents,
	SourceRef,
	type SourceRequest,
	BlobSource,
	type BlobSourceOptions,
	BufferSource,
	CustomPathedSource,
	FilePathSource,
	type FilePathSourceOptions,
	PathedSource,
	StreamSource,
	type StreamSourceOptions,
	RangedSource,
	ReadableStreamSource,
	type ReadableStreamSourceOptions,
	UrlSource,
	type UrlSourceOptions,
} from './source';
export {
	InputFormat,
	type InputFormatOptions,
	AdtsInputFormat,
	FlacInputFormat,
	IsobmffInputFormat,
	type IsobmffInputFormatOptions,
	HlsInputFormat,
	MatroskaInputFormat,
	Mp3InputFormat,
	Mp4InputFormat,
	MpegTsInputFormat,
	OggInputFormat,
	QuickTimeInputFormat,
	WaveInputFormat,
	WebMInputFormat,
	ALL_FORMATS,
	HLS_FORMATS,
	ADTS,
	FLAC,
	HLS,
	MATROSKA,
	MP3,
	MP4,
	MPEG_TS,
	OGG,
	QTFF,
	WAVE,
	WEBM,
} from './input-format';
export {
	Input,
	type InputOptions,
	type InputEvents,
	InputDisposedError,
	UnsupportedInputFormatError,
} from './input';
export {
	type DurationMetadataRequestOptions,
} from './demuxer';
export {
	InputTrack,
	InputVideoTrack,
	InputAudioTrack,
	type InputTrackQuery,
	type PacketStats,
	asc,
	desc,
	prefer,
} from './input-track';
export {
	EncodedPacket,
	type EncodedPacketSideData,
	type PacketType,
} from './packet';
export {
	AudioSample,
	type AudioSampleInit,
	type AudioSampleCopyToOptions,
	VideoSample,
	type VideoSampleInit,
	type VideoSamplePixelFormat,
	VideoSampleColorSpace,
	type CropRectangle,
	VIDEO_SAMPLE_PIXEL_FORMATS,
} from './sample';
export {
	AudioBufferSink,
	AudioSampleSink,
	BaseMediaSampleSink,
	CanvasSink,
	type CanvasSinkOptions,
	EncodedPacketSink,
	type PacketRetrievalOptions,
	VideoSampleSink,
	type WrappedAudioBuffer,
	type WrappedCanvas,
} from './media-sink';
export {
	Conversion,
	type ConversionOptions,
	type ConversionVideoOptions,
	type ConversionAudioOptions,
	ConversionCanceledError,
	type DiscardedTrack,
} from './conversion';
export {
	CustomVideoDecoder,
	CustomVideoEncoder,
	CustomAudioDecoder,
	CustomAudioEncoder,
	registerDecoder,
	registerEncoder,
} from './custom-coder';
export {
	type MetadataTags,
	type AttachedImage,
	RichImageData,
	AttachedFile,
	type TrackDisposition,
} from './metadata';

// 🐡🦔
