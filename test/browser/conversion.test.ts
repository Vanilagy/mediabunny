import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { AdtsOutputFormat, HlsOutputFormat, Mp4OutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { BufferSource, PathedSource, UrlSource } from '../../src/source.js';
import { expect, test } from 'vitest';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { InputVideoTrack } from '../../src/input-track.js';
import { CanvasSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { QUALITY_HIGH } from '../../src/encode.js';
import { EncodedPacket } from '../../src/packet.js';

test('Rotation is baked in when rerendering', async () => {
	using input = new Input({
		source: new UrlSource('/rotate-buck-bunny.mp4'),
		formats: ALL_FORMATS,
	});

	const ogTrack = await input.getPrimaryVideoTrack();
	assert(ogTrack);

	expect(await ogTrack.getRotation()).toBe(90);
	expect(await ogTrack.getCodedWidth()).toBe(1920);
	expect(await ogTrack.getCodedHeight()).toBe(1080);
	expect(await ogTrack.getDisplayWidth()).toBe(1080);
	expect(await ogTrack.getDisplayHeight()).toBe(1920);

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, video: {
		width: 320,
	} });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getCodedWidth()).toBe(320);
	expect(await track.getCodedHeight()).toBe(570);
	expect(await track.getDisplayWidth()).toBe(320);
	expect(await track.getDisplayHeight()).toBe(570);
	expect(await track.getRotation()).toBe(0);
});

test('Exceeding max allowed track count', async () => {
	using input = new Input({
		source: new UrlSource('/multiple-aac-tracks.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new AdtsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	expect(conversion.utilizedTracks).toHaveLength(1);
	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_reached');
});

test('Fan-out', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: [{ height: 480 }, { height: 360 }],
		audio: [], // Identical to discarding it
		showWarnings: false,
	});
	expect(conversion.utilizedTracks).toHaveLength(2);
	expect(conversion.discardedTracks).toHaveLength(1);
	expect(conversion.discardedTracks[0]!.reason).toBe('discarded_by_user');

	await conversion.execute();

	using otherInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await otherInput.getTracks() as InputVideoTrack[];
	expect(tracks.map(x => x.type)).toEqual(['video', 'video']);

	expect(await tracks[0]!.getDisplayHeight()).toBe(480);
	expect(await tracks[1]!.getDisplayHeight()).toBe(360);
});

// eslint-disable-next-line @stylistic/max-len
const aacPacketData = new Uint8Array([255, 241, 77, 128, 3, 159, 252, 0, 208, 0, 1, 3, 64, 0, 13, 0, 0, 17, 52, 0, 0, 208, 0, 3, 6, 128, 0, 56]);
const aacMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

const addAacPackets = async (source: EncodedAudioPacketSource, durationSeconds: number) => {
	const packetDuration = 1024 / 48000;
	const count = Math.ceil(durationSeconds / packetDuration);
	for (let i = 0; i < count; i++) {
		await source.add(
			new EncodedPacket(aacPacketData, 'key', i * packetDuration, packetDuration),
			i === 0 ? aacMetadata : undefined,
		);
	}
};

const sanitizeMasterPlaylist = (text: string) => {
	return text.replace(/CODECS=".+?"/g, 'CODECS="?"');
};

test('HLS track assignability is kept #1', async () => {
	const files = new Map<string, ArrayBuffer>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(100, 100, 200, 200);

	const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
	output.addVideoTrack(videoSource);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 2, 1 / 2);
	}

	await addAacPackets(audioSource, 2);

	await output.finalize();

	const masterPlayist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlayist.match(/\.m3u8/g)?.length).toBe(1);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new PathedSource(
			'master.m3u8',
			({ path }) => new BufferSource(files.get(path)!),
		),
	});

	const newOutput = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'new/master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const conversion = await Conversion.init({ input, output: newOutput });
	await conversion.execute();

	const newMasterPlayist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlayist).toBe(masterPlayist);
});

test('HLS track assignability is kept #2', async () => {
	const files = new Map<string, ArrayBuffer>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(100, 100, 200, 200);

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
	output.addVideoTrack(videoSource, { group: a });

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource, { group: b });

	await output.start();

	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 2, 1 / 2);
	}

	await addAacPackets(audioSource, 2);

	await output.finalize();

	const masterPlayist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlayist.match(/\.m3u8/g)?.length).toBe(2);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new PathedSource(
			'master.m3u8',
			({ path }) => new BufferSource(files.get(path)!),
		),
	});

	const newOutput = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'new/master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const conversion = await Conversion.init({ input, output: newOutput });
	await conversion.execute();

	const newMasterPlayist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlayist).toBe(masterPlayist);
});

test('HLS track assignability can be overridden', async () => {
	const files = new Map<string, ArrayBuffer>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const canvas = new OffscreenCanvas(1280, 720);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(100, 100, 200, 200);

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
	output.addVideoTrack(videoSource, { group: a });

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource, { group: b });

	await output.start();

	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 2, 1 / 2);
	}

	await addAacPackets(audioSource, 2);

	await output.finalize();

	const masterPlayist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlayist.match(/\.m3u8/g)?.length).toBe(2);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new PathedSource(
			'master.m3u8',
			({ path }) => new BufferSource(files.get(path)!),
		),
	});

	const newOutput = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget(
			'new/master.m3u8',
			({ path }) => {
				const target = new BufferTarget();
				target.on('finalized', () => {
					files.set(path, target.buffer!);
				});

				return target;
			},
		),
	});

	const conversion = await Conversion.init({
		input,
		output: newOutput,
		video: { group: newOutput.defaultTrackGroup },
		audio: { group: newOutput.defaultTrackGroup },
	});
	await conversion.execute();

	const newMasterPlayist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlayist).not.toBe(masterPlayist);
	expect(newMasterPlayist.match(/\.m3u8/g)?.length).toBe(1);
});
