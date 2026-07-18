/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AUDIO_CODECS,
	AudioCodec,
	buildAudioCodecString,
	buildVideoCodecString,
	guessDescriptionForAudio,
	guessDescriptionForVideo,
	inferCodecFromCodecString,
	MediaCodec,
	parsePcmCodec,
	PCM_AUDIO_CODECS,
	PcmAudioCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import {
	AvcNalUnitType,
	concatAvcNalUnits,
	deserializeAvcDecoderConfigurationRecord,
	determineVideoPacketType,
	extractNalUnitTypeForAvc,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
	iterateAvcNalUnits,
	iterateHevcNalUnits,
	parseAvcSps,
	sanitizeHevcPacketForChromium,
} from './codec-data';
import { CustomAudioDecoder, customAudioDecoders, CustomVideoDecoder, customVideoDecoders } from './custom-coder';
import {
	assert,
	assertNever,
	clamp,
	getInt24,
	getUint24,
	insertSorted,
	isAllowSharedBufferSource,
	isChromium,
	isWebKit,
	last,
	NaiveCallSerializer,
	promiseWithResolvers,
	removeItem,
	Rotation,
	SetOptional,
	toDataView,
	toUint8Array,
} from './misc';
import { EncodedPacket } from './packet';
import { fromAlaw, fromUlaw } from './pcm';
import { AudioSample, VideoSample, VideoSamplePixelFormat } from './sample';

export abstract class DecoderWrapper<
	MediaSample extends VideoSample | AudioSample,
> {
	constructor(
		public onSample: (sample: MediaSample) => unknown,
		public onError: (error: unknown) => unknown,
	) {}

	abstract getDecodeQueueSize(): number;
	abstract decode(packet: EncodedPacket): void;
	abstract flush(): Promise<void>;
	abstract close(): void;

	abstract get closed(): boolean;
}

export class VideoDecoderWrapper extends DecoderWrapper<VideoSample> {
	decoder: VideoDecoder | null = null;

	customDecoder: CustomVideoDecoder | null = null;
	customDecoderCallSerializer = new NaiveCallSerializer();
	customDecoderQueueSize = 0;
	customDecoderClosed = false;

	inputTimestamps: number[] = []; // Timestamps input into the decoder, sorted.
	frameQueue: VideoFrame[] = []; // Safari-specific thing, check usage.
	currentPacketIndex = 0;
	raslSkipped = false; // For HEVC stuff

	// Alpha stuff
	alphaDecoder: VideoDecoder | null = null;
	alphaHadKeyframe = false;
	colorQueue: VideoFrame[] = [];
	alphaQueue: (VideoFrame | null)[] = [];
	merger: ColorAlphaMerger | null = null;
	decodedAlphaChunkCount = 0;
	alphaDecoderQueueSize = 0;
	/** Each value is the number of decoded alpha chunks at which a null alpha frame should be added. */
	nullAlphaFrameQueue: number[] = [];
	currentAlphaPacketIndex = 0;
	alphaRaslSkipped = false; // For HEVC stuff
	finalFrames: { frame: VideoFrame | null }[] = [];
	mergeAlphaPromises: Promise<void>[] = [];

	onDequeue: (() => unknown) | null = null;

	constructor(
		onSample: (sample: VideoSample) => unknown,
		onError: (error: unknown) => unknown,
		public codec: VideoCodec,
		public decoderConfig: VideoDecoderConfig,
		public rotation: Rotation,
		public timeResolution: number,
	) {
		super(onSample, onError);

		const MatchingCustomDecoder = customVideoDecoders.find(x => x.supports(codec, decoderConfig));
		if (MatchingCustomDecoder) {
			// @ts-expect-error "Can't create instance of abstract class 🤓"
			this.customDecoder = new MatchingCustomDecoder() as CustomVideoDecoder;
			// @ts-expect-error It's technically readonly
			this.customDecoder.codec = codec;
			// @ts-expect-error It's technically readonly
			this.customDecoder.config = decoderConfig;
			// @ts-expect-error It's technically readonly
			this.customDecoder.onSample = (sample) => {
				if (!(sample instanceof VideoSample)) {
					throw new TypeError('The argument passed to onSample must be a VideoSample.');
				}

				// @ts-expect-error Readonly
				sample.rotation = this.rotation;

				this.onSample(sample);
			};
			// @ts-expect-error It's technically readonly
			this.customDecoder.onError = (error) => {
				onError(error);
			};

			void this.customDecoderCallSerializer
				.call(() => this.customDecoder!.init())
				.catch(error => onError(error));
		} else {
			const colorHandler = (frame: VideoFrame) => {
				if (this.alphaQueue.length > 0) {
					// Even when no alpha data is present (most of the time), there will be nulls in this queue
					const alphaFrame = this.alphaQueue.shift();
					assert(alphaFrame !== undefined);

					void this.mergeAlpha(frame, alphaFrame);
				} else {
					this.colorQueue.push(frame);
				}
			};

			if (codec === 'avc' && this.decoderConfig.description && isChromium()) {
				// Chromium has/had a bug with playing interlaced AVC (https://issues.chromium.org/issues/456919096)
				// which can be worked around by requesting that software decoding be used. So, here we peek into the
				// AVC description, if present, and switch to software decoding if we find interlaced content.
				const record = deserializeAvcDecoderConfigurationRecord(toUint8Array(this.decoderConfig.description));
				if (record && record.sequenceParameterSets.length > 0) {
					const sps = parseAvcSps(record.sequenceParameterSets[0]!);
					if (sps && sps.frameMbsOnlyFlag === 0) {
						this.decoderConfig = {
							...this.decoderConfig,
							hardwareAcceleration: 'prefer-software',
						};
					}
				}
			}

			const stack = new Error('Decoding error').stack;

			this.decoder = new VideoDecoder({
				output: (frame) => {
					try {
						colorHandler(frame);
					} catch (error) {
						this.onError(error);
					}
				},
				error: (error) => {
					error.stack = stack; // Provide a more useful stack trace, the default one sucks
					this.onError(error);
				},
			});
			this.decoder.configure(this.decoderConfig);

			this.decoder.addEventListener('dequeue', () => {
				this.onDequeue?.();
			});
		}
	}

	getDecodeQueueSize() {
		if (this.customDecoder) {
			return this.customDecoderQueueSize;
		} else {
			assert(this.decoder);

			let result = Math.max(
				this.decoder.decodeQueueSize,
				this.alphaDecoder?.decodeQueueSize ?? 0,
			);

			// Frames in an in-flight alpha merge must also count towards the queue size
			result += this.finalFrames.length;

			return result;
		}
	}

	decode(packet: EncodedPacket) {
		if (this.codec === 'hevc' && this.currentPacketIndex > 0 && !this.raslSkipped) {
			if (this.hasHevcRaslPicture(packet.data)) {
				return; // Drop
			}

			this.raslSkipped = true;
		}

		if (this.customDecoder) {
			this.customDecoderQueueSize++;
			void this.customDecoderCallSerializer
				.call(() => this.customDecoder!.decode(packet))
				.catch(error => this.onError(error))
				.finally(() => {
					this.customDecoderQueueSize--;
					this.onDequeue?.();
				});
		} else {
			assert(this.decoder);

			if (!isWebKit()) {
				insertSorted(this.inputTimestamps, packet.timestamp, x => x);
			}

			if (isChromium() && this.currentPacketIndex === 0) {
				if (this.codec === 'avc') {
					// Workaround for https://issues.chromium.org/issues/470109459
					const filteredNalUnits: Uint8Array[] = [];
					let hasFrameData = false;

					for (const loc of iterateAvcNalUnits(packet.data, this.decoderConfig)) {
						const type = extractNalUnitTypeForAvc(packet.data[loc.offset]!);
						hasFrameData ||= type >= 1 && type <= 5;

						if (type === AvcNalUnitType.AUD) {
							if (hasFrameData) {
								// Already has actual frame data, so treat an AUD as simply the end of the packet
								break;
							} else {
								// If packets contain an AUD and have NALUs before it, this trips up Chromium's key
								// frame detector. Clear the NALUs if an AUD is encountered.
								// https://github.com/Vanilagy/mediabunny/issues/396
								filteredNalUnits.length = 0;
							}
						}

						// These trip up Chromium's key frame detection, so let's strip them
						if (!(type >= 20 && type <= 31)) {
							filteredNalUnits.push(packet.data.subarray(loc.offset, loc.offset + loc.length));
						}
					}

					const newData = concatAvcNalUnits(filteredNalUnits, this.decoderConfig);
					packet = new EncodedPacket(newData, packet.type, packet.timestamp, packet.duration);
				} else if (this.codec === 'hevc') {
					// Workaround for https://issues.chromium.org/issues/507611247
					const sanitizedData = sanitizeHevcPacketForChromium(packet.data, this.decoderConfig);
					if (sanitizedData) {
						packet = new EncodedPacket(sanitizedData, packet.type, packet.timestamp, packet.duration);
					}
				}
			}

			this.decoder.decode(packet.toEncodedVideoChunk());
			this.decodeAlphaData(packet);
		}

		this.currentPacketIndex++;
	}

	decodeAlphaData(packet: EncodedPacket) {
		if (!packet.sideData.alpha) {
			// No alpha side data in the packet, most common case
			this.pushNullAlphaFrame();
			return;
		}

		if (!this.merger) {
			this.merger = new ColorAlphaMerger();
		}

		// Check if we need to set up the alpha decoder
		if (!this.alphaDecoder) {
			const alphaHandler = (frame: VideoFrame) => {
				if (this.colorQueue.length > 0) {
					const colorFrame = this.colorQueue.shift();
					assert(colorFrame !== undefined);

					void this.mergeAlpha(colorFrame, frame);
				} else {
					this.alphaQueue.push(frame);
				}

				// Check if any null frames have been queued for this point
				this.decodedAlphaChunkCount++;
				while (
					this.nullAlphaFrameQueue.length > 0
					&& this.nullAlphaFrameQueue[0] === this.decodedAlphaChunkCount
				) {
					this.nullAlphaFrameQueue.shift();

					if (this.colorQueue.length > 0) {
						const colorFrame = this.colorQueue.shift();
						assert(colorFrame !== undefined);

						void this.mergeAlpha(colorFrame, null);
					} else {
						this.alphaQueue.push(null);
					}
				}

				this.alphaDecoderQueueSize--;
			};

			const stack = new Error('Decoding error').stack;

			this.alphaDecoder = new VideoDecoder({
				output: (frame) => {
					try {
						alphaHandler(frame);
					} catch (error) {
						this.onError(error);
					}
				},
				error: (error) => {
					error.stack = stack; // Provide a more useful stack trace, the default one sucks
					this.onError(error);
				},
			});
			this.alphaDecoder.configure(this.decoderConfig);

			this.alphaDecoder.addEventListener('dequeue', () => {
				this.onDequeue?.();
			});
		}

		const type = determineVideoPacketType(this.codec, this.decoderConfig, packet.sideData.alpha);

		// Alpha packets might follow a different key frame rhythm than the main packets. Therefore, before we start
		// decoding, we must first find a packet that's actually a key frame. Until then, we treat the image as opaque.
		if (!this.alphaHadKeyframe) {
			this.alphaHadKeyframe = type === 'key';
		}

		if (this.alphaHadKeyframe) {
			// Same RASL skipping logic as for color, unlikely to be hit (since who uses HEVC with separate alpha??) but
			// here for symmetry.
			if (this.codec === 'hevc' && this.currentAlphaPacketIndex > 0 && !this.alphaRaslSkipped) {
				if (this.hasHevcRaslPicture(packet.sideData.alpha)) {
					this.pushNullAlphaFrame();
					return;
				}

				this.alphaRaslSkipped = true;
			}

			this.currentAlphaPacketIndex++;
			this.alphaDecoder.decode(packet.alphaToEncodedVideoChunk(type ?? packet.type));
			this.alphaDecoderQueueSize++;
		} else {
			this.pushNullAlphaFrame();
		}
	}

	pushNullAlphaFrame() {
		if (this.alphaDecoderQueueSize === 0) {
			// Easy
			this.alphaQueue.push(null);
		} else {
			// There are still alpha chunks being decoded, so pushing `null` immediately would result in out-of-order
			// data and be incorrect. Instead, we need to enqueue a "null frame" for when the current decoder workload
			// has finished.
			this.nullAlphaFrameQueue.push(this.decodedAlphaChunkCount + this.alphaDecoderQueueSize);
		}
	}

	/**
	 * If we're using HEVC, we need to make sure to skip any RASL slices that follow a non-IDR key frame such as
	 * CRA_NUT. This is because RASL slices cannot be decoded without data before the CRA_NUT. Browsers behave
	 * differently here: Chromium drops the packets, Safari throws a decoder error. Either way, it's not good
	 * and causes bugs upstream. So, let's take the dropping into our own hands.
	 */
	hasHevcRaslPicture(packetData: Uint8Array) {
		for (const loc of iterateHevcNalUnits(packetData, this.decoderConfig)) {
			const type = extractNalUnitTypeForHevc(packetData[loc.offset]!);
			if (type === HevcNalUnitType.RASL_N || type === HevcNalUnitType.RASL_R) {
				return true;
			}
		}

		return false;
	}

	/** Handler for the WebCodecs VideoDecoder for ironing out browser differences. */
	frameHandler(frame: VideoFrame) {
		if (isWebKit()) {
			// For correct B-frame handling, we don't just hand over the frames directly but instead add them to
			// a queue, because we want to ensure frames are emitted in presentation order. We flush the queue
			// each time we receive a frame with a timestamp larger than the highest we've seen so far, as we
			// can sure that is not a B-frame. Typically, WebCodecs automatically guarantees that frames are
			// emitted in presentation order, but Safari doesn't always follow this rule.
			if (this.frameQueue.length > 0 && (frame.timestamp >= last(this.frameQueue)!.timestamp)) {
				for (const frame of this.frameQueue) {
					this.finalizeAndEmitSample(frame);
				}

				this.frameQueue.length = 0;
			}

			insertSorted(this.frameQueue, frame, x => x.timestamp);
		} else {
			// Assign it the next earliest timestamp from the input. We do this because browsers, by spec, are
			// required to emit decoded frames in presentation order *while* retaining the timestamp of their
			// originating EncodedVideoChunk. For files with B-frames but no out-of-order timestamps (like a
			// missing ctts box, for example), this causes a mismatch. We therefore fix the timestamps and
			// ensure they are sorted by doing this.
			const timestamp = this.inputTimestamps.shift();

			// There's no way we'd have more decoded frames than encoded packets we passed in. Actually, the
			// correspondence should be 1:1.
			assert(timestamp !== undefined);
			this.finalizeAndEmitSample(frame, timestamp);
		}
	}

	finalizeAndEmitSample(frame: VideoFrame, timestampOverride?: number) {
		const sample = new VideoSample(frame, {
			// Round the timestamps to the time resolution
			timestamp: Math.round(
				(timestampOverride ?? (frame.timestamp / 1e6)) * this.timeResolution,
			) / this.timeResolution,
			duration: Math.round(
				(frame.duration ?? 0) / 1e6 * this.timeResolution,
			) / this.timeResolution,
			rotation: this.rotation,
		});

		this.onSample(sample);
	}

	async mergeAlpha(color: VideoFrame, alpha: VideoFrame | null) {
		const resolver = promiseWithResolvers();
		this.mergeAlphaPromises.push(resolver.promise);

		// Alpha merging is concurrent but the frames must still be emitted in the same order in which the merging
		// began. Therefore, serialize the results in an array.
		const result: { frame: VideoFrame | null } = { frame: null };
		this.finalFrames.push(result);

		try {
			if (!alpha) {
				// Nothing needs to be merged
				result.frame = color;
			} else {
				assert(this.merger);

				// The merger takes ownership of the frames, so no need to close them ourselves
				result.frame = await this.merger.merge(color, alpha);
			}

			// Emit any leading frames that are ready, preserving input order
			while (this.finalFrames.length > 0 && this.finalFrames[0]!.frame !== null) {
				const next = this.finalFrames.shift()!;
				this.frameHandler(next.frame!);
			}
		} catch (error) {
			removeItem(this.finalFrames, result);
			this.onError(error);
		} finally {
			removeItem(this.mergeAlphaPromises, resolver.promise);
			resolver.resolve();
		}
	}

	async flush() {
		if (this.customDecoder) {
			await this.customDecoderCallSerializer.call(() => this.customDecoder!.flush());
		} else {
			assert(this.decoder);
			await Promise.all([
				this.decoder.flush(),
				this.alphaDecoder?.flush(),
			]);
			await Promise.all(this.mergeAlphaPromises);

			this.colorQueue.forEach(x => x.close());
			this.colorQueue.length = 0;
			this.alphaQueue.forEach(x => x?.close());
			this.alphaQueue.length = 0;

			this.alphaHadKeyframe = false;
			this.decodedAlphaChunkCount = 0;
			this.alphaDecoderQueueSize = 0;
			this.nullAlphaFrameQueue.length = 0;
			this.currentAlphaPacketIndex = 0;
			this.alphaRaslSkipped = false;
		}

		if (isWebKit()) {
			for (const sample of this.frameQueue) {
				this.finalizeAndEmitSample(sample);
			}

			this.frameQueue.length = 0;
		}

		this.currentPacketIndex = 0;
		this.raslSkipped = false;
	}

	close() {
		if (this.customDecoder) {
			if (!this.customDecoderClosed) {
				this.customDecoderClosed = true;
				void this.customDecoderCallSerializer.call(() => this.customDecoder!.close());
			}
		} else {
			assert(this.decoder);

			if (this.decoder.state !== 'closed') {
				this.decoder.close();
			}
			if (this.alphaDecoder && this.alphaDecoder.state !== 'closed') {
				this.alphaDecoder.close();
			}

			this.colorQueue.forEach(x => x.close());
			this.colorQueue.length = 0;
			this.alphaQueue.forEach(x => x?.close());
			this.alphaQueue.length = 0;

			this.merger?.close();
		}

		for (const sample of this.frameQueue) {
			sample.close();
		}
		this.frameQueue.length = 0;
	}

	get closed() {
		if (this.customDecoder) {
			if (this.customDecoderClosed) {
				return true;
			}

			return !this.customDecoderCallSerializer.errored;
		} else {
			assert(this.decoder);
			return this.decoder.state === 'closed';
		}
	}
}

let mergerWorkerUrl: string | null = null;

/** Utility class that merges together color and alpha information on the CPU in a pool of workers. */
class ColorAlphaMerger {
	private workers: Worker[] = [];
	private nextWorkerIndex = 0;
	private pendingRequests = new Map<number, ReturnType<typeof promiseWithResolvers<VideoFrame>>>();
	private nextRequestId = 0;

	merge(color: VideoFrame, alpha: VideoFrame): Promise<VideoFrame> {
		if (this.workers.length === 0) {
			if (!mergerWorkerUrl) {
				const blob = new Blob(
					[`(${colorAlphaMergerWorkerCode.toString()})()`],
					{ type: 'application/javascript' },
				);
				mergerWorkerUrl = URL.createObjectURL(blob);
			}

			const poolSize = clamp(navigator.hardwareConcurrency, 1, 4);
			for (let i = 0; i < poolSize; i++) {
				const worker = new Worker(mergerWorkerUrl);

				worker.addEventListener('message', (event: MessageEvent<ColorAlphaMergerWorkerResponse>) => {
					const data = event.data;
					const pending = this.pendingRequests.get(data.id);
					if (!pending) {
						return;
					}
					this.pendingRequests.delete(data.id);

					if ('error' in data) {
						pending.reject(new Error(data.error));
					} else {
						pending.resolve(data.frame);
					}
				});

				worker.addEventListener('error', (event) => {
					const error = new Error(event.message || 'Color/alpha merge worker error.');
					for (const pending of this.pendingRequests.values()) {
						pending.reject(error);
					}
					this.pendingRequests.clear();
				});

				this.workers.push(worker);
			}
		}

		const id = this.nextRequestId++;
		const pending = promiseWithResolvers<VideoFrame>();
		this.pendingRequests.set(id, pending);

		// Hand the job to the next worker in round-robin fashion
		const worker = this.workers[this.nextWorkerIndex]!;
		this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
		worker.postMessage({ id, color, alpha }, { transfer: [color, alpha] });

		return pending.promise;
	}

	close() {
		for (const worker of this.workers) {
			worker.terminate();
		}
		this.workers.length = 0;

		const error = new Error('Color/alpha merger closed.');
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

type ColorAlphaMergerWorkerRequest = {
	id: number;
	color: VideoFrame;
	alpha: VideoFrame;
};

type ColorAlphaMergerWorkerResponse =
	| { id: number; frame: VideoFrame }
	| { id: number; error: string };

const colorAlphaMergerWorkerCode = () => {
	// These buffers are reused across frames as long as the size matches, since consecutive frames usually share
	// dimensions
	let cpuAlphaBuffer: Uint8Array | null = null;
	let cpuColorBuffer: Uint8Array | null = null;

	// Serialize execution internally so concurrent requests don't race on the shared cpu*Buffer state.
	let chain: Promise<void> = Promise.resolve();
	self.addEventListener('message', (event: MessageEvent<ColorAlphaMergerWorkerRequest>) => {
		const { id, color, alpha } = event.data;
		chain = chain.then(async () => {
			try {
				const frame = await merge(color, alpha);
				self.postMessage({ id, frame }, { transfer: [frame] });
			} catch (error) {
				self.postMessage({ id, error: (error as Error).message });
			} finally {
				// We took ownership of the inputs via transfer; close them now that the merge (or its error) is done.
				color.close();
				alpha.close();
			}
		});
	});

	const merge = async (color: VideoFrame, alpha: VideoFrame): Promise<VideoFrame> => {
		const format = color.format as VideoSamplePixelFormat | null;
		const alphaFormat = alpha.format as VideoSamplePixelFormat | null;
		if (!format || !alphaFormat) {
			throw new Error('CPU color/alpha merging requires a known VideoFrame format.');
		}

		// The alpha frame must have the same bit depth as the color frame
		const colorIs10 = format.includes('P10');
		const colorIs12 = format.includes('P12');
		const alphaIs10 = alphaFormat.includes('P10');
		const alphaIs12 = alphaFormat.includes('P12');
		if (alphaIs10 !== colorIs10 || alphaIs12 !== colorIs12) {
			throw new Error(
				`CPU color/alpha merging requires the alpha frame to have the same bit depth as the color frame`
				+ ` (color: '${format}', alpha: '${alphaFormat}').`,
			);
		}

		if (format === 'RGBX' || format === 'RGBA' || format === 'BGRX' || format === 'BGRA') {
			return await mergeInterleavedRgba(color, alpha, format);
		} else if (
			format === 'I420' || format === 'I420P10' || format === 'I420P12'
			|| format === 'I422' || format === 'I422P10' || format === 'I422P12'
			|| format === 'I444' || format === 'I444P10' || format === 'I444P12'
		) {
			return await mergePlanarYuv(color, alpha, format);
		} else if (format === 'NV12') {
			return await mergeNv12(color, alpha);
		}

		throw new Error(`CPU color/alpha merging does not support format '${format}'.`);
	};

	const mergeInterleavedRgba = async (
		color: VideoFrame,
		alpha: VideoFrame,
		format: 'RGBX' | 'RGBA' | 'BGRX' | 'BGRA',
	): Promise<VideoFrame> => {
		const width = color.visibleRect?.width ?? color.codedWidth;
		const height = color.visibleRect?.height ?? color.codedHeight;

		const pixelCount = width * height;
		const output = new Uint8Array(pixelCount * 4);

		// Color goes straight into the output buffer via copyTo, no intermediate copy needed
		await color.copyTo(output);

		// And now add the alpha data
		const alphaY = await readAlpha(alpha, width, height, 1);
		for (let i = 0, j = 3; i < pixelCount; i++, j += 4) {
			output[j] = alphaY[i]!;
		}

		const outputFormat = (format === 'RGBX' || format === 'RGBA') ? 'RGBA' : 'BGRA';
		const init = {
			format: outputFormat,
			codedWidth: width,
			codedHeight: height,
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
			transfer: [output.buffer],
		} as const;

		return new VideoFrame(output, init);
	};

	const mergePlanarYuv = async (
		color: VideoFrame,
		alpha: VideoFrame,
		format:
			| 'I420' | 'I420P10' | 'I420P12'
			| 'I422' | 'I422P10' | 'I422P12'
			| 'I444' | 'I444P10' | 'I444P12',
	): Promise<VideoFrame> => {
		const width = color.visibleRect?.width ?? color.codedWidth;
		const height = color.visibleRect?.height ?? color.codedHeight;

		const is10 = format.includes('P10');
		const is12 = format.includes('P12');
		const bytesPerSample = (is10 || is12) ? 2 : 1;

		let chromaW: number;
		let chromaH: number;
		if (format.startsWith('I420')) {
			chromaW = Math.ceil(width / 2);
			chromaH = Math.ceil(height / 2);
		} else if (format.startsWith('I422')) {
			chromaW = Math.ceil(width / 2);
			chromaH = height;
		} else {
			chromaW = width;
			chromaH = height;
		}

		const ySamples = width * height;
		const uvSamples = chromaW * chromaH;
		const yBytes = ySamples * bytesPerSample;
		const uvBytes = uvSamples * bytesPerSample;
		const aBytes = ySamples * bytesPerSample;

		const outputBytes = yBytes + 2 * uvBytes + aBytes;
		const output = new Uint8Array(outputBytes);

		// Write color planes directly into the output buffer via copyTo, no intermediate copy
		await color.copyTo(output);

		const alphaY = await readAlpha(alpha, width, height, bytesPerSample);
		const aOffset = yBytes + 2 * uvBytes;
		output.set(alphaY, aOffset);

		const outputFormat = (format.slice(0, 4) + 'A' + format.slice(4)) as VideoPixelFormat;

		const init = {
			format: outputFormat,
			codedWidth: width,
			codedHeight: height,
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
			transfer: [output.buffer],
		};

		return new VideoFrame(output, init);
	};

	const mergeNv12 = async (
		color: VideoFrame,
		alpha: VideoFrame,
	): Promise<VideoFrame> => {
		const width = color.visibleRect?.width ?? color.codedWidth;
		const height = color.visibleRect?.height ?? color.codedHeight;

		const ySize = width * height;
		const chromaW = Math.ceil(width / 2);
		const chromaH = Math.ceil(height / 2);
		const uvSize = chromaW * chromaH;

		const sourceSize = color.allocationSize();
		if (!cpuColorBuffer || cpuColorBuffer.byteLength !== sourceSize) {
			cpuColorBuffer = new Uint8Array(sourceSize);
		}
		await color.copyTo(cpuColorBuffer);

		const output = new Uint8Array(ySize + 2 * uvSize + ySize);

		// Y plane copies straight over
		output.set(cpuColorBuffer.subarray(0, ySize), 0);

		// Deinterleave the UV plane into separate U and V planes
		const uOffset = ySize;
		const vOffset = ySize + uvSize;
		const uvStart = ySize;
		for (let i = 0; i < uvSize; i++) {
			output[uOffset + i] = cpuColorBuffer[uvStart + i * 2]!;
			output[vOffset + i] = cpuColorBuffer[uvStart + i * 2 + 1]!;
		}

		const alphaY = await readAlpha(alpha, width, height, 1);
		output.set(alphaY, ySize + 2 * uvSize);

		const init = {
			format: 'I420A',
			codedWidth: width,
			codedHeight: height,
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
			transfer: [output.buffer],
		} as const;

		return new VideoFrame(output, init);
	};

	const readAlpha = async (alpha: VideoFrame, width: number, height: number, bytesPerSample: number) => {
		const size = alpha.allocationSize();
		if (!cpuAlphaBuffer || cpuAlphaBuffer.byteLength !== size) {
			cpuAlphaBuffer = new Uint8Array(size);
		}
		await alpha.copyTo(cpuAlphaBuffer);

		const format = alpha.format;
		if (format === 'RGBA' || format === 'BGRA' || format === 'RGBX' || format === 'BGRX') {
			// Pack alpha data tightly. Assume alpha is stored in RGB, so sample just from R for simplicity.
			const rOffset = (format === 'RGBA' || format === 'RGBX') ? 0 : 2;
			const pixelCount = width * height;
			for (let i = 0; i < pixelCount; i++) {
				cpuAlphaBuffer[i] = cpuAlphaBuffer[i * 4 + rOffset]!;
			}
			return cpuAlphaBuffer.subarray(0, pixelCount);
		} else {
			// For Y-plane-first formats (I*** and NV12), the leading width*height samples are the Y plane
			return cpuAlphaBuffer.subarray(0, width * height * bytesPerSample);
		}
	};
};

export class AudioDecoderWrapper extends DecoderWrapper<AudioSample> {
	decoder: AudioDecoder | null = null;

	customDecoder: CustomAudioDecoder | null = null;
	customDecoderCallSerializer = new NaiveCallSerializer();
	customDecoderQueueSize = 0;
	customDecoderClosed = false;

	// Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
	// inaccurate) packet timestamps.
	currentTimestamp: number | null = null;
	// Chromium does not respect negative packet timestamps, so we must do the fixin' ourselves
	expectedFirstTimestamp: number | null = null;
	timestampOffset = 0;

	onDequeue: (() => unknown) | null = null;

	constructor(
		onSample: (sample: AudioSample) => unknown,
		onError: (error: unknown) => unknown,
		codec: AudioCodec,
		decoderConfig: AudioDecoderConfig,
	) {
		super(onSample, onError);

		const sampleHandler = (sample: AudioSample) => {
			let sampleTimestamp = sample.timestamp;

			if (this.expectedFirstTimestamp && this.currentTimestamp === null) {
				this.timestampOffset = this.expectedFirstTimestamp - sampleTimestamp;
			}

			sampleTimestamp += this.timestampOffset;

			if (
				this.currentTimestamp === null
				|| Math.abs(sampleTimestamp - this.currentTimestamp) >= sample.duration
			) {
				// We need to sync with the sample timestamp again
				this.currentTimestamp = sampleTimestamp;
			}

			const preciseTimestamp = this.currentTimestamp;
			this.currentTimestamp += sample.duration;

			if (sample.numberOfFrames === 0) {
				// We skip zero-data (empty) AudioSamples. These are sometimes emitted, for example, by Firefox when it
				// decodes Vorbis (at the start).
				sample.close();
				return;
			}

			// Round the timestamp to the sample rate
			const sampleRate = decoderConfig.sampleRate;
			// @ts-expect-error Readonly
			sample.timestamp = Math.round(preciseTimestamp * sampleRate) / sampleRate;

			onSample(sample);
		};

		const MatchingCustomDecoder = customAudioDecoders.find(x => x.supports(codec, decoderConfig));
		if (MatchingCustomDecoder) {
			// @ts-expect-error "Can't create instance of abstract class 🤓"
			this.customDecoder = new MatchingCustomDecoder() as CustomAudioDecoder;
			// @ts-expect-error It's technically readonly
			this.customDecoder.codec = codec;
			// @ts-expect-error It's technically readonly
			this.customDecoder.config = decoderConfig;
			// @ts-expect-error It's technically readonly
			this.customDecoder.onSample = (sample) => {
				if (!(sample instanceof AudioSample)) {
					throw new TypeError('The argument passed to onSample must be an AudioSample.');
				}

				sampleHandler(sample);
			};
			// @ts-expect-error It's technically readonly
			this.customDecoder.onError = (error) => {
				onError(error);
			};

			void this.customDecoderCallSerializer
				.call(() => this.customDecoder!.init())
				.catch(error => onError(error));
		} else {
			const stack = new Error('Decoding error').stack;

			this.decoder = new AudioDecoder({
				output: (data) => {
					try {
						sampleHandler(new AudioSample(data));
					} catch (error) {
						this.onError(error);
					}
				},
				error: (error) => {
					error.stack = stack; // Provide a more useful stack trace, the default one sucks
					this.onError(error);
				},
			});
			this.decoder.configure(decoderConfig);

			this.decoder.addEventListener('dequeue', () => {
				this.onDequeue?.();
			});
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

	decode(packet: EncodedPacket) {
		if (this.customDecoder) {
			this.customDecoderQueueSize++;
			void this.customDecoderCallSerializer
				.call(() => this.customDecoder!.decode(packet))
				.catch(error => this.onError(error))
				.finally(() => {
					this.customDecoderQueueSize--;
					this.onDequeue?.();
				});
		} else {
			assert(this.decoder);

			this.expectedFirstTimestamp ??= packet.timestamp;
			this.decoder.decode(packet.toEncodedAudioChunk());
		}
	}

	async flush() {
		if (this.customDecoder) {
			await this.customDecoderCallSerializer.call(() => this.customDecoder!.flush());
		} else {
			assert(this.decoder);
			await this.decoder.flush();
		}

		this.currentTimestamp = null;
		this.expectedFirstTimestamp = null;
		this.timestampOffset = 0;
	}

	close() {
		if (this.customDecoder) {
			if (!this.customDecoderClosed) {
				this.customDecoderClosed = true;
				void this.customDecoderCallSerializer.call(() => this.customDecoder!.close());
			}
		} else {
			assert(this.decoder);

			if (this.decoder.state !== 'closed') {
				this.decoder.close();
			}
		}
	}

	get closed() {
		if (this.customDecoder) {
			if (this.customDecoderClosed) {
				return true;
			}

			return !this.customDecoderCallSerializer.errored;
		} else {
			assert(this.decoder);
			return this.decoder.state === 'closed';
		}
	}
}

// There are a lot of PCM variants not natively supported by the browser and by AudioData. Therefore we need a simple
// decoder that maps any input PCM format into a PCM format supported by the browser.
export class PcmAudioDecoderWrapper extends DecoderWrapper<AudioSample> {
	codec: PcmAudioCodec;

	inputSampleSize: 1 | 2 | 3 | 4 | 8;
	readInputValue: (view: DataView, byteOffset: number) => number;

	outputSampleSize: 1 | 2 | 4;
	outputFormat: 'u8' | 's16' | 's32' | 'f32';
	writeOutputValue: (view: DataView, byteOffset: number, value: number) => void;

	// Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
	// inaccurate) packet timestamps.
	currentTimestamp: number | null = null;

	isClosed = false;

	onDequeue: (() => unknown) | null = null;

	constructor(
		onSample: (sample: AudioSample) => unknown,
		onError: (error: unknown) => unknown,
		public decoderConfig: AudioDecoderConfig,
	) {
		super(onSample, onError);

		assert((PCM_AUDIO_CODECS as readonly string[]).includes(decoderConfig.codec));
		this.codec = decoderConfig.codec as PcmAudioCodec;

		const { dataType, sampleSize, littleEndian } = parsePcmCodec(this.codec);
		this.inputSampleSize = sampleSize;

		switch (sampleSize) {
			case 1: {
				if (dataType === 'unsigned') {
					this.readInputValue = (view, byteOffset) => view.getUint8(byteOffset) - 2 ** 7;
				} else if (dataType === 'signed') {
					this.readInputValue = (view, byteOffset) => view.getInt8(byteOffset);
				} else if (dataType === 'ulaw') {
					this.readInputValue = (view, byteOffset) => fromUlaw(view.getUint8(byteOffset));
				} else if (dataType === 'alaw') {
					this.readInputValue = (view, byteOffset) => fromAlaw(view.getUint8(byteOffset));
				} else {
					assert(false);
				}
			}; break;
			case 2: {
				if (dataType === 'unsigned') {
					this.readInputValue = (view, byteOffset) => view.getUint16(byteOffset, littleEndian) - 2 ** 15;
				} else if (dataType === 'signed') {
					this.readInputValue = (view, byteOffset) => view.getInt16(byteOffset, littleEndian);
				} else {
					assert(false);
				}
			}; break;
			case 3: {
				if (dataType === 'unsigned') {
					this.readInputValue = (view, byteOffset) => getUint24(view, byteOffset, littleEndian) - 2 ** 23;
				} else if (dataType === 'signed') {
					this.readInputValue = (view, byteOffset) => getInt24(view, byteOffset, littleEndian);
				} else {
					assert(false);
				}
			}; break;
			case 4: {
				if (dataType === 'unsigned') {
					this.readInputValue = (view, byteOffset) => view.getUint32(byteOffset, littleEndian) - 2 ** 31;
				} else if (dataType === 'signed') {
					this.readInputValue = (view, byteOffset) => view.getInt32(byteOffset, littleEndian);
				} else if (dataType === 'float') {
					this.readInputValue = (view, byteOffset) => view.getFloat32(byteOffset, littleEndian);
				} else {
					assert(false);
				}
			}; break;
			case 8: {
				if (dataType === 'float') {
					this.readInputValue = (view, byteOffset) => view.getFloat64(byteOffset, littleEndian);
				} else {
					assert(false);
				}
			}; break;
			default: {
				assertNever(sampleSize);
				assert(false);
			};
		}

		switch (sampleSize) {
			case 1: {
				if (dataType === 'ulaw' || dataType === 'alaw') {
					this.outputSampleSize = 2;
					this.outputFormat = 's16';
					this.writeOutputValue = (view, byteOffset, value) => view.setInt16(byteOffset, value, true);
				} else {
					this.outputSampleSize = 1;
					this.outputFormat = 'u8';
					this.writeOutputValue = (view, byteOffset, value) => view.setUint8(byteOffset, value + 2 ** 7);
				}
			}; break;
			case 2: {
				this.outputSampleSize = 2;
				this.outputFormat = 's16';
				this.writeOutputValue = (view, byteOffset, value) => view.setInt16(byteOffset, value, true);
			}; break;
			case 3: {
				this.outputSampleSize = 4;
				this.outputFormat = 's32';
				// From https://www.w3.org/TR/webcodecs:
				// AudioData containing 24-bit samples SHOULD store those samples in s32 or f32. When samples are
				// stored in s32, each sample MUST be left-shifted by 8 bits.
				this.writeOutputValue = (view, byteOffset, value) => view.setInt32(byteOffset, value << 8, true);
			}; break;
			case 4: {
				this.outputSampleSize = 4;

				if (dataType === 'float') {
					this.outputFormat = 'f32';
					this.writeOutputValue = (view, byteOffset, value) => view.setFloat32(byteOffset, value, true);
				} else {
					this.outputFormat = 's32';
					this.writeOutputValue = (view, byteOffset, value) => view.setInt32(byteOffset, value, true);
				}
			}; break;
			case 8: {
				this.outputSampleSize = 4;

				this.outputFormat = 'f32';
				this.writeOutputValue = (view, byteOffset, value) => view.setFloat32(byteOffset, value, true);
			}; break;
			default: {
				assertNever(sampleSize);
				assert(false);
			};
		};
	}

	getDecodeQueueSize() {
		return 0;
	}

	decode(packet: EncodedPacket) {
		this.onDequeue?.();

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
			// We need to sync with the packet timestamp again
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
			timestamp: preciseTimestamp,
		});

		this.onSample(audioSample);
	}

	async flush() {
		// Do nothing
	}

	close() {
		this.isClosed = true;
	}

	get closed() {
		return this.isClosed;
	}
}

export const canDecodeVideoMemo = new Map<string, Promise<boolean>>();
export const canDecodeAudioMemo = new Map<string, Promise<boolean>>();

const validateVideoDecodingConfig = (codec: VideoCodec, options: SetOptional<VideoDecoderConfig, 'codec'>) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.codec !== undefined && typeof options.codec !== 'string') {
		throw new TypeError('options.codec, when provided, must be a string.');
	}
	if (options.codec !== undefined && inferCodecFromCodecString(options.codec) !== codec) {
		throw new TypeError(`options.codec, when provided, must match the specified codec (${codec}).`);
	}
	if (
		options.codedWidth !== undefined
		&& (!Number.isInteger(options.codedWidth) || options.codedWidth <= 0)
	) {
		throw new TypeError('options.codedWidth, when provided, must be a positive integer.');
	}
	if (
		options.codedHeight !== undefined
		&& (!Number.isInteger(options.codedHeight) || options.codedHeight <= 0)
	) {
		throw new TypeError('options.codedHeight, when provided, must be a positive integer.');
	}
	if (
		options.displayAspectWidth !== undefined
		&& (!Number.isInteger(options.displayAspectWidth) || options.displayAspectWidth <= 0)
	) {
		throw new TypeError('options.displayAspectWidth, when provided, must be a positive integer.');
	}
	if (
		options.displayAspectHeight !== undefined
		&& (!Number.isInteger(options.displayAspectHeight) || options.displayAspectHeight <= 0)
	) {
		throw new TypeError('options.displayAspectHeight, when provided, must be a positive integer.');
	}
	if (options.description !== undefined && !isAllowSharedBufferSource(options.description)) {
		throw new TypeError('options.description, when provided, must be a buffer source.');
	}
	if (
		options.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(options.hardwareAcceleration)
	) {
		throw new TypeError(
			'options.hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
			+ ' \'prefer-software\'.',
		);
	}
	if (options.optimizeForLatency !== undefined && typeof options.optimizeForLatency !== 'boolean') {
		throw new TypeError('options.optimizeForLatency, when provided, must be a boolean.');
	}
};

const validateAudioDecodingConfig = (
	codec: AudioCodec,
	options: SetOptional<AudioDecoderConfig, 'codec' | 'numberOfChannels' | 'sampleRate'>,
) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('options must be an object.');
	}
	if (options.codec !== undefined && typeof options.codec !== 'string') {
		throw new TypeError('options.codec, when provided, must be a string.');
	}
	if (options.codec !== undefined && inferCodecFromCodecString(options.codec) !== codec) {
		throw new TypeError(`options.codec, when provided, must match the specified codec (${codec}).`);
	}
	if (
		options.numberOfChannels !== undefined
		&& (!Number.isInteger(options.numberOfChannels) || options.numberOfChannels <= 0)
	) {
		throw new TypeError('options.numberOfChannels, when provided, must be a positive integer.');
	}
	if (
		options.sampleRate !== undefined
		&& (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0)
	) {
		throw new TypeError('options.sampleRate, when provided, must be a positive integer.');
	}
	if (options.description !== undefined && !isAllowSharedBufferSource(options.description)) {
		throw new TypeError('options.description, when provided, must be a buffer source.');
	}
};

/**
 * Checks if the browser is able to decode the given codec.
 * @group Decoding
 * @public
 */
export const canDecode = (codec: MediaCodec) => {
	if ((VIDEO_CODECS as readonly string[]).includes(codec)) {
		return canDecodeVideo(codec as VideoCodec);
	} else if ((AUDIO_CODECS as readonly string[]).includes(codec)) {
		return canDecodeAudio(codec as AudioCodec);
	}

	return false;
};

/**
 * Checks if the browser is able to decode the given video codec with the given parameters.
 * @group Decoding
 * @public
 */
export const canDecodeVideo = async (
	codec: VideoCodec,
	options: SetOptional<VideoDecoderConfig, 'codec'> = {},
) => {
	if (!VIDEO_CODECS.includes(codec)) {
		return false;
	}

	validateVideoDecodingConfig(codec, options);

	const resolvedOptions: VideoDecoderConfig = {
		...options,
		codedWidth: options.codedWidth ?? 1280,
		codedHeight: options.codedHeight ?? 720,
		codec: options.codec ?? buildVideoCodecString(codec, 1280, 720, 1e6, false),
	};
	resolvedOptions.description ??= guessDescriptionForVideo(resolvedOptions);

	const key = JSON.stringify(resolvedOptions);
	const memoized = canDecodeVideoMemo.get(key);
	if (memoized) {
		return memoized;
	}

	const promise = (async () => {
		if (customVideoDecoders.some(x => x.supports(codec, resolvedOptions))) {
			return true;
		}
		if (typeof VideoDecoder === 'undefined') {
			return false;
		}

		const support = await VideoDecoder.isConfigSupported(resolvedOptions);
		return support.supported === true;
	})();
	canDecodeVideoMemo.set(key, promise);

	return promise;
};

/**
 * Checks if the browser is able to decode the given audio codec with the given parameters.
 * @group Decoding
 * @public
 */
export const canDecodeAudio = async (
	codec: AudioCodec,
	options: SetOptional<AudioDecoderConfig, 'codec' | 'numberOfChannels' | 'sampleRate'> = {},
) => {
	if (!AUDIO_CODECS.includes(codec)) {
		return false;
	}

	validateAudioDecodingConfig(codec, options);

	const resolvedOptions: AudioDecoderConfig = {
		...options,
		numberOfChannels: options.numberOfChannels ?? 2,
		sampleRate: options.sampleRate ?? 48000,
		codec: options.codec ?? buildAudioCodecString(codec, 2, 48000),
	};

	if (resolvedOptions.description === undefined) {
		const generatedDescription = guessDescriptionForAudio(resolvedOptions);
		if (generatedDescription === false) {
			return false;
		}

		resolvedOptions.description = generatedDescription;
	}

	const key = JSON.stringify(resolvedOptions);
	const memoized = canDecodeAudioMemo.get(key);
	if (memoized) {
		return memoized;
	}

	const promise = (async () => {
		if (customAudioDecoders.some(x => x.supports(codec, resolvedOptions))) {
			return true;
		}
		if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
			return true;
		}
		if (typeof AudioDecoder === 'undefined') {
			return false;
		}

		const support = await AudioDecoder.isConfigSupported(resolvedOptions);
		return support.supported === true;
	})();
	canDecodeAudioMemo.set(key, promise);

	return promise;
};

/**
 * Returns the list of all media codecs that can be decoded by the browser.
 * @group Decoding
 * @public
 */
export const getDecodableCodecs = async (): Promise<MediaCodec[]> => {
	const [videoCodecs, audioCodecs] = await Promise.all([
		getDecodableVideoCodecs(),
		getDecodableAudioCodecs(),
	]);

	return [...videoCodecs, ...audioCodecs];
};

/**
 * Returns the list of all video codecs that can be decoded by the browser.
 * @group Decoding
 * @public
 */
export const getDecodableVideoCodecs = async (
	checkedCodecs: VideoCodec[] = VIDEO_CODECS as unknown as VideoCodec[],
	options?: SetOptional<VideoDecoderConfig, 'codec'>,
): Promise<VideoCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canDecodeVideo(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the list of all audio codecs that can be decoded by the browser.
 * @group Decoding
 * @public
 */
export const getDecodableAudioCodecs = async (
	checkedCodecs: AudioCodec[] = AUDIO_CODECS as unknown as AudioCodec[],
	options?: SetOptional<AudioDecoderConfig, 'codec' | 'numberOfChannels' | 'sampleRate'>,
): Promise<AudioCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canDecodeAudio(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};
