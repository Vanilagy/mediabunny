import { Input, ALL_FORMATS, BlobSource, UrlSource } from 'mediabunny';

// Sample file URL - users can replace with their own
const SampleFileUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const contentContainer = document.querySelector('#content-container') as HTMLDivElement;

const extractSubtitles = async (resource: File | string) => {
	fileNameElement.textContent = resource instanceof File ? resource.name : resource;
	horizontalRule.style.display = '';
	contentContainer.innerHTML = '<p class="text-sm opacity-60">Loading...</p>';

	try {
		const source = resource instanceof File
			? new BlobSource(resource)
			: new UrlSource(resource);

		const input = new Input({
			source,
			formats: ALL_FORMATS,
		});

		const subtitleTracks = await input.subtitleTracks;

		if (!subtitleTracks || subtitleTracks.length === 0) {
			contentContainer.innerHTML = '<p class="text-sm opacity-60">No subtitle tracks found in this file.</p>';
			input.dispose();
			return;
		}

		// Extract all subtitle data before disposing input
		const subtitleData = await Promise.all(subtitleTracks.map(async (track) => {
			const cues = [];
			let cueCount = 0;
			for await (const cue of track.getCues()) {
				cues.push(cue);
				cueCount++;
				if (cueCount >= 5) break;
			}

			// Get full text for download
			const fullText = await track.exportToText();

			return {
				id: track.id,
				name: track.name,
				codec: track.codec,
				languageCode: track.languageCode,
				previewCues: cues,
				fullText,
			};
		}));

		// Now dispose the input
		input.dispose();

		// Render subtitle tracks
		contentContainer.innerHTML = '';

		for (const trackData of subtitleData) {
			const trackDiv = document.createElement('div');
			trackDiv.className = 'subtitle-track';

			// Header
			const headerDiv = document.createElement('div');
			headerDiv.className = 'subtitle-track-header';

			const titleSpan = document.createElement('span');
			titleSpan.className = 'subtitle-track-title';
			titleSpan.textContent = trackData.name || `Track ${trackData.id}`;

			const metaSpan = document.createElement('span');
			metaSpan.className = 'subtitle-track-meta';
			metaSpan.textContent = `${trackData.codec?.toUpperCase()} • ${trackData.languageCode}`;

			headerDiv.appendChild(titleSpan);
			headerDiv.appendChild(metaSpan);
			trackDiv.appendChild(headerDiv);

			// Cue preview
			const previewDiv = document.createElement('div');
			previewDiv.className = 'cue-preview';

			if (trackData.previewCues.length > 0) {
				for (const cue of trackData.previewCues) {
					const cueDiv = document.createElement('div');
					cueDiv.className = 'cue-item';

					const timeSpan = document.createElement('span');
					timeSpan.className = 'cue-time';
					timeSpan.textContent = formatTime(cue.timestamp);

					const textSpan = document.createElement('span');
					textSpan.textContent = cue.text.substring(0, 100) + (cue.text.length > 100 ? '...' : '');

					cueDiv.appendChild(timeSpan);
					cueDiv.appendChild(textSpan);
					previewDiv.appendChild(cueDiv);
				}

				const countNote = document.createElement('p');
				countNote.className = 'text-xs opacity-50 mt-2';
				countNote.textContent = `Showing first ${trackData.previewCues.length} cues`;
				previewDiv.appendChild(countNote);
			} else {
				previewDiv.innerHTML = '<p class="text-xs opacity-50">No cues found</p>';
			}

			trackDiv.appendChild(previewDiv);

			// Download button
			const downloadBtn = document.createElement('button');
			downloadBtn.className = 'download-btn';
			downloadBtn.textContent = `Download as ${trackData.codec?.toUpperCase()}`;
			downloadBtn.onclick = () => {
				try {
					const blob = new Blob([trackData.fullText], { type: 'text/plain' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = `subtitles_track${trackData.id}.${trackData.codec}`;
					a.click();
					URL.revokeObjectURL(url);
				} catch (err) {
					alert(`Error: ${err}`);
				}
			};
			trackDiv.appendChild(downloadBtn);

			contentContainer.appendChild(trackDiv);
		}
	} catch (err) {
		console.error(err);
		contentContainer.innerHTML = `<p class="text-red-500 text-sm">Error: ${err}</p>`;
	}
};

const formatTime = (seconds: number): string => {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 1000);
	return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
};

selectMediaButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = 'video/*,video/x-matroska,video/x-msvideo';
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		void extractSubtitles(file);
	});
	fileInput.click();
});

loadUrlButton.addEventListener('click', () => {
	const url = prompt(
		'Enter URL of a media file with subtitles. Must support CORS.',
		'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
	);
	if (!url) return;
	void extractSubtitles(url);
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
		void extractSubtitles(file);
	}
});
