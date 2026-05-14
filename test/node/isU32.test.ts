import { describe, it, expect } from 'vitest';
import { isU32 } from '../../src/misc';

describe('isU32() function', () => {
	it('should return true for valid unsigned 32-bit integers', () => {
		expect(isU32(0)).toBe(true);
		expect(isU32(1)).toBe(true);
		expect(isU32(2147483647)).toBe(true); // 2^31 - 1
		expect(isU32(2147483648)).toBe(true); // 2^31
		expect(isU32(4294967295)).toBe(true); // 2^32 - 1
	});

	it('should return false for negative numbers', () => {
		expect(isU32(-1)).toBe(false);
		expect(isU32(-100)).toBe(false);
	});

	it('should return false for numbers >= 2^32', () => {
		// Bug: The function checks `value < 2 ** 32` but should check `value <= 2 ** 32 - 1`
		// or equivalently `value < 2 ** 32` is correct, but we need to ensure it's an integer
		expect(isU32(4294967296)).toBe(false); // 2^32 exactly
		expect(isU32(4294967297)).toBe(false); // 2^32 + 1
	});

	it('should handle floating point numbers', () => {
		// The function should reject non-integer values
		expect(isU32(1.5)).toBe(false);
		expect(isU32(100.7)).toBe(false);
		expect(isU32(0.1)).toBe(false);
	});

	it('should handle edge case of exactly 2^32', () => {
		expect(isU32(4294967296)).toBe(false);
	});
});
