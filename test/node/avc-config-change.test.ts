import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { iterateAvcNalUnits } from '../../src/codec-data.js';
import { toUint8Array } from '../../src/misc.js';

// Regression for https://github.com/Vanilagy/mediabunny/issues/602.
// Decoder records from a production configuration-change failure and a matching encoder. No picture data.
const descriptions = [
	'01640032ffe1001b67640032ac2b70220157cb360220000003002000000791b43865c001000468ee3cb0fdf8f800',
	'01640c28ffe1001467640c28ac18d0088055f2cd35010d010784423501000468ce3c80fdf8f800',
].map(hex => new Uint8Array(Buffer.from(hex, 'hex')));
const config = (index: number): EncodedVideoChunkMetadata => ({ decoderConfig: {
	codec: 'avc1.640032', codedWidth: 1080, codedHeight: 1350, description: descriptions[index]!,
} });
const packet = (index: number, type: 'key' | 'delta' = 'key') =>
	new EncodedPacket(new Uint8Array([0, 0, 0, 2, type === 'key' ? 0x65 : 0x41, 0x80]), type, index / 30, 1 / 30);
const create = (fragmented = false) => {
	const target = new BufferTarget();
	const output = new Output({ target, format: new Mp4OutputFormat(fragmented ? { fastStart: 'fragmented' } : {}) });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source, { frameRate: 30 });
	return { output, source, target };
};

test('retains initial avcC and carries replacement AVC configuration in-band', async () => {
	const { output, source, target } = create();
	await output.start();
	await source.add(packet(0), config(0));
	await source.add(packet(1), config(1));
	await source.add(packet(2, 'delta'), config(1)); // Delta pictures need no repeated headers.
	await source.add(packet(3)); // Seeking here must not require the transition picture.
	await output.finalize();
	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	const decoder = (await track.getDecoderConfig())!;
	expect(decoder.codec.startsWith('avc3.')).toBe(true);
	expect(toUint8Array(decoder.description!)).toEqual(descriptions[0]);
	const packets: EncodedPacket[] = [];
	for await (const value of new EncodedPacketSink(track).packets()) packets.push(value);
	const nals = [...iterateAvcNalUnits(packets[1]!.data, decoder)]
		.map(loc => packets[1]!.data.subarray(loc.offset, loc.offset + loc.length));
	expect(nals.map(nal => nal[0]! & 31)).toEqual([7, 8, 5]);
	expect(nals[2]).toEqual(packet(1).data.subarray(4));
	expect(packets[0]!.data).toEqual(packet(0).data);
	expect(packets[2]!.data).toEqual(packet(2, 'delta').data);
	expect(packets[3]!.data.subarray(0, packets[3]!.data.length - packet(3).data.length))
		.toEqual(packets[1]!.data.subarray(0, packets[1]!.data.length - packet(1).data.length));
});

test('configuration changes without a key packet fail instead of producing corrupt output', async () => {
	const { output, source } = create();
	await output.start();
	await source.add(packet(0), config(0));
	await expect(source.add(packet(1, 'delta'), config(1))).rejects.toThrow('key packet');
	await output.cancel();
});

test('stable AVC configuration keeps avc1 and leaves picture packets untouched', async () => {
	const { output, source, target } = create();
	await output.start();
	await source.add(packet(0), config(0));
	await source.add(packet(1), config(0));
	await output.finalize();
	using input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	expect((await track.getDecoderConfig())!.codec.startsWith('avc1.')).toBe(true);
	const packets: EncodedPacket[] = [];
	for await (const value of new EncodedPacketSink(track).packets()) packets.push(value);
	expect(packets.map(value => value.data)).toEqual([packet(0).data, packet(1).data]);
});

test('fragmented MP4 rejects configuration changes after its initialization segment', async () => {
	const { output, source } = create(true);
	await output.start();
	await source.add(packet(0), config(0));
	await expect(source.add(packet(1), config(1))).rejects.toThrow('initialization segment');
	await output.cancel();
});
