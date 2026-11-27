import { afterAll } from 'vitest';

afterAll(async () => {
	// Run GC to trigger leak errors
	(globalThis as unknown as { gc: () => void }).gc();

	// The finalization callbacks run in a later task
	await new Promise(resolve => setTimeout(resolve, 10));
});
