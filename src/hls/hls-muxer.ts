import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import { EncodedAudioPacketSource, EncodedVideoPacketSource, MediaSource } from '../media-source';
import { assert, joinPaths, last, textEncoder } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from '../output';
import { MpegTsOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { SubtitleCue, SubtitleMetadata } from '../subtitles';
import { Writer } from '../writer';

type HlsTrackData = {
	track: OutputTrack;
	packets: EncodedPacket[];
	info: {
		type: 'video';
		decoderConfig: VideoDecoderConfig;
	} | {
		type: 'audio';
		decoderConfig: AudioDecoderConfig;
	};
};
type HlsVideoTrackData = HlsTrackData & { info: { type: 'video' } };
type HlsAudioTrackData = HlsTrackData & { info: { type: 'audio' } };

export class HlsMuxer extends Muxer {
	targetSegmentDuration = 2;
	trackDatas: HlsTrackData[] = [];
	currentSegmentStartTimestamp: number | null = null;
	nextSegmentId = 1;
	writtenSegments: {
		path: string;
		duration: number;
	}[] = [];

	constructor(output: Output) {
		if (typeof output.target !== 'function') {
			throw new TypeError('HLS outputs require `OutputOptions.target` to be a function.');
		}

		super(output);
	}

	async start(): Promise<void> {
		// Nada
	}

	async getMimeType(): Promise<string> {
		throw new Error('TODO');
	}

	private allTracksAreKnown() {
		for (const track of this.output._tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		try {
			if (!this.trackDatas.some(x => x.track === track)) {
				return;
			}

			await this.ting();
		} finally {
			release();
		}
	}

	getVideoTrackData(track: OutputVideoTrack, meta?: EncodedVideoChunkMetadata) {
		let trackData = this.trackDatas.find(x => x.track === track) as HlsVideoTrackData;
		if (trackData) {
			return trackData;
		}

		validateVideoChunkMetadata(meta);

		assert(meta);
		assert(meta?.decoderConfig);

		trackData = {
			track,
			packets: [],
			info: {
				type: 'video',
				decoderConfig: meta.decoderConfig,
			},
		};
		this.trackDatas.push(trackData);

		return trackData;
	}

	getAudioTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		let trackData = this.trackDatas.find(x => x.track === track) as HlsAudioTrackData;
		if (trackData) {
			return trackData;
		}

		validateAudioChunkMetadata(meta);

		assert(meta);
		assert(meta?.decoderConfig);

		trackData = {
			track,
			packets: [],
			info: {
				type: 'audio',
				decoderConfig: meta.decoderConfig,
			},
		};
		this.trackDatas.push(trackData);

		return trackData;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getVideoTrackData(track, meta);

			const timestamp = this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === 'key');
			const adjustedPacket = packet.clone({ timestamp });

			trackData.packets.push(adjustedPacket);

			if (this.currentSegmentStartTimestamp === null) {
				this.currentSegmentStartTimestamp = adjustedPacket.timestamp;
			} else {
				this.currentSegmentStartTimestamp = Math.min(
					this.currentSegmentStartTimestamp,
					adjustedPacket.timestamp,
				);
			}

			await this.ting();
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getAudioTrackData(track, meta);

			const timestamp = this.validateAndNormalizeTimestamp(track, packet.timestamp, packet.type === 'key');
			const adjustedPacket = packet.clone({ timestamp });

			trackData.packets.push(adjustedPacket);

			if (this.currentSegmentStartTimestamp === null) {
				this.currentSegmentStartTimestamp = adjustedPacket.timestamp;
			} else {
				this.currentSegmentStartTimestamp = Math.min(
					this.currentSegmentStartTimestamp,
					adjustedPacket.timestamp,
				);
			}

			await this.ting();
		} finally {
			release();
		}
	}

	async addSubtitleCue(
		track: OutputSubtitleTrack,
		cue: SubtitleCue,
		meta?: SubtitleMetadata,
	) {

	}

	async ting(isFinalCall = false) {
		assert(this.currentSegmentStartTimestamp !== null);

		if (!this.allTracksAreKnown()) {
			return;
		}

		while (true) {
			const currentSegmentEndTimestamp = this.currentSegmentStartTimestamp + this.targetSegmentDuration;

			let videoKeyEndTimestamp: number | null = null;
			let videoEndTimestamp: number | null = null;
			let audioEndTimestamp: number | null = null;
			let flushAllVideo = false;
			let flushAllAudio = false;

			for (const trackData of this.trackDatas) {
				for (let i = 0; i < trackData.packets.length; i++) {
					const packet = trackData.packets[i]!;
					const endTimestamp = packet.timestamp + packet.duration;

					if (trackData.info.type === 'video') {
						videoEndTimestamp = Math.max(videoEndTimestamp ?? -Infinity, endTimestamp);

						if (i > 0 && packet.type === 'key') {
							if (
								videoKeyEndTimestamp !== null
								&& packet.timestamp > currentSegmentEndTimestamp
							) {
								break;
							}

							videoKeyEndTimestamp = packet.timestamp;
						}
					} else if (trackData.info.type === 'audio') {
						if (
							audioEndTimestamp !== null
							&& packet.timestamp > currentSegmentEndTimestamp
						) {
							break;
						}

						audioEndTimestamp = packet.timestamp;

						const endTimestamp = packet.timestamp + packet.duration;
						if (endTimestamp <= currentSegmentEndTimestamp) {
							audioEndTimestamp = Math.max(audioEndTimestamp ?? -Infinity, endTimestamp);
							if (i === trackData.packets.length - 1) {
								flushAllAudio = true;
							}
						}
					}
				}
			}

			let endTimestamp: number | null = null;
			if (videoKeyEndTimestamp !== null && videoEndTimestamp! > currentSegmentEndTimestamp) {
				endTimestamp = videoKeyEndTimestamp;
			} else {
				if (isFinalCall) {
					endTimestamp = videoEndTimestamp;
					flushAllVideo = true;
				}

				if (audioEndTimestamp !== null) {
					endTimestamp = Math.max(endTimestamp ?? -Infinity, audioEndTimestamp);
				}
			}

			if (endTimestamp === null) {
				return;
			} else {
				if (!isFinalCall && endTimestamp < currentSegmentEndTimestamp) {
					return;
				}

				for (const trackData of this.trackDatas) {
					const closed = trackData.track.source._closed || isFinalCall;
					if (!closed && !trackData.packets.some(x => x.timestamp >= endTimestamp)) {
						return;
					}
				}
			}

			assert(this.output._rootPath !== null);
			const segmentPath = joinPaths(this.output._rootPath, `segment-${this.nextSegmentId}.ts`);
			const target = await this.output._getTarget({ path: segmentPath });
			this.nextSegmentId++;

			const output = new Output({
				format: new MpegTsOutputFormat(),
				target,
			});

			try {
				const packetSources = new Map<HlsTrackData, MediaSource>();

				for (const trackData of this.trackDatas) {
					if (trackData.packets.length === 0) {
						continue;
					}

					if (trackData.info.type === 'video') {
						const outputTrack = trackData.track as OutputVideoTrack;
						const source = new EncodedVideoPacketSource(outputTrack.source._codec);
						output.addVideoTrack(source, outputTrack.metadata);

						packetSources.set(trackData, source);
					} else if (trackData.info.type === 'audio') {
						const outputTrack = trackData.track as OutputAudioTrack;
						const source = new EncodedAudioPacketSource(outputTrack.source._codec);
						output.addAudioTrack(source, outputTrack.metadata);

						packetSources.set(trackData, source);
					}
				}

				await output.start();

				for (const trackData of this.trackDatas) {
					const source = packetSources.get(trackData);
					if (!source) {
						continue;
					}

					if (trackData.info.type === 'video') {
						const videoPacketSource = source as EncodedVideoPacketSource;
						const meta = { decoderConfig: trackData.info.decoderConfig };

						while (trackData.packets.length > 0) {
							const nextPacket = trackData.packets[0]!;
							if (!flushAllVideo && nextPacket.timestamp >= endTimestamp) {
								break;
							}

							trackData.packets.shift();
							await videoPacketSource.add(nextPacket, meta);
						}

						videoPacketSource.close();
					} else if (trackData.info.type === 'audio') {
						const audioPacketSource = source as EncodedAudioPacketSource;
						const meta = { decoderConfig: trackData.info.decoderConfig };

						while (trackData.packets.length > 0) {
							const nextPacket = trackData.packets[0]!;
							if (!flushAllAudio && nextPacket.timestamp >= endTimestamp) {
								break;
							}

							trackData.packets.shift();
							await audioPacketSource.add(nextPacket, meta);
						}

						audioPacketSource.close();
					}
				}

				await output.finalize();
			} catch (e) {
				await output.cancel();
				throw e;
			}

			this.writtenSegments.push({
				path: segmentPath,
				duration: endTimestamp - this.currentSegmentStartTimestamp,
			});

			this.currentSegmentStartTimestamp = endTimestamp;
		}
	}

	async finalize() {
		const release = await this.mutex.acquire();

		await this.ting(true);

		let targetDuration = this.targetSegmentDuration;
		for (const segment of this.writtenSegments) {
			targetDuration = Math.max(targetDuration, segment.duration);
		}

		const playlist = '#EXTM3U\n'
			+ '#EXT-X-VERSION:3\n'
			+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
			+ `#EXT-X-TARGETDURATION:${+targetDuration.toPrecision(13)}\n`
			+ '\n'
			+ (this.writtenSegments
				.map(segment => (
					`#EXTINF:${+segment.duration.toPrecision(13)}\n`
					+ `${segment.path}\n`
				))
				.join(''))
			+ '\n'
			+ '#EXT-X-ENDLIST\n';

		const rootWriter = await this.output._getRootWriter();
		rootWriter.write(textEncoder.encode(playlist));

		release();
	}
}
