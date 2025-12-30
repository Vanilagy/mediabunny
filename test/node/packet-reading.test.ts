import { expect, test } from 'vitest';
import { Input, InputDisposedError } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import path from 'node:path';
import fs from 'node:fs';
import { ALL_FORMATS } from '../../src/input-format.js';
import { PacketCursor, PacketReader } from '../../src/cursors.js';
import { promiseAllEnsureOrder } from '../../src/misc.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Packet reader', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.mov')),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const packet1 = (await reader.getFirst())!;
	expect(packet1.timestamp).toBe(0);

	const packet3 = (await reader.getNext(packet1))!;
	expect(packet3.sequenceNumber).toBeGreaterThan(packet1.sequenceNumber);

	const packet4 = (await reader.getNextKey(packet1))!;
	expect(packet4.sequenceNumber).toBeGreaterThan(packet3.sequenceNumber);
	expect(packet4.type).toBe('key');

	const packet5 = (await reader.getNext(packet3))!;
	expect(packet5.sequenceNumber).toBeGreaterThan(packet3.sequenceNumber);
	expect(packet5.sequenceNumber).toBeLessThan(packet4.sequenceNumber);

	const packet6 = (await reader.getAt(2.4))!;
	expect(packet6.timestamp).toBeGreaterThan(2);
	expect(packet6.timestamp).toBeLessThanOrEqual(2.4);
});

test('Packet reading throwing after Input disposal', async () => {
	const input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/trim-buck-bunny.mov'))),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const first = await reader.getFirst();

	input.dispose();

	expect(() => reader.getFirst()).toThrow(InputDisposedError);
	expect(() => reader.getAt(0)).toThrow(InputDisposedError);
	expect(() => reader.getKeyAt(0)).toThrow(InputDisposedError);
	expect(() => reader.getNext(first!)).toThrow(InputDisposedError);
	expect(() => reader.getNextKey(first!)).toThrow(InputDisposedError);
});

test('Packet cursor seeking', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.mov')),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const cursor = new PacketCursor(videoTrack);

	expect(cursor.current).toBe(null);

	const packet1 = (await cursor.seekToFirst())!;
	expect(packet1).not.toBe(null);
	expect(packet1).toBe(cursor.current);
	expect(packet1.timestamp).toBe(0);

	const packet2 = (await cursor.seekTo(0.01))!;
	expect(packet1.sequenceNumber).toBe(packet2.sequenceNumber); // Same packet

	const packet3 = (await cursor.seekTo(0.1))!;
	expect(packet3).toBe(cursor.current);
	expect(packet3.timestamp).toBeGreaterThan(0);
	expect(packet3.sequenceNumber).toBeGreaterThan(packet1.sequenceNumber);

	const packet4 = (await cursor.seekToKey(0.1))!;
	expect(packet4).toBe(cursor.current);
	expect(packet4.sequenceNumber).toBe(packet1.sequenceNumber);

	const packet5 = (await cursor.seekTo(Infinity))!;
	expect(packet5).toBe(cursor.current);
	expect(packet5.timestamp).toBe(5);

	const packet6 = (await cursor.seekTo(-Infinity))!;
	expect(packet6).toBe(cursor.current);
	expect(packet6).toBe(null);
});

test('Packet cursor iteration', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.mov')),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const cursor = new PacketCursor(videoTrack);

	const packet0 = (await cursor.seekToFirst())!;
	expect(cursor.current!.timestamp).toBe(0);

	const packet1 = (await cursor.next())!;
	expect(packet1.sequenceNumber).toBeGreaterThan(packet0.sequenceNumber);
	expect(packet1).toBe(cursor.current);

	const packet2 = (await cursor.next())!;
	expect(packet2.sequenceNumber).toBeGreaterThan(packet1.sequenceNumber);
	expect(packet2).toBe(cursor.current);

	const packet3 = (await cursor.nextKey())!;
	expect(packet3.sequenceNumber).toBeGreaterThan(packet2.sequenceNumber);
	expect(packet3.type).toBe('key');
	expect(packet3).toBe(cursor.current);

	await cursor.seekTo(Infinity);
	expect(cursor.current).not.toBe(null);

	const packet4 = await cursor.next();
	expect(packet4).toBe(null);
	expect(packet4).toBe(cursor.current);

	const packet5 = await cursor.next();
	expect(packet5).toBe(null);

	await cursor.seekTo(-Infinity);
	expect(cursor.current).toBe(null);

	const packet6 = (await cursor.next())!;
	expect(packet6.sequenceNumber).toBe(packet0.sequenceNumber);
	expect(packet6).toBe(cursor.current);

	await cursor.seekTo(-Infinity);
	expect(cursor.current).toBe(null);

	const packet7 = (await cursor.next())!;
	expect(packet7.sequenceNumber).toBe(packet0.sequenceNumber);
	expect(packet7).toBe(cursor.current);

	const packet8 = (await cursor.next())!;
	expect(packet8.sequenceNumber).toBeGreaterThan(packet7.sequenceNumber);
	expect(packet8).toBe(cursor.current);

	await cursor.seekToFirst();

	let total = 0;
	let lastSeqNum = -Infinity;
	for await (const packet of cursor) {
		if (total === 0) {
			expect(packet.sequenceNumber).toBe(packet0.sequenceNumber);
		}

		expect(packet.sequenceNumber).toBeGreaterThan(lastSeqNum);

		lastSeqNum = packet.sequenceNumber;
		total++;
	}

	expect(total).toBe(121);

	for await (const _ of cursor) {
		throw new Error('Unreachable');
	}

	total = 0;
	await cursor.seekTo(1);
	for await (const _ of cursor) {
		total++;
	}

	expect(total).toBe(97);

	total = 0;
	await cursor.seekToFirst();
	await cursor.iterate(() => void total++);

	expect(total).toBe(121);
	expect(cursor.current).toBe(null);

	total = 0;
	await cursor.seekToFirst();
	await cursor.iterate((packet) => {
		if (packet.timestamp === 1) {
			return false;
		}

		total++;
	});

	expect(total).toBe(24);
	expect(cursor.current!.timestamp).toBe(1);

	await cursor.seekTo(-Infinity);
	total = 0;
	for await (const _ of cursor) total++;

	expect(total).toBe(121);

	await cursor.seekTo(-Infinity);
	total = 0;
	await cursor.iterate(() => void total++);

	expect(total).toBe(121);

	const cursor2 = new PacketCursor(videoTrack);
	const packet9 = (await cursor2.next())!; // Without any prior seeks
	expect(packet9.sequenceNumber).toBe(packet0.sequenceNumber);
});

test('Synchronous packet reading', async () => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/trim-buck-bunny.mov'))),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);
	const cursor = new PacketCursor(videoTrack);

	expect(reader.getFirst()).not.toBeInstanceOf(Promise);

	expect(cursor.seekToFirst()).not.toBeInstanceOf(Promise);
	expect(cursor.seekTo(0.1)).not.toBeInstanceOf(Promise);
	expect(cursor.seekToKey(0.1)).not.toBeInstanceOf(Promise);
	expect(cursor.seekTo(2)).not.toBeInstanceOf(Promise);
	expect(cursor.seekTo(Infinity)).not.toBeInstanceOf(Promise);
	expect(cursor.seekTo(-Infinity)).not.toBeInstanceOf(Promise);

	void cursor.seekToFirst();

	expect(cursor.next()).not.toBeInstanceOf(Promise);
});

test('Command queuing', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/trim-buck-bunny.mov'), {
			maxCacheSize: 0, // So all commands return promises
		}),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const cursor = new PacketCursor(videoTrack);

	expect(cursor.waitUntilIdle()).toBe(null);

	const commands = [
		cursor.seekToFirst(),
		cursor.next(),
		cursor.next(),
		cursor.seekTo(2.4),
		cursor.next(),
		cursor.nextKey(),
		cursor.waitUntilIdle()!.then(() => cursor.current),
		cursor.nextKey(),
		cursor.nextKey(),
		cursor.next(),
		cursor.seekTo(Infinity),
		cursor.seekTo(-Infinity),
		cursor.seekToKey(2.4),
	];

	expect(commands.every(x => x instanceof Promise)).toBe(true);

	const resolved = await promiseAllEnsureOrder(commands);

	expect(resolved[0]!.timestamp).toBe(0);

	expect(resolved[1]!.sequenceNumber).toBeGreaterThan(resolved[0]!.sequenceNumber);

	expect(resolved[2]!.sequenceNumber).toBeGreaterThan(resolved[1]!.sequenceNumber);

	expect(resolved[3]!.timestamp).toBeGreaterThan(2);
	expect(resolved[3]!.timestamp).toBeLessThanOrEqual(2.4);

	expect(resolved[4]!.sequenceNumber).toBeGreaterThan(resolved[3]!.sequenceNumber);

	expect(resolved[5]!.timestamp).toBe(3);

	expect(resolved[6]!.sequenceNumber).toBe(resolved[5]!.sequenceNumber);

	expect(resolved[7]!.timestamp).toBe(4);

	expect(resolved[8]!.timestamp).toBe(5);

	expect(resolved[9]).toBe(null);

	expect(resolved[10]!.sequenceNumber).toBe(resolved[8]!.sequenceNumber);

	expect(resolved[11]).toBe(null);

	expect(resolved[12]!.timestamp).toBe(2);
	expect(resolved[12]!.type).toBe('key');

	void cursor.seekTo(1);
	await cursor.iterate((packet) => {
		expect(packet.timestamp).toBe(1);
		return false;
	});

	void cursor.seekTo(3);
	for await (const packet of cursor) {
		expect(packet.timestamp).toBe(3);
		break;
	}
});

test('verifyKeyPackets with faultily-labeled key frames', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/fucked-keyframes.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = (await input.getPrimaryVideoTrack())!;
	const reader = new PacketReader(videoTrack);

	const firstPacket = (await reader.getFirst())!;
	expect(firstPacket.type).toBe('key');

	const fakeKeyPacket = (await reader.getNextKey(firstPacket))!;
	expect(fakeKeyPacket).not.toBe(null);
	expect(fakeKeyPacket.type).toBe('key'); // Metadata says it's a key frame
	expect(fakeKeyPacket.sequenceNumber).toBeGreaterThan(firstPacket.sequenceNumber);

	const verifiedPacket = (await reader.getAt(fakeKeyPacket.timestamp, { verifyKeyPackets: true }))!;
	expect(verifiedPacket.sequenceNumber).toBe(fakeKeyPacket.sequenceNumber);
	expect(verifiedPacket.type).toBe('delta'); // After verification, it's actually a delta frame

	const unverifiedKeyAt = (await reader.getKeyAt(fakeKeyPacket.timestamp))!;
	expect(unverifiedKeyAt.sequenceNumber).toBe(fakeKeyPacket.sequenceNumber);
	expect(unverifiedKeyAt.type).toBe('key');

	const verifiedKeyAt = (await reader.getKeyAt(fakeKeyPacket.timestamp, { verifyKeyPackets: true }))!;
	expect(verifiedKeyAt.sequenceNumber).toBe(firstPacket.sequenceNumber);
	expect(verifiedKeyAt.type).toBe('key');

	const unverifiedNextKey = (await reader.getNextKey(firstPacket))!;
	expect(unverifiedNextKey).not.toBe(null);
	expect(unverifiedNextKey.type).toBe('key');
	expect(unverifiedNextKey.sequenceNumber).toBe(fakeKeyPacket.sequenceNumber);

	const verifiedNextKey = await reader.getNextKey(firstPacket, { verifyKeyPackets: true });
	expect(verifiedNextKey).toBe(null);
});
