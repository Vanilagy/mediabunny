import { AudioSampleResource } from 'mediabunny';
import * as NodeAv from 'node-av';
import { toAudioSampleFormat } from './misc';
import { assert, toUint8Array } from '../../../src/misc';

export class NodeAvFrameAudioSampleResource extends AudioSampleResource {
	frame: NodeAv.Frame;
	timestamp: number;

	constructor(frame: NodeAv.Frame, timestamp: number) {
		super();

		const clone = frame.clone();
		if (!clone) {
			throw new Error('Allocation failure during frame clone.');
		}

		this.frame = clone;
		this.timestamp = timestamp;
	}

	getFormat(): AudioSampleFormat {
		const result = toAudioSampleFormat(this.frame.format as NodeAv.AVSampleFormat);
		if (result === null) {
			throw new TypeError('Unsupported audio sample format: ' + this.frame.format);
		}

		return result;
	}

	getSampleRate(): number {
		return this.frame.sampleRate;
	}

	getNumberOfChannels(): number {
		return this.frame.channels;
	}

	getNumberOfFrames(): number {
		return this.frame.nbSamples;
	}

	getTimestamp(): number {
		return this.timestamp;
	}

	close(): void {
		this.frame.free();
	}

	getDataPlane(planeIndex: number): Uint8Array {
		assert(this.frame.data && planeIndex < this.frame.data.length);
		return toUint8Array(this.frame.data[planeIndex]!);
	}
}
