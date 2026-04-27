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
	OutputOptions,
	OutputTrack,
	OutputVideoTrack,
	OutputAudioTrack,
	OutputSubtitleTrack,
	OutputTrackGroup,
	BaseTrackMetadata,
	VideoTrackMetadata,
	AudioTrackMetadata,
	SubtitleTrackMetadata,
	OutputEvents,
} from './output';
export {
	OutputFormat,
	AdtsOutputFormat,
	AdtsOutputFormatOptions,
	CmafOutputFormat,
	CmafOutputFormatOptions,
	FlacOutputFormat,
	FlacOutputFormatOptions,
	HlsOutputFormat,
	HlsOutputFormatOptions,
	HlsOutputPlaylistInfo,
	HlsOutputSegmentInfo,
	IsobmffOutputFormat,
	IsobmffOutputFormatOptions,
	MkvOutputFormat,
	MkvOutputFormatOptions,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp3OutputFormatOptions,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	MpegTsOutputFormatOptions,
	OggOutputFormat,
	OggOutputFormatOptions,
	WavOutputFormat,
	WavOutputFormatOptions,
	WebMOutputFormat,
	WebMOutputFormatOptions,
	InclusiveIntegerRange,
	TrackCountLimits,
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
	MediaStreamAudioTrackSourceOptions,
	MediaStreamVideoTrackSource,
	MediaStreamVideoTrackSourceOptions,
	TextSubtitleSource,
	VideoSampleSource,
} from './media-source';
export {
	MediaCodec,
	VideoCodec,
	AudioCodec,
	SubtitleCodec,
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
	VideoEncodingConfig,
	VideoEncodingAdditionalOptions,
	VideoTransformOptions,
	AudioEncodingConfig,
	AudioEncodingAdditionalOptions,
	AudioTransformOptions,
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
	TargetEvents,
	TargetRequest,
	AppendOnlyStreamTarget,
	BufferTarget,
	BufferTargetOptions,
	FilePathTarget,
	FilePathTargetOptions,
	NullTarget,
	PathedTarget,
	RangedTarget,
	StreamTarget,
	StreamTargetOptions,
	StreamTargetChunk,
} from './target';
export {
	AnyIterable,
	ConcurrentRunner,
	EventEmitter,
	EventListenerOptions,
	FilePath,
	MaybePromise,
} from './misc';
export {
	PsshBox,
} from './isobmff/isobmff-misc';
export {
	Rational,
	Rectangle,
	Rotation,
	SetOptional,
	SetRequired,
} from './misc';
export {
	TrackType,
	ALL_TRACK_TYPES,
} from './output';
export {
	Source,
	SourceEvents,
	SourceRef,
	SourceRequest,
	BlobSource,
	BlobSourceOptions,
	BufferSource,
	CustomPathedSource,
	FilePathSource,
	FilePathSourceOptions,
	PathedSource,
	StreamSource,
	StreamSourceOptions,
	RangedSource,
	ReadableStreamSource,
	ReadableStreamSourceOptions,
	UrlSource,
	UrlSourceOptions,
} from './source';
export {
	InputFormat,
	InputFormatOptions,
	AdtsInputFormat,
	FlacInputFormat,
	IsobmffInputFormat,
	IsobmffInputFormatOptions,
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
	InputOptions,
	InputEvents,
	InputDisposedError,
	UnsupportedInputFormatError,
} from './input';
export {
	DurationMetadataRequestOptions,
} from './demuxer';
export {
	InputTrack,
	InputVideoTrack,
	InputAudioTrack,
	InputTrackQuery,
	PacketStats,
	asc,
	desc,
	prefer,
} from './input-track';
export {
	EncodedPacket,
	EncodedPacketSideData,
	PacketType,
} from './packet';
export {
	AudioSample,
	AudioSampleInit,
	AudioSampleCopyToOptions,
	VideoSample,
	VideoSampleInit,
	VideoSamplePixelFormat,
	VideoSampleColorSpace,
	CropRectangle,
	VIDEO_SAMPLE_PIXEL_FORMATS,
} from './sample';
export {
	AudioBufferSink,
	AudioSampleSink,
	BaseMediaSampleSink,
	CanvasSink,
	CanvasSinkOptions,
	EncodedPacketSink,
	PacketRetrievalOptions,
	VideoSampleSink,
	WrappedAudioBuffer,
	WrappedCanvas,
} from './media-sink';
export {
	Conversion,
	ConversionOptions,
	ConversionVideoOptions,
	ConversionAudioOptions,
	ConversionCanceledError,
	DiscardedTrack,
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
	MetadataTags,
	AttachedImage,
	RichImageData,
	AttachedFile,
	TrackDisposition,
} from './metadata';

// 🐡🦔
