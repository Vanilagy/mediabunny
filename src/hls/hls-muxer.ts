import { MediaCodec, validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../media-source';
import { arrayArgmax, assert, findLastIndex, joinPaths, textEncoder, UNDETERMINED_LANGUAGE } from '../misc';
import { Muxer } from '../muxer';
import {
	Output,
	OutputAudioTrack,
	OutputSubtitleTrack,
	OutputTrack,
	outputTracksArePairable,
	OutputVideoTrack,
	TrackType,
} from '../output';
import { HlsOutputFormat, HlsOutputFormatOptions, HlsOutputSegmentInfo, OutputFormat } from '../output-format';
import { Writer } from '../writer';
import { EncodedPacket } from '../packet';
import { SubtitleCue, SubtitleMetadata } from '../subtitles';
import { Target } from '../target';

type HlsTrackData = {
	track: OutputTrack;
	packets: EncodedPacket[];
	playlist: Playlist;
	// We must store it on the TrackData, reading it directly from the track leads to async race conditions!
	closed: boolean;
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

type Playlist = {
	id: number;
	path: string;
	tracks: OutputTrack[];
	segmentFormat: OutputFormat;

	currentSegmentStartTimestamp: number | null;
	currentSegmentStartTimestampIsFixed: boolean;
	nextSegmentId: number;
	writtenSegments: {
		path: string;
		duration: number;
		byteSize: number;
		byteOffset: number | null;
	}[];
	peakBitrate: number | null;
	averageBitrate: number | null;

	singleFile: {
		target: Target;
		path: string;
		nextOffset: number;
		info: HlsOutputSegmentInfo;
	} | null;
};

type PlaylistDeclaration = {
	playlist: Playlist;
	groupId: string | null;
	noUri: boolean;
	references: PlaylistDeclaration[];
};

export class HlsMuxer extends Muxer {
	format: HlsOutputFormat;
	getPlaylistPath: NonNullable<HlsOutputFormatOptions['getPlaylistPath']>;
	getSegmentPath: NonNullable<HlsOutputFormatOptions['getSegmentPath']>;

	targetSegmentDuration: number;
	trackDatas: HlsTrackData[] = [];
	singleFilePerPlaylist: boolean;

	playlists: Playlist[] = [];
	playlistDeclarations: PlaylistDeclaration[] = [];

	constructor(output: Output, format: HlsOutputFormat) {
		if (typeof output._target !== 'function') {
			throw new TypeError('HLS outputs require `OutputOptions.target` to be a function.');
		}

		super(output);

		this.format = format;
		this.targetSegmentDuration = format._options.targetDuration ?? 2;
		this.singleFilePerPlaylist = format._options.singleFilePerPlaylist ?? false;

		this.getPlaylistPath = format._options.getPlaylistPath
			?? (({ n }) => `playlist-${n}.m3u8`);
		this.getSegmentPath = format._options.getSegmentPath
			?? (info => info.isSingleFile
				? `segments-${info.playlist.n}${info.format.fileExtension}`
				: `segment-${info.playlist.n}-${info.n}${info.format.fileExtension}`);
	}

	async start(): Promise<void> {
		// Upon starting, we now need to assign the tracks to separate playlists. This assignment will make use of the
		// track pairability information provided by the user as well as other metadata specified on the tracks. The
		// resulting master playlist should preserve track pairability; meaning that all tracks that are pairable
		// remain pairable, and no two tracks become pairable that are meant to be mutually exclusive.
		// The algorithm determines "groups" by enumerating all pairable tracks for each track, and then materializes
		// each group either as #EXT-X-MEDIA tags or top-level #EXT-X-STREAM-INF tags. The algorithm is biased towards
		// video being the top-level grouping, since that's the standard practice.

		const groupAssignment = new Map<OutputTrack, string[]>();
		const groups: {
			name: string;
			key: string;
			tracks: OutputTrack[];
			needsEmit: boolean;
			firstNoUri: boolean;
		}[] = [];

		let hasVideo = false;
		let illegalPairingDetected = false;
		let keyPacketsOnlyPairingWarned = false;

		// First, let's build the "sibling" groups induced by track pairability
		for (const track of this.output._tracks) {
			if (track.type === 'video') {
				hasVideo = true;
			}

			const pairableGroups = new Map<MediaCodec, OutputTrack[]>();

			for (const otherTrack of this.output._tracks) {
				if (track === otherTrack) {
					continue;
				}

				if (!outputTracksArePairable(track, otherTrack)) {
					continue;
				}

				if (track.type === otherTrack.type) {
					if (!illegalPairingDetected) {
						console.warn(
							`Illegal pairing of two ${track.type} tracks detected, which is not possible in HLS;`
							+ ` treating them as unpaired.`,
						);
						illegalPairingDetected = true;
					}

					continue;
				}

				// Key-packets-only tracks can neither pair with nor be paired with other tracks
				if (
					(track.isVideoTrack() && track.metadata.hasOnlyKeyPackets)
					|| (otherTrack.isVideoTrack() && otherTrack.metadata.hasOnlyKeyPackets)
				) {
					if (!keyPacketsOnlyPairingWarned) {
						console.warn(
							`A key-packets-only video track is pairable with another track, which is not`
							+ ` possible in HLS; treating them as unpaired.`,
						);
						keyPacketsOnlyPairingWarned = true;
					}

					continue;
				}

				let groupTracks = pairableGroups.get(otherTrack.source._codec);
				if (!groupTracks) {
					pairableGroups.set(otherTrack.source._codec, groupTracks = []);
				}

				groupTracks.push(otherTrack);
			}

			for (const [, pairableTracks] of pairableGroups) {
				const key = pairableTracks.map(x => x.id).join('-');
				const group = groups.find(x => x.key === key);
				if (!group) {
					groups.push({
						name: pairableTracks[0]!.type + '-' + (groups.length + 1),
						key,
						tracks: pairableTracks,
						needsEmit: false,
						firstNoUri: false,
					});
				}

				let assignedGroups = groupAssignment.get(track);
				if (!assignedGroups) {
					groupAssignment.set(track, assignedGroups = []);
				}
				assignedGroups.push(key);
			}
		}

		const mainType: TrackType = hasVideo ? 'video' : 'audio';

		const variantStreams: {
			tracks: OutputTrack[];
			linkedGroup: typeof groups[number] | null;
		}[] = [];

		const unpairedVideoTracks: OutputTrack[] = [];
		const unpairedAudioTracks: OutputTrack[] = [];

		// Now, create the top-level variant streams
		for (const track of this.output._tracks) {
			const assignedGroupKeys = groupAssignment.get(track);
			if (assignedGroupKeys) {
				assert(assignedGroupKeys.length > 0);

				if (track.type !== mainType) {
					continue;
				}

				for (const key of assignedGroupKeys) {
					const group = groups.find(x => x.key === key);
					assert(group);

					if (assignedGroupKeys.length === 1 && group.tracks.length === 1) {
						const otherGroupKeys = groupAssignment.get(group.tracks[0]!);
						assert(otherGroupKeys !== undefined);

						if (otherGroupKeys.length === 1) {
							const otherGroup = groups.find(x => x.key === otherGroupKeys[0]!)!;

							if (otherGroup.tracks.length === 1) {
								assert(otherGroup.tracks[0] === track);

								variantStreams.push({
									tracks: [track, group.tracks[0]!],
									linkedGroup: null,
								});
								continue;
							}
						}
					}

					variantStreams.push({
						tracks: [track],
						linkedGroup: group,
					});
					group.needsEmit = true;
				}
			} else {
				if (track.type === 'video') {
					unpairedVideoTracks.push(track);
				} else if (track.type === 'audio') {
					unpairedAudioTracks.push(track);
				}
			}
		}

		// Video tracks that can't be paired with any other track always live on the top-level, the question is just if
		// they need to be separated into #EXT-X-MEDIA tags or not
		if (unpairedVideoTracks.length > 0) {
			const uniqueMetadata = new Set(unpairedVideoTracks.map(({ metadata }) => {
				let key = '';
				key += `${metadata.languageCode ?? UNDETERMINED_LANGUAGE}-`;
				key += `${metadata.disposition?.default ?? true}-`;
				key += `${metadata.disposition?.primary ?? false}-`;
				key += `${metadata.disposition?.forced ?? false}-`;

				return key;
			}));

			if (uniqueMetadata.size > 1) {
				// They differ in metadata, emit as group
				const group: typeof groups[number] = {
					key: unpairedVideoTracks.map(x => x.id).join('-'),
					name: 'video-' + (groups.length + 1),
					tracks: unpairedVideoTracks,
					needsEmit: true,
					firstNoUri: true,
				};
				groups.push(group);

				variantStreams.push({
					tracks: [unpairedVideoTracks[0]!],
					linkedGroup: group,
				});
			} else {
				for (const track of unpairedVideoTracks) {
					variantStreams.push({
						tracks: [track],
						linkedGroup: null,
					});
				}
			}
		}

		// Audio tracks that can't be paired with any other track always live on the top-level, the question is just if
		// they need to be separated into #EXT-X-MEDIA tags or not
		if (unpairedAudioTracks.length > 0) {
			const uniqueMetadata = new Set(unpairedAudioTracks.map(({ metadata }) => {
				let key = '';
				key += `${metadata.languageCode ?? UNDETERMINED_LANGUAGE}-`;
				key += `${metadata.disposition?.default ?? true}-`;
				key += `${metadata.disposition?.primary ?? false}-`;
				key += `${metadata.disposition?.forced ?? false}-`;

				return key;
			}));

			if (uniqueMetadata.size > 1) {
				// They differ in metadata, emit as group
				const group: typeof groups[number] = {
					key: unpairedAudioTracks.map(x => x.id).join('-'),
					name: 'audio-' + (groups.length + 1),
					tracks: unpairedAudioTracks,
					needsEmit: true,
					firstNoUri: true,
				};
				groups.push(group);

				variantStreams.push({
					tracks: [unpairedAudioTracks[0]!],
					linkedGroup: group,
				});
			} else {
				for (const track of unpairedAudioTracks) {
					variantStreams.push({
						tracks: [track],
						linkedGroup: null,
					});
				}
			}
		}

		const deduceSegmentFormat = (tracks: OutputTrack[]) => {
			const codecs: MediaCodec[] = [];
			let videoCount = 0;
			let audioCount = 0;
			let requiresRotationMetadata = false;

			let candidate: OutputFormat | null = null;
			let candidateScore = -Infinity;

			for (const track of tracks) {
				if (track.isVideoTrack()) {
					videoCount++;
					requiresRotationMetadata ||= (track.metadata.rotation ?? 0) !== 0;
				} else if (track.isAudioTrack()) {
					audioCount++;
				}

				codecs.push(track.source._codec);
			}

			for (const format of this.format._options.segmentFormats) {
				const supportedCodecs = format.getSupportedCodecs();
				const trackCounts = format.getSupportedTrackCounts();

				if (codecs.some(codec => !supportedCodecs.includes(codec))) {
					continue;
				}

				if (videoCount < trackCounts.video.min || videoCount > trackCounts.video.max) {
					continue;
				}

				if (audioCount < trackCounts.audio.min || audioCount > trackCounts.audio.max) {
					continue;
				}

				let score = 0;
				if (requiresRotationMetadata && format.supportsVideoRotationMetadata) {
					score++;
				}

				if (score > candidateScore) {
					candidate = format;
					candidateScore = score;
				}
			}

			// We must find a format. If no format is found, that means we incorrectly gated track creation and
			// assignment at an earlier step.
			assert(candidate);

			return candidate;
		};

		const registerPlaylist = async (tracks: OutputTrack[]) => {
			if (tracks.some(track => this.playlists.some(playlist => playlist.tracks.includes(track)))) {
				throw new Error('Internal error: track is already registered in a playlist.'); // Should be unreachable
			}

			const id = this.playlists.length + 1;
			const path = await this.getPlaylistPath({
				n: id,
				tracks,
			});
			if (typeof path !== 'string') {
				throw new TypeError('options.getPlaylistPath must return or resolve to a string');
			}
			if (/[\n\r"]/.test(path)) {
				throw new TypeError(
					'Playlist paths cannot contain line feed, carriage return, or double quote characters.',
				);
			}

			const format = deduceSegmentFormat(tracks);

			const playlist: Playlist = {
				id: this.playlists.length + 1,
				path,
				tracks,
				segmentFormat: format,
				currentSegmentStartTimestamp: null,
				currentSegmentStartTimestampIsFixed: false,
				nextSegmentId: 1,
				writtenSegments: [],
				peakBitrate: null,
				averageBitrate: null,
				singleFile: null,
			};
			this.playlists.push(playlist);

			return playlist;
		};

		// Now, finally let's create all declarations. Each declaration maps to one #EXT-X-MEDIA or #EXT-X-STREAM-INF
		// tag in the final master playlist.
		for (const group of groups) {
			if (!group.needsEmit) {
				continue;
			}

			for (let i = 0; i < group.tracks.length; i++) {
				const track = group.tracks[i]!;

				let playlist = this.playlists.find(x => x.tracks[0]!.id === track.id);
				playlist ??= await registerPlaylist([track]);

				this.playlistDeclarations.push({
					playlist,
					groupId: group.name,
					noUri: group.firstNoUri && i === 0,
					references: [],
				});
			}
		}

		for (const variant of variantStreams) {
			// Since tracks can only be assigned to one playlist, the first track's ID acts as a "playlist key"
			let playlist = this.playlists.find(x => x.tracks[0]!.id === variant.tracks[0]!.id);
			playlist ??= await registerPlaylist(variant.tracks);

			this.playlistDeclarations.push({
				playlist,
				groupId: null,
				noUri: false,
				references: variant.linkedGroup
					? this.playlistDeclarations.filter(x => x.groupId === variant.linkedGroup!.name)
					: [],
			});
		}
	}

	async getMimeType(): Promise<string> {
		return 'application/vnd.apple.mpegurl';
	}

	private allTracksAreKnown(playlist: Playlist) {
		for (const track of playlist.tracks) {
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
			const trackData = this.trackDatas.find(x => x.track === track);
			if (trackData) {
				trackData.closed = true;
			}

			const playlist = this.playlists.find(x => x.tracks.includes(track));
			assert(playlist); // If there isn't one then the assignment algo failed innit
			await this.advancePlaylist(playlist);
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

		const playlists = this.playlists.filter(x => x.tracks.includes(track));
		assert(playlists.length === 1);

		trackData = {
			track,
			packets: [],
			playlist: playlists[0]!,
			closed: false,
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

		const playlists = this.playlists.filter(x => x.tracks.includes(track));
		assert(playlists.length === 1);

		trackData = {
			track,
			packets: [],
			playlist: playlists[0]!,
			closed: false,
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

			const playlist = trackData.playlist;

			if (playlist.currentSegmentStartTimestamp === null) {
				playlist.currentSegmentStartTimestamp = adjustedPacket.timestamp;
			} else if (!playlist.currentSegmentStartTimestampIsFixed) {
				playlist.currentSegmentStartTimestamp = Math.min(
					playlist.currentSegmentStartTimestamp,
					adjustedPacket.timestamp,
				);
			}

			await this.advancePlaylist(playlist);
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

			const playlist = trackData.playlist;

			if (playlist.currentSegmentStartTimestamp === null) {
				playlist.currentSegmentStartTimestamp = adjustedPacket.timestamp;
			} else if (!playlist.currentSegmentStartTimestampIsFixed) {
				playlist.currentSegmentStartTimestamp = Math.min(
					playlist.currentSegmentStartTimestamp,
					adjustedPacket.timestamp,
				);
			}

			await this.advancePlaylist(playlist);
		} finally {
			release();
		}
	}

	async addSubtitleCue(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		track: OutputSubtitleTrack,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		cue: SubtitleCue,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		meta?: SubtitleMetadata,
	) {
		throw new Error('Unreachable.');
	}

	async advancePlaylist(playlist: Playlist) {
		assert(playlist.currentSegmentStartTimestamp !== null);

		if (!this.allTracksAreKnown(playlist)) {
			return;
		}

		const trackDatas = this.trackDatas.filter(x => playlist.tracks.includes(x.track));
		const videoTrack = trackDatas.find(x => x.info.type === 'video') as HlsVideoTrackData | undefined;
		const audioTrack = trackDatas.find(x => x.info.type === 'audio') as HlsAudioTrackData | undefined;

		// Loop in case we can finalize multiple segments
		while (true) {
			const currentSegmentEndTimestamp = playlist.currentSegmentStartTimestamp + this.targetSegmentDuration;

			// These store the index (exclusive) until when packets can be added to the next segment
			let videoEndIndex = 0;
			let audioEndIndex = 0;

			if (videoTrack && (!videoTrack.closed || videoTrack.packets.length > 0)) {
				const allBelow = videoTrack.packets.every(x => x.timestamp < currentSegmentEndTimestamp);

				let bestKeyPacket: EncodedPacket | null = null;
				let bestKeyPacketIndex: number | null = null;

				if (allBelow) {
					if (!videoTrack.closed) {
						// Not enough data yet
						return;
					}
				} else {
					// Find the best key packet timestamp
					for (let i = 0; i < videoTrack.packets.length; i++) {
						const packet = videoTrack.packets[i]!;

						if (bestKeyPacket !== null && packet.timestamp > currentSegmentEndTimestamp) {
							break;
						}

						if (i > 0 && packet.type === 'key') {
							bestKeyPacket = packet;
							bestKeyPacketIndex = i;
						}
					}
				}

				if (bestKeyPacketIndex !== null) {
					videoEndIndex = bestKeyPacketIndex;

					if (audioTrack) {
						// The audio track must go at least until the video key frame
						const index = audioTrack.packets.findIndex(x => x.timestamp >= bestKeyPacket!.timestamp);
						if (index !== -1) {
							audioEndIndex = index;
						} else {
							if (audioTrack.closed) {
								audioEndIndex = audioTrack.packets.length;
							} else {
								return;
							}
						}
					}
				} else {
					if (!videoTrack.closed) {
						return;
					}

					// Include the entire rest of the video (since there's no key frame to split it on)
					videoEndIndex = videoTrack.packets.length;
					const maxIndex = arrayArgmax(videoTrack.packets, x => x.timestamp);
					const maxPacket = videoTrack.packets[maxIndex];
					assert(maxPacket);

					if (audioTrack) {
						if (maxPacket.timestamp < currentSegmentEndTimestamp) {
							// The audio must go until at least the start of the next segment
							const index = audioTrack.packets.findIndex(x => x.timestamp >= currentSegmentEndTimestamp);
							if (index !== -1) {
								audioEndIndex = index;
							} else {
								if (audioTrack.closed) {
									audioEndIndex = audioTrack.packets.length;
								} else {
									return;
								}
							}
						} else {
							// The audio must go beyond the last video packet
							const index = audioTrack.packets.findIndex(x => x.timestamp > maxPacket.timestamp);
							if (index !== -1) {
								audioEndIndex = index;
							} else {
								if (audioTrack.closed) {
									audioEndIndex = audioTrack.packets.length;
								} else {
									return;
								}
							}
						}
					}
				}
			} else if (audioTrack && (!audioTrack.closed || audioTrack.packets.length > 0)) {
				const allBelow = audioTrack.packets.every(x => x.timestamp < currentSegmentEndTimestamp);

				if (allBelow) {
					if (audioTrack.closed) {
						audioEndIndex = audioTrack.packets.length;
					} else {
						return;
					}
				} else {
					const index = findLastIndex(audioTrack.packets, x => x.timestamp <= currentSegmentEndTimestamp);
					if (index !== -1) {
						audioEndIndex = index;
					} else {
						audioEndIndex = 1;
					}
				}
			}

			if (videoEndIndex === 0 && audioEndIndex === 0) {
				return;
			}

			// We can finalize a new segment!

			let segmentInfo: HlsOutputSegmentInfo | null = null;
			let relativeSegmentPath: string;
			let fullSegmentPath: string;

			assert(this.output._rootPath !== null);

			if (this.singleFilePerPlaylist) {
				if (playlist.singleFile === null) {
					const segmentInfo: HlsOutputSegmentInfo = {
						n: playlist.nextSegmentId,
						format: playlist.segmentFormat,
						isSingleFile: true,
						playlist: {
							n: playlist.id,
							tracks: playlist.tracks,
						},
					};

					relativeSegmentPath = await this.getSegmentPath(segmentInfo);
					validateSegmentPath(relativeSegmentPath);

					fullSegmentPath = joinPaths(
						joinPaths(this.output._rootPath, playlist.path),
						relativeSegmentPath,
					);

					const target = await this.output._getTarget({ path: fullSegmentPath, isRoot: false });
					target._start();

					playlist.singleFile = {
						target,
						path: relativeSegmentPath,
						nextOffset: 0,
						info: segmentInfo,
					};
				} else {
					relativeSegmentPath = playlist.singleFile.path;
					fullSegmentPath = joinPaths(
						joinPaths(this.output._rootPath, playlist.path),
						relativeSegmentPath,
					);
				}
			} else {
				segmentInfo = {
					n: playlist.nextSegmentId,
					format: playlist.segmentFormat,
					isSingleFile: false,
					playlist: {
						n: playlist.id,
						tracks: playlist.tracks,
					},
				};

				relativeSegmentPath = await this.getSegmentPath(segmentInfo);
				validateSegmentPath(relativeSegmentPath);

				assert(this.output._rootPath !== null);
				fullSegmentPath = joinPaths(joinPaths(this.output._rootPath, playlist.path), relativeSegmentPath);
				playlist.nextSegmentId++;
			}

			let segmentSize = 0;
			let outputTarget: Target | null = null;

			const output = new Output({
				format: playlist.segmentFormat,
				rootPath: fullSegmentPath,
				target: async (request) => {
					if (request.path === fullSegmentPath) {
						if (playlist.singleFile) {
							const slice = playlist.singleFile.target.slice(playlist.singleFile.nextOffset);
							slice.onwrite = (_, end) => segmentSize = Math.max(segmentSize, end);

							return slice;
						} else {
							const target = await this.output._getTarget(request);
							outputTarget = target;
							target.onwrite = (_, end) => segmentSize = Math.max(segmentSize, end);

							return target;
						}
					}

					return this.output._getTarget(request);
				},
			});

			let maxEndTimestamp = -Infinity;

			try {
				let videoSource: EncodedVideoPacketSource | null = null;
				let audioSource: EncodedAudioPacketSource | null = null;

				if (videoTrack) {
					// Always add the track, no matter if it has packets or not (maintains underlying IDs)
					videoSource = new EncodedVideoPacketSource((videoTrack.track as OutputVideoTrack).source._codec);
					output.addVideoTrack(videoSource, videoTrack.track.metadata);
				}

				if (audioTrack) {
					// Always add the track, no matter if it has packets or not (maintains underlying IDs)
					audioSource = new EncodedAudioPacketSource((audioTrack.track as OutputAudioTrack).source._codec);
					output.addAudioTrack(audioSource, audioTrack.track.metadata);
				}

				await output.start();

				// Add all of the packets

				if (videoTrack) {
					assert(videoSource);
					const meta = { decoderConfig: videoTrack.info.decoderConfig };

					for (let i = 0; i < videoEndIndex; i++) {
						const packet = videoTrack.packets[i]!;

						await videoSource.add(packet, meta);
						maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
					}
				}

				if (audioTrack) {
					assert(audioSource);
					const meta = { decoderConfig: audioTrack.info.decoderConfig };

					for (let i = 0; i < audioEndIndex; i++) {
						const packet = audioTrack.packets[i]!;

						await audioSource.add(packet, meta);
						maxEndTimestamp = Math.max(maxEndTimestamp, packet.timestamp + packet.duration);
					}
				}

				await output.finalize();
			} catch (e) {
				await output.cancel();
				throw e;
			}

			if (segmentInfo) {
				assert(outputTarget);
				this.format._options.onSegment?.(outputTarget, segmentInfo);
			}

			if (videoEndIndex > 0) {
				assert(videoTrack);
				videoTrack.packets.splice(0, videoEndIndex);
			}
			if (audioEndIndex > 0) {
				assert(audioTrack);
				audioTrack.packets.splice(0, audioEndIndex);
			}

			let minNextTimestamp = Infinity;
			if (videoTrack && videoTrack.packets.length > 0) {
				minNextTimestamp = videoTrack.packets[0]!.timestamp;
			}
			if (audioTrack && audioTrack.packets.length > 0) {
				minNextTimestamp = Math.min(minNextTimestamp, audioTrack.packets[0]!.timestamp);
			}

			const nextSegmentStartTimestamp = minNextTimestamp < Infinity
				? minNextTimestamp
				: maxEndTimestamp; // Happens for the last segment for example
			assert(Number.isFinite(nextSegmentStartTimestamp));

			playlist.writtenSegments.push({
				path: relativeSegmentPath,
				duration: nextSegmentStartTimestamp - playlist.currentSegmentStartTimestamp,
				byteSize: segmentSize,
				byteOffset: playlist.singleFile
					? playlist.singleFile.nextOffset
					: null,
			});

			playlist.currentSegmentStartTimestamp = nextSegmentStartTimestamp;
			playlist.currentSegmentStartTimestampIsFixed = true; // After the first segment, the timestamp is now fixed

			if (playlist.singleFile) {
				playlist.singleFile.nextOffset += segmentSize;
			}
		}
	}

	async finalize() {
		assert(this.output._rootPath !== null);
		const release = await this.mutex.acquire();

		for (const trackData of this.trackDatas) {
			trackData.closed = true;
		}

		for (const playlist of this.playlists) {
			if (playlist.currentSegmentStartTimestamp !== null) {
				await this.advancePlaylist(playlist);
			} else {
				// Never had any data written to it
			}

			let peakBitrate = 0;
			let totalBits = 0;

			for (const segment of playlist.writtenSegments) {
				peakBitrate = Math.max(peakBitrate, 8 * segment.byteSize / segment.duration);
				totalBits += 8 * segment.byteSize;
			}

			playlist.peakBitrate = peakBitrate;

			if (playlist.currentSegmentStartTimestamp !== null) {
				playlist.averageBitrate = totalBits / playlist.currentSegmentStartTimestamp;
			}
		}

		// Write all playlists in parallel
		const playlistPromises = this.playlists.map(async (playlist) => {
			if (playlist.singleFile) {
				await playlist.singleFile.target._flush();
				await playlist.singleFile.target._finalize();

				this.format._options.onSegment?.(playlist.singleFile.target, playlist.singleFile.info);
			}

			let targetDuration = this.targetSegmentDuration;
			let hasByteOffsets = false;
			for (const segment of playlist.writtenSegments) {
				targetDuration = Math.max(targetDuration, segment.duration);
				hasByteOffsets ||= segment.byteOffset !== null;
			}

			const isKeyPacketsOnly = playlist.tracks[0]!.isVideoTrack()
				&& playlist.tracks[0].metadata.hasOnlyKeyPackets;

			let version = 3;
			if (isKeyPacketsOnly || hasByteOffsets) {
				version = 4;
			}

			const playlistPath = joinPaths(this.output._rootPath!, playlist.path);
			const playlistText = '#EXTM3U\n'
				+ `#EXT-X-VERSION:${version}\n`
				+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
				+ `#EXT-X-TARGETDURATION:${Math.ceil(targetDuration)}\n` // Must be a "decimal-integer"
				+ (isKeyPacketsOnly ? '#EXT-X-I-FRAMES-ONLY\n' : '')
				+ '\n'
				+ (playlist.writtenSegments
					.map(segment => (
						`#EXTINF:${+segment.duration.toFixed(12)},\n` // Trailing comma mandated by spec
						+ (segment.byteOffset !== null
							? `#EXT-X-BYTERANGE:${segment.byteSize}@${segment.byteOffset}\n`
							: '')
						+ `${segment.path}\n`
					))
					.join(''))
				+ (playlist.writtenSegments.length > 0 ? '\n' : '')
				+ '#EXT-X-ENDLIST\n';

			this.format._options.onPlaylist?.(playlistText, {
				n: playlist.id,
				tracks: playlist.tracks,
			});

			const target = await this.output._getTarget({ path: playlistPath, isRoot: false });
			const writer = new Writer(target);
			writer.start();
			writer.write(textEncoder.encode(playlistText));

			await writer.flush();
			await writer.finalize();
		});

		const masterPlaylistPromise = (async () => {
			let masterPlaylistText = '#EXTM3U\n';
			let lastGroupId: string | null = null;
			let firstVariantWritten = false;

			for (const decl of this.playlistDeclarations) {
				if (decl.groupId === null) {
					const isKeyPacketsOnly = decl.playlist.tracks[0]!.isVideoTrack()
						&& decl.playlist.tracks[0].metadata.hasOnlyKeyPackets;

					const codecs: string[] = [];
					for (const track of decl.playlist.tracks) {
						const trackData = this.trackDatas.find(x => x.track === track);
						const codecString = trackData?.info.decoderConfig.codec ?? track.source._codec;
						codecs.push(codecString);
					}

					let peakDeclBitrate = 0;
					let totalDeclAverageBitrate = 0;

					if (decl.references.length > 0) {
						const firstRef = decl.references[0]!;
						const firstTrack = firstRef.playlist.tracks[0]!;
						const trackData = this.trackDatas.find(x => x.track === firstTrack);
						const codecString = trackData?.info.decoderConfig.codec ?? firstTrack.source._codec;
						codecs.push(codecString);

						for (const ref of decl.references) {
							assert(ref.playlist.peakBitrate !== null);
							peakDeclBitrate = Math.max(peakDeclBitrate, ref.playlist.peakBitrate);

							if (ref.playlist.averageBitrate !== null) {
								totalDeclAverageBitrate += ref.playlist.averageBitrate;
							}
						}
					}

					assert(decl.playlist.peakBitrate !== null);
					const totalPeakBitrate = decl.playlist.peakBitrate + peakDeclBitrate;
					const totalAverageBitrate = (decl.playlist.averageBitrate ?? 0)
						+ totalDeclAverageBitrate / (decl.references.length || 1);

					if (!firstVariantWritten) {
						masterPlaylistText += '\n';
						firstVariantWritten = true;
					}

					if (isKeyPacketsOnly) {
						masterPlaylistText += `#EXT-X-I-FRAME-STREAM-INF:`;
					} else {
						masterPlaylistText += `#EXT-X-STREAM-INF:`;
					}

					masterPlaylistText += `BANDWIDTH=${Math.ceil(totalPeakBitrate)}`;

					if (totalAverageBitrate > 0) {
						masterPlaylistText += `,AVERAGE-BANDWIDTH=${Math.ceil(totalAverageBitrate)}`;
					}

					masterPlaylistText += `,CODECS="${codecs.join(',')}"`;

					const videoTrack = decl.playlist.tracks.find(x => x.isVideoTrack());
					if (videoTrack?.isVideoTrack()) {
						const trackData = this.trackDatas.find(x => x.track === videoTrack) as
							HlsVideoTrackData | undefined;
						const decoderConfig = trackData?.info.decoderConfig;
						if (decoderConfig) {
							let width = decoderConfig.displayAspectWidth ?? decoderConfig.codedWidth;
							let height = decoderConfig.displayAspectHeight ?? decoderConfig.codedHeight;

							if (width !== undefined && height !== undefined) {
								if (
									videoTrack.metadata.rotation !== undefined
									&& videoTrack.metadata.rotation % 180 !== 90
								) {
									[width, height] = [height, width];
								}

								masterPlaylistText += `,RESOLUTION=${width}x${height}`;
							}
						}

						// FRAME-RATE is not defined for EXT-X-I-FRAME-STREAM-INF
						if (!isKeyPacketsOnly && videoTrack.metadata.frameRate !== undefined) {
							masterPlaylistText += `,FRAME-RATE=${+videoTrack.metadata.frameRate.toFixed(16)}`;
						}
					}

					const name = decl.playlist.tracks.find(x => x.metadata.name !== undefined)?.metadata.name;
					if (name !== undefined) {
						if (/[\n\r"]/.test(name)) {
							console.warn(
								'Dropping track name since it includes a line feed, carriage return, or double quote'
								+ ' character, which are not allowed in HLS playlist attributes.',
							);
						} else {
							masterPlaylistText += `,NAME="${name}"`;
						}
					}

					if (!isKeyPacketsOnly) {
						const groupIdForType = new Map<string, string>();
						for (const ref of decl.references) {
							assert(ref.groupId !== null);
							const type = ref.playlist.tracks[0]!.type;
							groupIdForType.set(type, ref.groupId);
						}

						for (const [type, id] of groupIdForType) {
							masterPlaylistText += `,${type.toUpperCase()}="${id}"`;
						}
					}

					if (isKeyPacketsOnly) {
						// EXT-X-I-FRAME-STREAM-INF is standalone with a URI attribute
						masterPlaylistText += `,URI="${decl.playlist.path}"`;
						masterPlaylistText += '\n';
					} else {
						masterPlaylistText += '\n';
						masterPlaylistText += `${decl.playlist.path}\n`;
					}
				} else {
					assert(decl.playlist.tracks.length === 1);

					const track = decl.playlist.tracks[0]!;
					const type = track.type;
					const name = track.metadata.name;
					const languageCode = track.metadata.languageCode;
					const disposition = track.metadata.disposition;

					if (lastGroupId === null || decl.groupId !== lastGroupId) {
						masterPlaylistText += '\n';
					}
					lastGroupId = decl.groupId;

					masterPlaylistText += `#EXT-X-MEDIA:TYPE=${type.toUpperCase()},GROUP-ID="${decl.groupId}"`;

					if (name !== undefined) {
						if (/[\n\r"]/.test(name)) {
							console.warn(
								'Dropping track name since it includes a line feed, carriage return, or double quote'
								+ ' character, which are not allowed in HLS playlist attributes.',
							);
						} else {
							masterPlaylistText += `,NAME="${name}"`;
						}
					}

					if (languageCode !== undefined) {
						masterPlaylistText += `,LANGUAGE="${languageCode}"`;
					}

					const dispositionPrimary = disposition?.primary ?? false;
					const dispositionDefault = disposition?.default ?? true;
					const dispositionForced = disposition?.forced ?? false;

					if (dispositionPrimary) {
						// HLS's "DEFAULT" behaves like our "primary"
						masterPlaylistText += ',DEFAULT=YES';
					}

					if (dispositionPrimary || dispositionDefault) {
						masterPlaylistText += ',AUTOSELECT=YES';
					}

					if (dispositionForced) {
						masterPlaylistText += ',FORCED=YES';
					}

					if (type === 'audio') {
						const trackData = this.trackDatas.find(x => x.track === track) as
							HlsAudioTrackData | undefined;
						const decoderConfig = trackData?.info.decoderConfig;

						if (decoderConfig) {
							masterPlaylistText += `,CHANNELS=${decoderConfig.numberOfChannels}`;
						}
					}

					if (!decl.noUri) {
						masterPlaylistText += `,URI="${decl.playlist.path}"`;
					}

					masterPlaylistText += '\n';
				}
			}

			this.format._options.onMaster?.(masterPlaylistText);

			const rootWriter = await this.output._getRootWriter();
			rootWriter.write(textEncoder.encode(masterPlaylistText));
		})();

		await Promise.all([...playlistPromises, masterPlaylistPromise]);

		release();
	}
}

const validateSegmentPath = (path: string) => {
	if (typeof path !== 'string') {
		throw new TypeError('options.getSegmentPath must return or resolve to a string');
	}
	if (/[\n\r"]/.test(path)) {
		throw new TypeError(
			'Segment paths cannot contain line feed or carriage return characters.',
		);
	}
};
