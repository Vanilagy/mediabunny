import { expect, test } from 'vitest';
import path from 'node:path';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';
import { parsePsshBoxContents } from '../../src/isobmff/isobmff-misc.js';
import { FileSlice, readBytes } from '../../src/reader.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const sink = new EncodedPacketSink(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

// Annex B isn't supposed to exist in MP4, but some files have it anyway, with an empty avcC box
test('Annex B', async () => {
	const filePath = path.join(__dirname, '..', 'public/annex-b.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('avc1.424028');
	expect(decoderConfig.description).toBeUndefined();

	const sink = new EncodedPacketSink(track);
	const firstPacket = (await sink.getFirstPacket())!;
	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
});

test('HE-AAC v2 audio config is parsed correctly', async () => {
	const filePath = path.join(__dirname, '..', 'public/he-aac-v2.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.getNumberOfChannels()).toBe(2);

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('mp4a.40.29');
	expect(decoderConfig.sampleRate).toBe(44100);
	expect(decoderConfig.numberOfChannels).toBe(2);
	expect([...toUint8Array(decoderConfig.description!)]).toEqual([0xeb, 0x8a, 0x08, 0x00]);
});

const buildTwoSampleMp4 = async (useMdtaMetadata = false) => {
	const output = new Output({
		format: new Mp4OutputFormat(useMdtaMetadata ? { metadataFormat: 'mdta' } : {}),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	if (useMdtaMetadata) {
		output.setMetadataTags({ title: 'Title', comment: 'Comment' });
	}

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 0.04), {
		decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
	});
	await source.add(new EncodedPacket(new Uint8Array(32), 'delta', 0.04, 0.04));
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const findBoxOffset = (bytes: Uint8Array, name: string) => {
	const nameBytes = [...name].map(character => character.charCodeAt(0));
	const offset = bytes.findIndex((_, index) => nameBytes.every((byte, i) => bytes[index + i] === byte));
	assert(offset !== -1);

	return offset;
};

const writeBoxName = (bytes: Uint8Array, offset: number, name: string) => {
	bytes.set([...name].map(character => character.charCodeAt(0)), offset);
};

test('Invalid stz2 field size is rejected', async () => {
	const bytes = await buildTwoSampleMp4();
	const offset = findBoxOffset(bytes, 'stsz');
	const view = new DataView(bytes.buffer);

	writeBoxName(bytes, offset, 'stz2');
	view.setUint8(offset + 11, 0);
	view.setUint32(offset + 12, 0xffffffff);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

	expect((await input.getTracks()).length).toBe(1);
	expect(await input.computeDuration()).toBe(0.08);
});

test('Invalid keys entry size is rejected', async () => {
	const bytes = await buildTwoSampleMp4(true);
	const offset = findBoxOffset(bytes, 'keys');
	const view = new DataView(bytes.buffer);

	view.setUint32(offset + 8, 0xffffffff);
	view.setUint32(offset + 12, 0);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

	expect((await input.getTracks()).length).toBe(1);
	expect(await input.computeDuration()).toBe(0.08);
});

test('MP4 without a sample size box still yields packets', async () => {
	const bytes = await buildTwoSampleMp4();
	writeBoxName(bytes, findBoxOffset(bytes, 'stsz'), 'free');

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

	expect(await input.computeDuration()).toBe(0.08);
});

test('Truncated pssh box does not abort metadata parsing', async () => {
	const base = await buildTwoSampleMp4();
	const pssh = new Uint8Array(12);
	const psshView = new DataView(pssh.buffer);
	psshView.setUint32(0, pssh.length);
	writeBoxName(pssh, 4, 'pssh');
	psshView.setUint8(8, 1);

	const moovOffset = findBoxOffset(base, 'moov');
	const insertAt = moovOffset + 4;
	const bytes = new Uint8Array(base.length + pssh.length);
	bytes.set(base.subarray(0, insertAt), 0);
	bytes.set(pssh, insertAt);
	bytes.set(base.subarray(insertAt), insertAt + pssh.length);

	const view = new DataView(bytes.buffer);
	view.setUint32(moovOffset - 4, view.getUint32(moovOffset - 4) + pssh.length);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

	expect((await input.getTracks()).length).toBe(1);
	expect(await input.computeDuration()).toBe(0.08);
});

test('pssh box contents are validated against the buffer length', () => {
	const makeV1Pssh = (length: number, declaredKidCount: number) => {
		const contents = new Uint8Array(length);
		const view = new DataView(contents.buffer);

		if (length >= 1) {
			view.setUint8(0, 1);
		}
		if (length >= 24) {
			view.setUint32(20, declaredKidCount);
		}

		return contents;
	};

	for (const length of [0, 1, 20, 24, 27]) {
		expect(parsePsshBoxContents(makeV1Pssh(length, 0))).toBe(null);
	}

	for (const length of [28, 36, 40, 43]) {
		expect(parsePsshBoxContents(makeV1Pssh(length, 0xffffffff))?.keyIds).toBe(null);
	}

	expect(parsePsshBoxContents(makeV1Pssh(44, 0xffffffff))?.keyIds).toEqual(['0'.repeat(32)]);
	expect(parsePsshBoxContents(makeV1Pssh(60, 2))?.keyIds?.length).toBe(2);
	expect(parsePsshBoxContents(new Uint8Array(24))?.keyIds).toBe(null);
});

test('Reading a negative amount of bytes throws', () => {
	const slice = FileSlice.tempFromBytes(new Uint8Array(64));
	slice.skip(16);

	expect(() => readBytes(slice, -8)).toThrow(RangeError);
});
