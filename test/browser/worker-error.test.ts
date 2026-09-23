import { beforeAll, expect, test } from 'vitest';
import type { AudioCodec } from '../../src/codec.js';
import { Quality } from '../../src/encode.js';
import { AudioSampleSource } from '../../src/media-source.js';
import { Output } from '../../src/output.js';
import { MovOutputFormat } from '../../src/output-format.js';
import { AudioSample } from '../../src/sample.js';
import { BufferTarget } from '../../src/target.js';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerAc3Encoder } from '@mediabunny/ac3';
import { registerDtsEncoder } from '@mediabunny/dts';
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

beforeAll(() => {
	const meta = document.createElement('meta');
	meta.httpEquiv = 'Content-Security-Policy';
	meta.content = 'worker-src \'self\'';
	document.head.appendChild(meta);
});

const cases: { codec: AudioCodec; register: () => void; bitrate: number }[] = [
	{ codec: 'aac', register: registerAacEncoder, bitrate: 192000 },
	{ codec: 'flac', register: registerFlacEncoder, bitrate: 192000 },
	{ codec: 'mp3', register: registerMp3Encoder, bitrate: 192000 },
	{ codec: 'ac3', register: registerAc3Encoder, bitrate: 192000 },
	{ codec: 'dts', register: registerDtsEncoder, bitrate: 768000 },
];

for (const { codec, register, bitrate } of cases) {
	test(`${codec} encoder CSP worker rejection`, async () => {
		register();

		const output = new Output({
			format: new MovOutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new AudioSampleSource({ codec, quality: new Quality({ bitrate }) });
		output.addAudioTrack(audioSource);
		await output.start();

		const sampleRate = 48000;
		using sample = new AudioSample({
			data: new Float32Array(sampleRate * 2),
			format: 'f32',
			numberOfChannels: 2,
			sampleRate,
			timestamp: 0,
		});

		await expect((async () => {
			await audioSource.add(sample);
			audioSource.close();
			await output.finalize();
		})()).rejects.toThrow(/worker/i);

		await output.cancel();
	});
}
