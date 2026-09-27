import { expect, test } from 'vitest';
import { BufferSource, EncodedPacketSink, Input, MP3 } from '../../src/index.js';
import { assert } from '../../src/misc.js';

for (const flags of [1, 3, 15]) {
	test(`LAME Xing fields trim encoder delay, decoder latency and padding (flags ${flags})`, async () => {
		const bytes = new Uint8Array(576 * 3);
		for (let i = 0; i < 3; i++) bytes.set([0xff, 0xfb, 0xb4, 0], i * 576);
		bytes.set([0x58, 0x69, 0x6e, 0x67], 36); // Xing
		const view = new DataView(bytes.buffer);
		view.setUint32(40, flags);
		view.setUint32(44, 2); // Two coded audio frames after the Xing frame
		let offset = 48;
		if (flags & 2) {
			view.setUint32(offset, bytes.length);
			offset += 4;
		}
		if (flags & 4) offset += 100;
		if (flags & 8) offset += 4;
		bytes.set([0x4c, 0x41, 0x4d, 0x45], offset); // LAME
		bytes.set([0x24, 0x02, 0x58], offset + 21); // Delay 576, padding 600
		using input = new Input({ source: new BufferSource(bytes), formats: [MP3] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const packets = [];
		for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
		expect(packets).toHaveLength(2);
		expect(packets[0]!.timestamp).toBe(-(576 + 529) / 48000);
		expect(packets[1]!.timestamp).toBe(47 / 48000);
		expect(packets[1]!.duration).toBe(1081 / 48000);
		expect(await track.getTimeResolution()).toBe(48000);
		expect(await track.getDurationFromMetadata()).toBe(1128 / 48000);
		expect(await track.computeDuration()).toBe(1128 / 48000);
	});
}

test('Xing fields cut off by the end of their frame count as absent', async () => {
	// MPEG-2 Layer III, 8 kbit/s, 24 kHz mono: 24-byte frames, so the frame count would end past the Xing frame
	const bytes = new Uint8Array(24 * 3);
	for (let i = 0; i < 3; i++) bytes.set([0xff, 0xf3, 0x14, 0xc0], i * 24);
	bytes.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1], 13); // Xing, frame count flag
	using input = new Input({ source: new BufferSource(bytes), formats: [MP3] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.getDurationFromMetadata()).toBeNull();
	expect(await track.computeDuration()).toBe(1152 / 24000);
});

test('LAME padding past the start of the last frame separates presentation from decode order', async () => {
	const bytes = new Uint8Array(576 * 4);
	for (let i = 0; i < 4; i++) bytes.set([0xff, 0xfb, 0xb4, 0], i * 576);
	bytes.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1, 0, 0, 0, 3], 36); // Xing, three coded audio frames
	bytes.set([0x4c, 0x41, 0x4d, 0x45], 48); // LAME
	bytes.set([0x24, 0x06, 0xa4], 48 + 21); // Delay 576, padding 1700: the stream ends before the last frame starts
	using input = new Input({ source: new BufferSource(bytes), formats: [MP3] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);
	const packets = [];
	for await (const packet of sink.packets()) packets.push(packet);
	expect(packets.map(packet => packet.duration)).toEqual([1152 / 48000, 1133 / 48000, 0]);
	expect((await sink.getPacket(Infinity))?.timestamp).toBe(47 / 48000);
	expect(await track.computeDuration()).toBe(1180 / 48000);
	expect(await track.getDurationFromMetadata()).toBe(1180 / 48000);
});

test('LAME delay and padding beyond the counted frames count as absent', async () => {
	const bytes = new Uint8Array(576 * 2);
	for (let i = 0; i < 2; i++) bytes.set([0xff, 0xfb, 0xb4, 0], i * 576);
	bytes.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1, 0, 0, 0, 1], 36); // Xing, one coded audio frame
	bytes.set([0x4c, 0x41, 0x4d, 0x45], 48); // LAME
	bytes.set([0x24, 0x06, 0xa4], 48 + 21); // Delay 576, padding 1700: more than the frame's 1152 samples
	using input = new Input({ source: new BufferSource(bytes), formats: [MP3] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const packet = await new EncodedPacketSink(track).getFirstPacket();
	expect(packet?.timestamp).toBe(0);
	expect(packet?.duration).toBe(1152 / 48000);
	expect(await track.getDurationFromMetadata()).toBe(1152 / 48000);
});
