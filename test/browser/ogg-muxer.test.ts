import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { OggOutputFormat } from '../../src/output-format.js';
import { NullTarget } from '../../src/target.js';
import { AudioBufferSource } from '../../src/media-source.js';

test('maximumPageDuration option', async () => {
	const sampleRate = 48000;
	const durationSeconds = 2;
	const audioBuffer = new AudioBuffer({ numberOfChannels: 1, length: sampleRate * durationSeconds, sampleRate });

	// First, create an Ogg file without the maximumPageDuration option
	let pageCountWithoutOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				onPage: () => {
					pageCountWithoutOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', bitrate: 64000 });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	// Then, create an Ogg file with maximumPageDuration set to 0.1 seconds
	let pageCountWithOption = 0;
	{
		const output = new Output({
			format: new OggOutputFormat({
				maximumPageDuration: 0.1,
				onPage: () => {
					pageCountWithOption++;
				},
			}),
			target: new NullTarget(),
		});

		const audioSource = new AudioBufferSource({ codec: 'opus', bitrate: 64000 });
		output.addAudioTrack(audioSource);

		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();
	}

	expect(pageCountWithoutOption).toBe(3);
	expect(pageCountWithOption).toBe(23); // It created more pages
});
