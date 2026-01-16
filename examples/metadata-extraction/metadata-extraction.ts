import { Input, ALL_FORMATS, BlobSource, UrlSource } from 'mediabunny';

import SampleFileUrl from '../../docs/assets/big-buck-bunny-trimmed.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const bytesReadElement = document.querySelector('#bytes-read') as HTMLParagraphElement;
const metadataContainer = document.querySelector('#metadata-container') as HTMLDivElement;

const extractMetadata = (resource: File | string) => {
	// Create a new input from the resource
	const source = resource instanceof File
		? new BlobSource(resource)
		: new UrlSource(resource);
	const input = new Input({
		source,
		formats: ALL_FORMATS, // Accept all formats
	});

	let bytesRead = 0;
	let fileSize: number | null = null;

	const updateBytesRead = () => {
		bytesReadElement.textContent = `Bytes read: ${bytesRead} / ${fileSize === null ? '?' : fileSize}`;

		if (fileSize !== null) {
			bytesReadElement.textContent += ` (${(100 * bytesRead / fileSize).toPrecision(3)}% of entire file)`;
		}
	};

	input.source.onread = (start, end) => {
		bytesRead += end - start;
		updateBytesRead();
	};

	// Get the input's size
	void input.source.getSize().then(size => fileSize = size);

	// This object contains all the data that gets displayed:
	const object = {
		'Format': input.getFormat().then(format => format.name),
		'Full MIME type': input.getMimeType(),
		'Starts at': input.getFirstTimestamp().then(start => `${start} seconds`),
		'Ends at': input.computeDuration().then(duration => `${duration} seconds`),
		'Tracks': input.getTracks().then(tracks => tracks.map(track => ({
			'Type': track.type,
			'Codec': track.codec,
			'Full codec string': track.getCodecParameterString(),
			'Starts at': track.getFirstTimestamp().then(start => `${start} seconds`),
			'Ends at': track.computeDuration().then(duration => `${duration} seconds`),
			'Language code': track.languageCode,
			...(track.isVideoTrack()
				? {
						'Coded width': `${track.codedWidth} pixels`,
						'Coded height': `${track.codedHeight} pixels`,
						'Rotation': `${track.rotation}° clockwise`,
						'Transparency': track.canBeTransparent(),
					}
				: track.isAudioTrack()
					? {
							'Number of channels': track.numberOfChannels,
							'Sample rate': `${track.sampleRate} Hz`,
						}
					: {}),
			'Packet statistics': shortDelay().then(() => track.computePacketStats()).then(stats => ({
				'Packet count': stats.packetCount,
				'Average packet rate': `${stats.averagePacketRate} Hz${track.isVideoTrack() ? ' (FPS)' : ''}`,
				'Average bitrate': `${stats.averageBitrate} bps`,
			})),
			...(track.isVideoTrack()
				? {
						'Color space': track.getColorSpace().then(colorSpace => ({
							'Color primaries': colorSpace.primaries ?? 'Unknown',
							'Transfer characteristics': colorSpace.transfer ?? 'Unknown',
							'Matrix coefficients': colorSpace.matrix ?? 'Unknown',
							'Full range': colorSpace.fullRange ?? 'Unknown',
							'HDR': track.hasHighDynamicRange(),
						})),
					}
				: {}
			),
		}))),
		'Metadata tags': input.getMetadataTags().then((tags) => {
			const result = {
				'Title': tags.title,
				'Description': tags.description,
				'Artist': tags.artist,
				'Album': tags.album,
				'Album artist': tags.albumArtist,
				'Track number': tags.trackNumber,
				'Tracks total': tags.tracksTotal,
				'Disc number': tags.discNumber,
				'Discs total': tags.discsTotal,
				'Genre': tags.genre,
				'Date': tags.date?.toISOString().slice(0, 10),
				'Lyrics': tags.lyrics,
				'Comment': tags.comment,
				'Images': tags.images?.map((image) => {
					const blob = new Blob([image.data.slice()], { type: image.mimeType });
					const element = new Image();
					element.src = URL.createObjectURL(blob);

					return element;
				}),
				'Raw tag count': tags.raw && Object.keys(tags.raw).length,
			};

			if (Object.values(result).some(x => x !== undefined)) {
				return result;
			} else {
				return undefined;
			}
		}),
	};

	fileNameElement.textContent = resource instanceof File ? resource.name : resource;
	horizontalRule.style.display = '';
	bytesReadElement.innerHTML = '';
	metadataContainer.innerHTML = '';

	const htmlElement = renderValue(object);
	metadataContainer.append(bytesReadElement, htmlElement);
};

// Creates an HTML element to display any given value
const renderValue = (value: unknown) => {
	if (value instanceof HTMLElement) {
		return value;
	} else if (Array.isArray(value)) {
		const arrayAsObject: Record<string, unknown> = Object.fromEntries(
			value.map((item, index) => [(index + 1).toString(), item]),
		);
		return renderObject(arrayAsObject);
	} else if (typeof value === 'object' && value !== null) {
		return renderObject(value as Record<string, unknown>);
	} else {
		const spanElement = document.createElement('span');
		spanElement.textContent = String(value);
		return spanElement;
	}
};

// Returns a <ul> element that renders an object. Fields that are unresolves promises will be displayed with a
// loading indicator.
const renderObject = (object: Record<string, unknown>) => {
	const listElement = document.createElement('ul');
	const keys = Object.keys(object);

	for (const key of keys) {
		const value = object[key];
		const listItem = document.createElement('li');
		listItem.style.wordBreak = 'break-word';
		const keySpan = document.createElement('b');
		keySpan.textContent = `${key}: `;

		listItem.appendChild(keySpan);

		if (value instanceof Promise) {
			// Show loading text until the promise resolves
			const loadingSpan = document.createElement('i');
			loadingSpan.textContent = 'Loading...';
			loadingSpan.className = 'opacity-50';
			listItem.appendChild(loadingSpan);

			value.then((resolvedValue) => {
				// Replace the loading text with the resolved value
				listItem.removeChild(loadingSpan);
				listItem.appendChild(renderValue(resolvedValue));

				if (resolvedValue === undefined) {
					listElement.removeChild(listItem);
				}
			}).catch((error) => {
				console.error(error);

				// Show the promise error
				listItem.removeChild(loadingSpan);
				const errorSpan = document.createElement('span');
				errorSpan.textContent = String(error);
				errorSpan.className = 'text-red-500';
				listItem.appendChild(errorSpan);
			});
		} else {
			listItem.appendChild(renderValue(value));
		}

		if (value !== undefined) {
			listElement.appendChild(listItem);
		}
	}

	return listElement;
};

const shortDelay = () => {
	return new Promise(resolve => setTimeout(resolve, 1000 / 60));
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

		extractMetadata(file);
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

	extractMetadata(url);
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
		extractMetadata(file);
	}
});
