/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AUDIO_CODECS, AudioCodec, inferCodecFromCodecString, MediaCodec, VIDEO_CODECS, VideoCodec } from '../codec';
import { Demuxer, DurationMetadataRequestOptions } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import { TrackType } from '../output';
import { assert, joinPaths, MaybePromise, Rotation, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket } from '../packet';
import { readAllLines } from '../reader';
import {
	AttributeList,
	canIgnoreLine,
	HLS_MIME_TYPE,
	TAG_EXTINF,
	TAG_I_FRAME_STREAM_INF,
	TAG_I_FRAMES_ONLY,
	TAG_MEDIA,
	TAG_STREAM_INF,
} from './hls-misc';
import { HlsSegmentedInput } from './hls-segmented-input';
import { SegmentedInputTrackDeclaration } from '../segmented-input';
import { PathedSource } from '../source';

type InternalTrack = {
	id: number;
	demuxer: HlsDemuxer;
	backingTrack: InputTrackBacking | null;
	default: boolean;
	autoselect: boolean;
	languageCode: string;
	lineNumber: number;

	fullPath: string;
	fullCodecString: string;
	pairingMask: bigint;
	peakBitrate: number | null;
	averageBitrate: number | null;
	name: string | null;
	hasOnlyKeyPackets: boolean;

	info: {
		type: 'video';
		width: number | null;
		height: number | null;
	} | {
		type: 'audio';
		numberOfChannels: number | null;
	};
};
type InternalVideoTrack = InternalTrack & { info: { type: 'video' } };
type InternalAudioTrack = InternalTrack & { info: { type: 'audio' } };

export class HlsDemuxer extends Demuxer {
	metadataPromise: Promise<void> | null = null;
	trackBackings: InputTrackBacking[] | null = null;
	internalTracks: InternalTrack[] | null = null;
	segmentedInputs: HlsSegmentedInput[] = [];
	hasMasterPlaylist = true;

	constructor(input: Input) {
		super(input);
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			assert(this.input._rootSource instanceof PathedSource);
			const { rootPath } = this.input._rootSource;

			const slice = await this.input._reader.requestEntireFile();
			assert(slice);
			const lines = readAllLines(slice, slice.length, { ignore: canIgnoreLine });

			const variantStreams: {
				fullPath: string;
				attributes: AttributeList;
				lineNumber: number;
				hasOnlyKeyPackets: boolean;
			}[] = [];
			const mediaTags: {
				fullPath: string | null;
				attributes: AttributeList;
				lineNumber: number;
			}[] = [];

			// Let's first iterate through the entire file, collecting all variant streams and media tags

			for (let i = 1; i < lines.length; i++) {
				const line = lines[i]!;

				if (line.startsWith(TAG_STREAM_INF)) {
					const streamInfLineNumber = i;
					const playlistPath = lines[++i];
					if (playlistPath === undefined) {
						throw new Error('Incorrect M3U8 file; a line must follow the #EXT-X-STREAM-INF tag.');
					}

					const fullPath = joinPaths(rootPath, playlistPath);
					const attributes = new AttributeList(line.slice(TAG_STREAM_INF.length));

					const bandwidth = attributes.getAsNumber('bandwidth');
					if (bandwidth === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-STREAM-INF tag requires a BANDWIDTH attribute with a valid'
							+ ' numerical value.',
						);
					}

					variantStreams.push({
						fullPath,
						attributes,
						lineNumber: streamInfLineNumber,
						hasOnlyKeyPackets: false,
					});
				} else if (line.startsWith(TAG_I_FRAME_STREAM_INF)) {
					const attributes = new AttributeList(line.slice(TAG_I_FRAME_STREAM_INF.length));
					const playlistPath = attributes.get('uri');

					if (playlistPath === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-I-FRAME-STREAM-INF tag requires a URI attribute.',
						);
					}

					const bandwidth = attributes.getAsNumber('bandwidth');
					if (bandwidth === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-I-FRAME-STREAM-INF tag requires a BANDWIDTH attribute with a'
							+ ' valid numerical value.',
						);
					}

					const fullPath = joinPaths(rootPath, playlistPath);

					variantStreams.push({
						fullPath,
						attributes,
						lineNumber: i,
						hasOnlyKeyPackets: true,
					});
				} else if (line.startsWith(TAG_MEDIA)) {
					const attributes = new AttributeList(line.slice(TAG_MEDIA.length));

					const type = attributes.get('type');
					if (type === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-MEDIA tag requires a TYPE attribute.',
						);
					}

					const groupId = attributes.get('group-id');
					if (groupId === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-MEDIA tag requires a GROUP-ID attribute.',
						);
					}

					let fullPath: string | null = null;
					const uri = attributes.get('uri');
					if (uri !== null) {
						fullPath = joinPaths(rootPath, uri);
					}

					mediaTags.push({ fullPath, attributes, lineNumber: i });
				} else if (line === TAG_I_FRAMES_ONLY) {
					// iFramesOnlyTagFound = true;
				} else if (line.startsWith(TAG_EXTINF)) {
					// This is a media playlist, not a master playlist
					const segmentedInput = new HlsSegmentedInput(this, rootPath, null, lines);

					this.segmentedInputs = [segmentedInput];
					this.hasMasterPlaylist = false;
					this.trackBackings = await segmentedInput.getTrackBackings();

					return;
				}
			}

			const videoGroupIds = [...new Set(
				mediaTags
					.filter(tag => tag.attributes.get('type')!.toLowerCase() === 'video')
					.map(tag => tag.attributes.get('group-id')!)),
			];
			const audioGroupIds = [...new Set(
				mediaTags
					.filter(tag => tag.attributes.get('type')!.toLowerCase() === 'audio')
					.map(tag => tag.attributes.get('group-id')!)),
			];

			// Now, let's process & resolve all variant streams in parallel, mapping each of them to tracks.

			const internalTracksByVariant = await Promise.all(variantStreams.map(async (variantStream, i) => {
				const result: InternalTrack[] = [];

				const codecsList = variantStream.attributes.get('codecs');
				let codecStrings: string[];

				if (codecsList) {
					codecStrings = codecsList.split(',').map(x => x.trim());
				} else {
					// No codecs were specified, we need to read the underlying media data
					const segmentedInput = this.getSegmentedInputForPath(variantStream.fullPath);
					const trackBackings = await segmentedInput.getTrackBackings();

					const tracksWithCodec = await Promise.all(
						trackBackings.map(async t => ({ track: t, codec: await t.getCodec() })),
					);
					codecStrings = await Promise.all(
						tracksWithCodec
							.filter(x => x.codec !== null)
							.map(x => x.track.getDecoderConfig().then(x => x!.codec)),
					);
				}

				const videoGroupId = variantStream.attributes.get('video');
				const audioGroupId = variantStream.attributes.get('audio');
				const containsVideoCodecs = codecStrings.some(x =>
					VIDEO_CODECS.includes(inferCodecFromCodecString(x) as VideoCodec),
				);
				const containsAudioCodecs = codecStrings.some(x =>
					AUDIO_CODECS.includes(inferCodecFromCodecString(x) as AudioCodec),
				);

				if (videoGroupId !== null && !containsVideoCodecs) {
					// A video group is linked but no video codec is listed, sigh. Let's resolve the video codec.

					if (!videoGroupIds.includes(videoGroupId)) {
						throw new Error(
							`Invalid M3U8 file; variant stream references video group "${videoGroupId}" which`
							+ ` is not defined in any #EXT-X-MEDIA tags.`,
						);
					}

					// We only need to look at the first matching tag, since all tags are required to have the same
					// codec anyway
					const matchingVideoMediaTag = mediaTags.find((mediaTag) => {
						const groupId = mediaTag.attributes.get('group-id')!;
						const type = mediaTag.attributes.get('type')!;
						return groupId === videoGroupId && type.toLowerCase() === 'video';
					});

					outer:
					if (matchingVideoMediaTag) {
						const uri = matchingVideoMediaTag.attributes.get('uri');
						if (uri === null) {
							break outer;
						}

						const fullPath = joinPaths(rootPath, uri);
						const segmentedInput = this.getSegmentedInputForPath(fullPath);
						const trackBackings = await segmentedInput.getTrackBackings();
						const videoTrack = trackBackings.find(x => x.getType() === 'video');

						if (!videoTrack || (await videoTrack.getCodec()) === null) {
							break outer;
						}

						const additionalCodecString = await videoTrack.getDecoderConfig().then(x => x?.codec ?? null);
						assert(additionalCodecString !== null);

						codecStrings.push(additionalCodecString);
					}
				}

				if (audioGroupId !== null && !containsAudioCodecs) {
					// An audio group is linked but no audio codec is listed, sigh. Let's resolve the audio codec.

					if (!audioGroupIds.includes(audioGroupId)) {
						throw new Error(
							`Invalid M3U8 file; variant stream references audio group "${audioGroupId}" which`
							+ ` is not defined in any #EXT-X-MEDIA tags.`,
						);
					}

					// We only need to look at the first matching tag, since all tags are required to have the same
					// codec anyway
					const matchingAudioMediaTag = mediaTags.find((tag) => {
						const groupId = tag.attributes.get('group-id')!;
						const type = tag.attributes.get('type')!;
						return groupId === audioGroupId && type.toLowerCase() === 'audio';
					});

					outer:
					if (matchingAudioMediaTag) {
						const uri = matchingAudioMediaTag.attributes.get('uri');
						if (uri === null) {
							break outer;
						}

						const fullPath = joinPaths(rootPath, uri);
						const segmentedInput = this.getSegmentedInputForPath(fullPath);
						const trackBackings = await segmentedInput.getTrackBackings();
						const audioTrack = trackBackings.find(x => x.getType() === 'audio');

						if (!audioTrack || (await audioTrack.getCodec()) === null) {
							break outer;
						}

						const additionalCodecString = await audioTrack.getDecoderConfig().then(x => x?.codec ?? null);
						assert(additionalCodecString !== null);

						codecStrings.push(additionalCodecString);
					}
				}

				// Unique that shit
				codecStrings = [...new Set(codecStrings)];

				let videoCodecString: string | null = null;
				let audioCodecString: string | null = null;

				const bandwidth = variantStream.attributes.getAsNumber('bandwidth');
				assert(bandwidth !== null);

				const averageBandwidth = variantStream.attributes.getAsNumber('average-bandwidth');
				const name = variantStream.attributes.get('name');

				// Now, finally, loop over each codec string for the variant and resolve each one to one or more tracks.
				for (const codecString of codecStrings) {
					const inferredCodec = inferCodecFromCodecString(codecString);
					if (inferredCodec === null) {
						continue;
					}

					if (VIDEO_CODECS.includes(inferredCodec as VideoCodec)) {
						if (videoCodecString !== null) {
							throw new Error(
								'Unsupported M3U8 file; multiple video codecs found in the CODECS attribute of a'
								+ ' variant stream.',
							);
						}

						videoCodecString = codecString;

						const videoGroupId = variantStream.attributes.get('video');

						if (videoGroupId === null) {
							const resolution = variantStream.attributes.get('resolution');
							let width: number | null = null;
							let height: number | null = null;

							if (resolution) {
								const match = resolution.match(/^(\d+)x(\d+)$/);
								if (match) {
									width = Number(match[1]);
									height = Number(match[2]);
								}
							}

							result.push({
								id: -1,
								demuxer: this,
								backingTrack: null,
								default: true,
								autoselect: true,
								languageCode: UNDETERMINED_LANGUAGE,
								lineNumber: variantStream.lineNumber,
								fullPath: variantStream.fullPath,
								fullCodecString: videoCodecString,
								pairingMask: 1n << BigInt(i),
								peakBitrate: bandwidth,
								averageBitrate: averageBandwidth,
								name,
								hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
								info: {
									type: 'video',
									width,
									height,
								},
							});
						} else {
							if (!videoGroupIds.includes(videoGroupId)) {
								throw new Error(
									`Invalid M3U8 file; variant stream references video group "${videoGroupId}"`
									+ ` which is not defined in any #EXT-X-MEDIA tags.`,
								);
							}

							for (const mediaTag of mediaTags) {
								const groupId = mediaTag.attributes.get('group-id')!;
								const type = mediaTag.attributes.get('type')!;

								if (groupId !== videoGroupId || type.toLowerCase() !== 'video') {
									continue;
								}

								const resolution = mediaTag.attributes.get('resolution')
									?? variantStream.attributes.get('resolution');
								let width: number | null = null;
								let height: number | null = null;

								if (resolution) {
									const match = resolution.match(/^(\d+)x(\d+)$/);
									if (match) {
										width = Number(match[1]);
										height = Number(match[2]);
									}
								}

								result.push({
									id: -1,
									demuxer: this,
									backingTrack: null,
									default: getMediaTagDefault(mediaTag.attributes),
									// Autoselect is inferred to be true if the default is true
									autoselect: getMediaTagDefault(mediaTag.attributes)
										|| getMediaTagAutoselect(mediaTag.attributes),
									languageCode: preprocessLanguageCode(mediaTag.attributes.get('language')),
									lineNumber: mediaTag.lineNumber,
									fullPath: mediaTag.fullPath ?? variantStream.fullPath,
									fullCodecString: videoCodecString,
									pairingMask: 1n << BigInt(i),
									peakBitrate: null,
									averageBitrate: null,
									name: mediaTag.attributes.get('name'),
									hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
									info: {
										type: 'video',
										width,
										height,
									},
								});
							}
						}
					} else if (AUDIO_CODECS.includes(inferredCodec as AudioCodec)) {
						if (audioCodecString !== null) {
							throw new Error(
								'Unsupported M3U8 file; multiple audio codecs found in the CODECS attribute of a'
								+ ' variant stream.',
							);
						}

						audioCodecString = codecString;

						const audioGroupId = variantStream.attributes.get('audio');

						if (audioGroupId === null) {
							const channels = variantStream.attributes.get('channels');
							const parsedChannels = channels !== null
								? Number(channels.split('/')[0]!)
								: null;

							result.push({
								id: -1,
								demuxer: this,
								backingTrack: null,
								default: true,
								autoselect: true,
								languageCode: UNDETERMINED_LANGUAGE,
								lineNumber: variantStream.lineNumber,
								fullPath: variantStream.fullPath,
								fullCodecString: audioCodecString,
								pairingMask: 1n << BigInt(i),
								peakBitrate: bandwidth,
								averageBitrate: averageBandwidth,
								name,
								hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
								info: {
									type: 'audio',
									numberOfChannels:
											parsedChannels !== null
											&& Number.isInteger(parsedChannels)
											&& parsedChannels > 0
												? parsedChannels
												: null,
								},
							});
						} else {
							if (!audioGroupIds.includes(audioGroupId)) {
								throw new Error(
									`Invalid M3U8 file; variant stream references audio group "${audioGroupId}"`
									+ ` which is not defined in any #EXT-X-MEDIA tags.`,
								);
							}

							for (const mediaTag of mediaTags) {
								const groupId = mediaTag.attributes.get('group-id')!;
								const type = mediaTag.attributes.get('type')!;

								if (groupId !== audioGroupId || type.toLowerCase() !== 'audio') {
									continue;
								}

								const channels = mediaTag.attributes.get('channels')
									?? variantStream.attributes.get('channels');
								const parsedChannels = channels !== null
									? Number(channels.split('/')[0]!)
									: null;

								result.push({
									id: -1,
									demuxer: this,
									backingTrack: null,
									default: getMediaTagDefault(mediaTag.attributes),
									// Autoselect is inferred to be true if the default is true
									autoselect: getMediaTagDefault(mediaTag.attributes)
										|| getMediaTagAutoselect(mediaTag.attributes),
									languageCode: preprocessLanguageCode(mediaTag.attributes.get('language')),
									lineNumber: mediaTag.lineNumber,
									fullPath: mediaTag.fullPath ?? variantStream.fullPath,
									fullCodecString: audioCodecString,
									pairingMask: 1n << BigInt(i),
									peakBitrate: null,
									averageBitrate: null,
									name: mediaTag.attributes.get('name'),
									hasOnlyKeyPackets: variantStream.hasOnlyKeyPackets,
									info: {
										type: 'audio',
										numberOfChannels:
												parsedChannels !== null
												&& Number.isInteger(parsedChannels)
												&& parsedChannels > 0
													? parsedChannels
													: null,
									},
								});
							}
						}
					}
				}

				return result;
			}));

			const internalTracks: InternalTrack[] = [];
			const addInternalTrack = (track: InternalTrack) => {
				const existingTrack = internalTracks.find(x =>
					x.fullPath === track.fullPath && x.info.type === track.info.type,
				);

				if (existingTrack) {
					existingTrack.pairingMask |= track.pairingMask;
					existingTrack.default ||= track.default;
					existingTrack.autoselect ||= track.autoselect;
					existingTrack.lineNumber = Math.min(existingTrack.lineNumber, track.lineNumber);

					if (track.peakBitrate !== null) {
						existingTrack.peakBitrate = Math.max(
							existingTrack.peakBitrate ?? -Infinity,
							track.peakBitrate,
						);
					}
					if (track.averageBitrate !== null) {
						existingTrack.averageBitrate = Math.max(
							existingTrack.averageBitrate ?? -Infinity,
							track.averageBitrate,
						);
					}

					if (existingTrack.languageCode === UNDETERMINED_LANGUAGE) {
						existingTrack.languageCode = track.languageCode;
					}
				} else {
					track.id = internalTracks.length + 1;
					internalTracks.push(track);
				}
			};

			for (const variantInternalTracks of internalTracksByVariant) {
				for (const trackEntry of variantInternalTracks) {
					addInternalTrack(trackEntry);
				}
			}

			// Order tracks by how they appear in the file
			internalTracks.sort((a, b) => a.lineNumber - b.lineNumber);

			this.trackBackings = [];
			for (const internalTrack of internalTracks) {
				if (internalTrack.info.type === 'video') {
					this.trackBackings.push(
						new HlsInputVideoTrackBacking(internalTrack as InternalVideoTrack),
					);
				} else {
					this.trackBackings.push(
						new HlsInputAudioTrackBacking(internalTrack as InternalAudioTrack),
					);
				}
			}

			this.internalTracks = internalTracks;
		})();
	}

	async getTrackBackings() {
		await this.readMetadata();
		assert(this.trackBackings);

		return this.trackBackings;
	}

	getSegmentedInputForPath(path: string) {
		let segmentedInput = this.segmentedInputs.find(x => x.path === path);
		if (segmentedInput) {
			return segmentedInput;
		}

		let decls: SegmentedInputTrackDeclaration[] | null = null;
		if (this.internalTracks) {
			const tracks = this.internalTracks.filter(x => x.fullPath === path);
			decls = tracks.map(x => ({
				id: x.id,
				type: x.info.type,
			}));
		}

		segmentedInput = new HlsSegmentedInput(this, path, decls, null);
		this.segmentedInputs.push(segmentedInput);

		return segmentedInput;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	async getMimeType(): Promise<string> {
		return HLS_MIME_TYPE;
	}

	override dispose(): void {
		if (this.segmentedInputs) {
			for (const segInput of this.segmentedInputs) {
				segInput.dispose();
			}
			this.segmentedInputs.length = 0;
		}
	}
}

abstract class HlsInputTrackBacking implements InputTrackBacking {
	hydrationPromise: Promise<void> | null = null;

	constructor(public internalTrack: InternalTrack) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;

	hydrate() {
		return this.hydrationPromise ??= (async () => {
			const segmentedInput = this.internalTrack.demuxer.getSegmentedInputForPath(this.internalTrack.fullPath);

			let trackBacking: InputTrackBacking | null = null;

			const trackBackings = await segmentedInput.getTrackBackings();
			const matchingType = trackBackings.filter(x => x.getType() === this.getType());

			if (matchingType.length === 1) {
				// Avoids reading fields on the track
				trackBacking = matchingType[0]!;
			} else {
				if (this instanceof HlsInputVideoTrackBacking) {
					for (const backing of matchingType) {
						if ((await backing.getCodec()) === this.getCodec()) {
							trackBacking = backing;
							break;
						}
					}
				} else {
					assert(this instanceof HlsInputAudioTrackBacking);

					for (const backing of matchingType) {
						if ((await backing.getCodec()) === this.getCodec()) {
							trackBacking = backing;
							break;
						}
					}
				}
			}

			if (!trackBacking) {
				throw new Error('Could not find matching track in underlying media data.');
			}

			this.internalTrack.backingTrack = trackBacking;
		})();
	}

	/** If the backing track is already present, delegate synchronously; otherwise, hydrate first. */
	delegate<T>(fn: () => MaybePromise<T>): MaybePromise<T> {
		if (this.internalTrack.backingTrack) {
			return fn();
		}

		return this.hydrate().then(fn);
	}

	getCodec(): MediaCodec | null {
		throw new Error('Not implemented on base class.');
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			// Meanings are swapped in HLS: "Default" means that a track is the primary track.
			default: this.internalTrack.autoselect,
			primary: this.internalTrack.default,
		};
	}

	getId(): number {
		return this.internalTrack.id;
	}

	getPairingMask(): bigint {
		return this.internalTrack.pairingMask;
	}

	getInternalCodecId(): string | number | Uint8Array | null {
		return null;
	}

	getLanguageCode(): string {
		return this.internalTrack.languageCode;
	}

	getName(): string | null {
		return this.internalTrack.name;
	}

	getNumber(): number {
		assert(this.internalTrack.demuxer.internalTracks);

		const trackType = this.internalTrack.info.type;
		let number = 0;
		for (const track of this.internalTrack.demuxer.internalTracks) {
			if (track.info.type === trackType) {
				number++;
			}

			if (track === this.internalTrack) {
				break;
			}
		}

		return number;
	}

	getTimeResolution(): MaybePromise<number> {
		return this.delegate(() => this.internalTrack.backingTrack!.getTimeResolution());
	}

	isRelativeToUnixEpoch(): MaybePromise<boolean> {
		return this.delegate(() => this.internalTrack.backingTrack!.isRelativeToUnixEpoch());
	}

	getBitrate(): number | null {
		return this.internalTrack.peakBitrate;
	}

	getAverageBitrate(): number | null {
		return this.internalTrack.averageBitrate;
	}

	async getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getDurationFromMetadata(options);
	}

	async getLiveRefreshInterval(): Promise<number | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getLiveRefreshInterval();
	}

	getHasOnlyKeyPackets() {
		return this.internalTrack.hasOnlyKeyPackets || null;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getFirstPacket(options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getPacket(timestamp, options);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getKeyPacket(timestamp, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getNextPacket(packet, options);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		await this.hydrate();
		return this.internalTrack.backingTrack!.getNextKeyPacket(packet, options);
	}
}

class HlsInputVideoTrackBacking
	extends HlsInputTrackBacking
	implements InputVideoTrackBacking {
	override internalTrack!: InternalVideoTrack;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
	}

	get backingVideoTrack() {
		return this.internalTrack.backingTrack as InputVideoTrackBacking | null;
	}

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec | null {
		const inferredCodec = inferCodecFromCodecString(this.internalTrack.fullCodecString);
		return inferredCodec as VideoCodec;
	}

	getCodedWidth(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getCodedWidth());
	}

	getCodedHeight(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getCodedHeight());
	}

	getSquarePixelWidth(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getSquarePixelWidth());
	}

	getSquarePixelHeight(): MaybePromise<number> {
		return this.delegate(() => this.backingVideoTrack!.getSquarePixelHeight());
	}

	getMetadataDisplayWidth(): number | null {
		if (this.backingVideoTrack) {
			return null;
		}

		return this.internalTrack.info.width;
	}

	getMetadataDisplayHeight(): number | null {
		if (this.backingVideoTrack) {
			return null;
		}

		return this.internalTrack.info.height;
	}

	getRotation(): MaybePromise<Rotation> {
		return this.delegate(() => this.backingVideoTrack!.getRotation());
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		await this.hydrate();
		return this.backingVideoTrack!.getColorSpace();
	}

	async canBeTransparent(): Promise<boolean> {
		await this.hydrate();
		return this.backingVideoTrack!.canBeTransparent();
	}

	getMetadataCodecParameterString(): string | null {
		if (this.backingVideoTrack) {
			return null;
		}
		return this.internalTrack.fullCodecString;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		await this.hydrate();
		return this.backingVideoTrack!.getDecoderConfig();
	}
}

class HlsInputAudioTrackBacking
	extends HlsInputTrackBacking
	implements InputAudioTrackBacking {
	override internalTrack!: InternalAudioTrack;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
	}

	get backingAudioTrack() {
		return this.internalTrack.backingTrack as InputAudioTrackBacking | null;
	}

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec | null {
		const inferredCodec = inferCodecFromCodecString(this.internalTrack.fullCodecString);
		return inferredCodec as AudioCodec;
	}

	getNumberOfChannels(): MaybePromise<number> {
		if (this.internalTrack.info.numberOfChannels !== null) {
			return this.internalTrack.info.numberOfChannels;
		}

		return this.delegate(() => this.backingAudioTrack!.getNumberOfChannels());
	}

	getSampleRate(): MaybePromise<number> {
		return this.delegate(() => this.backingAudioTrack!.getSampleRate());
	}

	getMetadataCodecParameterString(): string | null {
		if (this.backingAudioTrack) {
			return null;
		}
		return this.internalTrack.fullCodecString;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		await this.hydrate();
		return this.backingAudioTrack!.getDecoderConfig();
	}
}

const getMediaTagDefault = (attributes: AttributeList) => {
	const value = attributes.get('default');
	if (value === null) {
		return false;
	}

	const normalized = value.toUpperCase();
	if (normalized === 'YES') {
		return true;
	}
	if (normalized === 'NO') {
		return false;
	}

	throw new Error(
		`Invalid M3U8 file; #EXT-X-MEDIA DEFAULT attribute must be YES or NO, got "${value}".`,
	);
};

const getMediaTagAutoselect = (attributes: AttributeList) => {
	const value = attributes.get('autoselect');
	if (value === null) {
		return false;
	}

	const normalized = value.toUpperCase();
	if (normalized === 'YES') {
		return true;
	}
	if (normalized === 'NO') {
		return false;
	}

	throw new Error(
		`Invalid M3U8 file; #EXT-X-MEDIA AUTOSELECT attribute must be YES or NO, got "${value}".`,
	);
};

const preprocessLanguageCode = (code: string | null) => {
	if (code === null) {
		return UNDETERMINED_LANGUAGE;
	}

	const languageSubtag = code.split('-')[0];
	if (!languageSubtag) {
		return UNDETERMINED_LANGUAGE;
	}

	// Technically invalid, for now: The language subtag might be a language code from ISO 639-1,
	// ISO 639-2, ISO 639-3, ISO 639-5 or some other thing (source: Wikipedia). But, `languageCode` is
	// documented as ISO 639-2. Changing the definition would be a breaking change. This will get
	// cleaned up in the future by defining languageCode to be BCP 47 instead.
	return languageSubtag;
};
