import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ALL_FORMATS, EncodedPacketSink, Input, StreamSource } from '../../src/index.js';
import type { EncodedPacket } from '../../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;

/**
 * Creates a StreamSource backed by a buffer that records every read call.
 */
function createTrackingSource(buffer: Uint8Array) {
	const reads: Array<{ start: number; end: number }> = [];

	const source = new StreamSource({
		getSize: () => buffer.byteLength,
		read: (start, end) => {
			reads.push({ start, end });
			return buffer.subarray(start, end);
		},
	});

	return { source, reads, clearReads: () => { reads.length = 0; } };
}

async function collectKeyframeTimestamps(
	sink: EncodedPacketSink,
	options: { metadataOnly?: boolean } = {},
): Promise<number[]> {
	const timestamps: number[] = [];
	let packet: EncodedPacket | null = await sink.getKeyPacket(0, options);

	while (packet) {
		timestamps.push(packet.timestamp);
		const next = await sink.getNextKeyPacket(packet, options);
		if (!next || next.sequenceNumber === packet.sequenceNumber) break;
		packet = next;
	}

	return timestamps;
}

// multi-cluster.mkv: 5s H.264 video with 10 clusters and Cues element
const FIXTURE = 'multi-cluster.mkv';

test('MKV metadataOnly keyframe iteration should not read cluster data', async () => {
	const buffer = await readFile(path.join(__dirname, '..', `public/${FIXTURE}`));
	const fileSize = buffer.byteLength;
	const { source, reads, clearReads } = createTrackingSource(buffer);

	using input = new Input({ source, formats: ALL_FORMATS });

	// Phase 1: parse container metadata (reads Segment header, Tracks, Cues, etc.)
	const videoTrack = await input.getPrimaryVideoTrack();
	expect(videoTrack).not.toBeNull();
	const sink = new EncodedPacketSink(videoTrack!);

	// Clear reads from the initial parse phase
	clearReads();

	// Phase 2: iterate keyframes with metadataOnly: true
	const timestamps = await collectKeyframeTimestamps(sink, { metadataOnly: true });
	expect(timestamps.length).toBeGreaterThan(0);

	// Calculate total bytes read during keyframe iteration
	const totalBytesRead = reads.reduce((sum, r) => sum + (r.end - r.start), 0);

	// When Cues exist, metadataOnly keyframe iteration should use them directly
	// instead of reading full cluster data. The file is ~200KB of mostly video data;
	// iterating keyframe timestamps should require zero or minimal I/O since the
	// keyframe positions and timestamps are already available from the Cues element.
	expect(totalBytesRead).toBeLessThan(fileSize * 0.25);

	// Sanity check: we found multiple keyframes (file has 5 seconds of video with keyframes every ~1s)
	expect(timestamps.length).toBeGreaterThanOrEqual(4);
});

test('MKV metadataOnly keyframe timestamps match regular iteration', async () => {
	const buffer = await readFile(path.join(__dirname, '..', `public/${FIXTURE}`));
	const { source: source1 } = createTrackingSource(buffer);
	const { source: source2 } = createTrackingSource(buffer);

	using input1 = new Input({ source: source1, formats: ALL_FORMATS });
	using input2 = new Input({ source: source2, formats: ALL_FORMATS });

	const videoTrack1 = await input1.getPrimaryVideoTrack();
	expect(videoTrack1).not.toBeNull();
	const sink1 = new EncodedPacketSink(videoTrack1!);
	const metadataTimestamps = await collectKeyframeTimestamps(sink1, { metadataOnly: true });

	const videoTrack2 = await input2.getPrimaryVideoTrack();
	expect(videoTrack2).not.toBeNull();
	const sink2 = new EncodedPacketSink(videoTrack2!);
	const regularTimestamps = await collectKeyframeTimestamps(sink2);

	expect(metadataTimestamps.length).toBeGreaterThan(0);
	expect(metadataTimestamps).toEqual(regularTimestamps);
});
