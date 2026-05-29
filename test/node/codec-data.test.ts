import { expect, test, vi } from 'vitest';
import { deserializeAvcDecoderConfigurationRecord, parseDtsCoreFrameHeader } from '../../src/codec-data.js';
import { Bitstream } from '../../shared/bitstream.js';

const makeDtsCoreHeader = () => {
	const header = new Uint8Array(11);
	header.set([0x7f, 0xfe, 0x80, 0x01]);

	const bitstream = new Bitstream(header);
	bitstream.skipBits(32);
	bitstream.writeBits(1, 1); // Frame type
	bitstream.writeBits(5, 31); // Deficit sample count
	bitstream.writeBits(1, 0); // CRC present
	bitstream.writeBits(7, 31); // 32 PCM sample blocks
	bitstream.writeBits(14, 99); // 100-byte frame
	bitstream.writeBits(6, 9); // C + L + R + SL + SR
	bitstream.writeBits(4, 13); // 48 kHz
	bitstream.writeBits(5, 10); // Bit rate code
	bitstream.writeBits(1, 0); // Down mix
	bitstream.writeBits(1, 0); // Dynamic range
	bitstream.writeBits(1, 0); // Time stamp
	bitstream.writeBits(1, 0); // Auxiliary data
	bitstream.writeBits(1, 0); // HDCD
	bitstream.writeBits(3, 0); // Extension audio ID
	bitstream.writeBits(1, 0); // Extended audio
	bitstream.writeBits(1, 0); // Audio sync word insertion
	bitstream.writeBits(2, 1); // LFE

	return header;
};

test('parses DTS core frame headers', () => {
	expect(parseDtsCoreFrameHeader(makeDtsCoreHeader())).toEqual({
		frameSize: 100,
		sampleRate: 48000,
		channelCount: 6,
		sampleCount: 1024,
		channelArrangement: 9,
		sampleRateCode: 13,
	});
});

test('rejects unsupported DTS header variants', () => {
	const littleEndianSync = new Uint8Array([0xfe, 0x7f, 0x01, 0x80]);
	expect(parseDtsCoreFrameHeader(littleEndianSync)).toBeNull();
});

test('returns null for truncated AVC decoder configuration records without logging', () => {
	const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		expect(
			deserializeAvcDecoderConfigurationRecord(
				new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64]),
			),
		).toBeNull();
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	} finally {
		consoleErrorSpy.mockRestore();
	}
});
