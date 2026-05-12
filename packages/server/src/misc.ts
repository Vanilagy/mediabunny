import { VideoSamplePixelFormat, MediaCodec } from 'mediabunny';
import * as NodeAv from 'node-av';

export const CODEC_TO_CODEC_ID: Partial<Record<MediaCodec, NodeAv.AVCodecID>> = {
	avc: NodeAv.AV_CODEC_ID_H264,
	hevc: NodeAv.AV_CODEC_ID_HEVC,
	vp8: NodeAv.AV_CODEC_ID_VP8,
	vp9: NodeAv.AV_CODEC_ID_VP9,
	av1: NodeAv.AV_CODEC_ID_AV1,

	aac: NodeAv.AV_CODEC_ID_AAC,
	opus: NodeAv.AV_CODEC_ID_OPUS,
	mp3: NodeAv.AV_CODEC_ID_MP3,
	vorbis: NodeAv.AV_CODEC_ID_VORBIS,
	flac: NodeAv.AV_CODEC_ID_FLAC,
	ac3: NodeAv.AV_CODEC_ID_AC3,
	eac3: NodeAv.AV_CODEC_ID_EAC3,
};

let cachedHardwareContext: NodeAv.HardwareContext | null | undefined = undefined;
export const getHardwareContext = (): NodeAv.HardwareContext | null => {
	if (cachedHardwareContext === undefined) {
		cachedHardwareContext = NodeAv.HardwareContext.auto();
	}
	return cachedHardwareContext;
};

const hardwareDecoderCodecCache = new Map<NodeAv.AVCodecID, NodeAv.Codec | null>();
export const getHardwareDecoderCodec = (codecId: NodeAv.AVCodecID): NodeAv.Codec | null => {
	if (!hardwareDecoderCodecCache.has(codecId)) {
		const hw = getHardwareContext();
		hardwareDecoderCodecCache.set(codecId, hw?.getDecoderCodec(codecId) ?? null);
	}
	return hardwareDecoderCodecCache.get(codecId)!;
};

const hardwareEncoderCodecCache = new Map<NodeAv.AVCodecID, NodeAv.Codec | null>();
export const getHardwareEncoderCodec = (codecId: NodeAv.AVCodecID): NodeAv.Codec | null => {
	if (!hardwareEncoderCodecCache.has(codecId)) {
		const hw = getHardwareContext();
		hardwareEncoderCodecCache.set(codecId, hw?.getEncoderCodec(codecId) ?? null);
	}
	return hardwareEncoderCodecCache.get(codecId)!;
};

export const mapColorPrimaries = (primaries: string) => {
	switch (primaries) {
		case 'bt709': return NodeAv.AVCOL_PRI_BT709;
		case 'bt470bg': return NodeAv.AVCOL_PRI_BT470BG;
		case 'smpte170m': return NodeAv.AVCOL_PRI_SMPTE170M;
		case 'bt2020': return NodeAv.AVCOL_PRI_BT2020;
		case 'smpte432': return NodeAv.AVCOL_PRI_SMPTE432;
	}

	return null;
};

export const unmapColorPrimaries = (primaries: number) => {
	switch (primaries) {
		case NodeAv.AVCOL_PRI_BT709: return 'bt709';
		case NodeAv.AVCOL_PRI_BT470BG: return 'bt470bg';
		case NodeAv.AVCOL_PRI_SMPTE170M: return 'smpte170m';
		case NodeAv.AVCOL_PRI_BT2020: return 'bt2020';
		case NodeAv.AVCOL_PRI_SMPTE432: return 'smpte432';
	}

	return null;
};

export const mapTransferCharacteristics = (transfer: string) => {
	switch (transfer) {
		case 'bt709': return NodeAv.AVCOL_TRC_BT709;
		case 'smpte170m': return NodeAv.AVCOL_TRC_SMPTE170M;
		case 'iec61966-2-1': return NodeAv.AVCOL_TRC_IEC61966_2_1;
		case 'linear': return NodeAv.AVCOL_TRC_LINEAR;
		case 'pq': return NodeAv.AVCOL_TRC_SMPTE2084;
		case 'hlg': return NodeAv.AVCOL_TRC_ARIB_STD_B67;
	}

	return null;
};

export const unmapTransferCharacteristics = (transfer: number) => {
	switch (transfer) {
		case NodeAv.AVCOL_TRC_BT709: return 'bt709';
		case NodeAv.AVCOL_TRC_SMPTE170M: return 'smpte170m';
		case NodeAv.AVCOL_TRC_IEC61966_2_1: return 'iec61966-2-1';
		case NodeAv.AVCOL_TRC_LINEAR: return 'linear';
		case NodeAv.AVCOL_TRC_SMPTE2084: return 'pq';
		case NodeAv.AVCOL_TRC_ARIB_STD_B67: return 'hlg';
	}

	return null;
};

export const mapMatrixCoefficients = (matrix: string) => {
	switch (matrix) {
		case 'rgb': return NodeAv.AVCOL_SPC_RGB;
		case 'bt709': return NodeAv.AVCOL_SPC_BT709;
		case 'bt470bg': return NodeAv.AVCOL_SPC_BT470BG;
		case 'smpte170m': return NodeAv.AVCOL_SPC_SMPTE170M;
		case 'bt2020-ncl': return NodeAv.AVCOL_SPC_BT2020_NCL;
	}

	return null;
};

export const unmapMatrixCoefficients = (matrix: number) => {
	switch (matrix) {
		case NodeAv.AVCOL_SPC_RGB: return 'rgb';
		case NodeAv.AVCOL_SPC_BT709: return 'bt709';
		case NodeAv.AVCOL_SPC_BT470BG: return 'bt470bg';
		case NodeAv.AVCOL_SPC_SMPTE170M: return 'smpte170m';
		case NodeAv.AVCOL_SPC_BT2020_NCL: return 'bt2020-ncl';
	}

	return null;
};

export const toPixelFormat = (ffmpegPixelFormat: NodeAv.AVPixelFormat): VideoSamplePixelFormat | null => {
	switch (ffmpegPixelFormat) {
		case NodeAv.AV_PIX_FMT_YUV420P: return 'I420';
		// "deprecated in favor of AV_PIX_FMT_YUV420P and setting color_range"
		case NodeAv.AV_PIX_FMT_YUVJ420P: return 'I420';
		case NodeAv.AV_PIX_FMT_YUV420P10LE: return 'I420P10';
		case NodeAv.AV_PIX_FMT_YUV420P12LE: return 'I420P12';
		case NodeAv.AV_PIX_FMT_YUVA420P: return 'I420A';
		case NodeAv.AV_PIX_FMT_YUVA420P10LE: return 'I420AP10';

		case NodeAv.AV_PIX_FMT_YUV422P: return 'I422';
		// "deprecated in favor of AV_PIX_FMT_YUV422P and setting color_range"
		case NodeAv.AV_PIX_FMT_YUVJ422P: return 'I422';
		case NodeAv.AV_PIX_FMT_YUV422P10LE: return 'I422P10';
		case NodeAv.AV_PIX_FMT_YUV422P12LE: return 'I422P12';
		case NodeAv.AV_PIX_FMT_YUVA422P: return 'I422A';
		case NodeAv.AV_PIX_FMT_YUVA422P10LE: return 'I422AP10';
		case NodeAv.AV_PIX_FMT_YUVA422P12LE: return 'I422AP12';

		case NodeAv.AV_PIX_FMT_YUV444P: return 'I444';
		// "deprecated in favor of AV_PIX_FMT_YUV444P and setting color_range"
		case NodeAv.AV_PIX_FMT_YUVJ444P: return 'I444';
		case NodeAv.AV_PIX_FMT_YUV444P10LE: return 'I444P10';
		case NodeAv.AV_PIX_FMT_YUV444P12LE: return 'I444P12';
		case NodeAv.AV_PIX_FMT_YUVA444P: return 'I444A';
		case NodeAv.AV_PIX_FMT_YUVA444P10LE: return 'I444AP10';
		case NodeAv.AV_PIX_FMT_YUVA444P12LE: return 'I444AP12';

		case NodeAv.AV_PIX_FMT_NV12: return 'NV12';

		case NodeAv.AV_PIX_FMT_RGBA: return 'RGBA';
		case NodeAv.AV_PIX_FMT_RGB0: return 'RGBX';
		case NodeAv.AV_PIX_FMT_BGRA: return 'BGRA';
		case NodeAv.AV_PIX_FMT_BGR0: return 'BGRX';

		default: return null;
	}
};

export const fromPixelFormat = (pixelFormat: VideoSamplePixelFormat) => {
	switch (pixelFormat) {
		case 'I420': return NodeAv.AV_PIX_FMT_YUV420P;
		case 'I420P10': return NodeAv.AV_PIX_FMT_YUV420P10LE;
		case 'I420P12': return NodeAv.AV_PIX_FMT_YUV420P12LE;
		case 'I420A': return NodeAv.AV_PIX_FMT_YUVA420P;
		case 'I420AP10': return NodeAv.AV_PIX_FMT_YUVA420P10LE;

		case 'I422': return NodeAv.AV_PIX_FMT_YUV422P;
		case 'I422P10': return NodeAv.AV_PIX_FMT_YUV422P10LE;
		case 'I422P12': return NodeAv.AV_PIX_FMT_YUV422P12LE;
		case 'I422A': return NodeAv.AV_PIX_FMT_YUVA422P;
		case 'I422AP10': return NodeAv.AV_PIX_FMT_YUVA422P10LE;
		case 'I422AP12': return NodeAv.AV_PIX_FMT_YUVA422P12LE;

		case 'I444': return NodeAv.AV_PIX_FMT_YUV444P;
		case 'I444P10': return NodeAv.AV_PIX_FMT_YUV444P10LE;
		case 'I444P12': return NodeAv.AV_PIX_FMT_YUV444P12LE;
		case 'I444A': return NodeAv.AV_PIX_FMT_YUVA444P;
		case 'I444AP10': return NodeAv.AV_PIX_FMT_YUVA444P10LE;
		case 'I444AP12': return NodeAv.AV_PIX_FMT_YUVA444P12LE;

		case 'NV12': return NodeAv.AV_PIX_FMT_NV12;

		case 'RGBA': return NodeAv.AV_PIX_FMT_RGBA;
		case 'RGBX': return NodeAv.AV_PIX_FMT_RGB0;
		case 'BGRA': return NodeAv.AV_PIX_FMT_BGRA;
		case 'BGRX': return NodeAv.AV_PIX_FMT_BGR0;

		default: return NodeAv.AV_PIX_FMT_NONE;
	}
};

export const toAudioSampleFormat = (ffmpegSampleFormat: NodeAv.AVSampleFormat): AudioSampleFormat | null => {
	switch (ffmpegSampleFormat) {
		case NodeAv.AV_SAMPLE_FMT_U8: return 'u8';
		case NodeAv.AV_SAMPLE_FMT_S16: return 's16';
		case NodeAv.AV_SAMPLE_FMT_S32: return 's32';
		case NodeAv.AV_SAMPLE_FMT_FLT: return 'f32';
		case NodeAv.AV_SAMPLE_FMT_U8P: return 'u8-planar';
		case NodeAv.AV_SAMPLE_FMT_S16P: return 's16-planar';
		case NodeAv.AV_SAMPLE_FMT_S32P: return 's32-planar';
		case NodeAv.AV_SAMPLE_FMT_FLTP: return 'f32-planar';

		default: return null;
	}
};

export const fromAudioSampleFormat = (sampleFormat: AudioSampleFormat): NodeAv.AVSampleFormat => {
	switch (sampleFormat) {
		case 'u8': return NodeAv.AV_SAMPLE_FMT_U8;
		case 's16': return NodeAv.AV_SAMPLE_FMT_S16;
		case 's32': return NodeAv.AV_SAMPLE_FMT_S32;
		case 'f32': return NodeAv.AV_SAMPLE_FMT_FLT;
		case 'u8-planar': return NodeAv.AV_SAMPLE_FMT_U8P;
		case 's16-planar': return NodeAv.AV_SAMPLE_FMT_S16P;
		case 's32-planar': return NodeAv.AV_SAMPLE_FMT_S32P;
		case 'f32-planar': return NodeAv.AV_SAMPLE_FMT_FLTP;

		default: return NodeAv.AV_SAMPLE_FMT_NONE;
	}
};

export const getChannelLayout = (numChannels: number): NodeAv.ChannelLayout => {
	switch (numChannels) {
		case 1: return NodeAv.AV_CHANNEL_LAYOUT_MONO;
		case 2: return NodeAv.AV_CHANNEL_LAYOUT_STEREO;
		case 4: return NodeAv.AV_CHANNEL_LAYOUT_QUAD;
		case 6: return NodeAv.AV_CHANNEL_LAYOUT_5POINT1_BACK;
		case 8: return NodeAv.AV_CHANNEL_LAYOUT_7POINT1;
		default: return { nbChannels: numChannels, order: NodeAv.AV_CHANNEL_ORDER_UNSPEC, mask: 0n };
	}
};

// The value is incorrect in the node-av source code, so we do:
export const LIBVPX_VP9 = 'libvpx-vp9' as (NodeAv.FFEncoderCodec & NodeAv.FFDecoderCodec);
