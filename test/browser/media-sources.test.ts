import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import {
	MovOutputFormat,
	Mp4OutputFormat,
	WebMOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import {
	AudioSampleSource,
	VideoSampleSource,
} from '../../src/media-source.js';
import { AudioSample, VideoSample } from '../../src/sample.js';
import { canEncodeAudio, QUALITY_MEDIUM } from '../../src/encode.js';

test('VideoSampleSource.close() should be idempotent after finalize()', async () => {
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: 'vp8',
		bitrate: QUALITY_MEDIUM,
	});

	output.addVideoTrack(videoSource);
	await output.start();

	const canvas = new OffscreenCanvas(100, 100);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 100, 100);

	const sample = new VideoSample(canvas, { timestamp: 0, duration: 1 / 30 });
	await videoSource.add(sample);
	sample.close();

	await output.finalize();

	videoSource.close(); // This previously threw
});

test('MOV AAC should include QuickTime audio boxes', async () => {
	if (
		!(await canEncodeAudio('aac', {
			sampleRate: 48_000,
			numberOfChannels: 2,
			bitrate: QUALITY_MEDIUM,
		}))
	) {
		return;
	}

	const durationInSeconds = 1;
	const sampleRate = 48_000;
	const numberOfChannels = 2;

	const renderAudioOnly = async (format: MovOutputFormat | Mp4OutputFormat): Promise<ArrayBuffer> => {
		const output = new Output({
			format,
			target: new BufferTarget(),
		});

		const audioSource = new AudioSampleSource({
			codec: 'aac',
			bitrate: QUALITY_MEDIUM,
		});

		output.addAudioTrack(audioSource);
		await output.start();

		const audioSample = new AudioSample({
			data: new Float32Array(durationInSeconds * sampleRate * numberOfChannels),
			format: 'f32-planar',
			numberOfChannels,
			numberOfFrames: durationInSeconds * sampleRate,
			sampleRate,
			timestamp: 0,
		});

		await audioSource.add(audioSample);
		audioSample.close();
		await output.finalize();

		return output.target.buffer!;
	};

	const movBytes = new Uint8Array(await renderAudioOnly(new MovOutputFormat()));
	const mp4Bytes = new Uint8Array(await renderAudioOnly(new Mp4OutputFormat()));

	const movSampleEntry = getAudioSampleEntry(movBytes);
	const mp4SampleEntry = getAudioSampleEntry(mp4Bytes);

	expect(movSampleEntry.version).toBe(1);
	expect(movSampleEntry.childTypes).toEqual(['wave', 'chan']);
	expect(movSampleEntry.waveChildTypes).toEqual([
		'frma',
		'mp4a',
		'esds',
		'\0\0\0\0',
	]);

	expect(mp4SampleEntry.version).toBe(0);
	expect(mp4SampleEntry.childTypes).toEqual(['esds']);
});

const readU32 = (bytes: Uint8Array, offset: number): number => {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(offset, false);
};

const readU16 = (bytes: Uint8Array, offset: number): number => {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint16(offset, false);
};

type ParsedBox = {
	type: string;
	start: number;
	end: number;
	dataStart: number;
	children: ParsedBox[];
};

type AudioSampleEntry = {
	version: number;
	childTypes: string[];
	waveChildTypes: string[];
};

const CONTAINER_BOX_TYPES = new Set([
	'moov',
	'trak',
	'mdia',
	'minf',
	'stbl',
	'edts',
	'dinf',
	'udta',
	'wave',
	'stsd',
	'mp4a',
	'meta',
]);

const parseBoxes = (
	bytes: Uint8Array,
	start: number,
	end: number,
): ParsedBox[] => {
	const result: ParsedBox[] = [];
	let cursor = start;

	while (cursor + 8 <= end) {
		const size32 = readU32(bytes, cursor);
		const type = String.fromCharCode(
			bytes[cursor + 4]!,
			bytes[cursor + 5]!,
			bytes[cursor + 6]!,
			bytes[cursor + 7]!,
		);

		let headerSize = 8;
		let size = size32;
		if (size32 === 1) {
			if (cursor + 16 > end) {
				break;
			}
			size = Number(
				new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength,
				).getBigUint64(cursor + 8, false),
			);
			headerSize = 16;
		} else if (size32 === 0) {
			size = end - cursor;
		}

		if (size < headerSize || cursor + size > end) {
			break;
		}

		const dataStart = cursor + headerSize;
		const boxEnd = cursor + size;

		let childStart = dataStart;
		if (type === 'stsd') {
			childStart += 8; // FullBox + entry_count
		} else if (type === 'meta') {
			childStart += 4; // FullBox
		} else if (type === 'mp4a') {
			if (dataStart + 10 <= boxEnd) {
				const version = readU16(bytes, dataStart + 8);
				childStart = dataStart + (version === 0 ? 28 : version === 1 ? 44 : 64);
			}
		}

		let children: ParsedBox[] = [];
		if (CONTAINER_BOX_TYPES.has(type) && childStart < boxEnd) {
			children = parseBoxes(bytes, childStart, boxEnd);
		}

		result.push({
			type,
			start: cursor,
			end: boxEnd,
			dataStart,
			children,
		});

		cursor = boxEnd;
	}

	return result;
};

const findChild = (box: ParsedBox, type: string): ParsedBox | null => {
	for (const child of box.children) {
		if (child.type === type) {
			return child;
		}
	}

	return null;
};

const getAudioSampleEntry = (bytes: Uint8Array): AudioSampleEntry => {
	const roots = parseBoxes(bytes, 0, bytes.byteLength);
	const moov = roots.find(b => b.type === 'moov');
	if (!moov) {
		throw new Error('No moov box found');
	}

	const audioTrak = moov.children.find((trak) => {
		if (trak.type !== 'trak') {
			return false;
		}

		const mdia = findChild(trak, 'mdia');
		if (!mdia) {
			return false;
		}

		const hdlr = findChild(mdia, 'hdlr');
		if (!hdlr) {
			return false;
		}

		const handlerOffset = hdlr.dataStart + 8; // FullBox + pre_defined
		if (handlerOffset + 4 > hdlr.end) {
			return false;
		}

		const handlerType = String.fromCharCode(
			bytes[handlerOffset]!,
			bytes[handlerOffset + 1]!,
			bytes[handlerOffset + 2]!,
			bytes[handlerOffset + 3]!,
		);

		return handlerType === 'soun';
	});

	if (!audioTrak) {
		throw new Error('No audio track found');
	}

	const mdia = findChild(audioTrak, 'mdia');
	if (!mdia) {
		throw new Error('No mdia box found for audio track');
	}

	const minf = findChild(mdia, 'minf');
	if (!minf) {
		throw new Error('No minf box found for audio track');
	}

	const stbl = findChild(minf, 'stbl');
	if (!stbl) {
		throw new Error('No stbl box found for audio track');
	}

	const stsd = findChild(stbl, 'stsd');
	if (!stsd) {
		throw new Error('No stsd box found for audio track');
	}

	const mp4a = stsd.children.find(child => child.type === 'mp4a');
	if (!mp4a) {
		throw new Error('No mp4a sample entry found');
	}

	const version = readU16(bytes, mp4a.dataStart + 8);
	const childTypes = mp4a.children.map(c => c.type);
	const wave = mp4a.children.find(c => c.type === 'wave');

	return {
		version,
		childTypes,
		waveChildTypes: wave?.children.map(c => c.type) ?? [],
	};
};
