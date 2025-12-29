/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, parsePcmCodec, PCM_AUDIO_CODECS, PcmAudioCodec, VideoCodec } from './codec';
import {
	deserializeAvcDecoderConfigurationRecord,
	parseAvcSps,
	determineVideoPacketType,
	extractHevcNalUnits,
	extractNalUnitTypeForHevc,
	HevcNalUnitType,
} from './codec-data';
import { CustomAudioDecoder, customAudioDecoders, CustomVideoDecoder, customVideoDecoders } from './custom-coder';
import {
	CallSerializer,
	Rotation,
	isChromium,
	toUint8Array,
	isWebKit,
	insertSorted,
	last,
	assert,
	assertNever,
	getInt24,
	getUint24,
	toDataView,
} from './misc';
import { EncodedPacket } from './packet';
import { fromUlaw, fromAlaw } from './pcm';
import { VideoSample, AudioSample } from './sample';

export abstract class DecoderWrapper<
	MediaSample extends VideoSample | AudioSample,
> {
	constructor(
		public onSample: (sample: MediaSample) => unknown,
		public onError: (error: Error) => unknown,
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
	customDecoderCallSerializer = new CallSerializer();
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
	mergerCreationFailed = false;
	decodedAlphaChunkCount = 0;
	alphaDecoderQueueSize = 0;
	/** Each value is the number of decoded alpha chunks at which a null alpha frame should be added. */
	nullAlphaFrameQueue: number[] = [];
	currentAlphaPacketIndex = 0;
	alphaRaslSkipped = false; // For HEVC stuff

	onDequeue: (() => unknown) | null = null;

	constructor(
		onSample: (sample: VideoSample) => unknown,
		onError: (error: Error) => unknown,
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

			void this.customDecoderCallSerializer.call(() => this.customDecoder!.init());
		} else {
			const colorHandler = (frame: VideoFrame) => {
				if (this.alphaQueue.length > 0) {
					// Even when no alpha data is present (most of the time), there will be nulls in this queue
					const alphaFrame = this.alphaQueue.shift();
					assert(alphaFrame !== undefined);

					this.mergeAlpha(frame, alphaFrame);
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

			this.decoder = new VideoDecoder({
				output: (frame) => {
					try {
						colorHandler(frame);
					} catch (error) {
						this.onError(error as Error);
					}
				},
				error: onError,
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

			return Math.max(
				this.decoder.decodeQueueSize,
				this.alphaDecoder?.decodeQueueSize ?? 0,
			);
		}
	}

	decode(packet: EncodedPacket) {
		if (this.codec === 'hevc' && this.currentPacketIndex > 0 && !this.raslSkipped) {
			if (this.hasHevcRaslPicture(packet.data)) {
				return; // Drop
			}

			this.raslSkipped = true;
		}

		this.currentPacketIndex++;

		if (this.customDecoder) {
			this.customDecoderQueueSize++;
			void this.customDecoderCallSerializer
				.call(() => this.customDecoder!.decode(packet))
				.then(() => {
					this.customDecoderQueueSize--;
					this.onDequeue?.();
				});
		} else {
			assert(this.decoder);

			if (!isWebKit()) {
				insertSorted(this.inputTimestamps, packet.timestamp, x => x);
			}

			this.decoder.decode(packet.toEncodedVideoChunk());
			this.decodeAlphaData(packet);
		}
	}

	decodeAlphaData(packet: EncodedPacket) {
		if (!packet.sideData.alpha || this.mergerCreationFailed) {
			// No alpha side data in the packet, most common case
			this.pushNullAlphaFrame();
			return;
		}

		if (!this.merger) {
			try {
				this.merger = new ColorAlphaMerger();
			} catch (error) {
				console.error('Due to an error, only color data will be decoded.', error);

				this.mergerCreationFailed = true;
				this.decodeAlphaData(packet); // Go again

				return;
			}
		}

		// Check if we need to set up the alpha decoder
		if (!this.alphaDecoder) {
			const alphaHandler = (frame: VideoFrame) => {
				this.alphaDecoderQueueSize--;

				if (this.colorQueue.length > 0) {
					const colorFrame = this.colorQueue.shift();
					assert(colorFrame !== undefined);

					this.mergeAlpha(colorFrame, frame);
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

						this.mergeAlpha(colorFrame, null);
					} else {
						this.alphaQueue.push(null);
					}
				}
			};

			this.alphaDecoder = new VideoDecoder({
				output: (frame) => {
					try {
						alphaHandler(frame);
					} catch (error) {
						this.onError(error as Error);
					}
				},
				error: this.onError,
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
		const nalUnits = extractHevcNalUnits(packetData, this.decoderConfig);
		return nalUnits.some((x) => {
			const type = extractNalUnitTypeForHevc(x);
			return type === HevcNalUnitType.RASL_N || type === HevcNalUnitType.RASL_R;
		});
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

	mergeAlpha(color: VideoFrame, alpha: VideoFrame | null) {
		if (!alpha) {
			// Nothing needs to be merged
			this.frameHandler(color);
			return;
		}

		assert(this.merger);

		this.merger.update(color, alpha);
		color.close();
		alpha.close();

		const finalFrame = new VideoFrame(this.merger.canvas, {
			timestamp: color.timestamp,
			duration: color.duration ?? undefined,
		});
		this.frameHandler(finalFrame);
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

/** Utility class that merges together color and alpha information using simple WebGL 2 shaders. */
class ColorAlphaMerger {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	private gl: WebGL2RenderingContext;
	private program: WebGLProgram;
	private vao: WebGLVertexArrayObject;
	private colorTexture: WebGLTexture;
	private alphaTexture: WebGLTexture;

	constructor() {
		// Canvas will be resized later
		if (typeof OffscreenCanvas !== 'undefined') {
			// Prefer OffscreenCanvas for Worker environments
			this.canvas = new OffscreenCanvas(300, 150);
		} else {
			this.canvas = document.createElement('canvas');
		}

		const gl = this.canvas.getContext('webgl2', {
			premultipliedAlpha: false,
		}) as unknown as WebGL2RenderingContext | null; // Casting because of some TypeScript weirdness
		if (!gl) {
			throw new Error('Couldn\'t acquire WebGL 2 context.');
		}

		this.gl = gl;
		this.program = this.createProgram();
		this.vao = this.createVAO();
		this.colorTexture = this.createTexture();
		this.alphaTexture = this.createTexture();

		this.gl.useProgram(this.program);
		this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_colorTexture'), 0);
		this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_alphaTexture'), 1);
	}

	private createProgram(): WebGLProgram {
		const vertexShader = this.createShader(this.gl.VERTEX_SHADER, `#version 300 es
			in vec2 a_position;
			in vec2 a_texCoord;
			out vec2 v_texCoord;
			
			void main() {
				gl_Position = vec4(a_position, 0.0, 1.0);
				v_texCoord = a_texCoord;
			}
		`);

		const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, `#version 300 es
			precision highp float;
			
			uniform sampler2D u_colorTexture;
			uniform sampler2D u_alphaTexture;
			in vec2 v_texCoord;
			out vec4 fragColor;
			
			void main() {
				vec3 color = texture(u_colorTexture, v_texCoord).rgb;
				float alpha = texture(u_alphaTexture, v_texCoord).r;
				fragColor = vec4(color, alpha);
			}
		`);

		const program = this.gl.createProgram();
		this.gl.attachShader(program, vertexShader);
		this.gl.attachShader(program, fragmentShader);
		this.gl.linkProgram(program);

		return program;
	}

	private createShader(type: number, source: string): WebGLShader {
		const shader = this.gl.createShader(type)!;
		this.gl.shaderSource(shader, source);
		this.gl.compileShader(shader);
		return shader;
	}

	private createVAO(): WebGLVertexArrayObject {
		const vao = this.gl.createVertexArray();
		this.gl.bindVertexArray(vao);

		const vertices = new Float32Array([
			-1, -1, 0, 1,
			1, -1, 1, 1,
			-1, 1, 0, 0,
			1, 1, 1, 0,
		]);

		const buffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);

		const positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
		const texCoordLocation = this.gl.getAttribLocation(this.program, 'a_texCoord');

		this.gl.enableVertexAttribArray(positionLocation);
		this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 16, 0);

		this.gl.enableVertexAttribArray(texCoordLocation);
		this.gl.vertexAttribPointer(texCoordLocation, 2, this.gl.FLOAT, false, 16, 8);

		return vao;
	}

	private createTexture(): WebGLTexture {
		const texture = this.gl.createTexture();

		this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);

		return texture;
	}

	update(color: VideoFrame, alpha: VideoFrame): void {
		if (color.displayWidth !== this.canvas.width || color.displayHeight !== this.canvas.height) {
			this.canvas.width = color.displayWidth;
			this.canvas.height = color.displayHeight;
		}

		this.gl.activeTexture(this.gl.TEXTURE0);
		this.gl.bindTexture(this.gl.TEXTURE_2D, this.colorTexture);
		this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, color);

		this.gl.activeTexture(this.gl.TEXTURE1);
		this.gl.bindTexture(this.gl.TEXTURE_2D, this.alphaTexture);
		this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, alpha);

		this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		this.gl.clear(this.gl.COLOR_BUFFER_BIT);

		this.gl.bindVertexArray(this.vao);
		this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
	}

	close() {
		this.gl.getExtension('WEBGL_lose_context')?.loseContext();
		this.gl = null as unknown as WebGL2RenderingContext;
	}
}

export class AudioDecoderWrapper extends DecoderWrapper<AudioSample> {
	decoder: AudioDecoder | null = null;

	customDecoder: CustomAudioDecoder | null = null;
	customDecoderCallSerializer = new CallSerializer();
	customDecoderQueueSize = 0;
	customDecoderClosed = false;

	// Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
	// inaccurate) packet timestamps.
	currentTimestamp: number | null = null;

	onDequeue: (() => unknown) | null = null;

	constructor(
		onSample: (sample: AudioSample) => unknown,
		onError: (error: Error) => unknown,
		codec: AudioCodec,
		decoderConfig: AudioDecoderConfig,
	) {
		super(onSample, onError);

		const sampleHandler = (sample: AudioSample) => {
			if (
				this.currentTimestamp === null
				|| Math.abs(sample.timestamp - this.currentTimestamp) >= sample.duration
			) {
				// We need to sync with the sample timestamp again
				this.currentTimestamp = sample.timestamp;
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

			void this.customDecoderCallSerializer.call(() => this.customDecoder!.init());
		} else {
			this.decoder = new AudioDecoder({
				output: (data) => {
					try {
						sampleHandler(new AudioSample(data));
					} catch (error) {
						this.onError(error as Error);
					}
				},
				error: onError,
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
				.then(() => {
					this.customDecoderQueueSize--;
					this.onDequeue?.();
				});
		} else {
			assert(this.decoder);
			this.decoder.decode(packet.toEncodedAudioChunk());
		}
	}

	flush() {
		if (this.customDecoder) {
			return this.customDecoderCallSerializer.call(() => this.customDecoder!.flush());
		} else {
			assert(this.decoder);
			return this.decoder.flush();
		}
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
		onError: (error: Error) => unknown,
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
