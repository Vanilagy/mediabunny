import { expect, test } from 'vitest';
import { ForgivingCallSerializer } from '../../src/misc.js';

const executeDelayed = async <T>(fn: () => T) => {
	await new Promise(resolve => setTimeout(resolve, 10));
	return fn();
};

test('Call serialization and return values', async () => {
	const numbers: number[] = [];
	const serializer = new ForgivingCallSerializer();

	const first = serializer.call(() => numbers.push(1));
	const second = serializer.call(() => executeDelayed(() => numbers.push(2)));
	const third = serializer.call(() => numbers.push(3));
	const fourth = serializer.call(() => executeDelayed(() => numbers.push(4)));

	await fourth;

	expect(numbers).toEqual([1, 2, 3, 4]);
	expect(await first).toBe(1);
	expect(await second).toBe(2);
	expect(await third).toBe(3);
	expect(await fourth).toBe(4);
});

test('Synchronous return value', async () => {
	const serializer = new ForgivingCallSerializer();

	const first = serializer.call(() => {});
	expect(first).not.toBeInstanceOf(Promise);

	const second = serializer.call(async () => {});
	const third = serializer.call(() => {});
	expect(second).toBeInstanceOf(Promise);
	expect(third).toBeInstanceOf(Promise);

	await third;

	const fourth = serializer.call(() => {});
	expect(fourth).not.toBeInstanceOf(Promise);
});

test('Error handling', async () => {
	const serializer = new ForgivingCallSerializer();

	expect(() => serializer.call(() => {
		throw new Error('yo');
	})).toThrow();

	const second = serializer.call(() => executeDelayed(() => {
		throw new Error('yo');
	}));
	const third = serializer.call(() => executeDelayed(() => 1 + 2));

	await expect(second).rejects.toThrow();
	expect(await third).toBe(3);
});
