import { MediaCodec, validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import { EncodedAudioPacketSource, EncodedVideoPacketSource, MediaSource } from '../media-source';
import { assert, joinPaths, textEncoder, UNDETERMINED_LANGUAGE } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack, TrackType } from '../output';
import { HlsOutputFormat, HlsOutputFormatOptions, OutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { SubtitleCue, SubtitleMetadata } from '../subtitles';

type HlsTrackData = {
	track: OutputTrack;
	packets: EncodedPacket[];
	playlist: Playlist;
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
	key: string;
	path: string;
	tracks: OutputTrack[];
	segmentFormat: OutputFormat;

	currentSegmentStartTimestamp: number | null;
	nextSegmentId: number;
	writtenSegments: {
		path: string;
		duration: number;
		byteSize: number;
	}[];
	peakBitrate: number | null;
	averageBitrate: number | null;
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

	targetSegmentDuration = 2;
	trackDatas: HlsTrackData[] = [];

	playlists: Playlist[] = [];
	playlistDeclarations: PlaylistDeclaration[] = [];

	constructor(output: Output, format: HlsOutputFormat) {
		if (typeof output._target !== 'function') {
			throw new TypeError('HLS outputs require `OutputOptions.target` to be a function.');
		}

		super(output);

		this.format = format;

		this.getPlaylistPath = format._options.getPlaylistPath
			?? (({ n }) => `playlist-${n}.m3u8`);
		this.getSegmentPath = format._options.getSegmentPath
			?? (info => `segment-${info.playlist.n}-${info.n}${info.format.fileExtension}`);
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

		// First, let's build the "sibling" groups induced by track pairability
		for (const track of this.output._tracks) {
			if (track.type === 'video') {
				hasVideo = true;
			}

			const pairableGroups = new Map<MediaCodec, OutputTrack[]>();
			const trackGroups = Array.isArray(track.metadata.group)
				? track.metadata.group
				: [track.metadata.group!];

			for (const otherTrack of this.output._tracks) {
				if (track === otherTrack) {
					continue;
				}

				let pairable = false;
				const otherTrackGroups = Array.isArray(otherTrack.metadata.group)
					? otherTrack.metadata.group
					: [otherTrack.metadata.group!];

				for (const group of trackGroups) {
					const pairableInSameGroup = track.type !== otherTrack.type
						&& otherTrackGroups.some(otherGroup => group === otherGroup);
					if (pairableInSameGroup) {
						pairable = true;
						break;
					}

					const pairableAcrossGroups = otherTrackGroups.some(
						otherGroup => group._pairedGroups.has(otherGroup),
					);
					if (pairableAcrossGroups) {
						pairable = true;
						break;
					}
				}

				if (!pairable) {
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
				if (track.type === 'video') {
					videoCount++;
					requiresRotationMetadata ||= (track.metadata.rotation ?? 0) !== 0;
				} else if (track.type === 'audio') {
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

			const key = tracks.map(x => x.id).join('-');
			const format = deduceSegmentFormat(tracks);

			const playlist: Playlist = {
				id: this.playlists.length + 1,
				key,
				path,
				tracks,
				segmentFormat: format,
				currentSegmentStartTimestamp: null,
				nextSegmentId: 1,
				writtenSegments: [],
				peakBitrate: null,
				averageBitrate: null,
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

				const key = track.id.toString();
				let playlist = this.playlists.find(x => x.key === key);
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
			const key = variant.tracks.map(x => x.id).join('-');
			let playlist = this.playlists.find(x => x.key === key);
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
		throw new Error('TODO');
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
			if (!trackData) {
				return;
			}

			await this.advancePlaylist(trackData.playlist);
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
			} else {
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
			} else {
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

	async advancePlaylist(playlist: Playlist, isFinalCall = false) {
		assert(playlist.currentSegmentStartTimestamp !== null);

		if (!this.allTracksAreKnown(playlist)) {
			return;
		}

		while (true) {
			const currentSegmentEndTimestamp = playlist.currentSegmentStartTimestamp + this.targetSegmentDuration;

			let videoKeyEndTimestamp: number | null = null;
			let videoEndTimestamp: number | null = null;
			let audioEndTimestamp: number | null = null;
			let flushAllVideo = false;
			let flushAllAudio = false;

			const trackDatas = this.trackDatas.filter(x => playlist.tracks.includes(x.track));

			for (const trackData of trackDatas) {
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

				for (const trackData of trackDatas) {
					const closed = trackData.track.source._closed || isFinalCall;
					if (!closed && !trackData.packets.some(x => x.timestamp >= endTimestamp)) {
						return;
					}
				}
			}

			const relativeSegmentPath = await this.getSegmentPath({
				n: playlist.nextSegmentId,
				format: playlist.segmentFormat,
				playlist: {
					n: playlist.id,
					tracks: playlist.tracks,
				},
			});
			if (typeof relativeSegmentPath !== 'string') {
				throw new TypeError('options.getSegmentPath must return or resolve to a string');
			}
			if (/[\n\r"]/.test(relativeSegmentPath)) {
				throw new TypeError(
					'Segment paths cannot contain line feed or carriage return characters.',
				);
			}

			assert(this.output._rootPath !== null);
			const fullSegmentPath = joinPaths(joinPaths(this.output._rootPath, playlist.path), relativeSegmentPath);
			playlist.nextSegmentId++;

			let segmentSize = 0;
			const output = new Output({
				format: playlist.segmentFormat,
				rootPath: fullSegmentPath,
				target: async (request) => {
					const target = await this.output._getTarget(request);

					if (request.path === fullSegmentPath) {
						target.onwrite = (_, end) => segmentSize = Math.max(segmentSize, end);
					}

					return target;
				},
			});

			try {
				const packetSources = new Map<HlsTrackData, MediaSource>();

				for (const trackData of trackDatas) {
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

				for (const trackData of trackDatas) {
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

			playlist.writtenSegments.push({
				path: relativeSegmentPath,
				duration: endTimestamp - playlist.currentSegmentStartTimestamp,
				byteSize: segmentSize,
			});

			playlist.currentSegmentStartTimestamp = endTimestamp;
		}
	}

	async finalize() {
		assert(this.output._rootPath !== null);
		const release = await this.mutex.acquire();

		for (const playlist of this.playlists) {
			if (playlist.currentSegmentStartTimestamp !== null) {
				await this.advancePlaylist(playlist, true);
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

		const playlistPromises = this.playlists.map(async (playlist) => {
			let targetDuration = this.targetSegmentDuration;
			for (const segment of playlist.writtenSegments) {
				targetDuration = Math.max(targetDuration, segment.duration);
			}

			const playlistPath = joinPaths(this.output._rootPath!, playlist.path);
			const playlistText = '#EXTM3U\n'
				+ '#EXT-X-VERSION:3\n'
				+ '#EXT-X-PLAYLIST-TYPE:VOD\n'
				+ `#EXT-X-TARGETDURATION:${+targetDuration.toPrecision(13)}\n`
				+ '\n'
				+ (playlist.writtenSegments
					.map(segment => (
						`#EXTINF:${+segment.duration.toPrecision(13)}\n`
						+ `${segment.path}\n`
					))
					.join(''))
				+ '\n'
				+ '#EXT-X-ENDLIST\n';

			const target = await this.output._getTarget({ path: playlistPath });
			const writer = target._createWriter();
			writer.write(textEncoder.encode(playlistText));
			await writer.finalize();
		});

		const masterPlaylistPromise = (async () => {
			let masterPlaylistText = '#EXTM3U\n';
			let lastGroupId: string | null = null;
			let firstVariantWritten = false;

			for (const decl of this.playlistDeclarations) {
				if (decl.groupId === null) {
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

					masterPlaylistText += `#EXT-X-STREAM-INF:`;
					masterPlaylistText += `BANDWIDTH=${Math.ceil(totalPeakBitrate)}`;

					if (totalAverageBitrate > 0) {
						masterPlaylistText += `,AVERAGE-BANDWIDTH=${Math.ceil(totalAverageBitrate)}`;
					}

					masterPlaylistText += `,CODECS="${codecs.join(',')}"`;

					const videoTrack = decl.playlist.tracks.find(x => x.type === 'video');
					if (videoTrack) {
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

						if (videoTrack.metadata.frameRate !== undefined) {
							masterPlaylistText += `,FRAME-RATE=${videoTrack.metadata.frameRate}`;
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

					const groupIdForType = new Map<string, string>();
					for (const ref of decl.references) {
						assert(ref.groupId !== null);
						const type = ref.playlist.tracks[0]!.type;
						groupIdForType.set(type, ref.groupId);
					}

					for (const [type, id] of groupIdForType) {
						masterPlaylistText += `,${type.toUpperCase()}="${id}"`;
					}

					masterPlaylistText += '\n';
					masterPlaylistText += `${decl.playlist.path}\n`;
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

			const rootWriter = await this.output._getRootWriter();
			rootWriter.write(textEncoder.encode(masterPlaylistText));
		})();

		await Promise.all([...playlistPromises, masterPlaylistPromise]);

		release();
	}
}
