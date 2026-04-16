import { expect, test, vi } from 'vitest';
import { Output, OutputTrackGroup } from '../../src/output.js';
import {
	CmafOutputFormat,
	HlsOutputFormat,
	HlsOutputSegmentInfo,
	MpegTsOutputFormat,
} from '../../src/output-format.js';
import { BufferTarget, NullTarget, PathedTarget, StreamTarget, StreamTargetChunk } from '../../src/target.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { HlsMuxer } from '../../src/hls/hls-muxer.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { EncodedPacket, PacketType } from '../../src/packet.js';
import { assert, promiseWithResolvers } from '../../src/misc.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { InputAudioTrack, InputVideoTrack } from '../../src/input-track.js';
import { EncodedPacketSink } from '../../src/media-sink.js';

const videoSource = (codec: VideoCodec = 'avc') => new EncodedVideoPacketSource(codec);
const audioSource = (codec: AudioCodec = 'aac') => new EncodedAudioPacketSource(codec);

test('Playlist assignment, single video', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, single audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video with different metadata #1', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { languageCode: 'eng' });
	output.addVideoTrack(videoSource(), { languageCode: 'esp' });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('video-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('video-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, multiple video with different metadata #2', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { disposition: { primary: true } });
	output.addVideoTrack(videoSource(), { disposition: { primary: false } });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('video-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('video-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, multiple audio with different metadata', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addAudioTrack(audioSource(), { languageCode: 'eng' });
	output.addAudioTrack(audioSource(), { languageCode: 'esp' });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.references).toHaveLength(0);
	expect(decl[0]!.noUri).toBe(true);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.references).toHaveLength(0);
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
});

test('Playlist assignment, video and audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(1);
	expect(decl[0]!.playlist.tracks).toHaveLength(2);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);
});

test('Playlist assignment, one video and multiple audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 3));
});

test('Playlist assignment, multiple video and one audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toEqual([decl[0]!]);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[0]!]);
});

test('Playlist assignment, multiple video and audio', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(6);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBe('audio-1');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 3));

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual(decl.slice(0, 3));

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toEqual(decl.slice(0, 3));
});

test('Playlist assignment, video and audio in different groups', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio in pairs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	const c = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addVideoTrack(videoSource(), { group: c });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: c });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(2);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[0]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(2);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(decl[2]!.playlist.tracks).toHaveLength(2);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.playlist.tracks[1]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio with some unpaired', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	const c = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: c });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(6);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual(decl.slice(0, 2));

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual(decl.slice(0, 2));

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toHaveLength(0);

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toHaveLength(0);
});

test('Playlist assignment, multiple video and audio with multiple groups', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(8);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.groupId).toBe('audio-2');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[3]!.groupId).toBe('audio-2');
	expect(decl[3]!.noUri).toBe(false);

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual(decl.slice(0, 2));

	expect(decl[5]!.playlist.tracks).toHaveLength(1);
	expect(decl[5]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[5]!.groupId).toBeNull();
	expect(decl[5]!.references).toEqual(decl.slice(0, 2));

	expect(decl[6]!.playlist.tracks).toHaveLength(1);
	expect(decl[6]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[6]!.groupId).toBeNull();
	expect(decl[6]!.references).toEqual(decl.slice(2, 4));

	expect(decl[7]!.playlist.tracks).toHaveLength(1);
	expect(decl[7]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[7]!.groupId).toBeNull();
	expect(decl[7]!.references).toEqual(decl.slice(2, 4));
});

test('Playlist assignment, video with multiple audio codecs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource());
	output.addAudioTrack(audioSource('aac'));
	output.addAudioTrack(audioSource('ac3'));

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(4);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.playlist.tracks[0]!.source._codec).toBe('aac');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.playlist.tracks[0]!.source._codec).toBe('ac3');
	expect(decl[1]!.groupId).toBe('audio-2');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[1]!]);

	expect(decl[2]!.playlist).toBe(decl[3]!.playlist);
});

test('Playlist assignment, audio with multiple video codecs', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource('avc'));
	output.addVideoTrack(videoSource('hevc'));
	output.addAudioTrack(audioSource());

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(3);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[1]!.playlist.tracks[0]!.source._codec).toBe('avc');
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toEqual([decl[0]!]);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[2]!.playlist.tracks[0]!.source._codec).toBe('hevc');
	expect(decl[2]!.groupId).toBeNull();
	expect(decl[2]!.references).toEqual([decl[0]!]);
});

test('Playlist assignment, multiple video with conflicting audio interests', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });
	output.addAudioTrack(audioSource(), { group: [a, b] });
	output.addAudioTrack(audioSource(), { group: a });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(5);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[0]!.groupId).toBe('audio-1');
	expect(decl[0]!.noUri).toBe(false);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[1]!.groupId).toBe('audio-1');
	expect(decl[1]!.noUri).toBe(false);

	expect(decl[2]!.playlist.tracks).toHaveLength(1);
	expect(decl[2]!.playlist.tracks[0]!.type).toBe('audio');
	expect(decl[2]!.playlist).toBe(decl[0]!.playlist);
	expect(decl[2]!.groupId).toBe('audio-2');
	expect(decl[2]!.noUri).toBe(false);

	expect(decl[3]!.playlist.tracks).toHaveLength(1);
	expect(decl[3]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[3]!.groupId).toBeNull();
	expect(decl[3]!.references).toEqual([decl[0]!, decl[1]!]);

	expect(decl[4]!.playlist.tracks).toHaveLength(1);
	expect(decl[4]!.playlist.tracks[0]!.type).toBe('video');
	expect(decl[4]!.groupId).toBeNull();
	expect(decl[4]!.references).toEqual([decl[2]!]);
});

test('Playlist assignment, video paired with video', async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	a.pairWith(b);

	output.addVideoTrack(videoSource(), { group: a });
	output.addVideoTrack(videoSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(consoleSpy.mock.calls).toHaveLength(1);
	expect(consoleSpy.mock.calls[0]![0]).toContain('Illegal pairing');
});

test('Playlist assignment, audio paired with audio', async () => {
	const consoleSpy = vi.spyOn(console, 'warn');

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const a = new OutputTrackGroup();
	const b = new OutputTrackGroup();
	a.pairWith(b);

	output.addAudioTrack(audioSource(), { group: a });
	output.addAudioTrack(audioSource(), { group: b });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	const decl = muxer.playlistDeclarations;

	expect(decl).toHaveLength(2);

	expect(decl[0]!.playlist.tracks).toHaveLength(1);
	expect(decl[0]!.groupId).toBeNull();
	expect(decl[0]!.references).toHaveLength(0);

	expect(decl[1]!.playlist.tracks).toHaveLength(1);
	expect(decl[1]!.groupId).toBeNull();
	expect(decl[1]!.references).toHaveLength(0);

	expect(consoleSpy.mock.calls).toHaveLength(1);
	expect(consoleSpy.mock.calls[0]![0]).toContain('Illegal pairing');
});

// eslint-disable-next-line @stylistic/max-len
const avcPacketData = new Uint8Array([0, 0, 0, 1, 9, 240, 0, 0, 0, 1, 39, 77, 64, 41, 169, 24, 15, 0, 68, 252, 184, 3, 80, 16, 16, 27, 108, 43, 94, 247, 192, 64, 0, 0, 0, 1, 40, 222, 9, 200, 0, 0, 1, 6, 0, 7, 128, 175, 200, 0, 0, 3, 0, 64, 128, 0, 0, 1, 6, 5, 17, 3, 135, 244, 78, 205, 10, 75, 220, 161, 148, 58, 195, 212, 155, 23, 31, 0, 128, 0, 0, 1, 37, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 175, 0, 0, 1, 37, 0, 127, 174, 8, 8, 8, 81, 49, 64, 0, 85, 230, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 147, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 250, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 188, 0, 0, 1, 37, 0, 63, 203, 130, 2, 2, 20, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 240, 0, 0, 1, 37, 0, 23, 234, 224, 128, 128, 133, 19, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 249, 49, 64, 0, 85, 230, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 192, 0, 0, 1, 37, 0, 31, 226, 224, 128, 128, 133, 19, 20, 0, 5, 94, 111, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 250, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 188, 0, 0, 1, 37, 0, 9, 246, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 240, 0, 0, 1, 37, 0, 11, 244, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 175, 0, 0, 1, 37, 0, 13, 242, 184, 32, 32, 33, 68, 197, 0, 1, 87, 155, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 76, 80, 0, 21, 121, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 239, 190, 251, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 235, 174, 186, 255, 248, 255, 4, 17, 64, 0, 69, 19, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 247, 223, 125, 248]); ;
const avcMetadata: EncodedVideoChunkMetadata = {
	decoderConfig: {
		codec: 'avc1.4d401e',
		codedWidth: 1280,
		codedHeight: 720,
	},
};

// eslint-disable-next-line @stylistic/max-len
const aacPacketData = new Uint8Array([255, 241, 77, 128, 3, 159, 252, 0, 208, 0, 1, 3, 64, 0, 13, 0, 0, 17, 52, 0, 0, 208, 0, 3, 6, 128, 0, 56]);
const aacMetadata: EncodedAudioChunkMetadata = {
	decoderConfig: {
		codec: 'mp4a.40.2',
		numberOfChannels: 2,
		sampleRate: 48000,
	},
};

const setUpSegmentationEnvironment = async (options: {
	video?: boolean;
	audio?: boolean;
} = {}) => {
	let result: string | null = null;
	let segmentCount = 0;
	let lastSegmentVideoTimestamps: Promise<number[]> = Promise.resolve([]);
	let lastSegmentAudioTimestamps: Promise<number[]> = Promise.resolve([]);

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(), // No ADTS for simplicity
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					result = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentCount++;

				const videoBundle = promiseWithResolvers<number[]>();
				lastSegmentVideoTimestamps = videoBundle.promise;
				const audioBundle = promiseWithResolvers<number[]>();
				lastSegmentAudioTimestamps = audioBundle.promise;

				target.on('finalized', async () => {
					try {
						using input = new Input({
							source: new BufferSource(target.buffer!),
							formats: ALL_FORMATS,
						});

						const videoTrack = await input.getPrimaryVideoTrack() as InputVideoTrack;
						if (videoTrack) {
							const sink = new EncodedPacketSink(videoTrack);
							const timestamps: number[] = [];
							for await (const packet of sink.packets()) {
								timestamps.push(packet.timestamp);
							}
							videoBundle.resolve(timestamps);
						} else {
							videoBundle.resolve([]);
						}

						const audioTrack = await input.getPrimaryAudioTrack() as InputAudioTrack;
						if (audioTrack) {
							const sink = new EncodedPacketSink(audioTrack);
							const timestamps: number[] = [];
							for await (const packet of sink.packets()) {
								timestamps.push(packet.timestamp);
							}
							audioBundle.resolve(timestamps);
						} else {
							audioBundle.resolve([]);
						}
					} catch {
						videoBundle.resolve([]);
						audioBundle.resolve([]);
					}
				});
			}

			return target;
		}),
	});

	const _videoSource = options.video ? new EncodedVideoPacketSource('avc') : null;
	const _audioSource = options.audio ? new EncodedAudioPacketSource('aac') : null;

	if (_videoSource) {
		output.addVideoTrack(_videoSource);
	}
	if (_audioSource) {
		output.addAudioTrack(_audioSource);
	}

	await output.start();

	const addVideoPacket = (timestamp: number, type: PacketType, duration = 0) => {
		assert(_videoSource);

		return _videoSource.add(
			new EncodedPacket(avcPacketData, type, timestamp, duration),
			avcMetadata,
		);
	};

	const addAudioPacket = (timestamp: number, duration = 0) => {
		assert(_audioSource);

		return _audioSource.add(
			new EncodedPacket(aacPacketData, 'key', timestamp, duration),
			aacMetadata,
		);
	};

	return {
		output,
		videoSource: _videoSource,
		audioSource: _audioSource,
		addVideoPacket,
		addAudioPacket,
		get segmentCount() { return segmentCount; },
		get result() { return result; },
		get lastSegmentVideoTimestamps() { return lastSegmentVideoTimestamps; },
		get lastSegmentAudioTimestamps() { return lastSegmentAudioTimestamps; },
	};
};

test('Segmentation, empty', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.output.finalize();

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, simple', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5, 4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with a final key packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with a final key packet (audio)', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with packet durations', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	await env.addVideoPacket(3.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, reaching until end of second segment with packet durations (audio)', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 0.5);
	await env.addAudioPacket(0.5, 0.5);
	await env.addAudioPacket(1, 0.5);
	await env.addAudioPacket(1.5, 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2, 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5, 0.5);
	await env.addAudioPacket(3, 0.5);
	await env.addAudioPacket(3.5, 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4, 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3, 3.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, only one key packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.5);
	await env.addVideoPacket(2, 'delta', 0.5);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:4
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, key packets before the end of a segment (maximized segment duration test)', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'key', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(3.5, 'delta', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5]);
	await env.addVideoPacket(4, 'delta', 0.5);
	await env.addVideoPacket(4.5, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	await env.addVideoPacket(5, 'key', 0.5);
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3, 3.5, 4, 4.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(4);
	expect(await env.lastSegmentVideoTimestamps).toEqual([5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
#EXTINF:0.5,
segment-1-4.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, full segment duration recovery after shorter segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'key', 0.5);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta', 0.5);
	await env.addVideoPacket(3, 'delta', 0.5);
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(3.5, 'key', 0.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3]);
	await env.addVideoPacket(4, 'delta', 0.5);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3.5, 4]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:1,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, packet start timestamp intersecting with end timestamp of previous packet', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 0.5);
	await env.addVideoPacket(0.5, 'delta', 0.5);
	await env.addVideoPacket(1, 'delta', 0.5);
	await env.addVideoPacket(1.5, 'delta', 0.75); // This!
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'key', 0.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, last video packet is included', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, video not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.45, 'key');
	await env.addVideoPacket(0.9, 'key');
	await env.addVideoPacket(1.35, 'key');
	await env.addVideoPacket(1.8, 'key');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2.25, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addVideoPacket(2.7, 'key');
	await env.addVideoPacket(3.15, 'key');
	await env.addVideoPacket(3.6, 'key');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4.05, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.8, 2.25, 2.7, 3.15]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([3.6, 4.05]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts
#EXTINF:1.8,
segment-1-2.ts
#EXTINF:0.45,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, audio not lining up with segment boundaries', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.45);
	await env.addAudioPacket(0.9);
	await env.addAudioPacket(1.35);
	await env.addAudioPacket(1.8);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2.25);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.45, 0.9, 1.35]);
	await env.addAudioPacket(2.7);
	await env.addAudioPacket(3.15);
	await env.addAudioPacket(3.6);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.05);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.8, 2.25, 2.7, 3.15]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentAudioTimestamps).toEqual([3.6, 4.05]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts
#EXTINF:1.8,
segment-1-2.ts
#EXTINF:0.45,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, non-zero start time', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	// The minimum packet timestamp becomes the first packet's start time
	await env.addVideoPacket(1, 'key');
	await env.addAudioPacket(0.5);
	env.audioSource!.close();
	await env.addVideoPacket(1.5, 'key');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'key');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1, 1.5, 2]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0.5]);

	await env.output.finalize();
	expect(await env.lastSegmentVideoTimestamps).toEqual([2.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, B-frames before key frame', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addVideoPacket(1.75, 'delta');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'key');
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 1.75, 2.5, 3, 3.5]);
	await env.addVideoPacket(4.5, 'delta');

	await env.output.finalize();
	expect(await env.lastSegmentVideoTimestamps).toEqual([4, 4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, one video packet per segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true });

	await env.addVideoPacket(0, 'key', 3);
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(3, 'key', 3);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, one audio packet per segment', async () => {
	const env = await setUpSegmentationEnvironment({ audio: true });

	await env.addAudioPacket(0, 3);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(3, 3);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, single segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:0,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, video dictates the segmentation', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'key');
	await env.addVideoPacket(2, 'delta');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	await env.addVideoPacket(4.5, 'key');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
	await env.addAudioPacket(2);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(4.5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, video dictates the segmentation, inverted', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	await env.addAudioPacket(2);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	await env.addAudioPacket(4.5);

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'key');
	expect(env.segmentCount).toBe(0);
	await env.addVideoPacket(2, 'delta');
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1]);
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	expect(env.segmentCount).toBe(1);
	await env.addVideoPacket(4.5, 'key');
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([4.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, audio ending after video', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'delta');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	expect(env.segmentCount).toBe(1);

	await env.output.finalize();
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3.0, 3.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:1.5,
segment-1-2.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, audio ending after video in separate segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');
	await env.addVideoPacket(2, 'key');
	await env.addVideoPacket(2.5, 'delta');
	await env.addVideoPacket(3, 'delta');
	await env.addVideoPacket(3.5, 'delta');
	await env.addVideoPacket(4, 'delta');
	await env.addVideoPacket(4.5, 'delta');
	env.videoSource!.close();

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);
	expect(env.segmentCount).toBe(0);
	await env.addAudioPacket(2);
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);
	await env.addAudioPacket(2.5);
	await env.addAudioPacket(3);
	await env.addAudioPacket(3.5);
	await env.addAudioPacket(4);
	await env.addAudioPacket(4.5);
	expect(env.segmentCount).toBe(1);
	await env.addAudioPacket(5);
	expect(env.segmentCount).toBe(2);
	expect(await env.lastSegmentVideoTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
	await env.addAudioPacket(5.5);

	await env.output.finalize();
	expect(env.segmentCount).toBe(3);
	expect(await env.lastSegmentVideoTimestamps).toEqual([]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([5, 5.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:3,
segment-1-2.ts
#EXTINF:0.5,
segment-1-3.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, end timestamp with duration', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta', 0.25);

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5, 0.3);
	expect(env.segmentCount).toBe(0);

	await env.output.finalize();
	expect(env.segmentCount).toBe(1);
	expect(await env.lastSegmentVideoTimestamps).toEqual([0, 0.5, 1, 1.5]);
	expect(await env.lastSegmentAudioTimestamps).toEqual([0, 0.5, 1, 1.5]);

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.8,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('Segmentation, dual-track, closing writes segment', async () => {
	const env = await setUpSegmentationEnvironment({ video: true, audio: true });

	await env.addVideoPacket(0, 'key');
	await env.addVideoPacket(0.5, 'delta');
	await env.addVideoPacket(1, 'delta');
	await env.addVideoPacket(1.5, 'delta');

	await env.addAudioPacket(0);
	await env.addAudioPacket(0.5);
	await env.addAudioPacket(1);
	await env.addAudioPacket(1.5);

	expect(env.segmentCount).toBe(0);

	env.videoSource!.close();
	await new Promise(resolve => setTimeout(resolve, 4));

	expect(env.segmentCount).toBe(0);

	env.audioSource!.close();
	await new Promise(resolve => setTimeout(resolve, 4));

	expect(env.segmentCount).toBe(1);

	await env.output.finalize();

	expect(env.result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:1.5,
segment-1-1.ts

#EXT-X-ENDLIST
`,
	);
});

test('write, onSegment, onPlaylist, onMaster events', async () => {
	const onSegment = vi.fn();
	const onPlaylist = vi.fn();
	const onMaster = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onSegment,
			onPlaylist,
			onMaster,
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	let targetWrites = 0;
	output.target.on('write', () => targetWrites++);

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	// First segment
	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	expect(onSegment).toHaveBeenCalledTimes(0);

	// Second segment starts, first one is finalized
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	expect(onSegment).toHaveBeenCalledTimes(1);
	expect(onSegment.mock.calls[0]![1]).toEqual(expect.objectContaining({ n: 1 }));

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onPlaylist).not.toHaveBeenCalled();
	expect(onMaster).not.toHaveBeenCalled();

	await output.finalize();

	expect(targetWrites).toBeGreaterThan(0);

	// Second segment finalized on close
	expect(onSegment).toHaveBeenCalledTimes(2);
	expect(onSegment.mock.calls[1]![1]).toEqual(expect.objectContaining({ n: 2 }));

	// Both segment calls should have a Target as the first argument
	expect(onSegment.mock.calls[0]![0]).toBeDefined();
	expect(onSegment.mock.calls[1]![0]).toBeDefined();

	// Playlist and master should have been called once each
	expect(onPlaylist).toHaveBeenCalledTimes(1);
	expect(typeof onPlaylist.mock.calls[0]![0]).toBe('string');
	expect(onPlaylist.mock.calls[0]![0]).toContain('#EXTM3U');
	expect(onPlaylist.mock.calls[0]![1]).toEqual(expect.objectContaining({ n: 1 }));

	expect(onMaster).toHaveBeenCalledTimes(1);
	expect(typeof onMaster.mock.calls[0]![0]).toBe('string');
	expect(onMaster.mock.calls[0]![0]).toContain('#EXTM3U');
});

test('Single-file mode', async () => {
	let playlistText: string | null = null;
	const segmentPaths = new Set<string>();

	const onSegment = vi.fn();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			singleFilePerPlaylist: true,
			onSegment,
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			} else if (request.path.includes('segment')) {
				segmentPaths.add(request.path);
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	expect(onSegment).toHaveBeenCalledTimes(0);

	await output.finalize();

	// Only one segment file should have been created
	expect(segmentPaths.size).toBe(1);

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:4');

	expect(onSegment).toHaveBeenCalledTimes(1);
});

test('StreamTarget, write is called for each target', async () => {
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', (request) => {
			writeCounts.set(request.path, 0);

			const writable = new WritableStream<StreamTargetChunk>({
				write() {
					writeCounts.set(request.path, writeCounts.get(request.path)! + 1);
				},
			});

			return new StreamTarget(writable);
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Every StreamTarget should have been written to at least once
	for (const [path, count] of writeCounts) {
		expect(count, `Expected writes for ${path}`).toBeGreaterThanOrEqual(1);
	}
});

test('I-frame stream', async () => {
	let masterText = '';
	let playlistText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onMaster: (text) => { masterText = text; },
			onPlaylist: (text) => { playlistText = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source, { hasOnlyKeyPackets: true });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	expect(muxer.playlistDeclarations).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.groupId).toBeNull();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 1), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 1, 1), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 1), avcMetadata);

	await output.finalize();

	expect(playlistText).toContain('#EXT-X-I-FRAMES-ONLY');
	expect(playlistText).toContain('#EXT-X-VERSION:4');

	expect(masterText).toContain('#EXT-X-I-FRAME-STREAM-INF:');
	expect(masterText).toMatch(/#EXT-X-I-FRAME-STREAM-INF:[^\n]*URI="/);
	expect(masterText).not.toContain('#EXT-X-STREAM-INF:');
});

test('I-frame stream, pairing warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	const group = new OutputTrackGroup();
	output.addVideoTrack(videoSource(), { hasOnlyKeyPackets: true, group });
	output.addAudioTrack(audioSource(), { group });

	await output.start();

	const muxer = output._muxer as HlsMuxer;
	// Despite being pairable, they must end up as separate unpaired declarations
	expect(muxer.playlistDeclarations).toHaveLength(2);
	expect(muxer.playlistDeclarations[0]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[1]!.playlist.tracks).toHaveLength(1);
	expect(muxer.playlistDeclarations[0]!.groupId).toBeNull();
	expect(muxer.playlistDeclarations[1]!.groupId).toBeNull();

	expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('key-packets-only'));

	warnSpy.mockRestore();
});

test('CMAF segmentation', async () => {
	let playlistText: string | null = null;
	const targets = new Map<string, BufferTarget>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
		}),
		target: new PathedTarget('', (request) => {
			const target = new BufferTarget();
			targets.set(request.path, target);

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	expect(targets.has('init-1.m4s')).toBe(true);
	expect(targets.has('segment-1-1.m4s')).toBe(true);
	expect(targets.has('segment-1-2.m4s')).toBe(true);

	expect(playlistText).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:1.5,
segment-1-2.m4s

#EXT-X-ENDLIST
`,
	);

	// Verify that each segment contains exactly 4 video packets
	const initTarget = targets.get('init-1.m4s')!;
	using initInput = new Input({
		source: new BufferSource(initTarget.buffer!),
		formats: ALL_FORMATS,
	});

	for (const segmentPath of ['segment-1-1.m4s', 'segment-1-2.m4s']) {
		const segmentTarget = targets.get(segmentPath)!;

		using segmentInput = new Input({
			source: new BufferSource(segmentTarget.buffer!),
			formats: ALL_FORMATS,
			initInput,
		});

		const videoTrack = await segmentInput.getPrimaryVideoTrack() as InputVideoTrack;
		expect(videoTrack).toBeTruthy();

		const sink = new EncodedPacketSink(videoTrack);
		let packetCount = 0;
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const packet of sink.packets()) {
			packetCount++;
		}
		expect(packetCount).toBe(4);
	}
});

test('CMAF segmentation, single file per playlist', async () => {
	let playlistText: string | null = null;
	const writtenPaths = new Set<string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			singleFilePerPlaylist: true,
		}),
		target: new PathedTarget('', (request) => {
			writtenPaths.add(request.path);
			const target = new BufferTarget();

			if (request.path.includes('playlist')) {
				target.on('finalized', () => {
					playlistText = new TextDecoder().decode(target.buffer!);
				});
			}

			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0), avcMetadata);

	await output.finalize();

	// Init and segment files should have been written
	expect(writtenPaths).toContain('segments-1.m4s');
	expect(writtenPaths).not.toContain('init-1.m4s');

	expect(playlistText).not.toBeNull();
	expect(playlistText!.match(/#EXT-X-BYTERANGE/g)).toHaveLength(2);
	expect(playlistText).toContain('#EXT-X-VERSION:6');
	expect(playlistText).toContain('#EXT-X-MAP:URI=');
});

test('Live mode', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	expect(writtenTexts.size).toBe(0);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.has('playlist-1.m3u8')).toBe(true);
	expect(writtenTexts.has('master.m3u8')).toBe(true);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writeCounts.get('master.m3u8')).toBe(3);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts

#EXT-X-ENDLIST
`);
});

test('Live mode, CMAF', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	expect(writtenTexts.size).toBe(0);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.has('playlist-1.m3u8')).toBe(true);
	expect(writtenTexts.has('master.m3u8')).toBe(true);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:2,
segment-1-2.m4s
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writeCounts.get('master.m3u8')).toBe(3);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.m4s"

#EXTINF:2,
segment-1-1.m4s
#EXTINF:2,
segment-1-2.m4s
#EXTINF:2,
segment-1-3.m4s

#EXT-X-ENDLIST
`);
});

test('Live mode, fixed target duration', async () => {
	const writtenTexts = new Map<string, string>();
	const writeCounts = new Map<string, number>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
					writeCounts.set(request.path, (writeCounts.get(request.path) ?? 0) + 1);
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);

	await output.finalize();

	// The TARGETDURATION remains 2 even tho there are segments longer than that; this is because the spec disallows the
	// target duration to change, and it must be the same across all playlists
	expect(writeCounts.get('master.m3u8')).toBe(1);
	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:3,
segment-1-1.ts

#EXT-X-ENDLIST
`);
});

test('Live mode, empty', async () => {
	const writtenTexts = new Map<string, string>();

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();
	await output.finalize();

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-ENDLIST
`);
});

test('EXT-X-PROGRAM-DATE-TIME writing', async () => {
	let result: string | null = null;

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			onPlaylist: (text) => { result = text; },
		}),
		target: new PathedTarget('', () => new BufferTarget()),
	});

	const source = videoSource();
	output.addVideoTrack(source, { isRelativeToUnixEpoch: true });

	await output.start();

	const base = Date.parse('2026-01-01T00:00:00.250Z') / 1000;

	await source.add(new EncodedPacket(avcPacketData, 'key', base + 0, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 0.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 1, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 1.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'key', base + 2, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 2.5, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 3, 0), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', base + 3.5, 0), avcMetadata);

	await output.finalize();

	expect(result).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.250Z
segment-1-1.ts
#EXTINF:1.5,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:02.250Z
segment-1-2.ts

#EXT-X-ENDLIST
`);
});

test('Throws if some tracks are relativeToUnixEpoch and some are not', async () => {
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
		}),
		target: new PathedTarget('', () => new NullTarget()),
	});

	output.addVideoTrack(videoSource(), { isRelativeToUnixEpoch: true });
	output.addAudioTrack(audioSource(), { isRelativeToUnixEpoch: false });

	await expect(output.start()).rejects.toThrow('relativeToUnixEpoch');
});

test('Live mode, maxLiveSegmentCount', async () => {
	const writtenTexts = new Map<string, string>();
	const poppedSegments: { path: string; info: HlsOutputSegmentInfo }[] = [];

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			onSegmentPopped: (path, info) => {
				poppedSegments.push({ path, info });
			},
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			target.on('finalized', () => {
				if (request.path.endsWith('.m3u8')) {
					writtenTexts.set(request.path, new TextDecoder().decode(target.buffer!));
				}
			});
			return target;
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-1.ts
#EXTINF:2,
segment-1-2.ts
`);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 6, 0.5), avcMetadata);

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-2.ts
#EXTINF:2,
segment-1-3.ts
`);

	expect(poppedSegments).toHaveLength(1);
	expect(poppedSegments[0]!.path).toBe('segment-1-1.ts');
	expect(poppedSegments[0]!.info.n).toBe(1);
	expect(poppedSegments[0]!.info.isSingleFile).toBe(false);

	await source.add(new EncodedPacket(avcPacketData, 'delta', 6.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7.5, 0.5), avcMetadata);

	await output.finalize();

	expect(writtenTexts.get('playlist-1.m3u8')).toBe(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-INDEPENDENT-SEGMENTS

#EXTINF:2,
segment-1-3.ts
#EXTINF:2,
segment-1-4.ts

#EXT-X-ENDLIST
`);

	expect(poppedSegments).toHaveLength(2);
	expect(poppedSegments[1]!.path).toBe('segment-1-2.ts');
	expect(poppedSegments[1]!.info.n).toBe(2);
});

test('Live mode, maxLiveSegmentCount with singleFilePerPlaylist', async () => {
	const onSegmentPopped = vi.fn();
	let lastPlaylistText = '';

	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new MpegTsOutputFormat(),
			live: true,
			maxLiveSegmentCount: 2,
			singleFilePerPlaylist: true,
			onSegmentPopped,
			onPlaylist: (content) => {
				lastPlaylistText = content;
			},
		}),
		target: new PathedTarget('master.m3u8', () => {
			return new BufferTarget();
		}),
	});

	const source = videoSource();
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(avcPacketData, 'key', 0, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 0.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 1.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 2, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 2.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 3.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 4, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 4.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 5.5, 0.5), avcMetadata);

	await source.add(new EncodedPacket(avcPacketData, 'key', 6, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 6.5, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7, 0.5), avcMetadata);
	await source.add(new EncodedPacket(avcPacketData, 'delta', 7.5, 0.5), avcMetadata);

	await output.finalize();

	expect(onSegmentPopped).not.toHaveBeenCalled();

	// Popping still happened
	const extinfCount = (lastPlaylistText.match(/#EXTINF:/g) ?? []).length;
	expect(extinfCount).toBe(2);
});
