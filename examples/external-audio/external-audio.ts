import {
	Input,
	ALL_FORMATS,
	BlobSource,
	UrlSource,
	Output,
	BufferTarget,
	Mp4OutputFormat,
	Conversion,
	AudioBufferSource,
} from 'mediabunny';

import SampleFileUrl from '../../docs/assets/big-buck-bunny-trimmed.mp4';
(document.querySelector('#sample-file-download') as HTMLAnchorElement).href = SampleFileUrl;

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const statusText = document.querySelector('#status-text') as HTMLParagraphElement;
const videoElement = document.querySelector('video') as HTMLVideoElement;
const resultInfo = document.querySelector('#result-info') as HTMLParagraphElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;

let currentConversion: Conversion | null = null;
let currentOutput: Output<Mp4OutputFormat, BufferTarget> | null = null;
let currentIntervalId = -1;

/**
 * Synthesizes a short, speech-cadenced sequence of frequency-swept tones using an OfflineAudioContext. This stands
 * in for a real text-to-speech voiceover: in a production app, `audioBuffer` would instead come from an AI
 * voiceover/TTS service, decoded into an AudioBuffer.
 */
const synthesizeVoiceover = async (duration: number): Promise<AudioBuffer> => {
	const sampleRate = 48000;
	const totalSamples = Math.max(1, Math.ceil(duration * sampleRate));
	// Two channels, since not every AAC encoder implementation supports mono output.
	const context = new OfflineAudioContext(2, totalSamples, sampleRate);

	const master = context.createGain();
	master.gain.value = 0.5;
	master.connect(context.destination);

	// A tiny deterministic PRNG (mulberry32) so the "voiceover" is reproducible across runs of the demo.
	let seed = 0x2f6e2b1;
	const nextRandom = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let x = seed;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};

	// Fill the buffer with short "phrases": frequency sweeps shaped by an envelope and separated by silence, which
	// roughly mimics the rhythm of spoken words without requiring any real speech synthesis.
	let t = 0.2;
	while (t < duration - 0.15) {
		const phraseDuration = 0.15 + nextRandom() * 0.35;
		const startFrequency = 120 + nextRandom() * 80;
		const endFrequency = startFrequency + (nextRandom() - 0.5) * 160;

		const oscillator = context.createOscillator();
		oscillator.type = 'sawtooth';
		oscillator.frequency.setValueAtTime(startFrequency, t);
		oscillator.frequency.linearRampToValueAtTime(endFrequency, t + phraseDuration);

		const lowpass = context.createBiquadFilter();
		lowpass.type = 'lowpass';
		lowpass.frequency.value = 1200;

		const envelope = context.createGain();
		envelope.gain.setValueAtTime(0, t);
		envelope.gain.linearRampToValueAtTime(1, t + phraseDuration * 0.2);
		envelope.gain.linearRampToValueAtTime(1, t + phraseDuration * 0.7);
		envelope.gain.linearRampToValueAtTime(0, t + phraseDuration);

		oscillator.connect(lowpass);
		lowpass.connect(envelope);
		envelope.connect(master);

		oscillator.start(t);
		oscillator.stop(t + phraseDuration);

		t += phraseDuration + 0.08 + nextRandom() * 0.25; // Gap before the next "word"
	}

	return context.startRendering();
};

const addVoiceover = async (resource: File | string) => {
	clearInterval(currentIntervalId);
	await currentConversion?.cancel();
	// The conversion we're about to create won't own the output, so canceling it won't touch the output. We're the
	// ones who own it, so we must cancel any leftover output from a previous run ourselves.
	await currentOutput?.cancel();

	fileNameElement.textContent = resource instanceof File ? resource.name : resource;
	horizontalRule.style.display = '';
	progressBarContainer.style.display = '';
	progressBar.style.width = '0%';
	statusText.style.display = '';
	statusText.textContent = 'Loading video...';
	videoElement.style.display = 'none';
	videoElement.src = '';
	resultInfo.style.display = 'none';
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

		// Define the output file. Since we're using `ownsOutput: false`, this Output is entirely ours: we're the
		// ones who start it, add tracks to it, and finalize it.
		const output = new Output({
			target: new BufferTarget(),
			format: new Mp4OutputFormat(),
		});
		currentOutput = output;

		// A non-owning conversion only pumps the tracks it's given into the output; here, that's just the video
		// track. Any audio the input might already have is discarded, since we're replacing it with our own
		// synthesized voiceover track. If the input has no audio to begin with, this is a no-op.
		currentConversion = await Conversion.init({
			input,
			output,
			ownsOutput: false,
			audio: { discard: true },
		});

		if (!currentConversion.isValid) {
			console.info(currentConversion.discardedTracks);
			throw new Error('Conversion is invalid and cannot be executed; see the console for more.');
		}

		// We add our own audio track directly to the output; the conversion never touches it, nor does it write
		// any metadata tags (a non-owning conversion always leaves both of those to us).
		const voiceoverSource = new AudioBufferSource({ codec: 'aac', bitrate: 128e3 });
		output.addAudioTrack(voiceoverSource);

		// Keep track of conversion progress
		let progress = 0;
		currentConversion.onProgress = (newProgress) => {
			progress = newProgress;
		};

		const updateProgress = () => {
			progressBar.style.width = `${progress * 100}%`;
		};
		currentIntervalId = window.setInterval(updateProgress, 1000 / 60);

		// A non-owning conversion requires the output to already be started before `execute()` may be called, since
		// tracks (like the one we just added) can only be added while the output is still pending.
		await output.start();

		// Synthesize a voiceover track as long as the video itself
		statusText.textContent = 'Synthesizing voiceover...';
		const duration = await input.computeDuration();
		const voiceoverBuffer = await synthesizeVoiceover(Math.max(duration, 0.5));

		statusText.textContent = 'Converting...';

		// Run the conversion (which pumps the video track) concurrently with feeding our own voiceover audio into
		// the output. Both write into the very same output file.
		await Promise.all([
			currentConversion.execute(),
			(async () => {
				await voiceoverSource.add(voiceoverBuffer);
				voiceoverSource.close();
			})(),
		]);

		// Since the conversion doesn't own the output, finalizing it is our responsibility.
		await output.finalize();

		clearInterval(currentIntervalId);
		updateProgress();
		statusText.style.display = 'none';

		// Display the final media file
		videoElement.style.display = '';
		videoElement.src = URL.createObjectURL(new Blob([output.target.buffer!], { type: output.format.mimeType }));
		void videoElement.play();

		resultInfo.style.display = '';
		resultInfo.textContent = `Added a ${duration.toFixed(1)} s synthesized voiceover track.`;
	} catch (error) {
		console.error(error);

		await currentConversion?.cancel();
		await currentOutput?.cancel();

		errorElement.textContent = String(error);
		clearInterval(currentIntervalId);

		progressBarContainer.style.display = 'none';
		statusText.style.display = 'none';
		resultInfo.style.display = 'none';
		videoElement.style.display = 'none';
	}
};

/** === FILE SELECTION LOGIC === */

selectMediaButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = 'video/*,video/x-matroska,video/mp2t,.ts';
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (!file) {
			return;
		}

		void addVoiceover(file);
	});

	fileInput.click();
});

loadUrlButton.addEventListener('click', () => {
	const url = prompt(
		'Please enter a URL of a video file. Note that it must be HTTPS and support cross-origin requests, so have the'
		+ ' right CORS headers set.',
		'https://mediabunny.dev/big-buck-bunny.mp4',
	);
	if (!url) {
		return;
	}

	void addVoiceover(url);
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
		void addVoiceover(file);
	}
});
