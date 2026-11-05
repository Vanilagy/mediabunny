import { expect, test } from 'vitest';
import { Bitstream } from '../../shared/bitstream.js';
import {
	addAvcBitstreamRestriction,
	addAvcColorSpace,
	addEmulationPreventionBytes,
	deserializeAvcDecoderConfigurationRecord,
	parseAvcSps,
} from '../../src/codec-data.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';
import { assert, RequiredNonNull, toUint8Array } from '../../src/misc.js';
import { UrlSource } from '../../src/source.js';

test('AVC color fallback preserves existing VUI and composes with reorder metadata', async () => {
	using input = new Input({
		source: new UrlSource('https://remotion.media/mediabunny-h264-color-space-v1/untagged-h264.mp4'),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config?.description);
	const record = deserializeAvcDecoderConfigurationRecord(toUint8Array(config.description));
	assert(record);
	const sps = parseAvcSps(record.sequenceParameterSets[0]!);
	assert(sps);
	expect(sps.videoSignalTypePresentFlag).toBe(0);
	assert(sps.videoSignalTypeFlagBitOffset !== null);

	const colorSpace: RequiredNonNull<VideoColorSpaceInit> = {
		primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false,
	};
	const prefix = new Bitstream(new Uint8Array(sps.emulationUnpreventedBytes.length));
	prefix.copyBits(sps.vuiParametersFlagBitOffset, new Bitstream(sps.emulationUnpreventedBytes));
	prefix.writeBits(1, 0); // Remove the entire VUI to exercise its creation, too.
	prefix.writeBits(1, 1);
	prefix.writeBits((8 - prefix.pos % 8) % 8, 0);
	const withoutVui = parseAvcSps(addEmulationPreventionBytes(prefix.bytes.subarray(0, prefix.pos / 8)));
	assert(withoutVui);
	expect(withoutVui.videoSignalTypeFlagBitOffset).toBeNull();

	for (const original of [sps, withoutVui]) {
		for (const fullRange of [false, true]) {
			const patched = addAvcColorSpace(original, { ...colorSpace, fullRange });
			assert(patched);
			const parsed = parseAvcSps(patched);
			assert(parsed);
			expect(parsed).toMatchObject({
				colourPrimaries: 6, transferCharacteristics: 6, matrixCoefficients: 6,
				fullRangeFlag: Number(fullRange), videoSignalTypePresentFlag: 1,
				codedWidth: original.codedWidth, codedHeight: original.codedHeight,
				pixelAspectRatio: original.pixelAspectRatio,
				numReorderFrames: original.numReorderFrames, maxDecFrameBuffering: original.maxDecFrameBuffering,
			});
			expect(addAvcColorSpace(parsed, { ...colorSpace, matrix: 'bt709' })).toBeNull();

			if (original.videoSignalTypeFlagBitOffset !== null) {
				const oldBits = Array.from(original.emulationUnpreventedBytes, x => x.toString(2).padStart(8, '0'))
					.join('');
				const newBits = Array.from(parsed.emulationUnpreventedBytes, x => x.toString(2).padStart(8, '0'))
					.join('');
				const start = original.videoSignalTypeFlagBitOffset;
				expect(newBits.slice(0, start)).toBe(oldBits.slice(0, start));
				expect(newBits.slice(start + 30, parsed.vuiParametersEndBitOffset))
					.toBe(oldBits.slice(start + 1, original.vuiParametersEndBitOffset));
			}

			// Keep the signal/range fields, but remove the color description.
			const rangeOnly = new Bitstream(new Uint8Array(patched.length));
			const old = new Bitstream(parsed.emulationUnpreventedBytes);
			rangeOnly.copyBits(parsed.videoSignalTypeFlagBitOffset! + 5, old);
			rangeOnly.writeBits(1, 0);
			old.skipBits(25);
			rangeOnly.copyBits(parsed.vuiParametersEndBitOffset - old.pos, old);
			rangeOnly.writeBits(1, 1);
			rangeOnly.writeBits((8 - rangeOnly.pos % 8) % 8, 0);
			const rangeOnlyBytes = addEmulationPreventionBytes(rangeOnly.bytes.subarray(0, rangeOnly.pos / 8));
			const rangeOnlySps = parseAvcSps(rangeOnlyBytes);
			assert(rangeOnlySps);
			expect(rangeOnlySps.colourPrimaries).toBe(2);
			expect(addAvcColorSpace(rangeOnlySps, colorSpace)).toBeNull();
		}
	}

	const reordered = parseAvcSps(addAvcBitstreamRestriction(withoutVui));
	assert(reordered);
	const colored = parseAvcSps(addAvcColorSpace(reordered, colorSpace)!);
	expect(colored).toMatchObject({ bitstreamRestrictionFlag: 1, matrixCoefficients: 6 });
});
