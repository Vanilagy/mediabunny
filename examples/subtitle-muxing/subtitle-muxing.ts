import {
	Input,
	Output,
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	MkvOutputFormat,
	Mp4OutputFormat,
	MovOutputFormat,
	TextSubtitleSource,
	Conversion,
	type SubtitleCodec,
} from 'mediabunny';

const selectVideoBtn = document.querySelector('#select-video') as HTMLButtonElement;
const selectSubtitleBtn = document.querySelector('#select-subtitle') as HTMLButtonElement;
const videoNameEl = document.querySelector('#video-name') as HTMLParagraphElement;
const subtitleNameEl = document.querySelector('#subtitle-name') as HTMLParagraphElement;
const processBtn = document.querySelector('#process-btn') as HTMLButtonElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const progressFill = document.querySelector('#progress-fill') as HTMLDivElement;
const downloadSection = document.querySelector('#download-section') as HTMLDivElement;
const downloadBtn = document.querySelector('#download-btn') as HTMLButtonElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;

let videoFile: File | null = null;
let subtitleFile: File | null = null;
let outputBlob: Blob | null = null;
let outputExtension = 'mkv';

const detectSubtitleCodec = (filename: string): SubtitleCodec => {
	const ext = filename.toLowerCase().split('.').pop();
	if (ext === 'srt') return 'srt';
	if (ext === 'ass') return 'ass';
	if (ext === 'ssa') return 'ssa';
	if (ext === 'vtt') return 'webvtt';
	return 'srt';
};

const determineBestOutputFormat = (videoExt: string, subtitleCodec: SubtitleCodec) => {
	const ext = videoExt.toLowerCase();

	if (ext === 'mkv' || ext === 'webm') {
		return { format: new MkvOutputFormat(), extension: 'mkv' };
	}

	if (ext === 'mp4') {
		if (subtitleCodec === 'webvtt') {
			return { format: new Mp4OutputFormat(), extension: 'mp4' };
		} else {
			return { format: new MkvOutputFormat(), extension: 'mkv' };
		}
	}

	if (ext === 'mov') {
		if (subtitleCodec === 'webvtt') {
			return { format: new MovOutputFormat(), extension: 'mov' };
		} else {
			return { format: new MkvOutputFormat(), extension: 'mkv' };
		}
	}

	return { format: new MkvOutputFormat(), extension: 'mkv' };
};

selectVideoBtn.onclick = async () => {
	const [fileHandle] = await (window as any).showOpenFilePicker({
		types: [{
			description: 'Video Files',
			accept: {
				'video/*': ['.mp4', '.mkv', '.mov', '.webm'],
			},
		}],
	});
	videoFile = await fileHandle.getFile();
	videoNameEl.textContent = `Selected: ${videoFile!.name}`;
	updateProcessButton();
};

selectSubtitleBtn.onclick = async () => {
	const [fileHandle] = await (window as any).showOpenFilePicker({
		types: [{
			description: 'Subtitle Files',
			accept: {
				'text/*': ['.srt', '.ass', '.ssa', '.vtt'],
			},
		}],
	});
	subtitleFile = await fileHandle.getFile();
	subtitleNameEl.textContent = `Selected: ${subtitleFile!.name}`;
	updateProcessButton();
};

const updateProcessButton = () => {
	processBtn.disabled = !(videoFile && subtitleFile);
};

processBtn.onclick = async () => {
	if (!videoFile || !subtitleFile) return;

	errorElement.textContent = '';
	downloadSection.style.display = 'none';
	progressBar.style.display = 'block';
	progressFill.style.width = '0%';
	progressFill.textContent = '0%';
	processBtn.disabled = true;

	try {
		const subtitleText = await subtitleFile.text();
		const subtitleCodec = detectSubtitleCodec(subtitleFile.name);

		const input = new Input({
			source: new BlobSource(videoFile),
			formats: ALL_FORMATS,
		});

		progressFill.style.width = '10%';
		progressFill.textContent = '10%';

		// Detect video format from filename
		const videoExt = videoFile.name.toLowerCase().split('.').pop() || 'mkv';
		const { format: outputFormat, extension } = determineBestOutputFormat(videoExt, subtitleCodec);
		outputExtension = extension;

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		progressFill.style.width = '20%';
		progressFill.textContent = '20%';

		// Initialize conversion (it will copy video/audio tracks)
		const conversion = await Conversion.init({
			input,
			output,
		});

		progressFill.style.width = '30%';
		progressFill.textContent = '30%';

		// Create subtitle source
		const subtitleSource = new TextSubtitleSource(subtitleCodec);

		// Add subtitle track with content provider that will be called after output starts
		conversion.addExternalSubtitleTrack(
			subtitleSource,
			{
				languageCode: 'eng',
				name: 'English',
			},
			async () => {
				// This will be called after output.start() connects the tracks
				await subtitleSource.add(subtitleText);
				await subtitleSource.close();
			},
		);

		progressFill.style.width = '40%';
		progressFill.textContent = '40%';

		// Set up progress callback
		conversion.onProgress = (progress) => {
			const percentage = 50 + (progress * 40);
			progressFill.style.width = `${percentage}%`;
			progressFill.textContent = `${Math.round(percentage)}%`;
		};

		// Execute conversion (this will start the output, connect tracks, and run content providers)
		await conversion.execute();

		progressFill.style.width = '100%';
		progressFill.textContent = '100%';

		input.dispose();

		const buffer = (output.target as BufferTarget).buffer;
		if (!buffer) throw new Error('Output buffer is null');
		outputBlob = new Blob([buffer]);

		setTimeout(() => {
			progressBar.style.display = 'none';
			downloadSection.style.display = 'block';
			processBtn.disabled = false;
		}, 500);
	} catch (err) {
		console.error(err);
		errorElement.textContent = `Error: ${err}`;
		progressBar.style.display = 'none';
		processBtn.disabled = false;
	}
};

downloadBtn.onclick = () => {
	if (!outputBlob) return;

	const url = URL.createObjectURL(outputBlob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `video_with_subtitles.${outputExtension}`;
	a.click();
	URL.revokeObjectURL(url);
};
