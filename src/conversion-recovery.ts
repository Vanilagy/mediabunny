/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	Conversion,
	ConversionCanceledError,
	type ConversionOptions,
	type ConversionVideoOptions,
	type ConversionAudioOptions,
} from './conversion';
import { Input } from './input';
import { InputAudioTrack, InputVideoTrack } from './input-track';
import { Quality } from './encode';
import { ALL_FORMATS } from './input-format';
import { EncodedPacketSink, AudioSampleSink } from './media-sink';
import { EncodedVideoPacketSource, EncodedAudioPacketSource, AudioSampleSource } from './media-source';
import { Output, OutputTrackGroup } from './output';
import { OutputFormat, Mp4OutputFormat, WebMOutputFormat } from './output-format';
import { EncodedPacket } from './packet';
import { BufferSource } from './source';
import { BufferTarget, Target } from './target';
import { AudioSample, getBytesPerSample } from './sample';
import type { MetadataTags } from './metadata';

/** A JSON-serializable checkpoint. Publish atomically with the referenced complete media object.
 * @public
 * @group Conversion
 */
export type ConversionCheckpoint = {
	/** Checkpoint schema version. */
	version: 2;
	/** SHA-256 of byte-array sources, or the caller-verified immutable Input identity. */
	sourceHash: string;
	/** Serialized, versioned immutable conversion plan; must match when reopening. */
	configuration: string;
	/** Ordered durable object descriptors. Only this committed prefix is referenced. */
	segments: {
		/** SHA-256 of the complete stored object, including its envelope. */
		hash: string;
		/** Exact stored object size in bytes. */
		byteLength: number;
	}[];
};

/** Storage for durable conversion objects; the application owns durability and exclusive job locking.
 * @public
 * @group Conversion
 */
export type ConversionRecoveryStore = {
	/** Read a committed object by zero-based index; return independent immutable bytes. */
	readSegment: (index: number) => Promise<Uint8Array>;
	/**
	 * Durably persist complete bytes BEFORE atomically publishing the checkpoint, then resolve. An uncertain failure
	 * requires reopening the last published checkpoint. Unreferenced objects may be overwritten. One writer per job.
	 * Objects contain a native-rate PCM audio chunk or video segment; do not assume every object has video.
	 */
	commit: (index: number, bytes: Uint8Array, checkpoint: ConversionCheckpoint) => Promise<void>;
};

/** Durable conversion configuration. Uses incumbent Conversion options rather than a parallel transform API.
 * @public
 * @group Conversion
 */
export type RecoverableConversionOptions = {
	/** Immutable bytes (copied and hashed), or caller-owned Input backed by a file/network source. */
	source: Uint8Array | Input;
	/**
	 * Required for Input: caller-verified immutable content/version identity. The library cannot detect changed bytes
	 * behind a reused identity. Input remains caller-owned. Byte-array sources are SHA-256 checked instead.
	 */
	sourceIdentity?: string;
	/**
	 * Conversion options. Declarative option objects/arrays supported; track callbacks are rejected.
	 * Stateful process callbacks,
	 * group overrides, and composable outputs are rejected: their identity/state cannot survive a fresh instance.
	 * Explicit copy policies use the incumbent global plan, including mixed copied/transcoded variants.
	 * Omitted copy retains checkpointed transcoding.
	 */
	conversion?: Pick<
		ConversionOptions,
		'video' | 'audio' | 'trim' | 'tags' | 'tracks' | 'copy' | 'showWarnings'
	>;
	/**
	 * Final container; accepts declarative incumbent OutputFormat instances.
	 * Defaults to fragmented MP4 for planning and assembly.
	 */
	format?: 'mp4' | 'webm' | OutputFormat;
	/** Target video segment duration in seconds, defaults to 5. CFR boundaries align to the global frame grid. */
	segmentDuration?: number;
	/** Durable object storage. */
	store: ConversionRecoveryStore;
	/** Last published JSON checkpoint. */
	checkpoint?: ConversionCheckpoint;
};

type WorkUnit = {
	copyResume?: { previous: EncodedPacket; maxTimestamp: number };
	copy?: { outputId: number; offset: number; count: number; config: VideoDecoderConfig | AudioDecoderConfig };
	kind: 'video' | 'audio';
	start: number;
	end: number;
	trackIndex?: number;
	variant?: number;
	audioOptions?: ConversionAudioOptions;
	audioVariants?: { variant: number; options: ConversionAudioOptions }[];
	videoOptions?: ConversionVideoOptions;
	videoDecodeStart?: number;
	videoTimestampOffset?: number;
};
// Versioned JSON metadata followed by unexpanded color/alpha payload bytes.
const encodeCopyBatch = (unit: WorkUnit, packets: EncodedPacket[]) => {
	const header = new TextEncoder().encode(
		serialize({
			version: 1,
			copy: unit.copy,
			packets: packets.map(packet => ({
				type: packet.type,
				timestamp: packet.timestamp,
				duration: packet.duration,
				sequenceNumber: packet.sequenceNumber,
				byteLength: packet.data.byteLength,
				alphaByteLength: packet.sideData.alpha?.byteLength ?? 0,
			})),
		}),
	);
	const bytes = new Uint8Array(
		4
		+ header.byteLength
		+ packets.reduce(
			(size, packet) => size + packet.data.byteLength + (packet.sideData.alpha?.byteLength ?? 0),
			0,
		),
	);
	new DataView(bytes.buffer).setUint32(0, header.byteLength, true);
	bytes.set(header, 4);
	let offset = 4 + header.byteLength;
	for (const packet of packets) {
		bytes.set(packet.data, offset);
		offset += packet.data.byteLength;
		if (packet.sideData.alpha) {
			bytes.set(packet.sideData.alpha, offset);
			offset += packet.sideData.alpha.byteLength;
		}
	}
	return bytes;
};
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const digest = async (bytes: Uint8Array) => {
	const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
};
// Snapshot only declarative options, never caller-owned Input or storage capabilities.
const snapshotOptions = <T>(value: T): T => {
	if (!value || typeof value !== 'object') {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return value.slice(0) as T;
	}
	if (ArrayBuffer.isView(value)) {
		return structuredClone(value);
	}
	if (Array.isArray(value)) {
		return value.map(snapshotOptions) as T;
	}
	const prototype = Object.getPrototypeOf(value) as object | null;
	if (prototype !== Object.prototype && prototype !== null && !(value instanceof Quality)) {
		throw new TypeError('Unsupported recovery option object prototype.');
	}
	return Object.assign(
		Object.create(prototype) as object,
		Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotOptions(item)])),
	) as T;
};
const openMedia = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
const copyCheckpoint = (checkpoint: ConversionCheckpoint): ConversionCheckpoint => ({
	...checkpoint,
	segments: checkpoint.segments.map(segment => ({ ...segment })),
});
const serialize = (value: unknown): string =>
	JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
			throw new TypeError('Recovery options must be serializable; callbacks are not supported.');
		}
		if (item instanceof ArrayBuffer) {
			return Array.from(new Uint8Array(item));
		}
		if (ArrayBuffer.isView(item)) {
			return Array.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
		}
		if (item === Infinity) {
			return { $recoveryNumber: 'Infinity' };
		}
		if (typeof item === 'number' && !Number.isFinite(item)) {
			throw new TypeError('Recovery options must contain finite numbers.');
		}
		return item;
	});

/**
 * Durable conversion using existing Conversion, muxers, packet sources and targets. Video is encoded in independent
 * segments. Audio is decoded into durable native-rate float PCM chunks; each chunk is bounded by segmentDuration
 * (plus codec/container overhead). Assembly feeds saved PCM to ONE AudioSampleSource, preserving continuous
 * resampling, channel transforms and AAC/Opus encoder state. A crash restarts only the uncommitted source chunk;
 * AAC/Opus decoders seek with one second of discarded preroll; PCM requires none. No codec state is serialized.
 *
 * Assembly remuxes video including alpha and re-encodes saved PCM. Interrupted assembly restarts the final audio
 * encoder/resampler, not expensive original-source decoding. No whole-track audio buffer is allocated. Input
 * codecs without supported bounded seek preroll are rejected for transcoding (packet copy remains supported).
 * PCM decoding trims before expansion, but the demuxer still reads the entire encoded container packet;
 * source caching and packet bytes are not bounded by segmentDuration. FLAC seeks to independent frames.
 * MP3/Vorbis/AC3/EAC3/DTS and Matroska PCM recovery transcodes are unsupported. Compressed codec
 * allocations remain browser-controlled. AAC/Opus continuity is regression-tested, not a guarantee for all
 * codec profiles. Dynamic source audio format changes are rejected across checkpoint chunks.
 *
 * Supports multiple video/audio tracks and declarative variants with stable source-order/variant identities,
 * incumbent output formats, Conversion resizing/codec/quality/audio parameters,
 * arbitrary trim, nonzero input timestamps, rational CFR or original VFR. Callbacks, fan-out, track-group overrides,
 * metadata transformation mode are explicitly unsupported. Video transforms are baked in.
 * Explicit packet-copy policies reuse the global Conversion plan, including infinite tolerances. Copy batches
 * retain at most 128 packets or approximately 1 MiB of payload (one oversized packet is allowed). Binary envelopes
 * store payload bytes without JSON expansion. Planning scans packet metadata; batches resume through the incumbent
 * packet index with saved cursor state, without replaying committed payload. Mixed copied/transcoded variants share
 * the global output order and shift. Independent video encoder configurations must agree. If an encoder change
 * makes them incompatible, start a new job with a fresh store namespace and no checkpoint; never overwrite objects
 * referenced by the old checkpoint. Keep the same encoder implementation/settings across resumes.
 * VFR boundaries use input packet presentation timestamps;
 * discovering them scans packet metadata, not decoded frames. AAC/Opus retain normal encoder priming/padding.
 * @public
 * @group Conversion
 */
export class RecoverableConversion {
	/** @internal */
	_copyConversion?: Conversion;
	/** @internal */
	_copyOutput?: Output;
	/** @internal */
	_outputOrder: { trackIndex: number; variant: number; copyId?: number }[] = [];
	/** @internal */
	_timestampOffset = 0;
	/** @internal */
	_busy = false;
	/** @internal */
	_failed = false;
	/** @internal */
	_cancelled = false;
	/** @internal */
	_cancelSignal = deferred();
	/** @internal */
	_operationDone?: Promise<void>;
	/** @internal */
	_finishOperation?: () => void;
	/** @internal */
	_activeConversion?: Conversion;
	/** @internal */
	_activeOutput?: Output;
	/** @internal */
	_cancelPromise?: Promise<void>;
	/** @internal */
	_disposed = false;
	/** @internal */
	private constructor(
		/** @internal */
		public _options: RecoverableConversionOptions,
		/** @internal */
		public _input: Input,
		/** @internal */
		public _state: ConversionCheckpoint,
		/** @internal */
		public _units: WorkUnit[],
	) {}

	/** Validate source identity, options, checkpoint structure and every committed media object. */
	static async init(options: RecoverableConversionOptions) {
		options = {
			...options,
			conversion: snapshotOptions(options.conversion),
			checkpoint: snapshotOptions(options.checkpoint),
		};
		const allowed = new Set([
			'source',
			'sourceIdentity',
			'conversion',
			'format',
			'segmentDuration',
			'store',
			'checkpoint',
		]);
		for (const key of Object.keys(options)) {
			if (!allowed.has(key)) {
				throw new TypeError(`Unsupported recovery option: ${key}`);
			}
		}
		if (
			!(options.source instanceof Uint8Array || options.source instanceof Input)
			|| typeof options.store?.readSegment !== 'function'
			|| typeof options.store?.commit !== 'function'
		) {
			throw new TypeError('A source and recovery store are required.');
		}
		if (
			options.source instanceof Input
			&& (typeof options.sourceIdentity !== 'string' || !options.sourceIdentity)
		) {
			throw new TypeError('Input sources require an immutable sourceIdentity.');
		}
		if (
			options.format !== undefined
			&& options.format !== 'mp4'
			&& options.format !== 'webm'
			&& !(options.format instanceof OutputFormat)
		) {
			throw new TypeError('Unsupported recovery output format.');
		}
		const conversion = options.conversion ?? {};
		for (const key of Object.keys(conversion)) {
			if (!['video', 'audio', 'trim', 'tags', 'tracks', 'copy', 'showWarnings'].includes(key)) {
				throw new TypeError(`Unsupported recovery conversion option: ${key}`);
			}
		}
		serialize(conversion); // Reject callbacks before allocating resources or reading media.
		if (typeof conversion.video === 'function' || typeof conversion.audio === 'function') {
			throw new TypeError('Recovery track callbacks are not supported.');
		}
		const requestedVideos = Conversion._declarativeVariants(conversion.video, 'video');
		const requestedVideo = requestedVideos[0];
		const requestedAudios = Conversion._declarativeVariants(conversion.audio, 'audio');
		const requestedAudio = requestedAudios[0];
		const videoKeys = new Set([
			'discard',
			'width',
			'height',
			'fit',
			'rotate',
			'flip',
			'allowTransformationMetadata',
			'allowRotationMetadata',
			'crop',
			'frameRate',
			'codec',
			'quality',
			'bitrate',
			'forceTranscode',
			'keyFrameInterval',
			'hardwareAcceleration',
			'alpha',
			'process',
			'processedWidth',
			'processedHeight',
			'group',
		]);
		const audioKeys = new Set([
			'discard',
			'numberOfChannels',
			'sampleRate',
			'sampleFormat',
			'codec',
			'quality',
			'bitrate',
			'forceTranscode',
			'process',
			'processedNumberOfChannels',
			'processedSampleRate',
			'group',
		]);
		for (const [object, keys] of [
			...requestedVideos.map(video => [video, videoKeys] as const),
			...requestedAudios.map(audio => [audio, audioKeys] as const),
		] as const) {
			for (const key of Object.keys(object ?? {})) {
				if (!keys.has(key)) {
					throw new TypeError(`Unsupported recovery track option: ${key}`);
				}
			}
		}
		if (
			requestedVideos.some(
				video =>
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					video.group || video.allowTransformationMetadata === true || video.allowRotationMetadata === true,
			)
			|| requestedAudios.some(audio => audio.group)
		) {
			throw new TypeError('Recovery requires baked video transforms and does not support group overrides.');
		}
		if (options.format instanceof OutputFormat) {
			// Own a detached format configuration while retaining its incumbent muxer prototype.
			serialize(options.format);
			options.format = Object.assign(
				Object.create(Object.getPrototypeOf(options.format) as object) as OutputFormat,
				snapshotOptions({ ...options.format }),
			);
		}
		const format
			= options.format instanceof OutputFormat
				? options.format
				: options.format === 'webm'
					? new WebMOutputFormat()
					: new Mp4OutputFormat({ fastStart: 'fragmented' });
		const videoOptions: ConversionVideoOptions = {
			codec: format.getSupportedVideoCodecs()[0],
			...requestedVideo,
			allowTransformationMetadata: false,
		};
		const audioOptions: ConversionAudioOptions = {
			codec: format.getSupportedAudioCodecs()[0],
			bitrate: 128_000,
			...requestedAudio,
		};
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		if (requestedAudio?.quality !== undefined && requestedAudio.bitrate === undefined) {
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			delete audioOptions.bitrate;
		}
		const segmentDuration = options.segmentDuration ?? 5;
		if (
			!Number.isFinite(segmentDuration)
			|| segmentDuration <= 0
			|| (videoOptions.frameRate !== undefined
				&& (!Number.isFinite(videoOptions.frameRate) || videoOptions.frameRate <= 0))
		) {
			throw new TypeError('segmentDuration and frameRate must be positive finite numbers.');
		}
		const source = options.source instanceof Input ? options.source : options.source.slice();
		const sourceHash = source instanceof Input ? `identity:${options.sourceIdentity}` : await digest(source);
		const input = source instanceof Input ? source : openMedia(source);
		try {
			const tracks = await input.getTracks();
			const video = await input.getPrimaryVideoTrack();
			const audio = await input.getPrimaryAudioTrack();
			const audios = conversion.tracks === 'primary' ? (audio ? [audio] : []) : await input.getAudioTracks();
			const videos = conversion.tracks === 'primary' ? (video ? [video] : []) : await input.getVideoTracks();
			if (conversion.tracks !== 'primary' && tracks.length !== videos.length + audios.length) {
				throw new Error('Recovery supports audio/video tracks only; select primary explicitly.');
			}
			const selected = [
				...(requestedVideos.every(x => x.discard) ? [] : videos),
				...(requestedAudios.every(x => x.discard) ? [] : audios),
			];
			if (!selected.length) {
				throw new Error('No selected tracks for recovery.');
			}
			const first = Math.max(0, Math.min(...(await Promise.all(selected.map(x => x.getFirstTimestamp())))));
			const duration = Math.max(...(await Promise.all(selected.map(x => x.computeDuration()))));
			const start = conversion.trim?.start ?? first;
			const end = conversion.trim?.end ?? duration;
			if (
				!Number.isFinite(start)
				|| !Number.isFinite(end)
				|| start < 0
				|| end <= start
				|| end > duration + 1e-7
			) {
				throw new Error('Invalid trim: source must be covering the requested finite region.');
			}
			const units: WorkUnit[] = [];
			let outputOrder: { trackIndex: number; variant: number; copyId?: number }[] = [];
			let timestampOffset = -start;
			let copyConversion: Conversion | undefined;
			let copyOutput: Output | undefined;
			if (conversion.copy !== undefined && conversion.copy !== false) {
				copyOutput = new Output({ format, target: new BufferTarget() });
				copyConversion = await Conversion.init({ ...conversion, input, output: copyOutput });
				if (
					!copyConversion.isValid
					|| copyConversion.discardedTracks.some(x => x.reason !== 'discarded_by_user')
				) {
					throw new Error('Recovery requires every requested output variant to be supported by Conversion.');
				}
				if (copyConversion._startTimestamp !== start) {
					throw new Error('Recovery does not support a copy plan with a different trim origin.');
				}
				for (const plan of copyConversion._copyPlans) {
					const track = plan.track;
					const config
						= track instanceof InputVideoTrack || track instanceof InputAudioTrack
							? await track.getDecoderConfig()
							: null;
					if (!config) {
						throw new Error('Copied track requires decoder configuration.');
					}
					let offset = 0;
					let count = 0;
					let size = 0;
					let previous: EncodedPacket | undefined;
					let maxTimestamp = -Infinity;
					let copyResume: WorkUnit['copyResume'];
					const flush = async () => {
						if (!count) {
							return;
						}
						units.push({
							kind: plan.track instanceof InputAudioTrack ? 'audio' : 'video',
							trackIndex: tracks.indexOf(plan.track),
							variant: plan.outputTrackId,
							start,
							end,
							copyResume,
							copy: { outputId: plan.outputTrackId, offset, count, config },
						});
						offset += count;
						count = 0;
						size = 0;
						copyResume = previous ? { previous, maxTimestamp } : undefined;
					};
					let original: EncodedPacket;
					for await (const packet of copyConversion._copyPackets(
						plan.outputTrackId,
						0,
						true,
						undefined,
						(packet) => {
							original = packet;
						},
					)) {
						if (
							count
							&& (count >= 128
								|| size + packet.byteLength + (packet.sideData.alphaByteLength ?? 0) > 1024 * 1024)
						) {
							await flush();
						}
						previous = original!;
						maxTimestamp = Math.max(maxTimestamp, packet.timestamp);
						count++;
						size += packet.byteLength + (packet.sideData.alphaByteLength ?? 0);
					}
					await flush();
				}
				// Output IDs and utilizedTracks are in the incumbent's exact source/variant order.
				const occurrences = new Map<number, number>();
				outputOrder = copyConversion._outputTrackIds.map((id, index) => {
					const trackIndex = tracks.indexOf(copyConversion!.utilizedTracks[index]!);
					const occurrence = occurrences.get(trackIndex) ?? 0;
					occurrences.set(trackIndex, occurrence + 1);
					const variants
						= copyConversion!.utilizedTracks[index] instanceof InputAudioTrack
							? requestedAudios
							: requestedVideos;
					const variant = variants
						.map((option, variant) => (!option.discard ? variant : -1))
						.filter(x => x >= 0)[occurrence]!;
					return {
						trackIndex,
						variant,
						copyId: copyConversion!._copyPlans.some(plan => plan.outputTrackId === id) ? id : undefined,
					};
				});
				timestampOffset = copyConversion._timestampOffset;
				// Only the immutable global plan is used; no planned output pump will execute.
				await copyConversion.cancel();
			}
			const transcodes = (trackIndex: number, variant: number) =>
				!copyConversion
				|| outputOrder.some(
					entry =>
						entry.trackIndex === trackIndex && entry.variant === variant && entry.copyId === undefined,
				);
			for (const [variant, requested] of requestedAudios.entries()) {
				const variantOptions: ConversionAudioOptions = {
					codec: format.getSupportedAudioCodecs()[0],
					bitrate: 128000,
					...requested,
				};
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				if (requested.quality !== undefined && requested.bitrate === undefined) {
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					delete variantOptions.bitrate;
				}
				for (const audio of variantOptions.discard ? [] : audios) {
					const trackIndex = tracks.indexOf(audio);
					if (!transcodes(trackIndex, variant)) {
						continue;
					}
					const codec = await audio.getCodec();
					if (
						codec !== 'aac'
						&& codec !== 'opus'
						&& codec !== 'flac'
						&& !(codec?.startsWith('pcm-') && !(await input.getFormat()).mimeType.includes('matroska'))
					) {
						throw new Error(
							'Recovery audio transcoding requires bounded seek preroll;'
							+ ` unsupported codec/container: ${codec}.`
							+ ' Use packet copy or convert the source first.',
						);
					}
					const rate = await audio.getSampleRate();
					const firstSample = await audio.getFirstTimestamp();
					const startFrame = Math.round((start - firstSample) * rate);
					const endFrame = Math.round((Math.min(end, await audio.computeDuration()) - firstSample) * rate);
					const chunkFrames = Math.max(1, Math.round(segmentDuration * rate));
					for (let frame = Math.max(0, startFrame); frame < endFrame; frame += chunkFrames) {
						const chunkStart = firstSample + frame / rate;
						const existing = units.find(
							unit =>
								!unit.copy
								&& unit.kind === 'audio'
								&& unit.trackIndex === trackIndex
								&& unit.start === chunkStart,
						);
						if (existing) {
							existing.audioVariants!.push({ variant, options: variantOptions });
						} else {
							units.push({
								kind: 'audio',
								trackIndex,
								audioVariants: [{ variant, options: variantOptions }],
								start: chunkStart,
								end: firstSample + Math.min(endFrame, frame + chunkFrames) / rate,
							});
						}
					}
				}
			}
			for (const [variant, requested] of requestedVideos.entries()) {
				const videoOptions: ConversionVideoOptions = {
					codec: format.getSupportedVideoCodecs()[0],
					...requested,
					allowTransformationMetadata: false,
				};
				for (const video of videoOptions.discard ? [] : videos) {
					const trackIndex = tracks.indexOf(video);
					if (!transcodes(trackIndex, variant)) {
						continue;
					}
					const videoStart = Math.max(start, await video.getFirstTimestamp());
					const videoEnd = Math.min(end, await video.computeDuration());
					if (videoEnd <= videoStart) {
						continue;
					}
					{
						const end = videoEnd;
						const rate = videoOptions.frameRate;
						const step = segmentDuration;
						if (rate) {
							// Preserve Conversion's global normalization grid across independently encoded segments.
							// If a source frame starts inside the first grid slot, start with that frame rather
							// than re-encoding the previous slot's frame clipped to the segment boundary.
							const timestamps: number[] = [];
							for await (const packet of new EncodedPacketSink(video).packets(undefined, undefined, {
								metadataOnly: true,
							})) {
								if (packet.timestamp >= start && packet.timestamp < end) {
									timestamps.push(packet.timestamp);
								}
							}
							timestamps.sort((a, b) => a - b);
							const firstGridIndex = Math.max(0, Math.floor((videoStart - start) * rate + 1e-7));
							const framesPerSegment = Math.max(1, Math.round(segmentDuration * rate));
							let sourceIndex = 0;
							for (
								let index = firstGridIndex;
								start + index / rate < end - 1e-9;
								index += framesPerSegment
							) {
								const slotStart = start + index / rate;
								while (sourceIndex < timestamps.length && timestamps[sourceIndex]! < slotStart - 1e-9) {
									sourceIndex++;
								}
								const nextTimestamp = timestamps[sourceIndex];
								const firstFrame = nextTimestamp !== undefined
									&& nextTimestamp < start + (index + 1) / rate - 1e-9
									? nextTimestamp
									: undefined;
								units.push({
									kind: 'video',
									videoDecodeStart: firstFrame ?? Math.max(start, slotStart),
									videoTimestampOffset: timestampOffset,
									trackIndex,
									variant,
									videoOptions,
									start: start + index / rate,
									end: Math.min(end, start + (index + framesPerSegment) / rate),
								});
							}
						} else {
							// Presentation-order boundaries avoid splitting VFR frames
							// and are independent of decode order.
							const timestamps: number[] = [];
							for await (const packet of new EncodedPacketSink(video).packets(undefined, undefined, {
								metadataOnly: true,
							})) {
								if (packet.timestamp > start && packet.timestamp < end) {
									timestamps.push(packet.timestamp);
								}
							}
							timestamps.sort((a, b) => a - b);
							let boundary = start;
							for (const timestamp of timestamps) {
								if (timestamp - boundary >= step) {
									units.push({
										kind: 'video',
										trackIndex,
										variant,
										videoOptions,
										start: boundary,
										end: timestamp,
									});
									boundary = timestamp;
								}
							}
							units.push({ kind: 'video', trackIndex, variant, videoOptions, start: boundary, end });
						}
					}
				}
			}
			if (
				copyConversion
				&& outputOrder.some(
					entry =>
						!units.some(unit =>
							entry.copyId !== undefined
								? unit.copy?.outputId === entry.copyId
								: !unit.copy
									&& unit.trackIndex === entry.trackIndex
									&& (unit.audioVariants?.some(x => x.variant === entry.variant)
										|| unit.variant === entry.variant),
						),
				)
			) {
				throw new Error('Recovery cannot represent an output without durable work units.');
			}
			const configuration = serialize({
				revision: 12,
				format: { name: format._name, options: options.format },
				conversion,
				videoOptions,
				audioOptions,
				outputOrder,
				timestampOffset,
				units: units.map(({ copyResume, ...unit }) => ({
					...unit,
					copyResume: copyResume
						? {
								sequenceNumber: copyResume.previous.sequenceNumber,
								timestamp: copyResume.previous.timestamp,
								maxTimestamp: copyResume.maxTimestamp,
							}
						: undefined,
				})),
			});
			const checkpoint = options.checkpoint;
			if (
				checkpoint !== undefined
				&& (!checkpoint
					|| checkpoint.version !== 2
					|| checkpoint.sourceHash !== sourceHash
					|| checkpoint.configuration !== configuration
					|| !Array.isArray(checkpoint.segments)
					|| checkpoint.segments.length > units.length
					|| checkpoint.segments.some(
						segment =>
							!segment
							|| !/^[a-f0-9]{64}$/.test(segment.hash)
							|| !Number.isSafeInteger(segment.byteLength)
							|| segment.byteLength <= 0,
					))
			) {
				throw new Error('Invalid recovery checkpoint, source, or configuration.');
			}
			const recovery = new RecoverableConversion(
				{ ...options, source, conversion: { ...conversion } },
				input,
				checkpoint ? copyCheckpoint(checkpoint) : { version: 2, sourceHash, configuration, segments: [] },
				units,
			);
			recovery._copyConversion = copyConversion;
			recovery._copyOutput = copyOutput;
			recovery._outputOrder = outputOrder;
			recovery._timestampOffset = timestampOffset;
			for (let i = 0; i < recovery._state.segments.length; i++) {
				await recovery._validateUnit(await recovery._readSegment(i), units[i]!);
			}
			return recovery;
		} catch (error) {
			if (!(source instanceof Input)) {
				input.dispose();
			}
			throw error;
		}
	}

	/** Detached JSON-serializable last successfully committed checkpoint. */
	get checkpoint() {
		return copyCheckpoint(this._state);
	}

	/** @internal */
	_format() {
		if (this._options.format instanceof OutputFormat) {
			return this._options.format;
		}
		return this._options.format === 'webm'
			? new WebMOutputFormat()
			: new Mp4OutputFormat({ fastStart: 'fragmented' });
	}

	/**
	 * Cancel the current operation and wait for its codec, decoder, and output work to settle.
	 * Reopen from the last published checkpoint.
	 */
	cancel(): Promise<void> {
		if (this._cancelPromise) {
			return this._cancelPromise;
		}
		this._cancelled = true;
		this._cancelSignal.resolve();
		this._cancelPromise = (async () => {
			const conversion = this._activeConversion;
			const output = this._activeOutput;
			try {
				if (conversion) {
					await conversion.cancel();
				} else if (output) {
					await output.cancel();
				}
			} finally {
				await this._operationDone;
			}
		})();
		return this._cancelPromise;
	}

	/** @internal */
	_checkCancelled() {
		if (this._cancelled) {
			throw new ConversionCanceledError();
		}
	}

	/** @internal */
	async* _interruptibleSamples(sink: AudioSampleSink, start?: number, end?: number) {
		const iterator = sink.samples(start, end)[Symbol.asyncIterator]();
		try {
			while (true) {
				this._checkCancelled();
				const pending = iterator.next();
				const result = await Promise.race([pending, this._cancelSignal.promise.then(() => null)]);
				if (result === null) {
					// return() wakes the pump; settle the in-flight pull and close any late sample.
					const closing = iterator.return();
					try {
						const late = await pending;
						if (!late.done) {
							late.value.close();
						}
					} finally {
						await closing;
					}
					this._checkCancelled();
				}
				if (result!.done) {
					return;
				}
				yield result!.value;
			}
		} finally {
			await iterator.return();
		}
	}

	/** Commit one native-rate PCM audio chunk or independently encoded video segment. */
	async step(): Promise<boolean> {
		this._enter();
		try {
			return await this._runStep();
		} finally {
			this._busy = false;
			this._finishOperation?.();
		}
	}

	/** @internal */
	async _runStep(): Promise<boolean> {
		try {
			this._checkCancelled();
			const index = this._state.segments.length;
			const unit = this._units[index];
			if (!unit) {
				return false;
			}
			if (unit.copy) {
				const packets: EncodedPacket[] = [];
				for await (const packet of this._copyConversion!._copyPackets(
					unit.copy.outputId,
					0,
					false,
					unit.copyResume,
				)) {
					this._checkCancelled();
					packets.push(packet);
					if (packets.length === unit.copy.count) {
						break;
					}
				}
				const bytes = encodeCopyBatch(unit, packets);
				await this._validateUnit(bytes, unit);
				const next = copyCheckpoint(this._state);
				next.segments.push({ hash: await digest(bytes), byteLength: bytes.byteLength });
				this._checkCancelled();
				await this._options.store.commit(index, bytes, copyCheckpoint(next));
				this._state = next;
				this._checkCancelled();
				return true;
			}
			this._checkCancelled();
			const output = new Output({
				format:
					unit.kind === 'audio'
						? new Mp4OutputFormat({ fastStart: 'fragmented' })
						: ['vp8', 'vp9', 'av1'].includes(unit.videoOptions!.codec!)
								? new WebMOutputFormat()
								: new Mp4OutputFormat({ fastStart: 'fragmented' }),
				target: new BufferTarget(),
			});
			this._activeOutput = output;
			try {
				if (unit.kind === 'audio') {
					const track = (await this._input.getTracks())[unit.trackIndex!] as InputAudioTrack;
					const codec = await track.getCodec();
					if (!codec || !(await track.canDecode())) {
						throw new Error(`Recovery source audio decoder unavailable: ${codec}`);
					}
					const source = new AudioSampleSource({ codec: 'pcm-f32' });
					output.addAudioTrack(source);
					await output.start();
					try {
						// Warm overlap-add/history state before the requested boundary.
						// Preroll is discarded, never committed.
						// Initialization rejects codecs/containers without a bounded, supported seek path.
						const preroll = codec === 'aac' || codec === 'opus' ? 1 : 0;
						const from = Math.max(await track.getFirstTimestamp(), unit.start - preroll);
						const sink = new AudioSampleSink(track);
						sink._trimPcmBeforeDecode = true;
						sink._pcmDecodeStart = unit.start;
						for await (using sample of this._interruptibleSamples(sink, from, unit.end)) {
							const first = Math.max(0, Math.round((unit.start - sample.timestamp) * sample.sampleRate));
							const last = Math.min(
								sample.numberOfFrames,
								Math.round((unit.end - sample.timestamp) * sample.sampleRate),
							);
							if (first >= last) {
								continue;
							}
							using trimmed = sample.trim(first, last);
							trimmed.setTimestamp(trimmed.timestamp - unit.start);
							await source.add(trimmed);
						}
						this._checkCancelled();
						await output.finalize();
					} catch (error) {
						await output.cancel();
						throw error;
					}
				} else {
					const sourceTrack = (await this._input.getTracks())[unit.trackIndex!]!;
					const conversion = await Conversion.init({
						input: this._input,
						output,
						trim: { start: unit.videoDecodeStart ?? unit.start, end: unit.end },
						copy: false,
						tags: {},
						showWarnings: false,
						tracks: this._options.conversion?.tracks,
						video: track => (track === sourceTrack ? unit.videoOptions! : { discard: true }),
						audio: { discard: true },
					});
					if (unit.videoTimestampOffset !== undefined) {
						conversion._timestampOffset = unit.videoTimestampOffset;
					}
					this._activeConversion = conversion;
					try {
						this._checkCancelled();
						if (!conversion.isValid) {
							throw new Error(
								`Recovery cannot encode ${unit.kind}; check codec support and conversion options.`,
							);
						}
						await conversion.execute();
					} finally {
						await conversion.cancel();
					}
				}
				this._checkCancelled();
			} catch (error) {
				await output.cancel();
				throw error;
			}
			const bytes = new Uint8Array(output.target.buffer!);
			await this._validateUnit(bytes, unit);
			const previous = this._units.findIndex(
				x =>
					!x.copy && x.kind === unit.kind && x.trackIndex === unit.trackIndex && x.variant === unit.variant,
			);
			if (previous < index) {
				using first = openMedia(await this._readSegment(previous));
				using current = openMedia(bytes);
				if (
					(await this._trackConfiguration(first, unit.kind))
					!== (await this._trackConfiguration(current, unit.kind))
				) {
					throw new Error(
						'Decoder configuration changed between recovery segments.'
						+ ' Start a new job with a fresh store namespace and no checkpoint;'
						+ ' do not overwrite objects referenced by the old checkpoint.',
					);
				}
			}
			const next = copyCheckpoint(this._state);
			next.segments.push({ hash: await digest(bytes), byteLength: bytes.byteLength });
			this._checkCancelled();
			await this._options.store.commit(index, bytes, copyCheckpoint(next));
			this._state = next;
			this._checkCancelled();
			return true;
		} catch (error) {
			this._failed = true; // Rejected commits may already be durable. Reopen instead of retrying stale state.
			this._checkCancelled();
			throw error;
		} finally {
			this._activeConversion = undefined;
			this._activeOutput = undefined;
		}
	}

	/** Finish uncommitted work then remux to a fresh target. */
	async execute(target: Target) {
		this._enter();
		try {
			while (await this._runStep()) {
				// Every successful step is independently durable.
			}
			await this._runAssembly(target);
		} finally {
			this._busy = false;
			this._finishOperation?.();
		}
	}

	/**
	 * Remux committed video and continuously encode saved PCM without original-source decoding.
	 * Restartable into a fresh target. Preserves encoded alpha side data; final audio encoding restarts on retry.
	 */
	async assemble(target: Target) {
		this._enter();
		try {
			await this._runAssembly(target);
		} finally {
			this._busy = false;
			this._finishOperation?.();
		}
	}

	/** @internal */
	async _runAssembly(target: Target) {
		let output: Output | undefined;
		try {
			if (this._state.segments.length !== this._units.length) {
				throw new Error('Conversion is incomplete.');
			}
			output = new Output({ format: this._format(), target });
			this._activeOutput = output;
			this._checkCancelled();
			output.setMetadataTags(
				await Conversion._getOutputTags(
					this._input,
					output,
					this._options.conversion?.tags as MetadataTags | undefined,
				),
			);
			const sources = new Map<
				WorkUnit,
				EncodedVideoPacketSource | EncodedAudioPacketSource | AudioSampleSource
			>();
			const outputUnits = this._units
				.filter(unit => !unit.copy)
				.filter(
					(unit, index, all) =>
						all.findIndex(
							x =>
								x.kind === unit.kind
								&& x.trackIndex === unit.trackIndex
								&& (unit.kind === 'audio' || x.variant === unit.variant),
						) === index,
				)
				.flatMap(unit =>
					unit.kind === 'audio'
						? unit.audioVariants!.map(({ variant, options }) => ({
								...unit, variant, audioOptions: options,
							}))
						: [unit],
				);
			const copyUnits = this._units
				.filter(unit => unit.copy)
				.filter(
					(unit, index, all) => all.findIndex(x => x.copy!.outputId === unit.copy!.outputId) === index,
				);
			outputUnits.push(
				...copyUnits.map(unit => ({
					...unit,
					variant: this._outputOrder.find(entry => entry.copyId === unit.copy!.outputId)!.variant,
				})),
			);
			if (this._copyConversion) {
				outputUnits.sort(
					(a, b) =>
						this._outputOrder.findIndex(
							entry => entry.trackIndex === a.trackIndex && entry.variant === a.variant,
						)
						- this._outputOrder.findIndex(
							entry => entry.trackIndex === b.trackIndex && entry.variant === b.variant,
						),
				);
			} else {
				// The incumbent visits each input track, then its variants (not vice versa).
				outputUnits.sort((a, b) => a.trackIndex! - b.trackIndex! || a.variant! - b.variant!);
			}
			const groups = outputUnits.map(() => new OutputTrackGroup());
			const inputTracks = await this._input.getTracks();
			const sourceTracks = outputUnits.map(unit => inputTracks[unit.trackIndex!]!);
			for (let a = 0; a < sourceTracks.length; a++) {
				for (let b = a + 1; b < sourceTracks.length; b++) {
					if (sourceTracks[a]!.canBePairedWith(sourceTracks[b]!)) {
						groups[a]!.pairWith(groups[b]!);
					}
				}
			}
			for (const outputUnit of outputUnits) {
				const group = groups[outputUnits.indexOf(outputUnit)]!;
				const kind = outputUnit.kind;
				if (outputUnit.copy) {
					const planned
						= this._copyOutput!.tracks[
							this._copyConversion!._outputTrackIds.indexOf(outputUnit.copy.outputId)
						]!;
					if (kind === 'video') {
						const source = new EncodedVideoPacketSource(
							(planned.source as EncodedVideoPacketSource)._codec,
						);
						output.addVideoTrack(source, { ...planned.metadata, group });
						sources.set(outputUnit, source);
					} else {
						const source = new EncodedAudioPacketSource(
							(planned.source as EncodedAudioPacketSource)._codec,
						);
						output.addAudioTrack(source, { ...planned.metadata, group });
						sources.set(outputUnit, source);
					}
					continue;
				}
				const index = this._units.findIndex(
					unit =>
						!unit.copy
						&& unit.kind === outputUnit.kind
						&& unit.trackIndex === outputUnit.trackIndex
						&& (unit.kind === 'audio' || unit.variant === outputUnit.variant),
				);
				using input = openMedia(await this._readSegment(index));
				if (kind === 'video') {
					const track = (await input.getPrimaryVideoTrack())!;
					const source = new EncodedVideoPacketSource((await track.getCodec())!);
					output.addVideoTrack(source, {
						...(await Conversion._getTrackMetadata(inputTracks[outputUnit.trackIndex!]!)),
						frameRate: outputUnit.videoOptions!.frameRate,
						group,
					});
					sources.set(outputUnit, source);
				} else {
					const audioOptions = outputUnit.audioOptions!;
					const source = new AudioSampleSource({
						codec: audioOptions.codec!,
						quality: audioOptions.quality,
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						bitrate: audioOptions.bitrate,
						transform: {
							sampleRate: audioOptions.sampleRate,
							numberOfChannels: audioOptions.numberOfChannels,
							sampleFormat: audioOptions.sampleFormat,
						},
					});
					output.addAudioTrack(source, {
						...(await Conversion._getTrackMetadata(inputTracks[outputUnit.trackIndex!]!)),
						group,
					});
					sources.set(outputUnit, source);
				}
			}
			this._checkCancelled();
			await output.start();
			this._checkCancelled();
			const tasks = [...sources].map(async ([outputUnit, source]) => {
				const kind = outputUnit.kind;
				let configuration: string | undefined;
				let checkedAudioPadding = false;
				for (let i = 0; i < this._units.length; i++) {
					this._checkCancelled();
					const unit = this._units[i]!;
					if (outputUnit.copy) {
						if (unit.copy?.outputId !== outputUnit.copy.outputId) {
							continue;
						}
						for (const packet of this._copyPackets(await this._readSegment(i), unit)) {
							this._checkCancelled();
							if (source instanceof EncodedVideoPacketSource) {
								await source.add(packet, { decoderConfig: unit.copy.config as VideoDecoderConfig });
							} else if (source instanceof EncodedAudioPacketSource) {
								await source.add(packet, { decoderConfig: unit.copy.config as AudioDecoderConfig });
							}
						}
						continue;
					}
					if (
						unit.copy
						|| unit.kind !== kind
						|| unit.trackIndex !== outputUnit.trackIndex
						|| (kind === 'video' && unit.variant !== outputUnit.variant)
					) {
						continue;
					}
					using input = openMedia(await this._readSegment(i));
					if (source instanceof AudioSampleSource) {
						const track = (await input.getPrimaryAudioTrack())!;
						for await (using sample of this._interruptibleSamples(new AudioSampleSink(track))) {
							sample.setTimestamp(sample.timestamp + unit.start + this._timestampOffset);
							if (
								!checkedAudioPadding
								&& sample.timestamp > 0
								&& !output!.format.supportsTimestampedMediaData
							) {
								// Match Conversion's one-time leading padding for containers such as WAV.
								const count = Math.round(sample.timestamp * sample.sampleRate);
								const data = new Uint8Array(
									count * sample.numberOfChannels * getBytesPerSample(sample.format),
								);
								if (sample.format === 'u8' || sample.format === 'u8-planar') {
									data.fill(128);
								}
								using silence = new AudioSample({
									data,
									format: sample.format,
									numberOfChannels: sample.numberOfChannels,
									sampleRate: sample.sampleRate,
									timestamp: 0,
								});
								await source.add(silence);
							}
							checkedAudioPadding = true;
							await source.add(sample);
						}
						continue;
					}
					const track = (await input.getPrimaryVideoTrack())!;
					const decoderConfig = (await track.getDecoderConfig())!;
					const signature = await this._trackConfiguration(input, kind);
					if (configuration !== undefined && configuration !== signature) {
						throw new Error(
							'Decoder configuration changed between recovery segments.'
							+ ' Start a new job with a fresh store namespace and no checkpoint;'
							+ ' do not overwrite objects referenced by the old checkpoint.',
						);
					}
					configuration = signature;
					for await (const packet of new EncodedPacketSink(track).packets()) {
						this._checkCancelled();
						const remaining = unit.end + (unit.videoTimestampOffset ?? -unit.start) - packet.timestamp;
						const duration
							= kind === 'video'
								? Math.min(
										packet.duration || remaining,
										Math.max(0, remaining),
									)
								: packet.duration;
						if (kind === 'video' && duration <= 0) {
							continue;
						}
						const shifted = new EncodedPacket(
							packet.data,
							packet.type,
							unit.videoTimestampOffset !== undefined
								? packet.timestamp
								: packet.timestamp + unit.start + this._timestampOffset,
							duration,
							-1,
							undefined,
							packet.sideData,
						);
						if (source instanceof EncodedVideoPacketSource) {
							await source.add(shifted, { decoderConfig });
						}
					}
				}
				this._checkCancelled();
				source.close();
			});
			try {
				await Promise.all(tasks);
			} catch (error) {
				try {
					await output.cancel();
				} finally {
					await Promise.allSettled(tasks);
				}
				throw error;
			}
			this._checkCancelled();
			await output.finalize();
			this._checkCancelled();
		} catch (error) {
			if (output) {
				await output.cancel();
			}
			this._checkCancelled();
			throw error;
		} finally {
			this._activeOutput = undefined;
		}
	}

	/** Release owned input between operations. Caller-provided Input remains caller-owned. */
	dispose() {
		if (this._busy) {
			throw new Error('Cannot dispose during a recovery operation.');
		}
		this._disposed = true;
		if (!(this._options.source instanceof Input)) {
			void this._input.dispose();
		}
	}

	/** @internal */
	_enter() {
		if (this._busy || this._failed || this._disposed || this._cancelled) {
			throw new Error('Recovery is busy, disposed, canceled, or requires reopening after a failed step.');
		}
		this._busy = true;
		const operation = deferred();
		this._operationDone = operation.promise;
		this._finishOperation = operation.resolve;
	}

	/** @internal */
	async _trackConfiguration(input: Input, kind: WorkUnit['kind']) {
		const track
			= kind === 'video' ? (await input.getPrimaryVideoTrack())! : (await input.getPrimaryAudioTrack())!;
		return serialize(await track.getDecoderConfig());
	}

	/** @internal */
	_copyPackets(bytes: Uint8Array, unit: WorkUnit): EncodedPacket[] {
		if (bytes.byteLength < 4) {
			throw new Error('Truncated recovery copy envelope.');
		}
		const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
		if (headerLength > bytes.byteLength - 4) {
			throw new Error('Truncated recovery copy header.');
		}
		const data = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as {
			version: number;
			copy: WorkUnit['copy'];
			packets: { byteLength: number; alphaByteLength: number; type: 'key' | 'delta';
				timestamp: number; duration: number; sequenceNumber: number; }[];
		};
		if (
			data.version !== 1
			|| serialize(data.copy) !== serialize(unit.copy)
			|| !Array.isArray(data.packets)
			|| data.packets.length !== unit.copy!.count
		) {
			throw new Error('Invalid recovery copy batch plan or packet count.');
		}
		let offset = 4 + headerLength;
		const packets = data.packets.map(
			(packet: {
				byteLength: number;
				alphaByteLength: number;
				type: 'key' | 'delta';
				timestamp: number;
				duration: number;
				sequenceNumber: number;
			}) => {
				if (
					!Number.isSafeInteger(packet.byteLength)
					|| packet.byteLength < 0
					|| !Number.isSafeInteger(packet.alphaByteLength)
					|| packet.alphaByteLength < 0
					|| packet.byteLength + packet.alphaByteLength > bytes.byteLength - offset
				) {
					throw new Error('Invalid recovery copy payload lengths.');
				}
				const payload = bytes.subarray(offset, offset + packet.byteLength);
				offset += packet.byteLength;
				const alpha = packet.alphaByteLength
					? bytes.subarray(offset, offset + packet.alphaByteLength)
					: undefined;
				offset += packet.alphaByteLength;
				return new EncodedPacket(
					payload,
					packet.type,
					packet.timestamp,
					packet.duration,
					packet.sequenceNumber,
					undefined,
					alpha ? { alpha } : {},
				);
			},
		);
		if (offset !== bytes.byteLength) {
			throw new Error('Trailing recovery copy payload.');
		}
		return packets;
	}

	/** @internal */
	async _validateUnit(bytes: Uint8Array, unit: WorkUnit) {
		if (unit.copy) {
			this._copyPackets(bytes, unit);
			return;
		}
		using input = openMedia(bytes);
		const track
			= unit.kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
		const codec = unit.kind === 'video' ? unit.videoOptions!.codec : 'pcm-f32';
		if (!track || (await track.getCodec()) !== codec || (await input.getTracks()).length !== 1) {
			throw new Error('Recovery object has unexpected tracks or codec.');
		}
		const sink = new EncodedPacketSink(track);
		const first = await sink.getFirstPacket({ verifyKeyPackets: true });
		if (!first || first.type !== 'key') {
			throw new Error('Recovery object must start with an independently decodable packet.');
		}
		if (unit.kind === 'audio') {
			const audio = (await input.getPrimaryAudioTrack())!;
			const rate = await audio.getSampleRate();
			let expected = 0;
			for await (const packet of sink.packets()) {
				if (Math.abs(packet.timestamp - expected) > 0.5 / rate) {
					throw new Error('Recovery audio contains a gap or overlap.');
				}
				expected = packet.timestamp + packet.duration;
			}
			if (Math.abs(expected - (unit.end - unit.start)) > 0.5 / rate) {
				throw new Error('Recovery audio chunk does not cover the requested sample range.');
			}
		}
		if (unit.kind === 'video') {
			const offset = unit.videoTimestampOffset ?? -unit.start;
			for await (const packet of sink.packets()) {
				if (packet.timestamp < unit.start + offset - 1e-5 || packet.timestamp >= unit.end + offset + 0.002) {
					throw new Error('Recovery video packet lies outside the requested region.');
				}
			}
		}
	}

	/** @internal */
	async _readSegment(index: number) {
		const bytes = await this._options.store.readSegment(index);
		const expected = this._state.segments[index]!;
		if (bytes.byteLength !== expected.byteLength || (await digest(bytes)) !== expected.hash) {
			throw new Error(`Recovery segment ${index} is missing, truncated, or corrupt.`);
		}
		return bytes;
	}
}
