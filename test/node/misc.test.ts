import { expect, test } from 'vitest';
import { CallSerializer, EventEmitter, getQueryParameter, parseIsoSuffix, setInt64 } from '../../src/misc.js';
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
	const packet = new EncodedPacket({
		data: new Uint8Array(10),
		type: 'key',
		timestamp: 0,
		duration: 1,
	});
	const clone = packet.clone({ data: new Uint8Array(5) });

	expect(clone.byteLength).toBe(5);
});

test('Packet init object', () => {
	const data = new Uint8Array(10);
	const sideData = { alpha: new Uint8Array(3) };
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const positional = new EncodedPacket(data, 'delta', 1, 2, 3, 10, sideData);
	const fromInit = new EncodedPacket({
		data,
		type: 'delta',
		timestamp: 1,
		duration: 2,
		sequenceNumber: 3,
		byteLength: 10,
		sideData,
	});
	expect(fromInit).toEqual(positional);

	// Defaults
	const minimal = new EncodedPacket({
		data,
		type: 'key',
		timestamp: 0,
		duration: 0,
	});
	expect(minimal.sequenceNumber).toBe(-1);
	expect(minimal.byteLength).toBe(10);
	expect(minimal.sideData).toEqual({});
	expect(minimal.decoderConfig).toBe(null);

	// Invalid input
	expect(() => new EncodedPacket(null as never)).toThrow('init must be an object.');
	expect(() => new EncodedPacket({
		data: [] as never,
		type: 'key',
		timestamp: 0,
		duration: 0,
	})).toThrow('data must be a Uint8Array.');
	expect(() => new EncodedPacket({
		data,
		type: 'key',
		timestamp: 0,
		duration: -1,
	})).toThrow('duration must be a non-negative number.');
});

test('Packet decoder config', () => {
	const videoConfig = {
		type: 'video' as const,
		codec: 'vp8',
	};
	const audioConfig = {
		type: 'audio' as const,
		codec: 'opus',
		sampleRate: 48000,
		numberOfChannels: 2,
	};
	const createPacket = (decoderConfig: unknown) => new EncodedPacket({
		data: new Uint8Array(1),
		type: 'key',
		timestamp: 0,
		duration: 0,
		decoderConfig: decoderConfig as never,
	});

	const packet = createPacket(videoConfig);
	expect(packet.decoderConfig).toBe(videoConfig);
	expect(createPacket(audioConfig).decoderConfig).toBe(audioConfig);

	// Configs are validated
	expect(() => createPacket(5)).toThrow('decoderConfig, when provided, must be an object.');
	expect(() => createPacket({ codec: 'vp8' })).toThrow('decoderConfig.type must be \'video\' or \'audio\'.');
	expect(() => createPacket({
		type: 'video',
		codec: 'opus',
	})).toThrow('decoderConfig codec string must be a valid video codec string');
	expect(() => createPacket({
		type: 'audio',
		codec: 'opus',
		sampleRate: 48000,
	})).toThrow('decoderConfig must specify a valid numberOfChannels (positive integer).');

	// But only the first time a config is seen
	const mutatedConfig = { ...videoConfig };
	createPacket(mutatedConfig);
	mutatedConfig.codec = 'opus';
	expect(() => createPacket(mutatedConfig)).not.toThrow();

	// Clones keep the config unless it's overridden or removed
	expect(packet.clone().decoderConfig).toBe(videoConfig);
	expect(packet.clone({ decoderConfig: audioConfig }).decoderConfig).toBe(audioConfig);
	expect(packet.clone({ decoderConfig: null }).decoderConfig).toBe(null);
	expect(() => packet.clone({ decoderConfig: { codec: 'vp8' } as never })).toThrow('decoderConfig.type');
});

test('ISO date parsing', () => {
	// Every suffix of the full format, which is UTC unless it states a time zone
	expect(parseIsoSuffix('2013')?.toISOString()).toBe('2013-01-01T00:00:00.000Z');
	expect(parseIsoSuffix('2013-05')?.toISOString()).toBe('2013-05-01T00:00:00.000Z');
	expect(parseIsoSuffix('2013-05-03')?.toISOString()).toBe('2013-05-03T00:00:00.000Z');
	expect(parseIsoSuffix('2013-05-03T07')?.toISOString()).toBe('2013-05-03T07:00:00.000Z');
	expect(parseIsoSuffix('2013-05-03 07:08')?.toISOString()).toBe('2013-05-03T07:08:00.000Z');
	expect(parseIsoSuffix('2013-05-03T07:08:09Z')?.toISOString()).toBe('2013-05-03T07:08:09.000Z');
	expect(parseIsoSuffix('2013-05-03T07:08:09.5+02:00')?.toISOString()).toBe('2013-05-03T05:08:09.500Z');
	expect(parseIsoSuffix('2013-05-03T07:08:09-0530')?.toISOString()).toBe('2013-05-03T12:38:09.000Z');
	expect(parseIsoSuffix('0012')?.toISOString()).toBe('0012-01-01T00:00:00.000Z');

	// Things the engine's legacy parsing would otherwise make something of
	expect(parseIsoSuffix('2013-02-31')).toBe(null);
	expect(parseIsoSuffix('12')).toBe(null);
	expect(parseIsoSuffix('2013/05/03')).toBe(null);
	expect(parseIsoSuffix('May 3 2013')).toBe(null);
});

test('Query parameters', () => {
	expect(getQueryParameter('/media.m3u8?token=abc%20123', 'token')).toBe('abc 123');
	expect(getQueryParameter('/media.m3u8?a=1&token=x', 'token')).toBe('x');
	expect(getQueryParameter('/media.m3u8?a=1', 'token')).toBe(null);

	// Decoded like URLSearchParams does it, where + is a space
	expect(getQueryParameter('/media.m3u8?token=abc+123', 'token')).toBe('abc 123');

	// A ? in the fragment doesn't start a query
	expect(getQueryParameter('/media.m3u8#x?token=1', 'token')).toBe(null);
	expect(getQueryParameter('/media.m3u8?token=1#x', 'token')).toBe('1');
});
