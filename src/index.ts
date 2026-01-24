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
	BaseTrackMetadata,
	VideoTrackMetadata,
	AudioTrackMetadata,
	SubtitleTrackMetadata,
} from './output';
export {
	OutputFormat,
	AdtsOutputFormat,
	AdtsOutputFormatOptions,
	FlacOutputFormat,
	FlacOutputFormatOptions,
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
	MediaStreamVideoTrackSource,
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
	VideoEncodingConfig,
	VideoEncodingAdditionalOptions,
	AudioEncodingConfig,
	AudioEncodingAdditionalOptions,
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
	BufferTarget,
	FilePathTarget,
	FilePathTargetOptions,
	NullTarget,
	StreamTarget,
	StreamTargetOptions,
	StreamTargetChunk,
} from './target';
export {
	AnyIterable,
	MaybePromise,
	Rotation,
	SetRequired,
} from './misc';
export {
	TrackType,
	ALL_TRACK_TYPES,
} from './output';
export {
	Source,
	BlobSource,
	BlobSourceOptions,
	BufferSource,
	FilePathSource,
	FilePathSourceOptions,
	StreamSource,
	StreamSourceOptions,
	ReadableStreamSource,
	ReadableStreamSourceOptions,
	UrlSource,
	UrlSourceOptions,
} from './source';
export {
	InputFormat,
	AdtsInputFormat,
	FlacInputFormat,
	IsobmffInputFormat,
	MatroskaInputFormat,
	Mp3InputFormat,
	Mp4InputFormat,
	MpegTsInputFormat,
	OggInputFormat,
	QuickTimeInputFormat,
	WaveInputFormat,
	WebMInputFormat,
	ALL_FORMATS,
	ADTS,
	FLAC,
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
	InputDisposedError,
} from './input';
export {
	InputTrack,
	InputVideoTrack,
	InputAudioTrack,
	PacketStats,
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
