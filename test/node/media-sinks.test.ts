import { expect, test } from 'vitest';
import {
	determineVideoPacketType,
	extractNalUnitTypeForAvc,
	iterateAvcNalUnits,
	sanitizeAvcPacketForChromium,
} from '../../src/codec-data.js';

const AVC_CONFIG: VideoDecoderConfig = {
	codec: 'avc1.640034',
	codedWidth: 16,
	codedHeight: 16,
	description: new Uint8Array([1, 100, 0, 52, 255, 0]),
};

const lengthPrefixedNalUnit = (type: number, payloadLength = 1) => {
	const length = payloadLength + 1;
	return [
		(length >>> 24) & 0xff,
		(length >>> 16) & 0xff,
		(length >>> 8) & 0xff,
		length & 0xff,
		type,
		...Array.from({ length: payloadLength }, () => 0),
	];
};

test('Chromium AVC sanitization preserves IDR frames followed by AUD', () => {
	const packetData = new Uint8Array([
		...lengthPrefixedNalUnit(5, 4), // IDR
		...lengthPrefixedNalUnit(9), // AUD
	]);

	const sanitizedData = sanitizeAvcPacketForChromium(packetData, AVC_CONFIG);
	const nalTypes = [...iterateAvcNalUnits(sanitizedData, AVC_CONFIG)]
		.map(loc => extractNalUnitTypeForAvc(sanitizedData[loc.offset]!));

	expect(nalTypes).toEqual([5, 9]);
	expect(determineVideoPacketType('avc', AVC_CONFIG, sanitizedData)).toBe('key');
});
