import { expect, test } from 'vitest';
import { joinPaths } from '../../src/misc.js';

test('joinPaths handles all path combinations correctly', () => {
	// Simple relative paths
	expect(joinPaths('path/to/entry.m3u8', 'other.m3u8')).toBe('path/to/other.m3u8');
	expect(joinPaths('entry.m3u8', 'other.m3u8')).toBe('other.m3u8');
	expect(joinPaths('/path/to/entry.m3u8', 'other.m3u8')).toBe('/path/to/other.m3u8');

	// Absolute relative paths (starting with /)
	expect(joinPaths('path/to/entry.m3u8', '/other.m3u8')).toBe('/other.m3u8');
	expect(joinPaths('/path/to/entry.m3u8', '/other.m3u8')).toBe('/other.m3u8');

	// With protocols
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', '/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', 'other.m3u8')).toBe('file:///path/to/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', '/other.m3u8')).toBe('file:///other.m3u8');

	// With ./
	expect(joinPaths('path/to/entry.m3u8', './other.m3u8')).toBe('path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', './other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');

	// With ../
	expect(joinPaths('path/to/entry.m3u8', '../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('path/to/deep/entry.m3u8', '../../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', '../other.m3u8'))
		.toBe('https://example.com/path/other.m3u8');
	expect(joinPaths('https://example.com/a/b/c/entry.m3u8', '../../other.m3u8'))
		.toBe('https://example.com/a/other.m3u8');

	// Mixed ./ and ../
	expect(joinPaths('path/to/entry.m3u8', './../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('path/to/entry.m3u8', '../foo/../other.m3u8')).toBe('path/other.m3u8');

	// Second argument is a full URL with protocol
	expect(joinPaths('path/to/entry.m3u8', 'https://example.com/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'https://other.com/other.m3u8'))
		.toBe('https://other.com/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', 'https://example.com/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
});
