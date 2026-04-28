import {
	Input,
	ALL_FORMATS,
	BlobSource,
	UrlSource,
	Output,
	PathedTarget,
	BufferTarget,
	HlsOutputFormat,
	MpegTsOutputFormat,
	Conversion,
	QUALITY_VERY_HIGH,
	QUALITY_HIGH,
	QUALITY_MEDIUM,
	QUALITY_LOW,
	QUALITY_VERY_LOW,
} from 'mediabunny';

import SampleFileUrl from '../../docs/assets/big-buck-bunny-trimmed.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

declare global {
	interface Window {
		showDirectoryPicker(options: { mode: 'readwrite' }): Promise<FileSystemDirectoryHandle>;
	}
}

const selectDirectoryButton = document.querySelector('#select-directory') as HTMLButtonElement;
const directoryNameElement = document.querySelector('#directory-name') as HTMLParagraphElement;
const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadSampleButton = document.querySelector('#load-sample') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const dashboard = document.querySelector('#dashboard') as HTMLDivElement;
const statusElement = document.querySelector('#status') as HTMLParagraphElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const percentIndicator = document.querySelector('#percent-indicator') as HTMLParagraphElement;
const speedometer = document.querySelector('#speedometer') as HTMLParagraphElement;
const bytesWrittenElement = document.querySelector('#bytes-written') as HTMLParagraphElement;
const filesCreatedElement = document.querySelector('#files-created') as HTMLParagraphElement;
const latestFileElement = document.querySelector('#latest-file') as HTMLParagraphElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;

let currentConversion: Conversion | null = null;
let directoryHandle: FileSystemDirectoryHandle | null = null;
let progress = 0;
let processedTime = 0;
let startTime: number | null = null;
let bytesWritten = 0;
let filesCreated = 0;
let latestFile = '-';
let status = 'Waiting for directory';
let fileName = '';
let directoryName = '';
let errorMessage = '';
let renderIntervalId = -1;
const filePromises: Promise<void>[] = [];

const convertToHls = async (resource: File | string) => {
	await currentConversion?.cancel();

	resetDashboard();
	fileName = resource instanceof File ? resource.name : resource;
	updateFileUi();

	clearInterval(renderIntervalId);
	renderIntervalId = window.setInterval(render, 1000 / 60);
	render();

	try {
		// Load the input
		const source = resource instanceof File
			? new BlobSource(resource)
			: new UrlSource(resource);
		const input = new Input({
			source,
			formats: ALL_FORMATS,
		});

		const output = new Output({
			// Define the output format (HLS with MPEG-TS segments)
			format: new HlsOutputFormat({
				segmentFormat: new MpegTsOutputFormat(),
			}),
			// Describe where the files will be written
			target: new PathedTarget(
				'master.m3u8',
				({ path }) => createFileTarget(path),
			),
			onFinalize: () => Promise.all(filePromises),
		});

		currentConversion = await Conversion.init({
			input,
			output,
			tracks: 'primary', // Use only the primary video and audio tracks of the input
			video: [
				{ codec: 'avc', height: 1080, bitrate: QUALITY_VERY_HIGH },
				{ codec: 'avc', height: 720, bitrate: QUALITY_HIGH },
				{ codec: 'avc', height: 480, bitrate: QUALITY_MEDIUM },
				{ codec: 'avc', height: 360, bitrate: QUALITY_LOW },
				{ codec: 'avc', height: 240, bitrate: QUALITY_VERY_LOW },
			],
			audio: [
				{ codec: 'aac', bitrate: QUALITY_HIGH },
			],
		});

		if (!currentConversion.isValid) {
			console.info(currentConversion.discardedTracks);
			throw new Error('Conversion is invalid and cannot be executed; see the console for more.');
		}

		currentConversion.onProgress = (newProgress, newProcessedTime) => {
			progress = newProgress;
			processedTime = newProcessedTime;
			startTime ??= performance.now();
		};

		status = 'Encoding renditions and writing HLS files';

		await currentConversion.execute();

		progress = 1;
		status = 'HLS manifest complete';
	} catch (error) {
		console.error(error);

		await currentConversion?.cancel();
		status = 'Conversion failed';
		errorMessage = String(error);
		updateFileUi();
	} finally {
		clearInterval(renderIntervalId);
		renderIntervalId = -1;
		render();
	}
};

const formatBytes = (bytes: number) => {
	if (bytes < 1000) {
		return `${bytes} B`;
	}

	const units = ['kB', 'MB', 'GB', 'TB'];
	let size = bytes / 1000;
	let unitIndex = 0;
	while (size >= 1000) {
		size /= 1000;
		unitIndex++;
	}

	return `${+size.toFixed(2)} ${units[unitIndex]}`;
};

const render = () => {
	const percentage = Math.floor(progress * 100);
	const displayedPercentage = status === 'HLS manifest complete' ? 100 : Math.min(percentage, 99);
	progressBar.style.width = `${displayedPercentage}%`;
	percentIndicator.textContent = `${displayedPercentage}%`;
	bytesWrittenElement.textContent = formatBytes(bytesWritten);
	filesCreatedElement.textContent = filesCreated.toString();
	latestFileElement.textContent = latestFile;
	statusElement.textContent = status;

	if (startTime !== null) {
		const elapsedSeconds = (performance.now() - startTime) / 1000;
		const factor = processedTime / elapsedSeconds;
		speedometer.textContent = `${factor.toPrecision(3)}x`;
	} else {
		speedometer.textContent = '-';
	}
};

const updateFileUi = () => {
	directoryNameElement.textContent = directoryName;
	fileNameElement.textContent = fileName;
	errorElement.textContent = errorMessage;
};

const resetDashboard = () => {
	progress = 0;
	processedTime = 0;
	startTime = null;
	bytesWritten = 0;
	filesCreated = 0;
	latestFile = '-';
	status = 'Preparing HLS output';
	errorMessage = '';
	filePromises.length = 0;
	dashboard.classList.remove('opacity-50');
	updateFileUi();
};

const createFileTarget = async (path: string) => {
	const target = new BufferTarget({
		onFinalize: (buffer) => {
			filePromises.push((async () => {
				const handle = await directoryHandle!.getFileHandle(path, { create: true });
				const writable = await handle.createWritable();
				await writable.write(buffer);
				await writable.close();
			})());
		},
	});

	let fileBytes = 0;

	filesCreated++;
	latestFile = path;

	target.on('write', ({ end }) => {
		const newFileBytes = Math.max(fileBytes, end);
		bytesWritten += newFileBytes - fileBytes;
		fileBytes = newFileBytes;
	});

	return target;
};

// eslint-disable-next-line @typescript-eslint/no-misused-promises
selectDirectoryButton.addEventListener('click', async () => {
	directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
	directoryName = `Selected directory: ${directoryHandle.name}`;
	status = 'Waiting for source video';
	selectDirectoryButton.style.display = 'none';
	selectMediaButton.disabled = false;
	loadSampleButton.disabled = false;
	directoryNameElement.style.display = '';
	directoryNameElement.textContent = directoryName;
	statusElement.textContent = status;
});

selectMediaButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = 'video/*,video/x-matroska,video/mp2t,.ts';
	fileInput.addEventListener('change', () => {
		const file = fileInput.files![0];
		if (file) {
			void convertToHls(file);
		}
	});

	fileInput.click();
});

loadSampleButton.addEventListener('click', () => {
	const url = prompt(
		'Please enter a URL of a media file. Note that it must be HTTPS and support cross-origin requests, so have the'
		+ ' right CORS headers set.',
		'https://remotion.media/BigBuckBunny.mp4',
	);
	if (!url) {
		return;
	}

	void convertToHls(url);
});

document.addEventListener('dragover', (event) => {
	event.preventDefault();
	event.dataTransfer!.dropEffect = 'copy';
});

document.addEventListener('drop', (event) => {
	event.preventDefault();
	const files = event.dataTransfer!.files;
	const file = files[0];
	if (file) {
		void convertToHls(file);
	}
});
