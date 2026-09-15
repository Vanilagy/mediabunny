import { expect, test } from 'vitest';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { promiseWithResolvers } from '../../src/misc.js';

class ControlledCloseSource extends EncodedVideoPacketSource {
	calls: boolean[] = [];
	result = promiseWithResolvers<void>();

	constructor() {
		super('vp8');
	}

	override async _flushAndClose(forceClose: boolean) {
		this.calls.push(forceClose);
		if (!forceClose) {
			await this.result.promise;
		}
	}
}

test('Normal close preserves the original failure without retrying', async () => {
	const source = new ControlledCloseSource();
	const error = new Error('Flush failed');
	const closing = source._flushOrWaitForOngoingClose(false);
	const rejected = expect(closing).rejects.toBe(error);
	source.result.reject(error);
	await rejected;
	await expect(source._flushOrWaitForOngoingClose(false)).rejects.toBe(error);
	expect(source.calls).toEqual([false]);
	expect(source._closed).toBe(false);
});

test('Concurrent force closes wait for the pending flush and share one cleanup after failure', async () => {
	const source = new ControlledCloseSource();
	const error = new Error('Flush failed');
	const closing = source._flushOrWaitForOngoingClose(false);
	const rejected = expect(closing).rejects.toBe(error);
	const force1 = source._flushOrWaitForOngoingClose(true);
	const force2 = source._flushOrWaitForOngoingClose(true);
	const cleanup = Promise.all([force1, force2]);
	const cleaned = expect(cleanup).resolves.toEqual([undefined, undefined]);
	expect(source.calls).toEqual([false]);
	source.result.reject(error);
	await rejected;
	await cleaned;
	expect(source.calls).toEqual([false, true]);
	expect(source._closed).toBe(true);
});

test('Force close reuses a successful pending close', async () => {
	const source = new ControlledCloseSource();
	const closing = source._flushOrWaitForOngoingClose(false);
	const forced = source._flushOrWaitForOngoingClose(true);
	source.result.resolve();
	await Promise.all([closing, forced]);
	expect(source.calls).toEqual([false]);
	expect(source._closed).toBe(true);
});
