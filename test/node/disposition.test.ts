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

	expect(await track.getDisposition()).toEqual({
		default: true,
		forced: false,
		original: false,
		hearingImpaired: false,
		visuallyImpaired: false,
		primary: false,
		commentary: false,
	});
});

test('Disabled track disposition', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	for (let i = 0; i < 2; i++) {
		output.addVideoTrack(new EncodedVideoPacketSource('avc'), {
			disposition: { default: i !== 0 },
			decoderConfig: {
				codec: 'avc1.123456',
				codedWidth: 1920,
				codedHeight: 1080,
			},
		});
	}

	await output.start();
	await output.finalize();

	const buffer = Buffer.from(output.target.buffer!);
	const flagOffset = buffer.indexOf(Buffer.from([0x88, 0x81, 0, 0x9c, 0x81, 0]));
	expect(flagOffset).toBeGreaterThanOrEqual(0);
	// The muxer can't write FlagEnabled; replace FlagDefault/FlagLacing with FlagEnabled=0/FlagDefault=1.
	buffer.set([0xb9, 0x81, 0, 0x88, 0x81, 1], flagOffset);

	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks).toHaveLength(2);
	expect((await tracks[0]!.getDisposition()).default).toBe(false);
	expect((await tracks[1]!.getDisposition()).default).toBe(true);
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

	expect(await track.getDisposition()).toEqual({
		default: false,
		forced: true,
		original: true,
		hearingImpaired: true,
		visuallyImpaired: true,
		primary: false,
		commentary: true,
	});
});
