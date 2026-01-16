import { Input, ALL_FORMATS, BlobSource, UrlSource, CanvasSink } from 'mediabunny';

import SampleFileUrl from '../../docs/assets/big-buck-bunny-trimmed.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const thumbnailContainer = document.querySelector('#thumbnail-container') as HTMLDivElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;

const THUMBNAIL_COUNT = 16;
const THUMBNAIL_SIZE = 200;

const generateThumbnails = async (resource: File | string) => {
	fileNameElement.textContent = resource instanceof File ? resource.name : resource;
	horizontalRule.style.display = '';
	errorElement.textContent = '';
	thumbnailContainer.innerHTML = '';

	try {
		// Create a new input from the resource
		const source = resource instanceof File
			? new BlobSource(resource)
			: new UrlSource(resource);
		const input = new Input({
			source,
			formats: ALL_FORMATS, // Accept all formats
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error('File has no video track.');
		}

		if (videoTrack.codec === null) {
			throw new Error('Unsupported video codec.');
		}

		if (!(await videoTrack.canDecode())) {
			throw new Error('Unable to decode the video track.');
		}

		// Compute width and height of the thumbnails such that the larger dimension is equal to THUMBNAIL_SIZE
		const width = videoTrack.displayWidth > videoTrack.displayHeight
			? THUMBNAIL_SIZE
			: Math.floor(THUMBNAIL_SIZE * videoTrack.displayWidth / videoTrack.displayHeight);
		const height = videoTrack.displayHeight > videoTrack.displayWidth
			? THUMBNAIL_SIZE
			: Math.floor(THUMBNAIL_SIZE * videoTrack.displayHeight / videoTrack.displayWidth);

		// Create thumbnail elements
		const thumbnailElements = [];
		for (let i = 0; i < THUMBNAIL_COUNT; i++) {
			const thumbnailElement = document.createElement('div');
			thumbnailElement.className = 'rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800 relative';
			thumbnailElement.style.width = `${width}px`;
			thumbnailElement.style.height = `${height}px`;
			thumbnailElements.push(thumbnailElement);
			thumbnailContainer.append(thumbnailElement);
		}

		// Prepare the timestamps for the thumbnails, equally spaced between the first and last timestamp of the video
		const firstTimestamp = await videoTrack.getFirstTimestamp();
		const lastTimestamp = await videoTrack.computeDuration();
		const timestamps = Array.from(
			{ length: THUMBNAIL_COUNT },
			(_, i) => firstTimestamp + i * (lastTimestamp - firstTimestamp) / THUMBNAIL_COUNT,
		);

		// Create a CanvasSink for extracting resized frames from the video track
		const sink = new CanvasSink(videoTrack, {
			width: Math.floor(width * window.devicePixelRatio),
			height: Math.floor(height * window.devicePixelRatio),
			fit: 'fill',
		});

		// Iterate over all thumbnail canvases
		let i = 0;
		for await (const wrappedCanvas of sink.canvasesAtTimestamps(timestamps)) {
			const container = thumbnailElements[i]!;

			if (wrappedCanvas) {
				const canvasElement = wrappedCanvas.canvas as HTMLCanvasElement;
				canvasElement.className = 'size-full';
				container.append(canvasElement);

				canvasElement.animate(
					[{ transform: 'scale(1.2)' }, { transform: 'scale(1)' }],
					{ duration: 333, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
				);

				const timestampElement = document.createElement('p');
				timestampElement.textContent = wrappedCanvas.timestamp.toFixed(2) + ' s';
				timestampElement.className
                    = 'absolute bottom-0 right-0 bg-black/30 text-white px-1 py-0.5 text-[11px] rounded-tl-lg';
				container.append(timestampElement);
			} else {
				// Add something to indicate that the thumbnail is missing
				const p = document.createElement('p');
				p.textContent = '?';
				p.className = 'absolute inset-0 flex items-center justify-center text-3xl opacity-50';

				container.append(p);
			}

			i++;
		}
	} catch (error) {
		console.error(error);

		errorElement.textContent = String(error);
		thumbnailContainer.innerHTML = '';
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

		void generateThumbnails(file);
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

	void generateThumbnails(url);
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
		void generateThumbnails(file);
	}
});
