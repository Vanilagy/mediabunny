import { expect, onTestFinished, test, vi } from 'vitest';
import { Output } from '../../src/output.js';
import {
	AdtsOutputFormat,
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
import { VERSIONED_NAME } from '../../src/version.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioCodec, buildAudioCodecString } from '../../src/codec.js';
import { Conversion } from '../../src/conversion.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
						codec: buildAudioCodecString(codec),
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
	beatsPerMinute: 128,
	date: new Date('2021-04-23'),
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
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
	expect(readTags.beatsPerMinute).toBeUndefined();
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
	expect(readTags.date).toEqual(songMetadata.date);
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
	expect(readTags.beatsPerMinute).toBeUndefined();
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
	expect(readTags.date).toEqual(songMetadata.date);
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

test('FFmpeg-unsafe raw udta tags, MP4', async () => {
	const hmmt = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 250]);

	for (const metadataFormat of ['mdir', 'mdta', 'udta'] as const) {
		const output = new Output({
			format: new Mp4OutputFormat({ metadataFormat }),
			target: new BufferTarget(),
		});

		output.setMetadataTags({
			raw: {
				HMMT: hmmt,
				cust: new Uint8Array([1, 2, 3, 4]),
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

		// FFmpeg would misparse HMMT as an ilst item, so it's only dropped in that case
		expect(readTags.raw!['HMMT']).toEqual(metadataFormat === 'mdir' ? undefined : hmmt);
		expect(readTags.raw!['cust']).toEqual(new Uint8Array([1, 2, 3, 4]));
	}
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
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
			TXXZ: '鱼',
			TXXX: {
				foo: 'bar',
				baz: 'qux',
				你: '好',
			},
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in ID3v2

	expect(readTags.raw!['TIT2']).toBe(songMetadata.title);
	expect(readTags.raw!['APIC']).instanceOf(Uint8Array);
	expect(readTags.raw!['TXXY']).toBe('ID3v2 goated');
	expect(readTags.raw!['TXXZ']).toBe('鱼');
	expect(readTags.raw!['TXXX']).toEqual({
		foo: 'bar',
		baz: 'qux',
		你: '好',
	});
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in Vorbis-style metadata

	expect(readTags.raw!['vendor']).toBe(VERSIONED_NAME);
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
	expect(readTags.images).toHaveLength(1);
	expect(readTags.images![0]!.data).toEqual(coverArt);
	expect(readTags.images![0]!.mimeType).toEqual('image/jpeg');
	expect(readTags.images![0]!.kind).toEqual('coverFront');
	expect(readTags.images![0]!.description).toEqual(songMetadata.images![0]!.description);
	expect(readTags.images![0]!.name).toBeUndefined(); // Can't be contained in Vorbis-style metadata

	expect(readTags.raw!['vendor']).toBe(VERSIONED_NAME);
	expect(readTags.raw!['COMPOSER']).toBe('Hans Zimmer');
});

test('Read and write metadata, ADTS', async () => {
	const originalInput = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input: originalInput,
		output,
		tags: {
			...songMetadata,
			raw: {
				TXXY: 'ID3v2 goated',
			},
		},
	});
	await conversion.execute();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	// ID3v2 is goated, so pretty much everything was copied:
	expect(readTags.title).toBe(songMetadata.title);
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
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
	expect(readTags.beatsPerMinute).toBeUndefined();
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
	expect(readTags.date).toEqual(songMetadata.date);
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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
	expect(readTags.date).toEqual(songMetadata.date);
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

	expect(Object.keys(readTags).length).toBe(4);
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
	expect(readTags.beatsPerMinute).toBe(songMetadata.beatsPerMinute);
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

test('Default creation time, ISOBMFF', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
	vi.setSystemTime(new Date('2024-02-29T13:37:42.123Z'));

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
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

	// The format only stores whole seconds
	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42Z'));
});

test('Default creation time, Matroska', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
	vi.setSystemTime(new Date('2024-02-29T13:37:42.123Z'));

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
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

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));
});

test('Creation time override, ISOBMFF', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2024-02-29T13:37:42Z') });

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42Z'));

	const nullOutput = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	nullOutput.setMetadataTags({ creationTime: null });

	const nullDummyTrack = createDummyAudioTrack('opus', nullOutput);

	await nullOutput.start();
	await nullDummyTrack.addPacket();
	await nullOutput.finalize();

	using nullInput = new Input({
		source: new BufferSource(nullOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const nullReadTags = await nullInput.getMetadataTags();

	expect(nullReadTags.creationTime).toBeUndefined();
});

test('Creation time override, Matroska', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2024-02-29T13:37:42.123Z') });

	const dummyTrack = createDummyAudioTrack('opus', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));

	const nullOutput = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	nullOutput.setMetadataTags({ creationTime: null });

	const nullDummyTrack = createDummyAudioTrack('opus', nullOutput);

	await nullOutput.start();
	await nullDummyTrack.addPacket();
	await nullOutput.finalize();

	using nullInput = new Input({
		source: new BufferSource(nullOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const nullReadTags = await nullInput.getMetadataTags();

	expect(nullReadTags.creationTime).toBeUndefined();
});

test('Creation time not copied in conversion', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2010-01-01T00:00:00Z') });

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

	vi.useFakeTimers({ toFake: ['Date'] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
	vi.setSystemTime(new Date('2024-02-29T13:37:42.123Z'));

	const conversion = await Conversion.init({ input, output: output2 });
	await conversion.execute();

	using input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));
});

test('Creation time override in conversion', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	output.setMetadataTags({ creationTime: new Date('2010-01-01T00:00:00Z') });

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
		tags: { creationTime: new Date('2024-02-29T13:37:42.123Z') },
	});
	await conversion.execute();

	using input2 = new Input({
		source: new BufferSource(output2.target.buffer!),
		formats: ALL_FORMATS,
	});

	const readTags = await input2.getMetadataTags();

	expect(readTags.creationTime).toEqual(new Date('2024-02-29T13:37:42.123Z'));

	const nullOutput = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const nullConversion = await Conversion.init({
		input,
		output: nullOutput,
		tags: { creationTime: null },
	});
	await nullConversion.execute();

	using nullInput = new Input({
		source: new BufferSource(nullOutput.target.buffer!),
		formats: ALL_FORMATS,
	});

	const nullReadTags = await nullInput.getMetadataTags();

	expect(nullReadTags.creationTime).toBeUndefined();
});

test('ID3v2.3 unsynchronisation', async () => {
	const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0x00, 0xff]);
	const body = concat([
		frame('APIC', concat([latin1('\x00image/jpeg\x00\x03\x00'), image])),
		frame('TIT2', latin1('\x00Title')),
	]);
	const tags = await readId3V2Tag(3, 0x80, unsynchronize(body));

	expect(tags.images![0]!.data).toEqual(image);
	expect(tags.title).toBe('Title');
});

test('ID3v2.2 unsynchronisation', async () => {
	const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0x00, 0xff]);
	const body = concat([
		frame('PIC', concat([latin1('\x00JPG\x03\x00'), image])),
		frame('TT2', latin1('\x00Title')),
	]);
	const tags = await readId3V2Tag(2, 0x80, unsynchronize(body));

	expect(tags.images![0]!.data).toEqual(image);
	expect(tags.title).toBe('Title');
});

const unsynchronize = (bytes: Uint8Array) => {
	const result: number[] = [];
	for (const byte of bytes) {
		result.push(byte);
		if (byte === 0xff) {
			result.push(0x00);
		}
	}

	return new Uint8Array(result);
};

test('ID3v2.4 non-synchsafe frame sizes', async () => {
	// Old iTunes versions wrote plain frame sizes into ID3v2.4 tags
	const image = new Uint8Array(300).fill(1);
	const body = concat([
		frame('APIC', concat([latin1('\x00image/png\x00\x03\x00'), image])),
		frame('TIT2', latin1('\x00Title')),
	]);
	const tags = await readId3V2Tag(4, 0, body);

	expect(tags.images![0]!.data).toEqual(image);
	expect(tags.title).toBe('Title');
});

test('ID3v2.4 data length indicator', async () => {
	const tags = await readId3V2Tag(4, 0, frame('TIT2', latin1('\x00\x00\x00\x06\x00Title'), 0x0001));
	expect(tags.title).toBe('Title');
});

test('Empty UTF-16 strings without BOM', async () => {
	const image = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
	const body = concat([
		frame('COMM', latin1('\x01eng\x00\x00\xff\xfeH\x00i\x00\x00\x00')),
		frame('APIC', concat([latin1('\x01image/jpeg\x00\x03\x00\x00'), image])),
	]);
	const tags = await readId3V2Tag(3, 0, body);

	expect(tags.comment).toBe('Hi');
	expect(tags.images![0]!.data).toEqual(image);
});

test('APIC with UTF-16BE description', async () => {
	const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const tags = await readId3V2Tag(4, 0, frame('APIC', concat([latin1('\x02image/png\x00\x03\x00C\x00\x00'), image])));

	expect(tags.images![0]!.mimeType).toBe('image/png');
	expect(tags.images![0]!.description).toBe('C');
	expect(tags.images![0]!.data).toEqual(image);
});

test('Described COMM frame ahead of plain one', async () => {
	// iTunes keeps its own data in COMM frames with a description
	const body = concat([
		frame('COMM', latin1('\x00engiTunNORM\x00 00000A3B 00000A3B')),
		frame('COMM', latin1('\x00eng\x00Comment')),
	]);
	const tags = await readId3V2Tag(3, 0, body);

	expect(tags.comment).toBe('Comment');
});

test('Described COMM frame only', async () => {
	const tags = await readId3V2Tag(3, 0, frame('COMM', latin1('\x00engiTunNORM\x00 00000A3B 00000A3B')));
	expect(tags.comment).toBeUndefined();
});

test('TDAT ahead of TYER', async () => {
	// Mutagen writes the frames in this order
	const body = concat([
		frame('TDAT', latin1('\x002304')),
		frame('TYER', latin1('\x002021')),
	]);
	const tags = await readId3V2Tag(3, 0, body);

	expect(tags.date).toEqual(new Date('2021-04-23'));
});

test('TYER holding a full date', async () => {
	// As found in oversized-id3.wav
	const tags = await readId3V2Tag(3, 0, frame('TYER', latin1('\x0020190103')));
	expect(tags.date).toBeUndefined();
});

test('ID3v1 year below 100', async () => {
	const id3V1Tag = new Uint8Array(128);
	id3V1Tag.set(latin1('TAG'));
	id3V1Tag.set(latin1('13'), 93);

	const tags = await readMetadataTags(concat([mp3Frame(), mp3Frame(), id3V1Tag]));
	expect(tags.date).toEqual(new Date('0013-01-01T00:00:00Z'));
});

test('Zero BPM', async () => {
	const tags = await readId3V2Tag(4, 0, frame('TBPM', latin1('\x000')));
	expect(tags.beatsPerMinute).toBeUndefined();
});

test('ID3v2.2 compression flag', async () => {
	// No compression scheme was ever defined, so the tag can't be read - even if its data looks like an extended header
	const tags = await readId3V2Tag(2, 0x40, concat([new Uint8Array([0, 0, 0, 4]), frame('TT2', latin1('\x00Title'))]));
	expect(tags.title).toBeUndefined();
});

test('ID3v2.3 footer flag', async () => {
	// Footers only exist since ID3v2.4, so the flag mustn't make us skip into the audio data
	using input = new Input({
		source: new BufferSource(concat([
			createId3V2Tag(3, 0x10, frame('TIT2', latin1('\x00Title'))),
			mp3Frame(),
			mp3Frame(),
		])),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryAudioTrack())!;

	expect(await track.computeDuration()).toBe(2 * 1152 / 44100);
	expect((await input.getMetadataTags()).title).toBe('Title');
});

test('Grouping identity', async () => {
	const v3Tags = await readId3V2Tag(3, 0, frame('TIT2', latin1('\x07\x00Title'), 0x0020));
	expect(v3Tags.title).toBe('Title');

	// The group byte comes before the data length indicator
	const v4Tags = await readId3V2Tag(4, 0, frame('TIT2', latin1('\x07\x00\x00\x00\x06\x00Title'), 0x0041));
	expect(v4Tags.title).toBe('Title');
});

test('ID3v2.2 TXX', async () => {
	const tags = await readId3V2Tag(2, 0, frame('TXX', latin1('\x00Description\x00Value')));
	expect(tags.raw!['TXX']).toEqual({ Description: 'Value' });
});

test('TDRC with a time', async () => {
	// ID3v2.4 timestamps are always UTC, so the local time zone mustn't matter
	vi.stubEnv('TZ', 'America/New_York');
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});

	const tags = await readId3V2Tag(4, 0, frame('TDRC', latin1('\x002021-04-23T12:00')));
	expect(tags.date).toEqual(new Date('2021-04-23T12:00:00Z'));
});

test('Malformed TDRC', async () => {
	const tags = await readId3V2Tag(4, 0, frame('TDRC', latin1('\x0012')));
	expect(tags.date).toBeUndefined();
});

test('TDAT past the end of the month', async () => {
	const body = concat([
		frame('TYER', latin1('\x002021')),
		frame('TDAT', latin1('\x003102')),
	]);
	const tags = await readId3V2Tag(3, 0, body);

	expect(tags.date).toEqual(new Date('2021-01-01T00:00:00Z'));
});

test('ID3v2.4 non-synchsafe frame size with high bits', async () => {
	// A size of 0x180 can't be synchsafe, but read as one, it would point at the zeros
	const image = new Uint8Array(0x180 - 13).fill(1);
	image.fill(0, 0x80 - 13, 0x80 - 13 + 4);
	const body = concat([
		frame('APIC', concat([latin1('\x00image/png\x00\x03\x00'), image])),
		frame('TIT2', latin1('\x00Title')),
	]);
	const tags = await readId3V2Tag(4, 0, body);

	expect(tags.images![0]!.data).toEqual(image);
	expect(tags.title).toBe('Title');
});

test('ID3v2.4 extended header', async () => {
	const extendedHeader = new Uint8Array(200);
	new DataView(extendedHeader.buffer).setUint32(0, synchsafe(extendedHeader.length));
	extendedHeader[4] = 1; // Number of flag bytes

	const tags = await readId3V2Tag(4, 0x40, concat([extendedHeader, frame('TIT2', latin1('\x00Title'))]));
	expect(tags.title).toBe('Title');
});

const readId3V2Tag = async (majorVersion: number, flags: number, body: Uint8Array) => {
	return readMetadataTags(concat([createId3V2Tag(majorVersion, flags, body), mp3Frame(), mp3Frame()]));
};

const createId3V2Tag = (majorVersion: number, flags: number, body: Uint8Array) => {
	const header = new Uint8Array(10);
	header.set(latin1('ID3'));
	header[3] = majorVersion;
	header[5] = flags;
	new DataView(header.buffer).setUint32(6, synchsafe(body.length));

	return concat([header, body]);
};

const synchsafe = (value: number) => {
	return (value & 0x7f)
		| ((value << 1) & 0x7f00)
		| ((value << 2) & 0x7f0000)
		| ((value << 3) & 0x7f000000);
};

const frame = (id: string, data: Uint8Array, flags = 0) => {
	if (id.length === 3) {
		const size = data.length;
		return concat([latin1(id), new Uint8Array([size >> 16, (size >> 8) & 0xff, size & 0xff]), data]);
	}

	const header = new Uint8Array(10);
	header.set(latin1(id));
	const view = new DataView(header.buffer);
	view.setUint32(4, data.length);
	view.setUint16(8, flags);

	return concat([header, data]);
};

const concat = (parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

const latin1 = (text: string) => {
	return Uint8Array.from(text, char => char.charCodeAt(0));
};

const mp3Frame = () => {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz
	const bytes = new Uint8Array(417);
	bytes.set([0xff, 0xfb, 0x90, 0x64]);
	return bytes;
};

test('Non-Latin-1 lyrics', async () => {
	const lyrics = String.fromCharCode(0x6b4c, 0x8a5e);
	const tags = await readMetadataTags(await writeMp3({
		lyrics,
		comment: 'Comment',
	}));

	expect(tags.lyrics).toBe(lyrics);
	expect(tags.comment).toBe('Comment');
});

test('MP3 to MP3 conversion with images', async () => {
	using input = new Input({
		source: new BufferSource(await writeMp3({
			images: [{
				data: new Uint8Array([1, 2, 3]),
				mimeType: 'image/png',
				kind: 'coverFront',
			}],
		})),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
	});
	await conversion.execute();

	const tags = await readMetadataTags(new Uint8Array(output.target.buffer!));
	expect(tags.images).toHaveLength(1);
});

test('APIC with non-ASCII MIME type and non-Latin-1 description', async () => {
	// Both strings then get written as UTF-8, where the MIME type takes up more bytes than characters
	const data = new Uint8Array([1, 2, 3]);
	const tags = await readMetadataTags(await writeMp3({
		images: [{
			data,
			mimeType: 'image/pég',
			kind: 'coverFront',
			description: String.fromCharCode(0x6b4c),
		}],
		title: 'Title',
	}));

	expect(tags.images![0]!.data).toEqual(data);
	expect(tags.title).toBe('Title');
});

const writeMp3 = async (tags: MetadataTags) => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});
	output.setMetadataTags(tags);

	const dummyTrack = createDummyAudioTrack('mp3', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const readMetadataTags = async (bytes: Uint8Array) => {
	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	return await input.getMetadataTags();
};

test('Image with non-string name or description', () => {
	const output = new Output({
		format: new Mp3OutputFormat(),
		target: new BufferTarget(),
	});

	expect(() => output.setMetadataTags({
		images: [{
			data: new Uint8Array([1, 2, 3]),
			mimeType: 'image/png',
			kind: 'coverFront',
			name: 5 as unknown as string,
		}],
	})).toThrow(TypeError);
	expect(() => output.setMetadataTags({
		images: [{
			data: new Uint8Array([1, 2, 3]),
			mimeType: 'image/png',
			kind: 'coverFront',
			description: 5 as unknown as string,
		}],
	})).toThrow(TypeError);
});

test('ID3v2 year below 100', async () => {
	await testWaveFileDate(
		new WavOutputFormat({ metadataFormat: 'id3' }),
		{ TYER: '12' },
		new Date('0012-01-01T00:00:00Z'),
	);
});

test('RIFF INFO year', async () => {
	// Jan 1 in UTC, like any other year-only date, regardless of the local time zone
	await testWaveFileDate(new WavOutputFormat(), { YEAR: '2013' }, new Date('2013-01-01T00:00:00Z'));
});

const testWaveFileDate = async (format: WavOutputFormat, rawTags: MetadataTags['raw'], expectedDate: Date) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});
	output.setMetadataTags({ raw: rawTags });

	const dummyTrack = createDummyAudioTrack('pcm-s16', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect((await input.getMetadataTags()).date).toEqual(expectedDate);
};

test('RIFF INFO strings in UTF-8 and Latin-1', async () => {
	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});
	output.setMetadataTags({
		title: String.fromCharCode(...new TextEncoder().encode('Café ☕')),
		artist: 'Motörhead',
	});

	const dummyTrack = createDummyAudioTrack('pcm-s16', output);

	await output.start();
	await dummyTrack.addPacket();
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('Café ☕');
	expect(tags.artist).toBe('Motörhead');
});
