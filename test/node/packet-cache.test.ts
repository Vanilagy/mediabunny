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
	PACKET_SIZE_OVERHEAD,
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

const PACKET_DATA_SIZE = 8;
const FULL_PACKET_SIZE = PACKET_SIZE_OVERHEAD + PACKET_DATA_SIZE;

const BACKING_METHODS = ['getFirstPacket', 'getPacket', 'getKeyPacket', 'getNextPacket', 'getNextKeyPacket'] as const;
type BackingMethod = typeof BACKING_METHODS[number];

type PacketCacheTrackInfo = ReturnType<PacketCache['_getTrackInfo']>;
type CacheEntry = NonNullable<PacketCache['_lruHead']>;

let mainFile: ArrayBuffer;
let fakeFirstKeyFile: ArrayBuffer;
let emptyFile: ArrayBuffer;

beforeAll(async () => {
	mainFile = await createFile(MAIN_PACKETS);
	fakeFirstKeyFile = await createFile(FAKE_FIRST_KEY_PACKETS);
	emptyFile = await createFile([]);
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

	for (let i = 0; i < ctx.packets.length; i++) {
		expectPacket(ctx.packets[i], MAIN_PACKETS, i);
		expectPacket(await reader.getNext(ctx.packets[i]!), MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
		expectPacket(await reader.getNextKey(ctx.packets[i]!), MAIN_PACKETS, modelNextKey(MAIN_PACKETS, i));
	}
});

test('Sequential reading', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expect(cached.first()).toBe(undefined);

	let packet = await reader.getFirst();
	expectPacket(packet, MAIN_PACKETS, 0);
	expectPacket(cached.first(), MAIN_PACKETS, 0);

	for (let i = 0; i < ctx.packets.length; i++) {
		expect(cached.next(packet!)).toBe(undefined);
		packet = await reader.getNext(packet!);
		expectPacket(packet, MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
		expectPacket(cached.next(ctx.packets[i]!), MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
	}

	expectConsistentCache(ctx.cache);

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

	for (let i = 0; i < ctx.packets.length; i++) {
		expectPacket(cached.nextKey(ctx.packets[i]!), MAIN_PACKETS, modelNextKey(MAIN_PACKETS, i));
	}

	// And the reader no longer needs the backing at all
	const callCount = backing.totalCalls();
	for (const timestamp of QUERY_TIMESTAMPS.filter(x => x >= 2)) {
		expectPacket(await reader.getAt(timestamp), MAIN_PACKETS, modelAt(MAIN_PACKETS, timestamp));
		expectPacket(await reader.getKeyAt(timestamp), MAIN_PACKETS, modelKeyAt(MAIN_PACKETS, timestamp));
	}
	for (let i = 0; i < ctx.packets.length; i++) {
		expectPacket(await reader.getNext(ctx.packets[i]!), MAIN_PACKETS, modelNext(MAIN_PACKETS, i));
		expectPacket(await reader.getNextKey(ctx.packets[i]!), MAIN_PACKETS, modelNextKey(MAIN_PACKETS, i));
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

	expectConsistentCache(ctx.cache);
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
	expect(await readSequentially(ctx3.reader, ctx3.packets[11]!, 2)).toBe(null);
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
	await readSequentially(reader, ctx.packets[4]!, 4);

	expectPacket(cached.at(4.5), MAIN_PACKETS, 5);
	expectPacket(cached.at(7), MAIN_PACKETS, 7);
	expect(cached.at(7.5)).toBe(undefined); // The GOP's minimum timestamp after it is not yet known
	expect(cached.at(3.5)).toBe(undefined);

	// Now the first one. Since the second GOP's minimum timestamp is known, the first GOP can extend up to it
	await readSequentially(reader, (await reader.getFirst())!, 4);
	expectPacket(cached.at(3.5), MAIN_PACKETS, 3);
	expectPacket(cached.at(3.99), MAIN_PACKETS, 3);

	// Reading the third GOP extends the second one up to the third's minimum timestamp
	await readSequentially(reader, ctx.packets[8]!, 3);
	expectPacket(cached.at(7.5), MAIN_PACKETS, 7);
	expectPacket(cached.at(8), MAIN_PACKETS, 9);
	expectPacket(cached.at(8.5), MAIN_PACKETS, 9);
	expect(cached.at(9)).toBe(undefined); // The fourth GOP is only known by its key packet

	expectConsistentCache(ctx.cache);
});

test('Mid-GOP seek joined later', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached } = ctx;

	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	await readSequentially(reader, ctx.packets[5]!, 1);

	// The chain starting at the GOP's key packet joins the existing one, but it doesn't reach the GOP's end yet
	expectPacket(await reader.getKeyAt(6), MAIN_PACKETS, 4);
	expectPacket(await reader.getNext(ctx.packets[4]!), MAIN_PACKETS, 5);
	expect(cached.at(5.5)).toBe(undefined);
	expectPacket(cached.keyAt(6), MAIN_PACKETS, 4);
	expect(cached.keyAt(6.5)).toBe(undefined);

	// Now it does
	await readSequentially(reader, ctx.packets[6]!, 2);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(7), MAIN_PACKETS, 7);
	expectPacket(cached.keyAt(7.9), MAIN_PACKETS, 4);
	expectPacket(cached.nextKey(ctx.packets[5]!), MAIN_PACKETS, 8);

	// The same, but this time the join completes the GOP right away
	using ctx2 = await setup(mainFile);
	expectPacket(await ctx2.reader.getAt(4.5), MAIN_PACKETS, 5);
	await readSequentially(ctx2.reader, ctx2.packets[5]!, 3);
	expect(ctx2.cached.at(5.5)).toBe(undefined);

	expectPacket(await ctx2.reader.getKeyAt(6), MAIN_PACKETS, 4);
	expectPacket(await ctx2.reader.getNext(ctx2.packets[4]!), MAIN_PACKETS, 5);
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
	expect(getCachedSequenceNumbers(info)).toEqual([8, 9]);
	expectPacket(cached.at(8), MAIN_PACKETS, 9);

	// Retrieving the later one again doesn't duplicate it
	expectPacket(await reader.getNext(ctx.packets[8]!), MAIN_PACKETS, 9);
	expect(getCachedSequenceNumbers(info)).toEqual([8, 9]);

	expectPacket(await reader.getAt(9), MAIN_PACKETS, 11);
	expectPacket(await reader.getNext(ctx.packets[9]!), MAIN_PACKETS, 10);
	expectPacket(await reader.getNext(ctx.packets[10]!), MAIN_PACKETS, 11);
	expect(getCachedSequenceNumbers(info)).toEqual([8, 9, 10, 11]);
	expectPacket(cached.at(9), MAIN_PACKETS, 11);

	expectConsistentCache(ctx.cache);
});

test('Key packet sharing its timestamp with the preceding delta packet', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached } = ctx;

	expectPacket(await reader.getKeyAt(8), MAIN_PACKETS, 8);
	await readSequentially(reader, ctx.packets[8]!, 2);

	// The next key packet may still lie at 9, so key packet seeking can only go right up to it
	expectPacket(cached.keyAt(8.99), MAIN_PACKETS, 8);
	expect(cached.keyAt(9)).toBe(undefined);
	expectPacket(await reader.getKeyAt(9), MAIN_PACKETS, 11);

	using ctx2 = await setup(mainFile);
	expectPacket(await ctx2.reader.getKeyAt(8), MAIN_PACKETS, 8);
	await readSequentially(ctx2.reader, ctx2.packets[8]!, 3);
	expectPacket(ctx2.cached.keyAt(8.99), MAIN_PACKETS, 8);
	expect(ctx2.cached.keyAt(9)).toBe(undefined); // The key packet at 9 has no validity of its own yet

	await readSequentially(ctx2.reader, ctx2.packets[11]!, 1);
	expectPacket(ctx2.cached.keyAt(9), MAIN_PACKETS, 11);
	expectPacket(ctx2.cached.keyAt(9.99), MAIN_PACKETS, 11);
});

test('Next key packets', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expectPacket(await reader.getFirst(), MAIN_PACKETS, 0);
	expect(cached.nextKey(ctx.packets[0]!)).toBe(undefined);
	expectPacket(await reader.getNextKey(ctx.packets[0]!), MAIN_PACKETS, 4);
	expectPacket(cached.nextKey(ctx.packets[0]!), MAIN_PACKETS, 4);
	expectPacket(await reader.getNextKey(ctx.packets[0]!), MAIN_PACKETS, 4);
	expect(backing.calls.getNextKeyPacket).toBe(1);

	// Knowing the next key packet after a key packet bounds key packet seeking
	expectPacket(cached.keyAt(5.9), MAIN_PACKETS, 0);
	expect(cached.keyAt(6)).toBe(undefined); // The next key packet has no validity of its own yet

	// Not so for packets whose GOP is unknown
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expectPacket(await reader.getNextKey(ctx.packets[6]!), MAIN_PACKETS, 8);
	expectPacket(cached.nextKey(ctx.packets[6]!), MAIN_PACKETS, 8);
	expect(cached.keyAt(7.9)).toBe(undefined);

	// But for packets whose GOP is known
	expectPacket(await reader.getKeyAt(8), MAIN_PACKETS, 8);
	await readSequentially(reader, ctx.packets[8]!, 1);
	expect(cached.keyAt(8.99)).toBe(undefined);
	expectPacket(await reader.getNextKey(ctx.packets[9]!), MAIN_PACKETS, 11);
	expectPacket(cached.keyAt(8.99), MAIN_PACKETS, 8);

	// There's no key packet after the last one, so it's valid indefinitely
	expectPacket(await reader.getKeyAt(9.5), MAIN_PACKETS, 11);
	expect(await reader.getNextKey(ctx.packets[11]!)).toBe(null);
	expect(cached.nextKey(ctx.packets[11]!)).toBe(null);
	expectPacket(cached.keyAt(1000), MAIN_PACKETS, 11);
	expectPacket(await reader.getAt(10), MAIN_PACKETS, 12);
	expect(await reader.getNextKey(ctx.packets[12]!)).toBe(null);
	expect(cached.nextKey(ctx.packets[12]!)).toBe(null);
});

test('Uncached anchor packets', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, info } = ctx;

	// The packets handed to next() and nextKey() only serve as anchors. If they aren't cached, no link is made, but the
	// returned packets are still remembered.
	expectPacket(await reader.getNext(ctx.packets[5]!), MAIN_PACKETS, 6);
	expect(cached.next(ctx.packets[5]!)).toBe(undefined);
	expectPacket(await reader.getNextKey(ctx.packets[5]!), MAIN_PACKETS, 8);
	expect(cached.nextKey(ctx.packets[5]!)).toBe(undefined);
	expect(getCachedSequenceNumbers(info)).toEqual([6, 8]);
	for (const entry of info.sortedEntries) {
		expect(entry.next).toBe(undefined);
		expect(entry.prev).toBe(undefined);
		expect(entry.nextKey).toBe(undefined);
	}

	// Once the anchor is cached, links are made, pointing to the cache's own instances
	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	expectPacket(await reader.getNext(ctx.packets[5]!), MAIN_PACKETS, 6);
	expectPacket(cached.next(ctx.packets[5]!), MAIN_PACKETS, 6);
	expect(info.entries.get(6)!.prev).toBe(info.entries.get(5));
	expect(info.entries.get(5)!.packet).not.toBe(ctx.packets[5]);

	expectConsistentCache(ctx.cache);
});

test('Next key packets from the next() chain', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;

	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	await readSequentially(reader, ctx.packets[5]!, 2);
	expect(cached.nextKey(ctx.packets[5]!)).toBe(undefined); // Chain incomplete

	await readSequentially(reader, ctx.packets[7]!, 1);
	expectPacket(cached.nextKey(ctx.packets[5]!), MAIN_PACKETS, 8);
	expectPacket(await reader.getNextKey(ctx.packets[5]!), MAIN_PACKETS, 8);
	expect(backing.calls.getNextKeyPacket).toBe(0);

	expectPacket(await reader.getAt(10), MAIN_PACKETS, 12);
	await readSequentially(reader, ctx.packets[12]!, 1);
	expect(cached.nextKey(ctx.packets[12]!)).toBe(null);
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
	const storedPacket = info.sortedEntries[0]!.packet!;
	expect(storedPacket).not.toBe(metadataPacket);

	const fullPacket = await reader.getAt(5.5);
	expectPacket(fullPacket, MAIN_PACKETS, 6);
	expect(fullPacket!.isMetadataOnly).toBe(false);
	expect(info.sortedEntries[0]!.packet).toBe(storedPacket);
	expect(storedPacket.isMetadataOnly).toBe(false);
	expect(metadataPacket!.isMetadataOnly).toBe(true);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expect((cached.at(5.5, metadataOnly) as EncodedPacket).isMetadataOnly).toBe(true);

	// A full packet is never downgraded
	expectPacket(await reader.getAt(5.7, metadataOnly), MAIN_PACKETS, 6);
	expect(info.sortedEntries[0]!.packet!.isMetadataOnly).toBe(false);

	// The upgrade is seen by everything referencing the packet
	expectPacket(await reader.getFirst(metadataOnly), MAIN_PACKETS, 0);
	expectPacket(await reader.getNext(ctx.packets[0]!, metadataOnly), MAIN_PACKETS, 1);
	expectPacket(await reader.getAt(3, metadataOnly), MAIN_PACKETS, 3);
	expectPacket(await reader.getNextKey(ctx.packets[3]!, metadataOnly), MAIN_PACKETS, 4);
	expect(cached.first()).toBe(undefined);
	expect(cached.next(ctx.packets[0]!)).toBe(undefined);
	expect(cached.nextKey(ctx.packets[3]!)).toBe(undefined);

	expectPacket(await reader.getAt(2), MAIN_PACKETS, 0);
	expectPacket(await reader.getAt(0), MAIN_PACKETS, 1);
	expectPacket(await reader.getAt(6), MAIN_PACKETS, 4);
	expectPacket(cached.first(), MAIN_PACKETS, 0);
	expectPacket(cached.next(ctx.packets[0]!), MAIN_PACKETS, 1);
	expectPacket(cached.nextKey(ctx.packets[3]!), MAIN_PACKETS, 4);
	expect((cached.first() as EncodedPacket).isMetadataOnly).toBe(false);

	// A chain learned without data, then traversed with data
	expectPacket(await reader.getNext(ctx.packets[4]!, metadataOnly), MAIN_PACKETS, 5);
	expectPacket(await reader.getNext(ctx.packets[4]!), MAIN_PACKETS, 5);

	expectConsistentCache(ctx.cache);
});

test('Fresh packet instances', async () => {
	using ctx = await setup(mainFile);
	const { reader, info } = ctx;

	const a = (await reader.getAt(5.5))!;
	const b = (await reader.getAt(5.5))!;
	const c = (await reader.getAt(5.5))!;
	expect(a).not.toBe(b);
	expect(b).not.toBe(c);
	expect(b).not.toBe(info.sortedEntries[0]!.packet);
	expect(c).not.toBe(info.sortedEntries[0]!.packet);
	expect(b.data).toBe(c.data);
});

test('Key packet verification', async () => {
	using ctx = await setup(mainFile);
	const { reader, cached, backing } = ctx;
	const verify = { verifyKeyPackets: true };

	expectPacket(await reader.getFirst(verify), MAIN_PACKETS, 0);
	expectPacket(cached.first(verify), MAIN_PACKETS, 0);

	expectPacket(await reader.getAt(3), MAIN_PACKETS, 3);
	expectPacket(await reader.getNext(ctx.packets[3]!, verify), MAIN_PACKETS, 4);
	expectPacket(cached.next(ctx.packets[3]!, verify), MAIN_PACKETS, 4);

	// The fake key packet comes back as what it actually is when verifying, and as what the container says otherwise
	expectPacket(await reader.getAt(7), MAIN_PACKETS, 7);
	expectPacket(await reader.getNext(ctx.packets[7]!, verify), MAIN_PACKETS, 8, 'delta');
	expectPacket(cached.next(ctx.packets[7]!, verify), MAIN_PACKETS, 8, 'delta');
	expectPacket(cached.next(ctx.packets[7]!), MAIN_PACKETS, 8, 'key');
	expectPacket(await reader.getNext(ctx.packets[7]!), MAIN_PACKETS, 8, 'key');

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
	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	expectPacket(await reader.getNextKey(ctx.packets[5]!, verify), MAIN_PACKETS, 11);
	expectPacket(cached.nextKey(ctx.packets[5]!, verify), MAIN_PACKETS, 8, 'delta');
	const nextKeyCallCount = backing.totalCalls();
	expectPacket(await reader.getNextKey(ctx.packets[5]!, verify), MAIN_PACKETS, 11);
	expectPacket(await reader.getNextKey(ctx.packets[5]!), MAIN_PACKETS, 8);
	expect(backing.totalCalls()).toBe(nextKeyCallCount);
	expectPacket(await reader.getNextKey(ctx.packets[11]!, verify), MAIN_PACKETS, null);
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
	expectPacket(await reader.getAt(4.5), MAIN_PACKETS, 5);
	expectPacket(await reader.getNextKey(ctx.packets[5]!), MAIN_PACKETS, 8);
	expectPacket(await reader.getNextKey(ctx.packets[5]!, verify), MAIN_PACKETS, 11);
	expectPacket(cached.nextKey(ctx.packets[8]!, verify), MAIN_PACKETS, 11);

	// The reader itself also verifies cached packets on demand
	expectPacket(await reader.getKeyAt(2.5), MAIN_PACKETS, 0);
	expectPacket(await reader.getKeyAt(2.5, verify), MAIN_PACKETS, 0);

	using ctx2 = await setup(mainFile);
	expectPacket(await ctx2.reader.getFirst(), MAIN_PACKETS, 0);
	expectPacket(await ctx2.reader.getNextKey(ctx2.packets[0]!), MAIN_PACKETS, 4);
	expectPacket(await ctx2.reader.getNextKey(ctx2.packets[0]!, verify), MAIN_PACKETS, 4);
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
	expect(ctx.packets).toHaveLength(FAKE_FIRST_KEY_PACKETS.length);
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
	expectPacket(await reader.getNext(ctx.packets[2]!, metadataOnly), FAKE_FIRST_KEY_PACKETS, 3);
	expect(await reader.getNext(ctx.packets[3]!, metadataOnly)).toBe(null);

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
	expectPacket(await reader.getNext(ctx.packets[0]!), MAIN_PACKETS, 1);
	expectPacket(await reader.getNextKey(ctx.packets[0]!), MAIN_PACKETS, 4);
	expectPacket(await reader.getFirst({ verifyKeyPackets: true }), MAIN_PACKETS, 0);
	expectPacket(await reader.getKeyAt(8.5, { verifyKeyPackets: true }), MAIN_PACKETS, 4);
	expectPacket(await reader.getNextKey(ctx.packets[5]!, { verifyKeyPackets: true }), MAIN_PACKETS, 11);
	expect(await reader.getAt(-1)).toBe(null);

	expect(cached.first()).toBe(undefined);
	expect(cached.at(5.5)).toBe(undefined);
	expect(cached.keyAt(5.5)).toBe(undefined);
	expect(cached.next(ctx.packets[0]!)).toBe(undefined);
	expect(cached.nextKey(ctx.packets[0]!)).toBe(undefined);
	expect(cached.at(-1)).toBe(undefined);
	expect(info.sortedEntries).toHaveLength(0);

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

	// Make the anchors known first
	expectPacket(await reader.getAt(7), MAIN_PACKETS, 7);
	expectPacket(await reader.getAt(8), MAIN_PACKETS, 9);

	const nexts = await Promise.all([reader.getNext(ctx.packets[7]!), reader.getNext(ctx.packets[7]!)]);
	expectPacket(nexts[0], MAIN_PACKETS, 8);
	expectPacket(nexts[1], MAIN_PACKETS, 8);
	expect(backing.calls.getNextPacket).toBe(1);

	const nextKeys = await Promise.all([reader.getNextKey(ctx.packets[9]!), reader.getNextKey(ctx.packets[9]!)]);
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
	expect(backing.calls.getPacket).toBe(6);

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
	const nexts = await Promise.allSettled([reader.getNext(ctx.packets[1]!), reader.getNext(ctx.packets[1]!)]);
	expect(nexts[0].status).toBe('rejected');
	expect(nexts[1].status).toBe('fulfilled');

	backing.failNextCall = true;
	const nextKeys = await Promise.allSettled([
		reader.getNextKey(ctx.packets[1]!),
		reader.getNextKey(ctx.packets[1]!),
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

test('Cache size', async () => {
	using ctx = await setup(mainFile);
	const { reader, cache } = ctx;

	expect(cache._cacheSize).toBe(0);

	// A packet takes up a fixed overhead plus its data
	expectPacket(await reader.getAt(5.5, { metadataOnly: true }), MAIN_PACKETS, 6);
	expect(cache._cacheSize).toBe(PACKET_SIZE_OVERHEAD);
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expect(cache._cacheSize).toBe(FULL_PACKET_SIZE);

	await readSequentially(reader, (await reader.getFirst())!, MAIN_PACKETS.length);
	expect(cache._cacheSize).toBe(MAIN_PACKETS.length * FULL_PACKET_SIZE);

	// Alpha data counts too. The synthetic files have none, so let's hand it to the cache directly.
	using ctx2 = await setup(mainFile);
	const alphaPacket = ctx.packets[6]!.clone({ sideData: { alpha: new Uint8Array(100) } });
	ctx2.cache._insertAt(ctx2.info, 5.5, alphaPacket, undefined);
	expect(ctx2.cache._cacheSize).toBe(FULL_PACKET_SIZE + 100);

	expectConsistentCache(cache);
	expectConsistentCache(ctx2.cache);
});

test('Least recently used packets get evicted', async () => {
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: 3 * FULL_PACKET_SIZE }));
	const { reader, cache, cached, backing } = ctx;

	expectPacket(await reader.getAt(2.5), MAIN_PACKETS, 0);
	expectPacket(await reader.getAt(0.5), MAIN_PACKETS, 1);
	expectPacket(await reader.getAt(1.5), MAIN_PACKETS, 2);
	expect(getLruOrder(cache)).toEqual([2, 1, 0]);

	// Returning a packet makes it the most recently used one, no matter if it comes from the cache or the backing
	expectPacket(await reader.getAt(2.5), MAIN_PACKETS, 0);
	expect(backing.calls.getPacket).toBe(3);
	expect(getLruOrder(cache)).toEqual([0, 2, 1]);

	// Exceeding the maximum size by more than 10% evicts packets until the cache is down to 90% of it
	expectPacket(await reader.getAt(3.5), MAIN_PACKETS, 3);
	expect(getLruOrder(cache)).toEqual([3, 0]);
	expect(cached.at(0.5)).toBe(undefined);
	expect(cached.at(1.5)).toBe(undefined);
	expectPacket(cached.at(2.5), MAIN_PACKETS, 0);
	expect(getLruOrder(cache)).toEqual([0, 3]);

	// Metadata-only retrievals count too
	expectPacket(cached.at(3.5, { metadataOnly: true }), MAIN_PACKETS, 3);
	expect(getLruOrder(cache)).toEqual([3, 0]);

	// Requests the cache can't satisfy don't
	expectPacket(await reader.getAt(5.5, { metadataOnly: true }), MAIN_PACKETS, 6);
	expect(getLruOrder(cache)).toEqual([6, 3, 0]);
	expect(cached.at(5.5)).toBe(undefined);
	expect(getLruOrder(cache)).toEqual([6, 3, 0]);

	expectConsistentCache(cache);
	expect(cache._cacheSize).toBeLessThanOrEqual(3 * FULL_PACKET_SIZE);
});

test('Batched eviction', async () => {
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: 10 * FULL_PACKET_SIZE }));
	const { reader, cache } = ctx;

	// Up to 10% above the maximum size is tolerated
	await readSequentially(reader, (await reader.getFirst())!, 10);
	expect(cache._cacheSize).toBe(11 * FULL_PACKET_SIZE);

	// Beyond that, the cache gets brought down to 90% of it in one go
	await readSequentially(reader, ctx.packets[10]!, 1);
	expect(getLruOrder(cache)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3]);
	expect(cache._cacheSize).toBe(9 * FULL_PACKET_SIZE);
	expectConsistentCache(cache);

	// Explicit eviction behaves the same
	using ctx2 = await setup(mainFile, new PacketCache({ maxCacheSize: 10 * FULL_PACKET_SIZE, autoEvict: false }));
	await readSequentially(ctx2.reader, (await ctx2.reader.getFirst())!, 10);
	ctx2.cache.evict();
	expect(ctx2.cache._cacheSize).toBe(11 * FULL_PACKET_SIZE);

	await readSequentially(ctx2.reader, ctx2.packets[10]!, 1);
	ctx2.cache.evict();
	expect(getLruOrder(ctx2.cache)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3]);
	expectConsistentCache(ctx2.cache);
});

test('Eviction within a complete GOP', async () => {
	// 90% of the maximum size leaves room for exactly four packets
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: 4.5 * FULL_PACKET_SIZE, autoEvict: false }));
	const { reader, cache, cached } = ctx;

	expectPacket(await reader.getKeyAt(6), MAIN_PACKETS, 4);
	await readSequentially(reader, ctx.packets[4]!, 4);
	expect(cache._cacheSize).toBe(5 * FULL_PACKET_SIZE); // No automatic eviction

	// Use everything but the packet at 5
	expectPacket(cached.at(4.5), MAIN_PACKETS, 5);
	expectPacket(cached.at(6.5), MAIN_PACKETS, 4);
	expectPacket(cached.at(7), MAIN_PACKETS, 7);
	expectPacket(cached.next(ctx.packets[7]!), MAIN_PACKETS, 8);
	expect(getLruOrder(cache).at(-1)).toBe(6);

	cache.evict();
	expect(getLruOrder(cache)).toEqual([8, 7, 4, 5]);
	expectConsistentCache(cache);

	// Lookups that would've landed on the evicted packet now land on the one before it, which must not answer them
	expectPacket(cached.at(4.99), MAIN_PACKETS, 5);
	expect(cached.at(5)).toBe(undefined);
	expect(cached.at(5.5)).toBe(undefined);
	expectPacket(cached.at(6), MAIN_PACKETS, 4);
	expect(cached.next(ctx.packets[5]!)).toBe(undefined);
	expect(cached.next(ctx.packets[6]!)).toBe(undefined);

	// Which is, of course, still answered correctly
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);

	// Key packet seeking isn't affected by evicting delta packets
	expectPacket(cached.keyAt(7.99), MAIN_PACKETS, 4);
});

test('Eviction of key packets', async () => {
	// 90% of the maximum size leaves room for exactly three packets
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: 3.5 * FULL_PACKET_SIZE, autoEvict: false }));
	const { reader, cache, cached } = ctx;

	expectPacket(await reader.getKeyAt(6), MAIN_PACKETS, 4);
	await readSequentially(reader, ctx.packets[4]!, 4);
	expectPacket(cached.keyAt(7.99), MAIN_PACKETS, 4);

	// Evict the key packet, leaving the packets of its GOP behind
	expectPacket(cached.at(4.5), MAIN_PACKETS, 5);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expectPacket(cached.at(7), MAIN_PACKETS, 7);
	cache.evict();
	expect(getLruOrder(cache)).toEqual([7, 6, 5]);
	expectConsistentCache(cache);

	expect(cached.keyAt(7.99)).toBe(undefined);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);

	// The GOP's key packet isn't known anymore, so continuing the chain teaches us nothing about it
	expectPacket(await reader.getNext(ctx.packets[7]!), MAIN_PACKETS, 8);
	expectPacket(await reader.getNextKey(ctx.packets[6]!), MAIN_PACKETS, 8);
	expect(cached.keyAt(7.99)).toBe(undefined);
	expectConsistentCache(cache);

	cache.evict();
	expect(getLruOrder(cache)).toEqual([8, 6, 7]);
	expectConsistentCache(cache);

	// A next key packet that's linked to directly can be evicted too
	using ctx2 = await setup(mainFile, new PacketCache({ maxCacheSize: 1.5 * FULL_PACKET_SIZE, autoEvict: false }));
	expectPacket(await ctx2.reader.getAt(4.5), MAIN_PACKETS, 5);
	expectPacket(await ctx2.reader.getNextKey(ctx2.packets[5]!), MAIN_PACKETS, 8);
	expectPacket(ctx2.cached.nextKey(ctx2.packets[5]!), MAIN_PACKETS, 8);
	expectPacket(ctx2.cached.at(4.5), MAIN_PACKETS, 5);

	ctx2.cache.evict();
	expect(getLruOrder(ctx2.cache)).toEqual([5]);
	expect(ctx2.cached.nextKey(ctx2.packets[5]!)).toBe(undefined);
	expectPacket(await ctx2.reader.getNextKey(ctx2.packets[5]!), MAIN_PACKETS, 8);
	expectConsistentCache(ctx2.cache);
});

test('Evicted anchor packets', async () => {
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: 0, autoEvict: false }));
	const { reader, cache, info } = ctx;

	const first = (await reader.getFirst())!;
	cache.evict();
	expect(info.sortedEntries).toHaveLength(0);
	expect(info.first).toBe(undefined);

	expectPacket(await reader.getNext(first), MAIN_PACKETS, 1);
	expect(getCachedSequenceNumbers(info)).toEqual([1]);
	expect(info.entries.get(1)!.next).toBe(undefined);
	expect(info.entries.get(1)!.prev).toBe(undefined);
	expectConsistentCache(cache);
});

test('Eviction while verifying a key packet', async () => {
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: 0, autoEvict: false }));
	const { reader, cache, cached, info } = ctx;

	expectPacket(await reader.getKeyAt(6.5), MAIN_PACKETS, 4);
	const entry = info.entries.get(4)!;
	const verified = cached.keyAt(6.5, { verifyKeyPackets: true });
	expect(verified).toBeInstanceOf(Promise);
	cache.evict();

	expectPacket(await verified, MAIN_PACKETS, 4);
	expect(entry.packet).toBe(null);
	expect(entry.determinedType).toBe(undefined);
	expectConsistentCache(cache);
});

test('Results stay correct under eviction', async () => {
	for (const maxCacheSize of [0, FULL_PACKET_SIZE, 3 * FULL_PACKET_SIZE, 6 * FULL_PACKET_SIZE, Infinity]) {
		using ctx = await setup(mainFile, new PacketCache({ maxCacheSize }));
		const { reader, cache } = ctx;
		const random = createRandom(1234);
		const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;

		const anchors: EncodedPacket[] = [];

		for (let i = 0; i < 500; i++) {
			const options = pick<PacketRetrievalOptions>([{}, { metadataOnly: true }, { verifyKeyPackets: true }]);
			const verified = !!options.verifyKeyPackets;
			const operation = anchors.length === 0 ? 0 : Math.floor(random() * 5);

			let packet: EncodedPacket | null;
			let expectedIndex: number | null;
			let returnsKeyPackets = false;

			if (operation === 0) {
				packet = await reader.getFirst(options);
				expectedIndex = 0;
			} else if (operation === 1) {
				const timestamp = pick(QUERY_TIMESTAMPS);
				packet = await reader.getAt(timestamp, options);
				expectedIndex = modelAt(MAIN_PACKETS, timestamp);
			} else if (operation === 2) {
				const timestamp = pick(QUERY_TIMESTAMPS);
				packet = await reader.getKeyAt(timestamp, options);
				expectedIndex = modelKeyAt(MAIN_PACKETS, timestamp, verified);
				returnsKeyPackets = true;
			} else if (operation === 3) {
				const anchor = pick(anchors);
				packet = await reader.getNext(anchor, options);
				expectedIndex = modelNext(MAIN_PACKETS, anchor.sequenceNumber);
			} else {
				const anchor = pick(anchors);
				packet = await reader.getNextKey(anchor, options);
				expectedIndex = modelNextKey(MAIN_PACKETS, anchor.sequenceNumber, verified);
				returnsKeyPackets = true;
			}

			// Verification may turn key packets into delta packets
			const spec = expectedIndex !== null ? MAIN_PACKETS[expectedIndex]! : null;
			const expectedType = spec && verified && !returnsKeyPackets ? spec.actualType ?? spec.type : undefined;

			expectPacket(packet, MAIN_PACKETS, expectedIndex, expectedType);
			if (packet) {
				expect(packet.isMetadataOnly).toBe(!!options.metadataOnly);
				anchors.push(packet);
			}

			expectConsistentCache(cache);
			expect(cache._cacheSize).toBeLessThanOrEqual(1.1 * maxCacheSize);
		}
	}
});

test('Cache size across tracks', async () => {
	// 90% of the maximum size leaves room for exactly three packets
	const cache = new PacketCache({ maxCacheSize: 3.5 * FULL_PACKET_SIZE });
	using ctx1 = await setup(mainFile, cache);
	using ctx2 = await setup(mainFile, cache);

	expectPacket(await ctx1.reader.getAt(2.5), MAIN_PACKETS, 0);
	expectPacket(await ctx1.reader.getAt(0.5), MAIN_PACKETS, 1);
	expectPacket(await ctx2.reader.getAt(2.5), MAIN_PACKETS, 0);
	expectPacket(await ctx2.reader.getAt(0.5), MAIN_PACKETS, 1);

	expect(getCachedSequenceNumbers(ctx1.info)).toEqual([1]);
	expect(getCachedSequenceNumbers(ctx2.info)).toEqual([1, 0]);
	expectConsistentCache(cache);
});

test('Disabled eviction', async () => {
	using ctx = await setup(mainFile, new PacketCache({ maxCacheSize: Infinity }));
	const { reader, cache } = ctx;

	await readSequentially(reader, (await reader.getFirst())!, MAIN_PACKETS.length);
	expectPacket(await reader.getAt(5.5), MAIN_PACKETS, 6);
	cache.evict();
	expect(ctx.info.sortedEntries).toHaveLength(MAIN_PACKETS.length);

	// No LRU bookkeeping happens at all
	expect(cache._lruHead).toBe(null);
	expect(cache._cacheSize).toBe(0);
	expectConsistentCache(cache);
});

test('Clearing', async () => {
	using ctx = await setup(mainFile);
	const { reader, cache, cached, info, backing } = ctx;

	await readSequentially(reader, (await reader.getFirst())!, MAIN_PACKETS.length);
	expect(await reader.getAt(-1)).toBe(null);
	expectPacket(await reader.getKeyAt(Infinity), MAIN_PACKETS, 11);

	cache.clear();
	expect(info.sortedEntries).toHaveLength(0);
	expect(cache._cacheSize).toBe(0);
	expect(cached.first()).toBe(undefined);
	expect(cached.at(-1)).toBe(undefined);
	expect(cached.keyAt(Infinity)).toBe(undefined);
	expect(cached.next(ctx.packets[0]!)).toBe(undefined);
	expectConsistentCache(cache);

	// Requests that are underway while clearing still end up in the cache
	backing.forceAsync = true;
	const pending = reader.getAt(5.5);
	cache.clear();
	expectPacket(await pending, MAIN_PACKETS, 6);
	expectPacket(cached.at(5.5), MAIN_PACKETS, 6);
	expect(info.pendingAtCalls.size).toBe(0);
	expectConsistentCache(cache);
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

		const data = new Uint8Array(PACKET_DATA_SIZE);
		data[0] = (spec.actualType ?? spec.type) === 'key' ? 0 : 1; // VP8 frame tag
		data[1] = i;

		await source.add(new EncodedPacket(data, spec.type, spec.timestamp, 1));
	}

	await output.finalize();
	return output.target.buffer!;
};

const setup = async (file: ArrayBuffer, cache = new PacketCache()) => {
	const { input, track } = await openFile(file);

	// All of the track's packets, read without any cache involvement, so that tests have packets to hand to getNext
	// & co. This happens before instrumenting, so it doesn't count towards the backing calls.
	const packets: EncodedPacket[] = [];
	const plainReader = new PacketReader(track);
	let packet = await plainReader.getFirst();
	while (packet) {
		packets.push(packet);
		packet = await plainReader.getNext(packet);
	}

	const reader = new PacketReader(track, { cache });
	const info = cache._getTrackInfo(track);
	const backing = instrumentBacking(track);

	return {
		track,
		packets,
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

// Checks the cache's internal invariants
const expectConsistentCache = (cache: PacketCache) => {
	let entryCount = 0;

	for (const info of cache._trackInfos.values()) {
		for (let i = 1; i < info.sortedEntries.length; i++) {
			const a = info.sortedEntries[i - 1]!.packet!;
			const b = info.sortedEntries[i]!.packet!;

			expect(
				a.timestamp < b.timestamp
				|| (a.timestamp === b.timestamp && a.sequenceNumber < b.sequenceNumber),
			).toBe(true);
		}

		const isCached = (entry: CacheEntry) => {
			return entry.packet !== null && info.entries.get(entry.packet.sequenceNumber) === entry;
		};

		// Exactly the entries in the list are cached
		expect(info.entries.size).toBe(info.sortedEntries.length);
		for (const entry of info.sortedEntries) {
			const packet = entry.packet!;
			expect(packet).toBeInstanceOf(EncodedPacket);
			expect(isCached(entry)).toBe(true);
			expect(entry.trackInfo).toBe(info);
			expect(entry.timestamp).toBe(packet.timestamp);
			expect(entry.size).toBe(cache._evictionEnabled
				? PACKET_SIZE_OVERHEAD + packet.data.byteLength + (packet.sideData.alpha?.byteLength ?? 0)
				: 0,
			);

			// Links only ever connect cached entries, and always go both ways
			if (entry.next) {
				expect(isCached(entry.next)).toBe(true);
				expect(entry.next.prev).toBe(entry);
			}
			if (entry.prev) {
				expect(isCached(entry.prev)).toBe(true);
				expect(entry.prev.next).toBe(entry);
			}

			// These may point to evicted entries, which then must be marked as such
			for (const other of [entry.nextKey, entry.gopKey]) {
				if (other) {
					expect(other.packet === null || isCached(other)).toBe(true);
				}
			}
		}
		entryCount += info.entries.size;

		if (info.first) {
			expect(isCached(info.first)).toBe(true);
			expect(info.first.prev).toBe(null);
		}
	}

	// The LRU list contains every cached entry exactly once, and the sizes add up
	let size = 0;
	let count = 0;
	let previous: CacheEntry | null = null;
	for (let entry = cache._lruHead; entry; entry = entry.lruNext) {
		expect(entry.lruPrev).toBe(previous);
		expect(entry.trackInfo.entries.get(entry.packet!.sequenceNumber)).toBe(entry);
		size += entry.size;
		count++;
		previous = entry;
	}
	expect(cache._lruTail).toBe(previous);
	// Without eviction, there's no LRU bookkeeping at all
	expect(count).toBe(cache._evictionEnabled ? entryCount : 0);
	expect(cache._cacheSize).toBe(size);
};

// Sequence numbers of the cached packets, from most to least recently used
const getLruOrder = (cache: PacketCache) => {
	const result: number[] = [];
	for (let entry = cache._lruHead; entry; entry = entry.lruNext) {
		result.push(entry.packet!.sequenceNumber);
	}

	return result;
};

// Sequence numbers of the cached packets, in timestamp order
const getCachedSequenceNumbers = (info: PacketCacheTrackInfo) => {
	return info.sortedEntries.map(x => x.packet!.sequenceNumber);
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

// Deterministic pseudo-random numbers in [0, 1) (mulberry32), so that failures are reproducible
const createRandom = (seed: number) => {
	let state = seed;

	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};
