import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	CanvasSink,
	Input,
	UrlSource,
	WrappedAudioBuffer,
	WrappedCanvas,
} from 'mediabunny';

import SampleFileUrl from '../../docs/assets/big-buck-bunny-trimmed.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const loadingElement = document.querySelector('#loading-element') as HTMLParagraphElement;
const playerContainer = document.querySelector('#player') as HTMLDivElement;
const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const controlsElement = document.querySelector('#controls') as HTMLDivElement;
const playButton = document.querySelector('#play-button') as HTMLButtonElement;
const playIcon = document.querySelector('#play-icon') as HTMLSpanElement;
const pauseIcon = document.querySelector('#pause-icon') as HTMLSpanElement;
const currentTimeElement = document.querySelector('#current-time') as HTMLSpanElement;
const durationElement = document.querySelector('#duration') as HTMLSpanElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const volumeBarContainer = document.querySelector('#volume-bar-container') as HTMLDivElement;
const volumeBar = document.querySelector('#volume-bar') as HTMLDivElement;
const volumeIconWrapper = document.querySelector('#volume-icon-wrapper') as HTMLDivElement;
const volumeButton = document.querySelector('#volume-button') as HTMLButtonElement;
const fullscreenButton = document.querySelector('#fullscreen-button') as HTMLButtonElement;
const errorElement = document.querySelector('#error-element') as HTMLDivElement;
const warningElement = document.querySelector('#warning-element') as HTMLDivElement;

const context = canvas.getContext('2d')!;

let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;

let fileLoaded = false;
let videoSink: CanvasSink | null = null;
let audioSink: AudioBufferSink | null = null;

let totalDuration = 0;
/** The value of the audio context's currentTime the moment the playback was started. */
let audioContextStartTime: number | null = null;
let playing = false;
/** The timestamp within the media file when the playback was started. */
let playbackTimeAtStart = 0;

let videoFrameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
let audioBufferIterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
let nextFrame: WrappedCanvas | null = null;
const queuedAudioNodes: Set<AudioBufferSourceNode> = new Set();

/**
 * Used to prevent async race conditions. When seekId is incremented, already-running async functions will be prevented
 * from having an effect.
 */
let asyncId = 0;

let draggingProgressBar = false;
let volume = 0.7;
let draggingVolumeBar = false;
let volumeMuted = false;

/** === INIT LOGIC === */

const initMediaPlayer = async (resource: File | string) => {
	try {
		// First, dispose any ongoing playback:

		if (playing) {
			pause();
		}

		void videoFrameIterator?.return();
		void audioBufferIterator?.return();
		asyncId++;

		fileLoaded = false;
		fileNameElement.textContent = resource instanceof File ? resource.name : resource;
		horizontalRule.style.display = '';
		loadingElement.style.display = '';
		playerContainer.style.display = 'none';
		errorElement.textContent = '';
		warningElement.textContent = '';

		// Create an Input from the resource
		const source = resource instanceof File
			? new BlobSource(resource)
			: new UrlSource(resource);
		const input = new Input({
			source,
			formats: ALL_FORMATS,
		});

		playbackTimeAtStart = 0;
		totalDuration = await input.computeDuration();
		durationElement.textContent = formatSeconds(totalDuration);

		let videoTrack = await input.getPrimaryVideoTrack();
		let audioTrack = await input.getPrimaryAudioTrack();

		let problemMessage = '';

		if (videoTrack) {
			if (videoTrack.codec === null) {
				problemMessage += 'Unsupported video codec. ';
				videoTrack = null;
			} else if (!(await videoTrack.canDecode())) {
				problemMessage += 'Unable to decode the video track. ';
				videoTrack = null;
			}
		}

		if (audioTrack) {
			if (audioTrack.codec === null) {
				problemMessage += 'Unsupported audio codec. ';
				audioTrack = null;
			} else if (!(await audioTrack.canDecode())) {
				problemMessage += 'Unable to decode the audio track. ';
				audioTrack = null;
			}
		}

		if (!videoTrack && !audioTrack) {
			if (!problemMessage) {
				problemMessage = 'No audio or video track found.';
			}

			throw new Error(problemMessage);
		}

		if (problemMessage) {
			warningElement.textContent = problemMessage;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
		const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

		// We must create the audio context with the matching sample rate for correct acoustic results
		// (especially for low-sample rate files)
		audioContext = new AudioContext({ sampleRate: audioTrack?.sampleRate });
		gainNode = audioContext.createGain();
		gainNode.connect(audioContext.destination);
		updateVolume();

		const videoCanBeTransparent = videoTrack
			? await videoTrack.canBeTransparent()
			: false;

		playerContainer.style.background = videoCanBeTransparent ? 'transparent' : '';

		// For video, let's use a CanvasSink as it handles rotation and closing video samples for us.
		// Pool size of 2: We'll only ever have the current and the next frame around, so we only need two canvases.
		videoSink = videoTrack && new CanvasSink(videoTrack, {
			poolSize: 2,
			fit: 'contain', // In case the video changes dimensions over time
			alpha: videoCanBeTransparent,
		});
		// For audio, we'll use an AudioBufferSink to directly retrieve AudioBuffers compatible with the Web Audio API
		audioSink = audioTrack && new AudioBufferSink(audioTrack);

		// Show the canvas if there's a video track, otherwise hide it
		if (videoTrack) {
			canvas.style.display = '';
			canvas.width = videoTrack.displayWidth;
			canvas.height = videoTrack.displayHeight;
		} else {
			canvas.style.display = 'none';
		}

		// Show volume controls if there's an audio track, otherwise hide them
		if (audioTrack) {
			volumeButton.style.display = '';
			volumeBarContainer.style.display = '';
		} else {
			volumeButton.style.display = 'none';
			volumeBarContainer.style.display = 'none';
		}

		fileLoaded = true;

		await startVideoIterator();

		if (audioContext.state === 'running') {
			// Start playback automatically if the audio context permits
			await play();
		}

		loadingElement.style.display = 'none';
		playerContainer.style.display = '';

		if (!videoSink) {
			// If there's only an audio track, always show the controls
			controlsElement.style.opacity = '1';
			controlsElement.style.pointerEvents = '';
			playerContainer.style.cursor = '';
		}
	} catch (error) {
		console.error(error);

		errorElement.textContent = String(error);
		loadingElement.style.display = 'none';
		playerContainer.style.display = 'none';
	}
};

/** === VIDEO RENDERING LOGIC === */

/** Creates a new video frame iterator and renders the first video frame. */
const startVideoIterator = async () => {
	if (!videoSink) {
		return;
	}

	asyncId++;

	await videoFrameIterator?.return(); // Dispose of the current iterator

	// Create a new iterator
	videoFrameIterator = videoSink.canvases(getPlaybackTime());

	// Get the first two frames
	const firstFrame = (await videoFrameIterator.next()).value ?? null;
	const secondFrame = (await videoFrameIterator.next()).value ?? null;

	nextFrame = secondFrame;

	if (firstFrame) {
		// Draw the first frame
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(firstFrame.canvas, 0, 0);
	}
};

/** Runs every frame; updates the canvas if necessary. */
const render = (requestFrame = true) => {
	if (fileLoaded) {
		const playbackTime = getPlaybackTime();
		if (playbackTime >= totalDuration) {
			// Pause playback once the end is reached
			pause();
			playbackTimeAtStart = totalDuration;
		}

		// Check if the current playback time has caught up to the next frame
		if (nextFrame && nextFrame.timestamp <= playbackTime) {
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(nextFrame.canvas, 0, 0);
			nextFrame = null;

			// Request the next frame
			void updateNextFrame();
		}

		if (!draggingProgressBar) {
			updateProgressBarTime(playbackTime);
		}
	}

	if (requestFrame) {
		requestAnimationFrame(() => render());
	}
};
render();

// Also call the render function on an interval to make sure the video keeps updating even if the tab isn't visible
setInterval(() => render(false), 500);

/** Iterates over the video frame iterator until it finds a video frame in the future. */
const updateNextFrame = async () => {
	const currentAsyncId = asyncId;

	// We have a loop here because we may need to iterate over multiple frames until we reach a frame in the future
	while (true) {
		const newNextFrame = (await videoFrameIterator!.next()).value ?? null;
		if (!newNextFrame) {
			break;
		}

		if (currentAsyncId !== asyncId) {
			break;
		}

		const playbackTime = getPlaybackTime();
		if (newNextFrame.timestamp <= playbackTime) {
			// Draw it immediately
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(newNextFrame.canvas, 0, 0);
		} else {
			// Save it for later
			nextFrame = newNextFrame;
			break;
		}
	}
};

/** === AUDIO PLAYBACK LOGIC === */

/** Loops over the audio buffer iterator, scheduling the audio to be played in the audio context. */
const runAudioIterator = async () => {
	if (!audioSink) {
		return;
	}

	// To play back audio, we loop over all audio chunks (typically very short) of the file and play them at the correct
	// timestamp. The result is a continuous, uninterrupted audio signal.
	for await (const { buffer, timestamp } of audioBufferIterator!) {
		const node = audioContext!.createBufferSource();
		node.buffer = buffer;
		node.connect(gainNode!);

		const startTimestamp = audioContextStartTime! + timestamp - playbackTimeAtStart;

		// Two cases: Either, the audio starts in the future or in the past
		if (startTimestamp >= audioContext!.currentTime) {
			// If the audio starts in the future, easy, we just schedule it
			node.start(startTimestamp);
		} else {
			// If it starts in the past, then let's only play the audible section that remains from here on out
			node.start(audioContext!.currentTime, audioContext!.currentTime - startTimestamp);
		}

		queuedAudioNodes.add(node);
		node.onended = () => {
			queuedAudioNodes.delete(node);
		};

		// If we're more than a second ahead of the current playback time, let's slow down the loop until time has
		// passed.
		if (timestamp - getPlaybackTime() >= 1) {
			await new Promise<void>((resolve) => {
				const id = setInterval(() => {
					if (timestamp - getPlaybackTime() < 1) {
						clearInterval(id);
						resolve();
					}
				}, 100);
			});
		}
	}
};

/** === PLAYBACK CONTROL LOGIC === */

/** Returns the current playback time in the media file. */
const getPlaybackTime = () => {
	if (playing) {
		// To ensure perfect audio-video sync, we always use the audio context's clock to determine playback time, even
		// when there is no audio track.
		return audioContext!.currentTime - audioContextStartTime! + playbackTimeAtStart;
	} else {
		return playbackTimeAtStart;
	}
};

const play = async () => {
	if (audioContext!.state === 'suspended') {
		await audioContext!.resume();
	}

	if (getPlaybackTime() === totalDuration) {
		// If we're at the end, let's snap back to the start
		playbackTimeAtStart = 0;
		await startVideoIterator();
	}

	audioContextStartTime = audioContext!.currentTime;
	playing = true;

	if (audioSink) {
		// Start the audio iterator
		void audioBufferIterator?.return();
		audioBufferIterator = audioSink?.buffers(getPlaybackTime());
		void runAudioIterator();
	}

	playIcon.style.display = 'none';
	pauseIcon.style.display = '';
};

const pause = () => {
	playbackTimeAtStart = getPlaybackTime();
	playing = false;
	void audioBufferIterator?.return(); // This stops any for-loops that are iterating the iterator
	audioBufferIterator = null;

	// Stop all audio nodes that were already queued to play
	for (const node of queuedAudioNodes) {
		node.stop();
	}
	queuedAudioNodes.clear();

	playIcon.style.display = '';
	pauseIcon.style.display = 'none';
};

const togglePlay = () => {
	if (playing) {
		pause();
	} else {
		void play();
	}
};

const seekToTime = async (seconds: number) => {
	updateProgressBarTime(seconds);

	const wasPlaying = playing;

	if (wasPlaying) {
		pause();
	}

	playbackTimeAtStart = seconds;

	await startVideoIterator();

	if (wasPlaying && playbackTimeAtStart < totalDuration) {
		void play();
	}
};

/** === PROGRESS BAR LOGIC === */

const updateProgressBarTime = (seconds: number) => {
	currentTimeElement.textContent = formatSeconds(seconds);
	progressBar.style.width = `${(seconds / totalDuration) * 100}%`;
};

progressBarContainer.addEventListener('pointerdown', (event) => {
	draggingProgressBar = true;
	progressBarContainer.setPointerCapture(event.pointerId);

	const rect = progressBarContainer.getBoundingClientRect();
	const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
	updateProgressBarTime(completion * totalDuration);

	clearTimeout(hideControlsTimeout);

	window.addEventListener('pointerup', (event) => {
		draggingProgressBar = false;
		progressBarContainer.releasePointerCapture(event.pointerId);

		const rect = progressBarContainer.getBoundingClientRect();
		const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		const newTime = completion * totalDuration;

		void seekToTime(newTime);
		showControlsTemporarily();
	}, { once: true });
});

progressBarContainer.addEventListener('pointermove', (event) => {
	if (draggingProgressBar) {
		const rect = progressBarContainer.getBoundingClientRect();
		const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateProgressBarTime(completion * totalDuration);
	}
});

/** === VOLUME CONTROL LOGIC === */

const updateVolume = () => {
	const actualVolume = volumeMuted ? 0 : volume;

	volumeBar.style.width = `${actualVolume * 100}%`;
	gainNode!.gain.value = actualVolume ** 2; // Quadratic for more fine-grained control

	const iconNumber = volumeMuted ? 0 : Math.ceil(1 + 3 * volume);
	for (let i = 0; i < volumeIconWrapper.children.length; i++) {
		const icon = volumeIconWrapper.children[i] as HTMLImageElement;
		icon.style.display = i === iconNumber ? '' : 'none';
	}
};

volumeBarContainer.addEventListener('pointerdown', (event) => {
	draggingVolumeBar = true;
	volumeBarContainer.setPointerCapture(event.pointerId);

	const rect = volumeBarContainer.getBoundingClientRect();
	volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
	volumeMuted = false;
	updateVolume();

	clearTimeout(hideControlsTimeout);

	window.addEventListener('pointerup', (event) => {
		draggingVolumeBar = false;
		volumeBarContainer.releasePointerCapture(event.pointerId);

		const rect = volumeBarContainer.getBoundingClientRect();
		volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateVolume();

		showControlsTemporarily();
	}, { once: true });
});

volumeButton.addEventListener('click', () => {
	volumeMuted = !volumeMuted;
	updateVolume();
});

volumeBarContainer.addEventListener('pointermove', (event) => {
	if (draggingVolumeBar) {
		const rect = volumeBarContainer.getBoundingClientRect();
		volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateVolume();
	}
});

/** === CONTROL UI LOGIC === */

const showControlsTemporarily = () => {
	if (!videoSink) {
		// Shouldn't run if there's only an audio track
		return;
	}

	controlsElement.style.opacity = '1';
	controlsElement.style.pointerEvents = '';
	playerContainer.style.cursor = '';

	clearTimeout(hideControlsTimeout);
	hideControlsTimeout = window.setTimeout(() => {
		if (draggingProgressBar) {
			return;
		}

		hideControls();
		playerContainer.style.cursor = 'none';
	}, 2000);
};

const hideControls = () => {
	controlsElement.style.opacity = '0';
	controlsElement.style.pointerEvents = 'none';
};
hideControls();

let hideControlsTimeout = -1;
playerContainer.addEventListener('pointermove', (event) => {
	if (event.pointerType !== 'touch') {
		showControlsTemporarily();
	}
});
playerContainer.addEventListener('pointerleave', (event) => {
	if (!videoSink) {
		// Shouldn't run if there's only an audio track
		return;
	}

	if (draggingProgressBar || draggingVolumeBar || event.pointerType === 'touch') {
		return;
	}

	hideControls();
	clearTimeout(hideControlsTimeout);
});

/** === EVENT LISTENERS === */

playButton.addEventListener('click', togglePlay);
window.addEventListener('keydown', (e) => {
	if (!fileLoaded) {
		return;
	}

	if (e.code === 'Space' || e.code === 'KeyK') {
		togglePlay();
	} else if (e.code === 'KeyF') {
		fullscreenButton.click();
	} else if (e.code === 'ArrowLeft') {
		const newTime = Math.max(getPlaybackTime() - 5, 0);
		void seekToTime(newTime);
	} else if (e.code === 'ArrowRight') {
		const newTime = Math.min(getPlaybackTime() + 5, totalDuration);
		void seekToTime(newTime);
	} else if (e.code === 'KeyM') {
		volumeButton.click();
	} else {
		return;
	}

	showControlsTemporarily();
	e.preventDefault();
});

fullscreenButton.addEventListener('click', () => {
	if (document.fullscreenElement) {
		void document.exitFullscreen();
	} else {
		playerContainer.requestFullscreen().catch((e) => {
			console.error('Failed to enter fullscreen mode:', e);
		});
	}
});

// I'm sorry for this
const isTouchDevice = () => {
	return 'ontouchstart' in window;
};

playerContainer.addEventListener('click', () => {
	if (isTouchDevice()) {
		if (controlsElement.style.opacity === '1') {
			hideControls();
		} else {
			showControlsTemporarily();
		}
	} else {
		togglePlay();
	}
});
controlsElement.addEventListener('click', (event) => {
	// Make sure this does NOT toggle play
	event.stopPropagation();
	showControlsTemporarily();
});

/** === UTILS === */

const formatSeconds = (seconds: number) => {
	const showMilliseconds = window.innerWidth >= 640;

	seconds = Math.round(seconds * 1000) / 1000; // Round to milliseconds

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = Math.floor(seconds % 60);
	const millisecs = Math.floor(1000 * seconds % 1000).toString().padStart(3, '0');

	let result: string;
	if (hours > 0) {
		result = `${hours}:${minutes.toString().padStart(2, '0')}`
			+ `:${remainingSeconds.toString().padStart(2, '0')}`;
	} else {
		result = `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
	}

	if (showMilliseconds) {
		result += `.${millisecs}`;
	}

	return result;
};

window.addEventListener('resize', () => {
	if (totalDuration) {
		updateProgressBarTime(getPlaybackTime());
		durationElement.textContent = formatSeconds(totalDuration);
	}
});

/** === FILE SELECTION LOGIC === */

selectMediaButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = 'video/*,video/x-matroska,video/mp2t,.ts,audio/*,audio/aac';
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (!file) {
			return;
		}

		void initMediaPlayer(file);
	});

	fileInput.click();
});

loadUrlButton.addEventListener('click', () => {
	const url = prompt(
		'Please enter a URL of a media file. Note that it must be HTTPS and support cross-origin requests, so have the'
		+ ' right CORS headers set.',
		'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
	);
	if (!url) {
		return;
	}

	void initMediaPlayer(url);
});

document.addEventListener('dragover', (event) => {
	event.preventDefault();
	event.dataTransfer!.dropEffect = 'copy';
});

document.addEventListener('drop', (event) => {
	event.preventDefault();
	const files = event.dataTransfer?.files;
	const file = files && files.length > 0 ? files[0] : undefined;
	if (file) {
		void initMediaPlayer(file);
	}
});
