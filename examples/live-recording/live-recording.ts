import {
	canEncodeAudio,
	CanvasSource,
	MediaStreamAudioTrackSource,
	Mp4OutputFormat,
	Output,
	QUALITY_MEDIUM,
	StreamTarget,
} from 'mediabunny';

const toggleRecordingButton = document.querySelector('#toggle-button') as HTMLButtonElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const mainContainer = document.querySelector('#main-container') as HTMLDivElement;
const videoElement = document.querySelector('video') as HTMLVideoElement;
const downloadButton = document.querySelector('#download-button') as HTMLAnchorElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;
const warningElement = document.querySelector('#warning-element') as HTMLParagraphElement;

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const context = canvas.getContext('2d', { alpha: false, desynchronized: true })!;

const frameRate = 30;

const chunks: Uint8Array<ArrayBuffer>[] = [];
let recording = false;
let output: Output;
let videoSource: CanvasSource;
let videoCaptureInterval: number;
let mediaStream: MediaStream;
let startTime: number;
let readyForMoreFrames = true;
let lastFrameNumber = -1;

const startRecording = async () => {
	try {
		// Reset DOM state
		recording = true;
		toggleRecordingButton.textContent = 'Starting...';
		toggleRecordingButton.disabled = true;
		mainContainer.style.display = 'none';
		videoElement.src = '';
		downloadButton.style.display = 'none';
		errorElement.textContent = '';
		warningElement.textContent = '';

		// Paint a white background to the canvas
		context.fillStyle = 'white';
		context.fillRect(0, 0, canvas.width, canvas.height);

		const audioIsEncodable = await canEncodeAudio('opus', {
			bitrate: QUALITY_MEDIUM,
		});

		let audioTrack: MediaStreamAudioTrack | null = null;
		if (audioIsEncodable) {
			// Get user microphone
			mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			audioTrack = mediaStream.getAudioTracks()[0] ?? null;
		} else {
			warningElement.textContent
				= 'Audio is not yet encodable by your browser, so the audio track has been omitted.';
		}

		horizontalRule.style.display = '';
		mainContainer.style.display = '';

		// Create a new output file
		output = new Output({
			// We're using fragmented MP4 here; streamable WebM would also work
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			// We use StreamTarget to pipe the chunks to the SourceBuffer as soon as they are created
			target: new StreamTarget(new WritableStream({
				write(chunk) {
					chunks.push(chunk.data);

					if (sourceBuffer) {
						appendToSourceBuffer(chunk.data);
					}
				},
			})),
		});

		const mediaSource = new MediaSource();
		let sourceBuffer: SourceBuffer | null = null;
		videoElement.src = URL.createObjectURL(mediaSource);
		void videoElement.play();

		await new Promise(resolve => mediaSource.onsourceopen = resolve);

		let appendPromise = Promise.resolve();
		const appendToSourceBuffer = (source: BufferSource) => {
			// Buffer appends must be serialized to avoid errors
			appendPromise = appendPromise.then(() => {
				sourceBuffer!.appendBuffer(source);
				return new Promise(resolve => sourceBuffer!.onupdateend = () => resolve());
			});
		};

		// Add the video track, with the canvas as the source
		videoSource = new CanvasSource(canvas, {
			codec: 'avc',
			bitrate: QUALITY_MEDIUM,
			keyFrameInterval: 0.5,
			latencyMode: 'realtime', // Allow the encoder to skip frames to keep up with real-time constraints
		});
		output.addVideoTrack(videoSource, { frameRate });

		if (audioTrack) {
			// Add the audio track, with the media stream track as the source
			const audioSource = new MediaStreamAudioTrackSource(audioTrack, {
				codec: 'opus',
				bitrate: QUALITY_MEDIUM,
			});
			audioSource.errorPromise.catch(cancelRecording); // Make sure errors are bubbled up

			output.addAudioTrack(audioSource);
		}

		await output.start();

		startTime = Number(document.timeline.currentTime);
		readyForMoreFrames = true;
		lastFrameNumber = -1;

		// Start the video frame capture loop, making sure errors are caught
		void addVideoFrame().catch(cancelRecording);
		videoCaptureInterval = window.setInterval(() => void addVideoFrame().catch(cancelRecording), 1000 / frameRate);

		const mimeType = await output.getMimeType();
		sourceBuffer = mediaSource.addSourceBuffer(mimeType);

		// Add all chunks that have been queued up until this point
		chunks.forEach(chunk => appendToSourceBuffer(chunk));

		toggleRecordingButton.textContent = 'Stop recording';
		toggleRecordingButton.disabled = false;
	} catch (error) {
		await cancelRecording(error);
	}
};

const cancelRecording = async (error: unknown) => {
	if (!recording) {
		return; // Already canceled
	}

	console.error(error);

	errorElement.textContent = String(error);

	clearInterval(videoCaptureInterval);
	mainContainer.style.display = 'none';
	toggleRecordingButton.textContent = 'Start recording';
	toggleRecordingButton.disabled = false;
	recording = false;
	await output?.cancel();

	mediaStream?.getTracks().forEach(track => track.stop());
};

const stopRecording = async () => {
	toggleRecordingButton.textContent = 'Stopping...';
	toggleRecordingButton.disabled = true;

	clearInterval(videoCaptureInterval);
	mediaStream?.getTracks().forEach(track => track.stop());

	await output.finalize();

	// Show a download button
	const blob = new Blob(chunks, { type: output.format.mimeType });
	const url = URL.createObjectURL(blob);
	downloadButton.style.display = '';
	downloadButton.href = url;
	downloadButton.download = 'michelangelo' + output.format.fileExtension;

	toggleRecordingButton.textContent = 'Start recording';
	toggleRecordingButton.disabled = false;
	recording = false;
};

toggleRecordingButton.addEventListener('click', () => {
	if (!recording) {
		void startRecording();
	} else {
		void stopRecording();
	}
});

const addVideoFrame = async () => {
	if (!readyForMoreFrames) {
		// The last frame hasn't finished encoding yet; let's drop this frame due to real-time constraints
		return;
	}

	const elapsedSeconds = (Number(document.timeline.currentTime) - startTime) / 1000;
	const frameNumber = Math.round(elapsedSeconds * frameRate);
	if (frameNumber === lastFrameNumber) {
		// Prevent multiple frames with the same timestamp
		return;
	}

	lastFrameNumber = frameNumber;
	const timestamp = frameNumber / frameRate;

	readyForMoreFrames = false;
	await videoSource.add(timestamp, 1 / frameRate);
	readyForMoreFrames = true;
};

/* === CANVAS DRAWING STUFF === */

let drawing = false;
let lastPos = new DOMPoint(0, 0);

const getRelativeMousePos = (event: PointerEvent) => {
	const rect = canvas.getBoundingClientRect();
	return new DOMPoint(
		event.clientX - rect.x,
		event.clientY - rect.y,
	);
};

const drawLine = (from: DOMPoint, to: DOMPoint) => {
	context.beginPath();
	context.moveTo(from.x, from.y);
	context.lineTo(to.x, to.y);
	context.strokeStyle = '#27272a';
	context.lineWidth = 5;
	context.lineCap = 'round';
	context.stroke();
};

canvas.addEventListener('pointerdown', (event) => {
	if (event.button !== 0) return;

	drawing = true;
	lastPos = getRelativeMousePos(event);
	drawLine(lastPos, lastPos);
});
window.addEventListener('pointerup', () => {
	drawing = false;
});
window.addEventListener('pointermove', (event) => {
	if (!drawing) return;

	const newPos = getRelativeMousePos(event);
	drawLine(lastPos, newPos);
	lastPos = newPos;
});
