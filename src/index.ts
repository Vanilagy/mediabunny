/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// <reference types="dom-mediacapture-transform" preserve="true" />
/// <reference types="dom-webcodecs" preserve="true" />

export {
	Output,
	OutputOptions,
	BaseTrackMetadata,
	VideoTrackMetadata,
	AudioTrackMetadata,
	SubtitleTrackMetadata,
	TrackType,
	ALL_TRACK_TYPES,
} from './output';
export {
	OutputFormat,
	IsobmffOutputFormat,
	Mp4OutputFormat,
	MovOutputFormat,
	IsobmffOutputFormatOptions,
	MkvOutputFormat,
	MkvOutputFormatOptions,
	WebMOutputFormat,
	WebMOutputFormatOptions,
	Mp3OutputFormat,
	Mp3OutputFormatOptions,
	WavOutputFormat,
	WavOutputFormatOptions,
	OggOutputFormat,
	OggOutputFormatOptions,
	AdtsOutputFormat,
	AdtsOutputFormatOptions,
	TrackCountLimits,
	InclusiveIntegerRange,
} from './output-format';
export {
	MediaSource,
	VideoSource,
	EncodedVideoPacketSource,
	VideoSampleSource,
	CanvasSource,
	MediaStreamVideoTrackSource,
	AudioSource,
	EncodedAudioPacketSource,
	AudioSampleSource,
	AudioBufferSource,
	MediaStreamAudioTrackSource,
	SubtitleSource,
	TextSubtitleSource,
} from './media-source';
export {
	VIDEO_CODECS,
	VideoCodec,
	PCM_AUDIO_CODECS,
	NON_PCM_AUDIO_CODECS,
	AUDIO_CODECS,
	AudioCodec,
	SUBTITLE_CODECS,
	SubtitleCodec,
	MediaCodec,
	Quality,
	QUALITY_VERY_LOW,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
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
} from './encode';
export { Target, BufferTarget, StreamTarget, StreamTargetChunk, StreamTargetOptions, NullTarget } from './target';
export { Rotation, AnyIterable, SetRequired, MaybePromise } from './misc';
export {
	Source,
	BufferSource,
	BlobSource,
	BlobSourceOptions,
	UrlSource,
	UrlSourceOptions,
	FilePathSource,
	FilePathSourceOptions,
	StreamSource,
	StreamSourceOptions,
	ReadableStreamSource,
	ReadableStreamSourceOptions,
} from './source';
export {
	InputFormat,
	IsobmffInputFormat,
	Mp4InputFormat,
	QuickTimeInputFormat,
	MatroskaInputFormat,
	WebMInputFormat,
	Mp3InputFormat,
	WaveInputFormat,
	OggInputFormat,
	ALL_FORMATS,
	MP4,
	QTFF,
	MATROSKA,
	WEBM,
	MP3,
	WAVE,
	OGG,
} from './input-format';
export { Input, InputOptions } from './input';
export { InputTrack, InputVideoTrack, InputAudioTrack, PacketStats } from './input-track';
export { EncodedPacket, PacketType } from './packet';
export {
	VideoSample,
	VideoSampleInit,
	AudioSample,
	AudioSampleInit,
	AudioSampleCopyToOptions,
} from './sample';
export {
	PacketRetrievalOptions,
	EncodedPacketSink,
	BaseMediaSampleSink,
	VideoSampleSink,
	CanvasSinkOptions,
	CanvasSink,
	WrappedCanvas,
	AudioSampleSink,
	AudioBufferSink,
	WrappedAudioBuffer,
} from './media-sink';
export { Conversion, ConversionOptions, ConversionVideoOptions, ConversionAudioOptions } from './conversion';
export {
	CustomVideoDecoder,
	CustomAudioDecoder,
	CustomVideoEncoder,
	CustomAudioEncoder,
	registerDecoder,
	registerEncoder,
} from './custom-coder';

// 🐡🦔
