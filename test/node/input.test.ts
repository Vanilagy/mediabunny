import { expect, test, vi } from 'vitest';
import { Input, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { assert, TransformationMatrix } from '../../src/misc.js';

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

const identity: TransformationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const createMatrixFixture = async (version: number, fragmented = false) => {
	const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(version === 0 ? 2025 : 2050, 0, 1));
	try {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : 'in-memory' }),
			target: new BufferTarget(),
		});
		output.addVideoTrack(new EncodedVideoPacketSource('vp9'), {
			decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 8 },
		});
		await output.start();
		await output.finalize();
		return new Uint8Array(output.target.buffer!);
	} finally {
		clock.mockRestore();
	}
};

// These fixtures are small enough that their boxes always use 32-bit sizes.
const findBox = (bytes: Uint8Array, path: string[]): number => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let start = 0;
	let end = bytes.length;
	for (const name of path) {
		let found = false;
		for (let pos = start; pos + 8 <= end;) {
			const size = view.getUint32(pos);
			assert(size >= 8 && pos + size <= end);
			if (new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8)) === name) {
				start = pos + 8;
				end = pos + size;
				found = true;
				break;
			}
			pos += size;
		}
		expect(found, `Missing ${name}`).toBe(true);
	}
	return start;
};

const setMatrix = (bytes: Uint8Array, path: string[], matrix: TransformationMatrix, version: number) => {
	const start = findBox(bytes, path);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(view.getUint8(start)).toBe(version);
	const offset = start + (path.at(-1) === 'mvhd' ? 36 : 40) + (version === 1 ? 12 : 0);
	matrix.forEach((value, index) => {
		view.setInt32(offset + index * 4, value * (index % 3 === 2 ? 2 ** 30 : 2 ** 16));
	});
};

test.each([0, 1])('Movie and track matrices preserve all components in version %i headers', async (version) => {
	const matrices: TransformationMatrix[] = [
		identity,
		[0, 1, 0, -1, 0, 0, 8, 0, 1], // Rotation and translation
		[-1, 0, 0, 0, 1, 0, 16, 0, 1], // Mirroring
		[1.5, 0.25, 0, -0.5, 2, 0, -3.5, 4.25, 1], // Scale, shear, and fractional translation
		[1, 0, 0.125, 0, 1, -0.25, 0, 0, 0.5], // Perspective uses 2.30 fixed point
	];
	for (const matrix of matrices) {
		const bytes = await createMatrixFixture(version);
		setMatrix(bytes, ['moov', 'mvhd'], matrix, version);
		setMatrix(bytes, ['moov', 'trak', 'tkhd'], matrix, version);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await input.getTransformationMatrix()).toEqual(matrix);
		expect(await track.getTransformationMatrix()).toEqual(matrix);
		expect(await track.getSquarePixelWidth()).toBe(16);
		expect(await track.getSquarePixelHeight()).toBe(8);

		const returned = await track.getTransformationMatrix();
		returned![0] = 123;
		expect(await track.getTransformationMatrix()).toEqual(matrix);
		const movie = await input.getTransformationMatrix();
		movie![0] = 456;
		expect(await input.getTransformationMatrix()).toEqual(matrix);
	}
});

test('Segment inputs inherit movie and track matrices from their initialization input', async () => {
	const bytes = await createMatrixFixture(0, true);
	const movie: TransformationMatrix = [2, 0, 0, 0, 2, 0, 10, 20, 1];
	const trackMatrix: TransformationMatrix = [-1, 0, 0, 0, 1, 0, 16, 0, 1];
	setMatrix(bytes, ['moov', 'mvhd'], movie, 0);
	setMatrix(bytes, ['moov', 'trak', 'tkhd'], trackMatrix, 0);
	using initInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	// An empty segment with an styp box is enough to exercise initialization metadata inheritance.
	const segment = new Uint8Array([0, 0, 0, 16, 115, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
	using input = new Input({ source: new BufferSource(segment), formats: ALL_FORMATS, initInput });
	expect(await input.getTransformationMatrix()).toEqual(movie);
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getTransformationMatrix()).toEqual(trackMatrix);
});

test('Matrix metadata remains separate from rotation, pixel aspect ratio, and unavailable formats', async () => {
	for (const file of ['rotate-buck-bunny.mp4', 'sar_2x1.mp4', 'trunc-buck-bunny.mov', 'frames.webm']) {
		using input = new Input({
			source: new FilePathSource(new URL(`../public/${file}`, import.meta.url).pathname),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		const rotation = await track.getRotation();
		const dimensions = [await track.getDisplayWidth(), await track.getDisplayHeight()];
		if (file.endsWith('.webm')) {
			expect(await input.getTransformationMatrix()).toBeNull();
			expect(await track.getTransformationMatrix()).toBeNull();
		} else {
			expect(await input.getTransformationMatrix()).toEqual(file.endsWith('.mov')
				? [0.5260467529296875, 0, 0, 0, 0.5259246826171875, 0, 0, 0, 1]
				: identity);
			expect(await track.getTransformationMatrix()).toHaveLength(9);
		}
		if (file === 'sar_2x1.mp4') {
			expect(await track.getPixelAspectRatio()).toEqual({ num: 2, den: 1 });
			expect(await track.getTransformationMatrix()).toEqual(identity);
		}
		expect(await track.getRotation()).toBe(rotation);
		expect([await track.getDisplayWidth(), await track.getDisplayHeight()]).toEqual(dimensions);
	}
});
