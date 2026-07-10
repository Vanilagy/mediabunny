import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat, WavOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion, ConversionCanceledError } from '../../src/conversion.js';
import { EncodedAudioPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const publicDir = path.join(new URL('.', import.meta.url).pathname, '../public');
const videoPath = path.join(publicDir, 'video.mp4'); // avc video + aac audio, ~5 s, has metadata tags
const wavPath = path.join(publicDir, 'glitch-hop-is-dead.wav'); // pcm-s16 audio

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

const makeInput = () => new Input({ source: new FilePathSource(videoPath), formats: ALL_FORMATS });

test('Owning conversion still requires a fresh output', async () => {
	using input = makeInput();

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	output.addAudioTrack(new EncodedAudioPacketSource('aac')); // Makes the output non-fresh

	await expect(Conversion.init({ input, output })).rejects.toThrow(/must be fresh/);
});

test('Non-owning init works on an output that already has a track, but not on a started one', async () => {
	using input = makeInput();

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

	// A started output must be rejected, since tracks can only be added before starting
	using startedInput = makeInput();
	const startedOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	startedOutput.addAudioTrack(new EncodedAudioPacketSource('aac'));
	await startedOutput.start();

	await expect(Conversion.init({ input: startedInput, output: startedOutput, ownsOutput: false }))
		.rejects.toThrow(/not have been started/);

	await startedOutput.cancel();
});

test('Non-owning conversion rejects tags and non-boolean ownsOutput', async () => {
	using input = makeInput();

	const makeOutput = () => new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	await expect(Conversion.init({
		input,
		output: makeOutput(),
		ownsOutput: false,
		tags: { title: 'Not allowed' },
	})).rejects.toThrow(/tags cannot be set by a non-owning conversion/);

	await expect(Conversion.init({
		input,
		output: makeOutput(),
		// @ts-expect-error Intentionally passing an invalid type
		ownsOutput: 'yes',
	})).rejects.toThrow(/ownsOutput/);
});

test('Non-owning execute before output.start throws a helpful error', async () => {
	using input = makeInput();

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, ownsOutput: false, showWarnings: false });
	expect(conversion.isValid).toBe(true);

	await expect(conversion.execute()).rejects.toThrow(/output to be started/);
});

test('Non-owning conversion composes with a user-added track', async () => {
	using input = makeInput();

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
	using videoInput = makeInput();
	using audioInput = makeInput();

	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

	const videoConversion = await Conversion.init({
		input: videoInput,
		output,
		ownsOutput: false,
		audio: { discard: true },
		showWarnings: false,
	});
	const audioConversion = await Conversion.init({
		input: audioInput,
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
	using input = makeInput();

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
	using input = makeInput();

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

test('Track capacity is seeded from tracks already on the output', async () => {
	using input = new Input({ source: new FilePathSource(wavPath), formats: ALL_FORMATS });

	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	// The user already occupies the single audio slot that WAVE allows
	output.addAudioTrack(new EncodedAudioPacketSource('pcm-s16'));

	const conversion = await Conversion.init({
		input,
		output,
		ownsOutput: false,
		showWarnings: false,
	});

	// The conversion's audio track has no room left, so it gets discarded and the conversion is invalid
	expect(conversion.isValid).toBe(false);
	expect(conversion.utilizedTracks).toHaveLength(0);
	expect(conversion.discardedTracks).toHaveLength(1);
	// WAVE allows only one track in total, so the total-count check fires before the per-type one
	expect(conversion.discardedTracks[0]!.reason).toBe('max_track_count_reached');
});
