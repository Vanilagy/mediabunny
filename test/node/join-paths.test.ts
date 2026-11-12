import { expect, test } from 'vitest';
import { joinPaths } from '../../src/misc.js';

test('joinPaths', () => {
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
	expect(joinPaths('https://example.com?token=abc', 'other.m3u8')).toBe('https://example.com/other.m3u8');

	// Protocol-relative paths
	expect(joinPaths('https://example.com/path/to/entry.m3u8', '//cdn.example.com/other.m3u8'))
		.toBe('https://cdn.example.com/other.m3u8');

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
	expect(joinPaths('https://example.com/path/entry.m3u8', '../../other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('../entry.m3u8', 'other.m3u8')).toBe('../other.m3u8');
	expect(joinPaths('../../path/entry.m3u8', '../other.m3u8')).toBe('../../other.m3u8');
	expect(joinPaths('path/entry.m3u8', '../../other.m3u8')).toBe('../other.m3u8');
	expect(joinPaths('/path/entry.m3u8', '../../other.m3u8')).toBe('/other.m3u8');

	// Mixed ./ and ../
	expect(joinPaths('path/to/entry.m3u8', './../other.m3u8')).toBe('path/other.m3u8');
	expect(joinPaths('path/to/entry.m3u8', '../foo/../other.m3u8')).toBe('path/other.m3u8');

	// URL base path with query parameters
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', 'other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?redirect=/foo/bar', 'other.m3u8'))
		.toBe('https://example.com/path/to/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', '/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', '../other.m3u8'))
		.toBe('https://example.com/path/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8?token=abc', '?token=def'))
		.toBe('https://example.com/path/to/entry.m3u8?token=def');
	expect(joinPaths('https://example.com/path/to/entry.m3u8#x/y', '../other.m3u8'))
		.toBe('https://example.com/path/other.m3u8');

	// Query and fragment of the relative path are kept as they are
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'other.m3u8?redirect=https://example.org/x'))
		.toBe('https://example.com/path/to/other.m3u8?redirect=https://example.org/x');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'other.m3u8?p=a/../b'))
		.toBe('https://example.com/path/to/other.m3u8?p=a/../b');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'foo/../other.m3u8?p=./b#c/../d'))
		.toBe('https://example.com/path/to/other.m3u8?p=./b#c/../d');
	expect(joinPaths('path/to/entry.m3u8', 'other.m3u8?p=a/../b')).toBe('path/to/other.m3u8?p=a/../b');

	// Filesystem paths with ? in the name are preserved
	expect(joinPaths('path/to/sus?directory/file.m3u8', 'other.m3u8')).toBe('path/to/sus?directory/other.m3u8');

	// Second argument is a full URL with protocol
	expect(joinPaths('path/to/entry.m3u8', 'https://example.com/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'https://other.com/other.m3u8'))
		.toBe('https://other.com/other.m3u8');
	expect(joinPaths('file:///path/to/entry.m3u8', 'https://example.com/other.m3u8'))
		.toBe('https://example.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'HTTPS://other.com/other.m3u8'))
		.toBe('HTTPS://other.com/other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'blob:https://example.com/other'))
		.toBe('blob:https://example.com/other');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'data:text/plain,a/../b'))
		.toBe('data:text/plain,a/../b');
	expect(joinPaths('path/to/entry.m3u8', 'data:text/plain,abc')).toBe('data:text/plain,abc');

	// Colons that don't start a URI scheme
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'dir/x://other.m3u8'))
		.toBe('https://example.com/path/to/dir/x://other.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'other_1:2.m3u8'))
		.toBe('https://example.com/path/to/other_1:2.m3u8');
	expect(joinPaths('https://example.com/path/to/entry.m3u8', 'seg-12:00.ts'))
		.toBe('https://example.com/path/to/seg-12:00.ts');
});
