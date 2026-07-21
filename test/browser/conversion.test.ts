import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import {
	AdtsOutputFormat,
	HlsOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { BufferSource, CustomPathedSource, UrlSource } from '../../src/source.js';
import { expect, test } from 'vitest';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { Conversion, ConversionCanceledError } from '../../src/conversion.js';
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

	const masterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlaylist.match(/\.m3u8/g)?.length).toBe(1);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource(
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

	const newMasterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlaylist).toBe(masterPlaylist);
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

	const masterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlaylist.match(/\.m3u8/g)?.length).toBe(2);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource(
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

	const newMasterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlaylist).toBe(masterPlaylist);
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

	const masterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('master.m3u8')));
	expect(masterPlaylist.match(/\.m3u8/g)?.length).toBe(2);

	using input = new Input({
		formats: ALL_FORMATS,
		source: new CustomPathedSource(
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

	const newMasterPlaylist = sanitizeMasterPlaylist(new TextDecoder().decode(files.get('new/master.m3u8')));
	expect(newMasterPlaylist).not.toBe(masterPlaylist);
	expect(newMasterPlaylist.match(/\.m3u8/g)?.length).toBe(1);
});

test('Fractional audio sample boundary', async () => {
	using input = new Input({
		source: new UrlSource('/trim-buck-bunny-ffmpeg.ts'),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new WavOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			discard: true,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: 0.4 / 48000,
		},
	});
	await conversion.execute();
});

test('Owning conversion requires a fresh output', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // Makes the output non-fresh

	await expect(Conversion.init({ input, output })).rejects.toThrow(/must be fresh/);
});

test('Non-owning init works on an output that already has a track, but not on a started one', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // A user-added track

	const conversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		audio: { discard: true }, // Only contribute the video track
		showWarnings: false,
	});
	expect(conversion.isValid).toBe(true);
	expect(conversion.utilizedTracks).toHaveLength(1);
	expect(conversion.utilizedTracks[0]!.type).toBe('video');

	const startedOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	startedOutput.addAudioTrack(new EncodedAudioPacketSource('aac'));
	await startedOutput.start();

	await expect(Conversion.init({ input, output: startedOutput, ownsOutput: false }))
		.rejects.toThrow(/not have been started/);

	await startedOutput.cancel();
});

test('Non-owning conversion rejects tags', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const makeOutput = () => new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	await expect(Conversion.init({
		input,
		output: makeOutput(),
		ownsOutput: false,
		tags: { title: 'Not allowed' },
	})).rejects.toThrow(/tags cannot be set by a non-owning conversion/);
});

test('Non-owning conversion composes with a user-added track', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		audio: { discard: true }, // The user provides their own audio track
		showWarnings: false,
	});
	expect(conversion.utilizedTracks).toHaveLength(1);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	await Promise.all([
		conversion.execute(),
		(async () => {
			await addAacPackets(audioSource, 5);
			audioSource.close();
		})(),
	]);

	// The non-owning conversion must not have finalized the output
	expect(output.state).toBe('started');

	await output.finalize();
	expect(output.state).toBe('finalized');

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await result.getTracks();
	expect(tracks.map(t => t.type).sort()).toEqual(['audio', 'video']);

	const videoTrack = await result.getPrimaryVideoTrack();
	const audioTrack = await result.getPrimaryAudioTrack();
	expect(videoTrack).not.toBeNull();
	expect(audioTrack).not.toBeNull();
	expect(await videoTrack!.getCodec()).toBe('avc');
	expect(await audioTrack!.getCodec()).toBe('aac');
	expect(await videoTrack!.computeDuration()).toBeGreaterThan(4);
});

test('Two non-owning conversions compose into one output', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const videoConversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		audio: { discard: true },
		showWarnings: false,
	});
	const audioConversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		video: { discard: true },
		showWarnings: false,
	});
	expect(videoConversion.utilizedTracks).toHaveLength(1);
	expect(videoConversion.utilizedTracks[0]!.type).toBe('video');
	expect(audioConversion.utilizedTracks).toHaveLength(1);
	expect(audioConversion.utilizedTracks[0]!.type).toBe('audio');

	await output.start();
	await Promise.all([videoConversion.execute(), audioConversion.execute()]);
	expect(output.state).toBe('started');

	await output.finalize();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const tracks = await result.getTracks();
	expect(tracks.map(t => t.type).sort()).toEqual(['audio', 'video']);
	expect(await (await result.getPrimaryVideoTrack())!.getCodec()).toBe('avc');
	expect(await (await result.getPrimaryAudioTrack())!.getCodec()).toBe('aac');
});

test('Non-owning conversion does not write metadata tags', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	// Sanity check: this input carries metadata tags that an owning conversion would copy over
	const inputTags = await input.getMetadataTags();
	expect(inputTags.comment).toBeDefined();

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		audio: { discard: true },
		showWarnings: false,
	});

	// The conversion must not have touched the output's metadata tags
	expect(Object.keys(output._metadataTags)).toHaveLength(0);

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	// The user sets their own tags; these must survive
	output.setMetadataTags({ comment: 'User-owned' });

	await output.start();
	await Promise.all([
		conversion.execute(),
		(async () => {
			await addAacPackets(audioSource, 5);
			audioSource.close();
		})(),
	]);
	await output.finalize();

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const outTags = await result.getMetadataTags();
	// Only the user's tag is present; the input's tags were not copied
	expect(outTags.comment).toBe('User-owned');
});

test('Canceling a non-owning conversion leaves the output usable', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		audio: { discard: true },
		showWarnings: false,
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	const executePromise = conversion.execute();
	void conversion.cancel();

	await expect(executePromise).rejects.toBeInstanceOf(ConversionCanceledError);

	// The output must not have been canceled by the non-owning conversion
	expect(output.state).toBe('started');

	// The user's own track can still finish, and the output can still be finalized
	await addAacPackets(audioSource, 2);
	audioSource.close();
	await output.finalize();
	expect(output.state).toBe('finalized');

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const audioTrack = await result.getPrimaryAudioTrack();
	expect(audioTrack).not.toBeNull();
	expect(await audioTrack!.getCodec()).toBe('aac');
});

test('Track capacity works correctly with non-owning conversions', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	// The user already occupies the single audio slot that WAVE allows
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));

	const conversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		showWarnings: false,
	});

	// The conversion's audio track has no room left, so it gets discarded
	expect(conversion.isValid).toBe(true);
	expect(conversion.utilizedTracks).toHaveLength(0);
	expect(conversion.discardedTracks).toHaveLength(2);
	// WAVE allows only one track in total, so the total-count check fires before the per-type one
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_reached');
});
