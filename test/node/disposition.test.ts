import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';

test('Default track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
		decoderConfig: {
			codec: 'avc1.123456',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;

	expect(track.disposition).toEqual({
		default: true,
		forced: false,
		original: false,
		hearingImpaired: false,
		visionImpaired: false,
		commentary: false,
	});
});

test('Customized track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, {
		disposition: {
			default: false,
			forced: true,
			original: true,
			hearingImpaired: true,
			visuallyImpaired: true,
			commentary: true,
		},
	});

	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1), {
		decoderConfig: {
			codec: 'avc1.123456',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;

	expect(track.disposition).toEqual({
		default: false,
		forced: true,
		original: true,
		hearingImpaired: true,
		visionImpaired: true,
		commentary: true,
	});
});
