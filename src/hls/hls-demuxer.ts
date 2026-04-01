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
	InputAudioTrack,
	InputAudioTrackBacking,
	InputTrack,
	InputTrackBacking,
	InputVideoTrack,
	InputVideoTrackBacking,
	TrackNotHydratedError,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import { assert, joinPaths, Rotation, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket } from '../packet';
import { readAllLines } from '../reader';
import { AttributeList, canIgnoreLine } from './hls-misc';
import { HlsSegmentedInput } from './hls-segmented-input';

type InternalTrack = {
	id: number;
	demuxer: HlsDemuxer;
	inputTrack: InputTrack | null;
	backingTrack: InputTrack | null;
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
	tracks: InputTrack[] = [];
	segmentedInputs: HlsSegmentedInput[] = [];
	hasMasterPlaylist = true;

	constructor(input: Input) {
		super(input);
	}

	readMetadata() {
		return this.metadataPromise ??= (async () => {
			assert(this.input._entryPath !== null);

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

				if (line.startsWith('#EXT-X-STREAM-INF:')) {
					const streamInfLineNumber = i;
					const playlistPath = lines[++i];
					if (playlistPath === undefined) {
						throw new Error('Incorrect M3U8 file; a line must follow the #EXT-X-STREAM-INF tag.');
					}

					const fullPath = joinPaths(this.input._entryPath, playlistPath);
					const attributes = new AttributeList(line.slice(18));

					const bandwidth = attributes.getAsNumber('bandwidth');
					if (bandwidth === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-STREAM-INF tag requires a BANDWIDTH attribute with a valid'
							+ ' number value.',
						);
					}

					variantStreams.push({
						fullPath,
						attributes,
						lineNumber: streamInfLineNumber,
						hasOnlyKeyPackets: false,
					});
				} else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
					const attributes = new AttributeList(line.slice(18));
					const playlistPath = attributes.get('uri');

					if (playlistPath === null) {
						throw new Error(
							'Invalid M3U8 file; #EXT-X-I-FRAME-STREAM-INF tag requires a URI attribute.',
						);
					}

					const fullPath = joinPaths(this.input._entryPath, playlistPath);

					variantStreams.push({
						fullPath,
						attributes,
						lineNumber: i,
						hasOnlyKeyPackets: true,
					});
				} else if (line.startsWith('#EXT-X-MEDIA:')) {
					const attributes = new AttributeList(line.slice(13));

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
						fullPath = joinPaths(this.input._entryPath, uri);
					}

					mediaTags.push({ fullPath, attributes, lineNumber: i });
				} else if (line === '#EXT-X-I-FRAMES-ONLY') {
					// iFramesOnlyTagFound = true;
				} else if (line.startsWith('#EXTINF:')) {
					// This is a media playlist, not a master playlist
					const segmentedInput = new HlsSegmentedInput(this, this.input._entryPath, lines);
					this.segmentedInputs = [segmentedInput];
					this.hasMasterPlaylist = false;

					const input = segmentedInput.toInput();
					this.tracks = await input.getTracks();

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
					const input = segmentedInput.toInput();
					const tracks = await input.getTracks();

					codecStrings = await Promise.all(
						tracks
							.filter(x => x.codec !== null)
							.map(x => x.getCodecParameterString()),
					) as string[];
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

					const matchingVideoMediaTags = mediaTags.filter((mediaTag) => {
						const groupId = mediaTag.attributes.get('group-id')!;
						const type = mediaTag.attributes.get('type')!;
						return groupId === videoGroupId && type.toLowerCase() === 'video';
					});

					const additionalCodecStrings = await Promise.all(matchingVideoMediaTags.map(async (tag) => {
						const uri = tag.attributes.get('uri');
						if (uri === null) {
							return null;
						}

						const fullPath = joinPaths(this.input._entryPath!, uri);
						const segmentedInput = this.getSegmentedInputForPath(fullPath);
						const input = segmentedInput.toInput();
						const videoTrack = await input.getPrimaryVideoTrack();

						if (!videoTrack || videoTrack.codec === null) {
							return null;
						}

						const codecParameterString = await videoTrack.getCodecParameterString();
						assert(codecParameterString !== null);
						return codecParameterString;
					}));

					codecStrings.push(
						...additionalCodecStrings.filter((x): x is string => x !== null),
					);
				}

				if (audioGroupId !== null && !containsAudioCodecs) {
					// An audio group is linked but no audio codec is listed, sigh. Let's resolve the audio codec.

					if (!audioGroupIds.includes(audioGroupId)) {
						throw new Error(
							`Invalid M3U8 file; variant stream references audio group "${audioGroupId}" which`
							+ ` is not defined in any #EXT-X-MEDIA tags.`,
						);
					}

					const matchingAudioMediaTags = mediaTags.filter((tag) => {
						const groupId = tag.attributes.get('group-id')!;
						const type = tag.attributes.get('type')!;
						return groupId === audioGroupId && type.toLowerCase() === 'audio';
					});

					const additionalCodecStrings = await Promise.all(matchingAudioMediaTags.map(async (tag) => {
						const uri = tag.attributes.get('uri');
						if (uri === null) {
							return null;
						}

						const fullPath = joinPaths(this.input._entryPath!, uri);
						const segmentedInput = this.getSegmentedInputForPath(fullPath);
						const input = segmentedInput.toInput();
						const audioTrack = await input.getPrimaryAudioTrack();

						if (!audioTrack || audioTrack.codec === null) {
							return null;
						}

						const codecParameterString = await audioTrack.getCodecParameterString();
						assert(codecParameterString !== null);
						return codecParameterString;
					}));

					codecStrings.push(
						...additionalCodecStrings.filter((x): x is string => x !== null),
					);
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
								inputTrack: null,
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
									inputTrack: null,
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
								? Number(channels)
								: null;

							result.push({
								id: -1,
								demuxer: this,
								inputTrack: null,
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
									? Number(channels)
									: null;

								result.push({
									id: -1,
									demuxer: this,
									inputTrack: null,
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

			for (const internalTrack of internalTracks) {
				const inputTrack = internalTrack.info.type === 'video'
					? new InputVideoTrack(
						this.input,
						new HlsInputVideoTrackBacking(internalTrack as InternalVideoTrack),
					)
					: new InputAudioTrack(
						this.input,
						new HlsInputAudioTrackBacking(internalTrack as InternalAudioTrack),
					);

				internalTrack.inputTrack = inputTrack;
				this.tracks.push(inputTrack);
			}
		})();
	}

	async getTracks(): Promise<InputTrack[]> {
		await this.readMetadata();
		return this.tracks;
	}

	getSegmentedInputForPath(path: string) {
		let segmentedInput = this.segmentedInputs.find(x => x.path === path);
		if (segmentedInput) {
			return segmentedInput;
		}

		segmentedInput = new HlsSegmentedInput(this, path, null);
		this.segmentedInputs.push(segmentedInput);

		return segmentedInput;
	}

	async getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		return this.hasMasterPlaylist
			? null
			: this.segmentedInputs[0]!.getDurationFromMetadata(options);
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	async getMimeType(): Promise<string> {
		return 'application/vnd.apple.mpegurl';
	}

	override dispose(): void {
		for (const segInput of this.segmentedInputs) {
			segInput.dispose();
		}
		this.segmentedInputs.length = 0;
	}
}

abstract class HlsInputTrackBacking implements InputTrackBacking {
	constructor(public internalTrack: InternalTrack) {}

	isHydrated(): boolean {
		return !!this.internalTrack.backingTrack;
	}

	async hydrate() {
		const segmentedInput = this.internalTrack.demuxer.getSegmentedInputForPath(this.internalTrack.fullPath);
		const input = segmentedInput.toInput();

		let track: InputTrack | null;
		if (this instanceof HlsInputVideoTrackBacking) {
			track = await input.getPrimaryVideoTrack({
				filter: track => track.codec === this.getCodec(),
			});
		} else {
			assert(this instanceof HlsInputAudioTrackBacking);
			track = await input.getPrimaryAudioTrack({
				filter: track => track.codec === this.getCodec(),
			});
		}

		if (!track) {
			throw new Error('Could not find matching track in underlying media data.');
		}

		if (!track.isHydrated) {
			await track.hydrate(); // Just in case, typically not needed except for cursed shit like recursive .m3u8
		}

		this.internalTrack.backingTrack = track;
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
		let number = 0;
		for (const track of this.internalTrack.demuxer.tracks) {
			if (track.type === this.internalTrack.inputTrack!.type) {
				number++;
			}

			if (track === this.internalTrack.inputTrack) {
				break;
			}
		}

		return number;
	}

	getTimeResolution(): number {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getTimeResolution();
	}

	isRelativeToUnixEpoch(): boolean {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.isRelativeToUnixEpoch();
	}

	getBitrate(): number | null {
		return this.internalTrack.peakBitrate;
	}

	getAverageBitrate(): number | null {
		return this.internalTrack.averageBitrate;
	}

	async getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getDurationFromMetadata(options);
	}

	async getLiveRefreshInterval(): Promise<number | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getLiveRefreshInterval();
	}

	getHasOnlyKeyPackets() {
		return this.internalTrack.hasOnlyKeyPackets || null;
	}

	getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getFirstPacket(options);
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getPacket(timestamp, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getKeyPacket(timestamp, options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getNextPacket(packet, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (!this.internalTrack.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.internalTrack.backingTrack._backing.getNextKeyPacket(packet, options);
	}
}

class HlsInputVideoTrackBacking
	extends HlsInputTrackBacking
	implements InputVideoTrackBacking {
	override internalTrack!: InternalVideoTrack;

	constructor(internalTrack: InternalVideoTrack) {
		super(internalTrack);
	}

	get backingTrack() {
		return this.internalTrack.backingTrack as InputVideoTrack | null;
	}

	override getCodec(): VideoCodec | null {
		const inferredCodec = inferCodecFromCodecString(this.internalTrack.fullCodecString);
		return inferredCodec as VideoCodec;
	}

	getCodedWidth(): number {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getCodedWidth();
	}

	getCodedHeight(): number {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getCodedHeight();
	}

	getSquarePixelWidth(): number {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getSquarePixelWidth();
	}

	getSquarePixelHeight(): number {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getSquarePixelHeight();
	}

	getDisplayWidth(): number | null {
		if (this.backingTrack) {
			return null;
		}

		return this.internalTrack.info.width;
	}

	getDisplayHeight(): number | null {
		if (this.backingTrack) {
			return null;
		}

		return this.internalTrack.info.height;
	}

	getRotation(): Rotation {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getRotation();
	}

	getColorSpace(): Promise<VideoColorSpaceInit> {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getColorSpace();
	}

	canBeTransparent(): Promise<boolean> {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.canBeTransparent();
	}

	getCodecParameterString(): Promise<string | null> {
		if (!this.backingTrack) {
			return Promise.resolve(this.internalTrack.fullCodecString);
		}

		return this.backingTrack.getCodecParameterString();
	}

	getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getDecoderConfig();
	}
}

class HlsInputAudioTrackBacking
	extends HlsInputTrackBacking
	implements InputAudioTrackBacking {
	override internalTrack!: InternalAudioTrack;

	constructor(internalTrack: InternalAudioTrack) {
		super(internalTrack);
	}

	get backingTrack() {
		return this.internalTrack.backingTrack as InputAudioTrack | null;
	}

	override getCodec(): AudioCodec | null {
		const inferredCodec = inferCodecFromCodecString(this.internalTrack.fullCodecString);
		return inferredCodec as AudioCodec;
	}

	getNumberOfChannels(): number {
		if (this.internalTrack.info.numberOfChannels !== null) {
			return this.internalTrack.info.numberOfChannels;
		}

		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getNumberOfChannels();
	}

	getSampleRate(): number {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getSampleRate();
	}

	getCodecParameterString(): Promise<string | null> {
		if (!this.backingTrack) {
			return Promise.resolve(this.internalTrack.fullCodecString);
		}

		return this.backingTrack.getCodecParameterString();
	}

	getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		if (!this.backingTrack) {
			throw new TrackNotHydratedError();
		}

		return this.backingTrack._backing.getDecoderConfig();
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
