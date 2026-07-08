import { 
	Conversion, 
	AudioSampleSource, 
	AudioSample 
} from '../../src/index';

const selectFileBtn = document.getElementById('select-file') as HTMLButtonElement;
const fileNameEl = document.getElementById('file-name') as HTMLParagraphElement;
const loadingEl = document.getElementById('loading') as HTMLDivElement;
const resultEl = document.getElementById('result') as HTMLDivElement;
const outputVideo = document.getElementById('output-video') as HTMLVideoElement;
const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
const errorEl = document.getElementById('error-message') as HTMLDivElement;

selectFileBtn.addEventListener('click', async () => {
	const file = await selectFile();
	if (!file) return;

	fileNameEl.textContent = `Selected: ${file.name}`;
	loadingEl.classList.remove('hidden');
	resultEl.classList.add('hidden');
	errorEl.classList.add('hidden');

	try {
		// 1. Set up a synthesized audio source using AudioSampleSource
		const sampleRate = 48000;
		const durationSeconds = 5;
		const audioSource = new AudioSampleSource({
			codec: 'aac',
			bitrate: 128_000,
			transform: {
				numberOfChannels: 1,
				sampleRate,
				sampleFormat: 'f32-planar'
			}
		});

		// 2. Perform the conversion
		const conversion = await Conversion.start({
			input: file,
			output: {
				format: 'mp4'
			},
			tracks: 'primary',
			// Pass our custom audio source to be multiplexed!
			externalAudioSource: audioSource
		});

		// 3. Generate some audio samples (a simple beep) while it's muxing
		const frequency = 440;
		const samples = new Float32Array(sampleRate * durationSeconds);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.sin(2 * Math.PI * frequency * (i / sampleRate));
		}
		
		const sample = new AudioSample({
			data: samples,
			format: 'f32-planar',
			numberOfChannels: 1,
			sampleRate,
			timestamp: 0
		});
		
		// Wait for the track to be ready before adding samples
		await audioSource.add(sample);
		audioSource.close();
		sample.close();

		// 4. Wait for conversion to finish
		const result = await conversion.buffer;

		// 5. Display the result
		const blob = new Blob([result], { type: 'video/mp4' });
		const url = URL.createObjectURL(blob);
		
		outputVideo.src = url;
		downloadLink.href = url;
		downloadLink.download = `external-audio-${file.name}`;
		
		loadingEl.classList.add('hidden');
		resultEl.classList.remove('hidden');
	} catch (error) {
		console.error(error);
		errorEl.textContent = String(error);
		errorEl.classList.remove('hidden');
		loadingEl.classList.add('hidden');
	}
});

async function selectFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'video/*';
		input.onchange = () => {
			resolve(input.files?.[0] || null);
		};
		input.click();
	});
}
