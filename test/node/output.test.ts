import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import {
	AdtsOutputFormat,
	CmafOutputFormat,
	FlacOutputFormat,
	HlsOutputFormat,
	MkvOutputFormat,
	Mp3OutputFormat,
	MpegTsOutputFormat,
	OggOutputFormat,
	OutputFormat,
	WavOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, PathedTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource, TextSubtitleSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { AudioCodec } from '../../src/codec.js';
import { promiseWithResolvers } from '../../src/misc.js';

test('Output, onFinalize', async () => {
	let callCount = 0;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: async () => {
			await new Promise(resolve => setTimeout(resolve, 200));

			callCount++;
		},
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.5), {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	expect(callCount).toBe(1);
});

test('Exceeding the total track count', () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	for (let i = 0; i < 127; i++) {
		output.addVideoTrack(new EncodedVideoPacketSource('avc'));
	}

	expect(() => output.addAudioTrack(new EncodedAudioPacketSource('aac')))
		.toThrow('Matroska does not support more than 127 tracks in total.');
});

test('Cancel after a failed source close', async () => {
	let writableClosed = false;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new StreamTarget(new WritableStream({
			close() {
				writableClosed = true;
			},
		})),
	});

	const source = new TextSubtitleSource('webvtt');
	output.addSubtitleTrack(source);

	await output.start();

	// The second cue goes back in time, which the muxer rejects, making the source's close fail
	await source.add('WEBVTT\n\n00:05.000 --> 00:06.000\nB\n\n00:01.000 --> 00:02.000\nA\n');
	source.close();

	await output.cancel();
	expect(writableClosed).toBe(true);
});

test('Cancel after the target stream errored', async () => {
	const writable = new WritableStream<StreamTargetChunk>();
	await writable.abort(new Error('Upload failed'));

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new StreamTarget(writable),
	});

	output.addVideoTrack(new EncodedVideoPacketSource('avc'));
	await output.start();

	await output.cancel();
});

test('initTarget callback not returning a Target', async () => {
	const output = new Output({
		format: new CmafOutputFormat(),
		target: new BufferTarget(),
		// @ts-expect-error Invalid on purpose
		initTarget: () => null,
	});

	output.addVideoTrack(new EncodedVideoPacketSource('avc'));

	await expect(output.start()).rejects.toThrow('initTarget must return or resolve to a Target.');
	await output.cancel();
});

test('Cancel while the root target is being obtained', async () => {
	await testCancelWhileTargetIsObtained(getTarget => new Output({
		format: new MkvOutputFormat(),
		target: new PathedTarget('root.mkv', getTarget),
	}));
});

test('Cancel while the init target is being obtained', async () => {
	await testCancelWhileTargetIsObtained(getTarget => new Output({
		format: new CmafOutputFormat(),
		target: new StreamTarget(new WritableStream()),
		initTarget: getTarget,
	}));
});

const testCancelWhileTargetIsObtained = async (
	createOutput: (getTarget: () => Promise<StreamTarget>) => Output,
) => {
	let onTargetRequested!: (resolveTarget: (target: StreamTarget) => void) => void;
	const targetRequested = new Promise<(target: StreamTarget) => void>(resolve => onTargetRequested = resolve);

	const output = createOutput(() => new Promise(resolve => onTargetRequested(resolve)));
	output.addVideoTrack(new EncodedVideoPacketSource('avc'));

	const startPromise = output.start();
	const resolveTarget = await targetRequested;
	const cancelPromise = output.cancel();

	let writableClosed = false;
	resolveTarget(new StreamTarget(new WritableStream({
		close() {
			writableClosed = true;
		},
	})));

	await startPromise;
	await cancelPromise;
	expect(writableClosed).toBe(true);
};

test('Finalizing ADTS output after a failed start', async () => {
	await testFinalizeAfterFailedStart(new AdtsOutputFormat(), 'aac');
});

test('Finalizing FLAC output after a failed start', async () => {
	await testFinalizeAfterFailedStart(new FlacOutputFormat(), 'flac');
});

test('Finalizing MP3 output after a failed start', async () => {
	await testFinalizeAfterFailedStart(new Mp3OutputFormat(), 'mp3');
});

test('Finalizing Ogg output after a failed start', async () => {
	await testFinalizeAfterFailedStart(new OggOutputFormat(), 'opus');
});

test('Finalizing WAVE output after a failed start', async () => {
	await testFinalizeAfterFailedStart(new WavOutputFormat(), 'pcm-s16');
});

test('Finalizing MPEG-TS output after a failed start', async () => {
	await testFinalizeAfterFailedStart(new MpegTsOutputFormat(), 'aac');
});

const testFinalizeAfterFailedStart = async (format: OutputFormat, codec: AudioCodec) => {
	const output = new Output({
		format,
		target: new PathedTarget('output', () => {
			throw new Error('Disk full');
		}),
	});
	output.addAudioTrack(new EncodedAudioPacketSource(codec));

	await expect(output.start()).rejects.toThrow('Disk full');

	// Used to hang, since the failed start never released the muxer
	await expect(output.finalize()).rejects.toThrow();
};

test('Finalizing HLS output after a failed start', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('master.m3u8', () => new BufferTarget()),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('aac'), { isRelativeToUnixEpoch: true });
	output.addAudioTrack(new EncodedAudioPacketSource('aac'));

	await expect(output.start()).rejects.toThrow('All tracks must agree');

	// Used to hang, since the failed start never released the muxer
	await output.finalize();
});

test('MIME type when canceled before all tracks are known', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});
	output.addAudioTrack(new EncodedAudioPacketSource('aac'));
	await output.start();

	const mimeTypePromise = output.getMimeType();
	await output.cancel();
	await expect(mimeTypePromise).rejects.toThrow('canceled');
});

test('Reading the target getter with a failing async PathedTarget', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new PathedTarget('root.mkv', () => Promise.reject(new Error('No target'))),
	});
	output.addVideoTrack(new EncodedVideoPacketSource('avc'));

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		expect(() => output.target).toThrow('async callback');
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
	await expect(output.start()).rejects.toThrow('No target');
});

test('HLS segment target obtained after cancellation', async () => {
	const segmentRequested = promiseWithResolvers();
	const segmentTargetGate = promiseWithResolvers();
	const lateTarget = new BufferTarget();
	let lateWriteCount = 0;
	lateTarget.on('write', () => lateWriteCount++);

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
			live: true,
		}),
		target: new PathedTarget('master.m3u8', async ({ path }) => {
			if (path !== 'segment-1-2.m4s') {
				return new BufferTarget();
			}

			segmentRequested.resolve();
			await segmentTargetGate.promise;
			return lateTarget;
		}),
	});
	const videoSource = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(videoSource);
	await output.start();

	const addPromise = (async () => {
		for (let i = 0; i < 4; i++) {
			await videoSource.add(new EncodedPacket(new Uint8Array(100), 'key', i, 1), {
				decoderConfig: {
					codec: 'vp09.00.10.08',
					codedWidth: 64,
					codedHeight: 64,
				},
			});
		}
	})();

	await segmentRequested.promise;
	await output.cancel();
	segmentTargetGate.resolve();

	await expect(addPromise).rejects.toThrow('Output has been canceled.');
	expect(lateWriteCount).toBe(0);
});
