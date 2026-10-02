import { beforeAll, expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { InputVideoTrack } from '../../src/input-track.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { isThenable, MaybePromise, MaybeRelevantPromise, ResultValue } from '../../src/misc.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import {
	EncodedPacket,
	PacketCache,
	PacketReader,
	PacketRetrievalOptions,
	PacketRetrievalResult,
	PacketType,
} from '../../src/packet.js';
import { BufferSource } from '../../src/source.js';
import { BufferTarget } from '../../src/target.js';

type PacketSpec = {
	type: PacketType;
	timestamp: number;
	actualType?: PacketType;
};

// Decode order. Features an open GOP (key packet at 6 with leading packets at 4 and 5), a fake key packet at 8 whose
// bitstream says otherwise, duplicate timestamps (8 and 9), and a key packet sharing its timestamp with the delta
// packet right before it. All of it adheres to the GOP rule (no packets after a key frame have a timestamp less than
// any packet before the key frame).
const MAIN_PACKETS: PacketSpec[] = [
	{ type: 'key', timestamp: 2 }, // 0
	{ type: 'delta', timestamp: 0 }, // 1
	{ type: 'delta', timestamp: 1 }, // 2
	{ type: 'delta', timestamp: 3 }, // 3
	{ type: 'key', timestamp: 6 }, // 4
	{ type: 'delta', timestamp: 4 }, // 5
	{ type: 'delta', timestamp: 5 }, // 6
	{ type: 'delta', timestamp: 7 }, // 7
	{ type: 'key', timestamp: 8, actualType: 'delta' }, // 8
	{ type: 'delta', timestamp: 8 }, // 9
	{ type: 'delta', timestamp: 9 }, // 10
	{ type: 'key', timestamp: 9 }, // 11
	{ type: 'delta', timestamp: 10 }, // 12
];

// The very first key packet is fake here
const FAKE_FIRST_KEY_PACKETS: PacketSpec[] = [
	{ type: 'key', timestamp: 0, actualType: 'delta' }, // 0
	{ type: 'delta', timestamp: 1 }, // 1
	{ type: 'key', timestamp: 2 }, // 2
	{ type: 'delta', timestamp: 3 }, // 3
];

const QUERY_TIMESTAMPS = [
	-Infinity, -1, 0, 0.5, 1, 2, 2.5, 3, 3.5, 4, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 100, Infinity,
];

const BACKING_METHODS = ['getFirstPacket', 'getPacket', 'getKeyPacket', 'getNextPacket', 'getNextKeyPacket'] as const;
type BackingMethod = typeof BACKING_METHODS[number];

let mainFile: ArrayBuffer;
let fakeFirstKeyFile: ArrayBuffer;
let emptyFile: ArrayBuffer;

// All packets, read without any cache involvement, so that tests have packets to hand to getNext & co.
let mainPackets: EncodedPacket[];
let fakeFirstKeyPackets: EncodedPacket[];

beforeAll(async () => {
	mainFile = await createFile(MAIN_PACKETS);
	fakeFirstKeyFile = await createFile(FAKE_FIRST_KEY_PACKETS);
	emptyFile = await createFile([]);

	mainPackets = await readAllPackets(mainFile);
	fakeFirstKeyPackets = await readAllPackets(fakeFirstKeyFile);
});

test('Synthetic file matches the reference model', async () => {
	using ctx = await setup(mainFile);
	const reader = new PacketReader(ctx.track);

	for (const timestamp of QUERY_TIMESTAMPS) {
		expectPacket(await reader.getAt(timestamp), MAIN_PACKETS, modelAt(MAIN_PACKETS, timestamp));
		expectPacket(await reader.getKeyAt(timestamp), MAIN_PACKETS, modelKeyAt(MAIN_PACKETS, timestamp));
		expectPacket(
			await reader.getKeyAt(timestamp, { verifyKeyPackets: true }),
			MAIN_PACKETS,
			modelKeyAt(MAIN_PACKETS, timestamp, true),
		);
	}

	for (let i = 0; i < mainPackets.length; i++) {
		expectPacket(mainPackets[i], MAIN_PACKETS, i);
		expectPacket(await reader.getNext(mainPackets[i]!), MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
		expectPacket(await reader.getNextKey(mainPackets[i]!), MAIN_PACKETS, modelNextKey(MAIN_PACKETS, i));
	}
});

test('Sequential reading', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expect(cached.first()).toBe(undefined);

	let packet = await reader.getFirst();
	expectPacket(packet, MAIN_PACKETS, 0);
	expectPacket(cached.first(), MAIN_PACKETS, 0);

	for (let i = 0; i < mainPackets.length; i++) {
		expect(cached.next(packet!)).toBe(undefined);
		packet = await reader.getNext(packet!);
		expectPacket(packet, MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
		expectPacket(cached.next(mainPackets[i]!), MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
	}

	expectSortedPacketList(ctx.info);

	// Having read everything, every GOP is complete, so pretty much everything can be answered by the cache now
	for (const timestamp of QUERY_TIMESTAMPS) {
		if (timestamp === -Infinity) {
			// Nothing can ever lie at or before negative infinity
			expect(cached.at(timestamp)).toBe(null);
			expect(cached.keyAt(timestamp)).toBe(null);
			continue;
		}

		if (timestamp < 0) {
			expect(cached.at(timestamp)).toBe(undefined);
		} else {
			expectPacket(cached.at(timestamp), MAIN_PACKETS, modelAt(MAIN_PACKETS, timestamp));
		}

		if (timestamp < 2) {
			expect(cached.keyAt(timestamp)).toBe(undefined);
		} else {
			expectPacket(cached.keyAt(timestamp), MAIN_PACKETS, modelKeyAt(MAIN_PACKETS, timestamp));
		}
	}

	for (let i = 0; i < mainPackets.length; i++) {
		expectPacket(cached.nextKey(mainPackets[i]!), MAIN_PACKETS, modelNextKey(MAIN_PACKETS, i));
	}

	// And the reader no longer needs the backing at all
	const callCount = backing.totalCalls();
	for (const timestamp of QUERY_TIMESTAMPS.filter(x => x >= 2)) {
		expectPacket(await reader.getAt(timestamp), MAIN_PACKETS, modelAt(MAIN_PACKETS, timestamp));
		expectPacket(await reader.getKeyAt(timestamp), MAIN_PACKETS, modelKeyAt(MAIN_PACKETS, timestamp));
	}
	for (let i = 0; i < mainPackets.length; i++) {
		expectPacket(await reader.getNext(mainPackets[i]!), MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
		expectPacket(await reader.getNextKey(mainPackets[i]!), MAIN_PACKETS, modelNextKey(MAIN_PACKETS, i));
	}
	expectPacket(await reader.getFirst(), MAIN_PACKETS, 0);
	expectPacket(await reader.getFirstKey(), MAIN_PACKETS, 0);
	expect(backing.totalCalls()).toBe(callCount);

	// What lies before the first packets still needs to be learned
	expect(await reader.getAt(-1)).toBe(null);
	expect(cached.at(-1)).toBe(null);
	expect(cached.at(-2)).toBe(null);
	expect(await reader.getKeyAt(1)).toBe(null);
	expect(cached.keyAt(1)).toBe(null);
	expect(cached.keyAt(0.5)).toBe(null);
	expect(backing.totalCalls()).toBe(callCount + 2);
});

test('Seeking', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expect(cached.at(5.5)).toBe(undefined);
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(5), MAIN_PACKETS, 6);
	expect(cached.at(5.6)).toBe(undefined); // Something could lie in between
	expect(cached.at(4.5)).toBe(undefined); // No packet known here
	expect(cached.keyAt(5.5)).toBe(undefined); // It's a delta packet

	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expect(backing.calls.getPacket).toBe(1);

	// The same packet, learned via a larger timestamp
	expectPacket(await reader.getAt(5.8), MAIN_PACKETS, 6);
	expectPacket(cached.at(5.7), MAIN_PACKETS, 6);
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expect(backing.calls.getPacket).toBe(2);

	// Retrieving a key packet also makes it available to key packet seeking
	expectPacket(await reader.getAt(6.5), MAIN_PACKETS, 4);
	expectPacket(cached.at(6.5), MAIN_PACKETS, 4);
	expectPacket(cached.keyAt(6.5), MAIN_PACKETS, 4);
	expect(cached.keyAt(6.6)).toBe(undefined);

	expect(await reader.getAt(-1)).toBe(null);
	expect(cached.at(-1)).toBe(null);
	expect(cached.at(-5)).toBe(null);
	expect(cached.keyAt(-5)).toBe(null);
	expect(cached.at(-0.5)).toBe(undefined);

	expectSortedPacketList(ctx.info);
});

test('Key packet seeking', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expect(cached.keyAt(5.5)).toBe(undefined);
	expectPacket(await reader.getKeyAt(5.5), MAIN_PACKETS, 0);
	expectPacket(cached.keyAt(5.5), MAIN_PACKETS, 0);
	expectPacket(cached.keyAt(2), MAIN_PACKETS, 0);
	expect(cached.keyAt(5.6)).toBe(undefined);
	expect(cached.at(5.5)).toBe(undefined); // Doesn't tell us anything about non-key packets

	expectPacket(await reader.getKeyAt(5.5), MAIN_PACKETS, 0);
	expect(backing.calls.getKeyPacket).toBe(1);

	// The cache walks back over delta packets to find the relevant key packet
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.keyAt(5.5), MAIN_PACKETS, 0);

	expect(await reader.getKeyAt(1)).toBe(null);
	expect(cached.keyAt(1)).toBe(null);
	expect(cached.keyAt(0.5)).toBe(null);
	expect(cached.at(0.5)).toBe(undefined); // There are delta packets before the first key packet

	expectPacket(await reader.getKeyAt(100), MAIN_PACKETS, 11);
	expectPacket(cached.keyAt(100), MAIN_PACKETS, 11);
	expect(cached.keyAt(101)).toBe(undefined);
});

test('Infinite timestamps', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expect(cached.at(-Infinity)).toBe(null);
	expect(cached.keyAt(-Infinity)).toBe(null);
	expect(await reader.getAt(-Infinity)).toBe(null);
	expect(await reader.getKeyAt(-Infinity)).toBe(null);
	expect(backing.totalCalls()).toBe(0);

	// The last packet in presentation order
	expect(cached.at(Infinity)).toBe(undefined);
	expectPacket(await reader.getAt(Infinity), MAIN_PACKETS, 12);
	expectPacket(cached.at(Infinity), MAIN_PACKETS, 12);
	expectPacket(cached.at(1e300), MAIN_PACKETS, 12);
	expectPacket(cached.at(10), MAIN_PACKETS, 12);
	expect(cached.at(9.99)).toBe(undefined);
	expectPacket(await reader.getAt(Infinity), MAIN_PACKETS, 12);
	expect(backing.calls.getPacket).toBe(1);

	expect(cached.keyAt(Infinity)).toBe(undefined);
	expectPacket(await reader.getKeyAt(Infinity), MAIN_PACKETS, 11);
	expectPacket(cached.keyAt(Infinity), MAIN_PACKETS, 11);
	expectPacket(cached.keyAt(9.5), MAIN_PACKETS, 11);
	expectPacket(await reader.getKeyAt(Infinity), MAIN_PACKETS, 11);
	expect(backing.calls.getKeyPacket).toBe(1);

	expectPacket(
		await reader.getKeyAt(Infinity, { verifyKeyPackets: true }),
		MAIN_PACKETS,
		modelKeyAt(MAIN_PACKETS, Infinity, true),
	);

	// Concurrent requests for infinity are deduplicated too
	using ctx2 = await setup(mainFile);
	ctx2.backing.forceAsync = true;
	const results = await Promise.all([ctx2.reader.getAt(Infinity), ctx2.reader.getAt(Infinity)]);
	expectPacket(results[0], MAIN_PACKETS, 12);
	expectPacket(results[1], MAIN_PACKETS, 12);
	expect(ctx2.backing.calls.getPacket).toBe(1);

	// Reading up to the end also makes the cache aware of what's last
	using ctx3 = await setup(mainFile);
	expectPacket(await ctx3.reader.getKeyAt(9), MAIN_PACKETS, 11);
	expect(await readSequentially(ctx3.reader, mainPackets[11]!, 2)).toBe(null);
	expectPacket(ctx3.cached.at(Infinity), MAIN_PACKETS, 12);
	expectPacket(ctx3.cached.keyAt(Infinity), MAIN_PACKETS, 11);
});

test('Open GOP', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached } = ctx;

	// Read the first GOP, including the key packet that starts the next one
	await readSequentially(reader, (await reader.getFirst())!, 4);

	// The next GOP has leading packets at 4 and 5, below its key packet at 6, so the first GOP's packets must not be
	// considered valid beyond the first GOP's maximum timestamp
	expectPacket(cached.at(3), MAIN_PACKETS, 3);
	expect(cached.at(3.5)).toBe(undefined);
	expect(cached.at(4.5)).toBe(undefined);
	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);

	// Key packets on the other hand are monotonic, so key packet seeking may extend up to the next key packet
	expectPacket(cached.keyAt(5.9), MAIN_PACKETS, 0);
	expect(cached.keyAt(6)).toBe(undefined); // Another key packet might share its timestamp
});

test('Reverse GOP finalization', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached } = ctx;

	// Read the second GOP first
	expectPacket(await reader.getKeyAt(6), MAIN_PACKETS, 4);
	await readSequentially(reader, mainPackets[4]!, 4);

	expectPacket(cached.at(4.5), MAIN_PACKETS, 5);
	expectPacket(cached.at(7), MAIN_PACKETS, 7);
	expect(cached.at(7.5)).toBe(undefined); // The GOP's minimum timestamp after it is not yet known
	expect(cached.at(3.5)).toBe(undefined);

	// Now the first one. Since the second GOP's minimum timestamp is known, the first GOP can extend up to it
	await readSequentially(reader, (await reader.getFirst())!, 4);
	expectPacket(cached.at(3.5), MAIN_PACKETS, 3);
	expectPacket(cached.at(3.99), MAIN_PACKETS, 3);

	// Reading the third GOP extends the second one up to the third's minimum timestamp
	await readSequentially(reader, mainPackets[8]!, 3);
	expectPacket(cached.at(7.5), MAIN_PACKETS, 7);
	expectPacket(cached.at(8), MAIN_PACKETS, 9);
	expectPacket(cached.at(8.5), MAIN_PACKETS, 9);
	expect(cached.at(9)).toBe(undefined); // The fourth GOP is only known by its key packet

	expectSortedPacketList(ctx.info);
});

test('Mid-GOP seek joined later', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached } = ctx;

	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	await readSequentially(reader, mainPackets[5]!, 1);

	// The chain starting at the GOP's key packet joins the existing one, but it doesn't reach the GOP's end yet
	expectPacket(await reader.getKeyAt(6), MAIN_PACKETS, 4);
	expectPacket(await reader.getNext(mainPackets[4]!), MAIN_PACKETS, 5);
	expect(cached.at(5.5)).toBe(undefined);
	expectPacket(cached.keyAt(6), MAIN_PACKETS, 4);
	expect(cached.keyAt(6.5)).toBe(undefined);

	// Now it does
	await readSequentially(reader, mainPackets[6]!, 2);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(7), MAIN_PACKETS, 7);
	expectPacket(cached.keyAt(7.9), MAIN_PACKETS, 4);
	expectPacket(cached.nextKey(mainPackets[5]!), MAIN_PACKETS, 8);

	// The same, but this time the join completes the GOP right away
	using ctx2 = await setup(mainFile);
	expectPacket(await ctx2.reader.getAt(4.5), MAIN_PACKETS, 5);
	await readSequentially(ctx2.reader, mainPackets[5]!, 3);
	expect(ctx2.cached.at(5.5)).toBe(undefined);

	expectPacket(await ctx2.reader.getKeyAt(6), MAIN_PACKETS, 4);
	expectPacket(await ctx2.reader.getNext(mainPackets[4]!), MAIN_PACKETS, 5);
	expectPacket(ctx2.cached.at(5.5), MAIN_PACKETS, 6);
	expectPacket(ctx2.cached.keyAt(7.9), MAIN_PACKETS, 4);
});

test('Duplicate timestamps', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, info } = ctx;

	// Of the two packets at 8, getAt returns the later one
	expectPacket(await reader.getAt(8), MAIN_PACKETS, 9);
	expectPacket(cached.at(8), MAIN_PACKETS, 9);

	// The earlier one gets inserted before it
	expectPacket(await reader.getKeyAt(8.5), MAIN_PACKETS, 8);
	expect(info.packets.map(x => x.sequenceNumber)).toEqual([8, 9]);
	expectPacket(cached.at(8), MAIN_PACKETS, 9);

	// Retrieving the later one again doesn't duplicate it
	expectPacket(await reader.getNext(mainPackets[8]!), MAIN_PACKETS, 9);
	expect(info.packets.map(x => x.sequenceNumber)).toEqual([8, 9]);

	expectPacket(await reader.getAt(9), MAIN_PACKETS, 11);
	expectPacket(await reader.getNext(mainPackets[9]!), MAIN_PACKETS, 10);
	expectPacket(await reader.getNext(mainPackets[10]!), MAIN_PACKETS, 11);
	expect(info.packets.map(x => x.sequenceNumber)).toEqual([8, 9, 10, 11]);
	expectPacket(cached.at(9), MAIN_PACKETS, 11);

	expectSortedPacketList(info);
});

test('Key packet sharing its timestamp with the preceding delta packet', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached } = ctx;

	expectPacket(await reader.getKeyAt(8), MAIN_PACKETS, 8);
	await readSequentially(reader, mainPackets[8]!, 2);

	// The next key packet may still lie at 9, so key packet seeking can only go right up to it
	expectPacket(cached.keyAt(8.99), MAIN_PACKETS, 8);
	expect(cached.keyAt(9)).toBe(undefined);
	expectPacket(await reader.getKeyAt(9), MAIN_PACKETS, 11);

	using ctx2 = await setup(mainFile);
	expectPacket(await ctx2.reader.getKeyAt(8), MAIN_PACKETS, 8);
	await readSequentially(ctx2.reader, mainPackets[8]!, 3);
	expectPacket(ctx2.cached.keyAt(8.99), MAIN_PACKETS, 8);
	expect(ctx2.cached.keyAt(9)).toBe(undefined); // The key packet at 9 has no validity of its own yet

	await readSequentially(ctx2.reader, mainPackets[11]!, 1);
	expectPacket(ctx2.cached.keyAt(9), MAIN_PACKETS, 11);
	expectPacket(ctx2.cached.keyAt(9.99), MAIN_PACKETS, 11);
});

test('Next key packets', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expect(cached.nextKey(mainPackets[0]!)).toBe(undefined);
	expectPacket(await reader.getNextKey(mainPackets[0]!), MAIN_PACKETS, 4);
	expectPacket(cached.nextKey(mainPackets[0]!), MAIN_PACKETS, 4);
	expectPacket(await reader.getNextKey(mainPackets[0]!), MAIN_PACKETS, 4);
	expect(backing.calls.getNextKeyPacket).toBe(1);

	// Knowing the next key packet after a key packet bounds key packet seeking
	expect(cached.keyAt(3)).toBe(undefined);
	expectPacket(await reader.getKeyAt(2), MAIN_PACKETS, 0);
	expectPacket(cached.keyAt(5.9), MAIN_PACKETS, 0);

	// Not so for packets whose GOP is unknown
	expectPacket(await reader.getNextKey(mainPackets[6]!), MAIN_PACKETS, 8);
	expectPacket(cached.nextKey(mainPackets[6]!), MAIN_PACKETS, 8);
	expect(cached.keyAt(7.9)).toBe(undefined);

	// But for packets whose GOP is known
	expectPacket(await reader.getKeyAt(8), MAIN_PACKETS, 8);
	await readSequentially(reader, mainPackets[8]!, 1);
	expect(cached.keyAt(8.99)).toBe(undefined);
	expectPacket(await reader.getNextKey(mainPackets[9]!), MAIN_PACKETS, 11);
	expectPacket(cached.keyAt(8.99), MAIN_PACKETS, 8);

	// There's no key packet after the last one, so it's valid indefinitely
	expectPacket(await reader.getKeyAt(9.5), MAIN_PACKETS, 11);
	expect(await reader.getNextKey(mainPackets[11]!)).toBe(null);
	expect(cached.nextKey(mainPackets[11]!)).toBe(null);
	expectPacket(cached.keyAt(1000), MAIN_PACKETS, 11);
	expect(await reader.getNextKey(mainPackets[12]!)).toBe(null);
	expect(cached.nextKey(mainPackets[12]!)).toBe(null);
});

test('Next key packets from the next() chain', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	await readSequentially(reader, mainPackets[5]!, 2);
	expect(cached.nextKey(mainPackets[5]!)).toBe(undefined); // Chain incomplete

	await readSequentially(reader, mainPackets[7]!, 1);
	expectPacket(cached.nextKey(mainPackets[5]!), MAIN_PACKETS, 8);
	expectPacket(await reader.getNextKey(mainPackets[5]!), MAIN_PACKETS, 8);
	expect(backing.calls.getNextKeyPacket).toBe(0);

	expectPacket(await reader.getAt(10), MAIN_PACKETS, 12);
	await readSequentially(reader, mainPackets[12]!, 1);
	expect(cached.nextKey(mainPackets[12]!)).toBe(null);
});

test('Metadata-only packets', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, info } = ctx;
	const metadataOnly = { metadataOnly: true };

	const metadataPacket = await reader.getAt(5.5, metadataOnly);
	expectPacket(metadataPacket, MAIN_PACKETS, 6);
	expect(metadataPacket!.isMetadataOnly).toBe(true);
	expect((cached.at(5.5, metadataOnly) as EncodedPacket).isMetadataOnly).toBe(true);
	expect(cached.at(5.5)).toBe(undefined); // The data isn't known

	// The cache stores its own instance, which it upgrades in place once the data becomes known
	const storedPacket = info.packets[0]!;
	expect(storedPacket).not.toBe(metadataPacket);

	const fullPacket = await reader.getAt(5.5);
	expectPacket(fullPacket, MAIN_PACKETS, 6);
	expect(fullPacket!.isMetadataOnly).toBe(false);
	expect(info.packets[0]).toBe(storedPacket);
	expect(storedPacket.isMetadataOnly).toBe(false);
	expect(metadataPacket!.isMetadataOnly).toBe(true);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expect((cached.at(5.5, metadataOnly) as EncodedPacket).isMetadataOnly).toBe(true);

	// A full packet is never downgraded
	expectPacket(await reader.getAt(5.7, metadataOnly), MAIN_PACKETS, 6);
	expect(info.packets[0]!.isMetadataOnly).toBe(false);

	// The upgrade is seen by everything referencing the packet
	expectPacket(await reader.getFirst(metadataOnly), MAIN_PACKETS, 0);
	expectPacket(await reader.getNext(mainPackets[0]!, metadataOnly), MAIN_PACKETS, 1);
	expectPacket(await reader.getNextKey(mainPackets[3]!, metadataOnly), MAIN_PACKETS, 4);
	expect(cached.first()).toBe(undefined);
	expect(cached.next(mainPackets[0]!)).toBe(undefined);
	expect(cached.nextKey(mainPackets[3]!)).toBe(undefined);

	expectPacket(await reader.getAt(2), MAIN_PACKETS, 0);
	expectPacket(await reader.getAt(0), MAIN_PACKETS, 1);
	expectPacket(await reader.getAt(6), MAIN_PACKETS, 4);
	expectPacket(cached.first(), MAIN_PACKETS, 0);
	expectPacket(cached.next(mainPackets[0]!), MAIN_PACKETS, 1);
	expectPacket(cached.nextKey(mainPackets[3]!), MAIN_PACKETS, 4);
	expect((cached.first() as EncodedPacket).isMetadataOnly).toBe(false);

	// A chain learned without data, then traversed with data
	expectPacket(await reader.getNext(mainPackets[4]!, metadataOnly), MAIN_PACKETS, 5);
	expectPacket(await reader.getNext(mainPackets[4]!), MAIN_PACKETS, 5);

	expectSortedPacketList(info);
});

test('Fresh packet instances', async () => {
	using ctx = await setup(mainFile);
	const { reader, info } = ctx;

	const a = (await reader.getAt(5.5))!;
	const b = (await reader.getAt(5.5))!;
	const c = (await reader.getAt(5.5))!;
	expect(a).not.toBe(b);
	expect(b).not.toBe(c);
	expect(b).not.toBe(info.packets[0]);
	expect(c).not.toBe(info.packets[0]);
	expect(b.data).toBe(c.data);
});

test('Key packet verification', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;
	const verify = { verifyKeyPackets: true };

	expectPacket(await reader.getFirst(verify), MAIN_PACKETS, 0);
	expectPacket(cached.first(verify), MAIN_PACKETS, 0);

	expectPacket(await reader.getNext(mainPackets[3]!, verify), MAIN_PACKETS, 4);
	expectPacket(cached.next(mainPackets[3]!, verify), MAIN_PACKETS, 4);

	// The fake key packet comes back as what it actually is when verifying, and as what the container says otherwise
	expectPacket(await reader.getNext(mainPackets[7]!, verify), MAIN_PACKETS, 8, 'delta');
	expectPacket(cached.next(mainPackets[7]!, verify), MAIN_PACKETS, 8, 'delta');
	expectPacket(cached.next(mainPackets[7]!), MAIN_PACKETS, 8, 'key');
	expectPacket(await reader.getNext(mainPackets[7]!), MAIN_PACKETS, 8, 'key');

	expectPacket(await reader.getAt(6.5, verify), MAIN_PACKETS, 4);
	expectPacket(cached.at(6.5, verify), MAIN_PACKETS, 4);

	expectPacket(await reader.getAt(8.5, verify), MAIN_PACKETS, 9);

	// Verified key packet seeking skips over the fake key packet, and remembers everything it found along the way
	const keyPacketCalls = backing.calls.getKeyPacket;
	expectPacket(await reader.getKeyAt(8.5, verify), MAIN_PACKETS, 4);
	expect(backing.calls.getKeyPacket).toBeGreaterThan(keyPacketCalls);
	expectPacket(cached.keyAt(8.5, verify), MAIN_PACKETS, 8, 'delta');
	expectPacket(cached.keyAt(8.5), MAIN_PACKETS, 8);

	const callCount = backing.totalCalls();
	expectPacket(await reader.getKeyAt(8.5, verify), MAIN_PACKETS, 4);
	expectPacket(reader.getKeyAt(8.5, verify) as EncodedPacket, MAIN_PACKETS, 4); // Fully synchronous
	expectPacket(await reader.getKeyAt(8.5), MAIN_PACKETS, 8);
	expect(backing.totalCalls()).toBe(callCount);

	// Same for next key packets
	expectPacket(await reader.getNextKey(mainPackets[5]!, verify), MAIN_PACKETS, 11);
	expectPacket(cached.nextKey(mainPackets[5]!, verify), MAIN_PACKETS, 8, 'delta');
	const nextKeyCallCount = backing.totalCalls();
	expectPacket(await reader.getNextKey(mainPackets[5]!, verify), MAIN_PACKETS, 11);
	expectPacket(await reader.getNextKey(mainPackets[5]!), MAIN_PACKETS, 8);
	expect(backing.totalCalls()).toBe(nextKeyCallCount);
	expectPacket(await reader.getNextKey(mainPackets[11]!, verify), MAIN_PACKETS, null);
});

test('Key packet verification of cached packets', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;
	const verify = { verifyKeyPackets: true };

	// Packets cached without verification get verified on demand
	expectPacket(await reader.getKeyAt(6.5), MAIN_PACKETS, 4);
	const verified = cached.keyAt(6.5, verify);
	expect(verified).toBeInstanceOf(Promise);
	expectPacket(await verified, MAIN_PACKETS, 4);
	expectPacket(cached.keyAt(6.5, verify), MAIN_PACKETS, 4);

	expectPacket(await reader.getKeyAt(8.5), MAIN_PACKETS, 8);
	const verifiedFake = cached.keyAt(8.5, verify);
	expect(verifiedFake).toBeInstanceOf(Promise);
	expectPacket(await verifiedFake, MAIN_PACKETS, 8, 'delta');

	// The reader steps back from the fake key packet, partly using the cache
	const callCount = backing.calls.getKeyPacket;
	expectPacket(await reader.getKeyAt(8.5, verify), MAIN_PACKETS, 4);
	expect(backing.calls.getKeyPacket).toBe(callCount + 1);

	// Same for next key packets
	expectPacket(await reader.getNextKey(mainPackets[5]!), MAIN_PACKETS, 8);
	expectPacket(await reader.getNextKey(mainPackets[5]!, verify), MAIN_PACKETS, 11);
	expectPacket(cached.nextKey(mainPackets[8]!, verify), MAIN_PACKETS, 11);

	// The reader itself also verifies cached packets on demand
	expectPacket(await reader.getKeyAt(2.5), MAIN_PACKETS, 0);
	expectPacket(await reader.getKeyAt(2.5, verify), MAIN_PACKETS, 0);

	using ctx2 = await setup(mainFile);
	expectPacket(await ctx2.reader.getNextKey(mainPackets[0]!), MAIN_PACKETS, 4);
	expectPacket(await ctx2.reader.getNextKey(mainPackets[0]!, verify), MAIN_PACKETS, 4);
	expect(ctx2.backing.calls.getNextKeyPacket).toBe(1);
});

test('Fake first key packet', async () => {
	using ctx = await setup(fakeFirstKeyFile);
	const { reader, cached } = ctx;
	const verify = { verifyKeyPackets: true };

	const first = (await reader.getFirst(verify))!;
	expectPacket(first, FAKE_FIRST_KEY_PACKETS, 0, 'delta');
	expectPacket(cached.first(verify), FAKE_FIRST_KEY_PACKETS, 0, 'delta');
	expectPacket(cached.first(), FAKE_FIRST_KEY_PACKETS, 0, 'key');

	// Continuing from the packet that claims to be a delta packet, the first packet still starts the first GOP
	const second = (await reader.getNext(first))!;
	expectPacket(second, FAKE_FIRST_KEY_PACKETS, 1);
	expectPacket(await reader.getNext(second), FAKE_FIRST_KEY_PACKETS, 2);
	expectPacket(cached.at(0.5), FAKE_FIRST_KEY_PACKETS, 0);
	expectPacket(cached.at(1), FAKE_FIRST_KEY_PACKETS, 1);
	expect(cached.at(1.5)).toBe(undefined);
	expectPacket(await reader.getAt(0.5, verify), FAKE_FIRST_KEY_PACKETS, 0, 'delta');

	using ctx2 = await setup(fakeFirstKeyFile);
	expectPacket(await ctx2.reader.getAt(0.5, verify), FAKE_FIRST_KEY_PACKETS, 0, 'delta');
	expectPacket(ctx2.cached.at(0.5, verify), FAKE_FIRST_KEY_PACKETS, 0, 'delta');

	expectPacket(await reader.getKeyAt(1, verify), FAKE_FIRST_KEY_PACKETS, null);
	expectPacket(await reader.getKeyAt(3, verify), FAKE_FIRST_KEY_PACKETS, 2);
	expectPacket(await reader.getFirstKey(verify), FAKE_FIRST_KEY_PACKETS, 2);
	expect(fakeFirstKeyPackets).toHaveLength(FAKE_FIRST_KEY_PACKETS.length);
});

test('First GOP completed by learning the first packet', async () => {
	using ctx = await setup(fakeFirstKeyFile);
	const { reader, cached } = ctx;
	const verify = { verifyKeyPackets: true };
	const metadataOnly = { metadataOnly: true };

	// Continue from the first packet, which claims to be a delta packet, without knowing that it's the first packet
	const first = (await reader.getAt(0.5, verify))!;
	expectPacket(first, FAKE_FIRST_KEY_PACKETS, 0, 'delta');
	const second = (await reader.getNext(first))!;
	expectPacket(await reader.getNext(second), FAKE_FIRST_KEY_PACKETS, 2);
	expect(cached.at(1.5)).toBe(undefined);

	// Read the second GOP, but without data
	expectPacket(await reader.getNext(fakeFirstKeyPackets[2]!, metadataOnly), FAKE_FIRST_KEY_PACKETS, 3);
	expect(await reader.getNext(fakeFirstKeyPackets[3]!, metadataOnly)).toBe(null);

	// This completes the first GOP, which then extends right up to the second one
	expectPacket(await reader.getFirst(), FAKE_FIRST_KEY_PACKETS, 0);
	expectPacket(cached.at(1.5), FAKE_FIRST_KEY_PACKETS, 1);
	expectPacket(cached.at(1.99), FAKE_FIRST_KEY_PACKETS, 1);
});

test('Empty track', async () => {
	using ctx = await setup(emptyFile);
	const { reader, cached, backing } = ctx;

	expect(await reader.getFirst()).toBe(null);
	expect(cached.first()).toBe(null);
	expect(await reader.getFirst()).toBe(null);
	expect(await reader.getFirstKey()).toBe(null);
	expect(backing.calls.getFirstPacket).toBe(1);

	expect(await reader.getAt(5)).toBe(null);
	expect(cached.at(5)).toBe(null);
	expect(cached.at(6)).toBe(undefined);

	expect(await reader.getKeyAt(6)).toBe(null);
	expect(cached.keyAt(6)).toBe(null);
	expect(await reader.getKeyAt(6)).toBe(null);
	expect(backing.calls.getKeyPacket).toBe(1);
});

test('Provisional results', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing, info } = ctx;
	backing.markProvisional = true;

	expectPacket(await reader.getFirst(), MAIN_PACKETS, 0);
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expectPacket(await reader.getKeyAt(5.5), MAIN_PACKETS, 0);
	expectPacket(await reader.getNext(mainPackets[0]!), MAIN_PACKETS, 1);
	expectPacket(await reader.getNextKey(mainPackets[0]!), MAIN_PACKETS, 4);
	expectPacket(await reader.getFirst({ verifyKeyPackets: true }), MAIN_PACKETS, 0);
	expectPacket(await reader.getKeyAt(8.5, { verifyKeyPackets: true }), MAIN_PACKETS, 4);
	expectPacket(await reader.getNextKey(mainPackets[5]!, { verifyKeyPackets: true }), MAIN_PACKETS, 11);
	expect(await reader.getAt(-1)).toBe(null);

	expect(cached.first()).toBe(undefined);
	expect(cached.at(5.5)).toBe(undefined);
	expect(cached.keyAt(5.5)).toBe(undefined);
	expect(cached.next(mainPackets[0]!)).toBe(undefined);
	expect(cached.nextKey(mainPackets[0]!)).toBe(undefined);
	expect(cached.at(-1)).toBe(undefined);
	expect(info.packets).toHaveLength(0);

	// Asking again goes to the backing again
	const callCount = backing.totalCalls();
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expect(backing.totalCalls()).toBe(callCount + 1);

	backing.markProvisional = false;
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
});

test('Concurrent identical requests', async () => {
	using ctx = await setup(mainFile);
	const { reader, backing, info } = ctx;
	backing.forceAsync = true;

	const firsts = await Promise.all([reader.getFirst(), reader.getFirst()]);
	expectPacket(firsts[0], MAIN_PACKETS, 0);
	expectPacket(firsts[1], MAIN_PACKETS, 0);
	expect(firsts[0]).not.toBe(firsts[1]);
	expect(backing.calls.getFirstPacket).toBe(1);

	const ats = await Promise.all([reader.getAt(5.5), reader.getAt(5.5), reader.getAt(5.6)]);
	expectPacket(ats[0], MAIN_PACKETS, 6);
	expectPacket(ats[1], MAIN_PACKETS, 6);
	expectPacket(ats[2], MAIN_PACKETS, 6);
	expect(backing.calls.getPacket).toBe(2); // Different timestamps aren't deduplicated

	const keyAts = await Promise.all([reader.getKeyAt(6.5), reader.getKeyAt(6.5)]);
	expectPacket(keyAts[0], MAIN_PACKETS, 4);
	expectPacket(keyAts[1], MAIN_PACKETS, 4);
	expect(backing.calls.getKeyPacket).toBe(1);

	const nexts = await Promise.all([reader.getNext(mainPackets[7]!), reader.getNext(mainPackets[7]!)]);
	expectPacket(nexts[0], MAIN_PACKETS, 8);
	expectPacket(nexts[1], MAIN_PACKETS, 8);
	expect(backing.calls.getNextPacket).toBe(1);

	const nextKeys = await Promise.all([reader.getNextKey(mainPackets[9]!), reader.getNextKey(mainPackets[9]!)]);
	expectPacket(nextKeys[0], MAIN_PACKETS, 11);
	expectPacket(nextKeys[1], MAIN_PACKETS, 11);
	expect(backing.calls.getNextKeyPacket).toBe(1);

	// Different options aren't deduplicated
	const mixed = await Promise.all([
		reader.getAt(9.5),
		reader.getAt(9.5, { metadataOnly: true }),
		reader.getAt(9.5),
	]);
	expectPacket(mixed[0], MAIN_PACKETS, 11);
	expectPacket(mixed[1], MAIN_PACKETS, 11);
	expectPacket(mixed[2], MAIN_PACKETS, 11);
	expect(mixed[1]!.isMetadataOnly).toBe(true);
	expect(backing.calls.getPacket).toBe(4);

	const mixedFirsts = await Promise.all([
		reader.getFirst({ verifyKeyPackets: true }),
		reader.getFirst({ metadataOnly: true }),
		reader.getFirst({ verifyKeyPackets: true }),
	]);
	expectPacket(mixedFirsts[0], MAIN_PACKETS, 0);
	expectPacket(mixedFirsts[1], MAIN_PACKETS, 0);
	expectPacket(mixedFirsts[2], MAIN_PACKETS, 0);

	expect(info.pendingFirstCalls).toHaveLength(0);
	expect(info.pendingAtCalls.size).toBe(0);
	expect(info.pendingKeyAtCalls.size).toBe(0);
	expect(info.pendingNextCalls.size).toBe(0);
	expect(info.pendingNextKeyCalls.size).toBe(0);
});

test('Concurrent identical requests after a failure', async () => {
	using ctx = await setup(mainFile);
	const { reader, backing, info } = ctx;
	backing.forceAsync = true;

	backing.failNextCall = true;
	const results = await Promise.allSettled([reader.getAt(5.5), reader.getAt(5.5)]);
	expect(results[0].status).toBe('rejected');
	expect(results[1].status).toBe('fulfilled');
	expectPacket((results[1] as PromiseFulfilledResult<EncodedPacket | null>).value, MAIN_PACKETS, 6);
	expect(backing.calls.getPacket).toBe(2);

	backing.failNextCall = true;
	const firsts = await Promise.allSettled([reader.getFirst(), reader.getFirst()]);
	expect(firsts[0].status).toBe('rejected');
	expect(firsts[1].status).toBe('fulfilled');

	backing.failNextCall = true;
	const keyAts = await Promise.allSettled([reader.getKeyAt(6.5), reader.getKeyAt(6.5)]);
	expect(keyAts[0].status).toBe('rejected');
	expect(keyAts[1].status).toBe('fulfilled');

	backing.failNextCall = true;
	const nexts = await Promise.allSettled([reader.getNext(mainPackets[1]!), reader.getNext(mainPackets[1]!)]);
	expect(nexts[0].status).toBe('rejected');
	expect(nexts[1].status).toBe('fulfilled');

	backing.failNextCall = true;
	const nextKeys = await Promise.allSettled([
		reader.getNextKey(mainPackets[1]!),
		reader.getNextKey(mainPackets[1]!),
	]);
	expect(nextKeys[0].status).toBe('rejected');
	expect(nextKeys[1].status).toBe('fulfilled');

	expect(info.pendingFirstCalls).toHaveLength(0);
	expect(info.pendingAtCalls.size).toBe(0);
	expect(info.pendingKeyAtCalls.size).toBe(0);
	expect(info.pendingNextCalls.size).toBe(0);
	expect(info.pendingNextKeyCalls.size).toBe(0);
});

test('Asynchronous backing', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;
	backing.forceAsync = true;
	const verify = { verifyKeyPackets: true };

	const firstKey = reader.getFirstKey();
	expect(firstKey).toBeInstanceOf(Promise);
	expectPacket(await firstKey, MAIN_PACKETS, 0);
	expectPacket(cached.first(), MAIN_PACKETS, 0);

	// Stepping back from the fake key packet requires the time resolution, which is also asynchronous now
	expectPacket(await reader.getKeyAt(8.5, verify), MAIN_PACKETS, 4);

	// A new reader, this time stepping back based on what's in the cache
	const reader2 = new PacketReader(ctx.track, { cache: ctx.cache });
	const callCount = backing.totalCalls();
	expectPacket(await reader2.getKeyAt(8.5, verify), MAIN_PACKETS, 4);
	expect(backing.totalCalls()).toBe(callCount);
});

test('Shared cache', async () => {
	const cache = new PacketCache();
	using ctx1 = await setup(mainFile, cache);
	using ctx2 = await setup(mainFile, cache);

	// Different tracks don't share their cache entries
	expectPacket(await ctx1.reader.getAt(5.5), MAIN_PACKETS, 6);
	expect(ctx2.cached.at(5.5)).toBe(undefined);

	// Different readers of the same track do
	const reader = new PacketReader(ctx1.track, { cache });
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expect(ctx1.backing.calls.getPacket).toBe(1);
});

const createFile = async (packets: PacketSpec[]) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, {
		decoderConfig: {
			codec: 'vp8',
			codedWidth: 64,
			codedHeight: 64,
		},
	});

	await output.start();

	for (let i = 0; i < packets.length; i++) {
		const spec = packets[i]!;

		const data = new Uint8Array(8);
		data[0] = (spec.actualType ?? spec.type) === 'key' ? 0 : 1; // VP8 frame tag
		data[1] = i;

		await source.add(new EncodedPacket(data, spec.type, spec.timestamp, 1));
	}

	await output.finalize();
	return output.target.buffer!;
};

const readAllPackets = async (file: ArrayBuffer) => {
	const { input, track } = await openFile(file);
	using _ = input;

	const reader = new PacketReader(track);
	const packets: EncodedPacket[] = [];

	let packet = await reader.getFirst();
	while (packet) {
		packets.push(packet);
		packet = await reader.getNext(packet);
	}

	return packets;
};

const setup = async (file: ArrayBuffer, cache = new PacketCache()) => {
	const { input, track } = await openFile(file);
	const reader = new PacketReader(track, { cache });
	const info = cache._getTrackInfo(track);
	const backing = instrumentBacking(track);

	return {
		track,
		cache,
		reader,
		info,
		backing,
		// Direct access to the cache, so we know whether something was answered by it or not
		cached: {
			first: (options: PacketRetrievalOptions = {}) => cache._getFirst(info, options),
			at: (timestamp: number, options: PacketRetrievalOptions = {}) => cache._getAt(info, timestamp, options),
			keyAt: (timestamp: number, options: PacketRetrievalOptions = {}) => {
				return cache._getKeyAt(info, timestamp, options);
			},
			next: (packet: EncodedPacket, options: PacketRetrievalOptions = {}) => {
				return cache._getNext(info, packet, options);
			},
			nextKey: (packet: EncodedPacket, options: PacketRetrievalOptions = {}) => {
				return cache._getNextKey(info, packet, options);
			},
		},
		[Symbol.dispose]: () => input.dispose(),
	};
};

const openFile = async (file: ArrayBuffer) => {
	const input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});
	const track = (await input.getPrimaryVideoTrack())!;

	return {
		input,
		track,
	};
};

const instrumentBacking = (track: InputVideoTrack) => {
	const instrumentation = {
		calls: {
			getFirstPacket: 0,
			getPacket: 0,
			getKeyPacket: 0,
			getNextPacket: 0,
			getNextKeyPacket: 0,
		},
		markProvisional: false,
		failNextCall: false,
		// The MP4 backing answers synchronously for in-memory files, which would never let calls overlap
		forceAsync: false,
		totalCalls: () => Object.values(instrumentation.calls).reduce((a, b) => a + b, 0),
	};

	const getTimeResolution = track._backing.getTimeResolution.bind(track._backing);
	track._backing.getTimeResolution = () => {
		return instrumentation.forceAsync ? Promise.resolve(getTimeResolution()) : getTimeResolution();
	};

	type Method = (res: ResultValue<PacketRetrievalResult>, ...args: unknown[]) => MaybeRelevantPromise;
	const backing = track._backing as unknown as Record<BackingMethod, Method>;

	for (const name of BACKING_METHODS) {
		const original = backing[name].bind(backing);

		backing[name] = (res, ...args) => {
			instrumentation.calls[name]++;

			if (instrumentation.failNextCall) {
				instrumentation.failNextCall = false;
				return Promise.reject(new Error('Backing failure'));
			}

			const markProvisional = () => {
				if (instrumentation.markProvisional) {
					res.value.provisional = true;
				}
			};

			if (instrumentation.forceAsync) {
				return (async (): MaybeRelevantPromise => {
					await Promise.resolve();

					const promise = original(res, ...args);
					await promise;
					markProvisional();

					return promise;
				})();
			}

			const promise = original(res, ...args);
			if (res.pending) {
				return promise.then((value) => {
					markProvisional();
					return value;
				});
			}

			markProvisional();
			return promise;
		};
	}

	return instrumentation;
};

const readSequentially = async (reader: PacketReader, start: EncodedPacket, count: number) => {
	let packet: EncodedPacket | null = start;
	for (let i = 0; i < count; i++) {
		packet = await reader.getNext(packet!);
	}

	return packet;
};

const expectPacket = (
	maybePacket: MaybePromise<EncodedPacket | null | undefined>,
	packets: PacketSpec[],
	index: number | null,
	type?: PacketType,
) => {
	expect(isThenable(maybePacket)).toBe(false);
	const packet = maybePacket as EncodedPacket | null | undefined;

	if (index === null) {
		expect(packet).toBe(null);
		return;
	}

	expect(packet).toBeInstanceOf(EncodedPacket);
	expect(packet!.sequenceNumber).toBe(index);
	expect(packet!.timestamp).toBe(packets[index]!.timestamp);
	expect(packet!.type).toBe(type ?? packets[index]!.type);
	if (!packet!.isMetadataOnly) {
		expect(packet!.data[1]).toBe(index);
	}
};

const expectSortedPacketList = (info: ReturnType<PacketCache['_getTrackInfo']>) => {
	for (let i = 1; i < info.packets.length; i++) {
		const a = info.packets[i - 1]!;
		const b = info.packets[i]!;

		expect(
			a.timestamp < b.timestamp
			|| (a.timestamp === b.timestamp && a.sequenceNumber < b.sequenceNumber),
		).toBe(true);
	}
};

const modelKeyAt = (packets: PacketSpec[], timestamp: number, verified = false) => {
	let result = modelAt(packets, timestamp, i => packets[i]!.type === 'key');
	while (verified && result !== null && packets[result]!.actualType === 'delta') {
		result = modelAt(packets, packets[result]!.timestamp - 1e-6, i => packets[i]!.type === 'key');
	}

	return result;
};

const modelAt = (packets: PacketSpec[], timestamp: number, predicate = (_index: number) => true) => {
	let result: number | null = null;
	for (let i = 0; i < packets.length; i++) {
		if (
			packets[i]!.timestamp <= timestamp
			&& predicate(i)
			&& (result === null || packets[i]!.timestamp >= packets[result]!.timestamp)
		) {
			result = i;
		}
	}

	return result;
};

const modelNext = (packets: PacketSpec[], index: number) => {
	return index + 1 < packets.length ? index + 1 : null;
};

const modelNextKey = (packets: PacketSpec[], index: number, verified = false) => {
	for (let i = index + 1; i < packets.length; i++) {
		if (packets[i]!.type === 'key' && (!verified || packets[i]!.actualType !== 'delta')) {
			return i;
		}
	}

	return null;
};
