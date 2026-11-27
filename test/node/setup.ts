import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll } from 'vitest';

afterAll(async () => {
	// Run GC to trigger leak errors
	v8.setFlagsFromString('--expose-gc');
	const gc = vm.runInNewContext('gc') as () => void;
	gc();

	// The finalization callbacks run in a later task
	await new Promise(resolve => setTimeout(resolve, 10));
});
