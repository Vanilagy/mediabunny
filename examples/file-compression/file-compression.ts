import {
	Input,
	ALL_FORMATS,
	BlobSource,
	UrlSource,
	Output,
	BufferTarget,
	Mp4OutputFormat,
	Conversion,
	QUALITY_VERY_LOW,
} from 'mediabunny';

import SampleFileUrl from '../../docs/assets/big-buck-bunny-trimmed.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const speedometer = document.querySelector('#speedometer') as HTMLParagraphElement;
const videoElement = document.querySelector('video') as HTMLVideoElement;
const compressionFacts = document.querySelector('#compression-facts') as HTMLParagraphElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;

let currentConversion: Conversion | null = null;
let currentIntervalId = -1;

const compressFile = async (resource: File | string) => {
	clearInterval(currentIntervalId);
	await currentConversion?.cancel();

	fileNameElement.textContent = resource instanceof File ? resource.name : resource;
	horizontalRule.style.display = '';
	progressBarContainer.style.display = '';
	speedometer.style.display = '';
	speedometer.textContent = 'Speed: -';
	videoElement.style.display = 'none';
	videoElement.src = '';
	errorElement.textContent = '';

	try {
		// Create a new input from the resource
		const source = resource instanceof File
			? new BlobSource(resource)
			: new UrlSource(resource);
		const input = new Input({
			source,
			formats: ALL_FORMATS, // Accept all formats
		});

		const fileSize = await source.getSize();

		// Define the output file
		const output = new Output({
			target: new BufferTarget(),
			format: new Mp4OutputFormat(),
		});

		// Initialize the conversion process
		currentConversion = await Conversion.init({
			input,
			output,
			video: {
				width: 320, // Height will be deduced automatically to retain aspect ratio
				bitrate: QUALITY_VERY_LOW,
			},
			audio: {
				bitrate: 32e3,
			},
		});

		// Keep track of progress
		let progress = 0;
		currentConversion.onProgress = newProgress => progress = newProgress;

		const fileDuration = (await input.computeDuration()) - (await input.getFirstTimestamp());
		const startTime = performance.now();

		const updateProgress = () => {
			progressBar.style.width = `${progress * 100}%`;

			const now = performance.now();
			const elapsedSeconds = (now - startTime) / 1000;
			const factor = fileDuration / (elapsedSeconds / progress);
			speedometer.textContent = `Speed: ~${factor.toPrecision(3)}x real time`;
		};

		// Update the progress indicator regularly
		currentIntervalId = window.setInterval(updateProgress, 1000 / 60);

		// Start the conversion process
		await currentConversion.execute();

		clearInterval(currentIntervalId);
		updateProgress();

		// Display the final media file
		videoElement.style.display = '';
		videoElement.src = URL.createObjectURL(new Blob([output.target.buffer!], { type: output.format.mimeType }));
		void videoElement.play();

		compressionFacts.style.display = '';
		compressionFacts.textContent
			= `${(output.target.buffer!.byteLength / fileSize * 100).toPrecision(3)}% of original size`;
	} catch (error) {
		console.error(error);

		await currentConversion?.cancel();

		errorElement.textContent = String(error);
		clearInterval(currentIntervalId);

		progressBarContainer.style.display = 'none';
		speedometer.style.display = 'none';
		compressionFacts.style.display = 'none';
		videoElement.style.display = 'none';
	}
};

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

		void compressFile(file);
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

	void compressFile(url);
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
		void compressFile(file);
	}
});
