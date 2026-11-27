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
	MediaCodec,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import {
	assert,
	assertNever,
	AsyncMutex,
	clearIntervalUnthrottled,
	createWorker,
	isThenable,
	promiseWithResolvers,
	setIntervalUnthrottled,
	UnthrottledTimerHandle,
} from './misc';
import { SubtitleParser } from './subtitles';
import { EncodedPacket } from './packet';
import { AudioSample, VideoSample } from './sample';
import {
	AudioEncodingConfig,
	AudioSampleEncoder,
	AudioSampleEncoderOptions,
	validateAudioEncodingConfig,
	validateVideoEncodingConfig,
	VideoEncodingConfig,
	VideoSampleEncoder,
	VideoSampleEncoderOptions,
} from './encode';
import { Logging } from './logging';

/**
 * Base class for media sources. Media sources are used to add media samples to an output file.
 * @group Media sources
 * @public
 */
export abstract class MediaSource {
	/** @internal */
	abstract readonly _codec: MediaCodec;
	/** @internal */
	_connectedTrack: OutputTrack | null = null;
	/** @internal */
	_closingPromise: Promise<void> | null = null;
	/**
	 * Set when the encoder is configured with a bitrate.
	 * @internal
	 */
	_nominalBitrate: number | null = null;

	/** @internal */
	_ensureValidAdd() {
		if (!this._connectedTrack) {
			throw new Error('Source is not connected to an output track.');
		}

		if (this._connectedTrack.output.state === 'canceled') {
			throw new Error('Output has been canceled.');
		}

		if (this._connectedTrack.output.state === 'finalizing' || this._connectedTrack.output.state === 'finalized') {
			throw new Error('Output has been finalized.');
		}

		if (this._connectedTrack.output.state === 'pending') {
			throw new Error('Output has not started.');
		}

		if (this._closingPromise) {
			throw new Error('Source is closed.');
		}
	}

	/** @internal */
	async _start() {}
	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async _flushAndClose(forceClose: boolean) {}

	/**
	 * Closes this source. This prevents future samples from being added and signals to the output file that no further
	 * samples will come in for this track. Calling `.close()` is optional but recommended after adding the
	 * last sample - for improved performance and reduced memory usage.
	 */
	close() {
		if (this._closingPromise) {
			return;
		}

		const connectedTrack = this._connectedTrack;

		if (!connectedTrack) {
			throw new Error('Cannot call close without connecting the source to an output track.');
		}

		if (connectedTrack.output.state === 'pending') {
			throw new Error('Cannot call close before output has been started.');
		}

		this._closingPromise = (async () => {
			await this._flushAndClose(false);

			if (connectedTrack.output.state === 'finalizing' || connectedTrack.output.state === 'finalized') {
				return;
			}

			await connectedTrack.output._muxer.onTrackClose(connectedTrack);
		})();

		this._closingPromise.catch(() => {});
	}

	/** @internal */
	async _flushOrWaitForOngoingClose(forceClose: boolean) {
		return this._closingPromise ??= this._flushAndClose(forceClose);
	}
}

/**
 * Base class for video sources - sources for video tracks.
 * @group Media sources
 * @public
 */
export abstract class VideoSource extends MediaSource {
	/** @internal */
	declare _connectedTrack: OutputVideoTrack | null;
	/** @internal */
	override readonly _codec: VideoCodec;

	/** Internal constructor. */
	constructor(codec: VideoCodec) {
		super();

		if (!VIDEO_CODECS.includes(codec)) {
			throw new TypeError(`Invalid video codec '${codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
		}

		this._codec = codec;
	}
}

const maybeEnsureIsKeyPacket = (track: OutputVideoTrack, packet: EncodedPacket) => {
	if (track.metadata.hasOnlyKeyPackets && packet.type !== 'key') {
		throw new Error('Cannot add non-key packets to a hasOnlyKeyPackets video track.');
	}
};

/**
 * The most basic video source; can be used to directly pipe encoded packets into the output file.
 * @group Media sources
 * @public
 */
export class EncodedVideoPacketSource extends VideoSource {
	/** Creates a new {@link EncodedVideoPacketSource} whose packets are encoded using `codec`. */
	constructor(codec: VideoCodec) {
		super(codec);
	}

	/**
	 * Adds an encoded packet to the output video track. Packets must be added in *decode order*, while a packet's
	 * timestamp must be its *presentation timestamp*. B-frames are handled automatically.
	 *
	 * The first packet must have a decoder config, either its own or one passed in `meta`.
	 *
	 * @param meta - Additional metadata from the encoder. Its decoder config, if any, takes precedence over the
	 * packet's decoder config.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		if (packet.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be added.');
		}
		if (meta !== undefined && (!meta || typeof meta !== 'object')) {
			throw new TypeError('meta, when provided, must be an object.');
		}
		if (meta?.decoderConfig !== undefined && (!meta.decoderConfig || typeof meta.decoderConfig !== 'object')) {
			throw new TypeError('meta.decoderConfig, when provided, must be an object.');
		}

		this._ensureValidAdd();

		if (meta?.decoderConfig) {
			packet = packet.clone({
				decoderConfig: {
					...meta.decoderConfig,
					type: 'video',
				},
			});
		}

		maybeEnsureIsKeyPacket(this._connectedTrack!, packet);
		return this._connectedTrack!.output._muxer.addEncodedVideoPacket(this._connectedTrack!, packet);
	}
}

class SampleEncoderPump<Encoder extends VideoSampleEncoder | AudioSampleEncoder> {
	encoder: Encoder | null = null;
	pumpPromise: Promise<void> | null = null;
	error: unknown = null;
	errorSet = false;

	constructor(public source: VideoSource | AudioSource, public createEncoder: () => Encoder) {}

	async add(push: (encoder: Encoder) => Promise<void> | null) {
		this.checkForError();

		if (!this.encoder) {
			this.encoder = this.createEncoder();
			this.pumpPromise = this.run(this.encoder);
		} else if (!this.encoder.pushable) {
			// The encoder errored, and the pump gets the error out of it
			await this.pumpPromise;
			this.checkForError();
		}

		const backpressure = push(this.encoder);
		if (backpressure) {
			await backpressure;
			this.checkForError();
		}
	}

	async flushAndClose(forceClose: boolean) {
		if (!this.encoder) {
			return;
		}

		if (forceClose) {
			this.encoder.close();
			return;
		}

		this.checkForError();
		const finished = this.encoder.end();

		await this.pumpPromise;
		await finished;
		this.checkForError();
	}

	async run(encoder: Encoder) {
		const track = this.source._connectedTrack;
		assert(track);

		try {
			while (true) {
				let packet = encoder.pull();
				if (isThenable(packet)) {
					packet = await packet;
				}

				if (!packet) {
					if (!encoder.pullable) {
						break;
					}

					continue;
				}

				if (track.type === 'video') {
					maybeEnsureIsKeyPacket(track, packet);
					await track.output._muxer.addEncodedVideoPacket(track, packet);
				} else {
					await track.output._muxer.addEncodedAudioPacket(track, packet);
				}
			}
		} catch (error) {
			if (!this.errorSet) {
				this.error = error;
				this.errorSet = true;
			}

			encoder.close();
		}
	}

	checkForError() {
		if (this.errorSet) {
			throw this.error;
		}
	}
}

/**
 * This source can be used to add raw, unencoded video samples (frames) to an output video track. These frames will
 * automatically be encoded and then piped into the output.
 * @group Media sources
 * @public
 */
export class VideoSampleSource extends VideoSource {
	/** @internal */
	private _pump: SampleEncoderPump<VideoSampleEncoder>;

	/**
	 * Creates a new {@link VideoSampleSource} whose samples are encoded according to the specified
	 * {@link VideoEncodingConfig}.
	 */
	constructor(encodingConfig: VideoEncodingConfig) {
		validateVideoEncodingConfig(encodingConfig);

		super(encodingConfig.codec);
		this._pump = new SampleEncoderPump(this, () => createVideoSampleEncoder(this, encodingConfig));
	}

	/**
	 * Encodes a video sample (frame) and then adds it to the output.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(videoSample: VideoSample, encodeOptions?: VideoEncoderEncodeOptions) {
		if (!(videoSample instanceof VideoSample)) {
			throw new TypeError('videoSample must be a VideoSample.');
		}

		this._ensureValidAdd();

		return this._pump.add(encoder => encoder.push(videoSample, encodeOptions));
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._pump.flushAndClose(forceClose);
	}
}

/**
 * This source can be used to add video frames to the output track from a fixed canvas element. Since canvases are often
 * used for rendering, this source provides a convenient wrapper around {@link VideoSampleSource}.
 * @group Media sources
 * @public
 */
export class CanvasSource extends VideoSource {
	/** @internal */
	private _pump: SampleEncoderPump<VideoSampleEncoder>;
	/** @internal */
	private _canvas: HTMLCanvasElement | OffscreenCanvas;

	/**
	 * Creates a new {@link CanvasSource} from a canvas element or `OffscreenCanvas` whose samples are encoded
	 * according to the specified {@link VideoEncodingConfig}.
	 */
	constructor(canvas: HTMLCanvasElement | OffscreenCanvas, encodingConfig: VideoEncodingConfig) {
		if (
			!(typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)
			&& !(typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas)
		) {
			throw new TypeError('canvas must be an HTMLCanvasElement or OffscreenCanvas.');
		}
		validateVideoEncodingConfig(encodingConfig);

		super(encodingConfig.codec);
		this._pump = new SampleEncoderPump(this, () => createVideoSampleEncoder(this, encodingConfig));
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
	add(timestamp: number, duration = 0, encodeOptions?: VideoEncoderEncodeOptions) {
		if (!Number.isFinite(timestamp)) {
			throw new TypeError('timestamp must be a finite number.');
		}
		if (!Number.isFinite(duration) || duration < 0) {
			throw new TypeError('duration must be a non-negative number.');
		}

		this._ensureValidAdd();

		const sample = new VideoSample(this._canvas, { timestamp, duration });
		const promise = this._pump.add(encoder => encoder.push(sample, encodeOptions));
		sample.close();

		return promise;
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._pump.flushAndClose(forceClose);
	}
}

/**
 * Options for {@link MediaStreamVideoTrackSource}.
 * @group Media sources
 * @public
 */
export type MediaStreamVideoTrackSourceOptions = {
	/**
	 * The frame rate at which the underlying video track is sampled. Defaults to the frame rate specified in the
	 * track's [`MediaTrackSettings`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings). Set to
	 * `null` to only add a frame whenever the underlying track pushes one - this minimizes frame count but can
	 * lead to wildly irregular FPS.
	 */
	frameRate?: number | null;
	/**
	 * Controls the basis (zero point) for video frame timestamps.
	 *
	 * When set to `'synced-zero'`, timestamps will be relative to the first chunk of media from a `MediaStreamTrack`
	 * added to the {@link Output}.
	 *
	 * When set to `'zero'`, timestamps will be relative to the first video frame emitted by this source.
	 *
	 * When set to `'unix'`, timestamps will be relative to the Unix epoch, so clearly associated with a distinct point
	 * in time. Here, pausing via {@link MediaStreamVideoTrackSource.pause} will also create gaps in timestamps. Be sure
	 * to pair this mode with {@link BaseTrackMetadata.isRelativeToUnixEpoch}.
	 *
	 * Defaults to `'synced-zero'`.
	 */
	timestampBase?: 'synced-zero' | 'zero' | 'unix';
};

/**
 * Video source that encodes the frames of a
 * [`MediaStreamVideoTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack) and pipes them into the
 * output. This is useful for capturing live or real-time data such as webcams or screen captures. Frames will
 * automatically start being captured once the connected {@link Output} is started, and will keep being captured until
 * the {@link Output} is finalized or this source is closed.
 * @group Media sources
 * @public
 */
export class MediaStreamVideoTrackSource extends VideoSource {
	/** @internal */
	private _options: MediaStreamVideoTrackSourceOptions;
	/** @internal */
	private _pump: SampleEncoderPump<VideoSampleEncoder>;
	/** @internal */
	private _abortController: AbortController | null = null;
	/** @internal */
	private _track: MediaStreamVideoTrack;
	/** @internal */
	private _workerTrackId: number | null = null;
	/** @internal */
	private _workerListener: ((event: MessageEvent) => void) | null = null;
	/** @internal */
	private _promiseWithResolvers = promiseWithResolvers();
	/** @internal */
	private _errorPromiseAccessed = false;
	/** @internal */
	private _paused = false;
	/** @internal */
	private _lastVideoFrame: VideoFrame | null = null;
	/** @internal */
	private _timerHandle: UnthrottledTimerHandle | null = null;
	/** @internal */
	private _videoElement: HTMLVideoElement | null = null;

	/** A promise that rejects upon any error within this source. This promise never resolves. */
	get errorPromise() {
		this._errorPromiseAccessed = true;
		return this._promiseWithResolvers.promise;
	}

	/** Whether this source is currently paused as a result of calling `.pause()`. */
	get paused() {
		return this._paused;
	}

	/**
	 * Creates a new {@link MediaStreamVideoTrackSource} from a
	 * [`MediaStreamVideoTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack), which will pull
	 * video samples from the stream in real time and encode them according to {@link VideoEncodingConfig}.
	 */
	constructor(
		track: MediaStreamVideoTrack,
		encodingConfig: VideoEncodingConfig,
		options: MediaStreamVideoTrackSourceOptions = {},
	) {
		if (!(track instanceof MediaStreamTrack) || track.kind !== 'video') {
			throw new TypeError('track must be a video MediaStreamTrack.');
		}
		validateVideoEncodingConfig(encodingConfig);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.frameRate != null && (!Number.isFinite(options.frameRate) || options.frameRate <= 0)) {
			throw new TypeError('options.frameRate, when provided, must be either a finite positive number or null.');
		}
		if (
			options.timestampBase !== undefined
			&& options.timestampBase !== 'synced-zero'
			&& options.timestampBase !== 'zero'
			&& options.timestampBase !== 'unix'
		) {
			throw new TypeError(
				'options.timestampBase, when provided, must be one of \'synced-zero\', \'zero\', or \'unix\'.',
			);
		}

		super(encodingConfig.codec);

		this._options = options;
		this._pump = new SampleEncoderPump(this, () => createVideoSampleEncoder(this, {
			...encodingConfig,
			latencyMode: 'realtime',
			highWaterMark: 8,
		}));
		this._track = track;
	}

	/** @internal */
	override async _start() {
		if (!this._errorPromiseAccessed) {
			Logging._warn(
				'Make sure not to ignore the `errorPromise` field on MediaStreamVideoTrackSource, so that any internal'
				+ ' errors get bubbled up properly.',
			);
		}

		const frameRate = this._options.frameRate !== undefined
			? this._options.frameRate
			: (this._track.getSettings().frameRate ?? null);

		this._abortController = new AbortController();

		let firstVideoFrameTimestamp: number | null = null;
		let firstReceivedFrameTimestamp: number | null = null; // Also set when the frame is dropped due to a pause
		let lastFrameTime: number | null = null;
		let frameCount = 0;
		let errored = false;
		let lastSampleTimestamp: number | null = null;
		let timestampOffset = 0;
		let addIsPending = false;

		const tick = () => {
			assert(frameRate !== null);

			if (!this._lastVideoFrame) {
				return;
			}

			assert(lastFrameTime !== null);
			assert(firstReceivedFrameTimestamp !== null);

			const now = performance.now();

			// Add as many frames as warranted by the elapsed time.
			// > instead of >= intentionally because tick() is called before the _lastVideoFrame is changed
			while (now - lastFrameTime > 1000 / frameRate) {
				lastFrameTime += 1000 / frameRate;
				const timestamp = firstReceivedFrameTimestamp + frameCount / frameRate;

				const frame = new VideoFrame(this._videoElement ?? this._lastVideoFrame, {
					timestamp: 1e6 * timestamp,
					duration: 1e6 / frameRate,
				});

				addVideoFrame(frame, now);
			}
		};

		if (frameRate !== null) {
			this._timerHandle = setIntervalUnthrottled(tick, 4); // Run it at 250 Hz
		}

		const onVideoFrame = (videoFrame: VideoFrame) => {
			if (this._closingPromise) {
				videoFrame.close();
				return;
			}

			if (frameRate === null) {
				addVideoFrame(videoFrame);
			} else {
				const now = performance.now();

				if (!this._lastVideoFrame) {
					firstReceivedFrameTimestamp = videoFrame.timestamp / 1e6;
					addVideoFrame(videoFrame.clone(), now);
					lastFrameTime = now;
					this._lastVideoFrame = videoFrame;
				} else {
					tick();
					this._lastVideoFrame?.close();
					this._lastVideoFrame = videoFrame;
				}
			}
		};

		const addVideoFrame = (videoFrame: VideoFrame, now = performance.now()) => {
			if (errored || this._closingPromise || this._connectedTrack!.output.state !== 'started') {
				videoFrame.close();
				return;
			}

			frameCount++;
			const currentTimestamp = videoFrame.timestamp / 1e6;

			if (this._paused) {
				const frameSeen = firstVideoFrameTimestamp !== null;
				if (frameSeen) {
					if (lastSampleTimestamp !== null && this._options.timestampBase !== 'unix') {
						// In addition to dropping this frame, let's also keep track of the time we have lost due to the
						// pause. Doing it like this instead of simply keeping track of the paused time is better since
						// it retains the frame rate of the underlying source.
						const timeDelta = currentTimestamp - lastSampleTimestamp;
						timestampOffset -= timeDelta;
					}
					lastSampleTimestamp = currentTimestamp;
				}

				videoFrame.close();
				return;
			}

			if (firstVideoFrameTimestamp === null) {
				firstVideoFrameTimestamp = currentTimestamp;

				let target: number;
				const timestampBase = this._options.timestampBase ?? 'synced-zero';
				if (timestampBase === 'unix') {
					target = Date.now() / 1000;
				} else if (timestampBase === 'zero') {
					target = 0;
				} else {
					const output = this._connectedTrack!.output;
					if (output._firstMediaStreamTimestamp === null) {
						output._firstMediaStreamTimestamp = now / 1000;
						target = 0;
					} else {
						target = now / 1000 - output._firstMediaStreamTimestamp;
					}
				}

				timestampOffset = target - firstVideoFrameTimestamp;
			}

			lastSampleTimestamp = currentTimestamp;

			if (addIsPending) {
				// Drop frames while the encoder applies backpressure
				videoFrame.close();
				return;
			}

			const sample = new VideoSample(videoFrame, {
				timestamp: currentTimestamp + timestampOffset,
			});

			addIsPending = true;
			const promise = this._pump.add(encoder => encoder.push(sample));
			sample.close();

			void promise
				.then(() => {
					addIsPending = false;
				})
				.catch((error) => {
					errored = true;

					this._abortController?.abort();
					this._promiseWithResolvers.reject(error);

					if (this._workerTrackId !== null) {
						// Tell the worker to stop the track
						sendMessageToMediaStreamTrackProcessorWorker({
							type: 'stopTrack',
							trackId: this._workerTrackId,
						});
					}
				});
		};

		if (typeof MediaStreamTrackProcessor !== 'undefined') {
			// We can do it here directly, perfect
			const processor = new MediaStreamTrackProcessor({ track: this._track });
			const consumer = new WritableStream<VideoFrame>({ write: onVideoFrame });

			processor.readable.pipeTo(consumer, {
				signal: this._abortController.signal,
			}).catch((error) => {
				// Handle AbortError silently
				if (error instanceof DOMException && error.name === 'AbortError') return;

				this._promiseWithResolvers.reject(error);
			});
		} else {
			// It might still be supported in a worker, so let's check that
			const supportedInWorker = await mediaStreamTrackProcessorIsSupportedInWorker();

			if (supportedInWorker) {
				this._workerTrackId = nextMediaStreamTrackProcessorWorkerId++;

				// Tracks can't be copied, only transferred, but transferring naively would kill the user's own track
				const track = this._track.clone();
				sendMessageToMediaStreamTrackProcessorWorker({
					type: 'videoTrack',
					trackId: this._workerTrackId,
					track,
				}, [track as unknown as Transferable]);

				this._workerListener = (event: MessageEvent) => {
					const message = event.data as MediaStreamTrackProcessorWorkerMessage;

					if (message.type === 'videoFrame' && message.trackId === this._workerTrackId) {
						onVideoFrame(message.videoFrame);
					} else if (message.type === 'error' && message.trackId === this._workerTrackId) {
						this._promiseWithResolvers.reject(message.error);
					}
				};

				mediaStreamTrackProcessorWorker!.addEventListener('message', this._workerListener);
			} else if (frameRate !== null) {
				// No MediaStreamTrackProcessor support at all (e.g. Firefox), but we have a frame rate, so we can
				// manually sample from a hidden <video> element instead.
				const video = document.createElement('video');
				video.style.position = 'fixed';
				video.style.left = '-10000px';
				video.style.top = '-10000px';
				video.style.width = '1px';
				video.style.height = '1px';
				video.style.opacity = '0';
				video.style.pointerEvents = 'none';
				video.muted = true;
				video.srcObject = new MediaStream([this._track]);
				document.body.appendChild(video);
				this._videoElement = video;

				video.addEventListener('loadeddata', () => {
					if (errored || !this._videoElement) {
						return;
					}

					// This will be the first frame
					const frame = new VideoFrame(video, {
						timestamp: 1000 * performance.now(),
					});
					onVideoFrame(frame);
					frame.close();
				}, { once: true });

				void video.play().catch((error) => {
					errored = true;
					this._promiseWithResolvers.reject(error);
				});
			} else {
				throw new Error(
					'When no explicit frame rate is set, MediaStreamTrackProcessor is required; but it\'s not available'
					+ ' in this environment.',
				);
			}
		}
	}

	/**
	 * Pauses the capture of video frames - any video frames emitted by the underlying media stream will be ignored
	 * while paused. This does *not* close the underlying `MediaStreamVideoTrack`, it just ignores its output.
	 */
	pause() {
		this._paused = true;
	}

	/** Resumes the capture of video frames after being paused. */
	resume() {
		this._paused = false;
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		try {
			if (this._abortController) {
				this._abortController.abort();
				this._abortController = null;
			}

			if (this._timerHandle) {
				clearIntervalUnthrottled(this._timerHandle);
			}
			this._lastVideoFrame?.close();

			if (this._videoElement) {
				this._videoElement.srcObject = null;
				this._videoElement.remove();
				this._videoElement = null;
			}

			if (this._workerTrackId !== null) {
				assert(this._workerListener);

				sendMessageToMediaStreamTrackProcessorWorker({
					type: 'stopTrack',
					trackId: this._workerTrackId,
				});

				// Wait for the worker to stop the track
				await new Promise<void>((resolve) => {
					const listener = (event: MessageEvent) => {
						const message = event.data as MediaStreamTrackProcessorWorkerMessage;

						if (message.type === 'trackStopped' && message.trackId === this._workerTrackId) {
							assert(this._workerListener);
							mediaStreamTrackProcessorWorker!.removeEventListener('message', this._workerListener);
							mediaStreamTrackProcessorWorker!.removeEventListener('message', listener);

							resolve();
						}
					};

					mediaStreamTrackProcessorWorker!.addEventListener('message', listener);
				});
			}
		} finally {
			// The encoder must be closed even if the track teardown above threw
			await this._pump.flushAndClose(forceClose);
		}
	}
}

const createVideoSampleEncoder = (source: VideoSource, options: VideoSampleEncoderOptions) => {
	const track = source._connectedTrack;
	assert(track);

	return new VideoSampleEncoder({
		...options,
		frameRateHint: options.frameRateHint ?? track.metadata.frameRate,
		onEncoderConfig: (encoderConfig) => {
			source._nominalBitrate = encoderConfig.bitrateMode === 'quantizer' ? null : encoderConfig.bitrate ?? null;
			options.onEncoderConfig?.(encoderConfig);
		},
	});
};

/**
 * Base class for audio sources - sources for audio tracks.
 * @group Media sources
 * @public
 */
export abstract class AudioSource extends MediaSource {
	/** @internal */
	declare _connectedTrack: OutputAudioTrack | null;
	/** @internal */
	override readonly _codec: AudioCodec;

	/** Internal constructor. */
	constructor(codec: AudioCodec) {
		super();

		if (!AUDIO_CODECS.includes(codec)) {
			throw new TypeError(`Invalid audio codec '${codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
		}

		this._codec = codec;
	}
}

/**
 * The most basic audio source; can be used to directly pipe encoded packets into the output file.
 * @group Media sources
 * @public
 */
export class EncodedAudioPacketSource extends AudioSource {
	/** Creates a new {@link EncodedAudioPacketSource} whose packets are encoded using `codec`. */
	constructor(codec: AudioCodec) {
		super(codec);
	}

	/**
	 * Adds an encoded packet to the output audio track. Packets must be added in *decode order*. The first packet must
	 * have a decoder config, either its own or one passed in `meta`.
	 *
	 * @param meta - Additional metadata from the encoder. Its decoder config, if any, takes precedence over the
	 * packet's decoder config.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		if (!(packet instanceof EncodedPacket)) {
			throw new TypeError('packet must be an EncodedPacket.');
		}
		if (packet.isMetadataOnly) {
			throw new TypeError('Metadata-only packets cannot be added.');
		}
		if (meta !== undefined && (!meta || typeof meta !== 'object')) {
			throw new TypeError('meta, when provided, must be an object.');
		}
		if (meta?.decoderConfig !== undefined && (!meta.decoderConfig || typeof meta.decoderConfig !== 'object')) {
			throw new TypeError('meta.decoderConfig, when provided, must be an object.');
		}

		this._ensureValidAdd();

		if (meta?.decoderConfig) {
			packet = packet.clone({
				decoderConfig: {
					...meta.decoderConfig,
					type: 'audio',
				},
			});
		}

		return this._connectedTrack!.output._muxer.addEncodedAudioPacket(this._connectedTrack!, packet);
	}
}

/**
 * This source can be used to add raw, unencoded audio samples to an output audio track. These samples will
 * automatically be encoded and then piped into the output.
 * @group Media sources
 * @public
 */
export class AudioSampleSource extends AudioSource {
	/** @internal */
	private _pump: SampleEncoderPump<AudioSampleEncoder>;

	/**
	 * Creates a new {@link AudioSampleSource} whose samples are encoded according to the specified
	 * {@link AudioEncodingConfig}.
	 */
	constructor(encodingConfig: AudioEncodingConfig) {
		validateAudioEncodingConfig(encodingConfig);

		super(encodingConfig.codec);
		this._pump = new SampleEncoderPump(this, () => createAudioSampleEncoder(this, encodingConfig));
	}

	/**
	 * Encodes an audio sample and then adds it to the output.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(audioSample: AudioSample) {
		if (!(audioSample instanceof AudioSample)) {
			throw new TypeError('audioSample must be an AudioSample.');
		}

		this._ensureValidAdd();

		return this._pump.add(encoder => encoder.push(audioSample));
	}

	/** @internal */
	override _flushAndClose(forceClose: boolean) {
		return this._pump.flushAndClose(forceClose);
	}
}

/**
 * Options for {@link AudioBufferSource}.
 * @group Media sources
 * @public
 */
export type AudioBufferSourceOptions = {
	/**
	 * The timestamp of the first `AudioBuffer`, in seconds. Subsequent buffers are placed directly after the previous
	 * one. Defaults to 0.
	 */
	startTimestamp?: number;
};

/**
 * This source can be used to add audio data from an AudioBuffer to the output track. This is useful when working with
 * the Web Audio API.
 * @group Media sources
 * @public
 */
export class AudioBufferSource extends AudioSource {
	/** @internal */
	private _pump: SampleEncoderPump<AudioSampleEncoder>;
	/** @internal */
	private _accumulatedTime: number;
	/** @internal */
	private _addMutex = new AsyncMutex();

	/**
	 * Creates a new {@link AudioBufferSource} whose `AudioBuffer` instances are encoded according to the specified
	 * {@link AudioEncodingConfig} and {@link AudioBufferSourceOptions}.
	 */
	constructor(encodingConfig: AudioEncodingConfig, options: AudioBufferSourceOptions = {}) {
		validateAudioEncodingConfig(encodingConfig);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (options.startTimestamp !== undefined && !Number.isFinite(options.startTimestamp)) {
			throw new TypeError('options.startTimestamp, when provided, must be a finite number.');
		}

		super(encodingConfig.codec);
		this._pump = new SampleEncoderPump(this, () => createAudioSampleEncoder(this, encodingConfig));
		this._accumulatedTime = options.startTimestamp ?? 0;
	}

	/**
	 * Converts an AudioBuffer to audio samples, encodes them and adds them to the output. The first `AudioBuffer` will
	 * be played at the configured start timestamp (the default is 0), and each subsequent `AudioBuffer` will be placed
	 * directly after the previous one.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	async add(audioBuffer: AudioBuffer) {
		if (!(audioBuffer instanceof AudioBuffer)) {
			throw new TypeError('audioBuffer must be an AudioBuffer.');
		}

		this._ensureValidAdd();

		const iterator = AudioSample._fromAudioBuffer(audioBuffer, this._accumulatedTime);
		this._accumulatedTime += audioBuffer.duration;

		// The buffer goes in as several samples, so overlapping adds must not interleave theirs
		const release = await this._addMutex.acquire();
		try {
			for (const audioSample of iterator) {
				const promise = this._pump.add(encoder => encoder.push(audioSample));
				audioSample.close();

				await promise;
			}
		} finally {
			release();
		}
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		if (!forceClose) {
			// Buffers added before closing still belong in the file
			const release = await this._addMutex.acquire();
			release();
		}

		return this._pump.flushAndClose(forceClose);
	}
}

/**
 * Options for {@link MediaStreamAudioTrackSource}.
 * @group Media sources
 * @public
 */
export type MediaStreamAudioTrackSourceOptions = {
	/**
	 * Controls the basis (zero point) for audio sample timestamps.
	 *
	 * When set to `'synced-zero'`, timestamps will be relative to the first chunk of media from a `MediaStreamTrack`
	 * added to the {@link Output}.
	 *
	 * When set to `'zero'`, timestamps will be relative to the first audio sample emitted by this source.
	 *
	 * When set to `'unix'`, timestamps will be relative to the Unix epoch, so clearly associated with a distinct point
	 * in time. Here, pausing via {@link MediaStreamAudioTrackSource.pause} will also create gaps in timestamps. Be sure
	 * to pair this mode with {@link BaseTrackMetadata.isRelativeToUnixEpoch}.
	 *
	 * Defaults to `'synced-zero'`.
	 */
	timestampBase?: 'synced-zero' | 'zero' | 'unix';
};

/**
 * Audio source that encodes the data of a
 * [`MediaStreamAudioTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack) and pipes it into the
 * output. This is useful for capturing live or real-time audio such as microphones or audio from other media elements.
 * Audio will automatically start being captured once the connected {@link Output} is started, and will keep being
 * captured until the {@link Output} is finalized or this source is closed.
 * @group Media sources
 * @public
 */
export class MediaStreamAudioTrackSource extends AudioSource {
	/** @internal */
	private _options: MediaStreamAudioTrackSourceOptions;
	/** @internal */
	private _pump: SampleEncoderPump<AudioSampleEncoder>;
	/** @internal */
	private _abortController: AbortController | null = null;
	/** @internal */
	private _track: MediaStreamAudioTrack;
	/** @internal */
	private _audioContext: AudioContext | null = null;
	/** @internal */
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	private _scriptProcessorNode: ScriptProcessorNode | null = null; // Deprecated but goated
	/** @internal */
	private _promiseWithResolvers = promiseWithResolvers();
	/** @internal */
	private _errorPromiseAccessed = false;
	/** @internal */
	private _paused = false;

	/** A promise that rejects upon any error within this source. This promise never resolves. */
	get errorPromise() {
		this._errorPromiseAccessed = true;
		return this._promiseWithResolvers.promise;
	}

	/** Whether this source is currently paused as a result of calling `.pause()`. */
	get paused() {
		return this._paused;
	}

	/**
	 * Creates a new {@link MediaStreamAudioTrackSource} from a `MediaStreamAudioTrack`, which will pull audio samples
	 * from the stream in real time and encode them according to {@link AudioEncodingConfig}.
	 */
	constructor(
		track: MediaStreamAudioTrack,
		encodingConfig: AudioEncodingConfig,
		options: MediaStreamAudioTrackSourceOptions = {},
	) {
		if (!(track instanceof MediaStreamTrack) || track.kind !== 'audio') {
			throw new TypeError('track must be an audio MediaStreamTrack.');
		}
		validateAudioEncodingConfig(encodingConfig);
		if (typeof options !== 'object' || !options) {
			throw new TypeError('options must be an object.');
		}
		if (
			options.timestampBase !== undefined
			&& options.timestampBase !== 'synced-zero'
			&& options.timestampBase !== 'zero'
			&& options.timestampBase !== 'unix'
		) {
			throw new TypeError(
				'options.timestampBase, when provided, must be one of \'synced-zero\', \'zero\', or \'unix\'.',
			);
		}

		super(encodingConfig.codec);
		this._options = options;
		this._pump = new SampleEncoderPump(this, () => createAudioSampleEncoder(this, {
			...encodingConfig,
			highWaterMark: 8,
		}));
		this._track = track;
	}

	/** @internal */
	override async _start() {
		if (!this._errorPromiseAccessed) {
			Logging._warn(
				'Make sure not to ignore the `errorPromise` field on MediaStreamAudioTrackSource, so that any internal'
				+ ' errors get bubbled up properly.',
			);
		}

		this._abortController = new AbortController();

		let firstAudioDataTimestamp: number | null = null;
		let errored = false;
		let lastSampleTimestamp: number | null = null;
		let timestampOffset = 0;
		let addIsPending = false;

		const onAudioSample = (audioSample: AudioSample) => {
			if (errored || this._closingPromise || this._connectedTrack!.output.state !== 'started') {
				audioSample.close();
				return;
			}

			const currentTimestamp = audioSample.timestamp;

			if (this._paused) {
				const dataSeen = firstAudioDataTimestamp !== null;
				if (dataSeen) {
					if (lastSampleTimestamp !== null && this._options.timestampBase !== 'unix') {
						// In addition to dropping this sample, let's also keep track of the time we have lost due to
						// the pause. Doing it like this instead of simply keeping track of the paused time is better
						// since it retains the sample rate of the underlying source.
						const timeDelta = currentTimestamp - lastSampleTimestamp;
						timestampOffset -= timeDelta;
					}
					lastSampleTimestamp = currentTimestamp;
				}

				audioSample.close();
				return;
			}

			if (firstAudioDataTimestamp === null) {
				firstAudioDataTimestamp = audioSample.timestamp;

				let target: number;
				const timestampBase = this._options.timestampBase ?? 'synced-zero';
				if (timestampBase === 'unix') {
					target = Date.now() / 1000;
				} else if (timestampBase === 'zero') {
					target = 0;
				} else {
					const output = this._connectedTrack!.output;
					if (output._firstMediaStreamTimestamp === null) {
						output._firstMediaStreamTimestamp = performance.now() / 1000;
						target = 0;
					} else {
						target = performance.now() / 1000 - output._firstMediaStreamTimestamp;
					}
				}

				timestampOffset = target - firstAudioDataTimestamp;
			}

			lastSampleTimestamp = currentTimestamp;

			if (addIsPending) {
				// Drop data while the encoder applies backpressure
				audioSample.close();
				return;
			}

			audioSample.setTimestamp(currentTimestamp + timestampOffset);

			addIsPending = true;
			const promise = this._pump.add(encoder => encoder.push(audioSample));
			audioSample.close();

			void promise
				.then(() => {
					addIsPending = false;
				})
				.catch((error) => {
					errored = true;

					this._abortController?.abort();
					this._promiseWithResolvers.reject(error);
					if (this._audioContext && this._audioContext.state !== 'closed') {
						void this._audioContext.suspend();
					}
				});
		};

		if (typeof MediaStreamTrackProcessor !== 'undefined') {
			// Great, MediaStreamTrackProcessor is supported, this is the preferred way of doing things
			const processor = new MediaStreamTrackProcessor({ track: this._track });
			const consumer = new WritableStream<AudioData>({
				write: audioData => onAudioSample(new AudioSample(audioData)),
			});

			processor.readable.pipeTo(consumer, {
				signal: this._abortController.signal,
			}).catch((error) => {
				// Handle AbortError silently
				if (error instanceof DOMException && error.name === 'AbortError') return;

				this._promiseWithResolvers.reject(error);
			});
		} else {
			// Let's fall back to an AudioContext approach

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
			const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

			this._audioContext = new AudioContext({ sampleRate: this._track.getSettings().sampleRate });
			const sourceNode = this._audioContext.createMediaStreamSource(new MediaStream([this._track]));
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this._scriptProcessorNode = this._audioContext.createScriptProcessor(4096);

			if (this._audioContext.state === 'suspended') {
				await this._audioContext.resume();
			}

			sourceNode.connect(this._scriptProcessorNode);
			this._scriptProcessorNode.connect(this._audioContext.destination);

			let totalDuration = 0;

			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this._scriptProcessorNode.onaudioprocess = (event) => {
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				const iterator = AudioSample._fromAudioBuffer(event.inputBuffer, totalDuration);
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				totalDuration += event.inputBuffer.duration;

				for (const audioSample of iterator) {
					onAudioSample(audioSample);
				}
			};
		}
	}

	/**
	 * Pauses the capture of audio data - any audio data emitted by the underlying media stream will be ignored
	 * while paused. This does *not* close the underlying `MediaStreamAudioTrack`, it just ignores its output.
	 */
	pause() {
		this._paused = true;
	}

	/** Resumes the capture of audio data after being paused. */
	resume() {
		this._paused = false;
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		try {
			if (this._abortController) {
				this._abortController.abort();
				this._abortController = null;
			}

			if (this._audioContext) {
				assert(this._scriptProcessorNode);

				this._scriptProcessorNode.disconnect();
				await this._audioContext.close();
			}
		} finally {
			// The encoder must be closed even if the track teardown above threw
			await this._pump.flushAndClose(forceClose);
		}
	}
}

const createAudioSampleEncoder = (source: AudioSource, options: AudioSampleEncoderOptions) => {
	return new AudioSampleEncoder({
		...options,
		onEncoderConfig: (encoderConfig) => {
			source._nominalBitrate = encoderConfig.bitrate ?? null;
			options.onEncoderConfig?.(encoderConfig);
		},
	});
};

// === MEDIA STREAM TRACK PROCESSOR WORKER ===

type MediaStreamTrackProcessorWorkerMessage = {
	type: 'support';
	supported: boolean;
} | {
	type: 'videoFrame';
	trackId: number;
	videoFrame: VideoFrame;
} | {
	type: 'trackStopped';
	trackId: number;
} | {
	type: 'error';
	trackId: number;
	error: unknown;
};

type MediaStreamTrackProcessorControllerMessage = {
	type: 'videoTrack';
	trackId: number;
	track: MediaStreamVideoTrack;
} | {
	type: 'stopTrack';
	trackId: number;
};

export const mediaStreamTrackProcessorWorkerCode = () => {
	const sendMessage = (message: MediaStreamTrackProcessorWorkerMessage, transfer?: Transferable[]) => {
		if (transfer) {
			self.postMessage(message, { transfer });
		} else {
			self.postMessage(message);
		}
	};

	// Immediately send a message to the main thread, letting them know of the support
	sendMessage({
		type: 'support',
		supported: typeof MediaStreamTrackProcessor !== 'undefined',
	});

	const abortControllers = new Map<number, AbortController>();
	const activeTracks = new Map<number, MediaStreamVideoTrack>();

	self.addEventListener('message', (event) => {
		const message = event.data as MediaStreamTrackProcessorControllerMessage;

		switch (message.type) {
			case 'videoTrack': {
				activeTracks.set(message.trackId, message.track);

				const processor = new MediaStreamTrackProcessor({ track: message.track });
				const consumer = new WritableStream<VideoFrame>({
					write: (videoFrame) => {
						if (!activeTracks.has(message.trackId)) {
							videoFrame.close();
							return;
						}

						// Send it to the main thread
						sendMessage({
							type: 'videoFrame',
							trackId: message.trackId,
							videoFrame,
						}, [videoFrame]);
					},
				});

				const abortController = new AbortController();
				abortControllers.set(message.trackId, abortController);

				processor.readable.pipeTo(consumer, {
					signal: abortController.signal,
				}).catch((error: unknown) => {
					// Handle AbortError silently
					if (error instanceof DOMException && error.name === 'AbortError') return;

					sendMessage({
						type: 'error',
						trackId: message.trackId,
						error,
					});
				});
			}; break;

			case 'stopTrack': {
				const abortController = abortControllers.get(message.trackId);
				if (abortController) {
					abortController.abort();
					abortControllers.delete(message.trackId);
				}

				const track = activeTracks.get(message.trackId);
				track?.stop();
				activeTracks.delete(message.trackId);

				sendMessage({
					type: 'trackStopped',
					trackId: message.trackId,
				});
			}; break;

			default: assertNever(message);
		}
	});
};

let nextMediaStreamTrackProcessorWorkerId = 0;
let mediaStreamTrackProcessorWorker: Worker | null = null;

const initMediaStreamTrackProcessorWorker = () => {
	mediaStreamTrackProcessorWorker = createWorker('media-stream-track-processor', mediaStreamTrackProcessorWorkerCode);
};

let mediaStreamTrackProcessorIsSupportedInWorkerCache: boolean | null = null;
const mediaStreamTrackProcessorIsSupportedInWorker = async () => {
	if (mediaStreamTrackProcessorIsSupportedInWorkerCache !== null) {
		return mediaStreamTrackProcessorIsSupportedInWorkerCache;
	}

	if (!mediaStreamTrackProcessorWorker) {
		initMediaStreamTrackProcessorWorker();
	}

	return new Promise<boolean>((resolve) => {
		assert(mediaStreamTrackProcessorWorker);

		const listener = (event: MessageEvent) => {
			const message = event.data as MediaStreamTrackProcessorWorkerMessage;

			if (message.type === 'support') {
				mediaStreamTrackProcessorIsSupportedInWorkerCache = message.supported;
				mediaStreamTrackProcessorWorker!.removeEventListener('message', listener);

				resolve(message.supported);
			}
		};

		mediaStreamTrackProcessorWorker.addEventListener('message', listener);
	});
};

const sendMessageToMediaStreamTrackProcessorWorker = (
	message: MediaStreamTrackProcessorControllerMessage,
	transfer?: Transferable[],
) => {
	assert(mediaStreamTrackProcessorWorker);

	if (transfer) {
		mediaStreamTrackProcessorWorker.postMessage(message, transfer);
	} else {
		mediaStreamTrackProcessorWorker.postMessage(message);
	}
};

/**
 * Base class for subtitle sources - sources for subtitle tracks.
 * @group Media sources
 * @public
 */
export abstract class SubtitleSource extends MediaSource {
	/** @internal */
	declare _connectedTrack: OutputSubtitleTrack | null;
	/** @internal */
	override readonly _codec: SubtitleCodec;

	/** Internal constructor. */
	constructor(codec: SubtitleCodec) {
		super();

		if (!SUBTITLE_CODECS.includes(codec)) {
			throw new TypeError(`Invalid subtitle codec '${codec}'. Must be one of: ${SUBTITLE_CODECS.join(', ')}.`);
		}

		this._codec = codec;
	}
}

/**
 * This source can be used to add subtitles from a subtitle text file.
 * @group Media sources
 * @public
 */
export class TextSubtitleSource extends SubtitleSource {
	/** @internal */
	private _parser: SubtitleParser;
	/** @internal */
	private _error: unknown = null;
	/** @internal */
	private _errorSet = false;
	/** @internal */
	private _lastMuxerPromise: Promise<void> = Promise.resolve();

	/** Creates a new {@link TextSubtitleSource} where added text chunks are in the specified `codec`. */
	constructor(codec: SubtitleCodec) {
		super(codec);

		this._parser = new SubtitleParser({
			codec,
			output: (cue) => {
				this._lastMuxerPromise
					= this._connectedTrack!.output._muxer.addSubtitleCue(this._connectedTrack!, cue)
						.catch((error) => {
							this._setError(error);
						});
			},
		});
	}

	/**
	 * Parses the subtitle text according to the specified codec and adds it to the output track. You don't have to
	 * add the entire subtitle file at once here; you can provide it in chunks.
	 *
	 * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
	 * to respect writer and encoder backpressure.
	 */
	add(text: string) {
		if (typeof text !== 'string') {
			throw new TypeError('text must be a string.');
		}

		this._checkForError();

		this._ensureValidAdd();
		this._parser.parse(text);

		return this._lastMuxerPromise; // Allow the writer to apply backpressure
	}

	/** @internal */
	private _setError(error: unknown) {
		if (!this._errorSet) {
			this._error = error;
			this._errorSet = true;
		}
	}

	/** @internal */
	_checkForError() {
		if (this._errorSet) {
			throw this._error;
		}
	}

	/** @internal */
	override async _flushAndClose(forceClose: boolean) {
		if (!forceClose) {
			this._checkForError();
		}
	}
}
