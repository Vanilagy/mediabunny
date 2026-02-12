import { CustomVideoDecoder, EncodedPacket, MaybePromise, VideoCodec } from 'mediabunny';
import createModule from '../build/prores';
import { VideoSample } from 'mediabunny';

type ExtendedEmscriptenModule = EmscriptenModule & {
	cwrap: typeof cwrap;
};

export class ProResDecoder extends CustomVideoDecoder {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
		return codec === 'prores';
	}

	module!: ExtendedEmscriptenModule;
	initDecoder!: () => number;
	configurePacket!: (ctx: number, size: number) => number;
	decodePacket!: (ctx: number) => number;
	getFrameWidth!: (ctx: number) => number;
	getFrameHeight!: (ctx: number) => number;
	getFrameFormat!: (ctx: number) => number;
	getFrameNumPlanes!: (ctx: number) => number;
	getFrameLinesize!: (ctx: number, n: number) => number;
	getFrameData!: (ctx: number, n: number) => number;
	getFrameDataPtr!: (ctx: number) => number;
	getFrameDataSize!: (ctx: number) => number;

	decoderContextPtr!: number;

	override async init() {
		console.log('THIS IS BEING CALLED');

		this.module = (await createModule()) as ExtendedEmscriptenModule;

		// Set up the functions
		this.initDecoder = this.module.cwrap('init_decoder', 'number', []);
		this.configurePacket = this.module.cwrap('configure_packet', 'number', ['number', 'number']);
		this.decodePacket = this.module.cwrap('decode_packet', 'number', ['number']);
		this.getFrameWidth = this.module.cwrap('get_frame_width', 'number', ['number']);
		this.getFrameHeight = this.module.cwrap('get_frame_height', 'number', ['number']);
		this.getFrameFormat = this.module.cwrap('get_frame_format', 'number', ['number']);
		this.getFrameNumPlanes = this.module.cwrap('get_frame_num_planes', 'number', ['number']);
		this.getFrameLinesize = this.module.cwrap('get_frame_linesize', 'number', ['number', 'number']);
		this.getFrameData = this.module.cwrap('get_frame_data', 'number', ['number', 'number']);
		this.getFrameDataPtr = this.module.cwrap('get_frame_data_ptr', 'number', ['number']);
		this.getFrameDataSize = this.module.cwrap('get_frame_data_size', 'number', ['number']);

		this.decoderContextPtr = this.initDecoder();
	}

	override decode(packet: EncodedPacket) {
		const dataPtr = this.configurePacket(this.decoderContextPtr, packet.byteLength);
		if (dataPtr === 0) {
			throw new Error('todo');
		}

		this.module.HEAPU8.set(packet.data, dataPtr);

		console.time();
		const ret = this.decodePacket(this.decoderContextPtr);
		console.timeEnd();

		if (ret === 0) {
			const width = this.getFrameWidth(this.decoderContextPtr);
			const height = this.getFrameHeight(this.decoderContextPtr);
			const format = this.getFrameFormat(this.decoderContextPtr);
			const dataPtr = this.getFrameDataPtr(this.decoderContextPtr);
			const dataSize = this.getFrameDataSize(this.decoderContextPtr);

			const data = this.module.HEAPU8.subarray(dataPtr, dataPtr + dataSize);

			const sample = new VideoSample(data, {
				format: 'I422P10' as VideoPixelFormat,
				codedWidth: width,
				codedHeight: height,
				timestamp: packet.timestamp,
				duration: packet.duration,
			});
			this.onSample(sample);
		}
	}

	override flush(): MaybePromise<void> {
		// nada
	}

	override close(): MaybePromise<void> {
		// nada
	}
}
