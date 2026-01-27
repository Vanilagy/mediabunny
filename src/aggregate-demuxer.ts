import { VideoCodec, AudioCodec } from './codec';
import { Demuxer } from './demuxer';
import { Input } from './input';
import {
	InputTrack,
	InputVideoTrack,
	InputAudioTrack,
	InputTrackBacking,
	InputVideoTrackBacking,
	InputAudioTrackBacking,
} from './input-track';
import { ManifestInputVariant } from './manifest-input-variant';
import { PacketRetrievalOptions } from './media-sink';
import { MetadataTags, TrackDisposition } from './metadata';
import { arrayCount, Rotation } from './misc';
import { EncodedPacket } from './packet';

/** A utility demuxer that acts as the union of multiple Inputs. */
export class InputAggregateDemuxer extends Demuxer {
	subInputs: Input[];
	tracksPromise: Promise<InputTrack[]> | null = null;

	constructor(input: Input, subInputs: Input[]) {
		super(input);

		this.subInputs = subInputs;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {}; // todo?
	}

	async getMimeType() {
		return ''; // todo?
	}

	getTracks() {
		return this.tracksPromise ??= (async () => {
			const subInputTracks = await Promise.all(this.subInputs.map(x => x.getTracks()));

			const tracks: InputTrack[] = [];
			for (const inputTracks of subInputTracks) {
				for (const track of inputTracks) {
					if (track.isVideoTrack()) {
						const number = arrayCount(tracks, x => x.type === 'video') + 1;
						tracks.push(new InputVideoTrack(
							this.input,
							new InputAggregateVideoTrackBacking(track._backing, number),
						));
					} else if (track.isAudioTrack()) {
						const number = arrayCount(tracks, x => x.type === 'audio') + 1;
						tracks.push(new InputAudioTrack(
							this.input,
							new InputAggregateAudioTrackBacking(track._backing, number),
						));
					}
				}
			}

			return tracks;
		})();
	}
}

class InputAggregateTrackBacking implements InputTrackBacking {
	source: InputTrackBacking;
	number: number;

	constructor(source: InputTrackBacking, number: number) {
		this.source = source;
		this.number = number;
	}

	getId() {
		return this.source.getId();
	}

	getNumber() {
		return this.number;
	}

	getCodec() {
		return this.source.getCodec();
	}

	getInternalCodecId() {
		return this.source.getInternalCodecId();
	}

	getName() {
		return this.source.getName();
	}

	getLanguageCode() {
		return this.source.getLanguageCode();
	}

	getTimeResolution() {
		return this.source.getTimeResolution();
	}

	getDisposition(): TrackDisposition {
		return this.source.getDisposition();
	}

	getVariant(): ManifestInputVariant | null {
		return this.source.getVariant();
	}

	getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.source.getFirstPacket(options);
	}

	getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.source.getPacket(timestamp, options);
	}

	getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.source.getNextPacket(packet, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.source.getKeyPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.source.getNextKeyPacket(packet, options);
	}
}

class InputAggregateVideoTrackBacking extends InputAggregateTrackBacking implements InputVideoTrackBacking {
	override source!: InputVideoTrackBacking;

	constructor(source: InputVideoTrackBacking, number: number) {
		super(source, number);
	}

	override getCodec(): VideoCodec | null {
		return this.source.getCodec();
	}

	getCodedWidth() {
		return this.source.getCodedWidth();
	}

	getCodedHeight() {
		return this.source.getCodedHeight();
	}

	getRotation(): Rotation {
		return this.source.getRotation();
	}

	getColorSpace() {
		return this.source.getColorSpace();
	}

	canBeTransparent() {
		return this.source.canBeTransparent();
	}

	getDecoderConfig() {
		return this.source.getDecoderConfig();
	}
}

class InputAggregateAudioTrackBacking extends InputAggregateTrackBacking implements InputAudioTrackBacking {
	override source!: InputAudioTrackBacking;

	constructor(source: InputAudioTrackBacking, number: number) {
		super(source, number);
	}

	override getCodec(): AudioCodec | null {
		return this.source.getCodec();
	}

	getNumberOfChannels() {
		return this.source.getNumberOfChannels();
	}

	getSampleRate() {
		return this.source.getSampleRate();
	}

	getDecoderConfig() {
		return this.source.getDecoderConfig();
	}
}
