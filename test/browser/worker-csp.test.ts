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
	// A meta CSP inserted at runtime still applies to workers created afterwards. 'self' excludes blob: URLs,
	// which is how every extension package loads its inlined worker.
	const meta = document.createElement('meta');
	meta.httpEquiv = 'Content-Security-Policy';
	meta.content = 'worker-src \'self\'';
	document.head.appendChild(meta);
});

// Each bitrate has to pass the encoder's `supports`, or Mediabunny rejects the config before any worker is created
const cases: { codec: AudioCodec; register: () => void; bitrate: number }[] = [
	{ codec: 'aac', register: registerAacEncoder, bitrate: 192000 },
	{ codec: 'flac', register: registerFlacEncoder, bitrate: 192000 },
	{ codec: 'mp3', register: registerMp3Encoder, bitrate: 192000 },
	{ codec: 'ac3', register: registerAc3Encoder, bitrate: 192000 },
	{ codec: 'dts', register: registerDtsEncoder, bitrate: 768000 },
];

for (const { codec, register, bitrate } of cases) {
	test(`${codec} encoder rejects when a CSP blocks its worker`, async () => {
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

		// Encoders that send no command during init only surface the failure on a later call, so the
		// whole encode is checked. Before worker errors were handled, this never settled.
		await expect((async () => {
			await audioSource.add(sample);
			audioSource.close();
			await output.finalize();
		})()).rejects.toThrow(/worker/i);

		await output.cancel();
	});
}
