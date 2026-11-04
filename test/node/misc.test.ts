import { expect, test } from 'vitest';
import { CallSerializer, EventEmitter, setInt64 } from '../../src/misc.js';
import { Bitstream } from '../../shared/bitstream.js';
import { EncodedPacket } from '../../src/packet.js';

test('setInt64 big-endian', () => {
	for (const value of [1, -1, 2 ** 32 + 5, -(2 ** 40) - 3, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
		const actual = new DataView(new ArrayBuffer(8));
		const expected = new DataView(new ArrayBuffer(8));
		setInt64(actual, 0, value, false);
		expected.setBigInt64(0, BigInt(value), false);

		expect(new Uint8Array(actual.buffer)).toEqual(new Uint8Array(expected.buffer));
	}
});

test('Bitstream values of 32 bits and wider', () => {
	const bytes = new Uint8Array(10);
	const writer = new Bitstream(bytes);
	writer.writeBits(4, 0b1010);
	writer.writeBits(32, 0xdeadbeef);
	writer.writeBits(36, 2 ** 35 + 5);

	expect([...bytes.subarray(0, 5)]).toEqual([0xad, 0xea, 0xdb, 0xee, 0xf8]);

	const reader = new Bitstream(bytes);
	expect(reader.readBits(4)).toBe(0b1010);
	expect(reader.readBits(32)).toBe(0xdeadbeef);
	expect(reader.readBits(36)).toBe(2 ** 35 + 5);
});

test('EventEmitter once listener re-registered during emit', () => {
	const emitter = new EventEmitter<{ foo: number }>();
	const received: number[] = [];

	// The cap keeps a broken emit from looping forever
	const listen = () => {
		emitter.on('foo', (value) => {
			received.push(value);
			if (received.length < 10) {
				listen();
			}
		}, { once: true });
	};
	listen();

	emitter._emit('foo', 1);
	emitter._emit('foo', 2);
	expect(received).toEqual([1, 2]);
});

test('EventEmitter once listener with re-entrant emit', () => {
	const emitter = new EventEmitter<{ foo: void }>();
	let calls = 0;

	emitter.on('foo', () => {
		calls++;
		if (calls < 10) {
			emitter._emit('foo');
		}
	}, { once: true });

	emitter._emit('foo');
	expect(calls).toBe(1);
});

test('EventEmitter listener removed during emit', () => {
	const emitter = new EventEmitter<{ foo: void }>();
	let calls = 0;

	emitter.on('foo', () => removeSecond());
	const removeSecond = emitter.on('foo', () => calls++);

	emitter._emit('foo');
	expect(calls).toBe(0);
});

test('CallSerializer call after a failed call', async () => {
	const serializer = new CallSerializer();
	const calls: number[] = [];

	const first = serializer.call(async () => {
		calls.push(1);
		throw new Error('First failed');
	});
	const second = serializer.call(() => {
		calls.push(2);
	});

	await expect(first).rejects.toThrow('First failed');
	await expect(second).resolves.toBeUndefined();
	expect(calls).toEqual([1, 2]);
});

test('Packet clone with different-size data', () => {
	const packet = new EncodedPacket(new Uint8Array(10), 'key', 0, 1);
	const clone = packet.clone({ data: new Uint8Array(5) });

	expect(clone.byteLength).toBe(5);
});
