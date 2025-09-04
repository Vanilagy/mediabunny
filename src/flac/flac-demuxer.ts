import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack } from '../input-track';
import { Reader } from '../reader';

export class FlacDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	tracks: InputAudioTrack[] = [];

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	override async computeDuration(): Promise<number> {
		const tracks = await this.getTracks();
		const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
		return Math.max(0, ...trackDurations);
	}

	override getTracks(): Promise<InputAudioTrack[]> {
		throw new Error('getTracks() not implemented');
	}

	override getMimeType(): Promise<string> {
		throw new Error('getMimeType() not implemented');
	}
}
