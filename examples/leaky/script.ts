import { Input, StreamSource, ALL_FORMATS, VideoSampleSink, BlobSource } from 'mediabunny';

const fileInput = document.querySelector('input')!;

// eslint-disable-next-line @typescript-eslint/no-misused-promises
fileInput.addEventListener('change', async () => {
	const file = fileInput.files![0];
	if (!file) {
		return;
	}

	for (let i = 0; i < 100; i++) {
		console.log(i);
		await reproduceVideoFrameLeak(file);
	}

	console.log('Done');
});

async function reproduceVideoFrameLeak(videoFile: File) {
	let input: Input | undefined;

	try {
		// Create Input with StreamSource
		input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(videoFile) ?? new StreamSource({
				getSize: async () => videoFile.size,
				read: async (start: number, end: number) => {
					const slice = videoFile.slice(start, end);
					const arrayBuffer = await slice.arrayBuffer();
					return new Uint8Array(arrayBuffer);
				},
			}),
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error('No video track');

		const sink = new VideoSampleSink(videoTrack);

		// Process just 10 frames
		let frameCount = 0;
		for await (const sample of sink.samples()) {
			frameCount++;

			// We call close() but memory is still not released
			if (sample && typeof sample.close === 'function') {
				sample.close();
			}

			if (frameCount % 100 === 0) {
				console.log('oy?', frameCount);
			}

			if (frameCount >= 100) break;
		}

		console.log(`Processed ${frameCount} frames`);
	} finally {
		// Even Input.dispose() doesn't fully clean up
		input?.dispose();
	}
}
