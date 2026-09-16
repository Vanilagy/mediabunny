import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import {
	AdtsOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	Mp4OutputFormat,
	MpegTsOutputFormat,
	OutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { Output, OutputTrackGroup } from '../../src/output.js';
import { BufferSource, CustomPathedSource, UrlSource } from '../../src/source.js';
import { expect, test } from 'vitest';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { Conversion, ConversionCanceledError, ConversionOptions } from '../../src/conversion.js';
import { assert, uint8ArraysAreEqual } from '../../src/misc.js';
import { InputVideoTrack } from '../../src/input-track.js';
import { CanvasSource, EncodedAudioPacketSource } from '../../src/media-source.js';
import { Quality } from '../../src/encode.js';
import { EncodedPacket } from '../../src/packet.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

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

test('Flip is forwarded as metadata when copying', async () => {
	const buffer = await encodeFlippedVideo();
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getRotation()).toBe(90);
	expect(await track.getFlip()).toBe(true);
});

test('Flip is baked in when rerendering', async () => {
	const buffer = await encodeFlippedVideo();
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({ input, output, video: {
		width: 80,
	} });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	expect(await track.getRotation()).toBe(0);
	expect(await track.getFlip()).toBe(false);
	expect(await track.getCodedWidth()).toBe(80);
	expect(await track.getCodedHeight()).toBe(160);
});

test('Additional flip is composed with the input flip', async () => {
	const buffer = await encodeFlippedVideo();
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const conversion = await Conversion.init({
		input,
		output,
		copy: { mode: 'forced' },
		video: { flip: true },
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	// The two flips cancel out
	expect(await track.getRotation()).toBe(90);
	expect(await track.getFlip()).toBe(false);
});

/** A short 320x160 video with rotation 90 and flip metadata. */
const encodeFlippedVideo = async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const canvas = new OffscreenCanvas(320, 160);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = 'red';
	ctx.fillRect(0, 0, 320, 160);

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
	output.addVideoTrack(videoSource, {
		rotation: 90,
		flip: true,
	});

	await output.start();
	for (let i = 0; i < 4; i++) {
		await videoSource.add(i / 4, 1 / 4);
	}
	await output.finalize();

	return output.target.buffer!;
};

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

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
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

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
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

	const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
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

test('Non-composable conversion requires a fresh output', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // Makes the output non-fresh

	await expect(Conversion.init({ input, output })).rejects.toThrow(/must be fresh/);
});

test('Composable init works on an output that already has a track, but not on a started one', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // A user-added track

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true }, // Only contribute the video track
		showWarnings: false,
	});
	expect(conversion.isValid).toBe(true);
	expect(conversion.utilizedTracks).toHaveLength(1);
	expect(conversion.utilizedTracks[0]!.type).toBe('video');

	const startedOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	startedOutput.addAudioTrack(new EncodedAudioPacketSource('aac'));
	await startedOutput.start();

	await expect(Conversion.init({ input, output: startedOutput, composable: true }))
		.rejects.toThrow(/not have been started/);

	await startedOutput.cancel();
});

test('Composable conversion rejects tags', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const makeOutput = () => new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	await expect(Conversion.init({
		input,
		output: makeOutput(),
		composable: true,
		tags: { title: 'Not allowed' },
	})).rejects.toThrow(/tags cannot be set by a composable conversion/);
});

test('Composable conversion composes with a user-added track', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
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

	// The composable conversion must not have finalized the output
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

test('Two composable conversions compose into one output', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const videoConversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true },
		showWarnings: false,
	});
	const audioConversion = await Conversion.init({
		input,
		output,
		composable: true,
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

test('Composable conversion does not write metadata tags', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	// Sanity check: this input carries metadata tags that a non-composable conversion would copy over
	const inputTags = await input.getMetadataTags();
	expect(inputTags.comment).toBeDefined();

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
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

test('Canceling a composable conversion leaves the output usable', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const conversion = await Conversion.init({
		input,
		output,
		composable: true,
		audio: { discard: true },
		showWarnings: false,
	});

	const audioSource = new EncodedAudioPacketSource('aac');
	output.addAudioTrack(audioSource);

	await output.start();

	const executePromise = conversion.execute();
	void conversion.cancel();
	expect(conversion.state).toBe('canceled');

	await expect(executePromise).rejects.toBeInstanceOf(ConversionCanceledError);

	// The output must not have been canceled by the composable conversion
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

test('Track capacity works correctly with composable conversions', async () => {
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
		composable: true,
		showWarnings: false,
	});

	// The conversion's audio track has no room left, so it gets discarded
	expect(conversion.isValid).toBe(true);
	expect(conversion.utilizedTracks).toHaveLength(0);
	expect(conversion.discardedTracks).toHaveLength(2);
	// WAVE allows only one track in total, so the total-count check fires before the per-type one
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_reached');
});

test('Blank execute', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });
	expect(conversion.state).toBe('idle');

	const promise = conversion.execute();
	expect(conversion.state).toBe('executing');
	await promise;
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');
});

test('Stepwise until', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });

	await conversion.execute({ until: 2 });
	expect(conversion.state).toBe('idle');
	expect(output.state).toBe('started');
	await conversion.execute({ until: 4 });
	expect(conversion.state).toBe('idle');
	await conversion.execute({ until: 6 });
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');

	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const videoTrack = await result.getPrimaryVideoTrack();
	expect(await videoTrack!.computeDuration()).toBeGreaterThan(4);
});

test('Pause signal', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });

	const controller = new AbortController();
	conversion.onProgress = (progress) => {
		if (progress >= 0.5 && !controller.signal.aborted) {
			controller.abort();
		}
	};

	await conversion.execute({ pauseSignal: controller.signal });
	expect(conversion.state).toBe('idle');
	expect(output.state).toBe('started');

	await conversion.execute();
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');
});

test('Pre-signaled pause signal', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output });

	const controller = new AbortController();
	controller.abort();

	await conversion.execute({ pauseSignal: controller.signal });
	expect(conversion.state).toBe('idle');
	expect(output.state).toBe('started');

	await conversion.execute();
	expect(conversion.state).toBe('done');
	expect(output.state).toBe('finalized');

	await conversion.execute();
	expect(conversion.state).toBe('done');
});

test('Resizing at various scale factors', async () => {
	// The source is 1080p. 720p downscales by less than 2x, 240p downscales by more than 2x (which kicks in the manual
	// mipmapping path), and 1440p upscales.
	for (const height of [720, 240, 1440]) {
		using input = new Input({
			source: new UrlSource('/video.mp4'),
			formats: ALL_FORMATS,
		});

		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({
			input,
			output,
			video: { height },
			trim: { end: 1 },
		});
		await conversion.execute();

		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const videoTrack = await result.getPrimaryVideoTrack();
		expect(await videoTrack!.getDisplayHeight()).toBe(height);
	}
});

test('Packet copy, whole file', async () => {
	await testCopy({
		conversionOptions: {},
		expectedTimeOffset: 0,
		videoStartTimestamp: 0,
		videoEndTimestamp: 5,
		audioStartTimestamp: -1024 / 48000,
		audioEndTimestamp: 5,
	});
});

test('Packet copy, keyframe trim', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1,
				end: 2,
			},
		},
		expectedTimeOffset: 1,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1,
		audioStartTimestamp: -0.04,
		audioEndTimestamp: 1.0053333333333334,
	});
});

test('Packet copy, keyframe trim, shrink', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1,
				end: 2,
			},
			copy: {
				boundaryPolicy: 'shrink',
			},
		},
		expectedTimeOffset: 1,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1,
		audioStartTimestamp: -0.04 + 2 * 1024 / 48000,
		audioEndTimestamp: 1.0053333333333334 - 1024 / 48000,
	});
});

test('Packet copy, delta frame trim', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
		},
		expectedTimeOffset: 1.5,
		videoStartTimestamp: -0.5,
		videoEndTimestamp: 1.02,
		audioStartTimestamp: -0.028,
		audioEndTimestamp: 1.0173333333333334,
	});
});

test('Packet copy, delta frame trim, shrink', async () => {
	await testCopy({
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				boundaryPolicy: 'shrink',
			},
		},
		expectedTimeOffset: 1.5,
		videoStartTimestamp: 0.5,
		videoEndTimestamp: 1.02, // Due to MP4 not being able to express a different duration for the last packet
		audioStartTimestamp: -0.028 + 2 * 1024 / 48000,
		audioEndTimestamp: 1.0173333333333334 - 1024 / 48000,
	});
});

test('Packet copy, whole file, Matroska', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			copy: {
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: -1024 / 48000,
		videoStartTimestamp: 0 + 1024 / 48000,
		videoEndTimestamp: 5 + 1024 / 48000 - 1 / 25,
		audioStartTimestamp: 0,
		audioEndTimestamp: 235 * 1024 / 48000,
		precision: 0.001,
	});
});

test('Packet copy, whole file, Matroska, forced', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			copy: {
				mode: 'forced',
			},
		},
		expectedTimeOffset: 0,
		videoStartTimestamp: 0,
		videoEndTimestamp: 5 - 1 / 25,
		audioStartTimestamp: -1024 / 48000,
		audioEndTimestamp: 4.992,
		precision: 0.001,
	});
});

test('Packet copy, delta frame trim, Matroska', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: 1,
		videoStartTimestamp: 0,
		videoEndTimestamp: 1.48,
		audioStartTimestamp: 0.472,
		audioEndTimestamp: 1.496,
		precision: 0.001,
	});
});

test('Packet copy, delta frame trim, video transcoded, Matroska', async () => {
	await testCopy({
		outputFormat: new MkvOutputFormat(),
		conversionOptions: {
			video: {
				forceTranscode: true,
				codec: 'vp9',
			},
			trim: {
				start: 1.5,
				end: 2.5,
			},
			copy: {
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: 1.472,
		videoStartTimestamp: 0.028,
		videoEndTimestamp: 1.008,
		audioStartTimestamp: 0,
		audioEndTimestamp: 1.024,
		precision: 0.001,
		compareVideoPackets: false,
	});
});

test('Packet copy, whole file, ADTS', async () => {
	await testCopy({
		outputFormat: new AdtsOutputFormat(),
		conversionOptions: {
			video: {
				discard: true,
			},
			copy: {
				mode: 'forced',
				shiftTolerance: Infinity,
			},
		},
		expectedTimeOffset: -1024 / 48000,
		audioStartTimestamp: 0,
		audioEndTimestamp: 5.034666666666666,
		processNewAudioPacketData: data => data.subarray(7),
	});
});

const testCopy = async (options: {
	outputFormat?: OutputFormat;
	conversionOptions: Omit<ConversionOptions, 'input' | 'output'>;
	expectedTimeOffset: number;
	videoStartTimestamp?: number;
	videoEndTimestamp?: number;
	audioStartTimestamp: number;
	audioEndTimestamp: number;
	precision?: number;
	processNewAudioPacketData?: (data: Uint8Array) => Uint8Array;
	compareVideoPackets?: boolean;
}) => {
	const precision = options.precision ?? 0.000001;

	const isCloseTo = (a: number, b: number) => {
		return Math.abs(a - b) <= precision;
	};

	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: options.outputFormat ?? new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);
	const videoSink = new EncodedPacketSink(videoTrack);
	const audioSink = new EncodedPacketSink(audioTrack);

	const conversion = await Conversion.init({
		input,
		output,
		...options.conversionOptions,
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const newVideoTrack = await newInput.getPrimaryVideoTrack();
	const newAudioTrack = await newInput.getPrimaryAudioTrack();

	if (newVideoTrack) {
		const newVideoSink = new EncodedPacketSink(newVideoTrack);

		expect(isCloseTo(await newVideoTrack.getFirstTimestamp(), options.videoStartTimestamp!)).toBe(true);
		expect(isCloseTo(await newVideoTrack.computeDuration(), options.videoEndTimestamp!)).toBe(true);

		if (options.compareVideoPackets ?? true) {
			for await (const newPacket of newVideoSink.packets()) {
				const oldPacket = await videoSink.getPacket(
					newPacket.timestamp + options.expectedTimeOffset + precision,
				);
				assert(oldPacket);

				expect(uint8ArraysAreEqual(oldPacket.data, newPacket.data)).toBe(true);
				expect(oldPacket.type).toEqual(newPacket.type);
			}
		}
	}

	if (newAudioTrack) {
		const newAudioSink = new EncodedPacketSink(newAudioTrack);

		expect(isCloseTo(await newAudioTrack.getFirstTimestamp(), options.audioStartTimestamp)).toBe(true);
		expect(isCloseTo(await newAudioTrack.computeDuration(), options.audioEndTimestamp)).toBe(true);

		for await (const newPacket of newAudioSink.packets()) {
			const oldPacket = await audioSink.getPacket(newPacket.timestamp + options.expectedTimeOffset + precision);
			assert(oldPacket);

			const process = options.processNewAudioPacketData ?? (x => x);

			expect(uint8ArraysAreEqual(oldPacket.data, process(newPacket.data))).toBe(true);
			expect(oldPacket.type).toEqual(newPacket.type);
		}
	}
};

test('Trim wholly before media data, transcode', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			forceTranscode: true,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: -10,
			end: -5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Trim wholly before media data, copy', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		copy: { mode: 'forced' },
		trim: {
			start: -10,
			end: -5,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Trim wholly past media data, transcode', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		video: {
			forceTranscode: true,
		},
		audio: {
			forceTranscode: true,
		},
		trim: {
			start: 10,
			end: 15,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});

test('Trim wholly past media data, copy', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({
		input,
		output,
		copy: { mode: 'forced' },
		trim: {
			start: 10,
			end: 15,
		},
	});
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	// Don't test video yet; requires extensions to packet fetching logic. B-frames!!
	// expect(await newInput.getPrimaryVideoTrack()).toBeNull(); // No video data
	expect(await newInput.getPrimaryAudioTrack()).toBeNull(); // No audio data
});
