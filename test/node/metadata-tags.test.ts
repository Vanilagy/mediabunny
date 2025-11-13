import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import {
	FlacOutputFormat,
	MkvOutputFormat,
	MovOutputFormat,
	Mp3OutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AttachedFile, MetadataTags } from '../../src/metadata.js';
import path from 'node:path';
import { AudioCodec, buildAudioCodecString } from '../../src/codec.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = new URL('.', import.meta.url).pathname;

const createDummyAudioTrack = (codec: AudioCodec, output: Output) => {
	const source = new EncodedAudioPacketSource(codec);
	output.addAudioTrack(source);

	return {
		async addPacket() {
			// Data to make it behave like an MP3 frame
			const data = new Uint8Array(2000);
			data[0] = 255;
			data[1] = 251;
			data[2] = 224;
			data[3] = 100;

			const description = codec === 'flac'
				? new Uint8Array([
					102, 76, 97, 67, 128, 0, 0, 34, 16, 0,
					16, 0, 0, 6, 45, 0, 37, 173, 10, 196,
					66, 240, 0, 13, 68, 24, 85, 22, 231, 0,
					113, 139, 185, 1, 33, 54, 155, 80, 241, 191,
					203, 112,
				])
				// Opus description
				: new Uint8Array([
					79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 56, 1, 68, 172, 0, 0, 0, 0, 0,
				]);

			await source.add(
				new EncodedPacket(data, 'key', 0, 1),
				{
					decoderConfig: {
						codec: buildAudioCodecString(codec, 2, 44100),
						numberOfChannels: 2,
						sampleRate: 44100,
						description,
					},
				},
			);
		},
	};
};

const coverArt = new Uint8Array(1024);
coverArt[0] = 69;
const songMetadata: MetadataTags = {
	title: 'Trying to Feel Alive',
	description: 'A song',
	artist: 'Porter Robinson & others',
	album: 'Nurture',
	albumArtist: 'Porter Robinson',
	genre: 'Electronic',
	comment: 'Some of this info is intentionally incorrect',
	lyrics: 'Well, do you feel better now?\nI thought I\'d run until the sky came out',
	trackNumber: 13,
	tracksTotal: 14,
	discNumber: 1,
	discsTotal: 1,
	date: new Date(2021, 3, 23),
	images: [{
		data: coverArt,
		kind: 'coverFront',
		mimeType: 'image/jpeg',
		description: 'This image shows a person laying in a field of grass',
	}],
};

test('Read and write metadata, MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'©hog': 'pish',
			'©nam': 'Cheerleader', // Test that it doesn't override the main title
		},
	});

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toBeUndefined(); // Lost in MP4

	expect(readTags.raw!['©nam']).toBe(songMetadata.title);
	expect(readTags.raw!['trkn']).instanceOf(Uint8Array);
	expect(readTags.raw!['©hog']).toBe('pish');
});

test('Read and write metadata, QuickTime', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'©sic': 'ko mode',
			'cust': new Uint8Array([1, 2, 3, 4]),
		},
	});

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBeUndefined(); // All of these don't work in MOV
	expect(readTags.tracksTotal).toBeUndefined();
	expect(readTags.discNumber).toBeUndefined();
	expect(readTags.discsTotal).toBeUndefined();
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toBeUndefined();

	expect(readTags.raw!['©nam']).toBe(songMetadata.title);
	// We don't know what the data type is, so the demuxer just returns Uint8Array
	expect(readTags.raw!['©sic']).toBe('ko mode'); // Parsed as string because it begins with ©
	expect(readTags.raw!['cust']).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test('Read and write metadata, MP4 with mdta format', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({
			metadataFormat: 'mdta',
		}),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'AIGC': 'yes',
			'this key is': 'crazy long',
			'bytes': new Uint8Array([2, 3, 4, 5]),
		},
	});

	const dummyTrack = createDummyAudioTrack('aac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBeUndefined(); // Not written
	expect(readTags.discsTotal).toBeUndefined();
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toBeUndefined(); // Lost in MP4

	expect(readTags.raw!['title']).toBe(songMetadata.title);
	expect(readTags.raw!['AIGC']).toBe('yes');
	expect(readTags.raw!['this key is']).toBe('crazy long');
	expect(readTags.raw!['bytes']).toEqual(new Uint8Array([2, 3, 4, 5]));
});

test('Read MOV metadata tags, ilst with keys', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trunc-buck-bunny.mov')),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();
	expect(tags.raw).not.toBeUndefined();
	expect(tags.raw!['com.apple.quicktime.version']).toBe('7.4.1 (14) 0x7418000 (Mac OS X, 10.5.2, 9C31)');
	expect(tags.raw!['com.apple.quicktime.player.movie.audio.gain']).toEqual(new Uint8Array([63, 128, 0, 0]));
});

test('Read and write metadata, Matroska', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			'CUSTOM': 'Levels',
			// This number cannot be represented by f64, so this tests correct BigInt usage
			'9007199254740993': new AttachedFile(
				new Uint8Array(20),
				'font/ttf',
				'Heya',
				'A font file',
			),
			// And this one we don't expect to get attached again, since it mirrors the image we're also attaching
			'987654': new AttachedFile(
				songMetadata.images![0]!.data,
				songMetadata.images![0]!.mimeType,
				songMetadata.images![0]!.name,
				songMetadata.images![0]!.description,
			),
		},
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toEqual('cover.jpg'); // It constructed this name

	expect(readTags.raw!['TITLE']).toBe(songMetadata.title);
	expect(readTags.raw!['PART_NUMBER']).toBe('13/14');
	expect(readTags.raw!['CUSTOM']).toBe('Levels');

	const files = Object.entries(readTags.raw!).filter(x => x[1] instanceof AttachedFile);
	expect(files).toHaveLength(2);

	const imageFile = files.find(x => (x[1] as AttachedFile).mimeType === 'image/jpeg');
	expect((imageFile![1] as AttachedFile).data).toEqual(songMetadata.images![0]!.data);

	const secondFile = files.find(x => (x[1] as AttachedFile).mimeType === 'font/ttf');
	expect(secondFile![0]).toBe('9007199254740993');
	expect((secondFile![1] as AttachedFile).data).toHaveLength(20);
	expect((secondFile![1] as AttachedFile).mimeType).toBe('font/ttf');
	expect((secondFile![1] as AttachedFile).name).toBe('Heya');
	expect((secondFile![1] as AttachedFile).description).toBe('A font file');
});

test('Read and write metadata, MP3', async () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			TXXY: 'ID3v2 goated',
		},
	});

	const dummyTrack = createDummyAudioTrack('mp3', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	// ID3v2 is goated, so pretty much everything was copied:
	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in ID3v2

	expect(readTags.raw!['TIT2']).toBe(songMetadata.title);
	expect(readTags.raw!['APIC']).instanceOf(Uint8Array);
	expect(readTags.raw!['TXXY']).toBe('ID3v2 goated');
});

test('Read and write metadata, Ogg', async () => {
	const output = new Output({
		format: new OggOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			vendor: 'Mediabunny',
			COMPOSER: 'Hans Zimmer',
		},
	});

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in Vorbis-style metadata

	expect(readTags.raw!['vendor']).toBe('Mediabunny');
	expect(readTags.raw!['COMPOSER']).toBe('Hans Zimmer');
});

test('Read and write metadata, FLAC', async () => {
	const output = new Output({
		format: new FlacOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			vendor: 'Mediabunny',
			COMPOSER: 'Hans Zimmer',
		},
	});

	const dummyTrack = createDummyAudioTrack('flac', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in Vorbis-style metadata

	expect(readTags.raw!['vendor']).toBe('Mediabunny');
	expect(readTags.raw!['COMPOSER']).toBe('Hans Zimmer');
});

test('Read and write metadata, WAVE', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({
		...songMetadata,
		raw: {
			IKEK: 'RIFF INFO lowkey mid',
		},
	});

	const dummyTrack = createDummyAudioTrack('pcm-s16', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBeUndefined();
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBeUndefined();
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBeUndefined();
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBeUndefined();
	expect(readTags.discsTotal).toBeUndefined();
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toBeUndefined();

	expect(readTags.raw!['INAM']).toBe(songMetadata.title);
	expect(readTags.raw!['IKEK']).toBe('RIFF INFO lowkey mid');
});

test('Conversion metadata tags, default case', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags(songMetadata);

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const output2 = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output: output2 });
	await conversion.execute();

	const input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.description).toBe(songMetadata.description);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.tracksTotal).toBe(songMetadata.tracksTotal);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.discsTotal).toBe(songMetadata.discsTotal);
	expect(readTags.date).toEqual(readTags.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
});

test('Conversion metadata tags, modified', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags(songMetadata);

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const output2 = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output: output2,
		tags: inputTags => ({
			title: 'Blossom',
			artist: inputTags.artist,
			raw: inputTags.raw, // This should NOT be copied
		}),
	});
	await conversion.execute();

	const input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(Object.keys(readTags).length).toBe(3);
	expect(readTags.title).toBe('Blossom');
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(Object.keys(readTags.raw!).length).toBe(2);
});

test('Read ID3v2 tags from WAV file', async () => {
	const filePath = path.join(import.meta.dirname, '../public/glitch-hop-is-dead.wav');

	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const tags = await input.getMetadataTags();

	const expectedTitle = 'Glitch Hop Is Dead';
	const expectedArtist = 'GRiZ';
	const expectedTrackNumber = 19;

	// Specific expectations for the test WAV file
	expect(tags.title).toBe(expectedTitle);
	expect(tags.artist).toBe(expectedArtist);
	expect(tags.trackNumber).toBe(expectedTrackNumber);

	if (!tags.images) {
		throw new Error('No images found in the file');
	}

	const frontCover = tags.images[0];

	if (!frontCover) {
		throw new Error('No front cover found in the file');
	}

	expect(frontCover.kind).toBe('coverFront');
	expect(frontCover.mimeType).toBe('image/jpg');
	expect(frontCover.data).toBeInstanceOf(Uint8Array);
	expect(frontCover.data.length).toBeGreaterThan(0);

	if (!tags.raw) {
		throw new Error('No raw tags found in the file');
	}

	expect(tags.raw['TIT2']).toBe(expectedTitle); // Title
	expect(tags.raw['TPE1']).toBe(expectedArtist); // Artist
	expect(tags.raw['TRCK']).toBe(String(expectedTrackNumber)); // Track number
	expect(tags.raw['APIC']).toBeInstanceOf(Uint8Array);
});

test('Write WAV with ID3 tags', async () => {
	const output = new Output({
		target: new BufferTarget(),
		format: new WavOutputFormat({ metadataFormat: 'id3' }),
	});

	output.setMetadataTags(songMetadata);

	const dummyTrack = createDummyAudioTrack('pcm-f32', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.artist).toBe(songMetadata.artist);
	expect(readTags.album).toBe(songMetadata.album);
	expect(readTags.albumArtist).toBe(songMetadata.albumArtist);
	expect(readTags.trackNumber).toBe(songMetadata.trackNumber);
	expect(readTags.discNumber).toBe(songMetadata.discNumber);
	expect(readTags.genre).toBe(songMetadata.genre);
	expect(readTags.comment).toBe(songMetadata.comment);
	expect(readTags.lyrics).toBe(songMetadata.lyrics);

	expect(readTags.date).toBeDefined();

	expect(readTags.raw).toBeDefined();
	if (readTags.raw) {
		// Verify RIFF INFO tags are not present
		expect(readTags.raw['INAM']).toBeUndefined();

		// Verify ID3 tags are also present
		expect(readTags.raw['TIT2']).toBe(songMetadata.title);
		expect(readTags.raw['TPE1']).toBe(songMetadata.artist);
		expect(readTags.raw['TALB']).toBe(songMetadata.album);
		expect(readTags.raw['TPE2']).toBe(songMetadata.albumArtist);
		expect(readTags.raw['TCON']).toBe(songMetadata.genre);
		expect(readTags.raw['COMM']).toBeDefined();
		expect(readTags.raw['USLT']).toBeDefined();
		expect(readTags.raw['TRCK']).toBe(`${songMetadata.trackNumber}/${songMetadata.tracksTotal}`);
		expect(readTags.raw['TPOS']).toBe(`${songMetadata.discNumber}/${songMetadata.discsTotal}`);
		expect(readTags.raw['TDRC']).toBeDefined();
	}
});
