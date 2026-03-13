import vm from 'node:vm';
import { expect, test } from 'vitest';
import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../../src/codec.js';
import { isArrayBuffer, isBlob, isPromiseLike, isUint8Array } from '../../src/misc.js';
import { RichImageData } from '../../src/metadata.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { BlobSource, BufferSource } from '../../src/source.js';

const createConstructorDenyingProxy = () => new Proxy({}, {
	getPrototypeOf() {
		throw new Error('Permission denied to access property "constructor"');
	},
});

const createCrossRealmArrayBuffer = (byteLength: number) => {
	const value: unknown = vm.runInNewContext(`new ArrayBuffer(${byteLength})`);
	if (!isArrayBuffer(value)) {
		throw new Error('Expected vm context to return an ArrayBuffer.');
	}
	return value;
};

const createCrossRealmUint8Array = (byteLength: number) => {
	const value: unknown = vm.runInNewContext(`new Uint8Array(${byteLength})`);
	if (!isUint8Array(value)) {
		throw new Error('Expected vm context to return a Uint8Array.');
	}
	return value;
};

const createCrossRealmBlob = () => {
	const value: unknown = vm.runInNewContext(`new Blob([new Uint8Array([1, 2, 3])])`, {
		Blob,
		Uint8Array,
	});
	if (!isBlob(value)) {
		throw new Error('Expected vm context to return a Blob.');
	}
	return value;
};

const createCrossRealmPromise = () => {
	const value: unknown = vm.runInNewContext('Promise.resolve(1)');
	if (!isPromiseLike(value)) {
		throw new Error('Expected vm context to return a Promise-like value.');
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

test('BufferSource accepts a cross-realm Uint8Array', () => {
	const bytes = createCrossRealmUint8Array(16);

	expect(() => new BufferSource(bytes)).not.toThrow();
});

test('BlobSource accepts a cross-realm Blob', () => {
	const blob = createCrossRealmBlob();

	expect(() => new BlobSource(blob)).not.toThrow();
});

test('EncodedPacket accepts a cross-realm Uint8Array', () => {
	const bytes = createCrossRealmUint8Array(16);

	expect(() => new EncodedPacket(bytes, 'key', 0, 1)).not.toThrow();
});

test('RichImageData accepts a cross-realm Uint8Array', () => {
	const bytes = createCrossRealmUint8Array(16);

	expect(() => new RichImageData(bytes, 'image/png')).not.toThrow();
});

test('promise helper accepts a cross-realm Promise', () => {
	const promise = createCrossRealmPromise();

	expect(isPromiseLike(promise)).toBe(true);
});

test('buffer predicates do not throw when instanceof prototype lookup throws', () => {
	const value = createConstructorDenyingProxy();

	expect(() => isArrayBuffer(value)).not.toThrow();
	expect(() => isUint8Array(value)).not.toThrow();
	expect(() => isBlob(value)).not.toThrow();
});
