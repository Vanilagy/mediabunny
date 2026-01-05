import { Demuxer } from "../demuxer";
import { Input } from "../input";
import { InputTrack } from "../input-track";
import { Bitstream } from "../misc";
import { readBytes, Reader, readU24Be, readU8 } from "../reader";

export class MpegTsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			for (let i = 0; i < 2; i++) {
				this.readPacket(188 * i);
			}
		})();
	}

	async getTracks(): Promise<InputTrack[]> {
		await this.readMetadata();
		return [];
	}

	async readPacket(pos: number) {
		let slice = this.reader.requestSlice(pos, 188);
		if (slice instanceof Promise) slice = await slice;

		if (!slice) {
			return null;
		}

		const bitstream = new Bitstream(readBytes(slice, 3));
		const syncByte = bitstream.readBits(8);
		const transportErrorIndicator = bitstream.readBits(1);
		const payloadUnitStartIndicator = bitstream.readBits(1);
		const transportPriority = bitstream.readBits(1);
		const pid = bitstream.readBits(13);
		const transportScramblingControl = bitstream.readBits(2);
		const adaptationFieldControl = bitstream.readBits(2);
		const continuityCounter = bitstream.readBits(4);

		console.log(syncByte, transportErrorIndicator, payloadUnitStartIndicator, transportPriority, pid, transportScramblingControl, adaptationFieldControl, continuityCounter);
	}
}