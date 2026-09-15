import { expect, test } from 'vitest';
import { Output } from '../../src/output.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

test('Output, onFinalize', async () => {
	let callCount = 0;
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: async () => {
			await new Promise(resolve => setTimeout(resolve, 200));

			callCount++;
		},
	});

	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);

	await output.start();

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.5), {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 1920,
			codedHeight: 1080,
		},
	});

	await output.finalize();

	expect(callCount).toBe(1);
});

test('Failed finalization preserves its error and allows cancellation to release the source', async () => {
	const error = new Error('Flush failed');
	const calls: boolean[] = [];
	class FailingSource extends EncodedVideoPacketSource {
		override async _flushAndClose(forceClose: boolean) {
			calls.push(forceClose);
			if (!forceClose) {
				throw error;
			}
		}
	}
	const source = new FailingSource('vp8');
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	output.addVideoTrack(source);
	await output.start();
	await expect(output.finalize()).rejects.toBe(error);
	expect(output.state).toBe('started');
	await output.cancel();
	expect(output.state).toBe('canceled');
	expect(source._closed).toBe(true);
	expect(calls).toEqual([false, true]);
});

test('A failing onFinalize callback restores the state and preserves the error', async () => {
	const error = new Error('onFinalize failed');
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
		onFinalize: () => { throw error; },
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 0.5), {
		decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
	});
	await expect(output.finalize()).rejects.toBe(error);
	expect(output.state).toBe('started');
	await output.cancel();
	expect(output.state).toBe('canceled');
});
