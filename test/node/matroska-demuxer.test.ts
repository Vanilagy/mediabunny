import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CustomSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MkvOutputFormat,
	Output,
} from '../../src/index.js';
import { EBMLId } from '../../src/matroska/ebml.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const FRAMES_PER_BLOCK = 3;
const BLOCKS_PER_CLUSTER = 10;
const CLUSTER_COUNT = 50;

test('Zero-width unsigned integers', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-width-uint.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(1);
});

test('Zero timestamp scale', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-timestamp-scale.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow(/TimestampScale/);
});

test('Concurrent metadata tag reads', async () => {
	const filePath = path.join(__dirname, '..', 'public/tags-after-clusters.webm');
	const buffer = await fs.promises.readFile(filePath);

	// Async reads, so that both calls are in the middle of loading the tags at the same time
	using input = new Input({
		source: new CustomSource({
			getSize: async () => buffer.byteLength,
			read: async (start, end) => buffer.subarray(start, end),
		}),
		formats: ALL_FORMATS,
	});

	const [first, second] = await Promise.all([input.getMetadataTags(), input.getMetadataTags()]);
	expect(first.title).toBe('Hi');
	expect(second.title).toBe('Hi');
});

test('Output sampling frequency', async () => {
	const audio = element(
		EBMLId.Audio,
		uintElement(EBMLId.Channels, 2),
		floatElement(EBMLId.SamplingFrequency, 24000),
		floatElement(EBMLId.OutputSamplingFrequency, 48000),
	);
	const audioSpecificConfig = [0x13, 0x10, 0x56, 0xe5, 0x98];

	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(audioTrack(1, 'A_AAC', audio, element(EBMLId.CodecPrivate, audioSpecificConfig))),
			cluster(0, simpleBlock(1, 0, 0x80)),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getAudioTracks())[0]!;

	expect(await track.getSampleRate()).toBe(48000);
	expect((await track.getDecoderConfig())!.sampleRate).toBe(48000);
});

test('Segment title', async () => {
	using input = new Input({
		source: new BufferSource(matroska(
			element(EBMLId.Info, uintElement(EBMLId.TimestampScale, 1e6), element(EBMLId.Title, ascii('Hello'))),
			tracks(videoTrack(1)),
			cluster(0, simpleBlock(1, 0, 0x80)),
		)),
		formats: ALL_FORMATS,
	});

	expect((await input.getMetadataTags()).title).toBe('Hello');
});

test('Display size', async () => {
	// The display size of an unknown unit says nothing about the aspect ratio
	expect(await getSquarePixelSize(
		uintElement(EBMLId.DisplayWidth, 640),
		uintElement(EBMLId.DisplayHeight, 240),
		uintElement(EBMLId.DisplayUnit, 4),
	)).toEqual([320, 240]);

	// A missing display dimension defaults to the pixel dimension
	expect(await getSquarePixelSize(uintElement(EBMLId.DisplayWidth, 640))).toEqual([640, 240]);
	expect(await getSquarePixelSize(uintElement(EBMLId.DisplayHeight, 480))).toEqual([320, 480]);
});

const getSquarePixelSize = async (...videoChildren: Bytes[]) => {
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(videoTrack(1, 320, 240, ...videoChildren)),
			cluster(0, simpleBlock(1, 0, 0x80)),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	return [await track.getSquarePixelWidth(), await track.getSquarePixelHeight()];
};

test('Empty elements', async () => {
	// Empty elements take their default values
	using input = new Input({
		source: new BufferSource(matroska(
			element(EBMLId.Info, element(EBMLId.TimestampScale)),
			tracks(
				element(
					EBMLId.TrackEntry,
					uintElement(EBMLId.TrackNumber, 1),
					uintElement(EBMLId.TrackType, 1),
					element(EBMLId.CodecID, ascii('V_VP8')),
					element(EBMLId.FlagEnabled),
					element(EBMLId.FlagDefault),
					element(EBMLId.Language),
					element(
						EBMLId.Video,
						uintElement(EBMLId.PixelWidth, 16),
						uintElement(EBMLId.PixelHeight, 16),
						element(EBMLId.Colour, element(EBMLId.MatrixCoefficients)),
					),
				),
				audioTrack(
					2,
					'A_MPEG/L3',
					element(EBMLId.Audio, element(EBMLId.Channels), element(EBMLId.SamplingFrequency)),
					element(
						EBMLId.ContentEncodings,
						element(
							EBMLId.ContentEncoding,
							element(EBMLId.ContentEncodingScope),
							element(
								EBMLId.ContentCompression,
								uintElement(EBMLId.ContentCompAlgo, 3),
								element(EBMLId.ContentCompSettings, [0xff]),
							),
						),
					),
				),
			),
			element(EBMLId.Tags, element(
				EBMLId.Tag,
				element(EBMLId.Targets, element(EBMLId.TargetTypeValue)),
				element(
					EBMLId.SimpleTag,
					element(EBMLId.TagName, ascii('TITLE')),
					element(EBMLId.TagString, ascii('Hi')),
				),
			)),
			cluster(0, simpleBlock(1, 40, 0x80), simpleBlock(2, 40, 0x80)),
		)),
		formats: ALL_FORMATS,
	});

	const video = (await input.getPrimaryVideoTrack())!;
	expect((await video.getDisposition()).default).toBe(true);
	expect(await video.getLanguageCode()).toBe('eng');
	expect((await video.getColorSpace()).matrix).not.toBe('rgb');
	expect((await new EncodedPacketSink(video).getFirstPacket())!.timestamp).toBe(0.04);

	const audio = (await input.getPrimaryAudioTrack())!;
	expect(await audio.getNumberOfChannels()).toBe(1);
	expect(await audio.getSampleRate()).toBe(8000);
	expect((await new EncodedPacketSink(audio).getFirstPacket())!.data).toEqual(new Uint8Array([0xff, 0x10]));

	expect((await input.getMetadataTags()).title).toBe('Hi');
});

test('EBML lacing with a single frame', async () => {
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(videoTrack(1)),
			cluster(0, simpleBlock(1, 0, 0x86, [0x00, 0xaa, 0xbb])),
		)),
		formats: ALL_FORMATS,
	});
	const packet = await new EncodedPacketSink((await input.getPrimaryVideoTrack())!).getFirstPacket();

	expect(packet!.data).toEqual(new Uint8Array([0xaa, 0xbb]));
});

test('Unknown sizes of any width', async () => {
	// The size is unknown whenever all of its data bits are set, so these elements are much larger than 0x3fff bytes
	using input = new Input({
		source: new BufferSource(concat(
			ebmlHeader(),
			elementId(EBMLId.Segment),
			[0x7f, 0xff],
			info(),
			tracks(videoTrack(1)),
			elementId(EBMLId.Cluster),
			[0x7f, 0xff],
			uintElement(EBMLId.Timestamp, 0),
			...Array.from({ length: 4 }, (_, i) => simpleBlock(1, 40 * i, 0x80, new Uint8Array(10_000))),
			elementId(EBMLId.Cluster),
			[0x0f, 0xff, 0xff, 0xff, 0xff],
			uintElement(EBMLId.Timestamp, 160),
			simpleBlock(1, 0, 0x80),
		)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
});

test('Attached file with an empty FileUID', async () => {
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(videoTrack(1)),
			element(EBMLId.Attachments, element(
				EBMLId.AttachedFile,
				element(EBMLId.FileName, ascii('cover.png')),
				element(EBMLId.FileMediaType, ascii('image/png')),
				element(EBMLId.FileData, [1, 2, 3]),
				element(EBMLId.FileUID),
			)),
			cluster(0, simpleBlock(1, 0, 0x80)),
		)),
		formats: ALL_FORMATS,
	});

	expect((await input.getMetadataTags()).images).toHaveLength(1);
});

test('Default duration of the last block', async () => {
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(audioTrack(1, 'A_MPEG/L3', uintElement(EBMLId.DefaultDuration, 21_333_333))),
			cluster(0, simpleBlock(1, 0, 0x80)),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;
	const packet = await new EncodedPacketSink(track).getFirstPacket();

	// Must stay on the millisecond grid
	expect(await track.getTimeResolution()).toBe(1000);
	expect(packet!.duration).toBe(0.021);
});

test('Laced frames with a fractional default duration', async () => {
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(audioTrack(
				1,
				'A_OPUS',
				uintElement(EBMLId.CodecDelay, 6_500_000),
				// 1024 samples at 48 kHz, so not a whole number of milliseconds
				uintElement(EBMLId.DefaultDuration, 21_333_333),
				element(
					EBMLId.Audio,
					uintElement(EBMLId.Channels, 2),
					floatElement(EBMLId.SamplingFrequency, 48000),
				),
			)),
			...Array.from({ length: CLUSTER_COUNT }, (_, i) => cluster(
				64 * BLOCKS_PER_CLUSTER * i,
				...Array.from({ length: BLOCKS_PER_CLUSTER }, (_, j) => simpleBlock(
					1,
					64 * j,
					0x84, // Key frame, fixed-size lacing
					[FRAMES_PER_BLOCK - 1, ...new Uint8Array(4 * FRAMES_PER_BLOCK)],
				)),
			)),
		)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);

		const seekedPacket = await sink.getPacket(packet.timestamp);
		expect(seekedPacket!.sequenceNumber).toBe(packet.sequenceNumber);
	}

	// The frames stay on the millisecond grid: 64 ms per block, split into 21, 21 and 22 ms.
	// The 7 ms are the codec delay.
	const blockCount = BLOCKS_PER_CLUSTER * CLUSTER_COUNT;
	expect(timestamps).toEqual(Array.from(
		{ length: FRAMES_PER_BLOCK * blockCount },
		(_, i) => (64 * Math.floor(i / FRAMES_PER_BLOCK) + [0, 21, 42][i % FRAMES_PER_BLOCK]! - 7) / 1000,
	));
	expect(durations).toEqual(Array.from(
		{ length: FRAMES_PER_BLOCK * blockCount },
		(_, i) => [21, 21, 22][i % FRAMES_PER_BLOCK]! / 1000,
	));
});

test('AV1 codec info from CodecPrivate', async () => {
	// av1C of a 10-bit stream as written by FFmpeg, with the sequence header among the config OBUs
	const av1C = [
		0x81, 0x00, 0x4c, 0x00, 0x0a, 0x0e, 0x02, 0x00, 0x00, 0x05, 0x55, 0x7f, 0xfc, 0x02, 0xf8, 0x50, 0x20, 0x20,
		0x90, 0x40,
	];

	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(element(
				EBMLId.TrackEntry,
				uintElement(EBMLId.TrackNumber, 1),
				uintElement(EBMLId.TrackType, 1),
				element(EBMLId.CodecID, ascii('V_AV1')),
				element(EBMLId.CodecPrivate, av1C),
				element(EBMLId.Video, uintElement(EBMLId.PixelWidth, 64), uintElement(EBMLId.PixelHeight, 64)),
			)),
			// Just a temporal delimiter, so no sequence header in the packet
			cluster(0, simpleBlock(1, 0, 0x80, [0x12, 0x00])),
		)),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	expect(await track.getCodecParameterString()).toBe('av01.0.00M.10.0.110.02.02.09.0');
});

test('Projection pose of spherical video', async () => {
	// For 360-degree video, the pose sets the initial viewing direction instead of transforming the frame, no matter
	// the order of the elements
	using input = new Input({
		source: new BufferSource(matroska(
			info(),
			tracks(
				videoTrack(1, 16, 16, element(
					EBMLId.Projection,
					uintElement(EBMLId.ProjectionType, 1), // Equirectangular
					floatElement(EBMLId.ProjectionPoseYaw, 180),
					floatElement(EBMLId.ProjectionPoseRoll, 90),
				)),
				videoTrack(2, 16, 16, element(
					EBMLId.Projection,
					floatElement(EBMLId.ProjectionPoseYaw, 180),
					floatElement(EBMLId.ProjectionPoseRoll, 90),
					uintElement(EBMLId.ProjectionType, 1),
				)),
				// Rectangular is the default projection type
				videoTrack(3, 16, 16, element(
					EBMLId.Projection,
					floatElement(EBMLId.ProjectionPoseYaw, 180),
					floatElement(EBMLId.ProjectionPoseRoll, 90),
				)),
			),
			cluster(0, simpleBlock(1, 0, 0x80), simpleBlock(2, 0, 0x80), simpleBlock(3, 0, 0x80)),
		)),
		formats: ALL_FORMATS,
	});
	const [sphericalTrack, poseFirstTrack, rectangularTrack] = await input.getVideoTracks();

	expect(await sphericalTrack!.getRotation()).toBe(0);
	expect(await sphericalTrack!.getFlip()).toBe(false);
	expect(await poseFirstTrack!.getRotation()).toBe(0);
	expect(await poseFirstTrack!.getFlip()).toBe(false);
	expect(await rectangularTrack!.getRotation()).toBe(90);
	expect(await rectangularTrack!.getFlip()).toBe(true);
});

test('Truncated cluster', async () => {
	await testTruncatedCluster(element);
});

test('Truncated cluster of unknown size', async () => {
	// Like a live recording that got cut off
	await testTruncatedCluster(unknownSizeElement);
});

const testTruncatedCluster = async (makeElement: typeof element) => {
	const file = concat(ebmlHeader(), makeElement(
		EBMLId.Segment,
		info(),
		tracks(videoTrack(1)),
		makeElement(
			EBMLId.Cluster,
			uintElement(EBMLId.Timestamp, 0),
			simpleBlock(1, 0, 0x80),
			simpleBlock(1, 40, 0x00),
			simpleBlock(1, 80, 0x00, new Uint8Array(100)),
		),
	));

	// The file ends in the middle of the last block
	using input = new Input({
		source: new BufferSource(file.subarray(0, file.length - 50)),
		formats: ALL_FORMATS,
	});
	const sink = new EncodedPacketSink((await input.getVideoTracks())[0]!);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([0, 0.04]);
};

test('Track numbers in multi-segment files', async () => {
	const joined = concat(await createVideoFile(false), await createVideoFile(false));

	using input = new Input({
		source: new BufferSource(joined),
		formats: ALL_FORMATS,
	});

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks).toHaveLength(2);
	expect(videoTracks.map(x => x.number)).toEqual([1, 2]);
});

test('Unknown-size segment followed by another file', async () => {
	await testUnknownSizeSegmentFollowedByFile(false);
});

test('Unknown-size segment without cues followed by another file', async () => {
	await testUnknownSizeSegmentFollowedByFile(true);
});

const testUnknownSizeSegmentFollowedByFile = async (stripCues: boolean) => {
	let first = await createVideoFile(true);
	if (stripCues) {
		// Like a MediaRecorder recording, where the last cluster runs right up to the end of the file
		const cuesPos = Buffer.from(first).lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
		expect(cuesPos).not.toBe(-1);
		first = first.subarray(0, cuesPos);
	}

	const joined = concat(first, await createVideoFile(true));

	using input = new Input({
		source: new BufferSource(joined),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const sink = new EncodedPacketSink(videoTrack);

	const timestamps: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual([0, 0.25, 0.5, 0.75]);
};

const createVideoFile = async (appendOnly: boolean) => {
	const output = new Output({
		format: new MkvOutputFormat({ appendOnly }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();

	const meta = {
		decoderConfig: {
			codec: 'vp8',
			codedWidth: 320,
			codedHeight: 240,
		},
	};
	for (let i = 0; i < 4; i++) {
		const packet = new EncodedPacket(new Uint8Array(64).fill(i), 'key', i / 4, 1 / 4);
		await source.add(packet, i === 0 ? meta : undefined);
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

type Bytes = Uint8Array | number[];

const matroska = (...segmentChildren: Bytes[]) => concat(ebmlHeader(), element(EBMLId.Segment, ...segmentChildren));

const ebmlHeader = () => element(
	EBMLId.EBML,
	uintElement(EBMLId.EBMLVersion, 1),
	uintElement(EBMLId.EBMLReadVersion, 1),
	element(EBMLId.DocType, ascii('matroska')),
	uintElement(EBMLId.DocTypeVersion, 4),
	uintElement(EBMLId.DocTypeReadVersion, 2),
);

const info = () => element(EBMLId.Info, uintElement(EBMLId.TimestampScale, 1e6));

const tracks = (...entries: Bytes[]) => element(EBMLId.Tracks, ...entries);

const videoTrack = (number: number, width = 16, height = 16, ...videoChildren: Bytes[]) => element(
	EBMLId.TrackEntry,
	uintElement(EBMLId.TrackNumber, number),
	uintElement(EBMLId.TrackType, 1),
	element(EBMLId.CodecID, ascii('V_VP8')),
	element(
		EBMLId.Video,
		uintElement(EBMLId.PixelWidth, width),
		uintElement(EBMLId.PixelHeight, height),
		...videoChildren,
	),
);

const audioTrack = (number: number, codecId: string, ...extra: Bytes[]) => element(
	EBMLId.TrackEntry,
	uintElement(EBMLId.TrackNumber, number),
	uintElement(EBMLId.TrackType, 2),
	element(EBMLId.CodecID, ascii(codecId)),
	...extra,
);

const cluster = (timestamp: number, ...children: Bytes[]) => element(
	EBMLId.Cluster,
	uintElement(EBMLId.Timestamp, timestamp),
	...children,
);

const simpleBlock = (trackNumber: number, timestamp: number, flags: number, data: Bytes = [0x10]) => element(
	EBMLId.SimpleBlock,
	vint(trackNumber),
	bigEndian(timestamp, 2),
	[flags],
	data,
);

const floatElement = (id: number, value: number) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value);
	return element(id, bytes);
};

const uintElement = (id: number, value: number) => {
	let width = 1;
	while (value >= 2 ** (8 * width)) {
		width++;
	}

	return element(id, bigEndian(value, width));
};

const element = (id: number, ...parts: Bytes[]) => {
	const content = concat(...parts);
	return concat(elementId(id), vint(content.length), content);
};

const unknownSizeElement = (id: number, ...parts: Bytes[]) => concat(
	elementId(id),
	[0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
	...parts,
);

const elementId = (id: number) => bigEndian(id, id < 0x100 ? 1 : id < 0x10000 ? 2 : id < 0x1000000 ? 3 : 4);

const vint = (value: number) => {
	let width = 1;
	while (value >= 2 ** (7 * width) - 1) {
		width++;
	}

	const bytes = bigEndian(value, width);
	bytes[0]! |= 1 << (8 - width);
	return bytes;
};

const bigEndian = (value: number, width: number) => Array.from(
	{ length: width },
	(_, i) => Math.floor(value / 2 ** (8 * (width - 1 - i))) & 0xff,
);

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

const concat = (...parts: Bytes[]) => {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};
