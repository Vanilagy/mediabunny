import vm from 'node:vm';
import { expect, test } from 'vitest';
import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../../src/codec.js';
import { isArrayBuffer } from '../../src/misc.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { BufferSource } from '../../src/source.js';

const createCrossRealmArrayBuffer = (byteLength: number) => {
	const value: unknown = vm.runInNewContext(`new ArrayBuffer(${byteLength})`);
	if (!isArrayBuffer(value)) {
		throw new Error('Expected vm context to return an ArrayBuffer.');
	}
	return value;
};

test('chunk metadata validation accepts cross-realm ArrayBuffers', () => {
	const description = createCrossRealmArrayBuffer(4);

	expect(() => validateVideoChunkMetadata({
		decoderConfig: {
			codec: 'avc1.42001f',
			codedWidth: 2,
			codedHeight: 2,
			description,
		},
	})).not.toThrow();

	expect(() => validateAudioChunkMetadata({
		decoderConfig: {
			codec: 'mp4a.40.2',
			numberOfChannels: 2,
			sampleRate: 48000,
			description,
		},
	})).not.toThrow();
});

test('BufferSource accepts a cross-realm ArrayBuffer', () => {
	const bytes = createCrossRealmArrayBuffer(16);

	expect(() => new BufferSource(bytes)).not.toThrow();
});

test('sample constructors accept cross-realm ArrayBuffers', () => {
	const videoBytes = createCrossRealmArrayBuffer(16);
	const videoSample = new VideoSample(videoBytes, {
		codedWidth: 2,
		codedHeight: 2,
		format: 'RGBA',
		timestamp: 0,
	});
	videoSample.close();

	const audioBytes = createCrossRealmArrayBuffer(16);
	const audioSample = new AudioSample({
		data: audioBytes,
		numberOfChannels: 2,
		format: 's16',
		sampleRate: 48000,
		timestamp: 0,
	});
	audioSample.close();
});
